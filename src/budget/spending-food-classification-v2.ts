import { and, desc, eq } from "drizzle-orm";
import { resolveAuthoritativePurchaseSplitAsOf } from "../credit-cards/purchase-split-read";
import type { Database } from "../db/client";
import { effectiveRevisionAsOf } from "../db/effective-revision";
import {
	budgetV2SpendingFoodSemanticRevisions,
	SPENDING_FOOD_SOURCE_KINDS,
	type SpendingFoodSourceKind,
	type SpendingFoodSplitBasis,
	type SpendingFoodSubjectType,
} from "../db/schema/budget-v2-spending-food";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	personObligationRevisions,
	personObligations,
} from "../db/schema/people";
import {
	formatCentsToMoney,
	parseAggregateMoneyString,
	parseMoneyString,
} from "../ledger/money";
import { BudgetError } from "./errors";
import { calculateSpendingFoodSemanticRevisionFingerprint } from "./semantic-fingerprint-v2";
import { normalizeUuid } from "./utils";

// ============================================================================
// Subject reference
// ============================================================================

export type SpendingFoodSubjectRef =
	| { type: "CREDIT_CARD_PURCHASE"; purchaseEventId: string }
	| { type: "PEOPLE_PAYABLE"; personObligationId: string };

interface NormalizedSubject {
	subjectType: SpendingFoodSubjectType;
	purchaseEventId: string | null;
	personObligationId: string | null;
}

function normalizeSubject(ref: SpendingFoodSubjectRef): NormalizedSubject {
	if (!ref || typeof ref !== "object") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "subject is required");
	}
	if (ref.type === "CREDIT_CARD_PURCHASE") {
		return {
			subjectType: "CREDIT_CARD_PURCHASE",
			purchaseEventId: normalizeUuid(ref.purchaseEventId, "purchaseEventId"),
			personObligationId: null,
		};
	}
	if (ref.type === "PEOPLE_PAYABLE") {
		return {
			subjectType: "PEOPLE_PAYABLE",
			purchaseEventId: null,
			personObligationId: normalizeUuid(
				ref.personObligationId,
				"personObligationId",
			),
		};
	}
	throw new BudgetError(
		"BUDGET_INVALID_INPUT",
		`subject.type must be CREDIT_CARD_PURCHASE or PEOPLE_PAYABLE`,
	);
}

// ============================================================================
// Read model
// ============================================================================

export type FoodClassificationKind =
	| "FOOD_HOME_MARKET"
	| "FOOD_OUTSIDE"
	| "NON_FOOD"
	| "MIXED";

export type FoodClassificationStatus =
	| "CLASSIFIED"
	| "UNCLASSIFIED"
	| "STALE"
	| "SOURCE_VOID";

export interface SpendingFoodClassificationView {
	subjectType: SpendingFoodSubjectType;
	subjectId: string;
	status: FoodClassificationStatus;
	/** The stale / source-void reason, when applicable. */
	reason: string | null;
	semanticRevisionId: string | null;
	semanticRevisionNo: number | null;
	operation: "CREATE" | "UPDATE" | "VOID" | null;
	sourceKind: SpendingFoodSourceKind | null;
	/** Stored basis the user approved against (null when unclassified). */
	basisPersonalAmount: string | null;
	/** Authoritative personal economic amount of the source as of `asOf`. */
	currentPersonalEconomicAmount: string | null;
	foodHomeMarketAmount: string | null;
	foodOutsideAmount: string | null;
	foodTotalAmount: string | null;
	nonFoodAmount: string | null;
	classificationKind: FoodClassificationKind | null;
	occurredAt: string | null;
}

/**
 * The monetary allocation is authoritative; this label is a convenience
 * projection only. `basis`/`home`/`outside` are kuruş.
 */
export function deriveFoodClassificationKind(
	basisCents: bigint,
	homeCents: bigint,
	outsideCents: bigint,
): FoodClassificationKind {
	if (homeCents === 0n && outsideCents === 0n) return "NON_FOOD";
	if (homeCents === basisCents && outsideCents === 0n)
		return "FOOD_HOME_MARKET";
	if (outsideCents === basisCents && homeCents === 0n) return "FOOD_OUTSIDE";
	return "MIXED";
}

// ============================================================================
// Source basis resolution (Sections 6 / 7 / 10)
// ============================================================================

export type SpendingFoodBasisResolution =
	| {
			kind: "ACTIVE";
			basisPersonalCents: bigint;
			basisPersonalAmount: string;
			purchaseEventRevisionId: string | null;
			personObligationRevisionId: string | null;
			splitBasis: SpendingFoodSplitBasis | null;
			splitRevisionId: string | null;
	  }
	| { kind: "SOURCE_INACTIVE"; reason: string }
	| { kind: "UNRESOLVED"; reason: string };

function centsOf(v: string): bigint {
	return parseAggregateMoneyString(v).cents;
}

/**
 * The authoritative PERSONAL economic basis of a spending subject as of
 * `asOf`. Credit-card purchases reuse Checkpoint 4B.3's shared split reader;
 * People PAYABLE obligations use the effective non-VOID obligation principal.
 */
export async function resolveSpendingFoodBasisAsOf(params: {
	db: Database;
	userId: string;
	subject: SpendingFoodSubjectRef;
	asOf: Date;
}): Promise<SpendingFoodBasisResolution> {
	const userId = normalizeUuid(params.userId, "userId");
	const subject = normalizeSubject(params.subject);
	const { db, asOf } = params;

	if (subject.subjectType === "CREDIT_CARD_PURCHASE") {
		const purchaseEventId = subject.purchaseEventId as string;
		const [ev] = await db
			.select({
				id: creditCardLiabilityEvents.id,
				userId: creditCardLiabilityEvents.userId,
				eventType: creditCardLiabilityEvents.eventType,
			})
			.from(creditCardLiabilityEvents)
			.where(eq(creditCardLiabilityEvents.id, purchaseEventId))
			.limit(1);
		if (!ev || ev.userId !== userId || ev.eventType !== "PURCHASE") {
			return {
				kind: "UNRESOLVED",
				reason: `credit-card purchase ${purchaseEventId} not found for this user`,
			};
		}
		const revs = await db
			.select({
				id: creditCardLiabilityEventRevisions.id,
				revisionNo: creditCardLiabilityEventRevisions.revisionNo,
				operation: creditCardLiabilityEventRevisions.operation,
				amount: creditCardLiabilityEventRevisions.amount,
				occurredAt: creditCardLiabilityEventRevisions.occurredAt,
			})
			.from(creditCardLiabilityEventRevisions)
			.where(eq(creditCardLiabilityEventRevisions.eventId, purchaseEventId));
		const eff = effectiveRevisionAsOf(revs, asOf);
		if (!eff) {
			return {
				kind: "SOURCE_INACTIVE",
				reason: `credit-card purchase ${purchaseEventId} has no revision effective at ${asOf.toISOString()}`,
			};
		}
		if (eff.operation === "VOID") {
			return {
				kind: "SOURCE_INACTIVE",
				reason: `credit-card purchase ${purchaseEventId} is VOID as of ${asOf.toISOString()}`,
			};
		}
		const grossCents = centsOf(eff.amount);
		const split = await resolveAuthoritativePurchaseSplitAsOf({
			db,
			userId,
			purchaseEventId,
			asOf,
			expectedPurchaseCents: grossCents,
		});
		if (split.kind === "UNRESOLVED") {
			return {
				kind: "UNRESOLVED",
				reason: `credit-card purchase ${purchaseEventId} economic split is not authoritative as of ${asOf.toISOString()} (${split.reason})`,
			};
		}
		if (split.kind === "NO_SPLIT" || split.kind === "VOID_SPLIT") {
			return {
				kind: "ACTIVE",
				basisPersonalCents: grossCents,
				basisPersonalAmount: formatCentsToMoney(grossCents),
				purchaseEventRevisionId: eff.id,
				personObligationRevisionId: null,
				splitBasis: split.kind === "NO_SPLIT" ? "NO_SPLIT" : "VOID_SPLIT",
				splitRevisionId:
					split.kind === "VOID_SPLIT" ? split.splitRevisionId : null,
			};
		}
		// ACTIVE sealed split -> the user's exact economic share.
		if (split.userShareCents <= 0n) {
			return {
				kind: "SOURCE_INACTIVE",
				reason: `credit-card purchase ${purchaseEventId} has a zero personal economic share as of ${asOf.toISOString()}`,
			};
		}
		return {
			kind: "ACTIVE",
			basisPersonalCents: split.userShareCents,
			basisPersonalAmount: formatCentsToMoney(split.userShareCents),
			purchaseEventRevisionId: eff.id,
			personObligationRevisionId: null,
			splitBasis: "SEALED_SPLIT_AS_OF",
			splitRevisionId: split.splitRevisionId,
		};
	}

	// PEOPLE_PAYABLE
	const personObligationId = subject.personObligationId as string;
	const [obl] = await db
		.select({
			id: personObligations.id,
			userId: personObligations.userId,
			direction: personObligations.direction,
		})
		.from(personObligations)
		.where(eq(personObligations.id, personObligationId))
		.limit(1);
	if (!obl || obl.userId !== userId) {
		return {
			kind: "UNRESOLVED",
			reason: `people obligation ${personObligationId} not found for this user`,
		};
	}
	if (obl.direction !== "PAYABLE") {
		return {
			kind: "UNRESOLVED",
			reason: `people obligation ${personObligationId} is direction ${obl.direction}; only PAYABLE is eligible for food classification`,
		};
	}
	const oRevs = await db
		.select({
			id: personObligationRevisions.id,
			revisionNo: personObligationRevisions.revisionNo,
			operation: personObligationRevisions.operation,
			principal: personObligationRevisions.principalAmount,
			occurredAt: personObligationRevisions.occurredAt,
		})
		.from(personObligationRevisions)
		.where(eq(personObligationRevisions.obligationId, personObligationId));
	const oEff = effectiveRevisionAsOf(oRevs, asOf);
	if (!oEff) {
		return {
			kind: "SOURCE_INACTIVE",
			reason: `people obligation ${personObligationId} has no revision effective at ${asOf.toISOString()}`,
		};
	}
	if (oEff.operation === "VOID") {
		return {
			kind: "SOURCE_INACTIVE",
			reason: `people obligation ${personObligationId} is VOID as of ${asOf.toISOString()}`,
		};
	}
	const principalCents = centsOf(oEff.principal);
	return {
		kind: "ACTIVE",
		basisPersonalCents: principalCents,
		basisPersonalAmount: formatCentsToMoney(principalCents),
		purchaseEventRevisionId: null,
		personObligationRevisionId: oEff.id,
		splitBasis: null,
		splitRevisionId: null,
	};
}

// ============================================================================
// Params
// ============================================================================

export interface CreateSpendingFoodClassificationParams {
	db: Database;
	userId: string;
	subject: SpendingFoodSubjectRef;
	foodHomeMarketAmount: string;
	foodOutsideAmount: string;
	sourceKind: SpendingFoodSourceKind;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface UpdateSpendingFoodClassificationParams
	extends CreateSpendingFoodClassificationParams {
	expectedRevisionNo: number;
}

export interface VoidSpendingFoodClassificationParams {
	db: Database;
	userId: string;
	subject: SpendingFoodSubjectRef;
	expectedRevisionNo: number;
	sourceKind: SpendingFoodSourceKind;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface SpendingFoodClassificationItem {
	semanticRevisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	subjectType: SpendingFoodSubjectType;
	subjectId: string;
	sourceKind: SpendingFoodSourceKind;
	basisPersonalAmount: string;
	foodHomeMarketAmount: string;
	foodOutsideAmount: string;
	foodTotalAmount: string;
	nonFoodAmount: string;
	classificationKind: FoodClassificationKind;
	splitBasis: SpendingFoodSplitBasis | null;
	splitRevisionId: string | null;
	purchaseEventRevisionId: string | null;
	personObligationRevisionId: string | null;
	previousRevisionId: string | null;
	occurredAt: string;
}

export interface SpendingFoodClassificationResult {
	classification: SpendingFoodClassificationItem;
	idempotentReplay: boolean;
}

type Row = typeof budgetV2SpendingFoodSemanticRevisions.$inferSelect;

function toItem(row: Row): SpendingFoodClassificationItem {
	const basisCents = centsOf(row.basisPersonalAmount);
	const homeCents = centsOf(row.foodHomeMarketAmount);
	const outsideCents = centsOf(row.foodOutsideAmount);
	const foodTotal = homeCents + outsideCents;
	return {
		semanticRevisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as "CREATE" | "UPDATE" | "VOID",
		subjectType: row.subjectType as SpendingFoodSubjectType,
		subjectId: (row.purchaseEventId ?? row.personObligationId) as string,
		sourceKind: row.sourceKind as SpendingFoodSourceKind,
		basisPersonalAmount: parseAggregateMoneyString(row.basisPersonalAmount)
			.normalized,
		foodHomeMarketAmount: parseAggregateMoneyString(row.foodHomeMarketAmount)
			.normalized,
		foodOutsideAmount: parseAggregateMoneyString(row.foodOutsideAmount)
			.normalized,
		foodTotalAmount: formatCentsToMoney(foodTotal),
		nonFoodAmount: formatCentsToMoney(basisCents - foodTotal),
		classificationKind: deriveFoodClassificationKind(
			basisCents,
			homeCents,
			outsideCents,
		),
		splitBasis: row.splitBasis as SpendingFoodSplitBasis | null,
		splitRevisionId: row.splitRevisionId,
		purchaseEventRevisionId: row.purchaseEventRevisionId,
		personObligationRevisionId: row.personObligationRevisionId,
		previousRevisionId: row.previousRevisionId,
		occurredAt: row.occurredAt.toISOString(),
	};
}

// ============================================================================
// Validation
// ============================================================================

function validateSourceKind(value: unknown): SpendingFoodSourceKind {
	if (
		typeof value !== "string" ||
		!(SPENDING_FOOD_SOURCE_KINDS as readonly string[]).includes(value)
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`sourceKind must be one of: ${SPENDING_FOOD_SOURCE_KINDS.join(", ")}`,
		);
	}
	return value as SpendingFoodSourceKind;
}

function validateNonNegativeMoney(value: string, field: string): bigint {
	try {
		const parsed = parseMoneyString(value);
		if (parsed.cents < 0n) throw new Error("negative");
		return parsed.cents;
	} catch (e) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${field} must be a non-negative money string: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
}

function requireKey(idempotencyKey: string): string {
	const trimmed = idempotencyKey?.trim();
	if (!trimmed || trimmed.length > 128) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"idempotencyKey is required and must be 1..128 chars",
		);
	}
	return trimmed;
}

function validateOptionalOccurredAt(value: Date | undefined): Date | undefined {
	if (value === undefined) return undefined;
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

function validateExpectedRevisionNo(value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}
	return value;
}

// ============================================================================
// Internal lookups
// ============================================================================

async function findByIdempotencyKey(
	db: Database,
	userId: string,
	idempotencyKey: string,
): Promise<Row | undefined> {
	const [row] = await db
		.select()
		.from(budgetV2SpendingFoodSemanticRevisions)
		.where(
			and(
				eq(budgetV2SpendingFoodSemanticRevisions.userId, userId),
				eq(
					budgetV2SpendingFoodSemanticRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);
	return row;
}

function subjectFilter(subject: NormalizedSubject) {
	return subject.subjectType === "CREDIT_CARD_PURCHASE"
		? eq(
				budgetV2SpendingFoodSemanticRevisions.purchaseEventId,
				subject.purchaseEventId as string,
			)
		: eq(
				budgetV2SpendingFoodSemanticRevisions.personObligationId,
				subject.personObligationId as string,
			);
}

async function latestRevisionForSubject(
	db: Database,
	userId: string,
	subject: NormalizedSubject,
): Promise<Row | undefined> {
	const [row] = await db
		.select()
		.from(budgetV2SpendingFoodSemanticRevisions)
		.where(
			and(
				eq(budgetV2SpendingFoodSemanticRevisions.userId, userId),
				subjectFilter(subject),
			),
		)
		.orderBy(desc(budgetV2SpendingFoodSemanticRevisions.revisionNo))
		.limit(1);
	return row;
}

async function lockSubject(
	tx: Database,
	userId: string,
	subject: NormalizedSubject,
): Promise<void> {
	if (subject.subjectType === "CREDIT_CARD_PURCHASE") {
		const [ev] = await tx
			.select({
				id: creditCardLiabilityEvents.id,
				userId: creditCardLiabilityEvents.userId,
				eventType: creditCardLiabilityEvents.eventType,
			})
			.from(creditCardLiabilityEvents)
			.where(
				eq(creditCardLiabilityEvents.id, subject.purchaseEventId as string),
			)
			.for("update")
			.limit(1);
		if (!ev) {
			throw new BudgetError(
				"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
				`Credit-card purchase "${subject.purchaseEventId}" not found`,
			);
		}
		if (ev.userId !== userId || ev.eventType !== "PURCHASE") {
			throw new BudgetError(
				"BUDGET_CLASSIFICATION_INVALID_TARGET",
				`Credit-card purchase "${subject.purchaseEventId}" is not an owned PURCHASE event`,
			);
		}
		return;
	}
	const [obl] = await tx
		.select({
			id: personObligations.id,
			userId: personObligations.userId,
			direction: personObligations.direction,
		})
		.from(personObligations)
		.where(eq(personObligations.id, subject.personObligationId as string))
		.for("update")
		.limit(1);
	if (!obl) {
		throw new BudgetError(
			"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
			`People obligation "${subject.personObligationId}" not found`,
		);
	}
	if (obl.userId !== userId || obl.direction !== "PAYABLE") {
		throw new BudgetError(
			"BUDGET_CLASSIFICATION_INVALID_TARGET",
			`People obligation "${subject.personObligationId}" is not an owned PAYABLE obligation`,
		);
	}
}

// ============================================================================
// Reconcile (fail-closed replay)
// ============================================================================

interface ReconcileCtx {
	userId: string;
	subject: NormalizedSubject;
	operation: "CREATE" | "UPDATE" | "VOID";
	expectedRevisionNo?: number;
	foodHomeMarketAmount: string;
	foodOutsideAmount: string;
	sourceKind: SpendingFoodSourceKind;
	explicitOccurredAt: Date | undefined;
	idempotencyKey: string;
}

async function reconcileExisting(
	existing: Row,
	ctx: ReconcileCtx,
): Promise<SpendingFoodClassificationResult> {
	const candidateFp = await calculateSpendingFoodSemanticRevisionFingerprint({
		userId: ctx.userId,
		subjectType: ctx.subject.subjectType,
		purchaseEventId: ctx.subject.purchaseEventId,
		personObligationId: ctx.subject.personObligationId,
		operation: ctx.operation,
		revisionNo: existing.revisionNo,
		previousRevisionId: existing.previousRevisionId,
		// Replay uses the STORED derived truth -- a re-issue never re-reads
		// the mutable financial source.
		basisPersonalAmount: existing.basisPersonalAmount,
		foodHomeMarketAmount: existing.foodHomeMarketAmount,
		foodOutsideAmount: existing.foodOutsideAmount,
		sourceKind: ctx.sourceKind,
		purchaseEventRevisionId: existing.purchaseEventRevisionId,
		personObligationRevisionId: existing.personObligationRevisionId,
		splitBasis: existing.splitBasis as SpendingFoodSplitBasis | null,
		splitRevisionId: existing.splitRevisionId,
		occurredAt: ctx.explicitOccurredAt ?? existing.occurredAt,
	});
	const positionOk =
		ctx.operation === "CREATE"
			? existing.revisionNo === 1 && existing.previousRevisionId === null
			: existing.revisionNo === (ctx.expectedRevisionNo ?? -1) + 1 &&
				existing.previousRevisionId !== null;
	const storedFoodEcho =
		ctx.operation === "VOID"
			? existing.foodHomeMarketAmount === "0.00" &&
				existing.foodOutsideAmount === "0.00"
			: centsOf(existing.foodHomeMarketAmount) ===
					centsOf(ctx.foodHomeMarketAmount) &&
				centsOf(existing.foodOutsideAmount) === centsOf(ctx.foodOutsideAmount);
	const exact =
		existing.userId === ctx.userId &&
		existing.subjectType === ctx.subject.subjectType &&
		(existing.purchaseEventId ?? null) === ctx.subject.purchaseEventId &&
		(existing.personObligationId ?? null) === ctx.subject.personObligationId &&
		existing.operation === ctx.operation &&
		positionOk &&
		storedFoodEcho &&
		existing.revisionFingerprint === candidateFp;
	if (!exact) {
		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`Idempotency key "${ctx.idempotencyKey}" was already used with different food-classification parameters`,
		);
	}
	return { classification: toItem(existing), idempotentReplay: true };
}

// ============================================================================
// Shared insert body
// ============================================================================

interface InsertPlan {
	revisionNo: number;
	previousRevisionId: string | null;
	operation: "CREATE" | "UPDATE" | "VOID";
	basisPersonalAmount: string;
	foodHomeMarketAmount: string;
	foodOutsideAmount: string;
	purchaseEventRevisionId: string | null;
	personObligationRevisionId: string | null;
	splitBasis: SpendingFoodSplitBasis | null;
	splitRevisionId: string | null;
}

async function insertRevision(
	tx: Database,
	txdb: Database,
	ctx: ReconcileCtx,
	plan: InsertPlan,
	occurredAt: Date,
): Promise<SpendingFoodClassificationResult> {
	const revisionFingerprint =
		await calculateSpendingFoodSemanticRevisionFingerprint({
			userId: ctx.userId,
			subjectType: ctx.subject.subjectType,
			purchaseEventId: ctx.subject.purchaseEventId,
			personObligationId: ctx.subject.personObligationId,
			operation: plan.operation,
			revisionNo: plan.revisionNo,
			previousRevisionId: plan.previousRevisionId,
			basisPersonalAmount: plan.basisPersonalAmount,
			foodHomeMarketAmount: plan.foodHomeMarketAmount,
			foodOutsideAmount: plan.foodOutsideAmount,
			sourceKind: ctx.sourceKind,
			purchaseEventRevisionId: plan.purchaseEventRevisionId,
			personObligationRevisionId: plan.personObligationRevisionId,
			splitBasis: plan.splitBasis,
			splitRevisionId: plan.splitRevisionId,
			occurredAt,
		});

	const [inserted] = await tx
		.insert(budgetV2SpendingFoodSemanticRevisions)
		.values({
			userId: ctx.userId,
			subjectType: ctx.subject.subjectType,
			purchaseEventId: ctx.subject.purchaseEventId,
			personObligationId: ctx.subject.personObligationId,
			revisionNo: plan.revisionNo,
			previousRevisionId: plan.previousRevisionId,
			operation: plan.operation,
			basisPersonalAmount: plan.basisPersonalAmount,
			foodHomeMarketAmount: plan.foodHomeMarketAmount,
			foodOutsideAmount: plan.foodOutsideAmount,
			sourceKind: ctx.sourceKind,
			purchaseEventRevisionId: plan.purchaseEventRevisionId,
			personObligationRevisionId: plan.personObligationRevisionId,
			splitBasis: plan.splitBasis,
			splitRevisionId: plan.splitRevisionId,
			idempotencyKey: ctx.idempotencyKey,
			revisionFingerprint,
			occurredAt,
		})
		.onConflictDoNothing({
			target: [
				budgetV2SpendingFoodSemanticRevisions.userId,
				budgetV2SpendingFoodSemanticRevisions.idempotencyKey,
			],
		})
		.returning();
	if (inserted) {
		return { classification: toItem(inserted), idempotentReplay: false };
	}

	const afterConflict = await findByIdempotencyKey(
		txdb,
		ctx.userId,
		ctx.idempotencyKey,
	);
	if (!afterConflict) {
		throw new BudgetError(
			"BUDGET_INVALID_STATE",
			"food classification idempotency key conflicted but no row is visible",
		);
	}
	return reconcileExisting(afterConflict, ctx);
}

function resolveBasisOrThrow(
	res: SpendingFoodBasisResolution,
	subjectId: string,
): Extract<SpendingFoodBasisResolution, { kind: "ACTIVE" }> {
	if (res.kind === "ACTIVE") return res;
	throw new BudgetError(
		"BUDGET_CLASSIFICATION_INVALID_TARGET",
		`spending subject ${subjectId} economic basis is not authoritative for food classification (${res.reason})`,
	);
}

function assertFoodWithinBasis(
	homeCents: bigint,
	outsideCents: bigint,
	basisCents: bigint,
): void {
	if (homeCents + outsideCents > basisCents) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`foodHomeMarketAmount + foodOutsideAmount (${formatCentsToMoney(
				homeCents + outsideCents,
			)}) exceeds the personal economic basis (${formatCentsToMoney(basisCents)})`,
		);
	}
}

// ============================================================================
// create (CREATE revision #1)
// ============================================================================

export async function createSpendingFoodClassification(
	params: CreateSpendingFoodClassificationParams,
): Promise<SpendingFoodClassificationResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = normalizeSubject(params.subject);
	const subjectRef = params.subject;
	const homeCents = validateNonNegativeMoney(
		params.foodHomeMarketAmount,
		"foodHomeMarketAmount",
	);
	const outsideCents = validateNonNegativeMoney(
		params.foodOutsideAmount,
		"foodOutsideAmount",
	);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);

	const homeAmount = formatCentsToMoney(homeCents);
	const outsideAmount = formatCentsToMoney(outsideCents);
	const ctx: ReconcileCtx = {
		userId,
		subject,
		operation: "CREATE",
		foodHomeMarketAmount: homeAmount,
		foodOutsideAmount: outsideAmount,
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await lockSubject(txdb, userId, subject);

		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		const latest = await latestRevisionForSubject(txdb, userId, subject);
		if (latest) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Spending subject is already food-classified (revision ${latest.revisionNo}); use updateSpendingFoodClassification`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const basis = resolveBasisOrThrow(
			await resolveSpendingFoodBasisAsOf({
				db: txdb,
				userId,
				subject: subjectRef,
				asOf: occurredAt,
			}),
			subject.purchaseEventId ?? (subject.personObligationId as string),
		);
		assertFoodWithinBasis(homeCents, outsideCents, basis.basisPersonalCents);

		return insertRevision(
			tx as unknown as Database,
			txdb,
			ctx,
			{
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				basisPersonalAmount: basis.basisPersonalAmount,
				foodHomeMarketAmount: homeAmount,
				foodOutsideAmount: outsideAmount,
				purchaseEventRevisionId: basis.purchaseEventRevisionId,
				personObligationRevisionId: basis.personObligationRevisionId,
				splitBasis: basis.splitBasis,
				splitRevisionId: basis.splitRevisionId,
			},
			occurredAt,
		);
	});
}

// ============================================================================
// update (append UPDATE revision)
// ============================================================================

export async function updateSpendingFoodClassification(
	params: UpdateSpendingFoodClassificationParams,
): Promise<SpendingFoodClassificationResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = normalizeSubject(params.subject);
	const subjectRef = params.subject;
	const homeCents = validateNonNegativeMoney(
		params.foodHomeMarketAmount,
		"foodHomeMarketAmount",
	);
	const outsideCents = validateNonNegativeMoney(
		params.foodOutsideAmount,
		"foodOutsideAmount",
	);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	const homeAmount = formatCentsToMoney(homeCents);
	const outsideAmount = formatCentsToMoney(outsideCents);
	const ctx: ReconcileCtx = {
		userId,
		subject,
		operation: "UPDATE",
		expectedRevisionNo,
		foodHomeMarketAmount: homeAmount,
		foodOutsideAmount: outsideAmount,
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await lockSubject(txdb, userId, subject);

		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		const latest = await latestRevisionForSubject(txdb, userId, subject);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
				"Spending subject is not yet food-classified; use createSpendingFoodClassification",
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Expected food-classification revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const basis = resolveBasisOrThrow(
			await resolveSpendingFoodBasisAsOf({
				db: txdb,
				userId,
				subject: subjectRef,
				asOf: occurredAt,
			}),
			subject.purchaseEventId ?? (subject.personObligationId as string),
		);
		assertFoodWithinBasis(homeCents, outsideCents, basis.basisPersonalCents);

		return insertRevision(
			tx as unknown as Database,
			txdb,
			ctx,
			{
				revisionNo: expectedRevisionNo + 1,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				basisPersonalAmount: basis.basisPersonalAmount,
				foodHomeMarketAmount: homeAmount,
				foodOutsideAmount: outsideAmount,
				purchaseEventRevisionId: basis.purchaseEventRevisionId,
				personObligationRevisionId: basis.personObligationRevisionId,
				splitBasis: basis.splitBasis,
				splitRevisionId: basis.splitRevisionId,
			},
			occurredAt,
		);
	});
}

// ============================================================================
// void (append VOID revision -- carries the previous evidence forward)
// ============================================================================

export async function voidSpendingFoodClassification(
	params: VoidSpendingFoodClassificationParams,
): Promise<SpendingFoodClassificationResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = normalizeSubject(params.subject);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	const ctx: ReconcileCtx = {
		userId,
		subject,
		operation: "VOID",
		expectedRevisionNo,
		foodHomeMarketAmount: "0.00",
		foodOutsideAmount: "0.00",
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await lockSubject(txdb, userId, subject);

		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		const latest = await latestRevisionForSubject(txdb, userId, subject);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
				"Spending subject is not food-classified; nothing to void",
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Expected food-classification revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}
		if (latest.operation === "VOID") {
			throw new BudgetError(
				"BUDGET_ALREADY_VOIDED",
				"Spending subject food classification is already voided",
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		return insertRevision(
			tx as unknown as Database,
			txdb,
			ctx,
			{
				revisionNo: expectedRevisionNo + 1,
				previousRevisionId: latest.id,
				operation: "VOID",
				// Carry the last approved basis + evidence forward unchanged.
				basisPersonalAmount: latest.basisPersonalAmount,
				foodHomeMarketAmount: "0.00",
				foodOutsideAmount: "0.00",
				purchaseEventRevisionId: latest.purchaseEventRevisionId,
				personObligationRevisionId: latest.personObligationRevisionId,
				splitBasis: latest.splitBasis as SpendingFoodSplitBasis | null,
				splitRevisionId: latest.splitRevisionId,
			},
			occurredAt,
		);
	});
}

// ============================================================================
// get (business-effective as-of read + staleness)
// ============================================================================

async function loadSubjectRevisions(
	db: Database,
	userId: string,
	subject: NormalizedSubject,
): Promise<Row[]> {
	return db
		.select()
		.from(budgetV2SpendingFoodSemanticRevisions)
		.where(
			and(
				eq(budgetV2SpendingFoodSemanticRevisions.userId, userId),
				subjectFilter(subject),
			),
		);
}

const UNCLASSIFIED = (
	subject: NormalizedSubject,
): SpendingFoodClassificationView => ({
	subjectType: subject.subjectType,
	subjectId: (subject.purchaseEventId ?? subject.personObligationId) as string,
	status: "UNCLASSIFIED",
	reason: null,
	semanticRevisionId: null,
	semanticRevisionNo: null,
	operation: null,
	sourceKind: null,
	basisPersonalAmount: null,
	currentPersonalEconomicAmount: null,
	foodHomeMarketAmount: null,
	foodOutsideAmount: null,
	foodTotalAmount: null,
	nonFoodAmount: null,
	classificationKind: null,
	occurredAt: null,
});

/**
 * The food classification effective for a spending subject as of `asOf`:
 * the highest `revisionNo` whose `occurredAt <= asOf` (Checkpoint 4B.2 rule).
 *
 * `status`:
 *  - UNCLASSIFIED  -- no effective revision, or the effective one is a VOID
 *  - SOURCE_VOID   -- the financial source is not economically active as of asOf
 *  - STALE         -- the effective revision's stored basis no longer matches
 *                     the source's authoritative personal economic amount
 *  - CLASSIFIED    -- stored basis still matches; the allocation is authoritative
 */
export async function getSpendingFoodClassificationAsOf(params: {
	db: Database;
	userId: string;
	subject: SpendingFoodSubjectRef;
	asOf?: Date | undefined;
}): Promise<SpendingFoodClassificationView> {
	const userId = normalizeUuid(params.userId, "userId");
	const subject = normalizeSubject(params.subject);
	const asOf =
		params.asOf instanceof Date && !Number.isNaN(params.asOf.getTime())
			? params.asOf
			: new Date();

	const revs = await loadSubjectRevisions(params.db, userId, subject);
	const eff = effectiveRevisionAsOf(
		revs.map((r) => ({ ...r, occurredAt: r.occurredAt })),
		asOf,
	);
	if (!eff || eff.operation === "VOID") {
		const base = UNCLASSIFIED(subject);
		if (eff && eff.operation === "VOID") {
			base.semanticRevisionId = eff.id;
			base.semanticRevisionNo = eff.revisionNo;
			base.operation = "VOID";
			base.occurredAt = eff.occurredAt.toISOString();
		}
		return base;
	}

	const source = await resolveSpendingFoodBasisAsOf({
		db: params.db,
		userId,
		subject: params.subject,
		asOf,
	});

	const basisCents = centsOf(eff.basisPersonalAmount);
	const homeCents = centsOf(eff.foodHomeMarketAmount);
	const outsideCents = centsOf(eff.foodOutsideAmount);
	const foodTotal = homeCents + outsideCents;

	let status: FoodClassificationStatus;
	let reason: string | null = null;
	let currentPersonalEconomicAmount: string | null = null;
	if (source.kind === "SOURCE_INACTIVE") {
		status = "SOURCE_VOID";
		reason = source.reason;
	} else if (source.kind === "UNRESOLVED") {
		status = "STALE";
		reason = source.reason;
	} else {
		currentPersonalEconomicAmount = source.basisPersonalAmount;
		if (source.basisPersonalCents === basisCents) {
			status = "CLASSIFIED";
		} else {
			status = "STALE";
			reason = `stored basis ${eff.basisPersonalAmount} no longer matches the source personal economic amount ${source.basisPersonalAmount} as of ${asOf.toISOString()}; require a new approved UPDATE`;
		}
	}

	return {
		subjectType: subject.subjectType,
		subjectId: (subject.purchaseEventId ??
			subject.personObligationId) as string,
		status,
		reason,
		semanticRevisionId: eff.id,
		semanticRevisionNo: eff.revisionNo,
		operation: eff.operation as "CREATE" | "UPDATE",
		sourceKind: eff.sourceKind as SpendingFoodSourceKind,
		basisPersonalAmount: parseAggregateMoneyString(eff.basisPersonalAmount)
			.normalized,
		currentPersonalEconomicAmount,
		foodHomeMarketAmount: parseAggregateMoneyString(eff.foodHomeMarketAmount)
			.normalized,
		foodOutsideAmount: parseAggregateMoneyString(eff.foodOutsideAmount)
			.normalized,
		foodTotalAmount: formatCentsToMoney(foodTotal),
		nonFoodAmount: formatCentsToMoney(basisCents - foodTotal),
		classificationKind: deriveFoodClassificationKind(
			basisCents,
			homeCents,
			outsideCents,
		),
		occurredAt: eff.occurredAt.toISOString(),
	};
}
