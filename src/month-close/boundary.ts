import type { Database, DatabaseTransaction } from "../db/client";
import { LedgerError } from "../ledger/errors";
import { MidasError } from "../midas/errors";
import { ShortTermGoalError } from "../short-term-goals/errors";
import { MonthCloseError } from "./errors";

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
 * Maps Midas domain errors into sanitized MonthCloseError instances.
 */
export function mapMidasError(err: MidasError): never {
	switch (err.code) {
		case "MIDAS_INSUFFICIENT_FREE_BALANCE":
			throw new MonthCloseError(
				"MONTH_CLOSE_INSUFFICIENT_LIQUIDITY",
				"Insufficient unallocated Midas liquidity for this month-close routing",
			);
		case "MIDAS_IDEMPOTENCY_CONFLICT":
			throw new MonthCloseError(
				"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
				"Month-close operation idempotency conflict at the Midas allocation layer",
			);
		case "MIDAS_ACCOUNT_NOT_FOUND":
			throw new MonthCloseError(
				"MONTH_CLOSE_MIDAS_NOT_FOUND",
				"Midas account not found for month-close routing",
			);
		case "MIDAS_INVALID_INPUT":
			throw new MonthCloseError(
				"MONTH_CLOSE_INVALID_INPUT",
				"Month-close operation input invalid at the Midas allocation layer",
			);
		default:
			throw new MonthCloseError(
				"MONTH_CLOSE_INVALID_STATE",
				"Month-close Midas allocation state conflict",
			);
	}
}

/**
 * Maps Short-Term Goal domain errors into sanitized MonthCloseError
 * instances.
 */
export function mapShortTermGoalError(err: ShortTermGoalError): never {
	switch (err.code) {
		case "SHORT_TERM_GOAL_NOT_ACTIVE":
			throw new MonthCloseError(
				"MONTH_CLOSE_STALE_PROPOSAL",
				"Recommended short-term goal is no longer ACTIVE",
			);
		case "SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED":
			throw new MonthCloseError(
				"MONTH_CLOSE_STALE_PROPOSAL",
				"Recommended short-term goal funding cap would be exceeded",
			);
		case "SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE":
			throw new MonthCloseError(
				"MONTH_CLOSE_INSUFFICIENT_LIQUIDITY",
				err.message,
			);
		case "SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT":
			throw new MonthCloseError(
				"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
				err.message,
			);
		case "SHORT_TERM_GOAL_NOT_FOUND":
			throw new MonthCloseError(
				"MONTH_CLOSE_STALE_PROPOSAL",
				"Recommended short-term goal no longer exists",
			);
		default:
			throw new MonthCloseError(
				"MONTH_CLOSE_INVALID_STATE",
				"Month-close short-term goal state conflict",
			);
	}
}

/**
 * Maps Ledger domain errors into sanitized MonthCloseError instances.
 */
export function mapLedgerError(err: LedgerError): never {
	switch (err.code) {
		case "LEDGER_IDEMPOTENCY_CONFLICT":
			throw new MonthCloseError(
				"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
				"Month-close ledger idempotency conflict",
			);
		case "INVALID_MONEY":
		case "LEDGER_INVALID_ENTRY":
		case "LEDGER_USER_NOT_FOUND":
			throw new MonthCloseError(
				"MONTH_CLOSE_INVALID_INPUT",
				"Month-close ledger input is invalid",
			);
		default:
			throw new MonthCloseError(
				"MONTH_CLOSE_INVALID_STATE",
				"Month-close ledger state conflict",
			);
	}
}

/**
 * Maps recognized database errors, triggers, and constraint violations into
 * sanitized MonthCloseError instances. No raw SQL/constraint/query/credential
 * data may escape.
 */
export function mapDbError(err: unknown): never {
	if (err instanceof MonthCloseError) throw err;
	if (err instanceof MidasError) mapMidasError(err);
	if (err instanceof ShortTermGoalError) mapShortTermGoalError(err);
	if (err instanceof LedgerError) mapLedgerError(err);
	if (!isDatabaseBoundaryError(err)) {
		throw err;
	}

	const causeChain = extractErrorCauseChain(err);

	if (
		matchesDbConstraint(err, "month_closes_user_period_idx") ||
		causeChain.includes("naked month-close anchor")
	) {
		throw new MonthCloseError(
			"MONTH_CLOSE_ALREADY_CLOSED",
			"A month close already exists for this user/period",
		);
	}
	if (matchesDbConstraint(err, "month_close_revisions_user_idempotency_idx")) {
		throw new MonthCloseError(
			"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
			"Month-close idempotency key conflict",
		);
	}
	if (
		causeChain.includes("does not match monthly budget plan") ||
		causeChain.includes("budget plan revision")
	) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_STATE",
			"Month-close budget-plan binding invariant violated",
		);
	}

	throw new MonthCloseError(
		"MONTH_CLOSE_INVALID_STATE",
		"Month-close state transition failed",
	);
}

/**
 * Executes a unit of work inside a managed database transaction with
 * centralized error boundary mapping.
 */
export async function runMonthCloseTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work);
	} catch (err: unknown) {
		if (err instanceof MonthCloseError) throw err;
		if (err instanceof MidasError) mapMidasError(err);
		if (err instanceof ShortTermGoalError) mapShortTermGoalError(err);
		if (err instanceof LedgerError) mapLedgerError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}

/**
 * Executes a read-only unit of work under REPEATABLE READ isolation so a
 * result combining multiple statements comes from one coherent snapshot.
 */
export async function runMonthCloseReadTransaction<T>(
	db: Database,
	work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(work, { isolationLevel: "repeatable read" });
	} catch (err: unknown) {
		if (err instanceof MonthCloseError) throw err;
		if (err instanceof MidasError) mapMidasError(err);
		if (err instanceof ShortTermGoalError) mapShortTermGoalError(err);
		if (err instanceof LedgerError) mapLedgerError(err);
		if (isDatabaseBoundaryError(err)) mapDbError(err);
		throw err;
	}
}
