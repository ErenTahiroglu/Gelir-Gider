import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import { ledgerAccounts } from "../src/db/schema/ledger";
import { IncomeError } from "../src/income/errors";
import { archiveIncomeSource, createIncomeSource } from "../src/income/sources";

describe("Income Sources Service", () => {
	it("creates a valid FIXED_MONTHLY income source", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "ledger-acc-1",
										userId: "user-1",
										accountType: "INCOME",
										normalBalance: "CREDIT",
										currency: "TRY",
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					onConflictDoNothing: vi.fn().mockImplementation(() => ({
						returning: vi.fn().mockResolvedValue([
							{
								...vals,
								id: "source-1",
								createdAt: new Date(),
								archivedAt: null,
							},
						]),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await createIncomeSource({
			db: mockDb,
			userId: "user-1",
			code: "KYK",
			name: "KYK Bursu",
			nature: "REGULAR",
			referenceMethod: "FIXED_MONTHLY",
			expectedMonthlyAmount: "4000.00",
			incomeLedgerAccountId: "ledger-acc-1",
			activeFrom: "2026-01-01",
		});

		expect(res.id).toBe("source-1");
		expect(res.code).toBe("KYK");
		expect(res.expectedMonthlyAmount).toBe("4000.00");
	});

	it("creates a valid SEASONAL_ANNUALIZED income source", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "ledger-acc-2",
										userId: "user-1",
										accountType: "INCOME",
										normalBalance: "CREDIT",
										currency: "TRY",
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					onConflictDoNothing: vi.fn().mockImplementation(() => ({
						returning: vi.fn().mockResolvedValue([
							{
								...vals,
								id: "source-2",
								createdAt: new Date(),
								archivedAt: null,
							},
						]),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await createIncomeSource({
			db: mockDb,
			userId: "user-1",
			code: "SCHOLARSHIP",
			name: "Academic Scholarship",
			nature: "REGULAR",
			referenceMethod: "SEASONAL_ANNUALIZED",
			expectedMonthlyAmount: "5000.00",
			seasonalMonthsPerYear: 9,
			incomeLedgerAccountId: "ledger-acc-2",
			activeFrom: "2026-01-01",
		});

		expect(res.id).toBe("source-2");
		expect(res.seasonalMonthsPerYear).toBe(9);
	});

	it("rejects EXTRA nature with non-EXCLUDED reference method", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeSource({
				db: mockDb,
				userId: "user-1",
				code: "BONUS",
				name: "Work Bonus",
				nature: "EXTRA",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "10000.00",
				incomeLedgerAccountId: "ledger-acc-1",
				activeFrom: "2026-01-01",
			}),
		).rejects.toThrow(
			"Income nature 'EXTRA' must use reference method 'EXCLUDED'",
		);
	});

	it("rejects invalid seasonal months (< 1 or > 12)", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeSource({
				db: mockDb,
				userId: "user-1",
				code: "SEASONAL_INVALID",
				name: "Seasonal Invalid",
				nature: "REGULAR",
				referenceMethod: "SEASONAL_ANNUALIZED",
				expectedMonthlyAmount: "5000.00",
				seasonalMonthsPerYear: 15,
				incomeLedgerAccountId: "ledger-acc-1",
				activeFrom: "2026-01-01",
			}),
		).rejects.toThrow(
			"seasonalMonthsPerYear must be an integer between 1 and 12",
		);
	});

	it("rejects invalid rolling median window (< 1 or > 24)", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeSource({
				db: mockDb,
				userId: "user-1",
				code: "ROLLING_INVALID",
				name: "Rolling Invalid",
				nature: "REGULAR",
				referenceMethod: "ROLLING_MEDIAN",
				rollingMedianMonths: 36,
				incomeLedgerAccountId: "ledger-acc-1",
				activeFrom: "2026-01-01",
			}),
		).rejects.toThrow(
			"rollingMedianMonths must be an integer between 1 and 24",
		);
	});

	it("rejects archived income ledger account", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "ledger-acc-archived",
										userId: "user-1",
										accountType: "INCOME",
										normalBalance: "CREDIT",
										currency: "TRY",
										archivedAt: new Date(),
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		await expect(
			createIncomeSource({
				db: mockDb,
				userId: "user-1",
				code: "KYK",
				name: "KYK Bursu",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "4000.00",
				incomeLedgerAccountId: "ledger-acc-archived",
				activeFrom: "2026-01-01",
			}),
		).rejects.toThrow(
			"Cannot create income source with an archived ledger account",
		);
	});

	it("archives income source idempotently", async () => {
		const now = new Date();
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockResolvedValue([
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
								incomeLedgerAccountId: "ledger-acc-1",
								activeFrom: "2026-01-01",
								activeUntil: null,
								createdAt: now,
								archivedAt: null,
							},
						]),
					})),
				})),
			})),
			update: vi.fn().mockImplementation(() => ({
				set: vi.fn().mockImplementation((updates) => ({
					where: vi.fn().mockImplementation(() => ({
						returning: vi.fn().mockResolvedValue([
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
								incomeLedgerAccountId: "ledger-acc-1",
								activeFrom: "2026-01-01",
								activeUntil: null,
								createdAt: now,
								archivedAt: updates.archivedAt,
							},
						]),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await archiveIncomeSource({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
		});

		expect(res.archivedAt).toBeInstanceOf(Date);
	});

	it("strictly validates calendar dates and rejects impossible dates with INCOME_INVALID_INPUT", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "ledger-acc-1",
										userId: "user-1",
										accountType: "INCOME",
										normalBalance: "CREDIT",
										currency: "TRY",
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

		const invalidDates = [
			"2026-02-30", // Feb never has 30 days
			"2027-02-29", // 2027 is not a leap year
			"2026-13-01", // Month 13
			"2026-00-10", // Month 0
			"2026-04-31", // April has 30 days
			"2026-06-31", // June has 30 days
			"2026-09-31", // September has 30 days
			"2026-11-31", // November has 30 days
			"invalid-date",
		];

		for (const d of invalidDates) {
			await expect(
				createIncomeSource({
					db: mockDb,
					userId: "user-1",
					code: "TEST",
					name: "Test Source",
					nature: "REGULAR",
					referenceMethod: "FIXED_MONTHLY",
					expectedMonthlyAmount: "1000.00",
					incomeLedgerAccountId: "ledger-acc-1",
					activeFrom: d,
				}),
			).rejects.toSatisfy(
				(e: unknown) =>
					e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
			);
		}
	});

	it("accepts valid leap year calendar date (2028-02-29)", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "ledger-acc-1",
										userId: "user-1",
										accountType: "INCOME",
										normalBalance: "CREDIT",
										currency: "TRY",
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					onConflictDoNothing: vi.fn().mockImplementation(() => ({
						returning: vi.fn().mockResolvedValue([
							{
								...vals,
								id: "source-leap",
								createdAt: new Date(),
								archivedAt: null,
							},
						]),
					})),
				})),
			})),
		} as unknown as Database;

		const res = await createIncomeSource({
			db: mockDb,
			userId: "user-1",
			code: "LEAP",
			name: "Leap Year Source",
			nature: "REGULAR",
			referenceMethod: "FIXED_MONTHLY",
			expectedMonthlyAmount: "1000.00",
			incomeLedgerAccountId: "ledger-acc-1",
			activeFrom: "2028-02-29",
		});

		expect(res.activeFrom).toBe("2028-02-29");
	});

	it("wraps money parsing errors in INCOME_INVALID_INPUT", async () => {
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
			createIncomeSource({
				db: mockDb,
				userId: "user-1",
				code: "TEST",
				name: "Test Source",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "invalid-amount",
				incomeLedgerAccountId: "ledger-acc-1",
				activeFrom: "2026-01-01",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});
});
