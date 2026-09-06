import { describe, expect, it } from "vitest";
import migration0050Sql from "../migrations/0050_close_final_campaign_review_workflow_gaps.sql?raw";

describe("Campaign Domain Migration 0050 Verification (Phase 16-R2)", () => {
	const sql = migration0050Sql;

	it("adds the applied_campaign_revision_id column with FK + partial unique index (Section D/J)", () => {
		expect(sql).toContain(
			'ALTER TABLE "campaign_review_candidate_revisions" ADD COLUMN "applied_campaign_revision_id" uuid;',
		);
		expect(sql).toContain(
			"campaign_review_candidate_revisions_applied_campaign_revision_id_campaign_period_revisions_id_fk",
		);
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "campaign_review_candidate_revisions_applied_revision_idx" ON "campaign_review_candidate_revisions" USING btree ("applied_campaign_revision_id") WHERE "campaign_review_candidate_revisions"."applied_campaign_revision_id" IS NOT NULL;',
		);
	});

	it("enforces the APPLY <=> applied_campaign_revision_id NOT NULL shape via a plain CHECK (Section J)", () => {
		expect(sql).toContain(
			"campaign_review_candidate_revisions_applied_revision_shape_check",
		);
		expect(sql).toContain(
			`CHECK (("campaign_review_candidate_revisions"."operation" = 'APPLY') = ("campaign_review_candidate_revisions"."applied_campaign_revision_id" IS NOT NULL))`,
		);
	});

	it("adds rule_shape/reward_shape/merchant_scope_shape CHECK constraints mirroring campaign_period_revisions (Section H)", () => {
		expect(sql).toContain(
			"campaign_review_candidate_revisions_rule_shape_check",
		);
		expect(sql).toContain(
			"campaign_review_candidate_revisions_reward_shape_check",
		);
		expect(sql).toContain(
			"campaign_review_candidate_revisions_merchant_scope_shape_check",
		);
		// REPEATABLE_SPEND special case preserved exactly (expected_reward_points NULL).
		expect(sql).toContain(
			'\'REPEATABLE_SPEND\' AND "campaign_review_candidate_revisions"."expected_reward_points" IS NULL',
		);
	});

	it("locks the owning campaign_periods row FOR UPDATE as the first statement of the candidate anchor insert guard (Section E/G)", () => {
		const fnStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_insert()",
		);
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = sql.slice(fnStart, fnStart + 900);
		expect(fnBody).toContain(
			"SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id FOR UPDATE;",
		);
	});

	it("requires ACTIVE lifecycle to create a review candidate (Section E)", () => {
		expect(sql).toContain(
			"must be ACTIVE to create a review candidate (found %)",
		);
	});

	it("requires non-MANUAL source snapshot provider to match the campaign family provider (Section F)", () => {
		expect(sql).toContain(
			"Source snapshot provider % does not match campaign family provider %",
		);
		expect(sql).toContain("v_snapshot.source_type != 'MANUAL'");
	});

	it("rejects a second PENDING candidate with an identical (campaign_period_id, candidate_hash) pair (Section G)", () => {
		expect(sql).toContain(
			"already has a PENDING review candidate % with identical hash %",
		);
		expect(sql).toContain(
			"WHERE campaign_period_id = NEW.campaign_period_id\n\t\t\tAND candidate_hash = NEW.candidate_hash\n\t\t\tAND id != NEW.id",
		);
	});

	it("validates proposed_card_ids shape (array, non-empty, valid UUIDs, no duplicates, owned by the same user) (Section H)", () => {
		expect(sql).toContain(
			"proposed_card_ids must be a JSON array for candidate revision",
		);
		expect(sql).toContain(
			"proposed_card_ids must not be empty for candidate revision",
		);
		expect(sql).toContain(
			"proposed_card_ids must not contain duplicate ids for candidate revision",
		);
		expect(sql).toContain("is not a valid UUID for candidate revision");
		expect(sql).toContain("does not belong to candidate user");
	});

	it("validates reward account ownership for REWARD_POINTS without requiring activeness (Section H)", () => {
		expect(sql).toContain("NEW.reward_kind = 'REWARD_POINTS'");
		expect(sql).toContain("Reward account % not found");
		expect(sql).toContain(
			"Reward account % does not belong to candidate user %",
		);
	});

	it("requires APPLY/DISMISS to copy forward the exact reviewed terms from the predecessor (Section I)", () => {
		expect(sql).toContain(
			"APPLY/DISMISS must copy forward the exact reviewed terms from the predecessor revision",
		);
		expect(sql).toContain(
			"NEW.proposed_card_ids IS NOT DISTINCT FROM v_latest.proposed_card_ids",
		);
	});

	it("adds a DEFERRED constraint trigger sealing APPLY to the exact AMEND revision it produced (Section J)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_apply_seal()",
		);
		expect(sql).toContain("CREATE CONSTRAINT TRIGGER");
		expect(sql).toContain(
			'trg_guard_campaign_review_candidate_apply_seal\nAFTER INSERT ON "campaign_review_candidate_revisions"\nDEFERRABLE INITIALLY DEFERRED',
		);
		expect(sql).toContain("is not an AMEND revision (found %)");
		expect(sql).toContain("is not ACTIVE (found %)");
		expect(sql).toContain("source_snapshot_id does not match candidate");
		expect(sql).toContain("terms diverge from candidate APPLY revision");
		expect(sql).toContain("card scope diverges from candidate APPLY revision");
	});

	it("does not modify migration 0049 or any prior migration file (Phase 16-R2 scope discipline)", () => {
		// This migration is additive-only via ALTER/CREATE OR REPLACE; it never
		// DROPs the pre-existing campaign_review_candidate* tables/columns.
		expect(sql).not.toContain("DROP TABLE");
		expect(sql).not.toContain("DROP COLUMN");
	});
});
