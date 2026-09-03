export interface ParsedMoney {
	normalized: string;
	cents: bigint;
}

// Maximum 16 integer digits and up to 2 decimal digits (NUMERIC(18,2))
// Regex accepts:
// "0", "0.0", "0.00"
// "1", "1.2", "1.23", "1250.50"
// Rejects leading zeros like "01", "001.50" (unless "0" or "0.xx")
const MONEY_PATTERN = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

/**
 * Parses and validates an exact decimal money string without floating-point arithmetic.
 * Ensures compatibility with PostgreSQL NUMERIC(18,2) [max 16 integer digits + 2 decimals].
 *
 * Accepted examples: "0", "0.0", "0.00", "1", "1.2", "1.23", "1250.50"
 * Normalization: "1" -> "1.00", "1.2" -> "1.20", "1250.5" -> "1250.50"
 * Rejected: numbers, empty, leading-zero ambiguous ("01"), negative, commas, scientific notation, > 2 decimals, overflow.
 */
export function parseMoneyString(value: unknown): ParsedMoney {
	if (typeof value !== "string") {
		throw new Error("Money value must be a string");
	}

	const trimmed = value.trim();
	if (trimmed === "") {
		throw new Error("Money value cannot be empty");
	}

	if (!MONEY_PATTERN.test(trimmed)) {
		throw new Error(`Invalid money string format: "${trimmed}"`);
	}

	const parts = trimmed.split(".");
	const intPart = parts[0] ?? "0";
	let fracPart = parts[1] ?? "";

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
 * Parses a money string and enforces that it represents a strictly positive amount (> 0.00).
 */
export function parsePositiveMoneyString(value: unknown): ParsedMoney {
	const parsed = parseMoneyString(value);
	if (parsed.cents <= 0n) {
		throw new Error("Money value must be strictly positive");
	}
	return parsed;
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
