import { describe, expect, it } from "vitest";
import migration0067Sql from "../migrations/0067_add_budget_v2_spending_food_semantics.sql?raw";
import migration0068Sql from "../migrations/0068_add_budget_v2_checkpoint_persistence.sql?raw";
import journal from "../migrations/meta/_journal.json";
import snapshot0067 from "../migrations/meta/0067_snapshot.json";
import snapshot0068 from "../migrations/meta/0068_snapshot.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS,
	CHECKPOINT_TRIGGER_CARD_STATUSES,
} from "../src/db/schema/budget-v2-checkpoint";

const sql = migration0068Sql;
// the executable DDL / guard bodies with `-- ...` comment lines removed, so
// prose like "no issuer inference" doesn't trip a "reads a name column" check.
const sqlNoComments = sql
	.split("\n")
	.filter((l) => !l.trim().startsWith("--"))
	.join("\n");
const NEW_TABLES = [
	"budget_v2_checkpoint_trigger_card_revisions",
	"budget_v2_checkpoint_requests",
	"budget_v2_checkpoint_snapshots",
] as const;

describe("Migration 0068 -- Budget V2 durable checkpoint persistence & orchestration", () => {
	it("is journal entry idx 68 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 68);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe("0068_add_budget_v2_checkpoint_persistence");
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("creates the three additive checkpoint tables", () => {
		for (const t of NEW_TABLES) {
			expect(sql).toContain(`CREATE TABLE "${t}"`);
		}
		// trigger-card config is an append-only user-approved chain
		expect(sql).toMatch(
			new RegExp(
				`"status" IN \\('${CHECKPOINT_TRIGGER_CARD_STATUSES.join("', '")}'\\)`,
			),
		);
		expect(sql).toContain(
			`"source_kind" IN ('${CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS.join("', '")}')`,
		);
		expect(sql).toContain("\"operation\" IN ('CREATE', 'UPDATE')");
	});

	it("keys the trigger-card config on the exact creditCardId -- no issuer / name inference in SQL", () => {
		// the config chain FKs the literal card id and nothing name-shaped
		expect(sql).toContain(
			'"budget_v2_checkpoint_trigger_card_revisions_credit_card_id_credit_cards_id_fk"',
		);
		// no guard / check body ever references an issuer / display-name /
		// last-four / merchant column (comment prose that says "no issuer
		// inference" is fine; executable SQL touching such a column is not).
		expect(sqlNoComments).not.toMatch(
			/issuer|display_name|last_four|merchant/i,
		);
	});

	it("makes the request an immutable outbox row, unique per payment event", () => {
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "bv2ckreq_payment_event_idx" ON "budget_v2_checkpoint_requests"/,
		);
		expect(sql).toContain(
			'CONSTRAINT "bv2ckreq_period_first_day_check" CHECK (EXTRACT(DAY FROM "budget_v2_checkpoint_requests"."period_month") = 1)',
		);
	});

	it("makes the snapshot immutable, one-per-request, with an unbranched previous-checkpoint chain", () => {
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "bv2cksnap_request_idx" ON "budget_v2_checkpoint_snapshots"/,
		);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "bv2cksnap_payment_event_idx" ON "budget_v2_checkpoint_snapshots"/,
		);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "bv2cksnap_prev_idx"[^;]*WHERE[^;]*previous_checkpoint_snapshot_id" IS NOT NULL/,
		);
		expect(sql).toContain("\"report_fingerprint\" ~ '^[0-9a-f]{64}$'");
		// previous_checkpoint_snapshot_id and previous_checkpoint_at set together
		expect(sql).toContain(
			'("budget_v2_checkpoint_snapshots"."previous_checkpoint_snapshot_id" IS NULL) = ("budget_v2_checkpoint_snapshots"."previous_checkpoint_at" IS NULL)',
		);
	});

	it("adds one shared UPDATE/DELETE immutability guard for all three tables + a BEFORE INSERT guard per table", () => {
		for (const fn of [
			"trg_fn_guard_bv2ckpt_immutability",
			"trg_fn_guard_bv2ckcard_revisions_insert",
			"trg_fn_guard_bv2ckreq_insert",
			"trg_fn_guard_bv2cksnap_insert",
		]) {
			expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${fn}()`);
		}
		// the shared immutability function is wired to all three tables
		expect(sql.match(/BEFORE UPDATE OR DELETE ON/g) ?? []).toHaveLength(3);
		expect(
			sql.match(/EXECUTE FUNCTION trg_fn_guard_bv2ckpt_immutability\(\)/g) ??
				[],
		).toHaveLength(3);
		// the request guard binds ownership + PAID PAY revision + ENABLED config
		expect(sql).toContain("is not a PAID PAY revision for payment event");
		expect(sql).toContain("is not an ENABLED config for card");
		// the snapshot guard enforces the previous-checkpoint chain
		expect(sql).toContain("is not strictly earlier than this checkpoint");
	});

	it("performs no economic writes and no data backfill", () => {
		expect(sql).not.toMatch(
			/INSERT\s+INTO\s+"?(income|people|midas|credit|canonical|ledger)/i,
		);
		expect(sql).not.toMatch(
			/UPDATE\s+"?(income_|people_|midas_|monthly_budget|credit_card|ledger_)/i,
		);
		expect(sql).not.toMatch(/DELETE\s+FROM/i);
		// 0067 (the sibling projection) is untouched by 0068.
		expect(migration0067Sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_bv2food_revisions_insert()",
		);
	});

	it("has a Drizzle metadata snapshot chaining from 0067_snapshot (continuity audit)", () => {
		const snap = snapshot0068 as {
			version: string;
			dialect: string;
			prevId: string;
			tables: Record<string, unknown>;
		};
		expect(snap.version).toBe("7");
		expect(snap.dialect).toBe("postgresql");
		for (const t of NEW_TABLES) {
			expect(snap.tables[`public.${t}`]).toBeTruthy();
		}
		expect(snap.prevId).toBe((snapshot0067 as { id: string }).id);
	});

	it("the backup registry auto-discovers the new tables with an FK-consistent restore order", () => {
		const names = getBackupTableDescriptors().map((d) => d.tableName);
		for (const t of NEW_TABLES) expect(names).toContain(t);
		expect(names).toEqual([...names].sort());

		const order = computeRestoreOrderFromSchema();
		const idxCard = order.indexOf(
			"budget_v2_checkpoint_trigger_card_revisions",
		);
		const idxReq = order.indexOf("budget_v2_checkpoint_requests");
		const idxSnap = order.indexOf("budget_v2_checkpoint_snapshots");
		expect(idxCard).toBeGreaterThan(-1);
		expect(idxReq).toBeGreaterThan(-1);
		expect(idxSnap).toBeGreaterThan(-1);

		// parents before children
		for (const parent of [
			"users",
			"credit_cards",
			"credit_card_statements",
			"credit_card_statement_revisions",
			"credit_card_statement_payment_events",
		]) {
			expect(order.indexOf(parent)).toBeGreaterThan(-1);
			expect(order.indexOf(parent)).toBeLessThan(idxReq);
		}
		// the request references the trigger-card config; the snapshot references
		// the request.
		expect(idxCard).toBeLessThan(idxReq);
		expect(idxReq).toBeLessThan(idxSnap);
		expect(new Set(order).size).toBe(order.length);
	});
});
