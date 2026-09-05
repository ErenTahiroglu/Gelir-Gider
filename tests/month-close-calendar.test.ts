import { describe, expect, it } from "vitest";
import {
	dateStringToPeriodMonth,
	getMonthCloseIstanbulPeriodBoundaries,
	isMonthCloseperiodEnded,
	nextPeriodMonthDateString,
	periodMonthToDateString,
	validateMonthCloseCanonicalUuid,
	validateMonthCloseDecision,
	validateMonthCloseFingerprint,
	validateMonthCloseIdempotencyKey,
	validateMonthCloseOccurredAt,
	validateMonthCloseOptionalPartialAmount,
	validateMonthClosePeriodMonth,
	validateMonthClosePositiveMoney,
} from "../src/month-close/calendar";
import { MonthCloseError } from "../src/month-close/errors";

const VALID_USER_ID = "019543ef-1111-7000-8000-000000000001";
const VALID_FINGERPRINT = "a".repeat(64);

describe("Month Close Calendar & Public Input Boundary (Phase 14)", () => {
	describe("validateMonthClosePeriodMonth", () => {
		it("accepts a valid YYYY-MM string", () => {
			expect(validateMonthClosePeriodMonth("2026-01")).toBe("2026-01");
			expect(validateMonthClosePeriodMonth("2026-12")).toBe("2026-12");
		});

		it("rejects non-string input without calling .trim() first", () => {
			expect(() => validateMonthClosePeriodMonth(42 as unknown)).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthClosePeriodMonth(null as unknown)).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthClosePeriodMonth(undefined as unknown)).toThrow(
				MonthCloseError,
			);
		});

		it("rejects a full YYYY-MM-DD date (must be exactly YYYY-MM)", () => {
			expect(() => validateMonthClosePeriodMonth("2026-01-01")).toThrow(
				MonthCloseError,
			);
		});

		it("rejects an invalid month", () => {
			expect(() => validateMonthClosePeriodMonth("2026-13")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthClosePeriodMonth("2026-00")).toThrow(
				MonthCloseError,
			);
		});

		it("rejects an out-of-range year", () => {
			expect(() => validateMonthClosePeriodMonth("1899-01")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthClosePeriodMonth("2201-01")).toThrow(
				MonthCloseError,
			);
		});

		it("throws MONTH_CLOSE_INVALID_INPUT with a stable code", () => {
			try {
				validateMonthClosePeriodMonth("bad");
				throw new Error("expected throw");
			} catch (err) {
				expect(err).toBeInstanceOf(MonthCloseError);
				expect((err as MonthCloseError).code).toBe("MONTH_CLOSE_INVALID_INPUT");
			}
		});
	});

	describe("periodMonth <-> date string conversion", () => {
		it("converts YYYY-MM to YYYY-MM-01 and back", () => {
			expect(periodMonthToDateString("2026-03")).toBe("2026-03-01");
			expect(dateStringToPeriodMonth("2026-03-01")).toBe("2026-03");
		});

		it("computes the next calendar month, including year rollover", () => {
			expect(nextPeriodMonthDateString("2026-03-01")).toBe("2026-04-01");
			expect(nextPeriodMonthDateString("2026-12-01")).toBe("2027-01-01");
		});
	});

	describe("Europe/Istanbul period boundaries (fixed UTC+03:00, no DST since 2016)", () => {
		it("computes [start, end) as UTC instants offset by -03:00 from local midnight", () => {
			const { start, end } = getMonthCloseIstanbulPeriodBoundaries("2026-03");
			expect(start.toISOString()).toBe("2026-02-28T21:00:00.000Z");
			expect(end.toISOString()).toBe("2026-03-31T21:00:00.000Z");
		});

		it("handles a December -> January year rollover", () => {
			const { start, end } = getMonthCloseIstanbulPeriodBoundaries("2026-12");
			expect(start.toISOString()).toBe("2026-11-30T21:00:00.000Z");
			expect(end.toISOString()).toBe("2026-12-31T21:00:00.000Z");
		});

		it("handles February in a leap year", () => {
			const { start, end } = getMonthCloseIstanbulPeriodBoundaries("2028-02");
			expect(start.toISOString()).toBe("2028-01-31T21:00:00.000Z");
			expect(end.toISOString()).toBe("2028-02-29T21:00:00.000Z");
		});
	});

	describe("isMonthCloseperiodEnded", () => {
		it("returns false before the period end boundary", () => {
			const justBefore = new Date("2026-03-31T20:59:59.999Z");
			expect(isMonthCloseperiodEnded("2026-03", justBefore)).toBe(false);
		});

		it("returns true exactly at, and after, the period end boundary", () => {
			const exactly = new Date("2026-03-31T21:00:00.000Z");
			const after = new Date("2026-04-15T00:00:00.000Z");
			expect(isMonthCloseperiodEnded("2026-03", exactly)).toBe(true);
			expect(isMonthCloseperiodEnded("2026-03", after)).toBe(true);
		});
	});

	describe("validateMonthCloseCanonicalUuid", () => {
		it("lowercases and trims a valid UUID", () => {
			expect(
				validateMonthCloseCanonicalUuid(VALID_USER_ID.toUpperCase(), "userId"),
			).toBe(VALID_USER_ID);
		});

		it("rejects non-string and malformed input without pretrimming", () => {
			expect(() =>
				validateMonthCloseCanonicalUuid(1 as unknown, "userId"),
			).toThrow(MonthCloseError);
			expect(() =>
				validateMonthCloseCanonicalUuid("not-a-uuid", "userId"),
			).toThrow(MonthCloseError);
		});
	});

	describe("validateMonthCloseFingerprint", () => {
		it("accepts a 64-char lowercase hex string", () => {
			expect(validateMonthCloseFingerprint(VALID_FINGERPRINT, "x")).toBe(
				VALID_FINGERPRINT,
			);
		});

		it("rejects wrong-length or non-hex input", () => {
			expect(() => validateMonthCloseFingerprint("abc", "x")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseFingerprint("z".repeat(64), "x")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseFingerprint(123 as unknown, "x")).toThrow(
				MonthCloseError,
			);
		});
	});

	describe("validateMonthCloseDecision", () => {
		it("returns undefined only when omitted", () => {
			expect(validateMonthCloseDecision(undefined)).toBeUndefined();
		});

		it("accepts FULL, PARTIAL, SKIP", () => {
			expect(validateMonthCloseDecision("FULL")).toBe("FULL");
			expect(validateMonthCloseDecision("PARTIAL")).toBe("PARTIAL");
			expect(validateMonthCloseDecision("SKIP")).toBe("SKIP");
		});

		it("rejects null, unknown strings, and AUTO_MEDIUM/NO_ACTION (server-only)", () => {
			expect(() => validateMonthCloseDecision(null)).toThrow(MonthCloseError);
			expect(() => validateMonthCloseDecision("BOGUS")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseDecision("AUTO_MEDIUM")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseDecision("NO_ACTION")).toThrow(
				MonthCloseError,
			);
		});
	});

	describe("validateMonthCloseOptionalPartialAmount", () => {
		it("returns undefined only when omitted", () => {
			expect(
				validateMonthCloseOptionalPartialAmount(undefined),
			).toBeUndefined();
		});

		it("parses a valid positive money string", () => {
			expect(validateMonthCloseOptionalPartialAmount("250.00")?.cents).toBe(
				25000n,
			);
		});

		it("rejects zero, negative, and malformed amounts", () => {
			expect(() => validateMonthCloseOptionalPartialAmount("0.00")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseOptionalPartialAmount("-5.00")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseOptionalPartialAmount("abc")).toThrow(
				MonthCloseError,
			);
		});
	});

	describe("validateMonthClosePositiveMoney / validateMonthCloseOccurredAt / validateMonthCloseIdempotencyKey", () => {
		it("validates positive money strictly", () => {
			expect(validateMonthClosePositiveMoney("1.00", "x").cents).toBe(100n);
			expect(() => validateMonthClosePositiveMoney("0.00", "x")).toThrow(
				MonthCloseError,
			);
		});

		it("validates occurredAt as a real Date", () => {
			expect(
				validateMonthCloseOccurredAt(new Date("2026-01-01T00:00:00Z")),
			).toBeInstanceOf(Date);
			expect(() => validateMonthCloseOccurredAt("2026-01-01")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseOccurredAt(new Date(Number.NaN))).toThrow(
				MonthCloseError,
			);
		});

		it("validates idempotency key length bounds (1..128)", () => {
			expect(validateMonthCloseIdempotencyKey("k")).toBe("k");
			expect(() => validateMonthCloseIdempotencyKey("")).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseIdempotencyKey("x".repeat(129))).toThrow(
				MonthCloseError,
			);
			expect(() => validateMonthCloseIdempotencyKey(5 as unknown)).toThrow(
				MonthCloseError,
			);
		});
	});
});
