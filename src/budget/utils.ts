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
