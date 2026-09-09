import { describe, expect, it } from "vitest";
import migration0068Sql from "../migrations/0068_add_budget_v2_checkpoint_persistence.sql?raw";
import migration0069Sql from "../migrations/0069_harden_budget_v2_checkpoint_persistence.sql?raw";
import journal from "../migrations/meta/_journal.json";

const sql = migration0069Sql;

describe("Migration 0069 -- checkpoint request provenance hardening (function-only)", () => {
	it("is journal entry idx 69 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 69);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe(
			"0069_harden_budget_v2_checkpoint_persistence",
		);
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("is function/trigger-only: no table shape change", () => {
		expect(sql).not.toMatch(/CREATE\s+TABLE/i);
		expect(sql).not.toMatch(/ALTER\s+TABLE/i);
		expect(sql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
		expect(sql).not.toMatch(/DROP\s+TABLE/i);
	});

	it("CREATE OR REPLACEs exactly the 0068 request-insert guard and re-binds its trigger", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_bv2ckreq_insert()",
		);
		expect(sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi) ?? []).toHaveLength(
			1,
		);
		expect(sql).toContain(
			'DROP TRIGGER IF EXISTS trg_guard_bv2ckreq_insert ON "budget_v2_checkpoint_requests"',
		);
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_bv2ckreq_insert\nBEFORE INSERT ON "budget_v2_checkpoint_requests"',
		);
	});

	it("binds checkpoint_at, the Europe/Istanbul period month, and the exact effective config", () => {
		// checkpoint_at verbatim from the payment event (no clamp)
		expect(sql).toMatch(
			/NEW\.checkpoint_at IS DISTINCT FROM v_pe\.occurred_at/,
		);
		// period_month derived from the payment instant in Europe/Istanbul
		expect(sql).toContain(
			"date_trunc('month', v_pe.occurred_at AT TIME ZONE 'Europe/Istanbul')::date",
		);
		expect(sql).toMatch(/NEW\.period_month IS DISTINCT FROM v_expected_period/);
		// pay revision instant agrees with the payment event
		expect(sql).toMatch(
			/v_payrev\.occurred_at IS DISTINCT FROM v_pe\.occurred_at/,
		);
		// the trigger config must be the greatest revision_no effective at the
		// payment instant, and ENABLED + USER_APPROVED
		expect(sql).toContain("ORDER BY revision_no DESC");
		expect(sql).toContain("occurred_at <= v_pe.occurred_at");
		expect(sql).toMatch(/v_cfg\.id != NEW\.trigger_config_revision_id/);
		expect(sql).toMatch(/v_cfg\.status != 'ENABLED'/);
		expect(sql).toMatch(/v_cfg\.source_kind != 'USER_APPROVED'/);
	});

	it("keeps 0068 immutable and performs no economic writes / backfill", () => {
		// 0068 still carries its original request-guard text
		expect(migration0068Sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_bv2ckreq_insert()",
		);
		expect(sql).not.toMatch(/INSERT\s+INTO/i);
		expect(sql).not.toMatch(/UPDATE\s+"?[a-z_]+\s+SET/i);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		// no issuer / name inference -- config is keyed on the literal card id
		const sqlNoComments = sql
			.split("\n")
			.filter((l) => !l.trim().startsWith("--"))
			.join("\n");
		expect(sqlNoComments).not.toMatch(
			/issuer|display_name|last_four|merchant/i,
		);
	});
});
