import { CampaignError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GREGORIAN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates and canonicalizes a UUID string to lowercase. Accepts `unknown`.
 */
export function validateCampaignCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Validates a required trimmed text field. Accepts `unknown`.
 */
export function validateCampaignRequiredText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string {
	if (typeof value !== "string") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (trimmed.length > maxLength) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
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
export function validateCampaignOptionalText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (trimmed.length > maxLength) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

/**
 * Validates a Gregorian calendar date string in strict YYYY-MM-DD form
 * (rejects invalid calendar dates like 2024-02-30, no timezone arithmetic --
 * campaign date windows and purchase dates are already plain local dates).
 */
export function validateCampaignGregorianDateString(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string" || !GREGORIAN_DATE_PATTERN.test(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be a valid date in YYYY-MM-DD format`,
		);
	}
	const [yStr, mStr, dStr] = value.split("-");
	const year = Number.parseInt(yStr ?? "", 10);
	const month = Number.parseInt(mStr ?? "", 10);
	const day = Number.parseInt(dStr ?? "", 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} is not a valid calendar date: "${value}"`,
		);
	}
	return value;
}

/**
 * Validates an occurredAt value. Accepts `unknown`.
 */
export function validateCampaignOccurredAt(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

/**
 * Validates an expectedRevisionNo for optimistic concurrency control.
 */
export function validateCampaignExpectedRevisionNo(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"expectedRevisionNo must be a safe positive integer (>= 1)",
		);
	}
	return value;
}

/**
 * Validates an idempotency key. Accepts `unknown`, requires a string, trims,
 * and checks length 1..128.
 */
export function validateCampaignIdempotencyKey(value: unknown): string {
	if (typeof value !== "string") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"idempotencyKey must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 128) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

const RULE_MODE_VALUES = new Set([
	"TOTAL_SPEND",
	"TRANSACTION_COUNT",
	"REPEATABLE_SPEND",
]);

export function validateCampaignRuleMode(
	value: unknown,
): "TOTAL_SPEND" | "TRANSACTION_COUNT" | "REPEATABLE_SPEND" {
	if (typeof value !== "string" || !RULE_MODE_VALUES.has(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			`Invalid ruleMode: "${String(value)}". Must be TOTAL_SPEND, TRANSACTION_COUNT, or REPEATABLE_SPEND`,
		);
	}
	return value as "TOTAL_SPEND" | "TRANSACTION_COUNT" | "REPEATABLE_SPEND";
}

const REWARD_KIND_VALUES = new Set([
	"REWARD_POINTS",
	"STATEMENT_CREDIT",
	"INFORMATIONAL",
]);

export function validateCampaignRewardKind(
	value: unknown,
): "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL" {
	if (typeof value !== "string" || !REWARD_KIND_VALUES.has(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid rewardKind: "${String(value)}". Must be REWARD_POINTS, STATEMENT_CREDIT, or INFORMATIONAL`,
		);
	}
	return value as "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL";
}

const MERCHANT_SCOPE_MODE_VALUES = new Set([
	"ALL_MERCHANTS",
	"MERCHANT_ALIASES",
	"MANUAL_REVIEW_REQUIRED",
]);

export function validateCampaignMerchantScopeMode(
	value: unknown,
): "ALL_MERCHANTS" | "MERCHANT_ALIASES" | "MANUAL_REVIEW_REQUIRED" {
	if (typeof value !== "string" || !MERCHANT_SCOPE_MODE_VALUES.has(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid merchantScopeMode: "${String(value)}". Must be ALL_MERCHANTS, MERCHANT_ALIASES, or MANUAL_REVIEW_REQUIRED`,
		);
	}
	return value as
		| "ALL_MERCHANTS"
		| "MERCHANT_ALIASES"
		| "MANUAL_REVIEW_REQUIRED";
}

const SOURCE_TYPE_VALUES = new Set([
	"MANUAL",
	"OFFICIAL_PUBLIC_PAGE",
	"IMPORT",
]);

export function validateCampaignSourceType(
	value: unknown,
): "MANUAL" | "OFFICIAL_PUBLIC_PAGE" | "IMPORT" {
	if (typeof value !== "string" || !SOURCE_TYPE_VALUES.has(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid sourceType: "${String(value)}". Must be MANUAL, OFFICIAL_PUBLIC_PAGE, or IMPORT`,
		);
	}
	return value as "MANUAL" | "OFFICIAL_PUBLIC_PAGE" | "IMPORT";
}

/**
 * Validates an optional HTTPS-only source URL. `undefined`/`null` mean
 * omitted (returns null). No arbitrary/authenticated URL fetching is ever
 * performed by this domain -- this only validates a stored reference string.
 */
export function validateCampaignSourceUrl(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"sourceUrl must be a string if supplied",
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (!trimmed.toLowerCase().startsWith("https://")) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"sourceUrl must be an HTTPS URL",
		);
	}
	if (trimmed.length > 2048) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"sourceUrl cannot exceed 2048 characters",
		);
	}
	return trimmed;
}

/**
 * Validates a positive integer within an inclusive range. Accepts `unknown`.
 */
export function validateCampaignPositiveIntegerRange(
	value: unknown,
	fieldName: string,
	min: number,
	max: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be an integer between ${min} and ${max}`,
		);
	}
	return value;
}

/**
 * Validates an array of non-empty trimmed strings (used for
 * requiredCanonicalMerchantNames and allowedMccCodes). Accepts `unknown`.
 */
export function validateCampaignStringArray(
	value: unknown,
	fieldName: string,
	maxItemLength: number,
	maxItems: number,
): string[] {
	if (!Array.isArray(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must be an array of strings`,
		);
	}
	if (value.length < 1 || value.length > maxItems) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName} must contain between 1 and ${maxItems} entries`,
		);
	}
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				`${fieldName} entries must be strings`,
			);
		}
		const trimmed = item.trim();
		if (trimmed === "" || trimmed.length > maxItemLength) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				`${fieldName} entries must be non-empty and at most ${maxItemLength} characters`,
			);
		}
		result.push(trimmed);
	}
	return result;
}

const OVERRIDE_OPERATION_VALUES = new Set(["INCLUDE", "EXCLUDE", "CLEAR"]);

export function validateCampaignOverrideOperation(
	value: unknown,
): "INCLUDE" | "EXCLUDE" | "CLEAR" {
	if (typeof value !== "string" || !OVERRIDE_OPERATION_VALUES.has(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid override operation: "${String(value)}". Must be INCLUDE, EXCLUDE, or CLEAR`,
		);
	}
	return value as "INCLUDE" | "EXCLUDE" | "CLEAR";
}

/**
 * Validates an optional lifecycle status filter. Accepts `unknown`. Only
 * `undefined` means omitted.
 */
export function validateCampaignLifecycleStatusFilter(
	value: unknown,
): "REVIEW_REQUIRED" | "ACTIVE" | "ENDED" | "CANCELLED" | undefined {
	if (value === undefined) return undefined;
	const values = new Set(["REVIEW_REQUIRED", "ACTIVE", "ENDED", "CANCELLED"]);
	if (typeof value !== "string" || !values.has(value)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid lifecycle status filter: "${String(value)}"`,
		);
	}
	return value as "REVIEW_REQUIRED" | "ACTIVE" | "ENDED" | "CANCELLED";
}

/**
 * Validates an optional visibility filter. Accepts `unknown`. Only
 * `undefined` means omitted.
 */
export function validateCampaignVisibilityFilter(
	value: unknown,
): "VISIBLE" | "HIDDEN" | undefined {
	if (value === undefined) return undefined;
	if (value !== "VISIBLE" && value !== "HIDDEN") {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid visibility filter: "${String(value)}"`,
		);
	}
	return value;
}
