import { describe, expect, it } from "vitest";
import {
	formatCentsToCanonical,
	formatCentsToTry,
	formatMoneyToTry,
	parseMoneyToCents,
	sumMoneyStrings,
} from "../src/lib/money";

describe("Money Utility — Zero Float Arithmetic & Exact Cents Precision", () => {
	it("parses valid money strings to bigint cents", () => {
		expect(parseMoneyToCents("1000.00")).toBe(100000n);
		expect(parseMoneyToCents("14250.00")).toBe(1425000n);
		expect(parseMoneyToCents("0.00")).toBe(0n);
		expect(parseMoneyToCents("-25.50")).toBe(-2550n);
		expect(parseMoneyToCents("999999999999.99")).toBe(99999999999999n);
	});

	it("throws on invalid money strings", () => {
		expect(() => parseMoneyToCents("")).toThrow();
		expect(() => parseMoneyToCents("100")).toThrow();
		expect(() => parseMoneyToCents("100.5")).toThrow();
		expect(() => parseMoneyToCents("100.555")).toThrow();
		expect(() => parseMoneyToCents("abc")).toThrow();
		expect(() => parseMoneyToCents("1e5")).toThrow();
		expect(() => parseMoneyToCents(100 as unknown as string)).toThrow();
	});

	it("formats cents to canonical string", () => {
		expect(formatCentsToCanonical(100000n)).toBe("1000.00");
		expect(formatCentsToCanonical(1425000n)).toBe("14250.00");
		expect(formatCentsToCanonical(-2550n)).toBe("-25.50");
		expect(formatCentsToCanonical(0n)).toBe("0.00");
	});

	it("sums money strings using bigint cents without float drift", () => {
		const amounts = ["0.10", "0.20"];
		// In float: 0.10 + 0.20 = 0.30000000000000004
		expect(sumMoneyStrings(amounts)).toBe("0.30");

		const complexList = ["14250.00", "5750.50", "-25.50", "0.00"];
		expect(sumMoneyStrings(complexList)).toBe("19975.00");
	});

	it("formats Turkish Lira (₺) display with thousands grouping and decimals", () => {
		expect(formatCentsToTry(100000n)).toBe("₺1.000,00");
		expect(formatCentsToTry(1425000n)).toBe("₺14.250,00");
		expect(formatCentsToTry(0n)).toBe("₺0,00");
		expect(formatCentsToTry(-2550n)).toBe("-₺25,50");
		expect(formatMoneyToTry("14250.00")).toBe("₺14.250,00");
		expect(formatMoneyToTry("-25.50")).toBe("-₺25,50");
	});

	it("handles very large financial sums exactly", () => {
		const large1 = "9000000000.50";
		const large2 = "1000000000.50";
		expect(sumMoneyStrings([large1, large2])).toBe("10000000001.00");
		expect(formatMoneyToTry("10000000001.00")).toBe("₺10.000.000.001,00");
	});
});
