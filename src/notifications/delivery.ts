import { and, desc, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	notificationDeliveries,
	notificationDeliveryAttempts,
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
}

/**
 * Appends the next attempt in the chain. Must be called after
 * `lockDeliveryAttemptHistoryInTransaction` (same transaction) so
 * `nextAttemptNo` is race-safe; the DB trigger independently re-validates
 * the chain (Section 15/28) as the authoritative backstop.
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
