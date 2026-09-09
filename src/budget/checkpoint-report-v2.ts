import { and, asc, desc, eq } from "drizzle-orm";
import {
	getStatementReconciliation,
	type StatementReconciliationStatus,
} from "../credit-cards/statement-reconciliation";
import type { Database } from "../db/client";
import { incomeReceiptBudgetV2SemanticRevisions } from "../db/schema/budget-v2-semantics";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
	creditCardStatementPaymentEvents,
} from "../db/schema/credit-card-ledger";
import {
	creditCardPurchaseSplitParticipants,
	creditCardPurchaseSplitRevisionItems,
	creditCardPurchaseSplitRevisions,
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
	type PersonRelationship,
	personObligationRevisions,
	personObligations,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { formatCentsToMoney, parseAggregateMoneyString } from "../ledger/money";
import { BudgetError } from "./errors";
import {
	type BudgetV2LiveResolution,
	buildResolverWindow,
	type ResolverWindow,
	resolveBudgetV2LiveSnapshot,
} from "./live-resolver-v2";
import { normalizeUuid, validateBudgetPeriodMonth } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- AUTHORITATIVE CHECKPOINT REPORT READ MODEL (checkpoint 4B)
 *
 * A READ-ONLY, zero-inference report built when a credit-card statement is PAID.
 * The authoritative checkpoint instant is derived ONLY from that statement's PAY
 * lifecycle (its append-only PAY revision + linked payment event); a caller may
 * not supply an arbitrary checkpoint amount / status. Any trigger precondition
 * it cannot prove from stored truth fails the report closed.
 *
 * Two clearly separated layers:
 *   interval  -- append-only ACTIVITY strictly since the previous checkpoint,
 *                `(previousCheckpointAt, checkpointAt]` (first checkpoint:
 *                `[periodStart, checkpointAt]`), via `buildResolverWindow`.
 *   mtd       -- current MONTH-TO-DATE financial state at `checkpointAt`, taken
 *                verbatim from `resolveBudgetV2LiveSnapshot` (no re-implemented
 *                waterfall math).
 *
 * Food semantic analytics and forward installment schedules are explicitly
 * UNSUPPORTED here (not stored); they are never inferred from merchant / amount
 * / time / behaviour. No persistence, no trigger wiring, no learning.
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
	triggerStatementId: string;
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
	personalShare: string;
	externalShare: string;
	externalParticipants: PurchaseParticipant[];
	ownershipBasis: "CURRENT_ACTIVE_SPLIT";
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
}

export interface FoodAnalyticsSection {
	available: false;
	reason: "FOOD_SEMANTIC_CLASSIFICATION_NOT_STORED";
	supportedBudgetTruth: string;
	merchantInferenceUsed: false;
}

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
	availableToAllocateNow: BudgetV2LiveResolution["availableToAllocateNow"];
}

// ============================================================================
// Small helpers
// ============================================================================

function triggerInvalid(reason: string): never {
	throw new BudgetError("BUDGET_CHECKPOINT_TRIGGER_INVALID", reason);
}

function asDate(v: unknown): Date {
	return v instanceof Date ? v : new Date(v as string);
}

function centsOf(v: string): bigint {
	return parseAggregateMoneyString(v).cents;
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
 * Authoritative person identity (displayName + relationship) effective at a
 * point in time: the greatest-revision person_revisions row whose occurredAt is
 * at or before `at`; if none precede it, the earliest revision. Never inferred
 * from names.
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
		)
		.orderBy(asc(personRevisions.revisionNo));
	if (revs.length === 0) {
		triggerInvalid(
			`person ${personId} has no revisions; its relationship cannot be authoritatively resolved`,
		);
	}
	let chosen = revs[0];
	for (const r of revs) {
		if (asDate(r.occurredAt) <= at) chosen = r;
	}
	if (!chosen) chosen = revs[0];
	return {
		displayName: (chosen as (typeof revs)[number]).displayName,
		relationship: (chosen as (typeof revs)[number])
			.relationship as PersonRelationship,
	};
}

interface PurchaseShares {
	personalCents: bigint;
	externalCents: bigint;
	participants: Array<{
		personId: string;
		shareCents: bigint;
		displayName: string;
		relationship: PersonRelationship;
	}>;
}

/**
 * Current authoritative economic split of a purchase event: its split anchor's
 * latest non-VOID revision. No active / VOID split => 100% personal.
 */
async function currentPurchaseShares(
	db: Database,
	userId: string,
	purchaseEventId: string,
	grossCents: bigint,
	at: Date,
): Promise<PurchaseShares> {
	const [split] = await db
		.select({ id: creditCardPurchaseSplits.id })
		.from(creditCardPurchaseSplits)
		.where(eq(creditCardPurchaseSplits.purchaseEventId, purchaseEventId))
		.limit(1);
	if (!split) {
		return { personalCents: grossCents, externalCents: 0n, participants: [] };
	}
	const [rev] = await db
		.select({
			id: creditCardPurchaseSplitRevisions.id,
			operation: creditCardPurchaseSplitRevisions.operation,
			userShare: creditCardPurchaseSplitRevisions.userShareAmount,
			externalShare: creditCardPurchaseSplitRevisions.externalShareAmount,
		})
		.from(creditCardPurchaseSplitRevisions)
		.where(eq(creditCardPurchaseSplitRevisions.splitId, split.id))
		.orderBy(desc(creditCardPurchaseSplitRevisions.revisionNo))
		.limit(1);
	if (!rev || rev.operation === "VOID") {
		return { personalCents: grossCents, externalCents: 0n, participants: [] };
	}
	const items = await db
		.select({
			personId: creditCardPurchaseSplitRevisionItems.personId,
			shareAmount: creditCardPurchaseSplitRevisionItems.shareAmount,
		})
		.from(creditCardPurchaseSplitRevisionItems)
		.where(eq(creditCardPurchaseSplitRevisionItems.splitRevisionId, rev.id));
	const participants: PurchaseShares["participants"] = [];
	for (const it of items) {
		const who = await personAt(db, userId, it.personId, at);
		participants.push({
			personId: it.personId,
			shareCents: centsOf(it.shareAmount),
			displayName: who.displayName,
			relationship: who.relationship,
		});
	}
	return {
		personalCents: centsOf(rev.userShare),
		externalCents: centsOf(rev.externalShare),
		participants,
	};
}

interface CardMeta {
	cardId: string;
	code: string;
	displayName: string;
	issuer: string;
}

async function loadCardMeta(
	db: Database,
	userId: string,
): Promise<Map<string, CardMeta>> {
	const cards = await db
		.select({ id: creditCards.id, code: creditCards.code })
		.from(creditCards)
		.where(eq(creditCards.userId, userId));
	const out = new Map<string, CardMeta>();
	for (const c of cards) {
		const [rev] = await db
			.select({
				displayName: creditCardRevisions.displayName,
				issuer: creditCardRevisions.issuer,
			})
			.from(creditCardRevisions)
			.where(eq(creditCardRevisions.creditCardId, c.id))
			.orderBy(desc(creditCardRevisions.revisionNo))
			.limit(1);
		out.set(c.id, {
			cardId: c.id,
			code: c.code,
			displayName: rev?.displayName ?? c.code,
			issuer: rev?.issuer ?? "",
		});
	}
	return out;
}

// ============================================================================
// Section 2/3 -- authoritative trigger + ownership decomposition
// ============================================================================

interface TriggerContext {
	section: TriggerPaymentSection;
	checkpointAt: Date;
}

function decomposeOwnership(
	recon: Awaited<ReturnType<typeof getStatementReconciliation>>,
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
			triggerInvalid(
				`reconciliation references person ${personId} with no resolvable relationship`,
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
		triggerInvalid(
			`sealed reconciliation does not partition exactly: personal ${personalCents} + external ${externalTotal} != reconciled ${grossCents}`,
		);
	}
	if (family + friend + other !== externalTotal) {
		triggerInvalid(
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
	triggerStatementId: string,
	periodMonth: string,
	cardMeta: Map<string, CardMeta>,
): Promise<TriggerContext> {
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
				eq(creditCardStatements.id, triggerStatementId),
				eq(creditCardStatements.userId, userId),
			),
		)
		.limit(1);
	if (!stmt) {
		triggerInvalid(
			`statement ${triggerStatementId} does not exist for this user`,
		);
	}

	const [latestRev] = await db
		.select({
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
		})
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, stmt.id))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);
	if (!latestRev) {
		triggerInvalid(`statement ${stmt.id} has no revisions`);
	}
	if (latestRev.status !== "PAID") {
		triggerInvalid(
			`statement ${stmt.id} latest revision status is ${latestRev.status}, not PAID; there is no checkpoint to report`,
		);
	}

	const [payRev] = await db
		.select({
			occurredAt: creditCardStatementRevisions.occurredAt,
			paymentEventId: creditCardStatementRevisions.paymentEventId,
			statementAmount: creditCardStatementRevisions.statementAmount,
		})
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.statementId, stmt.id),
				eq(creditCardStatementRevisions.operation, "PAY"),
			),
		)
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);
	if (!payRev) {
		triggerInvalid(
			`statement ${stmt.id} is PAID but has no authoritative PAY revision`,
		);
	}
	if (!payRev.paymentEventId) {
		triggerInvalid(
			`the PAY revision of statement ${stmt.id} has no linked payment event; the checkpoint instant is not authoritative`,
		);
	}
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
				eq(creditCardStatementPaymentEvents.id, payRev.paymentEventId),
				eq(creditCardStatementPaymentEvents.userId, userId),
			),
		)
		.limit(1);
	if (!payEvent) {
		triggerInvalid(
			`the PAY revision of statement ${stmt.id} claims payment event ${payRev.paymentEventId} which cannot be resolved`,
		);
	}
	if (payEvent.statementId !== stmt.id) {
		triggerInvalid(
			`payment event ${payEvent.id} belongs to a different statement`,
		);
	}

	const payEventCents = centsOf(payEvent.amount);
	const latestAmtCents = centsOf(latestRev.statementAmount);
	const payRevAmtCents = centsOf(payRev.statementAmount);
	if (payEventCents !== latestAmtCents || payRevAmtCents !== latestAmtCents) {
		triggerInvalid(
			`payment amount does not agree with the statement lifecycle (payment event ${payEventCents}, PAY revision ${payRevAmtCents}, latest statement ${latestAmtCents} kurus)`,
		);
	}

	const checkpointAt = asDate(payEvent.occurredAt);

	// Section 4 / case W -- the trigger payment MUST fall inside the requested
	// period (checked before any further work). `previousCheckpointAt` is
	// validated by the caller.
	const w = buildResolverWindow(periodMonth, checkpointAt, undefined);
	if (checkpointAt < w.periodStart || checkpointAt >= w.periodEnd) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`trigger payment at ${checkpointAt.toISOString()} is outside the requested period ${periodMonth}`,
		);
	}

	const recon = await getStatementReconciliation({
		db,
		userId,
		statementId: stmt.id,
	});
	if (recon.status !== "RECONCILED") {
		triggerInvalid(
			`trigger statement ${stmt.id} reconciliation is ${recon.status}${
				recon.staleReason ? ` (${recon.staleReason})` : ""
			}; ownership cannot be authoritatively decomposed`,
		);
	}

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

	const meta = cardMeta.get(stmt.creditCardId);
	if (!meta) {
		triggerInvalid(
			`credit card ${stmt.creditCardId} for statement ${stmt.id} has no configuration`,
		);
	}

	return {
		checkpointAt,
		section: {
			statementId: stmt.id,
			cardId: stmt.creditCardId,
			cardCode: meta.code,
			displayName: meta.displayName,
			issuer: meta.issuer,
			statementCycle: { year: stmt.cycleYear, month: stmt.cycleMonth },
			statementAmount: formatCentsToMoney(latestAmtCents),
			paymentAmount: formatCentsToMoney(payEventCents),
			checkpointAt: checkpointAt.toISOString(),
			paidAt: checkpointAt.toISOString(),
			reservePlacement: latestRev.reservePlacement,
			paymentAssetAccountId: payEvent.paymentAssetAccountId,
			reconciliationRevisionNo: recon.revisionNo ?? 0,
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
			.where(eq(incomeReceiptRevisions.incomeReceiptId, r.receiptId))
			.orderBy(asc(incomeReceiptRevisions.revisionNo));
		if (revs.length === 0) continue;

		let supportRole: SupportRole | null = null;
		if (nature === "SUPPORT") {
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
			supportRole = (roleRow?.role as SupportRole | undefined) ?? null;
		}

		for (const rev of revs) {
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

		const latest = revs[revs.length - 1];
		if (!latest || latest.operation === "VOID") continue;
		const latestAt = asDate(latest.occurredAt);
		if (!win.inInterval(latestAt)) continue;
		const cents = centsOf(latest.amount);
		if (nature === "REGULAR") regular += cents;
		else if (nature === "EXTRA") extra += cents;
		else if (supportRole === "PLANNED_FAMILY_GIFT") gift += cents;
		else if (supportRole === "DEFICIT_FAMILY_SUPPORT") deficit += cents;
		else {
			triggerInvalid(
				`SUPPORT income receipt ${r.receiptId} active in the checkpoint interval has no Budget V2 support-role classification`,
			);
		}
	}

	return {
		activity,
		regularReceipts: formatCentsToMoney(regular),
		extraReceipts: formatCentsToMoney(extra),
		plannedFamilyGiftReceipts: formatCentsToMoney(gift),
		deficitFamilySupportReceipts: formatCentsToMoney(deficit),
		note: "PLANNED_FAMILY_GIFT is real support but not baseline income; DEFICIT_FAMILY_SUPPORT is a post-deficit funding source, not realizedIncome; People receivable repayments are never income.",
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

async function buildIntervalPurchases(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
	events: PurchaseEventRow[],
	cardMeta: Map<string, CardMeta>,
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
			const shares = await currentPurchaseShares(
				db,
				userId,
				ev.eventId,
				grossCents,
				checkpointAt,
			);
			const meta = cardMeta.get(ev.creditCardId);
			const op = rev.operation as "CREATE" | "UPDATE" | "VOID";
			activity.push({
				eventId: ev.eventId,
				revisionNo: rev.revisionNo,
				operation: op,
				cardId: ev.creditCardId,
				cardCode: meta?.code ?? "",
				displayName: meta?.displayName ?? "",
				grossAmount: formatCentsToMoney(grossCents),
				budgetCategory: normalizeCategory(rev.budgetCategory),
				merchant: rev.merchant,
				description: rev.description,
				installmentCount: rev.installmentCount,
				occurredAt: at.toISOString(),
				personalShare: formatCentsToMoney(shares.personalCents),
				externalShare: formatCentsToMoney(shares.externalCents),
				externalParticipants: shares.participants.map((p) => ({
					personId: p.personId,
					displayName: p.displayName,
					relationship: p.relationship,
					shareAmount: formatCentsToMoney(p.shareCents),
				})),
				ownershipBasis: "CURRENT_ACTIVE_SPLIT",
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
		note: "revision-level activity only; an UPDATE is a correction, never a second expense. No heuristic interval net-spend delta is produced -- current MTD totals are authoritative (see mtd.spending).",
	};
}

// ============================================================================
// Section 8 -- current MTD personal spending
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
			.where(eq(creditCardLiabilityEventRevisions.eventId, ev.eventId))
			.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo));
		const latest = revs[0];
		if (!latest || latest.operation === "VOID") continue;
		const at = asDate(latest.occurredAt);
		if (!win.inMtd(at)) continue;
		const grossCents = centsOf(latest.amount);
		const shares = await currentPurchaseShares(
			db,
			userId,
			ev.eventId,
			grossCents,
			checkpointAt,
		);
		const cat = normalizeCategory(latest.budgetCategory);
		byCategory[cat] += shares.personalCents;
		gross += grossCents;
		personal += shares.personalCents;
		external += shares.externalCents;
		for (const p of shares.participants) {
			byRelationship[p.relationship] += p.shareCents;
		}
		if (latest.installmentCount != null) {
			installmentPurchases.push({
				eventId: ev.eventId,
				grossAmount: formatCentsToMoney(grossCents),
				personalShare: formatCentsToMoney(shares.personalCents),
				installmentCount: latest.installmentCount,
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
	const splitObligationIds = new Set(
		participants.map((p) => p.personObligationId),
	);

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
				.where(eq(personSettlementRevisions.settlementId, s.id))
				.orderBy(asc(personSettlementRevisions.revisionNo));
			for (const rev of sRevs) {
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

			// Section 10 -- FAMILY_REIMBURSEMENT requires the full authoritative
			// chain: cc purchase -> sealed split participant -> FAMILY relationship
			// -> split-generated RECEIVABLE obligation -> non-VOID settlement.
			const latest = sRevs[sRevs.length - 1];
			if (latest?.operation !== "CREATE") continue;
			const at = asDate(latest.occurredAt);
			if (!win.inInterval(at)) continue;
			const isSplitLinked = splitObligationIds.has(o.id);
			if (direction === "RECEIVABLE" && isSplitLinked) {
				if (info.relationship === "FAMILY") {
					const link = participants.find((p) => p.personObligationId === o.id);
					const [split] = link
						? await db
								.select({
									purchaseEventId: creditCardPurchaseSplits.purchaseEventId,
								})
								.from(creditCardPurchaseSplits)
								.where(eq(creditCardPurchaseSplits.id, link.splitId))
								.limit(1)
						: [];
					if (split) {
						familyReimbursements.push({
							personId: o.personId,
							displayName: info.displayName,
							obligationId: o.id,
							purchaseEventId: split.purchaseEventId,
							settlementAmount: parseAggregateMoneyString(latest.applied)
								.normalized,
							occurredAt: at.toISOString(),
						});
					}
				}
			} else if (direction === "RECEIVABLE" && !isSplitLinked) {
				standaloneReceivableSettlements.push({
					personId: o.personId,
					displayName: info.displayName,
					relationship: info.relationship,
					obligationId: o.id,
					settlementAmount: parseAggregateMoneyString(latest.applied)
						.normalized,
					occurredAt: at.toISOString(),
				});
			}
		}
	}

	return {
		obligationActivity,
		settlementActivity,
		familyReimbursements,
		standaloneReceivableSettlements,
		note: "FAMILY_REIMBURSEMENT is economically neutral -- never income, never PLANNED_FAMILY_GIFT / DEFICIT_FAMILY_SUPPORT. A standalone family RECEIVABLE repayment (no split-generated obligation) is reported separately and never auto-labelled a reimbursement.",
	};
}

// ============================================================================
// Section 11 -- statement payments during the interval
// ============================================================================

async function buildStatementPayments(
	db: Database,
	userId: string,
	win: ResolverWindow,
	checkpointAt: Date,
	triggerStatementId: string,
	cardMeta: Map<string, CardMeta>,
): Promise<StatementPaymentItem[]> {
	const events = await db
		.select({
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
		const meta = stmt ? cardMeta.get(stmt.creditCardId) : undefined;
		const recon = await getStatementReconciliation({
			db,
			userId,
			statementId: e.statementId,
		});
		let ownership: OwnershipDecomposition | OwnershipUnavailable;
		if (recon.status === "RECONCILED") {
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
			ownership = decomposeOwnership(recon, whoByPerson);
		} else {
			ownership = {
				available: false,
				reason: "RECONCILIATION_UNAVAILABLE",
				reconciliationStatus: recon.status,
			};
		}
		out.push({
			statementId: e.statementId,
			cardId: stmt?.creditCardId ?? "",
			cardCode: meta?.code ?? "",
			displayName: meta?.displayName ?? "",
			amount: parseAggregateMoneyString(e.amount).normalized,
			occurredAt: at.toISOString(),
			paymentAssetAccountId: e.paymentAssetAccountId,
			isTrigger: e.statementId === triggerStatementId,
			ownership,
		});
	}
	return out;
}

// ============================================================================
// Section 12 -- current MTD Budget V2 state (verbatim from the live resolver)
// ============================================================================

function pick(obj: unknown, key: string): unknown {
	return obj && typeof obj === "object"
		? (obj as Record<string, unknown>)[key]
		: undefined;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "0.00";
}

function buildMtdBudget(resolution: BudgetV2LiveResolution): MtdBudgetSection {
	const ev = resolution.evidenceSnapshot;
	const bl = pick(ev, "basicLiving");
	const out = resolution.policyResult.outputs;
	return {
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
			approvedTarget: str(pick(bl, "basicLivingTarget")),
			actualPersonalMandatorySpendMTD: str(
				pick(bl, "actualPersonalMandatorySpendMTD"),
			),
			grossBasicLivingNeed: str(pick(bl, "grossBasicLivingNeed")),
			overlapWithCurrentObligations: str(
				pick(bl, "basicLivingOverlapWithCurrentObligations"),
			),
			basicLivingFunding: str(pick(bl, "basicLivingFunding")),
		},
	};
}

function buildMtdTail(resolution: BudgetV2LiveResolution): {
	emergencyFund: MtdSection["emergencyFund"];
	mobility: MtdSection["mobility"];
	necessaryPurchases: MtdSection["necessaryPurchases"];
} {
	const ev = resolution.evidenceSnapshot;
	const emergency = pick(ev, "emergencyFund");
	const mobility = pick(ev, "mobility");
	const necessary = pick(ev, "necessaryPurchases");
	const mobilityGoals = pick(mobility, "goals");
	const perGoal = pick(necessary, "perGoal");
	const overdue = pick(necessary, "overdueGoalIds");
	return {
		emergencyFund: {
			currentBalance: str(pick(emergency, "balance")),
			target: str(pick(emergency, "target")),
			gap: str(pick(emergency, "gap")),
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
// Orchestration
// ============================================================================

export async function buildBudgetV2CheckpointReport(
	params: CheckpointReportParams,
): Promise<BudgetV2CheckpointReport> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const triggerStatementId = normalizeUuid(
		params.triggerStatementId,
		"triggerStatementId",
	);

	const cardMeta = await loadCardMeta(db, userId);
	const trigger = await resolveTrigger(
		db,
		userId,
		triggerStatementId,
		periodMonth,
		cardMeta,
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

	const purchaseEvents = await loadPurchaseEvents(db, userId);

	const income = await buildIntervalIncome(db, userId, win);
	const purchases = await buildIntervalPurchases(
		db,
		userId,
		win,
		checkpointAt,
		purchaseEvents,
		cardMeta,
	);
	const peopleFamily = await buildPeopleFamily(db, userId, win, checkpointAt);
	const statementPayments = await buildStatementPayments(
		db,
		userId,
		win,
		checkpointAt,
		triggerStatementId,
		cardMeta,
	);
	const { spending, installmentPurchases } = await buildMtdSpending(
		db,
		userId,
		win,
		checkpointAt,
		purchaseEvents,
	);

	const tail = buildMtdTail(resolution);

	return {
		schemaVersion: BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION,
		checkpoint: {
			schemaVersion: BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION,
			periodMonth,
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
			budget: buildMtdBudget(resolution),
			emergencyFund: tail.emergencyFund,
			mobility: tail.mobility,
			necessaryPurchases: tail.necessaryPurchases,
		},
		foodAnalytics: {
			available: false,
			reason: "FOOD_SEMANTIC_CLASSIFICATION_NOT_STORED",
			supportedBudgetTruth: "FOOD_TOTAL requires explicit semantic data",
			merchantInferenceUsed: false,
		},
		installmentAnalytics: {
			purchases: installmentPurchases,
			futureInstallmentProjection: {
				available: false,
				reason: "INSTALLMENT_SCHEDULE_NOT_STORED",
			},
		},
		availableToAllocateNow: resolution.availableToAllocateNow,
	};
}
