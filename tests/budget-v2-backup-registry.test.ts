import { describe, expect, it } from "vitest";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";

/**
 * The backup registry auto-discovers every `pgTable` exported from the schema
 * barrel, and the restore dependency order is derived from the real FK graph.
 * Adding the V2 tables must flow through both with NO manual list edits.
 */
describe("Budget V2 tables in the backup / restore schema evolution", () => {
	const names = getBackupTableDescriptors().map((d) => d.tableName);

	it("the backup registry discovers both new V2 tables", () => {
		expect(names).toContain("monthly_budget_v2_plans");
		expect(names).toContain("monthly_budget_v2_plan_revisions");
		// still sorted + unique (registry contract)
		expect(names).toEqual([...names].sort());
		expect(new Set(names).size).toBe(names.length);
	});

	it("restore order places the V2 tables after every table they reference", () => {
		const order = computeRestoreOrderFromSchema();
		expect(order).toContain("monthly_budget_v2_plans");
		expect(order).toContain("monthly_budget_v2_plan_revisions");

		const anchorIdx = order.indexOf("monthly_budget_v2_plans");
		const revIdx = order.indexOf("monthly_budget_v2_plan_revisions");

		expect(order.indexOf("users")).toBeLessThan(anchorIdx);
		expect(order.indexOf("canonical_transactions")).toBeLessThan(anchorIdx);
		expect(anchorIdx).toBeLessThan(revIdx);
		expect(order.indexOf("transaction_revisions")).toBeLessThan(revIdx);

		expect(new Set(order).size).toBe(order.length);
	});
});
