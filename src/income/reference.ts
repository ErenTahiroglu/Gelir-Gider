import { and, desc, eq, inArray } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../db/schema/income";
import { formatCentsToMoney, parseMoneyString } from "../ledger/money";
import { validateIsoCalendarDate } from "./calendar";
import { IncomeError } from "./errors";
import type { IncomeNature, IncomeReferenceMethod } from "./sources";

export interface MonthlyReferenceIncomeSourceItem {
	sourceId: string;
	code: string;
	name: string;
	nature: IncomeNature;
	referenceMethod: IncomeReferenceMethod;
	referenceAmount: string;
}

export interface MonthlyReferenceIncomeResult {
	asOf: string;
	currency: string;
	total: string;
	sources: MonthlyReferenceIncomeSourceItem[];
}

export interface GetMonthlyReferenceIncomeParams {
	db: DatabaseOrTransaction;
	userId: string;
	asOf: string | Date;
}

const ISTANBUL_TZ = "Europe/Istanbul";

/**
 * Returns year, month (1-12), and day (1-31) in Europe/Istanbul timezone.
 */
function getIstanbulDateParts(date: Date): {
	year: number;
	month: number;
	day: number;
	dateStr: string;
	monthStr: string;
} {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: ISTANBUL_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = formatter.formatToParts(date);
	const yearPart = parts.find((p) => p.type === "year")?.value ?? "1970";
	const monthPart = parts.find((p) => p.type === "month")?.value ?? "01";
	const dayPart = parts.find((p) => p.type === "day")?.value ?? "01";

	const year = Number.parseInt(yearPart, 10);
	const month = Number.parseInt(monthPart, 10);
	const day = Number.parseInt(dayPart, 10);

	const yStr = year.toString().padStart(4, "0");
	const mStr = month.toString().padStart(2, "0");
	const dStr = day.toString().padStart(2, "0");

	return {
		year,
		month,
		day,
		dateStr: `${yStr}-${mStr}-${dStr}`,
		monthStr: `${yStr}-${mStr}`,
	};
}

function subtractMonths(
	year: number,
	month: number,
	k: number,
): { year: number; month: number; monthStr: string } {
	let y = year;
	let m = month - k;
	while (m <= 0) {
		m += 12;
		y -= 1;
	}
	const yStr = y.toString().padStart(4, "0");
	const mStr = m.toString().padStart(2, "0");
	return { year: y, month: m, monthStr: `${yStr}-${mStr}` };
}

/**
 * Computes the aggregate and per-source monthly reference income as of a specific date/time.
 */
export async function getMonthlyReferenceIncome(
	params: GetMonthlyReferenceIncomeParams,
): Promise<MonthlyReferenceIncomeResult> {
	const { db, userId, asOf } = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	let asOfDate: Date;
	let asOfDateStr: string;

	if (typeof asOf === "string") {
		const trimmed = asOf.trim();
		validateIsoCalendarDate(trimmed);
		asOfDate = new Date(`${trimmed}T12:00:00Z`);
		asOfDateStr = trimmed;
	} else if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) {
		asOfDate = asOf;
		asOfDateStr = getIstanbulDateParts(asOf).dateStr;
	} else {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Valid asOf date is required",
		);
	}

	// Fetch user currency
	const [user] = await db
		.select({ currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new IncomeError("INCOME_INVALID_INPUT", "User not found");
	}

	// Fetch all income sources
	const allSources = await db
		.select()
		.from(incomeSources)
		.where(eq(incomeSources.userId, userId))
		.orderBy(incomeSources.code);

	// Filter sources active as of given date/time
	const eligibleSources = allSources.filter((source) => {
		// Active window check
		if (asOfDateStr < source.activeFrom) return false;
		if (source.activeUntil !== null && asOfDateStr > source.activeUntil) {
			return false;
		}
		// Archive check: if archived on or before asOfDate
		if (source.archivedAt !== null && source.archivedAt <= asOfDate) {
			return false;
		}
		return true;
	});

	if (eligibleSources.length === 0) {
		return {
			asOf: asOfDateStr,
			currency: user.currency,
			total: "0.00",
			sources: [],
		};
	}

	// Check if any source uses ROLLING_MEDIAN to batch-load receipts
	const rollingSources = eligibleSources.filter(
		(s) => s.referenceMethod === "ROLLING_MEDIAN",
	);

	const receiptsBySourceMap = new Map<
		string,
		Array<{ occurredAt: Date; amountCents: bigint }>
	>();

	if (rollingSources.length > 0) {
		const sourceIds = rollingSources.map((s) => s.id);

		// Load receipts for these sources
		const receiptRows = await db
			.select({
				receiptId: incomeReceipts.id,
				sourceId: incomeReceipts.sourceId,
			})
			.from(incomeReceipts)
			.where(
				and(
					eq(incomeReceipts.userId, userId),
					inArray(incomeReceipts.sourceId, sourceIds),
				),
			);

		if (receiptRows.length > 0) {
			const rIds = receiptRows.map((r) => r.receiptId);

			const allRevs = await db
				.select()
				.from(incomeReceiptRevisions)
				.where(
					and(
						eq(incomeReceiptRevisions.userId, userId),
						inArray(incomeReceiptRevisions.incomeReceiptId, rIds),
					),
				)
				.orderBy(desc(incomeReceiptRevisions.revisionNo));

			// Latest revision map
			const latestRevMap = new Map<
				string,
				typeof incomeReceiptRevisions.$inferSelect
			>();
			for (const rev of allRevs) {
				if (!latestRevMap.has(rev.incomeReceiptId)) {
					latestRevMap.set(rev.incomeReceiptId, rev);
				}
			}

			for (const r of receiptRows) {
				const rev = latestRevMap.get(r.receiptId);
				if (!rev || rev.operation === "VOID") continue;

				const list = receiptsBySourceMap.get(r.sourceId) ?? [];
				list.push({
					occurredAt: rev.occurredAt,
					amountCents: parseMoneyString(rev.amount).cents,
				});
				receiptsBySourceMap.set(r.sourceId, list);
			}
		}
	}

	const istanbulParts = getIstanbulDateParts(asOfDate);
	let totalCents = 0n;
	const sourceResults: MonthlyReferenceIncomeSourceItem[] = [];

	for (const source of eligibleSources) {
		let refAmount = "0.00";

		if (source.referenceMethod === "FIXED_MONTHLY") {
			refAmount = source.expectedMonthlyAmount ?? "0.00";
		} else if (source.referenceMethod === "SEASONAL_ANNUALIZED") {
			const expectedCents = parseMoneyString(
				source.expectedMonthlyAmount ?? "0.00",
			).cents;
			const months = BigInt(source.seasonalMonthsPerYear ?? 12);
			const totalProduct = expectedCents * months;
			const quotient = totalProduct / 12n;
			const remainder = totalProduct % 12n;
			const roundedCents = remainder * 2n >= 12n ? quotient + 1n : quotient;
			refAmount = formatCentsToMoney(roundedCents);
		} else if (source.referenceMethod === "ROLLING_MEDIAN") {
			const N = source.rollingMedianMonths ?? 3;
			const activeFromMonthStr = source.activeFrom.slice(0, 7); // YYYY-MM

			// Generate candidate completed calendar months (excluding current month)
			const candidateMonths: string[] = [];
			for (let k = 1; k <= N; k++) {
				const mInfo = subtractMonths(
					istanbulParts.year,
					istanbulParts.month,
					k,
				);
				// Filter out months strictly before the source's activeFrom month
				if (mInfo.monthStr >= activeFromMonthStr) {
					candidateMonths.push(mInfo.monthStr);
				}
			}

			if (candidateMonths.length === 0) {
				refAmount = "0.00";
			} else {
				// Group receipts for this source into calendar months (Europe/Istanbul)
				const receipts = receiptsBySourceMap.get(source.id) ?? [];
				const monthTotalsMap = new Map<string, bigint>();
				for (const m of candidateMonths) {
					monthTotalsMap.set(m, 0n);
				}

				for (const r of receipts) {
					const rMonthStr = getIstanbulDateParts(r.occurredAt).monthStr;
					if (monthTotalsMap.has(rMonthStr)) {
						const cur = monthTotalsMap.get(rMonthStr) ?? 0n;
						monthTotalsMap.set(rMonthStr, cur + r.amountCents);
					}
				}

				const monthlyTotals = Array.from(monthTotalsMap.values()).sort(
					(a, b) => (a < b ? -1 : a > b ? 1 : 0),
				);

				const count = monthlyTotals.length;
				let medianCents = 0n;

				if (count % 2 === 1) {
					medianCents = monthlyTotals[Math.floor(count / 2)] ?? 0n;
				} else {
					const mid1 = monthlyTotals[count / 2 - 1] ?? 0n;
					const mid2 = monthlyTotals[count / 2] ?? 0n;
					const sum = mid1 + mid2;
					const quot = sum / 2n;
					const rem = sum % 2n;
					medianCents = rem === 1n ? quot + 1n : quot; // ROUND_HALF_UP
				}

				refAmount = formatCentsToMoney(medianCents);
			}
		} else if (source.referenceMethod === "EXCLUDED") {
			refAmount = "0.00";
		}

		const refCents = parseMoneyString(refAmount).cents;
		totalCents += refCents;

		sourceResults.push({
			sourceId: source.id,
			code: source.code,
			name: source.name,
			nature: source.nature as IncomeNature,
			referenceMethod: source.referenceMethod as IncomeReferenceMethod,
			referenceAmount: refAmount,
		});
	}

	return {
		asOf: asOfDateStr,
		currency: user.currency,
		total: formatCentsToMoney(totalCents),
		sources: sourceResults,
	};
}
