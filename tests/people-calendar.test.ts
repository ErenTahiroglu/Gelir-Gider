import { describe, expect, it } from "vitest";
import {
	validateIsoCalendarDate,
	validateOccurredAt,
	validateOptionalIsoCalendarDate,
} from "../src/people/calendar";
import { PeopleError } from "../src/people/errors";

describe("validateIsoCalendarDate", () => {
	it("accepts a valid calendar date", () => {
		expect(validateIsoCalendarDate("2026-09-05")).toBe("2026-09-05");
	});

	it("accepts a valid leap year date", () => {
		expect(validateIsoCalendarDate("2028-02-29")).toBe("2028-02-29");
	});

	it("rejects an impossible leap day on a non-leap year", () => {
		expect(() => validateIsoCalendarDate("2026-02-29")).toThrow(PeopleError);
	});

	it("rejects malformed input", () => {
		expect(() => validateIsoCalendarDate("2026/09/05")).toThrow(PeopleError);
		expect(() => validateIsoCalendarDate("")).toThrow(PeopleError);
	});

	it("rejects out-of-range month/day", () => {
		expect(() => validateIsoCalendarDate("2026-13-01")).toThrow(PeopleError);
		expect(() => validateIsoCalendarDate("2026-01-32")).toThrow(PeopleError);
	});
});

describe("validateOptionalIsoCalendarDate", () => {
	it("returns null for null/undefined", () => {
		expect(validateOptionalIsoCalendarDate(null)).toBeNull();
		expect(validateOptionalIsoCalendarDate(undefined)).toBeNull();
	});

	it("validates a provided date", () => {
		expect(validateOptionalIsoCalendarDate("2026-12-31")).toBe("2026-12-31");
	});

	it("rejects a provided invalid date", () => {
		expect(() => validateOptionalIsoCalendarDate("not-a-date")).toThrow(
			PeopleError,
		);
	});
});

describe("validateOccurredAt", () => {
	it("accepts a valid Date", () => {
		const d = new Date("2026-09-05T10:00:00.000Z");
		expect(validateOccurredAt(d)).toBe(d);
	});

	it("rejects a NaN Date", () => {
		expect(() => validateOccurredAt(new Date("not-a-date"))).toThrow(
			PeopleError,
		);
	});

	it("rejects a non-Date value", () => {
		expect(() => validateOccurredAt("2026-09-05" as unknown as Date)).toThrow(
			PeopleError,
		);
	});
});
