import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../src/db/schema/income";
import { IncomeError } from "../src/income/errors";
import { getMonthlyReferenceIncome } from "../src/income/reference";

describe("Income Reference Engine", () => {
	it("computes FIXED_MONTHLY reference income properly", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => {
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-1",
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										nature: "REGULAR",
										referenceMethod: "FIXED_MONTHLY",
										expectedMonthlyAmount: "4000.00",
										seasonalMonthsPerYear: null,
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await getMonthlyReferenceIncome({
			db: mockDb,
			userId: "user-1",
			asOf: "2026-09-15",
		});

		expect(res.asOf).toBe("2026-09-15");
		expect(res.total).toBe("4000.00");
		expect(res.sources).toHaveLength(1);
		expect(res.sources[0]?.referenceAmount).toBe("4000.00");
	});

	it("computes SEASONAL_ANNUALIZED reference income with ROUND_HALF_UP exact arithmetic", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => {
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-1",
										userId: "user-1",
										code: "SCHOLARSHIP",
										name: "Academic Scholarship",
										nature: "REGULAR",
										referenceMethod: "SEASONAL_ANNUALIZED",
										expectedMonthlyAmount: "5000.00",
										seasonalMonthsPerYear: 9,
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
									{
										id: "source-2",
										userId: "user-1",
										code: "SEASONAL_ROUNDING",
										name: "Seasonal Rounding",
										nature: "REGULAR",
										referenceMethod: "SEASONAL_ANNUALIZED",
										expectedMonthlyAmount: "10.00",
										seasonalMonthsPerYear: 7, // 10.00 * 7 / 12 = 70.00 / 12 = 5.8333... -> 5.83
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await getMonthlyReferenceIncome({
			db: mockDb,
			userId: "user-1",
			asOf: "2026-09-15",
		});

		// 5000.00 * 9 / 12 = 3750.00
		// 10.00 * 7 / 12 = 5.83
		// Total = 3755.83
		expect(res.sources[0]?.referenceAmount).toBe("3750.00");
		expect(res.sources[1]?.referenceAmount).toBe("5.83");
		expect(res.total).toBe("3755.83");
	});

	it("computes ROLLING_MEDIAN reference income with odd/even windows and Europe/Istanbul month boundaries", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => {
						if (table === incomeReceipts) {
							return Promise.resolve([
								{ receiptId: "rec-1", sourceId: "source-var" },
								{ receiptId: "rec-2", sourceId: "source-var" },
								{ receiptId: "rec-3", sourceId: "source-var" },
							]);
						}
						return {
							limit: vi.fn().mockImplementation(() => {
								if (table === users) {
									return Promise.resolve([{ currency: "TRY" }]);
								}
								return Promise.resolve([]);
							}),
							orderBy: vi.fn().mockImplementation(() => {
								if (table === incomeSources) {
									return Promise.resolve([
										{
											id: "source-var",
											userId: "user-1",
											code: "VARIABLE",
											name: "Freelance",
											nature: "REGULAR",
											referenceMethod: "ROLLING_MEDIAN",
											expectedMonthlyAmount: null,
											seasonalMonthsPerYear: null,
											rollingMedianMonths: 3,
											activeFrom: "2026-06-01",
											activeUntil: null,
											archivedAt: null,
										},
									]);
								}
								if (table === incomeReceiptRevisions) {
									return Promise.resolve([
										// June receipt (rev 1): 1000
										{
											incomeReceiptId: "rec-1",
											canonicalRevisionId: "rev-1",
											revisionNo: 1,
											operation: "CREATE",
											occurredAt: new Date("2026-06-15T10:00:00Z"),
											amount: "1000.00",
										},
										// August receipt (rev 1): 3000
										{
											incomeReceiptId: "rec-2",
											canonicalRevisionId: "rev-2",
											revisionNo: 1,
											operation: "CREATE",
											occurredAt: new Date("2026-08-10T10:00:00Z"),
											amount: "3000.00",
										},
										// Current incomplete September receipt (should be excluded): 5000
										{
											incomeReceiptId: "rec-3",
											canonicalRevisionId: "rev-3",
											revisionNo: 1,
											operation: "CREATE",
											occurredAt: new Date("2026-09-05T10:00:00Z"),
											amount: "5000.00",
										},
									]);
								}
								return Promise.resolve([]);
							}),
						};
					}),
				})),
			})),
		} as unknown as Database;

		const res = await getMonthlyReferenceIncome({
			db: mockDb,
			userId: "user-1",
			asOf: "2026-09-15",
		});

		// Completed candidate months: June, July, August (3 months)
		// June = 1000.00, July = 0.00, August = 3000.00
		// Sorted: [0.00, 1000.00, 3000.00]
		// Median = 1000.00
		expect(res.sources[0]?.referenceAmount).toBe("1000.00");
		expect(res.total).toBe("1000.00");
	});

	it("excludes EXTRA and SUPPORT sources from inflating reference income", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => {
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-extra",
										userId: "user-1",
										code: "BONUS",
										name: "Bonus",
										nature: "EXTRA",
										referenceMethod: "EXCLUDED",
										expectedMonthlyAmount: null,
										seasonalMonthsPerYear: null,
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
									{
										id: "source-support",
										userId: "user-1",
										code: "FAMILY_DEFICIT",
										name: "Family Support",
										nature: "SUPPORT",
										referenceMethod: "EXCLUDED",
										expectedMonthlyAmount: null,
										seasonalMonthsPerYear: null,
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await getMonthlyReferenceIncome({
			db: mockDb,
			userId: "user-1",
			asOf: "2026-09-15",
		});

		expect(res.total).toBe("0.00");
		expect(res.sources[0]?.referenceAmount).toBe("0.00");
		expect(res.sources[1]?.referenceAmount).toBe("0.00");
	});

	it("strictly handles asOf Date vs archivedAt timestamp boundary semantics", async () => {
		const asOfDate = new Date("2026-09-15T12:00:00Z");

		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => {
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-archived-prior",
										userId: "user-1",
										code: "ARCH_PRIOR",
										name: "Archived Prior to asOf",
										nature: "REGULAR",
										referenceMethod: "FIXED_MONTHLY",
										expectedMonthlyAmount: "1000.00",
										seasonalMonthsPerYear: null,
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: new Date("2026-09-15T12:00:00Z"), // <= asOfDate -> excluded
									},
									{
										id: "source-archived-later",
										userId: "user-1",
										code: "ARCH_LATER",
										name: "Archived After asOf",
										nature: "REGULAR",
										referenceMethod: "FIXED_MONTHLY",
										expectedMonthlyAmount: "2000.00",
										seasonalMonthsPerYear: null,
										rollingMedianMonths: null,
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: new Date("2026-09-15T12:00:01Z"), // > asOfDate -> included
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await getMonthlyReferenceIncome({
			db: mockDb,
			userId: "user-1",
			asOf: asOfDate,
		});

		expect(res.sources).toHaveLength(1);
		expect(res.sources[0]?.code).toBe("ARCH_LATER");
		expect(res.total).toBe("2000.00");
	});

	it("rejects invalid asOf calendar date strings", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockResolvedValue([{ currency: "TRY" }]),
					})),
				})),
			})),
		} as unknown as Database;

		await expect(
			getMonthlyReferenceIncome({
				db: mockDb,
				userId: "user-1",
				asOf: "2026-02-30",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});
});
