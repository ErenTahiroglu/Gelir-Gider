import { describe, expect, it } from "vitest";
import migration0018Sql from "../migrations/0018_mushy_sleepwalker.sql?raw";
import migration0019Sql from "../migrations/0019_harden_budget_plan_integrity.sql?raw";
import migration0064Sql from "../migrations/0064_add_budget_basic_living_config.sql?raw";
import journal from "../migrations/meta/_journal.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	BASIC_LIVING_CONFIG_OPERATIONS,
	BASIC_LIVING_CONFIG_SOURCE_KINDS,
} from "../src/db/schema/budget-basic-living";

const sql = migration0064Sql;

describe("Migration 0064 -- Budget V2 basic-living config", () => {
	it("is journal entry idx 64 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 64);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe("0064_add_budget_basic_living_config");
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("creates one additive append-only config projection table with no financial-amount ambiguity", () => {
		expect(sql).toContain(
			'CREATE TABLE "budget_v2_basic_living_config_revisions"',
		);
		expect(sql).toContain('"monthly_target_amount" numeric(18, 2) NOT NULL');
		expect(sql).toContain('"effective_period_month" date NOT NULL');
		// exactly the config operations and source kinds
		expect(sql).toMatch(
			new RegExp(
				`"operation" IN \\('${BASIC_LIVING_CONFIG_OPERATIONS.join("', '")}'\\)`,
			),
		);
		expect(sql).toContain(
			`"source_kind" IN ('${BASIC_LIVING_CONFIG_SOURCE_KINDS.join("', '")}')`,
		);
		expect(sql).toContain(
			`EXTRACT(DAY FROM "budget_v2_basic_living_config_revisions"."effective_period_month") = 1`,
		);
	});

	it("enforces the append-only revision chain / idempotency / fingerprint integrity", () => {
		expect(sql).toContain("bv2bl_user_rev_no_idx");
		expect(sql).toContain("bv2bl_user_idempotency_idx");
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "bv2bl_prev_idx"[^;]*WHERE[^;]*previous_revision_id" IS NOT NULL/,
		);
		expect(sql).toContain(`~ '^[0-9a-f]{64}$'`);
	});

	it("adds a NEW immutability guard + a BEFORE INSERT chain guard", () => {
		for (const fn of [
			"trg_fn_guard_bv2bl_revisions_immutability",
			"trg_fn_guard_bv2bl_revisions_insert",
		]) {
			expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`);
		}
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_bv2bl_revisions_insert\nBEFORE INSERT ON "budget_v2_basic_living_config_revisions"',
		);
		expect(sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).toHaveLength(1);
		// deterministic "effective for month" -> non-decreasing effective month
		expect(sql).toMatch(
			/effective_period_month < v_prev\.effective_period_month/,
		);
		expect(sql).toContain(
			"First basic-living config revision must have operation CREATE",
		);
	});

	it("contains no backfill, no data UPDATE of prior domains, no V1 Budget DDL", () => {
		expect(sql).not.toMatch(/INSERT\s+INTO\s+"?(income|people|midas|credit)/i);
		expect(sql).not.toMatch(
			/UPDATE\s+"?(income_|people_|midas_|monthly_budget|credit_card)/i,
		);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		expect(sql).not.toContain("PERSONAL_BUDGET_V1");
		expect(sql).not.toContain("PERSONAL_BUDGET_V2");
		expect(sql).not.toContain('"monthly_budget_plans"');
		// 0018 / 0019 (the V1 contract) are untouched.
		expect(migration0018Sql).toContain(
			`"policy_version" = 'PERSONAL_BUDGET_V1'`,
		);
		expect(migration0019Sql).toContain(
			"policy_version must be PERSONAL_BUDGET_V1",
		);
	});

	it("the backup registry auto-discovers the new config table and derives its restore order", () => {
		const names = getBackupTableDescriptors().map((d) => d.tableName);
		expect(names).toContain("budget_v2_basic_living_config_revisions");
		expect(names).toEqual([...names].sort());
		const order = computeRestoreOrderFromSchema();
		const bl = order.indexOf("budget_v2_basic_living_config_revisions");
		expect(bl).toBeGreaterThan(-1);
		expect(order.indexOf("users")).toBeLessThan(bl);
		expect(new Set(order).size).toBe(order.length);
	});
});
