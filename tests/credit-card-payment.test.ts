import { describe, expect, it, vi } from "vitest";
import * as ledgerProvisioning from "../src/credit-cards/ledger-provisioning";
import {
	payCreditCardStatement,
	reconcileCreditCardStatement,
	reopenCreditCardStatementPayment,
} from "../src/credit-cards/payments";
import type { Database, DatabaseTransaction } from "../src/db/client";
import * as ledgerBalances from "../src/ledger/balances";
import * as ledgerPosting from "../src/ledger/posting";
import * as midasService from "../src/midas/service";
import * as ledgerLifecycle from "../src/transactions/ledger-lifecycle";

describe("Credit Card Statement Payment & Reopen Domain Unit Tests", () => {
	const userId = "11111111-1111-1111-1111-111111111111";
	const cardId = "22222222-2222-2222-2222-222222222222";
	const statementId = "33333333-3333-3333-3333-333333333333";
	const liabilityAccountId = "44444444-4444-4444-4444-444444444444";
	const assetAccountId = "55555555-5555-5555-5555-555555555555";
	const midasAccountId = "66666666-6666-6666-6666-666666666666";
	const reserveBucketId = "77777777-7777-7777-7777-777777777777";
	const paymentEventId = "88888888-8888-8888-8888-888888888888";

	describe("payCreditCardStatement", () => {
		it("pays statement with OUTSIDE_MIDAS without touching Midas allocation", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 2) {
								return {
									for: vi
										.fn()
										.mockResolvedValue([{ id: statementId, cardId, userId }]),
								};
							}
							if (selectCallCount === 3) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-1",
												statementId,
												revisionNo: 1,
												status: "OPEN",
												statementAmount: "2500.00",
												statementDate: "2026-09-01",
												dueDate: "2026-09-15",
												reservePlacement: "OUTSIDE_MIDAS",
												note: null,
											},
										]),
									}),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([
									{
										id: assetAccountId,
										accountType: "ASSET",
										normalBalance: "DEBIT",
										archivedAt: null,
									},
								]),
							};
						}),
					})),
				})),
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
				ledgerPosting,
				"lockLedgerAccountsInTransaction",
			).mockResolvedValue([]);
			const createTxSpy = vi
				.spyOn(
					ledgerLifecycle,
					"createCanonicalTransactionWithLedgerInTransaction",
				)
				.mockResolvedValue({
					transactionId: "can-pay-tx-1",
					revisionId: "can-pay-rev-1",
					revisionNo: 1,
					operation: "CREATE",
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: "journal-pay-1",
						reversalJournalEntryId: null,
					},
				});

			const res = await payCreditCardStatement({
				db: mockDb,
				userId,
				statementId,
				expectedRevisionNo: 1,
				paymentAmount: "2500.00",
				paymentMethod: "OUTSIDE_MIDAS",
				paymentAssetAccountId: assetAccountId,
				occurredAt: new Date("2026-09-10T12:00:00Z"),
				idempotencyKey: "k-pay-outside-1",
			});

			expect(res.operation).toBe("PAY");
			expect(res.status).toBe("PAID");
			expect(res.snapshot.statementAmount).toBe("2500.00");

			expect(createTxSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "CREDIT_CARD_STATEMENT_PAYMENT",
					ledger: expect.objectContaining({
						lines: [
							{
								accountId: liabilityAccountId,
								side: "DEBIT",
								amount: "2500.00",
							},
							{ accountId: assetAccountId, side: "CREDIT", amount: "2500.00" },
						],
					}),
				}),
			);
		});

		it("pays statement with MIDAS_FUND and releases reserve to unallocated", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1)
								return { limit: vi.fn().mockResolvedValue([]) };
							if (selectCallCount === 2) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											creditCardId: cardId,
											cardId,
											userId,
											midasReserveBucketId: reserveBucketId,
										},
									]),
								};
							}
							if (selectCallCount === 3) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-1",
												statementId,
												revisionNo: 1,
												status: "OPEN",
												statementAmount: "5000.00",
												statementDate: "2026-09-01",
												dueDate: "2026-09-15",
												reservePlacement: "MIDAS_FUND",
												note: null,
											},
										]),
									}),
								};
							}
							// Payment asset account
							return {
								limit: vi.fn().mockResolvedValue([
									{
										id: assetAccountId,
										accountType: "ASSET",
										normalBalance: "DEBIT",
										archivedAt: null,
									},
								]),
							};
						}),
					})),
				})),
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
				ledgerPosting,
				"lockLedgerAccountsInTransaction",
			).mockResolvedValue([]);
			vi.spyOn(
				midasService,
				"lockMidasAllocationStateInTransaction",
			).mockResolvedValue(
				{} as unknown as midasService.LockedMidasAllocationIdentity,
			);
			const transferSpy = vi
				.spyOn(midasService, "createMidasAllocationTransferInTransaction")
				.mockResolvedValue(
					{} as unknown as midasService.MidasAllocationTransferResult,
				);

			vi.spyOn(
				ledgerLifecycle,
				"createCanonicalTransactionWithLedgerInTransaction",
			).mockResolvedValue({
				transactionId: "can-pay-midas-1",
				revisionId: "can-pay-midas-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				idempotentReplay: false,
				ledger: {
					appliedJournalEntryId: "journal-midas-1",
					reversalJournalEntryId: null,
				},
			});

			const res = await payCreditCardStatement({
				db: mockDb,
				userId,
				statementId,
				expectedRevisionNo: 1,
				paymentAmount: "5000.00",
				paymentMethod: "MIDAS_FUND",
				paymentAssetAccountId: assetAccountId,
				occurredAt: new Date("2026-09-10T12:00:00Z"),
				idempotencyKey: "k-pay-midas-1",
			});

			expect(res.operation).toBe("PAY");
			expect(res.status).toBe("PAID");
			expect(transferSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					fromBucketId: reserveBucketId,
					toBucketId: null, // released to unallocated
					amount: "5000.00",
				}),
			);
		});
	});

	describe("reopenCreditCardStatementPayment", () => {
		it("reopens PAID statement and restores reserve when MIDAS_FUND", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1)
								return { limit: vi.fn().mockResolvedValue([]) };
							if (selectCallCount === 2) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											creditCardId: cardId,
											cardId,
											userId,
											midasReserveBucketId: reserveBucketId,
										},
									]),
								};
							}
							if (selectCallCount === 3) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-2",
												statementId,
												revisionNo: 2,
												status: "PAID",
												operation: "PAY",
												statementAmount: "5000.00",
												statementDate: "2026-09-01",
												dueDate: "2026-09-15",
												reservePlacement: "MIDAS_FUND",
												paymentEventId,
												note: null,
											},
										]),
									}),
								};
							}
							if (selectCallCount === 4) {
								// Payment event
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: paymentEventId,
											canonicalTransactionId: "can-pay-tx-1",
											paymentAssetAccountId: assetAccountId,
											amount: "5000.00",
										},
									]),
								};
							}
							if (selectCallCount === 5) {
								// Midas account lookup
								return {
									limit: vi.fn().mockResolvedValue([{ id: midasAccountId }]),
								};
							}
							// Canonical tx revision
							return {
								orderBy: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([{ revisionNo: 1 }]),
								}),
							};
						}),
					})),
				})),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([{ id: "new-reopen-id" }]),
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
				ledgerPosting,
				"lockLedgerAccountsInTransaction",
			).mockResolvedValue([]);
			vi.spyOn(
				midasService,
				"lockMidasAllocationStateInTransaction",
			).mockResolvedValue(
				{} as unknown as midasService.LockedMidasAllocationIdentity,
			);
			const transferSpy = vi
				.spyOn(midasService, "createMidasAllocationTransferInTransaction")
				.mockResolvedValue(
					{} as unknown as midasService.MidasAllocationTransferResult,
				);

			const voidTxSpy = vi
				.spyOn(
					ledgerLifecycle,
					"voidCanonicalTransactionWithLedgerInTransaction",
				)
				.mockResolvedValue(
					{} as unknown as ledgerLifecycle.BoundCanonicalTransactionResult,
				);

			const res = await reopenCreditCardStatementPayment({
				db: mockDb,
				userId,
				statementId,
				expectedRevisionNo: 2,
				reasonNote: "Accidental payment entry",
				occurredAt: new Date("2026-09-11T12:00:00Z"),
				idempotencyKey: "k-reopen-1",
			});

			expect(res.operation).toBe("REOPEN");
			expect(res.status).toBe("OPEN");
			expect(transferSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					fromBucketId: null, // restored from unallocated
					toBucketId: reserveBucketId,
					amount: "5000.00",
				}),
			);
			expect(voidTxSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					transactionId: "can-pay-tx-1",
					reasonCode: "STATEMENT_PAYMENT_REOPEN",
				}),
			);
		});
	});

	describe("reconcileCreditCardStatement", () => {
		it("matches statement amount against live ledger liability balance", async () => {
			let selectCallCount = 0;
			const mockDb = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								return {
									limit: vi
										.fn()
										.mockResolvedValue([
											{ id: statementId, creditCardId: cardId, userId },
										]),
								};
							}
							if (selectCallCount === 2) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-1",
												statementId,
												revisionNo: 1,
												statementAmount: "4500.00",
												statementDate: "2026-09-01",
											},
										]),
									}),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([{ liabilityAccountId }]),
							};
						}),
					})),
				})),
			} as unknown as Database;

			vi.spyOn(
				ledgerBalances,
				"getLedgerAccountBalanceInTransaction",
			).mockResolvedValue({
				accountId: liabilityAccountId,
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "4500.00",
				asOf: "2026-09-01T23:59:59.999Z",
			});

			const rec = await reconcileCreditCardStatement({
				db: mockDb,
				userId,
				statementId,
			});

			expect(rec.isMatched).toBe(true);
			expect(rec.statementAmount).toBe("4500.00");
			expect(rec.ledgerLiabilityBalance).toBe("4500.00");
			expect(rec.difference).toBe("0.00");
		});
	});
});
