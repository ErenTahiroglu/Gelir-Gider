import { and, asc, desc, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	notificationDeliveries,
	notificationDeliveryAttempts,
	notificationDeliveryDispatches,
} from "../db/schema/notifications";
import { NotificationError } from "./errors";

export const MAX_DELIVERY_ATTEMPTS = 5;

type AttemptStatus =
	| "SUCCESS"
	| "RETRYABLE_FAILURE"
	| "TERMINAL_FAILURE"
	| "SUPPRESSED_OBSOLETE";

export type AttemptPlan =
	| "SEND"
	| "SUPPRESS_OBSOLETE"
	| "SKIP_DONE"
	| "SKIP_MAX_ATTEMPTS"
	| "SKIP_NOT_SAME_DAY";

export interface DeliveryAttemptHistory {
	attemptCount: number;
	lastAttemptStatus: AttemptStatus | null;
	hasSuccess: boolean;
}

/**
 * Pure decision function (Section 15-18, 27, 41) -- DB-less testable. Given
 * the delivery's current attempt history plus the statement's CURRENT
 * (freshly re-checked) latest status, decides what the scheduler should do
 * next for one (event, subscription) delivery.
 */
export function planDeliveryAttempt(input: {
	history: DeliveryAttemptHistory;
	currentStatementStatus: "OPEN" | "PAID" | "VOID";
	isSameDueDay: boolean;
}): AttemptPlan {
	if (input.history.hasSuccess) return "SKIP_DONE";
	if (
		input.history.lastAttemptStatus === "TERMINAL_FAILURE" ||
		input.history.lastAttemptStatus === "SUPPRESSED_OBSOLETE"
	) {
		return "SKIP_DONE";
	}
	if (!input.isSameDueDay) return "SKIP_NOT_SAME_DAY";
	if (input.history.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
		return "SKIP_MAX_ATTEMPTS";
	}
	if (input.currentStatementStatus !== "OPEN") return "SUPPRESS_OBSOLETE";
	return "SEND";
}

/**
 * Idempotently ensures exactly one `notification_deliveries` row exists for
 * (event, subscription) -- `ON CONFLICT DO NOTHING` + re-read (Section 28).
 * Returns whether this call created a brand-new row (so the caller knows it
 * still owes that delivery its first attempt before the transaction
 * committing this row is allowed to be treated as "done" -- the deferred
 * anchor-completeness trigger is the DB-level backstop).
 */
export async function ensureDeliveryInTransaction(
	tx: DatabaseTransaction,
	args: { userId: string; eventId: string; subscriptionId: string },
): Promise<{ deliveryId: string; created: boolean }> {
	const inserted = await tx
		.insert(notificationDeliveries)
		.values({
			userId: args.userId,
			notificationEventId: args.eventId,
			pushSubscriptionId: args.subscriptionId,
		})
		.onConflictDoNothing()
		.returning({ id: notificationDeliveries.id });
	if (inserted.length > 0 && inserted[0]) {
		return { deliveryId: inserted[0].id, created: true };
	}
	const [existing] = await tx
		.select({ id: notificationDeliveries.id })
		.from(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.notificationEventId, args.eventId),
				eq(notificationDeliveries.pushSubscriptionId, args.subscriptionId),
			),
		)
		.limit(1);
	if (!existing) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_STATE",
			"Failed to create or resolve notification delivery",
		);
	}
	return { deliveryId: existing.id, created: false };
}

/**
 * Reads the delivery's current attempt history (locking the delivery row
 * FOR UPDATE to serialize concurrent attempt-chain writers, Section 28).
 */
export async function lockDeliveryAttemptHistoryInTransaction(
	tx: DatabaseTransaction,
	deliveryId: string,
): Promise<DeliveryAttemptHistory> {
	await tx
		.select({ id: notificationDeliveries.id })
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.id, deliveryId))
		.for("update");

	const attempts = await tx
		.select()
		.from(notificationDeliveryAttempts)
		.where(eq(notificationDeliveryAttempts.deliveryId, deliveryId))
		.orderBy(desc(notificationDeliveryAttempts.attemptNo));

	const last = attempts[0];
	return {
		attemptCount: attempts.length,
		lastAttemptStatus: (last?.status as AttemptStatus) ?? null,
		hasSuccess: attempts.some((a) => a.status === "SUCCESS"),
	};
}

export interface InsertDeliveryAttemptArgs {
	userId: string;
	deliveryId: string;
	nextAttemptNo: number;
	status: AttemptStatus;
	httpStatus: number | null;
	errorCode: string | null;
	attemptedAt: Date;
	/**
	 * Phase 15-R1 Section A/K: the exact dispatch reservation this attempt
	 * result resolves. Required for every network-attempted outcome
	 * (SUCCESS/RETRYABLE_FAILURE/TERMINAL_FAILURE); must be null for the
	 * no-network SUPPRESSED_OBSOLETE path. The DB trigger independently
	 * re-validates this binding as the authoritative backstop.
	 */
	dispatchId: string | null;
}

/**
 * Appends the next attempt in the chain. Must be called after
 * `lockDeliveryHistoryInTransaction` (same transaction) so `nextAttemptNo`
 * is race-safe; the DB trigger independently re-validates the chain
 * (Section 15/28) as the authoritative backstop.
 */
export async function insertDeliveryAttemptInTransaction(
	tx: DatabaseTransaction,
	args: InsertDeliveryAttemptArgs,
): Promise<typeof notificationDeliveryAttempts.$inferSelect> {
	const [inserted] = await tx
		.insert(notificationDeliveryAttempts)
		.values({
			userId: args.userId,
			deliveryId: args.deliveryId,
			dispatchId: args.dispatchId,
			attemptNo: args.nextAttemptNo,
			status: args.status,
			httpStatus: args.httpStatus,
			errorCode: args.errorCode,
			attemptedAt: args.attemptedAt,
			nextAttemptAt: null,
		})
		.returning();
	if (!inserted) {
		throw new NotificationError(
			"NOTIFICATION_INVALID_STATE",
			"Failed to append notification delivery attempt",
		);
	}
	return inserted;
}

// ============================================================================
// Dispatch reservation (Phase 15-R1 Section A) -- pre-send reservation
// committed BEFORE any network call.
// ============================================================================

export const MAX_DISPATCH_ATTEMPTS = MAX_DELIVERY_ATTEMPTS;

export interface UnresolvedDispatch {
	id: string;
	dispatchNo: number;
	pushSubscriptionRevisionId: string;
	schedulerHourSlot: Date;
}

export interface DeliveryHistory {
	attemptCount: number;
	lastAttemptStatus: AttemptStatus | null;
	hasSuccess: boolean;
	dispatchCount: number;
	/** Dispatch reservations with no bound attempt result yet. */
	unresolvedDispatches: UnresolvedDispatch[];
}

export function toAttemptHistory(
	history: DeliveryHistory,
): DeliveryAttemptHistory {
	return {
		attemptCount: history.attemptCount,
		lastAttemptStatus: history.lastAttemptStatus,
		hasSuccess: history.hasSuccess,
	};
}

/**
 * Locks the delivery row FOR UPDATE and reads BOTH the attempt chain and the
 * dispatch-reservation chain (Section A) -- the single source of truth the
 * scheduler's Transaction A/B rely on to serialize concurrent writers.
 */
export async function lockDeliveryHistoryInTransaction(
	tx: DatabaseTransaction,
	deliveryId: string,
): Promise<DeliveryHistory> {
	await tx
		.select({ id: notificationDeliveries.id })
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.id, deliveryId))
		.for("update");

	const attempts = await tx
		.select()
		.from(notificationDeliveryAttempts)
		.where(eq(notificationDeliveryAttempts.deliveryId, deliveryId))
		.orderBy(asc(notificationDeliveryAttempts.attemptNo));

	const dispatches = await tx
		.select()
		.from(notificationDeliveryDispatches)
		.where(eq(notificationDeliveryDispatches.deliveryId, deliveryId))
		.orderBy(asc(notificationDeliveryDispatches.dispatchNo));

	const boundDispatchIds = new Set(
		attempts.map((a) => a.dispatchId).filter((id): id is string => id !== null),
	);

	const last = attempts[attempts.length - 1];

	return {
		attemptCount: attempts.length,
		lastAttemptStatus: (last?.status as AttemptStatus) ?? null,
		hasSuccess: attempts.some((a) => a.status === "SUCCESS"),
		dispatchCount: dispatches.length,
		unresolvedDispatches: dispatches
			.filter((d) => !boundDispatchIds.has(d.id))
			.map((d) => ({
				id: d.id,
				dispatchNo: d.dispatchNo,
				pushSubscriptionRevisionId: d.pushSubscriptionRevisionId,
				schedulerHourSlot: d.schedulerHourSlot,
			})),
	};
}

/**
 * Phase 15-R1 Section A (crash-window / stale-reservation policy): a
 * dispatch reservation whose `scheduler_hour_slot` is not the CURRENT hour
 * and has no bound attempt result is "stale" -- it can only mean a process
 * crash (or equivalent) happened between the successful reservation
 * (Transaction A committed) and its result being recorded (Transaction B).
 * Web Push cannot provide exactly-once delivery across that specific window;
 * the deterministic policy chosen here is CONSERVATIVE: resolve every such
 * stale reservation immediately, before planning this run's action, by
 * appending a sanitized `TERMINAL_FAILURE` / `DISPATCH_OUTCOME_UNKNOWN`
 * attempt bound to it. This counts against the max-attempt budget and marks
 * the delivery outcome as unknown-but-final for that dispatch, rather than
 * risking a second real network send for a delivery whose first send may
 * have actually succeeded. This is deliberately narrower than -- and must
 * never be confused with -- the Section A UNIQUE-constraint mechanism that
 * eliminates ordinary concurrent-scheduler-run duplication outright; this
 * only ever fires for a reservation that has already rolled into a PAST
 * hour slot unresolved.
 */
export async function resolveStaleDispatchReservationsInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		deliveryId: string;
		currentHourSlot: Date;
		history: DeliveryHistory;
		resolvedAt: Date;
	},
): Promise<DeliveryHistory> {
	const stale = args.history.unresolvedDispatches.filter(
		(d) => d.schedulerHourSlot.getTime() !== args.currentHourSlot.getTime(),
	);
	if (stale.length === 0) return args.history;

	let nextAttemptNo = args.history.attemptCount + 1;
	for (const dispatch of stale) {
		await insertDeliveryAttemptInTransaction(tx, {
			userId: args.userId,
			deliveryId: args.deliveryId,
			nextAttemptNo,
			status: "TERMINAL_FAILURE",
			httpStatus: null,
			errorCode: "DISPATCH_OUTCOME_UNKNOWN",
			attemptedAt: args.resolvedAt,
			dispatchId: dispatch.id,
		});
		nextAttemptNo++;
	}

	return lockDeliveryHistoryInTransaction(tx, args.deliveryId);
}

export interface ReserveDispatchArgs {
	userId: string;
	deliveryId: string;
	nextDispatchNo: number;
	pushSubscriptionRevisionId: string;
	schedulerHourSlot: Date;
	reservedAt: Date;
}

export interface ReserveDispatchResult {
	reserved: boolean;
	dispatch: typeof notificationDeliveryDispatches.$inferSelect | null;
}

/**
 * Phase 15-R1 Section A: reserves a pre-send dispatch slot, committed in
 * Transaction A, BEFORE any network call. Uses `ON CONFLICT DO NOTHING`
 * (not a try/catch around a thrown unique-violation) so a losing concurrent
 * reservation attempt does NOT poison the enclosing transaction -- Postgres
 * aborts a transaction on a raised/thrown constraint error, so catching one
 * mid-transaction and continuing to use the same `tx` would be unsafe. A
 * `reserved: false` result means either this exact delivery already has a
 * dispatch for `dispatchNo`, or -- the concurrency-critical case -- another
 * scheduler invocation already reserved this exact
 * `(deliveryId, schedulerHourSlot)` pair; either way, the correct action is
 * to make ZERO network calls for this attempt.
 */
export async function reserveDispatchInTransaction(
	tx: DatabaseTransaction,
	args: ReserveDispatchArgs,
): Promise<ReserveDispatchResult> {
	const inserted = await tx
		.insert(notificationDeliveryDispatches)
		.values({
			userId: args.userId,
			deliveryId: args.deliveryId,
			dispatchNo: args.nextDispatchNo,
			pushSubscriptionRevisionId: args.pushSubscriptionRevisionId,
			schedulerHourSlot: args.schedulerHourSlot,
			reservedAt: args.reservedAt,
		})
		.onConflictDoNothing()
		.returning();
	if (inserted.length === 0 || !inserted[0]) {
		return { reserved: false, dispatch: null };
	}
	return { reserved: true, dispatch: inserted[0] };
}

/**
 * Truncates an instant down to the start of its UTC hour -- the
 * `scheduler_hour_slot` identity for the hourly cron tick containing it.
 * Using UTC (rather than Europe/Istanbul local hour) avoids re-deriving a
 * second timezone-dependent value purely for slot identity; the cron itself
 * already fires once per UTC hour (`0 * * * *`), so this is exactly the
 * granularity needed to make "at most one dispatch per delivery per hourly
 * scheduler slot" (Section 21) DB-provable.
 */
export function truncateToSchedulerHourSlot(instant: Date): Date {
	const ms = instant.getTime();
	return new Date(ms - (ms % 3_600_000));
}
