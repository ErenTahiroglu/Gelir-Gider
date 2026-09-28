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

export interface MoneyNormalizationResult {
	valid: boolean;
	canonical?: string;
	cents?: bigint;
	error?: string;
}

/**
 * Normalizes user-entered Turkish money input string into canonical backend format ("123.45").
 *
 * Rules:
 *   - Accepts "350", "350,5", "350,50", "350.5", "350.50".
 *   - Also handles thousands dots if entered like "1.250,50" or "14.250".
 *   - Rejects negative, zero, letters, NaN, >2 decimal places, ambiguous dots/commas.
 *   - NO JavaScript float arithmetic! String and BigInt only.
 */
export function normalizeTurkishMoneyInput(
	raw: string,
): MoneyNormalizationResult {
	if (typeof raw !== "string") {
		return { valid: false, error: "Tutar bir metin olmalıdır" };
	}

	let trimmed = raw.trim();
	if (trimmed === "") {
		return { valid: false, error: "Tutar boş olamaz" };
	}

	// Reject negative numbers
	if (trimmed.startsWith("-") || trimmed.includes("-")) {
		return { valid: false, error: "Tutar negatif olamaz" };
	}

	// Remove currency symbol if user typed/pasted ₺ or TL
	trimmed = trimmed
		.replace(/₺/g, "")
		.replace(/\bTL\b/gi, "")
		.trim();

	// Check for invalid characters (only digits, dots, commas allowed)
	if (!/^[0-9.,]+$/.test(trimmed)) {
		return { valid: false, error: "Geçersiz karakter içeriyor" };
	}

	// Determine separator:
	// If both comma and dot exist:
	//   Case 1: "1.250,50" -> dot is thousand separator, comma is decimal
	//   Case 2: "1,250.50" -> comma is thousand separator, dot is decimal
	let wholePartStr = "";
	let decimalPartStr = "";

	const hasComma = trimmed.includes(",");
	const hasDot = trimmed.includes(".");

	if (hasComma && hasDot) {
		const lastCommaIndex = trimmed.lastIndexOf(",");
		const lastDotIndex = trimmed.lastIndexOf(".");

		if (lastCommaIndex > lastDotIndex) {
			// e.g. "1.250,50" -> comma is decimal
			const parts = trimmed.split(",");
			const p0 = parts[0];
			const p1 = parts[1];
			if (parts.length > 2 || p0 === undefined || p1 === undefined) {
				return { valid: false, error: "Geçersiz sayı formatı" };
			}
			wholePartStr = p0.replace(/\./g, "");
			decimalPartStr = p1;
		} else {
			// e.g. "1,250.50" -> dot is decimal
			const parts = trimmed.split(".");
			const p0 = parts[0];
			const p1 = parts[1];
			if (parts.length > 2 || p0 === undefined || p1 === undefined) {
				return { valid: false, error: "Geçersiz sayı formatı" };
			}
			wholePartStr = p0.replace(/,/g, "");
			decimalPartStr = p1;
		}
	} else if (hasComma) {
		// Only comma exists
		const parts = trimmed.split(",");
		const p0 = parts[0];
		const p1 = parts[1];
		if (parts.length > 2 || p0 === undefined || p1 === undefined) {
			return { valid: false, error: "Birden fazla virgül içeremez" };
		}
		wholePartStr = p0;
		decimalPartStr = p1;
	} else if (hasDot) {
		// Only dot exists.
		const parts = trimmed.split(".");
		if (parts.length > 2) {
			// Multiple dots: e.g. 1.000.000 -> thousands separators
			wholePartStr = parts.join("");
			decimalPartStr = "";
		} else {
			const p0 = parts[0];
			const p1 = parts[1];
			if (p0 === undefined || p1 === undefined) {
				return { valid: false, error: "Geçersiz sayı formatı" };
			}
			if (p1.length > 2) {
				return {
					valid: false,
					error: "Kuruş hanesi en fazla 2 basamak olabilir",
				};
			}
			wholePartStr = p0;
			decimalPartStr = p1;
		}
	} else {
		// Integer only
		wholePartStr = trimmed;
		decimalPartStr = "";
	}

	// Validate decimal part length
	if (decimalPartStr.length > 2) {
		return {
			valid: false,
			error: "Kuruş hanesi en fazla 2 basamak olabilir",
		};
	}

	// Normalize whole part
	if (!/^\d+$/.test(wholePartStr)) {
		return { valid: false, error: "Geçersiz tam sayı kısmı" };
	}

	// Remove leading zeroes unless the whole part is just "0"
	const wholeBigInt = BigInt(wholePartStr);
	wholePartStr = wholeBigInt.toString();

	// Pad or truncate decimal part
	let fractionBigInt = 0n;
	if (decimalPartStr.length === 1) {
		decimalPartStr = `${decimalPartStr}0`;
		fractionBigInt = BigInt(decimalPartStr);
	} else if (decimalPartStr.length === 2) {
		fractionBigInt = BigInt(decimalPartStr);
	} else if (decimalPartStr.length === 0) {
		decimalPartStr = "00";
		fractionBigInt = 0n;
	}

	const totalCents = wholeBigInt * 100n + fractionBigInt;

	if (totalCents <= 0n) {
		return { valid: false, error: "Tutar sıfırdan büyük olmalıdır" };
	}

	const canonical = `${wholePartStr}.${decimalPartStr}`;
	return {
		valid: true,
		canonical,
		cents: totalCents,
	};
}
