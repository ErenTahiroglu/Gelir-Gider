import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../src/db/schema/income";
import { ledgerAccounts } from "../src/db/schema/ledger";
import { createIncomeReceipt } from "../src/income/receipts";
import * as boundLifecycle from "../src/transactions/ledger-lifecycle";

describe("Income Receipts Service", () => {
	it("creates an income receipt in exactly 1 outer transaction without nested transactions", async () => {
		let outerTxCount = 0;
		const now = new Date("2026-09-01T10:00:00Z");

		// Transaction object has NO `transaction` method!
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-1",
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										incomeLedgerAccountId: "income-acc-1",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "dest-acc-1",
										userId: "user-1",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										archivedAt: null,
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation((table) => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockImplementation(() => {
						if (table === incomeReceipts) {
							return Promise.resolve([
								{
									id: "receipt-1",
									userId: vals.userId,
									sourceId: vals.sourceId,
									canonicalTransactionId: vals.canonicalTransactionId,
									createdAt: now,
								},
							]);
						}
						if (table === incomeReceiptRevisions) {
							return Promise.resolve([
								{
									id: "receipt-rev-1",
									userId: vals.userId,
									incomeReceiptId: vals.incomeReceiptId,
									canonicalRevisionId: vals.canonicalRevisionId,
									revisionNo: vals.revisionNo,
									previousReceiptRevisionId: vals.previousReceiptRevisionId,
									operation: vals.operation,
									occurredAt: vals.occurredAt,
									amount: vals.amount,
									destinationAccountId: vals.destinationAccountId,
									note: vals.note,
									createdAt: now,
								},
							]);
						}
						return Promise.resolve([vals]);
					}),
				})),
			})),
		} as unknown as DatabaseTransaction;

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
					outerTxCount++;
					return await cb(mockTx);
				},
			),
		} as unknown as Database;

		const boundSpy = vi
			.spyOn(
				boundLifecycle,
				"createCanonicalTransactionWithLedgerInTransaction",
			)
			.mockResolvedValueOnce({
				transactionId: "canon-tx-1",
				revisionId: "canon-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				idempotentReplay: false,
				ledger: {
					appliedJournalEntryId: "entry-1",
					reversalJournalEntryId: null,
				},
			});

		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
			idempotencyKey: "receipt-idem-1",
			receivedAt: now,
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			note: "September KYK",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.idempotentReplay).toBe(false);
		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");
		expect(res.incomeReceipt.amount).toBe("4000.00");
		expect(res.incomeReceipt.status).toBe("ACTIVE");

		expect(boundSpy).toHaveBeenCalledTimes(1);
		boundSpy.mockRestore();
	});

	it("replays existing receipt idempotently when canonical creation is replayed", async () => {
		const now = new Date("2026-09-01T10:00:00Z");

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-1",
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										incomeLedgerAccountId: "income-acc-1",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "dest-acc-1",
										userId: "user-1",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										archivedAt: null,
									},
								]);
							}
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
										canonicalTransactionId: "canon-tx-1",
										createdAt: now,
									},
								]);
							}
							if (table === incomeReceiptRevisions) {
								return Promise.resolve([
									{
										id: "receipt-rev-1",
										userId: "user-1",
										incomeReceiptId: "receipt-1",
										canonicalRevisionId: "canon-rev-1",
										revisionNo: 1,
										previousReceiptRevisionId: null,
										operation: "CREATE",
										occurredAt: now,
										amount: "4000.00",
										destinationAccountId: "dest-acc-1",
										note: "September KYK",
										createdAt: now,
									},
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

		const boundSpy = vi
			.spyOn(
				boundLifecycle,
				"createCanonicalTransactionWithLedgerInTransaction",
			)
			.mockResolvedValueOnce({
				transactionId: "canon-tx-1",
				revisionId: "canon-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: "entry-1",
					reversalJournalEntryId: null,
				},
			});

		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
			idempotencyKey: "receipt-idem-1",
			receivedAt: now,
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			note: "September KYK",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(true);
		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");
		expect(res.incomeReceipt.amount).toBe("4000.00");

		boundSpy.mockRestore();
	});

	it("rejects receipt creation on archived destination account", async () => {
		const now = new Date("2026-09-01T10:00:00Z");

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users) {
								return Promise.resolve([{ currency: "TRY" }]);
							}
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-1",
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										incomeLedgerAccountId: "income-acc-1",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === ledgerAccounts) {
								return Promise.resolve([
									{
										id: "dest-acc-archived",
										userId: "user-1",
										accountType: "ASSET",
										normalBalance: "DEBIT",
										currency: "TRY",
										archivedAt: new Date(),
									},
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

		await expect(
			createIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-1",
				idempotencyKey: "receipt-idem-1",
				receivedAt: now,
				amount: "4000.00",
				destinationAccountId: "dest-acc-archived",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toThrow(
			"Cannot post income receipt to an archived destination account",
		);
	});
});
