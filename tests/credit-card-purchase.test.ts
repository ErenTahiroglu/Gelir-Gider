import { describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import * as ledgerProvisioning from "../src/credit-cards/ledger-provisioning";
import {
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
								limit: vi.fn().mockResolvedValue([]),
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
								limit: vi.fn().mockResolvedValue([]),
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
});
