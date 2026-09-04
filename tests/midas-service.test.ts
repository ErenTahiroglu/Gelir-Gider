import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { MidasError } from "../src/midas/errors";
import {
	createMidasAccount,
	createMidasAllocationTransfer,
	createMidasBucket,
	getMidasLiquidityState,
	getMidasLiquidityStateInTransaction,
	reverseMidasAllocationTransfer,
} from "../src/midas/service";

describe("Midas Service Input Validations & Error Contracts (Phase 8A / R2)", () => {
	const mockTx = {
		select: vi.fn(),
		insert: vi.fn(),
	} as unknown as DatabaseTransaction;

	const mockDb = {
		transaction: vi.fn(async (cb: (tx: DatabaseTransaction) => unknown) => {
			return await cb(mockTx);
		}),
	} as unknown as Database;

	describe("createMidasAccount input validation & exact replay", () => {
		it("rejects empty userId", async () => {
			await expect(
				createMidasAccount({
					db: mockDb,
					userId: "",
					ledgerAccountId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_INPUT",
			});
		});

		it("returns existing Midas account immediately without mutable revalidation (exact replay first)", async () => {
			const existingRecord = {
				id: "99999999-9999-4999-8999-999999999999",
				userId: "11111111-1111-4111-8111-111111111111",
				ledgerAccountId: "22222222-2222-4222-8222-222222222222",
				createdAt: new Date(),
			};

			const mockDbWithExisting = {
				select: vi
					.fn()
					// 1. User existence
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "11111111-1111-4111-8111-111111111111",
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 2. Existing Midas account (checked FIRST)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([existingRecord]),
							}),
						}),
					}),
			} as unknown as Database;

			const result = await createMidasAccount({
				db: mockDbWithExisting,
				userId: "11111111-1111-4111-8111-111111111111",
				ledgerAccountId: "22222222-2222-4222-8222-222222222222",
			});

			expect(result).toEqual(existingRecord);
			// Only 2 queries executed (user + existing midas account); no mutable ledger account revalidation
			expect(mockDbWithExisting.select).toHaveBeenCalledTimes(2);
		});

		it("throws MIDAS_ACCOUNT_CONFLICT if user already has a Midas account linked to a different ledger account", async () => {
			const mockDbWithDiffLink = {
				select: vi
					.fn()
					// 1. User existence
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "11111111-1111-4111-8111-111111111111",
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 2. Existing Midas account for user linked to diff ledger account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "99999999-9999-4999-8999-999999999999",
										userId: "11111111-1111-4111-8111-111111111111",
										ledgerAccountId: "33333333-3333-4333-8333-333333333333",
										createdAt: new Date(),
									},
								]),
							}),
						}),
					}),
			} as unknown as Database;

			await expect(
				createMidasAccount({
					db: mockDbWithDiffLink,
					userId: "11111111-1111-4111-8111-111111111111",
					ledgerAccountId: "22222222-2222-4222-8222-222222222222",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_ACCOUNT_CONFLICT",
			});
		});

		it("rejects linking a ledger account with negative physical balance during preflight", async () => {
			const mockDbWithNegBalance = {
				select: vi
					.fn()
					// 1. User
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "11111111-1111-4111-8111-111111111111",
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 2. Existing Midas account for user (null)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					})
					// 3. Ledger Account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "22222222-2222-4222-8222-222222222222",
										userId: "11111111-1111-4111-8111-111111111111",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										archivedAt: null,
									},
								]),
							}),
						}),
					})
					// 4. Physical Balance query: netDebit = -50.00
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockResolvedValue([
									{
										netDebit: "-50.00",
									},
								]),
							}),
						}),
					}),
			} as unknown as Database;

			await expect(
				createMidasAccount({
					db: mockDbWithNegBalance,
					userId: "11111111-1111-4111-8111-111111111111",
					ledgerAccountId: "22222222-2222-4222-8222-222222222222",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_LEDGER_ACCOUNT_INVALID",
			});
		});

		it("maps DB trigger error during insert to MIDAS_LEDGER_ACCOUNT_INVALID", async () => {
			const triggerErr = new Error(
				"Cannot link Midas account to ledger account 22222222-2222-4222-8222-222222222222 with negative physical balance (-1.00)",
			);
			(triggerErr as unknown as { cause: { message: string } }).cause = {
				message:
					"Cannot link Midas account to ledger account 22222222-2222-4222-8222-222222222222 with negative physical balance (-1.00)",
			};

			const mockDbWithInsertTriggerErr = {
				select: vi
					.fn()
					// 1. User
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "11111111-1111-4111-8111-111111111111",
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 2. Existing Midas account (null)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					})
					// 3. Ledger Account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "22222222-2222-4222-8222-222222222222",
										userId: "11111111-1111-4111-8111-111111111111",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										archivedAt: null,
									},
								]),
							}),
						}),
					})
					// 4. Physical Balance query: netDebit = 0.00 (passes preflight)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockResolvedValue([
									{
										netDebit: "0.00",
									},
								]),
							}),
						}),
					})
					// 5. Existing ledger link check
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						onConflictDoNothing: vi.fn().mockReturnValue({
							returning: vi.fn().mockRejectedValue(triggerErr),
						}),
					}),
				}),
			} as unknown as Database;

			await expect(
				createMidasAccount({
					db: mockDbWithInsertTriggerErr,
					userId: "11111111-1111-4111-8111-111111111111",
					ledgerAccountId: "22222222-2222-4222-8222-222222222222",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_LEDGER_ACCOUNT_INVALID",
			});
		});
	});

	describe("createMidasBucket input validation", () => {
		it("rejects invalid bucket codes", async () => {
			await expect(
				createMidasBucket({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					code: "invalid-code",
					name: "Valid Name",
					bucketType: "SHORT_TERM_GOAL",
				}),
			).rejects.toThrowError(MidasError);
		});
	});

	describe("createMidasAllocationTransfer input validation", () => {
		it("rejects invalid idempotency keys", async () => {
			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "   ",
					fromBucketId: null,
					toBucketId: "33333333-3333-4333-8333-333333333333",
					amount: "10.00",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);
		});
	});

	describe("reverseMidasAllocationTransfer input validation", () => {
		it("rejects empty targetTransferId", async () => {
			await expect(
				reverseMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					idempotencyKey: "k-rev",
					targetTransferId: "",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);
		});
	});

	describe("getMidasLiquidityState & getMidasLiquidityStateInTransaction", () => {
		it("executes exactly one outer db.transaction and supplies tx with no nested transaction method", async () => {
			let txSupplied: unknown = null;
			const txMock = {
				select: vi
					.fn()
					// 1. Midas Account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([
										{
											id: "22222222-2222-4222-8222-222222222222",
											userId: "11111111-1111-4111-8111-111111111111",
											ledgerAccountId: "33333333-3333-4333-8333-333333333333",
										},
									]),
								}),
							}),
						}),
					})
					// 2. Ledger Currency
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 3. Physical Balance query
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockResolvedValue([
									{
										netDebit: "1000.00",
									},
								]),
							}),
						}),
					})
					// 4. Buckets
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								orderBy: vi.fn().mockResolvedValue([
									{
										id: "b1",
										code: "GOAL",
										name: "Goal Bucket",
										bucketType: "SHORT_TERM_GOAL",
									},
								]),
							}),
						}),
					})
					// 5. Transfers
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([
								{
									fromBucketId: null,
									toBucketId: "b1",
									amount: "300.00",
								},
							]),
						}),
					}),
			};

			const mockDatabase = {
				transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
					txSupplied = txMock;
					return await cb(txMock);
				}),
			} as unknown as Database;

			const result = await getMidasLiquidityState({
				db: mockDatabase,
				userId: "11111111-1111-4111-8111-111111111111",
			});

			expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
			expect(txSupplied).toBeDefined();
			expect("transaction" in (txSupplied as Record<string, unknown>)).toBe(
				false,
			);
			expect(result.physicalBalance).toBe("1000.00");
			expect(result.totalEarmarked).toBe("300.00");
			expect(result.unallocatedBalance).toBe("700.00");
			expect(result.buckets[0]?.balance).toBe("300.00");
		});

		it("proves getMidasLiquidityStateInTransaction executes FOR UPDATE lock", async () => {
			const forMock = vi.fn().mockReturnValue({
				limit: vi.fn().mockResolvedValue([]),
			});
			const txMock = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							for: forMock,
						}),
					}),
				}),
			} as unknown as DatabaseTransaction;

			await expect(
				getMidasLiquidityStateInTransaction({
					tx: txMock,
					userId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_ACCOUNT_NOT_FOUND",
			});

			expect(forMock).toHaveBeenCalledWith("update");
		});

		it("rejects empty userId", async () => {
			await expect(
				getMidasLiquidityState({
					db: mockDb,
					userId: "",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_INPUT",
			});
		});

		it("throws MIDAS_INVALID_STATE if impossible negative physical balance is encountered", async () => {
			const txMock = {
				select: vi
					.fn()
					// 1. Midas Account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([
										{
											id: "22222222-2222-4222-8222-222222222222",
											userId: "11111111-1111-4111-8111-111111111111",
											ledgerAccountId: "33333333-3333-4333-8333-333333333333",
										},
									]),
								}),
							}),
						}),
					})
					// 2. Ledger Account Currency
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 3. Physical Balance query: netDebit = -10.00
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockResolvedValue([
									{
										netDebit: "-10.00",
									},
								]),
							}),
						}),
					}),
			};

			const mockDbWithNegPhysical = {
				transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
					return await cb(txMock);
				}),
			} as unknown as Database;

			await expect(
				getMidasLiquidityState({
					db: mockDbWithNegPhysical,
					userId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_STATE",
			});
		});

		it("throws MIDAS_INVALID_STATE when sum of bucket balances diverges from total earmarked (Defect C)", async () => {
			const txMock = {
				select: vi
					.fn()
					// 1. Midas Account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([
										{
											id: "22222222-2222-4222-8222-222222222222",
											userId: "11111111-1111-4111-8111-111111111111",
											ledgerAccountId: "33333333-3333-4333-8333-333333333333",
										},
									]),
								}),
							}),
						}),
					})
					// 2. Ledger Account Currency
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										currency: "TRY",
									},
								]),
							}),
						}),
					})
					// 3. Physical Balance query
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							innerJoin: vi.fn().mockReturnValue({
								where: vi.fn().mockResolvedValue([
									{
										netDebit: "1000.00",
									},
								]),
							}),
						}),
					})
					// 4. Buckets: only b1 is returned
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								orderBy: vi.fn().mockResolvedValue([
									{
										id: "b1",
										code: "GOAL",
										name: "Goal Bucket",
										bucketType: "SHORT_TERM_GOAL",
									},
								]),
							}),
						}),
					})
					// 5. Transfers: contains earmark to deleted/missing bucket b2, causing sum of bucket balances (100) != total earmarked (300)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([
								{
									fromBucketId: null,
									toBucketId: "b1",
									amount: "100.00",
								},
								{
									fromBucketId: null,
									toBucketId: "b2-missing",
									amount: "200.00",
								},
							]),
						}),
					}),
			};

			const mockDbWithDivergentSum = {
				transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
					return await cb(txMock);
				}),
			} as unknown as Database;

			await expect(
				getMidasLiquidityState({
					db: mockDbWithDivergentSum,
					userId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_STATE",
			});
		});
	});

	describe("Midas Goal Trigger Error Trapping Helpers (Phase 9)", () => {
		it("detects goal inactive db error messages across cause chain", async () => {
			const { isMidasBucketInactiveDbError } = await import(
				"../src/midas/utils"
			);

			const directErr = new Error(
				'Cannot transfer funds into short-term goal bucket "b1" because goal is in "COMPLETED" status (must be ACTIVE)',
			);
			expect(isMidasBucketInactiveDbError(directErr)).toBe(true);

			const nestedErr = {
				message: "DrizzleQueryError",
				cause: {
					message: "Database error",
					detail:
						'Cannot transfer funds into short-term goal bucket "b2" because goal is in "CANCELLED" status (must be ACTIVE)',
				},
			};
			expect(isMidasBucketInactiveDbError(nestedErr)).toBe(true);

			expect(isMidasBucketInactiveDbError(new Error("Other error"))).toBe(
				false,
			);
		});

		it("detects goal max budget cap exceeded db error messages across cause chain", async () => {
			const { isMidasBucketCapExceededDbError } = await import(
				"../src/midas/utils"
			);

			const directErr = new Error(
				"Transfer amount 500.00 exceeds short-term goal max budget 1000.00 (current accumulated: 600.00)",
			);
			expect(isMidasBucketCapExceededDbError(directErr)).toBe(true);

			const nestedErr = {
				message: "DrizzleQueryError",
				cause: {
					detail:
						"Transfer amount 100.00 exceeds short-term goal max budget 500.00",
				},
			};
			expect(isMidasBucketCapExceededDbError(nestedErr)).toBe(true);

			expect(isMidasBucketCapExceededDbError(new Error("Other error"))).toBe(
				false,
			);
		});
	});

	describe("lockMidasAllocationStateInTransaction", () => {
		it("locks ledger_accounts FOR UPDATE then midas_accounts FOR UPDATE in strict order", async () => {
			const { lockMidasAllocationStateInTransaction } = await import(
				"../src/midas/service"
			);

			const callOrder: string[] = [];
			const mockTxLock = {
				select: vi.fn((_fields: unknown) => ({
					from: vi.fn((_table: unknown) => ({
						where: vi.fn((_clause: unknown) => ({
							limit: vi.fn(async () => {
								callOrder.push("resolve_midas_identity_no_lock");
								return [
									{
										id: "99999999-9999-4999-8999-999999999999",
										userId: "11111111-1111-4111-8111-111111111111",
										ledgerAccountId: "22222222-2222-4222-8222-222222222222",
									},
								];
							}),
							for: vi.fn((_mode: string) => ({
								limit: vi.fn(async () => {
									// Determine whether ledger_accounts or midas_accounts was called
									if (
										callOrder.filter((c) => c === "lock_ledger_accounts")
											.length === 0
									) {
										callOrder.push("lock_ledger_accounts");
										return [
											{
												id: "22222222-2222-4222-8222-222222222222",
												userId: "11111111-1111-4111-8111-111111111111",
											},
										];
									}
									callOrder.push("lock_midas_accounts");
									return [
										{
											id: "99999999-9999-4999-8999-999999999999",
											userId: "11111111-1111-4111-8111-111111111111",
											ledgerAccountId: "22222222-2222-4222-8222-222222222222",
										},
									];
								}),
							})),
						})),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const result = await lockMidasAllocationStateInTransaction({
				tx: mockTxLock,
				userId: "11111111-1111-4111-8111-111111111111",
				midasAccountId: "99999999-9999-4999-8999-999999999999",
			});

			expect(result.midasAccountId).toBe(
				"99999999-9999-4999-8999-999999999999",
			);
			expect(result.ledgerAccountId).toBe(
				"22222222-2222-4222-8222-222222222222",
			);
			expect(callOrder).toEqual([
				"resolve_midas_identity_no_lock",
				"lock_ledger_accounts",
				"lock_midas_accounts",
			]);
		});
	});
});
