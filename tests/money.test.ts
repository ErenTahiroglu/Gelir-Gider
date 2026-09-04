import { describe, expect, it } from "vitest";
import {
	formatCentsToMoney,
	formatSignedCentsToMoney,
	parseAggregateMoneyString,
	parseMoneyString,
	parsePositiveMoneyString,
	parseSignedAggregateMoneyString,
} from "../src/ledger/money";

describe("Exact-Decimal Money Engine (Phase 4A & 4B-R1)", () => {
	describe("parseMoneyString & Normalization (Single-Line Contract)", () => {
		it("correctly parses and normalizes integer money strings", () => {
			expect(parseMoneyString("0")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseMoneyString("1")).toEqual({
				normalized: "1.00",
				cents: 100n,
			});
			expect(parseMoneyString("1250")).toEqual({
				normalized: "1250.00",
				cents: 125000n,
			});
		});

		it("correctly parses single decimal place strings and normalizes to 2 decimal places", () => {
			expect(parseMoneyString("0.0")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseMoneyString("1.2")).toEqual({
				normalized: "1.20",
				cents: 120n,
			});
			expect(parseMoneyString("1250.5")).toEqual({
				normalized: "1250.50",
				cents: 125050n,
			});
		});

		it("correctly parses standard 2 decimal place strings", () => {
			expect(parseMoneyString("0.00")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseMoneyString("1.23")).toEqual({
				normalized: "1.23",
				cents: 123n,
			});
			expect(parseMoneyString("1250.50")).toEqual({
				normalized: "1250.50",
				cents: 125050n,
			});
			expect(parseMoneyString("99.99")).toEqual({
				normalized: "99.99",
				cents: 9999n,
			});
		});

		it("handles maximum NUMERIC(18,2) value (16 integer digits + 2 decimals)", () => {
			const maxStr = "9999999999999999.99";
			const result = parseMoneyString(maxStr);
			expect(result.normalized).toBe("9999999999999999.99");
			expect(result.cents).toBe(999999999999999999n);
		});

		it("strictly rejects single-line amounts exceeding 16 integer digits (NUMERIC(18,2) overflow)", () => {
			expect(() => parseMoneyString("19999999999999999.98")).toThrow(
				"Invalid money string format",
			);
			expect(() => parseMoneyString("99999999999999999.00")).toThrow(
				"Invalid money string format",
			);
		});

		it("allows leading and trailing whitespace around valid money strings", () => {
			expect(parseMoneyString("  125.45  ")).toEqual({
				normalized: "125.45",
				cents: 12545n,
			});
		});

		it("exact BigInt arithmetic avoids floating-point inaccuracy (e.g. 0.10 + 0.20 === 0.30)", () => {
			const p1 = parseMoneyString("0.10");
			const p2 = parseMoneyString("0.20");
			const sumCents = p1.cents + p2.cents;
			expect(sumCents).toBe(30n);
			expect(formatCentsToMoney(sumCents)).toBe("0.30");
		});

		it("rejects leading zero ambiguous integers (e.g. '01', '001', '01.20')", () => {
			expect(() => parseMoneyString("01")).toThrow(
				"Invalid money string format",
			);
			expect(() => parseMoneyString("001")).toThrow(
				"Invalid money string format",
			);
			expect(() => parseMoneyString("01.20")).toThrow(
				"Invalid money string format",
			);
		});

		it("rejects non-string inputs", () => {
			expect(() => parseMoneyString(1.25 as unknown as string)).toThrow(
				"Money value must be a string",
			);
			expect(() => parseMoneyString(null as unknown as string)).toThrow(
				"Money value must be a string",
			);
			expect(() => parseMoneyString(undefined as unknown as string)).toThrow(
				"Money value must be a string",
			);
		});

		it("rejects invalid formats, negative amounts, plus signs, commas, and scientific notation", () => {
			const invalidValues = [
				"",
				"   ",
				".",
				".50",
				"1.",
				"+1.00",
				"-1.00",
				"-0.01",
				"1,00",
				"1,250.50",
				"1e2",
				"1E5",
				"Infinity",
				"-Infinity",
				"NaN",
				"abc",
				"1.234", // > 2 decimal places
				"0.001",
				"100.000",
			];

			for (const val of invalidValues) {
				expect(() => parseMoneyString(val)).toThrow();
			}
		});
	});

	describe("parsePositiveMoneyString", () => {
		it("accepts strictly positive money values", () => {
			expect(parsePositiveMoneyString("0.01")).toEqual({
				normalized: "0.01",
				cents: 1n,
			});
			expect(parsePositiveMoneyString("100.00")).toEqual({
				normalized: "100.00",
				cents: 10000n,
			});
		});

		it("rejects zero amounts", () => {
			expect(() => parsePositiveMoneyString("0")).toThrow(
				"Money value must be strictly positive",
			);
			expect(() => parsePositiveMoneyString("0.0")).toThrow(
				"Money value must be strictly positive",
			);
			expect(() => parsePositiveMoneyString("0.00")).toThrow(
				"Money value must be strictly positive",
			);
		});
	});

	describe("parseAggregateMoneyString (Unbounded Exact Aggregate Contract)", () => {
		it("parses multi-line aggregates exceeding 16 integer digits without precision loss", () => {
			const res1 = parseAggregateMoneyString("19999999999999999.98");
			expect(res1).toEqual({
				normalized: "19999999999999999.98",
				cents: 1999999999999999998n,
			});

			const veryLargeStr = "123456789012345678901234567890.12";
			const res2 = parseAggregateMoneyString(veryLargeStr);
			expect(res2).toEqual({
				normalized: "123456789012345678901234567890.12",
				cents: 12345678901234567890123456789012n,
			});

			const maxNumericAggregate = "999999999999999999999999999999999999.99";
			const res3 = parseAggregateMoneyString(maxNumericAggregate);
			expect(res3.normalized).toBe(maxNumericAggregate);
			expect(res3.cents).toBe(99999999999999999999999999999999999999n);
		});

		it("normalizes small and standard aggregate amounts correctly", () => {
			expect(parseAggregateMoneyString("0")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseAggregateMoneyString("0.0")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseAggregateMoneyString("0.00")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseAggregateMoneyString("1")).toEqual({
				normalized: "1.00",
				cents: 100n,
			});
			expect(parseAggregateMoneyString("1.2")).toEqual({
				normalized: "1.20",
				cents: 120n,
			});
			expect(parseAggregateMoneyString("1.23")).toEqual({
				normalized: "1.23",
				cents: 123n,
			});
		});

		it("rejects invalid aggregate inputs (negative, comma, scientific, > 2 decimals, leading zero)", () => {
			const invalid = [
				"",
				"   ",
				"-1.00",
				"+1.00",
				"1,00",
				"1e5",
				"NaN",
				"Infinity",
				".50",
				"1.",
				"1.234",
				"01",
				"001.50",
				123 as unknown as string,
				null as unknown as string,
			];

			for (const val of invalid) {
				expect(() => parseAggregateMoneyString(val)).toThrow();
			}
		});
	});

	describe("formatCentsToMoney", () => {
		it("formats BigInt cents to exact decimal string", () => {
			expect(formatCentsToMoney(0n)).toBe("0.00");
			expect(formatCentsToMoney(5n)).toBe("0.05");
			expect(formatCentsToMoney(50n)).toBe("0.50");
			expect(formatCentsToMoney(100n)).toBe("1.00");
			expect(formatCentsToMoney(123456n)).toBe("1234.56");
		});

		it("throws on negative cents", () => {
			expect(() => formatCentsToMoney(-1n)).toThrow(
				"Negative cents formatting",
			);
		});
	});

	describe("formatSignedCentsToMoney", () => {
		it("formats zero cents as '0.00' (never '-0.00')", () => {
			expect(formatSignedCentsToMoney(0n)).toBe("0.00");
			expect(formatSignedCentsToMoney(-0n)).toBe("0.00");
		});

		it("formats positive cents correctly", () => {
			expect(formatSignedCentsToMoney(1n)).toBe("0.01");
			expect(formatSignedCentsToMoney(50n)).toBe("0.50");
			expect(formatSignedCentsToMoney(100n)).toBe("1.00");
			expect(formatSignedCentsToMoney(123n)).toBe("1.23");
			expect(formatSignedCentsToMoney(125000n)).toBe("1250.00");
			expect(formatSignedCentsToMoney(1999999999999999998n)).toBe(
				"19999999999999999.98",
			);
		});

		it("formats negative cents with exact minus sign prefix", () => {
			expect(formatSignedCentsToMoney(-1n)).toBe("-0.01");
			expect(formatSignedCentsToMoney(-50n)).toBe("-0.50");
			expect(formatSignedCentsToMoney(-100n)).toBe("-1.00");
			expect(formatSignedCentsToMoney(-123n)).toBe("-1.23");
			expect(formatSignedCentsToMoney(-125000n)).toBe("-1250.00");
			expect(formatSignedCentsToMoney(-999999999999999999n)).toBe(
				"-9999999999999999.99",
			);
		});
	});

	describe("parseSignedAggregateMoneyString (Signed Aggregate Contract)", () => {
		it("correctly parses zero, positive, and negative amounts", () => {
			expect(parseSignedAggregateMoneyString("0")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseSignedAggregateMoneyString("-0")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseSignedAggregateMoneyString("0.00")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseSignedAggregateMoneyString("-0.00")).toEqual({
				normalized: "0.00",
				cents: 0n,
			});
			expect(parseSignedAggregateMoneyString("0.50")).toEqual({
				normalized: "0.50",
				cents: 50n,
			});
			expect(parseSignedAggregateMoneyString("-0.50")).toEqual({
				normalized: "-0.50",
				cents: -50n,
			});
			expect(parseSignedAggregateMoneyString("-0.01")).toEqual({
				normalized: "-0.01",
				cents: -1n,
			});
			expect(parseSignedAggregateMoneyString("-0.5")).toEqual({
				normalized: "-0.50",
				cents: -50n,
			});
			expect(parseSignedAggregateMoneyString("1250.50")).toEqual({
				normalized: "1250.50",
				cents: 125050n,
			});
			expect(parseSignedAggregateMoneyString("-1250.50")).toEqual({
				normalized: "-1250.50",
				cents: -125050n,
			});
			expect(parseSignedAggregateMoneyString("-1250")).toEqual({
				normalized: "-1250.00",
				cents: -125000n,
			});
		});

		it("correctly avoids BigInt('-0') truncation bug", () => {
			const parsedNegCents = parseSignedAggregateMoneyString("-0.50");
			expect(parsedNegCents.cents).toBe(-50n);
			expect(parsedNegCents.normalized).toBe("-0.50");

			const parsedNegPenny = parseSignedAggregateMoneyString("-0.01");
			expect(parsedNegPenny.cents).toBe(-1n);
			expect(parsedNegPenny.normalized).toBe("-0.01");
		});

		it("rejects invalid inputs", () => {
			const invalid = [
				"",
				"   ",
				"+1.00",
				"1,00",
				"1e5",
				"NaN",
				"Infinity",
				".50",
				"-.50",
				"1.",
				"-1.",
				"1.234",
				"-1.234",
				"01",
				"-01",
				null as unknown as string,
				undefined as unknown as string,
			];

			for (const val of invalid) {
				expect(() => parseSignedAggregateMoneyString(val)).toThrow();
			}
		});
	});
});
