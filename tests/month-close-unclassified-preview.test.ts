import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../src/db/schema/budget";
import { creditCardSystemAccounts } from "../src/db/schema/credit-card-ledger";
import { journalLines, ledgerAccounts } from "../src/db/schema/ledger";
import { previewMonthClose } from "../src/month-close/service";

const USER_ID = "019543ef-1111-7000-8000-000000000099";
const PLAN_ID = "019543ef-2222-7000-8000-000000000001";
const LEDGER_ACCOUNT_ID = "019543ef-3333-7000-8000-000000000001";
const PERIOD_MONTH = "2026-01";

function makeBuilder(tableRowsMap: Map<unknown, unknown[]>) {
	return () => {
		let resolvedRows: unknown[] = [];
		const builder = {
			from(table: unknown) {
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
			innerJoin() {
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

describe("previewMonthClose exposes real figures when blocked on unclassified expenses (Phase 14-R1, Section C)", () => {
	it("returns route=BLOCKED with the actual (non-zero, non-dummy) resolved mandatory/discretionary/unclassified figures", async () => {
		const selectMap = new Map<unknown, unknown[]>();
		selectMap.set(users, [{ currency: "TRY" }]);
		selectMap.set(creditCardSystemAccounts, [
			{ role: "UNCLASSIFIED_EXPENSE", ledgerAccountId: LEDGER_ACCOUNT_ID },
		]);
		selectMap.set(ledgerAccounts, [
			{
				id: LEDGER_ACCOUNT_ID,
				userId: USER_ID,
				accountType: "EXPENSE",
				normalBalance: "DEBIT",
				currency: "TRY",
				archivedAt: null,
			},
		]);
		selectMap.set(monthlyBudgetPlans, [{ id: PLAN_ID }]);
		selectMap.set(monthlyBudgetPlanRevisions, [
			{
				id: "019543ef-4444-7000-8000-000000000001",
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
		// Only the UNCLASSIFIED_EXPENSE role is mapped, and it has a positive net
		// expense -- the aggregate query against journalLines is only ever
		// issued for that one mapped role (MANDATORY/DISCRETIONARY are
		// unmapped and therefore contribute exactly 0.00 without any query).
		selectMap.set(journalLines, [{ netDebit: "50.00" }]);

		const tx = {
			select: makeBuilder(selectMap),
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

		expect(proposal.route).toBe("BLOCKED");
		expect(proposal.blockedReason).toBe("MONTH_CLOSE_UNCLASSIFIED_EXPENSES");
		expect(proposal.budgetPlanId).toBe(PLAN_ID);
		expect(proposal.mandatory).toEqual({
			ceiling: "500.00",
			actualExpense: "0.00",
			unused: "500.00",
		});
		expect(proposal.discretionary).toEqual({
			ceiling: "100.00",
			actualExpense: "0.00",
			unused: "100.00",
		});
		expect(proposal.unclassifiedExpense).toBe("50.00");
		expect(proposal.closeSurplus).toBe("600.00");
		expect(proposal.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});
});
