import { CreditCardError } from "../credit-cards/errors";
import type { Database, DatabaseTransaction } from "../db/client";
import { IncomeError } from "../income/errors";
import { LedgerError } from "../ledger/errors";
import { CanonicalTransactionError } from "../transactions/errors";
import { ImportError } from "./errors";

/**
 * Extracts and traverses the complete error cause chain into a lowercase string.
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
			if (typeof obj.message === "string") messages.push(obj.message);
			if (typeof obj.detail === "string") messages.push(obj.detail);
			if (typeof obj.hint === "string") messages.push(obj.hint);
			if (typeof obj.where === "string") messages.push(obj.where);
			if (typeof obj.constraint === "string") messages.push(obj.constraint);
			if (typeof obj.constraint_name === "string") {
				messages.push(obj.constraint_name);
			}
			if (typeof obj.routine === "string") messages.push(obj.routine);
			current = (current as { cause?: unknown }).cause;
		} else {
			break;
		}
	}

	return messages.join(" | ").toLowerCase();
}

/**
 * Checks whether an error matches a specific constraint or fragment.
 */
export function matchesDbConstraint(
	err: unknown,
	constraintName: string,
	fragment?: string,
): boolean {
	const chain = extractErrorCauseChain(err);
	const lowerConstraint = constraintName.toLowerCase();
	if (chain.includes(lowerConstraint)) return true;
	if (fragment && chain.includes(fragment.toLowerCase())) return true;
	return false;
}

/**
 * Maps any domain or lower-level DB error to a clean, sanitized ImportError.
 */
export function mapToImportError(err: unknown): ImportError {
	if (err instanceof ImportError) {
		return err;
	}

	if (err instanceof CreditCardError) {
		if (err.code === "CREDIT_CARD_NOT_FOUND") {
			return new ImportError("IMPORT_TARGET_NOT_FOUND", err.message);
		}
		if (err.code === "CREDIT_CARD_IDEMPOTENCY_CONFLICT") {
			return new ImportError("IMPORT_IDEMPOTENCY_CONFLICT", err.message);
		}
		return new ImportError("IMPORT_INVALID_INPUT", err.message);
	}

	if (err instanceof IncomeError) {
		if (
			err.code === "INCOME_SOURCE_NOT_FOUND" ||
			err.code === "INCOME_DESTINATION_ACCOUNT_INVALID"
		) {
			return new ImportError("IMPORT_TARGET_NOT_FOUND", err.message);
		}
		if (err.code === "INCOME_IDEMPOTENCY_CONFLICT") {
			return new ImportError("IMPORT_IDEMPOTENCY_CONFLICT", err.message);
		}
		return new ImportError("IMPORT_INVALID_INPUT", err.message);
	}

	if (err instanceof CanonicalTransactionError) {
		if (err.code === "TRANSACTION_IDEMPOTENCY_CONFLICT") {
			return new ImportError("IMPORT_IDEMPOTENCY_CONFLICT", err.message);
		}
		return new ImportError("IMPORT_INVALID_INPUT", err.message);
	}

	if (err instanceof LedgerError) {
		return new ImportError("IMPORT_INVALID_INPUT", err.message);
	}

	const chain = extractErrorCauseChain(err);

	// Immutability checks
	if (
		chain.includes("is immutable: update and delete operations are forbidden")
	) {
		return new ImportError(
			"IMPORT_INVALID_STATE",
			"Import records are immutable: UPDATE and DELETE operations are forbidden",
		);
	}

	// Revision chain / sequence checks
	if (chain.includes("cannot append new revision to terminal row status")) {
		return new ImportError(
			"IMPORT_REVISION_CONFLICT",
			"Cannot append new revision to a terminal row",
		);
	}
	if (chain.includes("revision sequence gap")) {
		return new ImportError(
			"IMPORT_REVISION_CONFLICT",
			"Revision sequence conflict: unexpected revision number",
		);
	}
	if (chain.includes("import_row_revisions_row_rev_idx")) {
		return new ImportError(
			"IMPORT_REVISION_CONFLICT",
			"Revision number already exists for this import row",
		);
	}
	if (chain.includes("import_row_revisions_prev_rev_idx")) {
		return new ImportError(
			"IMPORT_REVISION_CONFLICT",
			"Revision branching forbidden: previous revision is already linked",
		);
	}

	// Idempotency conflict
	if (chain.includes("import_row_revisions_user_idempotency_idx")) {
		return new ImportError(
			"IMPORT_IDEMPOTENCY_CONFLICT",
			"Duplicate idempotency key used for import row revision",
		);
	}

	// Unique external claim
	if (chain.includes("import_ext_claims_identity_idx")) {
		return new ImportError(
			"IMPORT_EXACT_DUPLICATE",
			"Strong external identity claim already exists",
		);
	}

	// Unique batch row ordinal
	if (chain.includes("import_rows_batch_ordinal_idx")) {
		return new ImportError(
			"IMPORT_INVALID_INPUT",
			"Duplicate row ordinal within import batch",
		);
	}

	// Unique batch identity
	if (chain.includes("import_batches_identity_idx")) {
		return new ImportError(
			"IMPORT_IDEMPOTENCY_CONFLICT",
			"Import batch with identical identity already exists",
		);
	}

	// Anchor completeness / result binding triggers
	if (chain.includes("naked import row anchor")) {
		return new ImportError(
			"IMPORT_INVALID_STATE",
			"Import row has no stage revision at commit",
		);
	}
	if (
		chain.includes("import row revision") &&
		chain.includes("no matching import_row_results")
	) {
		return new ImportError(
			"IMPORT_INVALID_STATE",
			"Terminal revision requires matching import result record",
		);
	}
	if (
		chain.includes("card id mismatch") ||
		chain.includes("amount mismatch") ||
		chain.includes("income source mismatch")
	) {
		return new ImportError(
			"IMPORT_TARGET_MISMATCH",
			"Import result target does not match row payload",
		);
	}

	// Fallback
	const rawMessage = err instanceof Error ? err.message : String(err);
	return new ImportError("IMPORT_INVALID_INPUT", rawMessage);
}

/**
 * Runs a callback inside a database transaction with automatic error mapping.
 */
export async function withImportTransaction<T>(
	db: Database | DatabaseTransaction,
	fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		if ("transaction" in db && typeof db.transaction === "function") {
			return await db.transaction(async (tx) => {
				return await fn(tx as DatabaseTransaction);
			});
		}
		return await fn(db as DatabaseTransaction);
	} catch (err) {
		throw mapToImportError(err);
	}
}
