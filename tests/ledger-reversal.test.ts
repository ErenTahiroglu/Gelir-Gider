import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { journalEntries, journalLines } from "../src/db/schema/ledger";
import {
	calculateReversalFingerprint,
	reverseJournalEntry,
} from "../src/ledger/reversal";

describe("Ledger Reversal Service (Phase 4B)", () => {
	describe("calculateReversalFingerprint", () => {
		it("generates deterministic SHA-256 64 lowercase hex fingerprint with ledger-reversal-v1 tag", async () => {
			const occurredAt = new Date("2026-09-03T12:00:00Z");
			const params = {
				userId: "user-1",
				originalEntryId: "orig-1",
				occurredAt,
				currency: "TRY",
				memo: "Reversal memo",
				lines: [
					{
						accountId: "acc-1",
						side: "DEBIT" as const,
						amountNormalized: "100.00",
						memo: "Line 1",
					},
					{
						accountId: "acc-2",
						side: "CREDIT" as const,
						amountNormalized: "100.00",
						memo: null,
					},
				],
			};

			const fp1 = await calculateReversalFingerprint(params);
			const fp2 = await calculateReversalFingerprint(params);

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).toBe(fp2);

			const fpDifferent = await calculateReversalFingerprint({
				...params,
				memo: "Different memo",
			});
			expect(fpDifferent).not.toBe(fp1);
		});
	});

	describe("reverseJournalEntry Input Validation", () => {
		const mockDb = {} as Database;

		it("throws LEDGER_USER_NOT_FOUND when userId is missing", async () => {
			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "",
					originalEntryId: "orig-1",
					idempotencyKey: "rev-key-1",
					occurredAt: new Date(),
				}),
			).rejects.toThrow("User ID is required");
		});

		it("throws LEDGER_ENTRY_NOT_FOUND when originalEntryId is missing", async () => {
			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "",
					idempotencyKey: "rev-key-1",
					occurredAt: new Date(),
				}),
			).rejects.toThrow("Original entry ID is required");
		});

		it("throws LEDGER_INVALID_ENTRY on invalid idempotency key or occurredAt Date", async () => {
			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "orig-1",
					idempotencyKey: "",
					occurredAt: new Date(),
				}),
			).rejects.toThrow("Idempotency key must be between 1 and 128 characters");

			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "orig-1",
					idempotencyKey: "rev-key-1",
					occurredAt: new Date("invalid"),
				}),
			).rejects.toThrow("Valid occurredAt Date is required for reversal");
		});

		it("throws LEDGER_INVALID_ENTRY when memo exceeds 500 characters", async () => {
			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "orig-1",
					idempotencyKey: "rev-key-1",
					occurredAt: new Date(),
					memo: "a".repeat(501),
				}),
			).rejects.toThrow("Memo must not exceed 500 characters");
		});
	});

	describe("reverseJournalEntry Transaction Execution", () => {
		function createMockReversalDb({
			originalEntry = {
				id: "orig-entry-id",
				userId: "user-1",
				currency: "TRY",
				status: "POSTED",
			} as Record<string, unknown> | null,
			originalLines = [
				{
					lineNo: 1,
					accountId: "acc-expense",
					debit: "150.00",
					credit: "0.00",
					memo: "Food",
				},
				{
					lineNo: 2,
					accountId: "acc-liability",
					debit: "0.00",
					credit: "150.00",
					memo: "Card",
				},
			] as Record<string, unknown>[],
			existingReversalOfTarget = null as Record<string, unknown> | null,
			existingEarlyEntry = null as Record<string, unknown> | null,
			draftInsertConflict = false,
		} = {}) {
			let journalQueryIndex = 0;

			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						if (table === journalLines) {
							const execute = async () => originalLines;
							return {
								where: vi.fn().mockReturnValue({
									orderBy: vi.fn().mockImplementation(execute),
								}),
							};
						}
						if (table === journalEntries) {
							journalQueryIndex++;
							const qIdx = journalQueryIndex;

							const execute = async () => {
								if (qIdx === 1) {
									return existingEarlyEntry ? [existingEarlyEntry] : [];
								}
								if (qIdx === 2) {
									return originalEntry ? [originalEntry] : [];
								}
								if (qIdx === 3) {
									return existingReversalOfTarget
										? [existingReversalOfTarget]
										: [];
								}
								return existingEarlyEntry ? [existingEarlyEntry] : [];
							};

							const retObj: Record<string, unknown> = {};
							retObj.where = vi.fn().mockReturnValue(retObj);
							retObj.for = vi.fn().mockReturnValue(retObj);
							retObj.limit = vi.fn().mockImplementation(execute);
							return retObj;
						}
						return {};
					}),
				})),

				insert: vi.fn().mockImplementation(() => ({
					values: vi.fn().mockImplementation(() => ({
						onConflictDoNothing: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue(
								draftInsertConflict
									? []
									: [
											{
												id: "rev-new-id",
												userId: "user-1",
												status: "DRAFT",
												reversalOfEntryId: originalEntry?.id,
											},
										],
							),
						}),
						returning: vi.fn().mockResolvedValue([]),
					})),
				})),

				update: vi.fn().mockImplementation(() => ({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "rev-new-id",
									userId: "user-1",
									status: "POSTED",
									postedAt: new Date(),
									reversalOfEntryId: originalEntry?.id,
								},
							]),
						}),
					}),
				})),
			};

			return {
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
				mockTx,
			};
		}

		it("throws LEDGER_ENTRY_NOT_FOUND if original entry does not exist", async () => {
			const { transaction } = createMockReversalDb({ originalEntry: null });
			const mockDb = { transaction } as unknown as Database;

			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "nonexistent-id",
					idempotencyKey: "rev-1",
					occurredAt: new Date(),
				}),
			).rejects.toThrow('Original journal entry "nonexistent-id" not found');
		});

		it("throws LEDGER_INVALID_REVERSAL if original entry is in DRAFT status", async () => {
			const { transaction } = createMockReversalDb({
				originalEntry: {
					id: "draft-orig-id",
					userId: "user-1",
					currency: "TRY",
					status: "DRAFT",
				},
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "draft-orig-id",
					idempotencyKey: "rev-1",
					occurredAt: new Date(),
				}),
			).rejects.toThrow('Cannot reverse journal entry in "DRAFT" status');
		});

		it("throws LEDGER_ALREADY_REVERSED if original entry has already been reversed", async () => {
			const { transaction } = createMockReversalDb({
				existingReversalOfTarget: { id: "prior-reversal-id" },
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "orig-entry-id",
					idempotencyKey: "rev-new",
					occurredAt: new Date(),
				}),
			).rejects.toThrow("has already been reversed by entry");
		});

		it("creates exact inverse journal entry and transitions to POSTED", async () => {
			const { transaction, mockTx } = createMockReversalDb();
			const mockDb = { transaction } as unknown as Database;

			const result = await reverseJournalEntry({
				db: mockDb,
				userId: "user-1",
				originalEntryId: "orig-entry-id",
				idempotencyKey: "rev-idem-001",
				occurredAt: new Date("2026-09-03T15:00:00Z"),
				memo: "Correction for wrong dining entry",
			});

			expect(result).toEqual({
				entryId: "rev-new-id",
				reversalOfEntryId: "orig-entry-id",
				idempotentReplay: false,
				currency: "TRY",
				debitTotal: "150.00",
				creditTotal: "150.00",
				lineCount: 2,
			});

			expect(mockTx.insert).toHaveBeenCalledTimes(2); // DRAFT entry + inverted lines
			expect(mockTx.update).toHaveBeenCalledTimes(1); // DRAFT -> POSTED
		});

		it("replays existing reversal when exact same request is retried (idempotentReplay = true)", async () => {
			const occurredAt = new Date("2026-09-03T15:00:00Z");
			const reversedLines = [
				{
					accountId: "acc-expense",
					side: "CREDIT" as const,
					amountNormalized: "150.00",
					memo: "Food",
				},
				{
					accountId: "acc-liability",
					side: "DEBIT" as const,
					amountNormalized: "150.00",
					memo: "Card",
				},
			];
			const fingerprint = await calculateReversalFingerprint({
				userId: "user-1",
				originalEntryId: "orig-entry-id",
				occurredAt,
				currency: "TRY",
				memo: "Reversal replay",
				lines: reversedLines,
			});

			const { transaction, mockTx } = createMockReversalDb({
				existingEarlyEntry: {
					id: "existing-rev-id",
					userId: "user-1",
					idempotencyKey: "rev-retry-key",
					reversalOfEntryId: "orig-entry-id",
					postingFingerprint: fingerprint,
					status: "POSTED",
					currency: "TRY",
				},
			});
			const mockDb = { transaction } as unknown as Database;

			const result = await reverseJournalEntry({
				db: mockDb,
				userId: "user-1",
				originalEntryId: "orig-entry-id",
				idempotencyKey: "rev-retry-key",
				occurredAt,
				memo: "Reversal replay",
			});

			expect(result).toEqual({
				entryId: "existing-rev-id",
				reversalOfEntryId: "orig-entry-id",
				idempotentReplay: true,
				currency: "TRY",
				debitTotal: "150.00",
				creditTotal: "150.00",
				lineCount: 2,
			});

			expect(mockTx.insert).not.toHaveBeenCalled();
		});

		it("throws LEDGER_IDEMPOTENCY_CONFLICT when same key is submitted with different payload", async () => {
			const { transaction } = createMockReversalDb({
				existingEarlyEntry: {
					id: "existing-rev-id",
					userId: "user-1",
					idempotencyKey: "rev-conflict-key",
					reversalOfEntryId: "orig-entry-id",
					postingFingerprint:
						"0000000000000000000000000000000000000000000000000000000000000000",
					status: "POSTED",
					currency: "TRY",
				},
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				reverseJournalEntry({
					db: mockDb,
					userId: "user-1",
					originalEntryId: "orig-entry-id",
					idempotencyKey: "rev-conflict-key",
					occurredAt: new Date("2026-09-03T15:00:00Z"),
					memo: "Changed memo",
				}),
			).rejects.toThrow(
				"Idempotency key already used with different reversal payload",
			);
		});
	});
});
