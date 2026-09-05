import { PeopleError } from "./errors";

const DATE_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInMonth(year: number, month: number): number {
	switch (month) {
		case 1:
		case 3:
		case 5:
		case 7:
		case 8:
		case 10:
		case 12:
			return 31;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		case 2:
			return isLeapYear(year) ? 29 : 28;
		default:
			return 0;
	}
}

/**
 * Validates that an input string is a valid ISO calendar date (YYYY-MM-DD).
 * Throws PeopleError("PEOPLE_INVALID_INPUT", ...) if invalid.
 */
export function validateIsoCalendarDate(value: string): string {
	if (typeof value !== "string") {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"Calendar date must be a string in YYYY-MM-DD format",
		);
	}

	const trimmed = value.trim();
	if (!DATE_FORMAT_REGEX.test(trimmed)) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid date format "${value}". Expected YYYY-MM-DD`,
		);
	}

	const [yearStr, monthStr, dayStr] = trimmed.split("-");
	const year = Number.parseInt(yearStr ?? "", 10);
	const month = Number.parseInt(monthStr ?? "", 10);
	const day = Number.parseInt(dayStr ?? "", 10);

	if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid date numbers in "${trimmed}"`,
		);
	}

	if (year < 1900 || year > 2100) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Year ${year} is outside supported range (1900-2100)`,
		);
	}

	if (month < 1 || month > 12) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Month ${month} is invalid. Expected 1-12`,
		);
	}

	const maxDays = getDaysInMonth(year, month);
	if (day < 1 || day > maxDays) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Day ${day} is invalid for year ${year} and month ${month}. Expected 1-${maxDays}`,
		);
	}

	return trimmed;
}

/**
 * Validates an optional ISO calendar date. Returns null for null/undefined input.
 */
export function validateOptionalIsoCalendarDate(
	value: string | null | undefined,
): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	return validateIsoCalendarDate(value);
}

/**
 * Validates that a value is a valid, non-NaN Date instance.
 */
export function validateOccurredAt(value: Date): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"Valid occurredAt Date is required",
		);
	}
	return value;
}

/**
 * Validates an optional date filter.
 * Only `undefined` means filter omitted (returns undefined).
 * If supplied, must be a string in strict YYYY-MM-DD format representing a valid Gregorian date.
 * Any other value (null, empty string, whitespace, non-string, invalid Gregorian date) throws PeopleError("PEOPLE_INVALID_INPUT", ...).
 */
export function validateOptionalDateFilter(
	value: string | undefined,
	fieldName: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`${fieldName} must be a string in YYYY-MM-DD format`,
		);
	}
	if (!DATE_FORMAT_REGEX.test(value)) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid date format for ${fieldName}: "${value}". Expected strict YYYY-MM-DD`,
		);
	}
	return validateIsoCalendarDate(value);
}
