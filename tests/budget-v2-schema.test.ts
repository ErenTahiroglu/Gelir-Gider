import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../src/db/schema/budget";
import {
	monthlyBudgetV2PlanRevisions,
	monthlyBudgetV2Plans,
} from "../src/db/schema/budget-v2";

describe("Budget V2 schema (separate from the closed V1 contract)", () => {
	it("monthly_budget_v2_plans anchor has the minimal identity columns", () => {
		const cols = getTableColumns(monthlyBudgetV2Plans);
		expect(Object.keys(cols).sort()).toEqual(
			[
				"id",
				"userId",
				"periodMonth",
				"canonicalTransactionId",
				"createdAt",
			].sort(),
		);
		expect(cols.periodMonth.dataType).toBe("string"); // drizzle `date`
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("monthly_budget_v2_plan_revisions has the exact 6 input + 6 output NUMERIC snapshot columns and a JSONB evidence field", () => {
		const cols = getTableColumns(monthlyBudgetV2PlanRevisions);

		const inputCols = [
			"realizedIncomeAmount",
			"currentObligationsAmount",
			"basicLivingFundingAmount",
			"dateBoundNecessaryPurchaseFundingAmount",
			"coreEmergencyFundBalanceAmount",
			"mobilityBalanceAmount",
		];
		const outputCols = [
			"emergencyCatchUpAmount",
			"deficitAmount",
			"trueSurplusAmount",
			"mobilityAllocationAmount",
			"longTermInvestmentAmount",
			"discretionaryAllocationAmount",
		];
		for (const c of [...inputCols, ...outputCols]) {
			expect(cols[c as keyof typeof cols], `missing column ${c}`).toBeDefined();
			// drizzle maps NUMERIC to string
			expect(
				(cols[c as keyof typeof cols] as { dataType: string }).dataType,
			).toBe("string");
		}

		expect(cols.evidenceSnapshot).toBeDefined();
		expect((cols.evidenceSnapshot as { dataType: string }).dataType).toBe(
			"json",
		);

		// Chain / identity columns.
		for (const c of [
			"id",
			"userId",
			"budgetPlanId",
			"canonicalRevisionId",
			"revisionNo",
			"previousBudgetRevisionId",
			"operation",
			"policyVersion",
			"currency",
			"createdAt",
		]) {
			expect(cols[c as keyof typeof cols], `missing column ${c}`).toBeDefined();
		}

		// The financial amounts are NEVER folded into a generic JSON blob.
		expect((cols as Record<string, unknown>).amounts).toBeUndefined();
		expect((cols as Record<string, unknown>).outputs).toBeUndefined();
	});

	it("is a physically distinct projection from V1 (different table objects and names)", () => {
		expect(monthlyBudgetV2Plans).not.toBe(monthlyBudgetPlans);
		expect(monthlyBudgetV2PlanRevisions).not.toBe(monthlyBudgetPlanRevisions);

		// V1 revision columns are unchanged and NOT present on V2, and vice-versa.
		const v1 = getTableColumns(monthlyBudgetPlanRevisions);
		expect(v1.referenceIncomeAmount).toBeDefined();
		expect(v1.mandatoryCeilingAmount).toBeDefined();
		expect(v1.mediumTermReserveAmount).toBeDefined();

		const v2 = getTableColumns(monthlyBudgetV2PlanRevisions);
		expect(
			(v2 as Record<string, unknown>).referenceIncomeAmount,
		).toBeUndefined();
		expect(
			(v2 as Record<string, unknown>).mandatoryCeilingAmount,
		).toBeUndefined();
		expect(
			(v2 as Record<string, unknown>).mediumTermReserveAmount,
		).toBeUndefined();
		expect(
			(v1 as Record<string, unknown>).mobilityAllocationAmount,
		).toBeUndefined();
	});
});
