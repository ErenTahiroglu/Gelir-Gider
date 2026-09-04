import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	type CreditCardOperation,
	type CreditCardReservePlacement,
	type CreditCardStatementOperation,
	type CreditCardStatementStatus,
	type CreditCardStatus,
	creditCardRevisions,
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "../db/schema/credit-cards";
import { midasAccounts, midasBuckets } from "../db/schema/midas";
import { formatSignedCentsToMoney, parseSignedAggregateMoneyString } from "../ledger/money";
import { MidasError } from "../midas/errors";
import {
	createMidasAllocationTransferInTransaction,
} from "../midas/service";
import { extractErrorCauseChain } from "../midas/utils";
import {
	computeDueDate,
	computeStatementDate,
	parseCycleMonth,
	validateCalendarDay,
	validateCardCode,
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateCcOptionalText,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validateLastFour,
	validateReservePlacement,
} from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateCreditCardArchiveFingerprint,
	calculateCreditCardCreateFingerprint,
	calculateCreditCardUpdateFingerprint,
	calculateStatementCreateFingerprint,
	calculateStatementUpdateFingerprint,
	calculateStatementVoidFingerprint,
	generateCardReserveMidasKey,
} from "./fingerprint";

// ============================================================================
// Record Types
// ============================================================================

export interface CreditCardRecord {
	cardId: string;
	userId: string;
	code: string;
	status: CreditCardStatus;
	revisionNo: number;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour: string | null;
	note: string | null;
	createdAt: Date;
}

export interface CreditCardStatementRecord {
	statementId: string;
	cardId: string;
	userId: string;
	cycleYear: number;
	cycleMonth: number;
	status: CreditCardStatementStatus;
	revisionNo: number;
	statementAmount: string;
	statementDate: string;
	dueDate: string;
	reservePlacement: CreditCardReservePlacement;
	reserveAmount: string;
	reserveSatisfied: boolean;
	note: string | null;
}

export interface CreditCardLifecycleResult {
	cardId: string;
	revisionId: string;
	revisionNo: number;
	operation: CreditCardOperation;
	status: CreditCardStatus;
	idempotentReplay: boolean;
}

export interface CreditCardStatementLifecycleResult {
	statementId: string;
	revisionId: string;
	revisionNo: number;
	operation: CreditCardStatementOperation;
	status: CreditCardStatementStatus;
	idempotentReplay: boolean;
}

// ============================================================================
// Params Interfaces
// ============================================================================

export interface CreateCreditCardParams {
	db: Database | DatabaseTransaction;
	userId: string;
	code: string;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour?: string | null;
	note?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateCreditCardParams {
	db: Database | DatabaseTransaction;
	userId: string;
	cardId: string;
	expectedRevisionNo: number;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour?: string | null;
	note?: string | null;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ArchiveCreditCardParams {
	db: Database | DatabaseTransaction;
	userId: string;
	cardId: string;
	expectedRevisionNo: number;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetCreditCardParams {
	db: Database | DatabaseTransaction;
	userId: string;
	cardId: string;
}

export interface ListCreditCardsParams {
	db: Database | DatabaseTransaction;
	userId: string;
	status?: CreditCardStatus;
}

export interface CreateCreditCardStatementParams {
	db: Database;
	userId: string;
	midasAccountId: string;
	cardId: string;
	cycleMonth: string; // YYYY-MM
	statementAmount: string;
	reservePlacement: "MIDAS_FUND" | "OUTSIDE_MIDAS";
	note?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateCreditCardStatementParams {
	db: Database;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	statementAmount: string;
	reservePlacement: "MIDAS_FUND" | "OUTSIDE_MIDAS";
	note?: string | null;
	reasonNote?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface VoidCreditCardStatementParams {
	db: Database;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetCreditCardStatementParams {
	db: Database | DatabaseTransaction;
	userId: string;
	statementId: string;
}

export interface ListCreditCardStatementsParams {
	db: Database | DatabaseTransaction;
	userId: string;
	creditCardId?: string;
	status?: CreditCardStatementStatus;
	cycleMonthFrom?: string;
	cycleMonthUntil?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function isCardPeriodConflictDbError(err: unknown): boolean {
	const chain = extractErrorCauseChain(err);
	return (
		chain.includes("cc_statements_card_cycle_idx") ||
		chain.includes("credit_card_statements_card_cycle") ||
		chain.includes("cycleYear") ||
		chain.includes("cycle_year") ||
		(chain.includes("credit_card_statements") && chain.includes("unique"))
	);
}

function mapDbError(err: unknown, context: string): never {
	if (err instanceof CreditCardError || err instanceof MidasError) throw err;
	const chain = extractErrorCauseChain(err);
	if (
		chain.includes("MIDAS_INSUFFICIENT_FREE_BALANCE") ||
		chain.includes("Insufficient unallocated liquidity")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY",
			`Insufficient Midas liquidity for ${context} reserve allocation`,
		);
	}
	throw new CreditCardError(
		"CREDIT_CARD_INVALID_STATE",
		`Unexpected database error during ${context}: ${chain}`,
	);
}

// ============================================================================
// Card Lifecycle
// ============================================================================

export async function createCreditCard(
	params: CreateCreditCardParams,
): Promise<CreditCardLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const code = validateCardCode(params.code);
	const displayName = validateCcRequiredText(params.displayName, "displayName", 120);
	const issuer = validateCcRequiredText(params.issuer, "issuer", 120);
	const statementDay = validateCalendarDay(params.statementDay, "statementDay");
	const dueDay = validateCalendarDay(params.dueDay, "dueDay");
	const creditLimitParsed = validateCcPositiveMoneyString(params.creditLimit, "creditLimit");
	const lastFour = validateLastFour(params.lastFour);
	const note = validateCcOptionalText(params.note, "note", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "idempotencyKey must be 1-128 characters");
	}

	// Early idempotency lookup
	const [existingRev] = await params.db
		.select({
			id: creditCardRevisions.id,
			creditCardId: creditCardRevisions.creditCardId,
			revisionNo: creditCardRevisions.revisionNo,
			operation: creditCardRevisions.operation,
			status: creditCardRevisions.status,
			revisionFingerprint: creditCardRevisions.revisionFingerprint,
		})
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.userId, userId),
				eq(creditCardRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const candidateFp = await calculateCreditCardCreateFingerprint({
		userId,
		code,
		displayName,
		issuer,
		statementDay,
		dueDay,
		creditLimit: creditLimitParsed.normalized,
		lastFour,
		note,
		occurredAt,
	});

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different card parameters");
		}
		return {
			cardId: existingRev.creditCardId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardOperation,
			status: existingRev.status as CreditCardStatus,
			idempotentReplay: true,
		};
	}

	// Fresh creation: check for existing card with same code
	const [existingCard] = await params.db
		.select({ id: creditCards.id })
		.from(creditCards)
		.where(and(eq(creditCards.userId, userId), eq(creditCards.code, code)))
		.limit(1);

	if (existingCard) {
		throw new CreditCardError("CREDIT_CARD_CONFLICT", `Card with code "${code}" already exists`);
	}

	// Insert card identity then revision
	const [newCard] = await params.db
		.insert(creditCards)
		.values({ userId, code })
		.returning();
	if (!newCard) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to create card identity");

	const [newRev] = await params.db
		.insert(creditCardRevisions)
		.values({
			userId,
			creditCardId: newCard.id,
			revisionNo: 1,
			previousRevisionId: null,
			operation: "CREATE",
			status: "ACTIVE",
			displayName,
			issuer,
			statementDay,
			dueDay,
			creditLimit: creditLimitParsed.normalized,
			lastFour,
			note,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: candidateFp,
		})
		.returning();
	if (!newRev) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to create card revision");

	return {
		cardId: newCard.id,
		revisionId: newRev.id,
		revisionNo: newRev.revisionNo,
		operation: "CREATE",
		status: "ACTIVE",
		idempotentReplay: false,
	};
}

export async function updateCreditCard(
	params: UpdateCreditCardParams,
): Promise<CreditCardLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");
	const expectedRevisionNo = validateCcExpectedRevisionNo(params.expectedRevisionNo);
	const displayName = validateCcRequiredText(params.displayName, "displayName", 120);
	const issuer = validateCcRequiredText(params.issuer, "issuer", 120);
	const statementDay = validateCalendarDay(params.statementDay, "statementDay");
	const dueDay = validateCalendarDay(params.dueDay, "dueDay");
	const creditLimitParsed = validateCcPositiveMoneyString(params.creditLimit, "creditLimit");
	const lastFour = validateLastFour(params.lastFour);
	const note = validateCcOptionalText(params.note, "note", 500);
	const changeReason = validateCcOptionalText(params.changeReason, "changeReason", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "idempotencyKey must be 1-128 characters");
	}

	// Early idempotency
	const [existingRev] = await params.db
		.select({
			id: creditCardRevisions.id,
			creditCardId: creditCardRevisions.creditCardId,
			revisionNo: creditCardRevisions.revisionNo,
			operation: creditCardRevisions.operation,
			status: creditCardRevisions.status,
			revisionFingerprint: creditCardRevisions.revisionFingerprint,
		})
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.userId, userId),
				eq(creditCardRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const candidateFp = await calculateCreditCardUpdateFingerprint({
		userId,
		cardId,
		expectedRevisionNo,
		displayName,
		issuer,
		statementDay,
		dueDay,
		creditLimit: creditLimitParsed.normalized,
		lastFour,
		note,
		changeReason,
		occurredAt,
	});

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different parameters");
		}
		return {
			cardId: existingRev.creditCardId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardOperation,
			status: existingRev.status as CreditCardStatus,
			idempotentReplay: true,
		};
	}

	// Load current latest revision
	const [latest] = await params.db
		.select({
			id: creditCardRevisions.id,
			revisionNo: creditCardRevisions.revisionNo,
			status: creditCardRevisions.status,
		})
		.from(creditCardRevisions)
		.where(eq(creditCardRevisions.creditCardId, cardId))
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (!latest) throw new CreditCardError("CREDIT_CARD_NOT_FOUND", `Card ${cardId} not found`);
	if (latest.status !== "ACTIVE") throw new CreditCardError("CREDIT_CARD_NOT_ACTIVE", `Card ${cardId} is not ACTIVE`);
	if (latest.revisionNo !== expectedRevisionNo) {
		throw new CreditCardError("CREDIT_CARD_REVISION_CONFLICT", `Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`);
	}

	const [newRev] = await params.db
		.insert(creditCardRevisions)
		.values({
			userId,
			creditCardId: cardId,
			revisionNo: latest.revisionNo + 1,
			previousRevisionId: latest.id,
			operation: "UPDATE",
			status: "ACTIVE",
			displayName,
			issuer,
			statementDay,
			dueDay,
			creditLimit: creditLimitParsed.normalized,
			lastFour,
			note,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: candidateFp,
		})
		.returning();
	if (!newRev) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to insert card revision");

	return {
		cardId,
		revisionId: newRev.id,
		revisionNo: newRev.revisionNo,
		operation: "UPDATE",
		status: "ACTIVE",
		idempotentReplay: false,
	};
}

export async function archiveCreditCard(
	params: ArchiveCreditCardParams,
): Promise<CreditCardLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");
	const expectedRevisionNo = validateCcExpectedRevisionNo(params.expectedRevisionNo);
	const changeReason = validateCcOptionalText(params.changeReason, "changeReason", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "idempotencyKey must be 1-128 characters");
	}

	// Early idempotency
	const [existingRev] = await params.db
		.select({
			id: creditCardRevisions.id,
			creditCardId: creditCardRevisions.creditCardId,
			revisionNo: creditCardRevisions.revisionNo,
			operation: creditCardRevisions.operation,
			status: creditCardRevisions.status,
			revisionFingerprint: creditCardRevisions.revisionFingerprint,
		})
		.from(creditCardRevisions)
		.where(
			and(
				eq(creditCardRevisions.userId, userId),
				eq(creditCardRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const candidateFp = await calculateCreditCardArchiveFingerprint({ userId, cardId, expectedRevisionNo, changeReason, occurredAt });

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different archive parameters");
		}
		return {
			cardId: existingRev.creditCardId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardOperation,
			status: existingRev.status as CreditCardStatus,
			idempotentReplay: true,
		};
	}

	// Load current latest revision (need all config fields for ARCHIVE snapshot copy)
	const [latest] = await params.db
		.select({
			id: creditCardRevisions.id,
			revisionNo: creditCardRevisions.revisionNo,
			status: creditCardRevisions.status,
			displayName: creditCardRevisions.displayName,
			issuer: creditCardRevisions.issuer,
			statementDay: creditCardRevisions.statementDay,
			dueDay: creditCardRevisions.dueDay,
			creditLimit: creditCardRevisions.creditLimit,
			lastFour: creditCardRevisions.lastFour,
			note: creditCardRevisions.note,
		})
		.from(creditCardRevisions)
		.where(eq(creditCardRevisions.creditCardId, cardId))
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (!latest) throw new CreditCardError("CREDIT_CARD_NOT_FOUND", `Card ${cardId} not found`);
	if (latest.status !== "ACTIVE") throw new CreditCardError("CREDIT_CARD_NOT_ACTIVE", `Card ${cardId} is not ACTIVE`);
	if (latest.revisionNo !== expectedRevisionNo) {
		throw new CreditCardError("CREDIT_CARD_REVISION_CONFLICT", `Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`);
	}

	// Check for open statements (service-level guard, DB trigger is the backstop)
	const openStatements = await params.db
		.select({ id: creditCardStatements.id })
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.creditCardId, cardId),
				eq(creditCardStatements.userId, userId),
			),
		);

	for (const stmt of openStatements) {
		const [latestStmtRev] = await params.db
			.select({ status: creditCardStatementRevisions.status })
			.from(creditCardStatementRevisions)
			.where(eq(creditCardStatementRevisions.statementId, stmt.id))
			.orderBy(desc(creditCardStatementRevisions.revisionNo))
			.limit(1);
		if (latestStmtRev?.status === "OPEN") {
			throw new CreditCardError("CREDIT_CARD_NOT_ACTIVE", `Cannot archive card ${cardId} with OPEN statement ${stmt.id}`);
		}
	}

	const [newRev] = await params.db
		.insert(creditCardRevisions)
		.values({
			userId,
			creditCardId: cardId,
			revisionNo: latest.revisionNo + 1,
			previousRevisionId: latest.id,
			operation: "ARCHIVE",
			status: "ARCHIVED",
			displayName: latest.displayName,
			issuer: latest.issuer,
			statementDay: latest.statementDay,
			dueDay: latest.dueDay,
			creditLimit: latest.creditLimit,
			lastFour: latest.lastFour,
			note: latest.note,
			occurredAt,
			idempotencyKey,
			revisionFingerprint: candidateFp,
		})
		.returning();
	if (!newRev) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to insert archive revision");

	return {
		cardId,
		revisionId: newRev.id,
		revisionNo: newRev.revisionNo,
		operation: "ARCHIVE",
		status: "ARCHIVED",
		idempotentReplay: false,
	};
}

export async function getCreditCard(params: GetCreditCardParams): Promise<CreditCardRecord | null> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");

	const [card] = await params.db
		.select({
			id: creditCards.id,
			code: creditCards.code,
			createdAt: creditCards.createdAt,
		})
		.from(creditCards)
		.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
		.limit(1);

	if (!card) return null;

	const [latest] = await params.db
		.select({
			revisionNo: creditCardRevisions.revisionNo,
			status: creditCardRevisions.status,
			displayName: creditCardRevisions.displayName,
			issuer: creditCardRevisions.issuer,
			statementDay: creditCardRevisions.statementDay,
			dueDay: creditCardRevisions.dueDay,
			creditLimit: creditCardRevisions.creditLimit,
			lastFour: creditCardRevisions.lastFour,
			note: creditCardRevisions.note,
		})
		.from(creditCardRevisions)
		.where(eq(creditCardRevisions.creditCardId, cardId))
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (!latest) return null;

	return {
		cardId: card.id,
		userId,
		code: card.code,
		status: latest.status as CreditCardStatus,
		revisionNo: latest.revisionNo,
		displayName: latest.displayName,
		issuer: latest.issuer,
		statementDay: latest.statementDay,
		dueDay: latest.dueDay,
		creditLimit: latest.creditLimit,
		lastFour: latest.lastFour,
		note: latest.note,
		createdAt: card.createdAt,
	};
}

export async function listCreditCards(params: ListCreditCardsParams): Promise<CreditCardRecord[]> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");

	// Fetch all cards for user, then load latest revision and filter
	const allCards = await params.db
		.select({
			id: creditCards.id,
			code: creditCards.code,
			createdAt: creditCards.createdAt,
		})
		.from(creditCards)
		.where(eq(creditCards.userId, userId))
		.orderBy(asc(creditCards.createdAt));

	const results: CreditCardRecord[] = [];
	for (const card of allCards) {
		const [latest] = await params.db
			.select({
				revisionNo: creditCardRevisions.revisionNo,
				status: creditCardRevisions.status,
				displayName: creditCardRevisions.displayName,
				issuer: creditCardRevisions.issuer,
				statementDay: creditCardRevisions.statementDay,
				dueDay: creditCardRevisions.dueDay,
				creditLimit: creditCardRevisions.creditLimit,
				lastFour: creditCardRevisions.lastFour,
				note: creditCardRevisions.note,
			})
			.from(creditCardRevisions)
			.where(eq(creditCardRevisions.creditCardId, card.id))
			.orderBy(desc(creditCardRevisions.revisionNo))
			.limit(1);

		if (!latest) continue;
		if (params.status && latest.status !== params.status) continue;

		results.push({
			cardId: card.id,
			userId,
			code: card.code,
			status: latest.status as CreditCardStatus,
			revisionNo: latest.revisionNo,
			displayName: latest.displayName,
			issuer: latest.issuer,
			statementDay: latest.statementDay,
			dueDay: latest.dueDay,
			creditLimit: latest.creditLimit,
			lastFour: latest.lastFour,
			note: latest.note,
			createdAt: card.createdAt,
		});
	}

	return results;
}

// ============================================================================
// Statement Lifecycle
// ============================================================================

async function readReserveBalance(
	tx: DatabaseTransaction,
	midasAccountId: string,
	bucketId: string,
): Promise<bigint> {
	const [row] = await tx
		.select({
			netAmount: sql<string>`COALESCE(SUM(CASE WHEN to_bucket_id = ${bucketId} THEN amount WHEN from_bucket_id = ${bucketId} THEN -amount ELSE 0 END), 0)::text`,
		})
		.from(sql`midas_allocation_transfers`)
		.where(sql`midas_account_id = ${midasAccountId}`);
	const parsed = parseSignedAggregateMoneyString(row?.netAmount ?? "0.00");
	return parsed.cents;
}

export async function createCreditCardStatement(
	params: CreateCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateCcCanonicalUuid(params.midasAccountId, "midasAccountId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");
	const { year: cycleYear, month: cycleMonth } = parseCycleMonth(params.cycleMonth);
	const amountParsed = validateCcPositiveMoneyString(params.statementAmount, "statementAmount");
	const reservePlacement = validateReservePlacement(params.reservePlacement);
	const note = validateCcOptionalText(params.note, "note", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "idempotencyKey must be 1-128 characters");
	}

	// Early idempotency
	const [existingRev] = await params.db
		.select({
			id: creditCardStatementRevisions.id,
			statementId: creditCardStatementRevisions.statementId,
			revisionNo: creditCardStatementRevisions.revisionNo,
			operation: creditCardStatementRevisions.operation,
			status: creditCardStatementRevisions.status,
			revisionFingerprint: creditCardStatementRevisions.revisionFingerprint,
		})
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, userId),
				eq(creditCardStatementRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	const candidateFp = await calculateStatementCreateFingerprint({
		userId,
		cardId,
		cycleYear,
		cycleMonth,
		statementAmount: amountParsed.normalized,
		reservePlacement,
		note,
		occurredAt,
	});

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different statement parameters");
		}
		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
			idempotentReplay: true,
		};
	}

	// Run all creation in a single transaction
	return await (params.db as Database).transaction(async (tx) => {
		// Lock Midas account for serialization
		const [midasAcc] = await tx
			.select({ id: midasAccounts.id, userId: midasAccounts.userId, ledgerAccountId: midasAccounts.ledgerAccountId })
			.from(midasAccounts)
			.where(and(eq(midasAccounts.id, midasAccountId), eq(midasAccounts.userId, userId)))
			.for("update")
			.limit(1);
		if (!midasAcc) throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "Midas account not found");

		// Second idempotency check post-lock
		const [existingRevPost] = await tx
			.select({ id: creditCardStatementRevisions.id, statementId: creditCardStatementRevisions.statementId, revisionNo: creditCardStatementRevisions.revisionNo, operation: creditCardStatementRevisions.operation, status: creditCardStatementRevisions.status, revisionFingerprint: creditCardStatementRevisions.revisionFingerprint })
			.from(creditCardStatementRevisions)
			.where(and(eq(creditCardStatementRevisions.userId, userId), eq(creditCardStatementRevisions.idempotencyKey, idempotencyKey)))
			.limit(1);

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different statement parameters");
			}
			return {
				statementId: existingRevPost.statementId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardStatementOperation,
				status: existingRevPost.status as CreditCardStatementStatus,
				idempotentReplay: true,
			};
		}

		// Validate card is ACTIVE
		const [latestCardRev] = await tx
			.select({ status: creditCardRevisions.status, statementDay: creditCardRevisions.statementDay, dueDay: creditCardRevisions.dueDay })
			.from(creditCardRevisions)
			.where(eq(creditCardRevisions.creditCardId, cardId))
			.orderBy(desc(creditCardRevisions.revisionNo))
			.limit(1);

		if (!latestCardRev || latestCardRev.status !== "ACTIVE") {
			throw new CreditCardError("CREDIT_CARD_NOT_ACTIVE", `Card ${cardId} is not ACTIVE`);
		}

		// Compute statement/due date from card config at CREATE time
		const statementDate = computeStatementDate(cycleYear, cycleMonth, latestCardRev.statementDay);
		const dueDate = computeDueDate(statementDate, latestCardRev.dueDay);

		// Verify cycle not already used
		const [existingStmt] = await tx
			.select({ id: creditCardStatements.id })
			.from(creditCardStatements)
			.where(
				and(
					eq(creditCardStatements.creditCardId, cardId),
					eq(creditCardStatements.cycleYear, cycleYear),
					eq(creditCardStatements.cycleMonth, cycleMonth),
				),
			)
			.limit(1);

		if (existingStmt) {
			throw new CreditCardError("CREDIT_CARD_STATEMENT_PERIOD_CONFLICT", `Statement for cycle ${cycleYear}-${String(cycleMonth).padStart(2, "0")} already exists`);
		}

		// Generate stable statement UUID and bucket code
		const stmtUuidRaw = crypto.randomUUID();
		const stmtUuidNoHyphens = stmtUuidRaw.replace(/-/g, "").toUpperCase();
		const bucketCode = `CCR_${stmtUuidNoHyphens}`;
		const bucketName = `Credit card reserve ${stmtUuidRaw.slice(0, 8)}`;

		// Create CREDIT_CARD_RESERVE Midas bucket
		const [bucket] = await tx
			.insert(midasBuckets)
			.values({
				userId,
				midasAccountId,
				code: bucketCode,
				name: bucketName,
				bucketType: "CREDIT_CARD_RESERVE",
			})
			.returning();
		if (!bucket) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to create reserve bucket");

		// Create statement identity with the predetermined UUID
		const [stmt] = await tx
			.insert(creditCardStatements)
			.values({
				id: stmtUuidRaw,
				userId,
				creditCardId: cardId,
				midasAccountId,
				midasReserveBucketId: bucket.id,
				cycleYear,
				cycleMonth,
			})
			.returning();
		if (!stmt) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to create statement identity");

		// Allocate Midas reserve if MIDAS_FUND
		if (reservePlacement === "MIDAS_FUND") {
			const midasKey = await generateCardReserveMidasKey(idempotencyKey, stmt.id, "CREATE");
			try {
				await createMidasAllocationTransferInTransaction({
					tx,
					userId,
					midasAccountId,
					idempotencyKey: midasKey,
					fromBucketId: null,
					toBucketId: bucket.id,
					amount: amountParsed.normalized,
					occurredAt,
					memo: `Credit card reserve: ${stmt.id}`,
				});
			} catch (err: unknown) {
				if (err instanceof MidasError && err.code === "MIDAS_INSUFFICIENT_FREE_BALANCE") {
					throw new CreditCardError("CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY", "Insufficient unallocated Midas liquidity for reserve");
				}
				mapDbError(err, "statement CREATE reserve allocation");
			}
		}

		// Insert statement revision
		const [rev] = await tx
			.insert(creditCardStatementRevisions)
			.values({
				userId,
				statementId: stmt.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "OPEN",
				statementAmount: amountParsed.normalized,
				statementDate,
				dueDate,
				reservePlacement,
				note,
				reasonNote: null,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateFp,
			})
			.returning();
		if (!rev) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to insert statement revision");

		return {
			statementId: stmt.id,
			revisionId: rev.id,
			revisionNo: rev.revisionNo,
			operation: "CREATE",
			status: "OPEN",
			idempotentReplay: false,
		};
	});
}

export async function updateCreditCardStatement(
	params: UpdateCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(params.statementId, "statementId");
	const expectedRevisionNo = validateCcExpectedRevisionNo(params.expectedRevisionNo);
	const amountParsed = validateCcPositiveMoneyString(params.statementAmount, "statementAmount");
	const reservePlacement = validateReservePlacement(params.reservePlacement);
	const note = validateCcOptionalText(params.note, "note", 500);
	const reasonNote = validateCcOptionalText(params.reasonNote, "reasonNote", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "idempotencyKey must be 1-128 characters");
	}

	// Early idempotency
	const [existingRev] = await params.db
		.select({ id: creditCardStatementRevisions.id, statementId: creditCardStatementRevisions.statementId, revisionNo: creditCardStatementRevisions.revisionNo, operation: creditCardStatementRevisions.operation, status: creditCardStatementRevisions.status, revisionFingerprint: creditCardStatementRevisions.revisionFingerprint })
		.from(creditCardStatementRevisions)
		.where(and(eq(creditCardStatementRevisions.userId, userId), eq(creditCardStatementRevisions.idempotencyKey, idempotencyKey)))
		.limit(1);

	const candidateFp = await calculateStatementUpdateFingerprint({
		userId,
		statementId,
		expectedRevisionNo,
		statementAmount: amountParsed.normalized,
		reservePlacement,
		note,
		reasonNote,
		occurredAt,
	});

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different parameters");
		}
		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
			idempotentReplay: true,
		};
	}

	return await (params.db as Database).transaction(async (tx) => {
		// Load statement to get midas info
		const [stmt] = await tx
			.select({ id: creditCardStatements.id, midasAccountId: creditCardStatements.midasAccountId, midasReserveBucketId: creditCardStatements.midasReserveBucketId })
			.from(creditCardStatements)
			.where(and(eq(creditCardStatements.id, statementId), eq(creditCardStatements.userId, userId)))
			.limit(1);
		if (!stmt) throw new CreditCardError("CREDIT_CARD_STATEMENT_NOT_FOUND", `Statement ${statementId} not found`);

		// Lock Midas account
		const [midasAcc] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(eq(midasAccounts.id, stmt.midasAccountId))
			.for("update")
			.limit(1);
		if (!midasAcc) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Midas account not found");

		// Second idempotency check post-lock
		const [existingRevPost] = await tx
			.select({ id: creditCardStatementRevisions.id, statementId: creditCardStatementRevisions.statementId, revisionNo: creditCardStatementRevisions.revisionNo, operation: creditCardStatementRevisions.operation, status: creditCardStatementRevisions.status, revisionFingerprint: creditCardStatementRevisions.revisionFingerprint })
			.from(creditCardStatementRevisions)
			.where(and(eq(creditCardStatementRevisions.userId, userId), eq(creditCardStatementRevisions.idempotencyKey, idempotencyKey)))
			.limit(1);

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different parameters");
			}
			return {
				statementId: existingRevPost.statementId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardStatementOperation,
				status: existingRevPost.status as CreditCardStatementStatus,
				idempotentReplay: true,
			};
		}

		// Load latest revision
		const [latest] = await tx
			.select({ id: creditCardStatementRevisions.id, revisionNo: creditCardStatementRevisions.revisionNo, status: creditCardStatementRevisions.status, statementAmount: creditCardStatementRevisions.statementAmount, statementDate: creditCardStatementRevisions.statementDate, dueDate: creditCardStatementRevisions.dueDate, reservePlacement: creditCardStatementRevisions.reservePlacement, note: creditCardStatementRevisions.note })
			.from(creditCardStatementRevisions)
			.where(eq(creditCardStatementRevisions.statementId, statementId))
			.orderBy(desc(creditCardStatementRevisions.revisionNo))
			.limit(1);

		if (!latest) throw new CreditCardError("CREDIT_CARD_STATEMENT_NOT_FOUND", `Statement ${statementId} has no revisions`);
		if (latest.status !== "OPEN") throw new CreditCardError("CREDIT_CARD_STATEMENT_NOT_OPEN", `Statement ${statementId} is not OPEN`);
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError("CREDIT_CARD_STATEMENT_REVISION_CONFLICT", `Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`);
		}

		// Compute desired vs current reserve balance
		const currentBucketBalanceCents = await readReserveBalance(tx, stmt.midasAccountId, stmt.midasReserveBucketId);
		const oldPlacement = latest.reservePlacement as CreditCardReservePlacement;
		const newPlacement = reservePlacement;
		const newAmountCents = amountParsed.cents;
		const desiredCents = newPlacement === "MIDAS_FUND" ? newAmountCents : 0n;
		const deltaCents = desiredCents - currentBucketBalanceCents;

		if (deltaCents !== 0n) {
			const absAmount = deltaCents > 0n ? deltaCents : -deltaCents;
			const absAmountStr = formatSignedCentsToMoney(absAmount);
			const midasKey = await generateCardReserveMidasKey(idempotencyKey, statementId, oldPlacement === newPlacement ? "UPDATE_AMOUNT" : "UPDATE_PLACEMENT");

			try {
				if (deltaCents > 0n) {
					// Allocate more
					await createMidasAllocationTransferInTransaction({
						tx,
						userId,
						midasAccountId: stmt.midasAccountId,
						idempotencyKey: midasKey,
						fromBucketId: null,
						toBucketId: stmt.midasReserveBucketId,
						amount: absAmountStr,
						occurredAt,
						memo: `Credit card reserve update: ${statementId}`,
					});
				} else {
					// Release excess
					await createMidasAllocationTransferInTransaction({
						tx,
						userId,
						midasAccountId: stmt.midasAccountId,
						idempotencyKey: midasKey,
						fromBucketId: stmt.midasReserveBucketId,
						toBucketId: null,
						amount: absAmountStr,
						occurredAt,
						memo: `Credit card reserve release: ${statementId}`,
					});
				}
			} catch (err: unknown) {
				if (err instanceof MidasError && err.code === "MIDAS_INSUFFICIENT_FREE_BALANCE") {
					throw new CreditCardError("CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY", "Insufficient unallocated Midas liquidity for reserve increase");
				}
				mapDbError(err, "statement UPDATE reserve reconciliation");
			}
		}

		const [newRev] = await tx
			.insert(creditCardStatementRevisions)
			.values({
				userId,
				statementId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				status: "OPEN",
				statementAmount: amountParsed.normalized,
				statementDate: latest.statementDate,
				dueDate: latest.dueDate,
				reservePlacement,
				note,
				reasonNote,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateFp,
			})
			.returning();
		if (!newRev) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to insert UPDATE revision");

		return {
			statementId,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "UPDATE",
			status: "OPEN",
			idempotentReplay: false,
		};
	});
}

export async function voidCreditCardStatement(
	params: VoidCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(params.statementId, "statementId");
	const expectedRevisionNo = validateCcExpectedRevisionNo(params.expectedRevisionNo);
	const reasonNote = validateCcOptionalText(params.reasonNote, "reasonNote", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "idempotencyKey must be 1-128 characters");
	}

	// Early idempotency
	const [existingRev] = await params.db
		.select({ id: creditCardStatementRevisions.id, statementId: creditCardStatementRevisions.statementId, revisionNo: creditCardStatementRevisions.revisionNo, operation: creditCardStatementRevisions.operation, status: creditCardStatementRevisions.status, revisionFingerprint: creditCardStatementRevisions.revisionFingerprint })
		.from(creditCardStatementRevisions)
		.where(and(eq(creditCardStatementRevisions.userId, userId), eq(creditCardStatementRevisions.idempotencyKey, idempotencyKey)))
		.limit(1);

	const candidateFp = await calculateStatementVoidFingerprint({ userId, statementId, expectedRevisionNo, reasonNote, occurredAt });

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different void parameters");
		}
		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
			idempotentReplay: true,
		};
	}

	return await (params.db as Database).transaction(async (tx) => {
		const [stmt] = await tx
			.select({ id: creditCardStatements.id, midasAccountId: creditCardStatements.midasAccountId, midasReserveBucketId: creditCardStatements.midasReserveBucketId })
			.from(creditCardStatements)
			.where(and(eq(creditCardStatements.id, statementId), eq(creditCardStatements.userId, userId)))
			.limit(1);
		if (!stmt) throw new CreditCardError("CREDIT_CARD_STATEMENT_NOT_FOUND", `Statement ${statementId} not found`);

		// Lock Midas account
		await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(eq(midasAccounts.id, stmt.midasAccountId))
			.for("update")
			.limit(1);

		// Second idempotency check
		const [existingRevPost] = await tx
			.select({ id: creditCardStatementRevisions.id, statementId: creditCardStatementRevisions.statementId, revisionNo: creditCardStatementRevisions.revisionNo, operation: creditCardStatementRevisions.operation, status: creditCardStatementRevisions.status, revisionFingerprint: creditCardStatementRevisions.revisionFingerprint })
			.from(creditCardStatementRevisions)
			.where(and(eq(creditCardStatementRevisions.userId, userId), eq(creditCardStatementRevisions.idempotencyKey, idempotencyKey)))
			.limit(1);

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError("CREDIT_CARD_IDEMPOTENCY_CONFLICT", "Idempotency key already used with different void parameters");
			}
			return {
				statementId: existingRevPost.statementId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardStatementOperation,
				status: existingRevPost.status as CreditCardStatementStatus,
				idempotentReplay: true,
			};
		}

		const [latest] = await tx
			.select({ id: creditCardStatementRevisions.id, revisionNo: creditCardStatementRevisions.revisionNo, status: creditCardStatementRevisions.status, statementAmount: creditCardStatementRevisions.statementAmount, statementDate: creditCardStatementRevisions.statementDate, dueDate: creditCardStatementRevisions.dueDate, reservePlacement: creditCardStatementRevisions.reservePlacement, note: creditCardStatementRevisions.note })
			.from(creditCardStatementRevisions)
			.where(eq(creditCardStatementRevisions.statementId, statementId))
			.orderBy(desc(creditCardStatementRevisions.revisionNo))
			.limit(1);

		if (!latest) throw new CreditCardError("CREDIT_CARD_STATEMENT_NOT_FOUND", `Statement ${statementId} has no revisions`);
		if (latest.status !== "OPEN") throw new CreditCardError("CREDIT_CARD_STATEMENT_NOT_OPEN", `Statement ${statementId} is not OPEN`);
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError("CREDIT_CARD_STATEMENT_REVISION_CONFLICT", `Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`);
		}

		// Release entire reserve if MIDAS_FUND
		const currentBucketBalanceCents = await readReserveBalance(tx, stmt.midasAccountId, stmt.midasReserveBucketId);
		if (currentBucketBalanceCents > 0n) {
			const releaseKey = await generateCardReserveMidasKey(idempotencyKey, statementId, "VOID_RELEASE");
			try {
				await createMidasAllocationTransferInTransaction({
					tx,
					userId,
					midasAccountId: stmt.midasAccountId,
					idempotencyKey: releaseKey,
					fromBucketId: stmt.midasReserveBucketId,
					toBucketId: null,
					amount: formatSignedCentsToMoney(currentBucketBalanceCents),
					occurredAt,
					memo: `Credit card reserve void release: ${statementId}`,
				});
			} catch (err: unknown) {
				mapDbError(err, "statement VOID reserve release");
			}
		}

		const [newRev] = await tx
			.insert(creditCardStatementRevisions)
			.values({
				userId,
				statementId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "VOID",
				status: "VOID",
				statementAmount: latest.statementAmount,
				statementDate: latest.statementDate,
				dueDate: latest.dueDate,
				reservePlacement: latest.reservePlacement as CreditCardReservePlacement,
				note: latest.note,
				reasonNote,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateFp,
			})
			.returning();
		if (!newRev) throw new CreditCardError("CREDIT_CARD_INVALID_STATE", "Failed to insert VOID revision");

		return {
			statementId,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "VOID",
			status: "VOID",
			idempotentReplay: false,
		};
	});
}

// ============================================================================
// Statement Reads
// ============================================================================

export async function getCreditCardStatementInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	statementId: string,
	midasAccountId: string,
): Promise<CreditCardStatementRecord | null> {
	const [stmt] = await tx
		.select({
			id: creditCardStatements.id,
			cardId: creditCardStatements.creditCardId,
			cycleYear: creditCardStatements.cycleYear,
			cycleMonth: creditCardStatements.cycleMonth,
			midasReserveBucketId: creditCardStatements.midasReserveBucketId,
		})
		.from(creditCardStatements)
		.where(and(eq(creditCardStatements.id, statementId), eq(creditCardStatements.userId, userId)))
		.limit(1);

	if (!stmt) return null;

	const [latest] = await tx
		.select({
			revisionNo: creditCardStatementRevisions.revisionNo,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			statementDate: creditCardStatementRevisions.statementDate,
			dueDate: creditCardStatementRevisions.dueDate,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			note: creditCardStatementRevisions.note,
		})
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, statementId))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);

	if (!latest) return null;

	// Read reserve bucket balance consistently in the same tx
	const bucketBalanceCents = await readReserveBalance(tx, midasAccountId, stmt.midasReserveBucketId);
	const reserveAmount = formatSignedCentsToMoney(bucketBalanceCents < 0n ? 0n : bucketBalanceCents);

	const placement = latest.reservePlacement as CreditCardReservePlacement;
	let reserveSatisfied: boolean;

	if (latest.status === "VOID") {
		reserveSatisfied = bucketBalanceCents === 0n;
		if (!reserveSatisfied) {
			throw new CreditCardError("CREDIT_CARD_INVALID_STATE", `VOID statement ${statementId} has non-zero reserve bucket balance`);
		}
	} else if (placement === "MIDAS_FUND") {
		const amtCents = parseSignedAggregateMoneyString(latest.statementAmount).cents;
		reserveSatisfied = bucketBalanceCents === amtCents;
		if (!reserveSatisfied) {
			throw new CreditCardError("CREDIT_CARD_INVALID_STATE", `OPEN MIDAS_FUND statement ${statementId} has mismatched reserve: expected ${latest.statementAmount} found ${reserveAmount}`);
		}
	} else {
		// OUTSIDE_MIDAS: bucket must be 0, reserveSatisfied always true under V1 policy
		reserveSatisfied = true;
	}

	return {
		statementId: stmt.id,
		cardId: stmt.cardId,
		userId,
		cycleYear: stmt.cycleYear,
		cycleMonth: stmt.cycleMonth,
		status: latest.status as CreditCardStatementStatus,
		revisionNo: latest.revisionNo,
		statementAmount: latest.statementAmount,
		statementDate: latest.statementDate,
		dueDate: latest.dueDate,
		reservePlacement: placement,
		reserveAmount,
		reserveSatisfied,
		note: latest.note,
	};
}

export async function getCreditCardStatement(params: GetCreditCardStatementParams): Promise<CreditCardStatementRecord | null> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(params.statementId, "statementId");

	// Need midas account id
	const [stmt] = await params.db
		.select({ midasAccountId: creditCardStatements.midasAccountId })
		.from(creditCardStatements)
		.where(and(eq(creditCardStatements.id, statementId), eq(creditCardStatements.userId, userId)))
		.limit(1);

	if (!stmt) return null;

	return await (params.db as Database).transaction(async (tx) => {
		return getCreditCardStatementInTransaction(tx, userId, statementId, stmt.midasAccountId);
	});
}

export async function listCreditCardStatements(
	params: ListCreditCardStatementsParams,
): Promise<CreditCardStatementRecord[]> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");

	let cycleFromYear: number | undefined;
	let cycleFromMonth: number | undefined;
	let cycleUntilYear: number | undefined;
	let cycleUntilMonth: number | undefined;

	if (params.cycleMonthFrom) {
		const { year, month } = parseCycleMonth(params.cycleMonthFrom);
		cycleFromYear = year;
		cycleFromMonth = month;
	}
	if (params.cycleMonthUntil) {
		const { year, month } = parseCycleMonth(params.cycleMonthUntil);
		cycleUntilYear = year;
		cycleUntilMonth = month;
	}

	if (cycleFromYear !== undefined && cycleUntilYear !== undefined) {
		if (cycleFromYear > cycleUntilYear || (cycleFromYear === cycleUntilYear && cycleFromMonth! > cycleUntilMonth!)) {
			throw new CreditCardError("CREDIT_CARD_INVALID_INPUT", "cycleMonthFrom must be <= cycleMonthUntil");
		}
	}

	// Fetch all matching statements
	const allStmts = await params.db
		.select({
			id: creditCardStatements.id,
			cardId: creditCardStatements.creditCardId,
			cycleYear: creditCardStatements.cycleYear,
			cycleMonth: creditCardStatements.cycleMonth,
			midasAccountId: creditCardStatements.midasAccountId,
			midasReserveBucketId: creditCardStatements.midasReserveBucketId,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.userId, userId),
				params.creditCardId
					? eq(creditCardStatements.creditCardId, params.creditCardId)
					: undefined,
			),
		)
		.orderBy(
			desc(creditCardStatements.cycleYear),
			desc(creditCardStatements.cycleMonth),
			asc(creditCardStatements.id),
		);

	const results: CreditCardStatementRecord[] = [];

	for (const stmt of allStmts) {
		// Filter by cycle range
		if (cycleFromYear !== undefined) {
			if (stmt.cycleYear < cycleFromYear || (stmt.cycleYear === cycleFromYear && stmt.cycleMonth < cycleFromMonth!)) continue;
		}
		if (cycleUntilYear !== undefined) {
			if (stmt.cycleYear > cycleUntilYear || (stmt.cycleYear === cycleUntilYear && stmt.cycleMonth > cycleUntilMonth!)) continue;
		}

		const [latest] = await params.db
			.select({
				revisionNo: creditCardStatementRevisions.revisionNo,
				status: creditCardStatementRevisions.status,
				statementAmount: creditCardStatementRevisions.statementAmount,
				statementDate: creditCardStatementRevisions.statementDate,
				dueDate: creditCardStatementRevisions.dueDate,
				reservePlacement: creditCardStatementRevisions.reservePlacement,
				note: creditCardStatementRevisions.note,
			})
			.from(creditCardStatementRevisions)
			.where(eq(creditCardStatementRevisions.statementId, stmt.id))
			.orderBy(desc(creditCardStatementRevisions.revisionNo))
			.limit(1);

		if (!latest) continue;
		if (params.status && latest.status !== params.status) continue;

		// Compute reserve amount from balance
		const [balRow] = await params.db
			.select({
				netAmount: sql<string>`COALESCE(SUM(CASE WHEN to_bucket_id = ${stmt.midasReserveBucketId} THEN amount WHEN from_bucket_id = ${stmt.midasReserveBucketId} THEN -amount ELSE 0 END), 0)::text`,
			})
			.from(sql`midas_allocation_transfers`)
			.where(sql`midas_account_id = ${stmt.midasAccountId}`);

		const balCents = parseSignedAggregateMoneyString(balRow?.netAmount ?? "0.00").cents;
		const reserveAmount = formatSignedCentsToMoney(balCents < 0n ? 0n : balCents);
		const placement = latest.reservePlacement as CreditCardReservePlacement;

		let reserveSatisfied: boolean;
		if (latest.status === "VOID") {
			reserveSatisfied = balCents === 0n;
		} else if (placement === "MIDAS_FUND") {
			reserveSatisfied = balCents === parseSignedAggregateMoneyString(latest.statementAmount).cents;
		} else {
			reserveSatisfied = true;
		}

		results.push({
			statementId: stmt.id,
			cardId: stmt.cardId,
			userId,
			cycleYear: stmt.cycleYear,
			cycleMonth: stmt.cycleMonth,
			status: latest.status as CreditCardStatementStatus,
			revisionNo: latest.revisionNo,
			statementAmount: latest.statementAmount,
			statementDate: latest.statementDate,
			dueDate: latest.dueDate,
			reservePlacement: placement,
			reserveAmount,
			reserveSatisfied,
			note: latest.note,
		});
	}

	// Sort: OPEN first (by statementDate DESC, id ASC), then VOID after (same order)
	results.sort((a, b) => {
		const aOpen = a.status === "OPEN" ? 0 : 1;
		const bOpen = b.status === "OPEN" ? 0 : 1;
		if (aOpen !== bOpen) return aOpen - bOpen;
		if (a.statementDate !== b.statementDate) return a.statementDate > b.statementDate ? -1 : 1;
		return a.statementId < b.statementId ? -1 : 1;
	});

	return results;
}
