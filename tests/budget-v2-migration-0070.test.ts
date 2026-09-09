import { describe, expect, it } from "vitest";
import migration0067Sql from "../migrations/0067_add_budget_v2_spending_food_semantics.sql?raw";
import migration0070Sql from "../migrations/0070_add_budget_v2_surplus_use_attribution.sql?raw";
import journal from "../migrations/meta/_journal.json";
import snapshot0068 from "../migrations/meta/0068_snapshot.json";
import snapshot0070 from "../migrations/meta/0070_snapshot.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	SURPLUS_USE_LANES,
	SURPLUS_USE_OPERATIONS,
	SURPLUS_USE_SOURCE_KINDS,
	SURPLUS_USE_SUBJECT_TYPES,
} from "../src/db/schema/budget-v2-surplus-use";

const sql = migration0070Sql;
const T = "budget_v2_surplus_use_attribution_revisions";

describe("Migration 0070 -- Budget V2 surplus-use attribution", () => {
	it("is journal entry idx 70 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 70);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe("0070_add_budget_v2_surplus_use_attribution");
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("creates one additive append-only polymorphic attribution table", () => {
		expect(sql).toContain(`CREATE TABLE "${T}"`);
		expect(sql).toContain('"basis_amount" numeric(18, 2) NOT NULL');
		expect(sql).toContain('"current_surplus_amount" numeric(18, 2) NOT NULL');
		expect(sql).toMatch(
			new RegExp(
				`"operation" IN \\('${SURPLUS_USE_OPERATIONS.join("', '")}'\\)`,
			),
		);
		expect(sql).toContain(`"lane" IN ('${SURPLUS_USE_LANES.join("', '")}')`);
		expect(sql).toContain(
			`"subject_type" IN ('${SURPLUS_USE_SUBJECT_TYPES.join("', '")}')`,
		);
		expect(sql).toContain(
			`"source_kind" IN ('${SURPLUS_USE_SOURCE_KINDS.join("', '")}')`,
		);
		// no AUTO / MODEL / HEURISTIC source kind, no free-form manual subject
		expect(sql).not.toMatch(/AUTO|MODEL|HEURISTIC/);
	});

	it("enforces the money / explicit-zero invariants", () => {
		expect(sql).toContain('"basis_amount" > 0');
		expect(sql).toContain('"current_surplus_amount" >= 0');
		expect(sql).toMatch(
			/"current_surplus_amount" <= "budget_v2_surplus_use_attribution_revisions"\."basis_amount"/,
		);
		// a VOID revision carries 0 current surplus (never "0 = no attribution")
		expect(sql).toContain("\"operation\" <> 'VOID' OR");
		// other_funding_amount is derived, never stored
		expect(sql).not.toContain('"other_funding_amount"');
	});

	it("enforces exactly-one polymorphic subject + lane / evidence compatibility", () => {
		expect(sql).toContain("bv2surplus_subject_identity_check");
		// mobility subject -> INTERNATIONAL_MOBILITY lane + mobility_goal_id
		expect(sql).toMatch(
			/'MOBILITY_MIDAS_TRANSFER'[\s\S]*?"mobility_goal_id" IS NOT NULL[\s\S]*?"lane" = 'INTERNATIONAL_MOBILITY'/,
		);
		// long-term subject -> LONG_TERM_INVESTMENT lane
		expect(sql).toMatch(
			/'LONG_TERM_SEND_TASK'[\s\S]*?"long_term_task_revision_id" IS NOT NULL[\s\S]*?"lane" = 'LONG_TERM_INVESTMENT'/,
		);
		// spending subjects -> DISCRETIONARY lane
		expect(sql).toMatch(
			/'CREDIT_CARD_PURCHASE'[\s\S]*?"lane" = 'DISCRETIONARY'/,
		);
	});

	it("adds an immutability guard + a BEFORE INSERT subject/period/chain guard", () => {
		for (const fn of [
			"trg_fn_guard_bv2surplus_revisions_immutability",
			"trg_fn_guard_bv2surplus_revisions_insert",
		]) {
			expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`);
		}
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_bv2surplus_revisions_insert\nBEFORE INSERT ON "budget_v2_surplus_use_attribution_revisions"',
		);
		expect(sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).toHaveLength(1);
		// subject-type -> financial target validity
		expect(sql).toContain("event_type != 'PURCHASE'");
		expect(sql).toContain("direction != 'PAYABLE'");
		// period_month must be the first calendar day of a month
		expect(sql).toContain("EXTRACT(DAY FROM NEW.period_month) <> 1");
		// previous chain identity: same user / period / subject
		expect(sql).toContain(
			"previous surplus-use attribution revision period_month",
		);
		expect(sql).toContain(
			"previous surplus-use attribution revision subject does not match",
		);
	});

	it("performs no economic writes / funding inference in SQL", () => {
		const guardBodies = sql
			.split("\n")
			.filter((l) => !l.trim().startsWith("--"))
			.join("\n");
		expect(guardBodies).not.toMatch(/merchant|memo|destination_label/i);
		expect(sql).not.toMatch(
			/INSERT\s+INTO\s+"?(income|people|midas|credit|ledger)/i,
		);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		// 0067 (a sibling projection) is untouched.
		expect(migration0067Sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_bv2food_revisions_insert()",
		);
	});

	it("has a Drizzle metadata snapshot chaining from 0068_snapshot (0069 is function-only)", () => {
		const snap = snapshot0070 as {
			version: string;
			dialect: string;
			prevId: string;
			tables: Record<string, unknown>;
		};
		expect(snap.version).toBe("7");
		expect(snap.dialect).toBe("postgresql");
		expect(snap.tables[`public.${T}`]).toBeTruthy();
		expect(snap.prevId).toBe((snapshot0068 as { id: string }).id);
	});

	it("the backup registry auto-discovers the table with an FK-consistent restore order", () => {
		const names = getBackupTableDescriptors().map((d) => d.tableName);
		expect(names).toContain(T);
		expect(names).toEqual([...names].sort());
		const order = computeRestoreOrderFromSchema();
		const idx = order.indexOf(T);
		expect(idx).toBeGreaterThan(-1);
		for (const parent of [
			"users",
			"credit_card_liability_events",
			"person_obligations",
			"midas_allocation_transfers",
			"long_term_send_tasks",
			"short_term_goals",
		]) {
			expect(order.indexOf(parent)).toBeGreaterThan(-1);
			expect(order.indexOf(parent)).toBeLessThan(idx);
		}
		expect(new Set(order).size).toBe(order.length);
	});
});
