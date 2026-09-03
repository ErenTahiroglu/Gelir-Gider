import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import {
	canonicalTransactions,
	journalEntries,
	transactionLedgerBindings,
	transactionRevisions,
} from "../src/db/schema";
import { LedgerError } from "../src/ledger/errors";
import * as ledgerPosting from "../src/ledger/posting";
import * as ledgerReversal from "../src/ledger/reversal";
import {
	createCanonicalTransactionWithLedger,
	getCanonicalTransactionLedgerBinding,
	reviseCanonicalTransactionWithLedger,
	voidCanonicalTransactionWithLedger,
} from "../src/transactions/ledger-lifecycle";
import * as canonicalService from "../src/transactions/service";

describe("Atomic Canonical Revision ↔ Ledger Lifecycle (Phase 5B & 5B-R1)", () => {
	describe("Single Outer Transaction Boundary", () => {
		it("proves successful bound CREATE opens exactly 1 outer db.transaction and no nested transactions", async () => {
			let dbTxCount = 0;

			// Mock transaction client that does NOT have a transaction() method
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
								appliedJournalEntryId: "entry-uuid-1",
								reversalJournalEntryId: null,
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

			// Spy on internal transaction-scoped helpers to verify they receive mockTx and do not open nested transactions
			const createTxSpy = vi
				.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
				.mockResolvedValueOnce({
					transactionId: "tx-uuid-1",
					revisionId: "rev-uuid-1",
					revisionNo: 1,
					operation: "CREATE",
					idempotentReplay: false,
				});

			const postTxSpy = vi
				.spyOn(ledgerPosting, "postJournalEntryInTransaction")
				.mockResolvedValueOnce({
					entryId: "entry-uuid-1",
					currency: "TRY",
					debitTotal: "100.00",
					creditTotal: "100.00",
					lineCount: 2,
					idempotentReplay: false,
				});

			const res = await createCanonicalTransactionWithLedger({
				db: mockDb,
				userId: "user-1",
				kind: "EXPENSE",
				idempotencyKey: "key-1",
				occurredAt: new Date(),
				payload: { amount: "100.00" },
				source: { type: "MANUAL" },
				ledger: {
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "100.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "100.00" },
					],
				},
			});

			expect(dbTxCount).toBe(1);
			expect(createTxSpy).toHaveBeenCalledTimes(1);
			expect(postTxSpy).toHaveBeenCalledTimes(1);
			expect(res).toEqual({
				transactionId: "tx-uuid-1",
				revisionId: "rev-uuid-1",
				revisionNo: 1,
				operation: "CREATE",
				idempotentReplay: false,
				ledger: {
					appliedJournalEntryId: "entry-uuid-1",
					reversalJournalEntryId: null,
				},
			});

			createTxSpy.mockRestore();
			postTxSpy.mockRestore();
		});

		it("proves input validation error rejects before db.transaction is called", async () => {
			let dbTxCount = 0;
			const mockDb = {
				transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
					dbTxCount++;
					return await cb({});
				}),
			} as unknown as Database;

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

	describe("VOID Replay Verification (Phase 5B-R1)", () => {
		it("exercises reverseJournalEntryInTransaction during VOID replay and succeeds when matching", async () => {
			let bindingSelectCount = 0;
			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => ({
						where: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === transactionLedgerBindings) {
									bindingSelectCount++;
									if (bindingSelectCount === 1) {
										// Replayed VOID revision binding
										return Promise.resolve([
											{
												appliedJournalEntryId: null,
												reversalJournalEntryId: "reversal-entry-1",
											},
										]);
									}
									// Previous revision binding (for rev-uuid-1)
									return Promise.resolve([
										{
											appliedJournalEntryId: "applied-entry-1",
											reversalJournalEntryId: null,
										},
									]);
								}
								if (table === transactionRevisions) {
									return Promise.resolve([
										{ previousRevisionId: "rev-uuid-1" },
									]);
								}
								if (table === journalEntries) {
									return Promise.resolve([
										{ occurredAt: new Date("2026-09-01T10:00:00Z") },
									]);
								}
								return Promise.resolve([]);
							}),
						})),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(
					async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
						await cb(mockTx),
				),
			} as unknown as Database;

			const voidTxSpy = vi
				.spyOn(canonicalService, "voidCanonicalTransactionInTransaction")
				.mockResolvedValueOnce({
					transactionId: "tx-uuid-1",
					revisionId: "rev-uuid-2",
					revisionNo: 2,
					operation: "VOID",
					idempotentReplay: true,
				});

			const reverseTxSpy = vi
				.spyOn(ledgerReversal, "reverseJournalEntryInTransaction")
				.mockResolvedValueOnce({
					entryId: "reversal-entry-1",
					reversalOfEntryId: "applied-entry-1",
					currency: "TRY",
					debitTotal: "85.00",
					creditTotal: "85.00",
					lineCount: 2,
					idempotentReplay: true,
				});

			const res = await voidCanonicalTransactionWithLedger({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-uuid-1",
				expectedRevisionNo: 1,
				idempotencyKey: "idem-void-1",
				reasonCode: "ERROR_ENTRY",
				source: { type: "MANUAL" },
			});

			expect(voidTxSpy).toHaveBeenCalledTimes(1);
			expect(reverseTxSpy).toHaveBeenCalledTimes(1);
			expect(res).toEqual({
				transactionId: "tx-uuid-1",
				revisionId: "rev-uuid-2",
				revisionNo: 2,
				operation: "VOID",
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: null,
					reversalJournalEntryId: "reversal-entry-1",
				},
			});

			voidTxSpy.mockRestore();
			reverseTxSpy.mockRestore();
		});

		it("rejects VOID replay when reverseJournalEntryInTransaction throws LEDGER_IDEMPOTENCY_CONFLICT", async () => {
			let bindingSelectCount = 0;
			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => ({
						where: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === transactionLedgerBindings) {
									bindingSelectCount++;
									if (bindingSelectCount === 1) {
										return Promise.resolve([
											{
												appliedJournalEntryId: null,
												reversalJournalEntryId: "reversal-entry-1",
											},
										]);
									}
									return Promise.resolve([
										{
											appliedJournalEntryId: "applied-entry-1",
											reversalJournalEntryId: null,
										},
									]);
								}
								if (table === transactionRevisions) {
									return Promise.resolve([
										{ previousRevisionId: "rev-uuid-1" },
									]);
								}
								if (table === journalEntries) {
									return Promise.resolve([
										{ occurredAt: new Date("2026-09-01T10:00:00Z") },
									]);
								}
								return Promise.resolve([]);
							}),
						})),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(
					async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
						await cb(mockTx),
				),
			} as unknown as Database;

			const voidTxSpy = vi
				.spyOn(canonicalService, "voidCanonicalTransactionInTransaction")
				.mockResolvedValueOnce({
					transactionId: "tx-uuid-1",
					revisionId: "rev-uuid-2",
					revisionNo: 2,
					operation: "VOID",
					idempotentReplay: true,
				});

			const reverseTxSpy = vi
				.spyOn(ledgerReversal, "reverseJournalEntryInTransaction")
				.mockRejectedValueOnce(
					new LedgerError(
						"LEDGER_IDEMPOTENCY_CONFLICT",
						"Reversal fingerprint mismatch",
					),
				);

			await expect(
				voidCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "user-1",
					transactionId: "tx-uuid-1",
					expectedRevisionNo: 1,
					idempotencyKey: "idem-void-1",
					reasonCode: "ERROR_ENTRY",
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow("Reversal fingerprint mismatch");

			voidTxSpy.mockRestore();
			reverseTxSpy.mockRestore();
		});

		it("rejects VOID replay when reversal journal ID does not match binding", async () => {
			let bindingSelectCount = 0;
			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => ({
						where: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === transactionLedgerBindings) {
									bindingSelectCount++;
									if (bindingSelectCount === 1) {
										return Promise.resolve([
											{
												appliedJournalEntryId: null,
												reversalJournalEntryId: "reversal-entry-1",
											},
										]);
									}
									return Promise.resolve([
										{
											appliedJournalEntryId: "applied-entry-1",
											reversalJournalEntryId: null,
										},
									]);
								}
								if (table === transactionRevisions) {
									return Promise.resolve([
										{ previousRevisionId: "rev-uuid-1" },
									]);
								}
								if (table === journalEntries) {
									return Promise.resolve([
										{ occurredAt: new Date("2026-09-01T10:00:00Z") },
									]);
								}
								return Promise.resolve([]);
							}),
						})),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(
					async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
						await cb(mockTx),
				),
			} as unknown as Database;

			const voidTxSpy = vi
				.spyOn(canonicalService, "voidCanonicalTransactionInTransaction")
				.mockResolvedValueOnce({
					transactionId: "tx-uuid-1",
					revisionId: "rev-uuid-2",
					revisionNo: 2,
					operation: "VOID",
					idempotentReplay: true,
				});

			const reverseTxSpy = vi
				.spyOn(ledgerReversal, "reverseJournalEntryInTransaction")
				.mockResolvedValueOnce({
					entryId: "different-entry-id",
					reversalOfEntryId: "applied-entry-1",
					currency: "TRY",
					debitTotal: "85.00",
					creditTotal: "85.00",
					lineCount: 2,
					idempotentReplay: true,
				});

			await expect(
				voidCanonicalTransactionWithLedger({
					db: mockDb,
					userId: "user-1",
					transactionId: "tx-uuid-1",
					expectedRevisionNo: 1,
					idempotencyKey: "idem-void-1",
					reasonCode: "ERROR_ENTRY",
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow("Reversal replay mismatch with existing binding");

			voidTxSpy.mockRestore();
			reverseTxSpy.mockRestore();
		});
	});

	describe("Read Ledger Binding Helper & Cross-Transaction Read Isolation", () => {
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

		it("rejects cross-transaction read when explicit revisionId belongs to another transaction", async () => {
			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => ({
						where: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === canonicalTransactions) {
									return Promise.resolve([{ id: "tx-A" }]);
								}
								if (table === transactionRevisions) {
									// Revision B check for tx-A returns empty (because it belongs to tx-B)
									return Promise.resolve([]);
								}
								return Promise.resolve([]);
							}),
						})),
					})),
				})),
			} as unknown as Database;

			await expect(
				getCanonicalTransactionLedgerBinding({
					db: mockDb,
					userId: "user-1",
					transactionId: "tx-A",
					revisionId: "revision-B",
				}),
			).rejects.toThrow(
				'Revision "revision-B" does not belong to transaction "tx-A"',
			);
		});

		it("successfully reads binding when explicit revisionId belongs to transaction", async () => {
			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => ({
						where: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === canonicalTransactions) {
									return Promise.resolve([{ id: "tx-A" }]);
								}
								if (table === transactionRevisions) {
									return Promise.resolve([{ id: "revision-A" }]);
								}
								if (table === transactionLedgerBindings) {
									return Promise.resolve([
										{
											bindingId: "binding-A",
											transactionId: "tx-A",
											revisionId: "revision-A",
											previousBindingId: null,
											appliedJournalEntryId: "entry-1",
											reversalJournalEntryId: null,
											createdAt: new Date(),
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
					})),
				})),
			} as unknown as Database;

			const result = await getCanonicalTransactionLedgerBinding({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-A",
				revisionId: "revision-A",
			});

			expect(result.bindingId).toBe("binding-A");
			expect(result.transactionId).toBe("tx-A");
			expect(result.revisionId).toBe("revision-A");
			expect(result.appliedJournalEntryId).toBe("entry-1");
		});
	});
});
