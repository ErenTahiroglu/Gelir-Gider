import { describe, expect, it } from "vitest";
import migration0043Sql from "../migrations/0043_add_month_end_surplus_close.sql?raw";

describe("Month Close Domain Migration 0043 Verification (Phase 14)", () => {
	const sql = migration0043Sql;

	it("creates both new tables with the expected shape", () => {
		expect(sql).toContain('CREATE TABLE "month_closes"');
		expect(sql).toContain('CREATE TABLE "month_close_revisions"');
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "month_closes_user_period_idx" ON "month_closes" USING btree ("user_id","period_month")',
		);
	});

	it("enforces immutability (INSERT-only) on both tables via BEFORE UPDATE/DELETE triggers", () => {
		expect(sql).toContain("trg_fn_deny_mutation_month_close");
		expect(sql).toContain("is immutable (INSERT-only)");
		expect(sql).toContain('BEFORE UPDATE OR DELETE ON "month_closes"');
		expect(sql).toContain('BEFORE UPDATE OR DELETE ON "month_close_revisions"');
	});

	it("rejects a naked month-close anchor at commit via a deferred constraint trigger requiring exactly one revision", () => {
		expect(sql).toContain("trg_fn_guard_month_close_anchor_completeness");
		expect(sql).toContain("naked month-close anchor; expected exactly 1");
		expect(sql).toContain('AFTER INSERT ON "month_closes"');
		expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
	});

	it("enforces exact arithmetic invariants at the DB level via CHECK constraints", () => {
		expect(sql).toContain("month_close_revisions_mandatory_unused_check");
		expect(sql).toContain("month_close_revisions_discretionary_unused_check");
		expect(sql).toContain("month_close_revisions_surplus_check");
		expect(sql).toContain("month_close_revisions_unrouted_check");
		expect(sql).toContain(
			'"month_close_revisions"."close_surplus" = "month_close_revisions"."mandatory_unused" + "month_close_revisions"."discretionary_unused"',
		);
		expect(sql).toContain(
			'"month_close_revisions"."unrouted_amount" = "month_close_revisions"."close_surplus" - "month_close_revisions"."applied_amount"',
		);
	});

	it("requires unclassified_expense = 0 for the (always CLOSED in V1) stored revision", () => {
		expect(sql).toContain(
			'CONSTRAINT "month_close_revisions_unclassified_check" CHECK ("month_close_revisions"."unclassified_expense" = 0)',
		);
	});

	it("enforces exact route/decision shape combinations via a single CHECK constraint", () => {
		expect(sql).toContain("month_close_revisions_shape_check");
		expect(sql).toContain(
			"'SHORT_TERM_GOAL' AND \"month_close_revisions\".\"decision\" = 'FULL'",
		);
		expect(sql).toContain(
			"'SHORT_TERM_GOAL' AND \"month_close_revisions\".\"decision\" = 'PARTIAL'",
		);
		expect(sql).toContain(
			"'SHORT_TERM_GOAL' AND \"month_close_revisions\".\"decision\" = 'SKIP'",
		);
		expect(sql).toContain(
			"'MEDIUM_TERM_RESERVE' AND \"month_close_revisions\".\"decision\" = 'AUTO_MEDIUM'",
		);
		expect(sql).toContain(
			"'NONE' AND \"month_close_revisions\".\"decision\" = 'NO_ACTION'",
		);
	});

	it("validates budget-plan binding at insert time: same user, same period, exact ceiling/reference equality (forged-ceiling defense)", () => {
		expect(sql).toContain("trg_fn_guard_month_close_revision_insert");
		expect(sql).toContain(
			"Budget plan % user_id % does not match month close user_id %",
		);
		expect(sql).toContain(
			"Budget plan % period_month % does not match month close period_month %",
		);
		expect(sql).toContain("forged ceiling");
		expect(sql).toContain(
			"does not match budget plan revision mandatory_ceiling_amount",
		);
		expect(sql).toContain(
			"does not match budget plan revision discretionary_ceiling_amount",
		);
	});

	it("validates the exact Midas allocation transfer companion binding (from UNALLOCATED only, never a reversal, exact amount)", () => {
		expect(sql).toContain("must not be a Midas reversal");
		expect(sql).toContain(
			"must originate from UNALLOCATED (from_bucket_id must be NULL)",
		);
		expect(sql).toContain("does not match applied_amount");
	});

	it("never permits PENDING_LONG_TERM as a month-close target bucket under any route", () => {
		expect(sql).toContain("may never target the PENDING_LONG_TERM bucket");
	});

	it("validates the exact SHORT_TERM_GOAL target-goal binding (same user, same Midas account, exact bucket)", () => {
		expect(sql).toContain("Target short-term goal % not found");
		expect(sql).toContain("does not belong to user %");
		expect(sql).toContain(
			"Target short-term goal % bucket % does not match target_bucket_id %",
		);
	});

	it("validates bucket_type matches the route exactly (MEDIUM_TERM_RESERVE / SHORT_TERM_GOAL)", () => {
		expect(sql).toContain(
			"SHORT_TERM_GOAL route target bucket % has wrong bucket_type %",
		);
		expect(sql).toContain(
			"MEDIUM_TERM_RESERVE route target bucket % has wrong bucket_type %",
		);
	});
});
