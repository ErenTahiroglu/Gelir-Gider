import { RewardError } from "./errors";

export interface ParsedExactDecimal {
	/** Fixed-scale canonical decimal string, e.g. "100.0000". */
	normalized: string;
	/** Exact integer value scaled by 10^scale (never a JS float). */
	units: bigint;
}

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Parses a strictly positive exact decimal string with at most `scale`
 * fractional digits and at most `maxIntegerDigits` integer digits (matching
 * the DB's NUMERIC(precision, scale) contract exactly, so an out-of-range
 * value is rejected here rather than reaching PostgreSQL and failing with a
 * raw numeric field overflow). Never uses JS floating point -- both the
 * validation and the resulting `units` value are computed via string/BigInt
 * arithmetic only. Rejects non-string values, empty/whitespace, negative,
 * zero, and over-precise input.
 */
function parseExactPositiveDecimal(
	value: unknown,
	scale: number,
	maxIntegerDigits: number,
	fieldName: string,
): ParsedExactDecimal {
	if (typeof value !== "string") {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be a string`,
		);
	}
	const trimmed = value.trim();
	if (trimmed === "" || !DECIMAL_PATTERN.test(trimmed)) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be a valid positive decimal string`,
		);
	}

	const [intPartRaw, fracPartRaw] = trimmed.split(".");
	const intPart = intPartRaw ?? "0";
	const frac = fracPartRaw ?? "";

	if (frac.length > scale) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must have at most ${scale} decimal places`,
		);
	}
	if (intPart.length > maxIntegerDigits) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must have at most ${maxIntegerDigits} integer digits`,
		);
	}

	const fracPadded = frac.padEnd(scale, "0");
	const units =
		BigInt(intPart) * 10n ** BigInt(scale) +
		(scale > 0 ? BigInt(fracPadded) : 0n);

	if (units <= 0n) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`${fieldName} must be strictly positive`,
		);
	}

	const normalized = scale === 0 ? intPart : `${intPart}.${fracPadded}`;
	return { normalized, units };
}

/**
 * Parses a strictly positive point quantity (NUMERIC(20,4) DB contract: 20
 * total digits, 16 integer digits).
 * Callers always supply a positive point quantity -- sign is derived only
 * from event type, never accepted from the caller.
 */
export function parsePointQuantity(
	value: unknown,
	fieldName = "pointAmount",
): ParsedExactDecimal {
	return parseExactPositiveDecimal(value, 4, 16, fieldName);
}

/**
 * Parses a strictly positive TRY-per-point conversion rate (NUMERIC(18,6)
 * DB contract: 18 total digits, 12 integer digits).
 */
export function parseConversionRate(
	value: unknown,
	fieldName = "conversionRate",
): ParsedExactDecimal {
	return parseExactPositiveDecimal(value, 6, 12, fieldName);
}

/**
 * Formats a BigInt scaled by 10^scale back into a fixed-scale decimal
 * string. Handles negative values (used for display-only diagnostics; all
 * stored point/rate quantities are themselves always positive).
 */
export function formatUnitsToDecimal(units: bigint, scale: number): string {
	const negative = units < 0n;
	const abs = negative ? -units : units;
	const digits = abs.toString().padStart(scale + 1, "0");
	const intPart = digits.slice(0, digits.length - scale) || "0";
	const fracPart = scale > 0 ? digits.slice(digits.length - scale) : "";
	return `${negative ? "-" : ""}${intPart}${scale > 0 ? `.${fracPart}` : ""}`;
}

/**
 * Derives the exact TRY economic value of `pointUnits` (scale 4) points at
 * `rateUnits` (scale 6) TRY-per-point, rounded HALF UP to 2 decimal places
 * (kuruş), returned as exact-cent BigInt. Never uses JS Number/float
 * arithmetic -- the product of two exact fixed-scale integers is itself
 * exact (implied scale 10), and rounding to scale 2 is done via integer
 * division + remainder comparison only. This is the SINGLE shared helper
 * used for both redemption economic value and estimated display valuation,
 * so both agree exactly.
 */
export function roundHalfUpToEconomicCents(
	pointUnits: bigint,
	rateUnits: bigint,
): bigint {
	if (pointUnits < 0n || rateUnits < 0n) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"pointUnits and rateUnits must be non-negative",
		);
	}
	const product = pointUnits * rateUnits; // implied scale 4 + 6 = 10
	const divisor = 100_000_000n; // 10^8: scale down from 10 to 2 decimals
	const quotient = product / divisor;
	const remainder = product % divisor;
	// ROUND HALF UP for a non-negative value: bump up when the remainder is
	// at least half of the divisor.
	if (remainder * 2n >= divisor) {
		return quotient + 1n;
	}
	return quotient;
}

/** NUMERIC(18,2) DB contract: 18 total digits, 16 integer digits. */
const MONEY_MAX_INTEGER_DIGITS = 16;

/**
 * Convenience wrapper: parses raw point/rate decimal strings and returns the
 * exact economic value as a money string (e.g. "100.00").
 */
export function calculateRewardEconomicAmount(
	pointAmount: string,
	conversionRate: string,
): { normalized: string; cents: bigint } {
	const points = parsePointQuantity(pointAmount);
	const rate = parseConversionRate(conversionRate);
	const cents = roundHalfUpToEconomicCents(points.units, rate.units);
	return { normalized: formatUnitsToDecimal(cents, 2), cents };
}

/**
 * Derives the authoritative redemption economic amount from raw point/rate
 * strings and enforces two pre-DB invariants that must never reach
 * PostgreSQL: (1) the derived money value must fit the NUMERIC(18,2)
 * contract (at most 16 integer digits), and (2) a REDEEM_PURCHASE is a real
 * economic posting -- a derived value that rounds to exactly 0.00 must be
 * rejected rather than attempting a zero-value ledger journal. Pure and
 * DB-independent, safe to call before `db.transaction(...)`.
 */
export function deriveAndValidateEconomicAmount(
	pointAmount: string,
	conversionRate: string,
): { normalized: string; cents: bigint } {
	const { normalized, cents } = calculateRewardEconomicAmount(
		pointAmount,
		conversionRate,
	);
	if (cents === 0n) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"Reward purchase economic value rounds to 0.00; a zero-value ledger journal is not permitted",
		);
	}
	const integerDigits = normalized.split(".")[0]?.replace("-", "").length ?? 0;
	if (integerDigits > MONEY_MAX_INTEGER_DIGITS) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			`economicAmount must have at most ${MONEY_MAX_INTEGER_DIGITS} integer digits`,
		);
	}
	return { normalized, cents };
}
