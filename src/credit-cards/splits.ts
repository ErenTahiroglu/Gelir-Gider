import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
	Database,
	DatabaseOrTransaction,
	DatabaseTransaction,
} from "../db/client";
import {
	type CreditCardPurchaseBudgetCategory,
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
	mapPurchaseCategoryToSystemRole,
} from "../db/schema/credit-card-ledger";
import {
	creditCardPurchaseSplitParticipants,
	creditCardPurchaseSplitRevisionItems,
	creditCardPurchaseSplitRevisionSeals,
	creditCardPurchaseSplitRevisions,
	creditCardPurchaseSplits,
	type SplitMethod,
} from "../db/schema/credit-card-splits";
import { creditCardRevisions, creditCards } from "../db/schema/credit-cards";
import {
	people,
	personObligationRevisions,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { formatCentsToMoney, parsePositiveMoneyString } from "../ledger/money";
import { ensureUserExpenseSystemAccountsInTransaction } from "../ledger/system-expense-accounts";
import {
	createSplitObligationInTransaction,
	updateSplitObligationInTransaction,
	voidSplitObligationInTransaction,
} from "../people/obligations";
import {
	runCreditCardReadTransaction,
	runCreditCardTransaction,
} from "./boundary";
import {
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateGregorianDateString,
} from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateSplitCreateFingerprint,
	calculateSplitUpdateFingerprint,
	calculateSplitVoidFingerprint,
	deriveCreditCardSplitChildIdempotencyKey,
	type SplitParticipantItemFingerprint,
} from "./fingerprint";
import {
	calculateEqualSplit,
	calculateManualSplit,
	calculateRatioSplit,
	type EqualParticipantInput,
	type ManualParticipantInput,
	type RatioParticipantInput,
	type SplitCalculationResult,
} from "./split-allocation";

// ============================================================================
// Public Read Models
// ============================================================================

export interface CreditCardPurchaseSplitParticipantReadModel {
	participantId: string;
	personId: string;
	displayName: string;
	relationship: string;
	shareAmount: string;
	settledAmount: string;
	remainingAmount: string;
	weight: number | null;
	dueDate: string | null;
	description: string | null;
	personObligationId: string;
}

export interface CreditCardPurchaseSplitReadModel {
	splitId: string;
	userId: string;
	purchaseEventId: string;
	status: "ACTIVE" | "VOID";
	revisionNo: number;
	method: SplitMethod;
	grossAmount: string;
	userShareAmount: string;
	externalShareAmount: string;
	userWeight: number | null;
	occurredAt: Date;
	createdAt: Date;
	participants: CreditCardPurchaseSplitParticipantReadModel[];
}

// ============================================================================
// Input Parameters
// ============================================================================

export interface ParticipantAllocationInput {
	personId: string;
	shareAmount?: string | undefined;
	weight?: number | undefined;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
}

export interface CreateCreditCardPurchaseSplitParams {
	db: Database;
	userId: string;
	purchaseEventId: string;
	method: SplitMethod;
	userWeight?: number | undefined;
	participants: ParticipantAllocationInput[];
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface UpdateCreditCardPurchaseSplitParams {
	db: Database;
	userId: string;
	splitId: string;
	expectedRevisionNo: number;
	method: SplitMethod;
	userWeight?: number | undefined;
	participants: ParticipantAllocationInput[];
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface VoidCreditCardPurchaseSplitParams {
	db: Database;
	userId: string;
	splitId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface GetCreditCardPurchaseSplitParams {
	db: Database;
	userId: string;
	splitId?: string | undefined;
	purchaseEventId?: string | undefined;
}

export interface ListCreditCardPurchaseSplitsParams {
	db: Database;
	userId: string;
	cardId?: string | undefined;
	purchaseEventId?: string | undefined;
	status?: "ACTIVE" | "VOID" | undefined;
	personId?: string | undefined;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateUserId(value: string): string {
	return validateCcCanonicalUuid(value, "userId");
}

function validatePurchaseEventId(value: string): string {
	return validateCcCanonicalUuid(value, "purchaseEventId");
}

function validateSplitId(value: string): string {
	return validateCcCanonicalUuid(value, "splitId");
}

function validateIdempotencyKey(value: string): string {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

function validateSplitMethod(value: string): SplitMethod {
	const upper = value?.trim().toUpperCase();
	if (upper !== "EQUAL" && upper !== "MANUAL" && upper !== "RATIO") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid split method: "${value}". Must be EQUAL, MANUAL, or RATIO`,
		);
	}
	return upper as SplitMethod;
}

/**
 * Validates and normalizes an optional participant dueDate. undefined/null
 * means omitted; a supplied value must be a strict YYYY-MM-DD Gregorian date
 * string (rejects "", whitespace, non-zero-padded months/days, and invalid
 * calendar dates like 2026-02-30 -- raw `new Date(string)` is never used).
 */
export function validateParticipantDueDate(
	value: string | null | undefined,
): string | null {
	if (value === undefined || value === null) return null;
	return validateGregorianDateString(value, "dueDate");
}

/**
 * Validates and normalizes an optional participant description. null/
 * undefined means omitted. A supplied value is trimmed; a whitespace-only
 * or empty result normalizes to null (same rule used for storage and for
 * fingerprint canonicalization so both agree); a non-empty trimmed value
 * must be between 1 and 500 characters.
 */
export function validateParticipantDescription(
	value: string | null | undefined,
): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Participant description must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > 500) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Participant description must be at most 500 characters",
		);
	}
	return trimmed;
}

export interface NormalizedParticipantInput {
	personId: string;
	shareAmount?: string | undefined;
	weight?: number | undefined;
	dueDate: string | null;
	description: string | null;
}

/**
 * Validates the participants array shape and normalizes each participant's
 * personId (canonical lowercase UUID), dueDate, and description BEFORE any
 * DB query or allocation math, so the normalized values are used identically
 * for duplicate detection, allocation ordering, fingerprints, DB queries, and
 * payloads.
 */
export function validateParticipantsInput(
	participants: unknown,
): NormalizedParticipantInput[] {
	if (!Array.isArray(participants)) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"participants must be an array",
		);
	}
	if (participants.length < 1 || participants.length > 9) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`participants must contain between 1 and 9 entries (got ${participants.length})`,
		);
	}

	return participants.map((raw, index) => {
		if (typeof raw !== "object" || raw === null) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`participants[${index}] must be an object`,
			);
		}
		const p = raw as ParticipantAllocationInput;
		const personId = validateCcCanonicalUuid(
			p.personId,
			`participants[${index}].personId`,
		);
		return {
			personId,
			shareAmount: p.shareAmount,
			weight: p.weight,
			dueDate: validateParticipantDueDate(p.dueDate),
			description: validateParticipantDescription(p.description),
		};
	});
}

// ============================================================================
// Internal Helpers
// ============================================================================

async function getLatestPurchaseRevisionInTransaction(
	tx: DatabaseTransaction,
	purchaseEventId: string,
) {
	const [latest] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, purchaseEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);
	return latest ?? null;
}

async function getLatestSplitRevisionInTransaction(
	tx: DatabaseTransaction,
	splitId: string,
) {
	const [latest] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(eq(creditCardPurchaseSplitRevisions.splitId, splitId))
		.orderBy(desc(creditCardPurchaseSplitRevisions.revisionNo))
		.limit(1);
	return latest ?? null;
}

async function lockCardAndVerifyActive(
	tx: DatabaseTransaction,
	userId: string,
	cardId: string,
) {
	const [card] = await tx
		.select()
		.from(creditCards)
		.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${cardId}" not found`,
		);
	}

	const [latestRev] = await tx
		.select()
		.from(creditCardRevisions)
		.where(eq(creditCardRevisions.creditCardId, cardId))
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (latestRev?.operation === "ARCHIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${cardId}" is archived`,
		);
	}
}

async function lockPeopleAndVerifyActive(
	tx: DatabaseTransaction,
	userId: string,
	personIds: string[],
) {
	if (personIds.length === 0) return;

	// Deterministic lock order: ORDER BY id ASC
	const sortedPersonIds = [...new Set(personIds)].sort();

	const rows = await tx
		.select({ id: people.id })
		.from(people)
		.where(and(eq(people.userId, userId), inArray(people.id, sortedPersonIds)))
		.orderBy(asc(people.id))
		.for("update");

	if (rows.length !== sortedPersonIds.length) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"One or more selected people do not exist",
		);
	}

	for (const personId of sortedPersonIds) {
		const [latestPersonRev] = await tx
			.select({ status: personRevisions.status })
			.from(personRevisions)
			.where(eq(personRevisions.personId, personId))
			.orderBy(desc(personRevisions.revisionNo))
			.limit(1);

		if (latestPersonRev?.status !== "ACTIVE") {
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_CONFLICT",
				`Selected person "${personId}" is not active`,
			);
		}
	}
}

async function resolveExpenseAccountIdForPurchase(
	tx: DatabaseTransaction,
	userId: string,
	budgetCategory: string | null,
): Promise<string> {
	const category = (budgetCategory ??
		"UNCLASSIFIED") as CreditCardPurchaseBudgetCategory;
	const role = mapPurchaseCategoryToSystemRole(category);
	const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
		tx,
		userId,
	);
	return systemAccounts[role];
}

// ============================================================================
// Core Allocation Calculation Wrapper
// ============================================================================

function calculateAllocations(params: {
	method: SplitMethod;
	grossAmount: bigint;
	userWeight?: number | undefined;
	participants: NormalizedParticipantInput[];
}): SplitCalculationResult {
	const { method, grossAmount, userWeight, participants } = params;

	if (method === "EQUAL") {
		const equalInputs: EqualParticipantInput[] = participants.map((p) => ({
			personId: p.personId,
			dueDate: p.dueDate ? new Date(`${p.dueDate}T00:00:00.000Z`) : null,
			description: p.description,
		}));
		return calculateEqualSplit({ grossAmount, participants: equalInputs });
	}

	if (method === "MANUAL") {
		const manualInputs: ManualParticipantInput[] = participants.map((p) => {
			if (!p.shareAmount) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					`shareAmount is required for MANUAL split (person ${p.personId})`,
				);
			}
			const parsed = parsePositiveMoneyString(p.shareAmount);
			return {
				personId: p.personId,
				shareAmount: parsed.cents,
				dueDate: p.dueDate ? new Date(`${p.dueDate}T00:00:00.000Z`) : null,
				description: p.description,
			};
		});
		return calculateManualSplit({ grossAmount, participants: manualInputs });
	}

	if (method === "RATIO") {
		if (userWeight === undefined || userWeight === null) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"userWeight is required for RATIO split",
			);
		}
		const ratioInputs: RatioParticipantInput[] = participants.map((p) => {
			if (p.weight === undefined || p.weight === null) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					`weight is required for RATIO split (person ${p.personId})`,
				);
			}
			return {
				personId: p.personId,
				weight: p.weight,
				dueDate: p.dueDate ? new Date(p.dueDate) : null,
				description: p.description ?? null,
			};
		});
		return calculateRatioSplit({
			grossAmount,
			userWeight,
			participants: ratioInputs,
		});
	}

	throw new CreditCardError(
		"CREDIT_CARD_INVALID_INPUT",
		`Unknown split method "${method}"`,
	);
}

// ============================================================================
// Read Model Construction
// ============================================================================

async function buildSplitReadModelFromRevisionInTransaction(
	tx: DatabaseOrTransaction,
	split: typeof creditCardPurchaseSplits.$inferSelect,
	revision: typeof creditCardPurchaseSplitRevisions.$inferSelect,
): Promise<CreditCardPurchaseSplitReadModel> {
	const items = await tx
		.select()
		.from(creditCardPurchaseSplitRevisionItems)
		.where(
			eq(creditCardPurchaseSplitRevisionItems.splitRevisionId, revision.id),
		)
		.orderBy(asc(creditCardPurchaseSplitRevisionItems.personId));

	if (items.length === 0) {
		return {
			splitId: split.id,
			userId: split.userId,
			purchaseEventId: split.purchaseEventId,
			status: revision.operation === "VOID" ? "VOID" : "ACTIVE",
			revisionNo: revision.revisionNo,
			method: revision.method as SplitMethod,
			grossAmount: revision.grossAmount,
			userShareAmount: revision.userShareAmount,
			externalShareAmount: revision.externalShareAmount,
			userWeight: revision.userWeight,
			occurredAt: revision.occurredAt,
			createdAt: split.createdAt,
			participants: [],
		};
	}

	const participantIds = items.map((i) => i.participantId);
	const personIds = [...new Set(items.map((i) => i.personId))];

	const [participantRows, personRevRows] = await Promise.all([
		tx
			.select()
			.from(creditCardPurchaseSplitParticipants)
			.where(inArray(creditCardPurchaseSplitParticipants.id, participantIds)),
		tx
			.select()
			.from(personRevisions)
			.where(inArray(personRevisions.personId, personIds)),
	]);

	const participantById = new Map(participantRows.map((p) => [p.id, p]));

	const latestPersonRevByPersonId = new Map<
		string,
		(typeof personRevRows)[number]
	>();
	for (const rev of personRevRows) {
		const existing = latestPersonRevByPersonId.get(rev.personId);
		if (!existing || rev.revisionNo > existing.revisionNo) {
			latestPersonRevByPersonId.set(rev.personId, rev);
		}
	}

	const obligationIds = participantRows.map((p) => p.personObligationId);
	const settlementRows =
		obligationIds.length > 0
			? await tx
					.select({
						id: personSettlements.id,
						obligationId: personSettlements.obligationId,
					})
					.from(personSettlements)
					.where(inArray(personSettlements.obligationId, obligationIds))
			: [];

	const settlementIds = settlementRows.map((s) => s.id);
	const settlementRevRows =
		settlementIds.length > 0
			? await tx
					.select()
					.from(personSettlementRevisions)
					.where(inArray(personSettlementRevisions.settlementId, settlementIds))
			: [];

	const latestSettlementRevBySettlementId = new Map<
		string,
		(typeof settlementRevRows)[number]
	>();
	for (const rev of settlementRevRows) {
		const existing = latestSettlementRevBySettlementId.get(rev.settlementId);
		if (!existing || rev.revisionNo > existing.revisionNo) {
			latestSettlementRevBySettlementId.set(rev.settlementId, rev);
		}
	}

	const activeSettledCentsByObligationId = new Map<string, bigint>();
	for (const s of settlementRows) {
		const latestRev = latestSettlementRevBySettlementId.get(s.id);
		if (latestRev && latestRev.operation !== "VOID") {
			const prior = activeSettledCentsByObligationId.get(s.obligationId) ?? 0n;
			activeSettledCentsByObligationId.set(
				s.obligationId,
				prior + parsePositiveMoneyString(latestRev.appliedAmount).cents,
			);
		}
	}

	const participants: CreditCardPurchaseSplitParticipantReadModel[] = [];

	for (const item of items) {
		const participant = participantById.get(item.participantId);
		if (!participant) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Split participant ${item.participantId} referenced by revision item is missing`,
			);
		}

		const latestPersonRev = latestPersonRevByPersonId.get(item.personId);
		if (!latestPersonRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Person ${item.personId} has no revisions for split participant`,
			);
		}

		const activeSettledCents =
			activeSettledCentsByObligationId.get(participant.personObligationId) ??
			0n;
		const shareAmountCents = parsePositiveMoneyString(item.shareAmount).cents;
		const remainingCents =
			revision.operation === "VOID"
				? 0n
				: shareAmountCents - activeSettledCents;

		if (remainingCents < 0n) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Split participant ${participant.id} active settled amount ${formatCentsToMoney(activeSettledCents)} exceeds share ${item.shareAmount}`,
			);
		}

		const dueDateStr = item.dueDate
			? typeof item.dueDate === "string"
				? item.dueDate
				: (item.dueDate as Date).toISOString().slice(0, 10)
			: null;

		participants.push({
			participantId: participant.id,
			personId: item.personId,
			displayName: latestPersonRev.displayName,
			relationship: latestPersonRev.relationship,
			shareAmount: item.shareAmount,
			settledAmount: formatCentsToMoney(activeSettledCents),
			remainingAmount: formatCentsToMoney(remainingCents),
			weight: item.weight,
			dueDate: dueDateStr,
			description: item.description,
			personObligationId: participant.personObligationId,
		});
	}

	return {
		splitId: split.id,
		userId: split.userId,
		purchaseEventId: split.purchaseEventId,
		status: revision.operation === "VOID" ? "VOID" : "ACTIVE",
		revisionNo: revision.revisionNo,
		method: revision.method as SplitMethod,
		grossAmount: revision.grossAmount,
		userShareAmount: revision.userShareAmount,
		externalShareAmount: revision.externalShareAmount,
		userWeight: revision.userWeight,
		occurredAt: revision.occurredAt,
		createdAt: split.createdAt,
		participants,
	};
}

export async function buildSplitReadModelInTransaction(
	tx: DatabaseOrTransaction,
	splitId: string,
): Promise<CreditCardPurchaseSplitReadModel | null> {
	const [split] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(eq(creditCardPurchaseSplits.id, splitId))
		.limit(1);

	if (!split) return null;

	const [latestRev] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(eq(creditCardPurchaseSplitRevisions.splitId, splitId))
		.orderBy(desc(creditCardPurchaseSplitRevisions.revisionNo))
		.limit(1);

	if (!latestRev) return null;

	return buildSplitReadModelFromRevisionInTransaction(tx, split, latestRev);
}

/**
 * Builds the read model as it looked immediately after a specific historical
 * revision, for exact idempotent replay of a CREATE/UPDATE/VOID request whose
 * fingerprint matches that revision -- even if the split has since moved
 * forward (later UPDATEd/VOIDed) or the underlying purchase changed. Only the
 * revision's own identity/economic snapshot is replayed exactly; settled and
 * remaining amounts still reflect current settlement reality, since those
 * change over time independent of which split revision is being replayed.
 */
async function buildSplitReadModelAtRevisionInTransaction(
	tx: DatabaseOrTransaction,
	splitId: string,
	revisionId: string,
): Promise<CreditCardPurchaseSplitReadModel> {
	const [split] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(eq(creditCardPurchaseSplits.id, splitId))
		.limit(1);
	if (!split) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			`Split "${splitId}" not found`,
		);
	}

	const [revision] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(eq(creditCardPurchaseSplitRevisions.id, revisionId))
		.limit(1);
	if (!revision) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Split revision "${revisionId}" not found`,
		);
	}

	return buildSplitReadModelFromRevisionInTransaction(tx, split, revision);
}

// ============================================================================
// Core Transaction Handlers (Composing Split + People Obligations)
// ============================================================================

export async function createSplitInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		purchaseEventId: string;
		method: SplitMethod;
		userWeight?: number | undefined;
		participants: ParticipantAllocationInput[];
		idempotencyKey: string;
		occurredAt?: Date | undefined;
	},
): Promise<{
	split: CreditCardPurchaseSplitReadModel;
	idempotentReplay: boolean;
}> {
	const { userId, purchaseEventId, method, userWeight, idempotencyKey } =
		params;
	const normalizedParticipants = validateParticipantsInput(params.participants);

	// Global lock order: card -> purchase event -> split -> people -> obligations.
	// Pre-read the immutable purchase event anchor WITHOUT a lock to resolve
	// cardId, then lock card first, THEN lock the purchase event.
	const [purchaseEventPeek] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, purchaseEventId),
				eq(creditCardLiabilityEvents.userId, userId),
			),
		)
		.limit(1);

	if (!purchaseEventPeek) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Purchase event "${purchaseEventId}" not found`,
		);
	}

	if (purchaseEventPeek.eventType !== "PURCHASE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Cannot create a split on a non-PURCHASE liability event",
		);
	}

	await lockCardAndVerifyActive(tx, userId, purchaseEventPeek.creditCardId);

	const [purchaseEvent] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(eq(creditCardLiabilityEvents.id, purchaseEventId))
		.for("update");

	if (!purchaseEvent) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Purchase event "${purchaseEventId}" not found`,
		);
	}

	// Check latest purchase revision
	const latestPurchaseRev = await getLatestPurchaseRevisionInTransaction(
		tx,
		purchaseEventId,
	);
	if (!latestPurchaseRev || latestPurchaseRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			"Cannot split a voided purchase",
		);
	}

	// Check if a split already exists for this purchase
	const [existingSplit] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(eq(creditCardPurchaseSplits.purchaseEventId, purchaseEventId))
		.for("update");

	if (existingSplit) {
		const [firstRev] = await tx
			.select()
			.from(creditCardPurchaseSplitRevisions)
			.where(
				and(
					eq(creditCardPurchaseSplitRevisions.splitId, existingSplit.id),
					eq(creditCardPurchaseSplitRevisions.revisionNo, 1),
				),
			)
			.limit(1);

		if (firstRev && firstRev.idempotencyKey === idempotencyKey) {
			// Exact-payload replay verification: recompute the candidate
			// fingerprint against the HISTORICAL CREATE economic snapshot
			// (the historical grossAmount, not any current purchase amount),
			// so a replay is still recognized after the purchase or split has
			// since been mutated further, but a changed payload under the same
			// key is rejected rather than silently returning stale state.
			const historicalGrossCents = parsePositiveMoneyString(
				firstRev.grossAmount,
			).cents;
			const candidateAllocation = calculateAllocations({
				method,
				grossAmount: historicalGrossCents,
				userWeight,
				participants: normalizedParticipants,
			});
			const candidateOccurredAt = params.occurredAt ?? firstRev.occurredAt;
			const candidateFingerprintItems: SplitParticipantItemFingerprint[] =
				candidateAllocation.participants.map((p) => ({
					personId: p.personId,
					shareAmount: formatCentsToMoney(p.shareAmount),
					weight: p.weight ?? null,
					dueDate: p.dueDate ? p.dueDate.toISOString().slice(0, 10) : null,
					description: p.description ?? null,
				}));
			const candidateFingerprint = await calculateSplitCreateFingerprint({
				userId,
				purchaseEventId,
				method,
				grossAmount: formatCentsToMoney(candidateAllocation.grossAmount),
				userShareAmount: formatCentsToMoney(
					candidateAllocation.userShareAmount,
				),
				externalShareAmount: formatCentsToMoney(
					candidateAllocation.externalShareAmount,
				),
				userWeight: candidateAllocation.userWeight ?? null,
				items: candidateFingerprintItems,
				occurredAt: candidateOccurredAt,
			});

			if (candidateFingerprint !== firstRev.revisionFingerprint) {
				throw new CreditCardError(
					"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different split CREATE payload",
				);
			}

			const readModel = await buildSplitReadModelAtRevisionInTransaction(
				tx,
				existingSplit.id,
				firstRev.id,
			);
			return { split: readModel, idempotentReplay: true };
		}

		if (firstRev) {
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
				"A split already exists for this purchase under a different idempotency key",
			);
		}

		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_CONFLICT",
			"A split already exists for this purchase",
		);
	}

	const purchaseGrossCents = parsePositiveMoneyString(
		latestPurchaseRev.amount,
	).cents;
	const occurredAt = params.occurredAt ?? latestPurchaseRev.occurredAt;

	// Calculate allocation
	const allocation = calculateAllocations({
		method,
		grossAmount: purchaseGrossCents,
		userWeight,
		participants: normalizedParticipants,
	});

	// Lock people and verify active (ORDER BY id ASC)
	const personIds = allocation.participants.map((p) => p.personId);
	await lockPeopleAndVerifyActive(tx, userId, personIds);

	// Derive expense account
	const expenseAccountId = await resolveExpenseAccountIdForPurchase(
		tx,
		userId,
		latestPurchaseRev.budgetCategory,
	);

	// Fingerprint calculation
	const fingerprintItems: SplitParticipantItemFingerprint[] =
		allocation.participants.map((p) => ({
			personId: p.personId,
			shareAmount: formatCentsToMoney(p.shareAmount),
			weight: p.weight ?? null,
			dueDate: p.dueDate ? p.dueDate.toISOString().slice(0, 10) : null,
			description: p.description ?? null,
		}));

	const fingerprint = await calculateSplitCreateFingerprint({
		userId,
		purchaseEventId,
		method,
		grossAmount: formatCentsToMoney(allocation.grossAmount),
		userShareAmount: formatCentsToMoney(allocation.userShareAmount),
		externalShareAmount: formatCentsToMoney(allocation.externalShareAmount),
		userWeight: allocation.userWeight ?? null,
		items: fingerprintItems,
		occurredAt,
	});

	const splitId = crypto.randomUUID();

	// Insert split anchor
	await tx.insert(creditCardPurchaseSplits).values({
		id: splitId,
		userId,
		purchaseEventId,
	});

	const splitRevisionId = crypto.randomUUID();

	// Insert split revision #1
	await tx.insert(creditCardPurchaseSplitRevisions).values({
		id: splitRevisionId,
		splitId,
		revisionNo: 1,
		previousRevisionId: null,
		operation: "CREATE",
		method,
		purchaseEventRevisionId: latestPurchaseRev.id,
		grossAmount: formatCentsToMoney(allocation.grossAmount),
		userShareAmount: formatCentsToMoney(allocation.userShareAmount),
		externalShareAmount: formatCentsToMoney(allocation.externalShareAmount),
		userWeight: allocation.userWeight ?? null,
		occurredAt,
		idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	// Create participant anchors, obligations, and revision items
	for (const part of allocation.participants) {
		const participantId = crypto.randomUUID();
		const oblIdempotencyKey = await deriveCreditCardSplitChildIdempotencyKey(
			idempotencyKey,
			splitId,
			splitRevisionId,
			part.personId,
			"PARTICIPANT_CREATE",
		);
		const amountNormalized = formatCentsToMoney(part.shareAmount);
		const dueDateStr = part.dueDate
			? typeof part.dueDate === "string"
				? part.dueDate
				: (part.dueDate as Date).toISOString().slice(0, 10)
			: null;

		const oblRes = await createSplitObligationInTransaction({
			tx,
			userId,
			splitId,
			splitRevisionId,
			splitParticipantId: participantId,
			purchaseEventId,
			personId: part.personId,
			amountNormalized,
			expenseAccountId,
			dueDate: dueDateStr,
			description: part.description ?? null,
			occurredAt,
			idempotencyKey: oblIdempotencyKey,
		});

		await tx.insert(creditCardPurchaseSplitParticipants).values({
			id: participantId,
			userId,
			splitId,
			personId: part.personId,
			personObligationId: oblRes.obligationId,
		});

		await tx.insert(creditCardPurchaseSplitRevisionItems).values({
			id: crypto.randomUUID(),
			splitRevisionId,
			participantId,
			personId: part.personId,
			shareAmount: formatCentsToMoney(part.shareAmount),
			weight: part.weight ?? null,
			dueDate: dueDateStr,
			description: part.description ?? null,
		});
	}

	// Seal LAST: once inserted, no further items may ever be appended to this
	// revision, making the historical snapshot immutable beyond INSERT-only.
	await tx.insert(creditCardPurchaseSplitRevisionSeals).values({
		splitRevisionId,
	});

	const readModel = await buildSplitReadModelInTransaction(tx, splitId);
	if (!readModel) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			"Failed to build newly created split read model",
		);
	}

	return { split: readModel, idempotentReplay: false };
}

export async function updateSplitInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		splitId: string;
		expectedRevisionNo: number;
		method: SplitMethod;
		userWeight?: number | undefined;
		participants: ParticipantAllocationInput[];
		idempotencyKey: string;
		occurredAt?: Date | undefined;
		overridePurchaseRevision?:
			| typeof creditCardLiabilityEventRevisions.$inferSelect
			| undefined;
	},
): Promise<{
	split: CreditCardPurchaseSplitReadModel;
	idempotentReplay: boolean;
}> {
	const {
		userId,
		splitId,
		expectedRevisionNo,
		method,
		userWeight,
		idempotencyKey,
		overridePurchaseRevision,
	} = params;
	const normalizedParticipants = validateParticipantsInput(params.participants);

	// Pre-read the immutable split -> purchaseEventId, and purchase event ->
	// cardId, WITHOUT locks, so the global lock order (card -> purchase event
	// -> split) can be honored without a wrong-order deadlock-prone lock.
	const [splitPeek] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(
			and(
				eq(creditCardPurchaseSplits.id, splitId),
				eq(creditCardPurchaseSplits.userId, userId),
			),
		)
		.limit(1);

	if (!splitPeek) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			`Split "${splitId}" not found`,
		);
	}

	// Early idempotency replay (unlocked read) before acquiring authoritative
	// locks; a second replay check happens again below after locking.
	const [earlyReplay] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(
			and(
				eq(creditCardPurchaseSplitRevisions.splitId, splitId),
				eq(creditCardPurchaseSplitRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const [purchaseEventPeek] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(eq(creditCardLiabilityEvents.id, splitPeek.purchaseEventId))
		.limit(1);

	if (!purchaseEventPeek) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			"Underlying purchase event not found",
		);
	}

	await lockCardAndVerifyActive(tx, userId, purchaseEventPeek.creditCardId);

	// Lock purchase event FOR UPDATE
	const [purchaseEvent] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(eq(creditCardLiabilityEvents.id, splitPeek.purchaseEventId))
		.for("update");

	if (!purchaseEvent) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			"Underlying purchase event not found",
		);
	}

	// Lock split anchor last.
	const [split] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(
			and(
				eq(creditCardPurchaseSplits.id, splitId),
				eq(creditCardPurchaseSplits.userId, userId),
			),
		)
		.for("update");

	if (!split) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			`Split "${splitId}" not found`,
		);
	}

	// Second replay check under lock (races must never double-post).
	const [existingRevWithKey] =
		earlyReplay !== undefined
			? [earlyReplay]
			: await tx
					.select()
					.from(creditCardPurchaseSplitRevisions)
					.where(
						and(
							eq(creditCardPurchaseSplitRevisions.splitId, splitId),
							eq(
								creditCardPurchaseSplitRevisions.idempotencyKey,
								idempotencyKey,
							),
						),
					)
					.limit(1);

	if (existingRevWithKey) {
		// Exact-payload replay verification against the HISTORICAL economic
		// snapshot owned by this key (its own stored grossAmount/occurredAt),
		// not any current mutable purchase/split state, so a genuine retry
		// still replays after later lifecycle changes but a changed payload
		// under the same key is rejected.
		const historicalGrossCents = parsePositiveMoneyString(
			existingRevWithKey.grossAmount,
		).cents;
		const historicalExpectedRevisionNo = existingRevWithKey.revisionNo - 1;
		const candidateAllocation = calculateAllocations({
			method,
			grossAmount: historicalGrossCents,
			userWeight,
			participants: normalizedParticipants,
		});
		const candidateOccurredAt =
			params.occurredAt ?? existingRevWithKey.occurredAt;
		const candidateFingerprintItems: SplitParticipantItemFingerprint[] =
			candidateAllocation.participants.map((p) => ({
				personId: p.personId,
				shareAmount: formatCentsToMoney(p.shareAmount),
				weight: p.weight ?? null,
				dueDate: p.dueDate ? p.dueDate.toISOString().slice(0, 10) : null,
				description: p.description ?? null,
			}));
		const candidateFingerprint = await calculateSplitUpdateFingerprint({
			userId,
			splitId,
			expectedRevisionNo: historicalExpectedRevisionNo,
			method,
			grossAmount: formatCentsToMoney(candidateAllocation.grossAmount),
			userShareAmount: formatCentsToMoney(candidateAllocation.userShareAmount),
			externalShareAmount: formatCentsToMoney(
				candidateAllocation.externalShareAmount,
			),
			userWeight: candidateAllocation.userWeight ?? null,
			items: candidateFingerprintItems,
			occurredAt: candidateOccurredAt,
		});

		if (candidateFingerprint !== existingRevWithKey.revisionFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different split UPDATE payload",
			);
		}

		const readModel = await buildSplitReadModelAtRevisionInTransaction(
			tx,
			splitId,
			existingRevWithKey.id,
		);
		return { split: readModel, idempotentReplay: true };
	}

	// Get latest purchase revision
	const latestPurchaseRev =
		overridePurchaseRevision ??
		(await getLatestPurchaseRevisionInTransaction(tx, split.purchaseEventId));

	if (!latestPurchaseRev || latestPurchaseRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			"Cannot update split for voided purchase",
		);
	}

	// Get latest split revision
	const latestSplitRev = await getLatestSplitRevisionInTransaction(tx, splitId);
	if (!latestSplitRev) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			"Split has no revisions",
		);
	}

	if (latestSplitRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_ACTIVE",
			"Cannot update a voided split",
		);
	}

	if (latestSplitRev.revisionNo !== expectedRevisionNo) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_REVISION_CONFLICT",
			`Expected split revision ${expectedRevisionNo} but found ${latestSplitRev.revisionNo}`,
		);
	}

	const purchaseGrossCents = parsePositiveMoneyString(
		latestPurchaseRev.amount,
	).cents;
	const occurredAt = params.occurredAt ?? latestPurchaseRev.occurredAt;

	// Calculate new allocations against purchase gross amount
	const allocation = calculateAllocations({
		method,
		grossAmount: purchaseGrossCents,
		userWeight,
		participants: normalizedParticipants,
	});

	// Lock people and verify active (ORDER BY id ASC)
	const newPersonIds = allocation.participants.map((p) => p.personId);

	// Also gather prior active participant personIds to lock all involved people
	const priorItems = await tx
		.select()
		.from(creditCardPurchaseSplitRevisionItems)
		.where(
			eq(
				creditCardPurchaseSplitRevisionItems.splitRevisionId,
				latestSplitRev.id,
			),
		);

	const allInvolvedPersonIds = [
		...new Set([...newPersonIds, ...priorItems.map((i) => i.personId)]),
	].sort();
	await lockPeopleAndVerifyActive(tx, userId, allInvolvedPersonIds);

	// Derive expense account
	const expenseAccountId = await resolveExpenseAccountIdForPurchase(
		tx,
		userId,
		latestPurchaseRev.budgetCategory,
	);

	// Map prior items by personId
	const priorItemMap = new Map<
		string,
		typeof creditCardPurchaseSplitRevisionItems.$inferSelect
	>();
	for (const item of priorItems) {
		priorItemMap.set(item.personId, item);
	}

	const newPersonIdSet = new Set(newPersonIds);
	const nextRevisionNo = latestSplitRev.revisionNo + 1;
	const newSplitRevId = crypto.randomUUID();

	// 1. For REMOVED people: void their linked obligation
	for (const priorItem of priorItems) {
		if (!newPersonIdSet.has(priorItem.personId)) {
			const [participant] = await tx
				.select()
				.from(creditCardPurchaseSplitParticipants)
				.where(
					eq(creditCardPurchaseSplitParticipants.id, priorItem.participantId),
				)
				.limit(1);

			if (participant) {
				const [latestOblRev] = await tx
					.select()
					.from(personObligationRevisions)
					.where(
						eq(
							personObligationRevisions.obligationId,
							participant.personObligationId,
						),
					)
					.orderBy(desc(personObligationRevisions.revisionNo))
					.limit(1);

				if (latestOblRev && latestOblRev.operation !== "VOID") {
					const oblVoidKey = await deriveCreditCardSplitChildIdempotencyKey(
						idempotencyKey,
						splitId,
						newSplitRevId,
						priorItem.personId,
						"PARTICIPANT_VOID",
					);
					await voidSplitObligationInTransaction({
						tx,
						userId,
						obligationId: participant.personObligationId,
						expectedRevisionNo: latestOblRev.revisionNo,
						idempotencyKey: oblVoidKey,
					});
				}
			}
		}
	}

	// Fingerprint calculation
	const fingerprintItems: SplitParticipantItemFingerprint[] =
		allocation.participants.map((p) => ({
			personId: p.personId,
			shareAmount: formatCentsToMoney(p.shareAmount),
			weight: p.weight ?? null,
			dueDate: p.dueDate ? p.dueDate.toISOString().slice(0, 10) : null,
			description: p.description ?? null,
		}));

	const fingerprint = await calculateSplitUpdateFingerprint({
		userId,
		splitId,
		expectedRevisionNo,
		method,
		grossAmount: formatCentsToMoney(allocation.grossAmount),
		userShareAmount: formatCentsToMoney(allocation.userShareAmount),
		externalShareAmount: formatCentsToMoney(allocation.externalShareAmount),
		userWeight: allocation.userWeight ?? null,
		items: fingerprintItems,
		occurredAt,
	});

	// Insert new split revision
	await tx.insert(creditCardPurchaseSplitRevisions).values({
		id: newSplitRevId,
		splitId,
		revisionNo: nextRevisionNo,
		previousRevisionId: latestSplitRev.id,
		operation: "UPDATE",
		method,
		purchaseEventRevisionId: latestPurchaseRev.id,
		grossAmount: formatCentsToMoney(allocation.grossAmount),
		userShareAmount: formatCentsToMoney(allocation.userShareAmount),
		externalShareAmount: formatCentsToMoney(allocation.externalShareAmount),
		userWeight: allocation.userWeight ?? null,
		occurredAt,
		idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	// 2. For PRESENT people: update existing obligation or create new one if newly added
	for (const part of allocation.participants) {
		const priorItem = priorItemMap.get(part.personId);
		let participantId: string;
		const amountNormalized = formatCentsToMoney(part.shareAmount);
		const dueDateStr = part.dueDate
			? typeof part.dueDate === "string"
				? part.dueDate
				: (part.dueDate as Date).toISOString().slice(0, 10)
			: null;

		if (priorItem) {
			// Reuse existing participant anchor
			participantId = priorItem.participantId;
			const [participant] = await tx
				.select()
				.from(creditCardPurchaseSplitParticipants)
				.where(eq(creditCardPurchaseSplitParticipants.id, participantId))
				.limit(1);

			if (!participant) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					"Participant anchor missing",
				);
			}

			const [latestOblRev] = await tx
				.select()
				.from(personObligationRevisions)
				.where(
					eq(
						personObligationRevisions.obligationId,
						participant.personObligationId,
					),
				)
				.orderBy(desc(personObligationRevisions.revisionNo))
				.limit(1);

			if (!latestOblRev || latestOblRev.operation === "VOID") {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					"Prior active split participant has a voided obligation",
				);
			}

			const oblUpdateKey = await deriveCreditCardSplitChildIdempotencyKey(
				idempotencyKey,
				splitId,
				newSplitRevId,
				part.personId,
				"PARTICIPANT_UPDATE",
			);
			await updateSplitObligationInTransaction({
				tx,
				userId,
				splitId,
				splitRevisionId: newSplitRevId,
				splitParticipantId: participantId,
				purchaseEventId: split.purchaseEventId,
				personId: part.personId,
				obligationId: participant.personObligationId,
				expectedRevisionNo: latestOblRev.revisionNo,
				amountNormalized,
				expenseAccountId,
				dueDate: dueDateStr,
				description: part.description ?? null,
				occurredAt,
				idempotencyKey: oblUpdateKey,
			});
		} else {
			// Newly added person -> create new participant anchor & new obligation
			participantId = crypto.randomUUID();
			const oblCreateKey = await deriveCreditCardSplitChildIdempotencyKey(
				idempotencyKey,
				splitId,
				newSplitRevId,
				part.personId,
				"PARTICIPANT_CREATE",
			);

			const oblRes = await createSplitObligationInTransaction({
				tx,
				userId,
				splitId,
				splitRevisionId: newSplitRevId,
				splitParticipantId: participantId,
				purchaseEventId: split.purchaseEventId,
				personId: part.personId,
				amountNormalized,
				expenseAccountId,
				dueDate: dueDateStr,
				description: part.description ?? null,
				occurredAt,
				idempotencyKey: oblCreateKey,
			});

			await tx.insert(creditCardPurchaseSplitParticipants).values({
				id: participantId,
				userId,
				splitId,
				personId: part.personId,
				personObligationId: oblRes.obligationId,
			});
		}

		// Insert revision item
		await tx.insert(creditCardPurchaseSplitRevisionItems).values({
			id: crypto.randomUUID(),
			splitRevisionId: newSplitRevId,
			participantId,
			personId: part.personId,
			shareAmount: formatCentsToMoney(part.shareAmount),
			weight: part.weight ?? null,
			dueDate: dueDateStr,
			description: part.description ?? null,
		});
	}

	await tx.insert(creditCardPurchaseSplitRevisionSeals).values({
		splitRevisionId: newSplitRevId,
	});

	const readModel = await buildSplitReadModelInTransaction(tx, splitId);
	if (!readModel) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			"Failed to build updated split read model",
		);
	}

	return { split: readModel, idempotentReplay: false };
}

export async function voidSplitInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		splitId: string;
		expectedRevisionNo: number;
		idempotencyKey: string;
		occurredAt?: Date | undefined;
	},
): Promise<{
	split: CreditCardPurchaseSplitReadModel;
	idempotentReplay: boolean;
}> {
	const { userId, splitId, expectedRevisionNo, idempotencyKey } = params;

	// Pre-read split -> purchaseEventId and purchase event -> cardId WITHOUT
	// locks, to honor the global lock order (card -> purchase event -> split).
	const [splitPeek] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(
			and(
				eq(creditCardPurchaseSplits.id, splitId),
				eq(creditCardPurchaseSplits.userId, userId),
			),
		)
		.limit(1);

	if (!splitPeek) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			`Split "${splitId}" not found`,
		);
	}

	// Early idempotency replay (unlocked read).
	const [earlyReplay] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(
			and(
				eq(creditCardPurchaseSplitRevisions.splitId, splitId),
				eq(creditCardPurchaseSplitRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const [purchaseEventPeek] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(eq(creditCardLiabilityEvents.id, splitPeek.purchaseEventId))
		.limit(1);

	if (purchaseEventPeek) {
		await lockCardAndVerifyActive(tx, userId, purchaseEventPeek.creditCardId);
		await tx
			.select()
			.from(creditCardLiabilityEvents)
			.where(eq(creditCardLiabilityEvents.id, splitPeek.purchaseEventId))
			.for("update");
	}

	// Lock split anchor last.
	const [split] = await tx
		.select()
		.from(creditCardPurchaseSplits)
		.where(
			and(
				eq(creditCardPurchaseSplits.id, splitId),
				eq(creditCardPurchaseSplits.userId, userId),
			),
		)
		.for("update");

	if (!split) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			`Split "${splitId}" not found`,
		);
	}

	// Second replay check under lock.
	const [existingRevWithKey] =
		earlyReplay !== undefined
			? [earlyReplay]
			: await tx
					.select()
					.from(creditCardPurchaseSplitRevisions)
					.where(
						and(
							eq(creditCardPurchaseSplitRevisions.splitId, splitId),
							eq(
								creditCardPurchaseSplitRevisions.idempotencyKey,
								idempotencyKey,
							),
						),
					)
					.limit(1);

	if (existingRevWithKey) {
		const historicalExpectedRevisionNo = existingRevWithKey.revisionNo - 1;
		const candidateOccurredAt =
			params.occurredAt ?? existingRevWithKey.occurredAt;
		const candidateFingerprint = await calculateSplitVoidFingerprint({
			userId,
			splitId,
			expectedRevisionNo: historicalExpectedRevisionNo,
			occurredAt: candidateOccurredAt,
		});

		if (candidateFingerprint !== existingRevWithKey.revisionFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different split VOID payload",
			);
		}

		const readModel = await buildSplitReadModelAtRevisionInTransaction(
			tx,
			splitId,
			existingRevWithKey.id,
		);
		return { split: readModel, idempotentReplay: true };
	}

	// Get latest split revision
	const latestSplitRev = await getLatestSplitRevisionInTransaction(tx, splitId);
	if (!latestSplitRev) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_FOUND",
			"Split has no revisions",
		);
	}

	if (latestSplitRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_NOT_ACTIVE",
			"Cannot void an already voided split",
		);
	}

	if (latestSplitRev.revisionNo !== expectedRevisionNo) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_REVISION_CONFLICT",
			`Expected split revision ${expectedRevisionNo} but found ${latestSplitRev.revisionNo}`,
		);
	}

	const occurredAt = params.occurredAt ?? latestSplitRev.occurredAt;

	// Gather current active participants and lock people
	const currentItems = await tx
		.select()
		.from(creditCardPurchaseSplitRevisionItems)
		.where(
			eq(
				creditCardPurchaseSplitRevisionItems.splitRevisionId,
				latestSplitRev.id,
			),
		);

	const personIds = currentItems.map((i) => i.personId);
	await lockPeopleAndVerifyActive(tx, userId, personIds);

	const nextRevisionNo = latestSplitRev.revisionNo + 1;
	const newSplitRevId = crypto.randomUUID();

	// Void all active participant obligations
	for (const item of currentItems) {
		const [participant] = await tx
			.select()
			.from(creditCardPurchaseSplitParticipants)
			.where(eq(creditCardPurchaseSplitParticipants.id, item.participantId))
			.limit(1);

		if (participant) {
			const [latestOblRev] = await tx
				.select()
				.from(personObligationRevisions)
				.where(
					eq(
						personObligationRevisions.obligationId,
						participant.personObligationId,
					),
				)
				.orderBy(desc(personObligationRevisions.revisionNo))
				.limit(1);

			if (latestOblRev && latestOblRev.operation !== "VOID") {
				const oblVoidKey = await deriveCreditCardSplitChildIdempotencyKey(
					idempotencyKey,
					splitId,
					newSplitRevId,
					item.personId,
					"PARTICIPANT_VOID",
				);
				await voidSplitObligationInTransaction({
					tx,
					userId,
					obligationId: participant.personObligationId,
					expectedRevisionNo: latestOblRev.revisionNo,
					idempotencyKey: oblVoidKey,
				});
			}
		}
	}

	const fingerprint = await calculateSplitVoidFingerprint({
		userId,
		splitId,
		expectedRevisionNo,
		occurredAt,
	});

	// Insert VOID split revision (copy forward amounts)
	await tx.insert(creditCardPurchaseSplitRevisions).values({
		id: newSplitRevId,
		splitId,
		revisionNo: nextRevisionNo,
		previousRevisionId: latestSplitRev.id,
		operation: "VOID",
		method: latestSplitRev.method,
		purchaseEventRevisionId: latestSplitRev.purchaseEventRevisionId,
		grossAmount: latestSplitRev.grossAmount,
		userShareAmount: latestSplitRev.grossAmount,
		externalShareAmount: "0.00",
		userWeight: latestSplitRev.userWeight,
		occurredAt,
		idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	await tx.insert(creditCardPurchaseSplitRevisionSeals).values({
		splitRevisionId: newSplitRevId,
	});

	const readModel = await buildSplitReadModelInTransaction(tx, splitId);
	if (!readModel) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			"Failed to build voided split read model",
		);
	}

	return { split: readModel, idempotentReplay: false };
}

// ============================================================================
// Public APIs
// ============================================================================

export async function createCreditCardPurchaseSplit(
	params: CreateCreditCardPurchaseSplitParams,
): Promise<{
	split: CreditCardPurchaseSplitReadModel;
	idempotentReplay: boolean;
}> {
	const validUserId = validateUserId(params.userId);
	const validPurchaseEventId = validatePurchaseEventId(params.purchaseEventId);
	const validMethod = validateSplitMethod(params.method);
	const validIdempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const validOccurredAt = params.occurredAt
		? validateCcOccurredAt(params.occurredAt)
		: undefined;

	return runCreditCardTransaction(params.db, async (tx) => {
		return createSplitInTransaction(tx, {
			userId: validUserId,
			purchaseEventId: validPurchaseEventId,
			method: validMethod,
			userWeight: params.userWeight,
			participants: params.participants,
			idempotencyKey: validIdempotencyKey,
			occurredAt: validOccurredAt,
		});
	});
}

export async function updateCreditCardPurchaseSplit(
	params: UpdateCreditCardPurchaseSplitParams,
): Promise<{
	split: CreditCardPurchaseSplitReadModel;
	idempotentReplay: boolean;
}> {
	const validUserId = validateUserId(params.userId);
	const validSplitId = validateSplitId(params.splitId);
	const validExpectedRevisionNo = validateCcExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const validMethod = validateSplitMethod(params.method);
	const validIdempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const validOccurredAt = params.occurredAt
		? validateCcOccurredAt(params.occurredAt)
		: undefined;

	return runCreditCardTransaction(params.db, async (tx) => {
		return updateSplitInTransaction(tx, {
			userId: validUserId,
			splitId: validSplitId,
			expectedRevisionNo: validExpectedRevisionNo,
			method: validMethod,
			userWeight: params.userWeight,
			participants: params.participants,
			idempotencyKey: validIdempotencyKey,
			occurredAt: validOccurredAt,
		});
	});
}

export async function voidCreditCardPurchaseSplit(
	params: VoidCreditCardPurchaseSplitParams,
): Promise<{
	split: CreditCardPurchaseSplitReadModel;
	idempotentReplay: boolean;
}> {
	const validUserId = validateUserId(params.userId);
	const validSplitId = validateSplitId(params.splitId);
	const validExpectedRevisionNo = validateCcExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const validIdempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const validOccurredAt = params.occurredAt
		? validateCcOccurredAt(params.occurredAt)
		: undefined;

	return runCreditCardTransaction(params.db, async (tx) => {
		return voidSplitInTransaction(tx, {
			userId: validUserId,
			splitId: validSplitId,
			expectedRevisionNo: validExpectedRevisionNo,
			idempotencyKey: validIdempotencyKey,
			occurredAt: validOccurredAt,
		});
	});
}

export async function getCreditCardPurchaseSplit(
	params: GetCreditCardPurchaseSplitParams,
): Promise<CreditCardPurchaseSplitReadModel | null> {
	const validUserId = validateUserId(params.userId);
	const validSplitId =
		params.splitId === undefined ? undefined : validateSplitId(params.splitId);
	const validPurchaseEventId =
		params.purchaseEventId === undefined
			? undefined
			: validatePurchaseEventId(params.purchaseEventId);

	if (!validSplitId && !validPurchaseEventId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Either splitId or purchaseEventId must be provided",
		);
	}

	return runCreditCardReadTransaction(params.db, async (tx) => {
		let ownedSplit: typeof creditCardPurchaseSplits.$inferSelect | undefined;

		if (validSplitId) {
			const [split] = await tx
				.select()
				.from(creditCardPurchaseSplits)
				.where(
					and(
						eq(creditCardPurchaseSplits.id, validSplitId),
						eq(creditCardPurchaseSplits.userId, validUserId),
					),
				)
				.limit(1);
			if (!split) return null;
			ownedSplit = split;

			// If purchaseEventId was also supplied, it must identify the same split.
			if (
				validPurchaseEventId &&
				split.purchaseEventId !== validPurchaseEventId
			) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					"splitId and purchaseEventId do not identify the same split",
				);
			}
		} else if (validPurchaseEventId) {
			const [split] = await tx
				.select()
				.from(creditCardPurchaseSplits)
				.where(
					and(
						eq(creditCardPurchaseSplits.purchaseEventId, validPurchaseEventId),
						eq(creditCardPurchaseSplits.userId, validUserId),
					),
				)
				.limit(1);
			if (!split) return null;
			ownedSplit = split;
		}

		if (!ownedSplit) return null;
		return buildSplitReadModelInTransaction(tx, ownedSplit.id);
	});
}

export function validateSplitStatusFilter(
	value: unknown,
): "ACTIVE" | "VOID" | undefined {
	if (value === undefined) return undefined;
	if (value !== "ACTIVE" && value !== "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid split status filter: "${String(value)}"`,
		);
	}
	return value;
}

export async function listCreditCardPurchaseSplits(
	params: ListCreditCardPurchaseSplitsParams,
): Promise<CreditCardPurchaseSplitReadModel[]> {
	const validUserId = validateUserId(params.userId);
	const validCardId =
		params.cardId === undefined
			? undefined
			: validateCcCanonicalUuid(params.cardId, "cardId");
	const validPurchaseEventId =
		params.purchaseEventId === undefined
			? undefined
			: validatePurchaseEventId(params.purchaseEventId);
	const validPersonId =
		params.personId === undefined
			? undefined
			: validateCcCanonicalUuid(params.personId, "personId");
	const validStatus = validateSplitStatusFilter(params.status);

	return runCreditCardReadTransaction(params.db, async (tx) => {
		const conditions = [eq(creditCardPurchaseSplits.userId, validUserId)];

		if (validPurchaseEventId) {
			conditions.push(
				eq(creditCardPurchaseSplits.purchaseEventId, validPurchaseEventId),
			);
		}

		if (validCardId) {
			const purchases = await tx
				.select({ id: creditCardLiabilityEvents.id })
				.from(creditCardLiabilityEvents)
				.where(
					and(
						eq(creditCardLiabilityEvents.creditCardId, validCardId),
						eq(creditCardLiabilityEvents.userId, validUserId),
					),
				);

			if (purchases.length === 0) return [];
			conditions.push(
				inArray(
					creditCardPurchaseSplits.purchaseEventId,
					purchases.map((p) => p.id),
				),
			);
		}

		if (validPersonId) {
			const participants = await tx
				.select({ splitId: creditCardPurchaseSplitParticipants.splitId })
				.from(creditCardPurchaseSplitParticipants)
				.where(
					and(
						eq(creditCardPurchaseSplitParticipants.personId, validPersonId),
						eq(creditCardPurchaseSplitParticipants.userId, validUserId),
					),
				);

			if (participants.length === 0) return [];
			conditions.push(
				inArray(
					creditCardPurchaseSplits.id,
					participants.map((p) => p.splitId),
				),
			);
		}

		const splits = await tx
			.select()
			.from(creditCardPurchaseSplits)
			.where(and(...conditions))
			.orderBy(
				desc(creditCardPurchaseSplits.createdAt),
				asc(creditCardPurchaseSplits.id),
			);

		const results: CreditCardPurchaseSplitReadModel[] = [];
		for (const split of splits) {
			const readModel = await buildSplitReadModelInTransaction(tx, split.id);
			if (!readModel) continue;
			if (validStatus && readModel.status !== validStatus) continue;
			results.push(readModel);
		}

		return results;
	});
}
