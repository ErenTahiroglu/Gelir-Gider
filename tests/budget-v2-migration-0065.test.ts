import { describe, expect, it } from "vitest";
import migration0019Sql from "../migrations/0019_harden_budget_plan_integrity.sql?raw";
import migration0065Sql from "../migrations/0065_add_credit_card_statement_reconciliation.sql?raw";
import journal from "../migrations/meta/_journal.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	CC_STATEMENT_RECON_ADJUSTMENT_KINDS,
	CC_STATEMENT_RECON_COMPONENT_TYPES,
	CC_STATEMENT_RECON_OPERATIONS,
	CC_STATEMENT_RECON_OWNERSHIPS,
} from "../src/db/schema/credit-card-statement-reconciliation";

const sql = migration0065Sql;

describe("Migration 0065 -- credit-card statement reconciliation", () => {
	it("is journal entry idx 65 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 65);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe(
			"0065_add_credit_card_statement_reconciliation",
		);
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("creates the four additive append-only reconciliation tables", () => {
		for (const t of [
			"credit_card_statement_reconciliations",
			"credit_card_statement_reconciliation_revisions",
			"credit_card_statement_reconciliation_components",
			"credit_card_statement_reconciliation_seals",
		]) {
			expect(sql).toContain(`CREATE TABLE "${t}"`);
		}
		// component amounts are money, but there is NO stored personal/external
		// TOTAL column -- ownership is per-component and explicit.
		expect(sql).toContain('"amount" numeric(18, 2) NOT NULL');
	});

	it("binds the exact operation / component-type / ownership / adjustment-kind enums", () => {
		expect(sql).toContain(
			`"operation" IN ('${CC_STATEMENT_RECON_OPERATIONS.join("', '")}')`,
		);
		expect(sql).toContain(
			`"component_type" IN ('${CC_STATEMENT_RECON_COMPONENT_TYPES.join("', '")}')`,
		);
		expect(sql).toContain(
			`"ownership" IN ('${CC_STATEMENT_RECON_OWNERSHIPS.join("', '")}')`,
		);
		expect(sql).toContain(
			`"adjustment_kind" IN ('${CC_STATEMENT_RECON_ADJUSTMENT_KINDS.join("', '")}')`,
		);
	});

	it("never infers ownership: EXTERNAL_PERSON requires a person, ADJUSTMENT requires an explicit kind", () => {
		expect(sql).toMatch(
			/ownership" = 'EXTERNAL_PERSON' AND [^)]*"person_id" IS NOT NULL/,
		);
		expect(sql).toMatch(/ownership" = 'PERSONAL' AND [^)]*"person_id" IS NULL/);
		expect(sql).toMatch(
			/component_type" = 'ADJUSTMENT' AND [^)]*"purchase_event_id" IS NULL[^)]*"adjustment_kind" IS NOT NULL/,
		);
		expect(sql).toMatch(
			/component_type" = 'PURCHASE' AND [^)]*"purchase_event_id" IS NOT NULL[^)]*"adjustment_kind" IS NULL/,
		);
	});

	it("adds the immutability + anchor/revision/component/seal insert guards", () => {
		for (const fn of [
			"trg_fn_guard_ccsr_immutability",
			"trg_fn_guard_ccsr_anchor_insert",
			"trg_fn_guard_ccsrr_insert",
			"trg_fn_guard_ccsrc_insert",
			"trg_fn_guard_ccsr_seal_insert",
		]) {
			expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`);
		}
		// one shared immutability fn, applied to all four tables
		expect(sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).toHaveLength(4);
	});

	it("the seal guard enforces a kurus-exact component sum == reconciled statement amount", () => {
		expect(sql).toContain(
			"SELECT COALESCE(SUM(amount), 0)::numeric(18,2), COUNT(*)::integer",
		);
		expect(sql).toMatch(/v_sum != v_rev\.reconciled_statement_amount/);
		expect(sql).toContain(
			"only CREATE / SUPERSEDE reconciliation revisions may be sealed",
		);
	});

	it("the revision guard binds the statement revision + amount and forbids revisions after VOID", () => {
		expect(sql).toMatch(
			/v_stmt_rev\.statement_amount != NEW\.reconciled_statement_amount/,
		);
		expect(sql).toContain(
			"no reconciliation revision may be appended after a VOID revision",
		);
		expect(sql).toContain(
			"First reconciliation revision must have operation CREATE",
		);
	});

	it("the component guard rejects a VOID purchase and a foreign person / card", () => {
		expect(sql).toContain(
			"PURCHASE component references a VOID purchase liability event",
		);
		expect(sql).toMatch(/v_event\.credit_card_id != v_recon\.credit_card_id/);
		expect(sql).toMatch(/v_person\.user_id != v_rev\.user_id/);
		expect(sql).toContain(
			"reconciliation revision % is sealed; no further components may be added",
		);
	});

	it("contains no backfill, no data UPDATE of prior domains, no V1 Budget DDL, no calendar cycle inference", () => {
		expect(sql).not.toMatch(
			/INSERT\s+INTO\s+"?(income|people|midas|monthly_budget|credit_card_statements|credit_card_liability)/i,
		);
		expect(sql).not.toMatch(
			/UPDATE\s+"?(income_|people_|midas_|monthly_budget|credit_card_statement_revisions|credit_card_liability)/i,
		);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		expect(sql).not.toContain("PERSONAL_BUDGET_V1");
		expect(sql).not.toContain("PERSONAL_BUDGET_V2");
		// no statement_day / due_day cycle-window reconstruction in the migration
		expect(sql).not.toMatch(/statement_day|due_day/i);
		expect(migration0019Sql).not.toContain("MONTHLY_BUDGET_PLAN_V2");
	});

	it("the backup registry auto-discovers all four tables with an FK-consistent restore order", () => {
		const names = getBackupTableDescriptors().map((d) => d.tableName);
		for (const t of [
			"credit_card_statement_reconciliations",
			"credit_card_statement_reconciliation_revisions",
			"credit_card_statement_reconciliation_components",
			"credit_card_statement_reconciliation_seals",
		]) {
			expect(names).toContain(t);
		}
		expect(names).toEqual([...names].sort());
		const order = computeRestoreOrderFromSchema();
		const anchor = order.indexOf("credit_card_statement_reconciliations");
		const rev = order.indexOf("credit_card_statement_reconciliation_revisions");
		const comp = order.indexOf(
			"credit_card_statement_reconciliation_components",
		);
		const seal = order.indexOf("credit_card_statement_reconciliation_seals");
		expect(order.indexOf("credit_card_statements")).toBeLessThan(anchor);
		expect(order.indexOf("credit_card_statement_revisions")).toBeLessThan(rev);
		expect(anchor).toBeLessThan(rev);
		expect(rev).toBeLessThan(comp);
		expect(rev).toBeLessThan(seal);
		expect(new Set(order).size).toBe(order.length);
	});
});
