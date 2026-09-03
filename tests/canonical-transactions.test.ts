import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import {
	canonicalTransactions,
	transactionRevisions,
	transactionSources,
} from "../src/db/schema/transactions";
import {
	createCanonicalTransaction,
	getCanonicalTransaction,
	listCanonicalTransactionRevisions,
	listCanonicalTransactionSources,
	reviseCanonicalTransaction,
	voidCanonicalTransaction,
} from "../src/transactions/service";

describe("Canonical Transaction Audit Services (Phase 5A)", () => {
	describe("Input Validation", () => {
		const mockDb = {} as Database;

		it("throws on empty userId", async () => {
			await expect(
				createCanonicalTransaction({
					db: mockDb,
					userId: "",
					kind: "EXPENSE",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					payload: { amount: "100.00" },
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow("User ID is required");
		});

		it("throws on invalid transaction kind", async () => {
			await expect(
				createCanonicalTransaction({
					db: mockDb,
					userId: "user-1",
					kind: "invalid-lowercase",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					payload: { amount: "100.00" },
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow("Invalid transaction kind");
		});

		it("throws on invalid source type", async () => {
			await expect(
				createCanonicalTransaction({
					db: mockDb,
					userId: "user-1",
					kind: "EXPENSE",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					payload: { amount: "100.00" },
					source: { type: "invalid type" },
				}),
			).rejects.toThrow("Invalid source type");
		});

		it("throws on floating-point amount inside payload", async () => {
			await expect(
				createCanonicalTransaction({
					db: mockDb,
					userId: "user-1",
					kind: "EXPENSE",
					idempotencyKey: "key-1",
					occurredAt: new Date(),
					payload: { amount: 123.45 },
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow(
				/Floating-point and unsafe integer numbers are prohibited/,
			);
		});
	});

	describe("createCanonicalTransaction", () => {
		function createMockTxDb({
			existingTx = null as Record<string, unknown> | null,
			rev1 = null as Record<string, unknown> | null,
		} = {}) {
			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						const execute = async () => {
							if (table === canonicalTransactions) {
								return existingTx ? [existingTx] : [];
							}
							if (table === transactionRevisions) {
								return rev1 ? [rev1] : [];
							}
							return [];
						};

						return {
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockImplementation(execute),
							}),
							limit: vi.fn().mockImplementation(execute),
						};
					}),
				})),

				insert: vi.fn().mockImplementation(() => ({
					values: vi.fn().mockImplementation(() => ({
						onConflictDoNothing: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "new-tx-id",
									userId: "user-1",
									kind: "EXPENSE",
									creationIdempotencyKey: "create-key-1",
								},
							]),
						}),
						returning: vi.fn().mockResolvedValue([
							{
								id: "new-rev-1-id",
								userId: "user-1",
								transactionId: "new-tx-id",
								revisionNo: 1,
								operation: "CREATE",
							},
						]),
					})),
				})),
			};

			return {
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
				mockTx,
			};
		}

		it("creates a new canonical transaction with revision #1 (CREATE) and source record", async () => {
			const { transaction, mockTx } = createMockTxDb();
			const mockDb = { transaction } as unknown as Database;

			const result = await createCanonicalTransaction({
				db: mockDb,
				userId: "user-1",
				kind: "expense",
				idempotencyKey: "create-key-1",
				occurredAt: new Date("2026-09-03T12:00:00Z"),
				payload: { amount: "100.00", category: "Food" },
				source: { type: "MANUAL", ref: "user-input" },
			});

			expect(result).toEqual({
				transactionId: "new-tx-id",
				revisionId: "new-rev-1-id",
				revisionNo: 1,
				operation: "CREATE",
				idempotentReplay: false,
			});

			expect(mockTx.insert).toHaveBeenCalledTimes(3); // canonical_transactions, transaction_revisions, transaction_sources
		});

		it("throws TRANSACTION_IDEMPOTENCY_CONFLICT on same creation key with different payload", async () => {
			const { transaction } = createMockTxDb({
				existingTx: {
					id: "existing-tx-id",
					creationFingerprint:
						"0000000000000000000000000000000000000000000000000000000000000000",
				},
				rev1: {
					id: "existing-rev-1-id",
					revisionNo: 1,
				},
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				createCanonicalTransaction({
					db: mockDb,
					userId: "user-1",
					kind: "EXPENSE",
					idempotencyKey: "create-key-1",
					occurredAt: new Date("2026-09-03T12:00:00Z"),
					payload: { amount: "200.00" },
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow(
				"Creation idempotency key was already used with a different transaction payload or source",
			);
		});
	});

	describe("reviseCanonicalTransaction (UPDATE)", () => {
		function createMockReviseDb({
			existingEarlyRev = null as Record<string, unknown> | null,
			parentTx = {
				id: "tx-1",
				userId: "user-1",
				kind: "EXPENSE",
			} as Record<string, unknown> | null,
			latestRev = {
				id: "rev-1-id",
				revisionNo: 1,
				operation: "CREATE",
				occurredAt: new Date(),
				payload: { amount: "100.00" },
			} as Record<string, unknown> | null,
		} = {}) {
			let revisionQueryCount = 0;

			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						const execute = async () => {
							if (table === canonicalTransactions) {
								return parentTx ? [parentTx] : [];
							}
							if (table === transactionRevisions) {
								revisionQueryCount++;
								if (revisionQueryCount === 1) {
									// Early idempotency lookup
									return existingEarlyRev ? [existingEarlyRev] : [];
								}
								// Latest revision lookup
								return latestRev ? [latestRev] : [];
							}
							return [];
						};

						const queryObj: Record<string, unknown> = {};
						queryObj.where = vi.fn().mockReturnValue(queryObj);
						queryObj.for = vi.fn().mockReturnValue(queryObj);
						queryObj.orderBy = vi.fn().mockReturnValue(queryObj);
						queryObj.limit = vi.fn().mockImplementation(execute);
						return queryObj;
					}),
				})),

				insert: vi.fn().mockImplementation(() => ({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([
							{
								id: "rev-2-id",
								revisionNo: 2,
								operation: "UPDATE",
							},
						]),
					}),
				})),
			};

			return {
				transaction: vi.fn().mockImplementation(async (cb) => cb(mockTx)),
				mockTx,
			};
		}

		it("appends an UPDATE revision when expectedRevisionNo matches", async () => {
			const { transaction } = createMockReviseDb();
			const mockDb = { transaction } as unknown as Database;

			const result = await reviseCanonicalTransaction({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-1",
				expectedRevisionNo: 1,
				idempotencyKey: "update-key-1",
				occurredAt: new Date("2026-09-03T15:00:00Z"),
				payload: { amount: "150.00", category: "Food" },
				reasonCode: "USER_EDIT",
				reasonNote: "Updated dinner amount",
				source: { type: "MANUAL" },
			});

			expect(result).toEqual({
				transactionId: "tx-1",
				revisionId: "rev-2-id",
				revisionNo: 2,
				operation: "UPDATE",
				idempotentReplay: false,
			});
		});

		it("throws TRANSACTION_REVISION_CONFLICT when expectedRevisionNo does not match latest revision", async () => {
			const { transaction } = createMockReviseDb({
				latestRev: {
					id: "rev-2-id",
					revisionNo: 2,
					operation: "UPDATE",
					occurredAt: new Date(),
					payload: { amount: "120.00" },
				},
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				reviseCanonicalTransaction({
					db: mockDb,
					userId: "user-1",
					transactionId: "tx-1",
					expectedRevisionNo: 1, // Stale revision expectation
					idempotencyKey: "update-key-stale",
					occurredAt: new Date(),
					payload: { amount: "150.00" },
					reasonCode: "USER_EDIT",
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow(
				"Optimistic concurrency conflict: expected revision 1, but current revision is 2",
			);
		});

		it("throws TRANSACTION_ALREADY_VOIDED when trying to update a voided transaction", async () => {
			const { transaction } = createMockReviseDb({
				latestRev: {
					id: "rev-3-id",
					revisionNo: 3,
					operation: "VOID",
					occurredAt: new Date(),
					payload: { amount: "120.00" },
				},
			});
			const mockDb = { transaction } as unknown as Database;

			await expect(
				reviseCanonicalTransaction({
					db: mockDb,
					userId: "user-1",
					transactionId: "tx-1",
					expectedRevisionNo: 3,
					idempotencyKey: "update-key-after-void",
					occurredAt: new Date(),
					payload: { amount: "150.00" },
					reasonCode: "USER_EDIT",
					source: { type: "MANUAL" },
				}),
			).rejects.toThrow(
				'Cannot update transaction "tx-1" because it has been permanently voided',
			);
		});
	});

	describe("voidCanonicalTransaction", () => {
		it("appends a VOID revision copying previous payload and occurredAt", async () => {
			const occurredAt = new Date("2026-09-01T10:00:00Z");
			const prevPayload = { amount: "100.00", desc: "Original" };

			let revisionQueryCount = 0;
			const mockTx = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						const execute = async () => {
							if (table === canonicalTransactions) {
								return [{ id: "tx-1", userId: "user-1", kind: "EXPENSE" }];
							}
							if (table === transactionRevisions) {
								revisionQueryCount++;
								if (revisionQueryCount === 1) return []; // Early idempotency check
								return [
									{
										id: "rev-1-id",
										revisionNo: 1,
										operation: "CREATE",
										occurredAt,
										payload: prevPayload,
									},
								];
							}
							return [];
						};

						const queryObj: Record<string, unknown> = {};
						queryObj.where = vi.fn().mockReturnValue(queryObj);
						queryObj.for = vi.fn().mockReturnValue(queryObj);
						queryObj.orderBy = vi.fn().mockReturnValue(queryObj);
						queryObj.limit = vi.fn().mockImplementation(execute);
						return queryObj;
					}),
				})),

				insert: vi.fn().mockImplementation(() => ({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([
							{
								id: "rev-2-id",
								revisionNo: 2,
								operation: "VOID",
							},
						]),
					}),
				})),
			};

			const mockDb = {
				transaction: vi.fn().mockImplementation(async (cb) => cb(mockTx)),
			} as unknown as Database;

			const result = await voidCanonicalTransaction({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-1",
				expectedRevisionNo: 1,
				idempotencyKey: "void-key-1",
				reasonCode: "USER_VOID",
				reasonNote: "Duplicate transaction",
				source: { type: "MANUAL" },
			});

			expect(result).toEqual({
				transactionId: "tx-1",
				revisionId: "rev-2-id",
				revisionNo: 2,
				operation: "VOID",
				idempotentReplay: false,
			});
		});
	});

	describe("Read Models", () => {
		it("getCanonicalTransaction returns active transaction model", async () => {
			const occurredAt = new Date("2026-09-01T10:00:00Z");
			const createdAt = new Date("2026-09-01T10:05:00Z");

			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						const execute = async () => {
							if (table === canonicalTransactions) {
								return [
									{
										id: "tx-1",
										kind: "EXPENSE",
										createdAt,
									},
								];
							}
							if (table === transactionRevisions) {
								return [
									{
										revisionNo: 1,
										operation: "CREATE",
										occurredAt,
										payload: { amount: "100.00" },
										createdAt,
									},
								];
							}
							return [];
						};

						const queryObj: Record<string, unknown> = {};
						queryObj.where = vi.fn().mockReturnValue(queryObj);
						queryObj.orderBy = vi.fn().mockReturnValue(queryObj);
						queryObj.limit = vi.fn().mockImplementation(execute);
						return queryObj;
					}),
				})),
			} as unknown as Database;

			const result = await getCanonicalTransaction({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-1",
			});

			expect(result).toEqual({
				transactionId: "tx-1",
				kind: "EXPENSE",
				status: "ACTIVE",
				revisionNo: 1,
				occurredAt,
				payload: { amount: "100.00" },
				createdAt,
				latestRevisionCreatedAt: createdAt,
			});
		});

		it("listCanonicalTransactionRevisions and listCanonicalTransactionSources return audit histories", async () => {
			const createdAt = new Date("2026-09-01T10:00:00Z");

			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation((table) => {
						if (table === canonicalTransactions) {
							return {
								where: vi.fn().mockReturnValue({
									limit: vi
										.fn()
										.mockResolvedValue([{ id: "tx-1", userId: "user-1" }]),
								}),
							};
						}
						if (table === transactionRevisions) {
							return {
								where: vi.fn().mockReturnValue({
									orderBy: vi.fn().mockResolvedValue([
										{
											revisionId: "rev-1",
											revisionNo: 1,
											operation: "CREATE",
											occurredAt: createdAt,
											payload: { amount: "100.00" },
											reasonCode: null,
											reasonNote: null,
											createdAt,
										},
									]),
								}),
							};
						}
						if (table === transactionSources) {
							return {
								where: vi.fn().mockReturnValue({
									orderBy: vi.fn().mockResolvedValue([
										{
											sourceId: "src-1",
											revisionId: "rev-1",
											sourceType: "MANUAL",
											sourceRef: null,
											sourcePayloadHash: null,
											observedAt: null,
											createdAt,
										},
									]),
								}),
							};
						}
						return {};
					}),
				})),
			} as unknown as Database;

			const revs = await listCanonicalTransactionRevisions({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-1",
			});
			expect(revs).toHaveLength(1);
			expect(revs[0]?.revisionNo).toBe(1);

			const sources = await listCanonicalTransactionSources({
				db: mockDb,
				userId: "user-1",
				transactionId: "tx-1",
			});
			expect(sources).toHaveLength(1);
			expect(sources[0]?.sourceType).toBe("MANUAL");
		});
	});
});
