import { describe, expect, it } from "vitest";
import migration0051Sql from "../migrations/0051_close_campaign_review_idempotency_gaps.sql?raw";

describe("Campaign Domain Migration 0051 Verification (Phase 16-R3)", () => {
	const sql = migration0051Sql;

	it("creates the campaign_review_candidate_idempotency_receipts table with the required columns", () => {
		expect(sql).toContain(
			'CREATE TABLE "campaign_review_candidate_idempotency_receipts"',
		);
		expect(sql).toContain('"user_id" uuid NOT NULL');
		expect(sql).toContain('"idempotency_key" varchar(128) NOT NULL');
		expect(sql).toContain('"operation" varchar(10) NOT NULL');
		expect(sql).toContain('"request_fingerprint" varchar(64) NOT NULL');
		expect(sql).toContain('"candidate_id" uuid NOT NULL');
		expect(sql).toContain('"candidate_revision_id" uuid NOT NULL');
		expect(sql).toContain('"campaign_revision_id" uuid');
	});

	it("enforces UNIQUE(user_id, idempotency_key) (Section 3)", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "campaign_review_candidate_idempotency_receipts_user_key_idx" ON "campaign_review_candidate_idempotency_receipts" USING btree ("user_id","idempotency_key");',
		);
	});

	it("enforces the operation IN (CREATE, APPLY, DISMISS) CHECK", () => {
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_op_check",
		);
		expect(sql).toContain(
			`CHECK ("campaign_review_candidate_idempotency_receipts"."operation" IN ('CREATE', 'APPLY', 'DISMISS'))`,
		);
	});

	it("enforces operation = APPLY <=> campaign_revision_id IS NOT NULL via CHECK (Section 3)", () => {
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_apply_shape_check",
		);
		expect(sql).toContain(
			`CHECK (("campaign_review_candidate_idempotency_receipts"."operation" = 'APPLY') = ("campaign_review_candidate_idempotency_receipts"."campaign_revision_id" IS NOT NULL))`,
		);
	});

	it("enforces request_fingerprint as exactly 64 lowercase hex chars via CHECK (Section 3)", () => {
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_fingerprint_check",
		);
		expect(sql).toContain(
			`CHECK ("campaign_review_candidate_idempotency_receipts"."request_fingerprint" ~ '^[0-9a-f]{64}$')`,
		);
	});

	it("enforces idempotency_key shape (btrim, length 1-128) via CHECK", () => {
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_idempotency_check",
		);
	});

	it("adds FK constraints to users, campaign_review_candidates, campaign_review_candidate_revisions, and campaign_period_revisions", () => {
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_user_id_users_id_fk",
		);
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_candidate_id_campaign_review_candidates_id_fk",
		);
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_candidate_revision_id_campaign_review_candidate_revisions_id_fk",
		);
		expect(sql).toContain(
			"campaign_review_candidate_idempotency_receipts_campaign_revision_id_campaign_period_revisions_id_fk",
		);
	});

	it("makes the receipts table INSERT-only by reusing the existing generic trg_fn_deny_mutation_campaigns() function (Section 3/12)", () => {
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_campaign_review_candidate_idempotency_receipts",
		);
		expect(sql).toContain(
			'BEFORE UPDATE OR DELETE ON "campaign_review_candidate_idempotency_receipts"',
		);
		expect(sql).toContain(
			"FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();",
		);
		// It must NOT redefine trg_fn_deny_mutation_campaigns() -- it is
		// reused verbatim from migration 0048.
		expect(sql).not.toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_campaigns()",
		);
	});

	it("adds a BEFORE INSERT binding-validation guard trigger (Section 12)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_idempotency_receipt_insert()",
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_guard_campaign_review_candidate_idempotency_receipt_insert",
		);
		expect(sql).toContain(
			'BEFORE INSERT ON "campaign_review_candidate_idempotency_receipts"',
		);
	});

	it("rejects a receipt whose candidate_id does not belong to the receipt's user (Section 12)", () => {
		expect(sql).toContain(
			"does not belong to receipt user %', NEW.candidate_id, NEW.user_id",
		);
	});

	it("rejects a receipt whose candidate_revision_id belongs to a different candidate (Section 12)", () => {
		expect(sql).toContain(
			"does not belong to candidate % for idempotency receipt %",
		);
	});

	it("rejects a receipt whose candidate_revision_id does not belong to the receipt's user (Section 12)", () => {
		expect(sql).toContain(
			"does not belong to receipt user %', NEW.candidate_revision_id, NEW.user_id",
		);
	});

	it("rejects a receipt whose operation does not match its referenced revision's own operation (Section 12: CREATE/APPLY/DISMISS cross-check)", () => {
		expect(sql).toContain(
			"Receipt operation % does not match candidate revision % operation %",
		);
	});

	it("rejects an APPLY receipt whose campaign_revision_id does not exactly equal the referenced revision's applied_campaign_revision_id (Section 12)", () => {
		expect(sql).toContain("NEW.operation = 'APPLY'");
		expect(sql).toContain(
			"NEW.campaign_revision_id IS DISTINCT FROM v_revision.applied_campaign_revision_id",
		);
		expect(sql).toContain(
			"does not match candidate revision % applied_campaign_revision_id %",
		);
	});

	it("does not modify any prior migration file (Phase 16-R3 scope discipline)", () => {
		expect(sql).not.toContain("DROP TABLE");
		expect(sql).not.toContain("DROP COLUMN");
	});
});
