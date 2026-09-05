import type { Database, DatabaseTransaction } from "../db/client";
import { LedgerError } from "../ledger/errors";
import { MidasError } from "../midas/errors";
import { CanonicalTransactionError } from "../transactions/errors";
import { CreditCardError } from "./errors";

/**
 * Extracts and traverses the complete error cause chain into a lowercase string
 * to reliably inspect lower-layer and database engine errors.
 */
export function extractErrorCauseChain(err: unknown): string {
	const messages: string[] = [];
	let current: unknown = err;
	let depth = 0;
	const visited = new Set<unknown>();

	while (current && depth < 10 && !visited.has(current)) {
		visited.add(current);
		depth++;

		if (typeof current === "string") {
			messages.push(current);
		} else if (typeof current === "object" && current !== null) {
			const obj = current as Record<string, unknown>;
			if (typeof obj.message === "string") {
				messages.push(obj.message);
			}
			if (typeof obj.detail === "string") {
				messages.push(obj.detail);
			}
			if (typeof obj.hint === "string") {
				messages.push(obj.hint);
			}
			if (typeof obj.where === "string") {
				messages.push(obj.where);
			}
			if (typeof obj.constraint === "string") {
				messages.push(obj.constraint);
			}
			if (typeof obj.constraint_name === "string") {
				messages.push(obj.constraint_name);
			}
			if (typeof obj.routine === "string") {
				messages.push(obj.routine);
			}
			current = (current as { cause?: unknown }).cause;
		} else {
			break;
		}
	}

	return messages.join(" | ").toLowerCase();
}

/**
 * Checks whether an error represents a specific database constraint or trigger error.
 */
export function matchesDbConstraint(
	err: unknown,
	constraintName: string,
	fragment?: string,
): boolean {
	const chain = extractErrorCauseChain(err);
	const lowerConstraint = constraintName.toLowerCase();
	if (chain.includes(lowerConstraint)) {
		return true;
	}
	if (fragment && chain.includes(fragment.toLowerCase())) {
		return true;
	}
	return false;
}

/**
 * Detects whether an error originated from Drizzle, pg-core, or PostgreSQL driver layer.
 */
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

/**
 * Maps Midas domain errors into sanitized CreditCardError instances.
 */
export function mapMidasError(err: MidasError, _context?: string): never {
	switch (err.code) {
		case "MIDAS_INSUFFICIENT_FREE_BALANCE":
			throw new CreditCardError(
				"CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY",
				"Insufficient free Midas liquidity for credit card reserve",
			);
		case "MIDAS_IDEMPOTENCY_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Midas allocation idempotency conflict",
			);
		case "MIDAS_INSUFFICIENT_BUCKET_BALANCE":
			throw new CreditCardError(
				"CREDIT_CARD_RESERVE_CONFLICT",
				"Insufficient reserve bucket balance",
			);
		default:
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Credit card reserve state is inconsistent",
			);
	}
}

/**
 * Maps Canonical Transaction domain errors into sanitized CreditCardError instances.
 */
export function mapCanonicalError(
	err: CanonicalTransactionError,
	_context?: string,
): never {
	switch (err.code) {
		case "TRANSACTION_IDEMPOTENCY_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Credit card transaction idempotency conflict",
			);
		case "TRANSACTION_REVISION_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_REVISION_CONFLICT",
				"Credit card transaction revision conflict",
			);
		case "TRANSACTION_ALREADY_VOIDED":
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Credit card transaction is already voided",
			);
		case "TRANSACTION_LEDGER_EFFECT_CONFLICT":
		case "TRANSACTION_LEDGER_EFFECT_INVALID":
		case "TRANSACTION_LEDGER_INCOMPLETE_STATE":
		case "TRANSACTION_PAYLOAD_INVALID":
		case "TRANSACTION_SOURCE_CONFLICT":
		case "TRANSACTION_INVALID_STATE":
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Credit card canonical transaction state conflict",
			);
		case "TRANSACTION_INVALID_INPUT":
		case "TRANSACTION_NOT_FOUND":
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"Credit card transaction input invalid",
			);
		default:
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Credit card canonical transaction failed",
			);
	}
}

/**
 * Maps Ledger domain errors into sanitized CreditCardError instances.
 */
export function mapLedgerError(err: LedgerError, _context?: string): never {
	switch (err.code) {
		case "LEDGER_ACCOUNT_NOT_FOUND":
		case "LEDGER_ACCOUNT_ARCHIVED":
		case "LEDGER_ACCOUNT_IN_USE":
		case "LEDGER_CURRENCY_MISMATCH":
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				"Credit card ledger account is invalid or archived",
			);
		case "LEDGER_IDEMPOTENCY_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Credit card ledger journal idempotency conflict",
			);
		case "INVALID_MONEY":
		case "LEDGER_INVALID_ENTRY":
		case "LEDGER_USER_NOT_FOUND":
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"Credit card ledger entry input is invalid",
			);
		default:
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Credit card ledger state conflict",
			);
	}
}

/**
 * Maps recognized database errors, triggers, and constraint violations into sanitized CreditCardError.
 */
export function mapDbError(err: unknown, _context?: string): never {
	if (err instanceof CreditCardError) throw err;
	if (err instanceof MidasError) {
		mapMidasError(err);
	}
	if (err instanceof CanonicalTransactionError) {
		mapCanonicalError(err);
	}
	if (err instanceof LedgerError) {
		mapLedgerError(err);
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
	if (
		causeChain.includes("liability balance cannot become negative") ||
		causeChain.includes("negative liability") ||
		causeChain.includes("trg_fn_guard_cc_liability_non_negative")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			"Operation would result in negative credit card liability balance",
		);
	}
	if (
		causeChain.includes("with open statements") ||
		causeChain.includes("cannot create revision on archived card") ||
		causeChain.includes("cannot create liability event on non-active card") ||
		causeChain.includes("cannot create statement on archived card") ||
		causeChain.includes("cannot pay statement on archived card") ||
		causeChain.includes("cannot reopen statement on archived card")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			"Credit card is not active for this operation",
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
	if (
		causeChain.includes("cannot link archived") ||
		causeChain.includes("linked credit card ledger account") ||
		causeChain.includes("system account for role") ||
		causeChain.includes("outside payment asset account")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
			"Credit card ledger account constraint violation",
		);
	}

	if (
		matchesDbConstraint(err, "credit_card_purchase_splits_purchase_event_id_uq")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_CONFLICT",
			"A split already exists for this purchase",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"credit_card_purchase_split_revisions_split_revision_no_uq",
			"trg_fn_guard_cc_split_revision_insert",
		) ||
		causeChain.includes("split revision branching")
	) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_REVISION_CONFLICT",
			"Credit card split revision conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"credit_card_purchase_split_revisions_split_idempotency_key_uq",
		)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
			"Credit card split idempotency key conflict",
		);
	}
	if (
		matchesDbConstraint(
			err,
			"credit_card_purchase_split_revision_items_rev_person_uq",
		)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"Duplicate person in split revision",
		);
	}

	throw new CreditCardError(
		"CREDIT_CARD_INVALID_STATE",
		"Credit card state transition failed",
	);
}

/**
 * Maps People domain errors into sanitized CreditCardError instances.
 */
export function mapPeopleError(
	err: import("../people/errors").PeopleError,
	_context?: string,
): never {
	switch (err.code) {
		case "PEOPLE_NOT_FOUND":
		case "PEOPLE_INVALID_INPUT":
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				err.message || "Invalid people parameter",
			);
		case "PEOPLE_NOT_ACTIVE":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_CONFLICT",
				"Selected person is not active",
			);
		case "PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_CONFLICT",
				err.message ||
					"Cannot modify or void obligation with active settlements",
			);
		case "PEOPLE_OBLIGATION_REVISION_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_REVISION_CONFLICT",
				"Split obligation revision conflict",
			);
		case "PEOPLE_IDEMPOTENCY_CONFLICT":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
				"Split obligation idempotency conflict",
			);
		case "PEOPLE_OBLIGATION_NOT_FOUND":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_NOT_FOUND",
				"Split obligation not found",
			);
		case "PEOPLE_OBLIGATION_NOT_ACTIVE":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_NOT_ACTIVE",
				"Split obligation is not active",
			);
		case "PEOPLE_OBLIGATION_OVERSETTLEMENT":
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_CONFLICT",
				err.message || "Split obligation oversettlement conflict",
			);
		case "PEOPLE_LEDGER_ACCOUNT_INVALID":
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				err.message || "Invalid ledger account for split obligation",
			);
		case "PEOPLE_INVALID_STATE":
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				err.message || "Invalid people domain state during split operation",
			);
		default:
			throw new CreditCardError(
				"CREDIT_CARD_SPLIT_CONFLICT",
				"People domain conflict during credit card operation",
			);
	}
}

/**
 * Executes a unit of work inside a managed database transaction with centralized
 * error boundary mapping.
 *
 * Catches both in-flight work errors and deferred COMMIT-time trigger/constraint rejections.
 * - CreditCardError: rethrown unchanged
 * - MidasError: mapped to sanitized CreditCardError
 * - CanonicalTransactionError: mapped to sanitized CreditCardError
 * - LedgerError: mapped to sanitized CreditCardError
 * - PeopleError: mapped to sanitized CreditCardError
 * - Recognized DB/Postgres/Drizzle error: mapped to sanitized CreditCardError
 * - Programmer errors (e.g. TypeError, ReferenceError): rethrown unchanged
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
		if (err instanceof CanonicalTransactionError) {
			mapCanonicalError(err);
		}
		if (err instanceof LedgerError) {
			mapLedgerError(err);
		}
		if (
			err &&
			typeof err === "object" &&
			"name" in err &&
			(err as { name: string }).name === "PeopleError"
		) {
			mapPeopleError(err as import("../people/errors").PeopleError);
		}
		if (isDatabaseBoundaryError(err)) {
			mapDbError(err);
		}
		throw err;
	}
}

/**
 * Executes a read-only unit of work under REPEATABLE READ isolation so a
 * result combining multiple statements (e.g. a purchase's latest revision,
 * an active split's latest revision, participant obligations, and settlement
 * totals) is guaranteed to come from one coherent snapshot rather than
 * possibly-different READ COMMITTED snapshots per statement. Uses the same
 * sanitized error mapping as the write boundary. Does not affect write
 * transaction isolation.
 */
export async function runCreditCardReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work, { isolationLevel: "repeatable read" });
	} catch (err: unknown) {
		if (err instanceof CreditCardError) {
			throw err;
		}
		if (err instanceof MidasError) {
			mapMidasError(err);
		}
		if (err instanceof CanonicalTransactionError) {
			mapCanonicalError(err);
		}
		if (err instanceof LedgerError) {
			mapLedgerError(err);
		}
		if (
			err &&
			typeof err === "object" &&
			"name" in err &&
			(err as { name: string }).name === "PeopleError"
		) {
			mapPeopleError(err as import("../people/errors").PeopleError);
		}
		if (isDatabaseBoundaryError(err)) {
			mapDbError(err);
		}
		throw err;
	}
}
