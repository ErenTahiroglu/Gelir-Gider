import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { MidasError } from "../src/midas/errors";
import {
	createMidasAccount,
	createMidasAllocationTransfer,
	createMidasBucket,
	getMidasLiquidityState,
	reverseMidasAllocationTransfer,
} from "../src/midas/service";

describe("Midas Service Input Validations & Error Contracts (Phase 8A)", () => {
	const mockDb = {} as unknown as Database;

	describe("createMidasAccount input validation", () => {
		it("rejects empty userId", async () => {
			await expect(
				createMidasAccount({
					db: mockDb,
					userId: "",
					ledgerAccountId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects non-UUID userId", async () => {
			await expect(
				createMidasAccount({
					db: mockDb,
					userId: "not-a-valid-uuid",
					ledgerAccountId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_INPUT",
			});
		});

		it("rejects empty ledgerAccountId", async () => {
			await expect(
				createMidasAccount({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					ledgerAccountId: "",
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects non-UUID ledgerAccountId", async () => {
			await expect(
				createMidasAccount({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					ledgerAccountId: "invalid-account-uuid",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_INPUT",
			});
		});

		it("rejects linking a ledger account with negative physical balance", async () => {
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
					// 2. Ledger Account
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
					// 3. Physical Balance query: netDebit = -50.00
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

			await expect(
				createMidasBucket({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					code: "123_STARTS_WITH_NUMBER",
					name: "Valid Name",
					bucketType: "SHORT_TERM_GOAL",
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects empty or oversized names", async () => {
			await expect(
				createMidasBucket({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					code: "VALID_CODE",
					name: "   ",
					bucketType: "SHORT_TERM_GOAL",
				}),
			).rejects.toThrowError(MidasError);

			await expect(
				createMidasBucket({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					code: "VALID_CODE",
					name: "A".repeat(121),
					bucketType: "SHORT_TERM_GOAL",
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects invalid bucket types (including UNALLOCATED as stored bucket)", async () => {
			await expect(
				createMidasBucket({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					code: "UNALLOCATED_BUCKET",
					name: "Unallocated Bucket",
					bucketType:
						"UNALLOCATED" as unknown as typeof import("../src/db/schema/midas").MIDAS_BUCKET_TYPES[number],
				}),
			).rejects.toThrowError(MidasError);
		});
	});

	describe("createMidasAllocationTransfer input validation", () => {
		it("rejects transfer when both from and to buckets are null", async () => {
			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "k1",
					fromBucketId: null,
					toBucketId: null,
					amount: "100.00",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects transfer when from and to buckets are identical", async () => {
			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "k1",
					fromBucketId: "33333333-3333-4333-8333-333333333333",
					toBucketId: "33333333-3333-4333-8333-333333333333",
					amount: "100.00",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects non-positive amounts", async () => {
			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "k1",
					fromBucketId: null,
					toBucketId: "33333333-3333-4333-8333-333333333333",
					amount: "0.00",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);

			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "k1",
					fromBucketId: null,
					toBucketId: "33333333-3333-4333-8333-333333333333",
					amount: "-10.00",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects invalid idempotency keys", async () => {
			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "",
					fromBucketId: null,
					toBucketId: "33333333-3333-4333-8333-333333333333",
					amount: "100.00",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);

			await expect(
				createMidasAllocationTransfer({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "22222222-2222-4222-8222-222222222222",
					idempotencyKey: "a".repeat(129),
					fromBucketId: null,
					toBucketId: "33333333-3333-4333-8333-333333333333",
					amount: "100.00",
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
					idempotencyKey: "rev-k1",
					targetTransferId: "",
					occurredAt: new Date(),
				}),
			).rejects.toThrowError(MidasError);
		});
	});

	describe("getMidasLiquidityState input validation and consistency invariants", () => {
		it("rejects empty userId", async () => {
			await expect(
				getMidasLiquidityState({
					db: mockDb,
					userId: "",
				}),
			).rejects.toThrowError(MidasError);
		});

		it("rejects non-UUID userId", async () => {
			await expect(
				getMidasLiquidityState({
					db: mockDb,
					userId: "not-a-valid-uuid",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_INPUT",
			});
		});

		it("rejects non-UUID midasAccountId", async () => {
			await expect(
				getMidasLiquidityState({
					db: mockDb,
					userId: "11111111-1111-4111-8111-111111111111",
					midasAccountId: "not-a-valid-uuid",
				}),
			).rejects.toMatchObject({
				code: "MIDAS_INVALID_INPUT",
			});
		});

		it("throws MIDAS_INVALID_STATE if impossible negative physical balance is encountered", async () => {
			const mockDbWithNegPhysical = {
				select: vi
					.fn()
					// 1. Midas Account
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "22222222-2222-4222-8222-222222222222",
										userId: "11111111-1111-4111-8111-111111111111",
										ledgerAccountId: "33333333-3333-4333-8333-333333333333",
									},
								]),
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
	});
});
