import { IncomeError } from "./errors";

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that the input is a valid UUID string (case-insensitively)
 * and returns the normalized lowercase canonical UUID string.
 */
export function normalizeUuid(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid ${fieldName}: must be a non-empty string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid ${fieldName}: cannot be empty`,
		);
	}

	if (!UUID_REGEX.test(trimmed)) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid ${fieldName} format: "${trimmed}". Must be a valid UUID`,
		);
	}

	return trimmed.toLowerCase();
}

/**
 * Safely inspects an error and its nested cause chain to determine if it is
 * a PostgreSQL unique constraint violation for the entitlement period index
 * ('income_entitlements_user_source_period_idx').
 */
export function isEntitlementPeriodUniqueViolation(err: unknown): boolean {
	let current: unknown = err;
	let depth = 0;
	const maxDepth = 10;

	while (current && typeof current === "object" && depth < maxDepth) {
		const obj = current as {
			code?: unknown;
			constraint?: unknown;
			detail?: unknown;
			message?: unknown;
			cause?: unknown;
		};

		const code = typeof obj.code === "string" ? obj.code : undefined;
		const constraint =
			typeof obj.constraint === "string" ? obj.constraint : undefined;
		const detail = typeof obj.detail === "string" ? obj.detail : undefined;
		const message = typeof obj.message === "string" ? obj.message : undefined;

		const hasPeriodIndex =
			constraint === "income_entitlements_user_source_period_idx" ||
			detail?.includes("income_entitlements_user_source_period_idx") ||
			message?.includes("income_entitlements_user_source_period_idx");

		if (code === "23505" && hasPeriodIndex) {
			return true;
		}

		if (hasPeriodIndex && (code === "23505" || !code)) {
			return true;
		}

		current = obj.cause;
		depth++;
	}

	return false;
}
