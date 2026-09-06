import { describe, expect, it } from "vitest";
import migration0044Sql from "../migrations/0044_harden_month_end_close_integrity.sql?raw";

describe("Month Close Domain Migration 0044 Verification (Phase 14-R1)", () => {
	const sql = migration0044Sql;

	it("adds a route <-> Midas account shape CHECK constraint (Section F)", () => {
		expect(sql).toContain("month_close_revisions_midas_account_route_check");
		expect(sql).toContain(
			'("month_close_revisions"."route" IN (\'SHORT_TERM_GOAL\', \'MEDIUM_TERM_RESERVE\')) = ("month_close_revisions"."midas_account_id" IS NOT NULL)',
		);
	});

	it("validates any non-null midas_account_id references a real Midas account owned by the same user (Section F)", () => {
		expect(sql).toContain("Month close revision midas_account_id % not found");
		expect(sql).toContain(
			"Midas account % does not belong to month close revision user %",
		);
	});

	it("validates the target goal revision is a REAL row for the exact goal (Section E)", () => {
		expect(sql).toContain(
			"Target short-term goal revision % not found for goal % (user %)",
		);
	});

	it("validates the target goal revision is the LATEST revision for that goal (Section E)", () => {
		expect(sql).toContain("SELECT MAX(revision_no) INTO v_max_goal_rev_no");
		expect(sql).toContain("is not the latest revision (latest is %)");
	});

	it("validates the target goal revision status is ACTIVE (Section E)", () => {
		expect(sql).toContain("is not ACTIVE (status=%)");
		expect(sql).toContain("v_goal_rev.status != 'ACTIVE'");
	});

	it("applies the goal-revision binding under every SHORT_TERM_GOAL decision (FULL, PARTIAL, and SKIP)", () => {
		expect(sql).toContain("IF NEW.route = 'SHORT_TERM_GOAL' THEN");
		expect(sql).toContain(
			"This applies under every decision (FULL, PARTIAL, and SKIP)",
		);
	});

	it("requires the target bucket to belong to the same user (Section F)", () => {
		expect(sql).toContain("Target bucket % does not belong to user %");
	});

	it("replaces NULL-unsafe != identity comparisons with IS DISTINCT FROM (Section F)", () => {
		expect(sql).toContain(
			"v_midas_account.user_id IS DISTINCT FROM NEW.user_id",
		);
		expect(sql).toContain("v_goal.user_id IS DISTINCT FROM NEW.user_id");
		expect(sql).toContain(
			"v_goal.midas_account_id IS DISTINCT FROM NEW.midas_account_id",
		);
		expect(sql).toContain(
			"v_goal.midas_bucket_id IS DISTINCT FROM NEW.target_bucket_id",
		);
		expect(sql).toContain(
			"v_bucket.midas_account_id IS DISTINCT FROM NEW.midas_account_id",
		);
		expect(sql).toContain(
			"v_transfer.midas_account_id IS DISTINCT FROM NEW.midas_account_id",
		);
		expect(sql).toContain("v_transfer.user_id IS DISTINCT FROM NEW.user_id");
	});

	it("replaces the trg_fn_guard_month_close_revision_insert function via CREATE OR REPLACE (extends, never duplicates)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_month_close_revision_insert()",
		);
		expect(sql).toContain(
			'DROP TRIGGER IF EXISTS trg_guard_month_close_revision_insert ON "month_close_revisions"',
		);
	});

	it("is a forward-only migration that never redefines the 0043 anchor-completeness or immutability triggers", () => {
		// 0044 only extends/replaces trg_fn_guard_month_close_revision_insert
		// (Section E/F); the 0043 immutability and anchor-completeness triggers
		// are untouched here.
		expect(sql).not.toContain("trg_fn_deny_mutation_month_close");
		expect(sql).not.toContain("trg_fn_guard_month_close_anchor_completeness");
	});
});
