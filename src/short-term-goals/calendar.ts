import { parsePositiveMoneyString } from "../ledger/money";
import { ShortTermGoalError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validates and canonicalizes a UUID string to lowercase.
 */
export function validateCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}

	if (!UUID_PATTERN.test(trimmed)) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}

	return trimmed.toLowerCase();
}

/**
 * Validates a Gregorian calendar date string in YYYY-MM-DD format.
 * Rejects invalid leap years, out-of-range days/months, etc.
 * Returns the normalized YYYY-MM-DD string or null.
 */
export function validateGregorianDate(
	value: unknown,
	fieldName: string,
): string | null {
	if (value === null || value === undefined) {
		return null;
	}

	if (typeof value !== "string") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a string in YYYY-MM-DD format`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}

	const match = DATE_PATTERN.exec(trimmed);
	if (!match) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must match YYYY-MM-DD format: "${trimmed}"`,
		);
	}

	const yearStr = match[1];
	const monthStr = match[2];
	const dayStr = match[3];

	if (!yearStr || !monthStr || !dayStr) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must match YYYY-MM-DD format: "${trimmed}"`,
		);
	}

	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);

	if (year < 1900 || year > 2200) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} year must be between 1900 and 2200: "${trimmed}"`,
		);
	}

	if (month < 1 || month > 12) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} month must be between 01 and 12: "${trimmed}"`,
		);
	}

	// Days in month validation (accounting for leap years)
	const daysInMonth = [
		31,
		isLeapYear(year) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];

	const maxDays = daysInMonth[month - 1] ?? 31;
	if (day < 1 || day > maxDays) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} day is invalid for month ${month} and year ${year}: "${trimmed}"`,
		);
	}

	return trimmed;
}

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Validates an optional URL (must be http:// or https:// and length <= 2048).
 */
export function validateProductUrl(
	value: unknown,
	fieldName = "productUrl",
): string | null {
	if (value === null || value === undefined) {
		return null;
	}

	if (typeof value !== "string") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}

	if (trimmed.length > 2048) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} cannot exceed 2048 characters`,
		);
	}

	if (!/^https?:\/\//i.test(trimmed)) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must begin with http:// or https://: "${trimmed}"`,
		);
	}

	try {
		new URL(trimmed);
	} catch {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} is not a valid URL: "${trimmed}"`,
		);
	}

	return trimmed;
}

/**
 * Validates a required trimmed text field within length boundaries.
 */
export function validateRequiredTrimmedText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string {
	if (value === null || value === undefined) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} is required`,
		);
	}

	if (typeof value !== "string") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} cannot be empty or whitespace only`,
		);
	}

	if (trimmed.length > maxLength) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}

	return trimmed;
}

/**
 * Validates an optional trimmed text field within length boundaries.
 */
export function validateOptionalTrimmedText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string | null {
	if (value === null || value === undefined) {
		return null;
	}

	if (typeof value !== "string") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}

	if (trimmed.length > maxLength) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}

	return trimmed;
}

/**
 * Validates a trimmed text field within length boundaries (compatibility wrapper).
 */
export function validateTrimmedText(
	value: unknown,
	fieldName: string,
	maxLength: number,
	required = true,
): string | null {
	if (required) {
		return validateRequiredTrimmedText(value, fieldName, maxLength);
	}
	return validateOptionalTrimmedText(value, fieldName, maxLength);
}

/**
 * Validates an occurredAt Date object.
 */
export function validateOccurredAt(
	value: unknown,
	fieldName = "occurredAt",
): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a valid Date object`,
		);
	}
	return value;
}

/**
 * Validates a positive money string.
 */
export function validatePositiveMoneyString(
	value: unknown,
	fieldName: string,
): { normalized: string; cents: bigint } {
	try {
		return parsePositiveMoneyString(value);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName}: ${message}`,
		);
	}
}

/**
 * Validates an expectedRevisionNo for optimistic concurrency control.
 * Must be a safe positive integer (1, 2, 3...).
 */
export function validateExpectedRevisionNo(
	value: unknown,
	fieldName = "expectedRevisionNo",
): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a safe positive integer (>= 1)`,
		);
	}
	return value;
}

/**
 * Validates a 1-based priorityPosition for goal creation.
 * If omitted (undefined or null), returns activeCount + 1 (append).
 * If provided, must satisfy: 1 <= priorityPosition <= activeCount + 1.
 */
export function validatePriorityPosition(
	value: unknown,
	activeCount: number,
	fieldName = "priorityPosition",
): number {
	if (value === undefined || value === null) {
		return activeCount + 1;
	}

	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > activeCount + 1 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			`${fieldName} must be a 1-based integer between 1 and ${activeCount + 1}`,
		);
	}

	return value;
}
