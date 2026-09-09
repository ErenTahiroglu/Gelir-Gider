import { and, desc, eq, lt, lte, or, sql } from "drizzle-orm";
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
	creditCardStatementPaymentEvents,
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

/**
 * Net kurus balance of a Midas bucket at `at`.
 *  - "inclusive" (default): transfers with occurredAt <= at  -- current balance.
 *  - "exclusive": transfers with occurredAt <  at  -- STRICT recognition basis
 *    (reserve carry-in before periodStart / date-bound recognition basis). A
 *    transfer exactly at `at` does NOT count.
 */
async function bucketNetCents(
	db: Database,
	userId: string,
	bucketId: string,
	at: Date,
	boundary: "inclusive" | "exclusive" = "inclusive",
): Promise<bigint> {
	const timeCond =
		boundary === "exclusive"
			? lt(midasAllocationTransfers.occurredAt, at)
			: lte(midasAllocationTransfers.occurredAt, at);
	const [row] = await db
		.select({
			net: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${bucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${bucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
		})
		.from(midasAllocationTransfers)
		.where(
			and(
				eq(midasAllocationTransfers.userId, userId),
				timeCond,
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
		// Locked rule: transfers occurredAt < max(periodStart, goalActivation).
		// A transfer exactly at the recognition basis must NOT shrink the gap.
		const bucketAtBasis = await bucketNetCents(
			db,
			userId,
			g.midasBucketId,
			recognitionBasisAt,
			"exclusive",
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
	/** MANDATORY personal credit-card purchase spend this window, by purchase event. */
	mandatoryPersonalByEvent: Map<string, bigint>;
	/** MANDATORY People PAYABLE principal this window, by obligation. */
	mandatoryPeopleByObligation: Map<string, bigint>;
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
	const mandatoryPersonalByEvent = new Map<string, bigint>();
	const mandatoryPeopleByObligation = new Map<string, bigint>();
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
		mandatoryPersonalByEvent.set(
			p.eventId,
			(mandatoryPersonalByEvent.get(p.eventId) ?? 0n) + personalCents,
		);
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
		mandatoryPeopleByObligation.set(
			o.id,
			(mandatoryPeopleByObligation.get(o.id) ?? 0n) + cents,
		);
		spendComponents.push({
			source: "PEOPLE_PAYABLE",
			obligationId: o.id,
			principal: formatCentsToMoney(cents),
			occurredAt: at.toISOString(),
		});
	}

	return {
		targetCents,
		targetRevisionId: cfg.id,
		actualSpendMtdCents: spend,
		mandatoryPersonalByEvent,
		mandatoryPeopleByObligation,
		spendComponents,
		currency: cfg.currency,
	};
}

// ============================================================================
// Cross-waterfall overlap (section 4) -- the same MANDATORY economic item must
// NEVER be recognised in BOTH currentObligations and basicLivingFunding.
// Only subtract an overlap that EXACT source identity proves (never dates/amounts).
// ============================================================================

function computeBasicLivingOverlapCents(
	basicLiving: BasicLivingResult,
	obligations: CurrentObligationsResult,
): { overlapCents: bigint; detail: Array<Record<string, unknown>> } {
	let overlap = 0n;
	const detail: Array<Record<string, unknown>> = [];
	const remainingMandatoryByEvent = new Map(
		basicLiving.mandatoryPersonalByEvent,
	);

	for (const st of obligations.recognizedStatements) {
		if (st.burdenCents <= 0n) continue;
		let m = 0n;
		const events: string[] = [];
		for (const c of st.personalPurchaseComponents) {
			const mand = remainingMandatoryByEvent.get(c.purchaseEventId) ?? 0n;
			if (mand <= 0n) continue;
			const take = c.personalCents < mand ? c.personalCents : mand;
			m += take;
			remainingMandatoryByEvent.set(c.purchaseEventId, mand - take);
			events.push(c.purchaseEventId);
		}
		// Reserve carry-in funded `carryInFundedCents` of the personal share; only
		// the FRESH burden (personalShare - carryIn) can overlap current income.
		const stmtOverlap =
			m - st.carryInFundedCents > 0n ? m - st.carryInFundedCents : 0n;
		if (stmtOverlap > 0n) {
			overlap += stmtOverlap;
			detail.push({
				statementId: st.statementId,
				mandatoryPersonalPurchaseInStatement: formatCentsToMoney(m),
				carryInFunded: formatCentsToMoney(st.carryInFundedCents),
				overlapRecognized: formatCentsToMoney(stmtOverlap),
				events,
			});
		}
	}

	for (const [
		oblId,
		contribCents,
	] of obligations.recognizedPeopleByObligation) {
		const mand = basicLiving.mandatoryPeopleByObligation.get(oblId) ?? 0n;
		if (mand <= 0n || contribCents <= 0n) continue;
		const o = mand < contribCents ? mand : contribCents;
		overlap += o;
		detail.push({
			obligationId: oblId,
			mandatoryPrincipal: formatCentsToMoney(mand),
			recognizedInCurrentObligations: formatCentsToMoney(contribCents),
			overlapRecognized: formatCentsToMoney(o),
		});
	}

	return { overlapCents: overlap, detail };
}

// ============================================================================
// INPUT: currentObligations (section 3) -- ONE-COUNT
// ============================================================================

interface RecognizedStatement {
	statementId: string;
	carryInFundedCents: bigint;
	burdenCents: bigint;
	personalPurchaseComponents: Array<{
		purchaseEventId: string;
		personalCents: bigint;
	}>;
}

interface CurrentObligationsResult {
	cents: bigint;
	creditCardStatements: Array<Record<string, unknown>>;
	peoplePayable: Array<Record<string, unknown>>;
	unresolvedPayables: Array<Record<string, unknown>>;
	recognizedStatements: RecognizedStatement[];
	recognizedPeopleByObligation: Map<string, bigint>;
}

/**
 * Authoritative instant a statement became PAID -- from the append-only PAY
 * statement revision (preferring its linked payment event). Never inferred.
 */
async function statementPaidInstant(
	db: Database,
	statementId: string,
): Promise<Date | null> {
	const [payRev] = await db
		.select({
			occurredAt: creditCardStatementRevisions.occurredAt,
			paymentEventId: creditCardStatementRevisions.paymentEventId,
		})
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.statementId, statementId),
				eq(creditCardStatementRevisions.operation, "PAY"),
			),
		)
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);
	if (!payRev) return null;
	if (payRev.paymentEventId) {
		const [pe] = await db
			.select({ occurredAt: creditCardStatementPaymentEvents.occurredAt })
			.from(creditCardStatementPaymentEvents)
			.where(eq(creditCardStatementPaymentEvents.id, payRev.paymentEventId))
			.limit(1);
		if (pe) return asDate(pe.occurredAt);
	}
	return asDate(payRev.occurredAt);
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
	const recognizedStatements: RecognizedStatement[] = [];
	const recognizedPeopleByObligation = new Map<string, bigint>();

	// ---- A. Credit-card personal current/due/overdue burden (TRUE one-count) ----
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

			// Period recognition -- the defect was recognising every non-VOID
			// statement whose dueDate <= period end, so an old PAID statement
			// reappeared every later month.
			const dueThisPeriod = !!rev.dueDate && rev.dueDate <= lastDay;
			let recognisePeriod: boolean;
			let recognitionBasis: string;
			if (rev.status === "PAID") {
				const paidAt = await statementPaidInstant(db, s.id);
				if (!paidAt) {
					failClosed(
						`credit-card statement ${s.id} latest status is PAID but has no authoritative PAY revision / payment event`,
					);
				}
				if (paidAt < periodStart) {
					recognisePeriod = false; // settled before this period -- history
					recognitionBasis = "PAID_BEFORE_PERIOD";
				} else if (paidAt < windowEnd) {
					recognisePeriod = true; // actual current-period cash commitment
					recognitionBasis = "PAID_WITHIN_PERIOD";
				} else {
					// paid after asOf -> as of this period it was still an unpaid due
					recognisePeriod = dueThisPeriod;
					recognitionBasis = "OPEN_DUE";
				}
			} else {
				// OPEN (incl. after REOPEN) -- deterministic on latest status.
				recognisePeriod = dueThisPeriod;
				recognitionBasis = "OPEN_DUE";
			}
			if (!recognisePeriod) continue;

			const recon = await getStatementReconciliation({
				db,
				userId,
				statementId: s.id,
			});
			if (recon.status !== "RECONCILED") {
				failClosed(
					`credit-card statement ${s.id} is not reconciled (status=${recon.status}${recon.staleReason ? `: ${recon.staleReason}` : ""}); its personal share cannot be authoritatively decomposed`,
				);
			}
			const stmtAmountCents = parseAggregateMoneyString(
				rev.statementAmount,
			).cents;
			// STRICT: reserve carry-in = transfers occurredAt < periodStart.
			const carryInFunded = await bucketNetCents(
				db,
				userId,
				s.reserveBucketId,
				periodStart,
				"exclusive",
			);
			if (carryInFunded < 0n) {
				failClosed(
					`credit-card statement ${s.id} reserve bucket has a negative net balance; invariant violated`,
				);
			}
			let externalCents = 0n;
			for (const v of recon.externalByPerson.values()) externalCents += v;
			const isAllPersonal = externalCents === 0n;

			let burden: bigint;
			let carryInCase: string;
			if (carryInFunded === 0n) {
				burden = recon.personalCents;
				carryInCase = "A_NO_CARRY_IN";
			} else if (carryInFunded >= stmtAmountCents) {
				burden = 0n;
				carryInCase = "B_FULLY_PREFUNDED";
			} else if (isAllPersonal) {
				burden =
					recon.personalCents - carryInFunded > 0n
						? recon.personalCents - carryInFunded
						: 0n;
				carryInCase = "C_PARTIAL_ALL_PERSONAL";
			} else {
				failClosed(
					`credit-card statement ${s.id}: pre-period reserve carry-in ${carryInFunded} kurus partially funds a statement with mixed PERSONAL/EXTERNAL ownership; the ownership allocation of an old reserve is not authoritative`,
				);
			}
			total += burden;

			const personalPurchaseComponents = recon.components
				.filter(
					(c) =>
						c.componentType === "PURCHASE" &&
						c.ownership === "PERSONAL" &&
						!!c.purchaseEventId,
				)
				.map((c) => ({
					purchaseEventId: c.purchaseEventId as string,
					personalCents: parseAggregateMoneyString(c.amount).cents,
				}));
			recognizedStatements.push({
				statementId: s.id,
				carryInFundedCents: carryInFunded,
				burdenCents: burden,
				personalPurchaseComponents,
			});
			ccEvidence.push({
				statementId: s.id,
				cardId: card.id,
				dueDate: rev.dueDate,
				statementStatus: rev.status,
				recognitionBasis,
				statementAmount: rev.statementAmount,
				personalShare: formatCentsToMoney(recon.personalCents),
				externalShare: formatCentsToMoney(externalCents),
				reserveCarryInFundedBeforePeriod: formatCentsToMoney(carryInFunded),
				carryInCase,
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
				recognizedPeopleByObligation.set(o.id, settledInPeriod);
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
			recognizedPeopleByObligation.set(o.id, contribution);
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
		recognizedStatements,
		recognizedPeopleByObligation,
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

	// section 4 -- basicLivingFunding after removing the exact overlap with items
	// already recognised in currentObligations (one-count across the waterfall).
	const grossBasicLivingNeedCents =
		basicLiving.actualSpendMtdCents > basicLiving.targetCents
			? basicLiving.actualSpendMtdCents
			: basicLiving.targetCents;
	const {
		overlapCents: basicLivingOverlapCents,
		detail: basicLivingOverlapDetail,
	} = computeBasicLivingOverlapCents(basicLiving, obligations);
	const basicLivingFundingCents =
		grossBasicLivingNeedCents - basicLivingOverlapCents > 0n
			? grossBasicLivingNeedCents - basicLivingOverlapCents
			: 0n;

	const inputs: PersonalBudgetV2Inputs = {
		realizedIncome: formatCentsToMoney(income.cents),
		currentObligations: formatCentsToMoney(obligations.cents),
		basicLivingFunding: formatCentsToMoney(basicLivingFundingCents),
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
			actualPersonalMandatorySpendMTD: formatCentsToMoney(
				basicLiving.actualSpendMtdCents,
			),
			grossBasicLivingNeed: formatCentsToMoney(grossBasicLivingNeedCents),
			basicLivingOverlapWithCurrentObligations: formatCentsToMoney(
				basicLivingOverlapCents,
			),
			basicLivingOverlapDetail,
			basicLivingFunding: inputs.basicLivingFunding,
			formula:
				"max(max(approvedTarget, actualPersonalMandatorySpendMTD) - basicLivingOverlapWithCurrentObligations, 0)",
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
			actualPersonalMandatorySpendMTD: formatCentsToMoney(
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
			actualPersonalMandatorySpendMTD: formatCentsToMoney(
				basicLiving.actualSpendMtdCents,
			),
			grossBasicLivingNeed: formatCentsToMoney(grossBasicLivingNeedCents),
			basicLivingOverlapWithCurrentObligations: formatCentsToMoney(
				basicLivingOverlapCents,
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
		if (plan.periodMonth !== periodMonth) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`idempotency key "${idempotencyKey}" is stored for period "${plan.periodMonth}", not the requested "${periodMonth}"`,
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

	// 2. Stored REFRESH (UPDATE) revision by this key -> replay. The DB
	// idempotency uniqueness is user-scoped, so scope the lookup by userId.
	const [canonRev] = await db
		.select()
		.from(transactionRevisions)
		.where(
			and(
				eq(transactionRevisions.userId, userId),
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
			if (plan && plan.periodMonth !== periodMonth) {
				throw new BudgetError(
					"BUDGET_IDEMPOTENCY_CONFLICT",
					`refresh idempotency key "${idempotencyKey}" is stored for period "${plan.periodMonth}", not the requested "${periodMonth}"`,
				);
			}
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
