import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	journalEntries,
	journalLines,
	ledgerAccounts,
} from "../db/schema/ledger";
import {
	midasAccounts,
	midasAllocationTransfers,
	midasBuckets,
} from "../db/schema/midas";
import {
	type MonthCloseDecision,
	type MonthCloseRoute,
	monthCloseRevisions,
	monthCloses,
} from "../db/schema/month-close";
import {
	shortTermGoalPriorityRevisions,
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import { parseSignedAggregateMoneyString } from "../ledger/money";
import { MidasError } from "../midas/errors";
import { runMonthCloseReadTransaction } from "./boundary";
import {
	dateStringToPeriodMonth,
	periodMonthToDateString,
	validateMonthCloseCanonicalUuid,
	validateMonthCloseOptionalPeriodMonth,
} from "./calendar";
import { MonthCloseError } from "./errors";
import { formatMonthCloseCents } from "./formula";
import { decodeMonthCloseCursor, encodeMonthCloseCursor } from "./pagination";
import type {
	MonthCloseAmountBreakdown,
	MonthCloseRecommendedGoal,
} from "./service";

// ============================================================================
// Public DTO Interface
// ============================================================================

export interface MonthCloseProductDto {
	monthCloseId: string;
	userId: string;
	periodMonth: string;
	budgetPlanId: string;
	budgetPlanRevisionNo: number;
	policyVersion: string;
	currency: string;
	referenceIncome: string;
	mandatory: MonthCloseAmountBreakdown;
	discretionary: MonthCloseAmountBreakdown;
	unclassifiedExpense: string;
	closeSurplus: string;
	route: MonthCloseRoute;
	decision: MonthCloseDecision;
	midasAccountId: string | null;
	targetGoalId: string | null;
	targetGoalRevisionNo: number | null;
	targetBucketId: string | null;
	fullOfferAmount: string;
	appliedAmount: string;
	unroutedAmount: string;
	midasAllocationTransferId: string | null;
	proposalFingerprint: string;
	occurredAt: string;
	createdAt: string;
}

export function toMonthCloseProductDto(model: {
	monthCloseId: string;
	userId: string;
	periodMonth: string;
	budgetPlanId: string;
	budgetPlanRevisionNo: number;
	policyVersion: string;
	currency: string;
	referenceIncome: string;
	mandatory: MonthCloseAmountBreakdown;
	discretionary: MonthCloseAmountBreakdown;
	unclassifiedExpense: string;
	closeSurplus: string;
	route: MonthCloseRoute;
	decision: MonthCloseDecision;
	midasAccountId: string | null;
	targetGoalId: string | null;
	targetGoalRevisionNo: number | null;
	targetBucketId: string | null;
	fullOfferAmount: string;
	appliedAmount: string;
	unroutedAmount: string;
	midasAllocationTransferId: string | null;
	proposalFingerprint: string;
	occurredAt: Date | string;
	createdAt: Date | string;
}): MonthCloseProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		monthCloseId: model.monthCloseId,
		userId: model.userId,
		periodMonth: model.periodMonth,
		budgetPlanId: model.budgetPlanId,
		budgetPlanRevisionNo: model.budgetPlanRevisionNo,
		policyVersion: model.policyVersion,
		currency: model.currency,
		referenceIncome: model.referenceIncome,
		mandatory: model.mandatory,
		discretionary: model.discretionary,
		unclassifiedExpense: model.unclassifiedExpense,
		closeSurplus: model.closeSurplus,
		route: model.route,
		decision: model.decision,
		midasAccountId: model.midasAccountId,
		targetGoalId: model.targetGoalId,
		targetGoalRevisionNo: model.targetGoalRevisionNo,
		targetBucketId: model.targetBucketId,
		fullOfferAmount: model.fullOfferAmount,
		appliedAmount: model.appliedAmount,
		unroutedAmount: model.unroutedAmount,
		midasAllocationTransferId: model.midasAllocationTransferId,
		proposalFingerprint: model.proposalFingerprint,
		occurredAt: occurredAtStr,
		createdAt: createdAtStr,
	};
}

// ============================================================================
// Bounded Recommended Goal Query (PostgreSQL-Side)
// ============================================================================

export async function fetchRecommendedGoalForMonthClose(
	tx: DatabaseTransaction,
	userId: string,
	midasAccountId: string,
): Promise<MonthCloseRecommendedGoal | null> {
	const result = await tx.execute<{
		goal_id: string;
		revision_no: number;
		priority: number;
		midas_bucket_id: string;
		name: string;
		funding_target: string;
		current_balance: string;
		remaining_to_target: string;
	}>(sql`
		WITH latest_priority AS (
			SELECT ordered_goal_ids
			FROM ${shortTermGoalPriorityRevisions}
			WHERE midas_account_id = ${midasAccountId}
			  AND user_id = ${userId}
			ORDER BY revision_no DESC
			LIMIT 1
		),
		prioritized_goals AS (
			SELECT
				(t.elem)::uuid AS goal_id,
				t.ordinality::int AS priority
			FROM latest_priority,
				LATERAL jsonb_array_elements_text(latest_priority.ordered_goal_ids) WITH ORDINALITY AS t(elem, ordinality)
		),
		latest_goal_revisions AS (
			SELECT DISTINCT ON (stgr.goal_id)
				stgr.goal_id,
				stgr.revision_no,
				stgr.status,
				stgr.name,
				stgr.funding_target
			FROM ${shortTermGoalRevisions} stgr
			INNER JOIN prioritized_goals pg ON pg.goal_id = stgr.goal_id
			WHERE stgr.user_id = ${userId}
			ORDER BY stgr.goal_id, stgr.revision_no DESC
		),
		goal_bucket_transfers AS (
			SELECT
				stg.id AS goal_id,
				stg.midas_bucket_id,
				lgr.revision_no,
				lgr.name,
				lgr.funding_target,
				pg.priority,
				(
					COALESCE((
						SELECT SUM(mat.amount)
						FROM ${midasAllocationTransfers} mat
						WHERE mat.to_bucket_id = stg.midas_bucket_id
					), 0) - COALESCE((
						SELECT SUM(mat.amount)
						FROM ${midasAllocationTransfers} mat
						WHERE mat.from_bucket_id = stg.midas_bucket_id
					), 0)
				) AS current_balance
			FROM prioritized_goals pg
			INNER JOIN ${shortTermGoals} stg
				ON stg.id = pg.goal_id
				AND stg.user_id = ${userId}
				AND stg.midas_account_id = ${midasAccountId}
			INNER JOIN latest_goal_revisions lgr ON lgr.goal_id = stg.id
			WHERE lgr.status = 'ACTIVE'
		)
		SELECT
			goal_id,
			revision_no,
			priority,
			midas_bucket_id,
			name,
			funding_target,
			current_balance,
			GREATEST(funding_target - current_balance, 0)::text AS remaining_to_target
		FROM goal_bucket_transfers
		WHERE current_balance < funding_target
		ORDER BY priority ASC
		LIMIT 1
	`);

	const rows = (Array.isArray(result)
		? result
		: ((result as { rows?: unknown[] }).rows ?? [])) as unknown as Array<{
		goal_id: string;
		revision_no: number;
		priority: number;
		midas_bucket_id: string;
		name: string;
		funding_target: string;
		current_balance: string;
		remaining_to_target: string;
	}>;

	const row = rows[0];
	if (!row) return null;
	return {
		goalId: row.goal_id,
		revisionNo: Number(row.revision_no),
		priority: Number(row.priority),
		bucketId: row.midas_bucket_id,
		name: row.name,
		remainingToTarget: parseSignedAggregateMoneyString(
			row.remaining_to_target ?? "0.00",
		).normalized,
	};
}

// ============================================================================
// Constant-Sized Midas Liquidity Aggregation
// ============================================================================

export interface MidasAggregateLiquidity {
	midasAccountId: string;
	ledgerAccountId: string;
	currency: string;
	physicalBalance: string;
	totalEarmarked: string;
	unallocatedBalance: string;
}

export async function getMidasAggregateLiquidityInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	midasAccountId: string,
): Promise<MidasAggregateLiquidity> {
	const [account] = await tx
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
		})
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, midasAccountId),
				eq(midasAccounts.userId, userId),
			),
		)
		.limit(1);

	if (!account) {
		throw new MidasError(
			"MIDAS_ACCOUNT_NOT_FOUND",
			"Midas liquidity account not found",
		);
	}

	const [ledgerAcc] = await tx
		.select({
			currency: ledgerAccounts.currency,
		})
		.from(ledgerAccounts)
		.where(eq(ledgerAccounts.id, account.ledgerAccountId))
		.limit(1);

	if (!ledgerAcc) {
		throw new MidasError(
			"MIDAS_LEDGER_ACCOUNT_INVALID",
			"Linked ledger account not found",
		);
	}

	// Physical balance
	const [physicalRow] = await tx
		.select({
			netDebit: sql<string>`COALESCE(SUM(${journalLines.debit}) - SUM(${journalLines.credit}), 0)::text`,
		})
		.from(journalLines)
		.innerJoin(
			journalEntries,
			eq(journalEntries.id, journalLines.journalEntryId),
		)
		.where(
			and(
				eq(journalLines.accountId, account.ledgerAccountId),
				eq(journalEntries.status, "POSTED"),
			),
		);

	const physicalParsed = parseSignedAggregateMoneyString(
		physicalRow?.netDebit ?? "0.00",
	);
	const physicalBalanceCents = physicalParsed.cents;

	if (physicalBalanceCents < 0n) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: negative physical balance on linked ledger account (${physicalParsed.normalized})`,
		);
	}

	// SQL-aggregate bucket & transfer validation
	const aggResult = await tx.execute<{
		total_earmarked: string;
		min_bucket_balance: string;
		min_bucket_code: string | null;
		sum_bucket_balances: string;
	}>(sql`
		WITH bucket_balances AS (
			SELECT
				b.id,
				b.code,
				COALESCE(SUM(CASE WHEN t.to_bucket_id = b.id THEN t.amount ELSE 0 END), 0)
				- COALESCE(SUM(CASE WHEN t.from_bucket_id = b.id THEN t.amount ELSE 0 END), 0) AS balance
			FROM ${midasBuckets} b
			LEFT JOIN ${midasAllocationTransfers} t
				ON (t.to_bucket_id = b.id OR t.from_bucket_id = b.id)
				AND t.midas_account_id = ${account.id}
			WHERE b.midas_account_id = ${account.id}
			GROUP BY b.id, b.code
		),
		earmarked AS (
			SELECT
				COALESCE(SUM(CASE WHEN from_bucket_id IS NULL AND to_bucket_id IS NOT NULL THEN amount ELSE 0 END), 0)
				- COALESCE(SUM(CASE WHEN from_bucket_id IS NOT NULL AND to_bucket_id IS NULL THEN amount ELSE 0 END), 0) AS total_earmarked
			FROM ${midasAllocationTransfers}
			WHERE midas_account_id = ${account.id}
		)
		SELECT
			(SELECT total_earmarked::text FROM earmarked) AS total_earmarked,
			COALESCE((SELECT MIN(balance)::text FROM bucket_balances), '0.00') AS min_bucket_balance,
			(SELECT code FROM bucket_balances WHERE balance < 0 ORDER BY code ASC LIMIT 1) AS min_bucket_code,
			COALESCE((SELECT SUM(balance)::text FROM bucket_balances), '0.00') AS sum_bucket_balances
	`);

	const aggRows = (Array.isArray(aggResult)
		? aggResult
		: ((aggResult as { rows?: unknown[] }).rows ?? [])) as unknown as Array<{
		total_earmarked: string;
		min_bucket_balance: string;
		min_bucket_code: string | null;
		sum_bucket_balances: string;
	}>;

	const aggRow = aggRows[0] ?? {
		total_earmarked: "0.00",
		min_bucket_balance: "0.00",
		min_bucket_code: null,
		sum_bucket_balances: "0.00",
	};

	const totalEarmarkedCents = parseSignedAggregateMoneyString(
		aggRow.total_earmarked ?? "0.00",
	).cents;
	const minBucketBalanceCents = parseSignedAggregateMoneyString(
		aggRow.min_bucket_balance ?? "0.00",
	).cents;
	const sumBucketBalancesCents = parseSignedAggregateMoneyString(
		aggRow.sum_bucket_balances ?? "0.00",
	).cents;

	if (minBucketBalanceCents < 0n) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: bucket "${aggRow.min_bucket_code ?? "UNKNOWN"}" has negative balance (${formatMonthCloseCents(minBucketBalanceCents)})`,
		);
	}

	if (sumBucketBalancesCents !== totalEarmarkedCents) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: sum of bucket balances (${formatMonthCloseCents(sumBucketBalancesCents)}) does not match total earmarked (${formatMonthCloseCents(totalEarmarkedCents)})`,
		);
	}

	if (totalEarmarkedCents < 0n) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: total earmarked is negative (${formatMonthCloseCents(totalEarmarkedCents)})`,
		);
	}

	if (totalEarmarkedCents > physicalBalanceCents) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: total earmarked (${formatMonthCloseCents(totalEarmarkedCents)}) exceeds physical balance (${formatMonthCloseCents(physicalBalanceCents)})`,
		);
	}

	const unallocatedCents = physicalBalanceCents - totalEarmarkedCents;

	return {
		midasAccountId: account.id,
		ledgerAccountId: account.ledgerAccountId,
		currency: ledgerAcc.currency,
		physicalBalance: formatMonthCloseCents(physicalBalanceCents),
		totalEarmarked: formatMonthCloseCents(totalEarmarkedCents),
		unallocatedBalance: formatMonthCloseCents(unallocatedCents),
	};
}

// ============================================================================
// Bounded Keyset Listing
// ============================================================================

export interface ListBoundedMonthClosesParams {
	db: Database;
	userId: string;
	limit: number;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
	rawCursor?: string | undefined;
}

export interface ListBoundedMonthClosesResult {
	monthCloses: MonthCloseProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export async function listBoundedMonthCloses({
	db,
	userId,
	limit,
	periodMonthFrom,
	periodMonthUntil,
	rawCursor,
}: ListBoundedMonthClosesParams): Promise<ListBoundedMonthClosesResult> {
	const validUserId = validateMonthCloseCanonicalUuid(userId, "userId");
	const validPeriodMonthFrom =
		validateMonthCloseOptionalPeriodMonth(periodMonthFrom);
	const validPeriodMonthUntil =
		validateMonthCloseOptionalPeriodMonth(periodMonthUntil);

	if (
		validPeriodMonthFrom !== undefined &&
		validPeriodMonthUntil !== undefined &&
		periodMonthToDateString(validPeriodMonthFrom) >
			periodMonthToDateString(validPeriodMonthUntil)
	) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`periodMonthFrom "${validPeriodMonthFrom}" must not be after periodMonthUntil "${validPeriodMonthUntil}"`,
		);
	}

	const cursor = rawCursor
		? decodeMonthCloseCursor(rawCursor, {
				userId: validUserId,
				periodMonthFrom: validPeriodMonthFrom,
				periodMonthUntil: validPeriodMonthUntil,
			})
		: undefined;

	return runMonthCloseReadTransaction(db, async (tx) => {
		const conditions = [eq(monthCloses.userId, validUserId)];

		if (validPeriodMonthFrom !== undefined) {
			conditions.push(
				gte(
					monthCloses.periodMonth,
					periodMonthToDateString(validPeriodMonthFrom),
				),
			);
		}
		if (validPeriodMonthUntil !== undefined) {
			conditions.push(
				lte(
					monthCloses.periodMonth,
					periodMonthToDateString(validPeriodMonthUntil),
				),
			);
		}
		if (cursor) {
			conditions.push(
				lt(
					monthCloses.periodMonth,
					periodMonthToDateString(cursor.periodMonth),
				),
			);
		}

		const rows = await tx
			.select({
				monthCloseId: monthCloses.id,
				userId: monthCloses.userId,
				periodMonth: monthCloses.periodMonth,
				budgetPlanId: monthCloses.budgetPlanId,
				createdAt: monthCloses.createdAt,
				rev: monthCloseRevisions,
			})
			.from(monthCloses)
			.innerJoin(
				monthCloseRevisions,
				eq(monthCloseRevisions.monthCloseId, monthCloses.id),
			)
			.where(and(...conditions))
			.orderBy(desc(monthCloses.periodMonth))
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		let nextCursor: string | null = null;
		const lastRow = pageRows[pageRows.length - 1];
		if (hasMore && lastRow) {
			nextCursor = encodeMonthCloseCursor({
				v: 1,
				userId: validUserId,
				periodMonthFrom: validPeriodMonthFrom ?? null,
				periodMonthUntil: validPeriodMonthUntil ?? null,
				periodMonth: dateStringToPeriodMonth(lastRow.periodMonth),
			});
		}

		const monthClosesList: MonthCloseProductDto[] = pageRows.map((r) =>
			toMonthCloseProductDto({
				monthCloseId: r.monthCloseId,
				userId: r.userId,
				periodMonth: dateStringToPeriodMonth(r.periodMonth),
				budgetPlanId: r.budgetPlanId,
				budgetPlanRevisionNo: r.rev.budgetPlanRevisionNo,
				policyVersion: r.rev.policyVersion,
				currency: r.rev.currency,
				referenceIncome: r.rev.referenceIncome,
				mandatory: {
					ceiling: r.rev.mandatoryCeiling,
					actualExpense: r.rev.mandatoryExpense,
					unused: r.rev.mandatoryUnused,
				},
				discretionary: {
					ceiling: r.rev.discretionaryCeiling,
					actualExpense: r.rev.discretionaryExpense,
					unused: r.rev.discretionaryUnused,
				},
				unclassifiedExpense: r.rev.unclassifiedExpense,
				closeSurplus: r.rev.closeSurplus,
				route: r.rev.route as MonthCloseRoute,
				decision: r.rev.decision as MonthCloseDecision,
				midasAccountId: r.rev.midasAccountId,
				targetGoalId: r.rev.targetGoalId,
				targetGoalRevisionNo: r.rev.targetGoalRevisionNo,
				targetBucketId: r.rev.targetBucketId,
				fullOfferAmount: r.rev.fullOfferAmount,
				appliedAmount: r.rev.appliedAmount,
				unroutedAmount: r.rev.unroutedAmount,
				midasAllocationTransferId: r.rev.midasAllocationTransferId,
				proposalFingerprint: r.rev.proposalFingerprint,
				occurredAt: r.rev.occurredAt,
				createdAt: r.rev.createdAt,
			}),
		);

		return {
			monthCloses: monthClosesList,
			limit,
			hasMore,
			nextCursor,
		};
	});
}
