import { describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import * as ledgerProvisioning from "../src/credit-cards/ledger-provisioning";
import {
	listCreditCardPurchases,
	normalizePurchaseBudgetCategory,
	recordCreditCardOpeningBalance,
	recordCreditCardPurchase,
} from "../src/credit-cards/purchases";
import type { Database, DatabaseTransaction } from "../src/db/client";
import * as ledgerPosting from "../src/ledger/posting";
import * as ledgerLifecycle from "../src/transactions/ledger-lifecycle";

describe("Credit Card Purchase & Opening Balance Domain Unit Tests", () => {
	const userId = "11111111-1111-1111-1111-111111111111";
	const cardId = "22222222-2222-2222-2222-222222222222";
	const goalId = "44444444-4444-4444-4444-444444444444";
	const liabilityAccountId = "55555555-5555-5555-5555-555555555555";
	const expenseAccountId = "66666666-6666-6666-6666-666666666666";
	const equityAccountId = "77777777-7777-7777-7777-777777777777";

	describe("normalizePurchaseBudgetCategory", () => {
		it("normalizes standard inputs", () => {
			expect(normalizePurchaseBudgetCategory("MANDATORY")).toBe(
				"MANDATORY_EXPENSE",
			);
			expect(normalizePurchaseBudgetCategory("MANDATORY_EXPENSE")).toBe(
				"MANDATORY_EXPENSE",
			);
			expect(normalizePurchaseBudgetCategory("DISCRETIONARY")).toBe(
				"DISCRETIONARY_SPEND",
			);
			expect(normalizePurchaseBudgetCategory("DISCRETIONARY_SPEND")).toBe(
				"DISCRETIONARY_SPEND",
			);
			expect(normalizePurchaseBudgetCategory("SHORT_TERM_PURCHASE")).toBe(
				"SHORT_TERM_PURCHASE",
			);
			expect(normalizePurchaseBudgetCategory("UNCLASSIFIED")).toBe(
				"UNCLASSIFIED",
			);
		});

		it("throws on invalid category", () => {
			expect(() => normalizePurchaseBudgetCategory("INVALID")).toThrow(
				CreditCardError,
			);
		});
	});

	describe("Input Validations", () => {
		const mockDb = {
			transaction: vi.fn(async (cb) =>
				cb({} as unknown as DatabaseTransaction),
			),
		} as unknown as Database;

		it("rejects non-uuid userId", async () => {
			await expect(
				recordCreditCardPurchase({
					db: mockDb,
					userId: "invalid",
					cardId,
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					occurredAt: new Date(),
					idempotencyKey: "k1",
				}),
			).rejects.toThrow(CreditCardError);
		});

		it("rejects non-positive amount", async () => {
			await expect(
				recordCreditCardPurchase({
					db: mockDb,
					userId,
					cardId,
					amount: "0.00",
					purchaseCategory: "MANDATORY",
					occurredAt: new Date(),
					idempotencyKey: "k1",
				}),
			).rejects.toThrow(CreditCardError);
		});

		it("requires shortTermGoalId when SHORT_TERM_PURCHASE", async () => {
			await expect(
				recordCreditCardPurchase({
					db: mockDb,
					userId,
					cardId,
					amount: "100.00",
					purchaseCategory: "SHORT_TERM_PURCHASE",
					occurredAt: new Date(),
					idempotencyKey: "k1",
				}),
			).rejects.toThrow("shortTermGoalId is required");
		});

		it("forbids shortTermGoalId when not SHORT_TERM_PURCHASE", async () => {
			await expect(
				recordCreditCardPurchase({
					db: mockDb,
					userId,
					cardId,
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					shortTermGoalId: goalId,
					occurredAt: new Date(),
					idempotencyKey: "k1",
				}),
			).rejects.toThrow(
				"shortTermGoalId is only allowed for SHORT_TERM_PURCHASE",
			);
		});
	});

	describe("recordCreditCardPurchase", () => {
		it("creates purchase with Dr Expense, Cr Card Liability", async () => {
			const mockTx = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]), // No replay
							for: vi
								.fn()
								.mockResolvedValue([{ id: cardId, code: "AKBANK", userId }]),
							orderBy: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([{ status: "ACTIVE" }]),
							}),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([{ id: "new-id" }]),
					}),
				}),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			vi.spyOn(
				ledgerProvisioning,
				"ensureCreditCardLedgerLinkInTransaction",
			).mockResolvedValue(liabilityAccountId);
			vi.spyOn(
				ledgerProvisioning,
				"ensureCreditCardSystemAccountsInTransaction",
			).mockResolvedValue({
				MANDATORY_EXPENSE: expenseAccountId,
				DISCRETIONARY_EXPENSE: "disc-id",
				SHORT_TERM_PURCHASE: "st-id",
				UNCLASSIFIED_EXPENSE: "unclass-id",
				OPENING_EQUITY: equityAccountId,
			});
			vi.spyOn(
				ledgerPosting,
				"lockLedgerAccountsInTransaction",
			).mockResolvedValue([]);
			const createTxSpy = vi
				.spyOn(
					ledgerLifecycle,
					"createCanonicalTransactionWithLedgerInTransaction",
				)
				.mockResolvedValue({
					transactionId: "can-tx-1",
					revisionId: "can-rev-1",
					revisionNo: 1,
					operation: "CREATE",
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: "journal-1",
						reversalJournalEntryId: null,
					},
				});

			const res = await recordCreditCardPurchase({
				db: mockDb,
				userId,
				cardId,
				amount: "150.00",
				purchaseCategory: "MANDATORY",
				merchant: "BIM",
				description: "Weekly food",
				occurredAt: new Date("2026-09-04T12:00:00Z"),
				idempotencyKey: "k-purchase-1",
			});

			expect(res.operation).toBe("CREATE");
			expect(res.status).toBe("POSTED");
			expect(res.snapshot.amount).toBe("150.00");
			expect(res.snapshot.purchaseCategory).toBe("MANDATORY_EXPENSE");
			expect(res.snapshot.merchant).toBe("BIM");

			expect(createTxSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "CREDIT_CARD_PURCHASE",
					ledger: expect.objectContaining({
						lines: [
							{ accountId: expenseAccountId, side: "DEBIT", amount: "150.00" },
							{
								accountId: liabilityAccountId,
								side: "CREDIT",
								amount: "150.00",
							},
						],
					}),
				}),
			);
		});
	});

	describe("recordCreditCardOpeningBalance", () => {
		it("creates opening balance with Dr Opening Equity, Cr Card Liability", async () => {
			const mockTx = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]), // No replay, no existing opening balance
							for: vi
								.fn()
								.mockResolvedValue([{ id: cardId, code: "GARANTI", userId }]),
							orderBy: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([{ status: "ACTIVE" }]),
							}),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([{ id: "new-id" }]),
					}),
				}),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			vi.spyOn(
				ledgerProvisioning,
				"ensureCreditCardLedgerLinkInTransaction",
			).mockResolvedValue(liabilityAccountId);
			vi.spyOn(
				ledgerProvisioning,
				"ensureCreditCardSystemAccountsInTransaction",
			).mockResolvedValue({
				MANDATORY_EXPENSE: expenseAccountId,
				DISCRETIONARY_EXPENSE: "disc-id",
				SHORT_TERM_PURCHASE: "st-id",
				UNCLASSIFIED_EXPENSE: "unclass-id",
				OPENING_EQUITY: equityAccountId,
			});
			vi.spyOn(
				ledgerPosting,
				"lockLedgerAccountsInTransaction",
			).mockResolvedValue([]);
			const createTxSpy = vi
				.spyOn(
					ledgerLifecycle,
					"createCanonicalTransactionWithLedgerInTransaction",
				)
				.mockResolvedValue({
					transactionId: "can-tx-op-1",
					revisionId: "can-rev-op-1",
					revisionNo: 1,
					operation: "CREATE",
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: "journal-op-1",
						reversalJournalEntryId: null,
					},
				});

			const res = await recordCreditCardOpeningBalance({
				db: mockDb,
				userId,
				cardId,
				amount: "3000.00",
				description: "Card migration opening balance",
				occurredAt: new Date("2026-09-01T00:00:00Z"),
				idempotencyKey: "k-open-1",
			});

			expect(res.operation).toBe("CREATE");
			expect(res.status).toBe("POSTED");
			expect(res.snapshot.amount).toBe("3000.00");
			expect(res.snapshot.purchaseCategory).toBeNull();

			expect(createTxSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "CREDIT_CARD_OPENING_BALANCE",
					ledger: expect.objectContaining({
						lines: [
							{ accountId: equityAccountId, side: "DEBIT", amount: "3000.00" },
							{
								accountId: liabilityAccountId,
								side: "CREDIT",
								amount: "3000.00",
							},
						],
					}),
				}),
			);
		});
	});

	describe("listCreditCardPurchases", () => {
		it("retrieves purchases and opening balances in bulk with goalId and bindings", async () => {
			const ev1Id = "ev-11111111-1111-1111-1111-111111111111";
			const ev2Id = "ev-22222222-2222-2222-2222-222222222222";
			const canRev1Id = "can-rev-1";
			const canRev2Id = "can-rev-2";

			let selectCallCount = 0;
			const mockTx = {
				selectDistinctOn: vi.fn(() => ({
					from: vi.fn(() => ({
						innerJoin: vi.fn(() => ({
							where: vi.fn(() => ({
								orderBy: vi.fn(() => ({
									as: vi.fn().mockReturnValue("latest_revs"),
								})),
							})),
						})),
					})),
				})),
				select: vi.fn(() => ({
					from: vi.fn(() => {
						selectCallCount++;
						const currentCall = selectCallCount;
						return {
							where: vi.fn(() => {
								if (currentCall === 1) {
									// Filtered, ordered, paginated rows
									return {
										orderBy: vi.fn().mockReturnValue({
											limit: vi.fn().mockReturnValue({
												offset: vi.fn().mockResolvedValue([
													{
														revisionId: "rev-1",
														eventId: ev1Id,
														userId,
														revisionNo: 1,
														canonicalRevisionId: canRev1Id,
														operation: "CREATE",
														amount: "100.00",
														budgetCategory: "SHORT_TERM_PURCHASE",
														merchant: "Migros",
														description: "Groceries",
														installmentCount: null,
														purchaseDate: "2026-09-01",
														occurredAt: new Date("2026-09-01T10:00:00Z"),
														creditCardId: cardId,
														eventType: "PURCHASE",
														canonicalTransactionId: "can-tx-1",
														eventCreatedAt: new Date("2026-09-01T10:00:00Z"),
													},
													{
														revisionId: "rev-2",
														eventId: ev2Id,
														userId,
														revisionNo: 1,
														canonicalRevisionId: canRev2Id,
														operation: "CREATE",
														amount: "200.00",
														budgetCategory: null,
														merchant: null,
														description: "Opening",
														installmentCount: null,
														purchaseDate: null,
														occurredAt: new Date("2026-09-01T09:00:00Z"),
														creditCardId: cardId,
														eventType: "OPENING_BALANCE",
														canonicalTransactionId: "can-tx-2",
														eventCreatedAt: new Date("2026-09-01T09:00:00Z"),
													},
												]),
											}),
										}),
									};
								}
								if (currentCall === 2) {
									// Bindings in bulk
									return [
										{
											revisionId: canRev1Id,
											appliedJournalEntryId: "journal-entry-1",
										},
										{
											revisionId: canRev2Id,
											appliedJournalEntryId: "journal-entry-2",
										},
									];
								}
								if (currentCall === 3) {
									// Canonical revisions in bulk
									return [
										{
											id: canRev1Id,
											payload: { shortTermGoalId: goalId },
										},
										{
											id: canRev2Id,
											payload: {},
										},
									];
								}
								return [];
							}),
						};
					}),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			const records = await listCreditCardPurchases({
				db: mockDb,
				userId,
				cardId,
				budgetCategory: "SHORT_TERM_PURCHASE",
				purchaseDateFrom: "2026-09-01",
				purchaseDateUntil: "2026-09-30",
				limit: 20,
				offset: 0,
			});

			expect(records).toHaveLength(2);
			expect(records[0]?.eventId).toBe(ev1Id);
			expect(records[0]?.amount).toBe("100.00");
			expect(records[0]?.shortTermGoalId).toBe(goalId);
			expect(records[0]?.journalEntryId).toBe("journal-entry-1");
			expect(records[0]?.status).toBe("POSTED");

			expect(records[1]?.eventId).toBe(ev2Id);
			expect(records[1]?.amount).toBe("200.00");
			expect(records[1]?.shortTermGoalId).toBeNull();
			expect(records[1]?.journalEntryId).toBe("journal-entry-2");
		});

		it("returns empty list if no events match", async () => {
			const mockTx = {
				selectDistinctOn: vi.fn(() => ({
					from: vi.fn(() => ({
						innerJoin: vi.fn(() => ({
							where: vi.fn(() => ({
								orderBy: vi.fn(() => ({
									as: vi.fn().mockReturnValue("latest_revs"),
								})),
							})),
						})),
					})),
				})),
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => ({
							orderBy: vi.fn().mockReturnValue({
								limit: vi.fn().mockReturnValue({
									offset: vi.fn().mockResolvedValue([]),
								}),
							}),
						})),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			const records = await listCreditCardPurchases({
				db: mockDb,
				userId,
			});

			expect(records).toEqual([]);
		});

		it("rejects invalid date range where purchaseDateFrom is after purchaseDateUntil", async () => {
			const mockDb = {
				transaction: vi.fn(async (cb) =>
					cb({} as unknown as DatabaseTransaction),
				),
			} as unknown as Database;

			await expect(
				listCreditCardPurchases({
					db: mockDb,
					userId,
					purchaseDateFrom: "2026-09-30",
					purchaseDateUntil: "2026-09-01",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_INPUT",
				}),
			);
		});

		it("rejects non-Gregorian leap date (e.g. 2026-02-29)", async () => {
			const mockDb = {
				transaction: vi.fn(async (cb) =>
					cb({} as unknown as DatabaseTransaction),
				),
			} as unknown as Database;

			await expect(
				listCreditCardPurchases({
					db: mockDb,
					userId,
					purchaseDateFrom: "2026-02-29",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_INPUT",
				}),
			);
		});
	});
});
