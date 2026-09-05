import { describe, expect, it } from "vitest";
import {
	validateLongTermCanonicalUuid,
	validateLongTermExpectedRevisionNo,
	validateLongTermIdempotencyKey,
	validateLongTermOccurredAt,
	validateLongTermOptionalText,
	validateLongTermPositiveMoney,
	validateLongTermTaskStatusFilter,
} from "../src/long-term/calendar";
import { LongTermError } from "../src/long-term/errors";

describe("validateLongTermCanonicalUuid", () => {
	it("accepts a valid UUID and lowercases it", () => {
		expect(
			validateLongTermCanonicalUuid(
				"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
				"id",
			),
		).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	});

	it("rejects non-string values (unknown, not trusting declared type)", () => {
		expect(() => validateLongTermCanonicalUuid(123, "id")).toThrow(
			LongTermError,
		);
		expect(() => validateLongTermCanonicalUuid(null, "id")).toThrow(
			LongTermError,
		);
		expect(() => validateLongTermCanonicalUuid(undefined, "id")).toThrow(
			LongTermError,
		);
	});

	it("rejects a malformed UUID", () => {
		expect(() => validateLongTermCanonicalUuid("not-a-uuid", "id")).toThrow(
			LongTermError,
		);
	});
});

describe("validateLongTermPositiveMoney", () => {
	it("accepts a valid positive decimal string", () => {
		expect(validateLongTermPositiveMoney("100.00", "amount").normalized).toBe(
			"100.00",
		);
	});

	it("rejects zero and negative amounts", () => {
		expect(() => validateLongTermPositiveMoney("0", "amount")).toThrow(
			LongTermError,
		);
		expect(() => validateLongTermPositiveMoney("-1", "amount")).toThrow(
			LongTermError,
		);
	});

	it("rejects non-string values", () => {
		expect(() => validateLongTermPositiveMoney(100, "amount")).toThrow(
			LongTermError,
		);
	});
});

describe("validateLongTermOptionalText", () => {
	it("treats only undefined/null as omitted", () => {
		expect(validateLongTermOptionalText(undefined, "note", 500)).toBeNull();
		expect(validateLongTermOptionalText(null, "note", 500)).toBeNull();
	});

	it("normalizes a whitespace-only string to null", () => {
		expect(validateLongTermOptionalText("   ", "note", 500)).toBeNull();
	});

	it("rejects a non-string value", () => {
		expect(() => validateLongTermOptionalText(123, "note", 500)).toThrow(
			LongTermError,
		);
	});

	it("rejects text exceeding the max length", () => {
		expect(() =>
			validateLongTermOptionalText("x".repeat(501), "note", 500),
		).toThrow(LongTermError);
	});
});

describe("validateLongTermOccurredAt", () => {
	it("accepts a valid Date", () => {
		const d = new Date();
		expect(validateLongTermOccurredAt(d)).toBe(d);
	});

	it("rejects non-Date values and invalid dates", () => {
		expect(() => validateLongTermOccurredAt("2026-01-01")).toThrow(
			LongTermError,
		);
		expect(() => validateLongTermOccurredAt(new Date(Number.NaN))).toThrow(
			LongTermError,
		);
	});
});

describe("validateLongTermIdempotencyKey", () => {
	it("accepts and trims a valid key", () => {
		expect(validateLongTermIdempotencyKey("  key-1  ")).toBe("key-1");
	});

	it("rejects a non-string value", () => {
		expect(() => validateLongTermIdempotencyKey(123)).toThrow(LongTermError);
	});

	it("rejects an empty or over-length key", () => {
		expect(() => validateLongTermIdempotencyKey("")).toThrow(LongTermError);
		expect(() => validateLongTermIdempotencyKey("x".repeat(129))).toThrow(
			LongTermError,
		);
	});
});

describe("validateLongTermExpectedRevisionNo", () => {
	it("accepts a safe positive integer", () => {
		expect(validateLongTermExpectedRevisionNo(1)).toBe(1);
	});

	it("rejects zero, negative, non-integer, and non-number values", () => {
		expect(() => validateLongTermExpectedRevisionNo(0)).toThrow(LongTermError);
		expect(() => validateLongTermExpectedRevisionNo(-1)).toThrow(LongTermError);
		expect(() => validateLongTermExpectedRevisionNo(1.5)).toThrow(
			LongTermError,
		);
		expect(() => validateLongTermExpectedRevisionNo("1")).toThrow(
			LongTermError,
		);
	});
});

describe("validateLongTermTaskStatusFilter", () => {
	it("only undefined means omitted", () => {
		expect(validateLongTermTaskStatusFilter(undefined)).toBeUndefined();
	});

	it("accepts exact status values", () => {
		expect(validateLongTermTaskStatusFilter("PENDING")).toBe("PENDING");
		expect(validateLongTermTaskStatusFilter("SENT")).toBe("SENT");
		expect(validateLongTermTaskStatusFilter("CANCELLED")).toBe("CANCELLED");
	});

	it("rejects null, empty string, and unknown values", () => {
		expect(() => validateLongTermTaskStatusFilter(null)).toThrow(LongTermError);
		expect(() => validateLongTermTaskStatusFilter("")).toThrow(LongTermError);
		expect(() => validateLongTermTaskStatusFilter("BOGUS")).toThrow(
			LongTermError,
		);
	});
});
