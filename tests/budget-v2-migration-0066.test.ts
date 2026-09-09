import { describe, expect, it } from "vitest";
import migration0065Sql from "../migrations/0065_add_credit_card_statement_reconciliation.sql?raw";
import migration0066Sql from "../migrations/0066_harden_statement_reconciliation_split_consistency.sql?raw";
import journal from "../migrations/meta/_journal.json";
import { getBackupTableDescriptors } from "../src/backups/registry";

const sql = migration0066Sql;

describe("Migration 0066 -- statement reconciliation <-> purchase split consistency", () => {
	it("is journal entry idx 66 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 66);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe(
			"0066_harden_statement_reconciliation_split_consistency",
		);
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("only CREATE OR REPLACEs the existing 0065 component guard -- no new tables / no data change", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_ccsrc_insert()",
		);
		expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
		expect(sql).not.toMatch(/CREATE TABLE/i);
		expect(sql).not.toMatch(/ALTER TABLE/i);
		expect(sql).not.toMatch(/INSERT\s+INTO/i);
		expect(sql).not.toMatch(/UPDATE\s+"?[a-z_]/i);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		// migration 0065 is not edited by this migration
		expect(migration0065Sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_ccsrc_insert()",
		);
	});

	it("enforces the active-split invariants for PURCHASE components", () => {
		// active split -> must reference the exact active revision, sealed
		expect(sql).toContain("must be the active split revision % for purchase %");
		expect(sql).toContain("is not sealed");
		expect(sql).toContain(
			"is not a participant of split revision % for purchase %",
		);
		expect(sql).toContain(
			"has zero user share; PERSONAL ownership incompatible",
		);
		// no active split -> ownership must be PERSONAL, no split ref
		expect(sql).toContain("has no active split; ownership must be PERSONAL");
		expect(sql).toContain(
			"has no active split; purchase_split_revision_id must be NULL",
		);
		// resolves the authoritative active split as the latest non-VOID revision
		expect(sql).toMatch(/ORDER BY r\.revision_no DESC\s+LIMIT 1/);
		expect(sql).toMatch(/v_active_split\.operation = 'VOID'/);
		// no proportional installment allocation invented here (guard body only)
		const body = sql.slice(
			sql.indexOf("CREATE OR REPLACE FUNCTION trg_fn_guard_ccsrc_insert()"),
			sql.indexOf("$$ LANGUAGE plpgsql"),
		);
		expect(body).not.toMatch(/installment|proportional|allocat/i);
	});

	it("does not disturb the 0065 backup table set", () => {
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
	});
});
