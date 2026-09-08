import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import { getStatementReconciliation } from "../credit-cards/statement-reconciliation";
import type { Database } from "../db/client";
import { budgetV2BasicLivingConfigRevisions } from "../db/schema/budget-basic-living";
import {
	monthlyBudgetV2PlanRevisions,
	monthlyBudgetV2Plans,
} from "../db/schema/budget-v2";
import {
	incomeReceiptBudgetV2SemanticRevisions,
	shortTermGoalBudgetV2PurposeRevisions,
} from "../db/schema/budget-v2-semantics";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	creditCardPurchaseSplitRevisions,
	creditCardPurchaseSplits,
} from "../db/schema/credit-card-splits";
import {
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "../db/schema/credit-cards";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../db/schema/income";
import { midasAllocationTransfers, midasBuckets } from "../db/schema/midas";
import {
	personObligationRevisions,
	personObligations,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import {
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { getIstanbulCalendarDate } from "../income/calendar";
import {
	formatCentsToMoney,
	parseAggregateMoneyString,
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { BudgetError } from "./errors";
import {
	allocatePersonalBudgetV2,
	CORE_EMERGENCY_FUND_TARGET,
	type PersonalBudgetV2Inputs,
	type PersonalBudgetV2Result,
} from "./policy-v2";
import { normalizeUuid, validateBudgetPeriodMonth } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- AUTHORITATIVE LIVE-SOURCE RESOLVER
 *
 * Derives the six PERSONAL_BUDGET_V2 policy inputs from stored, authoritative
 * domain truth only (Income + Budget-V2 semantic roles / Credit cards + sealed
 * statement reconciliations / People / Midas / Short-term goals + goal purpose
 * classification / user-approved basic-living config). It NEVER estimates: any
 * input it cannot prove exactly raises `BUDGET_RESOLVER_FAIL_CLOSED`.
 *
 * It performs no writes and does not call the V2 lifecycle writer. The
 * historical-replay entrypoint (`resolveBudgetV2SnapshotForWrite`) checks a
 * stored creation / refresh revision by idempotency key FIRST and replays its
 * exact stored snapshot without re-reading mutable current sources.
 */

const CORE_EMERGENCY_TARGET_CENTS = 1_000_000n;

// ============================================================================
// Result shapes
// ============================================================================

export interface BudgetV2LiveResolution {
	asOf: string;
	periodMonth: string;
	inputs: PersonalBudgetV2Inputs;
	policyResult: PersonalBudgetV2Result;
	evidenceSnapshot: Record<string, unknown>;
	checkpointAnalysis: Record<string, unknown>;
	availableToAllocateNow: {
		available: false;
		reason: "SURPLUS_USE_ATTRIBUTION_UNSUPPORTED";
		supported: Record<string, unknown>;
	};
}

export interface ResolveBudgetV2LiveParams {
	db: Database;
	userId: string;
	periodMonth: string;
	asOf?: Date | undefined;
	previousCheckpointAt?: Date | undefined;
}

// ============================================================================
// Small helpers
// ============================================================================

function failClosed(reason: string): never {
	throw new BudgetError("BUDGET_RESOLVER_FAIL_CLOSED", reason);
}

function firstDayOfNextMonthIstanbulUtc(periodMonth: string): Date {
	const parts = periodMonth.split("-");
	const y = Number.parseInt(parts[0] ?? "0", 10);
	const m = Number.parseInt(parts[1] ?? "0", 10);
	const ny = m === 12 ? y + 1 : y;
	const nm = m === 12 ? 1 : m + 1;
	return new Date(`${ny}-${String(nm).padStart(2, "0")}-01T00:00:00+03:00`);
}

function lastCalendarDayOfMonth(periodMonth: string): string {
	const next = firstDayOfNextMonthIstanbulUtc(periodMonth);
	return getIstanbulCalendarDate(new Date(next.getTime() - 86_400_000));
}

/** ceil(numeratorCents / months) in exact BigInt. */
function ceilDivCents(numeratorCents: bigint, months: number): bigint {
	const d = BigInt(months);
	if (d <= 0n) failClosed("date-bound goal has non-positive remaining months");
	return (numeratorCents + d - 1n) / d;
}

function asDate(v: unknown): Date {
	return v instanceof Date ? v : new Date(v as string);
}

/** Net kurus balance of a Midas bucket as of `at` (inclusive). */
async function bucketNetCents(
	db: Database,
	userId: string,
	bucketId: string,
	at: Date,
): Promise<bigint> {
	const [row] = await db
		.select({
			net: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${bucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${bucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
		})
		.from(midasAllocationTransfers)
		.where(
			and(
				eq(midasAllocationTransfers.userId, userId),
				lte(midasAllocationTransfers.occurredAt, at),
				or(
					eq(midasAllocationTransfers.fromBucketId, bucketId),
					eq(midasAllocationTransfers.toBucketId, bucketId),
				),
			),
		);
	return parseSignedAggregateMoneyString(row?.net ?? "0").cents;
}

interface LatestGoalState {
	goalId: string;
	midasBucketId: string;
	status: string;
	fundingTargetCents: bigint;
	targetDate: string | null;
	activationAt: Date;
}

async function loadGoalStates(
	db: Database,
	userId: string,
): Promise<LatestGoalState[]> {
	const goals = await db
		.select({ id: shortTermGoals.id, bucketId: shortTermGoals.midasBucketId })
		.from(shortTermGoals)
		.where(eq(shortTermGoals.userId, userId));
	const out: LatestGoalState[] = [];
	for (const g of goals) {
		const revs = await db
			.select({
				revisionNo: shortTermGoalRevisions.revisionNo,
				status: shortTermGoalRevisions.status,
				fundingTarget: shortTermGoalRevisions.fundingTarget,
				targetDate: shortTermGoalRevisions.targetDate,
				occurredAt: shortTermGoalRevisions.occurredAt,
			})
			.from(shortTermGoalRevisions)
			.where(eq(shortTermGoalRevisions.goalId, g.id))
			.orderBy(shortTermGoalRevisions.revisionNo);
		if (revs.length === 0) continue;
		const latest = revs[revs.length - 1];
		const first = revs[0];
		if (!latest || !first) continue;
		out.push({
			goalId: g.id,
			midasBucketId: g.bucketId,
			status: latest.status,
			fundingTargetCents: parseAggregateMoneyString(latest.fundingTarget).cents,
			targetDate: latest.targetDate,
			activationAt: asDate(first.occurredAt),
		});
	}
	return out;
}

async function latestGoalPurpose(
	db: Database,
	goalId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ purpose: shortTermGoalBudgetV2PurposeRevisions.purpose })
		.from(shortTermGoalBudgetV2PurposeRevisions)
		.where(eq(shortTermGoalBudgetV2PurposeRevisions.goalId, goalId))
		.orderBy(desc(shortTermGoalBudgetV2PurposeRevisions.revisionNo))
		.limit(1);
	return row?.purpose ?? null;
}

// ============================================================================
// INPUT: realizedIncome  (section 2)
// ============================================================================

interface RealizedIncomeResult {
	cents: bigint;
	regularCents: bigint;
	extraCents: bigint;
	plannedFamilyGiftCents: bigint;
	deficitFamilySupportCents: bigint;
	receiptEvidence: Array<Record<string, unknown>>;
}

async function resolveRealizedIncome(
	db: Database,
	userId: string,
	windowStart: Date,
	windowEnd: Date,
): Promise<RealizedIncomeResult> {
	const receipts = await db
		.select({ receiptId: incomeReceipts.id, nature: incomeSources.nature })
		.from(incomeReceipts)
		.innerJoin(incomeSources, eq(incomeSources.id, incomeReceipts.sourceId))
		.where(eq(incomeReceipts.userId, userId));

	let regular = 0n;
	let extra = 0n;
	let gift = 0n;
	let deficit = 0n;
	const receiptEvidence: Array<Record<string, unknown>> = [];

	for (const r of receipts) {
		const [latest] = await db
			.select({
				operation: incomeReceiptRevisions.operation,
				occurredAt: incomeReceiptRevisions.occurredAt,
				amount: incomeReceiptRevisions.amount,
			})
			.from(incomeReceiptRevisions)
			.where(eq(incomeReceiptRevisions.incomeReceiptId, r.receiptId))
			.orderBy(desc(incomeReceiptRevisions.revisionNo))
			.limit(1);
		if (!latest || latest.operation === "VOID") continue;
		const occurredAt = asDate(latest.occurredAt);
		if (occurredAt < windowStart || occurredAt >= windowEnd) continue;
		const amountCents = parseAggregateMoneyString(latest.amount).cents;

		if (r.nature === "REGULAR") {
			regular += amountCents;
			receiptEvidence.push({
				receiptId: r.receiptId,
				nature: r.nature,
				amount: latest.amount,
				includedIn: "realizedIncome",
			});
		} else if (r.nature === "EXTRA") {
			extra += amountCents;
			receiptEvidence.push({
				receiptId: r.receiptId,
				nature: r.nature,
				amount: latest.amount,
				includedIn: "realizedIncome",
			});
		} else if (r.nature === "SUPPORT") {
			const [roleRow] = await db
				.select({ role: incomeReceiptBudgetV2SemanticRevisions.supportRole })
				.from(incomeReceiptBudgetV2SemanticRevisions)
				.where(
					eq(
						incomeReceiptBudgetV2SemanticRevisions.incomeReceiptId,
						r.receiptId,
					),
				)
				.orderBy(desc(incomeReceiptBudgetV2SemanticRevisions.revisionNo))
				.limit(1);
			if (!roleRow) {
				failClosed(
					`SUPPORT income receipt ${r.receiptId} has no active Budget V2 semantic role; classify it before resolving`,
				);
			}
			if (roleRow.role === "PLANNED_FAMILY_GIFT") {
				gift += amountCents;
				receiptEvidence.push({
					receiptId: r.receiptId,
					nature: r.nature,
					supportRole: roleRow.role,
					amount: latest.amount,
					includedIn: "realizedIncome",
				});
			} else {
				deficit += amountCents;
				receiptEvidence.push({
					receiptId: r.receiptId,
					nature: r.nature,
					supportRole: roleRow.role,
					amount: latest.amount,
					includedIn: "deficitFundingOnly",
				});
			}
		}
	}

	return {
		cents: regular + extra + gift,
		regularCents: regular,
		extraCents: extra,
		plannedFamilyGiftCents: gift,
		deficitFamilySupportCents: deficit,
		receiptEvidence,
	};
}

// ============================================================================
// INPUT: coreEmergencyFundBalance (section 8) + mobilityBalance (section 7)
// ============================================================================

async function resolveEmergencyFund(
	db: Database,
	userId: string,
	asOf: Date,
): Promise<{ bucketId: string; balanceCents: bigint; gapCents: bigint }> {
	const [bucket] = await db
		.select({ id: midasBuckets.id })
		.from(midasBuckets)
		.where(
			and(
				eq(midasBuckets.userId, userId),
				eq(midasBuckets.bucketType, "CORE_EMERGENCY_FUND"),
			),
		)
		.limit(1);
	if (!bucket) {
		failClosed(
			"no CORE_EMERGENCY_FUND Midas bucket exists; Budget V2 emergency fund balance is unresolved",
		);
	}
	const balanceCents = await bucketNetCents(db, userId, bucket.id, asOf);
	if (balanceCents < 0n) {
		failClosed(
			`CORE_EMERGENCY_FUND bucket ${bucket.id} has a negative net balance (${balanceCents} kurus); invariant violated`,
		);
	}
	const gapCents =
		CORE_EMERGENCY_TARGET_CENTS - balanceCents > 0n
			? CORE_EMERGENCY_TARGET_CENTS - balanceCents
			: 0n;
	return { bucketId: bucket.id, balanceCents, gapCents };
}

async function resolveMobilityBalance(
	db: Database,
	userId: string,
	goals: LatestGoalState[],
	asOf: Date,
): Promise<{ cents: bigint; goalEvidence: Array<Record<string, unknown>> }> {
	let total = 0n;
	const goalEvidence: Array<Record<string, unknown>> = [];
	for (const g of goals) {
		if (g.status !== "ACTIVE") continue;
		if ((await latestGoalPurpose(db, g.goalId)) !== "INTERNATIONAL_MOBILITY") {
			continue;
		}
		const bal = await bucketNetCents(db, userId, g.midasBucketId, asOf);
		if (bal < 0n) {
			failClosed(
				`INTERNATIONAL_MOBILITY goal ${g.goalId} bucket has a negative net balance (${bal} kurus); invariant violated`,
			);
		}
		total += bal;
		goalEvidence.push({
			goalId: g.goalId,
			bucketId: g.midasBucketId,
			currentBucketBalance: formatCentsToMoney(bal),
		});
	}
	return { cents: total, goalEvidence };
}

// ============================================================================
// INPUT: dateBoundNecessaryPurchaseFunding (section 6)
// ============================================================================

function inclusiveBudgetMonths(
	periodMonth: string,
	targetDate: string,
): number {
	const p = periodMonth.split("-").map((s) => Number.parseInt(s, 10));
	const t = targetDate.split("-").map((s) => Number.parseInt(s, 10));
	const diff = ((t[0] ?? 0) - (p[0] ?? 0)) * 12 + ((t[1] ?? 0) - (p[1] ?? 0));
	return diff <= 0 ? 1 : diff + 1;
}

async function resolveDateBoundNecessary(
	db: Database,
	userId: string,
	goals: LatestGoalState[],
	periodMonth: string,
	periodStart: Date,
): Promise<{
	cents: bigint;
	perGoal: Array<Record<string, unknown>>;
	overdue: string[];
}> {
	let total = 0n;
	const perGoal: Array<Record<string, unknown>> = [];
	const overdue: string[] = [];
	for (const g of goals) {
		if (g.status !== "ACTIVE") continue;
		if (
			(await latestGoalPurpose(db, g.goalId)) !==
			"DATE_BOUND_NECESSARY_PURCHASE"
		) {
			continue;
		}
		if (!g.targetDate) {
			failClosed(
				`DATE_BOUND_NECESSARY_PURCHASE goal ${g.goalId} has no targetDate; period contribution is unresolved`,
			);
		}
		const recognitionBasisAt =
			g.activationAt > periodStart ? g.activationAt : periodStart;
		const bucketAtBasis = await bucketNetCents(
			db,
			userId,
			g.midasBucketId,
			recognitionBasisAt,
		);
		if (bucketAtBasis < 0n) {
			failClosed(
				`DATE_BOUND_NECESSARY_PURCHASE goal ${g.goalId} bucket has a negative net balance at recognition basis; invariant violated`,
			);
		}
		const remainingGapCents =
			g.fundingTargetCents - bucketAtBasis > 0n
				? g.fundingTargetCents - bucketAtBasis
				: 0n;
		const months = inclusiveBudgetMonths(periodMonth, g.targetDate);
		const isOverdue = g.targetDate.slice(0, 7) < periodMonth.slice(0, 7);
		if (isOverdue) overdue.push(g.goalId);
		const monthlyCents =
			remainingGapCents === 0n ? 0n : ceilDivCents(remainingGapCents, months);
		total += monthlyCents;
		perGoal.push({
			goalId: g.goalId,
			bucketId: g.midasBucketId,
			fundingTarget: formatCentsToMoney(g.fundingTargetCents),
			targetDate: g.targetDate,
			recognitionBasisAt: recognitionBasisAt.toISOString(),
			bucketBalanceAtBasis: formatCentsToMoney(bucketAtBasis),
			remainingGap: formatCentsToMoney(remainingGapCents),
			remainingBudgetMonthsInclusive: months,
			overdue: isOverdue,
			monthlyRequiredContribution: formatCentsToMoney(monthlyCents),
		});
	}
	return { cents: total, perGoal, overdue };
}

// ============================================================================
// INPUT: basicLivingFunding (section 4)
// ============================================================================

async function personalPurchaseShareCents(
	db: Database,
	purchaseEventId: string,
	grossCents: bigint,
): Promise<bigint> {
	const [split] = await db
		.select({
			userShare: creditCardPurchaseSplitRevisions.userShareAmount,
			operation: creditCardPurchaseSplitRevisions.operation,
		})
		.from(creditCardPurchaseSplitRevisions)
		.innerJoin(
			creditCardPurchaseSplits,
			eq(creditCardPurchaseSplits.id, creditCardPurchaseSplitRevisions.splitId),
		)
		.where(eq(creditCardPurchaseSplits.purchaseEventId, purchaseEventId))
		.orderBy(desc(creditCardPurchaseSplitRevisions.revisionNo))
		.limit(1);
	if (!split || split.operation === "VOID") return grossCents;
	return parseAggregateMoneyString(split.userShare).cents;
}

interface BasicLivingResult {
	targetCents: bigint;
	targetRevisionId: string;
	actualSpendMtdCents: bigint;
	fundingCents: bigint;
	spendComponents: Array<Record<string, unknown>>;
	currency: string;
}

async function resolveBasicLiving(
	db: Database,
	userId: string,
	periodMonth: string,
	windowStart: Date,
	windowEnd: Date,
): Promise<BasicLivingResult> {
	const [cfg] = await db
		.select()
		.from(budgetV2BasicLivingConfigRevisions)
		.where(
			and(
				eq(budgetV2BasicLivingConfigRevisions.userId, userId),
				lte(
					budgetV2BasicLivingConfigRevisions.effectivePeriodMonth,
					periodMonth,
				),
			),
		)
		.orderBy(desc(budgetV2BasicLivingConfigRevisions.revisionNo))
		.limit(1);
	if (!cfg) {
		failClosed(
			`no user-approved basic-living config is effective for period ${periodMonth}`,
		);
	}
	const targetCents = parseAggregateMoneyString(cfg.monthlyTargetAmount).cents;

	let spend = 0n;
	const spendComponents: Array<Record<string, unknown>> = [];

	// (a) credit-card purchases categorised MANDATORY_EXPENSE (personal share)
	const purchaseRevs = await db
		.select({
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
			occurredAt: creditCardLiabilityEventRevisions.occurredAt,
		})
		.from(creditCardLiabilityEventRevisions)
		.innerJoin(
			creditCardLiabilityEvents,
			eq(
				creditCardLiabilityEvents.id,
				creditCardLiabilityEventRevisions.eventId,
			),
		)
		.where(
			and(
				eq(creditCardLiabilityEvents.userId, userId),
				eq(creditCardLiabilityEvents.eventType, "PURCHASE"),
			),
		)
		.orderBy(
			creditCardLiabilityEventRevisions.eventId,
			creditCardLiabilityEventRevisions.revisionNo,
		);
	const latestByEvent = new Map<string, (typeof purchaseRevs)[number]>();
	for (const p of purchaseRevs) latestByEvent.set(p.eventId, p);
	for (const p of latestByEvent.values()) {
		if (p.operation === "VOID") continue;
		if (p.budgetCategory !== "MANDATORY_EXPENSE") continue;
		const at = asDate(p.occurredAt);
		if (at < windowStart || at >= windowEnd) continue;
		const grossCents = parseAggregateMoneyString(p.amount).cents;
		const personalCents = await personalPurchaseShareCents(
			db,
			p.eventId,
			grossCents,
		);
		spend += personalCents;
		spendComponents.push({
			source: "CREDIT_CARD_PURCHASE",
			eventId: p.eventId,
			personalShare: formatCentsToMoney(personalCents),
			occurredAt: at.toISOString(),
		});
	}

	// (b) People PAYABLE obligations categorised MANDATORY_EXPENSE
	const payables = await db
		.select({ id: personObligations.id })
		.from(personObligations)
		.where(
			and(
				eq(personObligations.userId, userId),
				eq(personObligations.direction, "PAYABLE"),
			),
		);
	for (const o of payables) {
		const [rev] = await db
			.select({
				operation: personObligationRevisions.operation,
				principal: personObligationRevisions.principalAmount,
				budgetCategory: personObligationRevisions.budgetCategory,
				occurredAt: personObligationRevisions.occurredAt,
			})
			.from(personObligationRevisions)
			.where(eq(personObligationRevisions.obligationId, o.id))
			.orderBy(desc(personObligationRevisions.revisionNo))
			.limit(1);
		if (!rev || rev.operation === "VOID") continue;
		if (rev.budgetCategory !== "MANDATORY_EXPENSE") continue;
		const at = asDate(rev.occurredAt);
		if (at < windowStart || at >= windowEnd) continue;
		const cents = parseAggregateMoneyString(rev.principal).cents;
		spend += cents;
		spendComponents.push({
			source: "PEOPLE_PAYABLE",
			obligationId: o.id,
			principal: formatCentsToMoney(cents),
			occurredAt: at.toISOString(),
		});
	}

	const fundingCents = spend > targetCents ? spend : targetCents;
	return {
		targetCents,
		targetRevisionId: cfg.id,
		actualSpendMtdCents: spend,
		fundingCents,
		spendComponents,
		currency: cfg.currency,
	};
}

// ============================================================================
// INPUT: currentObligations (section 3) -- ONE-COUNT
// ============================================================================

interface CurrentObligationsResult {
	cents: bigint;
	creditCardStatements: Array<Record<string, unknown>>;
	peoplePayable: Array<Record<string, unknown>>;
	unresolvedPayables: Array<Record<string, unknown>>;
}

async function resolveCurrentObligations(
	db: Database,
	userId: string,
	periodMonth: string,
	periodStart: Date,
	windowStart: Date,
	windowEnd: Date,
): Promise<CurrentObligationsResult> {
	const lastDay = lastCalendarDayOfMonth(periodMonth);
	let total = 0n;
	const ccEvidence: Array<Record<string, unknown>> = [];
	const peopleEvidence: Array<Record<string, unknown>> = [];
	const unresolved: Array<Record<string, unknown>> = [];

	// ---- A. Credit-card personal current/due/overdue burden (one-count) ----
	const cards = await db
		.select({ id: creditCards.id })
		.from(creditCards)
		.where(eq(creditCards.userId, userId));
	for (const card of cards) {
		const stmts = await db
			.select({
				id: creditCardStatements.id,
				reserveBucketId: creditCardStatements.midasReserveBucketId,
			})
			.from(creditCardStatements)
			.where(
				and(
					eq(creditCardStatements.userId, userId),
					eq(creditCardStatements.creditCardId, card.id),
				),
			);
		for (const s of stmts) {
			const [rev] = await db
				.select({
					status: creditCardStatementRevisions.status,
					statementAmount: creditCardStatementRevisions.statementAmount,
					dueDate: creditCardStatementRevisions.dueDate,
				})
				.from(creditCardStatementRevisions)
				.where(eq(creditCardStatementRevisions.statementId, s.id))
				.orderBy(desc(creditCardStatementRevisions.revisionNo))
				.limit(1);
			if (!rev || rev.status === "VOID") continue;
			if (!rev.dueDate || rev.dueDate > lastDay) continue;

			const recon = await getStatementReconciliation({
				db,
				userId,
				statementId: s.id,
			});
			if (recon.status !== "RECONCILED") {
				failClosed(
					`credit-card statement ${s.id} is not reconciled (status=${recon.status}); its personal share cannot be authoritatively decomposed`,
				);
			}
			const stmtAmountCents = parseAggregateMoneyString(
				rev.statementAmount,
			).cents;
			const carryInFunded = await bucketNetCents(
				db,
				userId,
				s.reserveBucketId,
				periodStart,
			);
			if (carryInFunded < 0n) {
				failClosed(
					`credit-card statement ${s.id} reserve bucket has a negative net balance; invariant violated`,
				);
			}
			const fullyPreFunded = carryInFunded >= stmtAmountCents;
			const burden = fullyPreFunded ? 0n : recon.personalCents;
			total += burden;
			ccEvidence.push({
				statementId: s.id,
				cardId: card.id,
				dueDate: rev.dueDate,
				status: rev.status,
				statementAmount: rev.statementAmount,
				personalShare: formatCentsToMoney(recon.personalCents),
				reserveCarryInFundedBeforePeriod: formatCentsToMoney(carryInFunded),
				fullyPreFunded,
				recognizedPersonalBurden: formatCentsToMoney(burden),
				reconciliationRevisionNo: recon.revisionNo,
			});
		}
	}

	// ---- B. People PAYABLE current/due/overdue (one-count) ----
	const payables = await db
		.select({ id: personObligations.id, personId: personObligations.personId })
		.from(personObligations)
		.where(
			and(
				eq(personObligations.userId, userId),
				eq(personObligations.direction, "PAYABLE"),
			),
		);
	for (const o of payables) {
		const [rev] = await db
			.select({
				operation: personObligationRevisions.operation,
				principal: personObligationRevisions.principalAmount,
				dueDate: personObligationRevisions.dueDate,
			})
			.from(personObligationRevisions)
			.where(eq(personObligationRevisions.obligationId, o.id))
			.orderBy(desc(personObligationRevisions.revisionNo))
			.limit(1);
		if (!rev || rev.operation === "VOID") continue;
		const principalCents = parseAggregateMoneyString(rev.principal).cents;

		const settlements = await db
			.select({ id: personSettlements.id })
			.from(personSettlements)
			.where(eq(personSettlements.obligationId, o.id));
		let settledToDate = 0n;
		let settledInPeriod = 0n;
		for (const st of settlements) {
			const [sr] = await db
				.select({
					operation: personSettlementRevisions.operation,
					applied: personSettlementRevisions.appliedAmount,
					occurredAt: personSettlementRevisions.occurredAt,
				})
				.from(personSettlementRevisions)
				.where(eq(personSettlementRevisions.settlementId, st.id))
				.orderBy(desc(personSettlementRevisions.revisionNo))
				.limit(1);
			if (!sr || sr.operation === "VOID") continue;
			const appliedCents = parseAggregateMoneyString(sr.applied).cents;
			settledToDate += appliedCents;
			const at = asDate(sr.occurredAt);
			if (at >= windowStart && at < windowEnd) settledInPeriod += appliedCents;
		}
		const remainingCents =
			principalCents - settledToDate > 0n ? principalCents - settledToDate : 0n;

		if (!rev.dueDate) {
			if (remainingCents > 0n) {
				unresolved.push({
					obligationId: o.id,
					personId: o.personId,
					remainingPrincipal: formatCentsToMoney(remainingCents),
					reason: "PAYABLE_WITHOUT_DUE_DATE",
				});
			}
			total += settledInPeriod;
			if (settledInPeriod > 0n) {
				peopleEvidence.push({
					obligationId: o.id,
					personId: o.personId,
					dueDate: null,
					recognizedBurden: formatCentsToMoney(settledInPeriod),
					basis: "PERIOD_SETTLED_ONLY",
				});
			}
			continue;
		}

		const isCurrentDueOverdue = rev.dueDate <= lastDay;
		const contribution = isCurrentDueOverdue
			? remainingCents + settledInPeriod
			: settledInPeriod;
		total += contribution;
		if (contribution > 0n) {
			peopleEvidence.push({
				obligationId: o.id,
				personId: o.personId,
				dueDate: rev.dueDate,
				principal: formatCentsToMoney(principalCents),
				remainingPrincipal: formatCentsToMoney(remainingCents),
				periodSettledPrincipal: formatCentsToMoney(settledInPeriod),
				recognizedBurden: formatCentsToMoney(contribution),
				basis: isCurrentDueOverdue
					? "REMAINING_DUE_PLUS_PERIOD_SETTLED"
					: "PERIOD_SETTLED_ONLY",
			});
		}
	}

	return {
		cents: total,
		creditCardStatements: ccEvidence,
		peoplePayable: peopleEvidence,
		unresolvedPayables: unresolved,
	};
}

// ============================================================================
// Orchestration
// ============================================================================

export async function resolveBudgetV2LiveSnapshot(
	params: ResolveBudgetV2LiveParams,
): Promise<BudgetV2LiveResolution> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const asOf =
		params.asOf instanceof Date && !Number.isNaN(params.asOf.getTime())
			? params.asOf
			: new Date();

	const periodStart = new Date(`${periodMonth}T00:00:00+03:00`);
	const periodEnd = firstDayOfNextMonthIstanbulUtc(periodMonth);
	if (asOf < periodStart) {
		failClosed(
			`asOf ${asOf.toISOString()} precedes the start of period ${periodMonth}`,
		);
	}
	const windowStart = periodStart;
	const windowEnd = asOf < periodEnd ? asOf : periodEnd;

	const intervalStart =
		params.previousCheckpointAt instanceof Date &&
		!Number.isNaN(params.previousCheckpointAt.getTime())
			? params.previousCheckpointAt
			: periodStart;
	const intervalEnd = windowEnd;

	const goals = await loadGoalStates(db, userId);
	const income = await resolveRealizedIncome(
		db,
		userId,
		windowStart,
		windowEnd,
	);
	const emergency = await resolveEmergencyFund(db, userId, asOf);
	const mobility = await resolveMobilityBalance(db, userId, goals, asOf);
	const dateBound = await resolveDateBoundNecessary(
		db,
		userId,
		goals,
		periodMonth,
		periodStart,
	);
	const basicLiving = await resolveBasicLiving(
		db,
		userId,
		periodMonth,
		windowStart,
		windowEnd,
	);
	const obligations = await resolveCurrentObligations(
		db,
		userId,
		periodMonth,
		periodStart,
		windowStart,
		windowEnd,
	);

	const inputs: PersonalBudgetV2Inputs = {
		realizedIncome: formatCentsToMoney(income.cents),
		currentObligations: formatCentsToMoney(obligations.cents),
		basicLivingFunding: formatCentsToMoney(basicLiving.fundingCents),
		dateBoundNecessaryPurchaseFunding: formatCentsToMoney(dateBound.cents),
		coreEmergencyFundBalance: formatCentsToMoney(emergency.balanceCents),
		mobilityBalance: formatCentsToMoney(mobility.cents),
	};

	const policyResult = allocatePersonalBudgetV2(inputs);

	const evidenceSnapshot: Record<string, unknown> = {
		schemaVersion: "budget-v2-live-resolution-v1",
		asOf: asOf.toISOString(),
		periodMonth,
		window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
		income: {
			realizedIncome: inputs.realizedIncome,
			regular: formatCentsToMoney(income.regularCents),
			extra: formatCentsToMoney(income.extraCents),
			plannedFamilyGift: formatCentsToMoney(income.plannedFamilyGiftCents),
			deficitFamilySupport: formatCentsToMoney(
				income.deficitFamilySupportCents,
			),
			receipts: income.receiptEvidence,
		},
		obligations: {
			currentObligations: inputs.currentObligations,
			creditCardStatements: obligations.creditCardStatements,
			peoplePayable: obligations.peoplePayable,
			unresolvedPayables: obligations.unresolvedPayables,
		},
		basicLiving: {
			basicLivingTarget: formatCentsToMoney(basicLiving.targetCents),
			basicLivingTargetRevisionId: basicLiving.targetRevisionId,
			actualBasicLivingSpendMTD: formatCentsToMoney(
				basicLiving.actualSpendMtdCents,
			),
			basicLivingFunding: inputs.basicLivingFunding,
			formula: "max(approvedTarget, actualPersonalMandatorySpendMTD)",
			spendComponents: basicLiving.spendComponents,
		},
		necessaryPurchases: {
			dateBoundNecessaryPurchaseFunding:
				inputs.dateBoundNecessaryPurchaseFunding,
			perGoal: dateBound.perGoal,
			overdueGoalIds: dateBound.overdue,
		},
		emergencyFund: {
			bucketId: emergency.bucketId,
			balance: inputs.coreEmergencyFundBalance,
			target: CORE_EMERGENCY_FUND_TARGET,
			gap: formatCentsToMoney(emergency.gapCents),
		},
		mobility: {
			mobilityBalance: inputs.mobilityBalance,
			goals: mobility.goalEvidence,
		},
		checkpointContext: {
			intervalStart: intervalStart.toISOString(),
			intervalEnd: intervalEnd.toISOString(),
			previousCheckpointProvided: params.previousCheckpointAt instanceof Date,
		},
	};

	const checkpointAnalysis: Record<string, unknown> = {
		intervalStart: intervalStart.toISOString(),
		intervalEnd: intervalEnd.toISOString(),
		income: {
			realizedIncomeMTD: inputs.realizedIncome,
			regular: formatCentsToMoney(income.regularCents),
			extra: formatCentsToMoney(income.extraCents),
			plannedFamilyGift: formatCentsToMoney(income.plannedFamilyGiftCents),
			deficitFamilySupport: {
				amount: formatCentsToMoney(income.deficitFamilySupportCents),
				note: "post-deficit funding source; NOT part of realizedIncome",
			},
			receipts: income.receiptEvidence,
		},
		creditCards: {
			note: "per-statement personal / external decomposition is taken only from sealed statement reconciliations; an unreconciled current/due statement fails the resolver closed",
			currentDueOrOverdueStatements: obligations.creditCardStatements,
		},
		spending: {
			actualBasicLivingSpendMTD: formatCentsToMoney(
				basicLiving.actualSpendMtdCents,
			),
			basicLivingSpendComponents: basicLiving.spendComponents,
			note: "discretionary / food split analytics require category aggregation this resolver does not yet perform; omitted rather than estimated",
		},
		peopleFamily: {
			peoplePayableDueOrOverdue: obligations.peoplePayable,
			unresolvedPayables: obligations.unresolvedPayables,
		},
		budgetInputs: {
			basicLivingTarget: formatCentsToMoney(basicLiving.targetCents),
			actualBasicLivingSpendMTD: formatCentsToMoney(
				basicLiving.actualSpendMtdCents,
			),
			basicLivingFunding: inputs.basicLivingFunding,
			dateBoundNecessaryPurchaseFunding:
				inputs.dateBoundNecessaryPurchaseFunding,
			emergencyFundBalance: inputs.coreEmergencyFundBalance,
			emergencyGap: formatCentsToMoney(emergency.gapCents),
			mobilityBalance: inputs.mobilityBalance,
			currentObligations: inputs.currentObligations,
		},
		policyOutput: {
			deficit: policyResult.outputs.deficit.amount,
			emergencyCatchUp: policyResult.outputs.emergencyCatchUp.amount,
			trueSurplus: policyResult.outputs.trueSurplus.amount,
			mobilityAllocation: policyResult.outputs.mobilityAllocation.amount,
			longTermInvestment: policyResult.outputs.longTermInvestment.amount,
			discretionaryAllocation:
				policyResult.outputs.discretionaryAllocation.amount,
		},
	};

	return {
		asOf: asOf.toISOString(),
		periodMonth,
		inputs,
		policyResult,
		evidenceSnapshot,
		checkpointAnalysis,
		availableToAllocateNow: {
			available: false,
			reason: "SURPLUS_USE_ATTRIBUTION_UNSUPPORTED",
			supported: {
				trueSurplus: policyResult.outputs.trueSurplus.amount,
				actualMobilityBucketBalances: mobility.goalEvidence,
				note: "exact attribution of realized discretionary / Mobility / Long-Term / sweep spend against the projected trueSurplus split is not derivable from stored accounting truth; no TL figure is produced",
			},
		},
	};
}

// ============================================================================
// Section 11 -- historical-replay-first entrypoint
// ============================================================================

export interface ResolveForWriteResult {
	source: "REPLAY" | "LIVE";
	periodMonth: string;
	snapshot: {
		inputs: PersonalBudgetV2Inputs;
		evidenceSnapshot: Record<string, unknown>;
	};
	resolution?: BudgetV2LiveResolution;
}

function inputsFromStoredRevision(
	rev: typeof monthlyBudgetV2PlanRevisions.$inferSelect,
): PersonalBudgetV2Inputs {
	return {
		realizedIncome: rev.realizedIncomeAmount,
		currentObligations: rev.currentObligationsAmount,
		basicLivingFunding: rev.basicLivingFundingAmount,
		dateBoundNecessaryPurchaseFunding:
			rev.dateBoundNecessaryPurchaseFundingAmount,
		coreEmergencyFundBalance: rev.coreEmergencyFundBalanceAmount,
		mobilityBalance: rev.mobilityBalanceAmount,
	};
}

export async function resolveBudgetV2SnapshotForWrite(params: {
	db: Database;
	userId: string;
	periodMonth: string;
	idempotencyKey: string;
	asOf?: Date | undefined;
	previousCheckpointAt?: Date | undefined;
}): Promise<ResolveForWriteResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new BudgetError("BUDGET_INVALID_INPUT", "idempotencyKey is required");
	}

	// 1. Stored CREATION revision by this key -> replay, no live recompute.
	const [canon] = await db
		.select()
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.userId, userId),
				eq(canonicalTransactions.creationIdempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	if (canon) {
		if (canon.kind !== "MONTHLY_BUDGET_PLAN_V2") {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`idempotency key "${idempotencyKey}" already used for kind "${canon.kind}"`,
			);
		}
		const [plan] = await db
			.select()
			.from(monthlyBudgetV2Plans)
			.where(eq(monthlyBudgetV2Plans.canonicalTransactionId, canon.id))
			.limit(1);
		const [rev1] = plan
			? await db
					.select()
					.from(monthlyBudgetV2PlanRevisions)
					.where(
						and(
							eq(monthlyBudgetV2PlanRevisions.budgetPlanId, plan.id),
							eq(monthlyBudgetV2PlanRevisions.revisionNo, 1),
						),
					)
					.limit(1)
			: [];
		if (!plan || !rev1) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"stored V2 creation exists but plan/revision #1 is missing",
			);
		}
		return {
			source: "REPLAY",
			periodMonth: plan.periodMonth,
			snapshot: {
				inputs: inputsFromStoredRevision(rev1),
				evidenceSnapshot: rev1.evidenceSnapshot as Record<string, unknown>,
			},
		};
	}

	// 2. Stored REFRESH (UPDATE) revision by this key -> replay.
	const [canonRev] = await db
		.select()
		.from(transactionRevisions)
		.where(
			and(
				eq(transactionRevisions.idempotencyKey, idempotencyKey),
				eq(transactionRevisions.operation, "UPDATE"),
			),
		)
		.limit(1);
	if (canonRev) {
		const [planRev] = await db
			.select()
			.from(monthlyBudgetV2PlanRevisions)
			.where(
				and(
					eq(monthlyBudgetV2PlanRevisions.canonicalRevisionId, canonRev.id),
					eq(monthlyBudgetV2PlanRevisions.userId, userId),
				),
			)
			.limit(1);
		if (planRev) {
			const [plan] = await db
				.select()
				.from(monthlyBudgetV2Plans)
				.where(eq(monthlyBudgetV2Plans.id, planRev.budgetPlanId))
				.limit(1);
			return {
				source: "REPLAY",
				periodMonth: plan?.periodMonth ?? periodMonth,
				snapshot: {
					inputs: inputsFromStoredRevision(planRev),
					evidenceSnapshot: planRev.evidenceSnapshot as Record<string, unknown>,
				},
			};
		}
	}

	// 3. Fresh -> live resolve.
	const resolution = await resolveBudgetV2LiveSnapshot({
		db,
		userId,
		periodMonth,
		asOf: params.asOf,
		previousCheckpointAt: params.previousCheckpointAt,
	});
	return {
		source: "LIVE",
		periodMonth,
		snapshot: {
			inputs: resolution.inputs,
			evidenceSnapshot: resolution.evidenceSnapshot,
		},
		resolution,
	};
}
