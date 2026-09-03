import { describe, expect, it, vi } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	createMonthlyBudgetPlan,
	refreshMonthlyBudgetPlan,
	voidMonthlyBudgetPlan,
} from "../src/budget/service";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../src/db/schema/budget";
import { canonicalTransactions } from "../src/db/schema/transactions";
import * as referenceModule from "../src/income/reference";
import * as canonicalService from "../src/transactions/service";

const PLAN_UUID = "a0000000-0000-0000-0000-000000000001";
const CANON_TX_UUID = "b0000000-0000-0000-0000-000000000001";
const CANON_REV1_UUID = "c0000000-0000-0000-0000-000000000001";
const CANON_REV2_UUID = "c0000000-0000-0000-0000-000000000002";
const PLAN_REV1_UUID = "d0000000-0000-0000-0000-000000000001";
const PLAN_REV2_UUID = "d0000000-0000-0000-0000-000000000002";

describe("Budget Service", () => {
	it("creates a monthly budget plan in exactly 1 outer transaction", async () => {
		let outerTxCount = 0;

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === monthlyBudgetPlans) return Promise.resolve([]);
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation((table) => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockImplementation(() => {
						if (table === monthlyBudgetPlans) {
							return Promise.resolve([
								{
									id: PLAN_UUID,
									userId: vals.userId,
									periodMonth: vals.periodMonth,
									canonicalTransactionId: vals.canonicalTransactionId,
									createdAt: new Date(),
								},
							]);
						}
						if (table === monthlyBudgetPlanRevisions) {
							return Promise.resolve([
								{
									id: PLAN_REV1_UUID,
									userId: vals.userId,
									budgetPlanId: vals.budgetPlanId,
									canonicalRevisionId: vals.canonicalRevisionId,
									revisionNo: vals.revisionNo,
									previousBudgetRevisionId: null,
									operation: vals.operation,
									policyVersion: vals.policyVersion,
									currency: vals.currency,
									referenceIncomeAmount: vals.referenceIncomeAmount,
									mandatoryCeilingAmount: vals.mandatoryCeilingAmount,
									discretionaryCeilingAmount: vals.discretionaryCeilingAmount,
									shortTermPurchaseAmount: vals.shortTermPurchaseAmount,
									mediumTermReserveAmount: vals.mediumTermReserveAmount,
									longTermInvestmentAmount: vals.longTermInvestmentAmount,
									referenceSnapshot: vals.referenceSnapshot,
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
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
					outerTxCount++;
					return await cb(mockTx);
				},
			),
		} as unknown as Database;

		const refSpy = vi
			.spyOn(referenceModule, "getMonthlyReferenceIncome")
			.mockResolvedValue({
				asOf: "2026-09-01",
				currency: "TRY",
				total: "10000.00",
				sources: [
					{
						sourceId: "src-1",
						code: "SALARY",
						name: "Maaş",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						referenceAmount: "10000.00",
					},
				],
			});

		const canonSpy = vi
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: CANON_TX_UUID,
				revisionId: CANON_REV1_UUID,
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		const res = await createMonthlyBudgetPlan({
			db: mockDb,
			userId: "user-1",
			periodMonth: "2026-09-01",
			idempotencyKey: "plan-key-1",
			provenance: { type: "MANUAL" },
		});

		expect(outerTxCount).toBe(1);
		expect(res.idempotentReplay).toBe(false);
		expect(res.budgetPlan.budgetPlanId).toBe(PLAN_UUID);
		expect(res.budgetPlan.periodMonth).toBe("2026-09-01");
		expect(res.budgetPlan.referenceIncome).toBe("10000.00");
		expect(res.budgetPlan.mandatoryExpense.amount).toBe("6500.00");
		expect(res.budgetPlan.discretionarySpend.amount).toBe("500.00");
		expect(res.budgetPlan.shortTermPurchase.amount).toBe("1000.00");
		expect(res.budgetPlan.mediumTermReserve.amount).toBe("1000.00");
		expect(res.budgetPlan.longTermInvestment.amount).toBe("1000.00");

		refSpy.mockRestore();
		canonSpy.mockRestore();
	});

	it("handles historical idempotent replay without re-evaluating reference income", async () => {
		let refIncomeCalled = false;

		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === canonicalTransactions) {
								return Promise.resolve([
									{
										id: CANON_TX_UUID,
										userId: "user-1",
										kind: "MONTHLY_BUDGET_PLAN",
										creationIdempotencyKey: "plan-key-replay",
									},
								]);
							}
							if (table === monthlyBudgetPlans) {
								return Promise.resolve([
									{
										id: PLAN_UUID,
										userId: "user-1",
										periodMonth: "2026-09-01",
										canonicalTransactionId: CANON_TX_UUID,
										createdAt: new Date(),
									},
								]);
							}
							if (table === monthlyBudgetPlanRevisions) {
								return Promise.resolve([
									{
										id: PLAN_REV1_UUID,
										userId: "user-1",
										budgetPlanId: PLAN_UUID,
										canonicalRevisionId: CANON_REV1_UUID,
										revisionNo: 1,
										previousBudgetRevisionId: null,
										operation: "CREATE",
										policyVersion: "PERSONAL_BUDGET_V1",
										currency: "TRY",
										referenceIncomeAmount: "10000.00",
										mandatoryCeilingAmount: "6500.00",
										discretionaryCeilingAmount: "500.00",
										shortTermPurchaseAmount: "1000.00",
										mediumTermReserveAmount: "1000.00",
										longTermInvestmentAmount: "1000.00",
										referenceSnapshot: { total: "10000.00" },
										createdAt: new Date(),
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		const refSpy = vi
			.spyOn(referenceModule, "getMonthlyReferenceIncome")
			.mockImplementation(async () => {
				refIncomeCalled = true;
				return {
					asOf: "2026-09-01",
					currency: "TRY",
					total: "20000.00", // even if reference changed!
					sources: [],
				};
			});

		const res = await createMonthlyBudgetPlan({
			db: mockDb,
			userId: "user-1",
			periodMonth: "2026-09-01",
			idempotencyKey: "plan-key-replay",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(true);
		expect(res.budgetPlan.budgetPlanId).toBe(PLAN_UUID);
		expect(res.budgetPlan.referenceIncome).toBe("10000.00"); // returns historical amount!
		expect(refIncomeCalled).toBe(false); // reference income was NOT re-evaluated!

		refSpy.mockRestore();
	});

	it("throws BUDGET_IDEMPOTENCY_CONFLICT if existing key was for a different period", async () => {
		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === canonicalTransactions) {
								return Promise.resolve([
									{
										id: CANON_TX_UUID,
										userId: "user-1",
										kind: "MONTHLY_BUDGET_PLAN",
										creationIdempotencyKey: "plan-key-conflict",
									},
								]);
							}
							if (table === monthlyBudgetPlans) {
								return Promise.resolve([
									{
										id: PLAN_UUID,
										userId: "user-1",
										periodMonth: "2026-09-01", // created for September
										canonicalTransactionId: CANON_TX_UUID,
										createdAt: new Date(),
									},
								]);
							}
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
		} as unknown as Database;

		// Reusing key for October
		await expect(
			createMonthlyBudgetPlan({
				db: mockDb,
				userId: "user-1",
				periodMonth: "2026-10-01",
				idempotencyKey: "plan-key-conflict",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof BudgetError && e.code === "BUDGET_IDEMPOTENCY_CONFLICT",
		);
	});

	it("maps wrapped Drizzle cause { cause: { code: '23505', constraint: 'monthly_budget_plans_user_period_idx' } } to BUDGET_PERIOD_CONFLICT", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockImplementation(() => {
							if (table === users)
								return Promise.resolve([{ currency: "TRY" }]);
							if (table === monthlyBudgetPlans) return Promise.resolve([]);
							return Promise.resolve([]);
						}),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation(() => ({
					returning: vi.fn().mockRejectedValue({
						message: "Failed query: INSERT INTO monthly_budget_plans...",
						cause: {
							code: "23505",
							constraint: "monthly_budget_plans_user_period_idx",
							detail: "Key (user_id, period_month)=(...) already exists.",
						},
					}),
				})),
			})),
		} as unknown as DatabaseTransaction;

		const mockDb = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => ({
						limit: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) =>
					await cb(mockTx),
			),
		} as unknown as Database;

		const refSpy = vi
			.spyOn(referenceModule, "getMonthlyReferenceIncome")
			.mockResolvedValue({
				asOf: "2026-09-01",
				currency: "TRY",
				total: "10000.00",
				sources: [],
			});

		const canonSpy = vi
			.spyOn(canonicalService, "createCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: CANON_TX_UUID,
				revisionId: CANON_REV1_UUID,
				revisionNo: 1,
				idempotentReplay: false,
				operation: "CREATE",
			});

		await expect(
			createMonthlyBudgetPlan({
				db: mockDb,
				userId: "user-1",
				periodMonth: "2026-09-01",
				idempotencyKey: "plan-key-concurrent",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof BudgetError && e.code === "BUDGET_PERIOD_CONFLICT",
		);

		refSpy.mockRestore();
		canonSpy.mockRestore();
	});

	it("refreshes a monthly budget plan, appending revision #2 and updating snapshot", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						for: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === monthlyBudgetPlans) {
									return Promise.resolve([
										{
											id: PLAN_UUID,
											userId: "user-1",
											periodMonth: "2026-09-01",
											canonicalTransactionId: CANON_TX_UUID,
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === monthlyBudgetPlanRevisions) {
									return Promise.resolve([
										{
											id: PLAN_REV1_UUID,
											userId: "user-1",
											budgetPlanId: PLAN_UUID,
											canonicalRevisionId: CANON_REV1_UUID,
											revisionNo: 1,
											operation: "CREATE",
											policyVersion: "PERSONAL_BUDGET_V1",
											currency: "TRY",
											referenceIncomeAmount: "10000.00",
											mandatoryCeilingAmount: "6500.00",
											discretionaryCeilingAmount: "500.00",
											shortTermPurchaseAmount: "1000.00",
											mediumTermReserveAmount: "1000.00",
											longTermInvestmentAmount: "1000.00",
											referenceSnapshot: { total: "10000.00" },
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
						limit: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockResolvedValue([
						{
							id: PLAN_REV2_UUID,
							userId: vals.userId,
							budgetPlanId: vals.budgetPlanId,
							canonicalRevisionId: vals.canonicalRevisionId,
							revisionNo: vals.revisionNo,
							previousBudgetRevisionId: vals.previousBudgetRevisionId,
							operation: vals.operation,
							policyVersion: vals.policyVersion,
							currency: vals.currency,
							referenceIncomeAmount: vals.referenceIncomeAmount,
							mandatoryCeilingAmount: vals.mandatoryCeilingAmount,
							discretionaryCeilingAmount: vals.discretionaryCeilingAmount,
							shortTermPurchaseAmount: vals.shortTermPurchaseAmount,
							mediumTermReserveAmount: vals.mediumTermReserveAmount,
							longTermInvestmentAmount: vals.longTermInvestmentAmount,
							referenceSnapshot: vals.referenceSnapshot,
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

		const refSpy = vi
			.spyOn(referenceModule, "getMonthlyReferenceIncome")
			.mockResolvedValue({
				asOf: "2026-09-01",
				currency: "TRY",
				total: "12000.00", // New reference total!
				sources: [],
			});

		const canonSpy = vi
			.spyOn(canonicalService, "reviseCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: CANON_TX_UUID,
				revisionId: CANON_REV2_UUID,
				revisionNo: 2,
				idempotentReplay: false,
				operation: "UPDATE",
			});

		const res = await refreshMonthlyBudgetPlan({
			db: mockDb,
			userId: "user-1",
			budgetPlanId: PLAN_UUID,
			expectedRevisionNo: 1,
			idempotencyKey: "plan-refresh-1",
			reasonCode: "RECALCULATE",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(false);
		expect(res.budgetPlan.revisionNo).toBe(2);
		expect(res.budgetPlan.referenceIncome).toBe("12000.00");
		expect(res.budgetPlan.mandatoryExpense.amount).toBe("7800.00"); // 65% of 12000
		expect(res.budgetPlan.discretionarySpend.amount).toBe("600.00"); // 5% of 12000
		expect(res.budgetPlan.shortTermPurchase.amount).toBe("1200.00"); // 10% of 12000

		refSpy.mockRestore();
		canonSpy.mockRestore();
	});

	it("voids a monthly budget plan copying predecessor snapshot and allocations", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						for: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === monthlyBudgetPlans) {
									return Promise.resolve([
										{
											id: PLAN_UUID,
											userId: "user-1",
											periodMonth: "2026-09-01",
											canonicalTransactionId: CANON_TX_UUID,
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === monthlyBudgetPlanRevisions) {
									return Promise.resolve([
										{
											id: PLAN_REV1_UUID,
											userId: "user-1",
											budgetPlanId: PLAN_UUID,
											canonicalRevisionId: CANON_REV1_UUID,
											revisionNo: 1,
											operation: "CREATE",
											policyVersion: "PERSONAL_BUDGET_V1",
											currency: "TRY",
											referenceIncomeAmount: "10000.00",
											mandatoryCeilingAmount: "6500.00",
											discretionaryCeilingAmount: "500.00",
											shortTermPurchaseAmount: "1000.00",
											mediumTermReserveAmount: "1000.00",
											longTermInvestmentAmount: "1000.00",
											referenceSnapshot: { total: "10000.00" },
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
						limit: vi.fn().mockResolvedValue([]),
					})),
				})),
			})),
			insert: vi.fn().mockImplementation(() => ({
				values: vi.fn().mockImplementation((vals) => ({
					returning: vi.fn().mockResolvedValue([
						{
							id: PLAN_REV2_UUID,
							userId: vals.userId,
							budgetPlanId: vals.budgetPlanId,
							canonicalRevisionId: vals.canonicalRevisionId,
							revisionNo: vals.revisionNo,
							previousBudgetRevisionId: vals.previousBudgetRevisionId,
							operation: "VOID",
							policyVersion: vals.policyVersion,
							currency: vals.currency,
							referenceIncomeAmount: vals.referenceIncomeAmount,
							mandatoryCeilingAmount: vals.mandatoryCeilingAmount,
							discretionaryCeilingAmount: vals.discretionaryCeilingAmount,
							shortTermPurchaseAmount: vals.shortTermPurchaseAmount,
							mediumTermReserveAmount: vals.mediumTermReserveAmount,
							longTermInvestmentAmount: vals.longTermInvestmentAmount,
							referenceSnapshot: vals.referenceSnapshot,
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
			.spyOn(canonicalService, "voidCanonicalTransactionInTransaction")
			.mockResolvedValue({
				transactionId: CANON_TX_UUID,
				revisionId: CANON_REV2_UUID,
				revisionNo: 2,
				idempotentReplay: false,
				operation: "VOID",
			});

		const res = await voidMonthlyBudgetPlan({
			db: mockDb,
			userId: "user-1",
			budgetPlanId: PLAN_UUID,
			expectedRevisionNo: 1,
			idempotencyKey: "plan-void-1",
			reasonCode: "VOID_MISTAKE",
			provenance: { type: "MANUAL" },
		});

		expect(res.idempotentReplay).toBe(false);
		expect(res.budgetPlan.status).toBe("VOIDED");
		expect(res.budgetPlan.revisionNo).toBe(2);
		expect(res.budgetPlan.referenceIncome).toBe("10000.00"); // copied

		canonSpy.mockRestore();
	});

	it("rejects updating an already voided budget plan with BUDGET_ALREADY_VOIDED", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation((table) => ({
					where: vi.fn().mockImplementation(() => ({
						for: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === monthlyBudgetPlans) {
									return Promise.resolve([
										{
											id: PLAN_UUID,
											userId: "user-1",
											periodMonth: "2026-09-01",
											canonicalTransactionId: CANON_TX_UUID,
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
						orderBy: vi.fn().mockImplementation(() => ({
							limit: vi.fn().mockImplementation(() => {
								if (table === monthlyBudgetPlanRevisions) {
									return Promise.resolve([
										{
											id: PLAN_REV2_UUID,
											userId: "user-1",
											budgetPlanId: PLAN_UUID,
											revisionNo: 2,
											operation: "VOID", // ALREADY VOIDED
										},
									]);
								}
								return Promise.resolve([]);
							}),
						})),
						limit: vi.fn().mockResolvedValue([]),
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
			refreshMonthlyBudgetPlan({
				db: mockDb,
				userId: "user-1",
				budgetPlanId: PLAN_UUID,
				expectedRevisionNo: 2,
				idempotencyKey: "plan-refresh-voided",
				reasonCode: "RECALC",
				provenance: { type: "MANUAL" },
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof BudgetError && e.code === "BUDGET_ALREADY_VOIDED",
		);
	});
});
