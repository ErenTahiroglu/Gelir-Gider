import { describe, expect, it } from "vitest";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../src/db/schema/budget";

describe("Budget Schema Definitions", () => {
	it("defines monthly_budget_plans table with required columns", () => {
		expect(monthlyBudgetPlans.id).toBeDefined();
		expect(monthlyBudgetPlans.userId).toBeDefined();
		expect(monthlyBudgetPlans.periodMonth).toBeDefined();
		expect(monthlyBudgetPlans.canonicalTransactionId).toBeDefined();
		expect(monthlyBudgetPlans.createdAt).toBeDefined();
	});

	it("defines monthly_budget_plan_revisions table with all required 5 envelope columns", () => {
		expect(monthlyBudgetPlanRevisions.id).toBeDefined();
		expect(monthlyBudgetPlanRevisions.userId).toBeDefined();
		expect(monthlyBudgetPlanRevisions.budgetPlanId).toBeDefined();
		expect(monthlyBudgetPlanRevisions.canonicalRevisionId).toBeDefined();
		expect(monthlyBudgetPlanRevisions.revisionNo).toBeDefined();
		expect(monthlyBudgetPlanRevisions.previousBudgetRevisionId).toBeDefined();
		expect(monthlyBudgetPlanRevisions.operation).toBeDefined();
		expect(monthlyBudgetPlanRevisions.policyVersion).toBeDefined();
		expect(monthlyBudgetPlanRevisions.currency).toBeDefined();
		expect(monthlyBudgetPlanRevisions.referenceIncomeAmount).toBeDefined();
		expect(monthlyBudgetPlanRevisions.mandatoryCeilingAmount).toBeDefined();
		expect(monthlyBudgetPlanRevisions.discretionaryCeilingAmount).toBeDefined();
		expect(monthlyBudgetPlanRevisions.shortTermPurchaseAmount).toBeDefined();
		expect(monthlyBudgetPlanRevisions.mediumTermReserveAmount).toBeDefined();
		expect(monthlyBudgetPlanRevisions.longTermInvestmentAmount).toBeDefined();
		expect(monthlyBudgetPlanRevisions.referenceSnapshot).toBeDefined();
		expect(monthlyBudgetPlanRevisions.createdAt).toBeDefined();
	});
});
