import { describe, expect, it, vi } from "vitest";
import { calculateStatementPayFingerprint } from "../src/credit-cards/fingerprint";
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
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 4) {
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
							if (selectCallCount === 5) {
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: assetAccountId,
											accountType: "ASSET",
											normalBalance: "DEBIT",
											currency: "TRY",
											archivedAt: null,
										},
									]),
								};
							}
							if (selectCallCount === 6) {
								// midasAccounts check (not linked)
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 7) {
								// users check
								return {
									limit: vi.fn().mockResolvedValue([
										{
											currency: "TRY",
										},
									]),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([]),
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
				ledgerBalances,
				"getLedgerAccountBalanceInTransaction",
			).mockResolvedValue({
				accountId: liabilityAccountId,
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "10000.00",
				asOf: "2026-09-01T23:59:59.999Z",
			});
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
							{
								accountId: assetAccountId,
								side: "CREDIT",
								amount: "2500.00",
							},
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
							if (selectCallCount === 1) {
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 2) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											cardId,
											userId,
											midasAccountId,
											midasReserveBucketId: reserveBucketId,
										},
									]),
								};
							}
							if (selectCallCount === 3) {
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 4) {
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
							if (selectCallCount === 5) {
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: midasAccountId,
											ledgerAccountId: assetAccountId,
										},
									]),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([]),
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
				ledgerBalances,
				"getLedgerAccountBalanceInTransaction",
			).mockResolvedValue({
				accountId: liabilityAccountId,
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "10000.00",
				asOf: "2026-09-01T23:59:59.999Z",
			});
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

		it("replays exact historical PAY revision when idempotency key is re-sent with exact payload", async () => {
			const occurredAt = new Date("2026-09-10T12:00:00Z");
			const storedFp = await calculateStatementPayFingerprint({
				userId,
				statementId,
				expectedRevisionNo: 1,
				paymentAmount: "2500.00",
				paymentMethod: "OUTSIDE_MIDAS",
				assetAccountId,
				occurredAt,
			});

			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								// Early replay find
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: "rev-stmt-pay-1",
											userId,
											statementId,
											revisionNo: 2,
											previousRevisionId: "rev-stmt-1",
											operation: "PAY",
											status: "PAID",
											statementAmount: "2500.00",
											statementDate: "2026-09-01",
											dueDate: "2026-09-15",
											reservePlacement: "OUTSIDE_MIDAS",
											paymentEventId,
											note: null,
											reasonNote: null,
											revisionFingerprint: storedFp,
										},
									]),
								};
							}
							if (selectCallCount === 2) {
								// Payment event query in checkStatementPayReplay
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: paymentEventId,
											paymentAssetAccountId: assetAccountId,
										},
									]),
								};
							}
							return { limit: vi.fn().mockResolvedValue([]) };
						}),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			const res = await payCreditCardStatement({
				db: mockDb,
				userId,
				statementId,
				expectedRevisionNo: 1,
				paymentAmount: "2500.00",
				paymentMethod: "OUTSIDE_MIDAS",
				paymentAssetAccountId: assetAccountId,
				occurredAt,
				idempotencyKey: "k-pay-replay-1",
			});

			expect(res.idempotentReplay).toBe(true);
			expect(res.operation).toBe("PAY");
			expect(res.status).toBe("PAID");
			expect(res.revisionId).toBe("rev-stmt-pay-1");
		});

		it("throws CREDIT_CARD_IDEMPOTENCY_CONFLICT when replaying PAY with changed payload", async () => {
			const occurredAt = new Date("2026-09-10T12:00:00Z");
			const storedFp = await calculateStatementPayFingerprint({
				userId,
				statementId,
				expectedRevisionNo: 1,
				paymentAmount: "2500.00",
				paymentMethod: "OUTSIDE_MIDAS",
				assetAccountId,
				occurredAt,
			});

			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: "rev-stmt-pay-1",
											userId,
											statementId,
											revisionNo: 2,
											previousRevisionId: "rev-stmt-1",
											operation: "PAY",
											status: "PAID",
											statementAmount: "2500.00",
											statementDate: "2026-09-01",
											dueDate: "2026-09-15",
											reservePlacement: "OUTSIDE_MIDAS",
											paymentEventId,
											note: null,
											reasonNote: null,
											revisionFingerprint: storedFp,
										},
									]),
								};
							}
							if (selectCallCount === 2) {
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: paymentEventId,
											paymentAssetAccountId: assetAccountId,
										},
									]),
								};
							}
							return { limit: vi.fn().mockResolvedValue([]) };
						}),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			// Pass wrong expectedRevisionNo (2 instead of 1)
			await expect(
				payCreditCardStatement({
					db: mockDb,
					userId,
					statementId,
					expectedRevisionNo: 2,
					paymentAmount: "2500.00",
					paymentMethod: "OUTSIDE_MIDAS",
					paymentAssetAccountId: assetAccountId,
					occurredAt,
					idempotencyKey: "k-pay-replay-1",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_IDEMPOTENCY_CONFLICT",
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
								return { limit: vi.fn().mockResolvedValue([]) }; // early replay
							if (selectCallCount === 2)
								return {
									limit: vi.fn().mockResolvedValue([{ creditCardId: cardId }]),
								}; // preliminary stmt lookup
							if (selectCallCount === 3)
								return {
									for: vi.fn().mockResolvedValue([{ id: cardId, userId }]),
								}; // card lock
							if (selectCallCount === 4)
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([{ status: "ACTIVE" }]), // card rev
									}),
								};
							if (selectCallCount === 5) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											creditCardId: cardId,
											userId,
											midasAccountId,
											midasReserveBucketId: reserveBucketId,
										},
									]),
								}; // statement lock
							}
							if (selectCallCount === 6)
								return { limit: vi.fn().mockResolvedValue([]) }; // 2nd replay
							if (selectCallCount === 7) {
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
							if (selectCallCount === 8) {
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
							if (selectCallCount === 9) {
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

		it("throws CREDIT_CARD_NOT_ACTIVE if card is ARCHIVED when fresh REOPEN is attempted", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1)
								return { limit: vi.fn().mockResolvedValue([]) }; // early replay
							if (selectCallCount === 2)
								return {
									limit: vi.fn().mockResolvedValue([{ creditCardId: cardId }]),
								}; // preliminary stmt lookup
							if (selectCallCount === 3)
								return {
									for: vi.fn().mockResolvedValue([{ id: cardId, userId }]),
								}; // card lock
							if (selectCallCount === 4)
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([{ status: "ARCHIVED" }]), // card rev is ARCHIVED
									}),
								};
							return { limit: vi.fn().mockResolvedValue([]) };
						}),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			await expect(
				reopenCreditCardStatementPayment({
					db: mockDb,
					userId,
					statementId,
					expectedRevisionNo: 2,
					reasonNote: "Reopen after archive attempt",
					occurredAt: new Date("2026-09-11T12:00:00Z"),
					idempotencyKey: "k-reopen-archived-1",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_NOT_ACTIVE",
				}),
			);
		});
	});

	describe("reconcileCreditCardStatement", () => {
		it("matches statement amount against live ledger liability balance", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											creditCardId: cardId,
											userId,
											midasAccountId: null,
											midasReserveBucketId: null,
										},
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
												status: "OPEN",
												statementAmount: "4500.00",
												statementDate: "2026-09-01",
												reservePlacement: "OUTSIDE_MIDAS",
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

			expect(rec.liabilityCoverage).toBe("READY");
			expect(rec.statementAmount).toBe("4500.00");
			expect(rec.cardLiabilityBalance).toBe("4500.00");
			expect(rec.liabilityAfterPayment).toBe("0.00");
		});

		it("returns SHORTFALL when ledger liability is less than statement amount", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											creditCardId: cardId,
											userId,
											midasAccountId: null,
											midasReserveBucketId: null,
										},
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
												status: "OPEN",
												statementAmount: "8000.00",
												statementDate: "2026-09-01",
												reservePlacement: "OUTSIDE_MIDAS",
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
				ledgerBalances,
				"getLedgerAccountBalanceInTransaction",
			).mockResolvedValue({
				accountId: liabilityAccountId,
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "7000.00",
				asOf: "2026-09-01T23:59:59.999Z",
			});

			const rec = await reconcileCreditCardStatement({
				db: mockDb,
				userId,
				statementId,
			});

			expect(rec.liabilityCoverage).toBe("SHORTFALL");
			expect(rec.statementAmount).toBe("8000.00");
			expect(rec.cardLiabilityBalance).toBe("7000.00");
			expect(rec.liabilityAfterPayment).toBe("-1000.00");
		});

		it("throws CREDIT_CARD_INVALID_STATE if OPEN MIDAS_FUND reserve amount does not match statement amount", async () => {
			let selectCallCount = 0;
			const mockTx = {
				select: vi.fn(() => ({
					from: vi.fn(() => ({
						where: vi.fn(() => {
							selectCallCount++;
							if (selectCallCount === 1) {
								return {
									for: vi.fn().mockResolvedValue([
										{
											id: statementId,
											creditCardId: cardId,
											userId,
											midasAccountId,
											midasReserveBucketId: reserveBucketId,
										},
									]),
								};
							}
							if (selectCallCount === 2) {
								return {
									limit: vi
										.fn()
										.mockResolvedValue([{ ledgerAccountId: assetAccountId }]),
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
												statementAmount: "8000.00",
												statementDate: "2026-09-01",
												reservePlacement: "MIDAS_FUND",
											},
										]),
									}),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([]),
							};
						}),
					})),
				})),
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
			vi.spyOn(
				ledgerBalances,
				"getLedgerAccountBalanceInTransaction",
			).mockResolvedValue({
				accountId: liabilityAccountId,
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "8000.00",
				asOf: "2026-09-01T23:59:59.999Z",
			});
			vi.spyOn(
				midasService,
				"getMidasLiquidityStateInTransaction",
			).mockResolvedValue({
				midasAccountId,
				ledgerAccountId: "midas-ledger-account",
				currency: "TRY",
				physicalBalance: "8000.00",
				totalEarmarked: "5000.00",
				unallocatedBalance: "3000.00",
				buckets: [
					{
						bucketId: reserveBucketId,
						code: "CC_RESERVE",
						name: "CREDIT_CARD_RESERVE",
						bucketType: "CREDIT_CARD_RESERVE",
						balance: "5000.00", // Mismatched reserve! (5000 vs 8000)
					},
				],
			});

			await expect(
				reconcileCreditCardStatement({
					db: mockDb,
					userId,
					statementId,
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_STATE",
				}),
			);
		});
	});

	describe("payCreditCardStatement shortfall enforcement", () => {
		it("throws CREDIT_CARD_LIABILITY_SHORTFALL when liability is less than statement amount", async () => {
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
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 4) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-1",
												statementId,
												revisionNo: 1,
												status: "OPEN",
												statementAmount: "8000.00",
												statementDate: "2026-09-01",
												dueDate: "2026-09-15",
												reservePlacement: "OUTSIDE_MIDAS",
												note: null,
											},
										]),
									}),
								};
							}
							if (selectCallCount === 5) {
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: assetAccountId,
											accountType: "ASSET",
											normalBalance: "DEBIT",
											currency: "TRY",
											archivedAt: null,
										},
									]),
								};
							}
							if (selectCallCount === 6) {
								// midasAccounts check (not linked)
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 7) {
								// users check
								return {
									limit: vi.fn().mockResolvedValue([
										{
											currency: "TRY",
										},
									]),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([]),
							};
						}),
					})),
				})),
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
				ledgerBalances,
				"getLedgerAccountBalanceInTransaction",
			).mockResolvedValue({
				accountId: liabilityAccountId,
				currency: "TRY",
				normalBalance: "CREDIT",
				balance: "7000.00", // Shortfall!
				asOf: "2026-09-01T23:59:59.999Z",
			});

			await expect(
				payCreditCardStatement({
					db: mockDb,
					userId,
					statementId,
					expectedRevisionNo: 1,
					paymentAmount: "8000.00",
					paymentMethod: "OUTSIDE_MIDAS",
					paymentAssetAccountId: assetAccountId,
					occurredAt: new Date("2026-09-10T12:00:00Z"),
					idempotencyKey: "k-pay-shortfall-1",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_LIABILITY_SHORTFALL",
				}),
			);
		});

		it("rejects contradictory paymentAssetAccountId and outsidePaymentAssetAccountId", async () => {
			const mockDb = {
				transaction: vi.fn(async (cb) =>
					cb({} as unknown as DatabaseTransaction),
				),
			} as unknown as Database;

			await expect(
				payCreditCardStatement({
					db: mockDb,
					userId,
					statementId,
					expectedRevisionNo: 1,
					paymentAmount: "100.00",
					paymentMethod: "OUTSIDE_MIDAS",
					paymentAssetAccountId: assetAccountId,
					outsidePaymentAssetAccountId: "99999999-9999-9999-9999-999999999999",
					occurredAt: new Date("2026-09-10T12:00:00Z"),
					idempotencyKey: "k-pay-contradictory-1",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_INPUT",
				}),
			);
		});

		it("rejects MIDAS_FUND payment when supplied asset differs from Midas account", async () => {
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
										.mockResolvedValue([
											{ id: statementId, cardId, userId, midasAccountId },
										]),
								};
							}
							if (selectCallCount === 3) {
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 4) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-1",
												statementId,
												revisionNo: 1,
												status: "OPEN",
												statementAmount: "100.00",
												statementDate: "2026-09-01",
												dueDate: "2026-09-15",
												reservePlacement: "MIDAS_FUND",
												midasAccountId: midasAccountId,
												note: null,
											},
										]),
									}),
								};
							}
							if (selectCallCount === 5) {
								// midasAccounts query
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: midasAccountId,
											ledgerAccountId: midasAccountId,
										},
									]),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([]),
							};
						}),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			vi.spyOn(
				ledgerProvisioning,
				"ensureCreditCardLedgerLinkInTransaction",
			).mockResolvedValue(liabilityAccountId);

			await expect(
				payCreditCardStatement({
					db: mockDb,
					userId,
					statementId,
					expectedRevisionNo: 1,
					paymentAmount: "100.00",
					paymentMethod: "MIDAS_FUND",
					paymentAssetAccountId: "99999999-9999-9999-9999-999999999999", // Contradictory!
					occurredAt: new Date("2026-09-10T12:00:00Z"),
					idempotencyKey: "k-pay-midas-wrong-asset-1",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_INPUT",
				}),
			);
		});

		it("rejects OUTSIDE_MIDAS payment when asset account currency does not match user currency", async () => {
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
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 4) {
								return {
									orderBy: vi.fn().mockReturnValue({
										limit: vi.fn().mockResolvedValue([
											{
												id: "rev-stmt-1",
												statementId,
												revisionNo: 1,
												status: "OPEN",
												statementAmount: "100.00",
												statementDate: "2026-09-01",
												dueDate: "2026-09-15",
												reservePlacement: "OUTSIDE_MIDAS",
												note: null,
											},
										]),
									}),
								};
							}
							if (selectCallCount === 5) {
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: assetAccountId,
											accountType: "ASSET",
											normalBalance: "DEBIT",
											archivedAt: null,
											currency: "USD", // Cross-currency!
										},
									]),
								};
							}
							if (selectCallCount === 6) {
								// midasAccounts check (not linked)
								return { limit: vi.fn().mockResolvedValue([]) };
							}
							if (selectCallCount === 7) {
								// users check
								return {
									limit: vi.fn().mockResolvedValue([
										{
											id: userId,
											currency: "TRY",
										},
									]),
								};
							}
							return {
								limit: vi.fn().mockResolvedValue([]),
							};
						}),
					})),
				})),
			} as unknown as DatabaseTransaction;

			const mockDb = {
				transaction: vi.fn(async (cb) => cb(mockTx)),
			} as unknown as Database;

			vi.spyOn(
				ledgerProvisioning,
				"ensureCreditCardLedgerLinkInTransaction",
			).mockResolvedValue(liabilityAccountId);

			await expect(
				payCreditCardStatement({
					db: mockDb,
					userId,
					statementId,
					expectedRevisionNo: 1,
					paymentAmount: "100.00",
					paymentMethod: "OUTSIDE_MIDAS",
					paymentAssetAccountId: assetAccountId,
					occurredAt: new Date("2026-09-10T12:00:00Z"),
					idempotencyKey: "k-pay-outside-cross-curr-1",
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				}),
			);
		});
	});
});
