import { describe, expect, it } from "vitest";
import migration0018Sql from "../migrations/0018_mushy_sleepwalker.sql?raw";
import migration0019Sql from "../migrations/0019_harden_budget_plan_integrity.sql?raw";
import migration0061Sql from "../migrations/0061_add_budget_policy_v2_foundation.sql?raw";
import migration0062Sql from "../migrations/0062_harden_budget_v2_anchor_insert.sql?raw";
import journal from "../migrations/meta/_journal.json";

const sql = migration0062Sql;

describe("Migration 0062 -- V2 anchor insert guard (forward hardening)", () => {
	it("is journal entry idx 62 with a strictly-increasing `when`, no reused tag", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const last = entries[entries.length - 1];
		const prev = entries[entries.length - 2];
		expect(last?.idx).toBe(62);
		expect(last?.tag).toBe("0062_harden_budget_v2_anchor_insert");
		expect(prev?.idx).toBe(61);
		expect(last?.when).toBeGreaterThan(prev?.when ?? 0);
	});

	it("adds ONE new BEFORE INSERT guard function + trigger on monthly_budget_v2_plans", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plans_insert()",
		);
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_monthly_budget_v2_plans_insert\nBEFORE INSERT ON "monthly_budget_v2_plans"',
		);
		expect(sql).toContain(
			"FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_v2_plans_insert()",
		);
		// Exactly one CREATE FUNCTION in this migration.
		expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
	});

	it("binds the anchor to canonical ownership + kind at insert time", () => {
		expect(sql).toContain(
			"SELECT * INTO v_canon_tx\n  FROM canonical_transactions\n  WHERE id = NEW.canonical_transaction_id",
		);
		expect(sql).toContain("row % not found for monthly_budget_v2_plans anchor");
		expect(sql).toContain(
			"anchor user_id % does not match canonical_transaction user_id %",
		);
		expect(sql).toContain(
			"canonical_transaction kind must be MONTHLY_BUDGET_PLAN_V2, found %",
		);
		expect(sql).toContain("RETURN NEW;");
	});

	// --- Adversarial (structural) ---------------------------------------
	it("adversarial: the guard's failure branches cover wrong-user, wrong-kind, and missing canonical tx", () => {
		// wrong user -> RAISE
		expect(sql).toMatch(/IF v_canon_tx\.user_id != NEW\.user_id THEN\s+RAISE/);
		// wrong / unrelated kind (anything != MONTHLY_BUDGET_PLAN_V2, incl. the V1
		// kind 'MONTHLY_BUDGET_PLAN') -> RAISE
		expect(sql).toMatch(
			/IF v_canon_tx\.kind != 'MONTHLY_BUDGET_PLAN_V2' THEN\s+RAISE/,
		);
		// non-existent canonical tx -> NOT FOUND RAISE (belt-and-suspenders with the FK)
		expect(sql).toMatch(/IF NOT FOUND THEN\s+RAISE EXCEPTION/);
		// the correct case returns NEW
		expect(
			sql.trimEnd().endsWith("trg_fn_guard_monthly_budget_v2_plans_insert();"),
		).toBe(true);
	});

	it("does NOT weaken or replace the existing UPDATE/DELETE immutability guard from 0061", () => {
		// 0061 owns immutability; 0062 must not touch it.
		expect(migration0061Sql).toContain(
			"CREATE TRIGGER trg_guard_monthly_budget_v2_plans_immutability",
		);
		expect(sql).not.toContain(
			"trg_fn_guard_monthly_budget_v2_plans_immutability",
		);
		expect(sql).not.toMatch(/BEFORE UPDATE OR DELETE/);
	});

	it("changes no table shape, constraint, index, or 0061 object", () => {
		expect(sql).not.toMatch(/CREATE TABLE/i);
		expect(sql).not.toMatch(/ALTER TABLE/i);
		expect(sql).not.toMatch(/DROP (CONSTRAINT|INDEX|TABLE|COLUMN)/i);
		expect(sql).not.toMatch(/ADD (CONSTRAINT|COLUMN)/i);
		expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
		// no re-declaration of the 0061 revision guard / immutability guards
		expect(sql).not.toContain(
			"trg_fn_guard_monthly_budget_v2_plan_revisions_insert",
		);
		expect(sql).not.toContain(
			"trg_fn_guard_monthly_budget_v2_plan_revisions_immutability",
		);
	});

	it("contains no backfill, no financial-row UPDATE/INSERT, no V1 DDL", () => {
		expect(sql).not.toMatch(/INSERT\s+INTO/i);
		expect(sql).not.toMatch(/UPDATE\s+"?[a-z_]/i);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		expect(sql).not.toContain('"monthly_budget_plans"');
		expect(sql).not.toContain('"monthly_budget_plan_revisions"');
		expect(sql).not.toContain("PERSONAL_BUDGET_V1");
	});
});

describe("Migration 0062 -- V1 / historical isolation", () => {
	it("does not modify migrations 0018 / 0019 / 0061", () => {
		expect(migration0018Sql).toContain(
			`"policy_version" = 'PERSONAL_BUDGET_V1'`,
		);
		expect(migration0019Sql).toContain(
			"canonical_transaction kind must be MONTHLY_BUDGET_PLAN, found",
		);
		expect(migration0019Sql).not.toContain("MONTHLY_BUDGET_PLAN_V2");
		// 0061 still owns the full V2 revision guard + immutability guards.
		expect(migration0061Sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_insert()",
		);
	});

	it("0062 references only V2 objects and the shared canonical_transactions table", () => {
		expect(sql).toContain('"monthly_budget_v2_plans"');
		expect(sql).toContain("canonical_transactions");
		expect(sql).not.toMatch(/monthly_budget_plans[^_v]/);
	});
});
