import { RewardError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Validates and canonicalizes a UUID string to lowercase. Accepts `unknown`
 * -- never trusts the caller-declared TypeScript type -- and never calls
 * `.trim()` before confirming the value is a string.
 */
export function validateRewardCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Validates and canonicalizes a reward account code.
 */
export function validateRewardAccountCode(value: unknown): string {
	if (typeof value !== "string") {
		throw new RewardError("REWARD_INVALID_INPUT", "code must be a string");
	}
	const trimmed = value.trim().toUpperCase();
	if (!CODE_PATTERN.test(trimmed)) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`code must match ^[A-Z][A-Z0-9_]{1,31}$: "${trimmed}"`,
		);
	}
	return trimmed;
}

/**
 * Validates a required trimmed text field. Accepts `unknown`.
 */
export function validateRewardRequiredText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string {
	if (value === null || value === undefined) {
		throw new RewardError("REWARD_INVALID_INPUT", `${fieldName} is required`);
	}
	if (typeof value !== "string") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (trimmed.length > maxLength) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

/**
 * Validates an optional trimmed text field. Accepts `unknown`. Only
 * `undefined`/`null` mean omitted; a whitespace-only string normalizes to
 * null.
 */
export function validateRewardOptionalText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (trimmed.length > maxLength) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

/**
 * Validates an occurredAt value. Accepts `unknown`.
 */
export function validateRewardOccurredAt(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

/**
 * Validates an expectedRevisionNo for optimistic concurrency control.
 * Accepts `unknown`.
 */
export function validateRewardExpectedRevisionNo(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"expectedRevisionNo must be a safe positive integer (>= 1)",
		);
	}
	return value;
}

/**
 * Validates a reward idempotency key. Accepts `unknown`, requires a string,
 * trims, and checks length 1..128. Never calls `.trim()` on an unverified
 * value.
 */
export function validateRewardIdempotencyKey(value: unknown): string {
	if (typeof value !== "string") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"idempotencyKey must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 128) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

const REWARD_PURCHASE_CATEGORY_VALUES = new Set([
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
	"UNCLASSIFIED",
]);

/**
 * Validates a reward purchase category. Accepts `unknown`.
 */
export function validateRewardPurchaseCategory(
	value: unknown,
):
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE"
	| "UNCLASSIFIED" {
	if (
		typeof value !== "string" ||
		!REWARD_PURCHASE_CATEGORY_VALUES.has(value)
	) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`Invalid purchaseCategory: "${String(value)}". Must be MANDATORY_EXPENSE, DISCRETIONARY_SPEND, SHORT_TERM_PURCHASE, or UNCLASSIFIED`,
		);
	}
	return value as
		| "MANDATORY_EXPENSE"
		| "DISCRETIONARY_SPEND"
		| "SHORT_TERM_PURCHASE"
		| "UNCLASSIFIED";
}

/**
 * Validates an optional reward account status filter. Accepts `unknown`.
 * Only `undefined` means omitted.
 */
export function validateRewardAccountStatusFilter(
	value: unknown,
): "ACTIVE" | "ARCHIVED" | undefined {
	if (value === undefined) return undefined;
	if (value !== "ACTIVE" && value !== "ARCHIVED") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`Invalid reward account status filter: "${String(value)}"`,
		);
	}
	return value;
}
