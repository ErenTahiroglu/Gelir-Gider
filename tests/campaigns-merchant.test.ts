import { describe, expect, it } from "vitest";
import { CampaignError } from "../src/campaigns/errors";
import {
	normalizeMerchantAlias,
	validateMerchantAliasInput,
} from "../src/campaigns/merchant";

describe("normalizeMerchantAlias", () => {
	it("trims and lowercases", () => {
		expect(normalizeMerchantAlias("  MIGROS  ")).toBe("migros");
	});

	it("collapses repeated whitespace", () => {
		expect(normalizeMerchantAlias("Migros   Ticaret   A.S")).toBe(
			"migros ticaret a s",
		);
	});

	it("strips a narrow well-defined punctuation set", () => {
		expect(normalizeMerchantAlias("MIGROS*ISTANBUL")).toBe("migros istanbul");
		expect(normalizeMerchantAlias("CARREFOURSA/ONLINE")).toBe(
			"carrefoursa online",
		);
		expect(normalizeMerchantAlias("A101_MARKET")).toBe("a101 market");
	});

	it("two differently-formatted raw strings normalize identically", () => {
		const a = normalizeMerchantAlias("Migros* Istanbul");
		const b = normalizeMerchantAlias("  MIGROS  ISTANBUL  ");
		expect(a).toBe(b);
	});

	it("is deterministic (same input always produces same output)", () => {
		const raw = "Some-Merchant.Name #42";
		expect(normalizeMerchantAlias(raw)).toBe(normalizeMerchantAlias(raw));
	});
});

describe("validateMerchantAliasInput", () => {
	it("accepts a valid non-empty string", () => {
		expect(validateMerchantAliasInput("Migros", "rawAlias")).toBe("Migros");
	});

	it("rejects empty and over-long strings", () => {
		expect(() => validateMerchantAliasInput("   ", "rawAlias")).toThrow(
			CampaignError,
		);
		expect(() =>
			validateMerchantAliasInput("a".repeat(201), "rawAlias"),
		).toThrow(CampaignError);
	});

	it("rejects non-string input", () => {
		expect(() => validateMerchantAliasInput(42, "rawAlias")).toThrow(
			CampaignError,
		);
	});
});
