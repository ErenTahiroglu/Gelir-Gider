import { parsePositiveMoneyString } from "../ledger/money";
import { MonthCloseError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERIOD_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * Validates and canonicalizes a UUID string to lowercase. Accepts `unknown`
 * -- never trusts the caller-declared TypeScript type -- and never calls
 * `.trim()` before confirming the value is a string.
 */
export function validateMonthCloseCanonicalUuid(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`${fieldName} must be a valid UUID string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`${fieldName} cannot be empty`,
		);
	}
	if (!UUID_PATTERN.test(trimmed)) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`${fieldName} must be a valid canonical UUID: "${trimmed}"`,
		);
	}
	return trimmed.toLowerCase();
}

/**
 * Validates the public periodMonth contract: exact format "YYYY-MM" (Section
 * 2 of the Phase 14 spec). Accepts `unknown`. Never calls `.trim()` before
 * confirming the value is a string.
 */
export function validateMonthClosePeriodMonth(value: unknown): string {
	if (typeof value !== "string") {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"periodMonth must be a string in YYYY-MM format",
		);
	}
	const trimmed = value.trim();
	const match = PERIOD_MONTH_PATTERN.exec(trimmed);
	if (!match) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`periodMonth must match YYYY-MM format: "${value}"`,
		);
	}
	const yearStr = match[1] as string;
	const monthStr = match[2] as string;
	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	if (year < 1900 || year > 2200) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`periodMonth year must be between 1900 and 2200: "${trimmed}"`,
		);
	}
	if (month < 1 || month > 12) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`periodMonth month must be between 01 and 12: "${trimmed}"`,
		);
	}
	return `${yearStr}-${monthStr}`;
}

/**
 * Converts a validated "YYYY-MM" periodMonth into the "YYYY-MM-01" date
 * string used by the underlying `date` columns (matching the existing
 * monthly_budget_plans.period_month storage convention).
 */
export function periodMonthToDateString(periodMonth: string): string {
	return `${periodMonth}-01`;
}

/**
 * Converts a stored "YYYY-MM-01" date string back into the public "YYYY-MM"
 * periodMonth contract.
 */
export function dateStringToPeriodMonth(dateString: string): string {
	return dateString.slice(0, 7);
}

/**
 * Returns the "YYYY-MM-01" date string for the calendar month immediately
 * following the given "YYYY-MM-01" periodMonth date string.
 */
export function nextPeriodMonthDateString(periodMonthDate: string): string {
	const match = /^(\d{4})-(\d{2})-01$/.exec(periodMonthDate);
	if (!match) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_STATE",
			`Invalid internal periodMonth date string: "${periodMonthDate}"`,
		);
	}
	const year = Number.parseInt(match[1] as string, 10);
	const month = Number.parseInt(match[2] as string, 10);
	if (month === 12) {
		return `${year + 1}-01-01`;
	}
	return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/**
 * Returns the [start, end) Date boundaries (converted to UTC instants) of a
 * calendar month in Europe/Istanbul local time, for a validated "YYYY-MM"
 * periodMonth. Europe/Istanbul has been a fixed UTC+03:00 offset with no DST
 * since 2016, matching the existing `getIstanbulDateAtMidnightUtc` helper
 * convention used by the income and budget domains.
 */
export function getMonthCloseIstanbulPeriodBoundaries(periodMonth: string): {
	start: Date;
	end: Date;
} {
	const startDateStr = periodMonthToDateString(periodMonth);
	const endDateStr = nextPeriodMonthDateString(startDateStr);
	return {
		start: new Date(`${startDateStr}T00:00:00+03:00`),
		end: new Date(`${endDateStr}T00:00:00+03:00`),
	};
}

/**
 * Returns true when the given periodMonth's Europe/Istanbul period has fully
 * ended as of `now` (i.e. `now` is at or after the period's end boundary).
 */
export function isMonthCloseperiodEnded(
	periodMonth: string,
	now: Date,
): boolean {
	const { end } = getMonthCloseIstanbulPeriodBoundaries(periodMonth);
	return now.getTime() >= end.getTime();
}

/**
 * Validates a positive money string (NUMERIC(18,2) contract).
 */
export function validateMonthClosePositiveMoney(
	value: unknown,
	fieldName: string,
): { normalized: string; cents: bigint } {
	try {
		return parsePositiveMoneyString(value);
	} catch (err) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Validates an occurredAt value. Accepts `unknown`.
 */
export function validateMonthCloseOccurredAt(value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

/**
 * Validates a month-close idempotency key. Accepts `unknown`, requires a
 * string, trims, and checks length 1..128.
 */
export function validateMonthCloseIdempotencyKey(value: unknown): string {
	if (typeof value !== "string") {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"idempotencyKey must be a string",
		);
	}
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > 128) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

/**
 * Validates a 64-hex-character fingerprint string supplied by the caller.
 */
export function validateMonthCloseFingerprint(
	value: unknown,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(trimmed)) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`${fieldName} must be a 64-character hex SHA-256 fingerprint`,
		);
	}
	return trimmed;
}

const MONTH_CLOSE_DECISION_VALUES = new Set(["FULL", "PARTIAL", "SKIP"]);

/**
 * Validates an optional user decision (FULL|PARTIAL|SKIP). Accepts
 * `unknown`. Only `undefined` means omitted (the MEDIUM_TERM_RESERVE / NONE
 * routes must not supply a decision).
 */
export function validateMonthCloseDecision(
	value: unknown,
): "FULL" | "PARTIAL" | "SKIP" | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !MONTH_CLOSE_DECISION_VALUES.has(value)) {
		throw new MonthCloseError(
			"MONTH_CLOSE_INVALID_INPUT",
			`decision must be one of FULL, PARTIAL, SKIP (or omitted): "${String(value)}"`,
		);
	}
	return value as "FULL" | "PARTIAL" | "SKIP";
}

/**
 * Validates an optional partialAmount. Accepts `unknown`. Only `undefined`
 * means omitted.
 */
export function validateMonthCloseOptionalPartialAmount(
	value: unknown,
): { normalized: string; cents: bigint } | undefined {
	if (value === undefined) return undefined;
	return validateMonthClosePositiveMoney(value, "partialAmount");
}

/**
 * Validates optional periodMonth range filter bounds for listing.
 */
export function validateMonthCloseOptionalPeriodMonth(
	value: unknown,
): string | undefined {
	if (value === undefined) return undefined;
	return validateMonthClosePeriodMonth(value);
}
