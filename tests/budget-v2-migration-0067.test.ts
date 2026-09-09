import { describe, expect, it } from "vitest";
import migration0063Sql from "../migrations/0063_add_budget_v2_semantic_classifications.sql?raw";
import migration0067Sql from "../migrations/0067_add_budget_v2_spending_food_semantics.sql?raw";
import journal from "../migrations/meta/_journal.json";
import snapshot0065 from "../migrations/meta/0065_snapshot.json";
import snapshot0067 from "../migrations/meta/0067_snapshot.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	SPENDING_FOOD_OPERATIONS,
	SPENDING_FOOD_SOURCE_KINDS,
	SPENDING_FOOD_SUBJECT_TYPES,
} from "../src/db/schema/budget-v2-spending-food";

const sql = migration0067Sql;

describe("Migration 0067 -- Budget V2 explicit spending food semantics", () => {
	it("is journal entry idx 67 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 67);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe("0067_add_budget_v2_spending_food_semantics");
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("creates one additive append-only food-semantic projection table with kuruş-exact allocations", () => {
		expect(sql).toContain(
			'CREATE TABLE "budget_v2_spending_food_semantic_revisions"',
		);
		expect(sql).toContain('"basis_personal_amount" numeric(18, 2) NOT NULL');
		expect(sql).toContain('"food_home_market_amount" numeric(18, 2) NOT NULL');
		expect(sql).toContain('"food_outside_amount" numeric(18, 2) NOT NULL');
		expect(sql).toMatch(
			new RegExp(
				`"operation" IN \\('${SPENDING_FOOD_OPERATIONS.join("', '")}'\\)`,
			),
		);
		expect(sql).toContain(
			`"source_kind" IN ('${SPENDING_FOOD_SOURCE_KINDS.join("', '")}')`,
		);
		expect(sql).toContain(
			`"subject_type" IN ('${SPENDING_FOOD_SUBJECT_TYPES.join("', '")}')`,
		);
		// no AUTO / MODEL / HEURISTIC source kind
		expect(sql).not.toMatch(/AUTO|MODEL|HEURISTIC/);
	});

	it("enforces the mixed-spend + non-food-derivable invariants", () => {
		expect(sql).toContain('"food_home_market_amount" >= 0');
		expect(sql).toContain('"food_outside_amount" >= 0');
		expect(sql).toContain('"basis_personal_amount" > 0');
		// home + outside <= basis (non-food is exactly derivable, never stored)
		expect(sql).toMatch(
			/"food_home_market_amount" \+ "budget_v2_spending_food_semantic_revisions"\."food_outside_amount" <= "budget_v2_spending_food_semantic_revisions"\."basis_personal_amount"/,
		);
		expect(sql).not.toContain('"non_food_amount"');
		// a VOID revision carries no food
		expect(sql).toContain("\"operation\" <> 'VOID' OR (");
	});

	it("enforces polymorphic subject identity + basis evidence", () => {
		expect(sql).toContain("bv2food_subject_identity_check");
		expect(sql).toContain("bv2food_cc_evidence_check");
		expect(sql).toContain("bv2food_people_evidence_check");
		expect(sql).toContain("bv2food_sealed_split_rev_check");
		expect(sql).toContain(
			`"split_basis" IN ('NO_SPLIT', 'VOID_SPLIT', 'SEALED_SPLIT_AS_OF')`,
		);
	});

	it("enforces the append-only revision chain / idempotency / fingerprint integrity", () => {
		expect(sql).toContain("bv2food_purchase_rev_no_idx");
		expect(sql).toContain("bv2food_obligation_rev_no_idx");
		expect(sql).toContain("bv2food_user_idempotency_idx");
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "bv2food_prev_idx"[^;]*WHERE[^;]*previous_revision_id" IS NOT NULL/,
		);
		expect(sql).toContain(`~ '^[0-9a-f]{64}$'`);
	});

	it("adds a NEW immutability guard + a BEFORE INSERT subject/chain guard", () => {
		for (const fn of [
			"trg_fn_guard_bv2food_revisions_immutability",
			"trg_fn_guard_bv2food_revisions_insert",
		]) {
			expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`);
		}
		expect(sql).toContain(
			'CREATE TRIGGER trg_guard_bv2food_revisions_insert\nBEFORE INSERT ON "budget_v2_spending_food_semantic_revisions"',
		);
		expect(sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).toHaveLength(1);
		// subject-type -> financial target validity
		expect(sql).toContain("event_type != 'PURCHASE'");
		expect(sql).toContain("direction != 'PAYABLE'");
		expect(sql).toContain(
			"First food classification revision must have operation CREATE",
		);
		expect(sql).toContain(
			"Subsequent food classification revision must have operation UPDATE or VOID",
		);
	});

	it("performs no classification inference in SQL and no data backfill of prior domains", () => {
		// the guard never reads a merchant / mcc column to decide anything
		expect(sql).not.toMatch(/(merchant|mcc)\s*(=|~|!=|IN|LIKE)/i);
		expect(sql).not.toMatch(/INSERT\s+INTO\s+"?(income|people|midas|credit)/i);
		expect(sql).not.toMatch(
			/UPDATE\s+"?(income_|people_|midas_|monthly_budget|credit_card)/i,
		);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		// 0063 (the sibling semantic projection) is untouched.
		expect(migration0063Sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_irbv2sem_revisions_insert()",
		);
	});

	it("has a Drizzle metadata snapshot representing the post-0067 schema (continuity audit, 4C.1)", () => {
		// Without this file `drizzle-kit generate` diffs against 0065_snapshot
		// (0066 is function-only, no snapshot) and re-proposes the 0067 table.
		const snap = snapshot0067 as {
			version: string;
			dialect: string;
			prevId: string;
			tables: Record<string, unknown>;
		};
		expect(snap.version).toBe("7");
		expect(snap.dialect).toBe("postgresql");
		expect(
			snap.tables["public.budget_v2_spending_food_semantic_revisions"],
		).toBeTruthy();
		// snapshot chain: 0066 has no snapshot, so 0065 is the predecessor.
		expect(snap.prevId).toBe((snapshot0065 as { id: string }).id);
	});

	it("the backup registry auto-discovers the new table and derives an FK-consistent restore order", () => {
		const names = getBackupTableDescriptors().map((d) => d.tableName);
		expect(names).toContain("budget_v2_spending_food_semantic_revisions");
		expect(names).toEqual([...names].sort());
		const order = computeRestoreOrderFromSchema();
		const idx = order.indexOf("budget_v2_spending_food_semantic_revisions");
		expect(idx).toBeGreaterThan(-1);
		for (const parent of [
			"users",
			"credit_card_liability_events",
			"credit_card_liability_event_revisions",
			"person_obligations",
			"person_obligation_revisions",
			"credit_card_purchase_split_revisions",
		]) {
			expect(order.indexOf(parent)).toBeLessThan(idx);
			expect(order.indexOf(parent)).toBeGreaterThan(-1);
		}
		expect(new Set(order).size).toBe(order.length);
	});
});
