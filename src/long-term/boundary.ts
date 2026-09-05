import type { Database, DatabaseTransaction } from "../db/client";
import { LedgerError } from "../ledger/errors";
import { MidasError } from "../midas/errors";
import { CanonicalTransactionError } from "../transactions/errors";
import { LongTermError } from "./errors";

/**
 * Extracts and traverses the complete error cause chain into a lowercase
 * string to reliably inspect lower-layer and database engine errors.
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
			if (typeof obj.constraint_name === "string")
				messages.push(obj.constraint_name);
			if (typeof obj.routine === "string") messages.push(obj.routine);
			current = (current as { cause?: unknown }).cause;
		} else {
			break;
		}
	}

	return messages.join(" | ").toLowerCase();
}

/**
 * Checks whether an error represents a specific database constraint or
 * trigger error.
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
 * Detects whether an error originated from Drizzle, pg-core, or PostgreSQL
 * driver layer.
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
			if ("query" in obj && typeof obj.query === "string") return true;

			if (typeof obj.code === "string") {
				if (/^[0-9A-Z]{5}$/.test(obj.code)) return true;
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
 * Maps Midas domain errors into sanitized LongTermError instances.
 */
export function mapMidasError(err: MidasError): never {
	switch (err.code) {
		case "MIDAS_INSUFFICIENT_FREE_BALANCE":
			throw new LongTermError(
				"LONG_TERM_INSUFFICIENT_UNALLOCATED",
				"Insufficient unallocated Midas liquidity for this operation",
			);
		case "MIDAS_IDEMPOTENCY_CONFLICT":
			throw new LongTermError(
				"LONG_TERM_IDEMPOTENCY_CONFLICT",
				"Long-term operation idempotency conflict at the Midas allocation layer",
			);
		case "MIDAS_INVALID_INPUT":
			throw new LongTermError(
				"LONG_TERM_INVALID_INPUT",
				"Long-term operation input invalid at the Midas allocation layer",
			);
		default:
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Long-term Midas allocation state conflict",
			);
	}
}

/**
 * Maps Canonical Transaction domain errors into sanitized LongTermError
 * instances.
 */
export function mapCanonicalError(err: CanonicalTransactionError): never {
	switch (err.code) {
		case "TRANSACTION_IDEMPOTENCY_CONFLICT":
			throw new LongTermError(
				"LONG_TERM_IDEMPOTENCY_CONFLICT",
				"Long-term canonical transaction idempotency conflict",
			);
		case "TRANSACTION_REVISION_CONFLICT":
			throw new LongTermError(
				"LONG_TERM_REVISION_CONFLICT",
				"Long-term canonical transaction revision conflict",
			);
		case "TRANSACTION_INVALID_INPUT":
		case "TRANSACTION_NOT_FOUND":
			throw new LongTermError(
				"LONG_TERM_INVALID_INPUT",
				"Long-term canonical transaction input invalid",
			);
		default:
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Long-term canonical transaction state conflict",
			);
	}
}

/**
 * Maps Ledger domain errors into sanitized LongTermError instances.
 */
export function mapLedgerError(err: LedgerError): never {
	switch (err.code) {
		case "LEDGER_IDEMPOTENCY_CONFLICT":
			throw new LongTermError(
				"LONG_TERM_IDEMPOTENCY_CONFLICT",
				"Long-term ledger journal idempotency conflict",
			);
		case "INVALID_MONEY":
		case "LEDGER_INVALID_ENTRY":
		case "LEDGER_USER_NOT_FOUND":
			throw new LongTermError(
				"LONG_TERM_INVALID_INPUT",
				"Long-term ledger entry input is invalid",
			);
		default:
			throw new LongTermError(
				"LONG_TERM_INVALID_STATE",
				"Long-term ledger state conflict",
			);
	}
}

/**
 * Maps recognized database errors, triggers, and constraint violations into
 * sanitized LongTermError instances. No raw SQL/constraint/query/credential
 * data may escape.
 */
export function mapDbError(err: unknown): never {
	if (err instanceof LongTermError) throw err;
	if (err instanceof MidasError) mapMidasError(err);
	if (err instanceof CanonicalTransactionError) mapCanonicalError(err);
	if (err instanceof LedgerError) mapLedgerError(err);
	if (!isDatabaseBoundaryError(err)) {
		throw err;
	}

	const causeChain = extractErrorCauseChain(err);

	if (
		causeChain.includes("does not match sum of pending task amounts") ||
		(causeChain.includes("balance") && causeChain.includes("pending_long_term"))
	) {
		throw new LongTermError(
			"LONG_TERM_INVALID_STATE",
			"Long-term pending-bucket reconciliation invariant violated",
		);
	}
	if (
		matchesDbConstraint(err, "long_term_task_revisions_task_rev_idx") ||
		matchesDbConstraint(err, "trg_fn_guard_long_term_task_revision_insert")
	) {
		throw new LongTermError(
			"LONG_TERM_REVISION_CONFLICT",
			"Long-term task revision conflict",
		);
	}
	if (
		matchesDbConstraint(err, "long_term_task_revisions_user_idempotency_idx")
	) {
		throw new LongTermError(
			"LONG_TERM_IDEMPOTENCY_CONFLICT",
			"Long-term task idempotency key conflict",
		);
	}
	if (
		causeChain.includes("cannot create revision on cancelled") ||
		causeChain.includes("terminal")
	) {
		throw new LongTermError(
			"LONG_TERM_TASK_CANCELLED",
			"Long-term task is CANCELLED (terminal)",
		);
	}
	if (
		causeChain.includes("naked task anchor") ||
		causeChain.includes("no linked long_term_send_task_revisions")
	) {
		throw new LongTermError(
			"LONG_TERM_INVALID_STATE",
			"Long-term domain anchor completeness violation",
		);
	}

	throw new LongTermError(
		"LONG_TERM_INVALID_STATE",
		"Long-term state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with
 * centralized error boundary mapping.
 */
export async function runLongTermTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work);
	} catch (err: unknown) {
		if (err instanceof LongTermError) throw err;
		if (err instanceof MidasError) mapMidasError(err);
		if (err instanceof CanonicalTransactionError) mapCanonicalError(err);
		if (err instanceof LedgerError) mapLedgerError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

/**
 * Executes a read-only unit of work under REPEATABLE READ isolation so a
 * result combining multiple statements (task, latest revision, Midas
 * transfer, canonical send data) is guaranteed to come from one coherent
 * snapshot.
 */
export async function runLongTermReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work, { isolationLevel: "repeatable read" });
	} catch (err: unknown) {
		if (err instanceof LongTermError) throw err;
		if (err instanceof MidasError) mapMidasError(err);
		if (err instanceof CanonicalTransactionError) mapCanonicalError(err);
		if (err instanceof LedgerError) mapLedgerError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}
