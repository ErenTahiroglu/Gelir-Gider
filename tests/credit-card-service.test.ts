import { describe, expect, it } from "vitest";
import {
	validateCalendarDay,
	validateCardCode,
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOptionalText,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validateLastFour,
	validateReservePlacement,
} from "../src/credit-cards/calendar";
import { CreditCardError } from "../src/credit-cards/errors";

describe("CreditCardError", () => {
	it("has correct name and code", () => {
		const err = new CreditCardError("CREDIT_CARD_NOT_FOUND", "not found");
		expect(err.name).toBe("CreditCardError");
		expect(err.code).toBe("CREDIT_CARD_NOT_FOUND");
		expect(err.message).toBe("not found");
		expect(err instanceof Error).toBe(true);
	});

	it("all required error codes exist as strings", () => {
		const codes = [
			"CREDIT_CARD_INVALID_INPUT",
			"CREDIT_CARD_NOT_FOUND",
			"CREDIT_CARD_NOT_ACTIVE",
			"CREDIT_CARD_CONFLICT",
			"CREDIT_CARD_REVISION_CONFLICT",
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			"CREDIT_CARD_STATEMENT_PERIOD_CONFLICT",
			"CREDIT_CARD_STATEMENT_NOT_OPEN",
			"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			"CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY",
			"CREDIT_CARD_RESERVE_CONFLICT",
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"CREDIT_CARD_INVALID_STATE",
		] as const;

		for (const code of codes) {
			const err = new CreditCardError(code, "test");
			expect(err.code).toBe(code);
		}
	});
});

describe("input validation edge cases", () => {
	it("validateCcCanonicalUuid rejects non-string", () => {
		expect(() => validateCcCanonicalUuid(123, "id")).toThrow(CreditCardError);
	});

	it("validateCcCanonicalUuid rejects invalid UUID", () => {
		expect(() => validateCcCanonicalUuid("not-a-uuid", "id")).toThrow(CreditCardError);
	});

	it("validateCcCanonicalUuid normalizes to lowercase", () => {
		const upper = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
		expect(validateCcCanonicalUuid(upper, "id")).toBe(upper.toLowerCase());
	});

	it("validateCardCode trims and uppercases", () => {
		expect(validateCardCode("  akbank  ")).toBe("AKBANK");
	});

	it("validateCcRequiredText trims input", () => {
		expect(validateCcRequiredText("  hello  ", "f", 100)).toBe("hello");
	});

	it("validateCcRequiredText throws on empty", () => {
		expect(() => validateCcRequiredText("   ", "f", 100)).toThrow(CreditCardError);
	});

	it("validateCcRequiredText throws on exceeding maxLength", () => {
		expect(() => validateCcRequiredText("a".repeat(201), "f", 200)).toThrow(CreditCardError);
	});

	it("validateCcOptionalText returns null for empty string", () => {
		expect(validateCcOptionalText("  ", "f", 100)).toBeNull();
	});

	it("validateCcOptionalText returns null for null", () => {
		expect(validateCcOptionalText(null, "f", 100)).toBeNull();
	});

	it("validateCcPositiveMoneyString rejects 0.00", () => {
		expect(() => validateCcPositiveMoneyString("0.00", "amount")).toThrow(CreditCardError);
	});

	it("validateCcPositiveMoneyString accepts 8000.00", () => {
		const r = validateCcPositiveMoneyString("8000.00", "amount");
		expect(r.normalized).toBe("8000.00");
		expect(r.cents).toBe(800000n);
	});

	it("validateCcPositiveMoneyString rejects decimal > 2 places", () => {
		expect(() => validateCcPositiveMoneyString("8000.001", "amount")).toThrow(CreditCardError);
	});

	it("validateCalendarDay accepts 1 and 31", () => {
		expect(validateCalendarDay(1, "d")).toBe(1);
		expect(validateCalendarDay(31, "d")).toBe(31);
	});

	it("validateCalendarDay rejects 0, 32, float", () => {
		expect(() => validateCalendarDay(0, "d")).toThrow(CreditCardError);
		expect(() => validateCalendarDay(32, "d")).toThrow(CreditCardError);
		expect(() => validateCalendarDay(1.5, "d")).toThrow(CreditCardError);
	});

	it("validateLastFour accepts null and 4-digit string", () => {
		expect(validateLastFour(null)).toBeNull();
		expect(validateLastFour("5678")).toBe("5678");
	});

	it("validateLastFour rejects non-digit 4-char string", () => {
		expect(() => validateLastFour("ABCD")).toThrow(CreditCardError);
	});

	it("validateLastFour rejects 3 and 5 digit strings", () => {
		expect(() => validateLastFour("123")).toThrow(CreditCardError);
		expect(() => validateLastFour("12345")).toThrow(CreditCardError);
	});

	it("validateReservePlacement accepts both placements", () => {
		expect(validateReservePlacement("MIDAS_FUND")).toBe("MIDAS_FUND");
		expect(validateReservePlacement("OUTSIDE_MIDAS")).toBe("OUTSIDE_MIDAS");
	});

	it("validateReservePlacement rejects invalid", () => {
		expect(() => validateReservePlacement("PARTIAL")).toThrow(CreditCardError);
		expect(() => validateReservePlacement(null)).toThrow(CreditCardError);
	});

	it("validateCcExpectedRevisionNo rejects 0, float, negative", () => {
		expect(() => validateCcExpectedRevisionNo(0)).toThrow(CreditCardError);
		expect(() => validateCcExpectedRevisionNo(1.5)).toThrow(CreditCardError);
		expect(() => validateCcExpectedRevisionNo(-5)).toThrow(CreditCardError);
	});
});
