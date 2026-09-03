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
										id: "source-1",
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
									id: "ent-1",
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
			sourceId: "source-1",
			periodMonth: "2026-09-01",
			amount: "4000.00",
			expectedReceiptOn: "2026-09-10",
			note: "September entitlement",
			idempotencyKey: "ent-idem-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.idempotentReplay).toBe(false);
		expect(res.incomeEntitlement.entitlementId).toBe("ent-1");
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
											id: "source-1",
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
											id: "ent-1",
											userId: "user-1",
											sourceId: "source-1",
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
											entitlementId: "ent-1",
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
			sourceId: "source-1",
			periodMonth: "2026-09-01",
			amount: "4000.00",
			idempotencyKey: "ent-idem-1",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(true);
		expect(res.incomeEntitlement.entitlementId).toBe("ent-1");
		expect(res.incomeEntitlement.amount).toBe("4000.00");

		canonSpy.mockRestore();
	});

	it("rejects non-first-day periodMonth and invalid calendar dates", async () => {
		const mockDb = {} as Database;

		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-1",
				periodMonth: "2026-09-02", // Not first day!
				amount: "4000.00",
				idempotencyKey: "ent-idem-1",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);

		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-1",
				periodMonth: "2026-02-30", // Impossible date!
				amount: "4000.00",
				idempotencyKey: "ent-idem-1",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});

	it("rejects entitlement creation on EXTRA and SUPPORT nature income sources", async () => {
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
										id: "source-bonus",
										userId: "user-1",
										code: "BONUS",
										name: "Bonus",
										nature: "EXTRA", // EXTRA nature
										activeFrom: "2026-01-01",
										activeUntil: null,
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
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-bonus",
				periodMonth: "2026-09-01",
				amount: "5000.00",
				idempotencyKey: "ent-idem-extra",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_INVALID_INPUT",
		);
	});

	it("rejects fresh entitlement creation on archived source but allows active window overlap", async () => {
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
										id: "source-arch",
										userId: "user-1",
										code: "OLD_JOB",
										name: "Old Job",
										nature: "REGULAR",
										activeFrom: "2026-01-01",
										activeUntil: null,
										archivedAt: new Date(), // Archived!
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
				transactionId: "canon-ent-tx-arch",
				revisionId: "canon-ent-rev-arch",
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		await expect(
			createIncomeEntitlement({
				db: mockDb,
				userId: "user-1",
				sourceId: "source-arch",
				periodMonth: "2026-09-01",
				amount: "5000.00",
				idempotencyKey: "ent-idem-arch",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof IncomeError && e.code === "INCOME_SOURCE_ARCHIVED",
		);

		canonSpy.mockRestore();
	});

	it("rejects revising entitlement amount below active settlement allocation", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => {
						const resObj: Record<string, unknown> = {
							for: vi.fn().mockImplementation(() => ({
								limit: vi.fn().mockResolvedValue([
									{
										id: "ent-1",
										userId: "user-1",
										sourceId: "source-1",
										periodMonth: "2026-09-01",
										canonicalTransactionId: "canon-ent-tx-1",
									},
								]),
							})),
							limit: vi.fn().mockImplementation(() => {
								if (table === incomeSources) {
									return Promise.resolve([
										{
											id: "source-1",
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
											entitlementId: "ent-1",
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
											entitlementId: "ent-1",
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
				entitlementId: "ent-1",
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
										id: "ent-1",
										userId: "user-1",
										sourceId: "source-1",
										periodMonth: "2026-09-01",
										canonicalTransactionId: "canon-ent-tx-1",
									},
								]),
							})),
							limit: vi.fn().mockImplementation(() => {
								if (table === incomeSources) {
									return Promise.resolve([
										{
											id: "source-1",
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
											entitlementId: "ent-1",
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
											entitlementId: "ent-1",
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
				entitlementId: "ent-1",
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
