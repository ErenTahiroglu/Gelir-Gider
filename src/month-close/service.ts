import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../db/schema/budget";
import { journalEntries, journalLines } from "../db/schema/ledger";
import { midasAccounts } from "../db/schema/midas";
import {
	type MonthCloseDecision,
	type MonthCloseRoute,
	monthCloseRevisions,
	monthCloses,
} from "../db/schema/month-close";
import { parseSignedAggregateMoneyString } from "../ledger/money";
import { ensureUserExpenseSystemAccountsInTransaction } from "../ledger/system-expense-accounts";
import { MidasError } from "../midas/errors";
import {
	createMidasAllocationTransferInTransaction,
	ensureMidasSingletonBucketInTransaction,
	getMidasLiquidityStateInTransaction,
	lockMidasAllocationStateInTransaction,
} from "../midas/service";
import { ShortTermGoalError } from "../short-term-goals/errors";
import {
	fundShortTermGoal,
	listShortTermGoalsInTransaction,
} from "../short-term-goals/service";
import {
	mapMidasError,
	mapShortTermGoalError,
	runMonthCloseReadTransaction,
	runMonthCloseTransaction,
} from "./boundary";
import {
	dateStringToPeriodMonth,
	getMonthCloseIstanbulPeriodBoundaries,
	isMonthCloseperiodEnded,
	periodMonthToDateString,
	validateMonthCloseCanonicalUuid,
	validateMonthCloseDecision,
	validateMonthCloseFingerprint,
	validateMonthCloseIdempotencyKey,
	validateMonthCloseOccurredAt,
	validateMonthCloseOptionalPartialAmount,
	validateMonthCloseOptionalPeriodMonth,
	validateMonthClosePeriodMonth,
} from "./calendar";
import { MonthCloseError } from "./errors";
import {
	calculateMonthCloseApplyFingerprint,
	calculateMonthCloseProposalFingerprint,
	deriveMonthCloseChildIdempotencyKey,
	type MonthCloseRecommendedGoalFingerprintInput,
} from "./fingerprint";
import {
	computeMonthCloseFullOffer,
	computeMonthCloseSurplusCents,
	computeMonthCloseUnusedCents,
	formatMonthCloseCents,
} from "./formula";

const MEDIUM_TERM_RESERVE_BUCKET_CODE = "MEDIUM_TERM_RESERVE";
const MEDIUM_TERM_RESERVE_BUCKET_NAME = "Medium-Term Reserve";

export interface MonthCloseRecommendedGoal {
	goalId: string;
	revisionNo: number;
	priority: number;
	bucketId: string;
	name: string;
	remainingToTarget: string;
}

export interface MonthCloseAmountBreakdown {
	ceiling: string;
	actualExpense: string;
	unused: string;
}

export interface MonthCloseProposal {
	periodMonth: string;
	budgetPlanId: string | null;
	budgetPlanRevisionNo: number | null;
	policyVersion: string | null;
	currency: string | null;
	referenceIncome: string | null;
	mandatory: MonthCloseAmountBreakdown | null;
	discretionary: MonthCloseAmountBreakdown | null;
	unclassifiedExpense: string | null;
	closeSurplus: string | null;
	midasAccountId: string | null;
	midasUnallocatedBalance: string | null;
	route: MonthCloseRoute | "BLOCKED";
	recommendedGoal: MonthCloseRecommendedGoal | null;
	fullOfferAmount: string | null;
	unroutedRemainderIfFull: string | null;
	proposalFingerprint: string;
	blockedReason: string | null;
}

export interface MonthCloseReadModel {
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
	occurredAt: Date;
	createdAt: Date;
}

export interface PreviewMonthCloseParams {
	db: Database;
	userId: string;
	periodMonth: string;
}

export interface CloseMonthParams {
	db: Database;
	userId: string;
	periodMonth: string;
	expectedProposalFingerprint: string;
	decision?: "FULL" | "PARTIAL" | "SKIP" | undefined;
	partialAmount?: string | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetMonthCloseParams {
	db: Database;
	userId: string;
	periodMonth: string;
}

export interface ListMonthClosesParams {
	db: Database;
	userId: string;
	periodMonth?: string | undefined;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
}

// ============================================================================
// Internal: authoritative figure resolution
// ============================================================================

interface ResolvedBudgetPlan {
	budgetPlanId: string;
	revisionNo: number;
	policyVersion: string;
	currency: string;
	referenceIncome: string;
	mandatoryCeiling: string;
	discretionaryCeiling: string;
}

async function resolveActiveBudgetPlanInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	periodMonthDate: string,
): Promise<
	| ResolvedBudgetPlan
	| {
			blockedReason:
				| "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND"
				| "MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE";
	  }
> {
	const [plan] = await tx
		.select({ id: monthlyBudgetPlans.id })
		.from(monthlyBudgetPlans)
		.where(
			and(
				eq(monthlyBudgetPlans.userId, userId),
				eq(monthlyBudgetPlans.periodMonth, periodMonthDate),
			),
		)
		.limit(1);

	if (!plan) {
		return { blockedReason: "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND" };
	}

	const [latestRev] = await tx
		.select()
		.from(monthlyBudgetPlanRevisions)
		.where(eq(monthlyBudgetPlanRevisions.budgetPlanId, plan.id))
		.orderBy(desc(monthlyBudgetPlanRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		return { blockedReason: "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND" };
	}

	if (latestRev.operation === "VOID") {
		return { blockedReason: "MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE" };
	}

	return {
		budgetPlanId: plan.id,
		revisionNo: latestRev.revisionNo,
		policyVersion: latestRev.policyVersion,
		currency: latestRev.currency,
		referenceIncome: latestRev.referenceIncomeAmount,
		mandatoryCeiling: latestRev.mandatoryCeilingAmount,
		discretionaryCeiling: latestRev.discretionaryCeilingAmount,
	};
}

/**
 * Computes net expense (SUM(debit) - SUM(credit)) for POSTED journal entries
 * against a single expense ledger account within [start, end). Reuses the
 * same aggregation style as `getLedgerAccountBalanceInTransaction`.
 */
async function computeAccountNetExpenseInTransaction(
	tx: DatabaseTransaction,
	accountId: string,
	start: Date,
	end: Date,
): Promise<bigint> {
	const [aggregate] = await tx
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
				eq(journalLines.accountId, accountId),
				eq(journalEntries.status, "POSTED"),
				gte(journalEntries.occurredAt, start),
				lt(journalEntries.occurredAt, end),
			),
		);

	return parseSignedAggregateMoneyString(aggregate?.netDebit ?? "0.00").cents;
}

const centsToMoney = formatMonthCloseCents;

interface MonthCloseFigures {
	plan: ResolvedBudgetPlan;
	mandatoryExpenseCents: bigint;
	mandatoryUnusedCents: bigint;
	discretionaryExpenseCents: bigint;
	discretionaryUnusedCents: bigint;
	unclassifiedExpenseCents: bigint;
	closeSurplusCents: bigint;
}

type ResolvedState =
	| ({ status: "OK" } & MonthCloseFigures)
	| {
			status: "BLOCKED";
			reason:
				| "MONTH_CLOSE_PERIOD_NOT_ENDED"
				| "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND"
				| "MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE"
				| "MONTH_CLOSE_UNCLASSIFIED_EXPENSES";
	  };

async function resolveMonthCloseFiguresInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	periodMonth: string,
	now: Date,
	enforcePeriodEnded: boolean,
): Promise<ResolvedState> {
	if (enforcePeriodEnded && !isMonthCloseperiodEnded(periodMonth, now)) {
		return { status: "BLOCKED", reason: "MONTH_CLOSE_PERIOD_NOT_ENDED" };
	}

	const periodMonthDate = periodMonthToDateString(periodMonth);
	const planResult = await resolveActiveBudgetPlanInTransaction(
		tx,
		userId,
		periodMonthDate,
	);
	if ("blockedReason" in planResult) {
		return { status: "BLOCKED", reason: planResult.blockedReason };
	}

	const { start, end } = getMonthCloseIstanbulPeriodBoundaries(periodMonth);
	const accounts = await ensureUserExpenseSystemAccountsInTransaction(
		tx,
		userId,
	);

	const mandatoryExpenseCents = await computeAccountNetExpenseInTransaction(
		tx,
		accounts.MANDATORY_EXPENSE,
		start,
		end,
	);
	const discretionaryExpenseCents = await computeAccountNetExpenseInTransaction(
		tx,
		accounts.DISCRETIONARY_EXPENSE,
		start,
		end,
	);
	const unclassifiedExpenseCents = await computeAccountNetExpenseInTransaction(
		tx,
		accounts.UNCLASSIFIED_EXPENSE,
		start,
		end,
	);

	if (unclassifiedExpenseCents > 0n) {
		return { status: "BLOCKED", reason: "MONTH_CLOSE_UNCLASSIFIED_EXPENSES" };
	}

	const mandatoryCeilingCents = parseSignedAggregateMoneyString(
		planResult.mandatoryCeiling,
	).cents;
	const discretionaryCeilingCents = parseSignedAggregateMoneyString(
		planResult.discretionaryCeiling,
	).cents;

	const mandatoryUnusedCents = computeMonthCloseUnusedCents(
		mandatoryCeilingCents,
		mandatoryExpenseCents,
	);
	const discretionaryUnusedCents = computeMonthCloseUnusedCents(
		discretionaryCeilingCents,
		discretionaryExpenseCents,
	);

	const closeSurplusCents = computeMonthCloseSurplusCents(
		mandatoryUnusedCents,
		discretionaryUnusedCents,
	);

	return {
		status: "OK",
		plan: planResult,
		mandatoryExpenseCents,
		mandatoryUnusedCents,
		discretionaryExpenseCents,
		discretionaryUnusedCents,
		unclassifiedExpenseCents,
		closeSurplusCents,
	};
}

interface ResolvedRouting {
	route: MonthCloseRoute;
	midasAccountId: string | null;
	recommendedGoal: MonthCloseRecommendedGoal | null;
	fullOfferAmountCents: bigint;
	unroutedRemainderIfFullCents: bigint;
}

type RoutingResult =
	| ({ status: "OK" } & ResolvedRouting)
	| { status: "BLOCKED"; reason: "MONTH_CLOSE_MIDAS_NOT_FOUND" };

async function resolveMonthCloseRoutingInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	closeSurplusCents: bigint,
): Promise<RoutingResult> {
	if (closeSurplusCents === 0n) {
		return {
			status: "OK",
			route: "NONE",
			midasAccountId: null,
			recommendedGoal: null,
			fullOfferAmountCents: 0n,
			unroutedRemainderIfFullCents: 0n,
		};
	}

	const [midasAccount] = await tx
		.select({ id: midasAccounts.id })
		.from(midasAccounts)
		.where(eq(midasAccounts.userId, userId))
		.limit(1);

	if (!midasAccount) {
		return { status: "BLOCKED", reason: "MONTH_CLOSE_MIDAS_NOT_FOUND" };
	}

	const activeGoals = await listShortTermGoalsInTransaction({
		tx,
		userId,
		midasAccountId: midasAccount.id,
		status: "ACTIVE",
	});

	const fundable = activeGoals.find((g) => {
		const remaining = parseSignedAggregateMoneyString(
			g.remainingToTarget,
		).cents;
		return remaining > 0n;
	});

	if (fundable) {
		const remainingCents = parseSignedAggregateMoneyString(
			fundable.remainingToTarget,
		).cents;
		const { fullOfferCents, unroutedRemainderIfFullCents } =
			computeMonthCloseFullOffer(closeSurplusCents, remainingCents);
		return {
			status: "OK",
			route: "SHORT_TERM_GOAL",
			midasAccountId: midasAccount.id,
			recommendedGoal: {
				goalId: fundable.id,
				revisionNo: fundable.latestRevisionNo,
				priority: fundable.priority as number,
				bucketId: fundable.midasBucketId,
				name: fundable.name,
				remainingToTarget: fundable.remainingToTarget,
			},
			fullOfferAmountCents: fullOfferCents,
			unroutedRemainderIfFullCents,
		};
	}

	return {
		status: "OK",
		route: "MEDIUM_TERM_RESERVE",
		midasAccountId: midasAccount.id,
		recommendedGoal: null,
		fullOfferAmountCents: closeSurplusCents,
		unroutedRemainderIfFullCents: 0n,
	};
}

async function buildProposalFingerprint(
	userId: string,
	periodMonth: string,
	figures: MonthCloseFigures,
	routing: ResolvedRouting,
): Promise<string> {
	const recommendedGoal: MonthCloseRecommendedGoalFingerprintInput | null =
		routing.recommendedGoal
			? {
					goalId: routing.recommendedGoal.goalId,
					revisionNo: routing.recommendedGoal.revisionNo,
					priority: routing.recommendedGoal.priority,
					bucketId: routing.recommendedGoal.bucketId,
					remainingToTarget: routing.recommendedGoal.remainingToTarget,
				}
			: null;

	return calculateMonthCloseProposalFingerprint({
		userId,
		periodMonth,
		budgetPlanId: figures.plan.budgetPlanId,
		budgetPlanRevisionNo: figures.plan.revisionNo,
		referenceIncome: figures.plan.referenceIncome,
		mandatoryCeiling: figures.plan.mandatoryCeiling,
		mandatoryExpense: centsToMoney(figures.mandatoryExpenseCents),
		mandatoryUnused: centsToMoney(figures.mandatoryUnusedCents),
		discretionaryCeiling: figures.plan.discretionaryCeiling,
		discretionaryExpense: centsToMoney(figures.discretionaryExpenseCents),
		discretionaryUnused: centsToMoney(figures.discretionaryUnusedCents),
		unclassifiedExpense: centsToMoney(figures.unclassifiedExpenseCents),
		closeSurplus: centsToMoney(figures.closeSurplusCents),
		route: routing.route,
		recommendedGoal,
	});
}

// ============================================================================
// PREVIEW (read-only)
// ============================================================================

export async function previewMonthClose(
	params: PreviewMonthCloseParams,
): Promise<MonthCloseProposal> {
	const userId = validateMonthCloseCanonicalUuid(params.userId, "userId");
	const periodMonth = validateMonthClosePeriodMonth(params.periodMonth);

	return runMonthCloseReadTransaction(params.db, async (tx) => {
		const now = new Date();
		const resolved = await resolveMonthCloseFiguresInTransaction(
			tx,
			userId,
			periodMonth,
			now,
			false,
		);

		if (resolved.status === "BLOCKED") {
			const fingerprint = await calculateMonthCloseProposalFingerprint({
				userId,
				periodMonth,
				budgetPlanId: "",
				budgetPlanRevisionNo: 0,
				referenceIncome: "0.00",
				mandatoryCeiling: "0.00",
				mandatoryExpense: "0.00",
				mandatoryUnused: "0.00",
				discretionaryCeiling: "0.00",
				discretionaryExpense: "0.00",
				discretionaryUnused: "0.00",
				unclassifiedExpense: "0.00",
				closeSurplus: "0.00",
				route: "NONE",
				recommendedGoal: null,
			});
			return {
				periodMonth,
				budgetPlanId: null,
				budgetPlanRevisionNo: null,
				policyVersion: null,
				currency: null,
				referenceIncome: null,
				mandatory: null,
				discretionary: null,
				unclassifiedExpense: null,
				closeSurplus: null,
				midasAccountId: null,
				midasUnallocatedBalance: null,
				route: "BLOCKED",
				recommendedGoal: null,
				fullOfferAmount: null,
				unroutedRemainderIfFull: null,
				proposalFingerprint: fingerprint,
				blockedReason: resolved.reason,
			};
		}

		const routing = await resolveMonthCloseRoutingInTransaction(
			tx,
			userId,
			resolved.closeSurplusCents,
		);

		if (routing.status === "BLOCKED") {
			const fingerprint = await buildProposalFingerprint(
				userId,
				periodMonth,
				resolved,
				{
					route: "NONE",
					midasAccountId: null,
					recommendedGoal: null,
					fullOfferAmountCents: 0n,
					unroutedRemainderIfFullCents: 0n,
				},
			);
			return {
				periodMonth,
				budgetPlanId: resolved.plan.budgetPlanId,
				budgetPlanRevisionNo: resolved.plan.revisionNo,
				policyVersion: resolved.plan.policyVersion,
				currency: resolved.plan.currency,
				referenceIncome: resolved.plan.referenceIncome,
				mandatory: {
					ceiling: resolved.plan.mandatoryCeiling,
					actualExpense: centsToMoney(resolved.mandatoryExpenseCents),
					unused: centsToMoney(resolved.mandatoryUnusedCents),
				},
				discretionary: {
					ceiling: resolved.plan.discretionaryCeiling,
					actualExpense: centsToMoney(resolved.discretionaryExpenseCents),
					unused: centsToMoney(resolved.discretionaryUnusedCents),
				},
				unclassifiedExpense: centsToMoney(resolved.unclassifiedExpenseCents),
				closeSurplus: centsToMoney(resolved.closeSurplusCents),
				midasAccountId: null,
				midasUnallocatedBalance: null,
				route: "BLOCKED",
				recommendedGoal: null,
				fullOfferAmount: null,
				unroutedRemainderIfFull: null,
				proposalFingerprint: fingerprint,
				blockedReason: routing.reason,
			};
		}

		const fingerprint = await buildProposalFingerprint(
			userId,
			periodMonth,
			resolved,
			routing,
		);

		let midasUnallocatedBalance: string | null = null;
		if (routing.midasAccountId) {
			const liquidity = await getMidasLiquidityStateInTransaction({
				tx,
				userId,
				midasAccountId: routing.midasAccountId,
			});
			midasUnallocatedBalance = liquidity.unallocatedBalance;
		}

		return {
			periodMonth,
			budgetPlanId: resolved.plan.budgetPlanId,
			budgetPlanRevisionNo: resolved.plan.revisionNo,
			policyVersion: resolved.plan.policyVersion,
			currency: resolved.plan.currency,
			referenceIncome: resolved.plan.referenceIncome,
			mandatory: {
				ceiling: resolved.plan.mandatoryCeiling,
				actualExpense: centsToMoney(resolved.mandatoryExpenseCents),
				unused: centsToMoney(resolved.mandatoryUnusedCents),
			},
			discretionary: {
				ceiling: resolved.plan.discretionaryCeiling,
				actualExpense: centsToMoney(resolved.discretionaryExpenseCents),
				unused: centsToMoney(resolved.discretionaryUnusedCents),
			},
			unclassifiedExpense: centsToMoney(resolved.unclassifiedExpenseCents),
			closeSurplus: centsToMoney(resolved.closeSurplusCents),
			midasAccountId: routing.midasAccountId,
			midasUnallocatedBalance,
			route: routing.route,
			recommendedGoal: routing.recommendedGoal,
			fullOfferAmount: centsToMoney(routing.fullOfferAmountCents),
			unroutedRemainderIfFull: centsToMoney(
				routing.unroutedRemainderIfFullCents,
			),
			proposalFingerprint: fingerprint,
			blockedReason: null,
		};
	});
}

// ============================================================================
// CLOSE (mutation)
// ============================================================================

function buildReadModel(
	monthCloseId: string,
	userId: string,
	periodMonth: string,
	budgetPlanId: string,
	rev: typeof monthCloseRevisions.$inferSelect,
): MonthCloseReadModel {
	return {
		monthCloseId,
		userId,
		periodMonth,
		budgetPlanId,
		budgetPlanRevisionNo: rev.budgetPlanRevisionNo,
		policyVersion: rev.policyVersion,
		currency: rev.currency,
		referenceIncome: rev.referenceIncome,
		mandatory: {
			ceiling: rev.mandatoryCeiling,
			actualExpense: rev.mandatoryExpense,
			unused: rev.mandatoryUnused,
		},
		discretionary: {
			ceiling: rev.discretionaryCeiling,
			actualExpense: rev.discretionaryExpense,
			unused: rev.discretionaryUnused,
		},
		unclassifiedExpense: rev.unclassifiedExpense,
		closeSurplus: rev.closeSurplus,
		route: rev.route as MonthCloseRoute,
		decision: rev.decision as MonthCloseDecision,
		midasAccountId: rev.midasAccountId,
		targetGoalId: rev.targetGoalId,
		targetGoalRevisionNo: rev.targetGoalRevisionNo,
		targetBucketId: rev.targetBucketId,
		fullOfferAmount: rev.fullOfferAmount,
		appliedAmount: rev.appliedAmount,
		unroutedAmount: rev.unroutedAmount,
		midasAllocationTransferId: rev.midasAllocationTransferId,
		proposalFingerprint: rev.proposalFingerprint,
		occurredAt: rev.occurredAt,
		createdAt: rev.createdAt,
	};
}

async function findExistingRevisionByIdempotencyKeyInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	idempotencyKey: string,
): Promise<typeof monthCloseRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(monthCloseRevisions)
		.where(
			and(
				eq(monthCloseRevisions.userId, userId),
				eq(monthCloseRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	return row;
}

export async function closeMonth(
	params: CloseMonthParams,
): Promise<{ monthClose: MonthCloseReadModel; idempotentReplay: boolean }> {
	const userId = validateMonthCloseCanonicalUuid(params.userId, "userId");
	const periodMonth = validateMonthClosePeriodMonth(params.periodMonth);
	const expectedProposalFingerprint = validateMonthCloseFingerprint(
		params.expectedProposalFingerprint,
		"expectedProposalFingerprint",
	);
	const decision = validateMonthCloseDecision(params.decision);
	const parsedPartialAmount = validateMonthCloseOptionalPartialAmount(
		params.partialAmount,
	);
	const occurredAt = validateMonthCloseOccurredAt(params.occurredAt);
	const idempotencyKey = validateMonthCloseIdempotencyKey(
		params.idempotencyKey,
	);

	if (decision === "PARTIAL" && parsedPartialAmount === undefined) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"partialAmount is required when decision is PARTIAL",
		);
	}
	if (decision !== "PARTIAL" && parsedPartialAmount !== undefined) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"partialAmount must not be supplied unless decision is PARTIAL",
		);
	}

	return runMonthCloseTransaction(params.db, async (tx) => {
		const periodMonthDate = periodMonthToDateString(periodMonth);

		const tryReplay = async (
			existingRev: typeof monthCloseRevisions.$inferSelect,
		): Promise<{
			monthClose: MonthCloseReadModel;
			idempotentReplay: boolean;
		}> => {
			const candidateFingerprint = await calculateMonthCloseApplyFingerprint({
				userId,
				periodMonth,
				expectedProposalFingerprint,
				effectiveRoute: existingRev.route as MonthCloseRoute,
				decision: existingRev.decision as MonthCloseDecision,
				partialAmount:
					existingRev.decision === "PARTIAL" ? existingRev.appliedAmount : null,
				occurredAt,
			});
			if (candidateFingerprint !== existingRev.revisionFingerprint) {
				throw new MonthCloseError(
					"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different month-close payload",
				);
			}
			if (existingRev.proposalFingerprint !== expectedProposalFingerprint) {
				throw new MonthCloseError(
					"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different expectedProposalFingerprint",
				);
			}
			const [anchorRow] = await tx
				.select({ budgetPlanId: monthCloses.budgetPlanId })
				.from(monthCloses)
				.where(eq(monthCloses.id, existingRev.monthCloseId))
				.limit(1);
			if (!anchorRow) {
				throw new MonthCloseError(
					"MONTH_CLOSE_INVALID_STATE",
					"Failed to resolve month-close anchor for replay",
				);
			}
			return {
				monthClose: buildReadModel(
					existingRev.monthCloseId,
					userId,
					periodMonth,
					anchorRow.budgetPlanId,
					existingRev,
				),
				idempotentReplay: true,
			};
		};

		// Early replay (before any current-state resolution) -- historical
		// exact replay after later unrelated Midas activity must still return
		// the stored snapshot.
		const earlyRev = await findExistingRevisionByIdempotencyKeyInTransaction(
			tx,
			userId,
			idempotencyKey,
		);
		if (earlyRev) return tryReplay(earlyRev);

		// Acquire period ownership BEFORE any allocation side effect: race-safe
		// anchor insert. Requires an active budget plan to bind to.
		const now = new Date();
		if (!isMonthCloseperiodEnded(periodMonth, now)) {
			throw new MonthCloseError(
				"MONTH_CLOSE_PERIOD_NOT_ENDED",
				`Period "${periodMonth}" has not yet ended in Europe/Istanbul`,
			);
		}

		const planResult = await resolveActiveBudgetPlanInTransaction(
			tx,
			userId,
			periodMonthDate,
		);
		if ("blockedReason" in planResult) {
			throw new MonthCloseError(
				planResult.blockedReason,
				planResult.blockedReason === "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND"
					? `No monthly budget plan found for period "${periodMonth}"`
					: `Monthly budget plan for period "${periodMonth}" is not ACTIVE`,
			);
		}

		const [insertedAnchor] = await tx
			.insert(monthCloses)
			.values({
				userId,
				periodMonth: periodMonthDate,
				budgetPlanId: planResult.budgetPlanId,
			})
			.onConflictDoNothing({
				target: [monthCloses.userId, monthCloses.periodMonth],
			})
			.returning();

		let monthCloseId: string;
		if (insertedAnchor) {
			monthCloseId = insertedAnchor.id;
		} else {
			// Someone else owns (or is racing for) this period. Re-check
			// idempotency for a legitimate replay; otherwise this period is
			// already closed.
			const secondRev = await findExistingRevisionByIdempotencyKeyInTransaction(
				tx,
				userId,
				idempotencyKey,
			);
			if (secondRev) return tryReplay(secondRev);

			throw new MonthCloseError(
				"MONTH_CLOSE_ALREADY_CLOSED",
				`Period "${periodMonth}" has already been closed for this user`,
			);
		}

		// This transaction now owns the month-close identity. Lock the Midas
		// allocation state (if a Midas account exists) before resolving the
		// authoritative proposal, so no concurrent allocation change can occur
		// between our stale-proposal check and our liquidity check.
		const [midasAccountRow] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(eq(midasAccounts.userId, userId))
			.limit(1);
		if (midasAccountRow) {
			await lockMidasAllocationStateInTransaction({
				tx,
				userId,
				midasAccountId: midasAccountRow.id,
			});
		}

		const resolved = await resolveMonthCloseFiguresInTransaction(
			tx,
			userId,
			periodMonth,
			now,
			true,
		);
		if (resolved.status === "BLOCKED") {
			throw new MonthCloseError(
				resolved.reason,
				`Month close for period "${periodMonth}" is blocked: ${resolved.reason}`,
			);
		}

		const routing = await resolveMonthCloseRoutingInTransaction(
			tx,
			userId,
			resolved.closeSurplusCents,
		);
		if (routing.status === "BLOCKED") {
			throw new MonthCloseError(
				routing.reason,
				`Month close for period "${periodMonth}" requires a Midas account`,
			);
		}

		const currentProposalFingerprint = await buildProposalFingerprint(
			userId,
			periodMonth,
			resolved,
			routing,
		);
		if (currentProposalFingerprint !== expectedProposalFingerprint) {
			throw new MonthCloseError(
				"MONTH_CLOSE_STALE_PROPOSAL",
				"The month-close proposal has changed since it was generated; re-fetch the preview and retry",
			);
		}

		// Validate decision against the now-authoritative route.
		let effectiveDecision: MonthCloseDecision;
		let appliedAmountCents: bigint;
		if (routing.route === "SHORT_TERM_GOAL") {
			if (decision === undefined) {
				throw new MonthCloseError(
					"MONTH_CLOSE_INVALID_INPUT",
					"decision (FULL, PARTIAL, or SKIP) is required for the SHORT_TERM_GOAL route",
				);
			}
			if (decision === "FULL") {
				effectiveDecision = "FULL";
				appliedAmountCents = routing.fullOfferAmountCents;
			} else if (decision === "SKIP") {
				effectiveDecision = "SKIP";
				appliedAmountCents = 0n;
			} else {
				if (parsedPartialAmount === undefined) {
					throw new MonthCloseError(
						"MONTH_CLOSE_INVALID_INPUT",
						"partialAmount is required when decision is PARTIAL",
					);
				}
				if (
					parsedPartialAmount.cents <= 0n ||
					parsedPartialAmount.cents >= routing.fullOfferAmountCents
				) {
					throw new MonthCloseError(
						"MONTH_CLOSE_INVALID_INPUT",
						`partialAmount must satisfy 0 < partialAmount < fullOfferAmount (${centsToMoney(routing.fullOfferAmountCents)})`,
					);
				}
				effectiveDecision = "PARTIAL";
				appliedAmountCents = parsedPartialAmount.cents;
			}
		} else {
			if (decision !== undefined) {
				throw new MonthCloseError(
					"MONTH_CLOSE_INVALID_INPUT",
					`decision must not be supplied for the ${routing.route} route`,
				);
			}
			effectiveDecision =
				routing.route === "MEDIUM_TERM_RESERVE" ? "AUTO_MEDIUM" : "NO_ACTION";
			appliedAmountCents =
				routing.route === "MEDIUM_TERM_RESERVE"
					? resolved.closeSurplusCents
					: 0n;
		}

		// Idempotency-conflict re-check now that effective route/decision are
		// known (defense-in-depth; the early/second checks above already
		// covered the common exact-replay path).
		const applyFingerprint = await calculateMonthCloseApplyFingerprint({
			userId,
			periodMonth,
			expectedProposalFingerprint,
			effectiveRoute: routing.route,
			decision: effectiveDecision,
			partialAmount:
				effectiveDecision === "PARTIAL"
					? centsToMoney(appliedAmountCents)
					: null,
			occurredAt,
		});

		// Liquidity check (Section 13/20): re-checked independently at apply
		// time regardless of the (economics-only) proposal fingerprint match.
		let midasAllocationTransferId: string | null = null;
		// Section 27: target_bucket_id must be recorded whenever route is
		// SHORT_TERM_GOAL, regardless of decision (including SKIP, which applies
		// zero and creates no transfer but still records which goal/bucket the
		// recommendation pointed to for audit purposes).
		let targetBucketId: string | null =
			routing.route === "SHORT_TERM_GOAL" && routing.recommendedGoal
				? routing.recommendedGoal.bucketId
				: null;
		if (appliedAmountCents > 0n) {
			if (!routing.midasAccountId) {
				throw new MonthCloseError(
					"MONTH_CLOSE_MIDAS_NOT_FOUND",
					"Midas account is required to route a non-zero month-close surplus",
				);
			}
			const liquidity = await getMidasLiquidityStateInTransaction({
				tx,
				userId,
				midasAccountId: routing.midasAccountId,
			});
			const unallocatedCents = parseSignedAggregateMoneyString(
				liquidity.unallocatedBalance,
			).cents;
			if (unallocatedCents < appliedAmountCents) {
				throw new MonthCloseError(
					"MONTH_CLOSE_INSUFFICIENT_LIQUIDITY",
					`Insufficient unallocated Midas liquidity: available ${liquidity.unallocatedBalance}, required ${centsToMoney(appliedAmountCents)}`,
				);
			}

			try {
				if (routing.route === "SHORT_TERM_GOAL" && routing.recommendedGoal) {
					targetBucketId = routing.recommendedGoal.bucketId;
					const childKey = await deriveMonthCloseChildIdempotencyKey(
						idempotencyKey,
						[periodMonth, "SHORT_TERM_GOAL", "transfer"],
					);
					const fundRes = await fundShortTermGoal({
						db: tx,
						userId,
						goalId: routing.recommendedGoal.goalId,
						fromBucketId: null,
						amount: centsToMoney(appliedAmountCents),
						occurredAt,
						memo: "Month-end surplus close: short-term goal funding",
						idempotencyKey: childKey,
					});
					midasAllocationTransferId = fundRes.transferId;
				} else if (routing.route === "MEDIUM_TERM_RESERVE") {
					const bucket = await ensureMidasSingletonBucketInTransaction({
						tx,
						userId,
						midasAccountId: routing.midasAccountId,
						bucketType: "MEDIUM_TERM_RESERVE",
						code: MEDIUM_TERM_RESERVE_BUCKET_CODE,
						name: MEDIUM_TERM_RESERVE_BUCKET_NAME,
					});
					targetBucketId = bucket.id;
					const childKey = await deriveMonthCloseChildIdempotencyKey(
						idempotencyKey,
						[periodMonth, "MEDIUM_TERM_RESERVE", "transfer"],
					);
					const transferRes = await createMidasAllocationTransferInTransaction({
						tx,
						userId,
						midasAccountId: routing.midasAccountId,
						idempotencyKey: childKey,
						fromBucketId: null,
						toBucketId: bucket.id,
						amount: centsToMoney(appliedAmountCents),
						occurredAt,
						memo: "Month-end surplus close: medium-term reserve",
					});
					midasAllocationTransferId = transferRes.transferId;
				}
			} catch (err: unknown) {
				if (err instanceof MidasError) mapMidasError(err);
				if (err instanceof ShortTermGoalError) mapShortTermGoalError(err);
				throw err;
			}
		}

		const unroutedAmountCents = resolved.closeSurplusCents - appliedAmountCents;

		const [insertedRev] = await tx
			.insert(monthCloseRevisions)
			.values({
				userId,
				monthCloseId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CLOSE",
				status: "CLOSED",
				budgetPlanRevisionNo: resolved.plan.revisionNo,
				policyVersion: resolved.plan.policyVersion,
				currency: resolved.plan.currency,
				referenceIncome: resolved.plan.referenceIncome,
				mandatoryCeiling: resolved.plan.mandatoryCeiling,
				mandatoryExpense: centsToMoney(resolved.mandatoryExpenseCents),
				mandatoryUnused: centsToMoney(resolved.mandatoryUnusedCents),
				discretionaryCeiling: resolved.plan.discretionaryCeiling,
				discretionaryExpense: centsToMoney(resolved.discretionaryExpenseCents),
				discretionaryUnused: centsToMoney(resolved.discretionaryUnusedCents),
				unclassifiedExpense: centsToMoney(resolved.unclassifiedExpenseCents),
				closeSurplus: centsToMoney(resolved.closeSurplusCents),
				route: routing.route,
				decision: effectiveDecision,
				midasAccountId: routing.midasAccountId,
				targetGoalId:
					routing.route === "SHORT_TERM_GOAL" && routing.recommendedGoal
						? routing.recommendedGoal.goalId
						: null,
				targetGoalRevisionNo:
					routing.route === "SHORT_TERM_GOAL" && routing.recommendedGoal
						? routing.recommendedGoal.revisionNo
						: null,
				targetBucketId,
				fullOfferAmount:
					routing.route === "SHORT_TERM_GOAL"
						? centsToMoney(routing.fullOfferAmountCents)
						: "0.00",
				appliedAmount: centsToMoney(appliedAmountCents),
				unroutedAmount: centsToMoney(unroutedAmountCents),
				midasAllocationTransferId,
				proposalFingerprint: expectedProposalFingerprint,
				idempotencyKey,
				revisionFingerprint: applyFingerprint,
				occurredAt,
			})
			.returning();

		if (!insertedRev) {
			throw new MonthCloseError(
				"MONTH_CLOSE_INVALID_STATE",
				"Failed to create month-close revision",
			);
		}

		return {
			monthClose: buildReadModel(
				monthCloseId,
				userId,
				periodMonth,
				planResult.budgetPlanId,
				insertedRev,
			),
			idempotentReplay: false,
		};
	});
}

// ============================================================================
// Reads
// ============================================================================

export async function getMonthClose(
	params: GetMonthCloseParams,
): Promise<MonthCloseReadModel | null> {
	const userId = validateMonthCloseCanonicalUuid(params.userId, "userId");
	const periodMonth = validateMonthClosePeriodMonth(params.periodMonth);
	const periodMonthDate = periodMonthToDateString(periodMonth);

	return runMonthCloseReadTransaction(params.db, async (tx) => {
		const [anchor] = await tx
			.select({ id: monthCloses.id, budgetPlanId: monthCloses.budgetPlanId })
			.from(monthCloses)
			.where(
				and(
					eq(monthCloses.userId, userId),
					eq(monthCloses.periodMonth, periodMonthDate),
				),
			)
			.limit(1);
		if (!anchor) return null;

		const [rev] = await tx
			.select()
			.from(monthCloseRevisions)
			.where(eq(monthCloseRevisions.monthCloseId, anchor.id))
			.orderBy(desc(monthCloseRevisions.revisionNo))
			.limit(1);
		if (!rev) return null;

		return buildReadModel(
			anchor.id,
			userId,
			periodMonth,
			anchor.budgetPlanId,
			rev,
		);
	});
}

export async function listMonthCloses(
	params: ListMonthClosesParams,
): Promise<MonthCloseReadModel[]> {
	const userId = validateMonthCloseCanonicalUuid(params.userId, "userId");
	const periodMonth = validateMonthCloseOptionalPeriodMonth(params.periodMonth);
	const periodMonthFrom = validateMonthCloseOptionalPeriodMonth(
		params.periodMonthFrom,
	);
	const periodMonthUntil = validateMonthCloseOptionalPeriodMonth(
		params.periodMonthUntil,
	);

	if (
		periodMonthFrom !== undefined &&
		periodMonthUntil !== undefined &&
		periodMonthToDateString(periodMonthFrom) >
			periodMonthToDateString(periodMonthUntil)
	) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`periodMonthFrom "${periodMonthFrom}" must not be after periodMonthUntil "${periodMonthUntil}"`,
		);
	}

	return runMonthCloseReadTransaction(params.db, async (tx) => {
		const conditions = [eq(monthCloses.userId, userId)];
		if (periodMonth !== undefined) {
			conditions.push(
				eq(monthCloses.periodMonth, periodMonthToDateString(periodMonth)),
			);
		}
		if (periodMonthFrom !== undefined) {
			conditions.push(
				gte(monthCloses.periodMonth, periodMonthToDateString(periodMonthFrom)),
			);
		}
		if (periodMonthUntil !== undefined) {
			conditions.push(
				lte(monthCloses.periodMonth, periodMonthToDateString(periodMonthUntil)),
			);
		}

		const anchors = await tx
			.select({
				id: monthCloses.id,
				periodMonth: monthCloses.periodMonth,
				budgetPlanId: monthCloses.budgetPlanId,
			})
			.from(monthCloses)
			.where(and(...conditions))
			.orderBy(desc(monthCloses.periodMonth), asc(monthCloses.id));

		const results: MonthCloseReadModel[] = [];
		for (const anchor of anchors) {
			const [rev] = await tx
				.select()
				.from(monthCloseRevisions)
				.where(eq(monthCloseRevisions.monthCloseId, anchor.id))
				.orderBy(desc(monthCloseRevisions.revisionNo))
				.limit(1);
			if (!rev) continue;
			results.push(
				buildReadModel(
					anchor.id,
					userId,
					dateStringToPeriodMonth(anchor.periodMonth),
					anchor.budgetPlanId,
					rev,
				),
			);
		}
		return results;
	});
}
