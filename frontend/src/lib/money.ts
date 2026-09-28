/**
 * Exact Money Utility for Frontend -- Zero Floating Point Arithmetic
 *
 * Adheres strictly to Section 23 / 45:
 *   - Parses exact backend string formats (e.g. "14250.00", "-25.50") to bigint cents.
 *   - Aggregates balances strictly in bigint cents.
 *   - Formats Turkish Lira (₺) with thousands dots and comma decimal separator.
 */

const MONEY_STRING_REGEX = /^(-)?(?:0|[1-9]\d*)\.\d{2}$/;

export interface ParsedMoney {
	cents: bigint;
	isNegative: boolean;
	wholePart: bigint;
	decimalPart: number;
}

/**
 * Parses an exact money string (e.g. "14250.00", "-25.50") into bigint cents.
 * Throws an Error if the string is invalid or uses floats/scientific notation.
 */
export function parseMoneyToCents(amount: string): bigint {
	if (typeof amount !== "string") {
		throw new Error("Money amount must be a string");
	}

	const trimmed = amount.trim();
	if (!MONEY_STRING_REGEX.test(trimmed)) {
		throw new Error(
			`Invalid money string format: "${amount}". Expected format like "100.00" or "-25.50"`,
		);
	}

	const isNegative = trimmed.startsWith("-");
	const raw = isNegative ? trimmed.slice(1) : trimmed;
	const dotIndex = raw.indexOf(".");

	const wholeStr = raw.slice(0, dotIndex);
	const fractionStr = raw.slice(dotIndex + 1);

	const whole = BigInt(wholeStr);
	const fraction = BigInt(fractionStr);
	const totalCents = whole * 100n + fraction;

	return isNegative ? -totalCents : totalCents;
}

/**
 * Converts bigint cents back to canonical money string (e.g. 1425000n -> "14250.00", -2550n -> "-25.50").
 */
export function formatCentsToCanonical(cents: bigint): string {
	const isNegative = cents < 0n;
	const absCents = isNegative ? -cents : cents;

	const whole = absCents / 100n;
	const fraction = absCents % 100n;

	const wholeStr = whole.toString();
	const fractionStr = fraction.toString().padStart(2, "0");

	return `${isNegative ? "-" : ""}${wholeStr}.${fractionStr}`;
}

/**
 * Sums an array of money strings using bigint cents arithmetic.
 */
export function sumMoneyStrings(amounts: readonly string[]): string {
	let totalCents = 0n;
	for (const amt of amounts) {
		totalCents += parseMoneyToCents(amt);
	}
	return formatCentsToCanonical(totalCents);
}

/**
 * Formats bigint cents into Turkish Lira display format.
 * Examples:
 *   1425000n -> "₺14.250,00"
 *   100000n  -> "₺1.000,00"
 *   -2550n   -> "-₺25,50"
 *   0n       -> "₺0,00"
 */
export function formatCentsToTry(cents: bigint): string {
	const isNegative = cents < 0n;
	const absCents = isNegative ? -cents : cents;

	const whole = absCents / 100n;
	const fraction = absCents % 100n;

	const wholeStr = whole.toString();
	// Format with dots for thousands grouping
	const groupedWhole = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	const fractionStr = fraction.toString().padStart(2, "0");

	const signPrefix = isNegative ? "-" : "";
	return `${signPrefix}₺${groupedWhole},${fractionStr}`;
}

/**
 * Formats a money string (e.g. "14250.00") into Turkish Lira display format.
 */
export function formatMoneyToTry(amount: string): string {
	const cents = parseMoneyToCents(amount);
	return formatCentsToTry(cents);
}
