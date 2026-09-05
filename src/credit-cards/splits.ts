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
import { runCreditCardTransaction } from "./boundary";
import {
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
} from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateSplitCreateFingerprint,
	calculateSplitUpdateFingerprint,
	calculateSplitVoidFingerprint,
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
	participants: ParticipantAllocationInput[];
}): SplitCalculationResult {
	const { method, grossAmount, userWeight, participants } = params;

	if (method === "EQUAL") {
		const equalInputs: EqualParticipantInput[] = participants.map((p) => ({
			personId: p.personId,
			dueDate: p.dueDate ? new Date(p.dueDate) : null,
			description: p.description ?? null,
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
				dueDate: p.dueDate ? new Date(p.dueDate) : null,
				description: p.description ?? null,
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

	const items = await tx
		.select()
		.from(creditCardPurchaseSplitRevisionItems)
		.where(
			eq(creditCardPurchaseSplitRevisionItems.splitRevisionId, latestRev.id),
		)
		.orderBy(asc(creditCardPurchaseSplitRevisionItems.personId));

	const participants: CreditCardPurchaseSplitParticipantReadModel[] = [];

	for (const item of items) {
		const [participant] = await tx
			.select()
			.from(creditCardPurchaseSplitParticipants)
			.where(eq(creditCardPurchaseSplitParticipants.id, item.participantId))
			.limit(1);

		if (!participant) continue;

		const [_person] = await tx
			.select()
			.from(people)
			.where(eq(people.id, item.personId))
			.limit(1);

		const [latestPersonRev] = await tx
			.select()
			.from(personRevisions)
			.where(eq(personRevisions.personId, item.personId))
			.orderBy(desc(personRevisions.revisionNo))
			.limit(1);

		// Calculate active settled amount on this obligation
		const settlements = await tx
			.select({ id: personSettlements.id })
			.from(personSettlements)
			.where(
				eq(personSettlements.obligationId, participant.personObligationId),
			);

		let activeSettledCents = 0n;
		for (const s of settlements) {
			const [latestSettlementRev] = await tx
				.select()
				.from(personSettlementRevisions)
				.where(eq(personSettlementRevisions.settlementId, s.id))
				.orderBy(desc(personSettlementRevisions.revisionNo))
				.limit(1);

			if (latestSettlementRev && latestSettlementRev.operation !== "VOID") {
				activeSettledCents += parsePositiveMoneyString(
					latestSettlementRev.appliedAmount,
				).cents;
			}
		}

		const shareAmountCents = parsePositiveMoneyString(item.shareAmount).cents;
		const remainingCents =
			latestRev.operation === "VOID"
				? 0n
				: shareAmountCents - activeSettledCents;

		const dueDateStr = item.dueDate
			? typeof item.dueDate === "string"
				? item.dueDate
				: (item.dueDate as Date).toISOString().slice(0, 10)
			: null;

		participants.push({
			participantId: participant.id,
			personId: item.personId,
			displayName: latestPersonRev?.displayName ?? "Unknown",
			relationship: latestPersonRev?.relationship ?? "OTHER",
			shareAmount: item.shareAmount,
			settledAmount: formatCentsToMoney(activeSettledCents),
			remainingAmount: formatCentsToMoney(
				remainingCents < 0n ? 0n : remainingCents,
			),
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
		status: latestRev.operation === "VOID" ? "VOID" : "ACTIVE",
		revisionNo: latestRev.revisionNo,
		method: latestRev.method as SplitMethod,
		grossAmount: latestRev.grossAmount,
		userShareAmount: latestRev.userShareAmount,
		externalShareAmount: latestRev.externalShareAmount,
		userWeight: latestRev.userWeight,
		occurredAt: latestRev.occurredAt,
		createdAt: split.createdAt,
		participants,
	};
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
	const {
		userId,
		purchaseEventId,
		method,
		userWeight,
		participants,
		idempotencyKey,
	} = params;

	// Lock purchase event FOR UPDATE
	const [purchaseEvent] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, purchaseEventId),
				eq(creditCardLiabilityEvents.userId, userId),
			),
		)
		.for("update");

	if (!purchaseEvent) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Purchase event "${purchaseEventId}" not found`,
		);
	}

	if (purchaseEvent.eventType !== "PURCHASE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Cannot create a split on a non-PURCHASE liability event",
		);
	}

	// Lock card and verify ACTIVE
	await lockCardAndVerifyActive(tx, userId, purchaseEvent.creditCardId);

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
		// Check if idempotent replay
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
			const readModel = await buildSplitReadModelInTransaction(
				tx,
				existingSplit.id,
			);
			if (!readModel) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					"Failed to build split read model on replay",
				);
			}
			return { split: readModel, idempotentReplay: true };
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
		participants,
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
		const oblIdempotencyKey = `${idempotencyKey}_PART_${part.personId}`;
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
		participants,
		idempotencyKey,
		overridePurchaseRevision,
	} = params;

	// Lock split anchor
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

	// Check idempotency early replay
	const [existingRevWithKey] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(
			and(
				eq(creditCardPurchaseSplitRevisions.splitId, splitId),
				eq(creditCardPurchaseSplitRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	if (existingRevWithKey) {
		const readModel = await buildSplitReadModelInTransaction(tx, splitId);
		if (!readModel) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to build split read model on replay",
			);
		}
		return { split: readModel, idempotentReplay: true };
	}

	// Lock purchase event FOR UPDATE
	const [purchaseEvent] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(eq(creditCardLiabilityEvents.id, split.purchaseEventId))
		.for("update");

	if (!purchaseEvent) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			"Underlying purchase event not found",
		);
	}

	// Lock card and verify ACTIVE
	await lockCardAndVerifyActive(tx, userId, purchaseEvent.creditCardId);

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
		participants,
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
					const oblVoidKey = `${idempotencyKey}_VOID_PART_${priorItem.personId}`;
					await voidSplitObligationInTransaction({
						tx,
						userId,
						obligationId: participant.personObligationId,
						expectedRevisionNo: latestOblRev.revisionNo,
						idempotencyKey: oblVoidKey,
						occurredAt,
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

	const nextRevisionNo = latestSplitRev.revisionNo + 1;
	const newSplitRevId = crypto.randomUUID();

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

			const oblUpdateKey = `${idempotencyKey}_UPD_PART_${part.personId}`;
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
			const oblCreateKey = `${idempotencyKey}_ADD_PART_${part.personId}`;

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

	// Lock split anchor
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

	// Check idempotency early replay
	const [existingRevWithKey] = await tx
		.select()
		.from(creditCardPurchaseSplitRevisions)
		.where(
			and(
				eq(creditCardPurchaseSplitRevisions.splitId, splitId),
				eq(creditCardPurchaseSplitRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	if (existingRevWithKey) {
		const readModel = await buildSplitReadModelInTransaction(tx, splitId);
		if (!readModel) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to build split read model on replay",
			);
		}
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
				const oblVoidKey = `${idempotencyKey}_VOID_PART_${item.personId}`;
				await voidSplitObligationInTransaction({
					tx,
					userId,
					obligationId: participant.personObligationId,
					expectedRevisionNo: latestOblRev.revisionNo,
					idempotencyKey: oblVoidKey,
					occurredAt,
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

	const nextRevisionNo = latestSplitRev.revisionNo + 1;
	const newSplitRevId = crypto.randomUUID();

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
	const validSplitId = params.splitId
		? validateSplitId(params.splitId)
		: undefined;
	const validPurchaseEventId = params.purchaseEventId
		? validatePurchaseEventId(params.purchaseEventId)
		: undefined;

	if (!validSplitId && !validPurchaseEventId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Either splitId or purchaseEventId must be provided",
		);
	}

	return runCreditCardTransaction(params.db, async (tx) => {
		let targetSplitId = validSplitId;
		if (!targetSplitId && validPurchaseEventId) {
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
			targetSplitId = split.id;
		}

		if (!targetSplitId) return null;
		return buildSplitReadModelInTransaction(tx, targetSplitId);
	});
}

export async function listCreditCardPurchaseSplits(
	params: ListCreditCardPurchaseSplitsParams,
): Promise<CreditCardPurchaseSplitReadModel[]> {
	const validUserId = validateUserId(params.userId);
	const validCardId = params.cardId
		? validateCcCanonicalUuid(params.cardId, "cardId")
		: undefined;
	const validPurchaseEventId = params.purchaseEventId
		? validatePurchaseEventId(params.purchaseEventId)
		: undefined;
	const validPersonId = params.personId
		? validateCcCanonicalUuid(params.personId, "personId")
		: undefined;
	const validStatus = params.status;

	return runCreditCardTransaction(params.db, async (tx) => {
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
			.orderBy(desc(creditCardPurchaseSplits.createdAt));

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
