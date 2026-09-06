import { describe, expect, it } from "vitest";
import {
	validateCampaignCanonicalUuid,
	validateCampaignExpectedRevisionNo,
	validateCampaignGregorianDateString,
	validateCampaignIdempotencyKey,
	validateCampaignLifecycleStatusFilter,
	validateCampaignMerchantScopeMode,
	validateCampaignOccurredAt,
	validateCampaignOptionalText,
	validateCampaignOverrideOperation,
	validateCampaignPositiveIntegerRange,
	validateCampaignRequiredText,
	validateCampaignRewardKind,
	validateCampaignRuleMode,
	validateCampaignSourceType,
	validateCampaignSourceUrl,
	validateCampaignStringArray,
	validateCampaignVisibilityFilter,
} from "../src/campaigns/calendar";
import { CampaignError } from "../src/campaigns/errors";

describe("validateCampaignCanonicalUuid", () => {
	it("accepts and lowercases a canonical UUID", () => {
		const uuid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
		expect(validateCampaignCanonicalUuid(uuid, "id")).toBe(uuid.toLowerCase());
	});

	it("rejects non-UUID strings and non-strings", () => {
		expect(() => validateCampaignCanonicalUuid("not-a-uuid", "id")).toThrow(
			CampaignError,
		);
		expect(() => validateCampaignCanonicalUuid(123, "id")).toThrow(
			CampaignError,
		);
		expect(() => validateCampaignCanonicalUuid(undefined, "id")).toThrow(
			CampaignError,
		);
	});
});

describe("validateCampaignGregorianDateString", () => {
	it("accepts a valid calendar date", () => {
		expect(validateCampaignGregorianDateString("2024-09-01", "startsOn")).toBe(
			"2024-09-01",
		);
	});

	it("rejects an invalid calendar date (e.g. Feb 30)", () => {
		expect(() =>
			validateCampaignGregorianDateString("2024-02-30", "startsOn"),
		).toThrow(CampaignError);
	});

	it("rejects malformed date strings", () => {
		expect(() =>
			validateCampaignGregorianDateString("09/01/2024", "startsOn"),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignGregorianDateString("2024-9-1", "startsOn"),
		).toThrow(CampaignError);
	});
});

describe("validateCampaignOccurredAt", () => {
	it("accepts a valid Date", () => {
		const d = new Date();
		expect(validateCampaignOccurredAt(d)).toBe(d);
	});

	it("rejects non-Date / invalid Date", () => {
		expect(() => validateCampaignOccurredAt("2024-01-01")).toThrow(
			CampaignError,
		);
		expect(() => validateCampaignOccurredAt(new Date("invalid"))).toThrow(
			CampaignError,
		);
	});
});

describe("validateCampaignExpectedRevisionNo", () => {
	it("accepts positive safe integers", () => {
		expect(validateCampaignExpectedRevisionNo(1)).toBe(1);
	});

	it("rejects zero, negative, non-integer", () => {
		expect(() => validateCampaignExpectedRevisionNo(0)).toThrow(CampaignError);
		expect(() => validateCampaignExpectedRevisionNo(-1)).toThrow(CampaignError);
		expect(() => validateCampaignExpectedRevisionNo(1.5)).toThrow(
			CampaignError,
		);
	});
});

describe("validateCampaignIdempotencyKey", () => {
	it("trims and accepts a valid key", () => {
		expect(validateCampaignIdempotencyKey("  key-1  ")).toBe("key-1");
	});

	it("rejects empty and over-long keys", () => {
		expect(() => validateCampaignIdempotencyKey("")).toThrow(CampaignError);
		expect(() => validateCampaignIdempotencyKey("a".repeat(129))).toThrow(
			CampaignError,
		);
	});
});

describe("validateCampaignRuleMode / RewardKind / MerchantScopeMode / SourceType", () => {
	it("accepts valid enum values", () => {
		expect(validateCampaignRuleMode("TOTAL_SPEND")).toBe("TOTAL_SPEND");
		expect(validateCampaignRewardKind("REWARD_POINTS")).toBe("REWARD_POINTS");
		expect(validateCampaignMerchantScopeMode("ALL_MERCHANTS")).toBe(
			"ALL_MERCHANTS",
		);
		expect(validateCampaignSourceType("MANUAL")).toBe("MANUAL");
	});

	it("rejects invalid enum values", () => {
		expect(() => validateCampaignRuleMode("BOGUS")).toThrow(CampaignError);
		expect(() => validateCampaignRewardKind("BOGUS")).toThrow(CampaignError);
		expect(() => validateCampaignMerchantScopeMode("BOGUS")).toThrow(
			CampaignError,
		);
		expect(() => validateCampaignSourceType("BOGUS")).toThrow(CampaignError);
	});
});

describe("validateCampaignSourceUrl", () => {
	it("accepts an https URL", () => {
		expect(validateCampaignSourceUrl("https://example.com/campaign")).toBe(
			"https://example.com/campaign",
		);
	});

	it("rejects non-https URLs", () => {
		expect(() => validateCampaignSourceUrl("http://example.com")).toThrow(
			CampaignError,
		);
		expect(() => validateCampaignSourceUrl("ftp://example.com/file")).toThrow(
			CampaignError,
		);
	});

	it("returns null when omitted", () => {
		expect(validateCampaignSourceUrl(undefined)).toBeNull();
		expect(validateCampaignSourceUrl(null)).toBeNull();
	});
});

describe("validateCampaignStringArray", () => {
	it("accepts a valid array of trimmed strings", () => {
		expect(
			validateCampaignStringArray(["Migros", "CarrefourSA"], "names", 200, 10),
		).toEqual(["Migros", "CarrefourSA"]);
	});

	it("rejects empty arrays and non-arrays", () => {
		expect(() => validateCampaignStringArray([], "names", 200, 10)).toThrow(
			CampaignError,
		);
		expect(() =>
			validateCampaignStringArray("Migros", "names", 200, 10),
		).toThrow(CampaignError);
	});

	it("rejects entries that are empty after trim", () => {
		expect(() =>
			validateCampaignStringArray(["   "], "names", 200, 10),
		).toThrow(CampaignError);
	});
});

describe("validateCampaignOverrideOperation", () => {
	it("accepts INCLUDE/EXCLUDE/CLEAR", () => {
		expect(validateCampaignOverrideOperation("INCLUDE")).toBe("INCLUDE");
		expect(validateCampaignOverrideOperation("EXCLUDE")).toBe("EXCLUDE");
		expect(validateCampaignOverrideOperation("CLEAR")).toBe("CLEAR");
	});

	it("rejects other values", () => {
		expect(() => validateCampaignOverrideOperation("MAYBE")).toThrow(
			CampaignError,
		);
	});
});

describe("filters default to undefined when omitted", () => {
	it("lifecycle status filter", () => {
		expect(validateCampaignLifecycleStatusFilter(undefined)).toBeUndefined();
		expect(validateCampaignLifecycleStatusFilter("ACTIVE")).toBe("ACTIVE");
		expect(() => validateCampaignLifecycleStatusFilter("BOGUS")).toThrow(
			CampaignError,
		);
	});

	it("visibility filter", () => {
		expect(validateCampaignVisibilityFilter(undefined)).toBeUndefined();
		expect(validateCampaignVisibilityFilter("HIDDEN")).toBe("HIDDEN");
	});
});

describe("validateCampaignRequiredText / validateCampaignOptionalText", () => {
	it("required text rejects empty", () => {
		expect(() => validateCampaignRequiredText("", "title", 200)).toThrow(
			CampaignError,
		);
		expect(validateCampaignRequiredText(" hi ", "title", 200)).toBe("hi");
	});

	it("optional text normalizes whitespace-only to null", () => {
		expect(validateCampaignOptionalText("   ", "note", 200)).toBeNull();
		expect(validateCampaignOptionalText(undefined, "note", 200)).toBeNull();
	});
});

describe("validateCampaignPositiveIntegerRange", () => {
	it("accepts within range", () => {
		expect(validateCampaignPositiveIntegerRange(5, "maxSteps", 1, 10)).toBe(5);
	});

	it("rejects out of range / non-integer", () => {
		expect(() =>
			validateCampaignPositiveIntegerRange(0, "maxSteps", 1, 10),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignPositiveIntegerRange(1.5, "maxSteps", 1, 10),
		).toThrow(CampaignError);
	});
});
