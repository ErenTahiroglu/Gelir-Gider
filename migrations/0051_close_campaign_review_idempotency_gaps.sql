CREATE TABLE "campaign_review_candidate_idempotency_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"operation" varchar(10) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_revision_id" uuid NOT NULL,
	"campaign_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_review_candidate_idempotency_receipts_op_check" CHECK ("campaign_review_candidate_idempotency_receipts"."operation" IN ('CREATE', 'APPLY', 'DISMISS')),
	CONSTRAINT "campaign_review_candidate_idempotency_receipts_apply_shape_check" CHECK (("campaign_review_candidate_idempotency_receipts"."operation" = 'APPLY') = ("campaign_review_candidate_idempotency_receipts"."campaign_revision_id" IS NOT NULL)),
	CONSTRAINT "campaign_review_candidate_idempotency_receipts_fingerprint_check" CHECK ("campaign_review_candidate_idempotency_receipts"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaign_review_candidate_idempotency_receipts_idempotency_check" CHECK ("campaign_review_candidate_idempotency_receipts"."idempotency_key" = btrim("campaign_review_candidate_idempotency_receipts"."idempotency_key") AND length("campaign_review_candidate_idempotency_receipts"."idempotency_key") >= 1 AND length("campaign_review_candidate_idempotency_receipts"."idempotency_key") <= 128)
);
--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_idempotency_receipts" ADD CONSTRAINT "campaign_review_candidate_idempotency_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_idempotency_receipts" ADD CONSTRAINT "campaign_review_candidate_idempotency_receipts_candidate_id_campaign_review_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."campaign_review_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_idempotency_receipts" ADD CONSTRAINT "campaign_review_candidate_idempotency_receipts_candidate_revision_id_campaign_review_candidate_revisions_id_fk" FOREIGN KEY ("candidate_revision_id") REFERENCES "public"."campaign_review_candidate_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_idempotency_receipts" ADD CONSTRAINT "campaign_review_candidate_idempotency_receipts_campaign_revision_id_campaign_period_revisions_id_fk" FOREIGN KEY ("campaign_revision_id") REFERENCES "public"."campaign_period_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_review_candidate_idempotency_receipts_user_key_idx" ON "campaign_review_candidate_idempotency_receipts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "campaign_review_candidate_idempotency_receipts_candidate_idx" ON "campaign_review_candidate_idempotency_receipts" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "campaign_review_candidate_idempotency_receipts_campaign_rev_idx" ON "campaign_review_candidate_idempotency_receipts" USING btree ("campaign_revision_id");--> statement-breakpoint

-- ============================================================================
-- PHASE 16-R3: CLOSE CAMPAIGN REVIEW CANDIDATE IDEMPOTENCY GAPS
--
-- This migration closes 3 remaining idempotency gaps specifically in the
-- campaign_review_candidates / campaign_review_candidate_revisions
-- subsystem (Phase 16/16-R1/16-R2 accepted and out of scope otherwise):
--
-- 1. CREATE historical replay must precede mutable campaign lifecycle
--    checks -- fixed entirely at the application layer
--    (src/campaigns/review-candidates.ts): the early idempotency-key
--    replay lookup now runs before the campaign_periods FOR UPDATE lock,
--    before the ACTIVE lifecycle gate, and before source/provider
--    validation.
-- 2. A dedup request that returns an already-PENDING candidate must
--    permanently bind its own idempotency key to that exact result --
--    fixed at the application layer by durably inserting a receipt row for
--    the dedup-alias key.
-- 3. The candidate idempotency-key namespace must remain consistent across
--    CREATE/APPLY/DISMISS -- fixed by this migration's new
--    campaign_review_candidate_idempotency_receipts table (created above
--    via drizzle-kit generate) plus the immutability + binding-validation
--    triggers below.
--
-- A. IMMUTABILITY: the new receipts table is INSERT-only, reusing the
--    exact generic trg_fn_deny_mutation_campaigns() function already used
--    for every other immutable campaign-domain table (migration 0048).
-- B. DB-AUTHORITATIVE BINDING GUARD (BEFORE INSERT): validates
--    candidate_id/candidate_revision_id/campaign_revision_id ownership and
--    cross-references so the receipt table can never be fed a value the
--    application layer computed incorrectly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY (reuses the existing generic deny-mutation function)
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_review_candidate_idempotency_receipts ON "campaign_review_candidate_idempotency_receipts";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_review_candidate_idempotency_receipts
BEFORE UPDATE OR DELETE ON "campaign_review_candidate_idempotency_receipts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. RECEIPT BINDING VALIDATION GUARD (BEFORE INSERT)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_idempotency_receipt_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_candidate RECORD;
	v_revision RECORD;
BEGIN
	SELECT * INTO v_candidate FROM campaign_review_candidates WHERE id = NEW.candidate_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign review candidate % not found for idempotency receipt %', NEW.candidate_id, NEW.id;
	END IF;
	IF v_candidate.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign review candidate % does not belong to receipt user %', NEW.candidate_id, NEW.user_id;
	END IF;

	SELECT * INTO v_revision FROM campaign_review_candidate_revisions WHERE id = NEW.candidate_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign review candidate revision % not found for idempotency receipt %', NEW.candidate_revision_id, NEW.id;
	END IF;
	IF v_revision.candidate_id != NEW.candidate_id THEN
		RAISE EXCEPTION 'Candidate revision % does not belong to candidate % for idempotency receipt %', NEW.candidate_revision_id, NEW.candidate_id, NEW.id;
	END IF;
	IF v_revision.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Candidate revision % does not belong to receipt user %', NEW.candidate_revision_id, NEW.user_id;
	END IF;
	IF v_revision.operation != NEW.operation THEN
		RAISE EXCEPTION 'Receipt operation % does not match candidate revision % operation % for idempotency receipt %', NEW.operation, NEW.candidate_revision_id, v_revision.operation, NEW.id;
	END IF;

	IF NEW.operation = 'APPLY' THEN
		IF NEW.campaign_revision_id IS DISTINCT FROM v_revision.applied_campaign_revision_id THEN
			RAISE EXCEPTION 'APPLY idempotency receipt % campaign_revision_id % does not match candidate revision % applied_campaign_revision_id %', NEW.id, NEW.campaign_revision_id, NEW.candidate_revision_id, v_revision.applied_campaign_revision_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_idempotency_receipt_insert ON "campaign_review_candidate_idempotency_receipts";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_review_candidate_idempotency_receipt_insert
BEFORE INSERT ON "campaign_review_candidate_idempotency_receipts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_idempotency_receipt_insert();