import { IncomeError } from "./errors";

export const ISTANBUL_TIMEZONE = "Europe/Istanbul";

const DATE_FORMAT_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates whether a year is a leap year in the Gregorian calendar.
 */
function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the number of days in a given month for a specific year.
 */
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
 * Validates that an input string is a valid ISO calendar date (YYYY-MM-DD)
 * and conforms to actual calendar days (including leap years).
 * Throws IncomeError("INCOME_INVALID_INPUT", ...) if invalid.
 */
export function validateIsoCalendarDate(value: string): string {
	if (typeof value !== "string") {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Calendar date must be a string in YYYY-MM-DD format",
		);
	}

	const trimmed = value.trim();
	if (!DATE_FORMAT_REGEX.test(trimmed)) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid date format "${value}". Expected YYYY-MM-DD`,
		);
	}

	const [yearStr, monthStr, dayStr] = trimmed.split("-");
	const year = Number.parseInt(yearStr ?? "", 10);
	const month = Number.parseInt(monthStr ?? "", 10);
	const day = Number.parseInt(dayStr ?? "", 10);

	if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid date numbers in "${trimmed}"`,
		);
	}

	if (year < 1900 || year > 2100) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Year ${year} is outside supported range (1900-2100)`,
		);
	}

	if (month < 1 || month > 12) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Month ${month} is invalid. Expected 1-12`,
		);
	}

	const maxDays = getDaysInMonth(year, month);
	if (day < 1 || day > maxDays) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Day ${day} is invalid for year ${year} and month ${month}. Expected 1-${maxDays}`,
		);
	}

	return trimmed;
}

/**
 * Formats a Date object into a calendar date string (YYYY-MM-DD)
 * strictly in the Europe/Istanbul timezone.
 */
export function getIstanbulCalendarDate(date: Date): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: ISTANBUL_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	const parts = formatter.formatToParts(date);
	const year = parts.find((p) => p.type === "year")?.value ?? "1970";
	const month = parts.find((p) => p.type === "month")?.value ?? "01";
	const day = parts.find((p) => p.type === "day")?.value ?? "01";

	return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
