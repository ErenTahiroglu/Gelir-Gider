import { validatePeriodMonth } from "../income/calendar";
import { IncomeError } from "../income/errors";
import { CanonicalTransactionError } from "../transactions/errors";
import { BudgetError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes and validates a UUID input string.
 * Trims whitespace, validates case-insensitively, and returns lowercase canonical string.
 */
export function normalizeUuid(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new BudgetError("BUDGET_INVALID_INPUT", `${fieldName} is required`);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`Invalid ${fieldName} format: "${trimmed}". Must be a valid UUID`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Recursively inspects an error and its nested `.cause` chain to determine
 * whether it represents a Postgres unique violation (23505) on the
 * `monthly_budget_plans_user_period_idx` constraint.
 */
export function isBudgetPeriodUniqueViolation(err: unknown): boolean {
	let current: unknown = err;
	let depth = 0;

	while (current && depth < 10) {
		const obj = current as {
			code?: string;
			constraint?: string;
			detail?: string;
			message?: string;
			cause?: unknown;
		};

		if (obj.code === "23505") {
			if (obj.constraint === "monthly_budget_plans_user_period_idx") {
				return true;
			}
			const detail = (obj.detail || obj.message || "").toLowerCase();
			if (detail.includes("monthly_budget_plans_user_period_idx")) {
				return true;
			}
		}

		current = obj.cause;
		depth++;
	}

	return false;
}

/**
 * V2 analogue of `isBudgetPeriodUniqueViolation` for the
 * `monthly_budget_v2_plans_user_period_idx` unique constraint. Kept as a
 * separate function so the V1 detector stays a closed V1-only contract.
 */
export function isBudgetV2PeriodUniqueViolation(err: unknown): boolean {
	let current: unknown = err;
	let depth = 0;

	while (current && depth < 10) {
		const obj = current as {
			code?: string;
			constraint?: string;
			detail?: string;
			message?: string;
			cause?: unknown;
		};

		if (obj.code === "23505") {
			if (obj.constraint === "monthly_budget_v2_plans_user_period_idx") {
				return true;
			}
			const detail = (obj.detail || obj.message || "").toLowerCase();
			if (detail.includes("monthly_budget_v2_plans_user_period_idx")) {
				return true;
			}
		}

		current = obj.cause;
		depth++;
	}

	return false;
}

/**
 * Wraps validatePeriodMonth from the income domain and maps any IncomeError
 * to BudgetError("BUDGET_INVALID_INPUT", ...) so the budget public API
 * never leaks income-domain error codes.
 */
export function validateBudgetPeriodMonth(value: string): string {
	try {
		return validatePeriodMonth(value);
	} catch (err: unknown) {
		if (err instanceof IncomeError) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`Invalid period month: ${err.message}`,
			);
		}
		throw err;
	}
}

/**
 * Maps a CanonicalTransactionError from the canonical service boundary
 * into the budget domain's typed BudgetError.
 *
 * Mapping table:
 *   TRANSACTION_IDEMPOTENCY_CONFLICT -> BUDGET_IDEMPOTENCY_CONFLICT
 *   TRANSACTION_REVISION_CONFLICT    -> BUDGET_REVISION_CONFLICT
 *   TRANSACTION_ALREADY_VOIDED       -> BUDGET_ALREADY_VOIDED
 *   TRANSACTION_INVALID_STATE        -> BUDGET_INVALID_STATE
 *   TRANSACTION_NOT_FOUND            -> BUDGET_INVALID_STATE
 *
 * Other CanonicalTransactionError codes are re-thrown as BUDGET_INVALID_STATE
 * to prevent unexpected canonical codes leaking through.
 *
 * Non-CanonicalTransactionError errors are rethrown unchanged so programming
 * errors (e.g. TypeError) are not swallowed.
 */
export function mapCanonicalError(err: unknown): never {
	if (err instanceof CanonicalTransactionError) {
		switch (err.code) {
			case "TRANSACTION_IDEMPOTENCY_CONFLICT":
				throw new BudgetError("BUDGET_IDEMPOTENCY_CONFLICT", err.message);
			case "TRANSACTION_REVISION_CONFLICT":
				throw new BudgetError("BUDGET_REVISION_CONFLICT", err.message);
			case "TRANSACTION_ALREADY_VOIDED":
				throw new BudgetError("BUDGET_ALREADY_VOIDED", err.message);
			case "TRANSACTION_NOT_FOUND":
			case "TRANSACTION_INVALID_STATE":
				throw new BudgetError("BUDGET_INVALID_STATE", err.message);
			default:
				throw new BudgetError(
					"BUDGET_INVALID_STATE",
					`Unexpected canonical transaction error: ${err.message}`,
				);
		}
	}
	throw err;
}
