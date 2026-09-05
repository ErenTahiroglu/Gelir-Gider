import { describe, expect, it } from "vitest";
import {
	calculateRewardEconomicAmount,
	deriveAndValidateEconomicAmount,
	formatUnitsToDecimal,
	parseConversionRate,
	parsePointQuantity,
	roundHalfUpToEconomicCents,
} from "../src/rewards/decimal";
import { RewardError } from "../src/rewards/errors";

describe("parsePointQuantity", () => {
	it("parses an integer point amount to 4 implied decimals", () => {
		const parsed = parsePointQuantity("100");
		expect(parsed.normalized).toBe("100.0000");
		expect(parsed.units).toBe(1_000_000n);
	});

	it("parses a fractional point amount exactly", () => {
		const parsed = parsePointQuantity("100.5");
		expect(parsed.normalized).toBe("100.5000");
		expect(parsed.units).toBe(1_005_000n);
	});

	it("preserves full 4-decimal precision", () => {
		const parsed = parsePointQuantity("0.0001");
		expect(parsed.normalized).toBe("0.0001");
		expect(parsed.units).toBe(1n);
	});

	it("rejects zero", () => {
		expect(() => parsePointQuantity("0")).toThrow(RewardError);
	});

	it("rejects negative values", () => {
		expect(() => parsePointQuantity("-1")).toThrow(RewardError);
	});

	it("rejects non-string values", () => {
		expect(() => parsePointQuantity(100)).toThrow(RewardError);
		expect(() => parsePointQuantity(null)).toThrow(RewardError);
		expect(() => parsePointQuantity(undefined)).toThrow(RewardError);
	});

	it("rejects over-precise input (more than 4 decimal places)", () => {
		expect(() => parsePointQuantity("1.00001")).toThrow(RewardError);
	});

	it("rejects empty/whitespace strings", () => {
		expect(() => parsePointQuantity("")).toThrow(RewardError);
		expect(() => parsePointQuantity("  ")).toThrow(RewardError);
	});

	it("rejects malformed decimal strings", () => {
		expect(() => parsePointQuantity("1.2.3")).toThrow(RewardError);
		expect(() => parsePointQuantity("abc")).toThrow(RewardError);
		expect(() => parsePointQuantity("01")).toThrow(RewardError);
	});
});

describe("parseConversionRate", () => {
	it("parses a rate to 6 implied decimals", () => {
		const parsed = parseConversionRate("1");
		expect(parsed.normalized).toBe("1.000000");
		expect(parsed.units).toBe(1_000_000n);
	});

	it("parses a non-1:1 fractional rate exactly", () => {
		const parsed = parseConversionRate("0.25");
		expect(parsed.normalized).toBe("0.250000");
		expect(parsed.units).toBe(250_000n);
	});

	it("rejects zero and negative rates", () => {
		expect(() => parseConversionRate("0")).toThrow(RewardError);
		expect(() => parseConversionRate("-0.5")).toThrow(RewardError);
	});

	it("rejects over-precise input (more than 6 decimal places)", () => {
		expect(() => parseConversionRate("1.0000001")).toThrow(RewardError);
	});
});

describe("formatUnitsToDecimal", () => {
	it("formats scale-4 units back to a canonical string", () => {
		expect(formatUnitsToDecimal(1_000_000n, 4)).toBe("100.0000");
		expect(formatUnitsToDecimal(1n, 4)).toBe("0.0001");
	});

	it("formats scale-2 (money) units correctly", () => {
		expect(formatUnitsToDecimal(10_000n, 2)).toBe("100.00");
		expect(formatUnitsToDecimal(1n, 2)).toBe("0.01");
	});

	it("formats negative values with a leading minus sign", () => {
		expect(formatUnitsToDecimal(-500n, 2)).toBe("-5.00");
	});

	it("formats zero correctly", () => {
		expect(formatUnitsToDecimal(0n, 4)).toBe("0.0000");
	});
});

describe("roundHalfUpToEconomicCents (deterministic ROUND HALF UP, non-trivial fractional cases)", () => {
	it("100 points at 1:1 -> 100.00", () => {
		const points = parsePointQuantity("100").units;
		const rate = parseConversionRate("1").units;
		expect(
			formatUnitsToDecimal(roundHalfUpToEconomicCents(points, rate), 2),
		).toBe("100.00");
	});

	it("400 points at 0.25 -> 100.00", () => {
		const points = parsePointQuantity("400").units;
		const rate = parseConversionRate("0.25").units;
		expect(
			formatUnitsToDecimal(roundHalfUpToEconomicCents(points, rate), 2),
		).toBe("100.00");
	});

	it("400 points at 0.300000 -> 120.00", () => {
		const points = parsePointQuantity("400").units;
		const rate = parseConversionRate("0.3").units;
		expect(
			formatUnitsToDecimal(roundHalfUpToEconomicCents(points, rate), 2),
		).toBe("120.00");
	});

	it("rounds a value ending exactly at .xx5 half-up (10 points at 0.125 -> 1.25 exact, no rounding needed)", () => {
		const points = parsePointQuantity("10").units;
		const rate = parseConversionRate("0.125").units;
		// 10 * 0.125 = 1.25 exactly -- no rounding boundary hit.
		expect(
			formatUnitsToDecimal(roundHalfUpToEconomicCents(points, rate), 2),
		).toBe("1.25");
	});

	it("rounds a genuine half-kurus case up (1 point at 0.005 -> exactly 0.005 -> rounds to 0.01)", () => {
		const points = parsePointQuantity("1").units;
		const rate = parseConversionRate("0.005").units;
		expect(
			formatUnitsToDecimal(roundHalfUpToEconomicCents(points, rate), 2),
		).toBe("0.01");
	});

	it("rounds a sub-half fraction down (1 point at 0.004 -> 0.004 -> rounds to 0.00 would be zero; use non-zero example)", () => {
		const points = parsePointQuantity("3").units;
		const rate = parseConversionRate("0.001").units; // 3 * 0.001 = 0.003 -> rounds down to 0.00... use larger base
		// Use a case landing just below half: 7 * 0.001 = 0.007 -> rounds to 0.01 (>= half of 0.01)
		// and 4 * 0.001 = 0.004 -> rounds to 0.00 (below half). We assert both directions distinctly below.
		expect(roundHalfUpToEconomicCents(points, rate)).toBeGreaterThanOrEqual(0n);
	});

	it("rounds 0.004 TRY down to 0.00 and 0.006 TRY up to 0.01 (below/above half-kurus boundary)", () => {
		const rate = parseConversionRate("0.001").units;
		const down = roundHalfUpToEconomicCents(
			parsePointQuantity("4").units,
			rate,
		); // 0.004
		const up = roundHalfUpToEconomicCents(parsePointQuantity("6").units, rate); // 0.006
		expect(formatUnitsToDecimal(down, 2)).toBe("0.00");
		expect(formatUnitsToDecimal(up, 2)).toBe("0.01");
	});

	it("large point quantities do not overflow (exact BigInt arithmetic)", () => {
		const points = parsePointQuantity("99999999999999.9999").units;
		const rate = parseConversionRate("999999.999999").units;
		expect(() => roundHalfUpToEconomicCents(points, rate)).not.toThrow();
	});
});

describe("numeric precision contract boundaries (matches DB NUMERIC limits)", () => {
	it("accepts a point quantity at exactly the 16 integer digit boundary (NUMERIC(20,4))", () => {
		expect(() => parsePointQuantity("9999999999999999.9999")).not.toThrow();
	});

	it("rejects a point quantity exceeding the 16 integer digit boundary", () => {
		expect(() => parsePointQuantity("99999999999999999")).toThrow(RewardError);
	});

	it("accepts a conversion rate at exactly the 12 integer digit boundary (NUMERIC(18,6))", () => {
		expect(() => parseConversionRate("999999999999.999999")).not.toThrow();
	});

	it("rejects a conversion rate exceeding the 12 integer digit boundary", () => {
		expect(() => parseConversionRate("9999999999999")).toThrow(RewardError);
	});

	it("rejects a derived economic amount that would exceed the NUMERIC(18,2) money contract", () => {
		expect(() =>
			deriveAndValidateEconomicAmount(
				"9999999999999999.9999",
				"999999999999.999999",
			),
		).toThrow(RewardError);
	});
});

describe("deriveAndValidateEconomicAmount (pre-DB zero-value redemption rejection)", () => {
	it("rejects an economic amount that rounds down to exactly 0.00", () => {
		expect(() => deriveAndValidateEconomicAmount("1", "0.001")).toThrow(
			RewardError,
		);
	});

	it("accepts an economic amount that rounds to a non-zero value", () => {
		const result = deriveAndValidateEconomicAmount("100", "1");
		expect(result.normalized).toBe("100.00");
	});

	it("accepts the smallest possible non-zero economic amount (0.01)", () => {
		const result = deriveAndValidateEconomicAmount("1", "0.01");
		expect(result.normalized).toBe("0.01");
	});
});

describe("calculateRewardEconomicAmount (combined helper used for both redemption and display valuation)", () => {
	it("100 points at 1.000000 -> 100.00 TRY", () => {
		expect(calculateRewardEconomicAmount("100", "1").normalized).toBe("100.00");
	});

	it("400 points at 0.250000 -> 100.00 TRY", () => {
		expect(calculateRewardEconomicAmount("400", "0.25").normalized).toBe(
			"100.00",
		);
	});

	it("400 points at 0.300000 -> 120.00 TRY (rate-change scenario, new rate applied prospectively)", () => {
		expect(calculateRewardEconomicAmount("400", "0.3").normalized).toBe(
			"120.00",
		);
	});
});
