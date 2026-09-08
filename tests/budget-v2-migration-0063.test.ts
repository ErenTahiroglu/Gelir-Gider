import { describe, expect, it } from "vitest";
import migration0019Sql from "../migrations/0019_harden_budget_plan_integrity.sql?raw";
import migration0063Sql from "../migrations/0063_add_budget_v2_semantic_classifications.sql?raw";
import journal from "../migrations/meta/_journal.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	STG_BUDGET_V2_PURPOSES,
	SUPPORT_RECEIPT_ROLES,
} from "../src/db/schema/budget-v2-semantics";

const sql = migration0063Sql;

describe("Migration 0063 -- Budget V2 semantic classifications", () => {
	it("is journal entry idx 63 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 63);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe(
			"0063_add_budget_v2_semantic_classifications",
		);
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	// --- E. schema shape -------------------------------------------------
	it("creates the two additive append-only revision projection tables", () => {
		expect(sql).toContain(
			'CREATE TABLE "income_receipt_budget_v2_semantic_revisions"',
		);
		expect(sql).toContain(
			'CREATE TABLE "short_term_goal_budget_v2_purpose_revisions"',
		);
		expect(sql).toContain('"income_receipt_id" uuid NOT NULL');
		expect(sql).toContain('"goal_id" uuid NOT NULL');
		// no financial amount columns anywhere in these tables
		expect(sql).not.toMatch(/numeric\(18, 2\)/);
	});

	it("binds the exact role / purpose enums + operation set", () => {
		expect(sql).toContain(
			`"support_role" IN ('${SUPPORT_RECEIPT_ROLES.join("', '")}')`,
		);
		expect(sql).toContain(
			`"purpose" IN ('${STG_BUDGET_V2_PURPOSES.join("', '")}')`,
		);
		expect(sql).toMatch(/"operation" IN \('CREATE', 'UPDATE'\)/);
		// no VOID operation for a classification
		expect(sql).not.toMatch(/"operation" IN \([^)]*'VOID'/);
	});

	it("enforces revision-chain / idempotency / fingerprint integrity", () => {
		expect(sql).toContain("irbv2sem_receipt_rev_no_idx");
		expect(sql).toContain("irbv2sem_user_idempotency_idx");
		expect(sql).toContain("stgbv2purpose_goal_rev_no_idx");
		expect(sql).toContain("stgbv2purpose_user_idempotency_idx");
		expect(sql).toContain(`~ '^[0-9a-f]{64}$'`);
		// partial-unique previous_revision_id (no branching)
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "irbv2sem_prev_idx"[^;]*WHERE[^;]*previous_revision_id" IS NOT NULL/,
		);
	});

	// --- F. DB guards --------------------------------------------------
	it("adds NEW immutability + BEFORE INSERT guards for both tables", () => {
		for (const fn of [
			"trg_fn_guard_irbv2sem_revisions_immutability",
			"trg_fn_guard_irbv2sem_revisions_insert",
			"trg_fn_guard_stgbv2purpose_revisions_immutability",
			"trg_fn_guard_stgbv2purpose_revisions_insert",
		]) {
			expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`);
		}
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_irbv2sem_revisions_insert\nBEFORE INSERT ON "income_receipt_budget_v2_semantic_revisions"',
		);
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_stgbv2purpose_revisions_insert\nBEFORE INSERT ON "short_term_goal_budget_v2_purpose_revisions"',
		);
		expect(sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).toHaveLength(2);
	});

	it("the support-receipt guard requires the income source nature to be exactly SUPPORT", () => {
		expect(sql).toContain(
			"SELECT * INTO v_source FROM income_sources WHERE id = v_receipt.source_id",
		);
		expect(sql).toMatch(/IF v_source\.nature != 'SUPPORT' THEN\s+RAISE/);
		expect(sql).toContain("FOR UPDATE"); // receipt anchor lock
		expect(sql).toContain(
			"First support classification revision must have operation CREATE",
		);
	});

	it("the goal-purpose guard binds ownership + the append-only chain, and never touches financial state", () => {
		expect(sql).toContain(
			"SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.goal_id FOR UPDATE",
		);
		expect(sql).toMatch(/IF v_goal\.user_id != NEW\.user_id THEN\s+RAISE/);
		expect(sql).toContain(
			"First goal purpose revision must have operation CREATE",
		);
		// The guard function body references no financial tables.
		const body = sql.slice(
			sql.indexOf(
				"CREATE OR REPLACE FUNCTION trg_fn_guard_stgbv2purpose_revisions_insert()",
			),
		);
		const fnBody = body.slice(0, body.indexOf("$$ LANGUAGE plpgsql"));
		expect(fnBody).not.toMatch(/midas_|journal_|ledger_|_amount|allocation/i);
	});

	// --- AG / AH ----------------------------------------------------
	it("AG: contains no backfill, no inferred classification, no data UPDATE of prior domains", () => {
		expect(sql).not.toMatch(
			/INSERT\s+INTO\s+"?(income|people|midas|short_term)/i,
		);
		expect(sql).not.toMatch(
			/UPDATE\s+"?(income_|people_|midas_|short_term_goals|monthly_budget)/i,
		);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
	});

	it("AH: contains no V1 Budget DDL and does not modify the V1 guard", () => {
		expect(sql).not.toContain("PERSONAL_BUDGET_V1");
		expect(sql).not.toContain('"monthly_budget_plans"');
		expect(sql).not.toContain('"monthly_budget_plan_revisions"');
		expect(sql).not.toMatch(
			/FUNCTION\s+trg_fn_guard_monthly_budget_plan_revisions_insert/,
		);
		// 0019 (the V1 hardening) still binds its guard to PERSONAL_BUDGET_V1.
		expect(migration0019Sql).toContain(
			"policy_version must be PERSONAL_BUDGET_V1",
		);
		expect(migration0019Sql).not.toContain("PERSONAL_BUDGET_V2");
	});

	// --- AC / AD / AE  backup / restore ---------------------------
	it("AC: the backup registry auto-discovers both new semantic tables", () => {
		const names = getBackupTableDescriptors().map((d) => d.tableName);
		expect(names).toContain("income_receipt_budget_v2_semantic_revisions");
		expect(names).toContain("short_term_goal_budget_v2_purpose_revisions");
		expect(names).toEqual([...names].sort());
	});

	it("AD/AE: restore order derives from the FK graph (users / income_receipts / short_term_goals / self-FK) with no manual list", () => {
		const order = computeRestoreOrderFromSchema();
		const ir = order.indexOf("income_receipt_budget_v2_semantic_revisions");
		const gp = order.indexOf("short_term_goal_budget_v2_purpose_revisions");
		expect(ir).toBeGreaterThan(-1);
		expect(gp).toBeGreaterThan(-1);
		expect(order.indexOf("users")).toBeLessThan(ir);
		expect(order.indexOf("income_receipts")).toBeLessThan(ir);
		expect(order.indexOf("users")).toBeLessThan(gp);
		expect(order.indexOf("short_term_goals")).toBeLessThan(gp);
		expect(new Set(order).size).toBe(order.length);
	});
});
