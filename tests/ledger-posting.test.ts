import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import { journalEntries, ledgerAccounts } from "../src/db/schema/ledger";
import { LedgerError } from "../src/ledger/errors";
import {
	calculatePostingFingerprint,
	postJournalEntry,
} from "../src/ledger/posting";

describe("Ledger Posting Service (Phase 4A)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("calculatePostingFingerprint", () => {
		it("generates deterministic SHA-256 64 lowercase hex fingerprint", async () => {
			const occurredAt = new Date("2026-09-03T12:00:00Z");
			const fp1 = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: "Grocery",
				source: { type: "MANUAL", ref: "tx-1" },
				lines: [
					{
						accountId: "acc-1",
						side: "DEBIT",
						amountNormalized: "100.50",
						cents: 10050n,
						memo: "Food",
					},
					{
						accountId: "acc-2",
						side: "CREDIT",
						amountNormalized: "100.50",
						cents: 10050n,
						memo: null,
					},
				],
			});

			const fp2 = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: "Grocery",
				source: { type: "MANUAL", ref: "tx-1" },
				lines: [
					{
						accountId: "acc-1",
						side: "DEBIT",
						amountNormalized: "100.50",
						cents: 10050n,
						memo: "Food",
					},
					{
						accountId: "acc-2",
						side: "CREDIT",
						amountNormalized: "100.50",
						cents: 10050n,
						memo: null,
					},
				],
			});

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).toBe(fp2);

			// Changing any field changes the fingerprint
			const fpDifferent = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: "Grocery modified",
				source: { type: "MANUAL", ref: "tx-1" },
				lines: [
					{
						accountId: "acc-1",
						side: "DEBIT",
						amountNormalized: "100.50",
						cents: 10050n,
						memo: "Food",
					},
					{
						accountId: "acc-2",
						side: "CREDIT",
						amountNormalized: "100.50",
						cents: 10050n,
						memo: null,
					},
				],
			});

			expect(fpDifferent).not.toBe(fp1);
		});

		it("prevents delimiter collision between ambiguous boundary fields (Adversarial Collision Test)", async () => {
			const occurredAt = new Date("2026-09-03T12:00:00Z");
			const commonLines = [
				{
					accountId: "acc-1",
					side: "DEBIT" as const,
					amountNormalized: "100.00",
					cents: 10000n,
					memo: "Line 1",
				},
				{
					accountId: "acc-2",
					side: "CREDIT" as const,
					amountNormalized: "100.00",
					cents: 10000n,
					memo: "Line 2",
				},
			];

			// Payload A: memo = "M\nX", source.type = "Y", source.ref = "Z"
			const fpA = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: "M\nX",
				source: { type: "Y", ref: "Z" },
				lines: commonLines,
			});

			// Payload B: memo = "M", source.type = "X\nY", source.ref = "Z"
			const fpB = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: "M",
				source: { type: "X\nY", ref: "Z" },
				lines: commonLines,
			});

			expect(fpA).not.toBe(fpB);
		});

		it("handles arbitrary delimiter characters in memos and sources deterministically", async () => {
			const occurredAt = new Date("2026-09-03T12:00:00Z");
			const specialLines = [
				{
					accountId: "acc-1",
					side: "DEBIT" as const,
					amountNormalized: "50.00",
					cents: 5000n,
					memo: 'Delimiters: | : \n \t " \\ special',
				},
				{
					accountId: "acc-2",
					side: "CREDIT" as const,
					amountNormalized: "50.00",
					cents: 5000n,
					memo: null,
				},
			];

			const fp1 = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: 'Memo with "quotes" and | pipes : colons \n newlines',
				source: { type: "SRC:PIPE|", ref: 'REF"123\\' },
				lines: specialLines,
			});

			const fp2 = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: 'Memo with "quotes" and | pipes : colons \n newlines',
				source: { type: "SRC:PIPE|", ref: 'REF"123\\' },
				lines: specialLines,
			});

			expect(fp1).toBe(fp2);
		});
	});

	describe("postJournalEntry Input Validation", () => {
		it("rejects less than 2 lines", async () => {
			const mockDb = {} as Database;
			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					lines: [{ accountId: "acc-1", side: "DEBIT", amount: "100.00" }],
				}),
			).rejects.toThrow("Journal entry must have at least 2 lines");
		});

		it("rejects unbalanced entries (DEBIT != CREDIT)", async () => {
			const mockDb = {} as Database;
			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "100.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "90.00" },
					],
				}),
			).rejects.toThrowError(LedgerError);
		});

		it("rejects all-debit or all-credit entries", async () => {
			const mockDb = {} as Database;
			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "100.00" },
						{ accountId: "acc-2", side: "DEBIT", amount: "100.00" },
					],
				}),
			).rejects.toThrow("at least one DEBIT and at least one CREDIT");
		});

		it("rejects non-positive money amounts", async () => {
			const mockDb = {} as Database;
			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "0.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "0.00" },
					],
				}),
			).rejects.toThrow("Money value must be strictly positive");
		});

		it("rejects empty idempotency key or invalid date", async () => {
			const mockDb = {} as Database;
			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "   ",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "10.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "10.00" },
					],
				}),
			).rejects.toThrow("Idempotency key must be between 1 and 128 characters");

			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "key-1",
					occurredAt: new Date("invalid"),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "10.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "10.00" },
					],
				}),
			).rejects.toThrow("Valid occurredAt Date is required");
		});
	});

	describe("postJournalEntry Transaction Execution", () => {
		function createMockTxDb({
			userCurrency = "TRY",
			accounts = [
				{ id: "acc-1", userId: "user-1", currency: "TRY", archivedAt: null },
				{ id: "acc-2", userId: "user-1", currency: "TRY", archivedAt: null },
				{ id: "acc-3", userId: "user-1", currency: "TRY", archivedAt: null },
			] as {
				id: string;
				userId: string;
				currency: string;
				archivedAt: Date | null;
			}[],
			draftInsertConflict = false,
			existingEntry = null as Record<string, unknown> | null,
		} = {}) {
			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						const execute = async () => {
							if (table === users) {
								return [{ id: "user-1", currency: userCurrency }];
							}
							if (table === journalEntries) {
								return existingEntry ? [existingEntry] : [];
							}
							if (table === ledgerAccounts) {
								return accounts;
							}
							return accounts;
						};

						return {
							where: vi.fn().mockImplementation(() => {
								const promise = execute();
								// Attach limit method for queries chaining .limit(1)
								(promise as unknown as Record<string, unknown>).limit = vi
									.fn()
									.mockImplementation(execute);
								return promise;
							}),
							limit: vi.fn().mockImplementation(execute),
						};
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
												id: "entry-new-id",
												userId: "user-1",
												status: "DRAFT",
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
									id: "entry-new-id",
									userId: "user-1",
									status: "POSTED",
									postedAt: new Date(),
								},
							]),
						}),
					}),
				})),
			};

			return {
				transaction: vi.fn().mockImplementation(async (callback) => {
					return await callback(mockTx);
				}),
				mockTx,
			};
		}

		it("posts balanced 2-line journal entry atomically", async () => {
			const { transaction, mockTx } = createMockTxDb();
			const mockDb = { transaction } as unknown as Database;

			const result = await postJournalEntry({
				db: mockDb,
				userId: "user-1",
				idempotencyKey: "idem-1",
				occurredAt: new Date("2026-09-03T10:00:00Z"),
				memo: "Grocery purchase",
				lines: [
					{
						accountId: "acc-1",
						side: "DEBIT",
						amount: "150.25",
						memo: "Food",
					},
					{
						accountId: "acc-2",
						side: "CREDIT",
						amount: "150.25",
						memo: "Card",
					},
				],
			});

			expect(result).toEqual({
				entryId: "entry-new-id",
				idempotentReplay: false,
				currency: "TRY",
				debitTotal: "150.25",
				creditTotal: "150.25",
				lineCount: 2,
			});

			expect(transaction).toHaveBeenCalledTimes(1);
			expect(mockTx.insert).toHaveBeenCalledTimes(2); // DRAFT entry + Lines
			expect(mockTx.update).toHaveBeenCalledTimes(1); // DRAFT -> POSTED
		});

		it("posts multi-line split entry atomically (e.g. 1 debit = 2 credits)", async () => {
			const { transaction } = createMockTxDb();
			const mockDb = { transaction } as unknown as Database;

			const result = await postJournalEntry({
				db: mockDb,
				userId: "user-1",
				idempotencyKey: "split-1",
				occurredAt: new Date("2026-09-03T10:00:00Z"),
				lines: [
					{ accountId: "acc-1", side: "DEBIT", amount: "300.00" },
					{ accountId: "acc-2", side: "CREDIT", amount: "200.00" },
					{ accountId: "acc-3", side: "CREDIT", amount: "100.00" },
				],
			});

			expect(result.debitTotal).toBe("300.00");
			expect(result.creditTotal).toBe("300.00");
			expect(result.lineCount).toBe(3);
			expect(result.idempotentReplay).toBe(false);
		});

		it("throws LEDGER_ACCOUNT_NOT_FOUND when account is missing or belongs to another user", async () => {
			const { transaction } = createMockTxDb({
				accounts: [
					{ id: "acc-1", userId: "user-1", currency: "TRY", archivedAt: null },
					// acc-2 missing
				],
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "idem-2",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "50.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "50.00" },
					],
				}),
			).rejects.toThrow('Account "acc-2" not found for this user');
		});

		it("throws LEDGER_ACCOUNT_ARCHIVED when account is archived", async () => {
			const { transaction } = createMockTxDb({
				accounts: [
					{ id: "acc-1", userId: "user-1", currency: "TRY", archivedAt: null },
					{
						id: "acc-2",
						userId: "user-1",
						currency: "TRY",
						archivedAt: new Date(),
					},
				],
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "idem-3",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "50.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "50.00" },
					],
				}),
			).rejects.toThrow(
				'Account "acc-2" is archived and cannot receive new postings',
			);
		});

		it("throws LEDGER_CURRENCY_MISMATCH when account currency does not match user currency", async () => {
			const { transaction } = createMockTxDb({
				accounts: [
					{ id: "acc-1", userId: "user-1", currency: "TRY", archivedAt: null },
					{ id: "acc-2", userId: "user-1", currency: "USD", archivedAt: null },
				],
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "idem-4",
					occurredAt: new Date(),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "50.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "50.00" },
					],
				}),
			).rejects.toThrow('does not match user currency "TRY"');
		});

		it("replays existing entry when identical request is retried (idempotentReplay = true)", async () => {
			const occurredAt = new Date("2026-09-03T10:00:00Z");
			const lines = [
				{
					accountId: "acc-1",
					side: "DEBIT" as const,
					amountNormalized: "100.00",
					cents: 10000n,
					memo: null,
				},
				{
					accountId: "acc-2",
					side: "CREDIT" as const,
					amountNormalized: "100.00",
					cents: 10000n,
					memo: null,
				},
			];
			const fingerprint = await calculatePostingFingerprint({
				userId: "user-1",
				occurredAt,
				currency: "TRY",
				memo: null,
				source: null,
				lines,
			});

			const { transaction } = createMockTxDb({
				draftInsertConflict: true,
				existingEntry: {
					id: "existing-entry-id",
					userId: "user-1",
					idempotencyKey: "idem-retry",
					postingFingerprint: fingerprint,
					status: "POSTED",
					currency: "TRY",
				},
			});
			const mockDb = { transaction } as unknown as Database;

			const result = await postJournalEntry({
				db: mockDb,
				userId: "user-1",
				idempotencyKey: "idem-retry",
				occurredAt,
				lines: [
					{ accountId: "acc-1", side: "DEBIT", amount: "100.00" },
					{ accountId: "acc-2", side: "CREDIT", amount: "100.00" },
				],
			});

			expect(result).toEqual({
				entryId: "existing-entry-id",
				idempotentReplay: true,
				currency: "TRY",
				debitTotal: "100.00",
				creditTotal: "100.00",
				lineCount: 2,
			});
		});

		it("throws LEDGER_IDEMPOTENCY_CONFLICT when same idempotency key is submitted with different payload", async () => {
			const { transaction } = createMockTxDb({
				draftInsertConflict: true,
				existingEntry: {
					id: "existing-entry-id",
					userId: "user-1",
					idempotencyKey: "idem-conflict",
					postingFingerprint:
						"0000000000000000000000000000000000000000000000000000000000000000",
					status: "POSTED",
					currency: "TRY",
				},
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				postJournalEntry({
					db: mockDb,
					userId: "user-1",
					idempotencyKey: "idem-conflict",
					occurredAt: new Date("2026-09-03T10:00:00Z"),
					lines: [
						{ accountId: "acc-1", side: "DEBIT", amount: "100.00" },
						{ accountId: "acc-2", side: "CREDIT", amount: "100.00" },
					],
				}),
			).rejects.toThrow(
				"Idempotency key already used with different entry payload",
			);
		});
	});
});
