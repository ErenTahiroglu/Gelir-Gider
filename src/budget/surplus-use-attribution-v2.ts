import { and, desc, eq } from "drizzle-orm";
import { resolveAuthoritativePurchaseSplitAsOf } from "../credit-cards/purchase-split-read";
import type { Database } from "../db/client";
import { effectiveRevisionAsOf } from "../db/effective-revision";
import { shortTermGoalBudgetV2PurposeRevisions } from "../db/schema/budget-v2-semantics";
import {
	budgetV2SurplusUseAttributionRevisions,
	SURPLUS_USE_SOURCE_KINDS,
	type SurplusUseLane,
	type SurplusUseOperation,
	type SurplusUseSourceKind,
	type SurplusUseSubjectType,
} from "../db/schema/budget-v2-surplus-use";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	longTermSendTaskRevisions,
	longTermSendTasks,
} from "../db/schema/long-term";
import { midasAllocationTransfers } from "../db/schema/midas";
import {
	personObligationRevisions,
	personObligations,
} from "../db/schema/people";
import { shortTermGoals } from "../db/schema/short-term-goals";
import { getIstanbulCalendarDate } from "../income/calendar";
import {
	formatCentsToMoney,
	parseAggregateMoneyString,
	parseMoneyString,
} from "../ledger/money";
import { BudgetError } from "./errors";
import { calculateSurplusUseAttributionRevisionFingerprint } from "./semantic-fingerprint-v2";
import { normalizeUuid, validateBudgetPeriodMonth } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- SURPLUS-USE ATTRIBUTION write service + basis/staleness
 * read model (Checkpoint 5B).
 *
 * Append-only, USER-APPROVED. `create*` opens revision #1; `update*` appends an
 * OCC-guarded correction; `void*` removes the attribution from that instant
 * onward (the source becomes UNATTRIBUTED, NOT "0 current surplus").
 *
 * `resolveSurplusUseBasisAsOf` derives the exact authoritative source basis
 * from stored domain truth only; the write path stores that basis + evidence,
 * and the read path re-derives it to classify the attribution ATTRIBUTED /
 * UNATTRIBUTED / STALE / SOURCE_INACTIVE. Funding provenance is never inferred
 * from merchant / memo / amount / card / bank / timing / bucket balance /
 * destination label.
 */

// ============================================================================
// Public types
// ============================================================================

export type SurplusUseSubjectRef =
	| { type: "CREDIT_CARD_PURCHASE"; purchaseEventId: string }
	| { type: "PEOPLE_PAYABLE"; personObligationId: string }
	| { type: "MOBILITY_MIDAS_TRANSFER"; midasAllocationTransferId: string }
	| { type: "LONG_TERM_SEND_TASK"; longTermSendTaskId: string };

export type SurplusUseStatus =
	| "ATTRIBUTED"
	| "UNATTRIBUTED"
	| "STALE"
	| "SOURCE_INACTIVE";

export interface SurplusUseEvidence {
	purchaseEventRevisionId: string | null;
	purchaseSplitRevisionId: string | null;
	personObligationRevisionId: string | null;
	mobilityGoalId: string | null;
	mobilityPurposeRevisionId: string | null;
	longTermTaskRevisionId: string | null;
}

const EMPTY_EVIDENCE: SurplusUseEvidence = {
	purchaseEventRevisionId: null,
	purchaseSplitRevisionId: null,
	personObligationRevisionId: null,
	mobilityGoalId: null,
	mobilityPurposeRevisionId: null,
	longTermTaskRevisionId: null,
};

export type SurplusUseBasisResolution =
	| {
			kind: "ACTIVE";
			lane: SurplusUseLane;
			basisCents: bigint;
			basisAmount: string;
			/** economic-occurrence instant of the source (for period binding). */
			sourceOccurredAt: Date;
			evidence: SurplusUseEvidence;
	  }
	| { kind: "SOURCE_INACTIVE"; reason: string }
	| { kind: "UNRESOLVED"; reason: string };

export interface SurplusUseAttributionView {
	status: SurplusUseStatus;
	subjectType: SurplusUseSubjectType;
	subjectId: string;
	periodMonth: string;
	lane: SurplusUseLane | null;
	semanticRevisionId: string | null;
	semanticRevisionNo: number | null;
	storedBasisAmount: string | null;
	attributedCurrentSurplusAmount: string | null;
	otherFundingAmount: string | null;
	sourceKind: SurplusUseSourceKind | null;
	/** current authoritative source basis at asOf, when the source is active. */
	currentBasisAmount: string | null;
	reason: string | null;
}

// ============================================================================
// Validation
// ============================================================================

function centsOf(v: string): bigint {
	return parseAggregateMoneyString(v).cents;
}

function validateSubject(subject: unknown): SurplusUseSubjectRef {
	if (!subject || typeof subject !== "object") {
		throw new BudgetError("BUDGET_INVALID_INPUT", "subject is required");
	}
	const s = subject as { type?: unknown };
	switch (s.type) {
		case "CREDIT_CARD_PURCHASE":
			return {
				type: "CREDIT_CARD_PURCHASE",
				purchaseEventId: normalizeUuid(
					(subject as { purchaseEventId: unknown }).purchaseEventId,
					"purchaseEventId",
				),
			};
		case "PEOPLE_PAYABLE":
			return {
				type: "PEOPLE_PAYABLE",
				personObligationId: normalizeUuid(
					(subject as { personObligationId: unknown }).personObligationId,
					"personObligationId",
				),
			};
		case "MOBILITY_MIDAS_TRANSFER":
			return {
				type: "MOBILITY_MIDAS_TRANSFER",
				midasAllocationTransferId: normalizeUuid(
					(subject as { midasAllocationTransferId: unknown })
						.midasAllocationTransferId,
					"midasAllocationTransferId",
				),
			};
		case "LONG_TERM_SEND_TASK":
			return {
				type: "LONG_TERM_SEND_TASK",
				longTermSendTaskId: normalizeUuid(
					(subject as { longTermSendTaskId: unknown }).longTermSendTaskId,
					"longTermSendTaskId",
				),
			};
		default:
			throw new BudgetError(
				"BUDGET_SURPLUS_USE_SUBJECT_INVALID",
				`unknown surplus-use subject type ${String(s.type)}`,
			);
	}
}

function subjectId(subject: SurplusUseSubjectRef): string {
	switch (subject.type) {
		case "CREDIT_CARD_PURCHASE":
			return subject.purchaseEventId;
		case "PEOPLE_PAYABLE":
			return subject.personObligationId;
		case "MOBILITY_MIDAS_TRANSFER":
			return subject.midasAllocationTransferId;
		case "LONG_TERM_SEND_TASK":
			return subject.longTermSendTaskId;
	}
}

function laneForSubject(type: SurplusUseSubjectType): SurplusUseLane {
	if (type === "MOBILITY_MIDAS_TRANSFER") return "INTERNATIONAL_MOBILITY";
	if (type === "LONG_TERM_SEND_TASK") return "LONG_TERM_INVESTMENT";
	return "DISCRETIONARY";
}

function validateSourceKind(value: unknown): SurplusUseSourceKind {
	if (
		typeof value !== "string" ||
		!(SURPLUS_USE_SOURCE_KINDS as readonly string[]).includes(value)
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`sourceKind must be one of: ${SURPLUS_USE_SOURCE_KINDS.join(", ")}`,
		);
	}
	return value as SurplusUseSourceKind;
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

function validateNonNegativeMoney(value: string, field: string): bigint {
	let cents: bigint;
	try {
		cents = parseMoneyString(value).cents;
	} catch (e) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${field} must be a non-negative money string: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (cents < 0n) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${field} cannot be negative`,
		);
	}
	return cents;
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

function validateRequiredDate(value: unknown, field: string): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${field} must be a valid Date object`,
		);
	}
	return value;
}

function istanbulMonth(instant: Date): string {
	return `${getIstanbulCalendarDate(instant).slice(0, 7)}-01`;
}

// ============================================================================
// Basis resolution -- authoritative, as-of, per source domain
// ============================================================================

export async function resolveSurplusUseBasisAsOf(params: {
	db: Database;
	userId: string;
	subject: SurplusUseSubjectRef;
	asOf: Date;
}): Promise<SurplusUseBasisResolution> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = validateSubject(params.subject);
	const asOf = validateRequiredDate(params.asOf, "asOf");

	if (subject.type === "CREDIT_CARD_PURCHASE") {
		const [event] = await db
			.select({
				id: creditCardLiabilityEvents.id,
				userId: creditCardLiabilityEvents.userId,
				eventType: creditCardLiabilityEvents.eventType,
			})
			.from(creditCardLiabilityEvents)
			.where(eq(creditCardLiabilityEvents.id, subject.purchaseEventId))
			.limit(1);
		if (!event || event.userId !== userId || event.eventType !== "PURCHASE") {
			return {
				kind: "UNRESOLVED",
				reason: `purchase event ${subject.purchaseEventId} is not an owned PURCHASE liability event`,
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
			.where(
				eq(creditCardLiabilityEventRevisions.eventId, subject.purchaseEventId),
			);
		const eff = effectiveRevisionAsOf(revs, asOf);
		if (!eff) {
			return {
				kind: "UNRESOLVED",
				reason: `purchase event ${subject.purchaseEventId} has no effective revision as of the attribution instant`,
			};
		}
		if (eff.operation === "VOID") {
			return { kind: "SOURCE_INACTIVE", reason: "purchase event is VOID" };
		}
		const grossCents = centsOf(eff.amount);
		const split = await resolveAuthoritativePurchaseSplitAsOf({
			db,
			userId,
			purchaseEventId: subject.purchaseEventId,
			asOf,
			expectedPurchaseCents: grossCents,
		});
		let basisCents: bigint;
		let purchaseSplitRevisionId: string | null = null;
		if (split.kind === "NO_SPLIT" || split.kind === "VOID_SPLIT") {
			basisCents = grossCents;
		} else if (split.kind === "ACTIVE") {
			basisCents = split.userShareCents;
			purchaseSplitRevisionId = split.splitRevisionId;
		} else {
			return {
				kind: "UNRESOLVED",
				reason: `purchase ${subject.purchaseEventId} split is not authoritative (${split.reason})`,
			};
		}
		if (basisCents <= 0n) {
			return {
				kind: "UNRESOLVED",
				reason: `purchase ${subject.purchaseEventId} personal economic share is not positive`,
			};
		}
		return {
			kind: "ACTIVE",
			lane: "DISCRETIONARY",
			basisCents,
			basisAmount: formatCentsToMoney(basisCents),
			sourceOccurredAt: toDate(eff.occurredAt),
			evidence: {
				...EMPTY_EVIDENCE,
				purchaseEventRevisionId: eff.id,
				purchaseSplitRevisionId,
			},
		};
	}

	if (subject.type === "PEOPLE_PAYABLE") {
		const [obl] = await db
			.select({
				id: personObligations.id,
				userId: personObligations.userId,
				direction: personObligations.direction,
			})
			.from(personObligations)
			.where(eq(personObligations.id, subject.personObligationId))
			.limit(1);
		if (!obl || obl.userId !== userId || obl.direction !== "PAYABLE") {
			return {
				kind: "UNRESOLVED",
				reason: `obligation ${subject.personObligationId} is not an owned PAYABLE`,
			};
		}
		const revs = await db
			.select({
				id: personObligationRevisions.id,
				revisionNo: personObligationRevisions.revisionNo,
				operation: personObligationRevisions.operation,
				principal: personObligationRevisions.principalAmount,
				occurredAt: personObligationRevisions.occurredAt,
			})
			.from(personObligationRevisions)
			.where(
				eq(personObligationRevisions.obligationId, subject.personObligationId),
			);
		const eff = effectiveRevisionAsOf(revs, asOf);
		if (!eff) {
			return {
				kind: "UNRESOLVED",
				reason: `obligation ${subject.personObligationId} has no effective revision as of the attribution instant`,
			};
		}
		if (eff.operation === "VOID") {
			return { kind: "SOURCE_INACTIVE", reason: "People PAYABLE is VOID" };
		}
		const basisCents = centsOf(eff.principal);
		if (basisCents <= 0n) {
			return {
				kind: "UNRESOLVED",
				reason: `obligation ${subject.personObligationId} principal is not positive`,
			};
		}
		const create = revs.find((r) => r.revisionNo === 1) ?? eff;
		return {
			kind: "ACTIVE",
			lane: "DISCRETIONARY",
			basisCents,
			basisAmount: formatCentsToMoney(basisCents),
			sourceOccurredAt: toDate(create.occurredAt),
			evidence: { ...EMPTY_EVIDENCE, personObligationRevisionId: eff.id },
		};
	}

	if (subject.type === "MOBILITY_MIDAS_TRANSFER") {
		const [tr] = await db
			.select({
				id: midasAllocationTransfers.id,
				userId: midasAllocationTransfers.userId,
				fromBucketId: midasAllocationTransfers.fromBucketId,
				toBucketId: midasAllocationTransfers.toBucketId,
				amount: midasAllocationTransfers.amount,
				occurredAt: midasAllocationTransfers.occurredAt,
				reversalOfTransferId: midasAllocationTransfers.reversalOfTransferId,
			})
			.from(midasAllocationTransfers)
			.where(eq(midasAllocationTransfers.id, subject.midasAllocationTransferId))
			.limit(1);
		if (!tr || tr.userId !== userId) {
			return {
				kind: "UNRESOLVED",
				reason: `Midas transfer ${subject.midasAllocationTransferId} is not owned by this user`,
			};
		}
		if (tr.reversalOfTransferId !== null) {
			return {
				kind: "UNRESOLVED",
				reason: "Midas transfer is itself a reversal, not a new allocation",
			};
		}
		if (tr.fromBucketId !== null || tr.toBucketId === null) {
			return {
				kind: "UNRESOLVED",
				reason: "Midas transfer is not an UNALLOCATED -> bucket allocation",
			};
		}
		// reversal that makes the source inactive (occurred at-or-before asOf)
		const reversals = await db
			.select({
				id: midasAllocationTransfers.id,
				occurredAt: midasAllocationTransfers.occurredAt,
			})
			.from(midasAllocationTransfers)
			.where(
				and(
					eq(midasAllocationTransfers.userId, userId),
					eq(midasAllocationTransfers.reversalOfTransferId, tr.id),
				),
			);
		if (
			reversals.some((r) => toDate(r.occurredAt).getTime() <= asOf.getTime())
		) {
			return {
				kind: "SOURCE_INACTIVE",
				reason: "Midas allocation transfer was reversed",
			};
		}
		const [goal] = await db
			.select({ id: shortTermGoals.id, userId: shortTermGoals.userId })
			.from(shortTermGoals)
			.where(eq(shortTermGoals.midasBucketId, tr.toBucketId))
			.limit(1);
		if (!goal || goal.userId !== userId) {
			return {
				kind: "UNRESOLVED",
				reason:
					"Midas transfer target bucket is not an owned short-term-goal bucket",
			};
		}
		const purposeRevs = await db
			.select({
				id: shortTermGoalBudgetV2PurposeRevisions.id,
				revisionNo: shortTermGoalBudgetV2PurposeRevisions.revisionNo,
				purpose: shortTermGoalBudgetV2PurposeRevisions.purpose,
				occurredAt: shortTermGoalBudgetV2PurposeRevisions.occurredAt,
			})
			.from(shortTermGoalBudgetV2PurposeRevisions)
			.where(eq(shortTermGoalBudgetV2PurposeRevisions.goalId, goal.id));
		const purpose = effectiveRevisionAsOf(purposeRevs, asOf);
		if (purpose?.purpose !== "INTERNATIONAL_MOBILITY") {
			return {
				kind: "UNRESOLVED",
				reason: `goal ${goal.id} is not classified INTERNATIONAL_MOBILITY as of the attribution instant`,
			};
		}
		const basisCents = centsOf(tr.amount);
		return {
			kind: "ACTIVE",
			lane: "INTERNATIONAL_MOBILITY",
			basisCents,
			basisAmount: formatCentsToMoney(basisCents),
			sourceOccurredAt: toDate(tr.occurredAt),
			evidence: {
				...EMPTY_EVIDENCE,
				mobilityGoalId: goal.id,
				mobilityPurposeRevisionId: purpose.id,
			},
		};
	}

	// LONG_TERM_SEND_TASK
	const [task] = await db
		.select({
			id: longTermSendTasks.id,
			userId: longTermSendTasks.userId,
		})
		.from(longTermSendTasks)
		.where(eq(longTermSendTasks.id, subject.longTermSendTaskId))
		.limit(1);
	if (!task || task.userId !== userId) {
		return {
			kind: "UNRESOLVED",
			reason: `Long-Term task ${subject.longTermSendTaskId} is not owned by this user`,
		};
	}
	const taskRevs = await db
		.select({
			id: longTermSendTaskRevisions.id,
			revisionNo: longTermSendTaskRevisions.revisionNo,
			status: longTermSendTaskRevisions.status,
			amount: longTermSendTaskRevisions.amount,
			occurredAt: longTermSendTaskRevisions.occurredAt,
		})
		.from(longTermSendTaskRevisions)
		.where(eq(longTermSendTaskRevisions.taskId, subject.longTermSendTaskId));
	const eff = effectiveRevisionAsOf(taskRevs, asOf);
	if (!eff) {
		return {
			kind: "UNRESOLVED",
			reason: `Long-Term task ${subject.longTermSendTaskId} has no effective revision as of the attribution instant`,
		};
	}
	if (eff.status === "CANCELLED") {
		return {
			kind: "SOURCE_INACTIVE",
			reason: "Long-Term send task is CANCELLED",
		};
	}
	const create = taskRevs.find((r) => r.revisionNo === 1) ?? eff;
	const basisCents = centsOf(eff.amount);
	if (basisCents <= 0n) {
		return {
			kind: "UNRESOLVED",
			reason: `Long-Term task ${subject.longTermSendTaskId} amount is not positive`,
		};
	}
	return {
		kind: "ACTIVE",
		lane: "LONG_TERM_INVESTMENT",
		basisCents,
		basisAmount: formatCentsToMoney(basisCents),
		sourceOccurredAt: toDate(create.occurredAt),
		evidence: { ...EMPTY_EVIDENCE, longTermTaskRevisionId: eff.id },
	};
}

function toDate(v: Date | string): Date {
	return v instanceof Date ? v : new Date(v);
}

// ============================================================================
// Internal row helpers
// ============================================================================

type Row = typeof budgetV2SurplusUseAttributionRevisions.$inferSelect;

function subjectMatchColumns(subject: SurplusUseSubjectRef) {
	return {
		purchaseEventId:
			subject.type === "CREDIT_CARD_PURCHASE" ? subject.purchaseEventId : null,
		personObligationId:
			subject.type === "PEOPLE_PAYABLE" ? subject.personObligationId : null,
		midasAllocationTransferId:
			subject.type === "MOBILITY_MIDAS_TRANSFER"
				? subject.midasAllocationTransferId
				: null,
		longTermSendTaskId:
			subject.type === "LONG_TERM_SEND_TASK"
				? subject.longTermSendTaskId
				: null,
	};
}

async function findByIdempotencyKey(
	db: Database,
	userId: string,
	idempotencyKey: string,
): Promise<Row | undefined> {
	const [row] = await db
		.select()
		.from(budgetV2SurplusUseAttributionRevisions)
		.where(
			and(
				eq(budgetV2SurplusUseAttributionRevisions.userId, userId),
				eq(
					budgetV2SurplusUseAttributionRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);
	return row;
}

async function latestRevisionForSubject(
	db: Database,
	userId: string,
	subject: SurplusUseSubjectRef,
	periodMonth: string,
): Promise<Row | undefined> {
	const m = subjectMatchColumns(subject);
	const idCol =
		subject.type === "CREDIT_CARD_PURCHASE"
			? eq(
					budgetV2SurplusUseAttributionRevisions.purchaseEventId,
					m.purchaseEventId as string,
				)
			: subject.type === "PEOPLE_PAYABLE"
				? eq(
						budgetV2SurplusUseAttributionRevisions.personObligationId,
						m.personObligationId as string,
					)
				: subject.type === "MOBILITY_MIDAS_TRANSFER"
					? eq(
							budgetV2SurplusUseAttributionRevisions.midasAllocationTransferId,
							m.midasAllocationTransferId as string,
						)
					: eq(
							budgetV2SurplusUseAttributionRevisions.longTermSendTaskId,
							m.longTermSendTaskId as string,
						);
	const [row] = await db
		.select()
		.from(budgetV2SurplusUseAttributionRevisions)
		.where(
			and(
				eq(budgetV2SurplusUseAttributionRevisions.userId, userId),
				eq(budgetV2SurplusUseAttributionRevisions.periodMonth, periodMonth),
				idCol,
			),
		)
		.orderBy(desc(budgetV2SurplusUseAttributionRevisions.revisionNo))
		.limit(1);
	return row;
}

function toEvidence(row: Row): SurplusUseEvidence {
	return {
		purchaseEventRevisionId: row.purchaseEventRevisionId,
		purchaseSplitRevisionId: row.purchaseSplitRevisionId,
		personObligationRevisionId: row.personObligationRevisionId,
		mobilityGoalId: row.mobilityGoalId,
		mobilityPurposeRevisionId: row.mobilityPurposeRevisionId,
		longTermTaskRevisionId: row.longTermTaskRevisionId,
	};
}

async function fingerprintOfRow(
	row: Row,
	userId: string,
	subject: SurplusUseSubjectRef,
): Promise<string> {
	return calculateSurplusUseAttributionRevisionFingerprint({
		userId,
		periodMonth: row.periodMonth,
		subjectType: subject.type,
		purchaseEventId: row.purchaseEventId,
		personObligationId: row.personObligationId,
		midasAllocationTransferId: row.midasAllocationTransferId,
		longTermSendTaskId: row.longTermSendTaskId,
		operation: row.operation as SurplusUseOperation,
		revisionNo: row.revisionNo,
		previousRevisionId: row.previousRevisionId,
		lane: row.lane,
		basisAmount: row.basisAmount,
		currentSurplusAmount: row.currentSurplusAmount,
		sourceKind: row.sourceKind,
		purchaseEventRevisionId: row.purchaseEventRevisionId,
		purchaseSplitRevisionId: row.purchaseSplitRevisionId,
		personObligationRevisionId: row.personObligationRevisionId,
		mobilityGoalId: row.mobilityGoalId,
		mobilityPurposeRevisionId: row.mobilityPurposeRevisionId,
		longTermTaskRevisionId: row.longTermTaskRevisionId,
		occurredAt: toDate(row.occurredAt),
	});
}

// ============================================================================
// Result shape
// ============================================================================

export interface SurplusUseAttributionResult {
	revisionId: string;
	revisionNo: number;
	operation: SurplusUseOperation;
	subjectType: SurplusUseSubjectType;
	subjectId: string;
	periodMonth: string;
	lane: SurplusUseLane;
	basisAmount: string;
	currentSurplusAmount: string;
	otherFundingAmount: string;
	sourceKind: SurplusUseSourceKind;
	occurredAt: string;
	idempotentReplay: boolean;
}

function toResult(
	row: Row,
	subject: SurplusUseSubjectRef,
	idempotentReplay: boolean,
): SurplusUseAttributionResult {
	const basisC = centsOf(row.basisAmount);
	const currentC = centsOf(row.currentSurplusAmount);
	return {
		revisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as SurplusUseOperation,
		subjectType: subject.type,
		subjectId: subjectId(subject),
		periodMonth: row.periodMonth,
		lane: row.lane as SurplusUseLane,
		basisAmount: row.basisAmount,
		currentSurplusAmount: row.currentSurplusAmount,
		otherFundingAmount: formatCentsToMoney(basisC - currentC),
		sourceKind: row.sourceKind as SurplusUseSourceKind,
		occurredAt: toDate(row.occurredAt).toISOString(),
		idempotentReplay,
	};
}

// ============================================================================
// create
// ============================================================================

export interface CreateSurplusUseAttributionParams {
	db: Database;
	userId: string;
	subject: SurplusUseSubjectRef;
	periodMonth: string;
	currentSurplusAmount: string;
	sourceKind: SurplusUseSourceKind;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export async function createSurplusUseAttribution(
	params: CreateSurplusUseAttributionParams,
): Promise<SurplusUseAttributionResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = validateSubject(params.subject);
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const currentSurplusCents = validateNonNegativeMoney(
		params.currentSurplusAmount,
		"currentSurplusAmount",
	);
	const currentSurplusAmount = formatCentsToMoney(currentSurplusCents);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) {
		return replayReconcile(existing, {
			userId,
			subject,
			periodMonth,
			operation: "CREATE",
			currentSurplusAmount,
			sourceKind,
			expectedRevisionNo: undefined,
			idempotencyKey,
		});
	}

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await lockSubjectAnchor(txdb, subject);
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) {
			return replayReconcile(raced, {
				userId,
				subject,
				periodMonth,
				operation: "CREATE",
				currentSurplusAmount,
				sourceKind,
				expectedRevisionNo: undefined,
				idempotencyKey,
			});
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const basis = await resolveSurplusUseBasisAsOf({
			db: txdb,
			userId,
			subject,
			asOf: occurredAt,
		});
		assertBasisActive(basis);
		assertPeriodBinding(basis, periodMonth);
		if (currentSurplusCents > basis.basisCents) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`currentSurplusAmount ${currentSurplusAmount} exceeds the authoritative source basis ${basis.basisAmount}`,
			);
		}

		const latest = await latestRevisionForSubject(
			txdb,
			userId,
			subject,
			periodMonth,
		);
		if (latest) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`a surplus-use attribution already exists for this subject in ${periodMonth} (revision ${latest.revisionNo}); use updateSurplusUseAttribution`,
			);
		}

		return insertRevision(tx, txdb, {
			userId,
			subject,
			periodMonth,
			operation: "CREATE",
			revisionNo: 1,
			previousRevisionId: null,
			lane: basis.lane,
			basisAmount: basis.basisAmount,
			currentSurplusAmount,
			sourceKind,
			evidence: basis.evidence,
			occurredAt,
			idempotencyKey,
			ctxCurrentSurplusAmount: currentSurplusAmount,
			ctxExpectedRevisionNo: undefined,
		});
	});
}

// ============================================================================
// update
// ============================================================================

export interface UpdateSurplusUseAttributionParams
	extends CreateSurplusUseAttributionParams {
	expectedRevisionNo: number;
}

export async function updateSurplusUseAttribution(
	params: UpdateSurplusUseAttributionParams,
): Promise<SurplusUseAttributionResult> {
	const { db, expectedRevisionNo } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = validateSubject(params.subject);
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const currentSurplusCents = validateNonNegativeMoney(
		params.currentSurplusAmount,
		"currentSurplusAmount",
	);
	const currentSurplusAmount = formatCentsToMoney(currentSurplusCents);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) {
		return replayReconcile(existing, {
			userId,
			subject,
			periodMonth,
			operation: "UPDATE",
			currentSurplusAmount,
			sourceKind,
			expectedRevisionNo,
			idempotencyKey,
		});
	}

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await lockSubjectAnchor(txdb, subject);
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) {
			return replayReconcile(raced, {
				userId,
				subject,
				periodMonth,
				operation: "UPDATE",
				currentSurplusAmount,
				sourceKind,
				expectedRevisionNo,
				idempotencyKey,
			});
		}

		const latest = await latestRevisionForSubject(
			txdb,
			userId,
			subject,
			periodMonth,
		);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"no surplus-use attribution to update for this subject/period; use createSurplusUseAttribution",
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`expected surplus-use attribution revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const basis = await resolveSurplusUseBasisAsOf({
			db: txdb,
			userId,
			subject,
			asOf: occurredAt,
		});
		assertBasisActive(basis);
		assertPeriodBinding(basis, periodMonth);
		if (currentSurplusCents > basis.basisCents) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`currentSurplusAmount ${currentSurplusAmount} exceeds the authoritative source basis ${basis.basisAmount}`,
			);
		}

		return insertRevision(tx, txdb, {
			userId,
			subject,
			periodMonth,
			operation: "UPDATE",
			revisionNo: expectedRevisionNo + 1,
			previousRevisionId: latest.id,
			lane: basis.lane,
			basisAmount: basis.basisAmount,
			currentSurplusAmount,
			sourceKind,
			evidence: basis.evidence,
			occurredAt,
			idempotencyKey,
			ctxCurrentSurplusAmount: currentSurplusAmount,
			ctxExpectedRevisionNo: expectedRevisionNo,
		});
	});
}

// ============================================================================
// void
// ============================================================================

export interface VoidSurplusUseAttributionParams {
	db: Database;
	userId: string;
	subject: SurplusUseSubjectRef;
	periodMonth: string;
	expectedRevisionNo: number;
	sourceKind: SurplusUseSourceKind;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export async function voidSurplusUseAttribution(
	params: VoidSurplusUseAttributionParams,
): Promise<SurplusUseAttributionResult> {
	const { db, expectedRevisionNo } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = validateSubject(params.subject);
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) {
		return replayReconcile(existing, {
			userId,
			subject,
			periodMonth,
			operation: "VOID",
			currentSurplusAmount: "0.00",
			sourceKind,
			expectedRevisionNo,
			idempotencyKey,
		});
	}

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await lockSubjectAnchor(txdb, subject);
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) {
			return replayReconcile(raced, {
				userId,
				subject,
				periodMonth,
				operation: "VOID",
				currentSurplusAmount: "0.00",
				sourceKind,
				expectedRevisionNo,
				idempotencyKey,
			});
		}

		const latest = await latestRevisionForSubject(
			txdb,
			userId,
			subject,
			periodMonth,
		);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"no surplus-use attribution to void for this subject/period",
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`expected surplus-use attribution revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}
		if (latest.operation === "VOID") {
			throw new BudgetError(
				"BUDGET_ALREADY_VOIDED",
				"the surplus-use attribution is already voided",
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		// A VOID carries the prior basis + evidence forward with 0 current surplus.
		return insertRevision(tx, txdb, {
			userId,
			subject,
			periodMonth,
			operation: "VOID",
			revisionNo: expectedRevisionNo + 1,
			previousRevisionId: latest.id,
			lane: latest.lane as SurplusUseLane,
			basisAmount: latest.basisAmount,
			currentSurplusAmount: "0.00",
			sourceKind,
			evidence: toEvidence(latest),
			occurredAt,
			idempotencyKey,
			ctxCurrentSurplusAmount: "0.00",
			ctxExpectedRevisionNo: expectedRevisionNo,
		});
	});
}

// ============================================================================
// shared write internals
// ============================================================================

async function lockSubjectAnchor(
	txdb: Database,
	subject: SurplusUseSubjectRef,
): Promise<void> {
	if (subject.type === "CREDIT_CARD_PURCHASE") {
		const [r] = await txdb
			.select({ id: creditCardLiabilityEvents.id })
			.from(creditCardLiabilityEvents)
			.where(eq(creditCardLiabilityEvents.id, subject.purchaseEventId))
			.for("update");
		if (!r) subjectNotFound("purchase event", subject.purchaseEventId);
	} else if (subject.type === "PEOPLE_PAYABLE") {
		const [r] = await txdb
			.select({ id: personObligations.id })
			.from(personObligations)
			.where(eq(personObligations.id, subject.personObligationId))
			.for("update");
		if (!r) subjectNotFound("People obligation", subject.personObligationId);
	} else if (subject.type === "MOBILITY_MIDAS_TRANSFER") {
		const [r] = await txdb
			.select({ id: midasAllocationTransfers.id })
			.from(midasAllocationTransfers)
			.where(eq(midasAllocationTransfers.id, subject.midasAllocationTransferId))
			.for("update");
		if (!r)
			subjectNotFound("Midas transfer", subject.midasAllocationTransferId);
	} else {
		const [r] = await txdb
			.select({ id: longTermSendTasks.id })
			.from(longTermSendTasks)
			.where(eq(longTermSendTasks.id, subject.longTermSendTaskId))
			.for("update");
		if (!r) subjectNotFound("Long-Term task", subject.longTermSendTaskId);
	}
}

function subjectNotFound(label: string, id: string): never {
	throw new BudgetError(
		"BUDGET_SURPLUS_USE_SUBJECT_INVALID",
		`${label} ${id} does not exist for this user`,
	);
}

function assertBasisActive(
	basis: SurplusUseBasisResolution,
): asserts basis is Extract<SurplusUseBasisResolution, { kind: "ACTIVE" }> {
	if (basis.kind === "SOURCE_INACTIVE") {
		throw new BudgetError("BUDGET_SURPLUS_USE_SOURCE_INACTIVE", basis.reason);
	}
	if (basis.kind === "UNRESOLVED") {
		throw new BudgetError("BUDGET_SURPLUS_USE_SUBJECT_INVALID", basis.reason);
	}
}

function assertPeriodBinding(
	basis: Extract<SurplusUseBasisResolution, { kind: "ACTIVE" }>,
	periodMonth: string,
): void {
	const sourceMonth = istanbulMonth(basis.sourceOccurredAt);
	if (sourceMonth !== periodMonth) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`the source's economic occurrence is in ${sourceMonth}, not the requested period ${periodMonth}`,
		);
	}
}

interface InsertCtx {
	userId: string;
	subject: SurplusUseSubjectRef;
	periodMonth: string;
	operation: SurplusUseOperation;
	revisionNo: number;
	previousRevisionId: string | null;
	lane: SurplusUseLane;
	basisAmount: string;
	currentSurplusAmount: string;
	sourceKind: SurplusUseSourceKind;
	evidence: SurplusUseEvidence;
	occurredAt: Date;
	idempotencyKey: string;
	ctxCurrentSurplusAmount: string;
	ctxExpectedRevisionNo: number | undefined;
}

async function insertRevision(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle tx
	tx: any,
	txdb: Database,
	ctx: InsertCtx,
): Promise<SurplusUseAttributionResult> {
	const m = subjectMatchColumns(ctx.subject);
	const fingerprint = await calculateSurplusUseAttributionRevisionFingerprint({
		userId: ctx.userId,
		periodMonth: ctx.periodMonth,
		subjectType: ctx.subject.type,
		purchaseEventId: m.purchaseEventId,
		personObligationId: m.personObligationId,
		midasAllocationTransferId: m.midasAllocationTransferId,
		longTermSendTaskId: m.longTermSendTaskId,
		operation: ctx.operation,
		revisionNo: ctx.revisionNo,
		previousRevisionId: ctx.previousRevisionId,
		lane: ctx.lane,
		basisAmount: ctx.basisAmount,
		currentSurplusAmount: ctx.currentSurplusAmount,
		sourceKind: ctx.sourceKind,
		purchaseEventRevisionId: ctx.evidence.purchaseEventRevisionId,
		purchaseSplitRevisionId: ctx.evidence.purchaseSplitRevisionId,
		personObligationRevisionId: ctx.evidence.personObligationRevisionId,
		mobilityGoalId: ctx.evidence.mobilityGoalId,
		mobilityPurposeRevisionId: ctx.evidence.mobilityPurposeRevisionId,
		longTermTaskRevisionId: ctx.evidence.longTermTaskRevisionId,
		occurredAt: ctx.occurredAt,
	});

	const [inserted] = await tx
		.insert(budgetV2SurplusUseAttributionRevisions)
		.values({
			userId: ctx.userId,
			periodMonth: ctx.periodMonth,
			subjectType: ctx.subject.type,
			purchaseEventId: m.purchaseEventId,
			personObligationId: m.personObligationId,
			midasAllocationTransferId: m.midasAllocationTransferId,
			longTermSendTaskId: m.longTermSendTaskId,
			revisionNo: ctx.revisionNo,
			previousRevisionId: ctx.previousRevisionId,
			operation: ctx.operation,
			lane: ctx.lane,
			basisAmount: ctx.basisAmount,
			currentSurplusAmount: ctx.currentSurplusAmount,
			sourceKind: ctx.sourceKind,
			purchaseEventRevisionId: ctx.evidence.purchaseEventRevisionId,
			purchaseSplitRevisionId: ctx.evidence.purchaseSplitRevisionId,
			personObligationRevisionId: ctx.evidence.personObligationRevisionId,
			mobilityGoalId: ctx.evidence.mobilityGoalId,
			mobilityPurposeRevisionId: ctx.evidence.mobilityPurposeRevisionId,
			longTermTaskRevisionId: ctx.evidence.longTermTaskRevisionId,
			idempotencyKey: ctx.idempotencyKey,
			revisionFingerprint: fingerprint,
			occurredAt: ctx.occurredAt,
		})
		.onConflictDoNothing({
			target: [
				budgetV2SurplusUseAttributionRevisions.userId,
				budgetV2SurplusUseAttributionRevisions.idempotencyKey,
			],
		})
		.returning();
	if (inserted) return toResult(inserted as Row, ctx.subject, false);

	const afterConflict = await findByIdempotencyKey(
		txdb,
		ctx.userId,
		ctx.idempotencyKey,
	);
	if (!afterConflict) {
		throw new BudgetError(
			"BUDGET_INVALID_STATE",
			"surplus-use attribution idempotency key conflicted but no row is visible",
		);
	}
	return replayReconcile(afterConflict, {
		userId: ctx.userId,
		subject: ctx.subject,
		periodMonth: ctx.periodMonth,
		operation: ctx.operation,
		currentSurplusAmount: ctx.ctxCurrentSurplusAmount,
		sourceKind: ctx.sourceKind,
		expectedRevisionNo: ctx.ctxExpectedRevisionNo,
		idempotencyKey: ctx.idempotencyKey,
	});
}

interface ReconcileCtx {
	userId: string;
	subject: SurplusUseSubjectRef;
	periodMonth: string;
	operation: SurplusUseOperation;
	currentSurplusAmount: string;
	sourceKind: SurplusUseSourceKind;
	expectedRevisionNo: number | undefined;
	idempotencyKey: string;
}

async function replayReconcile(
	existing: Row,
	ctx: ReconcileCtx,
): Promise<SurplusUseAttributionResult> {
	const storedFp = await fingerprintOfRow(existing, ctx.userId, ctx.subject);
	const m = subjectMatchColumns(ctx.subject);
	const positionOk =
		ctx.operation === "CREATE"
			? existing.revisionNo === 1 && existing.previousRevisionId === null
			: existing.revisionNo === (ctx.expectedRevisionNo ?? -1) + 1 &&
				existing.previousRevisionId !== null;
	const exact =
		existing.userId === ctx.userId &&
		existing.periodMonth === ctx.periodMonth &&
		existing.subjectType === ctx.subject.type &&
		existing.purchaseEventId === m.purchaseEventId &&
		existing.personObligationId === m.personObligationId &&
		existing.midasAllocationTransferId === m.midasAllocationTransferId &&
		existing.longTermSendTaskId === m.longTermSendTaskId &&
		existing.operation === ctx.operation &&
		existing.currentSurplusAmount === ctx.currentSurplusAmount &&
		existing.sourceKind === ctx.sourceKind &&
		positionOk &&
		existing.revisionFingerprint === storedFp;
	if (!exact) {
		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`idempotency key "${ctx.idempotencyKey}" was already used with different surplus-use attribution parameters`,
		);
	}
	return toResult(existing, ctx.subject, true);
}

// ============================================================================
// getSurplusUseAttributionAsOf -- basis / staleness read model
// ============================================================================

export async function getSurplusUseAttributionAsOf(params: {
	db: Database;
	userId: string;
	subject: SurplusUseSubjectRef;
	periodMonth: string;
	asOf: Date;
}): Promise<SurplusUseAttributionView> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const subject = validateSubject(params.subject);
	const periodMonth = validateBudgetPeriodMonth(params.periodMonth);
	const asOf = validateRequiredDate(params.asOf, "asOf");
	const sid = subjectId(subject);

	const rows = await selectSubjectRevisions(db, userId, subject, periodMonth);
	const eff = effectiveRevisionAsOf(
		rows.map((r) => ({
			...r,
			occurredAt: toDate(r.occurredAt),
		})),
		asOf,
	);

	const basis = await resolveSurplusUseBasisAsOf({ db, userId, subject, asOf });

	// No effective semantic revision, or the effective one is a VOID -> UNATTRIBUTED
	if (!eff || eff.operation === "VOID") {
		return {
			status: "UNATTRIBUTED",
			subjectType: subject.type,
			subjectId: sid,
			periodMonth,
			lane: laneForSubject(subject.type),
			semanticRevisionId: eff ? eff.id : null,
			semanticRevisionNo: eff ? eff.revisionNo : null,
			storedBasisAmount: null,
			attributedCurrentSurplusAmount: null,
			otherFundingAmount: null,
			sourceKind: null,
			currentBasisAmount: basis.kind === "ACTIVE" ? basis.basisAmount : null,
			reason: eff ? "the effective attribution revision is a VOID" : null,
		};
	}

	if (basis.kind === "SOURCE_INACTIVE") {
		return {
			status: "SOURCE_INACTIVE",
			subjectType: subject.type,
			subjectId: sid,
			periodMonth,
			lane: eff.lane as SurplusUseLane,
			semanticRevisionId: eff.id,
			semanticRevisionNo: eff.revisionNo,
			storedBasisAmount: eff.basisAmount,
			attributedCurrentSurplusAmount: eff.currentSurplusAmount,
			otherFundingAmount: formatCentsToMoney(
				centsOf(eff.basisAmount) - centsOf(eff.currentSurplusAmount),
			),
			sourceKind: eff.sourceKind as SurplusUseSourceKind,
			currentBasisAmount: null,
			reason: basis.reason,
		};
	}

	// UNRESOLVED (source exists but not authoritative now, e.g. unsealed split,
	// mobility purpose no longer INTERNATIONAL_MOBILITY) -> STALE
	if (basis.kind === "UNRESOLVED") {
		return staleView(subject, sid, periodMonth, eff, null, basis.reason);
	}

	// ACTIVE -- compare stored basis / evidence against current authoritative truth
	const storedBasisCents = centsOf(eff.basisAmount);
	if (storedBasisCents !== basis.basisCents) {
		return staleView(
			subject,
			sid,
			periodMonth,
			eff,
			basis.basisAmount,
			`stored basis ${eff.basisAmount} no longer matches the authoritative source basis ${basis.basisAmount}`,
		);
	}
	if (
		subject.type === "MOBILITY_MIDAS_TRANSFER" &&
		eff.mobilityPurposeRevisionId !== basis.evidence.mobilityPurposeRevisionId
	) {
		return staleView(
			subject,
			sid,
			periodMonth,
			eff,
			basis.basisAmount,
			"the mobility goal purpose classification has been superseded",
		);
	}

	return {
		status: "ATTRIBUTED",
		subjectType: subject.type,
		subjectId: sid,
		periodMonth,
		lane: eff.lane as SurplusUseLane,
		semanticRevisionId: eff.id,
		semanticRevisionNo: eff.revisionNo,
		storedBasisAmount: eff.basisAmount,
		attributedCurrentSurplusAmount: eff.currentSurplusAmount,
		otherFundingAmount: formatCentsToMoney(
			storedBasisCents - centsOf(eff.currentSurplusAmount),
		),
		sourceKind: eff.sourceKind as SurplusUseSourceKind,
		currentBasisAmount: basis.basisAmount,
		reason: null,
	};
}

function staleView(
	subject: SurplusUseSubjectRef,
	sid: string,
	periodMonth: string,
	eff: Row,
	currentBasisAmount: string | null,
	reason: string,
): SurplusUseAttributionView {
	return {
		status: "STALE",
		subjectType: subject.type,
		subjectId: sid,
		periodMonth,
		lane: eff.lane as SurplusUseLane,
		semanticRevisionId: eff.id,
		semanticRevisionNo: eff.revisionNo,
		storedBasisAmount: eff.basisAmount,
		attributedCurrentSurplusAmount: eff.currentSurplusAmount,
		otherFundingAmount: formatCentsToMoney(
			centsOf(eff.basisAmount) - centsOf(eff.currentSurplusAmount),
		),
		sourceKind: eff.sourceKind as SurplusUseSourceKind,
		currentBasisAmount,
		reason,
	};
}

async function selectSubjectRevisions(
	db: Database,
	userId: string,
	subject: SurplusUseSubjectRef,
	periodMonth: string,
): Promise<Row[]> {
	const m = subjectMatchColumns(subject);
	const idCol =
		subject.type === "CREDIT_CARD_PURCHASE"
			? eq(
					budgetV2SurplusUseAttributionRevisions.purchaseEventId,
					m.purchaseEventId as string,
				)
			: subject.type === "PEOPLE_PAYABLE"
				? eq(
						budgetV2SurplusUseAttributionRevisions.personObligationId,
						m.personObligationId as string,
					)
				: subject.type === "MOBILITY_MIDAS_TRANSFER"
					? eq(
							budgetV2SurplusUseAttributionRevisions.midasAllocationTransferId,
							m.midasAllocationTransferId as string,
						)
					: eq(
							budgetV2SurplusUseAttributionRevisions.longTermSendTaskId,
							m.longTermSendTaskId as string,
						);
	return db
		.select()
		.from(budgetV2SurplusUseAttributionRevisions)
		.where(
			and(
				eq(budgetV2SurplusUseAttributionRevisions.userId, userId),
				eq(budgetV2SurplusUseAttributionRevisions.periodMonth, periodMonth),
				idCol,
			),
		);
}
