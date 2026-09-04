import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	type CreditCardLiabilityEventOperation,
	type CreditCardLiabilityEventType,
	type CreditCardPurchaseBudgetCategory,
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
	mapPurchaseCategoryToSystemRole,
} from "../db/schema/credit-card-ledger";
import { creditCards } from "../db/schema/credit-cards";
import {
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import { transactionLedgerBindings } from "../db/schema/transaction-ledger";
import { transactionRevisions } from "../db/schema/transactions";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	reviseCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import {
	formatIstanbulPurchaseDate,
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateCcOptionalText,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validateLiabilityEventStatusFilter,
} from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateLiabilityEventCreateFingerprint,
	calculateLiabilityEventUpdateFingerprint,
	calculateLiabilityEventVoidFingerprint,
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
	category: unknown,
): CreditCardPurchaseBudgetCategory {
	if (typeof category !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`purchaseCategory must be a string, found: ${String(category)}`,
		);
	}
	const normalized = category.trim().toUpperCase();
	switch (normalized) {
		case "MANDATORY":
		case "MANDATORY_EXPENSE":
			return "MANDATORY_EXPENSE";
		case "DISCRETIONARY":
		case "DISCRETIONARY_SPEND":
			return "DISCRETIONARY_SPEND";
		case "SHORT_TERM_PURCHASE":
			return "SHORT_TERM_PURCHASE";
		case "UNCLASSIFIED":
		case "UNCLASSIFIED_EXPENSE":
			return "UNCLASSIFIED";
		default:
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Invalid purchaseCategory: "${category}". Must be MANDATORY, DISCRETIONARY, SHORT_TERM_PURCHASE, or UNCLASSIFIED`,
			);
	}
}

// ============================================================================
// Purchase Domain Service Implementation
// ============================================================================

/**
 * Records a new credit card purchase within an existing transaction.
 * Posts canonical transaction and exact 2-line journal entry (Dr Expense, Cr Card Liability).
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
	occurredAt,
	idempotencyKey,
}: RecordCreditCardPurchaseInTransactionParams): Promise<CreditCardLiabilityEventLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validCardId = validateCcCanonicalUuid(cardId, "cardId");
	const validAmount = validateCcPositiveMoneyString(
		amount,
		"amount",
	).normalized;
	const validCategory = normalizePurchaseBudgetCategory(purchaseCategory);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validMerchant = validateCcOptionalText(merchant, "merchant", 200);
	const validDesc = validateCcOptionalText(description, "description", 500);

	let validGoalId: string | null = null;
	if (validCategory === "SHORT_TERM_PURCHASE") {
		if (!shortTermGoalId) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"shortTermGoalId is required for SHORT_TERM_PURCHASE category",
			);
		}
		validGoalId = validateCcCanonicalUuid(shortTermGoalId, "shortTermGoalId");
	} else if (shortTermGoalId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"shortTermGoalId is only allowed for SHORT_TERM_PURCHASE category",
		);
	}

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardLiabilityEventRevisions.id,
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			purchaseDate: creditCardLiabilityEventRevisions.purchaseDate,
			budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
			merchant: creditCardLiabilityEventRevisions.merchant,
			description: creditCardLiabilityEventRevisions.description,
			revisionFingerprint:
				creditCardLiabilityEventRevisions.revisionFingerprint,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateLiabilityEventCreateFingerprint(
			{
				userId: validUserId,
				cardId: validCardId,
				eventType: "PURCHASE",
				amount: validAmount,
				purchaseCategory: validCategory,
				shortTermGoalId: validGoalId,
				merchant: validMerchant,
				description: validDesc,
				occurredAt: validOccurredAt,
			},
		);

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different purchase payload",
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
				shortTermGoalId: validGoalId,
				merchant: existingRev.merchant,
				description: existingRev.description,
				reasonNote: null,
			},
		};
	}

	// 2. Lock Card FOR UPDATE & Verify Active
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
	const expenseRole = mapPurchaseCategoryToSystemRole(validCategory);
	const expenseAccountId = systemAccounts[expenseRole];

	// Lock ledger accounts deterministically
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, expenseAccountId],
	});

	// 5. Post Canonical Transaction with Ledger Entry
	const canonicalRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		kind: "CREDIT_CARD_PURCHASE",
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
			cardId: validCardId,
			amount: validAmount,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
		},
		source: {
			type: "CREDIT_CARD_PURCHASE",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card purchase: ${validMerchant ?? card.code}`,
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

	const purchaseDate = formatIstanbulPurchaseDate(validOccurredAt);
	const fingerprint = await calculateLiabilityEventCreateFingerprint({
		userId: validUserId,
		cardId: validCardId,
		eventType: "PURCHASE",
		amount: validAmount,
		purchaseCategory: validCategory,
		shortTermGoalId: validGoalId,
		merchant: validMerchant,
		description: validDesc,
		occurredAt: validOccurredAt,
	});

	const eventId = crypto.randomUUID();

	// 6. Insert Event Anchor
	await tx.insert(creditCardLiabilityEvents).values({
		id: eventId,
		userId: validUserId,
		creditCardId: validCardId,
		eventType: "PURCHASE",
		canonicalTransactionId: canonicalRes.transactionId,
	});

	// 7. Insert First Revision
	const revisionId = crypto.randomUUID();
	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: revisionId,
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
		installmentCount: null,
		purchaseDate,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		eventId,
		revisionId,
		revisionNo: 1,
		operation: "CREATE",
		status: "POSTED",
		idempotentReplay: false,
		snapshot: {
			amount: validAmount,
			purchaseDate,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
			reasonNote: null,
		},
	};
}

/**
 * Records a new credit card purchase.
 */
export async function recordCreditCardPurchase(
	params: RecordCreditCardPurchaseParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return recordCreditCardPurchaseInTransaction({ tx, ...params });
	});
}

/**
 * Updates an existing credit card purchase within an existing transaction.
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
	const validCategory = normalizePurchaseBudgetCategory(purchaseCategory);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validMerchant = validateCcOptionalText(merchant, "merchant", 200);
	const validDesc = validateCcOptionalText(description, "description", 500);
	const validReason = validateCcOptionalText(reasonNote, "reasonNote", 500);

	let validGoalId: string | null = null;
	if (validCategory === "SHORT_TERM_PURCHASE") {
		if (!shortTermGoalId) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"shortTermGoalId is required for SHORT_TERM_PURCHASE category",
			);
		}
		validGoalId = validateCcCanonicalUuid(shortTermGoalId, "shortTermGoalId");
	} else if (shortTermGoalId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"shortTermGoalId is only allowed for SHORT_TERM_PURCHASE category",
		);
	}

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardLiabilityEventRevisions.id,
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			purchaseDate: creditCardLiabilityEventRevisions.purchaseDate,
			budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
			merchant: creditCardLiabilityEventRevisions.merchant,
			description: creditCardLiabilityEventRevisions.description,
			revisionFingerprint:
				creditCardLiabilityEventRevisions.revisionFingerprint,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateLiabilityEventUpdateFingerprint(
			{
				userId: validUserId,
				eventId: validEventId,
				expectedRevisionNo: validExpectedRev,
				amount: validAmount,
				purchaseCategory: validCategory,
				shortTermGoalId: validGoalId,
				merchant: validMerchant,
				description: validDesc,
				occurredAt: validOccurredAt,
			},
		);

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different purchase update payload",
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
				shortTermGoalId: validGoalId,
				merchant: existingRev.merchant,
				description: existingRev.description,
				reasonNote: validReason,
			},
		};
	}

	// 2. Lock Event Anchor FOR UPDATE
	const [event] = await tx
		.select({
			id: creditCardLiabilityEvents.id,
			userId: creditCardLiabilityEvents.userId,
			creditCardId: creditCardLiabilityEvents.creditCardId,
			eventType: creditCardLiabilityEvents.eventType,
			canonicalTransactionId: creditCardLiabilityEvents.canonicalTransactionId,
		})
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "PURCHASE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is an OPENING_BALANCE, not a PURCHASE`,
		);
	}

	// 3. Fetch latest revision
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

	// Lock card FOR UPDATE
	const [card] = await tx
		.select({ id: creditCards.id, code: creditCards.code })
		.from(creditCards)
		.where(eq(creditCards.id, event.creditCardId))
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${event.creditCardId}" not found`,
		);
	}

	// If short term goal, verify goal
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

	// 4. Resolve Ledger Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		event.creditCardId,
	);
	const systemAccounts = await ensureCreditCardSystemAccountsInTransaction(
		tx,
		validUserId,
	);
	const expenseRole = mapPurchaseCategoryToSystemRole(validCategory);
	const expenseAccountId = systemAccounts[expenseRole];

	// Get latest canonical revision number
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

	// Lock ledger accounts deterministically
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, expenseAccountId],
	});

	// 5. Revise Canonical Transaction with Ledger Entry
	const canonicalRes = await reviseCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: event.canonicalTransactionId,
		expectedRevisionNo: canonicalRev.revisionNo,
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
			cardId: event.creditCardId,
			amount: validAmount,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
		},
		reasonCode: "PURCHASE_UPDATE",
		reasonNote: validReason,
		source: {
			type: "CREDIT_CARD_PURCHASE",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card purchase update: ${validMerchant ?? card.code}`,
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

	const purchaseDate = formatIstanbulPurchaseDate(validOccurredAt);
	const fingerprint = await calculateLiabilityEventUpdateFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		amount: validAmount,
		purchaseCategory: validCategory,
		shortTermGoalId: validGoalId,
		merchant: validMerchant,
		description: validDesc,
		occurredAt: validOccurredAt,
	});

	const newRevisionNo = latestRev.revisionNo + 1;
	const newRevisionId = crypto.randomUUID();

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
		installmentCount: null,
		purchaseDate,
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
			purchaseDate,
			purchaseCategory: validCategory,
			shortTermGoalId: validGoalId,
			merchant: validMerchant,
			description: validDesc,
			reasonNote: validReason,
		},
	};
}

/**
 * Updates an existing credit card purchase.
 */
export async function updateCreditCardPurchase(
	params: UpdateCreditCardPurchaseParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return updateCreditCardPurchaseInTransaction({ tx, ...params });
	});
}

/**
 * Voids an existing credit card purchase within an existing transaction.
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

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardLiabilityEventRevisions.id,
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			purchaseDate: creditCardLiabilityEventRevisions.purchaseDate,
			budgetCategory: creditCardLiabilityEventRevisions.budgetCategory,
			merchant: creditCardLiabilityEventRevisions.merchant,
			description: creditCardLiabilityEventRevisions.description,
			revisionFingerprint:
				creditCardLiabilityEventRevisions.revisionFingerprint,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateLiabilityEventVoidFingerprint({
			userId: validUserId,
			eventId: validEventId,
			expectedRevisionNo: validExpectedRev,
			reasonNote: validReason,
			occurredAt: validOccurredAt,
		});

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different purchase void payload",
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
				reasonNote: validReason,
			},
		};
	}

	// 2. Lock Event Anchor FOR UPDATE
	const [event] = await tx
		.select({
			id: creditCardLiabilityEvents.id,
			userId: creditCardLiabilityEvents.userId,
			creditCardId: creditCardLiabilityEvents.creditCardId,
			eventType: creditCardLiabilityEvents.eventType,
			canonicalTransactionId: creditCardLiabilityEvents.canonicalTransactionId,
		})
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "PURCHASE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is an OPENING_BALANCE, not a PURCHASE`,
		);
	}

	// 3. Fetch latest revision
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
			`Purchase "${validEventId}" is already VOID`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	// 4. Resolve latest canonical revision number
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

	// 5. Void Canonical Transaction with Reversal Journal Posting
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

	const fingerprint = await calculateLiabilityEventVoidFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	const newRevisionNo = latestRev.revisionNo + 1;
	const newRevisionId = crypto.randomUUID();

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
		installmentCount: null,
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
			reasonNote: validReason,
		},
	};
}

/**
 * Voids an existing credit card purchase.
 */
export async function voidCreditCardPurchase(
	params: VoidCreditCardPurchaseParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return voidCreditCardPurchaseInTransaction({ tx, ...params });
	});
}

// ============================================================================
// Opening Balance Domain Service Implementation
// ============================================================================

/**
 * Records a credit card opening balance within an existing transaction.
 * Posts Dr Opening Equity, Cr Card Liability (no new expense).
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

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardLiabilityEventRevisions.id,
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			description: creditCardLiabilityEventRevisions.description,
			revisionFingerprint:
				creditCardLiabilityEventRevisions.revisionFingerprint,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateLiabilityEventCreateFingerprint(
			{
				userId: validUserId,
				cardId: validCardId,
				eventType: "OPENING_BALANCE",
				amount: validAmount,
				purchaseCategory: null,
				shortTermGoalId: null,
				merchant: null,
				description: validDesc,
				occurredAt: validOccurredAt,
			},
		);

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
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
				reasonNote: null,
			},
		};
	}

	// 2. Check if an opening balance already exists for this card
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
			`Opening balance already exists for credit card "${validCardId}"`,
		);
	}

	// 3. Lock Card FOR UPDATE
	const [card] = await tx
		.select({ id: creditCards.id, code: creditCards.code })
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

	// Lock ledger accounts deterministically
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, equityAccountId],
	});

	// 5. Post Canonical Transaction with Ledger Entry
	const canonicalRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		kind: "CREDIT_CARD_OPENING_BALANCE",
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
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

	const fingerprint = await calculateLiabilityEventCreateFingerprint({
		userId: validUserId,
		cardId: validCardId,
		eventType: "OPENING_BALANCE",
		amount: validAmount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: validDesc,
		occurredAt: validOccurredAt,
	});

	const eventId = crypto.randomUUID();

	await tx.insert(creditCardLiabilityEvents).values({
		id: eventId,
		userId: validUserId,
		creditCardId: validCardId,
		eventType: "OPENING_BALANCE",
		canonicalTransactionId: canonicalRes.transactionId,
	});

	const revisionId = crypto.randomUUID();
	await tx.insert(creditCardLiabilityEventRevisions).values({
		id: revisionId,
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
		revisionId,
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
			reasonNote: null,
		},
	};
}

/**
 * Records a credit card opening balance.
 */
export async function recordCreditCardOpeningBalance(
	params: RecordCreditCardOpeningBalanceParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return recordCreditCardOpeningBalanceInTransaction({ tx, ...params });
	});
}

/**
 * Updates a credit card opening balance within an existing transaction.
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

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardLiabilityEventRevisions.id,
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			description: creditCardLiabilityEventRevisions.description,
			revisionFingerprint:
				creditCardLiabilityEventRevisions.revisionFingerprint,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateLiabilityEventUpdateFingerprint(
			{
				userId: validUserId,
				eventId: validEventId,
				expectedRevisionNo: validExpectedRev,
				amount: validAmount,
				purchaseCategory: null,
				shortTermGoalId: null,
				merchant: null,
				description: validDesc,
				occurredAt: validOccurredAt,
			},
		);

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different opening balance update payload",
			);
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
				reasonNote: validReason,
			},
		};
	}

	// 2. Lock Event Anchor FOR UPDATE
	const [event] = await tx
		.select({
			id: creditCardLiabilityEvents.id,
			userId: creditCardLiabilityEvents.userId,
			creditCardId: creditCardLiabilityEvents.creditCardId,
			eventType: creditCardLiabilityEvents.eventType,
			canonicalTransactionId: creditCardLiabilityEvents.canonicalTransactionId,
		})
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "OPENING_BALANCE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is a PURCHASE, not an OPENING_BALANCE`,
		);
	}

	// 3. Fetch latest revision
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

	// 4. Resolve Ledger Accounts
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

	const [card] = await tx
		.select({ id: creditCards.id, code: creditCards.code })
		.from(creditCards)
		.where(eq(creditCards.id, event.creditCardId))
		.for("update");

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

	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, equityAccountId],
	});

	const canonicalRes = await reviseCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: event.canonicalTransactionId,
		expectedRevisionNo: canonicalRev.revisionNo,
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
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
			memo: `Credit card opening balance update: ${card?.code ?? ""}`,
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

	const fingerprint = await calculateLiabilityEventUpdateFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		amount: validAmount,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: validDesc,
		occurredAt: validOccurredAt,
	});

	const newRevisionNo = latestRev.revisionNo + 1;
	const newRevisionId = crypto.randomUUID();

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
			reasonNote: validReason,
		},
	};
}

/**
 * Updates a credit card opening balance.
 */
export async function updateCreditCardOpeningBalance(
	params: UpdateCreditCardOpeningBalanceParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return updateCreditCardOpeningBalanceInTransaction({ tx, ...params });
	});
}

/**
 * Voids a credit card opening balance within an existing transaction.
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

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardLiabilityEventRevisions.id,
			eventId: creditCardLiabilityEventRevisions.eventId,
			revisionNo: creditCardLiabilityEventRevisions.revisionNo,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			description: creditCardLiabilityEventRevisions.description,
			revisionFingerprint:
				creditCardLiabilityEventRevisions.revisionFingerprint,
		})
		.from(creditCardLiabilityEventRevisions)
		.where(
			and(
				eq(creditCardLiabilityEventRevisions.userId, validUserId),
				eq(creditCardLiabilityEventRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateLiabilityEventVoidFingerprint({
			userId: validUserId,
			eventId: validEventId,
			expectedRevisionNo: validExpectedRev,
			reasonNote: validReason,
			occurredAt: validOccurredAt,
		});

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different opening balance void payload",
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
				reasonNote: validReason,
			},
		};
	}

	// 2. Lock Event Anchor FOR UPDATE
	const [event] = await tx
		.select({
			id: creditCardLiabilityEvents.id,
			userId: creditCardLiabilityEvents.userId,
			creditCardId: creditCardLiabilityEvents.creditCardId,
			eventType: creditCardLiabilityEvents.eventType,
			canonicalTransactionId: creditCardLiabilityEvents.canonicalTransactionId,
		})
		.from(creditCardLiabilityEvents)
		.where(
			and(
				eq(creditCardLiabilityEvents.id, validEventId),
				eq(creditCardLiabilityEvents.userId, validUserId),
			),
		)
		.for("update");

	if (!event) {
		throw new CreditCardError(
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			`Liability event "${validEventId}" not found`,
		);
	}

	if (event.eventType !== "OPENING_BALANCE") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Liability event "${validEventId}" is a PURCHASE, not an OPENING_BALANCE`,
		);
	}

	// 3. Fetch latest revision
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
			`Opening balance "${validEventId}" is already VOID`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

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

	const fingerprint = await calculateLiabilityEventVoidFingerprint({
		userId: validUserId,
		eventId: validEventId,
		expectedRevisionNo: validExpectedRev,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	const newRevisionNo = latestRev.revisionNo + 1;
	const newRevisionId = crypto.randomUUID();

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
			reasonNote: validReason,
		},
	};
}

/**
 * Voids a credit card opening balance.
 */
export async function voidCreditCardOpeningBalance(
	params: VoidCreditCardOpeningBalanceParams,
): Promise<CreditCardLiabilityEventLifecycleResult> {
	return params.db.transaction(async (tx) => {
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
		canonicalTransactionId: event.canonicalTransactionId,
		canonicalRevisionId: latestRev.canonicalRevisionId,
		journalEntryId: binding?.appliedJournalEntryId ?? null,
		createdAt: event.createdAt,
	};
}

/**
 * Lists credit card purchases and opening balances.
 */
export async function listCreditCardPurchases({
	db,
	userId,
	cardId,
	status,
	limit = 50,
	offset = 0,
}: ListCreditCardPurchasesParams): Promise<CreditCardPurchaseRecord[]> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatus = validateLiabilityEventStatusFilter(status);
	const validCardId = cardId
		? validateCcCanonicalUuid(cardId, "cardId")
		: undefined;

	const conditions = [eq(creditCardLiabilityEvents.userId, validUserId)];
	if (validCardId) {
		conditions.push(eq(creditCardLiabilityEvents.creditCardId, validCardId));
	}

	const events = await db
		.select()
		.from(creditCardLiabilityEvents)
		.where(and(...conditions))
		.orderBy(desc(creditCardLiabilityEvents.createdAt))
		.limit(limit)
		.offset(offset);

	const results: CreditCardPurchaseRecord[] = [];
	for (const ev of events) {
		const [latestRev] = await db
			.select()
			.from(creditCardLiabilityEventRevisions)
			.where(eq(creditCardLiabilityEventRevisions.eventId, ev.id))
			.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
			.limit(1);

		if (!latestRev) continue;

		const revStatus = latestRev.operation === "VOID" ? "VOID" : "POSTED";
		if (validStatus && revStatus !== validStatus) continue;

		const [binding] = await db
			.select({
				appliedJournalEntryId: transactionLedgerBindings.appliedJournalEntryId,
			})
			.from(transactionLedgerBindings)
			.where(
				eq(transactionLedgerBindings.revisionId, latestRev.canonicalRevisionId),
			)
			.limit(1);

		const [canonicalRev] = await db
			.select({ payload: transactionRevisions.payload })
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, latestRev.canonicalRevisionId))
			.limit(1);

		const payload = canonicalRev?.payload as
			| { shortTermGoalId?: string | null }
			| undefined;
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
			canonicalTransactionId: ev.canonicalTransactionId,
			canonicalRevisionId: latestRev.canonicalRevisionId,
			journalEntryId: binding?.appliedJournalEntryId ?? null,
			createdAt: ev.createdAt,
		});
	}

	return results;
}
