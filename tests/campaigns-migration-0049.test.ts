import { describe, expect, it } from "vitest";
import migration0049Sql from "../migrations/0049_harden_campaign_qualification_and_reward_integrity.sql?raw";

describe("Campaign Domain Migration 0049 Verification (Phase 16-R1)", () => {
	const sql = migration0049Sql;

	it("creates the campaign review candidate tables (Section K)", () => {
		expect(sql).toContain('CREATE TABLE "campaign_review_candidates"');
		expect(sql).toContain('CREATE TABLE "campaign_review_candidate_revisions"');
		expect(sql).toContain("campaign_review_candidates_hash_check");
		expect(sql).toContain(
			"campaign_review_candidate_revisions_proposed_card_ids_check",
		);
	});

	it("enforces INSERT-only immutability on the new review candidate tables (Section K)", () => {
		expect(sql).toContain("trg_deny_mutation_campaign_review_candidates");
		expect(sql).toContain(
			"trg_deny_mutation_campaign_review_candidate_revisions",
		);
	});

	it("enforces ownership + chain guard + anchor completeness on review candidates (Section K)", () => {
		expect(sql).toContain("trg_fn_guard_campaign_review_candidate_insert");
		expect(sql).toContain(
			"trg_fn_guard_campaign_review_candidate_revision_insert",
		);
		expect(sql).toContain(
			"trg_fn_guard_campaign_review_candidate_anchor_completeness",
		);
		expect(sql).toContain("naked candidate anchor");
		expect(sql).toContain(
			"Only APPLY or DISMISS is permitted as a subsequent candidate revision",
		);
		expect(sql).toContain("Cannot create revision on non-PENDING candidate");
	});

	it("rejects cross-provider review candidates only implicitly at the app layer, but the anchor guard still validates snapshot ownership", () => {
		expect(sql).toContain("Source snapshot user_id");
	});

	it("locks the owning campaign_periods row FOR UPDATE as the first statement of the single-active-credit guard (Section H)", () => {
		const fnStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_reward_credit_insert()",
		);
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = sql.slice(fnStart, fnStart + 800);
		expect(fnBody).toContain(
			"SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id FOR UPDATE;",
		);
	});

	it("locks the owning campaign_periods row FOR UPDATE as the first statement of the revision-chain guard (Section H)", () => {
		const fnStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_period_revision_insert()",
		);
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = sql.slice(fnStart, fnStart + 800);
		expect(fnBody).toContain(
			"SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id FOR UPDATE;",
		);
	});

	it("locks the owning campaign_purchase_overrides row FOR UPDATE as the first statement (Section M)", () => {
		const fnStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_purchase_override_revision_insert()",
		);
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = sql.slice(fnStart, fnStart + 600);
		expect(fnBody).toContain(
			"SELECT * INTO v_override FROM campaign_purchase_overrides WHERE id = NEW.override_id FOR UPDATE;",
		);
	});

	it("locks the owning campaign_review_candidates row FOR UPDATE as the first statement (Section K/M pattern)", () => {
		const fnStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_revision_insert()",
		);
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = sql.slice(fnStart, fnStart + 600);
		expect(fnBody).toContain(
			"SELECT * INTO v_candidate FROM campaign_review_candidates WHERE id = NEW.candidate_id FOR UPDATE;",
		);
	});

	it("freezes source_snapshot_id/parser provenance for lifecycle-only operations (Section J)", () => {
		expect(sql).toContain(
			"NEW.source_snapshot_id IS NOT DISTINCT FROM v_latest.source_snapshot_id",
		);
		expect(sql).toContain(
			"NEW.parser_type IS NOT DISTINCT FROM v_latest.parser_type",
		);
		expect(sql).toContain(
			"NEW.parser_version IS NOT DISTINCT FROM v_latest.parser_version",
		);
		expect(sql).toContain(
			"NEW.parser_confidence IS NOT DISTINCT FROM v_latest.parser_confidence",
		);
	});

	it("freezes the card companion set for CONFIRM/HIDE/RESTORE/END/CANCEL relative to the predecessor (Section J)", () => {
		expect(sql).toContain(
			"trg_fn_guard_campaign_period_card_scope_completeness",
		);
		expect(sql).toContain(
			"must not change the bound card set relative to its predecessor",
		);
		expect(sql).toContain(
			"NEW.operation IN ('CONFIRM', 'HIDE', 'RESTORE', 'END', 'CANCEL') AND NEW.previous_revision_id IS NOT NULL",
		);
	});

	it("installs the bidirectional REWARD -> CAMPAIGN companion guard (Section I)", () => {
		expect(sql).toContain(
			"trg_fn_guard_reward_event_revision_campaign_companion",
		);
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_reward_event_revision_campaign_companion",
		);
		expect(sql).toContain('AFTER INSERT ON "reward_event_revisions"');
		expect(sql).toContain(
			"has no matching campaign_reward_credit_revisions CREATE companion",
		);
		expect(sql).toContain(
			"VOID has no matching campaign_reward_credit VOID companion",
		);
		// Zero interference with MANUAL reward flows: immediate return for
		// non-CAMPAIGN-sourced or non-EARN rows.
		expect(sql).toContain(
			"IF v_event.event_type != 'EARN' OR NEW.source_type != 'CAMPAIGN' THEN",
		);
	});

	it("requires a fresh active campaign credit to bind an EARN whose latest revision is still CREATE, never already VOID (Section I)", () => {
		expect(sql).toContain(
			"Reward event % latest revision must be CREATE (not already VOID) to bind a fresh active campaign credit",
		);
	});

	it("is a DEFERRABLE INITIALLY DEFERRED constraint trigger for every cross-table integrity check introduced in this migration", () => {
		const deferredTriggerNames = [
			"trg_guard_campaign_period_card_scope_completeness",
			"trg_guard_reward_event_revision_campaign_companion",
			"trg_guard_campaign_review_candidate_anchor_completeness",
		];
		for (const name of deferredTriggerNames) {
			const idx = sql.indexOf(`CREATE CONSTRAINT TRIGGER ${name}`);
			expect(
				idx,
				`expected to find CREATE CONSTRAINT TRIGGER ${name}`,
			).toBeGreaterThan(-1);
			const nearby = sql.slice(idx, idx + 200);
			expect(nearby).toContain("DEFERRABLE INITIALLY DEFERRED");
		}
	});
});
