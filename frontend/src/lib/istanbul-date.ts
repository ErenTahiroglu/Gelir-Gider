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

/**
 * Returns timeline group label in Europe/Istanbul for an instant.
 * Labels:
 *   - "Bugün" (if calendar date matches today in Europe/Istanbul)
 *   - "Dün" (if calendar date matches yesterday in Europe/Istanbul)
 *   - "14 Eylül 2026" (for older/other dates)
 */
export function formatTimelineDateGroupTurkish(
	occurredAtInstant: string | Date,
	now: Date = new Date(),
): string {
	const date =
		typeof occurredAtInstant === "string"
			? new Date(occurredAtInstant)
			: occurredAtInstant;

	const txCal = getIstanbulCalendarDate(date);
	const nowCal = getIstanbulCalendarDate(now);

	const txUtc = Date.UTC(txCal.year, txCal.month - 1, txCal.day);
	const nowUtc = Date.UTC(nowCal.year, nowCal.month - 1, nowCal.day);

	const diffDays = Math.round((nowUtc - txUtc) / (1000 * 60 * 60 * 24));

	if (diffDays === 0) return "Bugün";
	if (diffDays === 1) return "Dün";

	const monthKey = String(txCal.month).padStart(2, "0");
	const monthName = TURKISH_MONTH_NAMES[monthKey] ?? `${txCal.month}`;
	return `${txCal.day} ${monthName} ${txCal.year}`;
}

/**
 * Formats a Date instant into a datetime-local input string ("YYYY-MM-DDTHH:mm")
 * evaluated strictly in Europe/Istanbul timezone.
 */
export function formatIstanbulDateTimeLocal(now: Date = new Date()): string {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Istanbul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const parts = formatter.formatToParts(now);
	let yearStr = "";
	let monthStr = "";
	let dayStr = "";
	let hourStr = "00";
	let minuteStr = "00";

	for (const part of parts) {
		if (part.type === "year") yearStr = part.value;
		else if (part.type === "month") monthStr = part.value;
		else if (part.type === "day") dayStr = part.value;
		else if (part.type === "hour") hourStr = part.value;
		else if (part.type === "minute") minuteStr = part.value;
	}

	if (hourStr === "24") hourStr = "00";

	return `${yearStr}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}`;
}

/**
 * Converts a datetime-local input string ("YYYY-MM-DDTHH:mm") entered by the user
 * in Europe/Istanbul time into a canonical ISO string (UTC instant).
 *
 * Turkey is UTC+3 permanently with no DST.
 */
export function parseIstanbulDateTimeLocalToIso(dtLocalStr: string): string {
	const trimmed = dtLocalStr.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
		trimmed,
	);
	if (!match) {
		throw new Error(
			`Invalid datetime-local format: "${dtLocalStr}". Expected YYYY-MM-DDTHH:mm`,
		);
	}

	const year = match[1];
	const month = match[2];
	const day = match[3];
	const hour = match[4];
	const minute = match[5];
	const second = match[6] ?? "00";

	// Europe/Istanbul is UTC+03:00 fixed
	const isoWithOffset = `${year}-${month}-${day}T${hour}:${minute}:${second}+03:00`;
	const d = new Date(isoWithOffset);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`Invalid date/time value: "${dtLocalStr}"`);
	}
	return d.toISOString();
}

/**
 * Formats an instant into Turkish display date and time (e.g. "29 Eylül 2026, 20:30")
 * strictly in Europe/Istanbul.
 */
export function formatIstanbulDateTimeTurkish(instant: string | Date): string {
	const date = typeof instant === "string" ? new Date(instant) : instant;
	const cal = getIstanbulCalendarDate(date);
	const monthKey = String(cal.month).padStart(2, "0");
	const monthName = TURKISH_MONTH_NAMES[monthKey] ?? `${cal.month}`;

	const timeFormatter = new Intl.DateTimeFormat("tr-TR", {
		timeZone: "Europe/Istanbul",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const timePart = timeFormatter.format(date);
	return `${cal.day} ${monthName} ${cal.year}, ${timePart}`;
}
