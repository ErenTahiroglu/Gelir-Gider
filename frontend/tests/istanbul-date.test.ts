import { describe, expect, it } from "vitest";
import {
	formatDueDateRelativeTurkish,
	formatPeriodMonthTurkish,
	getDaysUntilDueDate,
	getIstanbulCalendarDate,
	getIstanbulPeriodMonth,
} from "../src/lib/istanbul-date";

describe("Istanbul Date & Period Utilities", () => {
	it("correctly derives periodMonth at Istanbul timezone boundary", () => {
		// 2026-09-30T20:59:59Z -> Istanbul: 2026-09-30 23:59:59 -> "2026-09"
		const endOfSeptemberUtc = new Date("2026-09-30T20:59:59Z");
		expect(getIstanbulPeriodMonth(endOfSeptemberUtc)).toBe("2026-09");

		// 2026-09-30T21:30:00Z -> Istanbul: 2026-10-01 00:30:00 -> "2026-10"
		const startOfOctoberUtc = new Date("2026-09-30T21:30:00Z");
		expect(getIstanbulPeriodMonth(startOfOctoberUtc)).toBe("2026-10");
	});

	it("extracts calendar components accurately in Europe/Istanbul", () => {
		const instant = new Date("2026-09-30T21:30:00Z");
		const cal = getIstanbulCalendarDate(instant);
		expect(cal.year).toBe(2026);
		expect(cal.month).toBe(10);
		expect(cal.day).toBe(1);
		expect(cal.dateString).toBe("2026-10-01");
		expect(cal.periodMonth).toBe("2026-10");
	});

	it("formats periodMonth to natural Turkish text", () => {
		expect(formatPeriodMonthTurkish("2026-09")).toBe("Eylül 2026");
		expect(formatPeriodMonthTurkish("2026-10")).toBe("Ekim 2026");
		expect(formatPeriodMonthTurkish("2026-01")).toBe("Ocak 2026");
		expect(formatPeriodMonthTurkish("2026-12")).toBe("Aralık 2026");
	});

	it("calculates due date relative days and Turkish copy", () => {
		// Set current instant to 2026-09-15 12:00:00 Istanbul time
		const baseNow = new Date("2026-09-15T09:00:00Z");

		// Today
		expect(getDaysUntilDueDate("2026-09-15", baseNow)).toBe(0);
		expect(formatDueDateRelativeTurkish("2026-09-15", baseNow)).toBe("Bugün");

		// Tomorrow
		expect(getDaysUntilDueDate("2026-09-16", baseNow)).toBe(1);
		expect(formatDueDateRelativeTurkish("2026-09-16", baseNow)).toBe("Yarın");

		// 3 days later
		expect(getDaysUntilDueDate("2026-09-18", baseNow)).toBe(3);
		expect(formatDueDateRelativeTurkish("2026-09-18", baseNow)).toBe(
			"3 gün sonra",
		);

		// 2 days overdue
		expect(getDaysUntilDueDate("2026-09-13", baseNow)).toBe(-2);
		expect(formatDueDateRelativeTurkish("2026-09-13", baseNow)).toBe(
			"2 gün gecikti",
		);
	});
});
