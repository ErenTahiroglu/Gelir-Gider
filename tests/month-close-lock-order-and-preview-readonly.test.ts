import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../src/db/schema/budget";
import { creditCardSystemAccounts } from "../src/db/schema/credit-card-ledger";
import { midasAccounts } from "../src/db/schema/midas";
import { monthCloseRevisions } from "../src/db/schema/month-close";
import { calculateMonthCloseProposalFingerprint } from "../src/month-close/fingerprint";

const USER_ID = "019543ef-1111-7000-8000-000000000099";
const PLAN_ID = "019543ef-2222-7000-8000-000000000001";
const MONTH_CLOSE_ID = "019543ef-3333-7000-8000-000000000001";
const MIDAS_ACCOUNT_ID = "019543ef-4444-7000-8000-000000000001";
const MIDAS_LEDGER_ACCOUNT_ID = "019543ef-5555-7000-8000-000000000001";
const BUCKET_ID = "019543ef-6666-7000-8000-000000000001";
const TRANSFER_ID = "019543ef-7777-7000-8000-000000000001";
const PERIOD_MONTH = "2026-01";

const { callOrder } = vi.hoisted(() => ({ callOrder: [] as string[] }));

vi.mock("../src/ledger/posting", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/ledger/posting")>();
	return {
		...actual,
		lockLedgerAccountsInTransaction: vi.fn(async () => {
			callOrder.push("lockLedgerAccounts");
			return [];
		}),
	};
});

vi.mock("../src/midas/service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/midas/service")>();
	return {
		...actual,
		lockMidasAllocationStateInTransaction: vi.fn(
			async ({
				midasAccountId,
				userId,
			}: {
				midasAccountId: string;
				userId: string;
			}) => {
				callOrder.push("lockMidas");
				return {
					midasAccountId,
					userId,
					ledgerAccountId: MIDAS_LEDGER_ACCOUNT_ID,
				};
			},
		),
		getMidasLiquidityStateInTransaction: vi.fn(async () => ({
			midasAccountId: MIDAS_ACCOUNT_ID,
			ledgerAccountId: MIDAS_LEDGER_ACCOUNT_ID,
			currency: "TRY",
			physicalBalance: "10000.00",
			totalEarmarked: "0.00",
			unallocatedBalance: "10000.00",
			buckets: [],
		})),
		ensureMidasSingletonBucketInTransaction: vi.fn(async () => ({
			id: BUCKET_ID,
			userId: USER_ID,
			midasAccountId: MIDAS_ACCOUNT_ID,
			code: "MEDIUM_TERM_RESERVE",
			name: "Medium-Term Reserve",
			bucketType: "MEDIUM_TERM_RESERVE" as const,
			createdAt: new Date(),
		})),
		createMidasAllocationTransferInTransaction: vi.fn(async () => ({
			transferId: TRANSFER_ID,
			idempotentReplay: false,
			midasAccountId: MIDAS_ACCOUNT_ID,
			fromBucketId: null,
			toBucketId: BUCKET_ID,
			amount: "600.00",
			occurredAt: new Date(),
		})),
	};
});

vi.mock("../src/short-term-goals/service", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/short-term-goals/service")>();
	return {
		...actual,
		listShortTermGoalsInTransaction: vi.fn(async () => []),
	};
});

const { closeMonth, previewMonthClose } = await import(
	"../src/month-close/service"
);

/**
 * A generic table-identity-keyed fake `select` chain. `.from(table)` looks up
 * canned rows for that exact schema table object; every intermediate chain
 * method (`where`/`orderBy`/`limit`/`offset`/`for`) returns the same builder,
 * which is itself thenable (resolves to the canned rows) so it can be
 * awaited at any point in the chain, matching real drizzle usage in this
 * codebase (some queries end at `.where()`, others at `.limit()`).
 */
function makeSelectFn(
	tableRowsMap: Map<unknown, unknown[]>,
	onForUpdate?: (table: unknown) => void,
) {
	return () => {
		let resolvedRows: unknown[] = [];
		let currentTable: unknown;
		const builder = {
			from(table: unknown) {
				currentTable = table;
				resolvedRows = tableRowsMap.get(table) ?? [];
				return builder;
			},
			where() {
				return builder;
			},
			orderBy() {
				return builder;
			},
			limit() {
				return builder;
			},
			offset() {
				return builder;
			},
			for(mode: string) {
				if (mode === "update") onForUpdate?.(currentTable);
				return builder;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable mock query builder (mirrors real drizzle chain, which is also thenable)
			then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
				return Promise.resolve(resolvedRows).then(resolve, reject);
			},
		};
		return builder;
	};
}

function makeInsertFn(tableRowsMap: Map<unknown, unknown[]>) {
	return (table: unknown) => {
		const rows = tableRowsMap.get(table) ?? [];
		const builder = {
			values() {
				return builder;
			},
			onConflictDoNothing() {
				return builder;
			},
			returning() {
				return Promise.resolve(rows);
			},
		};
		return builder;
	};
}

function buildCommonSelectMap(): Map<unknown, unknown[]> {
	const map = new Map<unknown, unknown[]>();
	map.set(users, [{ currency: "TRY" }]);
	map.set(creditCardSystemAccounts, []);
	map.set(monthlyBudgetPlans, [{ id: PLAN_ID }]);
	map.set(monthlyBudgetPlanRevisions, [
		{
			id: "019543ef-8888-7000-8000-000000000001",
			budgetPlanId: PLAN_ID,
			revisionNo: 1,
			operation: "CREATE",
			userId: USER_ID,
			policyVersion: "PERSONAL_BUDGET_V1",
			currency: "TRY",
			referenceIncomeAmount: "1000.00",
			mandatoryCeilingAmount: "500.00",
			discretionaryCeilingAmount: "100.00",
		},
	]);
	map.set(midasAccounts, [
		{ id: MIDAS_ACCOUNT_ID, ledgerAccountId: MIDAS_LEDGER_ACCOUNT_ID },
	]);
	map.set(monthCloseRevisions, []);
	return map;
}

describe("closeMonth lock ordering (Phase 14-R1, Section D)", () => {
	it("locks required ledger accounts before the Midas allocation lock, and the budget-plan row before the final proposal resolution", async () => {
		callOrder.length = 0;
		const planLockOrder: string[] = [];

		const selectMap = buildCommonSelectMap();
		const insertMap = new Map<unknown, unknown[]>();
		insertMap.set((await import("../src/db/schema/month-close")).monthCloses, [
			{
				id: MONTH_CLOSE_ID,
				userId: USER_ID,
				periodMonth: "2026-01-01",
				budgetPlanId: PLAN_ID,
				createdAt: new Date(),
			},
		]);

		const expectedProposalFingerprint =
			await calculateMonthCloseProposalFingerprint({
				userId: USER_ID,
				periodMonth: PERIOD_MONTH,
				budgetPlanId: PLAN_ID,
				budgetPlanRevisionNo: 1,
				referenceIncome: "1000.00",
				mandatoryCeiling: "500.00",
				mandatoryExpense: "0.00",
				mandatoryUnused: "500.00",
				discretionaryCeiling: "100.00",
				discretionaryExpense: "0.00",
				discretionaryUnused: "100.00",
				unclassifiedExpense: "0.00",
				closeSurplus: "600.00",
				route: "MEDIUM_TERM_RESERVE",
				recommendedGoal: null,
			});

		insertMap.set(monthCloseRevisions, [
			{
				id: "019543ef-9999-7000-8000-000000000001",
				userId: USER_ID,
				monthCloseId: MONTH_CLOSE_ID,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CLOSE",
				status: "CLOSED",
				budgetPlanRevisionNo: 1,
				policyVersion: "PERSONAL_BUDGET_V1",
				currency: "TRY",
				referenceIncome: "1000.00",
				mandatoryCeiling: "500.00",
				mandatoryExpense: "0.00",
				mandatoryUnused: "500.00",
				discretionaryCeiling: "100.00",
				discretionaryExpense: "0.00",
				discretionaryUnused: "100.00",
				unclassifiedExpense: "0.00",
				closeSurplus: "600.00",
				route: "MEDIUM_TERM_RESERVE",
				decision: "AUTO_MEDIUM",
				midasAccountId: MIDAS_ACCOUNT_ID,
				targetGoalId: null,
				targetGoalRevisionNo: null,
				targetBucketId: BUCKET_ID,
				fullOfferAmount: "0.00",
				appliedAmount: "600.00",
				unroutedAmount: "0.00",
				midasAllocationTransferId: TRANSFER_ID,
				proposalFingerprint: expectedProposalFingerprint,
				idempotencyKey: "lock-order-test-key",
				revisionFingerprint: "f".repeat(64),
				occurredAt: new Date("2026-02-05T00:00:00Z"),
				createdAt: new Date(),
			},
		]);

		const tx = {
			select: makeSelectFn(selectMap, (table) => {
				if (table === monthlyBudgetPlans) planLockOrder.push("lockPlan");
			}),
			insert: makeInsertFn(insertMap),
		} as unknown as DatabaseTransaction;

		const db = {
			transaction: vi.fn(async (cb: (tx: DatabaseTransaction) => unknown) =>
				cb(tx),
			),
		} as unknown as Database;

		const result = await closeMonth({
			db,
			userId: USER_ID,
			periodMonth: PERIOD_MONTH,
			expectedProposalFingerprint,
			occurredAt: new Date("2026-02-05T00:00:00Z"),
			idempotencyKey: "lock-order-test-key",
		});

		expect(result.idempotentReplay).toBe(false);
		// Section D: budget-plan row locked, THEN ledger accounts (ascending),
		// THEN Midas allocation state. Never inverted.
		expect(planLockOrder).toEqual(["lockPlan"]);
		expect(callOrder).toEqual(["lockLedgerAccounts", "lockMidas"]);
	});
});

describe("previewMonthClose strict read-only contract (Phase 14-R1, Section B)", () => {
	it("never invokes any write method (insert/update/delete) even when expense-system roles are entirely unprovisioned", async () => {
		const selectMap = buildCommonSelectMap();

		const insertSpy = vi.fn(() => {
			throw new Error(
				"previewMonthClose must never call tx.insert -- it is strictly read-only",
			);
		});

		const tx = {
			select: makeSelectFn(selectMap),
			insert: insertSpy,
			update: vi.fn(() => {
				throw new Error("previewMonthClose must never call tx.update");
			}),
			delete: vi.fn(() => {
				throw new Error("previewMonthClose must never call tx.delete");
			}),
		} as unknown as DatabaseTransaction;

		const db = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => unknown, _opts?: unknown) =>
					cb(tx),
			),
		} as unknown as Database;

		const proposal = await previewMonthClose({
			db,
			userId: USER_ID,
			periodMonth: PERIOD_MONTH,
		});

		expect(insertSpy).not.toHaveBeenCalled();
		// No expense-system accounts are provisioned (empty creditCardSystemAccounts
		// map) -- Section B: each role's expense must be treated as exactly 0.00,
		// never provisioned on the fly.
		expect(proposal.mandatory?.actualExpense).toBe("0.00");
		expect(proposal.discretionary?.actualExpense).toBe("0.00");
		expect(proposal.unclassifiedExpense).toBe("0.00");
	});
});
