import { describe, expect, it } from "vitest";
import { normalizeTurkishMoneyInput } from "../src/lib/money";

describe("Money Input Normalization — Turkish Entry & Zero Floats", () => {
	it("normalizes integer strings correctly", () => {
		const res = normalizeTurkishMoneyInput("350");
		expect(res.valid).toBe(true);
		expect(res.canonical).toBe("350.00");
		expect(res.cents).toBe(35000n);
	});

	it("normalizes single decimal comma strings correctly", () => {
		const res = normalizeTurkishMoneyInput("350,5");
		expect(res.valid).toBe(true);
		expect(res.canonical).toBe("350.50");
		expect(res.cents).toBe(35050n);
	});

	it("normalizes two decimal comma strings correctly", () => {
		const res = normalizeTurkishMoneyInput("350,50");
		expect(res.valid).toBe(true);
		expect(res.canonical).toBe("350.50");
		expect(res.cents).toBe(35050n);
	});

	it("normalizes single decimal dot strings correctly", () => {
		const res = normalizeTurkishMoneyInput("350.5");
		expect(res.valid).toBe(true);
		expect(res.canonical).toBe("350.50");
		expect(res.cents).toBe(35050n);
	});

	it("normalizes thousands dots with comma decimal (e.g. 1.250,50)", () => {
		const res = normalizeTurkishMoneyInput("1.250,50");
		expect(res.valid).toBe(true);
		expect(res.canonical).toBe("1250.50");
		expect(res.cents).toBe(125050n);
	});

	it("rejects zero amount", () => {
		const res = normalizeTurkishMoneyInput("0");
		expect(res.valid).toBe(false);
	});

	it("rejects zero with decimals (0,00)", () => {
		const res = normalizeTurkishMoneyInput("0,00");
		expect(res.valid).toBe(false);
	});

	it("rejects negative amount", () => {
		const res = normalizeTurkishMoneyInput("-1");
		expect(res.valid).toBe(false);
		expect(res.error).toBe("Tutar negatif olamaz");
	});

	it("rejects invalid characters / letters", () => {
		const res = normalizeTurkishMoneyInput("abc");
		expect(res.valid).toBe(false);
	});

	it("rejects ambiguous / >2 decimals (1,234 or 1.234)", () => {
		const resComma = normalizeTurkishMoneyInput("1,234");
		expect(resComma.valid).toBe(false);

		const resDot = normalizeTurkishMoneyInput("1.234");
		expect(resDot.valid).toBe(false);
	});

	it("handles large exact values without floating point precision loss", () => {
		const res = normalizeTurkishMoneyInput("999999999,99");
		expect(res.valid).toBe(true);
		expect(res.canonical).toBe("999999999.99");
		expect(res.cents).toBe(99999999999n);
	});
});
