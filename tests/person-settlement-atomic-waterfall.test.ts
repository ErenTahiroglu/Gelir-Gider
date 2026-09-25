import { describe, expect, it, vi } from "vitest";
import { users } from "../src/db/schema/auth";
import { ledgerAccounts } from "../src/db/schema/ledger";
import {
	people,
	personLedgerLinks,
	personObligationRevisions,
	personObligations,
	personReceivableSettlementRequests,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../src/db/schema/people";
import { PeopleError } from "../src/people/errors";
import { calculatePersonReceivableSettlementRequestFingerprint } from "../src/people/fingerprint";
import {
	type SettlePersonReceivablesResult,
	settlePersonReceivables,
} from "../src/people/person-settlement-orchestrator";

describe("Person Settlement Atomicity, Idempotency & Waterfall", () => {
	const userId = "11111111-1111-4111-8111-111111111111";
	const personId = "22222222-2222-4222-8222-222222222222";
	const destinationAssetAccountId = "33333333-3333-4333-8333-333333333333";
	const occurredAt = new Date("2026-09-24T10:00:00Z");

	function createMockTx(handlers: {
		selectHandler?: (table: any, fields: any) => any;
		insertHandler?: (val: any) => any;
	}) {
		return {
			select: (fields?: any) => {
				let currentTable: any = null;
				const chain: any = {
					from: (table?: any) => {
						currentTable = table;
						return chain;
					},
					where: (cond?: any) => chain,
					orderBy: (order?: any) => chain,
					limit: (num?: number) => {
						if (handlers.selectHandler) {
							const custom = handlers.selectHandler(currentTable, fields);
							if (custom !== undefined) return Promise.resolve(custom);
						}
						if (currentTable === users)
							return Promise.resolve([{ id: userId }]);
						return Promise.resolve([]);
					},
					for: (mode?: string) => {
						let res: any;
						if (handlers.selectHandler) {
							res = handlers.selectHandler(currentTable, fields);
						}
						if (res === undefined) {
							res = currentTable === users ? [{ id: userId }] : [];
						}
						return Object.assign(Promise.resolve(res), {
							limit: () => Promise.resolve(res),
						});
					},
					// biome-ignore lint/suspicious/noThenProperty: mock query builder is thenable to support await query
					then: (resolve: any) => {
						let res: any;
						if (handlers.selectHandler) {
							res = handlers.selectHandler(currentTable, fields);
						}
						if (res === undefined) {
							res = currentTable === users ? [{ id: userId }] : [];
						}
						return Promise.resolve(res).then(resolve);
					},
				};
				return chain;
			},
			insert: (table?: any) => ({
				values: (val: any) => {
					if (handlers.insertHandler) handlers.insertHandler(val);
					return {
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([{ id: "ins-1" }]),
						}),
						returning: () => Promise.resolve([{ id: "ins-1" }]),
					};
				},
			}),
		};
	}

	describe("Request Fingerprint Computation", () => {
		it("computes deterministic SHA-256 fingerprint from parameters", async () => {
			const fp1 = await calculatePersonReceivableSettlementRequestFingerprint({
				userId,
				personId,
				cashAmount: "100.00",
				destinationAssetAccountId,
				isCash: true,
				occurredAt,
			});

			const fp2 = await calculatePersonReceivableSettlementRequestFingerprint({
				userId,
				personId,
				cashAmount: "100.00",
				destinationAssetAccountId,
				isCash: true,
				occurredAt,
			});

			expect(fp1).toBe(fp2);
			expect(fp1).toMatch(/^[0-9a-f]{64}$/);

			const fpDifferent =
				await calculatePersonReceivableSettlementRequestFingerprint({
					userId,
					personId,
					cashAmount: "150.00",
					destinationAssetAccountId,
					isCash: true,
					occurredAt,
				});

			expect(fpDifferent).not.toBe(fp1);
		});
	});

	describe("Pre-flight Invariants & Error Handling", () => {
		it("rejects non-cash destination account if not linked to Midas", async () => {
			const mockTx = createMockTx({
				selectHandler: () => [
					{ id: destinationAssetAccountId, accountType: "ASSET" },
				],
			});

			const mockDb = {
				transaction: async (cb: any) => cb(mockTx),
			};

			await expect(
				settlePersonReceivables({
					db: mockDb as any,
					userId,
					personId,
					cashAmount: "100.00",
					destinationAssetAccountId,
					isCash: false,
					occurredAt,
					idempotencyKey: "idem-non-midas",
				}),
			).rejects.toThrowError(PeopleError);
		});

		it("throws PEOPLE_NO_OPEN_RECEIVABLES when person has no open receivable obligations", async () => {
			const mockTx = createMockTx({
				selectHandler: (table: any) => {
					if (table === users) return [{ id: userId }];
					if (table === people) return [{ id: personId, userId }];
					if (table === personRevisions)
						return [{ personId, revisionNo: 1, status: "ACTIVE" }];
					if (table === personObligations) return []; // 0 open receivables
					return [];
				},
			});

			const mockDb = {
				transaction: async (cb: any) => cb(mockTx),
			};

			await expect(
				settlePersonReceivables({
					db: mockDb as any,
					userId,
					personId,
					cashAmount: "100.00",
					destinationAssetAccountId,
					isCash: true,
					occurredAt,
					idempotencyKey: "idem-no-open",
				}),
			).rejects.toThrowError(
				expect.objectContaining({ code: "PEOPLE_NO_OPEN_RECEIVABLES" }),
			);
		});
	});

	describe("Root Idempotency Receipt Replay", () => {
		it("returns stored settlement receipt with idempotentReplay=true on exact replay", async () => {
			const storedReceipt: SettlePersonReceivablesResult = {
				cashReceived: "100.00",
				receivableApplied: "100.00",
				excess: "0.00",
				remainingReceivable: "0.00",
				routing: [],
			};

			const fp = await calculatePersonReceivableSettlementRequestFingerprint({
				userId,
				personId,
				cashAmount: "100.00",
				destinationAssetAccountId,
				isCash: true,
				occurredAt,
			});

			const existingRequest = {
				id: "req-1",
				idempotencyKey: "idem-exact",
				requestFingerprint: fp,
				resultJson: storedReceipt,
			};

			const mockTx = createMockTx({
				selectHandler: (table: any) => {
					if (table === personReceivableSettlementRequests)
						return [existingRequest];
					return [existingRequest];
				},
			});

			const mockDb = {
				transaction: async (cb: any) => cb(mockTx),
			};

			const res = await settlePersonReceivables({
				db: mockDb as any,
				userId,
				personId,
				cashAmount: "100.00",
				destinationAssetAccountId,
				isCash: true,
				occurredAt,
				idempotencyKey: "idem-exact",
			});

			expect(res.cashReceived).toBe("100.00");
			expect(res.receivableApplied).toBe("100.00");
			expect(res.excess).toBe("0.00");
			expect(res.remainingReceivable).toBe("0.00");
		});

		it("throws PEOPLE_IDEMPOTENCY_CONFLICT when key matches but payload differs", async () => {
			const existingRequest = {
				id: "req-1",
				idempotencyKey: "idem-conflict",
				requestFingerprint:
					"different-fingerprint-000000000000000000000000000000000000000000",
				resultJson: {},
			};

			const mockTx = createMockTx({
				selectHandler: (table: any) => {
					if (table === personReceivableSettlementRequests)
						return [existingRequest];
					return [existingRequest];
				},
			});

			const mockDb = {
				transaction: async (cb: any) => cb(mockTx),
			};

			await expect(
				settlePersonReceivables({
					db: mockDb as any,
					userId,
					personId,
					cashAmount: "100.00",
					destinationAssetAccountId,
					isCash: true,
					occurredAt,
					idempotencyKey: "idem-conflict",
				}),
			).rejects.toThrowError(
				expect.objectContaining({ code: "PEOPLE_IDEMPOTENCY_CONFLICT" }),
			);
		});
	});

	describe("Atomic Rollback on Error", () => {
		it("rolls back the root transaction entirely if any child step fails", async () => {
			let transactionRolledBack = false;
			const obId = "44444444-4444-4444-8444-444444444444";

			const mockTx = createMockTx({
				selectHandler: (table: any) => {
					if (table === people) return [{ id: personId, userId }];
					if (table === personRevisions)
						return [{ personId, revisionNo: 1, status: "ACTIVE" }];
					if (table === personObligations)
						return [
							{
								id: obId,
								userId,
								direction: "RECEIVABLE",
								personId,
								createdAt: new Date(),
							},
						];
					if (table === personObligationRevisions)
						return [
							{
								obligationId: obId,
								revisionNo: 1,
								operation: "CREATE",
								principalAmount: "100.00",
								dueDate: null,
							},
						];
					if (table === ledgerAccounts)
						return [
							{
								id: destinationAssetAccountId,
								userId,
								accountType: "ASSET",
								normalBalance: "DEBIT",
								archivedAt: null,
								currency: "TRY",
							},
							{
								id: "55555555-5555-4555-8555-555555555555",
								userId,
								accountType: "ASSET",
								normalBalance: "DEBIT",
								archivedAt: null,
								currency: "TRY",
							},
						];
					if (table === users) return [{ id: userId, currency: "TRY" }];
					if (table === personLedgerLinks)
						return [
							{
								personId,
								receivableAccountId: "55555555-5555-4555-8555-555555555555",
								payableAccountId: "66666666-6666-4666-8666-666666666666",
							},
						];
					if (table === personSettlements) return [];
					if (table === personSettlementRevisions) return [];
					return [];
				},
				insertHandler: () => {
					throw new Error("Simulated database failure during settlement");
				},
			});

			const mockDb = {
				transaction: async (cb: any) => {
					try {
						return await cb(mockTx);
					} catch (err) {
						transactionRolledBack = true;
						throw err;
					}
				},
			};

			await expect(
				settlePersonReceivables({
					db: mockDb as any,
					userId,
					personId,
					cashAmount: "100.00",
					destinationAssetAccountId,
					isCash: true,
					occurredAt,
					idempotencyKey: "idem-rollback",
				}),
			).rejects.toThrow("Simulated database failure during settlement");

			expect(transactionRolledBack).toBe(true);
		});
	});
});
