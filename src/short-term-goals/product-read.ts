import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../db/client";
import { midasAccounts, midasAllocationTransfers } from "../db/schema/midas";
import {
	type ShortTermGoalFundingStatus,
	type ShortTermGoalStatus,
	shortTermGoalPriorityRevisions,
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import {
	parseMoneyString,
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { validateCanonicalUuid } from "./calendar";
import { ShortTermGoalError } from "./errors";
import {
	decodeShortTermGoalCursor,
	type ShortTermGoalCursor,
} from "./pagination";
import type { ShortTermGoalRecord } from "./service";

// ============================================================================
// Public DTO Interface
// ============================================================================

export interface ShortTermGoalProductDto {
	goalId: string;
	midasAccountId: string;
	midasBucketId: string;
	status: ShortTermGoalStatus;
	name: string;
	fundingTarget: string;
	accumulatedAmount: string;
	remainingToTarget: string;
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	priority: number | null;
	latestRevisionNo: number;
	createdAt: string;
	updatedAt: string;
}

export function toShortTermGoalProductDto(
	record: ShortTermGoalRecord,
): ShortTermGoalProductDto {
	const createdAtStr =
		record.createdAt instanceof Date
			? record.createdAt.toISOString()
			: String(record.createdAt);
	const updatedAtStr =
		record.updatedAt instanceof Date
			? record.updatedAt.toISOString()
			: String(record.updatedAt);

	return {
		goalId: record.id,
		midasAccountId: record.midasAccountId,
		midasBucketId: record.midasBucketId,
		status: record.status,
		name: record.name,
		fundingTarget: record.fundingTarget,
		accumulatedAmount: record.accumulatedAmount,
		remainingToTarget: record.remainingToTarget,
		fundingStatus: record.fundingStatus,
		progressPercentage: record.progressPercentage,
		targetDate: record.targetDate,
		maxBudget: record.maxBudget,
		targetPrice: record.targetPrice,
		productUrl: record.productUrl,
		note: record.note,
		priority: record.priority,
		latestRevisionNo: record.latestRevisionNo,
		createdAt: createdAtStr,
		updatedAt: updatedAtStr,
	};
}

// ============================================================================
// Funding Metrics Helper
// ============================================================================

function deriveFundingMetrics(balanceCents: bigint, targetCents: bigint) {
	const accumulatedAmount = (Number(balanceCents) / 100).toFixed(2);
	let remainingToTarget = "0.00";
	let fundingStatus: ShortTermGoalFundingStatus = "EMPTY";
	let progressPercentage = 0;

	if (targetCents > 0n) {
		const remCents =
			targetCents > balanceCents ? targetCents - balanceCents : 0n;
		remainingToTarget = (Number(remCents) / 100).toFixed(2);

		if (balanceCents === 0n) {
			fundingStatus = "EMPTY";
			progressPercentage = 0;
		} else if (balanceCents >= targetCents) {
			fundingStatus = "TARGET_REACHED";
			progressPercentage = 100;
		} else {
			fundingStatus = "PARTIAL";
			progressPercentage = Math.min(
				99.99,
				Math.round((Number(balanceCents) / Number(targetCents)) * 10000) / 100,
			);
		}
	} else {
		remainingToTarget = "0.00";
		fundingStatus = balanceCents > 0n ? "TARGET_REACHED" : "EMPTY";
		progressPercentage = balanceCents > 0n ? 100 : 0;
	}

	return {
		accumulatedAmount,
		remainingToTarget,
		fundingStatus,
		progressPercentage,
	};
}

// ============================================================================
// Bounded ACTIVE Priority Page Extraction (PostgreSQL-side, no full-array load)
// ============================================================================

interface BoundedActivePriorityRow {
	goalId: string;
	priority: number;
}

/**
 * Returns at most `limitPlusOne` ACTIVE-goal IDs from the manual priority
 * ordering, starting immediately after `cursorGoalId` (or, if that ID is no
 * longer present in the current ordering, after position `cursorFallback`).
 * The complete `ordered_goal_ids` JSONB array never leaves PostgreSQL --
 * position lookup and slicing both happen in SQL via `WITH ORDINALITY`.
 */
async function fetchBoundedActivePriorityPage(
	tx: DatabaseOrTransaction,
	userId: string,
	midasAccountId: string,
	cursorGoalId: string | null,
	cursorFallback: number,
	limitPlusOne: number,
): Promise<BoundedActivePriorityRow[]> {
	const query = sql`
		WITH latest_priority AS (
			SELECT ${shortTermGoalPriorityRevisions.orderedGoalIds} AS ordered_goal_ids
			FROM ${shortTermGoalPriorityRevisions}
			WHERE ${shortTermGoalPriorityRevisions.midasAccountId} = ${midasAccountId}
				AND ${shortTermGoalPriorityRevisions.userId} = ${userId}
			ORDER BY ${shortTermGoalPriorityRevisions.revisionNo} DESC
			LIMIT 1
		),
		elems AS (
			SELECT t.elem AS goal_id, t.ordinality::int AS ordinality
			FROM latest_priority,
				jsonb_array_elements_text(latest_priority.ordered_goal_ids) WITH ORDINALITY AS t(elem, ordinality)
		),
		cursor_pos AS (
			SELECT ordinality FROM elems WHERE goal_id = ${cursorGoalId} LIMIT 1
		)
		SELECT goal_id, ordinality
		FROM elems
		WHERE ordinality > COALESCE((SELECT ordinality FROM cursor_pos), ${cursorFallback})
		ORDER BY ordinality
		LIMIT ${limitPlusOne}
	`;

	const rawResult = await tx.execute(query);
	const rows = (Array.isArray(rawResult)
		? rawResult
		: ((rawResult as { rows?: unknown[] }).rows ?? [])) as unknown as Array<{
		goal_id: string;
		ordinality: number;
	}>;

	return rows.map((r) => ({
		goalId: r.goal_id,
		priority: Number(r.ordinality),
	}));
}

// ============================================================================
// Bounded Keyset Query
// ============================================================================

export interface ListBoundedShortTermGoalsParams {
	db: Database;
	userId: string;
	midasAccountId?: string | undefined;
	status?: ShortTermGoalStatus | undefined;
	limit: number;
	afterCursor?: ShortTermGoalCursor | undefined;
	rawCursor?: string | undefined;
}

export interface ListBoundedShortTermGoalsResult {
	goals: ShortTermGoalProductDto[];
	hasMore: boolean;
	nextCursor: ShortTermGoalCursor | null;
}

export async function listBoundedShortTermGoals({
	db,
	userId,
	midasAccountId,
	status,
	limit,
	afterCursor,
	rawCursor,
}: ListBoundedShortTermGoalsParams): Promise<ListBoundedShortTermGoalsResult> {
	const validUserId = validateCanonicalUuid(userId, "userId");

	return await db.transaction(async (tx) => {
		let resolvedMidasAccountId: string;
		if (midasAccountId !== undefined) {
			resolvedMidasAccountId = validateCanonicalUuid(
				midasAccountId,
				"midasAccountId",
			);
		} else {
			const [acc] = await tx
				.select({ id: midasAccounts.id })
				.from(midasAccounts)
				.where(eq(midasAccounts.userId, validUserId))
				.limit(1);
			if (!acc) {
				return {
					goals: [],
					hasMore: false,
					nextCursor: null,
				};
			}
			resolvedMidasAccountId = acc.id;
		}

		// Decode cursor with expected scope if raw cursor was passed
		let effectiveCursor = afterCursor;
		if (rawCursor !== undefined) {
			effectiveCursor = decodeShortTermGoalCursor(rawCursor, {
				userId: validUserId,
				midasAccountId: resolvedMidasAccountId,
				status,
			});
		} else if (effectiveCursor) {
			// Validate scope on decoded cursor as well
			if (
				effectiveCursor.userId !== validUserId ||
				effectiveCursor.midasAccountId !== resolvedMidasAccountId ||
				effectiveCursor.status !== (status ?? "ALL")
			) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_INPUT",
					"Invalid short-term goal pagination cursor scope",
				);
			}
		}

		// Verify Midas account ownership
		const [accRecord] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, resolvedMidasAccountId),
					eq(midasAccounts.userId, validUserId),
				),
			)
			.limit(1);

		if (!accRecord) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND",
				"Midas account not found",
			);
		}

		// Priority number (1-based position in the manual ACTIVE ordering) is
		// populated only for the bounded candidate IDs actually returned below --
		// the complete ordered_goal_ids array is never loaded into this map.
		const priorityMap = new Map<string, number>();

		// 2. Select the bounded list of goal IDs (limit + 1)
		const candidateGoalIds: string[] = [];

		if (status === "ACTIVE") {
			const cursorGoalId = effectiveCursor?.id ?? null;
			const cursorFallback = effectiveCursor?.priority ?? 0;
			const activeRows = await fetchBoundedActivePriorityPage(
				tx,
				validUserId,
				resolvedMidasAccountId,
				cursorGoalId,
				cursorFallback,
				limit + 1,
			);
			for (const row of activeRows) {
				candidateGoalIds.push(row.goalId);
				priorityMap.set(row.goalId, row.priority);
			}
		} else if (status === "COMPLETED" || status === "CANCELLED") {
			// Terminal goals bounded query via SQL
			const latestRevSubquery = tx
				.select({
					goalId: shortTermGoalRevisions.goalId,
					maxRev: sql<number>`MAX(${shortTermGoalRevisions.revisionNo})`.as(
						"max_rev",
					),
				})
				.from(shortTermGoalRevisions)
				.where(eq(shortTermGoalRevisions.userId, validUserId))
				.groupBy(shortTermGoalRevisions.goalId)
				.as("latest_rev");

			const terminalConditions = [
				eq(shortTermGoals.midasAccountId, resolvedMidasAccountId),
				eq(shortTermGoals.userId, validUserId),
				eq(shortTermGoalRevisions.status, status),
			];

			if (effectiveCursor) {
				const cursorDate = new Date(effectiveCursor.createdAt);
				const cursorCond = or(
					lt(shortTermGoals.createdAt, cursorDate),
					and(
						eq(shortTermGoals.createdAt, cursorDate),
						gt(shortTermGoals.id, effectiveCursor.id),
					),
				);
				if (cursorCond) {
					terminalConditions.push(cursorCond);
				}
			}

			const terminalRows = await tx
				.select({ id: shortTermGoals.id })
				.from(shortTermGoals)
				.innerJoin(
					shortTermGoalRevisions,
					eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
				)
				.innerJoin(
					latestRevSubquery,
					and(
						eq(latestRevSubquery.goalId, shortTermGoals.id),
						eq(shortTermGoalRevisions.revisionNo, latestRevSubquery.maxRev),
					),
				)
				.where(and(...terminalConditions))
				.orderBy(desc(shortTermGoals.createdAt), asc(shortTermGoals.id))
				.limit(limit + 1);

			candidateGoalIds.push(...terminalRows.map((r) => r.id));
		} else {
			// All goals (Active priority first, then Terminal by createdAt DESC, id ASC)
			if (effectiveCursor && effectiveCursor.priority === null) {
				// Cursor is already in terminal section
				const latestRevSubquery = tx
					.select({
						goalId: shortTermGoalRevisions.goalId,
						maxRev: sql<number>`MAX(${shortTermGoalRevisions.revisionNo})`.as(
							"max_rev",
						),
					})
					.from(shortTermGoalRevisions)
					.where(eq(shortTermGoalRevisions.userId, validUserId))
					.groupBy(shortTermGoalRevisions.goalId)
					.as("latest_rev");

				const cursorDate = new Date(effectiveCursor.createdAt);
				const terminalRows = await tx
					.select({ id: shortTermGoals.id })
					.from(shortTermGoals)
					.innerJoin(
						shortTermGoalRevisions,
						eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
					)
					.innerJoin(
						latestRevSubquery,
						and(
							eq(latestRevSubquery.goalId, shortTermGoals.id),
							eq(shortTermGoalRevisions.revisionNo, latestRevSubquery.maxRev),
						),
					)
					.where(
						and(
							eq(shortTermGoals.midasAccountId, resolvedMidasAccountId),
							eq(shortTermGoals.userId, validUserId),
							sql`${shortTermGoalRevisions.status} != 'ACTIVE'`,
							or(
								lt(shortTermGoals.createdAt, cursorDate),
								and(
									eq(shortTermGoals.createdAt, cursorDate),
									gt(shortTermGoals.id, effectiveCursor.id),
								),
							),
						),
					)
					.orderBy(desc(shortTermGoals.createdAt), asc(shortTermGoals.id))
					.limit(limit + 1);

				candidateGoalIds.push(...terminalRows.map((r) => r.id));
			} else {
				// Starting from active section
				const cursorGoalId =
					effectiveCursor && effectiveCursor.priority !== null
						? effectiveCursor.id
						: null;
				const cursorFallback =
					effectiveCursor && effectiveCursor.priority !== null
						? effectiveCursor.priority
						: 0;
				const activeRows = await fetchBoundedActivePriorityPage(
					tx,
					validUserId,
					resolvedMidasAccountId,
					cursorGoalId,
					cursorFallback,
					limit + 1,
				);
				for (const row of activeRows) {
					candidateGoalIds.push(row.goalId);
					priorityMap.set(row.goalId, row.priority);
				}

				if (candidateGoalIds.length < limit + 1) {
					const remainingNeeded = limit + 1 - candidateGoalIds.length;
					const latestRevSubquery = tx
						.select({
							goalId: shortTermGoalRevisions.goalId,
							maxRev: sql<number>`MAX(${shortTermGoalRevisions.revisionNo})`.as(
								"max_rev",
							),
						})
						.from(shortTermGoalRevisions)
						.where(eq(shortTermGoalRevisions.userId, validUserId))
						.groupBy(shortTermGoalRevisions.goalId)
						.as("latest_rev");

					const terminalRows = await tx
						.select({ id: shortTermGoals.id })
						.from(shortTermGoals)
						.innerJoin(
							shortTermGoalRevisions,
							eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
						)
						.innerJoin(
							latestRevSubquery,
							and(
								eq(latestRevSubquery.goalId, shortTermGoals.id),
								eq(shortTermGoalRevisions.revisionNo, latestRevSubquery.maxRev),
							),
						)
						.where(
							and(
								eq(shortTermGoals.midasAccountId, resolvedMidasAccountId),
								eq(shortTermGoals.userId, validUserId),
								sql`${shortTermGoalRevisions.status} != 'ACTIVE'`,
							),
						)
						.orderBy(desc(shortTermGoals.createdAt), asc(shortTermGoals.id))
						.limit(remainingNeeded);

					candidateGoalIds.push(...terminalRows.map((r) => r.id));
				}
			}
		}

		if (candidateGoalIds.length === 0) {
			return {
				goals: [],
				hasMore: false,
				nextCursor: null,
			};
		}

		// 3. Fetch goal anchors for the bounded candidate IDs
		const goalRows = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(
					eq(shortTermGoals.userId, validUserId),
					inArray(shortTermGoals.id, candidateGoalIds),
				),
			);

		const goalMap = new Map<string, (typeof goalRows)[0]>();
		for (const g of goalRows) {
			goalMap.set(g.id, g);
		}

		// 4. Fetch exactly the current/latest revision per bounded candidate goal
		// (PostgreSQL DISTINCT ON, not the full append-only revision history).
		const revRows = await tx
			.selectDistinctOn([shortTermGoalRevisions.goalId])
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, validUserId),
					inArray(shortTermGoalRevisions.goalId, candidateGoalIds),
				),
			)
			.orderBy(
				shortTermGoalRevisions.goalId,
				desc(shortTermGoalRevisions.revisionNo),
			);

		const latestRevMap = new Map<string, (typeof revRows)[0]>();
		for (const r of revRows) {
			latestRevMap.set(r.goalId, r);
		}

		// 5. Aggregate bucket balances in PostgreSQL for only the bounded
		// candidate buckets -- raw transfer-history rows never reach Node.
		const bucketIds = goalRows.map((g) => g.midasBucketId);
		const bucketBalanceMap = new Map<string, bigint>();
		for (const bId of bucketIds) {
			bucketBalanceMap.set(bId, 0n);
		}

		if (bucketIds.length > 0) {
			const bucketIdList = sql.join(
				bucketIds.map((id) => sql`${id}`),
				sql`, `,
			);

			const balanceQuery = sql`
				SELECT bucket_id, COALESCE(SUM(delta), 0)::text AS total
				FROM (
					SELECT ${midasAllocationTransfers.toBucketId} AS bucket_id, ${midasAllocationTransfers.amount} AS delta
					FROM ${midasAllocationTransfers}
					WHERE ${midasAllocationTransfers.midasAccountId} = ${resolvedMidasAccountId}
						AND ${midasAllocationTransfers.toBucketId} IN (${bucketIdList})
					UNION ALL
					SELECT ${midasAllocationTransfers.fromBucketId} AS bucket_id, -${midasAllocationTransfers.amount} AS delta
					FROM ${midasAllocationTransfers}
					WHERE ${midasAllocationTransfers.midasAccountId} = ${resolvedMidasAccountId}
						AND ${midasAllocationTransfers.fromBucketId} IN (${bucketIdList})
				) bucket_deltas
				GROUP BY bucket_id
			`;

			const rawBalanceResult = await tx.execute(balanceQuery);
			const balanceRows = (Array.isArray(rawBalanceResult)
				? rawBalanceResult
				: ((rawBalanceResult as { rows?: unknown[] }).rows ??
					[])) as unknown as Array<{ bucket_id: string; total: string }>;

			for (const row of balanceRows) {
				if (bucketBalanceMap.has(row.bucket_id)) {
					bucketBalanceMap.set(
						row.bucket_id,
						parseSignedAggregateMoneyString(row.total).cents,
					);
				}
			}
		}

		// 6. Build DTOs in order of candidateGoalIds
		const resultDtos: ShortTermGoalProductDto[] = [];
		for (const gId of candidateGoalIds) {
			const goal = goalMap.get(gId);
			const rev = latestRevMap.get(gId);
			if (!goal || !rev) continue;

			const currentBalanceCents =
				bucketBalanceMap.get(goal.midasBucketId) ?? 0n;
			const targetCents = parseMoneyString(rev.fundingTarget).cents;
			const {
				accumulatedAmount,
				remainingToTarget,
				fundingStatus,
				progressPercentage,
			} = deriveFundingMetrics(currentBalanceCents, targetCents);

			const pNum = priorityMap.get(gId) ?? null;

			resultDtos.push({
				goalId: goal.id,
				midasAccountId: goal.midasAccountId,
				midasBucketId: goal.midasBucketId,
				status: rev.status as ShortTermGoalStatus,
				name: rev.name,
				fundingTarget: rev.fundingTarget,
				accumulatedAmount,
				remainingToTarget,
				fundingStatus,
				progressPercentage,
				targetDate: rev.targetDate,
				maxBudget: rev.maxBudget,
				targetPrice: rev.targetPrice,
				productUrl: rev.productUrl,
				note: rev.note,
				priority: pNum,
				latestRevisionNo: rev.revisionNo,
				createdAt:
					goal.createdAt instanceof Date
						? goal.createdAt.toISOString()
						: String(goal.createdAt),
				updatedAt:
					rev.occurredAt instanceof Date
						? rev.occurredAt.toISOString()
						: String(rev.occurredAt),
			});
		}

		const hasMore = resultDtos.length > limit;
		const page = resultDtos.slice(0, limit);

		let nextCursor: ShortTermGoalCursor | null = null;
		const lastItem = page[page.length - 1];
		if (hasMore && lastItem) {
			nextCursor = {
				v: 1,
				userId: validUserId,
				midasAccountId: resolvedMidasAccountId,
				status: status ?? "ALL",
				priority: lastItem.priority,
				createdAt: lastItem.createdAt,
				id: lastItem.goalId,
			};
		}

		return {
			goals: page,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// Revision-Scoped DTO (historical-replay-safe mutation response)
// ============================================================================

/**
 * Builds the product DTO for exactly one goal revision (by revisionId), not
 * "whatever the latest revision currently is". This is the historical-replay
 * fixture used by mutation routes: when an idempotency key resolves to an
 * earlier revision (a later key has since advanced the goal further), the
 * caller must see the source-authoritative snapshot owned by their key, not
 * the goal's current live configuration. Funding metrics remain live -- the
 * Midas allocation ledger is an independent append-only stream, not owned by
 * any single goal-configuration revision.
 */
export async function buildShortTermGoalProductDtoForRevision(
	db: Database,
	userId: string,
	goalId: string,
	revisionId: string,
): Promise<ShortTermGoalProductDto> {
	const validUserId = validateCanonicalUuid(userId, "userId");
	const validGoalId = validateCanonicalUuid(goalId, "goalId");

	return await db.transaction(async (tx) => {
		const [goal] = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(
					eq(shortTermGoals.id, validGoalId),
					eq(shortTermGoals.userId, validUserId),
				),
			)
			.limit(1);
		if (!goal) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"Short-term goal not found",
			);
		}

		const [rev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.id, revisionId),
					eq(shortTermGoalRevisions.userId, validUserId),
					eq(shortTermGoalRevisions.goalId, validGoalId),
				),
			)
			.limit(1);
		if (!rev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"Short-term goal revision not found",
			);
		}

		// Live bucket balance -- exactly one bucket, bounded aggregate.
		const balanceQuery = sql`
			SELECT COALESCE(SUM(delta), 0)::text AS total
			FROM (
				SELECT ${midasAllocationTransfers.amount} AS delta
				FROM ${midasAllocationTransfers}
				WHERE ${midasAllocationTransfers.midasAccountId} = ${goal.midasAccountId}
					AND ${midasAllocationTransfers.toBucketId} = ${goal.midasBucketId}
				UNION ALL
				SELECT -${midasAllocationTransfers.amount} AS delta
				FROM ${midasAllocationTransfers}
				WHERE ${midasAllocationTransfers.midasAccountId} = ${goal.midasAccountId}
					AND ${midasAllocationTransfers.fromBucketId} = ${goal.midasBucketId}
			) bucket_deltas
		`;
		const rawBalanceResult = await tx.execute(balanceQuery);
		const balanceRows = (Array.isArray(rawBalanceResult)
			? rawBalanceResult
			: ((rawBalanceResult as { rows?: unknown[] }).rows ??
				[])) as unknown as Array<{ total: string }>;
		const balanceCents = parseSignedAggregateMoneyString(
			balanceRows[0]?.total ?? "0",
		).cents;

		const targetCents = parseMoneyString(rev.fundingTarget).cents;
		const {
			accumulatedAmount,
			remainingToTarget,
			fundingStatus,
			progressPercentage,
		} = deriveFundingMetrics(balanceCents, targetCents);

		// Priority reflects the CURRENT manual ordering (best-effort, null if
		// this revision's status is not ACTIVE or the goal is not present).
		let priority: number | null = null;
		if (rev.status === "ACTIVE") {
			const posQuery = sql`
				WITH latest_priority AS (
					SELECT ${shortTermGoalPriorityRevisions.orderedGoalIds} AS ordered_goal_ids
					FROM ${shortTermGoalPriorityRevisions}
					WHERE ${shortTermGoalPriorityRevisions.midasAccountId} = ${goal.midasAccountId}
						AND ${shortTermGoalPriorityRevisions.userId} = ${validUserId}
					ORDER BY ${shortTermGoalPriorityRevisions.revisionNo} DESC
					LIMIT 1
				)
				SELECT t.ordinality::int AS ordinality
				FROM latest_priority,
					jsonb_array_elements_text(latest_priority.ordered_goal_ids) WITH ORDINALITY AS t(elem, ordinality)
				WHERE t.elem = ${validGoalId}
				LIMIT 1
			`;
			const rawPosResult = await tx.execute(posQuery);
			const posRows = (Array.isArray(rawPosResult)
				? rawPosResult
				: ((rawPosResult as { rows?: unknown[] }).rows ??
					[])) as unknown as Array<{ ordinality: number }>;
			priority = posRows[0] ? Number(posRows[0].ordinality) : null;
		}

		return {
			goalId: goal.id,
			midasAccountId: goal.midasAccountId,
			midasBucketId: goal.midasBucketId,
			status: rev.status as ShortTermGoalStatus,
			name: rev.name,
			fundingTarget: rev.fundingTarget,
			accumulatedAmount,
			remainingToTarget,
			fundingStatus,
			progressPercentage,
			targetDate: rev.targetDate,
			maxBudget: rev.maxBudget,
			targetPrice: rev.targetPrice,
			productUrl: rev.productUrl,
			note: rev.note,
			priority,
			latestRevisionNo: rev.revisionNo,
			createdAt:
				goal.createdAt instanceof Date
					? goal.createdAt.toISOString()
					: String(goal.createdAt),
			updatedAt:
				rev.occurredAt instanceof Date
					? rev.occurredAt.toISOString()
					: String(rev.occurredAt),
		};
	});
}
