import { parsePositiveMoneyString } from "../ledger/money";
import { CreditCardError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const CYCLE_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * Returns true if the year is a Gregorian leap year.
 */
export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the exact number of days in a given Gregorian calendar month.
 */
export function getDaysInMonth(year: number, month: number): number {
	const table = [
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
	const days = table[month - 1];
	if (days === undefined)
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid month: ${month}`,
		);
	return days;
}

/**
 * Computes the canonical statement date for a cycle from card config.
 * Clamps statement day to the last day of the given month if necessary.
 * Returns YYYY-MM-DD string.
 */
export function computeStatementDate(
	cycleYear: number,
	cycleMonth: number,
	statementDay: number,
): string {
	const maxDay = getDaysInMonth(cycleYear, cycleMonth);
	const actualDay = Math.min(statementDay, maxDay);
	const mm = String(cycleMonth).padStart(2, "0");
	const dd = String(actualDay).padStart(2, "0");
	return `${cycleYear}-${mm}-${dd}`;
}

/**
 * Computes the due date which is the FIRST calendar date matching dueDay
 * that is STRICTLY AFTER the statement date.
 * Clamps to last day of month if necessary.
 * Returns YYYY-MM-DD string.
 */
export function computeDueDate(
	statementDateStr: string,
	dueDay: number,
): string {
	const parts = statementDateStr.split("-");
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid statementDate: ${statementDateStr}`,
		);
	}
	const stmtYear = Number.parseInt(parts[0], 10);
	const stmtMonth = Number.parseInt(parts[1], 10);

	// Try same month first
	const sameMontMaxDay = getDaysInMonth(stmtYear, stmtMonth);
	const sameMothDueDay = Math.min(dueDay, sameMontMaxDay);
	// Build YYYY-MM-DD for same month candidate
	const sameMm = String(stmtMonth).padStart(2, "0");
	const sameDd = String(sameMothDueDay).padStart(2, "0");
	const sameDateStr = `${stmtYear}-${sameMm}-${sameDd}`;

	if (sameDateStr > statementDateStr) {
		return sameDateStr;
	}

	// Otherwise use next month
	let nextYear = stmtYear;
	let nextMonth = stmtMonth + 1;
	if (nextMonth > 12) {
		nextMonth = 1;
		nextYear++;
	}
	const nextMonthMaxDay = getDaysInMonth(nextYear, nextMonth);
	const nextDueDay = Math.min(dueDay, nextMonthMaxDay);
	const nextMm = String(nextMonth).padStart(2, "0");
	const nextDd = String(nextDueDay).padStart(2, "0");
	return `${nextYear}-${nextMm}-${nextDd}`;
}

/**
 * Parses a YYYY-MM cycle month string into { year, month }.
 */
export function parseCycleMonth(cycleStr: string): {
	year: number;
	month: number;
} {
	const match = CYCLE_MONTH_PATTERN.exec(cycleStr.trim());
	if (!match?.[1] || !match[2]) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`cycleMonth must be in YYYY-MM format: "${cycleStr}"`,
		);
	}
	const year = Number.parseInt(match[1], 10);
	const month = Number.parseInt(match[2], 10);
	if (year < 2000 || year > 2200) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`cycleMonth year must be between 2000 and 2200: "${cycleStr}"`,
		);
	}
	if (month < 1 || month > 12) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`cycleMonth month must be between 01 and 12: "${cycleStr}"`,
		);
	}
	return { year, month };
}

/**
 * Validates and canonicalizes a UUID string to lowercase.
 */
export function validateCcCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Validates and canonicalizes a card code.
 */
export function validateCardCode(value: unknown): string {
	if (typeof value !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"code must be a string",
		);
	}
	const trimmed = value.trim().toUpperCase();
	if (!CARD_CODE_PATTERN.test(trimmed)) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`code must match ^[A-Z][A-Z0-9_]{1,31}$: "${trimmed}"`,
		);
	}
	return trimmed;
}

/**
 * Validates a required trimmed text field.
 */
export function validateCcRequiredText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string {
	if (value === null || value === undefined) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} is required`,
		);
	}
	if (typeof value !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (trimmed.length > maxLength) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

/**
 * Validates an optional trimmed text field.
 */
export function validateCcOptionalText(
	value: unknown,
	fieldName: string,
	maxLength: number,
): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (trimmed.length > maxLength) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} cannot exceed ${maxLength} characters`,
		);
	}
	return trimmed;
}

/**
 * Validates a calendar day integer (1-31).
 */
export function validateCalendarDay(value: unknown, fieldName: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 31
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be an integer between 1 and 31`,
		);
	}
	return value;
}

/**
 * Validates a positive money string for statement amount / credit limit.
 */
export function validateCcPositiveMoneyString(
	value: unknown,
	fieldName: string,
): { normalized: string; cents: bigint } {
	try {
		return parsePositiveMoneyString(value);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName}: ${message}`,
		);
	}
}

/**
 * Validates an optional "last four" string (exactly 4 digits).
 */
export function validateLastFour(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"lastFour must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (!/^[0-9]{4}$/.test(trimmed)) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`lastFour must be exactly 4 decimal digits: "${trimmed}"`,
		);
	}
	return trimmed;
}

/**
 * Validates an occurredAt Date object.
 */
export function validateCcOccurredAt(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

/**
 * Validates an expectedRevisionNo for optimistic concurrency control.
 */
export function validateCcExpectedRevisionNo(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			"expectedRevisionNo must be a safe positive integer (>= 1)",
		);
	}
	return value;
}

/**
 * Validates a reserve placement string.
 */
export function validateReservePlacement(
	value: unknown,
): "MIDAS_FUND" | "OUTSIDE_MIDAS" {
	if (value !== "MIDAS_FUND" && value !== "OUTSIDE_MIDAS") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`reservePlacement must be MIDAS_FUND or OUTSIDE_MIDAS, found: "${String(value)}"`,
		);
	}
	return value;
}

/**
 * Validates an optional card status filter.
 */
export function validateCardStatusFilter(
	value: unknown,
): "ACTIVE" | "ARCHIVED" | undefined {
	if (value === undefined || value === null) return undefined;
	if (value !== "ACTIVE" && value !== "ARCHIVED") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid card status filter: "${String(value)}"`,
		);
	}
	return value;
}

/**
 * Validates an optional statement status filter.
 */
export function validateStatementStatusFilter(
	value: unknown,
): "OPEN" | "VOID" | "PAID" | undefined {
	if (value === undefined || value === null) return undefined;
	if (value !== "OPEN" && value !== "VOID" && value !== "PAID") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid statement status filter: "${String(value)}"`,
		);
	}
	return value;
}

/**
 * Validates a credit card purchase category.
 */
export function validatePurchaseCategory(
	value: unknown,
):
	| "MANDATORY"
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE"
	| "UNCLASSIFIED" {
	if (
		value !== "MANDATORY" &&
		value !== "MANDATORY_EXPENSE" &&
		value !== "DISCRETIONARY" &&
		value !== "DISCRETIONARY_SPEND" &&
		value !== "SHORT_TERM_PURCHASE" &&
		value !== "UNCLASSIFIED"
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid purchaseCategory: "${String(value)}". Must be MANDATORY, MANDATORY_EXPENSE, DISCRETIONARY, DISCRETIONARY_SPEND, SHORT_TERM_PURCHASE, or UNCLASSIFIED`,
		);
	}
	return value;
}

/**
 * Validates a credit card statement payment method.
 */
export function validatePaymentMethod(
	value: unknown,
): "MIDAS_FUND" | "OUTSIDE_MIDAS" {
	if (value !== "MIDAS_FUND" && value !== "OUTSIDE_MIDAS") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid paymentMethod: "${String(value)}". Must be MIDAS_FUND or OUTSIDE_MIDAS`,
		);
	}
	return value;
}

/**
 * Validates an optional liability event status filter.
 */
export function validateLiabilityEventStatusFilter(
	value: unknown,
): "POSTED" | "VOID" {
	if (value !== "POSTED" && value !== "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid liability event status filter: "${String(value)}"`,
		);
	}
	return value;
}

/**
 * Formats a Date object as a YYYY-MM-DD string in the Europe/Istanbul time zone.
 */
export function formatIstanbulPurchaseDate(occurredAt: Date): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Istanbul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return formatter.format(occurredAt);
}

/**
 * Validates an installment count (1 to 60 or null/undefined).
 */
export function validateInstallmentCount(value: unknown): number | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 60
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Invalid installmentCount: "${String(value)}". Must be an integer between 1 and 60`,
		);
	}
	return value;
}

const GREGORIAN_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validates a Gregorian calendar date string in YYYY-MM-DD format.
 */
export function validateGregorianDateString(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string" || !GREGORIAN_DATE_PATTERN.test(value)) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a valid date in YYYY-MM-DD format`,
		);
	}
	const match = GREGORIAN_DATE_PATTERN.exec(value);
	if (!match) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a valid date in YYYY-MM-DD format`,
		);
	}
	const [_, yStr = "", mStr = "", dStr = ""] = match;
	const year = Number.parseInt(yStr, 10);
	const month = Number.parseInt(mStr, 10);
	const day = Number.parseInt(dStr, 10);

	if (month < 1 || month > 12) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} month must be between 01 and 12`,
		);
	}
	const maxDays = getDaysInMonth(year, month);
	if (day < 1 || day > maxDays) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} day must be between 01 and ${maxDays} for year ${year} and month ${month}`,
		);
	}
	return value;
}

/**
 * Validates an integer in a closed [min, max] range.
 */
export function validatePositiveIntegerRange(
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
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be an integer between ${min} and ${max}`,
		);
	}
	return value;
}

/**
 * Validates a pagination offset (safe integer >= 0).
 */
export function validateCcOffset(value: unknown, fieldName = "offset"): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		!Number.isSafeInteger(value)
	) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`${fieldName} must be a non-negative safe integer`,
		);
	}
	return value;
}
