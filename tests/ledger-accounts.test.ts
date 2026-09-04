import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import {
	archiveLedgerAccount,
	createLedgerAccount,
	deriveNormalBalance,
} from "../src/ledger/accounts";
import { LedgerError } from "../src/ledger/errors";

describe("Ledger Accounts Service (Phase 4A)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("deriveNormalBalance", () => {
		it("derives DEBIT for ASSET and EXPENSE accounts", () => {
			expect(deriveNormalBalance("ASSET")).toBe("DEBIT");
			expect(deriveNormalBalance("EXPENSE")).toBe("DEBIT");
		});

		it("derives CREDIT for LIABILITY, EQUITY, and INCOME accounts", () => {
			expect(deriveNormalBalance("LIABILITY")).toBe("CREDIT");
			expect(deriveNormalBalance("EQUITY")).toBe("CREDIT");
			expect(deriveNormalBalance("INCOME")).toBe("CREDIT");
		});
	});

	describe("createLedgerAccount", () => {
		it("creates account with derived normal balance and user currency", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi
								.fn()
								.mockResolvedValue([{ id: "user-1", currency: "TRY" }]),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([
							{
								id: "acc-1",
								userId: "user-1",
								code: "ASSET_BANK",
								name: "Garanti Bankasi",
								accountType: "ASSET",
								normalBalance: "DEBIT",
								currency: "TRY",
								createdAt: new Date(),
								archivedAt: null,
							},
						]),
					}),
				}),
			} as unknown as Database;

			const result = await createLedgerAccount({
				db: mockDb,
				userId: "user-1",
				code: "asset_bank", // Should be normalized to uppercase
				name: "Garanti Bankasi",
				accountType: "ASSET",
			});

			expect(result.code).toBe("ASSET_BANK");
			expect(result.normalBalance).toBe("DEBIT");
			expect(result.currency).toBe("TRY");
			expect(result.archivedAt).toBeNull();
		});

		it("throws LEDGER_ACCOUNT_CODE_CONFLICT when code already exists for user", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi
								.fn()
								.mockResolvedValue([{ id: "user-1", currency: "TRY" }]),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi
							.fn()
							.mockRejectedValue(
								new Error(
									'duplicate key value violates unique constraint "ledger_accounts_user_code_idx"',
								),
							),
					}),
				}),
			} as unknown as Database;

			await expect(
				createLedgerAccount({
					db: mockDb,
					userId: "user-1",
					code: "ASSET_BANK",
					name: "Garanti Bankasi",
					accountType: "ASSET",
				}),
			).rejects.toThrowError(LedgerError);
		});

		it("validates code format and rejects invalid formats", async () => {
			const mockDb = {} as Database;

			await expect(
				createLedgerAccount({
					db: mockDb,
					userId: "user-1",
					code: "123_INVALID",
					name: "Test",
					accountType: "ASSET",
				}),
			).rejects.toThrow("Invalid account code format");

			await expect(
				createLedgerAccount({
					db: mockDb,
					userId: "user-1",
					code: "A", // too short (must be >= 2)
					name: "Test",
					accountType: "ASSET",
				}),
			).rejects.toThrow("Invalid account code format");
		});

		it("validates name and rejects empty or oversized names", async () => {
			const mockDb = {} as Database;

			await expect(
				createLedgerAccount({
					db: mockDb,
					userId: "user-1",
					code: "ASSET_TEST",
					name: "   ",
					accountType: "ASSET",
				}),
			).rejects.toThrow("Account name must be between 1 and 100 characters");

			await expect(
				createLedgerAccount({
					db: mockDb,
					userId: "user-1",
					code: "ASSET_TEST",
					name: "a".repeat(101),
					accountType: "ASSET",
				}),
			).rejects.toThrow("Account name must be between 1 and 100 characters");
		});

		it("throws LEDGER_USER_NOT_FOUND when user does not exist", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			} as unknown as Database;

			await expect(
				createLedgerAccount({
					db: mockDb,
					userId: "unknown-user",
					code: "ASSET_BANK",
					name: "Bank",
					accountType: "ASSET",
				}),
			).rejects.toThrow("User does not exist");
		});
	});

	describe("archiveLedgerAccount", () => {
		it("archives an active ledger account", async () => {
			const now = new Date();
			const mockDb = {
				select: vi
					.fn()
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "acc-1",
										userId: "user-1",
										code: "ASSET_OLD",
										name: "Old Account",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										createdAt: now,
										archivedAt: null,
									},
								]),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "acc-1",
									userId: "user-1",
									code: "ASSET_OLD",
									name: "Old Account",
									accountType: "ASSET",
									normalBalance: "DEBIT",
									currency: "TRY",
									createdAt: now,
									archivedAt: now,
								},
							]),
						}),
					}),
				}),
			} as unknown as Database;

			const result = await archiveLedgerAccount({
				db: mockDb,
				userId: "user-1",
				accountId: "acc-1",
			});

			expect(result.archivedAt).toEqual(now);
		});

		it("throws LEDGER_ACCOUNT_IN_USE when account is linked to a Midas account", async () => {
			const now = new Date();
			const mockDb = {
				select: vi
					.fn()
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "acc-1",
										userId: "user-1",
										code: "ASSET_OLD",
										name: "Old Account",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										createdAt: now,
										archivedAt: null,
									},
								]),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "midas-1",
									},
								]),
							}),
						}),
					}),
				update: vi.fn(),
			} as unknown as Database;

			await expect(
				archiveLedgerAccount({
					db: mockDb,
					userId: "user-1",
					accountId: "acc-1",
				}),
			).rejects.toMatchObject({
				code: "LEDGER_ACCOUNT_IN_USE",
			});
			expect(mockDb.update).not.toHaveBeenCalled();
		});

		it("throws LEDGER_ACCOUNT_IN_USE when DB trigger rejects archive due to racing Midas link", async () => {
			const now = new Date();
			const triggerError = new Error(
				"Cannot archive ledger account acc-1 because it is linked to Midas liquidity account midas-1",
			);
			(triggerError as unknown as { cause: { message: string } }).cause = {
				message:
					"Cannot archive ledger account acc-1 because it is linked to Midas liquidity account midas-1",
			};

			const mockDb = {
				select: vi
					.fn()
					// 1. Ledger account lookup
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "acc-1",
										userId: "user-1",
										code: "ASSET_OLD",
										name: "Old Account",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										createdAt: now,
										archivedAt: null,
									},
								]),
							}),
						}),
					})
					// 2. Pre-check sees no Midas link (racing window)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					})
					// 3. Pre-check sees no card link
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					})
					// 4. Pre-check sees no system role link
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockRejectedValue(triggerError),
						}),
					}),
				}),
			} as unknown as Database;

			await expect(
				archiveLedgerAccount({
					db: mockDb,
					userId: "user-1",
					accountId: "acc-1",
				}),
			).rejects.toMatchObject({
				code: "LEDGER_ACCOUNT_IN_USE",
			});
		});

		it("is idempotent when account is already archived", async () => {
			const archivedDate = new Date("2026-01-01T00:00:00Z");
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: "acc-1",
									userId: "user-1",
									code: "ASSET_OLD",
									name: "Old Account",
									accountType: "ASSET",
									normalBalance: "DEBIT",
									currency: "TRY",
									createdAt: new Date(),
									archivedAt: archivedDate,
								},
							]),
						}),
					}),
				}),
				update: vi.fn(),
			} as unknown as Database;

			const result = await archiveLedgerAccount({
				db: mockDb,
				userId: "user-1",
				accountId: "acc-1",
			});

			expect(result.archivedAt).toEqual(archivedDate);
			expect(mockDb.update).not.toHaveBeenCalled();
		});

		it("throws LEDGER_ACCOUNT_NOT_FOUND when account does not exist for user", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			} as unknown as Database;

			await expect(
				archiveLedgerAccount({
					db: mockDb,
					userId: "user-1",
					accountId: "acc-unknown",
				}),
			).rejects.toThrow("Ledger account not found");
		});
	});
});
