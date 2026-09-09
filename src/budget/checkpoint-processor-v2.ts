import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	budgetV2CheckpointRequests,
	budgetV2CheckpointSnapshots,
} from "../db/schema/budget-v2-checkpoint";
import {
	calculateCheckpointReportFingerprint,
	verifyStoredCheckpointSnapshot,
} from "./checkpoint-canonical-v2";
import { buildBudgetV2CheckpointReport } from "./checkpoint-report-v2";
import { BudgetError } from "./errors";
import { normalizeUuid, validateBudgetPeriodMonth } from "./utils";

/**
 * DURABLE CHECKPOINT PERSISTENCE PROCESSOR (Checkpoint 5, Sections 9-16).
 *
 * A bounded, retryable processor that turns pending checkpoint REQUEST rows
 * (an actual PAID payment event on a trigger card, no snapshot yet) into
 * immutable checkpoint SNAPSHOT rows.
 *
 * Guarantees:
 *   - REPLAY BEFORE LIVE: `getBudgetV2CheckpointByPaymentEventId` returns the
 *     frozen stored snapshot verbatim when one exists -- it never rebuilds the
 *     report or resolves current source truth.
 *   - PREVIOUS-CHECKPOINT CHAIN is derived from stored successful snapshots,
 *     per user+periodMonth, month boundaries starting a fresh chain.
 *   - NEVER SKIP AN EARLIER PENDING CHECKPOINT: requests are processed oldest
 *     first per user+period; a failure stops that period (later requests stay
 *     pending) but never blocks other periods/users.
 *   - CONCURRENCY: one snapshot per request (row lock + unique(request_id) +
 *     ON CONFLICT DO NOTHING); a losing worker returns the stored snapshot.
 *   - SAME-TIMESTAMP COLLISION: two distinct eligible events in one
 *     user+period sharing the exact `checkpointAt` fail closed at the report
 *     layer -- payments and requests remain intact.
 *   - A failed-closed report never fabricates a snapshot and never deletes the
 *     request; a later run may succeed once evidence is repaired.
 *
 * No `report_json` / balances / amounts / names in any operational count.
 * Month-close is never invoked from here.
 */

// ============================================================================
// Processor
// ============================================================================

export interface ProcessPendingCheckpointRequestsParams {
	db: Database;
}

export interface ProcessPendingCheckpointRequestsResult {
	pendingDiscovered: number;
	persisted: number;
	/** Left pending because an earlier same-period request is unresolved. */
	blocked: number;
	/** Requests whose authoritative report build failed closed this run. */
	failedReport: number;
	/** (user, periodMonth) groups halted by a same-`checkpointAt` collision. */
	collisionPeriods: number;
	periodsProcessed: number;
}

type RequestRow = typeof budgetV2CheckpointRequests.$inferSelect;
type SnapshotRow = typeof budgetV2CheckpointSnapshots.$inferSelect;

function groupKey(userId: string, periodMonth: string): string {
	return `${userId}|${periodMonth}`;
}

export async function processPendingBudgetV2CheckpointRequests(
	params: ProcessPendingCheckpointRequestsParams,
): Promise<ProcessPendingCheckpointRequestsResult> {
	const { db } = params;

	const allRequests = await db
		.select()
		.from(budgetV2CheckpointRequests)
		.orderBy(
			asc(budgetV2CheckpointRequests.userId),
			asc(budgetV2CheckpointRequests.periodMonth),
			asc(budgetV2CheckpointRequests.checkpointAt),
			asc(budgetV2CheckpointRequests.id),
		);
	const persistedRequestIds = new Set(
		(
			await db
				.select({ requestId: budgetV2CheckpointSnapshots.requestId })
				.from(budgetV2CheckpointSnapshots)
		).map((r) => r.requestId),
	);

	const pending = allRequests.filter((r) => !persistedRequestIds.has(r.id));

	const result: ProcessPendingCheckpointRequestsResult = {
		pendingDiscovered: pending.length,
		persisted: 0,
		blocked: 0,
		failedReport: 0,
		collisionPeriods: 0,
		periodsProcessed: 0,
	};
	if (pending.length === 0) return result;

	// Group pending by user+period, preserving chronological order.
	const groups = new Map<string, RequestRow[]>();
	for (const r of pending) {
		const key = groupKey(r.userId, r.periodMonth);
		const list = groups.get(key) ?? [];
		list.push(r);
		groups.set(key, list);
	}

	for (const [, groupRequests] of groups) {
		result.periodsProcessed += 1;
		const { userId, periodMonth } = groupRequests[0] as RequestRow;

		// Persisted snapshots already in this (user, period) chain.
		let chain: SnapshotRow[] = await db
			.select()
			.from(budgetV2CheckpointSnapshots)
			.where(
				and(
					eq(budgetV2CheckpointSnapshots.userId, userId),
					eq(budgetV2CheckpointSnapshots.periodMonth, periodMonth),
				),
			)
			.orderBy(asc(budgetV2CheckpointSnapshots.checkpointAt));

		// Same-`checkpointAt` collision: any two distinct eligible events in
		// this user+period sharing the exact instant -> fail closed here.
		const instants = new Map<number, number>();
		for (const s of chain) {
			instants.set(
				s.checkpointAt.getTime(),
				(instants.get(s.checkpointAt.getTime()) ?? 0) + 1,
			);
		}
		for (const r of groupRequests) {
			instants.set(
				r.checkpointAt.getTime(),
				(instants.get(r.checkpointAt.getTime()) ?? 0) + 1,
			);
		}
		if ([...instants.values()].some((count) => count > 1)) {
			result.collisionPeriods += 1;
			result.blocked += groupRequests.length;
			continue;
		}

		let halted = false;
		for (const request of groupRequests) {
			if (halted) {
				result.blocked += 1;
				continue;
			}

			// Immediately-preceding persisted checkpoint in this period.
			const predecessor = lastBefore(chain, request.checkpointAt);
			const previousCheckpointAt = predecessor?.checkpointAt;

			let report: Awaited<ReturnType<typeof buildBudgetV2CheckpointReport>>;
			try {
				report = await buildBudgetV2CheckpointReport({
					db,
					userId,
					periodMonth: validateBudgetPeriodMonth(periodMonth),
					triggerPaymentEventId: request.paymentEventId,
					previousCheckpointAt,
				});
			} catch (err) {
				if (err instanceof BudgetError) {
					// Fail closed: payment stays committed, request stays pending,
					// no fake snapshot, later same-period requests stay blocked.
					result.failedReport += 1;
					halted = true;
					continue;
				}
				throw err;
			}

			const persistedSnap = await persistCheckpointSnapshot(
				db,
				request,
				report,
				predecessor ?? null,
			);
			chain = [...chain, persistedSnap].sort(
				(a, b) => a.checkpointAt.getTime() - b.checkpointAt.getTime(),
			);
			result.persisted += 1;
		}
	}

	return result;
}

function lastBefore(chain: SnapshotRow[], at: Date): SnapshotRow | undefined {
	let chosen: SnapshotRow | undefined;
	for (const s of chain) {
		if (s.checkpointAt.getTime() < at.getTime()) {
			if (!chosen || s.checkpointAt.getTime() > chosen.checkpointAt.getTime()) {
				chosen = s;
			}
		}
	}
	return chosen;
}

/**
 * Hardened single-snapshot persist. Serializes on the request row, second-checks
 * for an existing snapshot under lock, recomputes the predecessor under lock and
 * refuses to persist a report built against a now-stale interval, then inserts
 * with ON CONFLICT (request_id) DO NOTHING. A losing worker returns the stored
 * snapshot; a raw 23505 never escapes.
 */
async function persistCheckpointSnapshot(
	db: Database,
	request: RequestRow,
	report: Awaited<ReturnType<typeof buildBudgetV2CheckpointReport>>,
	builtPredecessor: SnapshotRow | null,
): Promise<SnapshotRow> {
	const fingerprint = await calculateCheckpointReportFingerprint(report);

	return db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;

		const [lockedReq] = await tx
			.select()
			.from(budgetV2CheckpointRequests)
			.where(eq(budgetV2CheckpointRequests.id, request.id))
			.for("update");
		if (!lockedReq) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				`checkpoint request ${request.id} vanished under lock`,
			);
		}

		const [already] = await txdb
			.select()
			.from(budgetV2CheckpointSnapshots)
			.where(eq(budgetV2CheckpointSnapshots.requestId, request.id))
			.limit(1);
		if (already) return already;

		const [predecessor] = await txdb
			.select()
			.from(budgetV2CheckpointSnapshots)
			.where(
				and(
					eq(budgetV2CheckpointSnapshots.userId, request.userId),
					eq(budgetV2CheckpointSnapshots.periodMonth, request.periodMonth),
					lt(budgetV2CheckpointSnapshots.checkpointAt, request.checkpointAt),
				),
			)
			.orderBy(desc(budgetV2CheckpointSnapshots.checkpointAt))
			.limit(1);

		if ((predecessor?.id ?? null) !== (builtPredecessor?.id ?? null)) {
			throw new BudgetError(
				"BUDGET_CHECKPOINT_REQUEST_BLOCKED",
				`checkpoint request ${request.id} predecessor changed under lock; retry on the next run`,
			);
		}

		const [inserted] = await tx
			.insert(budgetV2CheckpointSnapshots)
			.values({
				userId: request.userId,
				requestId: request.id,
				paymentEventId: request.paymentEventId,
				periodMonth: request.periodMonth,
				checkpointAt: request.checkpointAt,
				previousCheckpointSnapshotId: predecessor?.id ?? null,
				previousCheckpointAt: predecessor?.checkpointAt ?? null,
				reportSchemaVersion: report.schemaVersion,
				reportJson: report as unknown,
				reportFingerprint: fingerprint,
			})
			.onConflictDoNothing({
				target: [budgetV2CheckpointSnapshots.requestId],
			})
			.returning();
		if (inserted) return inserted;

		const [afterConflict] = await txdb
			.select()
			.from(budgetV2CheckpointSnapshots)
			.where(eq(budgetV2CheckpointSnapshots.requestId, request.id))
			.limit(1);
		if (!afterConflict) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				`checkpoint snapshot for request ${request.id} conflicted but no row is visible`,
			);
		}
		return afterConflict;
	});
}

// ============================================================================
// Replay-before-live read
// ============================================================================

export type CheckpointReplay =
	| { status: "PENDING"; paymentEventId: string }
	| {
			status: "PERSISTED";
			snapshotId: string;
			paymentEventId: string;
			periodMonth: string;
			checkpointAt: string;
			previousCheckpointAt: string | null;
			previousCheckpointSnapshotId: string | null;
			schemaVersion: string;
			fingerprint: string;
			report: unknown;
	  };

/**
 * REPLAY BEFORE LIVE (Section 9). Returns the frozen stored checkpoint snapshot
 * verbatim when one exists for `paymentEventId` -- after verifying its
 * integrity -- WITHOUT invoking `buildBudgetV2CheckpointReport`, resolving
 * current source state, refreshing food classifications, resolving current
 * relationships, or recomputing the waterfall.
 *
 * When no snapshot exists yet but a request does, reports `PENDING` (the
 * hourly processor will persist it). When neither exists, this payment event
 * is not an eligible checkpoint trigger.
 */
export async function getBudgetV2CheckpointByPaymentEventId(params: {
	db: Database;
	userId: string;
	paymentEventId: string;
}): Promise<CheckpointReplay> {
	const userId = normalizeUuid(params.userId, "userId");
	const paymentEventId = normalizeUuid(params.paymentEventId, "paymentEventId");

	const [snap] = await params.db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(
			and(
				eq(budgetV2CheckpointSnapshots.userId, userId),
				eq(budgetV2CheckpointSnapshots.paymentEventId, paymentEventId),
			),
		)
		.limit(1);

	if (snap) {
		await verifyStoredCheckpointSnapshot({
			reportSchemaVersion: snap.reportSchemaVersion,
			reportJson: snap.reportJson,
			reportFingerprint: snap.reportFingerprint,
			paymentEventId: snap.paymentEventId,
			periodMonth: snap.periodMonth,
			checkpointAt: snap.checkpointAt,
			previousCheckpointAt: snap.previousCheckpointAt,
		});
		return {
			status: "PERSISTED",
			snapshotId: snap.id,
			paymentEventId: snap.paymentEventId,
			periodMonth: snap.periodMonth,
			checkpointAt: snap.checkpointAt.toISOString(),
			previousCheckpointAt: snap.previousCheckpointAt
				? snap.previousCheckpointAt.toISOString()
				: null,
			previousCheckpointSnapshotId: snap.previousCheckpointSnapshotId,
			schemaVersion: snap.reportSchemaVersion,
			fingerprint: snap.reportFingerprint,
			report: snap.reportJson,
		};
	}

	const [req] = await params.db
		.select({ id: budgetV2CheckpointRequests.id })
		.from(budgetV2CheckpointRequests)
		.where(
			and(
				eq(budgetV2CheckpointRequests.userId, userId),
				eq(budgetV2CheckpointRequests.paymentEventId, paymentEventId),
			),
		)
		.limit(1);
	if (req) return { status: "PENDING", paymentEventId };

	throw new BudgetError(
		"BUDGET_CHECKPOINT_TRIGGER_CARD_INVALID",
		`no Budget V2 checkpoint request exists for payment event ${paymentEventId}`,
	);
}
