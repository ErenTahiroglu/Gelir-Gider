import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
} from "../src/db/schema/income";
import {
	incomeEntitlementRevisions,
	incomeEntitlements,
	incomeSettlementBatches,
	incomeSettlementBatchRevisions,
} from "../src/db/schema/income-entitlements";
import { IncomeError } from "../src/income/errors";
import {
	createIncomeSettlement,
	reviseIncomeSettlement,
} from "../src/income/settlements";
import * as canonicalService from "../src/transactions/service";

const RECEIPT_UUID = "a0000000-0000-0000-0000-000000000001";
const ENT_SEP_UUID = "b0000000-0000-0000-0000-000000000001";
const ENT_OCT_UUID = "b0000000-0000-0000-0000-000000000002";
const BATCH_UUID = "c0000000-0000-0000-0000-000000000001";

function createMockPromise(arr: unknown[] = []) {
	const p = Promise.resolve(arr) as Promise<unknown[]> & {
		limit: (n: number) => Promise<unknown[]>;
		for: () => Promise<unknown[]>;
		orderBy: () => Promise<unknown[]>;
	};
	p.limit = vi.fn().mockImplementation(() => Promise.resolve(arr));
	p.for = vi.fn().mockImplementation(() => Promise.resolve(arr));
	p.orderBy = vi.fn().mockImplementation(() => Promise.resolve(arr));
	return p;
}

function createMockTx(options?: {
	onLock?: () => void;
	onReadReceiptRev?: () => void;
	receiptAmount?: string;
	entitlements?: Array<{ id: string; periodMonth: string; amount: string }>;
	batchRev?: {
		id: string;
		allocations: Array<{ entitlementId: string; amount: string }>;
	};
}) {
	const receiptAmount = options?.receiptAmount ?? "8000.00";
	const ents = options?.entitlements ?? [
		{ id: ENT_SEP_UUID, periodMonth: "2026-09-01", amount: "4000.00" },
	];

	const mockTx = {
		select: vi.fn().mockImplementation(() => ({
			from: vi.fn().mockImplementation((table) => ({
				where: vi.fn().mockImplementation(() => {
					const chain: Record<string, unknown> = {};
					const limitFn = vi.fn().mockImplementation(() => {
						if (table === users) return Promise.resolve([{ currency: "TRY" }]);
						if (table === incomeReceipts) {
							return Promise.resolve([
								{
									id: RECEIPT_UUID,
									userId: "user-1",
									sourceId: "source-1",
									canonicalTransactionId: "canon-rx-1",
								},
							]);
						}
						if (table === incomeReceiptRevisions) {
							if (options?.onReadReceiptRev) options.onReadReceiptRev();
							return Promise.resolve([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: RECEIPT_UUID,
									revisionNo: 1,
									operation: "CREATE",
									amount: receiptAmount,
									occurredAt: new Date("2026-09-01T10:00:00Z"),
								},
							]);
						}
						if (table === incomeEntitlements) {
							return Promise.resolve(
								ents.map((e) => ({
									id: e.id,
									userId: "user-1",
									sourceId: "source-1",
									periodMonth: e.periodMonth,
								})),
							);
						}
						if (table === incomeEntitlementRevisions) {
							return Promise.resolve(
								ents.map((e) => ({
									id: `ent-rev-${e.id}`,
									userId: "user-1",
									entitlementId: e.id,
									revisionNo: 1,
									operation: "CREATE",
									amount: e.amount,
								})),
							);
						}
						if (table === incomeSettlementBatches) {
							if (options?.batchRev) {
								return Promise.resolve([
									{
										id: BATCH_UUID,
										userId: "user-1",
										incomeReceiptId: RECEIPT_UUID,
										canonicalTransactionId: "canon-set-tx-1",
									},
								]);
							}
							return Promise.resolve([]);
						}
						if (table === incomeSettlementBatchRevisions) {
							if (options?.batchRev) {
								return Promise.resolve([
									{
										id: options.batchRev.id,
										settlementBatchId: BATCH_UUID,
										revisionNo: 1,
										allocations: options.batchRev.allocations,
									},
								]);
							}
							return Promise.resolve([]);
						}
						return Promise.resolve([]);
					});
					chain.limit = limitFn;
					chain.orderBy = vi.fn().mockImplementation(() => {
						if (table === incomeEntitlements) {
							return createMockPromise(
								ents.map((e) => ({ id: e.id, sourceId: "source-1" })),
							);
						}
						if (table === incomeEntitlementRevisions) {
							return createMockPromise(
								ents.map((e) => ({
									id: `ent-rev-${e.id}`,
									userId: "user-1",
									entitlementId: e.id,
									revisionNo: 1,
									operation: "CREATE",
									amount: e.amount,
								})),
							);
						}
						if (table === incomeReceiptRevisions) {
							if (options?.onReadReceiptRev) options.onReadReceiptRev();
							return createMockPromise([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: RECEIPT_UUID,
									revisionNo: 1,
									operation: "CREATE",
									amount: receiptAmount,
									occurredAt: new Date("2026-09-01T10:00:00Z"),
								},
							]);
						}
						if (table === incomeSettlementBatchRevisions) {
							return createMockPromise([]);
						}
						return createMockPromise([]);
					});
					chain.for = vi.fn().mockImplementation(() => {
						if (options?.onLock) options.onLock();
						const forChain: Record<string, unknown> = {
							limit: limitFn,
							orderBy: vi
								.fn()
								.mockImplementation(() =>
									createMockPromise(
										ents.map((e) => ({ id: e.id, sourceId: "source-1" })),
									),
								),
						};
						return forChain;
					});
					return chain;
				}),
			})),
		})),
		insert: vi.fn().mockImplementation((table) => ({
			values: vi.fn().mockImplementation((vals) => ({
				returning: vi.fn().mockImplementation(() => {
					if (table === incomeSettlementBatches) {
						return Promise.resolve([
							{
								id: BATCH_UUID,
								userId: vals.userId,
								incomeReceiptId: vals.incomeReceiptId,
								canonicalTransactionId: vals.canonicalTransactionId,
								createdAt: new Date(),
							},
						]);
					}
					if (table === incomeSettlementBatchRevisions) {
						return Promise.resolve([
							{
								id: "batch-rev-1",
								userId: vals.userId,
								settlementBatchId: vals.settlementBatchId,
								canonicalRevisionId: vals.canonicalRevisionId,
								revisionNo: vals.revisionNo,
								previousSettlementRevisionId: vals.previousSettlementRevisionId,
								operation: vals.operation,
								allocations: vals.allocations,
								note: vals.note,
								createdAt: new Date(),
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

describe("Income Settlements Service", () => {
	it("rejects non-UUID entitlementId with INCOME_INVALID_INPUT", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeSettlement({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: RECEIPT_UUID,
				allocations: [{ entitlementId: "not-a-uuid", amount: "1000.00" }],
				idempotencyKey: "idem-1",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});

	it("creates an income settlement in exactly 1 outer transaction and locks receipt before reading receipt revision", async () => {
		let outerTxCount = 0;
		const callOrder: string[] = [];

		const mockTx = createMockTx({
			onLock: () => callOrder.push("LOCK_RECEIPT_AND_ENTS"),
			onReadReceiptRev: () => callOrder.push("READ_RECEIPT_REV"),
			entitlements: [
				{ id: ENT_SEP_UUID, periodMonth: "2026-09-01", amount: "4000.00" },
			],
		});

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
					outerTxCount++;
					return await cb(mockTx);
				},
			),
		} as unknown as Database;

		const canonSpy = vi
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-set-tx-1",
				revisionId: "canon-set-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				idempotentReplay: false,
			});

		const res = await createIncomeSettlement({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: RECEIPT_UUID,
			allocations: [
				{
					entitlementId: ENT_SEP_UUID,
					amount: "4000.00",
				},
			],
			note: "September settlement",
			idempotencyKey: "set-idem-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.settlement.settlementBatchId).toBe(BATCH_UUID);
		expect(res.settlement.allocatedAmount).toBe("4000.00");
		expect(res.settlement.unallocatedAmount).toBe("4000.00");

		// Proves lock happens BEFORE reading latest receipt revision
		expect(callOrder[0]).toBe("LOCK_RECEIPT_AND_ENTS");
		expect(callOrder.indexOf("LOCK_RECEIPT_AND_ENTS")).toBeLessThan(
			callOrder.indexOf("READ_RECEIPT_REV"),
		);

		canonSpy.mockRestore();
	});

	it("sorts allocations deterministically by entitlementId ASC before creating canonical payload", async () => {
		let capturedPayload: Record<string, unknown> | null = null;

		const mockTx = createMockTx({
			entitlements: [
				{ id: ENT_SEP_UUID, periodMonth: "2026-09-01", amount: "4000.00" },
				{ id: ENT_OCT_UUID, periodMonth: "2026-10-01", amount: "4000.00" },
			],
		});

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		const canonSpy = vi
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockImplementation(async (opts) => {
				capturedPayload = opts.payload as Record<string, unknown>;
				return {
					transactionId: "canon-set-tx-1",
					revisionId: "canon-set-rev-1",
					revisionNo: 1,
					operation: "CREATE",
					idempotentReplay: false,
				};
			});

		// Pass out of order: Oct then Sep
		await createIncomeSettlement({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: RECEIPT_UUID,
			allocations: [
				{ entitlementId: ENT_OCT_UUID, amount: "4000.00" },
				{ entitlementId: ENT_SEP_UUID, amount: "4000.00" },
			],
			idempotencyKey: "set-idem-order",
			provenance: { type: "MANUAL" },
		});

		expect(capturedPayload).not.toBeNull();
		const allocs = (
			capturedPayload as unknown as {
				allocations: Array<{ entitlementId: string }>;
			}
		).allocations;
		expect(allocs[0]?.entitlementId).toBe(ENT_SEP_UUID);
		expect(allocs[1]?.entitlementId).toBe(ENT_OCT_UUID);

		canonSpy.mockRestore();
	});

	it("rejects receipt over-allocation (sum of allocations > receipt amount)", async () => {
		const mockTx = createMockTx({
			receiptAmount: "5000.00",
			entitlements: [
				{ id: ENT_SEP_UUID, periodMonth: "2026-09-01", amount: "10000.00" },
			],
		});

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		// Allocating 6000.00 to a 5000.00 receipt MUST reject
		await expect(
			createIncomeSettlement({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: RECEIPT_UUID,
				allocations: [
					{
						entitlementId: ENT_SEP_UUID,
						amount: "6000.00",
					},
				],
				idempotencyKey: "set-fail-over-alloc",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});

	it("revises settlement allocations and allows clearing allocations ([])", async () => {
		const mockTx = createMockTx({
			receiptAmount: "8000.00",
			batchRev: {
				id: "batch-rev-1",
				allocations: [{ entitlementId: ENT_SEP_UUID, amount: "4000.00" }],
			},
			entitlements: [
				{ id: ENT_SEP_UUID, periodMonth: "2026-09-01", amount: "4000.00" },
			],
		});

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		const canonSpy = vi
			.spyOn(canonicalService, "reviseCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-set-tx-1",
				revisionId: "canon-set-rev-2",
				revisionNo: 2,
				operation: "UPDATE",
				idempotentReplay: false,
			});

		const res = await reviseIncomeSettlement({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: RECEIPT_UUID,
			expectedRevisionNo: 1,
			allocations: [], // Clear allocations
			idempotencyKey: "rev-clear-1",
			reasonCode: "CORRECTION",
			provenance: { type: "MANUAL" },
		});

		expect(res.settlement.allocatedAmount).toBe("0.00");
		expect(res.settlement.unallocatedAmount).toBe("8000.00");
		expect(res.settlement.allocations.length).toBe(0);

		canonSpy.mockRestore();
	});
});
