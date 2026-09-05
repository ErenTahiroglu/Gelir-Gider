import { describe, expect, it } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import {
	compareAscii,
	deriveCreditCardSplitChildIdempotencyKey,
} from "../src/credit-cards/fingerprint";
import {
	validateParticipantDescription,
	validateParticipantDueDate,
	validateParticipantsInput,
	validateSplitStatusFilter,
} from "../src/credit-cards/splits";

const UUID_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_B = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("compareAscii", () => {
	it("orders strings by code point, not locale collation", () => {
		expect(compareAscii("a", "b")).toBeLessThan(0);
		expect(compareAscii("b", "a")).toBeGreaterThan(0);
		expect(compareAscii("a", "a")).toBe(0);
	});

	it("is stable for canonical UUID ordering", () => {
		const ids = [UUID_B, UUID_A].sort(compareAscii);
		expect(ids).toEqual([UUID_A, UUID_B]);
	});
});

describe("deriveCreditCardSplitChildIdempotencyKey", () => {
	it("produces a bounded (<=128 char) key even for a 128-character parent key", async () => {
		const parentKey = "K".repeat(128);
		const key = await deriveCreditCardSplitChildIdempotencyKey(
			parentKey,
			UUID_A,
			UUID_B,
			UUID_A,
			"PARTICIPANT_CREATE",
		);
		expect(key.length).toBeLessThanOrEqual(128);
		expect(key.startsWith("CC_SPLIT_CHILD_")).toBe(true);
	});

	it("is deterministic for identical inputs", async () => {
		const k1 = await deriveCreditCardSplitChildIdempotencyKey(
			"parent",
			UUID_A,
			UUID_B,
			UUID_A,
			"PARTICIPANT_UPDATE",
		);
		const k2 = await deriveCreditCardSplitChildIdempotencyKey(
			"parent",
			UUID_A,
			UUID_B,
			UUID_A,
			"PARTICIPANT_UPDATE",
		);
		expect(k1).toBe(k2);
	});

	it("differs by operation so CREATE/UPDATE/VOID never collide for the same participant", async () => {
		const create = await deriveCreditCardSplitChildIdempotencyKey(
			"parent",
			UUID_A,
			UUID_B,
			UUID_A,
			"PARTICIPANT_CREATE",
		);
		const update = await deriveCreditCardSplitChildIdempotencyKey(
			"parent",
			UUID_A,
			UUID_B,
			UUID_A,
			"PARTICIPANT_UPDATE",
		);
		const voidKey = await deriveCreditCardSplitChildIdempotencyKey(
			"parent",
			UUID_A,
			UUID_B,
			UUID_A,
			"PARTICIPANT_VOID",
		);
		expect(new Set([create, update, voidKey]).size).toBe(3);
	});
});

describe("validateParticipantDueDate", () => {
	it("returns null for undefined/null (omitted)", () => {
		expect(validateParticipantDueDate(undefined)).toBeNull();
		expect(validateParticipantDueDate(null)).toBeNull();
	});

	it("accepts a strict YYYY-MM-DD Gregorian date", () => {
		expect(validateParticipantDueDate("2026-09-05")).toBe("2026-09-05");
	});

	it("rejects empty string, whitespace, and non-zero-padded dates", () => {
		expect(() => validateParticipantDueDate("")).toThrow(CreditCardError);
		expect(() => validateParticipantDueDate(" ")).toThrow(CreditCardError);
		expect(() => validateParticipantDueDate("2026-2-3")).toThrow(
			CreditCardError,
		);
		expect(() => validateParticipantDueDate(" 2026-09-05 ")).toThrow(
			CreditCardError,
		);
	});

	it("rejects an invalid calendar date", () => {
		expect(() => validateParticipantDueDate("2026-02-30")).toThrow(
			CreditCardError,
		);
	});
});

describe("validateParticipantDescription", () => {
	it("returns null for undefined/null (omitted)", () => {
		expect(validateParticipantDescription(undefined)).toBeNull();
		expect(validateParticipantDescription(null)).toBeNull();
	});

	it("trims and normalizes whitespace-only to null", () => {
		expect(validateParticipantDescription("   ")).toBeNull();
		expect(validateParticipantDescription("  hello  ")).toBe("hello");
	});

	it("rejects a description longer than 500 characters", () => {
		expect(() => validateParticipantDescription("x".repeat(501))).toThrow(
			CreditCardError,
		);
	});

	it("accepts exactly 500 characters", () => {
		expect(validateParticipantDescription("x".repeat(500))).toBe(
			"x".repeat(500),
		);
	});
});

describe("validateParticipantsInput", () => {
	it("rejects a non-array value", () => {
		expect(() => validateParticipantsInput("not-an-array")).toThrow(
			CreditCardError,
		);
	});

	it("rejects zero participants", () => {
		expect(() => validateParticipantsInput([])).toThrow(CreditCardError);
	});

	it("rejects more than 9 participants", () => {
		const ten = Array.from({ length: 10 }, (_, i) => ({
			personId: UUID_A,
			description: `p${i}`,
		}));
		expect(() => validateParticipantsInput(ten)).toThrow(CreditCardError);
	});

	it("canonicalizes personId and normalizes dueDate/description for each entry", () => {
		const result = validateParticipantsInput([
			{
				personId: UUID_A.toUpperCase(),
				dueDate: "2026-09-05",
				description: "  note  ",
			},
		]);
		expect(result).toHaveLength(1);
		expect(result[0]?.personId).toBe(UUID_A);
		expect(result[0]?.dueDate).toBe("2026-09-05");
		expect(result[0]?.description).toBe("note");
	});

	it("rejects a malformed personId with CREDIT_CARD_INVALID_INPUT (no raw 22P02)", () => {
		try {
			validateParticipantsInput([{ personId: "not-a-uuid" }]);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(CreditCardError);
			expect((e as CreditCardError).code).toBe("CREDIT_CARD_INVALID_INPUT");
		}
	});

	it("rejects a non-object array entry", () => {
		expect(() => validateParticipantsInput([null])).toThrow(CreditCardError);
	});
});

describe("validateSplitStatusFilter", () => {
	it("returns undefined only when the value itself is undefined", () => {
		expect(validateSplitStatusFilter(undefined)).toBeUndefined();
	});

	it("accepts ACTIVE and VOID", () => {
		expect(validateSplitStatusFilter("ACTIVE")).toBe("ACTIVE");
		expect(validateSplitStatusFilter("VOID")).toBe("VOID");
	});

	it("rejects null, empty string, and unknown values (not silently omitted)", () => {
		expect(() => validateSplitStatusFilter(null)).toThrow(CreditCardError);
		expect(() => validateSplitStatusFilter("")).toThrow(CreditCardError);
		expect(() => validateSplitStatusFilter("BOGUS")).toThrow(CreditCardError);
	});
});
