import { and, asc, eq } from "drizzle-orm";
import { resolveAuthoritativePurchaseSplitAsOf } from "../credit-cards/purchase-split-read";
import {
	getStatementReconciliationAsOf,
	type StatementReconciliationStatus,
} from "../credit-cards/statement-reconciliation";
import type { Database } from "../db/client";
import { effectiveRevisionAsOf } from "../db/effective-revision";
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
	creditCardPurchaseSplitParticipants,
	creditCardPurchaseSplits,
} from "../db/schema/credit-card-splits";
import {
	creditCardRevisions,
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "../db/schema/credit-cards";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../db/schema/income";
import {
	longTermSendTaskRevisions,
	longTermSendTasks,
} from "../db/schema/long-term";
import { midasAllocationTransfers } from "../db/schema/midas";
import {
	type PersonRelationship,
	personObligationRevisions,
	personObligations,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { shortTermGoals } from "../db/schema/short-term-goals";
import { formatCentsToMoney, parseAggregateMoneyString } from "../ledger/money";
import { BudgetError } from "./errors";
import {
	type BudgetV2LiveResolution,
	buildResolverWindow,
	type CurrentObligationsOverlap,
	type ResolverWindow,
	resolveBudgetV2CurrentObligationsOverlap,
	resolveBudgetV2LiveSnapshot,
} from "./live-resolver-v2";
import {
	type FoodClassificationKind,
	getSpendingFoodClassificationAsOf,
} from "./spending-food-classification-v2";
import {
	getSurplusUseAttributionAsOf,
	type SurplusUseSubjectRef,
} from "./surplus-use-attribution-v2";
import { normalizeUuid, validateBudgetPeriodMonth } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- AUTHORITATIVE CHECKPOINT REPORT READ MODEL
 * (checkpoint 4B, hardened in 4B.1)
 *
 * A READ-ONLY, zero-inference, zero-silent-fallback report.
 *
 * TRIGGER IDENTITY = PAYMENT EVENT, not statement. The credit-card domain
 * supports PAID -> REOPEN -> PAY, so one statement can carry several distinct
 * PAY / payment events; each is a separate checkpoint identity. The canonical
 * API takes `triggerPaymentEventId` and derives
 *   paymentEvent -> statement -> the exact PAY revision that references it.
 * `buildBudgetV2CheckpointReportByStatement` is a compatibility wrapper only --
 * it resolves solely when exactly one eligible PAY event is unambiguous and
 * otherwise raises BUDGET_CHECKPOINT_TRIGGER_AMBIGUOUS.
 *
 * TEMPORAL SAFETY. Every historical fact is read AS OF `checkpointAt`:
 *   - person relationship: highest person_revisions row with occurredAt <= at;
 *     no row => fail closed (never borrow a later state);
 *   - purchase split ownership: the effective split revision as of `at`, which
 *     MUST be sealed and internally consistent, else fail closed / mark the
 *     activity row ownership unavailable (never trust an unsealed or future
 *     revision, never infer ownership from amounts or names);
 *   - card displayName / issuer: the card revision effective at `checkpointAt`;
 *   - SUPPORT income role: the classification revision effective at
 *     `checkpointAt` (a later reclassification never rewrites the report).
 *
 * MTD state comes verbatim from `resolveBudgetV2LiveSnapshot` (no re-derived
 * waterfall math); required evidence fields are typed-asserted, never coerced
 * into a plausible "0.00".
 *
 * FOOD semantics (checkpoint 4C): explicit, user-approved FOOD_HOME_MARKET /
 * FOOD_OUTSIDE allocations ARE stored (`budget_v2_spending_food_semantic_
 * revisions`) and are read here authoritatively -- `mtd.foodAnalytics` for the
 * current spending-state total (exact only when every active MTD subject is
 * CLASSIFIED, including explicit NON_FOOD) and a per-row `foodClassification`
 * on interval activity as of each activity instant. Merchant / MCC / heuristic
 * food inference is NEVER used. Forward installment schedules remain unstored
 * and unsupported.
 *
 * SURPLUS-USE ATTRIBUTION (checkpoint 5B / 5B.1): `mtd.surplusUseAttribution`
 * lists every active MTD surplus-use candidate (credit-card purchase personal
 * share, People PAYABLE principal, UNALLOCATED -> INTERNATIONAL_MOBILITY goal
 * transfer, Long-Term send task) with its user-approved funding provenance;
 * `availableToAllocateNow` is the AUTHORITATIVE observation of remaining
 * current-period true-surplus policy capacity. An economic source is never
 * subtracted twice: `waterfallAlreadyCoveredAmount` (exact per-source overlap
 * with `currentObligations`) is removed dynamically, and
 * `effectiveCurrentSurplusUseAmount = min(attributed, remaining)` -- so an
 * attribution does NOT need an UPDATE merely because the same expense later
 * enters a statement. When per-source overlap cannot be proven exactly
 * (partial reserve carry-in, basic-living aggregate), the report fails closed
 * (SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED); explicit zero attribution does
 * not cure an unresolved overlap.
 *
 * LAYERING / AUTHORITY BOUNDARY:
 *   - `resolveBudgetV2LiveSnapshot(...)` is the lower-level six-input / policy
 *     resolver. Its `availableToAllocateNow` stays the legacy
 *     `{available:false, reason:"SURPLUS_USE_ATTRIBUTION_UNSUPPORTED"}` digest
 *     and MUST NOT be treated as an authority; surplus-use candidate
 *     construction is NOT duplicated there.
 *   - `buildBudgetV2CheckpointReport(...)` is READ-ONLY but authoritative: it
 *     combines the live policy result + exact currentObligations overlap +
 *     the surplus-use candidate universe + user-approved attribution + food
 *     semantics.
 *   - the Checkpoint 5 durable snapshot (`budget_v2_checkpoint_snapshots`)
 *     FREEZES this report's output at a real PAID payment event and is the
 *     authoritative HISTORICAL replay source (replay-before-live). A later
 *     attribution / source / currentObligations change never rewrites a
 *     stored snapshot. The Behavior Engine (future) consumes persisted
 *     checkpoint observations -- `extractBehaviorEngineCheckpointObservation`
 *     -- never a recomputation from mutable live sources.
 */

export const BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION =
	"budget-v2-checkpoint-report-v1";

// ============================================================================
// Public shape
// ============================================================================

export type { PersonRelationship };

export interface CheckpointReportParams {
	db: Database;
	userId: string;
	periodMonth: string;
	/** Canonical trigger identity -- a credit_card_statement_payment_events id. */
	triggerPaymentEventId: string;
	previousCheckpointAt?: Date | undefined;
}

export interface OwnershipByPerson {
	personId: string;
	displayName: string;
	relationship: PersonRelationship;
	amount: string;
}

export interface OwnershipDecomposition {
	available: true;
	grossStatementAmount: string;
	personalEconomicShare: string;
	externalShareTotal: string;
	externalByPerson: OwnershipByPerson[];
	familyExternalShare: string;
	friendExternalShare: string;
	otherExternalShare: string;
}

export interface OwnershipUnavailable {
	available: false;
	reason: "RECONCILIATION_UNAVAILABLE";
	reconciliationStatus: StatementReconciliationStatus;
}

export interface TriggerPaymentSection {
	paymentEventId: string;
	payRevisionId: string;
	statementId: string;
	cardId: string;
	cardCode: string;
	displayName: string;
	issuer: string;
	statementCycle: { year: number; month: number };
	statementAmount: string;
	paymentAmount: string;
	checkpointAt: string;
	paidAt: string;
	reservePlacement: string;
	paymentAssetAccountId: string;
	reconciliationRevisionNo: number;
	ownership: OwnershipDecomposition;
}

export interface CheckpointSection {
	schemaVersion: string;
	periodMonth: string;
	paymentEventId: string;
	payRevisionId: string;
	statementId: string;
	checkpointAt: string;
	previousCheckpointAt: string | null;
	isFirstCheckpoint: boolean;
	intervalStart: string;
	intervalStartInclusive: boolean;
	intervalEnd: string;
	mtdWindowStart: string;
	mtdWindowEnd: string;
}

export type IncomeSourceNature = "REGULAR" | "EXTRA" | "SUPPORT";
export type SupportRole = "PLANNED_FAMILY_GIFT" | "DEFICIT_FAMILY_SUPPORT";

export interface IntervalIncomeActivityItem {
	receiptId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	amount: string;
	occurredAt: string;
	sourceNature: IncomeSourceNature;
	/** Role effective AT the checkpoint instant (never a later reclassification). */
	supportRole: SupportRole | null;
}

export interface IntervalIncomeSection {
	activity: IntervalIncomeActivityItem[];
	regularReceipts: string;
	extraReceipts: string;
	plannedFamilyGiftReceipts: string;
	deficitFamilySupportReceipts: string;
	note: string;
}

export type PurchaseBudgetCategory =
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE"
	| "UNCLASSIFIED";

export interface PurchaseParticipant {
	personId: string;
	displayName: string;
	relationship: PersonRelationship;
	shareAmount: string;
}

export type PurchaseOwnership =
	| {
			available: true;
			personalShare: string;
			externalShare: string;
			externalParticipants: PurchaseParticipant[];
			basis: "SEALED_SPLIT_AS_OF" | "NO_SPLIT" | "VOID_SPLIT";
	  }
	| { available: false; reason: string };

/**
 * Explicit (user-approved) food-semantic visibility for ONE interval activity
 * row, evaluated AS OF that activity revision's own `occurredAt` -- never a
 * later classification. This is historical activity CONTEXT; the authoritative
 * current spending-state total is `mtd.foodAnalytics`. A correction / VOID
 * revision is visible here but never contributes a second food amount.
 *
 *   applicable:false           -- the subject is not a food-expense subject
 *                                 (People RECEIVABLE, settlements)
 *   applicable:true available:false
 *                              -- the classification could not be resolved
 *   applicable:true available:true status:"CLASSIFIED"
 *                              -- an active approved allocation at that instant
 *   applicable:true available:true status:"UNCLASSIFIED"|"STALE"|"SOURCE_VOID"
 *                              -- no active allocation at that instant; no
 *                                 fabricated food amounts
 */
export type IntervalFoodClassification =
	| { applicable: false }
	| { applicable: true; available: false; reason: string }
	| {
			applicable: true;
			available: true;
			status: "CLASSIFIED";
			semanticRevisionId: string;
			semanticRevisionNo: number;
			basisPersonalAmount: string;
			foodHomeMarketAmount: string;
			foodOutsideAmount: string;
			foodTotalAmount: string;
			nonFoodAmount: string;
			classificationKind: FoodClassificationKind;
			sourceKind: "USER_APPROVED" | "USER_APPROVED_FROM_SUGGESTION";
	  }
	| {
			applicable: true;
			available: true;
			status: "UNCLASSIFIED" | "STALE" | "SOURCE_VOID";
			semanticRevisionId: string | null;
			semanticRevisionNo: number | null;
			reason: string | null;
	  };

export interface IntervalPurchaseActivityItem {
	eventId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	cardId: string;
	cardCode: string;
	displayName: string;
	grossAmount: string;
	budgetCategory: PurchaseBudgetCategory;
	merchant: string | null;
	description: string | null;
	installmentCount: number | null;
	occurredAt: string;
	/** Ownership effective at THIS activity instant; unavailable if unprovable. */
	ownership: PurchaseOwnership;
	/** Approved food-semantic status AS OF this activity instant (context only). */
	foodClassification: IntervalFoodClassification;
}

export interface IntervalPurchaseSection {
	activity: IntervalPurchaseActivityItem[];
	newlyPostedPurchases: string[];
	correctedPurchases: string[];
	voidedPurchases: string[];
	note: string;
}

export interface PeopleObligationActivityItem {
	obligationId: string;
	personId: string;
	displayName: string;
	relationship: PersonRelationship;
	direction: "RECEIVABLE" | "PAYABLE";
	kind: "OBLIGATION";
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	principal: string;
	budgetCategory: string | null;
	dueDate: string | null;
	occurredAt: string;
	/**
	 * Approved food-semantic status AS OF this activity instant. PAYABLE is a
	 * food-expense subject; RECEIVABLE is explicitly `applicable:false`.
	 */
	foodClassification: IntervalFoodClassification;
}

export interface PeopleSettlementActivityItem {
	obligationId: string;
	personId: string;
	displayName: string;
	relationship: PersonRelationship;
	direction: "RECEIVABLE" | "PAYABLE";
	kind: "SETTLEMENT";
	revisionNo: number;
	operation: "CREATE" | "VOID";
	settlementAmount: string;
	occurredAt: string;
}

export interface FamilyReimbursementItem {
	personId: string;
	displayName: string;
	obligationId: string;
	purchaseEventId: string;
	splitRevisionId: string;
	settlementAmount: string;
	occurredAt: string;
}

export interface StandaloneReceivableSettlementItem {
	personId: string;
	displayName: string;
	relationship: PersonRelationship;
	obligationId: string;
	settlementAmount: string;
	occurredAt: string;
}

export interface PeopleFamilySection {
	obligationActivity: PeopleObligationActivityItem[];
	settlementActivity: PeopleSettlementActivityItem[];
	familyReimbursements: FamilyReimbursementItem[];
	standaloneReceivableSettlements: StandaloneReceivableSettlementItem[];
	note: string;
}

export interface StatementPaymentItem {
	paymentEventId: string;
	statementId: string;
	cardId: string;
	cardCode: string;
	displayName: string;
	amount: string;
	occurredAt: string;
	paymentAssetAccountId: string;
	isTrigger: boolean;
	ownership: OwnershipDecomposition | OwnershipUnavailable;
}

export interface IntervalSection {
	income: IntervalIncomeSection;
	purchases: IntervalPurchaseSection;
	peopleFamily: PeopleFamilySection;
	statementPayments: StatementPaymentItem[];
}

export interface MtdSpendingSection {
	byCategoryPersonalShare: Record<PurchaseBudgetCategory, string>;
	grossCardPurchasesMTD: string;
	personalCardSpendMTD: string;
	externalCardSpendMTD: string;
	externalCardSpendByRelationship: Record<PersonRelationship, string>;
}

export interface MtdBudgetSection {
	inputs: BudgetV2LiveResolution["inputs"];
	policyOutput: {
		deficit: string;
		emergencyCatchUp: string;
		trueSurplus: string;
		mobilityAllocation: string;
		longTermInvestment: string;
		discretionaryAllocation: string;
	};
	basicLiving: {
		approvedTarget: string;
		actualPersonalMandatorySpendMTD: string;
		grossBasicLivingNeed: string;
		overlapWithCurrentObligations: string;
		basicLivingFunding: string;
	};
}

export interface MtdSection {
	spending: MtdSpendingSection;
	budget: MtdBudgetSection;
	emergencyFund: { currentBalance: string; target: string; gap: string };
	mobility: { currentTotal: string; perGoal: unknown[] };
	necessaryPurchases: {
		totalMonthlyContribution: string;
		perGoal: unknown[];
		overdueGoalIds: unknown[];
	};
	surplusUseAttribution: SurplusUseAttributionSection;
}

// ============================================================================
// Section 5B -- surplus-use attribution + authoritative availableToAllocateNow
// ============================================================================

export type SurplusUseLaneName =
	| "DISCRETIONARY"
	| "INTERNATIONAL_MOBILITY"
	| "LONG_TERM_INVESTMENT";

export type SurplusUseCandidateStatus = "ATTRIBUTED" | "UNATTRIBUTED" | "STALE";

/**
 * One active MTD surplus-use CANDIDATE and its explicit (user-approved) funding
 * provenance as of the checkpoint. Funding provenance is never inferred.
 *   - `waterfallAlreadyCoveredAmount` is the EXACT part of this source already
 *     represented in the policy waterfall (`currentObligations`); Midas
 *     Mobility / Long-Term allocations have zero waterfall overlap.
 *   - `waterfallOverlapExact = false` when a partial carry-in / basic-living
 *     aggregate makes per-source overlap ambiguous -- this forces
 *     `availableToAllocateNow` unavailable for exactness (never guessed).
 *   - `effectiveCurrentSurplusUseAmount = min(attributed, remaining)` when the
 *     overlap is exact -- so an attribution need not be rewritten merely
 *     because the same expense later enters `currentObligations`.
 */
export interface SurplusUseCandidateEntry {
	subjectType:
		| "CREDIT_CARD_PURCHASE"
		| "PEOPLE_PAYABLE"
		| "MOBILITY_MIDAS_TRANSFER"
		| "LONG_TERM_SEND_TASK";
	subjectId: string;
	lane: SurplusUseLaneName;
	sourceEconomicAmount: string;
	waterfallAlreadyCoveredAmount: string;
	waterfallOverlapExact: boolean;
	waterfallOverlapUnresolvedReason: string | null;
	remainingPotentialSurplusUseAmount: string;
	status: SurplusUseCandidateStatus;
	semanticRevisionId: string | null;
	semanticRevisionNo: number | null;
	storedBasisAmount: string | null;
	attributedCurrentSurplusAmount: string | null;
	effectiveCurrentSurplusUseAmount: string | null;
	sourceKind: "USER_APPROVED" | null;
	reason: string | null;
}

export interface SurplusUseAttributionSection {
	candidates: SurplusUseCandidateEntry[];
	candidateCount: number;
	attributedCount: number;
	coverageComplete: boolean;
	unattributedSubjectIds: string[];
	staleSubjectIds: string[];
	overlapUnresolvedSubjectIds: string[];
	knownAttributedCurrentSurplusUse: string;
}

export interface SurplusUseLaneAccounting {
	planned: string;
	used: string;
	remaining: string;
	overrun: string;
}

export interface AvailableToAllocateNowAvailable {
	available: true;
	amount: string;
	trueSurplus: string;
	totalAttributedCurrentSurplusUse: string;
	oversubscribedBy: string;
	lanes: Record<SurplusUseLaneName, SurplusUseLaneAccounting>;
	provenance: {
		method: "AUTHORITATIVE_USER_APPROVED_SURPLUS_USE_ATTRIBUTION";
		meaning: string;
		candidateCount: number;
		attributedCount: number;
	};
}

export interface AvailableToAllocateNowUnavailable {
	available: false;
	reason:
		| "SURPLUS_USE_ATTRIBUTION_INCOMPLETE"
		| "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED";
	trueSurplus: string;
	candidateCount: number;
	attributedCount: number;
	unattributedSubjectIds: string[];
	staleSubjectIds: string[];
	overlapUnresolvedSubjectIds: string[];
	knownAttributedCurrentSurplusUse: string;
	unresolvedPotentialUseAmount: string | null;
}

export type AvailableToAllocateNowSection =
	| AvailableToAllocateNowAvailable
	| AvailableToAllocateNowUnavailable;

/**
 * One eligible PERSONAL economic spending subject in the MTD window and its
 * explicit (user-approved) food-semantic status effective at the checkpoint.
 * `classificationStatus`:
 *   CLASSIFIED   -- an active, non-stale approved allocation (incl. NON_FOOD 0/0)
 *   UNCLASSIFIED -- no approved allocation
 *   STALE        -- the stored basis no longer matches the authoritative
 *                   personal economic amount; a new approved UPDATE is required
 */
export interface FoodSubjectEntry {
	subjectType: "CREDIT_CARD_PURCHASE" | "PEOPLE_PAYABLE";
	subjectId: string;
	effectiveFinancialRevisionId: string;
	personalEconomicAmount: string;
	classificationStatus: "CLASSIFIED" | "UNCLASSIFIED" | "STALE";
	semanticRevisionId: string | null;
	semanticRevisionNo: number | null;
	foodHomeMarketAmount: string | null;
	foodOutsideAmount: string | null;
	foodTotalAmount: string | null;
	nonFoodAmount: string | null;
	classificationKind: FoodClassificationKind | null;
	sourceKind: "USER_APPROVED" | "USER_APPROVED_FROM_SUGGESTION" | null;
}

/**
 * FOOD_TOTAL is presented as an EXACT total only when every eligible active
 * MTD spending subject is CLASSIFIED. Any UNCLASSIFIED / STALE subject flips
 * `available` to false with reason FOOD_CLASSIFICATION_INCOMPLETE, and only
 * clearly-labelled partial known totals are exposed.
 */
export interface FoodAnalyticsAvailable {
	available: true;
	merchantInferenceUsed: false;
	subjects: FoodSubjectEntry[];
	classifiedSubjectCount: number;
	foodHomeMarket: string;
	foodOutside: string;
	foodTotal: string;
	classifiedPersonalSpend: string;
}

export interface FoodAnalyticsIncomplete {
	available: false;
	reason: "FOOD_CLASSIFICATION_INCOMPLETE";
	merchantInferenceUsed: false;
	subjects: FoodSubjectEntry[];
	classifiedSubjectCount: number;
	unclassifiedSubjectIds: string[];
	staleSubjectIds: string[];
	classifiedPersonalSpend: string;
	unclassifiedOrStalePersonalSpend: string;
	partialKnownFoodHomeMarket: string;
	partialKnownFoodOutside: string;
	partialKnownFoodTotal: string;
}

export type FoodAnalyticsSection =
	| FoodAnalyticsAvailable
	| FoodAnalyticsIncomplete;

export interface InstallmentAnalyticsSection {
	purchases: Array<{
		eventId: string;
		grossAmount: string;
		personalShare: string;
		installmentCount: number;
	}>;
	futureInstallmentProjection: {
		available: false;
		reason: "INSTALLMENT_SCHEDULE_NOT_STORED";
	};
}

export interface BudgetV2CheckpointReport {
	schemaVersion: string;
	checkpoint: CheckpointSection;
	triggerPayment: TriggerPaymentSection;
	interval: IntervalSection;
	mtd: MtdSection;
	foodAnalytics: FoodAnalyticsSection;
	installmentAnalytics: InstallmentAnalyticsSection;
	availableToAllocateNow: AvailableToAllocateNowSection;
}

// ============================================================================
// Small helpers
// ============================================================================

function triggerInvalid(reason: string): never {
	throw new BudgetError("BUDGET_CHECKPOINT_TRIGGER_INVALID", reason);
}

function reportFailClosed(reason: string): never {
	throw new BudgetError("BUDGET_CHECKPOINT_REPORT_FAIL_CLOSED", reason);
}

function asDate(v: unknown): Date {
	return v instanceof Date ? v : new Date(v as string);
}

function centsOf(v: string): bigint {
	return parseAggregateMoneyString(v).cents;
}

function pick(obj: unknown, key: string): unknown {
	return obj && typeof obj === "object"
		? (obj as Record<string, unknown>)[key]
		: undefined;
}

/**
 * Required resolver-evidence extractor -- fails the report closed rather than
 * converting a missing / malformed field into a plausible financial zero.
 */
function reqMoney(v: unknown, path: string): string {
	if (typeof v !== "string") {
		reportFailClosed(
			`required resolver evidence "${path}" is missing or not a string`,
		);
	}
	try {
		parseAggregateMoneyString(v);
	} catch {
		reportFailClosed(
			`required resolver evidence "${path}" is not a canonical money string`,
		);
	}
	return v;
}

const PURCHASE_CATEGORIES: PurchaseBudgetCategory[] = [
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
	"UNCLASSIFIED",
];

function normalizeCategory(v: string | null): PurchaseBudgetCategory {
	return v && (PURCHASE_CATEGORIES as string[]).includes(v)
		? (v as PurchaseBudgetCategory)
		: "UNCLASSIFIED";
}

/**
 * Person identity (displayName + relationship) effective AT `at`: the highest
 * person_revisions row whose occurredAt <= at. If none exists, fail closed --
 * a later revision must never be used to classify a historical checkpoint.
 */
async function personAt(
	db: Database,
	userId: string,
	personId: string,
	at: Date,
): Promise<{ displayName: string; relationship: PersonRelationship }> {
	const revs = await db
		.select({
			displayName: personRevisions.displayName,
			relationship: personRevisions.relationship,
			occurredAt: personRevisions.occurredAt,
			revisionNo: personRevisions.revisionNo,
		})
		.from(personRevisions)
		.where(
			and(
				eq(personRevisions.personId, personId),
				eq(personRevisions.userId, userId),
			),
		);
	const chosen = effectiveRevisionAsOf(revs, at);
	if (!chosen) {
		reportFailClosed(
			`person ${personId} has no revision effective at or before ${at.toISOString()}; a later revision must not be used to classify it`,
		);
	}
	return {
		displayName: chosen.displayName,
		relationship: chosen.relationship as PersonRelationship,
	};
}

interface CardMeta {
	cardId: string;
	code: string;
	displayName: string;
	issuer: string;
}

/**
 * Card displayName / issuer as of `at` -- a rename / config edit performed
 * after the checkpoint must not rewrite the historical report label. Card code
 * comes from the immutable anchor.
 */
async function cardMetaAsOf(
	db: Database,
	userId: string,
	cardId: string,
	at: Date,
): Promise<CardMeta> {
	const [card] = await db
		.select({ id: creditCards.id, code: creditCards.code })
		.from(creditCards)
		.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
		.limit(1);
	if (!card) {
		reportFailClosed(`credit card ${cardId} not found for this user`);
	}
	const revs = await db
		.select({
			displayName: creditCardRevisions.displayName,
			issuer: creditCardRevisions.issuer,
			occurredAt: creditCardRevisions.occurredAt,
			revisionNo: creditCardRevisions.revisionNo,
		})
		.from(creditCardRevisions)
		.where(eq(creditCardRevisions.creditCardId, cardId));
	const chosen = effectiveRevisionAsOf(revs, at);
	if (!chosen) {
		reportFailClosed(
			`credit card ${cardId} has no configuration revision effective at or before ${at.toISOString()}`,
		);
	}
	return {
		cardId,
		code: card.code,
		displayName: chosen.displayName,
		issuer: chosen.issuer,
	};
}

function makeCardMetaAsOf(
	db: Database,
	userId: string,
	at: Date,
): (cardId: string) => Promise<CardMeta> {
	const cache = new Map<string, CardMeta>();
	return async (cardId: string) => {
		const hit = cache.get(cardId);
		if (hit) return hit;
		const v = await cardMetaAsOf(db, userId, cardId, at);
		cache.set(cardId, v);
		return v;
	};
}

// ============================================================================
// Sealed split truth (strict), effective AS OF a point in time
// ============================================================================

interface PurchaseSharesAvailable {
	available: true;
	personalCents: bigint;
	externalCents: bigint;
	participants: Array<{
		personId: string;
		shareCents: bigint;
		displayName: string;
		relationship: PersonRelationship;
	}>;
	basis: "SEALED_SPLIT_AS_OF" | "NO_SPLIT" | "VOID_SPLIT";
}
type PurchaseSharesResult =
	| PurchaseSharesAvailable
	| { available: false; reason: string };

async function purchaseSharesAsOf(
	db: Database,
	userId: string,
	purchaseEventId: string,
	grossCents: bigint,
	at: Date,
): Promise<PurchaseSharesResult> {
	const res = await resolveAuthoritativePurchaseSplitAsOf({
		db,
		userId,
		purchaseEventId,
		asOf: at,
		expectedPurchaseCents: grossCents,
	});
	if (res.kind === "NO_SPLIT") {
		return {
			available: true,
			personalCents: grossCents,
			externalCents: 0n,
			participants: [],
			basis: "NO_SPLIT",
		};
	}
	if (res.kind === "VOID_SPLIT") {
		return {
			available: true,
			personalCents: grossCents,
			externalCents: 0n,
			participants: [],
			basis: "VOID_SPLIT",
		};
	}
	if (res.kind === "UNRESOLVED") {
		return { available: false, reason: res.reason };
	}
	const participants: PurchaseSharesAvailable["participants"] = [];
	for (const p of res.participants) {
		const who = await personAt(db, userId, p.personId, at);
		participants.push({
			personId: p.personId,
			shareCents: p.shareCents,
			displayName: who.displayName,
			relationship: who.relationship,
		});
	}
	return {
		available: true,
		personalCents: res.userShareCents,
		externalCents: res.externalShareCents,
		participants,
		basis: "SEALED_SPLIT_AS_OF",
	};
}

// ============================================================================
// Section 2/3 -- authoritative trigger + ownership decomposition
// ============================================================================

interface TriggerContext {
	section: TriggerPaymentSection;
	checkpointAt: Date;
	paymentEventId: string;
	payRevisionId: string;
	statementId: string;
}

function decomposeOwnership(
	recon: Awaited<ReturnType<typeof getStatementReconciliationAsOf>>,
	whoByPerson: Map<
		string,
		{ displayName: string; relationship: PersonRelationship }
	>,
): OwnershipDecomposition {
	const grossCents = centsOf(recon.reconciledStatementAmount ?? "0.00");
	const personalCents = recon.personalCents;
	let externalTotal = 0n;
	let family = 0n;
	let friend = 0n;
	let other = 0n;
	const externalByPerson: OwnershipByPerson[] = [];
	for (const [personId, cents] of recon.externalByPerson) {
		externalTotal += cents;
		const who = whoByPerson.get(personId);
		if (!who) {
			reportFailClosed(
				`reconciliation references person ${personId} with no resolvable relationship at the checkpoint`,
			);
		}
		if (who.relationship === "FAMILY") family += cents;
		else if (who.relationship === "FRIEND") friend += cents;
		else other += cents;
		externalByPerson.push({
			personId,
			displayName: who.displayName,
			relationship: who.relationship,
			amount: formatCentsToMoney(cents),
		});
	}
	if (personalCents + externalTotal !== grossCents) {
		reportFailClosed(
			`sealed reconciliation does not partition exactly: personal ${personalCents} + external ${externalTotal} != reconciled ${grossCents}`,
		);
	}
	if (family + friend + other !== externalTotal) {
		reportFailClosed(
			`external share does not partition by relationship exactly (family ${family} + friend ${friend} + other ${other} != ${externalTotal})`,
		);
	}
	return {
		available: true,
		grossStatementAmount: formatCentsToMoney(grossCents),
		personalEconomicShare: formatCentsToMoney(personalCents),
		externalShareTotal: formatCentsToMoney(externalTotal),
		externalByPerson,
		familyExternalShare: formatCentsToMoney(family),
		friendExternalShare: formatCentsToMoney(friend),
		otherExternalShare: formatCentsToMoney(other),
	};
}

async function resolveTrigger(
	db: Database,
	userId: string,
	triggerPaymentEventId: string,
	periodMonth: string,
): Promise<TriggerContext> {
	// 1. payment event belongs to the user.
	const [payEvent] = await db
		.select({
			id: creditCardStatementPaymentEvents.id,
			amount: creditCardStatementPaymentEvents.amount,
			occurredAt: creditCardStatementPaymentEvents.occurredAt,
			paymentAssetAccountId:
				creditCardStatementPaymentEvents.paymentAssetAccountId,
			statementId: creditCardStatementPaymentEvents.statementId,
		})
		.from(creditCardStatementPaymentEvents)
		.where(
			and(
				eq(creditCardStatementPaymentEvents.id, triggerPaymentEventId),
				eq(creditCardStatementPaymentEvents.userId, userId),
			),
		)
		.limit(1);
	if (!payEvent) {
		triggerInvalid(
			`payment event ${triggerPaymentEventId} does not exist for this user`,
		);
	}

	// 2. referenced statement belongs to the user.
	const [stmt] = await db
		.select({
			id: creditCardStatements.id,
			creditCardId: creditCardStatements.creditCardId,
			cycleYear: creditCardStatements.cycleYear,
			cycleMonth: creditCardStatements.cycleMonth,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, payEvent.statementId),
				eq(creditCardStatements.userId, userId),
			),
		)
		.limit(1);
	if (!stmt) {
		triggerInvalid(
			`payment event ${triggerPaymentEventId} references statement ${payEvent.statementId} which does not exist for this user`,
		);
	}

	// 3. exactly one PAY statement revision references this payment event.
	const payRevs = await db
		.select({
			id: creditCardStatementRevisions.id,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			statementId: creditCardStatementRevisions.statementId,
		})
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.statementId, stmt.id),
				eq(creditCardStatementRevisions.operation, "PAY"),
				eq(creditCardStatementRevisions.paymentEventId, triggerPaymentEventId),
			),
		);
	if (payRevs.length === 0) {
		triggerInvalid(
			`no PAY statement revision references payment event ${triggerPaymentEventId}`,
		);
	}
	if (payRevs.length > 1) {
		triggerInvalid(
			`payment event ${triggerPaymentEventId} is referenced by ${payRevs.length} PAY revisions; the trigger identity is ambiguous`,
		);
	}
	const payRev = payRevs[0] as (typeof payRevs)[number];

	// 4. PAY revision status is PAID. 5. statement identity agrees.
	if (payRev.status !== "PAID") {
		triggerInvalid(
			`the PAY revision for payment event ${triggerPaymentEventId} has status ${payRev.status}, not PAID`,
		);
	}
	if (payRev.statementId !== payEvent.statementId) {
		triggerInvalid(
			`PAY revision ${payRev.id} statement ${payRev.statementId} does not match payment event statement ${payEvent.statementId}`,
		);
	}

	// 6. payment amount == PAY revision statement amount.
	const payEventCents = centsOf(payEvent.amount);
	const payRevCents = centsOf(payRev.statementAmount);
	if (payEventCents !== payRevCents) {
		triggerInvalid(
			`payment amount ${payEventCents} does not equal the PAY revision statement amount ${payRevCents} kurus`,
		);
	}

	// 7. checkpointAt = paymentEvent.occurredAt. 8. it belongs to the period.
	const checkpointAt = asDate(payEvent.occurredAt);
	const w = buildResolverWindow(periodMonth, checkpointAt, undefined);
	if (checkpointAt < w.periodStart || checkpointAt >= w.periodEnd) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`trigger payment at ${checkpointAt.toISOString()} is outside the requested period ${periodMonth}`,
		);
	}

	// 9. reconciliation is authoritative for the PAY revision statement amount --
	// read AS OF the checkpoint, so a SUPERSEDE / VOID authored after this payment
	// event cannot rewrite the historical trigger ownership. If the statement was
	// later REOPENED / repaid at a different amount, the as-of reconciliation is
	// no longer RECONCILED / matching and we fail closed rather than switching.
	const recon = await getStatementReconciliationAsOf({
		db,
		userId,
		statementId: stmt.id,
		asOf: checkpointAt,
	});
	if (recon.status !== "RECONCILED") {
		triggerInvalid(
			`statement ${stmt.id} reconciliation is ${recon.status}${
				recon.staleReason ? ` (${recon.staleReason})` : ""
			}; this checkpoint can no longer be safely reported`,
		);
	}
	if (centsOf(recon.reconciledStatementAmount ?? "0.00") !== payRevCents) {
		triggerInvalid(
			`statement ${stmt.id} reconciliation amount ${recon.reconciledStatementAmount} does not match the PAY revision amount ${payRevCents} kurus; the statement was likely reopened / repaid`,
		);
	}
	if (recon.revisionNo == null) {
		triggerInvalid(
			`statement ${stmt.id} reconciliation has no revision number`,
		);
	}

	const meta = await cardMetaAsOf(db, userId, stmt.creditCardId, checkpointAt);

	const whoByPerson = new Map<
		string,
		{ displayName: string; relationship: PersonRelationship }
	>();
	for (const personId of recon.externalByPerson.keys()) {
		whoByPerson.set(
			personId,
			await personAt(db, userId, personId, checkpointAt),
		);
	}

	return {
		checkpointAt,
		paymentEventId: payEvent.id,
		payRevisionId: payRev.id,
		statementId: stmt.id,
		section: {
			paymentEventId: payEvent.id,
			payRevisionId: payRev.id,
			statementId: stmt.id,
			cardId: stmt.creditCardId,
			cardCode: meta.code,
			displayName: meta.displayName,
			issuer: meta.issuer,
			statementCycle: { year: stmt.cycleYear, month: stmt.cycleMonth },
			statementAmount: formatCentsToMoney(payRevCents),
			paymentAmount: formatCentsToMoney(payEventCents),
			checkpointAt: checkpointAt.toISOString(),
			paidAt: checkpointAt.toISOString(),
			reservePlacement: payRev.reservePlacement,
			paymentAssetAccountId: payEvent.paymentAssetAccountId,
			reconciliationRevisionNo: recon.revisionNo,
			ownership: decomposeOwnership(recon, whoByPerson),
		},
	};
}

// ============================================================================
// Section 6 -- interval income activity
// ============================================================================

async function buildIntervalIncome(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
): Promise<IntervalIncomeSection> {
	const receipts = await db
		.select({ receiptId: incomeReceipts.id, nature: incomeSources.nature })
		.from(incomeReceipts)
		.innerJoin(incomeSources, eq(incomeSources.id, incomeReceipts.sourceId))
		.where(eq(incomeReceipts.userId, userId));

	const activity: IntervalIncomeActivityItem[] = [];
	let regular = 0n;
	let extra = 0n;
	let gift = 0n;
	let deficit = 0n;

	for (const r of receipts) {
		const nature = r.nature as IncomeSourceNature;
		const revs = await db
			.select({
				operation: incomeReceiptRevisions.operation,
				revisionNo: incomeReceiptRevisions.revisionNo,
				occurredAt: incomeReceiptRevisions.occurredAt,
				amount: incomeReceiptRevisions.amount,
			})
			.from(incomeReceiptRevisions)
			.where(eq(incomeReceiptRevisions.incomeReceiptId, r.receiptId));
		if (revs.length === 0) continue;

		// SUPPORT role effective AT the checkpoint (never a later reclassification).
		let supportRole: SupportRole | null = null;
		if (nature === "SUPPORT") {
			const roleRevs = await db
				.select({
					role: incomeReceiptBudgetV2SemanticRevisions.supportRole,
					revisionNo: incomeReceiptBudgetV2SemanticRevisions.revisionNo,
					occurredAt: incomeReceiptBudgetV2SemanticRevisions.occurredAt,
				})
				.from(incomeReceiptBudgetV2SemanticRevisions)
				.where(
					eq(
						incomeReceiptBudgetV2SemanticRevisions.incomeReceiptId,
						r.receiptId,
					),
				);
			supportRole =
				(effectiveRevisionAsOf(roleRevs, checkpointAt)?.role as
					| SupportRole
					| undefined) ?? null;
		}

		// The activity list is revision-activity based within the interval.
		for (const rev of [...revs].sort((a, b) => a.revisionNo - b.revisionNo)) {
			const at = asDate(rev.occurredAt);
			if (!win.inInterval(at)) continue;
			activity.push({
				receiptId: r.receiptId,
				revisionNo: rev.revisionNo,
				operation: rev.operation as "CREATE" | "UPDATE" | "VOID",
				amount: parseAggregateMoneyString(rev.amount).normalized,
				occurredAt: at.toISOString(),
				sourceNature: nature,
				supportRole,
			});
		}

		// The SUMMARY uses the receipt STATE effective at the checkpoint -- a
		// later UPDATE/VOID must not replace or erase the older summary figure.
		const eff = effectiveRevisionAsOf(revs, checkpointAt);
		if (!eff || eff.operation === "VOID") continue;
		const effAt = asDate(eff.occurredAt);
		if (!win.inInterval(effAt)) continue;
		const cents = centsOf(eff.amount);
		if (nature === "REGULAR") regular += cents;
		else if (nature === "EXTRA") extra += cents;
		else if (supportRole === "PLANNED_FAMILY_GIFT") gift += cents;
		else if (supportRole === "DEFICIT_FAMILY_SUPPORT") deficit += cents;
		else {
			reportFailClosed(
				`SUPPORT income receipt ${r.receiptId} active in the checkpoint interval has no Budget V2 support-role classification effective by ${checkpointAt.toISOString()}`,
			);
		}
	}

	return {
		activity,
		regularReceipts: formatCentsToMoney(regular),
		extraReceipts: formatCentsToMoney(extra),
		plannedFamilyGiftReceipts: formatCentsToMoney(gift),
		deficitFamilySupportReceipts: formatCentsToMoney(deficit),
		note: "PLANNED_FAMILY_GIFT is real support but not baseline income; DEFICIT_FAMILY_SUPPORT is a post-deficit funding source, not realizedIncome; People receivable repayments are never income. Support role is resolved as of the checkpoint instant.",
	};
}

// ============================================================================
// Section 7 -- interval credit-card purchase activity
// ============================================================================

interface PurchaseEventRow {
	eventId: string;
	creditCardId: string;
}

async function loadPurchaseEvents(
	db: Database,
	userId: string,
): Promise<PurchaseEventRow[]> {
	const rows = await db
		.select({
			eventId: creditCardLiabilityEvents.id,
			creditCardId: creditCardLiabilityEvents.creditCardId,
		})
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.userId, userId),
				eq(creditCardLiabilityEvents.eventType, "PURCHASE"),
			),
		);
	return rows;
}

/**
 * Approved food-semantic status for one interval activity row, resolved AS OF
 * that row's own `occurredAt`. `getSpendingFoodClassificationAsOf` already
 * applies the Checkpoint 4B.2 effective-revision rule, so a food revision
 * authored after `atInstant` never rewrites this row. A CLASSIFIED view whose
 * required money / identity fields are missing or malformed fails the report
 * closed (never a plausible zero).
 */
async function evaluateIntervalFoodClassification(
	db: Database,
	userId: string,
	subject:
		| { type: "CREDIT_CARD_PURCHASE"; purchaseEventId: string }
		| { type: "PEOPLE_PAYABLE"; personObligationId: string },
	applicable: boolean,
	atInstant: Date,
): Promise<IntervalFoodClassification> {
	if (!applicable) return { applicable: false };
	const view = await getSpendingFoodClassificationAsOf({
		db,
		userId,
		subject,
		asOf: atInstant,
	});
	if (view.status !== "CLASSIFIED") {
		return {
			applicable: true,
			available: true,
			status: view.status,
			semanticRevisionId: view.semanticRevisionId,
			semanticRevisionNo: view.semanticRevisionNo,
			reason: view.reason,
		};
	}
	const path = `interval.foodClassification[${view.subjectId}]`;
	const home = reqMoney(
		view.foodHomeMarketAmount,
		`${path}.foodHomeMarketAmount`,
	);
	const outside = reqMoney(view.foodOutsideAmount, `${path}.foodOutsideAmount`);
	const total = reqMoney(view.foodTotalAmount, `${path}.foodTotalAmount`);
	const nonFood = reqMoney(view.nonFoodAmount, `${path}.nonFoodAmount`);
	const basis = reqMoney(
		view.basisPersonalAmount,
		`${path}.basisPersonalAmount`,
	);
	if (!view.semanticRevisionId || view.semanticRevisionNo == null) {
		reportFailClosed(
			`${path} is CLASSIFIED but carries no semantic revision identity`,
		);
	}
	if (!view.classificationKind || !view.sourceKind) {
		reportFailClosed(
			`${path} is CLASSIFIED but carries no classificationKind / sourceKind`,
		);
	}
	const hc = centsOf(home);
	const oc = centsOf(outside);
	if (centsOf(total) !== hc + oc) {
		reportFailClosed(
			`${path}: FOOD_TOTAL ${total} != FOOD_HOME_MARKET ${home} + FOOD_OUTSIDE ${outside}`,
		);
	}
	if (centsOf(basis) !== hc + oc + centsOf(nonFood)) {
		reportFailClosed(
			`${path}: basis ${basis} != food ${total} + nonFood ${nonFood}`,
		);
	}
	return {
		applicable: true,
		available: true,
		status: "CLASSIFIED",
		semanticRevisionId: view.semanticRevisionId,
		semanticRevisionNo: view.semanticRevisionNo,
		basisPersonalAmount: basis,
		foodHomeMarketAmount: home,
		foodOutsideAmount: outside,
		foodTotalAmount: total,
		nonFoodAmount: nonFood,
		classificationKind: view.classificationKind,
		sourceKind: view.sourceKind,
	};
}

async function buildIntervalPurchases(
	db: Database,
	userId: string,
	win: ResolverWindow,
	events: PurchaseEventRow[],
	cardMetaOf: (cardId: string) => Promise<CardMeta>,
): Promise<IntervalPurchaseSection> {
	const activity: IntervalPurchaseActivityItem[] = [];
	const newlyPosted: string[] = [];
	const corrected: string[] = [];
	const voided: string[] = [];

	for (const ev of events) {
		const revs = await db
			.select({
				revisionNo: creditCardLiabilityEventRevisions.revisionNo,
				operation: creditCardLiabilityEventRevisions.operation,
				amount: creditCardLiabilityEventRevisions.amount,
				budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
				merchant: creditCardLiabilityEventRevisions.merchant,
				description: creditCardLiabilityEventRevisions.description,
				installmentCount: creditCardLiabilityEventRevisions.installmentCount,
				occurredAt: creditCardLiabilityEventRevisions.occurredAt,
			})
			.from(creditCardLiabilityEventRevisions)
			.where(eq(creditCardLiabilityEventRevisions.eventId, ev.eventId))
			.orderBy(asc(creditCardLiabilityEventRevisions.revisionNo));

		for (const rev of revs) {
			const at = asDate(rev.occurredAt);
			if (!win.inInterval(at)) continue;
			const grossCents = centsOf(rev.amount);
			// Ownership effective at THIS activity instant -- never current / future.
			const shares = await purchaseSharesAsOf(
				db,
				userId,
				ev.eventId,
				grossCents,
				at,
			);
			const meta = await cardMetaOf(ev.creditCardId);
			const op = rev.operation as "CREATE" | "UPDATE" | "VOID";
			const ownership: PurchaseOwnership = shares.available
				? {
						available: true,
						personalShare: formatCentsToMoney(shares.personalCents),
						externalShare: formatCentsToMoney(shares.externalCents),
						externalParticipants: shares.participants.map((p) => ({
							personId: p.personId,
							displayName: p.displayName,
							relationship: p.relationship,
							shareAmount: formatCentsToMoney(p.shareCents),
						})),
						basis: shares.basis,
					}
				: { available: false, reason: shares.reason };
			const foodClassification = await evaluateIntervalFoodClassification(
				db,
				userId,
				{ type: "CREDIT_CARD_PURCHASE", purchaseEventId: ev.eventId },
				true,
				at,
			);
			activity.push({
				eventId: ev.eventId,
				revisionNo: rev.revisionNo,
				operation: op,
				cardId: ev.creditCardId,
				cardCode: meta.code,
				displayName: meta.displayName,
				grossAmount: formatCentsToMoney(grossCents),
				budgetCategory: normalizeCategory(rev.budgetCategory),
				merchant: rev.merchant,
				description: rev.description,
				installmentCount: rev.installmentCount,
				occurredAt: at.toISOString(),
				ownership,
				foodClassification,
			});
			if (op === "CREATE") newlyPosted.push(ev.eventId);
			else if (op === "UPDATE") corrected.push(ev.eventId);
			else voided.push(ev.eventId);
		}
	}

	return {
		activity,
		newlyPostedPurchases: newlyPosted,
		correctedPurchases: corrected,
		voidedPurchases: voided,
		note: "revision-level activity only; an UPDATE is a correction, never a second expense. Ownership is resolved as of each activity instant and reported unavailable when it cannot be proved. No heuristic interval net-spend delta is produced -- current MTD totals are authoritative (see mtd.spending).",
	};
}

// ============================================================================
// Section 8 -- current MTD personal spending (must remain exact)
// ============================================================================

async function buildMtdSpending(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
	events: PurchaseEventRow[],
): Promise<{
	spending: MtdSpendingSection;
	installmentPurchases: InstallmentAnalyticsSection["purchases"];
}> {
	const byCategory: Record<PurchaseBudgetCategory, bigint> = {
		MANDATORY_EXPENSE: 0n,
		DISCRETIONARY_SPEND: 0n,
		SHORT_TERM_PURCHASE: 0n,
		UNCLASSIFIED: 0n,
	};
	const byRelationship: Record<PersonRelationship, bigint> = {
		FAMILY: 0n,
		FRIEND: 0n,
		OTHER: 0n,
	};
	let gross = 0n;
	let personal = 0n;
	let external = 0n;
	const installmentPurchases: InstallmentAnalyticsSection["purchases"] = [];

	for (const ev of events) {
		const revs = await db
			.select({
				revisionNo: creditCardLiabilityEventRevisions.revisionNo,
				operation: creditCardLiabilityEventRevisions.operation,
				amount: creditCardLiabilityEventRevisions.amount,
				budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
				installmentCount: creditCardLiabilityEventRevisions.installmentCount,
				occurredAt: creditCardLiabilityEventRevisions.occurredAt,
			})
			.from(creditCardLiabilityEventRevisions)
			.where(eq(creditCardLiabilityEventRevisions.eventId, ev.eventId));
		// The purchase revision STATE effective at the checkpoint -- a later
		// UPDATE/VOID (or a CREATE after the checkpoint) must NOT erase or mutate
		// this MTD purchase. Never "latest, then test its occurredAt".
		const eff = effectiveRevisionAsOf(revs, checkpointAt);
		if (!eff) continue; // purchase did not exist yet at the checkpoint
		if (eff.operation === "VOID") continue;
		const at = asDate(eff.occurredAt);
		if (!win.inMtd(at)) continue;
		const grossCents = centsOf(eff.amount);
		const shares = await purchaseSharesAsOf(
			db,
			userId,
			ev.eventId,
			grossCents,
			checkpointAt,
		);
		if (!shares.available) {
			reportFailClosed(
				`MTD purchase ${ev.eventId}: ownership cannot be authoritatively resolved as of the checkpoint (${shares.reason})`,
			);
		}
		const cat = normalizeCategory(eff.budgetCategory);
		byCategory[cat] += shares.personalCents;
		gross += grossCents;
		personal += shares.personalCents;
		external += shares.externalCents;
		for (const p of shares.participants) {
			byRelationship[p.relationship] += p.shareCents;
		}
		if (eff.installmentCount != null) {
			installmentPurchases.push({
				eventId: ev.eventId,
				grossAmount: formatCentsToMoney(grossCents),
				personalShare: formatCentsToMoney(shares.personalCents),
				installmentCount: eff.installmentCount,
			});
		}
	}

	return {
		spending: {
			byCategoryPersonalShare: {
				MANDATORY_EXPENSE: formatCentsToMoney(byCategory.MANDATORY_EXPENSE),
				DISCRETIONARY_SPEND: formatCentsToMoney(byCategory.DISCRETIONARY_SPEND),
				SHORT_TERM_PURCHASE: formatCentsToMoney(byCategory.SHORT_TERM_PURCHASE),
				UNCLASSIFIED: formatCentsToMoney(byCategory.UNCLASSIFIED),
			},
			grossCardPurchasesMTD: formatCentsToMoney(gross),
			personalCardSpendMTD: formatCentsToMoney(personal),
			externalCardSpendMTD: formatCentsToMoney(external),
			externalCardSpendByRelationship: {
				FAMILY: formatCentsToMoney(byRelationship.FAMILY),
				FRIEND: formatCentsToMoney(byRelationship.FRIEND),
				OTHER: formatCentsToMoney(byRelationship.OTHER),
			},
		},
		installmentPurchases,
	};
}

// ============================================================================
// Sections 9 / 10 -- People / family activity + FAMILY_REIMBURSEMENT
// ============================================================================

async function buildPeopleFamily(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
): Promise<PeopleFamilySection> {
	const obligations = await db
		.select({
			id: personObligations.id,
			personId: personObligations.personId,
			direction: personObligations.direction,
		})
		.from(personObligations)
		.where(eq(personObligations.userId, userId));

	const participants = await db
		.select({
			splitId: creditCardPurchaseSplitParticipants.splitId,
			personId: creditCardPurchaseSplitParticipants.personId,
			personObligationId:
				creditCardPurchaseSplitParticipants.personObligationId,
		})
		.from(creditCardPurchaseSplitParticipants)
		.where(eq(creditCardPurchaseSplitParticipants.userId, userId));

	const obligationActivity: PeopleObligationActivityItem[] = [];
	const settlementActivity: PeopleSettlementActivityItem[] = [];
	const familyReimbursements: FamilyReimbursementItem[] = [];
	const standaloneReceivableSettlements: StandaloneReceivableSettlementItem[] =
		[];

	const whoCache = new Map<
		string,
		{ displayName: string; relationship: PersonRelationship }
	>();
	const who = async (personId: string) => {
		const cached = whoCache.get(personId);
		if (cached) return cached;
		const v = await personAt(db, userId, personId, checkpointAt);
		whoCache.set(personId, v);
		return v;
	};

	for (const o of obligations) {
		const direction = o.direction as "RECEIVABLE" | "PAYABLE";
		const info = await who(o.personId);

		const oRevs = await db
			.select({
				revisionNo: personObligationRevisions.revisionNo,
				operation: personObligationRevisions.operation,
				principal: personObligationRevisions.principalAmount,
				budgetCategory: personObligationRevisions.budgetCategory,
				dueDate: personObligationRevisions.dueDate,
				occurredAt: personObligationRevisions.occurredAt,
			})
			.from(personObligationRevisions)
			.where(eq(personObligationRevisions.obligationId, o.id))
			.orderBy(asc(personObligationRevisions.revisionNo));
		for (const rev of oRevs) {
			const at = asDate(rev.occurredAt);
			if (!win.inInterval(at)) continue;
			// PAYABLE is a food-expense subject; RECEIVABLE never is. Settlements
			// (handled below) are never food-expense subjects.
			const foodClassification = await evaluateIntervalFoodClassification(
				db,
				userId,
				{ type: "PEOPLE_PAYABLE", personObligationId: o.id },
				direction === "PAYABLE",
				at,
			);
			obligationActivity.push({
				obligationId: o.id,
				personId: o.personId,
				displayName: info.displayName,
				relationship: info.relationship,
				direction,
				kind: "OBLIGATION",
				revisionNo: rev.revisionNo,
				operation: rev.operation as "CREATE" | "UPDATE" | "VOID",
				principal: parseAggregateMoneyString(rev.principal).normalized,
				budgetCategory: rev.budgetCategory,
				dueDate: rev.dueDate,
				occurredAt: at.toISOString(),
				foodClassification,
			});
		}

		const settlements = await db
			.select({ id: personSettlements.id })
			.from(personSettlements)
			.where(eq(personSettlements.obligationId, o.id));
		for (const s of settlements) {
			const sRevs = await db
				.select({
					revisionNo: personSettlementRevisions.revisionNo,
					operation: personSettlementRevisions.operation,
					applied: personSettlementRevisions.appliedAmount,
					occurredAt: personSettlementRevisions.occurredAt,
				})
				.from(personSettlementRevisions)
				.where(eq(personSettlementRevisions.settlementId, s.id));
			for (const rev of [...sRevs].sort(
				(a, b) => a.revisionNo - b.revisionNo,
			)) {
				const at = asDate(rev.occurredAt);
				if (!win.inInterval(at)) continue;
				settlementActivity.push({
					obligationId: o.id,
					personId: o.personId,
					displayName: info.displayName,
					relationship: info.relationship,
					direction,
					kind: "SETTLEMENT",
					revisionNo: rev.revisionNo,
					operation: rev.operation as "CREATE" | "VOID",
					settlementAmount: parseAggregateMoneyString(rev.applied).normalized,
					occurredAt: at.toISOString(),
				});
			}

			// Section 10 -- FAMILY_REIMBURSEMENT requires the FULL authoritative
			// chain: cc PURCHASE -> split anchor -> split revision effective at the
			// checkpoint that is ACTIVE + SEALED -> exact revision item references
			// the participant -> participant anchor personObligationId == this
			// obligation -> direction RECEIVABLE -> relationship at checkpoint FAMILY
			// -> settlement STATE effective at the checkpoint is CREATE, in the
			// interval. A VOID authored after the checkpoint does not erase it.
			const latest = effectiveRevisionAsOf(sRevs, checkpointAt);
			if (latest?.operation !== "CREATE") continue;
			const at = asDate(latest.occurredAt);
			if (!win.inInterval(at)) continue;
			if (direction !== "RECEIVABLE") continue;

			const link = participants.find((p) => p.personObligationId === o.id);
			if (!link) {
				standaloneReceivableSettlements.push({
					personId: o.personId,
					displayName: info.displayName,
					relationship: info.relationship,
					obligationId: o.id,
					settlementAmount: parseAggregateMoneyString(latest.applied)
						.normalized,
					occurredAt: at.toISOString(),
				});
				continue;
			}

			const [split] = await db
				.select({
					purchaseEventId: creditCardPurchaseSplits.purchaseEventId,
				})
				.from(creditCardPurchaseSplits)
				.where(eq(creditCardPurchaseSplits.id, link.splitId))
				.limit(1);
			if (!split) {
				reportFailClosed(
					`split participant for obligation ${o.id} references a missing split anchor ${link.splitId}`,
				);
			}
			const sres = await resolveAuthoritativePurchaseSplitAsOf({
				db,
				userId,
				purchaseEventId: split.purchaseEventId,
				asOf: checkpointAt,
			});
			if (sres.kind === "ACTIVE") {
				const inRevision = sres.participants.some(
					(pp) =>
						pp.personId === link.personId && pp.personObligationId === o.id,
				);
				if (inRevision && info.relationship === "FAMILY") {
					familyReimbursements.push({
						personId: o.personId,
						displayName: info.displayName,
						obligationId: o.id,
						purchaseEventId: split.purchaseEventId,
						splitRevisionId: sres.splitRevisionId,
						settlementAmount: parseAggregateMoneyString(latest.applied)
							.normalized,
						occurredAt: at.toISOString(),
					});
				}
				// else: not FAMILY, or the participant is absent from the exact
				// active revision -> ordinary settlement activity only.
			} else if (sres.kind === "UNRESOLVED" && sres.inconsistent) {
				reportFailClosed(
					`FAMILY_REIMBURSEMENT chain for obligation ${o.id} is internally inconsistent: ${sres.reason}`,
				);
			}
			// VOID_SPLIT / not-yet / unsealed -> not a reimbursement; the
			// settlement is still present in settlementActivity above.
		}
	}

	return {
		obligationActivity,
		settlementActivity,
		familyReimbursements,
		standaloneReceivableSettlements,
		note: "FAMILY_REIMBURSEMENT requires an ACTIVE, SEALED split revision (effective at the checkpoint) whose exact item references the participant, whose participant anchor obligation is this RECEIVABLE, and a FAMILY relationship at the checkpoint. A VOID / unsealed / participant-missing chain is never labelled a reimbursement; a standalone family RECEIVABLE repayment is reported separately.",
	};
}

// ============================================================================
// Section 11 -- statement payments during the interval
// ============================================================================

async function buildStatementPayments(
	db: Database,
	userId: string,
	win: ResolverWindow,
	triggerPaymentEventId: string,
	cardMetaOf: (cardId: string) => Promise<CardMeta>,
): Promise<StatementPaymentItem[]> {
	const events = await db
		.select({
			id: creditCardStatementPaymentEvents.id,
			statementId: creditCardStatementPaymentEvents.statementId,
			amount: creditCardStatementPaymentEvents.amount,
			occurredAt: creditCardStatementPaymentEvents.occurredAt,
			paymentAssetAccountId:
				creditCardStatementPaymentEvents.paymentAssetAccountId,
		})
		.from(creditCardStatementPaymentEvents)
		.where(eq(creditCardStatementPaymentEvents.userId, userId));

	const out: StatementPaymentItem[] = [];
	for (const e of events) {
		const at = asDate(e.occurredAt);
		if (!win.inInterval(at)) continue;
		const [stmt] = await db
			.select({ creditCardId: creditCardStatements.creditCardId })
			.from(creditCardStatements)
			.where(eq(creditCardStatements.id, e.statementId))
			.limit(1);
		if (!stmt) {
			reportFailClosed(
				`payment event ${e.id} references a missing statement ${e.statementId}`,
			);
		}
		const meta = await cardMetaOf(stmt.creditCardId);
		// Section 9 -- ownership for EACH interval payment is based on the
		// reconciliation truth effective at THAT payment event's own instant,
		// never the report checkpoint's current/latest reconciliation.
		const recon = await getStatementReconciliationAsOf({
			db,
			userId,
			statementId: e.statementId,
			asOf: at,
		});
		let ownership: OwnershipDecomposition | OwnershipUnavailable;
		if (recon.status === "RECONCILED") {
			const whoByPerson = new Map<
				string,
				{ displayName: string; relationship: PersonRelationship }
			>();
			for (const personId of recon.externalByPerson.keys()) {
				whoByPerson.set(personId, await personAt(db, userId, personId, at));
			}
			ownership = decomposeOwnership(recon, whoByPerson);
		} else {
			ownership = {
				available: false,
				reason: "RECONCILIATION_UNAVAILABLE",
				reconciliationStatus: recon.status,
			};
		}
		out.push({
			paymentEventId: e.id,
			statementId: e.statementId,
			cardId: stmt.creditCardId,
			cardCode: meta.code,
			displayName: meta.displayName,
			amount: parseAggregateMoneyString(e.amount).normalized,
			occurredAt: at.toISOString(),
			paymentAssetAccountId: e.paymentAssetAccountId,
			isTrigger: e.id === triggerPaymentEventId,
			ownership,
		});
	}
	return out;
}

// ============================================================================
// Section 12 -- current MTD Budget V2 state (verbatim from the live resolver)
// ============================================================================

/**
 * Pure assembly of the non-spending MTD sections from an authoritative live
 * resolution. Required money fields are typed-asserted (never coerced to
 * "0.00"); policy outputs come from the strongly-typed resolver contract.
 */
export function assembleMtdNonSpending(
	resolution: BudgetV2LiveResolution,
): Omit<MtdSection, "spending" | "surplusUseAttribution"> {
	const ev = resolution.evidenceSnapshot;
	const bl = pick(ev, "basicLiving");
	const emergency = pick(ev, "emergencyFund");
	const mobility = pick(ev, "mobility");
	const necessary = pick(ev, "necessaryPurchases");
	const out = resolution.policyResult.outputs;
	const mobilityGoals = pick(mobility, "goals");
	const perGoal = pick(necessary, "perGoal");
	const overdue = pick(necessary, "overdueGoalIds");
	return {
		budget: {
			inputs: resolution.inputs,
			policyOutput: {
				deficit: out.deficit.amount,
				emergencyCatchUp: out.emergencyCatchUp.amount,
				trueSurplus: out.trueSurplus.amount,
				mobilityAllocation: out.mobilityAllocation.amount,
				longTermInvestment: out.longTermInvestment.amount,
				discretionaryAllocation: out.discretionaryAllocation.amount,
			},
			basicLiving: {
				approvedTarget: reqMoney(
					pick(bl, "basicLivingTarget"),
					"basicLiving.basicLivingTarget",
				),
				actualPersonalMandatorySpendMTD: reqMoney(
					pick(bl, "actualPersonalMandatorySpendMTD"),
					"basicLiving.actualPersonalMandatorySpendMTD",
				),
				grossBasicLivingNeed: reqMoney(
					pick(bl, "grossBasicLivingNeed"),
					"basicLiving.grossBasicLivingNeed",
				),
				overlapWithCurrentObligations: reqMoney(
					pick(bl, "basicLivingOverlapWithCurrentObligations"),
					"basicLiving.basicLivingOverlapWithCurrentObligations",
				),
				basicLivingFunding: reqMoney(
					pick(bl, "basicLivingFunding"),
					"basicLiving.basicLivingFunding",
				),
			},
		},
		emergencyFund: {
			currentBalance: reqMoney(
				pick(emergency, "balance"),
				"emergencyFund.balance",
			),
			target: reqMoney(pick(emergency, "target"), "emergencyFund.target"),
			gap: reqMoney(pick(emergency, "gap"), "emergencyFund.gap"),
		},
		mobility: {
			currentTotal: resolution.inputs.mobilityBalance,
			perGoal: Array.isArray(mobilityGoals) ? mobilityGoals : [],
		},
		necessaryPurchases: {
			totalMonthlyContribution:
				resolution.inputs.dateBoundNecessaryPurchaseFunding,
			perGoal: Array.isArray(perGoal) ? perGoal : [],
			overdueGoalIds: Array.isArray(overdue) ? overdue : [],
		},
	};
}

// ============================================================================
// Section 12 -- authoritative MTD food semantics (checkpoint 4C)
// ============================================================================

interface FoodUniverseSubject {
	subjectType: "CREDIT_CARD_PURCHASE" | "PEOPLE_PAYABLE";
	subjectId: string;
	effectiveFinancialRevisionId: string;
	personalCents: bigint;
}

/**
 * Every eligible PERSONAL economic spending subject whose economic occurrence
 * lands in the MTD window and is still economically active at `checkpointAt`:
 *   - CREDIT_CARD_PURCHASE: effective non-VOID purchase revision, PERSONAL
 *     share (reusing the 4B.3 shared split reader via `purchaseSharesAsOf`)
 *   - PEOPLE_PAYABLE: effective non-VOID PAYABLE obligation, principal, whose
 *     CREATE (economic occurrence) is in the MTD window
 * Family/friend external shares, People RECEIVABLE, reimbursements, family
 * gift / support income, statement payments and Midas movement are excluded.
 */
async function loadFoodUniverse(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
	events: PurchaseEventRow[],
): Promise<FoodUniverseSubject[]> {
	const subjects: FoodUniverseSubject[] = [];

	for (const ev of events) {
		const revs = await db
			.select({
				id: creditCardLiabilityEventRevisions.id,
				revisionNo: creditCardLiabilityEventRevisions.revisionNo,
				operation: creditCardLiabilityEventRevisions.operation,
				amount: creditCardLiabilityEventRevisions.amount,
				occurredAt: creditCardLiabilityEventRevisions.occurredAt,
			})
			.from(creditCardLiabilityEventRevisions)
			.where(eq(creditCardLiabilityEventRevisions.eventId, ev.eventId));
		const eff = effectiveRevisionAsOf(revs, checkpointAt);
		if (!eff || eff.operation === "VOID") continue;
		const at = asDate(eff.occurredAt);
		if (!win.inMtd(at)) continue;
		const grossCents = centsOf(eff.amount);
		const shares = await purchaseSharesAsOf(
			db,
			userId,
			ev.eventId,
			grossCents,
			checkpointAt,
		);
		if (!shares.available) {
			reportFailClosed(
				`MTD food: purchase ${ev.eventId} ownership cannot be authoritatively resolved as of the checkpoint (${shares.reason})`,
			);
		}
		if (shares.personalCents <= 0n) continue; // no personal spend to classify
		subjects.push({
			subjectType: "CREDIT_CARD_PURCHASE",
			subjectId: ev.eventId,
			effectiveFinancialRevisionId: eff.id,
			personalCents: shares.personalCents,
		});
	}

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
		const oRevs = await db
			.select({
				id: personObligationRevisions.id,
				revisionNo: personObligationRevisions.revisionNo,
				operation: personObligationRevisions.operation,
				principal: personObligationRevisions.principalAmount,
				occurredAt: personObligationRevisions.occurredAt,
			})
			.from(personObligationRevisions)
			.where(eq(personObligationRevisions.obligationId, o.id));
		const eff = effectiveRevisionAsOf(oRevs, checkpointAt);
		if (!eff || eff.operation === "VOID") continue;
		const create = oRevs.find((r) => r.revisionNo === 1);
		if (!create) continue;
		// Economic expense occurrence = the CREATE revision instant. A later
		// UPDATE corrects the principal but not when the expense happened.
		if (!win.inMtd(asDate(create.occurredAt))) continue;
		const principalCents = centsOf(eff.principal);
		if (principalCents <= 0n) continue;
		subjects.push({
			subjectType: "PEOPLE_PAYABLE",
			subjectId: o.id,
			effectiveFinancialRevisionId: eff.id,
			personalCents: principalCents,
		});
	}

	subjects.sort((a, b) =>
		a.subjectType === b.subjectType
			? a.subjectId.localeCompare(b.subjectId)
			: a.subjectType.localeCompare(b.subjectType),
	);
	return subjects;
}

async function buildFoodAnalytics(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
	events: PurchaseEventRow[],
): Promise<FoodAnalyticsSection> {
	const universe = await loadFoodUniverse(
		db,
		userId,
		win,
		checkpointAt,
		events,
	);

	const subjects: FoodSubjectEntry[] = [];
	let homeTotal = 0n;
	let outsideTotal = 0n;
	let classifiedPersonal = 0n;
	let unclassifiedOrStalePersonal = 0n;
	const unclassifiedSubjectIds: string[] = [];
	const staleSubjectIds: string[] = [];

	for (const subj of universe) {
		const view = await getSpendingFoodClassificationAsOf({
			db,
			userId,
			subject:
				subj.subjectType === "CREDIT_CARD_PURCHASE"
					? { type: "CREDIT_CARD_PURCHASE", purchaseEventId: subj.subjectId }
					: { type: "PEOPLE_PAYABLE", personObligationId: subj.subjectId },
			asOf: checkpointAt,
		});

		// The subject was pre-filtered to an economically-active source, so the
		// only statuses possible here are CLASSIFIED / UNCLASSIFIED / STALE.
		const status: FoodSubjectEntry["classificationStatus"] =
			view.status === "CLASSIFIED"
				? "CLASSIFIED"
				: view.status === "STALE" || view.status === "SOURCE_VOID"
					? "STALE"
					: "UNCLASSIFIED";

		let entry: FoodSubjectEntry;
		if (status === "CLASSIFIED") {
			// Every field below is REQUIRED for a CLASSIFIED subject. Corruption
			// fails the report closed -- never a plausible zero food spend.
			const path = `foodAnalytics.subject[${subj.subjectId}]`;
			const home = reqMoney(
				view.foodHomeMarketAmount,
				`${path}.foodHomeMarketAmount`,
			);
			const outside = reqMoney(
				view.foodOutsideAmount,
				`${path}.foodOutsideAmount`,
			);
			const total = reqMoney(view.foodTotalAmount, `${path}.foodTotalAmount`);
			const nonFood = reqMoney(view.nonFoodAmount, `${path}.nonFoodAmount`);
			const basis = reqMoney(
				view.basisPersonalAmount,
				`${path}.basisPersonalAmount`,
			);
			if (!view.semanticRevisionId || view.semanticRevisionNo == null) {
				reportFailClosed(
					`${path} is CLASSIFIED but carries no semantic revision identity`,
				);
			}
			if (!view.classificationKind || !view.sourceKind) {
				reportFailClosed(
					`${path} is CLASSIFIED but carries no classificationKind / sourceKind`,
				);
			}
			const hc = centsOf(home);
			const oc = centsOf(outside);
			// FOOD_TOTAL = FOOD_HOME_MARKET + FOOD_OUTSIDE (per subject).
			if (centsOf(total) !== hc + oc) {
				reportFailClosed(
					`${path}: FOOD_TOTAL ${total} != FOOD_HOME_MARKET ${home} + FOOD_OUTSIDE ${outside}`,
				);
			}
			if (centsOf(basis) !== hc + oc + centsOf(nonFood)) {
				reportFailClosed(
					`${path}: basis ${basis} != food ${total} + nonFood ${nonFood}`,
				);
			}
			entry = {
				subjectType: subj.subjectType,
				subjectId: subj.subjectId,
				effectiveFinancialRevisionId: subj.effectiveFinancialRevisionId,
				personalEconomicAmount: formatCentsToMoney(subj.personalCents),
				classificationStatus: "CLASSIFIED",
				semanticRevisionId: view.semanticRevisionId,
				semanticRevisionNo: view.semanticRevisionNo,
				foodHomeMarketAmount: home,
				foodOutsideAmount: outside,
				foodTotalAmount: total,
				nonFoodAmount: nonFood,
				classificationKind: view.classificationKind,
				sourceKind: view.sourceKind,
			};
			homeTotal += hc;
			outsideTotal += oc;
			classifiedPersonal += subj.personalCents;
		} else {
			entry = {
				subjectType: subj.subjectType,
				subjectId: subj.subjectId,
				effectiveFinancialRevisionId: subj.effectiveFinancialRevisionId,
				personalEconomicAmount: formatCentsToMoney(subj.personalCents),
				classificationStatus: status,
				semanticRevisionId: view.semanticRevisionId,
				semanticRevisionNo: view.semanticRevisionNo,
				foodHomeMarketAmount: null,
				foodOutsideAmount: null,
				foodTotalAmount: null,
				nonFoodAmount: null,
				classificationKind: null,
				sourceKind: null,
			};
			unclassifiedOrStalePersonal += subj.personalCents;
			if (status === "STALE") staleSubjectIds.push(subj.subjectId);
			else unclassifiedSubjectIds.push(subj.subjectId);
		}
		subjects.push(entry);
	}

	const classifiedSubjectCount = subjects.filter(
		(s) => s.classificationStatus === "CLASSIFIED",
	).length;
	const complete =
		subjects.length === classifiedSubjectCount &&
		unclassifiedSubjectIds.length === 0 &&
		staleSubjectIds.length === 0;

	if (complete) {
		const foodTotal = homeTotal + outsideTotal;
		// FOOD_TOTAL = FOOD_HOME_MARKET + FOOD_OUTSIDE -- assert against the
		// independently summed per-subject foodTotalAmount fields.
		let subjectFoodTotal = 0n;
		for (const sEntry of subjects) {
			subjectFoodTotal += centsOf(sEntry.foodTotalAmount ?? "0.00");
		}
		if (subjectFoodTotal !== foodTotal) {
			reportFailClosed(
				`FOOD_TOTAL invariant violated: sum of subject foodTotalAmount ${formatCentsToMoney(
					subjectFoodTotal,
				)} != FOOD_HOME_MARKET + FOOD_OUTSIDE ${formatCentsToMoney(foodTotal)}`,
			);
		}
		return {
			available: true,
			merchantInferenceUsed: false,
			subjects,
			classifiedSubjectCount,
			foodHomeMarket: formatCentsToMoney(homeTotal),
			foodOutside: formatCentsToMoney(outsideTotal),
			foodTotal: formatCentsToMoney(foodTotal),
			classifiedPersonalSpend: formatCentsToMoney(classifiedPersonal),
		};
	}

	return {
		available: false,
		reason: "FOOD_CLASSIFICATION_INCOMPLETE",
		merchantInferenceUsed: false,
		subjects,
		classifiedSubjectCount,
		unclassifiedSubjectIds,
		staleSubjectIds,
		classifiedPersonalSpend: formatCentsToMoney(classifiedPersonal),
		unclassifiedOrStalePersonalSpend: formatCentsToMoney(
			unclassifiedOrStalePersonal,
		),
		partialKnownFoodHomeMarket: formatCentsToMoney(homeTotal),
		partialKnownFoodOutside: formatCentsToMoney(outsideTotal),
		partialKnownFoodTotal: formatCentsToMoney(homeTotal + outsideTotal),
	};
}

// ============================================================================
// Section 5B -- surplus-use candidate universe + authoritative availableToAllocateNow
// ============================================================================

interface SurplusUseCandidate {
	subject: SurplusUseSubjectRef;
	subjectType: SurplusUseCandidateEntry["subjectType"];
	subjectId: string;
	lane: SurplusUseLaneName;
	sourceEconomicCents: bigint;
	coveredCents: bigint;
	overlapExact: boolean;
	overlapUnresolvedReason: string | null;
}

async function loadSurplusUseCandidateUniverse(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
	events: PurchaseEventRow[],
	overlap: CurrentObligationsOverlap,
): Promise<SurplusUseCandidate[]> {
	const out: SurplusUseCandidate[] = [];
	const ambiguous = new Set(overlap.ambiguousPurchaseEventIds);

	// ---- 11A. personal spending -- credit-card purchase PERSONAL share ----
	for (const ev of events) {
		const revs = await db
			.select({
				id: creditCardLiabilityEventRevisions.id,
				revisionNo: creditCardLiabilityEventRevisions.revisionNo,
				operation: creditCardLiabilityEventRevisions.operation,
				amount: creditCardLiabilityEventRevisions.amount,
				budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
				occurredAt: creditCardLiabilityEventRevisions.occurredAt,
			})
			.from(creditCardLiabilityEventRevisions)
			.where(eq(creditCardLiabilityEventRevisions.eventId, ev.eventId));
		const eff = effectiveRevisionAsOf(revs, checkpointAt);
		if (!eff || eff.operation === "VOID") continue;
		if (!win.inMtd(asDate(eff.occurredAt))) continue;
		const shares = await purchaseSharesAsOf(
			db,
			userId,
			ev.eventId,
			centsOf(eff.amount),
			checkpointAt,
		);
		if (!shares.available) {
			reportFailClosed(
				`surplus-use: purchase ${ev.eventId} ownership cannot be authoritatively resolved as of the checkpoint (${shares.reason})`,
			);
		}
		const personalCents = shares.personalCents;
		if (personalCents <= 0n) continue;
		const coveredCents =
			overlap.purchasePersonalCoveredCents.get(ev.eventId) ?? 0n;
		let overlapExact = true;
		let overlapUnresolvedReason: string | null = null;
		if (ambiguous.has(ev.eventId)) {
			overlapExact = false;
			overlapUnresolvedReason =
				"a partial pre-period reserve carry-in makes the per-purchase currentObligations overlap ambiguous";
		} else if (
			eff.budgetCategory === "MANDATORY_EXPENSE" &&
			coveredCents < personalCents
		) {
			overlapExact = false;
			overlapUnresolvedReason =
				"a MANDATORY_EXPENSE personal share not fully inside currentObligations is basic-living funded in aggregate; per-source overlap is not exact";
		}
		out.push({
			subject: { type: "CREDIT_CARD_PURCHASE", purchaseEventId: ev.eventId },
			subjectType: "CREDIT_CARD_PURCHASE",
			subjectId: ev.eventId,
			lane: "DISCRETIONARY",
			sourceEconomicCents: personalCents,
			coveredCents: coveredCents > personalCents ? personalCents : coveredCents,
			overlapExact,
			overlapUnresolvedReason,
		});
	}

	// ---- 11A. personal spending -- People PAYABLE principal ----
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
		const oRevs = await db
			.select({
				id: personObligationRevisions.id,
				revisionNo: personObligationRevisions.revisionNo,
				operation: personObligationRevisions.operation,
				principal: personObligationRevisions.principalAmount,
				occurredAt: personObligationRevisions.occurredAt,
			})
			.from(personObligationRevisions)
			.where(eq(personObligationRevisions.obligationId, o.id));
		const eff = effectiveRevisionAsOf(oRevs, checkpointAt);
		if (!eff || eff.operation === "VOID") continue;
		const create = oRevs.find((r) => r.revisionNo === 1);
		if (!create || !win.inMtd(asDate(create.occurredAt))) continue;
		const principalCents = centsOf(eff.principal);
		if (principalCents <= 0n) continue;
		const coveredCents = overlap.peoplePayableCoveredCents.get(o.id) ?? 0n;
		out.push({
			subject: { type: "PEOPLE_PAYABLE", personObligationId: o.id },
			subjectType: "PEOPLE_PAYABLE",
			subjectId: o.id,
			lane: "DISCRETIONARY",
			sourceEconomicCents: principalCents,
			coveredCents:
				coveredCents > principalCents ? principalCents : coveredCents,
			overlapExact: true,
			overlapUnresolvedReason: null,
		});
	}

	// ---- 11B. Mobility -- UNALLOCATED -> INTERNATIONAL_MOBILITY goal transfer ----
	const transfers = await db
		.select({
			id: midasAllocationTransfers.id,
			fromBucketId: midasAllocationTransfers.fromBucketId,
			toBucketId: midasAllocationTransfers.toBucketId,
			amount: midasAllocationTransfers.amount,
			occurredAt: midasAllocationTransfers.occurredAt,
			reversalOfTransferId: midasAllocationTransfers.reversalOfTransferId,
		})
		.from(midasAllocationTransfers)
		.where(eq(midasAllocationTransfers.userId, userId));
	const reversedTargets = new Set(
		transfers
			.filter(
				(t) =>
					t.reversalOfTransferId !== null &&
					asDate(t.occurredAt).getTime() <= checkpointAt.getTime(),
			)
			.map((t) => t.reversalOfTransferId as string),
	);
	for (const t of transfers) {
		if (t.reversalOfTransferId !== null) continue;
		if (t.fromBucketId !== null || t.toBucketId === null) continue;
		if (!win.inMtd(asDate(t.occurredAt))) continue;
		if (reversedTargets.has(t.id)) continue; // SOURCE_INACTIVE -- not a candidate
		const [goal] = await db
			.select({ id: shortTermGoals.id })
			.from(shortTermGoals)
			.where(eq(shortTermGoals.midasBucketId, t.toBucketId))
			.limit(1);
		if (!goal) continue;
		const purposeRevs = await db
			.select({
				revisionNo: shortTermGoalBudgetV2PurposeRevisions.revisionNo,
				purpose: shortTermGoalBudgetV2PurposeRevisions.purpose,
				occurredAt: shortTermGoalBudgetV2PurposeRevisions.occurredAt,
			})
			.from(shortTermGoalBudgetV2PurposeRevisions)
			.where(eq(shortTermGoalBudgetV2PurposeRevisions.goalId, goal.id));
		const purpose = effectiveRevisionAsOf(purposeRevs, checkpointAt);
		if (purpose?.purpose !== "INTERNATIONAL_MOBILITY") continue;
		out.push({
			subject: {
				type: "MOBILITY_MIDAS_TRANSFER",
				midasAllocationTransferId: t.id,
			},
			subjectType: "MOBILITY_MIDAS_TRANSFER",
			subjectId: t.id,
			lane: "INTERNATIONAL_MOBILITY",
			sourceEconomicCents: centsOf(t.amount),
			coveredCents: 0n,
			overlapExact: true,
			overlapUnresolvedReason: null,
		});
	}

	// ---- 11C. Long Term -- one active source per task (CREATE; SENT is not a 2nd) ----
	const tasks = await db
		.select({ id: longTermSendTasks.id })
		.from(longTermSendTasks)
		.where(eq(longTermSendTasks.userId, userId));
	for (const task of tasks) {
		const tRevs = await db
			.select({
				id: longTermSendTaskRevisions.id,
				revisionNo: longTermSendTaskRevisions.revisionNo,
				status: longTermSendTaskRevisions.status,
				amount: longTermSendTaskRevisions.amount,
				occurredAt: longTermSendTaskRevisions.occurredAt,
			})
			.from(longTermSendTaskRevisions)
			.where(eq(longTermSendTaskRevisions.taskId, task.id));
		const eff = effectiveRevisionAsOf(tRevs, checkpointAt);
		if (!eff || eff.status === "CANCELLED") continue; // SOURCE_INACTIVE
		const create = tRevs.find((r) => r.revisionNo === 1);
		if (!create || !win.inMtd(asDate(create.occurredAt))) continue;
		out.push({
			subject: { type: "LONG_TERM_SEND_TASK", longTermSendTaskId: task.id },
			subjectType: "LONG_TERM_SEND_TASK",
			subjectId: task.id,
			lane: "LONG_TERM_INVESTMENT",
			sourceEconomicCents: centsOf(eff.amount),
			coveredCents: 0n,
			overlapExact: true,
			overlapUnresolvedReason: null,
		});
	}

	out.sort((a, b) =>
		a.subjectType === b.subjectType
			? a.subjectId.localeCompare(b.subjectId)
			: a.subjectType.localeCompare(b.subjectType),
	);
	return out;
}

const ATAN_MEANING =
	"remaining Budget V2 current-period true-surplus policy capacity after authoritative realized-use attribution -- NOT a bank-account balance, cash promise, investment advice, or auto-spend permission";

function max0(v: bigint): bigint {
	return v > 0n ? v : 0n;
}

async function buildSurplusUseAttribution(
	db: Database,
	userId: string,
	periodMonth: string,
	checkpointAt: Date,
	candidates: SurplusUseCandidate[],
	policy: BudgetV2LiveResolution["policyResult"],
): Promise<{
	section: SurplusUseAttributionSection;
	availableToAllocateNow: AvailableToAllocateNowSection;
}> {
	const entries: SurplusUseCandidateEntry[] = [];
	const unattributedSubjectIds: string[] = [];
	const staleSubjectIds: string[] = [];
	const overlapUnresolvedSubjectIds: string[] = [];
	let attributedCount = 0;
	let knownAttributedUseCents = 0n;
	let unresolvedPotentialUseCents = 0n;
	let anyUnresolvedPotentialInexact = false;
	const usedByLane: Record<SurplusUseLaneName, bigint> = {
		DISCRETIONARY: 0n,
		INTERNATIONAL_MOBILITY: 0n,
		LONG_TERM_INVESTMENT: 0n,
	};

	for (const c of candidates) {
		const remainingCents = max0(c.sourceEconomicCents - c.coveredCents);
		const view = await getSurplusUseAttributionAsOf({
			db,
			userId,
			subject: c.subject,
			periodMonth,
			asOf: checkpointAt,
		});

		let status: SurplusUseCandidateStatus;
		let effectiveUseCents: bigint | null = null;
		if (view.status === "SOURCE_INACTIVE") {
			// The universe already excludes inactive sources; a disagreement is
			// an authoritative contradiction.
			reportFailClosed(
				`surplus-use: candidate ${c.subjectId} is an active MTD source but its attribution resolves SOURCE_INACTIVE (${view.reason})`,
			);
		} else if (view.status === "ATTRIBUTED") {
			status = "ATTRIBUTED";
			attributedCount += 1;
			const attributedCents = centsOf(
				reqMoney(
					view.attributedCurrentSurplusAmount,
					"attributedCurrentSurplusAmount",
				),
			);
			if (c.overlapExact) {
				effectiveUseCents =
					attributedCents < remainingCents ? attributedCents : remainingCents;
				usedByLane[c.lane] += effectiveUseCents;
				knownAttributedUseCents += effectiveUseCents;
			}
		} else if (view.status === "STALE") {
			status = "STALE";
			if (c.overlapExact && remainingCents > 0n) {
				staleSubjectIds.push(c.subjectId);
				unresolvedPotentialUseCents += remainingCents;
			}
		} else {
			status = "UNATTRIBUTED";
			if (c.overlapExact && remainingCents > 0n) {
				unattributedSubjectIds.push(c.subjectId);
				unresolvedPotentialUseCents += remainingCents;
			}
		}

		if (!c.overlapExact && remainingCents > 0n) {
			overlapUnresolvedSubjectIds.push(c.subjectId);
			anyUnresolvedPotentialInexact = true;
		}

		entries.push({
			subjectType: c.subjectType,
			subjectId: c.subjectId,
			lane: c.lane,
			sourceEconomicAmount: formatCentsToMoney(c.sourceEconomicCents),
			waterfallAlreadyCoveredAmount: formatCentsToMoney(c.coveredCents),
			waterfallOverlapExact: c.overlapExact,
			waterfallOverlapUnresolvedReason: c.overlapUnresolvedReason,
			remainingPotentialSurplusUseAmount: formatCentsToMoney(remainingCents),
			status,
			semanticRevisionId: view.semanticRevisionId,
			semanticRevisionNo: view.semanticRevisionNo,
			storedBasisAmount: view.storedBasisAmount,
			attributedCurrentSurplusAmount: view.attributedCurrentSurplusAmount,
			effectiveCurrentSurplusUseAmount:
				effectiveUseCents === null
					? null
					: formatCentsToMoney(effectiveUseCents),
			sourceKind: view.sourceKind,
			reason: view.reason,
		});
	}

	const coverageComplete =
		overlapUnresolvedSubjectIds.length === 0 &&
		unattributedSubjectIds.length === 0 &&
		staleSubjectIds.length === 0;

	const section: SurplusUseAttributionSection = {
		candidates: entries,
		candidateCount: entries.length,
		attributedCount,
		coverageComplete,
		unattributedSubjectIds,
		staleSubjectIds,
		overlapUnresolvedSubjectIds,
		knownAttributedCurrentSurplusUse: formatCentsToMoney(
			knownAttributedUseCents,
		),
	};

	const trueSurplus = policy.outputs.trueSurplus.amount;

	if (overlapUnresolvedSubjectIds.length > 0) {
		return {
			section,
			availableToAllocateNow: {
				available: false,
				reason: "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED",
				trueSurplus,
				candidateCount: entries.length,
				attributedCount,
				unattributedSubjectIds,
				staleSubjectIds,
				overlapUnresolvedSubjectIds,
				knownAttributedCurrentSurplusUse: formatCentsToMoney(
					knownAttributedUseCents,
				),
				unresolvedPotentialUseAmount: null,
			},
		};
	}

	if (unattributedSubjectIds.length > 0 || staleSubjectIds.length > 0) {
		return {
			section,
			availableToAllocateNow: {
				available: false,
				reason: "SURPLUS_USE_ATTRIBUTION_INCOMPLETE",
				trueSurplus,
				candidateCount: entries.length,
				attributedCount,
				unattributedSubjectIds,
				staleSubjectIds,
				overlapUnresolvedSubjectIds,
				knownAttributedCurrentSurplusUse: formatCentsToMoney(
					knownAttributedUseCents,
				),
				unresolvedPotentialUseAmount: anyUnresolvedPotentialInexact
					? null
					: formatCentsToMoney(unresolvedPotentialUseCents),
			},
		};
	}

	// COMPLETE -- authoritative availableToAllocateNow
	const tsCents = centsOf(trueSurplus);
	const totalUsedCents =
		usedByLane.DISCRETIONARY +
		usedByLane.INTERNATIONAL_MOBILITY +
		usedByLane.LONG_TERM_INVESTMENT;
	const lane = (
		planned: string,
		usedCents: bigint,
	): SurplusUseLaneAccounting => {
		const plannedCents = centsOf(planned);
		return {
			planned,
			used: formatCentsToMoney(usedCents),
			remaining: formatCentsToMoney(max0(plannedCents - usedCents)),
			overrun: formatCentsToMoney(max0(usedCents - plannedCents)),
		};
	};

	return {
		section,
		availableToAllocateNow: {
			available: true,
			amount: formatCentsToMoney(max0(tsCents - totalUsedCents)),
			trueSurplus,
			totalAttributedCurrentSurplusUse: formatCentsToMoney(totalUsedCents),
			oversubscribedBy: formatCentsToMoney(max0(totalUsedCents - tsCents)),
			lanes: {
				INTERNATIONAL_MOBILITY: lane(
					policy.outputs.mobilityAllocation.amount,
					usedByLane.INTERNATIONAL_MOBILITY,
				),
				LONG_TERM_INVESTMENT: lane(
					policy.outputs.longTermInvestment.amount,
					usedByLane.LONG_TERM_INVESTMENT,
				),
				DISCRETIONARY: lane(
					policy.outputs.discretionaryAllocation.amount,
					usedByLane.DISCRETIONARY,
				),
			},
			provenance: {
				method: "AUTHORITATIVE_USER_APPROVED_SURPLUS_USE_ATTRIBUTION",
				meaning: ATAN_MEANING,
				candidateCount: entries.length,
				attributedCount,
			},
		},
	};
}

// ============================================================================
// Orchestration
// ============================================================================

export async function buildBudgetV2CheckpointReport(
	params: CheckpointReportParams,
): Promise<BudgetV2CheckpointReport> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const triggerPaymentEventId = normalizeUuid(
		params.triggerPaymentEventId,
		"triggerPaymentEventId",
	);

	const trigger = await resolveTrigger(
		db,
		userId,
		triggerPaymentEventId,
		periodMonth,
	);
	const checkpointAt = trigger.checkpointAt;

	// Section 4 -- validate an explicit previous checkpoint (never swap / clamp).
	const prevRaw = params.previousCheckpointAt;
	const periodEnd = buildResolverWindow(
		periodMonth,
		checkpointAt,
		undefined,
	).periodEnd;
	if (prevRaw instanceof Date) {
		if (Number.isNaN(prevRaw.getTime())) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				"previousCheckpointAt is not a valid Date",
			);
		}
		if (prevRaw >= checkpointAt) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`previousCheckpointAt ${prevRaw.toISOString()} is not before the current checkpoint ${checkpointAt.toISOString()}`,
			);
		}
		if (prevRaw >= periodEnd) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`previousCheckpointAt ${prevRaw.toISOString()} is at or after the end of period ${periodMonth}; the interval would be empty`,
			);
		}
	} else if (prevRaw !== undefined) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"previousCheckpointAt must be a Date or undefined",
		);
	}

	const win = buildResolverWindow(
		periodMonth,
		checkpointAt,
		prevRaw ?? undefined,
	);

	// Section 5B -- MTD state comes verbatim from the authoritative live resolver.
	const resolution = await resolveBudgetV2LiveSnapshot({
		db,
		userId,
		periodMonth,
		asOf: checkpointAt,
		previousCheckpointAt: prevRaw ?? undefined,
	});

	const cardMetaOf = makeCardMetaAsOf(db, userId, checkpointAt);
	const purchaseEvents = await loadPurchaseEvents(db, userId);

	const income = await buildIntervalIncome(db, userId, win, checkpointAt);
	const purchases = await buildIntervalPurchases(
		db,
		userId,
		win,
		purchaseEvents,
		cardMetaOf,
	);
	const peopleFamily = await buildPeopleFamily(db, userId, win, checkpointAt);
	const statementPayments = await buildStatementPayments(
		db,
		userId,
		win,
		triggerPaymentEventId,
		cardMetaOf,
	);
	const { spending, installmentPurchases } = await buildMtdSpending(
		db,
		userId,
		win,
		checkpointAt,
		purchaseEvents,
	);
	const foodAnalytics = await buildFoodAnalytics(
		db,
		userId,
		win,
		checkpointAt,
		purchaseEvents,
	);

	// Section 5B -- surplus-use attribution + authoritative availableToAllocateNow.
	const obligationsOverlap = await resolveBudgetV2CurrentObligationsOverlap({
		db,
		userId,
		periodMonth,
		asOf: checkpointAt,
		previousCheckpointAt: prevRaw ?? undefined,
	});
	const surplusUseCandidates = await loadSurplusUseCandidateUniverse(
		db,
		userId,
		win,
		checkpointAt,
		purchaseEvents,
		obligationsOverlap,
	);
	const surplusUse = await buildSurplusUseAttribution(
		db,
		userId,
		periodMonth,
		checkpointAt,
		surplusUseCandidates,
		resolution.policyResult,
	);

	const nonSpending = assembleMtdNonSpending(resolution);

	return {
		schemaVersion: BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION,
		checkpoint: {
			schemaVersion: BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION,
			periodMonth,
			paymentEventId: trigger.paymentEventId,
			payRevisionId: trigger.payRevisionId,
			statementId: trigger.statementId,
			checkpointAt: checkpointAt.toISOString(),
			previousCheckpointAt: prevRaw ? prevRaw.toISOString() : null,
			isFirstCheckpoint: !prevRaw,
			intervalStart: win.intervalStart.toISOString(),
			intervalStartInclusive: win.intervalStartInclusive,
			intervalEnd: win.upperLabel.toISOString(),
			mtdWindowStart: win.periodStart.toISOString(),
			mtdWindowEnd: win.upperLabel.toISOString(),
		},
		triggerPayment: trigger.section,
		interval: {
			income,
			purchases,
			peopleFamily,
			statementPayments,
		},
		mtd: {
			spending,
			budget: nonSpending.budget,
			emergencyFund: nonSpending.emergencyFund,
			mobility: nonSpending.mobility,
			necessaryPurchases: nonSpending.necessaryPurchases,
			surplusUseAttribution: surplusUse.section,
		},
		foodAnalytics,
		installmentAnalytics: {
			purchases: installmentPurchases,
			futureInstallmentProjection: {
				available: false,
				reason: "INSTALLMENT_SCHEDULE_NOT_STORED",
			},
		},
		availableToAllocateNow: surplusUse.availableToAllocateNow,
	};
}

// ============================================================================
// Compatibility wrapper -- statementId -> single unambiguous payment event
// ============================================================================

/**
 * Resolve the one eligible trigger payment event id for a statement. Rejects
 * with BUDGET_CHECKPOINT_TRIGGER_AMBIGUOUS when 0 or >1 distinct payment events
 * exist (e.g. after PAY -> REOPEN -> PAY). NOT the canonical trigger API.
 */
export async function resolveTriggerPaymentEventIdForStatement(params: {
	db: Database;
	userId: string;
	statementId: string;
}): Promise<string> {
	const userId = normalizeUuid(params.userId, "userId");
	const statementId = normalizeUuid(params.statementId, "statementId");
	const [stmt] = await params.db
		.select({ id: creditCardStatements.id })
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, statementId),
				eq(creditCardStatements.userId, userId),
			),
		)
		.limit(1);
	if (!stmt) {
		triggerInvalid(`statement ${statementId} does not exist for this user`);
	}
	const payRevs = await params.db
		.select({ paymentEventId: creditCardStatementRevisions.paymentEventId })
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.statementId, statementId),
				eq(creditCardStatementRevisions.operation, "PAY"),
			),
		);
	const ids = [
		...new Set(
			payRevs
				.map((r) => r.paymentEventId)
				.filter((x): x is string => typeof x === "string" && x.length > 0),
		),
	];
	if (ids.length === 0) {
		triggerInvalid(
			`statement ${statementId} has no PAY revision with a linked payment event`,
		);
	}
	if (ids.length > 1) {
		throw new BudgetError(
			"BUDGET_CHECKPOINT_TRIGGER_AMBIGUOUS",
			`statement ${statementId} has ${ids.length} distinct trigger payment events; call buildBudgetV2CheckpointReport with an explicit triggerPaymentEventId`,
		);
	}
	return ids[0] as string;
}

export async function buildBudgetV2CheckpointReportByStatement(params: {
	db: Database;
	userId: string;
	periodMonth: string;
	triggerStatementId: string;
	previousCheckpointAt?: Date | undefined;
}): Promise<BudgetV2CheckpointReport> {
	const triggerPaymentEventId = await resolveTriggerPaymentEventIdForStatement({
		db: params.db,
		userId: params.userId,
		statementId: params.triggerStatementId,
	});
	return buildBudgetV2CheckpointReport({
		db: params.db,
		userId: params.userId,
		periodMonth: params.periodMonth,
		triggerPaymentEventId,
		previousCheckpointAt: params.previousCheckpointAt,
	});
}

// ============================================================================
// Behavior-Engine observation contract (Checkpoint 5B.1, section 9)
// ============================================================================

/**
 * The deterministic, machine-readable slice of ONE checkpoint report that the
 * (future) Behavior Engine is allowed to consume.
 *
 * AUTHORITY BOUNDARY -- the Behavior Engine's observation source is the
 * PERSISTED Budget V2 checkpoint report (`budget_v2_checkpoint_snapshots`,
 * replayed via `getBudgetV2CheckpointByPaymentEventId`), NEVER
 * `resolveBudgetV2LiveSnapshot(...).availableToAllocateNow` and never a
 * recomputation from mutable live sources. `extract...` is a pure projection
 * of an already-built (typically frozen) report object -- it performs no I/O
 * and adds no new math.
 */
export interface BehaviorEngineCheckpointObservation {
	paymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
	previousCheckpointAt: string | null;
	trueSurplus: string;
	coverageComplete: boolean;
	candidateCount: number;
	attributedCount: number;
	unattributedSubjectIds: string[];
	staleSubjectIds: string[];
	overlapUnresolvedSubjectIds: string[];
	availableToAllocateNow: AvailableToAllocateNowSection;
	/** flat convenience mirrors (null when availability is not authoritative) */
	availableAmount: string | null;
	oversubscribedBy: string | null;
	lanes: Record<SurplusUseLaneName, SurplusUseLaneAccounting> | null;
}

export function extractBehaviorEngineCheckpointObservation(
	report: BudgetV2CheckpointReport,
): BehaviorEngineCheckpointObservation {
	const su = report.mtd.surplusUseAttribution;
	const atn = report.availableToAllocateNow;
	return {
		paymentEventId: report.checkpoint.paymentEventId,
		checkpointAt: report.checkpoint.checkpointAt,
		periodMonth: report.checkpoint.periodMonth,
		previousCheckpointAt: report.checkpoint.previousCheckpointAt,
		trueSurplus: report.mtd.budget.policyOutput.trueSurplus,
		coverageComplete: su.coverageComplete,
		candidateCount: su.candidateCount,
		attributedCount: su.attributedCount,
		unattributedSubjectIds: su.unattributedSubjectIds,
		staleSubjectIds: su.staleSubjectIds,
		overlapUnresolvedSubjectIds: su.overlapUnresolvedSubjectIds,
		availableToAllocateNow: atn,
		availableAmount: atn.available ? atn.amount : null,
		oversubscribedBy: atn.available ? atn.oversubscribedBy : null,
		lanes: atn.available ? atn.lanes : null,
	};
}
