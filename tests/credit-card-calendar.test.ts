import { describe, expect, it } from "vitest";
import {
	computeDueDate,
	computeStatementDate,
	getDaysInMonth,
	isLeapYear,
	parseCycleMonth,
	validateCalendarDay,
	validateCardCode,
	validateCardStatusFilter,
	validateCcExpectedRevisionNo,
	validateCcPositiveMoneyString,
	validateLastFour,
	validateReservePlacement,
	validateStatementStatusFilter,
} from "../src/credit-cards/calendar";
import { CreditCardError } from "../src/credit-cards/errors";

describe("isLeapYear", () => {
	it("returns true for 2000 (divisible by 400)", () =>
		expect(isLeapYear(2000)).toBe(true));
	it("returns false for 1900 (divisible by 100 not 400)", () =>
		expect(isLeapYear(1900)).toBe(false));
	it("returns true for 2024", () => expect(isLeapYear(2024)).toBe(true));
	it("returns true for 2028", () => expect(isLeapYear(2028)).toBe(true));
	it("returns false for 2027", () => expect(isLeapYear(2027)).toBe(false));
	it("returns false for 2100", () => expect(isLeapYear(2100)).toBe(false));
});

describe("getDaysInMonth", () => {
	it("January has 31 days", () => expect(getDaysInMonth(2026, 1)).toBe(31));
	it("February 2027 has 28 days", () =>
		expect(getDaysInMonth(2027, 2)).toBe(28));
	it("February 2028 has 29 days (leap)", () =>
		expect(getDaysInMonth(2028, 2)).toBe(29));
	it("April has 30 days", () => expect(getDaysInMonth(2026, 4)).toBe(30));
	it("December has 31 days", () => expect(getDaysInMonth(2026, 12)).toBe(31));
});

describe("computeStatementDate", () => {
	it("day 31, January 2026 -> 2026-01-31", () =>
		expect(computeStatementDate(2026, 1, 31)).toBe("2026-01-31"));
	it("day 31, February 2027 -> 2027-02-28", () =>
		expect(computeStatementDate(2027, 2, 31)).toBe("2027-02-28"));
	it("day 31, February 2028 (leap) -> 2028-02-29", () =>
		expect(computeStatementDate(2028, 2, 31)).toBe("2028-02-29"));
	it("day 31, April -> April 30", () =>
		expect(computeStatementDate(2026, 4, 31)).toBe("2026-04-30"));
	it("day 2, September 2026 -> 2026-09-02 (AKBANK)", () =>
		expect(computeStatementDate(2026, 9, 2)).toBe("2026-09-02"));
	it("day 15, September 2026 -> 2026-09-15", () =>
		expect(computeStatementDate(2026, 9, 15)).toBe("2026-09-15"));
	it("day 1, September 2026 -> 2026-09-01", () =>
		expect(computeStatementDate(2026, 9, 1)).toBe("2026-09-01"));
});

describe("computeDueDate", () => {
	it("statement 2026-09-01, dueDay 11 -> 2026-09-11", () =>
		expect(computeDueDate("2026-09-01", 11)).toBe("2026-09-11"));
	it("statement 2026-09-02, dueDay 12 -> 2026-09-12 (AKBANK)", () =>
		expect(computeDueDate("2026-09-02", 12)).toBe("2026-09-12"));
	it("statement 2026-09-15, dueDay 25 -> 2026-09-25", () =>
		expect(computeDueDate("2026-09-15", 25)).toBe("2026-09-25"));
	it("statement 2026-09-25, dueDay 15 -> 2026-10-15 (wraps to next month)", () =>
		expect(computeDueDate("2026-09-25", 15)).toBe("2026-10-15"));
	it("statement 2026-01-31, dueDay 31 -> 2026-02-28", () =>
		expect(computeDueDate("2026-01-31", 31)).toBe("2026-02-28"));
	it("statement 2028-01-31, dueDay 31 -> 2028-02-29 (leap year)", () =>
		expect(computeDueDate("2028-01-31", 31)).toBe("2028-02-29"));
	it("dueDate must be strictly after statementDate (same month wrap)", () => {
		// statementDay=30, dueDay=30 -> next month day 30
		expect(computeDueDate("2026-09-30", 30)).toBe("2026-10-30");
	});
	it("December wrap -> January next year", () =>
		expect(computeDueDate("2026-12-25", 5)).toBe("2027-01-05"));
});

describe("parseCycleMonth", () => {
	it("parses valid YYYY-MM", () => {
		const r = parseCycleMonth("2026-09");
		expect(r.year).toBe(2026);
		expect(r.month).toBe(9);
	});
	it("rejects invalid format", () => {
		expect(() => parseCycleMonth("09-2026")).toThrow(CreditCardError);
	});
	it("rejects month 13", () => {
		expect(() => parseCycleMonth("2026-13")).toThrow(CreditCardError);
	});
});

describe("validateCardCode", () => {
	it("accepts AKBANK", () => expect(validateCardCode("AKBANK")).toBe("AKBANK"));
	it("accepts TOM_HADI", () =>
		expect(validateCardCode("TOM_HADI")).toBe("TOM_HADI"));
	it("accepts YAPI_KREDI", () =>
		expect(validateCardCode("YAPI_KREDI")).toBe("YAPI_KREDI"));
	it("auto-uppercases lowercase", () =>
		expect(validateCardCode("akbank")).toBe("AKBANK"));
	it("rejects starting with digit", () =>
		expect(() => validateCardCode("1CARD")).toThrow(CreditCardError));
	it("rejects too short (1 char)", () =>
		expect(() => validateCardCode("A")).toThrow(CreditCardError));
	it("rejects spaces", () =>
		expect(() => validateCardCode("MY CARD")).toThrow(CreditCardError));
	it("rejects special chars other than _", () =>
		expect(() => validateCardCode("MY-CARD")).toThrow(CreditCardError));
});

describe("validateCalendarDay", () => {
	it("accepts 1", () => expect(validateCalendarDay(1, "d")).toBe(1));
	it("accepts 31", () => expect(validateCalendarDay(31, "d")).toBe(31));
	it("rejects 0", () =>
		expect(() => validateCalendarDay(0, "d")).toThrow(CreditCardError));
	it("rejects 32", () =>
		expect(() => validateCalendarDay(32, "d")).toThrow(CreditCardError));
	it("rejects float 2.5", () =>
		expect(() => validateCalendarDay(2.5, "d")).toThrow(CreditCardError));
});

describe("validateLastFour", () => {
	it("accepts 4 digits", () => expect(validateLastFour("1234")).toBe("1234"));
	it("returns null for null", () => expect(validateLastFour(null)).toBeNull());
	it("rejects 3 digits", () =>
		expect(() => validateLastFour("123")).toThrow(CreditCardError));
	it("rejects 5 digits", () =>
		expect(() => validateLastFour("12345")).toThrow(CreditCardError));
	it("rejects letters", () =>
		expect(() => validateLastFour("ABCD")).toThrow(CreditCardError));
});

describe("validateReservePlacement", () => {
	it("accepts MIDAS_FUND", () =>
		expect(validateReservePlacement("MIDAS_FUND")).toBe("MIDAS_FUND"));
	it("accepts OUTSIDE_MIDAS", () =>
		expect(validateReservePlacement("OUTSIDE_MIDAS")).toBe("OUTSIDE_MIDAS"));
	it("rejects UNKNOWN", () =>
		expect(() => validateReservePlacement("UNKNOWN")).toThrow(CreditCardError));
});

describe("validateCcExpectedRevisionNo", () => {
	it("accepts 1", () => expect(validateCcExpectedRevisionNo(1)).toBe(1));
	it("accepts large safe integer", () =>
		expect(validateCcExpectedRevisionNo(1000000)).toBe(1000000));
	it("rejects 0", () =>
		expect(() => validateCcExpectedRevisionNo(0)).toThrow(CreditCardError));
	it("rejects float", () =>
		expect(() => validateCcExpectedRevisionNo(1.5)).toThrow(CreditCardError));
	it("rejects negative", () =>
		expect(() => validateCcExpectedRevisionNo(-1)).toThrow(CreditCardError));
});

describe("validateCcPositiveMoneyString", () => {
	it("accepts 100.00", () => {
		const r = validateCcPositiveMoneyString("100.00", "amount");
		expect(r.normalized).toBe("100.00");
		expect(r.cents).toBe(10000n);
	});
	it("rejects 0", () =>
		expect(() => validateCcPositiveMoneyString("0", "amount")).toThrow(
			CreditCardError,
		));
	it("rejects negative", () =>
		expect(() => validateCcPositiveMoneyString("-10", "amount")).toThrow(
			CreditCardError,
		));
});

describe("card-specific fixture day examples", () => {
	const fixtures = [
		{
			code: "ZIRAAT",
			statementDay: 1,
			dueDay: 11,
			cycleYear: 2026,
			cycleMonth: 9,
			expectedStatement: "2026-09-01",
			expectedDue: "2026-09-11",
		},
		{
			code: "AKBANK",
			statementDay: 2,
			dueDay: 12,
			cycleYear: 2026,
			cycleMonth: 9,
			expectedStatement: "2026-09-02",
			expectedDue: "2026-09-12",
		},
		{
			code: "TOM_HADI",
			statementDay: 5,
			dueDay: 17,
			cycleYear: 2026,
			cycleMonth: 9,
			expectedStatement: "2026-09-05",
			expectedDue: "2026-09-17",
		},
		{
			code: "YAPI_KREDI",
			statementDay: 8,
			dueDay: 18,
			cycleYear: 2026,
			cycleMonth: 9,
			expectedStatement: "2026-09-08",
			expectedDue: "2026-09-18",
		},
		{
			code: "KUVEYT_TURK",
			statementDay: 15,
			dueDay: 25,
			cycleYear: 2026,
			cycleMonth: 9,
			expectedStatement: "2026-09-15",
			expectedDue: "2026-09-25",
		},
		{
			code: "QNB",
			statementDay: 15,
			dueDay: 25,
			cycleYear: 2026,
			cycleMonth: 9,
			expectedStatement: "2026-09-15",
			expectedDue: "2026-09-25",
		},
	];

	for (const f of fixtures) {
		it(`${f.code} Sep 2026 statement=${f.expectedStatement} due=${f.expectedDue}`, () => {
			const stmtDate = computeStatementDate(
				f.cycleYear,
				f.cycleMonth,
				f.statementDay,
			);
			const dueDate = computeDueDate(stmtDate, f.dueDay);
			expect(stmtDate).toBe(f.expectedStatement);
			expect(dueDate).toBe(f.expectedDue);
			expect(dueDate > stmtDate).toBe(true);
		});
	}
});

describe("validateCardStatusFilter", () => {
	it("returns undefined for undefined and null", () => {
		expect(validateCardStatusFilter(undefined)).toBeUndefined();
		expect(validateCardStatusFilter(null)).toBeUndefined();
	});

	it("accepts ACTIVE and ARCHIVED", () => {
		expect(validateCardStatusFilter("ACTIVE")).toBe("ACTIVE");
		expect(validateCardStatusFilter("ARCHIVED")).toBe("ARCHIVED");
	});

	it("rejects invalid card statuses", () => {
		expect(() => validateCardStatusFilter("OPEN")).toThrow(CreditCardError);
		expect(() => validateCardStatusFilter("VOID")).toThrow(CreditCardError);
		expect(() => validateCardStatusFilter("PAID")).toThrow(CreditCardError);
		expect(() => validateCardStatusFilter("")).toThrow(CreditCardError);
		expect(() => validateCardStatusFilter("foo")).toThrow(CreditCardError);
		expect(() => validateCardStatusFilter(123)).toThrow(CreditCardError);
	});
});

describe("validateStatementStatusFilter", () => {
	it("returns undefined for undefined and null", () => {
		expect(validateStatementStatusFilter(undefined)).toBeUndefined();
		expect(validateStatementStatusFilter(null)).toBeUndefined();
	});

	it("accepts OPEN, VOID, and PAID", () => {
		expect(validateStatementStatusFilter("OPEN")).toBe("OPEN");
		expect(validateStatementStatusFilter("VOID")).toBe("VOID");
		expect(validateStatementStatusFilter("PAID")).toBe("PAID");
	});

	it("rejects invalid statement statuses", () => {
		expect(() => validateStatementStatusFilter("ACTIVE")).toThrow(
			CreditCardError,
		);
		expect(() => validateStatementStatusFilter("ARCHIVED")).toThrow(
			CreditCardError,
		);
		expect(() => validateStatementStatusFilter("")).toThrow(CreditCardError);
		expect(() => validateStatementStatusFilter("foo")).toThrow(CreditCardError);
		expect(() => validateStatementStatusFilter(123)).toThrow(CreditCardError);
	});
});

describe("validateInstallmentCount", () => {
	it("accepts null and undefined and returns null", async () => {
		const { validateInstallmentCount } = await import(
			"../src/credit-cards/calendar"
		);
		expect(validateInstallmentCount(undefined)).toBeNull();
		expect(validateInstallmentCount(null)).toBeNull();
	});

	it("accepts integers from 1 to 60", async () => {
		const { validateInstallmentCount } = await import(
			"../src/credit-cards/calendar"
		);
		expect(validateInstallmentCount(1)).toBe(1);
		expect(validateInstallmentCount(3)).toBe(3);
		expect(validateInstallmentCount(12)).toBe(12);
		expect(validateInstallmentCount(60)).toBe(60);
	});

	it("rejects out-of-range or non-integer values", async () => {
		const { validateInstallmentCount } = await import(
			"../src/credit-cards/calendar"
		);
		expect(() => validateInstallmentCount(0)).toThrow(CreditCardError);
		expect(() => validateInstallmentCount(-1)).toThrow(CreditCardError);
		expect(() => validateInstallmentCount(61)).toThrow(CreditCardError);
		expect(() => validateInstallmentCount(3.5)).toThrow(CreditCardError);
		expect(() => validateInstallmentCount("3")).toThrow(CreditCardError);
		expect(() => validateInstallmentCount(Number.NaN)).toThrow(CreditCardError);
	});
});
