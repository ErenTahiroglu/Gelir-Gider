import { describe, expect, it } from "vitest";
import {
	formatIstanbulDateTimeLocal,
	formatIstanbulDateTimeTurkish,
	formatTimelineDateGroupTurkish,
	parseIstanbulDateTimeLocalToIso,
} from "../src/lib/istanbul-date";

describe("Istanbul Date Grouping & Local Time Handling — F3", () => {
	it("correctly groups transactions across UTC date boundary into Istanbul calendar date", () => {
		// 2026-09-28T21:30:00Z is 2026-09-29 00:30 in Europe/Istanbul (UTC+3)
		const lateUtcInstant = "2026-09-28T21:30:00Z";

		// Controlled current instant: 2026-09-29T10:00:00Z (2026-09-29 13:00 Istanbul)
		const nowSameDay = new Date("2026-09-29T10:00:00Z");
		expect(formatTimelineDateGroupTurkish(lateUtcInstant, nowSameDay)).toBe(
			"Bugün",
		);

		// Controlled next day: 2026-09-30T10:00:00Z (2026-09-30 13:00 Istanbul)
		const nowNextDay = new Date("2026-09-30T10:00:00Z");
		expect(formatTimelineDateGroupTurkish(lateUtcInstant, nowNextDay)).toBe(
			"Dün",
		);

		// Controlled later date: 2026-10-05T10:00:00Z
		const nowLater = new Date("2026-10-05T10:00:00Z");
		expect(formatTimelineDateGroupTurkish(lateUtcInstant, nowLater)).toBe(
			"29 Eylül 2026",
		);
	});

	it("formats datetime-local strictly in Europe/Istanbul without browser shifting", () => {
		// 2026-09-28T21:30:00Z -> Istanbul: 2026-09-29 00:30
		const instant = new Date("2026-09-28T21:30:00Z");
		const localStr = formatIstanbulDateTimeLocal(instant);
		expect(localStr).toBe("2026-09-29T00:30");
	});

	it("converts user-entered datetime-local into canonical UTC ISO string using Europe/Istanbul (+03:00)", () => {
		// User enters "2026-09-29T00:30" in Istanbul -> 2026-09-28T21:30:00.000Z
		const iso = parseIstanbulDateTimeLocalToIso("2026-09-29T00:30");
		expect(iso).toBe("2026-09-28T21:30:00.000Z");
	});

	it("formats Turkish display datetime cleanly", () => {
		const instant = "2026-09-28T21:30:00Z";
		const formatted = formatIstanbulDateTimeTurkish(instant);
		expect(formatted).toContain("29 Eylül 2026");
		expect(formatted).toContain("00:30");
	});
});
