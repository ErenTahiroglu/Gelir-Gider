import { describe, expect, it } from "vitest";
import {
	validateCanonicalUuid,
	validateExpectedRevisionNo,
	validateGregorianDate,
	validateOccurredAt,
	validatePositiveMoneyString,
	validatePriorityPosition,
	validateProductUrl,
	validateTrimmedText,
} from "../src/short-term-goals/calendar";
import {
	ShortTermGoalError,
	type ShortTermGoalErrorCode,
} from "../src/short-term-goals/errors";

describe("Short-Term Goal Service & Validation Unit Tests (DB-less)", () => {
	describe("UUID Validation", () => {
		it("accepts valid canonical UUIDs and normalizes to lowercase", () => {
			const valid = "019543EF-1111-7000-8000-000000000001";
			expect(validateCanonicalUuid(valid, "goalId")).toBe(
				"019543ef-1111-7000-8000-000000000001",
			);
		});

		it("rejects non-string and invalid UUID formats", () => {
			expect(() => validateCanonicalUuid(null, "goalId")).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateCanonicalUuid("", "goalId")).toThrowError(
				ShortTermGoalError,
			);
			expect(() =>
				validateCanonicalUuid("not-a-uuid-string", "goalId"),
			).toThrowError(ShortTermGoalError);
		});
	});

	describe("Optimistic Concurrency expectedRevisionNo Validation (Section 3)", () => {
		it("accepts safe positive integers (>= 1)", () => {
			expect(validateExpectedRevisionNo(1)).toBe(1);
			expect(validateExpectedRevisionNo(42)).toBe(42);
			expect(validateExpectedRevisionNo(1000)).toBe(1000);
		});

		it("rejects 0, negative numbers, floats, NaN, and non-numbers", () => {
			expect(() => validateExpectedRevisionNo(0)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateExpectedRevisionNo(-1)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateExpectedRevisionNo(1.5)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateExpectedRevisionNo(Number.NaN)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateExpectedRevisionNo("1")).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateExpectedRevisionNo(null)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateExpectedRevisionNo(undefined)).toThrowError(
				ShortTermGoalError,
			);
		});
	});

	describe("1-Based Priority Position Validation (Section 11, 12)", () => {
		it("appends to activeCount + 1 when priorityPosition is omitted", () => {
			expect(validatePriorityPosition(undefined, 3)).toBe(4);
			expect(validatePriorityPosition(null, 0)).toBe(1);
			expect(validatePriorityPosition(undefined, 0)).toBe(1);
		});

		it("accepts valid 1-based positions from 1 to activeCount + 1", () => {
			expect(validatePriorityPosition(1, 3)).toBe(1);
			expect(validatePriorityPosition(2, 3)).toBe(2);
			expect(validatePriorityPosition(3, 3)).toBe(3);
			expect(validatePriorityPosition(4, 3)).toBe(4);
		});

		it("rejects 0, negative numbers, non-integers, and out-of-range positions (activeCount + 2)", () => {
			expect(() => validatePriorityPosition(0, 3)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validatePriorityPosition(-1, 3)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validatePriorityPosition(5, 3)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validatePriorityPosition(1.5, 3)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validatePriorityPosition(Number.NaN, 3)).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validatePriorityPosition("1", 3)).toThrowError(
				ShortTermGoalError,
			);
		});
	});

	describe("Gregorian Calendar Validation", () => {
		it("accepts valid Gregorian calendar dates", () => {
			expect(validateGregorianDate("2026-09-04", "targetDate")).toBe(
				"2026-09-04",
			);
			expect(validateGregorianDate("2024-02-29", "targetDate")).toBe(
				"2024-02-29",
			); // Leap year
			expect(validateGregorianDate("2028-02-29", "targetDate")).toBe(
				"2028-02-29",
			); // Leap year
			expect(validateGregorianDate("2026-12-31", "targetDate")).toBe(
				"2026-12-31",
			);
			expect(validateGregorianDate(null, "targetDate")).toBeNull();
			expect(validateGregorianDate(undefined, "targetDate")).toBeNull();
			expect(validateGregorianDate("   ", "targetDate")).toBeNull();
		});

		it("rejects non-leap year Feb 29 and invalid days/months", () => {
			// 2026 is not a leap year
			expect(() =>
				validateGregorianDate("2026-02-29", "targetDate"),
			).toThrowError(ShortTermGoalError);

			// April has 30 days
			expect(() =>
				validateGregorianDate("2026-04-31", "targetDate"),
			).toThrowError(ShortTermGoalError);

			// Month 13
			expect(() =>
				validateGregorianDate("2026-13-01", "targetDate"),
			).toThrowError(ShortTermGoalError);

			// Month 00
			expect(() =>
				validateGregorianDate("2026-00-10", "targetDate"),
			).toThrowError(ShortTermGoalError);

			// Malformed string
			expect(() =>
				validateGregorianDate("2026-9-4", "targetDate"),
			).toThrowError(ShortTermGoalError);
			expect(() =>
				validateGregorianDate("invalid-date", "targetDate"),
			).toThrowError(ShortTermGoalError);
		});
	});

	describe("Product URL Validation", () => {
		it("accepts valid http and https URLs", () => {
			expect(validateProductUrl("https://example.com/item/123")).toBe(
				"https://example.com/item/123",
			);
			expect(validateProductUrl("http://store.local/test")).toBe(
				"http://store.local/test",
			);
			expect(validateProductUrl(null)).toBeNull();
			expect(validateProductUrl(undefined)).toBeNull();
			expect(validateProductUrl("")).toBeNull();
		});

		it("rejects non-http URLs and invalid syntax", () => {
			expect(() => validateProductUrl("ftp://example.com/item")).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateProductUrl("javascript:alert(1)")).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateProductUrl("not-a-url")).toThrowError(
				ShortTermGoalError,
			);
			expect(() =>
				validateProductUrl(`http://${"a".repeat(2050)}`),
			).toThrowError(ShortTermGoalError);
		});
	});

	describe("Trimmed Text & OccurredAt Validation", () => {
		it("validates and trims text fields within bounds", () => {
			expect(validateTrimmedText("  New Laptop  ", "name", 120, true)).toBe(
				"New Laptop",
			);
			expect(validateTrimmedText(null, "note", 500, false)).toBeNull();
			expect(() => validateTrimmedText("   ", "name", 120, true)).toThrowError(
				ShortTermGoalError,
			);
			expect(() =>
				validateTrimmedText("x".repeat(121), "name", 120, true),
			).toThrowError(ShortTermGoalError);
		});

		it("validates valid Date objects", () => {
			const valid = new Date("2026-09-04T12:00:00Z");
			expect(validateOccurredAt(valid)).toBe(valid);
			expect(() => validateOccurredAt(new Date("invalid"))).toThrowError(
				ShortTermGoalError,
			);
			expect(() => validateOccurredAt("2026-09-04")).toThrowError(
				ShortTermGoalError,
			);
		});
	});

	describe("Money Validation", () => {
		it("validates positive exact decimal money strings", () => {
			const res = validatePositiveMoneyString("35000.50", "fundingTarget");
			expect(res.normalized).toBe("35000.50");
			expect(res.cents).toBe(3500050n);
		});

		it("rejects zero, negative, or invalid format money", () => {
			expect(() =>
				validatePositiveMoneyString("0.00", "fundingTarget"),
			).toThrowError(ShortTermGoalError);
			expect(() =>
				validatePositiveMoneyString("-100.00", "fundingTarget"),
			).toThrowError(ShortTermGoalError);
			expect(() =>
				validatePositiveMoneyString("invalid", "fundingTarget"),
			).toThrowError(ShortTermGoalError);
		});
	});

	describe("ShortTermGoalError Error Code Coverage (Phase 9-R1)", () => {
		it("constructs ShortTermGoalError with code and message", () => {
			const codes: ShortTermGoalErrorCode[] = [
				"SHORT_TERM_GOAL_INVALID_INPUT",
				"SHORT_TERM_GOAL_NOT_FOUND",
				"SHORT_TERM_GOAL_NOT_ACTIVE",
				"SHORT_TERM_GOAL_NON_ZERO_BALANCE",
				"SHORT_TERM_GOAL_BALANCE_NOT_ZERO",
				"SHORT_TERM_GOAL_BUCKET_NOT_FOUND",
				"SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND",
				"SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED",
				"SHORT_TERM_GOAL_PRIORITY_COLLISION",
				"SHORT_TERM_GOAL_PRIORITY_MISMATCH",
				"SHORT_TERM_GOAL_PRIORITY_CONFLICT",
				"SHORT_TERM_GOAL_REVISION_CONFLICT",
				"SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE",
				"SHORT_TERM_GOAL_INSUFFICIENT_BALANCE",
				"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
				"SHORT_TERM_GOAL_INVALID_STATE",
			];

			for (const code of codes) {
				const err = new ShortTermGoalError(code, `Test message for ${code}`);
				expect(err.name).toBe("ShortTermGoalError");
				expect(err.code).toBe(code);
				expect(err.message).toBe(`Test message for ${code}`);
				expect(err instanceof Error).toBe(true);
				expect(err instanceof ShortTermGoalError).toBe(true);
			}
		});
	});
});
