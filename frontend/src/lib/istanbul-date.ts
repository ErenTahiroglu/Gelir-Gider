/**
 * Europe/Istanbul Calendar Date & Period Utilities
 *
 * Adheres strictly to Section 14, 29, 46:
 *   - Derives periodMonth (YYYY-MM) and calendar day using Europe/Istanbul timezone.
 *   - Compares calendar dates in Europe/Istanbul for due date countdowns.
 */

const TURKISH_MONTH_NAMES: Record<string, string> = {
	"01": "Ocak",
	"02": "Şubat",
	"03": "Mart",
	"04": "Nisan",
	"05": "Mayıs",
	"06": "Haziran",
	"07": "Temmuz",
	"08": "Ağustos",
	"09": "Eylül",
	"10": "Ekim",
	"11": "Kasım",
	"12": "Aralık",
};

export interface IstanbulCalendarDate {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
	periodMonth: string; // "YYYY-MM"
	dateString: string; // "YYYY-MM-DD"
}

/**
 * Extracts the calendar year, month, and day for a given instant in Europe/Istanbul.
 */
export function getIstanbulCalendarDate(
	now: Date = new Date(),
): IstanbulCalendarDate {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Istanbul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	const parts = formatter.formatToParts(now);
	let yearStr = "";
	let monthStr = "";
	let dayStr = "";

	for (const part of parts) {
		if (part.type === "year") yearStr = part.value;
		else if (part.type === "month") monthStr = part.value;
		else if (part.type === "day") dayStr = part.value;
	}

	const year = Number.parseInt(yearStr, 10);
	const month = Number.parseInt(monthStr, 10);
	const day = Number.parseInt(dayStr, 10);
	const periodMonth = `${yearStr}-${monthStr}`;
	const dateString = `${yearStr}-${monthStr}-${dayStr}`;

	return {
		year,
		month,
		day,
		periodMonth,
		dateString,
	};
}

/**
 * Returns the current Europe/Istanbul period month in "YYYY-MM" format.
 * Example: 2026-09-30T21:30:00Z -> "2026-10" (because Istanbul is UTC+3)
 */
export function getIstanbulPeriodMonth(now: Date = new Date()): string {
	return getIstanbulCalendarDate(now).periodMonth;
}

/**
 * Formats a "YYYY-MM" period month string into natural Turkish text.
 * Example: "2026-09" -> "Eylül 2026"
 */
export function formatPeriodMonthTurkish(periodMonth: string): string {
	const [yearStr, monthStr] = periodMonth.split("-");
	if (!yearStr || !monthStr || !TURKISH_MONTH_NAMES[monthStr]) {
		return periodMonth;
	}
	return `${TURKISH_MONTH_NAMES[monthStr]} ${yearStr}`;
}

/**
 * Parses a "YYYY-MM-DD" Gregorian calendar date string into year, month, day.
 */
export function parseDateString(dateStr: string): {
	year: number;
	month: number;
	day: number;
} {
	const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(dateStr);
	if (!match?.[1] || !match[2] || !match[3]) {
		throw new Error(`Invalid date string: "${dateStr}". Expected YYYY-MM-DD`);
	}
	return {
		year: Number.parseInt(match[1], 10),
		month: Number.parseInt(match[2], 10),
		day: Number.parseInt(match[3], 10),
	};
}

/**
 * Calculates calendar day difference between targetDateStr ("YYYY-MM-DD")
 * and the current date in Europe/Istanbul.
 *
 * Positive -> target is in the future.
 * 0 -> today.
 * Negative -> target is in the past (overdue).
 */
export function getDaysUntilDueDate(
	targetDateStr: string,
	now: Date = new Date(),
): number {
	const target = parseDateString(targetDateStr);
	const current = getIstanbulCalendarDate(now);

	// Compare whole calendar days in UTC to avoid time-of-day discrepancies
	const targetUtc = Date.UTC(target.year, target.month - 1, target.day);
	const currentUtc = Date.UTC(current.year, current.month - 1, current.day);

	const diffMs = targetUtc - currentUtc;
	return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Returns natural Turkish copy for a due date relative to today in Europe/Istanbul.
 * Examples:
 *   0 -> "Bugün"
 *   1 -> "Yarın"
 *   3 -> "3 gün sonra"
 *  -2 -> "2 gün gecikti"
 */
export function formatDueDateRelativeTurkish(
	dueDateStr: string,
	now: Date = new Date(),
): string {
	const days = getDaysUntilDueDate(dueDateStr, now);

	if (days === 0) return "Bugün";
	if (days === 1) return "Yarın";
	if (days > 1) return `${days} gün sonra`;
	return `${Math.abs(days)} gün gecikti`;
}
