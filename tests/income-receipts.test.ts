import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../src/db/schema/income";
import { ledgerAccounts } from "../src/db/schema/ledger";
import { IncomeError } from "../src/income/errors";
import {
	createIncomeReceipt,
	reviseIncomeReceipt,
	voidIncomeReceipt,
} from "../src/income/receipts";
import { CanonicalTransactionError } from "../src/transactions/errors";
import * as boundLifecycle from "../src/transactions/ledger-lifecycle";

describe("Income Receipts Service", () => {
	it("creates an income receipt in exactly 1 outer transaction without nested transactions", async () => {
		let outerTxCount = 0;
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
			.mockResolvedValue({
				transactionId: "canon-tx-1",
				revisionId: "canon-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				ledger: {
					appliedJournalEntryId: "journal-1",
					reversalJournalEntryId: null,
				},
				idempotentReplay: false,
			});

		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
			idempotencyKey: "receipt-idem-1",
			receivedAt: now,
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.idempotentReplay).toBe(false);
		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");
		expect(res.incomeReceipt.amount).toBe("4000.00");
		expect(res.incomeReceipt.status).toBe("ACTIVE");

		boundSpy.mockRestore();
	});

	it("handles idempotent replay of income receipt successfully even when destination account was later archived", async () => {
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
										archivedAt: new Date("2026-09-02T10:00:00Z"), // Later archived!
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
										note: null,
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
			.mockResolvedValue({
				transactionId: "canon-tx-1",
				revisionId: "canon-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				ledger: {
					appliedJournalEntryId: "journal-1",
					reversalJournalEntryId: null,
				},
				idempotentReplay: true,
			});

		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
			idempotencyKey: "receipt-idem-1",
			receivedAt: now,
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(true);
		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");
		expect(res.incomeReceipt.amount).toBe("4000.00");

		boundSpy.mockRestore();
	});

	it("maps TRANSACTION_IDEMPOTENCY_CONFLICT and TRANSACTION_LEDGER_EFFECT_CONFLICT to INCOME_IDEMPOTENCY_CONFLICT", async () => {
		const now = new Date("2026-09-01T10:00:00Z");

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
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
			.mockRejectedValue(
				new CanonicalTransactionError(
					"TRANSACTION_IDEMPOTENCY_CONFLICT",
					"Idempotency conflict at canonical layer",
				),
			);

		await expect(
			createIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-1",
				idempotencyKey: "receipt-idem-1",
				receivedAt: now,
				amount: "4000.00",
				destinationAccountId: "dest-acc-1",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_IDEMPOTENCY_CONFLICT",
		);

		boundSpy.mockRestore();
	});

	it("validates active window in Europe/Istanbul (2026-08-31T22:30:00Z is 2026-09-01 Istanbul)", async () => {
		const receivedAtUtc = new Date("2026-08-31T22:30:00Z");

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-sept",
										userId: "user-1",
										code: "SEPT",
										name: "September Source",
										incomeLedgerAccountId: "income-acc-1",
										activeFrom: "2026-09-01",
										activeUntil: "2026-09-30",
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
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockResolvedValue([
						{
							...vals,
							id: "receipt-1",
							createdAt: receivedAtUtc,
						},
					]),
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
			.mockResolvedValue({
				transactionId: "canon-tx-1",
				revisionId: "canon-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				ledger: {
					appliedJournalEntryId: "journal-1",
					reversalJournalEntryId: null,
				},
				idempotentReplay: false,
			});

		// 2026-08-31T22:30:00Z is 2026-09-01 in Europe/Istanbul -> should PASS for activeFrom: 2026-09-01
		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-sept",
			idempotencyKey: "receipt-idem-tz",
			receivedAt: receivedAtUtc,
			amount: "1000.00",
			destinationAccountId: "dest-acc-1",
			provenance: { type: "MANUAL" },
		});

		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");

		boundSpy.mockRestore();
	});

	it("rejects reviseIncomeReceipt when moving receipt outside source active window", async () => {
		const newDateOutside = new Date("2026-10-01T10:00:00Z"); // October is outside active window [2026-09-01, 2026-09-30]

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-sept",
										canonicalTransactionId: "canon-tx-1",
										createdAt: new Date(),
									},
								]);
							}
							if (table === incomeSources) {
								return Promise.resolve([
									{
										id: "source-sept",
										userId: "user-1",
										code: "SEPT",
										name: "September Source",
										incomeLedgerAccountId: "income-acc-1",
										activeFrom: "2026-09-01",
										activeUntil: "2026-09-30",
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
		} as unknown as DatabaseTransaction;

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		await expect(
			reviseIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				expectedRevisionNo: 1,
				idempotencyKey: "rev-key-1",
				receivedAt: newDateOutside,
				amount: "1500.00",
				destinationAccountId: "dest-acc-1",
				reasonCode: "CORRECTION",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});

	it("maps voidIncomeReceipt idempotency conflict to INCOME_IDEMPOTENCY_CONFLICT", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
										canonicalTransactionId: "canon-tx-1",
										createdAt: new Date(),
									},
								]);
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
										occurredAt: new Date(),
										amount: "4000.00",
										destinationAccountId: "dest-acc-1",
										note: null,
										createdAt: new Date(),
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
			.spyOn(boundLifecycle, "voidCanonicalTransactionWithLedgerInTransaction")
			.mockRejectedValue(
				new CanonicalTransactionError(
					"TRANSACTION_IDEMPOTENCY_CONFLICT",
					"Idempotency conflict on void",
				),
			);

		await expect(
			voidIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				expectedRevisionNo: 1,
				idempotencyKey: "void-key-1",
				reasonCode: "VOID_MISTAKE",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_IDEMPOTENCY_CONFLICT",
		);

		boundSpy.mockRestore();
	});

	it("rejects reviseIncomeReceipt amount < active settlement allocation with INCOME_SETTLEMENT_CONFLICT", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
										canonicalTransactionId: "canon-tx-1",
									},
								]);
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
							if (table === incomeReceiptRevisions) {
								return Promise.resolve([
									{
										id: "receipt-rev-1",
										userId: "user-1",
										incomeReceiptId: "receipt-1",
										revisionNo: 1,
										operation: "CREATE",
										amount: "4000.00",
									},
								]);
							}
							// Settlement batch
							return Promise.resolve([
								{
									id: "batch-1",
								},
							]);
						}),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockResolvedValue([
								{
									allocations: [
										{
											entitlementId: "ent-1",
											amount: "3000.00", // 3000.00 allocated!
										},
									],
								},
							]),
						})),
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

		// Attempting to revise amount to 2500.00 (< 3000.00 allocated) MUST throw INCOME_SETTLEMENT_CONFLICT
		await expect(
			reviseIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				expectedRevisionNo: 1,
				idempotencyKey: "rev-rx-less-than-alloc",
				receivedAt: new Date("2026-09-05T10:00:00Z"),
				amount: "2500.00",
				destinationAccountId: "dest-acc-1",
				reasonCode: "CORRECTION",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});

	it("rejects voidIncomeReceipt when receipt has active settlement allocations with INCOME_SETTLEMENT_CONFLICT", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
										canonicalTransactionId: "canon-tx-1",
									},
								]);
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
							if (table === incomeReceiptRevisions) {
								return Promise.resolve([
									{
										id: "receipt-rev-1",
										userId: "user-1",
										incomeReceiptId: "receipt-1",
										revisionNo: 1,
										operation: "CREATE",
										amount: "4000.00",
									},
								]);
							}
							// Settlement batch exists
							return Promise.resolve([
								{
									id: "batch-1",
								},
							]);
						}),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockResolvedValue([
								{
									allocations: [
										{
											entitlementId: "ent-1",
											amount: "1500.00", // active allocation exists!
										},
									],
								},
							]),
						})),
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
			voidIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				expectedRevisionNo: 1,
				idempotencyKey: "void-rx-with-alloc",
				reasonCode: "VOID_MISTAKE",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});
});
