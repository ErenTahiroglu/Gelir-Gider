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
 * DURABLE CHECKPOINT PERSISTENCE PROCESSOR (Checkpoint 5 / 5A).
 *
 * A bounded, retryable processor that turns pending checkpoint REQUEST rows
 * (an actual PAID payment event on a trigger card, no snapshot yet) into
 * immutable checkpoint SNAPSHOT rows.
 *
 * Guarantees:
 *   - REPLAY BEFORE LIVE: before building a report for a request, the processor
 *     re-checks whether that request's snapshot has appeared since discovery
 *     (a concurrent worker persisted it). If so it verifies the stored
 *     snapshot's integrity, treats it as chain state, and does NOT rebuild
 *     live truth for that request. `getBudgetV2CheckpointByPaymentEventId`
 *     likewise returns the frozen stored snapshot verbatim.
 *   - PREVIOUS-CHECKPOINT CHAIN is derived from stored successful snapshots,
 *     per user+periodMonth, month boundaries starting a fresh chain.
 *   - NEVER SKIP AN EARLIER PENDING CHECKPOINT: requests are processed oldest
 *     first per user+period; a fail-closed report or a predecessor-changed
 *     BUDGET_CHECKPOINT_REQUEST_BLOCKED stops that period (later requests stay
 *     pending, counted `blocked`) but never blocks other periods/users and
 *     never turns the whole run into an infrastructure failure.
 *   - CONCURRENCY: one snapshot per request (row lock + unique(request_id) +
 *     ON CONFLICT DO NOTHING); a losing worker observes the stored snapshot.
 *   - SAME-TIMESTAMP COLLISION is IDENTITY-AWARE: only TWO DISTINCT payment
 *     events in one user+period sharing the exact `checkpointAt` are a
 *     collision (fail closed, no snapshot). The same payment event represented
 *     by a still-present request row AND an already-persisted snapshot is NOT
 *     a collision.
 *   - A failed-closed report never fabricates a snapshot and never deletes the
 *     request; a later run may succeed once evidence is repaired.
 *
 * COUNT SEMANTICS: `persisted` counts snapshots THIS run newly wrote (the
 * race/insert winner). `alreadyPersisted` counts requests this run found
 * already persisted by a concurrent worker (replay / stale-pending) and did
 * NOT rebuild. `pendingDiscovered` is the count of requests with no snapshot
 * at discovery time.
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
	/** Requests with no snapshot at discovery time. */
	pendingDiscovered: number;
	/** Snapshots THIS run newly wrote (insert / race winner). */
	persisted: number;
	/** Requests THIS run found already persisted by a concurrent worker. */
	alreadyPersisted: number;
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

/**
 * IDENTITY-AWARE same-`checkpointAt` collision test. Groups the given entries
 * by exact `checkpointAt` instant and reports a collision only when a single
 * instant carries TWO OR MORE DISTINCT `paymentEventId`s. A request row and
 * its own already-persisted snapshot share a `paymentEventId`, so they never
 * count as a collision.
 */
export function hasDistinctEventTimestampCollision(
	entries: ReadonlyArray<{ checkpointAt: Date; paymentEventId: string }>,
): boolean {
	const byInstant = new Map<number, Set<string>>();
	for (const e of entries) {
		const key = e.checkpointAt.getTime();
		const set = byInstant.get(key) ?? new Set<string>();
		set.add(e.paymentEventId);
		byInstant.set(key, set);
	}
	for (const set of byInstant.values()) {
		if (set.size > 1) return true;
	}
	return false;
}

async function loadSnapshotByRequestId(
	db: Database,
	requestId: string,
): Promise<SnapshotRow | undefined> {
	const [row] = await db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(eq(budgetV2CheckpointSnapshots.requestId, requestId))
		.limit(1);
	return row;
}

async function verifySnapshotRow(row: SnapshotRow): Promise<void> {
	await verifyStoredCheckpointSnapshot({
		reportSchemaVersion: row.reportSchemaVersion,
		reportJson: row.reportJson,
		reportFingerprint: row.reportFingerprint,
		paymentEventId: row.paymentEventId,
		periodMonth: row.periodMonth,
		checkpointAt: row.checkpointAt,
		previousCheckpointAt: row.previousCheckpointAt,
	});
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
	const pendingIds = new Set(
		allRequests.filter((r) => !persistedRequestIds.has(r.id)).map((r) => r.id),
	);

	const result: ProcessPendingCheckpointRequestsResult = {
		pendingDiscovered: pendingIds.size,
		persisted: 0,
		alreadyPersisted: 0,
		blocked: 0,
		failedReport: 0,
		collisionPeriods: 0,
		periodsProcessed: 0,
	};
	if (pendingIds.size === 0) return result;

	// Group ALL requests by user+period (chronological). A request whose
	// snapshot already exists is still carried so identity-aware collision
	// detection can dedupe it against its own snapshot.
	const groups = new Map<string, RequestRow[]>();
	for (const r of allRequests) {
		const key = groupKey(r.userId, r.periodMonth);
		const list = groups.get(key) ?? [];
		list.push(r);
		groups.set(key, list);
	}

	for (const [, groupRequests] of groups) {
		const { userId, periodMonth } = groupRequests[0] as RequestRow;
		if (!groupRequests.some((r) => pendingIds.has(r.id))) continue; // nothing to do
		result.periodsProcessed += 1;

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

		// Identity-aware same-`checkpointAt` collision over {persisted chain}
		// UNION {this period's requests}. Only two DISTINCT payment events at
		// the same instant fail closed.
		if (
			hasDistinctEventTimestampCollision([
				...chain.map((s) => ({
					checkpointAt: s.checkpointAt,
					paymentEventId: s.paymentEventId,
				})),
				...groupRequests.map((r) => ({
					checkpointAt: r.checkpointAt,
					paymentEventId: r.paymentEventId,
				})),
			])
		) {
			result.collisionPeriods += 1;
			result.blocked += groupRequests.filter((r) =>
				pendingIds.has(r.id),
			).length;
			continue;
		}

		let halted = false;
		for (const request of groupRequests) {
			const isPending = pendingIds.has(request.id);
			if (halted) {
				if (isPending) result.blocked += 1;
				continue;
			}

			// Replay-before-live: has this request's snapshot appeared since
			// discovery (a concurrent worker persisted it)? If so, adopt it as
			// chain state -- never rebuild live truth for it.
			const existing = await loadSnapshotByRequestId(db, request.id);
			if (existing) {
				await verifySnapshotRow(existing);
				chain = mergeChain(chain, existing);
				if (isPending) result.alreadyPersisted += 1;
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

			let persisted: PersistResult;
			try {
				persisted = await persistCheckpointSnapshot(
					db,
					request,
					report,
					predecessor ?? null,
				);
			} catch (err) {
				if (err instanceof BudgetError) {
					// Expected concurrency/retry outcome (e.g. predecessor changed
					// under lock -> BUDGET_CHECKPOINT_REQUEST_BLOCKED). Leave the
					// request pending, halt this user+period for this run, keep
					// processing other periods/users. NOT an infra failure.
					result.blocked += 1;
					halted = true;
					continue;
				}
				throw err;
			}

			chain = mergeChain(chain, persisted.snapshot);
			if (persisted.created) result.persisted += 1;
			else if (isPending) result.alreadyPersisted += 1;
		}
	}

	return result;
}

function mergeChain(chain: SnapshotRow[], row: SnapshotRow): SnapshotRow[] {
	if (chain.some((s) => s.id === row.id)) return chain;
	return [...chain, row].sort(
		(a, b) => a.checkpointAt.getTime() - b.checkpointAt.getTime(),
	);
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

export interface PersistResult {
	snapshot: SnapshotRow;
	/** true when THIS call inserted the row; false when it observed one already present. */
	created: boolean;
}

/**
 * Hardened single-snapshot persist. Serializes on the request row, second-checks
 * for an existing snapshot under lock, recomputes the predecessor under lock and
 * refuses to persist a report built against a now-stale interval
 * (BUDGET_CHECKPOINT_REQUEST_BLOCKED -- an expected concurrency/retry outcome),
 * then inserts with ON CONFLICT (request_id) DO NOTHING. A losing worker
 * observes the stored snapshot (`created: false`); a raw 23505 never escapes.
 */
export async function persistCheckpointSnapshot(
	db: Database,
	request: RequestRow,
	report: Awaited<ReturnType<typeof buildBudgetV2CheckpointReport>>,
	builtPredecessor: SnapshotRow | null,
): Promise<PersistResult> {
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
		if (already) return { snapshot: already, created: false };

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
		if (inserted) return { snapshot: inserted, created: true };

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
		return { snapshot: afterConflict, created: false };
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
