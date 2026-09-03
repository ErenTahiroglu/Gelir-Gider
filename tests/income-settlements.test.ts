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

describe("Income Settlements Service", () => {
	it("creates an income settlement in exactly 1 outer transaction without nested transactions", async () => {
		let outerTxCount = 0;

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
										canonicalTransactionId: "canon-rx-1",
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
										amount: "8000.00",
										occurredAt: new Date(),
									},
								]);
							}
							if (table === incomeEntitlements) {
								return Promise.resolve([
									{
										id: "ent-sep",
										userId: "user-1",
										sourceId: "source-1",
										periodMonth: "2026-09-01",
									},
								]);
							}
							if (table === incomeEntitlementRevisions) {
								return Promise.resolve([
									{
										id: "ent-rev-sep",
										userId: "user-1",
										entitlementId: "ent-sep",
										revisionNo: 1,
										operation: "CREATE",
										amount: "4000.00",
									},
								]);
							}
							if (table === incomeSettlementBatches) {
								return Promise.resolve([]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => {
							const p: any = Promise.resolve([]);
							p.limit = vi.fn().mockResolvedValue([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: "receipt-1",
									revisionNo: 1,
									operation: "CREATE",
									amount: "8000.00",
									occurredAt: new Date(),
								},
							]);
							return p;
						}),
						for: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation((table) => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockImplementation(() => {
						if (table === incomeSettlementBatches) {
							return Promise.resolve([
								{
									id: "batch-1",
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
									previousSettlementRevisionId:
										vals.previousSettlementRevisionId,
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
				idempotentReplay: false,
				operation: "CREATE",
			});

		const res = await createIncomeSettlement({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: "receipt-1",
			allocations: [
				{
					entitlementId: "ent-sep",
					amount: "4000.00",
				},
			],
			idempotencyKey: "set-idem-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.idempotentReplay).toBe(false);
		expect(res.settlement.settlementBatchId).toBe("batch-1");
		expect(res.settlement.allocatedAmount).toBe("4000.00");
		expect(res.settlement.unallocatedAmount).toBe("4000.00");
		expect(res.settlement.allocations).toHaveLength(1);

		canonSpy.mockRestore();
	});

	it("sorts allocations deterministically by entitlementId ASC before creating canonical payload", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
										canonicalTransactionId: "canon-rx-1",
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
										amount: "8000.00",
										occurredAt: new Date(),
									},
								]);
							}
							if (table === incomeEntitlements) {
								return Promise.resolve([
									{
										id: "ent-z",
										userId: "user-1",
										sourceId: "source-1",
										periodMonth: "2026-10-01",
									},
								]);
							}
							if (table === incomeEntitlementRevisions) {
								return Promise.resolve([
									{
										id: "ent-rev-z",
										userId: "user-1",
										entitlementId: "ent-z",
										revisionNo: 1,
										operation: "CREATE",
										amount: "4000.00",
									},
								]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => {
							const p: any = Promise.resolve([]);
							p.limit = vi.fn().mockResolvedValue([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: "receipt-1",
									revisionNo: 1,
									operation: "CREATE",
									amount: "8000.00",
									occurredAt: new Date(),
								},
							]);
							return p;
						}),
						for: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockResolvedValue([
						{
							...vals,
							id: "batch-1",
							createdAt: new Date(),
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

		let capturedPayload: Record<string, unknown> | null = null;

		const canonSpy = vi
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockImplementation((args) => {
				capturedPayload = args.payload;
				return Promise.resolve({
					transactionId: "canon-set-tx-1",
					revisionId: "canon-set-rev-1",
					revisionNo: 1,
					idempotentReplay: false,
					operation: "CREATE",
				});
			});

		// Pass unordered: ["ent-z", "ent-a"]
		await createIncomeSettlement({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: "receipt-1",
			allocations: [
				{ entitlementId: "ent-z", amount: "4000.00" },
				{ entitlementId: "ent-a", amount: "4000.00" },
			],
			idempotencyKey: "set-idem-sort",
			provenance: { type: "MANUAL" },
		});

		expect(capturedPayload).not.toBeNull();
		const allocs = (capturedPayload as any).allocations;
		expect(allocs[0].entitlementId).toBe("ent-a");
		expect(allocs[1].entitlementId).toBe("ent-z");

		canonSpy.mockRestore();
	});

	it("rejects duplicate entitlementId inside allocations input", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeSettlement({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				allocations: [
					{ entitlementId: "ent-1", amount: "2000.00" },
					{ entitlementId: "ent-1", amount: "2000.00" }, // duplicate!
				],
				idempotencyKey: "set-idem-dup",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});

	it("rejects receipt over-allocation (sum of allocations > receipt amount)", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
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
										amount: "4000.00", // receipt amount is 4000.00
									},
								]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockResolvedValue([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: "receipt-1",
									revisionNo: 1,
									operation: "CREATE",
									amount: "4000.00",
								},
							]),
						})),
						for: vi.fn().mockResolvedValue([]),
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

		// Allocating 5000.00 against 4000.00 receipt MUST be rejected
		await expect(
			createIncomeSettlement({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				allocations: [{ entitlementId: "ent-1", amount: "5000.00" }],
				idempotencyKey: "set-idem-over",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});

	it("rejects cross-source allocation (entitlement source != receipt source)", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-kyk", // receipt source is KYK
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
							if (table === incomeEntitlements) {
								return Promise.resolve([
									{
										id: "ent-scholarship",
										userId: "user-1",
										sourceId: "source-scholarship", // different source!
									},
								]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockResolvedValue([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: "receipt-1",
									revisionNo: 1,
									operation: "CREATE",
									amount: "4000.00",
								},
							]),
						})),
						for: vi.fn().mockResolvedValue([]),
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
			createIncomeSettlement({
				db: mockDb,
				userId: "user-1",
				incomeReceiptId: "receipt-1",
				allocations: [{ entitlementId: "ent-scholarship", amount: "4000.00" }],
				idempotencyKey: "set-idem-cross",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});

	it("revises settlement allocations and allows clearing allocations ([])", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === incomeReceipts) {
								return Promise.resolve([
									{
										id: "receipt-1",
										userId: "user-1",
										sourceId: "source-1",
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
										occurredAt: new Date(),
									},
								]);
							}
							if (table === incomeSettlementBatches) {
								return Promise.resolve([
									{
										id: "batch-1",
										userId: "user-1",
										incomeReceiptId: "receipt-1",
										canonicalTransactionId: "canon-set-tx-1",
									},
								]);
							}
							if (table === incomeSettlementBatchRevisions) {
								return Promise.resolve([
									{
										id: "batch-rev-1",
										userId: "user-1",
										settlementBatchId: "batch-1",
										revisionNo: 1,
										allocations: [
											{ entitlementId: "ent-1", amount: "4000.00" },
										],
									},
								]);
							}
							return Promise.resolve([]);
						}),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockResolvedValue([
								{
									id: "receipt-rev-1",
									userId: "user-1",
									incomeReceiptId: "receipt-1",
									revisionNo: 1,
									operation: "CREATE",
									amount: "4000.00",
									occurredAt: new Date(),
								},
							]),
						})),
						for: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockResolvedValue([
						{
							...vals,
							id: "batch-rev-2",
							createdAt: new Date(),
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

		const canonSpy = vi
			.spyOn(canonicalService, "reviseCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-set-tx-1",
				revisionId: "canon-set-rev-2",
				revisionNo: 2,
				idempotentReplay: false,
				operation: "UPDATE",
			});

		// Clear allocations with []
		const res = await reviseIncomeSettlement({
			db: mockDb,
			userId: "user-1",
			incomeReceiptId: "receipt-1",
			expectedRevisionNo: 1,
			allocations: [],
			idempotencyKey: "rev-set-clear-1",
			reasonCode: "CLEAR_ALLOCATIONS",
			provenance: { type: "MANUAL" },
		});

		expect(res.settlement.allocatedAmount).toBe("0.00");
		expect(res.settlement.unallocatedAmount).toBe("4000.00");
		expect(res.settlement.allocations).toHaveLength(0);

		canonSpy.mockRestore();
	});
});
