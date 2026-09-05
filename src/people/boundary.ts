import type { Database, DatabaseTransaction } from "../db/client";
import { IncomeError } from "../income/errors";
import { LedgerError } from "../ledger/errors";
import { CanonicalTransactionError } from "../transactions/errors";
import { PeopleError } from "./errors";

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
 * Maps Income domain errors into sanitized PeopleError instances.
 */
export function mapIncomeError(err: IncomeError, _context?: string): never {
	switch (err.code) {
		case "INCOME_IDEMPOTENCY_CONFLICT":
			throw new PeopleError(
				"PEOPLE_IDEMPOTENCY_CONFLICT",
				"People overpayment income idempotency conflict",
			);
		case "INCOME_DESTINATION_ACCOUNT_INVALID":
		case "INCOME_LEDGER_ACCOUNT_INVALID":
			throw new PeopleError(
				"PEOPLE_LEDGER_ACCOUNT_INVALID",
				"People overpayment income ledger account is invalid or archived",
			);
		case "INCOME_SOURCE_NOT_FOUND":
		case "INCOME_SOURCE_ARCHIVED":
		case "INCOME_SOURCE_CODE_CONFLICT":
		case "INCOME_RECEIPT_NOT_FOUND":
		case "INCOME_RECEIPT_INVALID_STATE":
		case "INCOME_SETTLEMENT_CONFLICT":
		case "INCOME_REFERENCE_INVALID_STATE":
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"People overpayment income state conflict",
			);
		default:
			throw new PeopleError(
				"PEOPLE_INVALID_INPUT",
				"People overpayment income input invalid",
			);
	}
}

/**
 * Maps Canonical Transaction domain errors into sanitized PeopleError instances.
 */
export function mapCanonicalError(
	err: CanonicalTransactionError,
	_context?: string,
): never {
	switch (err.code) {
		case "TRANSACTION_IDEMPOTENCY_CONFLICT":
			throw new PeopleError(
				"PEOPLE_IDEMPOTENCY_CONFLICT",
				"People transaction idempotency conflict",
			);
		case "TRANSACTION_REVISION_CONFLICT":
			throw new PeopleError(
				"PEOPLE_OBLIGATION_REVISION_CONFLICT",
				"People obligation revision conflict",
			);
		case "TRANSACTION_ALREADY_VOIDED":
		case "TRANSACTION_LEDGER_EFFECT_CONFLICT":
		case "TRANSACTION_LEDGER_EFFECT_INVALID":
		case "TRANSACTION_LEDGER_INCOMPLETE_STATE":
		case "TRANSACTION_PAYLOAD_INVALID":
		case "TRANSACTION_SOURCE_CONFLICT":
		case "TRANSACTION_INVALID_STATE":
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"People canonical transaction state conflict",
			);
		case "TRANSACTION_INVALID_INPUT":
		case "TRANSACTION_NOT_FOUND":
			throw new PeopleError(
				"PEOPLE_INVALID_INPUT",
				"People transaction input invalid",
			);
		default:
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"People canonical transaction failed",
			);
	}
}

/**
 * Maps Ledger domain errors into sanitized PeopleError instances.
 */
export function mapLedgerError(err: LedgerError, _context?: string): never {
	switch (err.code) {
		case "LEDGER_ACCOUNT_NOT_FOUND":
		case "LEDGER_ACCOUNT_ARCHIVED":
		case "LEDGER_ACCOUNT_IN_USE":
		case "LEDGER_CURRENCY_MISMATCH":
			throw new PeopleError(
				"PEOPLE_LEDGER_ACCOUNT_INVALID",
				"People ledger account is invalid or archived",
			);
		case "LEDGER_IDEMPOTENCY_CONFLICT":
			throw new PeopleError(
				"PEOPLE_IDEMPOTENCY_CONFLICT",
				"People ledger journal idempotency conflict",
			);
		case "INVALID_MONEY":
		case "LEDGER_INVALID_ENTRY":
		case "LEDGER_USER_NOT_FOUND":
			throw new PeopleError(
				"PEOPLE_INVALID_INPUT",
				"People ledger entry input is invalid",
			);
		default:
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"People ledger state conflict",
			);
	}
}

/**
 * Maps recognized database errors, triggers, and constraint violations into sanitized PeopleError.
 */
export function mapDbError(err: unknown, _context?: string): never {
	if (err instanceof PeopleError) throw err;
	if (err instanceof IncomeError) {
		mapIncomeError(err);
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
		causeChain.includes("active settled amount") ||
		causeChain.includes("below active settled amount") ||
		causeChain.includes("push obligation") ||
		causeChain.includes("beyond principal")
	) {
		throw new PeopleError(
			"PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
			"Operation conflicts with obligation's active settled amount",
		);
	}
	if (
		causeChain.includes("cannot settle obligation") ||
		causeChain.includes("cannot create obligation for archived")
	) {
		throw new PeopleError(
			"PEOPLE_OBLIGATION_NOT_ACTIVE",
			"Obligation or person is not in an active state for this operation",
		);
	}
	if (
		causeChain.includes("cannot archive") ||
		causeChain.includes("cannot create revision on archived") ||
		causeChain.includes("cannot create revision on void")
	) {
		throw new PeopleError(
			"PEOPLE_NOT_ACTIVE",
			"Person or obligation is not active for this operation",
		);
	}
	if (
		causeChain.includes("branching forbidden") ||
		causeChain.includes("trg_fn_guard_person_revision_insert") ||
		causeChain.includes("person_revisions_person_rev_idx")
	) {
		throw new PeopleError(
			"PEOPLE_REVISION_CONFLICT",
			"Person revision conflict",
		);
	}
	if (
		causeChain.includes("trg_fn_guard_person_obligation_revision_insert") ||
		causeChain.includes("person_obligation_revisions_obl_rev_idx")
	) {
		throw new PeopleError(
			"PEOPLE_OBLIGATION_REVISION_CONFLICT",
			"Person obligation revision conflict",
		);
	}
	if (
		causeChain.includes("trg_fn_guard_person_settlement_revision_insert") ||
		causeChain.includes("person_settlement_revisions_settle_rev_idx")
	) {
		throw new PeopleError(
			"PEOPLE_OBLIGATION_OVERSETTLEMENT",
			"Person settlement conflict",
		);
	}
	if (
		causeChain.includes("does not reconcile") ||
		causeChain.includes("cannot become negative")
	) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Person ledger balance failed reconciliation or non-negativity checks",
		);
	}
	if (
		causeChain.includes("linked to a people receivable/payable account") ||
		causeChain.includes("linked to a people system income role") ||
		causeChain.includes("trg_fn_guard_ledger_accounts_archive")
	) {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			"People ledger account archive constraint violation",
		);
	}

	throw new PeopleError(
		"PEOPLE_INVALID_STATE",
		"People state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with centralized
 * error boundary mapping.
 *
 * Catches both in-flight work errors and deferred COMMIT-time trigger/constraint rejections.
 * - PeopleError: rethrown unchanged
 * - IncomeError: mapped to sanitized PeopleError
 * - CanonicalTransactionError: mapped to sanitized PeopleError
 * - LedgerError: mapped to sanitized PeopleError
 * - Recognized DB/Postgres/Drizzle error: mapped to sanitized PeopleError
 * - Programmer errors (e.g. TypeError, ReferenceError): rethrown unchanged
 */
async function withPeopleErrorBoundary<T>(exec: () => Promise<T>): Promise<T> {
	try {
		return await exec();
	} catch (err: unknown) {
		if (err instanceof PeopleError) {
			throw err;
		}
		if (err instanceof IncomeError) {
			mapIncomeError(err);
		}
		if (err instanceof CanonicalTransactionError) {
			mapCanonicalError(err);
		}
		if (err instanceof LedgerError) {
			mapLedgerError(err);
		}
		if (isDatabaseBoundaryError(err)) {
			mapDbError(err);
		}
		throw err;
	}
}

export async function runPeopleTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	return withPeopleErrorBoundary(() => db.transaction(work));
}

/**
 * Executes a read-only unit of work inside a REPEATABLE READ transaction, so
 * every statement inside `work` sees one coherent snapshot of the database
 * rather than PostgreSQL's default READ COMMITTED behavior (which can observe
 * a different committed state from one statement to the next within the same
 * `db.transaction(...)` call). Used by every People read API that combines a
 * revision with derived ledger balances or settlement totals, so those pieces
 * are never assembled from different points in time. Shares the same
 * sanitized error boundary as `runPeopleTransaction`.
 */
export async function runPeopleReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	return withPeopleErrorBoundary(() =>
		db.transaction(work, { isolationLevel: "repeatable read" }),
	);
}
