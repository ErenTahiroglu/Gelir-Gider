/**
 * Lightweight Europe/Istanbul period month utilities.
 * Keeps initial bundle decoupled from full date-fns/calendar utility suite.
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

export function getIstanbulPeriodMonth(now: Date = new Date()): string {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Istanbul",
		year: "numeric",
		month: "2-digit",
	});
	const parts = formatter.formatToParts(now);
	let yearStr = "";
	let monthStr = "";
	for (const part of parts) {
		if (part.type === "year") yearStr = part.value;
		else if (part.type === "month") monthStr = part.value;
	}
	return `${yearStr}-${monthStr}`;
}

export function formatPeriodMonthTurkish(periodMonth: string): string {
	const [yearStr, monthStr] = periodMonth.split("-");
	if (!yearStr || !monthStr || !TURKISH_MONTH_NAMES[monthStr]) {
		return periodMonth;
	}
	return `${TURKISH_MONTH_NAMES[monthStr]} ${yearStr}`;
}
