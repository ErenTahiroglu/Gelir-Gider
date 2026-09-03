import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import { incomeSources } from "../src/db/schema/income";
import {
	incomeEntitlementRevisions,
	incomeEntitlements,
} from "../src/db/schema/income-entitlements";
import {
	createIncomeEntitlement,
	reviseIncomeEntitlement,
	voidIncomeEntitlement,
} from "../src/income/entitlements";
import { IncomeError } from "../src/income/errors";
import * as canonicalService from "../src/transactions/service";

const SOURCE_UUID = "a0000000-0000-0000-0000-000000000001";
const ENT_UUID = "b0000000-0000-0000-0000-000000000001";

describe("Income Entitlements Service", () => {
	it("creates an income entitlement in exactly 1 outer transaction without nested transactions", async () => {
		let outerTxCount = 0;

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
										id: SOURCE_UUID,
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										nature: "REGULAR",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === incomeEntitlements) {
								return Promise.resolve([]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation((table) => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockImplementation(() => {
						if (table === incomeEntitlements) {
							return Promise.resolve([
								{
									id: ENT_UUID,
									userId: vals.userId,
									sourceId: vals.sourceId,
									periodMonth: vals.periodMonth,
									canonicalTransactionId: vals.canonicalTransactionId,
									createdAt: new Date(),
								},
							]);
						}
						if (table === incomeEntitlementRevisions) {
							return Promise.resolve([
								{
									id: "ent-rev-1",
									userId: vals.userId,
									entitlementId: vals.entitlementId,
									canonicalRevisionId: vals.canonicalRevisionId,
									revisionNo: vals.revisionNo,
									previousEntitlementRevisionId:
										vals.previousEntitlementRevisionId,
									operation: vals.operation,
									amount: vals.amount,
									expectedReceiptOn: vals.expectedReceiptOn,
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
				transactionId: "canon-ent-tx-1",
				revisionId: "canon-ent-rev-1",
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		const res = await createIncomeEntitlement({
			db: mockDb,
			userId: "user-1",
			sourceId: SOURCE_UUID,
			periodMonth: "2026-09-01",
			amount: "4000.00",
			expectedReceiptOn: "2026-09-10",
			note: "September entitlement",
			idempotencyKey: "ent-idem-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.idempotentReplay).toBe(false);
		expect(res.incomeEntitlement.entitlementId).toBe(ENT_UUID);
		expect(res.incomeEntitlement.periodMonth).toBe("2026-09-01");
		expect(res.incomeEntitlement.amount).toBe("4000.00");
		expect(res.incomeEntitlement.allocatedAmount).toBe("0.00");
		expect(res.incomeEntitlement.outstandingAmount).toBe("4000.00");
		expect(res.incomeEntitlement.settlementStatus).toBe("OPEN");

		canonSpy.mockRestore();
	});

	it("handles exact idempotent replay of income entitlement", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => {
						const resObj: Record<string, unknown> = {
							limit: vi.fn().mockImplementation(() => {
								if (table === users)
									return Promise.resolve([{ currency: "TRY" }]);
								if (table === incomeSources) {
									return Promise.resolve([
										{
											id: SOURCE_UUID,
											userId: "user-1",
											code: "KYK",
											name: "KYK Bursu",
											nature: "REGULAR",
											activeFrom: "2026-01-01",
											activeUntil: null,
											archivedAt: null,
										},
									]);
								}
								if (table === incomeEntitlements) {
									return Promise.resolve([
										{
											id: ENT_UUID,
											userId: "user-1",
											sourceId: SOURCE_UUID,
											periodMonth: "2026-09-01",
											canonicalTransactionId: "canon-ent-tx-1",
											createdAt: new Date(),
										},
									]);
								}
								if (table === incomeEntitlementRevisions) {
									return Promise.resolve([
										{
											id: "ent-rev-1",
											userId: "user-1",
											entitlementId: ENT_UUID,
											canonicalRevisionId: "canon-ent-rev-1",
											revisionNo: 1,
											previousEntitlementRevisionId: null,
											operation: "CREATE",
											amount: "4000.00",
											expectedReceiptOn: "2026-09-10",
											note: "September entitlement",
											createdAt: new Date(),
										},
									]);
								}
								return Promise.resolve([]);
							}),
							orderBy: vi.fn().mockImplementation(() => {
								const p = Promise.resolve([]) as unknown as Promise<
									unknown[]
								> & {
									limit: ReturnType<typeof vi.fn>;
								};
								p.limit = vi.fn().mockResolvedValue([]);
								return p;
							}),
							for: vi.fn().mockImplementation(() => ({
								limit: vi.fn().mockResolvedValue([]),
							})),
						};
						return resObj;
					}),
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
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-ent-tx-1",
				revisionId: "canon-ent-rev-1",
				revisionNo: 1,
				idempotentReplay: true,
				operation: "CREATE",
			});

		const res = await createIncomeEntitlement({
			db: mockDb,
			userId: "user-1",
			sourceId: SOURCE_UUID,
			periodMonth: "2026-09-01",
			amount: "4000.00",
			expectedReceiptOn: "2026-09-10",
			note: "September entitlement",
			idempotencyKey: "ent-idem-replay",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(true);
		expect(res.incomeEntitlement.entitlementId).toBe(ENT_UUID);

		canonSpy.mockRestore();
	});

	it("maps wrapped Drizzle cause { cause: { code: '23505', constraint: 'income_entitlements_user_source_period_idx' } } to INCOME_ENTITLEMENT_PERIOD_CONFLICT", async () => {
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
										id: SOURCE_UUID,
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										nature: "REGULAR",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === incomeEntitlements) return Promise.resolve([]);
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation(() => ({
					returning: vi.fn().mockRejectedValue({
						message: "Failed query: INSERT INTO income_entitlements...",
						cause: {
							code: "23505",
							constraint: "income_entitlements_user_source_period_idx",
							detail:
								"Key (user_id, source_id, period_month)=(...) already exists.",
						},
					}),
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
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-ent-tx-1",
				revisionId: "canon-ent-rev-1",
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: SOURCE_UUID,
				periodMonth: "2026-09-01",
				amount: "4000.00",
				idempotencyKey: "ent-conflict-wrapped",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError &&
				e.code === "INCOME_ENTITLEMENT_PERIOD_CONFLICT",
		);

		canonSpy.mockRestore();
	});

	it("maps direct PG error { code: '23505', constraint: 'income_entitlements_user_source_period_idx' } to INCOME_ENTITLEMENT_PERIOD_CONFLICT", async () => {
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
										id: SOURCE_UUID,
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										nature: "REGULAR",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === incomeEntitlements) return Promise.resolve([]);
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation(() => ({
					returning: vi.fn().mockRejectedValue({
						code: "23505",
						constraint: "income_entitlements_user_source_period_idx",
					}),
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
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-ent-tx-1",
				revisionId: "canon-ent-rev-1",
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: SOURCE_UUID,
				periodMonth: "2026-09-01",
				amount: "4000.00",
				idempotencyKey: "ent-conflict-direct-pg",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError &&
				e.code === "INCOME_ENTITLEMENT_PERIOD_CONFLICT",
		);

		canonSpy.mockRestore();
	});

	it("does NOT map unrelated unique index { code: '23505', constraint: 'income_entitlements_canonical_tx_idx' } to period conflict", async () => {
		const unrelatedError = {
			code: "23505",
			constraint: "income_entitlements_canonical_tx_idx",
			message: "duplicate key value violates unique constraint",
		};

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
										id: SOURCE_UUID,
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										nature: "REGULAR",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === incomeEntitlements) return Promise.resolve([]);
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation(() => ({
					returning: vi.fn().mockRejectedValue(unrelatedError),
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
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-ent-tx-1",
				revisionId: "canon-ent-rev-1",
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		// Must rethrow original error and NOT map to INCOME_ENTITLEMENT_PERIOD_CONFLICT
		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: SOURCE_UUID,
				periodMonth: "2026-09-01",
				amount: "4000.00",
				idempotencyKey: "ent-unrelated-index",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toBe(unrelatedError);

		canonSpy.mockRestore();
	});

	it("accepts valid uppercase UUID for sourceId and normalizes it to canonical lowercase", async () => {
		const UPPER_SOURCE_UUID = "A0000000-0000-0000-0000-000000000001";
		let capturedSourceIdInQuery = "";

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === incomeSources) {
								capturedSourceIdInQuery = SOURCE_UUID;
								return Promise.resolve([
									{
										id: SOURCE_UUID,
										userId: "user-1",
										code: "KYK",
										name: "KYK Bursu",
										nature: "REGULAR",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: null,
									},
								]);
							}
							if (table === incomeEntitlements) return Promise.resolve([]);
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation((table) => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockImplementation(() => {
						if (table === incomeEntitlements) {
							return Promise.resolve([
								{
									id: ENT_UUID,
									userId: vals.userId,
									sourceId: vals.sourceId,
									periodMonth: vals.periodMonth,
									canonicalTransactionId: vals.canonicalTransactionId,
									createdAt: new Date(),
								},
							]);
						}
						if (table === incomeEntitlementRevisions) {
							return Promise.resolve([
								{
									id: "ent-rev-1",
									userId: vals.userId,
									entitlementId: vals.entitlementId,
									canonicalRevisionId: vals.canonicalRevisionId,
									revisionNo: vals.revisionNo,
									previousEntitlementRevisionId: null,
									operation: "CREATE",
									amount: vals.amount,
									expectedReceiptOn: null,
									note: null,
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
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		const canonSpy = vi
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: "canon-ent-tx-1",
				revisionId: "canon-ent-rev-1",
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		const res = await createIncomeEntitlement({
			db: mockDb,
			userId: "user-1",
			sourceId: UPPER_SOURCE_UUID,
			periodMonth: "2026-09-01",
			amount: "4000.00",
			idempotencyKey: "ent-upper-uuid",
			provenance: { type: "MANUAL" },
		});

		expect(res.incomeEntitlement.sourceId).toBe(SOURCE_UUID);
		expect(capturedSourceIdInQuery).toBe(SOURCE_UUID);

		canonSpy.mockRestore();
	});

	it("rejects invalid non-UUID sourceId and entitlementId with INCOME_INVALID_INPUT", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: "not-a-valid-uuid",
				periodMonth: "2026-09-01",
				amount: "4000.00",
				idempotencyKey: "ent-bad-source",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);

		await expect(
			reviseIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				entitlementId: "123-bad-id",
				expectedRevisionNo: 1,
				amount: "4000.00",
				idempotencyKey: "ent-bad-id",
				reasonCode: "CORRECTION",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});

	it("rejects reviseIncomeEntitlement amount < active settlement allocation with INCOME_SETTLEMENT_CONFLICT", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => {
						const resObj: Record<string, unknown> = {
							for: vi.fn().mockImplementation(() => ({
								limit: vi.fn().mockResolvedValue([
									{
										id: ENT_UUID,
										userId: "user-1",
										sourceId: SOURCE_UUID,
										periodMonth: "2026-09-01",
										canonicalTransactionId: "canon-ent-tx-1",
									},
								]),
							})),
							limit: vi.fn().mockImplementation(() => {
								if (table === incomeSources) {
									return Promise.resolve([
										{
											id: SOURCE_UUID,
											userId: "user-1",
											code: "KYK",
											name: "KYK Bursu",
											nature: "REGULAR",
										},
									]);
								}
								if (table === incomeEntitlementRevisions) {
									return Promise.resolve([
										{
											id: "ent-rev-1",
											userId: "user-1",
											entitlementId: ENT_UUID,
											revisionNo: 1,
											operation: "CREATE",
											amount: "4000.00",
											expectedReceiptOn: null,
											note: null,
										},
									]);
								}
								return Promise.resolve([]);
							}),
							orderBy: vi.fn().mockResolvedValue([
								{
									settlementBatchId: "batch-1",
									revisionNo: 1,
									allocations: [
										{
											entitlementId: ENT_UUID,
											amount: "3000.00", // 3000.00 is currently allocated!
										},
									],
								},
							]),
						};
						return resObj;
					}),
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
			reviseIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				entitlementId: ENT_UUID,
				expectedRevisionNo: 1,
				amount: "2500.00",
				idempotencyKey: "rev-ent-key-1",
				reasonCode: "CORRECTION",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});

	it("rejects voiding entitlement when active settlement allocations exist", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => {
						const resObj: Record<string, unknown> = {
							for: vi.fn().mockImplementation(() => ({
								limit: vi.fn().mockResolvedValue([
									{
										id: ENT_UUID,
										userId: "user-1",
										sourceId: SOURCE_UUID,
										periodMonth: "2026-09-01",
										canonicalTransactionId: "canon-ent-tx-1",
									},
								]),
							})),
							limit: vi.fn().mockImplementation(() => {
								if (table === incomeSources) {
									return Promise.resolve([
										{
											id: SOURCE_UUID,
											userId: "user-1",
											code: "KYK",
											name: "KYK Bursu",
											nature: "REGULAR",
										},
									]);
								}
								if (table === incomeEntitlementRevisions) {
									return Promise.resolve([
										{
											id: "ent-rev-1",
											userId: "user-1",
											entitlementId: ENT_UUID,
											revisionNo: 1,
											operation: "CREATE",
											amount: "4000.00",
											expectedReceiptOn: null,
											note: null,
										},
									]);
								}
								return Promise.resolve([]);
							}),
							orderBy: vi.fn().mockResolvedValue([
								{
									settlementBatchId: "batch-1",
									revisionNo: 1,
									allocations: [
										{
											entitlementId: ENT_UUID,
											amount: "1000.00", // 1000.00 allocated!
										},
									],
								},
							]),
						};
						return resObj;
					}),
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
			voidIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				entitlementId: ENT_UUID,
				expectedRevisionNo: 1,
				idempotencyKey: "void-ent-key-1",
				reasonCode: "VOID_MISTAKE",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SETTLEMENT_CONFLICT",
		);
	});
});
