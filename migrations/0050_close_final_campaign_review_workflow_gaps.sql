ALTER TABLE "campaign_review_candidate_revisions" ADD COLUMN "applied_campaign_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_applied_campaign_revision_id_campaign_period_revisions_id_fk" FOREIGN KEY ("applied_campaign_revision_id") REFERENCES "public"."campaign_period_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_review_candidate_revisions_applied_revision_idx" ON "campaign_review_candidate_revisions" USING btree ("applied_campaign_revision_id") WHERE "campaign_review_candidate_revisions"."applied_campaign_revision_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_rule_shape_check" CHECK ((
				"campaign_review_candidate_revisions"."rule_mode" = 'TOTAL_SPEND' AND "campaign_review_candidate_revisions"."target_spend_amount" IS NOT NULL AND "campaign_review_candidate_revisions"."target_spend_amount" > 0
					AND "campaign_review_candidate_revisions"."required_transaction_count" IS NULL AND "campaign_review_candidate_revisions"."minimum_transaction_amount" IS NULL
					AND "campaign_review_candidate_revisions"."step_spend_amount" IS NULL AND "campaign_review_candidate_revisions"."reward_points_per_step" IS NULL AND "campaign_review_candidate_revisions"."max_steps" IS NULL
			) OR (
				"campaign_review_candidate_revisions"."rule_mode" = 'TRANSACTION_COUNT' AND "campaign_review_candidate_revisions"."required_transaction_count" IS NOT NULL AND "campaign_review_candidate_revisions"."required_transaction_count" >= 1
					AND ("campaign_review_candidate_revisions"."minimum_transaction_amount" IS NULL OR "campaign_review_candidate_revisions"."minimum_transaction_amount" > 0)
					AND "campaign_review_candidate_revisions"."target_spend_amount" IS NULL AND "campaign_review_candidate_revisions"."step_spend_amount" IS NULL
					AND "campaign_review_candidate_revisions"."reward_points_per_step" IS NULL AND "campaign_review_candidate_revisions"."max_steps" IS NULL
			) OR (
				"campaign_review_candidate_revisions"."rule_mode" = 'REPEATABLE_SPEND' AND "campaign_review_candidate_revisions"."step_spend_amount" IS NOT NULL AND "campaign_review_candidate_revisions"."step_spend_amount" > 0
					AND "campaign_review_candidate_revisions"."reward_points_per_step" IS NOT NULL AND "campaign_review_candidate_revisions"."reward_points_per_step" > 0
					AND "campaign_review_candidate_revisions"."max_steps" IS NOT NULL AND "campaign_review_candidate_revisions"."max_steps" >= 1
					AND ("campaign_review_candidate_revisions"."minimum_transaction_amount" IS NULL OR "campaign_review_candidate_revisions"."minimum_transaction_amount" > 0)
					AND "campaign_review_candidate_revisions"."target_spend_amount" IS NULL AND "campaign_review_candidate_revisions"."required_transaction_count" IS NULL
			));--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_reward_shape_check" CHECK ((
				"campaign_review_candidate_revisions"."reward_kind" = 'REWARD_POINTS' AND "campaign_review_candidate_revisions"."reward_account_id" IS NOT NULL
					AND (
						("campaign_review_candidate_revisions"."rule_mode" = 'REPEATABLE_SPEND' AND "campaign_review_candidate_revisions"."expected_reward_points" IS NULL)
						OR ("campaign_review_candidate_revisions"."rule_mode" != 'REPEATABLE_SPEND' AND "campaign_review_candidate_revisions"."expected_reward_points" IS NOT NULL AND "campaign_review_candidate_revisions"."expected_reward_points" > 0)
					)
			) OR (
				"campaign_review_candidate_revisions"."reward_kind" IN ('STATEMENT_CREDIT', 'INFORMATIONAL')
					AND "campaign_review_candidate_revisions"."reward_account_id" IS NULL AND "campaign_review_candidate_revisions"."expected_reward_points" IS NULL
			));--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_merchant_scope_shape_check" CHECK ((
				"campaign_review_candidate_revisions"."merchant_scope_mode" = 'MERCHANT_ALIASES' AND "campaign_review_candidate_revisions"."required_canonical_merchant_names" IS NOT NULL
					AND jsonb_typeof("campaign_review_candidate_revisions"."required_canonical_merchant_names") = 'array' AND jsonb_array_length("campaign_review_candidate_revisions"."required_canonical_merchant_names") >= 1
			) OR (
				"campaign_review_candidate_revisions"."merchant_scope_mode" != 'MERCHANT_ALIASES' AND "campaign_review_candidate_revisions"."required_canonical_merchant_names" IS NULL
			));--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_applied_revision_shape_check" CHECK (("campaign_review_candidate_revisions"."operation" = 'APPLY') = ("campaign_review_candidate_revisions"."applied_campaign_revision_id" IS NOT NULL));--> statement-breakpoint

-- ============================================================================
-- PHASE 16-R2: CLOSE FINAL CAMPAIGN REVIEW WORKFLOW GAPS
--
-- This migration closes 10 defect classes found specifically in the
-- campaign_review_candidates / campaign_review_candidate_revisions
-- subsystem introduced by Phase 16 and hardened by Phase 16-R1. It does NOT
-- touch campaign_period_revisions/campaign_purchase_overrides/
-- campaign_reward_credits trigger logic (accepted, out of scope).
--
-- E. ACTIVE CAMPAIGN GATE: trg_fn_guard_campaign_review_candidate_insert now
--    locks the owning campaign_periods row FOR UPDATE as the first
--    statement and requires lifecycle_status = 'ACTIVE' before a candidate
--    may be created (HIDDEN visibility with ACTIVE lifecycle is allowed).
-- F. SOURCE PROVIDER AUTHORITY: the same trigger now also requires a
--    non-MANUAL source snapshot's provider to match the campaign family's
--    provider (MANUAL retains its documented exception).
-- G. CONCURRENT PENDING DEDUP: the same trigger's campaign_periods FOR
--    UPDATE lock doubles as the defense-in-depth serialization point for
--    rejecting a second PENDING candidate with an identical
--    (campaign_period_id, candidate_hash) pair (a previously APPLIED or
--    DISMISSED candidate with the same hash does not block a new PENDING
--    proposal).
-- H. CANDIDATE PROPOSED-TERM DB INTEGRITY: rule_shape/reward_shape/
--    merchant_scope_shape CHECK constraints mirroring
--    campaign_period_revisions (added above via drizzle-kit generate), plus
--    trg_fn_guard_campaign_review_candidate_revision_insert now validates
--    proposed_card_ids shape (JSON array, non-empty, valid UUIDs, no
--    duplicates, every id owned by the candidate's user -- archived cards
--    permitted) and, for REWARD_POINTS, that reward_account_id is owned by
--    the candidate's user (activeness NOT required here -- APPLY's reuse of
--    the campaign AMEND trigger enforces that stricter check).
-- I. TERMINAL COPY-FORWARD: the same trigger now requires an APPLY/DISMISS
--    revision to carry forward the EXACT reviewed terms (title/dates/rule/
--    reward/merchant/mcc/expiry/parser/proposed_card_ids) from its
--    predecessor via IS NOT DISTINCT FROM -- only operation/status/
--    occurred_at/idempotency_key/revision_fingerprint/
--    applied_campaign_revision_id may differ.
-- J. APPLY SEALED TO THE EXACT AMEND: a new DEFERRED constraint trigger on
--    campaign_review_candidate_revisions validates, for every APPLY row,
--    that applied_campaign_revision_id points to a real AMEND revision of
--    the SAME campaign period, ACTIVE, with the same source_snapshot_id,
--    identical term fields, and an identical card-companion set.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- E/F/G. CAMPAIGN REVIEW CANDIDATE ANCHOR INSERT GUARD (rewrite)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_family RECORD;
	v_latest_period_rev RECORD;
	v_snapshot RECORD;
	v_existing RECORD;
	v_existing_latest RECORD;
BEGIN
	-- Section E/G: lock the owning campaign_periods row FOR UPDATE as the
	-- very first statement. This is BOTH the ACTIVE lifecycle gate's read
	-- point AND the serialization point for the concurrent-PENDING-dedup
	-- check below -- the SAME row the app layer locks in
	-- createCampaignReviewCandidate before performing its own get-or-create
	-- search.
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match candidate user_id %', v_period.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_family FROM campaign_families WHERE id = v_period.campaign_family_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign family for period % not found', NEW.campaign_period_id;
	END IF;

	-- Section E: require ACTIVE lifecycle. HIDDEN visibility with ACTIVE
	-- lifecycle is explicitly allowed (visibility is orthogonal);
	-- REVIEW_REQUIRED/ENDED/CANCELLED are all rejected.
	SELECT lifecycle_status INTO v_latest_period_rev
	FROM campaign_period_revisions
	WHERE campaign_period_id = NEW.campaign_period_id
	ORDER BY revision_no DESC
	LIMIT 1;
	IF v_latest_period_rev IS NULL THEN
		RAISE EXCEPTION 'Campaign period % has no revisions', NEW.campaign_period_id;
	END IF;
	IF v_latest_period_rev.lifecycle_status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Campaign period % must be ACTIVE to create a review candidate (found %)', NEW.campaign_period_id, v_latest_period_rev.lifecycle_status;
	END IF;

	SELECT * INTO v_snapshot FROM campaign_source_snapshots WHERE id = NEW.source_snapshot_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign source snapshot % not found', NEW.source_snapshot_id;
	END IF;
	IF v_snapshot.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Source snapshot user_id % does not match candidate user_id %', v_snapshot.user_id, NEW.user_id;
	END IF;

	-- Section F: source-provider authority. MANUAL source snapshots retain
	-- their documented provider exception.
	IF v_snapshot.source_type != 'MANUAL' AND v_snapshot.provider != v_family.provider THEN
		RAISE EXCEPTION 'Source snapshot provider % does not match campaign family provider %', v_snapshot.provider, v_family.provider;
	END IF;

	-- Section G: reject if another candidate anchor for the same
	-- (campaign_period_id, candidate_hash) already has a PENDING latest
	-- revision. A previously APPLIED or DISMISSED candidate with the same
	-- hash does NOT block a later new PENDING proposal (legitimate
	-- re-review cycle) -- only a currently-PENDING duplicate is forbidden.
	FOR v_existing IN
		SELECT id FROM campaign_review_candidates
		WHERE campaign_period_id = NEW.campaign_period_id
			AND candidate_hash = NEW.candidate_hash
			AND id != NEW.id
	LOOP
		SELECT status INTO v_existing_latest
		FROM campaign_review_candidate_revisions
		WHERE candidate_id = v_existing.id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF v_existing_latest.status IS NOT DISTINCT FROM 'PENDING' THEN
			RAISE EXCEPTION 'Campaign period % already has a PENDING review candidate % with identical hash %', NEW.campaign_period_id, v_existing.id, NEW.candidate_hash;
		END IF;
	END LOOP;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_insert ON "campaign_review_candidates";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_review_candidate_insert
BEFORE INSERT ON "campaign_review_candidates"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- H/I. CAMPAIGN REVIEW CANDIDATE REVISION INSERT GUARD (rewrite): adds
-- proposed_card_ids shape/ownership validation, reward account ownership,
-- and terminal APPLY/DISMISS copy-forward sealing.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_candidate RECORD;
	v_latest RECORD;
	v_unchanged BOOLEAN;
	v_card RECORD;
	v_card_id_text TEXT;
	v_card_count INT;
	v_card_distinct_count INT;
	v_reward_account RECORD;
BEGIN
	SELECT * INTO v_candidate FROM campaign_review_candidates WHERE id = NEW.candidate_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign review candidate % not found', NEW.candidate_id;
	END IF;
	IF v_candidate.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Candidate user_id % does not match revision user_id %', v_candidate.user_id, NEW.user_id;
	END IF;

	-- Section H (part: proposed card ids). Validated on every insert
	-- (cheap, and correct regardless of operation since APPLY/DISMISS must
	-- copy the CREATE's already-validated array forward unchanged anyway).
	IF jsonb_typeof(NEW.proposed_card_ids) != 'array' THEN
		RAISE EXCEPTION 'proposed_card_ids must be a JSON array for candidate revision %', NEW.id;
	END IF;
	IF jsonb_array_length(NEW.proposed_card_ids) < 1 THEN
		RAISE EXCEPTION 'proposed_card_ids must not be empty for candidate revision %', NEW.id;
	END IF;
	SELECT count(*), count(DISTINCT elem) INTO v_card_count, v_card_distinct_count
	FROM jsonb_array_elements_text(NEW.proposed_card_ids) AS elem;
	IF v_card_count != v_card_distinct_count THEN
		RAISE EXCEPTION 'proposed_card_ids must not contain duplicate ids for candidate revision %', NEW.id;
	END IF;
	FOR v_card_id_text IN SELECT jsonb_array_elements_text(NEW.proposed_card_ids) LOOP
		IF v_card_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
			RAISE EXCEPTION 'proposed_card_ids element % is not a valid UUID for candidate revision %', v_card_id_text, NEW.id;
		END IF;
		SELECT * INTO v_card FROM credit_cards WHERE id = v_card_id_text::uuid;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card % not found', v_card_id_text;
		END IF;
		IF v_card.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Credit card % does not belong to candidate user %', v_card_id_text, NEW.user_id;
		END IF;
	END LOOP;

	-- Section H (part: reward account ownership). Activeness is NOT
	-- required here -- a stale/archived reward account is fine to retain as
	-- historical proposal evidence; the campaign AMEND trigger (via
	-- amendCampaignPeriodInTransaction reusing the exact same insert path
	-- as any other AMEND) is where activeness is authoritatively enforced
	-- at APPLY time.
	IF NEW.reward_kind = 'REWARD_POINTS' THEN
		SELECT * INTO v_reward_account FROM reward_accounts WHERE id = NEW.reward_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
		END IF;
		IF v_reward_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reward account % does not belong to candidate user %', NEW.reward_account_id, NEW.user_id;
		END IF;
	END IF;

	SELECT id, revision_no, status, title, starts_on, ends_on, rule_mode, target_spend_amount,
		required_transaction_count, minimum_transaction_amount, step_spend_amount,
		reward_points_per_step, max_steps, reward_kind, reward_account_id, expected_reward_points,
		merchant_scope_mode, required_canonical_merchant_names, allowed_mcc_codes, reward_expiry_date,
		parser_type, parser_version, parser_confidence, proposed_card_ids
	INTO v_latest
	FROM campaign_review_candidate_revisions
	WHERE candidate_id = NEW.candidate_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Candidate % already has revisions; revision 1 cannot be created again', NEW.candidate_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'PENDING' THEN
			RAISE EXCEPTION 'First revision must have status PENDING, found %', NEW.status;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for candidate %', NEW.candidate_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of candidate % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.candidate_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status != 'PENDING' THEN
			RAISE EXCEPTION 'Cannot create revision on non-PENDING candidate % (% is terminal)', NEW.candidate_id, v_latest.status;
		END IF;
		IF NEW.operation NOT IN ('APPLY', 'DISMISS') THEN
			RAISE EXCEPTION 'Only APPLY or DISMISS is permitted as a subsequent candidate revision, found %', NEW.operation;
		END IF;
		IF NEW.operation = 'APPLY' AND NEW.status != 'APPLIED' THEN
			RAISE EXCEPTION 'APPLY must set status APPLIED, found %', NEW.status;
		END IF;
		IF NEW.operation = 'DISMISS' AND NEW.status != 'DISMISSED' THEN
			RAISE EXCEPTION 'DISMISS must set status DISMISSED, found %', NEW.status;
		END IF;

		-- Section I: terminal copy-forward -- APPLY/DISMISS must carry
		-- forward the EXACT reviewed terms from the predecessor revision.
		-- Only operation/status/occurred_at/idempotency_key/
		-- revision_fingerprint (and, for APPLY, applied_campaign_revision_id)
		-- may differ.
		v_unchanged := (
			NEW.title IS NOT DISTINCT FROM v_latest.title AND
			NEW.starts_on IS NOT DISTINCT FROM v_latest.starts_on AND
			NEW.ends_on IS NOT DISTINCT FROM v_latest.ends_on AND
			NEW.rule_mode IS NOT DISTINCT FROM v_latest.rule_mode AND
			NEW.target_spend_amount IS NOT DISTINCT FROM v_latest.target_spend_amount AND
			NEW.required_transaction_count IS NOT DISTINCT FROM v_latest.required_transaction_count AND
			NEW.minimum_transaction_amount IS NOT DISTINCT FROM v_latest.minimum_transaction_amount AND
			NEW.step_spend_amount IS NOT DISTINCT FROM v_latest.step_spend_amount AND
			NEW.reward_points_per_step IS NOT DISTINCT FROM v_latest.reward_points_per_step AND
			NEW.max_steps IS NOT DISTINCT FROM v_latest.max_steps AND
			NEW.reward_kind IS NOT DISTINCT FROM v_latest.reward_kind AND
			NEW.reward_account_id IS NOT DISTINCT FROM v_latest.reward_account_id AND
			NEW.expected_reward_points IS NOT DISTINCT FROM v_latest.expected_reward_points AND
			NEW.merchant_scope_mode IS NOT DISTINCT FROM v_latest.merchant_scope_mode AND
			NEW.required_canonical_merchant_names IS NOT DISTINCT FROM v_latest.required_canonical_merchant_names AND
			NEW.allowed_mcc_codes IS NOT DISTINCT FROM v_latest.allowed_mcc_codes AND
			NEW.reward_expiry_date IS NOT DISTINCT FROM v_latest.reward_expiry_date AND
			NEW.parser_type IS NOT DISTINCT FROM v_latest.parser_type AND
			NEW.parser_version IS NOT DISTINCT FROM v_latest.parser_version AND
			NEW.parser_confidence IS NOT DISTINCT FROM v_latest.parser_confidence AND
			NEW.proposed_card_ids IS NOT DISTINCT FROM v_latest.proposed_card_ids
		);
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'APPLY/DISMISS must copy forward the exact reviewed terms from the predecessor revision (candidate %)', NEW.candidate_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_revision_insert ON "campaign_review_candidate_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_review_candidate_revision_insert
BEFORE INSERT ON "campaign_review_candidate_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- J. APPLY SEALED TO THE EXACT AMEND (DEFERRED). Fires at COMMIT so the
-- application may insert the campaign AMEND row and the candidate APPLY row
-- in either order within the same transaction.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_apply_seal()
RETURNS TRIGGER AS $$
DECLARE
	v_candidate RECORD;
	v_amend RECORD;
	v_amend_card_ids UUID[];
	v_candidate_card_ids UUID[];
BEGIN
	IF NEW.operation != 'APPLY' THEN
		RETURN NULL;
	END IF;

	IF NEW.applied_campaign_revision_id IS NULL THEN
		RAISE EXCEPTION 'APPLY revision % must have applied_campaign_revision_id set', NEW.id;
	END IF;

	SELECT * INTO v_candidate FROM campaign_review_candidates WHERE id = NEW.candidate_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign review candidate % not found for APPLY seal check', NEW.candidate_id;
	END IF;

	SELECT * INTO v_amend FROM campaign_period_revisions WHERE id = NEW.applied_campaign_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Applied campaign revision % not found', NEW.applied_campaign_revision_id;
	END IF;

	IF v_amend.campaign_period_id != v_candidate.campaign_period_id THEN
		RAISE EXCEPTION 'Applied campaign revision % belongs to a different campaign period than candidate %', NEW.applied_campaign_revision_id, NEW.candidate_id;
	END IF;
	IF v_amend.operation != 'AMEND' THEN
		RAISE EXCEPTION 'Applied campaign revision % is not an AMEND revision (found %)', NEW.applied_campaign_revision_id, v_amend.operation;
	END IF;
	IF v_amend.lifecycle_status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Applied campaign revision % is not ACTIVE (found %)', NEW.applied_campaign_revision_id, v_amend.lifecycle_status;
	END IF;
	IF v_amend.source_snapshot_id IS DISTINCT FROM v_candidate.source_snapshot_id THEN
		RAISE EXCEPTION 'Applied campaign revision % source_snapshot_id does not match candidate % source_snapshot_id', NEW.applied_campaign_revision_id, NEW.candidate_id;
	END IF;

	IF v_amend.title IS DISTINCT FROM NEW.title OR
		v_amend.starts_on IS DISTINCT FROM NEW.starts_on OR
		v_amend.ends_on IS DISTINCT FROM NEW.ends_on OR
		v_amend.rule_mode IS DISTINCT FROM NEW.rule_mode OR
		v_amend.target_spend_amount IS DISTINCT FROM NEW.target_spend_amount OR
		v_amend.required_transaction_count IS DISTINCT FROM NEW.required_transaction_count OR
		v_amend.minimum_transaction_amount IS DISTINCT FROM NEW.minimum_transaction_amount OR
		v_amend.step_spend_amount IS DISTINCT FROM NEW.step_spend_amount OR
		v_amend.reward_points_per_step IS DISTINCT FROM NEW.reward_points_per_step OR
		v_amend.max_steps IS DISTINCT FROM NEW.max_steps OR
		v_amend.reward_kind IS DISTINCT FROM NEW.reward_kind OR
		v_amend.reward_account_id IS DISTINCT FROM NEW.reward_account_id OR
		v_amend.expected_reward_points IS DISTINCT FROM NEW.expected_reward_points OR
		v_amend.merchant_scope_mode IS DISTINCT FROM NEW.merchant_scope_mode OR
		v_amend.required_canonical_merchant_names IS DISTINCT FROM NEW.required_canonical_merchant_names OR
		v_amend.allowed_mcc_codes IS DISTINCT FROM NEW.allowed_mcc_codes OR
		v_amend.reward_expiry_date IS DISTINCT FROM NEW.reward_expiry_date OR
		v_amend.parser_type IS DISTINCT FROM NEW.parser_type OR
		v_amend.parser_version IS DISTINCT FROM NEW.parser_version OR
		v_amend.parser_confidence IS DISTINCT FROM NEW.parser_confidence
	THEN
		RAISE EXCEPTION 'Applied campaign revision % terms diverge from candidate APPLY revision % reviewed terms', NEW.applied_campaign_revision_id, NEW.id;
	END IF;

	SELECT array_agg(credit_card_id ORDER BY credit_card_id) INTO v_amend_card_ids
	FROM campaign_period_revision_cards WHERE revision_id = v_amend.id;

	SELECT array_agg((elem)::uuid ORDER BY (elem)::uuid) INTO v_candidate_card_ids
	FROM jsonb_array_elements_text(NEW.proposed_card_ids) AS elem;

	IF v_amend_card_ids IS DISTINCT FROM v_candidate_card_ids THEN
		RAISE EXCEPTION 'Applied campaign revision % card scope diverges from candidate APPLY revision % proposed_card_ids', NEW.applied_campaign_revision_id, NEW.id;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_apply_seal ON "campaign_review_candidate_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_review_candidate_apply_seal
AFTER INSERT ON "campaign_review_candidate_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_apply_seal();