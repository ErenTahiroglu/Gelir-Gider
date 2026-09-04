export interface ParsedMoney {
	normalized: string;
	cents: bigint;
}

// Unbounded exact unsigned decimal pattern:
// Accepts: "0", "0.0", "0.00", "1", "1.2", "1.23", "19999999999999999.98", etc.
// Rejects: leading zero ambiguous integers like "01", "001.50" (unless "0" or "0.xx"), negative, decimals > 2, commas, scientific notation.
const AGGREGATE_MONEY_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/**
 * Internal exact unsigned decimal parser.
 * Converts string money representations into exact normalized decimal string and BigInt integer cents.
 * Performs zero binary floating-point conversions.
 */
function parseExactUnsignedDecimal(
	value: unknown,
	maxIntegerDigits?: number,
): ParsedMoney {
	if (typeof value !== "string") {
		throw new Error("Money value must be a string");
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new Error("Money value cannot be empty");
	}

	if (!AGGREGATE_MONEY_PATTERN.test(trimmed)) {
		throw new Error(`Invalid money string format: "${trimmed}"`);
	}

	const parts = trimmed.split(".");
	const intPart = parts[0] ?? "0";
	let fracPart = parts[1] ?? "";

	if (maxIntegerDigits !== undefined && intPart.length > maxIntegerDigits) {
		throw new Error(`Invalid money string format: "${trimmed}"`);
	}

	if (fracPart.length === 0) {
		fracPart = "00";
	} else if (fracPart.length === 1) {
		fracPart = `${fracPart}0`;
	}

	const normalized = `${intPart}.${fracPart}`;
	const cents = BigInt(intPart) * 100n + BigInt(fracPart);

	return {
		normalized,
		cents,
	};
}

/**
 * Parses and validates a single journal line exact decimal money string without floating-point arithmetic.
 * Ensures compatibility with PostgreSQL NUMERIC(18,2) [max 16 integer digits + 2 decimals].
 *
 * Accepted examples: "0", "0.0", "0.00", "1", "1.2", "1.23", "1250.50"
 * Normalization: "1" -> "1.00", "1.2" -> "1.20", "1250.5" -> "1250.50"
 * Rejected: numbers, empty, leading-zero ambiguous ("01"), negative, commas, scientific notation, > 2 decimals, overflow (> 16 integer digits).
 */
export function parseMoneyString(value: unknown): ParsedMoney {
	return parseExactUnsignedDecimal(value, 16);
}

/**
 * Parses a single journal line money string and enforces that it represents a strictly positive amount (> 0.00).
 */
export function parsePositiveMoneyString(value: unknown): ParsedMoney {
	const parsed = parseMoneyString(value);
	if (parsed.cents <= 0n) {
		throw new Error("Money value must be strictly positive");
	}
	return parsed;
}

/**
 * Pattern for signed exact money strings resulting from PostgreSQL aggregations.
 * Supports optional leading minus sign, unbounded integer digits, and 0-2 decimal places.
 */
const SIGNED_AGGREGATE_MONEY_PATTERN = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/;

/**
 * Parses an exact signed decimal money string resulting from PostgreSQL aggregations (e.g. SUM(debit) - SUM(credit)).
 * Correctly preserves negative signs on sub-unit amounts (e.g. "-0.50" -> -50n cents).
 *
 * Accepted examples: "-0.50", "-0.01", "-1.00", "0", "0.00", "1.23", "19999999999999999.98"
 * Normalization: "-0.5" -> "-0.50", "-0.00" -> "0.00", "1" -> "1.00"
 */
export function parseSignedAggregateMoneyString(value: unknown): ParsedMoney {
	if (typeof value !== "string") {
		throw new Error("Money value must be a string");
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new Error("Money value cannot be empty");
	}

	if (!SIGNED_AGGREGATE_MONEY_PATTERN.test(trimmed)) {
		throw new Error(`Invalid money string format: "${trimmed}"`);
	}

	const isNegative = trimmed.startsWith("-");
	const clean = isNegative ? trimmed.slice(1) : trimmed;

	const parts = clean.split(".");
	const intPart = parts[0] ?? "0";
	let fracPart = parts[1] ?? "";

	if (fracPart.length === 0) {
		fracPart = "00";
	} else if (fracPart.length === 1) {
		fracPart = `${fracPart}0`;
	}

	const absCents = BigInt(intPart) * 100n + BigInt(fracPart);

	if (absCents === 0n) {
		return {
			normalized: "0.00",
			cents: 0n,
		};
	}

	const normalized = `${isNegative ? "-" : ""}${intPart}.${fracPart}`;
	const cents = isNegative ? -absCents : absCents;

	return {
		normalized,
		cents,
	};
}

/**
 * Parses an exact decimal money string resulting from PostgreSQL aggregations (e.g. SUM(debit), SUM(credit)).
 * Unlike single-line NUMERIC(18,2) parsing, this supports unbounded integer digits beyond 16 digits
 * using pure BigInt capacity without precision loss.
 *
 * Accepted examples: "0", "1.23", "19999999999999999.98", "123456789012345678901234567890.12"
 */
export function parseAggregateMoneyString(value: unknown): ParsedMoney {
	return parseExactUnsignedDecimal(value);
}

/**
 * Formats integer cents into an exact normalized decimal string.
 */
export function formatCentsToMoney(cents: bigint): string {
	if (cents < 0n) {
		throw new Error(
			"Negative cents formatting is not supported for ledger amounts",
		);
	}

	const intPart = cents / 100n;
	const frac = cents % 100n;
	const fracPart = frac < 10n ? `0${frac.toString()}` : frac.toString();

	return `${intPart.toString()}.${fracPart}`;
}

/**
 * Formats signed integer cents into an exact decimal string for balance queries.
 * Examples: 0n -> "0.00", 100n -> "1.00", -100n -> "-1.00", -1n -> "-0.01"
 */
export function formatSignedCentsToMoney(cents: bigint): string {
	if (cents === 0n) {
		return "0.00";
	}

	const isNegative = cents < 0n;
	const absCents = isNegative ? -cents : cents;
	const intPart = absCents / 100n;
	const frac = absCents % 100n;
	const fracPart = frac < 10n ? `0${frac.toString()}` : frac.toString();

	return `${isNegative ? "-" : ""}${intPart.toString()}.${fracPart}`;
}
