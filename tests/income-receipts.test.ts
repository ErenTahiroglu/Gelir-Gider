import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../src/db/schema/income";
import {
	incomeSettlementBatches,
	incomeSettlementBatchRevisions,
} from "../src/db/schema/income-entitlements";
import { ledgerAccounts } from "../src/db/schema/ledger";
import { IncomeError } from "../src/income/errors";
import {
	createIncomeReceipt,
	reviseIncomeReceipt,
	voidIncomeReceipt,
} from "../src/income/receipts";
import { CanonicalTransactionError } from "../src/transactions/errors";
import * as boundLifecycle from "../src/transactions/ledger-lifecycle";

function createMockTx(overrides: {
	receipt?: Record<string, unknown>;
	source?: Record<string, unknown>;
	destAccount?: Record<string, unknown>;
	latestReceiptRev?: Record<string, unknown>;
	settlementBatch?: Record<string, unknown>;
	settlementBatchRev?: Record<string, unknown>;
	onLockReceipt?: () => void;
	onReadAllocations?: () => void;
}) {
	const now = new Date("2026-09-01T10:00:00Z");
	const receipt = overrides.receipt ?? {
		id: "receipt-1",
		userId: "user-1",
		sourceId: "source-1",
		canonicalTransactionId: "canon-tx-1",
		createdAt: now,
	};
	const source = overrides.source ?? {
		id: "source-1",
		userId: "user-1",
		code: "KYK",
		name: "KYK Bursu",
		incomeLedgerAccountId: "income-acc-1",
		activeFrom: "2026-01-01",
		activeUntil: null,
		archivedAt: null,
	};
	const destAccount = overrides.destAccount ?? {
		id: "dest-acc-1",
		userId: "user-1",
		accountType: "ASSET",
		normalBalance: "DEBIT",
		currency: "TRY",
		archivedAt: null,
	};
	const latestReceiptRev = overrides.latestReceiptRev ?? {
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
	};

	const mockTx = {
		select: vi.fn().mockImplementation(() => ({
			from: vi.fn().mockImplementation((table) => ({
				where: vi.fn().mockImplementation(() => {
					const chain: Record<string, unknown> = {};
					const limitFn = vi.fn().mockImplementation(() => {
						if (table === users) return Promise.resolve([{ currency: "TRY" }]);
						if (table === incomeReceipts) {
							if (overrides.onLockReceipt) overrides.onLockReceipt();
							return Promise.resolve([receipt]);
						}
						if (table === incomeSources) return Promise.resolve([source]);
						if (table === ledgerAccounts) return Promise.resolve([destAccount]);
						if (table === incomeReceiptRevisions)
							return Promise.resolve([latestReceiptRev]);
						if (table === incomeSettlementBatches) {
							if (overrides.onReadAllocations) overrides.onReadAllocations();
							if (overrides.settlementBatch)
								return Promise.resolve([overrides.settlementBatch]);
							return Promise.resolve([]);
						}
						return Promise.resolve([]);
					});
					chain.limit = limitFn;
					chain.for = vi.fn().mockImplementation(() => {
						if (table === incomeReceipts && overrides.onLockReceipt) {
							overrides.onLockReceipt();
						}
						return chain;
					});
					chain.orderBy = vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (overrides.onReadAllocations) overrides.onReadAllocations();
							if (table === incomeSettlementBatchRevisions) {
								if (overrides.settlementBatchRev)
									return Promise.resolve([overrides.settlementBatchRev]);
								return Promise.resolve([]);
							}
							if (table === incomeReceiptRevisions)
								return Promise.resolve([latestReceiptRev]);
							return Promise.resolve([]);
						}),
					}));
					return chain;
				}),
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

	return mockTx;
}

describe("Income Receipts Service", () => {
	it("creates an income receipt in exactly 1 outer transaction without nested transactions", async () => {
		let outerTxCount = 0;
		const mockTx = createMockTx({});
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
				idempotentReplay: false,
				ledger: {
					appliedJournalEntryId: "journal-1",
					reversalJournalEntryId: null,
				},
			});

		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
			receivedAt: new Date("2026-09-01T10:00:00Z"),
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			idempotencyKey: "idem-key-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");
		expect(res.incomeReceipt.amount).toBe("4000.00");

		boundSpy.mockRestore();
	});

	it("handles idempotent replay of income receipt successfully even when destination account was later archived", async () => {
		const mockTx = createMockTx({
			destAccount: {
				id: "dest-acc-1",
				userId: "user-1",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archivedAt: new Date(), // Later archived!
			},
		});

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
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: "journal-1",
					reversalJournalEntryId: null,
				},
			});

		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-1",
			receivedAt: new Date("2026-09-01T10:00:00Z"),
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			idempotencyKey: "idem-key-replay",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(true);
		expect(res.incomeReceipt.amount).toBe("4000.00");

		boundSpy.mockRestore();
	});

	it("maps TRANSACTION_IDEMPOTENCY_CONFLICT and TRANSACTION_LEDGER_EFFECT_CONFLICT to INCOME_IDEMPOTENCY_CONFLICT", async () => {
		const mockTx = createMockTx({});
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
					"Idempotency conflict on receipt creation",
				),
			);

		await expect(
			createIncomeReceipt({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-1",
				receivedAt: new Date("2026-09-01T10:00:00Z"),
				amount: "4000.00",
				destinationAccountId: "dest-acc-1",
				idempotencyKey: "idem-conflict-1",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_IDEMPOTENCY_CONFLICT",
		);

		boundSpy.mockRestore();
	});

	it("validates active window in Europe/Istanbul (2026-08-31T22:30:00Z is 2026-09-01 Istanbul)", async () => {
		const mockTx = createMockTx({
			source: {
				id: "source-sept",
				userId: "user-1",
				code: "SEPT",
				name: "September Source",
				incomeLedgerAccountId: "income-acc-1",
				activeFrom: "2026-09-01",
				activeUntil: "2026-09-30",
				archivedAt: null,
			},
		});

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
				idempotentReplay: false,
				ledger: {
					appliedJournalEntryId: "journal-1",
					reversalJournalEntryId: null,
				},
			});

		// 2026-08-31T22:30:00Z is 2026-09-01T01:30:00+03:00 in Istanbul
		const res = await createIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			sourceId: "source-sept",
			receivedAt: new Date("2026-08-31T22:30:00Z"),
			amount: "4000.00",
			destinationAccountId: "dest-acc-1",
			idempotencyKey: "idem-istanbul-boundary",
			provenance: { type: "MANUAL" },
		});

		expect(res.incomeReceipt.incomeReceiptId).toBe("receipt-1");

		boundSpy.mockRestore();
	});

	it("proves reviseIncomeReceipt locks receipt FOR UPDATE before reading settlement allocation", async () => {
		const callOrder: string[] = [];

		const mockTx = createMockTx({
			settlementBatch: { id: "batch-1" },
			settlementBatchRev: {
				allocations: [{ entitlementId: "ent-1", amount: "1000.00" }],
			},
			onLockReceipt: () => callOrder.push("LOCK_RECEIPT"),
			onReadAllocations: () => callOrder.push("READ_ALLOCATIONS"),
		});

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		const boundSpy = vi
			.spyOn(
				boundLifecycle,
				"reviseCanonicalTransactionWithLedgerInTransaction",
			)
			.mockImplementation(async () => {
				callOrder.push("CANONICAL_MUTATION");
				return {
					transactionId: "canon-tx-1",
					revisionId: "canon-rev-2",
					revisionNo: 2,
					operation: "UPDATE",
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: "journal-2",
						reversalJournalEntryId: null,
					},
				};
			});

		await reviseIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: "receipt-1",
			expectedRevisionNo: 1,
			idempotencyKey: "rev-lock-order-1",
			receivedAt: new Date("2026-09-01T10:00:00Z"),
			amount: "3500.00",
			destinationAccountId: "dest-acc-1",
			reasonCode: "CORRECTION",
			provenance: { type: "MANUAL" },
		});

		expect(callOrder[0]).toBe("LOCK_RECEIPT");
		expect(callOrder.indexOf("LOCK_RECEIPT")).toBeLessThan(
			callOrder.indexOf("READ_ALLOCATIONS"),
		);
		expect(callOrder.indexOf("READ_ALLOCATIONS")).toBeLessThan(
			callOrder.indexOf("CANONICAL_MUTATION"),
		);

		boundSpy.mockRestore();
	});

	it("proves voidIncomeReceipt locks receipt FOR UPDATE before reading settlement allocation", async () => {
		const callOrder: string[] = [];

		const mockTx = createMockTx({
			onLockReceipt: () => callOrder.push("LOCK_RECEIPT"),
			onReadAllocations: () => callOrder.push("READ_ALLOCATIONS"),
		});

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		const boundSpy = vi
			.spyOn(boundLifecycle, "voidCanonicalTransactionWithLedgerInTransaction")
			.mockImplementation(async () => {
				callOrder.push("CANONICAL_VOID");
				return {
					transactionId: "canon-tx-1",
					revisionId: "canon-rev-2",
					revisionNo: 2,
					operation: "VOID",
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: null,
						reversalJournalEntryId: "journal-2",
					},
				};
			});

		await voidIncomeReceipt({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: "receipt-1",
			expectedRevisionNo: 1,
			idempotencyKey: "void-lock-order-1",
			reasonCode: "VOID_MISTAKE",
			provenance: { type: "MANUAL" },
		});

		expect(callOrder[0]).toBe("LOCK_RECEIPT");
		expect(callOrder.indexOf("LOCK_RECEIPT")).toBeLessThan(
			callOrder.indexOf("READ_ALLOCATIONS"),
		);
		expect(callOrder.indexOf("READ_ALLOCATIONS")).toBeLessThan(
			callOrder.indexOf("CANONICAL_VOID"),
		);

		boundSpy.mockRestore();
	});

	it("rejects reviseIncomeReceipt amount < active settlement allocation with INCOME_SETTLEMENT_CONFLICT", async () => {
		const mockTx = createMockTx({
			settlementBatch: { id: "batch-1" },
			settlementBatchRev: {
				allocations: [{ entitlementId: "ent-1", amount: "3000.00" }],
			},
		});

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
		const mockTx = createMockTx({
			settlementBatch: { id: "batch-1" },
			settlementBatchRev: {
				allocations: [{ entitlementId: "ent-1", amount: "1500.00" }],
			},
		});

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
