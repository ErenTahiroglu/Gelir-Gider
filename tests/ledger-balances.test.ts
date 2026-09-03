import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { ledgerAccounts } from "../src/db/schema/ledger";
import {
	getLedgerAccountBalance,
	listLedgerAccountBalances,
} from "../src/ledger/balances";

describe("Ledger Balances Read Model (Phase 4B)", () => {
	describe("getLedgerAccountBalance", () => {
		function createMockBalanceDb({
			account = {
				id: "acc-asset-1",
				userId: "user-1",
				normalBalance: "DEBIT",
				currency: "TRY",
			} as Record<string, unknown> | null,
			aggregate = {
				debitSum: "250.75",
				creditSum: "100.50",
			},
		} = {}) {
			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						if (table === ledgerAccounts) {
							return {
								where: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue(account ? [account] : []),
								}),
							};
						}
						// Aggregate query from journalLines join journalEntries
						return {
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockResolvedValue([aggregate]),
							}),
						};
					}),
				})),
			};

			return mockDb as unknown as Database;
		}

		it("throws LEDGER_USER_NOT_FOUND when userId is empty", async () => {
			const mockDb = {} as Database;
			await expect(
				getLedgerAccountBalance({
					db: mockDb,
					userId: "",
					accountId: "acc-1",
				}),
			).rejects.toThrow("User ID is required");
		});

		it("throws LEDGER_ACCOUNT_NOT_FOUND when account is missing or not owned by user", async () => {
			const mockDb = createMockBalanceDb({ account: null });
			await expect(
				getLedgerAccountBalance({
					db: mockDb,
					userId: "user-1",
					accountId: "nonexistent-acc",
				}),
			).rejects.toThrow('Account "nonexistent-acc" not found for this user');
		});

		it("calculates exact DEBIT normal balance (debit - credit) for ASSET and EXPENSE", async () => {
			const mockDb = createMockBalanceDb({
				account: {
					id: "acc-asset-1",
					userId: "user-1",
					normalBalance: "DEBIT",
					currency: "TRY",
				},
				aggregate: {
					debitSum: "500.00",
					creditSum: "150.25",
				},
			});

			const result = await getLedgerAccountBalance({
				db: mockDb,
				userId: "user-1",
				accountId: "acc-asset-1",
			});

			expect(result).toEqual({
				accountId: "acc-asset-1",
				currency: "TRY",
				normalBalance: "DEBIT",
				balance: "349.75",
				asOf: null,
			});
		});

		it("calculates exact CREDIT normal balance (credit - debit) for LIABILITY, EQUITY, and INCOME", async () => {
			const mockDb = createMockBalanceDb({
				account: {
					id: "acc-liab-1",
					userId: "user-1",
					normalBalance: "CREDIT",
					currency: "TRY",
				},
				aggregate: {
					debitSum: "100.00",
					creditSum: "350.50",
				},
			});

			const result = await getLedgerAccountBalance({
				db: mockDb,
				userId: "user-1",
				accountId: "acc-liab-1",
			});

			expect(result).toEqual({
				accountId: "acc-liab-1",
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "250.50",
				asOf: null,
			});
		});

		it("formats negative contra-balance correctly (e.g. overdrawn asset)", async () => {
			const mockDb = createMockBalanceDb({
				account: {
					id: "acc-asset-1",
					userId: "user-1",
					normalBalance: "DEBIT",
					currency: "TRY",
				},
				aggregate: {
					debitSum: "100.00",
					creditSum: "150.00",
				},
			});

			const result = await getLedgerAccountBalance({
				db: mockDb,
				userId: "user-1",
				accountId: "acc-asset-1",
			});

			expect(result.balance).toBe("-50.00");
		});

		it("returns asOf ISO string when asOf Date is provided", async () => {
			const asOf = new Date("2026-09-02T23:59:59Z");
			const mockDb = createMockBalanceDb();

			const result = await getLedgerAccountBalance({
				db: mockDb,
				userId: "user-1",
				accountId: "acc-asset-1",
				asOf,
			});

			expect(result.asOf).toBe("2026-09-02T23:59:59.000Z");
		});
	});

	describe("listLedgerAccountBalances", () => {
		it("lists balances for multiple accounts ordered by code", async () => {
			const mockAccounts = [
				{
					id: "acc-1",
					code: "ASSET_BANK",
					name: "Bank",
					accountType: "ASSET",
					normalBalance: "DEBIT",
					currency: "TRY",
					archivedAt: null,
				},
				{
					id: "acc-2",
					code: "EXPENSE_FOOD",
					name: "Food",
					accountType: "EXPENSE",
					normalBalance: "DEBIT",
					currency: "TRY",
					archivedAt: null,
				},
			];

			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						if (table === ledgerAccounts) {
							return {
								where: vi.fn().mockReturnValue({
									orderBy: vi.fn().mockResolvedValue(mockAccounts),
								}),
							};
						}
						// Aggregated lines
						return {
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockReturnValue({
									groupBy: vi.fn().mockResolvedValue([
										{
											accountId: "acc-1",
											debitSum: "1000.00",
											creditSum: "200.00",
										},
										{
											accountId: "acc-2",
											debitSum: "200.00",
											creditSum: "0.00",
										},
									]),
								}),
							}),
						};
					}),
				})),
			} as unknown as Database;

			const result = await listLedgerAccountBalances({
				db: mockDb,
				userId: "user-1",
			});

			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				accountId: "acc-1",
				code: "ASSET_BANK",
				name: "Bank",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				balance: "800.00",
			});
			expect(result[1]).toEqual({
				accountId: "acc-2",
				code: "EXPENSE_FOOD",
				name: "Food",
				accountType: "EXPENSE",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				balance: "200.00",
			});
		});
	});
});
