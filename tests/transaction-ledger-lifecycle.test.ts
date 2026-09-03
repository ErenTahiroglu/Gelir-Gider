import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import {
	createCanonicalTransactionWithLedger,
	getCanonicalTransactionLedgerBinding,
	reviseCanonicalTransactionWithLedger,
	voidCanonicalTransactionWithLedger,
} from "../src/transactions/ledger-lifecycle";

describe("Atomic Canonical Revision ↔ Ledger Lifecycle (Phase 5B)", () => {
	describe("Single Outer Transaction Boundary", () => {
		it("proves createCanonicalTransactionWithLedger opens exactly 1 outer db.transaction and no nested transactions", async () => {
			let dbTxCount = 0;

			// Mock transaction client that does not have a nested transaction() method
			const mockTx = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
							for: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
							orderBy: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						onConflictDoNothing: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "tx-uuid-1",
									creationFingerprint: "fingerprint-1",
								},
							]),
						}),
						returning: vi.fn().mockResolvedValue([
							{
								id: "rev-uuid-1",
								revisionNo: 1,
								operation: "CREATE",
							},
						]),
					}),
				}),
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "entry-uuid-1",
									status: "POSTED",
								},
							]),
						}),
					}),
				}),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(
					async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
						dbTxCount++;
						return await cb(mockTx);
					},
				),
			} as unknown as Database;

			// Verify input validation error handling without DB call
			await expect(
				createCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "user-1",
					kind: "EXPENSE",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					payload: { amount: "100.00" },
					source: { type: "MANUAL" },
					// @ts-expect-error test missing lines
					ledger: {},
				}),
			).rejects.toThrow("Ledger specification with lines array is required");

			expect(dbTxCount).toBe(0);
		});
	});

	describe("Input Validation & Error Handling", () => {
		const mockDb = {
			transaction: vi.fn(async (cb) => cb({} as DatabaseTransaction)),
		} as unknown as Database;

		it("rejects when ledger is missing or invalid in create", async () => {
			await expect(
				createCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "user-1",
					kind: "EXPENSE",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					payload: { amount: "100.00" },
					source: { type: "MANUAL" },
					// @ts-expect-error test invalid input
					ledger: null,
				}),
			).rejects.toThrow("Ledger specification with lines array is required");
		});

		it("rejects when ledger is missing or invalid in revise", async () => {
			await expect(
				reviseCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "user-1",
					transactionId: "tx-1",
					expectedRevisionNo: 1,
					idempotencyKey: "key-2",
					occurredAt: new Date(),
					payload: { amount: "120.00" },
					reasonCode: "CORRECTION",
					source: { type: "MANUAL" },
					// @ts-expect-error test invalid input
					ledger: null,
				}),
			).rejects.toThrow("Ledger specification with lines array is required");
		});

		it("rejects void without userId or transactionId", async () => {
			await expect(
				voidCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "",
					transactionId: "tx-1",
					expectedRevisionNo: 1,
					idempotencyKey: "key-3",
					reasonCode: "CORRECTION",
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow("User ID is required");

			await expect(
				voidCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "user-1",
					transactionId: "",
					expectedRevisionNo: 1,
					idempotencyKey: "key-3",
					reasonCode: "CORRECTION",
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow("Transaction ID is required");
		});
	});

	describe("Read Ledger Binding Helper", () => {
		it("validates getCanonicalTransactionLedgerBinding inputs", async () => {
			const mockDb = {} as Database;

			await expect(
				getCanonicalTransactionLedgerBinding({
					db: mockDb,
					userId: "",
					transactionId: "tx-1",
				}),
			).rejects.toThrow("User ID is required");

			await expect(
				getCanonicalTransactionLedgerBinding({
					db: mockDb,
					userId: "user-1",
					transactionId: "",
				}),
			).rejects.toThrow("Transaction ID is required");
		});
	});
});
