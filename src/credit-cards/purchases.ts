import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	type CreditCardLiabilityEventOperation,
	type CreditCardLiabilityEventType,
	type CreditCardPurchaseBudgetCategory,
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
	mapPurchaseCategoryToSystemRole,
} from "../db/schema/credit-card-ledger";
import { creditCardRevisions, creditCards } from "../db/schema/credit-cards";
import {
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import { transactionLedgerBindings } from "../db/schema/transaction-ledger";
import { transactionRevisions } from "../db/schema/transactions";
import { getLedgerAccountBalanceInTransaction } from "../ledger/balances";
import {
	parsePositiveMoneyString,
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	reviseCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import { runCreditCardTransaction } from "./boundary";
import {
	formatIstanbulPurchaseDate,
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateCcOptionalText,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validateInstallmentCount,
	validateLiabilityEventStatusFilter,
	validatePurchaseCategory,
} from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateLiabilityEventCreateFingerprint,
	calculateLiabilityEventCreateFingerprintV1,
	calculateLiabilityEventUpdateFingerprint,
	calculateLiabilityEventUpdateFingerprintV1,
	calculateLiabilityEventVoidFingerprint,
	calculateLiabilityEventVoidFingerprintV1,
	generateCreditCardLiabilityJournalKey,
} from "./fingerprint";
import {
	ensureCreditCardLedgerLinkInTransaction,
	ensureCreditCardSystemAccountsInTransaction,
} from "./ledger-provisioning";

// ============================================================================
// Record & Snapshot Types
// ============================================================================

export interface CreditCardPurchaseRecord {
	eventId: string;
	cardId: string;
	userId: string;
	eventType: CreditCardLiabilityEventType;
	status: "POSTED" | "VOID";
	revisionNo: number;
	amount: string;
	purchaseDate: string | null;
	purchaseCategory: CreditCardPurchaseBudgetCategory | null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	installmentCount: number | null;
	canonicalTransactionId: string;
	canonicalRevisionId: string;
	journalEntryId: string | null;
	createdAt: Date;
}

export interface CreditCardPurchaseSnapshot {
	amount: string;
	purchaseDate: string | null;
	purchaseCategory: CreditCardPurchaseBudgetCategory | null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	installmentCount: number | null;
	reasonNote: string | null;
}

export interface CreditCardLiabilityEventLifecycleResult {
	eventId: string;
	revisionId: string;
	revisionNo: number;
	operation: CreditCardLiabilityEventOperation;
	status: "POSTED" | "VOID";
	idempotentReplay: boolean;
	snapshot: CreditCardPurchaseSnapshot;
}

// ============================================================================
// Params Interfaces
// ============================================================================

export interface RecordCreditCardPurchaseInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	cardId: string;
	amount: string;
	purchaseCategory: string;
	shortTermGoalId?: string | null | undefined;
	merchant?: string | null | undefined;
	description?: string | null | undefined;
	installmentCount?: number | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface RecordCreditCardPurchaseParams {
	db: Database;
	userId: string;
	cardId: string;
	amount: string;
	purchaseCategory: string;
	shortTermGoalId?: string | null | undefined;
	merchant?: string | null | undefined;
	description?: string | null | undefined;
	installmentCount?: number | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateCreditCardPurchaseInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	amount: string;
	purchaseCategory: string;
	shortTermGoalId?: string | null | undefined;
	merchant?: string | null | undefined;
	description?: string | null | undefined;
	installmentCount?: number | null | undefined;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateCreditCardPurchaseParams {
	db: Database;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	amount: string;
	purchaseCategory: string;
	shortTermGoalId?: string | null | undefined;
	merchant?: string | null | undefined;
	description?: string | null | undefined;
	installmentCount?: number | null | undefined;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface VoidCreditCardPurchaseInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface VoidCreditCardPurchaseParams {
	db: Database;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface RecordCreditCardOpeningBalanceInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	cardId: string;
	amount: string;
	description?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface RecordCreditCardOpeningBalanceParams {
	db: Database;
	userId: string;
	cardId: string;
	amount: string;
	description?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateCreditCardOpeningBalanceInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	amount: string;
	description?: string | null | undefined;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateCreditCardOpeningBalanceParams {
	db: Database;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	amount: string;
	description?: string | null | undefined;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface VoidCreditCardOpeningBalanceInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface VoidCreditCardOpeningBalanceParams {
	db: Database;
	userId: string;
	eventId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetCreditCardPurchaseParams {
	db: Database;
	userId: string;
	eventId: string;
}

export interface ListCreditCardPurchasesInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	cardId?: string | undefined;
	status?: "POSTED" | "VOID" | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export interface ListCreditCardPurchasesParams {
	db: Database;
	userId: string;
	cardId?: string | undefined;
	status?: "POSTED" | "VOID" | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

// ============================================================================
// Internal Helpers
// ============================================================================

export function normalizePurchaseBudgetCategory(
	category: string,
): CreditCardPurchaseBudgetCategory {
	const upper = category.trim().toUpperCase();
	if (upper === "MANDATORY" || upper === "MANDATORY_EXPENSE") {
		return "MANDATORY_EXPENSE";
	}
	if (upper === "DISCRETIONARY" || upper === "DISCRETIONARY_SPEND") {
		return "DISCRETIONARY_SPEND";
	}
	if (upper === "SHORT_TERM_PURCHASE") {
		return "SHORT_TERM_PURCHASE";
	}
	if (upper === "UNCLASSIFIED") {
		return "UNCLASSIFIED";
	}
	throw new CreditCardError(
		"CREDIT_CARD_INVALID_INPUT",
		`Invalid purchase category: "${category}"`,
	);
}

// ============================================================================
// Purchase Lifecycle
// ============================================================================

/**
 * Records a fresh credit card purchase inside a transaction with double-entry accounting.
 * DR Expense Account, CR Credit Card Liability Account.
 */
export async function recordCreditCardPurchaseInTransaction({
	tx,
	userId,
	cardId,
	amount,
	purchaseCategory,
	shortTermGoalId,
	merchant,
	description,
	installmentCount,
	occurredAt,
	idempotencyKey,
}: RecordCreditCardPurchaseInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	// 1. Input Validation
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validCardId = validateCcCanonicalUuid(cardId, "cardId");
	const validAmount = validateCcPositiveMoneyString(
		amount,
		"amount",
	).normalized;
	const parsedCat = validatePurchaseCategory(purchaseCategory);
	const validCategory = normalizePurchaseBudgetCategory(parsedCat);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validMerchant = validateCcOptionalText(merchant, "merchant", 200);
	const validDesc = validateCcOptionalText(description, "description", 500);
	const validInstallmentCount = validateInstallmentCount(installmentCount);
	const validGoalId = shortTermGoalId
		? validateCcCanonicalUuid(shortTermGoalId, "shortTermGoalId")
		: null;

	if (validCategory === "SHORT_TERM_PURCHASE" && !validGoalId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"shortTermGoalId is required when purchaseCategory is SHORT_TERM_PURCHASE",
		);
	}
	if (validCategory !== "SHORT_TERM_PURCHASE" && validGoalId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"shortTermGoalId is only allowed for SHORT_TERM_PURCHASE category",
		);
	}

	// 1.1 EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkPurchaseCreateReplay(
			tx,
			earlyRev,
			validUserId,
			validCardId,
			validAmount,
			validCategory,
			validGoalId,
			validMerchant,
			validDesc,
			validInstallmentCount,
			validOccurredAt,
		);
	}

	// 2. Lock Card Anchor FOR UPDATE & Verify Active
	const [card] = await tx
		.select({
			id: creditCards.id,
			code: creditCards.code,
			userId: creditCards.userId,
		})
		.from(creditCards)
		.where(
			and(eq(creditCards.id, validCardId), eq(creditCards.userId, validUserId)),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${validCardId}" not found`,
		);
	}

	// Check latest card status
	const [latestCardRev] = await tx
		.select({ status: creditCardRevisions.status })
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.creditCardId, validCardId),
				eq(creditCardRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (latestCardRev?.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${validCardId}" is not active`,
		);
	}

	// 2.1 SECOND IDEMPOTENCY REPLAY CHECK (under card lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkPurchaseCreateReplay(
			tx,
			secondRev,
			validUserId,
			validCardId,
			validAmount,
			validCategory,
			validGoalId,
			validMerchant,
			validDesc,
			validInstallmentCount,
			validOccurredAt,
		);
	}

	// 3. If Short-term goal, verify goal exists and is ACTIVE
	if (validGoalId) {
		const [goal] = await tx
			.select({
				id: shortTermGoals.id,
				status: shortTermGoalRevisions.status,
			})
			.from(shortTermGoals)
			.innerJoin(
				shortTermGoalRevisions,
				eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
			)
			.where(
				and(
					eq(shortTermGoals.id, validGoalId),
					eq(shortTermGoals.userId, validUserId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);
		if (!goal) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Short-term goal "${validGoalId}" not found`,
			);
		}
		if (goal.status !== "ACTIVE") {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Short-term goal "${validGoalId}" is not ACTIVE`,
			);
		}
	}

	// 4. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		validCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);
	const role = mapPurchaseCategoryToSystemRole(validCategory);
	const expenseAccountId = systemAccounts[role];

	// 5. Lock Ledger Accounts FOR UPDATE
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, expenseAccountId],
	});

	// Pre-generate event ID before canonical transaction creation
	const eventId = crypto.randomUUID();
	const canonicalPurchaseDate = formatIstanbulPurchaseDate(validOccurredAt);

	// 6. Post Canonical Transaction with Ledger Lines
	const canonicalRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		kind: "CREDIT_CARD_PURCHASE",
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		payload: {
			eventId,
			cardId: validCardId,
			amount: validAmount,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
			installmentCount: validInstallmentCount,
			purchaseDate: canonicalPurchaseDate,
		},
		source: {
			type: "CREDIT_CARD_PURCHASE",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card purchase: ${validMerchant ? `${validMerchant} ` : ""}(${card.code})`,
			lines: [
				{
					accountId: expenseAccountId,
					side: "DEBIT",
					amount: validAmount,
				},
				{
					accountId: liabilityAccountId,
					side: "CREDIT",
					amount: validAmount,
				},
			],
		},
	});

	// 7. Insert Credit Card Liability Event Anchor
	await tx.insert(creditCardLiabilityEvents).values({
		id: eventId,
		userId: validUserId,
		creditCardId: validCardId,
		eventType: "PURCHASE",
		canonicalTransactionId: canonicalRes.transactionId,
	});

	// 8. Calculate SHA-256 Fingerprint v2 and Insert Revision
	const fingerprint = await calculateLiabilityEventCreateFingerprint({
		userId: validUserId,
		cardId: validCardId,
		eventType: "PURCHASE",
		amount: validAmount,
		purchaseCategory: validCategory,
		shortTermGoalId: validGoalId,
		merchant: validMerchant,
		description: validDesc,
		installmentCount: validInstallmentCount,
		occurredAt: validOccurredAt,
	});

	const newRevisionId = crypto.randomUUID();
	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		eventId,
		revisionNo: 1,
		previousRevisionId: null,
		canonicalRevisionId: canonicalRes.revisionId,
		operation: "CREATE",
		amount: validAmount,
		budgetCategory: validCategory,
		merchant: validMerchant,
		description: validDesc,
		installmentCount: validInstallmentCount,
		purchaseDate: canonicalPurchaseDate,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId,
		revisionId: newRevisionId,
		revisionNo: 1,
		operation: "CREATE",
		status: "POSTED",
		idempotentReplay: false,
		snapshot: {
			amount: validAmount,
			purchaseDate: canonicalPurchaseDate,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
			installmentCount: validInstallmentCount,
			reasonNote: null,
		},
	};
}

async function checkPurchaseCreateReplay(
	_tx: DatabaseTransaction,
	existingRev: typeof creditCardLiabilityEventRevisions.$inferSelect,
	userId: string,
	cardId: string,
	amount: string,
	category: CreditCardPurchaseBudgetCategory,
	goalId: string | null,
	merchant: string | null,
	description: string | null,
	installmentCount: number | null,
	occurredAt: Date,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	const fpV2 = await calculateLiabilityEventCreateFingerprint({
		userId,
		cardId,
		eventType: "PURCHASE",
		amount,
		purchaseCategory: category,
		shortTermGoalId: goalId,
		merchant,
		description,
		installmentCount,
		occurredAt,
	});

	const fpV1 = await calculateLiabilityEventCreateFingerprintV1({
		userId,
		cardId,
		eventType: "PURCHASE",
		amount,
		purchaseCategory: category,
		shortTermGoalId: goalId,
		merchant,
		description,
		occurredAt,
	});

	if (
		existingRev.revisionFingerprint !== fpV2 &&
		existingRev.revisionFingerprint !== fpV1
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different purchase payload",
		);
	}

	// For v1 replay: check that caller installment intent matches stored projection
	if (
		existingRev.revisionFingerprint === fpV1 &&
		installmentCount !== null &&
		existingRev.installmentCount !== installmentCount
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different installmentCount",
		);
	}

	return {
		eventId: existingRev.eventId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: existingRev.operation as CreditCardLiabilityEventOperation,
		status: "POSTED",
		idempotentReplay: true,
		snapshot: {
			amount: existingRev.amount,
			purchaseDate: existingRev.purchaseDate,
			purchaseCategory:
				existingRev.budgetCategory as CreditCardPurchaseBudgetCategory,
			shortTermGoalId: goalId,
			merchant: existingRev.merchant,
			description: existingRev.description,
			installmentCount: existingRev.installmentCount ?? null,
			reasonNote: null,
		},
	};
}

/**
 * Records a fresh credit card purchase.
 */
export async function recordCreditCardPurchase(
	params: RecordCreditCardPurchaseParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return recordCreditCardPurchaseInTransaction({ tx, ...params });
	});
}

/**
 * Updates an existing credit card purchase.
 */
export async function updateCreditCardPurchaseInTransaction({
	tx,
	userId,
	eventId,
	expectedRevisionNo,
	amount,
	purchaseCategory,
	shortTermGoalId,
	merchant,
	description,
	installmentCount,
	reasonNote,
	occurredAt,
	idempotencyKey,
}: UpdateCreditCardPurchaseInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validEventId = validateCcCanonicalUuid(eventId, "eventId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validAmount = validateCcPositiveMoneyString(
		amount,
		"amount",
	).normalized;
	const parsedCat = validatePurchaseCategory(purchaseCategory);
	const validCategory = normalizePurchaseBudgetCategory(parsedCat);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validMerchant = validateCcOptionalText(merchant, "merchant", 200);
	const validDesc = validateCcOptionalText(description, "description", 500);
	const validReason = validateCcOptionalText(reasonNote, "reasonNote", 500);
	const validInstallmentCount = validateInstallmentCount(installmentCount);
	const validGoalId = shortTermGoalId
		? validateCcCanonicalUuid(shortTermGoalId, "shortTermGoalId")
		: null;

	if (validCategory === "SHORT_TERM_PURCHASE" && !validGoalId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"shortTermGoalId is required when purchaseCategory is SHORT_TERM_PURCHASE",
		);
	}
	if (validCategory !== "SHORT_TERM_PURCHASE" && validGoalId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"shortTermGoalId is only allowed for SHORT_TERM_PURCHASE category",
		);
	}

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkPurchaseUpdateReplay(
			tx,
			earlyRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validAmount,
			validCategory,
			validGoalId,
			validMerchant,
			validDesc,
			validInstallmentCount,
			validReason,
			validOccurredAt,
		);
	}

	// 2. Resolve Event Anchor without lock to find cardId
	const [event] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.limit(1);

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "PURCHASE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is not a PURCHASE`,
		);
	}

	// 3. Lock Card Anchor FOR UPDATE & Verify Active
	const [card] = await tx
		.select()
		.from(creditCards)
		.where(
			and(
				eq(creditCards.id, event.creditCardId),
				eq(creditCards.userId, validUserId),
			),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${event.creditCardId}" not found`,
		);
	}

	const [latestCardRev] = await tx
		.select({ status: creditCardRevisions.status })
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.creditCardId, event.creditCardId),
				eq(creditCardRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (latestCardRev?.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${event.creditCardId}" is not active`,
		);
	}

	// 4. Lock Event Anchor FOR UPDATE
	await tx
		.select({ id: creditCardLiabilityEvents.id })
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	// 4.1 SECOND IDEMPOTENCY REPLAY CHECK (under lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkPurchaseUpdateReplay(
			tx,
			secondRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validAmount,
			validCategory,
			validGoalId,
			validMerchant,
			validDesc,
			validInstallmentCount,
			validReason,
			validOccurredAt,
		);
	}

	// 5. Fetch latest revision
	const [latestRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, validEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for event "${validEventId}"`,
		);
	}

	if (latestRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			`Cannot update VOID purchase "${validEventId}"`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	// Verify short-term goal if applicable
	if (validGoalId) {
		const [goal] = await tx
			.select({
				id: shortTermGoals.id,
				status: shortTermGoalRevisions.status,
			})
			.from(shortTermGoals)
			.innerJoin(
				shortTermGoalRevisions,
				eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
			)
			.where(
				and(
					eq(shortTermGoals.id, validGoalId),
					eq(shortTermGoals.userId, validUserId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);
		if (goal?.status !== "ACTIVE") {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Short-term goal "${validGoalId}" is not active`,
			);
		}
	}

	// 6. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		event.creditCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);

	const oldRole = mapPurchaseCategoryToSystemRole(
		latestRev.budgetCategory as CreditCardPurchaseBudgetCategory,
	);
	const newRole = mapPurchaseCategoryToSystemRole(validCategory);
	const oldExpenseAccountId = systemAccounts[oldRole];
	const newExpenseAccountId = systemAccounts[newRole];

	// Lock ledger accounts
	const accountIdsToLock = Array.from(
		new Set([liabilityAccountId, oldExpenseAccountId, newExpenseAccountId]),
	);
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: accountIdsToLock,
	});

	// 7. Verify Liability Non-Negativity Pre-check
	const currentBal = await getLedgerAccountBalanceInTransaction({
		tx,
		userId: validUserId,
		accountId: liabilityAccountId,
	});
	const currentCents = parseSignedAggregateMoneyString(
		currentBal.balance,
	).cents;
	const oldCents = parsePositiveMoneyString(latestRev.amount).cents;
	const newCents = parsePositiveMoneyString(validAmount).cents;
	const netDiff = newCents - oldCents;

	if (currentCents + netDiff < 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			"Updating purchase would result in negative credit card liability balance",
		);
	}

	// 8. Fetch latest canonical revision
	const [canonicalRev] = await tx
		.select({ revisionNo: transactionRevisions.revisionNo })
		.from(transactionRevisions)
		.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
		.limit(1);

	if (!canonicalRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Canonical revision "${latestRev.canonicalRevisionId}" not found`,
		);
	}

	const canonicalPurchaseDate = formatIstanbulPurchaseDate(validOccurredAt);

	const canonicalRes = await reviseCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: event.canonicalTransactionId,
		expectedRevisionNo: canonicalRev.revisionNo,
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
			eventId: validEventId,
			cardId: event.creditCardId,
			amount: validAmount,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
			installmentCount: validInstallmentCount,
			purchaseDate: canonicalPurchaseDate,
		},
		reasonCode: "PURCHASE_UPDATE",
		reasonNote: validReason,
		source: {
			type: "CREDIT_CARD_PURCHASE",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card purchase update: ${validMerchant ? `${validMerchant} ` : ""}(${card.code})`,
			lines: [
				{
					accountId: newExpenseAccountId,
					side: "DEBIT",
					amount: validAmount,
				},
				{
					accountId: liabilityAccountId,
					side: "CREDIT",
					amount: validAmount,
				},
			],
		},
	});

	const newRevisionId = crypto.randomUUID();
	const newRevisionNo = latestRev.revisionNo + 1;

	const fingerprint = await calculateLiabilityEventUpdateFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		amount: validAmount,
		purchaseCategory: validCategory,
		shortTermGoalId: validGoalId,
		merchant: validMerchant,
		description: validDesc,
		installmentCount: validInstallmentCount,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		eventId: validEventId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		canonicalRevisionId: canonicalRes.revisionId,
		operation: "UPDATE",
		amount: validAmount,
		budgetCategory: validCategory,
		merchant: validMerchant,
		description: validDesc,
		installmentCount: validInstallmentCount,
		purchaseDate: canonicalPurchaseDate,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId: validEventId,
		revisionId: newRevisionId,
		revisionNo: newRevisionNo,
		operation: "UPDATE",
		status: "POSTED",
		idempotentReplay: false,
		snapshot: {
			amount: validAmount,
			purchaseDate: canonicalPurchaseDate,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
			installmentCount: validInstallmentCount,
			reasonNote: validReason,
		},
	};
}

async function checkPurchaseUpdateReplay(
	tx: DatabaseTransaction,
	existingRev: typeof creditCardLiabilityEventRevisions.$inferSelect,
	userId: string,
	eventId: string,
	expectedRevisionNo: number,
	amount: string,
	category: CreditCardPurchaseBudgetCategory,
	goalId: string | null,
	merchant: string | null,
	description: string | null,
	installmentCount: number | null,
	reasonNote: string | null,
	occurredAt: Date,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	const fpV2 = await calculateLiabilityEventUpdateFingerprint({
		userId,
		eventId,
		expectedRevisionNo,
		amount,
		purchaseCategory: category,
		shortTermGoalId: goalId,
		merchant,
		description,
		installmentCount,
		reasonNote,
		occurredAt,
	});

	const fpV1 = await calculateLiabilityEventUpdateFingerprintV1({
		userId,
		eventId,
		expectedRevisionNo,
		amount,
		purchaseCategory: category,
		shortTermGoalId: goalId,
		merchant,
		description,
		occurredAt,
	});

	if (
		existingRev.revisionFingerprint !== fpV2 &&
		existingRev.revisionFingerprint !== fpV1
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different update payload",
		);
	}

	// For legacy v1 replay: check reasonNote and installmentCount against canonical revision
	if (existingRev.revisionFingerprint === fpV1) {
		if (
			installmentCount !== null &&
			existingRev.installmentCount !== installmentCount
		) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different installmentCount",
			);
		}
		const [canRev] = await tx
			.select({ reasonNote: transactionRevisions.reasonNote })
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, existingRev.canonicalRevisionId))
			.limit(1);

		if (canRev && (canRev.reasonNote ?? null) !== reasonNote) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different reasonNote",
			);
		}
	}

	return {
		eventId: existingRev.eventId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: existingRev.operation as CreditCardLiabilityEventOperation,
		status: "POSTED",
		idempotentReplay: true,
		snapshot: {
			amount: existingRev.amount,
			purchaseDate: existingRev.purchaseDate,
			purchaseCategory:
				existingRev.budgetCategory as CreditCardPurchaseBudgetCategory,
			shortTermGoalId: goalId,
			merchant: existingRev.merchant,
			description: existingRev.description,
			installmentCount: existingRev.installmentCount ?? null,
			reasonNote,
		},
	};
}

/**
 * Updates an existing credit card purchase.
 */
export async function updateCreditCardPurchase(
	params: UpdateCreditCardPurchaseParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return updateCreditCardPurchaseInTransaction({ tx, ...params });
	});
}

/**
 * Voids an existing credit card purchase inside a transaction.
 */
export async function voidCreditCardPurchaseInTransaction({
	tx,
	userId,
	eventId,
	expectedRevisionNo,
	reasonNote,
	occurredAt,
	idempotencyKey,
}: VoidCreditCardPurchaseInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validEventId = validateCcCanonicalUuid(eventId, "eventId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validReason = validateCcOptionalText(reasonNote, "reasonNote", 500);

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkPurchaseVoidReplay(
			earlyRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validReason,
			validOccurredAt,
		);
	}

	// 2. Resolve Event Anchor without lock to find cardId
	const [event] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.limit(1);

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "PURCHASE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is not a PURCHASE`,
		);
	}

	// 3. Lock Card Anchor FOR UPDATE & Verify Active
	const [card] = await tx
		.select()
		.from(creditCards)
		.where(
			and(
				eq(creditCards.id, event.creditCardId),
				eq(creditCards.userId, validUserId),
			),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${event.creditCardId}" not found`,
		);
	}

	const [latestCardRev] = await tx
		.select({ status: creditCardRevisions.status })
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.creditCardId, event.creditCardId),
				eq(creditCardRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (latestCardRev?.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${event.creditCardId}" is not active`,
		);
	}

	// 4. Lock Event Anchor FOR UPDATE
	await tx
		.select({ id: creditCardLiabilityEvents.id })
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	// 4.1 SECOND IDEMPOTENCY REPLAY CHECK (under lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkPurchaseVoidReplay(
			secondRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validReason,
			validOccurredAt,
		);
	}

	// 5. Fetch latest revision
	const [latestRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, validEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for event "${validEventId}"`,
		);
	}

	if (latestRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			`Purchase "${validEventId}" is already voided`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	// 6. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		event.creditCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);
	const role = mapPurchaseCategoryToSystemRole(
		latestRev.budgetCategory as CreditCardPurchaseBudgetCategory,
	);
	const expenseAccountId = systemAccounts[role];

	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, expenseAccountId],
	});

	// 7. Verify Liability Non-Negativity Pre-check
	const currentBal = await getLedgerAccountBalanceInTransaction({
		tx,
		userId: validUserId,
		accountId: liabilityAccountId,
	});
	const currentCents = parseSignedAggregateMoneyString(
		currentBal.balance,
	).cents;
	const voidCents = parsePositiveMoneyString(latestRev.amount).cents;

	if (currentCents - voidCents < 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			"Voiding purchase would result in negative credit card liability balance",
		);
	}

	// 8. Fetch latest canonical revision
	const [canonicalRev] = await tx
		.select({ revisionNo: transactionRevisions.revisionNo })
		.from(transactionRevisions)
		.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
		.limit(1);

	if (!canonicalRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Canonical revision "${latestRev.canonicalRevisionId}" not found`,
		);
	}

	const canonicalRes = await voidCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: event.canonicalTransactionId,
		expectedRevisionNo: canonicalRev.revisionNo,
		idempotencyKey: validKey,
		reasonCode: "PURCHASE_VOID",
		reasonNote: validReason,
		source: {
			type: "CREDIT_CARD_PURCHASE",
			ref: validKey,
		},
	});

	const newRevisionId = crypto.randomUUID();
	const newRevisionNo = latestRev.revisionNo + 1;

	const fingerprint = await calculateLiabilityEventVoidFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		eventId: validEventId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		canonicalRevisionId: canonicalRes.revisionId,
		operation: "VOID",
		amount: latestRev.amount,
		budgetCategory: latestRev.budgetCategory,
		merchant: latestRev.merchant,
		description: latestRev.description,
		installmentCount: latestRev.installmentCount,
		purchaseDate: latestRev.purchaseDate,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId: validEventId,
		revisionId: newRevisionId,
		revisionNo: newRevisionNo,
		operation: "VOID",
		status: "VOID",
		idempotentReplay: false,
		snapshot: {
			amount: latestRev.amount,
			purchaseDate: latestRev.purchaseDate,
			purchaseCategory:
				latestRev.budgetCategory as CreditCardPurchaseBudgetCategory,
			shortTermGoalId: null,
			merchant: latestRev.merchant,
			description: latestRev.description,
			installmentCount: latestRev.installmentCount ?? null,
			reasonNote: validReason,
		},
	};
}

async function checkPurchaseVoidReplay(
	existingRev: typeof creditCardLiabilityEventRevisions.$inferSelect,
	userId: string,
	eventId: string,
	expectedRevisionNo: number,
	reasonNote: string | null,
	occurredAt: Date,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	const fpV2 = await calculateLiabilityEventVoidFingerprint({
		userId,
		eventId,
		expectedRevisionNo,
		reasonNote,
		occurredAt,
	});
	const fpV1 = await calculateLiabilityEventVoidFingerprintV1({
		userId,
		eventId,
		expectedRevisionNo,
		reasonNote,
		occurredAt,
	});

	if (
		existingRev.revisionFingerprint !== fpV2 &&
		existingRev.revisionFingerprint !== fpV1
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different void payload",
		);
	}

	return {
		eventId: existingRev.eventId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: "VOID",
		status: "VOID",
		idempotentReplay: true,
		snapshot: {
			amount: existingRev.amount,
			purchaseDate: existingRev.purchaseDate,
			purchaseCategory:
				existingRev.budgetCategory as CreditCardPurchaseBudgetCategory,
			shortTermGoalId: null,
			merchant: existingRev.merchant,
			description: existingRev.description,
			installmentCount: existingRev.installmentCount ?? null,
			reasonNote,
		},
	};
}

/**
 * Voids an existing credit card purchase.
 */
export async function voidCreditCardPurchase(
	params: VoidCreditCardPurchaseParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return voidCreditCardPurchaseInTransaction({ tx, ...params });
	});
}

// ============================================================================
// Opening Balance Lifecycle
// ============================================================================

/**
 * Records an initial credit card opening balance.
 * DR OPENING_EQUITY, CR Card Liability Account.
 */
export async function recordCreditCardOpeningBalanceInTransaction({
	tx,
	userId,
	cardId,
	amount,
	description,
	occurredAt,
	idempotencyKey,
}: RecordCreditCardOpeningBalanceInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validCardId = validateCcCanonicalUuid(cardId, "cardId");
	const validAmount = validateCcPositiveMoneyString(
		amount,
		"amount",
	).normalized;
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validDesc = validateCcOptionalText(description, "description", 500);

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkOpeningCreateReplay(
			earlyRev,
			validUserId,
			validCardId,
			validAmount,
			validDesc,
			validOccurredAt,
		);
	}

	// 2. Lock Card Anchor FOR UPDATE & Verify Active
	const [card] = await tx
		.select({
			id: creditCards.id,
			code: creditCards.code,
			userId: creditCards.userId,
		})
		.from(creditCards)
		.where(
			and(eq(creditCards.id, validCardId), eq(creditCards.userId, validUserId)),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${validCardId}" not found`,
		);
	}

	const [latestCardRev] = await tx
		.select({ status: creditCardRevisions.status })
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.creditCardId, validCardId),
				eq(creditCardRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (latestCardRev?.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${validCardId}" is not active`,
		);
	}

	// 2.1 SECOND IDEMPOTENCY REPLAY CHECK (under card lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkOpeningCreateReplay(
			secondRev,
			validUserId,
			validCardId,
			validAmount,
			validDesc,
			validOccurredAt,
		);
	}

	// 3. Ensure card does not already have an opening balance event
	const [existingOpening] = await tx
		.select({ id: creditCardLiabilityEvents.id })
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.creditCardId, validCardId),
				eq(creditCardLiabilityEvents.eventType, "OPENING_BALANCE"),
			),
		)
		.limit(1);

	if (existingOpening) {
		throw new CreditCardError(
			"CREDIT_CARD_OPENING_BALANCE_CONFLICT",
			`Credit card "${validCardId}" already has an opening balance event`,
		);
	}

	// 4. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		validCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);
	const equityAccountId = systemAccounts.OPENING_EQUITY;

	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, equityAccountId],
	});

	const eventId = crypto.randomUUID();

	// 5. Post Canonical Transaction
	const canonicalRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		kind: "CREDIT_CARD_OPENING_BALANCE",
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		payload: {
			eventId,
			cardId: validCardId,
			amount: validAmount,
			description: validDesc,
		},
		source: {
			type: "CREDIT_CARD_OPENING_BALANCE",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card opening balance: ${card.code}`,
			lines: [
				{
					accountId: equityAccountId,
					side: "DEBIT",
					amount: validAmount,
				},
				{
					accountId: liabilityAccountId,
					side: "CREDIT",
					amount: validAmount,
				},
			],
		},
	});

	// 6. Insert Event Anchor & Revision
	await tx.insert(creditCardLiabilityEvents).values({
		id: eventId,
		userId: validUserId,
		creditCardId: validCardId,
		eventType: "OPENING_BALANCE",
		canonicalTransactionId: canonicalRes.transactionId,
	});

	const fingerprint = await calculateLiabilityEventCreateFingerprint({
		userId: validUserId,
		cardId: validCardId,
		eventType: "OPENING_BALANCE",
		amount: validAmount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: validDesc,
		installmentCount: null,
		occurredAt: validOccurredAt,
	});

	const newRevisionId = crypto.randomUUID();
	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		eventId,
		revisionNo: 1,
		previousRevisionId: null,
		canonicalRevisionId: canonicalRes.revisionId,
		operation: "CREATE",
		amount: validAmount,
		budgetCategory: null,
		merchant: null,
		description: validDesc,
		installmentCount: null,
		purchaseDate: null,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId,
		revisionId: newRevisionId,
		revisionNo: 1,
		operation: "CREATE",
		status: "POSTED",
		idempotentReplay: false,
		snapshot: {
			amount: validAmount,
			purchaseDate: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: validDesc,
			installmentCount: null,
			reasonNote: null,
		},
	};
}

async function checkOpeningCreateReplay(
	existingRev: typeof creditCardLiabilityEventRevisions.$inferSelect,
	userId: string,
	cardId: string,
	amount: string,
	description: string | null,
	occurredAt: Date,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	const fpV2 = await calculateLiabilityEventCreateFingerprint({
		userId,
		cardId,
		eventType: "OPENING_BALANCE",
		amount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description,
		installmentCount: null,
		occurredAt,
	});
	const fpV1 = await calculateLiabilityEventCreateFingerprintV1({
		userId,
		cardId,
		eventType: "OPENING_BALANCE",
		amount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description,
		occurredAt,
	});

	if (
		existingRev.revisionFingerprint !== fpV2 &&
		existingRev.revisionFingerprint !== fpV1
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different opening balance payload",
		);
	}

	return {
		eventId: existingRev.eventId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: "CREATE",
		status: "POSTED",
		idempotentReplay: true,
		snapshot: {
			amount: existingRev.amount,
			purchaseDate: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: existingRev.description,
			installmentCount: null,
			reasonNote: null,
		},
	};
}

/**
 * Records an initial credit card opening balance.
 */
export async function recordCreditCardOpeningBalance(
	params: RecordCreditCardOpeningBalanceParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return recordCreditCardOpeningBalanceInTransaction({ tx, ...params });
	});
}

/**
 * Updates a credit card opening balance inside a transaction.
 */
export async function updateCreditCardOpeningBalanceInTransaction({
	tx,
	userId,
	eventId,
	expectedRevisionNo,
	amount,
	description,
	reasonNote,
	occurredAt,
	idempotencyKey,
}: UpdateCreditCardOpeningBalanceInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validEventId = validateCcCanonicalUuid(eventId, "eventId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validAmount = validateCcPositiveMoneyString(
		amount,
		"amount",
	).normalized;
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validDesc = validateCcOptionalText(description, "description", 500);
	const validReason = validateCcOptionalText(reasonNote, "reasonNote", 500);

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkOpeningUpdateReplay(
			tx,
			earlyRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validAmount,
			validDesc,
			validReason,
			validOccurredAt,
		);
	}

	// 2. Resolve Event Anchor without lock to find cardId
	const [event] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.limit(1);

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "OPENING_BALANCE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is not an OPENING_BALANCE`,
		);
	}

	// 3. Lock Card Anchor FOR UPDATE & Verify Active
	const [card] = await tx
		.select()
		.from(creditCards)
		.where(
			and(
				eq(creditCards.id, event.creditCardId),
				eq(creditCards.userId, validUserId),
			),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${event.creditCardId}" not found`,
		);
	}

	const [latestCardRev] = await tx
		.select({ status: creditCardRevisions.status })
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.creditCardId, event.creditCardId),
				eq(creditCardRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (!latestCardRev || latestCardRev.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${event.creditCardId}" is not active`,
		);
	}

	// 4. Lock Event Anchor FOR UPDATE
	await tx
		.select({ id: creditCardLiabilityEvents.id })
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	// 4.1 SECOND IDEMPOTENCY REPLAY CHECK (under lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkOpeningUpdateReplay(
			tx,
			secondRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validAmount,
			validDesc,
			validReason,
			validOccurredAt,
		);
	}

	// 5. Fetch latest revision
	const [latestRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, validEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for event "${validEventId}"`,
		);
	}

	if (latestRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			`Cannot update VOID opening balance "${validEventId}"`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	// 6. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		event.creditCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);
	const equityAccountId = systemAccounts.OPENING_EQUITY;

	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, equityAccountId],
	});

	// 7. Verify Liability Non-Negativity Pre-check
	const currentBal = await getLedgerAccountBalanceInTransaction({
		tx,
		userId: validUserId,
		accountId: liabilityAccountId,
	});
	const currentCents = parseSignedAggregateMoneyString(
		currentBal.balance,
	).cents;
	const oldCents = parsePositiveMoneyString(latestRev.amount).cents;
	const newCents = parsePositiveMoneyString(validAmount).cents;
	const netDiff = newCents - oldCents;

	if (currentCents + netDiff < 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			"Updating opening balance would result in negative credit card liability balance",
		);
	}

	// 8. Fetch latest canonical revision
	const [canonicalRev] = await tx
		.select({ revisionNo: transactionRevisions.revisionNo })
		.from(transactionRevisions)
		.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
		.limit(1);

	if (!canonicalRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Canonical revision "${latestRev.canonicalRevisionId}" not found`,
		);
	}

	const canonicalRes = await reviseCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: event.canonicalTransactionId,
		expectedRevisionNo: canonicalRev.revisionNo,
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
			eventId: validEventId,
			cardId: event.creditCardId,
			amount: validAmount,
			description: validDesc,
		},
		reasonCode: "OPENING_BALANCE_UPDATE",
		reasonNote: validReason,
		source: {
			type: "CREDIT_CARD_OPENING_BALANCE",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card opening balance update: ${card.code}`,
			lines: [
				{
					accountId: equityAccountId,
					side: "DEBIT",
					amount: validAmount,
				},
				{
					accountId: liabilityAccountId,
					side: "CREDIT",
					amount: validAmount,
				},
			],
		},
	});

	const newRevisionId = crypto.randomUUID();
	const newRevisionNo = latestRev.revisionNo + 1;

	const fingerprint = await calculateLiabilityEventUpdateFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		amount: validAmount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: validDesc,
		installmentCount: null,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		eventId: validEventId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		canonicalRevisionId: canonicalRes.revisionId,
		operation: "UPDATE",
		amount: validAmount,
		budgetCategory: null,
		merchant: null,
		description: validDesc,
		installmentCount: null,
		purchaseDate: null,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId: validEventId,
		revisionId: newRevisionId,
		revisionNo: newRevisionNo,
		operation: "UPDATE",
		status: "POSTED",
		idempotentReplay: false,
		snapshot: {
			amount: validAmount,
			purchaseDate: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: validDesc,
			installmentCount: null,
			reasonNote: validReason,
		},
	};
}

async function checkOpeningUpdateReplay(
	tx: DatabaseTransaction,
	existingRev: typeof creditCardLiabilityEventRevisions.$inferSelect,
	userId: string,
	eventId: string,
	expectedRevisionNo: number,
	amount: string,
	description: string | null,
	reasonNote: string | null,
	occurredAt: Date,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	const fpV2 = await calculateLiabilityEventUpdateFingerprint({
		userId,
		eventId,
		expectedRevisionNo,
		amount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description,
		installmentCount: null,
		reasonNote,
		occurredAt,
	});

	const fpV1 = await calculateLiabilityEventUpdateFingerprintV1({
		userId,
		eventId,
		expectedRevisionNo,
		amount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description,
		occurredAt,
	});

	if (
		existingRev.revisionFingerprint !== fpV2 &&
		existingRev.revisionFingerprint !== fpV1
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different update payload",
		);
	}

	if (existingRev.revisionFingerprint === fpV1) {
		const [canRev] = await tx
			.select({ reasonNote: transactionRevisions.reasonNote })
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, existingRev.canonicalRevisionId))
			.limit(1);

		if (canRev && (canRev.reasonNote ?? null) !== reasonNote) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different reasonNote",
			);
		}
	}

	return {
		eventId: existingRev.eventId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: "UPDATE",
		status: "POSTED",
		idempotentReplay: true,
		snapshot: {
			amount: existingRev.amount,
			purchaseDate: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: existingRev.description,
			installmentCount: null,
			reasonNote,
		},
	};
}

/**
 * Updates a credit card opening balance.
 */
export async function updateCreditCardOpeningBalance(
	params: UpdateCreditCardOpeningBalanceParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return updateCreditCardOpeningBalanceInTransaction({ tx, ...params });
	});
}

/**
 * Voids a credit card opening balance inside a transaction.
 */
export async function voidCreditCardOpeningBalanceInTransaction({
	tx,
	userId,
	eventId,
	expectedRevisionNo,
	reasonNote,
	occurredAt,
	idempotencyKey,
}: VoidCreditCardOpeningBalanceInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validEventId = validateCcCanonicalUuid(eventId, "eventId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validReason = validateCcOptionalText(reasonNote, "reasonNote", 500);

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkOpeningVoidReplay(
			earlyRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validReason,
			validOccurredAt,
		);
	}

	// 2. Resolve Event Anchor without lock to find cardId
	const [event] = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.limit(1);

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "OPENING_BALANCE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is not an OPENING_BALANCE`,
		);
	}

	// 3. Lock Card Anchor FOR UPDATE & Verify Active
	const [card] = await tx
		.select()
		.from(creditCards)
		.where(
			and(
				eq(creditCards.id, event.creditCardId),
				eq(creditCards.userId, validUserId),
			),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${event.creditCardId}" not found`,
		);
	}

	const [latestCardRev] = await tx
		.select({ status: creditCardRevisions.status })
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.creditCardId, event.creditCardId),
				eq(creditCardRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (!latestCardRev || latestCardRev.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${event.creditCardId}" is not active`,
		);
	}

	// 4. Lock Event Anchor FOR UPDATE
	await tx
		.select({ id: creditCardLiabilityEvents.id })
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	// 4.1 SECOND IDEMPOTENCY REPLAY CHECK (under lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkOpeningVoidReplay(
			secondRev,
			validUserId,
			validEventId,
			validExpectedRev,
			validReason,
			validOccurredAt,
		);
	}

	// 5. Fetch latest revision
	const [latestRev] = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, validEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for event "${validEventId}"`,
		);
	}

	if (latestRev.operation === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			`Opening balance "${validEventId}" is already voided`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	// 6. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		event.creditCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);
	const equityAccountId = systemAccounts.OPENING_EQUITY;

	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, equityAccountId],
	});

	// 7. Verify Liability Non-Negativity Pre-check
	const currentBal = await getLedgerAccountBalanceInTransaction({
		tx,
		userId: validUserId,
		accountId: liabilityAccountId,
	});
	const currentCents = parseSignedAggregateMoneyString(
		currentBal.balance,
	).cents;
	const voidCents = parsePositiveMoneyString(latestRev.amount).cents;

	if (currentCents - voidCents < 0n) {
		throw new CreditCardError(
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			"Voiding opening balance would result in negative credit card liability balance",
		);
	}

	// 8. Fetch latest canonical revision
	const [canonicalRev] = await tx
		.select({ revisionNo: transactionRevisions.revisionNo })
		.from(transactionRevisions)
		.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
		.limit(1);

	if (!canonicalRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Canonical revision "${latestRev.canonicalRevisionId}" not found`,
		);
	}

	const canonicalRes = await voidCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: event.canonicalTransactionId,
		expectedRevisionNo: canonicalRev.revisionNo,
		idempotencyKey: validKey,
		reasonCode: "OPENING_BALANCE_VOID",
		reasonNote: validReason,
		source: {
			type: "CREDIT_CARD_OPENING_BALANCE",
			ref: validKey,
		},
	});

	const newRevisionId = crypto.randomUUID();
	const newRevisionNo = latestRev.revisionNo + 1;

	const fingerprint = await calculateLiabilityEventVoidFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		eventId: validEventId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		canonicalRevisionId: canonicalRes.revisionId,
		operation: "VOID",
		amount: latestRev.amount,
		budgetCategory: null,
		merchant: null,
		description: latestRev.description,
		installmentCount: null,
		purchaseDate: null,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId: validEventId,
		revisionId: newRevisionId,
		revisionNo: newRevisionNo,
		operation: "VOID",
		status: "VOID",
		idempotentReplay: false,
		snapshot: {
			amount: latestRev.amount,
			purchaseDate: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: latestRev.description,
			installmentCount: null,
			reasonNote: validReason,
		},
	};
}

async function checkOpeningVoidReplay(
	existingRev: typeof creditCardLiabilityEventRevisions.$inferSelect,
	userId: string,
	eventId: string,
	expectedRevisionNo: number,
	reasonNote: string | null,
	occurredAt: Date,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	const fpV2 = await calculateLiabilityEventVoidFingerprint({
		userId,
		eventId,
		expectedRevisionNo,
		reasonNote,
		occurredAt,
	});
	const fpV1 = await calculateLiabilityEventVoidFingerprintV1({
		userId,
		eventId,
		expectedRevisionNo,
		reasonNote,
		occurredAt,
	});

	if (
		existingRev.revisionFingerprint !== fpV2 &&
		existingRev.revisionFingerprint !== fpV1
	) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different void payload",
		);
	}

	return {
		eventId: existingRev.eventId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: "VOID",
		status: "VOID",
		idempotentReplay: true,
		snapshot: {
			amount: existingRev.amount,
			purchaseDate: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: existingRev.description,
			installmentCount: null,
			reasonNote,
		},
	};
}

/**
 * Voids a credit card opening balance.
 */
export async function voidCreditCardOpeningBalance(
	params: VoidCreditCardOpeningBalanceParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return voidCreditCardOpeningBalanceInTransaction({ tx, ...params });
	});
}

// ============================================================================
// Query Methods
// ============================================================================

/**
 * Retrieves a single credit card purchase or opening balance event by ID.
 */
export async function getCreditCardPurchase({
	db,
	userId,
	eventId,
}: GetCreditCardPurchaseParams): Promise<CreditCardPurchaseRecord> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validEventId = validateCcCanonicalUuid(eventId, "eventId");

	const [event] = await db
		.select()
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.limit(1);

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	const [latestRev] = await db
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(eq(creditCardLiabilityEventRevisions.eventId, validEventId))
		.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for event "${validEventId}"`,
		);
	}

	// Fetch applied journal entry from ledger bindings
	const [binding] = await db
		.select({
			appliedJournalEntryId: transactionLedgerBindings.appliedJournalEntryId,
		})
		.from(transactionLedgerBindings)
		.where(
			eq(transactionLedgerBindings.revisionId, latestRev.canonicalRevisionId),
		)
		.limit(1);

	// Fetch canonical revision payload to extract shortTermGoalId
	const [canonicalRev] = await db
		.select({ payload: transactionRevisions.payload })
		.from(transactionRevisions)
		.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
		.limit(1);

	const payload = canonicalRev?.payload as
		| { shortTermGoalId?: string | null }
		| undefined;
	const shortTermGoalId = payload?.shortTermGoalId ?? null;

	return {
		eventId: event.id,
		cardId: event.creditCardId,
		userId: event.userId,
		eventType: event.eventType as CreditCardLiabilityEventType,
		status: latestRev.operation === "VOID" ? "VOID" : "POSTED",
		revisionNo: latestRev.revisionNo,
		amount: latestRev.amount,
		purchaseDate: latestRev.purchaseDate,
		purchaseCategory:
			latestRev.budgetCategory as CreditCardPurchaseBudgetCategory | null,
		shortTermGoalId,
		merchant: latestRev.merchant,
		description: latestRev.description,
		installmentCount: latestRev.installmentCount ?? null,
		canonicalTransactionId: event.canonicalTransactionId,
		canonicalRevisionId: latestRev.canonicalRevisionId,
		journalEntryId: binding?.appliedJournalEntryId ?? null,
		createdAt: event.createdAt,
	};
}

/**
 * Lists credit card purchases and opening balances inside a transaction using bulk queries.
 */
export async function listCreditCardPurchasesInTransaction({
	tx,
	userId,
	cardId,
	status,
	limit = 50,
	offset = 0,
}: ListCreditCardPurchasesInTransactionParams): Promise<
	CreditCardPurchaseRecord[]
> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatus = validateLiabilityEventStatusFilter(status);
	const validCardId = cardId
		? validateCcCanonicalUuid(cardId, "cardId")
		: undefined;

	const conditions = [eq(creditCardLiabilityEvents.userId, validUserId)];
	if (validCardId) {
		conditions.push(eq(creditCardLiabilityEvents.creditCardId, validCardId));
	}

	// 1. Query event anchors
	const events = await tx
		.select()
		.from(creditCardLiabilityEvents)
		.where(and(...conditions))
		.orderBy(desc(creditCardLiabilityEvents.createdAt))
		.limit(limit)
		.offset(offset);

	if (events.length === 0) {
		return [];
	}

	const eventIds = events.map((e) => e.id);

	// 2. Query revisions for all events in bulk
	const allRevisions = await tx
		.select()
		.from(creditCardLiabilityEventRevisions)
		.where(inArray(creditCardLiabilityEventRevisions.eventId, eventIds))
		.orderBy(
			creditCardLiabilityEventRevisions.eventId,
			desc(creditCardLiabilityEventRevisions.revisionNo),
		);

	// Derive latest revision per event
	const latestRevisionByEventId = new Map<
		string,
		typeof creditCardLiabilityEventRevisions.$inferSelect
	>();
	for (const rev of allRevisions) {
		if (!latestRevisionByEventId.has(rev.eventId)) {
			latestRevisionByEventId.set(rev.eventId, rev);
		}
	}

	// Collect canonical revision IDs for latest revisions
	const canonicalRevisionIds: string[] = [];
	for (const event of events) {
		const latestRev = latestRevisionByEventId.get(event.id);
		if (!latestRev) continue;
		const revStatus = latestRev.operation === "VOID" ? "VOID" : "POSTED";
		if (validStatus && revStatus !== validStatus) continue;
		canonicalRevisionIds.push(latestRev.canonicalRevisionId);
	}

	// 3. Bulk query ledger bindings
	const bindingsByRevisionId = new Map<string, string | null>();
	if (canonicalRevisionIds.length > 0) {
		const bindings = await tx
			.select({
				revisionId: transactionLedgerBindings.revisionId,
				appliedJournalEntryId: transactionLedgerBindings.appliedJournalEntryId,
			})
			.from(transactionLedgerBindings)
			.where(
				inArray(transactionLedgerBindings.revisionId, canonicalRevisionIds),
			);
		for (const b of bindings) {
			bindingsByRevisionId.set(b.revisionId, b.appliedJournalEntryId);
		}
	}

	// 4. Bulk query canonical revision payloads
	const payloadsByRevisionId = new Map<
		string,
		{ shortTermGoalId?: string | null } | undefined
	>();
	if (canonicalRevisionIds.length > 0) {
		const canonicalRevs = await tx
			.select({
				id: transactionRevisions.id,
				payload: transactionRevisions.payload,
			})
			.from(transactionRevisions)
			.where(inArray(transactionRevisions.id, canonicalRevisionIds));
		for (const cr of canonicalRevs) {
			payloadsByRevisionId.set(
				cr.id,
				cr.payload as { shortTermGoalId?: string | null } | undefined,
			);
		}
	}

	// 5. Assemble results in order
	const results: CreditCardPurchaseRecord[] = [];
	for (const ev of events) {
		const latestRev = latestRevisionByEventId.get(ev.id);
		if (!latestRev) continue;

		const revStatus = latestRev.operation === "VOID" ? "VOID" : "POSTED";
		if (validStatus && revStatus !== validStatus) continue;

		const appliedJournalEntryId =
			bindingsByRevisionId.get(latestRev.canonicalRevisionId) ?? null;
		const payload = payloadsByRevisionId.get(latestRev.canonicalRevisionId);
		const shortTermGoalId = payload?.shortTermGoalId ?? null;

		results.push({
			eventId: ev.id,
			cardId: ev.creditCardId,
			userId: ev.userId,
			eventType: ev.eventType as CreditCardLiabilityEventType,
			status: revStatus,
			revisionNo: latestRev.revisionNo,
			amount: latestRev.amount,
			purchaseDate: latestRev.purchaseDate,
			purchaseCategory:
				latestRev.budgetCategory as CreditCardPurchaseBudgetCategory | null,
			shortTermGoalId,
			merchant: latestRev.merchant,
			description: latestRev.description,
			installmentCount: latestRev.installmentCount ?? null,
			canonicalTransactionId: ev.canonicalTransactionId,
			canonicalRevisionId: latestRev.canonicalRevisionId,
			journalEntryId: appliedJournalEntryId,
			createdAt: ev.createdAt,
		});
	}

	return results;
}

/**
 * Lists credit card purchases and opening balances.
 */
export async function listCreditCardPurchases(
	params: ListCreditCardPurchasesParams,
): Promise<CreditCardPurchaseRecord[]> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return listCreditCardPurchasesInTransaction({ tx, ...params });
	});
}
