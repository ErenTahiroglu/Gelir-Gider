import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import { creditCardLedgerLinks } from "../db/schema/credit-card-ledger";
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
import { getLedgerAccountBalanceInTransaction } from "../ledger/balances";
import {
	formatSignedCentsToMoney,
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { MidasError } from "../midas/errors";
import {
	createMidasAllocationTransferInTransaction,
	getMidasLiquidityStateInTransaction,
	lockMidasAllocationStateInTransaction,
	type MidasLiquidityBucketState,
} from "../midas/service";
import { extractErrorCauseChain } from "../midas/utils";
import {
	computeDueDate,
	computeStatementDate,
	parseCycleMonth,
	validateCalendarDay,
	validateCardCode,
	validateCardStatusFilter,
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateCcOptionalText,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validateLastFour,
	validateReservePlacement,
	validateStatementStatusFilter,
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
import {
	ensureCreditCardLedgerLinkInTransaction,
	ensureCreditCardSystemAccountsInTransaction,
} from "./ledger-provisioning";

// ============================================================================
// Record Types & Lifecycle Snapshots
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
	liabilityAccountId?: string | undefined;
	liveLiabilityBalance?: string | undefined;
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

export interface CreditCardSnapshot {
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour: string | null;
	note: string | null;
	changeReason: string | null;
}

export interface CreditCardLifecycleResult {
	cardId: string;
	revisionId: string;
	revisionNo: number;
	operation: CreditCardOperation;
	status: CreditCardStatus;
	idempotentReplay: boolean;
	snapshot: CreditCardSnapshot;
}

export interface CreditCardStatementSnapshot {
	statementAmount: string;
	statementDate: string;
	dueDate: string;
	reservePlacement: CreditCardReservePlacement;
	note: string | null;
	reasonNote: string | null;
}

export interface CreditCardStatementLifecycleResult {
	statementId: string;
	revisionId: string;
	revisionNo: number;
	operation: CreditCardStatementOperation;
	status: CreditCardStatementStatus;
	idempotentReplay: boolean;
	snapshot: CreditCardStatementSnapshot;
}

// ============================================================================
// Params Interfaces
// ============================================================================

export interface CreateCreditCardInTransactionParams {
	tx: DatabaseTransaction;
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

export interface UpdateCreditCardInTransactionParams {
	tx: DatabaseTransaction;
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

export interface ArchiveCreditCardInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	cardId: string;
	expectedRevisionNo: number;
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

export interface CreateCreditCardStatementInTransactionParams {
	tx: DatabaseTransaction;
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

export interface CreateCreditCardStatementParams {
	db: Database | DatabaseTransaction;
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

export interface UpdateCreditCardStatementInTransactionParams {
	tx: DatabaseTransaction;
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

export interface UpdateCreditCardStatementParams {
	db: Database | DatabaseTransaction;
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

export interface VoidCreditCardStatementInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface VoidCreditCardStatementParams {
	db: Database | DatabaseTransaction;
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
// Error Mapping Helpers
// ============================================================================

export function matchesDbConstraint(
	err: unknown,
	exactConstraint: string,
	triggerPattern?: string,
): boolean {
	let current: unknown = err;
	let depth = 0;
	const visited = new Set<unknown>();

	while (current && depth < 10 && !visited.has(current)) {
		visited.add(current);
		depth++;

		if (typeof current === "object" && current !== null) {
			const obj = current as {
				code?: string;
				constraint?: string;
				constraint_name?: string;
				detail?: string;
				message?: string;
				cause?: unknown;
			};

			const code = obj.code;
			const constraint = obj.constraint || obj.constraint_name;
			const detail = obj.detail || "";
			const message = obj.message || "";

			if (code === "23505") {
				if (constraint === exactConstraint) {
					return true;
				}
				if (
					detail.includes(exactConstraint) ||
					message.includes(exactConstraint)
				) {
					return true;
				}
			}

			if (constraint === exactConstraint) {
				return true;
			}

			if (triggerPattern) {
				if (
					message.includes(triggerPattern) ||
					detail.includes(triggerPattern)
				) {
					return true;
				}
			}

			current = obj.cause;
		} else {
			break;
		}
	}

	return false;
}

export function mapMidasError(err: MidasError, _context?: string): never {
	if (err.code === "MIDAS_INSUFFICIENT_FREE_BALANCE") {
		throw new CreditCardError(
			"CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY",
			"Insufficient free Midas liquidity for credit card reserve",
		);
	}
	if (err.code === "MIDAS_IDEMPOTENCY_CONFLICT") {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Midas allocation idempotency conflict",
		);
	}
	if (err.code === "MIDAS_INSUFFICIENT_BUCKET_BALANCE") {
		throw new CreditCardError(
			"CREDIT_CARD_RESERVE_CONFLICT",
			"Insufficient reserve bucket balance",
		);
	}
	throw new CreditCardError(
		"CREDIT_CARD_INVALID_STATE",
		"Credit card reserve state is inconsistent",
	);
}

export function isDatabaseBoundaryError(err: unknown): boolean {
	let current: unknown = err;
	let depth = 0;
	const visited = new Set<unknown>();

	while (current && depth < 10 && !visited.has(current)) {
		visited.add(current);
		depth++;

		if (typeof current === "object" && current !== null) {
			const obj = current as Record<string, unknown>;

			if (
				typeof obj.name === "string" &&
				(obj.name === "DrizzleQueryError" ||
					obj.name === "DrizzleError" ||
					obj.name === "TransactionRollbackError")
			) {
				return true;
			}
			if ("query" in obj && typeof obj.query === "string") {
				return true;
			}

			if (typeof obj.code === "string") {
				if (/^[0-9A-Z]{5}$/.test(obj.code)) {
					return true;
				}
				if (
					obj.code.startsWith("PG_") ||
					obj.code === "ECONNRESET" ||
					obj.code === "ETIMEDOUT" ||
					obj.code === "EPIPE" ||
					obj.code === "ECONNREFUSED"
				) {
					return true;
				}
			}

			if (
				"constraint" in obj ||
				"constraint_name" in obj ||
				"severity" in obj ||
				"schema" in obj ||
				"table" in obj ||
				"column" in obj ||
				"routine" in obj ||
				"internalQuery" in obj ||
				"internalPosition" in obj
			) {
				return true;
			}

			if (typeof obj.message === "string") {
				const msg = obj.message;
				if (
					msg.includes("branching forbidden") ||
					msg.includes("trg_fn_guard_") ||
					msg.includes("trg_guard_") ||
					msg.includes("violates ") ||
					msg.includes("duplicate key ") ||
					msg.includes("deadlock detected")
				) {
					return true;
				}
			}

			current = (current as { cause?: unknown }).cause;
		} else {
			break;
		}
	}

	return false;
}

export function mapDbError(err: unknown, _context?: string): never {
	if (err instanceof CreditCardError) throw err;
	if (err instanceof MidasError) {
		mapMidasError(err);
	}
	if (!isDatabaseBoundaryError(err)) {
		throw err;
	}
	const causeChain = extractErrorCauseChain(err);
	if (
		causeChain.includes("non-zero liability balance") ||
		causeChain.includes("with non-zero liability balance")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY",
			"Cannot archive credit card with non-zero liability balance",
		);
	}
	if (causeChain.includes("with OPEN statements")) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			"Cannot archive card with OPEN statements",
		);
	}
	if (matchesDbConstraint(err, "credit_cards_user_code_idx")) {
		throw new CreditCardError("CREDIT_CARD_CONFLICT", "Card code conflict");
	}
	if (matchesDbConstraint(err, "cc_statements_card_cycle_idx")) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_PERIOD_CONFLICT",
			"Statement cycle period conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"cc_revisions_card_rev_idx",
			"Card revision branching forbidden",
		) ||
		matchesDbConstraint(
			err,
			"cc_revisions_card_rev_idx",
			"trg_fn_guard_cc_revision_insert",
		)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			"Card revision conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"cc_stmt_revisions_stmt_rev_idx",
			"Statement revision branching forbidden",
		) ||
		matchesDbConstraint(
			err,
			"cc_stmt_revisions_stmt_rev_idx",
			"trg_fn_guard_cc_stmt_revision_insert",
		)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			"Statement revision conflict",
		);
	}
	if (matchesDbConstraint(err, "cc_liability_events_card_opening_idx")) {
		throw new CreditCardError(
			"CREDIT_CARD_OPENING_BALANCE_CONFLICT",
			"Opening balance already exists for this card",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"cc_liability_event_revisions_event_rev_idx",
			"trg_fn_guard_cc_liability_event_revision_insert",
		)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			"Liability event revision conflict",
		);
	}
	if (matchesDbConstraint(err, "cc_stmt_payment_events_canonical_tx_idx")) {
		throw new CreditCardError(
			"CREDIT_CARD_PAYMENT_CONFLICT",
			"Statement payment conflict",
		);
	}
	throw new CreditCardError(
		"CREDIT_CARD_INVALID_STATE",
		"Credit card state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with centralized
 * error boundary mapping.
 *
 * Catches both in-flight work errors and deferred COMMIT-time trigger/constraint rejections.
 * - CreditCardError: rethrown unchanged
 * - MidasError: mapped to sanitized CreditCardError
 * - Recognized DB/Postgres/Drizzle error: mapped to sanitized CreditCardError
 * - Programmer errors (e.g. TypeError, ReferenceError): rethrown unchanged
 *
 * NOTE ON DatabaseTransaction CONTRACT:
 * When caller passes a pre-existing DatabaseTransaction, the caller owns the transaction
 * and its eventual COMMIT. In that mode, inner work errors are mapped, but deferred
 * COMMIT failures belong to the outer transaction owner.
 */
export async function runCreditCardTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work);
	} catch (err: unknown) {
		if (err instanceof CreditCardError) {
			throw err;
		}
		if (err instanceof MidasError) {
			mapMidasError(err);
		}
		if (isDatabaseBoundaryError(err)) {
			mapDbError(err);
		}
		throw err;
	}
}

// ============================================================================
// Card Lifecycle
// ============================================================================

export async function createCreditCardInTransaction(
	params: CreateCreditCardInTransactionParams,
): Promise<CreditCardLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const code = validateCardCode(params.code);
	const displayName = validateCcRequiredText(
		params.displayName,
		"displayName",
		120,
	);
	const issuer = validateCcRequiredText(params.issuer, "issuer", 120);
	const statementDay = validateCalendarDay(params.statementDay, "statementDay");
	const dueDay = validateCalendarDay(params.dueDay, "dueDay");
	const creditLimitParsed = validateCcPositiveMoneyString(
		params.creditLimit,
		"creditLimit",
	);
	const lastFour = validateLastFour(params.lastFour);
	const note = validateCcOptionalText(params.note, "note", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be 1-128 characters",
		);
	}

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

	// Early idempotency lookup
	const [existingRev] = await params.tx
		.select({
			id: creditCardRevisions.id,
			creditCardId: creditCardRevisions.creditCardId,
			revisionNo: creditCardRevisions.revisionNo,
			operation: creditCardRevisions.operation,
			status: creditCardRevisions.status,
			displayName: creditCardRevisions.displayName,
			issuer: creditCardRevisions.issuer,
			statementDay: creditCardRevisions.statementDay,
			dueDay: creditCardRevisions.dueDay,
			creditLimit: creditCardRevisions.creditLimit,
			lastFour: creditCardRevisions.lastFour,
			note: creditCardRevisions.note,
			changeReason: creditCardRevisions.changeReason,
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

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different card parameters",
			);
		}
		return {
			cardId: existingRev.creditCardId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardOperation,
			status: existingRev.status as CreditCardStatus,
			idempotentReplay: true,
			snapshot: {
				displayName: existingRev.displayName,
				issuer: existingRev.issuer,
				statementDay: existingRev.statementDay,
				dueDay: existingRev.dueDay,
				creditLimit: existingRev.creditLimit,
				lastFour: existingRev.lastFour,
				note: existingRev.note,
				changeReason: existingRev.changeReason,
			},
		};
	}

	try {
		// Lock user row FOR UPDATE to serialize card CREATE for this user
		const [userRow] = await params.tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.for("update")
			.limit(1);

		if (!userRow) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`User ${userId} not found`,
			);
		}

		// Second idempotency lookup post-lock
		const [existingRevPost] = await params.tx
			.select({
				id: creditCardRevisions.id,
				creditCardId: creditCardRevisions.creditCardId,
				revisionNo: creditCardRevisions.revisionNo,
				operation: creditCardRevisions.operation,
				status: creditCardRevisions.status,
				displayName: creditCardRevisions.displayName,
				issuer: creditCardRevisions.issuer,
				statementDay: creditCardRevisions.statementDay,
				dueDay: creditCardRevisions.dueDay,
				creditLimit: creditCardRevisions.creditLimit,
				lastFour: creditCardRevisions.lastFour,
				note: creditCardRevisions.note,
				changeReason: creditCardRevisions.changeReason,
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

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError(
					"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different card parameters",
				);
			}
			return {
				cardId: existingRevPost.creditCardId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardOperation,
				status: existingRevPost.status as CreditCardStatus,
				idempotentReplay: true,
				snapshot: {
					displayName: existingRevPost.displayName,
					issuer: existingRevPost.issuer,
					statementDay: existingRevPost.statementDay,
					dueDay: existingRevPost.dueDay,
					creditLimit: existingRevPost.creditLimit,
					lastFour: existingRevPost.lastFour,
					note: existingRevPost.note,
					changeReason: existingRevPost.changeReason,
				},
			};
		}

		// Check for existing card code
		const [existingCard] = await params.tx
			.select({ id: creditCards.id })
			.from(creditCards)
			.where(and(eq(creditCards.userId, userId), eq(creditCards.code, code)))
			.limit(1);

		if (existingCard) {
			throw new CreditCardError(
				"CREDIT_CARD_CONFLICT",
				`Card with code "${code}" already exists`,
			);
		}

		// Insert card identity
		const [newCard] = await params.tx
			.insert(creditCards)
			.values({ userId, code })
			.returning();

		if (!newCard) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to create card identity",
			);
		}

		// Insert revision #1
		const [newRev] = await params.tx
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
				changeReason: null,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateFp,
			})
			.returning();

		if (!newRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to create card revision",
			);
		}

		// Provision linked liability ledger account and system accounts
		await ensureCreditCardLedgerLinkInTransaction(
			params.tx,
			userId,
			newCard.id,
		);
		await ensureCreditCardSystemAccountsInTransaction(params.tx, userId);

		return {
			cardId: newCard.id,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "CREATE",
			status: "ACTIVE",
			idempotentReplay: false,
			snapshot: {
				displayName,
				issuer,
				statementDay,
				dueDay,
				creditLimit: creditLimitParsed.normalized,
				lastFour,
				note,
				changeReason: null,
			},
		};
	} catch (err: unknown) {
		mapDbError(err, "card CREATE");
	}
}

export async function createCreditCard(
	params: CreateCreditCardParams,
): Promise<CreditCardLifecycleResult> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return createCreditCardInTransaction({
				...params,
				tx,
			});
		});
	}
	return createCreditCardInTransaction({
		...params,
		tx: params.db as DatabaseTransaction,
	});
}

export async function updateCreditCardInTransaction(
	params: UpdateCreditCardInTransactionParams,
): Promise<CreditCardLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");
	const expectedRevisionNo = validateCcExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const displayName = validateCcRequiredText(
		params.displayName,
		"displayName",
		120,
	);
	const issuer = validateCcRequiredText(params.issuer, "issuer", 120);
	const statementDay = validateCalendarDay(params.statementDay, "statementDay");
	const dueDay = validateCalendarDay(params.dueDay, "dueDay");
	const creditLimitParsed = validateCcPositiveMoneyString(
		params.creditLimit,
		"creditLimit",
	);
	const lastFour = validateLastFour(params.lastFour);
	const note = validateCcOptionalText(params.note, "note", 500);
	const changeReason = validateCcOptionalText(
		params.changeReason,
		"changeReason",
		500,
	);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be 1-128 characters",
		);
	}

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

	// Early idempotency lookup
	const [existingRev] = await params.tx
		.select({
			id: creditCardRevisions.id,
			creditCardId: creditCardRevisions.creditCardId,
			revisionNo: creditCardRevisions.revisionNo,
			operation: creditCardRevisions.operation,
			status: creditCardRevisions.status,
			displayName: creditCardRevisions.displayName,
			issuer: creditCardRevisions.issuer,
			statementDay: creditCardRevisions.statementDay,
			dueDay: creditCardRevisions.dueDay,
			creditLimit: creditCardRevisions.creditLimit,
			lastFour: creditCardRevisions.lastFour,
			note: creditCardRevisions.note,
			changeReason: creditCardRevisions.changeReason,
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

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different parameters",
			);
		}
		return {
			cardId: existingRev.creditCardId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardOperation,
			status: existingRev.status as CreditCardStatus,
			idempotentReplay: true,
			snapshot: {
				displayName: existingRev.displayName,
				issuer: existingRev.issuer,
				statementDay: existingRev.statementDay,
				dueDay: existingRev.dueDay,
				creditLimit: existingRev.creditLimit,
				lastFour: existingRev.lastFour,
				note: existingRev.note,
				changeReason: existingRev.changeReason,
			},
		};
	}

	try {
		// Lock credit_cards anchor FOR UPDATE
		const [card] = await params.tx
			.select({ id: creditCards.id })
			.from(creditCards)
			.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
			.for("update")
			.limit(1);

		if (!card) {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_FOUND",
				`Card ${cardId} not found`,
			);
		}

		// Second idempotency check post-lock
		const [existingRevPost] = await params.tx
			.select({
				id: creditCardRevisions.id,
				creditCardId: creditCardRevisions.creditCardId,
				revisionNo: creditCardRevisions.revisionNo,
				operation: creditCardRevisions.operation,
				status: creditCardRevisions.status,
				displayName: creditCardRevisions.displayName,
				issuer: creditCardRevisions.issuer,
				statementDay: creditCardRevisions.statementDay,
				dueDay: creditCardRevisions.dueDay,
				creditLimit: creditCardRevisions.creditLimit,
				lastFour: creditCardRevisions.lastFour,
				note: creditCardRevisions.note,
				changeReason: creditCardRevisions.changeReason,
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

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError(
					"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different parameters",
				);
			}
			return {
				cardId: existingRevPost.creditCardId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardOperation,
				status: existingRevPost.status as CreditCardStatus,
				idempotentReplay: true,
				snapshot: {
					displayName: existingRevPost.displayName,
					issuer: existingRevPost.issuer,
					statementDay: existingRevPost.statementDay,
					dueDay: existingRevPost.dueDay,
					creditLimit: existingRevPost.creditLimit,
					lastFour: existingRevPost.lastFour,
					note: existingRevPost.note,
					changeReason: existingRevPost.changeReason,
				},
			};
		}

		// Load authoritative current latest revision
		const [latest] = await params.tx
			.select({
				id: creditCardRevisions.id,
				revisionNo: creditCardRevisions.revisionNo,
				status: creditCardRevisions.status,
			})
			.from(creditCardRevisions)
			.where(eq(creditCardRevisions.creditCardId, cardId))
			.orderBy(desc(creditCardRevisions.revisionNo))
			.limit(1);

		if (!latest) {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_FOUND",
				`Card ${cardId} not found`,
			);
		}
		if (latest.status !== "ACTIVE") {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_ACTIVE",
				`Card ${cardId} is not ACTIVE`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError(
				"CREDIT_CARD_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`,
			);
		}

		const [newRev] = await params.tx
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
				changeReason,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateFp,
			})
			.returning();

		if (!newRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to insert card revision",
			);
		}

		return {
			cardId,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "UPDATE",
			status: "ACTIVE",
			idempotentReplay: false,
			snapshot: {
				displayName,
				issuer,
				statementDay,
				dueDay,
				creditLimit: creditLimitParsed.normalized,
				lastFour,
				note,
				changeReason,
			},
		};
	} catch (err: unknown) {
		mapDbError(err, "card UPDATE");
	}
}

export async function updateCreditCard(
	params: UpdateCreditCardParams,
): Promise<CreditCardLifecycleResult> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return updateCreditCardInTransaction({
				...params,
				tx,
			});
		});
	}
	return updateCreditCardInTransaction({
		...params,
		tx: params.db as DatabaseTransaction,
	});
}

export async function archiveCreditCardInTransaction(
	params: ArchiveCreditCardInTransactionParams,
): Promise<CreditCardLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");
	const expectedRevisionNo = validateCcExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const changeReason = validateCcOptionalText(
		params.changeReason,
		"changeReason",
		500,
	);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be 1-128 characters",
		);
	}

	const candidateFp = await calculateCreditCardArchiveFingerprint({
		userId,
		cardId,
		expectedRevisionNo,
		changeReason,
		occurredAt,
	});

	// Early idempotency lookup
	const [existingRev] = await params.tx
		.select({
			id: creditCardRevisions.id,
			creditCardId: creditCardRevisions.creditCardId,
			revisionNo: creditCardRevisions.revisionNo,
			operation: creditCardRevisions.operation,
			status: creditCardRevisions.status,
			displayName: creditCardRevisions.displayName,
			issuer: creditCardRevisions.issuer,
			statementDay: creditCardRevisions.statementDay,
			dueDay: creditCardRevisions.dueDay,
			creditLimit: creditCardRevisions.creditLimit,
			lastFour: creditCardRevisions.lastFour,
			note: creditCardRevisions.note,
			changeReason: creditCardRevisions.changeReason,
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

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different archive parameters",
			);
		}
		return {
			cardId: existingRev.creditCardId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardOperation,
			status: existingRev.status as CreditCardStatus,
			idempotentReplay: true,
			snapshot: {
				displayName: existingRev.displayName,
				issuer: existingRev.issuer,
				statementDay: existingRev.statementDay,
				dueDay: existingRev.dueDay,
				creditLimit: existingRev.creditLimit,
				lastFour: existingRev.lastFour,
				note: existingRev.note,
				changeReason: existingRev.changeReason,
			},
		};
	}

	try {
		// Lock credit_cards anchor FOR UPDATE
		const [card] = await params.tx
			.select({ id: creditCards.id })
			.from(creditCards)
			.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
			.for("update")
			.limit(1);

		if (!card) {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_FOUND",
				`Card ${cardId} not found`,
			);
		}

		// Second idempotency check post-lock
		const [existingRevPost] = await params.tx
			.select({
				id: creditCardRevisions.id,
				creditCardId: creditCardRevisions.creditCardId,
				revisionNo: creditCardRevisions.revisionNo,
				operation: creditCardRevisions.operation,
				status: creditCardRevisions.status,
				displayName: creditCardRevisions.displayName,
				issuer: creditCardRevisions.issuer,
				statementDay: creditCardRevisions.statementDay,
				dueDay: creditCardRevisions.dueDay,
				creditLimit: creditCardRevisions.creditLimit,
				lastFour: creditCardRevisions.lastFour,
				note: creditCardRevisions.note,
				changeReason: creditCardRevisions.changeReason,
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

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError(
					"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different archive parameters",
				);
			}
			return {
				cardId: existingRevPost.creditCardId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardOperation,
				status: existingRevPost.status as CreditCardStatus,
				idempotentReplay: true,
				snapshot: {
					displayName: existingRevPost.displayName,
					issuer: existingRevPost.issuer,
					statementDay: existingRevPost.statementDay,
					dueDay: existingRevPost.dueDay,
					creditLimit: existingRevPost.creditLimit,
					lastFour: existingRevPost.lastFour,
					note: existingRevPost.note,
					changeReason: existingRevPost.changeReason,
				},
			};
		}

		// Load current latest revision
		const [latest] = await params.tx
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

		if (!latest) {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_FOUND",
				`Card ${cardId} not found`,
			);
		}
		if (latest.status !== "ACTIVE") {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_ACTIVE",
				`Card ${cardId} is not ACTIVE`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError(
				"CREDIT_CARD_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`,
			);
		}

		// Check for OPEN statements
		const openStatements = await params.tx
			.select({ id: creditCardStatements.id })
			.from(creditCardStatements)
			.where(
				and(
					eq(creditCardStatements.creditCardId, cardId),
					eq(creditCardStatements.userId, userId),
				),
			);

		for (const stmt of openStatements) {
			const [latestStmtRev] = await params.tx
				.select({ status: creditCardStatementRevisions.status })
				.from(creditCardStatementRevisions)
				.where(eq(creditCardStatementRevisions.statementId, stmt.id))
				.orderBy(desc(creditCardStatementRevisions.revisionNo))
				.limit(1);

			if (latestStmtRev?.status === "OPEN") {
				throw new CreditCardError(
					"CREDIT_CARD_NOT_ACTIVE",
					`Cannot archive card ${cardId} with OPEN statement ${stmt.id}`,
				);
			}
		}

		// Check for non-zero live liability balance
		const [link] = await params.tx
			.select({ liabilityAccountId: creditCardLedgerLinks.liabilityAccountId })
			.from(creditCardLedgerLinks)
			.where(
				and(
					eq(creditCardLedgerLinks.userId, userId),
					eq(creditCardLedgerLinks.creditCardId, cardId),
				),
			)
			.limit(1);

		if (link) {
			const bal = await getLedgerAccountBalanceInTransaction({
				tx: params.tx,
				userId,
				accountId: link.liabilityAccountId,
			});
			if (bal.balance !== "0.00") {
				throw new CreditCardError(
					"CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY",
					`Cannot archive credit card ${cardId} with non-zero liability balance ${bal.balance}`,
				);
			}
		}

		const [newRev] = await params.tx
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
				changeReason,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateFp,
			})
			.returning();

		if (!newRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to insert archive revision",
			);
		}

		return {
			cardId,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "ARCHIVE",
			status: "ARCHIVED",
			idempotentReplay: false,
			snapshot: {
				displayName: latest.displayName,
				issuer: latest.issuer,
				statementDay: latest.statementDay,
				dueDay: latest.dueDay,
				creditLimit: latest.creditLimit,
				lastFour: latest.lastFour,
				note: latest.note,
				changeReason,
			},
		};
	} catch (err: unknown) {
		mapDbError(err, "card ARCHIVE");
	}
}

export async function archiveCreditCard(
	params: ArchiveCreditCardParams,
): Promise<CreditCardLifecycleResult> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return archiveCreditCardInTransaction({
				...params,
				tx,
			});
		});
	}
	return archiveCreditCardInTransaction({
		...params,
		tx: params.db as DatabaseTransaction,
	});
}

export async function getCreditCard(
	params: GetCreditCardParams,
): Promise<CreditCardRecord | null> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");

	try {
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

		const [link] = await params.db
			.select({ liabilityAccountId: creditCardLedgerLinks.liabilityAccountId })
			.from(creditCardLedgerLinks)
			.where(
				and(
					eq(creditCardLedgerLinks.userId, userId),
					eq(creditCardLedgerLinks.creditCardId, card.id),
				),
			)
			.limit(1);

		let liveLiabilityBalance = "0.00";
		if (link) {
			const bal = await getLedgerAccountBalanceInTransaction({
				tx: params.db as unknown as DatabaseTransaction,
				userId,
				accountId: link.liabilityAccountId,
			});
			liveLiabilityBalance = bal.balance;
		}

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
			liabilityAccountId: link?.liabilityAccountId,
			liveLiabilityBalance,
		};
	} catch (err: unknown) {
		mapDbError(err);
	}
}

export async function listCreditCards(
	params: ListCreditCardsParams,
): Promise<CreditCardRecord[]> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statusFilter = validateCardStatusFilter(params.status);

	try {
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
			if (statusFilter && latest.status !== statusFilter) continue;

			const [link] = await params.db
				.select({
					liabilityAccountId: creditCardLedgerLinks.liabilityAccountId,
				})
				.from(creditCardLedgerLinks)
				.where(
					and(
						eq(creditCardLedgerLinks.userId, userId),
						eq(creditCardLedgerLinks.creditCardId, card.id),
					),
				)
				.limit(1);

			let liveLiabilityBalance = "0.00";
			if (link) {
				const bal = await getLedgerAccountBalanceInTransaction({
					tx: params.db as unknown as DatabaseTransaction,
					userId,
					accountId: link.liabilityAccountId,
				});
				liveLiabilityBalance = bal.balance;
			}

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
				liabilityAccountId: link?.liabilityAccountId,
				liveLiabilityBalance,
			});
		}

		return results;
	} catch (err: unknown) {
		mapDbError(err);
	}
}

// ============================================================================
// Statement Lifecycle
// ============================================================================

export async function createCreditCardStatementInTransaction(
	params: CreateCreditCardStatementInTransactionParams,
): Promise<CreditCardStatementLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateCcCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);
	const cardId = validateCcCanonicalUuid(params.cardId, "cardId");
	const { year: cycleYear, month: cycleMonth } = parseCycleMonth(
		params.cycleMonth,
	);
	const amountParsed = validateCcPositiveMoneyString(
		params.statementAmount,
		"statementAmount",
	);
	const reservePlacement = validateReservePlacement(params.reservePlacement);
	const note = validateCcOptionalText(params.note, "note", 500);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be 1-128 characters",
		);
	}

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

	// Early idempotency lookup
	const [existingRev] = await params.tx
		.select({
			id: creditCardStatementRevisions.id,
			statementId: creditCardStatementRevisions.statementId,
			revisionNo: creditCardStatementRevisions.revisionNo,
			operation: creditCardStatementRevisions.operation,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			statementDate: creditCardStatementRevisions.statementDate,
			dueDate: creditCardStatementRevisions.dueDate,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			note: creditCardStatementRevisions.note,
			reasonNote: creditCardStatementRevisions.reasonNote,
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

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different statement parameters",
			);
		}
		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
			idempotentReplay: true,
			snapshot: {
				statementAmount: existingRev.statementAmount,
				statementDate: existingRev.statementDate,
				dueDate: existingRev.dueDate,
				reservePlacement:
					existingRev.reservePlacement as CreditCardReservePlacement,
				note: existingRev.note,
				reasonNote: existingRev.reasonNote,
			},
		};
	}

	try {
		// 1. Lock card anchor FOR UPDATE (serializes against card archive)
		const [card] = await params.tx
			.select({ id: creditCards.id })
			.from(creditCards)
			.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
			.for("update")
			.limit(1);

		if (!card) {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_FOUND",
				`Card ${cardId} not found`,
			);
		}

		// 2. Second idempotency check post-card-lock
		const [existingRevPost] = await params.tx
			.select({
				id: creditCardStatementRevisions.id,
				statementId: creditCardStatementRevisions.statementId,
				revisionNo: creditCardStatementRevisions.revisionNo,
				operation: creditCardStatementRevisions.operation,
				status: creditCardStatementRevisions.status,
				statementAmount: creditCardStatementRevisions.statementAmount,
				statementDate: creditCardStatementRevisions.statementDate,
				dueDate: creditCardStatementRevisions.dueDate,
				reservePlacement: creditCardStatementRevisions.reservePlacement,
				note: creditCardStatementRevisions.note,
				reasonNote: creditCardStatementRevisions.reasonNote,
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

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError(
					"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different statement parameters",
				);
			}
			return {
				statementId: existingRevPost.statementId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardStatementOperation,
				status: existingRevPost.status as CreditCardStatementStatus,
				idempotentReplay: true,
				snapshot: {
					statementAmount: existingRevPost.statementAmount,
					statementDate: existingRevPost.statementDate,
					dueDate: existingRevPost.dueDate,
					reservePlacement:
						existingRevPost.reservePlacement as CreditCardReservePlacement,
					note: existingRevPost.note,
					reasonNote: existingRevPost.reasonNote,
				},
			};
		}

		// 3. Lock Midas allocation state via helper (strict global order: card -> ledger_accounts -> midas_accounts)
		await lockMidasAllocationStateInTransaction({
			tx: params.tx,
			userId,
			midasAccountId,
		});

		// 4. Validate card is ACTIVE and read latest card revision
		const [latestCardRev] = await params.tx
			.select({
				status: creditCardRevisions.status,
				statementDay: creditCardRevisions.statementDay,
				dueDay: creditCardRevisions.dueDay,
			})
			.from(creditCardRevisions)
			.where(eq(creditCardRevisions.creditCardId, cardId))
			.orderBy(desc(creditCardRevisions.revisionNo))
			.limit(1);

		if (latestCardRev?.status !== "ACTIVE") {
			throw new CreditCardError(
				"CREDIT_CARD_NOT_ACTIVE",
				`Card ${cardId} is not ACTIVE`,
			);
		}

		// 5. Compute statement and due dates from authoritative card config
		const statementDate = computeStatementDate(
			cycleYear,
			cycleMonth,
			latestCardRev.statementDay,
		);
		const dueDate = computeDueDate(statementDate, latestCardRev.dueDay);

		// 6. Check for duplicate statement cycle
		const [existingStmt] = await params.tx
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
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_PERIOD_CONFLICT",
				`Statement for cycle ${cycleYear}-${String(cycleMonth).padStart(2, "0")} already exists`,
			);
		}

		// 7. Generate statement UUID and bucket code
		const stmtUuidRaw = crypto.randomUUID();
		const stmtUuidNoHyphens = stmtUuidRaw.replace(/-/g, "").toUpperCase();
		const bucketCode = `CCR_${stmtUuidNoHyphens}`;
		const bucketName = `Credit card reserve ${stmtUuidRaw.slice(0, 8)}`;

		// 8. Create dedicated reserve bucket
		const [bucket] = await params.tx
			.insert(midasBuckets)
			.values({
				userId,
				midasAccountId,
				code: bucketCode,
				name: bucketName,
				bucketType: "CREDIT_CARD_RESERVE",
			})
			.returning();

		if (!bucket) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to create reserve bucket",
			);
		}

		// 9. Create statement identity anchor
		const [stmt] = await params.tx
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

		if (!stmt) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to create statement identity",
			);
		}

		// 10. Allocate Midas reserve if MIDAS_FUND
		if (reservePlacement === "MIDAS_FUND") {
			const midasKey = await generateCardReserveMidasKey(
				idempotencyKey,
				stmt.id,
				"CREATE",
			);
			try {
				await createMidasAllocationTransferInTransaction({
					tx: params.tx,
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
				if (err instanceof MidasError) {
					mapMidasError(err, "statement CREATE reserve allocation");
				}
				mapDbError(err, "statement CREATE reserve allocation");
			}
		}

		// 11. Insert statement revision #1
		const [rev] = await params.tx
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

		if (!rev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to insert statement revision",
			);
		}

		return {
			statementId: stmt.id,
			revisionId: rev.id,
			revisionNo: rev.revisionNo,
			operation: "CREATE",
			status: "OPEN",
			idempotentReplay: false,
			snapshot: {
				statementAmount: amountParsed.normalized,
				statementDate,
				dueDate,
				reservePlacement,
				note,
				reasonNote: null,
			},
		};
	} catch (err: unknown) {
		mapDbError(err, "statement CREATE");
	}
}

export async function createCreditCardStatement(
	params: CreateCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return createCreditCardStatementInTransaction({
				...params,
				tx,
			});
		});
	}
	return createCreditCardStatementInTransaction({
		...params,
		tx: params.db as DatabaseTransaction,
	});
}

export async function updateCreditCardStatementInTransaction(
	params: UpdateCreditCardStatementInTransactionParams,
): Promise<CreditCardStatementLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);
	const expectedRevisionNo = validateCcExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const amountParsed = validateCcPositiveMoneyString(
		params.statementAmount,
		"statementAmount",
	);
	const reservePlacement = validateReservePlacement(params.reservePlacement);
	const note = validateCcOptionalText(params.note, "note", 500);
	const reasonNote = validateCcOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be 1-128 characters",
		);
	}

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

	// Early idempotency lookup
	const [existingRev] = await params.tx
		.select({
			id: creditCardStatementRevisions.id,
			statementId: creditCardStatementRevisions.statementId,
			revisionNo: creditCardStatementRevisions.revisionNo,
			operation: creditCardStatementRevisions.operation,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			statementDate: creditCardStatementRevisions.statementDate,
			dueDate: creditCardStatementRevisions.dueDate,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			note: creditCardStatementRevisions.note,
			reasonNote: creditCardStatementRevisions.reasonNote,
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

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different parameters",
			);
		}
		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
			idempotentReplay: true,
			snapshot: {
				statementAmount: existingRev.statementAmount,
				statementDate: existingRev.statementDate,
				dueDate: existingRev.dueDate,
				reservePlacement:
					existingRev.reservePlacement as CreditCardReservePlacement,
				note: existingRev.note,
				reasonNote: existingRev.reasonNote,
			},
		};
	}

	try {
		// 1. Lock statement anchor FOR UPDATE
		const [stmt] = await params.tx
			.select({
				id: creditCardStatements.id,
				midasAccountId: creditCardStatements.midasAccountId,
				midasReserveBucketId: creditCardStatements.midasReserveBucketId,
			})
			.from(creditCardStatements)
			.where(
				and(
					eq(creditCardStatements.id, statementId),
					eq(creditCardStatements.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!stmt) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_FOUND",
				`Statement ${statementId} not found`,
			);
		}

		// 2. Second idempotency check post-statement-lock
		const [existingRevPost] = await params.tx
			.select({
				id: creditCardStatementRevisions.id,
				statementId: creditCardStatementRevisions.statementId,
				revisionNo: creditCardStatementRevisions.revisionNo,
				operation: creditCardStatementRevisions.operation,
				status: creditCardStatementRevisions.status,
				statementAmount: creditCardStatementRevisions.statementAmount,
				statementDate: creditCardStatementRevisions.statementDate,
				dueDate: creditCardStatementRevisions.dueDate,
				reservePlacement: creditCardStatementRevisions.reservePlacement,
				note: creditCardStatementRevisions.note,
				reasonNote: creditCardStatementRevisions.reasonNote,
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

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError(
					"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different parameters",
				);
			}
			return {
				statementId: existingRevPost.statementId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardStatementOperation,
				status: existingRevPost.status as CreditCardStatementStatus,
				idempotentReplay: true,
				snapshot: {
					statementAmount: existingRevPost.statementAmount,
					statementDate: existingRevPost.statementDate,
					dueDate: existingRevPost.dueDate,
					reservePlacement:
						existingRevPost.reservePlacement as CreditCardReservePlacement,
					note: existingRevPost.note,
					reasonNote: existingRevPost.reasonNote,
				},
			};
		}

		// 3. Lock Midas allocation state via helper (strict global order: statement -> ledger_accounts -> midas_accounts)
		await lockMidasAllocationStateInTransaction({
			tx: params.tx,
			userId,
			midasAccountId: stmt.midasAccountId,
		});

		// 4. Load latest statement revision
		const [latest] = await params.tx
			.select({
				id: creditCardStatementRevisions.id,
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

		if (!latest) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_FOUND",
				`Statement ${statementId} has no revisions`,
			);
		}
		if (latest.status !== "OPEN") {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_OPEN",
				`Statement ${statementId} is not OPEN`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`,
			);
		}

		// 5. Read current bucket balance from Midas liquidity state consistently
		const midasState = await getMidasLiquidityStateInTransaction({
			tx: params.tx,
			userId,
			midasAccountId: stmt.midasAccountId,
		});
		const bucket = midasState.buckets.find(
			(b) => b.bucketId === stmt.midasReserveBucketId,
		);
		const currentBucketBalanceCents = bucket
			? parseSignedAggregateMoneyString(bucket.balance).cents
			: 0n;

		const oldPlacement = latest.reservePlacement as CreditCardReservePlacement;
		const newPlacement = reservePlacement;
		const newAmountCents = amountParsed.cents;
		const desiredCents = newPlacement === "MIDAS_FUND" ? newAmountCents : 0n;
		const deltaCents = desiredCents - currentBucketBalanceCents;

		if (deltaCents !== 0n) {
			const absAmount = deltaCents > 0n ? deltaCents : -deltaCents;
			const absAmountStr = formatSignedCentsToMoney(absAmount);
			const midasKey = await generateCardReserveMidasKey(
				idempotencyKey,
				statementId,
				oldPlacement === newPlacement ? "UPDATE_AMOUNT" : "UPDATE_PLACEMENT",
			);

			try {
				if (deltaCents > 0n) {
					await createMidasAllocationTransferInTransaction({
						tx: params.tx,
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
					await createMidasAllocationTransferInTransaction({
						tx: params.tx,
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
				if (err instanceof MidasError) {
					mapMidasError(err, "statement UPDATE reserve reconciliation");
				}
				mapDbError(err, "statement UPDATE reserve reconciliation");
			}
		}

		// 6. Insert UPDATE revision
		const [newRev] = await params.tx
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

		if (!newRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to insert UPDATE revision",
			);
		}

		return {
			statementId,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "UPDATE",
			status: "OPEN",
			idempotentReplay: false,
			snapshot: {
				statementAmount: amountParsed.normalized,
				statementDate: latest.statementDate,
				dueDate: latest.dueDate,
				reservePlacement,
				note,
				reasonNote,
			},
		};
	} catch (err: unknown) {
		mapDbError(err, "statement UPDATE");
	}
}

export async function updateCreditCardStatement(
	params: UpdateCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return updateCreditCardStatementInTransaction({
				...params,
				tx,
			});
		});
	}
	return updateCreditCardStatementInTransaction({
		...params,
		tx: params.db as DatabaseTransaction,
	});
}

export async function voidCreditCardStatementInTransaction(
	params: VoidCreditCardStatementInTransactionParams,
): Promise<CreditCardStatementLifecycleResult> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);
	const expectedRevisionNo = validateCcExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const reasonNote = validateCcOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const occurredAt = validateCcOccurredAt(params.occurredAt);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey || idempotencyKey.length > 128) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"idempotencyKey must be 1-128 characters",
		);
	}

	const candidateFp = await calculateStatementVoidFingerprint({
		userId,
		statementId,
		expectedRevisionNo,
		reasonNote,
		occurredAt,
	});

	// Early idempotency lookup
	const [existingRev] = await params.tx
		.select({
			id: creditCardStatementRevisions.id,
			statementId: creditCardStatementRevisions.statementId,
			revisionNo: creditCardStatementRevisions.revisionNo,
			operation: creditCardStatementRevisions.operation,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			statementDate: creditCardStatementRevisions.statementDate,
			dueDate: creditCardStatementRevisions.dueDate,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			note: creditCardStatementRevisions.note,
			reasonNote: creditCardStatementRevisions.reasonNote,
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

	if (existingRev) {
		if (existingRev.revisionFingerprint !== candidateFp) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different void parameters",
			);
		}
		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
			idempotentReplay: true,
			snapshot: {
				statementAmount: existingRev.statementAmount,
				statementDate: existingRev.statementDate,
				dueDate: existingRev.dueDate,
				reservePlacement:
					existingRev.reservePlacement as CreditCardReservePlacement,
				note: existingRev.note,
				reasonNote: existingRev.reasonNote,
			},
		};
	}

	try {
		// 1. Lock statement anchor FOR UPDATE
		const [stmt] = await params.tx
			.select({
				id: creditCardStatements.id,
				midasAccountId: creditCardStatements.midasAccountId,
				midasReserveBucketId: creditCardStatements.midasReserveBucketId,
			})
			.from(creditCardStatements)
			.where(
				and(
					eq(creditCardStatements.id, statementId),
					eq(creditCardStatements.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!stmt) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_FOUND",
				`Statement ${statementId} not found`,
			);
		}

		// 2. Second idempotency check post-statement-lock
		const [existingRevPost] = await params.tx
			.select({
				id: creditCardStatementRevisions.id,
				statementId: creditCardStatementRevisions.statementId,
				revisionNo: creditCardStatementRevisions.revisionNo,
				operation: creditCardStatementRevisions.operation,
				status: creditCardStatementRevisions.status,
				statementAmount: creditCardStatementRevisions.statementAmount,
				statementDate: creditCardStatementRevisions.statementDate,
				dueDate: creditCardStatementRevisions.dueDate,
				reservePlacement: creditCardStatementRevisions.reservePlacement,
				note: creditCardStatementRevisions.note,
				reasonNote: creditCardStatementRevisions.reasonNote,
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

		if (existingRevPost) {
			if (existingRevPost.revisionFingerprint !== candidateFp) {
				throw new CreditCardError(
					"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different void parameters",
				);
			}
			return {
				statementId: existingRevPost.statementId,
				revisionId: existingRevPost.id,
				revisionNo: existingRevPost.revisionNo,
				operation: existingRevPost.operation as CreditCardStatementOperation,
				status: existingRevPost.status as CreditCardStatementStatus,
				idempotentReplay: true,
				snapshot: {
					statementAmount: existingRevPost.statementAmount,
					statementDate: existingRevPost.statementDate,
					dueDate: existingRevPost.dueDate,
					reservePlacement:
						existingRevPost.reservePlacement as CreditCardReservePlacement,
					note: existingRevPost.note,
					reasonNote: existingRevPost.reasonNote,
				},
			};
		}

		// 3. Lock Midas allocation state via helper (strict global order: statement -> ledger_accounts -> midas_accounts)
		await lockMidasAllocationStateInTransaction({
			tx: params.tx,
			userId,
			midasAccountId: stmt.midasAccountId,
		});

		// 4. Load latest statement revision
		const [latest] = await params.tx
			.select({
				id: creditCardStatementRevisions.id,
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

		if (!latest) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_FOUND",
				`Statement ${statementId} has no revisions`,
			);
		}
		if (latest.status !== "OPEN") {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_NOT_OPEN",
				`Statement ${statementId} is not OPEN`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new CreditCardError(
				"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but current is ${latest.revisionNo}`,
			);
		}

		// 5. Release entire reserve if > 0
		const midasState = await getMidasLiquidityStateInTransaction({
			tx: params.tx,
			userId,
			midasAccountId: stmt.midasAccountId,
		});
		const bucket = midasState.buckets.find(
			(b) => b.bucketId === stmt.midasReserveBucketId,
		);
		const currentBucketBalanceCents = bucket
			? parseSignedAggregateMoneyString(bucket.balance).cents
			: 0n;

		if (currentBucketBalanceCents > 0n) {
			const releaseKey = await generateCardReserveMidasKey(
				idempotencyKey,
				statementId,
				"VOID_RELEASE",
			);
			try {
				await createMidasAllocationTransferInTransaction({
					tx: params.tx,
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
				if (err instanceof MidasError) {
					mapMidasError(err, "statement VOID reserve release");
				}
				mapDbError(err, "statement VOID reserve release");
			}
		}

		// 6. Insert VOID revision
		const [newRev] = await params.tx
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

		if (!newRev) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Failed to insert VOID revision",
			);
		}

		return {
			statementId,
			revisionId: newRev.id,
			revisionNo: newRev.revisionNo,
			operation: "VOID",
			status: "VOID",
			idempotentReplay: false,
			snapshot: {
				statementAmount: latest.statementAmount,
				statementDate: latest.statementDate,
				dueDate: latest.dueDate,
				reservePlacement: latest.reservePlacement as CreditCardReservePlacement,
				note: latest.note,
				reasonNote,
			},
		};
	} catch (err: unknown) {
		mapDbError(err, "statement VOID");
	}
}

export async function voidCreditCardStatement(
	params: VoidCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return voidCreditCardStatementInTransaction({
				...params,
				tx,
			});
		});
	}
	return voidCreditCardStatementInTransaction({
		...params,
		tx: params.db as DatabaseTransaction,
	});
}

// ============================================================================
// Statement Consistent Reads
// ============================================================================

export async function getCreditCardStatementInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	statementId: string,
): Promise<CreditCardStatementRecord | null> {
	const canonicalUserId = validateCcCanonicalUuid(userId, "userId");
	const canonicalStatementId = validateCcCanonicalUuid(
		statementId,
		"statementId",
	);

	try {
		// 1. Resolve immutable statement identity
		const [stmt] = await tx
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
					eq(creditCardStatements.id, canonicalStatementId),
					eq(creditCardStatements.userId, canonicalUserId),
				),
			)
			.limit(1);

		if (!stmt) return null;

		// 2. Call getMidasLiquidityStateInTransaction exactly once
		const midasState = await getMidasLiquidityStateInTransaction({
			tx,
			userId: canonicalUserId,
			midasAccountId: stmt.midasAccountId,
		});

		// 3. Read authoritative latest statement revision
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
			.where(eq(creditCardStatementRevisions.statementId, canonicalStatementId))
			.orderBy(desc(creditCardStatementRevisions.revisionNo))
			.limit(1);

		if (!latest) return null;

		// 4. Locate dedicated reserve bucket in returned Midas state
		const bucket = midasState.buckets.find(
			(b) => b.bucketId === stmt.midasReserveBucketId,
		);
		if (!bucket) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Dedicated reserve bucket ${stmt.midasReserveBucketId} not found in Midas state for statement ${canonicalStatementId}`,
			);
		}
		if (bucket.bucketType !== "CREDIT_CARD_RESERVE") {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Reserve bucket ${stmt.midasReserveBucketId} has invalid bucketType: ${bucket.bucketType}`,
			);
		}

		// Parse bucket balance
		const parsedBal = parseSignedAggregateMoneyString(bucket.balance);
		if (parsedBal.cents < 0n) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Reserve bucket ${stmt.midasReserveBucketId} has negative balance: ${bucket.balance}`,
			);
		}

		const placement = latest.reservePlacement as CreditCardReservePlacement;
		const stmtAmountCents = parseSignedAggregateMoneyString(
			latest.statementAmount,
		).cents;

		// 5. Validate fail-closed invariants
		if (latest.status === "VOID") {
			if (parsedBal.cents !== 0n) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`VOID statement ${canonicalStatementId} has non-zero reserve bucket balance: ${bucket.balance}`,
				);
			}
		} else if (latest.status === "PAID") {
			if (parsedBal.cents !== 0n) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`PAID statement ${canonicalStatementId} has non-zero reserve bucket balance: ${bucket.balance}`,
				);
			}
		} else if (placement === "MIDAS_FUND") {
			if (parsedBal.cents !== stmtAmountCents) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`OPEN MIDAS_FUND statement ${canonicalStatementId} has mismatched reserve: expected ${latest.statementAmount} found ${bucket.balance}`,
				);
			}
		} else if (placement === "OUTSIDE_MIDAS") {
			if (parsedBal.cents !== 0n) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`OPEN OUTSIDE_MIDAS statement ${canonicalStatementId} has non-zero reserve bucket balance: ${bucket.balance}`,
				);
			}
		}

		return {
			statementId: stmt.id,
			cardId: stmt.cardId,
			userId: canonicalUserId,
			cycleYear: stmt.cycleYear,
			cycleMonth: stmt.cycleMonth,
			status: latest.status as CreditCardStatementStatus,
			revisionNo: latest.revisionNo,
			statementAmount: latest.statementAmount,
			statementDate: latest.statementDate,
			dueDate: latest.dueDate,
			reservePlacement: placement,
			reserveAmount: bucket.balance,
			reserveSatisfied: true,
			note: latest.note,
		};
	} catch (err: unknown) {
		mapDbError(err);
	}
}

export async function getCreditCardStatement(
	params: GetCreditCardStatementParams,
): Promise<CreditCardStatementRecord | null> {
	const userId = validateCcCanonicalUuid(params.userId, "userId");
	const statementId = validateCcCanonicalUuid(
		params.statementId,
		"statementId",
	);

	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return getCreditCardStatementInTransaction(tx, userId, statementId);
		});
	}
	return getCreditCardStatementInTransaction(
		params.db as DatabaseTransaction,
		userId,
		statementId,
	);
}

export async function listCreditCardStatementsInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		creditCardId?: string;
		status?: CreditCardStatementStatus;
		cycleMonthFrom?: string;
		cycleMonthUntil?: string;
	},
): Promise<CreditCardStatementRecord[]> {
	const canonicalUserId = validateCcCanonicalUuid(params.userId, "userId");
	const canonicalCardId =
		params.creditCardId !== undefined && params.creditCardId !== null
			? validateCcCanonicalUuid(params.creditCardId, "creditCardId")
			: undefined;
	const statusFilter = validateStatementStatusFilter(params.status);

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

	if (
		cycleFromYear !== undefined &&
		cycleUntilYear !== undefined &&
		cycleFromMonth !== undefined &&
		cycleUntilMonth !== undefined
	) {
		if (
			cycleFromYear > cycleUntilYear ||
			(cycleFromYear === cycleUntilYear && cycleFromMonth > cycleUntilMonth)
		) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"cycleMonthFrom must be <= cycleMonthUntil",
			);
		}
	}

	try {
		// 1. Resolve user's Midas account
		const [userMidasAcc] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(eq(midasAccounts.userId, canonicalUserId))
			.limit(1);

		// If no Midas account, user has no statements either
		if (!userMidasAcc) {
			return [];
		}

		// 2. Call getMidasLiquidityStateInTransaction exactly once
		const midasState = await getMidasLiquidityStateInTransaction({
			tx,
			userId: canonicalUserId,
			midasAccountId: userMidasAcc.id,
		});

		const bucketMap = new Map<string, MidasLiquidityBucketState>();
		for (const b of midasState.buckets) {
			bucketMap.set(b.bucketId, b);
		}

		// 3. Load statement identities in one query
		const allStmts = await tx
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
					eq(creditCardStatements.userId, canonicalUserId),
					canonicalCardId
						? eq(creditCardStatements.creditCardId, canonicalCardId)
						: undefined,
				),
			)
			.orderBy(
				desc(creditCardStatements.cycleYear),
				desc(creditCardStatements.cycleMonth),
				asc(creditCardStatements.id),
			);

		if (allStmts.length === 0) {
			return [];
		}

		const stmtIds = allStmts.map((s) => s.id);

		// 4. Load all revisions for these statements in bulk
		const allRevisions = await tx
			.select({
				id: creditCardStatementRevisions.id,
				statementId: creditCardStatementRevisions.statementId,
				revisionNo: creditCardStatementRevisions.revisionNo,
				status: creditCardStatementRevisions.status,
				statementAmount: creditCardStatementRevisions.statementAmount,
				statementDate: creditCardStatementRevisions.statementDate,
				dueDate: creditCardStatementRevisions.dueDate,
				reservePlacement: creditCardStatementRevisions.reservePlacement,
				note: creditCardStatementRevisions.note,
			})
			.from(creditCardStatementRevisions)
			.where(
				and(
					eq(creditCardStatementRevisions.userId, canonicalUserId),
					inArray(creditCardStatementRevisions.statementId, stmtIds),
				),
			)
			.orderBy(
				asc(creditCardStatementRevisions.statementId),
				desc(creditCardStatementRevisions.revisionNo),
			);

		// 5. Derive latest revision per statement
		const latestRevMap = new Map<string, (typeof allRevisions)[0]>();
		for (const rev of allRevisions) {
			if (!latestRevMap.has(rev.statementId)) {
				latestRevMap.set(rev.statementId, rev);
			}
		}

		// 6. Map reserve buckets and validate ALL matched domain rows (fail closed)
		const results: CreditCardStatementRecord[] = [];

		for (const stmt of allStmts) {
			const latest = latestRevMap.get(stmt.id);
			if (!latest) continue;

			// Find bucket in Midas state
			const bucket = bucketMap.get(stmt.midasReserveBucketId);
			if (!bucket) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`Dedicated reserve bucket ${stmt.midasReserveBucketId} not found in Midas state for statement ${stmt.id}`,
				);
			}
			if (bucket.bucketType !== "CREDIT_CARD_RESERVE") {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`Reserve bucket ${stmt.midasReserveBucketId} has invalid bucketType: ${bucket.bucketType}`,
				);
			}

			const parsedBal = parseSignedAggregateMoneyString(bucket.balance);
			if (parsedBal.cents < 0n) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`Reserve bucket ${stmt.midasReserveBucketId} has negative balance: ${bucket.balance}`,
				);
			}

			const placement = latest.reservePlacement as CreditCardReservePlacement;
			const stmtAmountCents = parseSignedAggregateMoneyString(
				latest.statementAmount,
			).cents;

			// Fail-closed invariant validation
			if (latest.status === "VOID") {
				if (parsedBal.cents !== 0n) {
					throw new CreditCardError(
						"CREDIT_CARD_INVALID_STATE",
						`VOID statement ${stmt.id} has non-zero reserve bucket balance: ${bucket.balance}`,
					);
				}
			} else if (latest.status === "PAID") {
				if (parsedBal.cents !== 0n) {
					throw new CreditCardError(
						"CREDIT_CARD_INVALID_STATE",
						`PAID statement ${stmt.id} has non-zero reserve bucket balance: ${bucket.balance}`,
					);
				}
			} else if (placement === "MIDAS_FUND") {
				if (parsedBal.cents !== stmtAmountCents) {
					throw new CreditCardError(
						"CREDIT_CARD_INVALID_STATE",
						`OPEN MIDAS_FUND statement ${stmt.id} has mismatched reserve: expected ${latest.statementAmount} found ${bucket.balance}`,
					);
				}
			} else if (placement === "OUTSIDE_MIDAS") {
				if (parsedBal.cents !== 0n) {
					throw new CreditCardError(
						"CREDIT_CARD_INVALID_STATE",
						`OPEN OUTSIDE_MIDAS statement ${stmt.id} has non-zero reserve bucket balance: ${bucket.balance}`,
					);
				}
			}

			// Apply filters
			if (statusFilter && latest.status !== statusFilter) continue;

			if (cycleFromYear !== undefined && cycleFromMonth !== undefined) {
				if (
					stmt.cycleYear < cycleFromYear ||
					(stmt.cycleYear === cycleFromYear && stmt.cycleMonth < cycleFromMonth)
				) {
					continue;
				}
			}
			if (cycleUntilYear !== undefined && cycleUntilMonth !== undefined) {
				if (
					stmt.cycleYear > cycleUntilYear ||
					(stmt.cycleYear === cycleUntilYear &&
						stmt.cycleMonth > cycleUntilMonth)
				) {
					continue;
				}
			}

			results.push({
				statementId: stmt.id,
				cardId: stmt.cardId,
				userId: canonicalUserId,
				cycleYear: stmt.cycleYear,
				cycleMonth: stmt.cycleMonth,
				status: latest.status as CreditCardStatementStatus,
				revisionNo: latest.revisionNo,
				statementAmount: latest.statementAmount,
				statementDate: latest.statementDate,
				dueDate: latest.dueDate,
				reservePlacement: placement,
				reserveAmount: bucket.balance,
				reserveSatisfied: true,
				note: latest.note,
			});
		}

		// 7. Sort: OPEN first (statementDate DESC, id ASC), then VOID after (same order)
		results.sort((a, b) => {
			const aOpen = a.status === "OPEN" ? 0 : 1;
			const bOpen = b.status === "OPEN" ? 0 : 1;
			if (aOpen !== bOpen) return aOpen - bOpen;
			if (a.statementDate !== b.statementDate) {
				return a.statementDate > b.statementDate ? -1 : 1;
			}
			return a.statementId < b.statementId ? -1 : 1;
		});

		return results;
	} catch (err: unknown) {
		mapDbError(err);
	}
}

export async function listCreditCardStatements(
	params: ListCreditCardStatementsParams,
): Promise<CreditCardStatementRecord[]> {
	if (
		"transaction" in params.db &&
		typeof params.db.transaction === "function"
	) {
		return await runCreditCardTransaction(params.db as Database, async (tx) => {
			return listCreditCardStatementsInTransaction(tx, params);
		});
	}
	return listCreditCardStatementsInTransaction(
		params.db as DatabaseTransaction,
		params,
	);
}
