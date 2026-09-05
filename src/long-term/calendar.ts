import { parsePositiveMoneyString } from "../ledger/money";
import { LongTermError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates and canonicalizes a UUID string to lowercase. Accepts `unknown`
 * -- never trusts the caller-declared TypeScript type -- and never calls
 * `.trim()` before confirming the value is a string.
 */
export function validateLongTermCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Validates a positive money string (NUMERIC(18,2) contract).
 */
export function validateLongTermPositiveMoney(
	value: unknown,
	fieldName: string,
): { normalized: string; cents: bigint } {
	try {
		return parsePositiveMoneyString(value);
	} catch (err) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Validates an optional trimmed text field. Accepts `unknown`. Only
 * `undefined`/`null` mean omitted; a whitespace-only string normalizes to
 * null.
 */
export function validateLongTermOptionalText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (trimmed.length > maxLength) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

/**
 * Validates an occurredAt value. Accepts `unknown`.
 */
export function validateLongTermOccurredAt(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

/**
 * Validates a long-term idempotency key. Accepts `unknown`, requires a
 * string, trims, and checks length 1..128. Never calls `.trim()` on an
 * unverified value.
 */
export function validateLongTermIdempotencyKey(value: unknown): string {
	if (typeof value !== "string") {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			"idempotencyKey must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 128) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

/**
 * Validates an expectedRevisionNo for optimistic concurrency control.
 * Accepts `unknown`.
 */
export function validateLongTermExpectedRevisionNo(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			"expectedRevisionNo must be a safe positive integer (>= 1)",
		);
	}
	return value;
}

const LONG_TERM_TASK_STATUS_VALUES = new Set(["PENDING", "SENT", "CANCELLED"]);

/**
 * Validates an optional task status filter. Accepts `unknown`. Only
 * `undefined` means omitted.
 */
export function validateLongTermTaskStatusFilter(
	value: unknown,
): "PENDING" | "SENT" | "CANCELLED" | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !LONG_TERM_TASK_STATUS_VALUES.has(value)) {
		throw new LongTermError(
			"LONG_TERM_INVALID_INPUT",
			`Invalid task status filter: "${String(value)}"`,
		);
	}
	return value as "PENDING" | "SENT" | "CANCELLED";
}
