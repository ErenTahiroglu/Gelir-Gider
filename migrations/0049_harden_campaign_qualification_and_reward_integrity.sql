CREATE TABLE "campaign_review_candidate_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"status" varchar(10) NOT NULL,
	"title" varchar(200) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"rule_mode" varchar(24) NOT NULL,
	"target_spend_amount" numeric(18, 2),
	"required_transaction_count" integer,
	"minimum_transaction_amount" numeric(18, 2),
	"step_spend_amount" numeric(18, 2),
	"reward_points_per_step" numeric(20, 4),
	"max_steps" integer,
	"reward_kind" varchar(20) NOT NULL,
	"reward_account_id" uuid,
	"expected_reward_points" numeric(20, 4),
	"merchant_scope_mode" varchar(24) NOT NULL,
	"required_canonical_merchant_names" jsonb,
	"allowed_mcc_codes" jsonb,
	"reward_expiry_date" date,
	"parser_type" varchar(60),
	"parser_version" varchar(40),
	"parser_confidence" numeric(5, 4),
	"proposed_card_ids" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_review_candidate_revisions_rev_no_check" CHECK ("campaign_review_candidate_revisions"."revision_no" > 0),
	CONSTRAINT "campaign_review_candidate_revisions_op_check" CHECK ("campaign_review_candidate_revisions"."operation" IN ('CREATE', 'APPLY', 'DISMISS')),
	CONSTRAINT "campaign_review_candidate_revisions_status_check" CHECK ("campaign_review_candidate_revisions"."status" IN ('PENDING', 'APPLIED', 'DISMISSED')),
	CONSTRAINT "campaign_review_candidate_revisions_title_check" CHECK ("campaign_review_candidate_revisions"."title" = btrim("campaign_review_candidate_revisions"."title") AND length("campaign_review_candidate_revisions"."title") >= 1 AND length("campaign_review_candidate_revisions"."title") <= 200),
	CONSTRAINT "campaign_review_candidate_revisions_date_window_check" CHECK ("campaign_review_candidate_revisions"."starts_on" <= "campaign_review_candidate_revisions"."ends_on"),
	CONSTRAINT "campaign_review_candidate_revisions_rule_mode_check" CHECK ("campaign_review_candidate_revisions"."rule_mode" IN ('TOTAL_SPEND', 'TRANSACTION_COUNT', 'REPEATABLE_SPEND')),
	CONSTRAINT "campaign_review_candidate_revisions_reward_kind_check" CHECK ("campaign_review_candidate_revisions"."reward_kind" IN ('REWARD_POINTS', 'STATEMENT_CREDIT', 'INFORMATIONAL')),
	CONSTRAINT "campaign_review_candidate_revisions_merchant_scope_check" CHECK ("campaign_review_candidate_revisions"."merchant_scope_mode" IN ('ALL_MERCHANTS', 'MERCHANT_ALIASES', 'MANUAL_REVIEW_REQUIRED')),
	CONSTRAINT "campaign_review_candidate_revisions_mcc_shape_check" CHECK ("campaign_review_candidate_revisions"."allowed_mcc_codes" IS NULL OR jsonb_typeof("campaign_review_candidate_revisions"."allowed_mcc_codes") = 'array'),
	CONSTRAINT "campaign_review_candidate_revisions_parser_confidence_check" CHECK ("campaign_review_candidate_revisions"."parser_confidence" IS NULL OR ("campaign_review_candidate_revisions"."parser_confidence" >= 0 AND "campaign_review_candidate_revisions"."parser_confidence" <= 1)),
	CONSTRAINT "campaign_review_candidate_revisions_parser_shape_check" CHECK (("campaign_review_candidate_revisions"."parser_type" IS NULL) = ("campaign_review_candidate_revisions"."parser_version" IS NULL)),
	CONSTRAINT "campaign_review_candidate_revisions_proposed_card_ids_check" CHECK (jsonb_typeof("campaign_review_candidate_revisions"."proposed_card_ids") = 'array'),
	CONSTRAINT "campaign_review_candidate_revisions_fingerprint_check" CHECK ("campaign_review_candidate_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaign_review_candidate_revisions_idempotency_check" CHECK ("campaign_review_candidate_revisions"."idempotency_key" = btrim("campaign_review_candidate_revisions"."idempotency_key") AND length("campaign_review_candidate_revisions"."idempotency_key") >= 1 AND length("campaign_review_candidate_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "campaign_review_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"campaign_period_id" uuid NOT NULL,
	"source_snapshot_id" uuid NOT NULL,
	"candidate_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_review_candidates_hash_check" CHECK ("campaign_review_candidates"."candidate_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_candidate_id_campaign_review_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."campaign_review_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_previous_revision_id_campaign_review_candidate_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."campaign_review_candidate_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidate_revisions" ADD CONSTRAINT "campaign_review_candidate_revisions_reward_account_id_reward_accounts_id_fk" FOREIGN KEY ("reward_account_id") REFERENCES "public"."reward_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidates" ADD CONSTRAINT "campaign_review_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidates" ADD CONSTRAINT "campaign_review_candidates_campaign_period_id_campaign_periods_id_fk" FOREIGN KEY ("campaign_period_id") REFERENCES "public"."campaign_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_review_candidates" ADD CONSTRAINT "campaign_review_candidates_source_snapshot_id_campaign_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."campaign_source_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_review_candidate_revisions_candidate_rev_idx" ON "campaign_review_candidate_revisions" USING btree ("candidate_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_review_candidate_revisions_user_idempotency_idx" ON "campaign_review_candidate_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_review_candidate_revisions_prev_rev_idx" ON "campaign_review_candidate_revisions" USING btree ("previous_revision_id") WHERE "campaign_review_candidate_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_review_candidate_revisions_candidate_idx" ON "campaign_review_candidate_revisions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "campaign_review_candidates_period_idx" ON "campaign_review_candidates" USING btree ("campaign_period_id");--> statement-breakpoint
CREATE INDEX "campaign_review_candidates_user_idx" ON "campaign_review_candidates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_review_candidates_hash_idx" ON "campaign_review_candidates" USING btree ("campaign_period_id","candidate_hash");--> statement-breakpoint

-- ============================================================================
-- PHASE 16-R1: CAMPAIGN QUALIFICATION AND REWARD INTEGRITY HARDENING
--
-- H. Single-active-credit + revision-chain serialization: lock the owning
--    campaign_periods row FOR UPDATE as the very first statement in both
--    trg_fn_guard_campaign_reward_credit_insert and
--    trg_fn_guard_campaign_period_revision_insert.
-- I. Bidirectional CAMPAIGN <-> REWARD companion: a new deferred constraint
--    trigger on reward_event_revisions rejects a CAMPAIGN-sourced EARN/VOID
--    with no matching campaign_reward_credit_revisions companion in the same
--    transaction; trg_fn_guard_campaign_reward_credit_revision_insert now
--    also requires the linked reward event's latest revision to still be
--    CREATE (never already VOID) before binding a fresh active credit.
-- J. Card-scope + source/parser provenance sealing: CONFIRM/HIDE/RESTORE/
--    END/CANCEL freeze source_snapshot_id/parser_type/parser_version/
--    parser_confidence (extends the existing v_unchanged check) and the
--    linked card-companion set (extends the existing deferred card-scope
--    completeness trigger to also compare against the predecessor's set).
-- K. New campaign_review_candidates / campaign_review_candidate_revisions
--    domain: immutability + ownership/chain guard + anchor completeness,
--    mirroring the campaign_purchase_overrides pattern exactly.
-- M. Purchase override revision-chain serialization: lock the owning
--    campaign_purchase_overrides row FOR UPDATE as the very first statement.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- H (part 1). CAMPAIGN PERIOD REVISION CHAIN GUARD: anchor lock + card/source/
-- parser provenance sealing (J)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_period_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_latest RECORD;
	v_reward_account RECORD;
	v_unchanged BOOLEAN;
BEGIN
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match revision user_id %', v_period.user_id, NEW.user_id;
	END IF;

	IF NEW.reward_kind = 'REWARD_POINTS' THEN
		SELECT * INTO v_reward_account FROM reward_accounts WHERE id = NEW.reward_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
		END IF;
		IF v_reward_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reward account user_id % does not match revision user_id %', v_reward_account.user_id, NEW.user_id;
		END IF;
	END IF;

	SELECT id, revision_no, operation, lifecycle_status, visibility, title, starts_on, ends_on,
		rule_mode, target_spend_amount, required_transaction_count, minimum_transaction_amount,
		step_spend_amount, reward_points_per_step, max_steps, reward_kind, reward_account_id,
		expected_reward_points, merchant_scope_mode, required_canonical_merchant_names,
		allowed_mcc_codes, reward_expiry_date, source_snapshot_id, parser_type, parser_version,
		parser_confidence
	INTO v_latest
	FROM campaign_period_revisions
	WHERE campaign_period_id = NEW.campaign_period_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Campaign period % already has revisions; revision 1 cannot be created again', NEW.campaign_period_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.lifecycle_status != 'REVIEW_REQUIRED' THEN
			RAISE EXCEPTION 'First revision must have lifecycle_status REVIEW_REQUIRED, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != 'VISIBLE' THEN
			RAISE EXCEPTION 'First revision must have visibility VISIBLE, found %', NEW.visibility;
		END IF;
		RETURN NEW;
	END IF;

	IF v_latest.id IS NULL THEN
		RAISE EXCEPTION 'No predecessor revision exists for campaign period %', NEW.campaign_period_id;
	END IF;
	IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
		RAISE EXCEPTION 'Previous revision % is not current latest revision % of campaign period % (branching forbidden)',
			NEW.previous_revision_id, v_latest.id, NEW.campaign_period_id;
	END IF;
	IF v_latest.revision_no != (NEW.revision_no - 1) THEN
		RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
	END IF;
	IF v_latest.lifecycle_status = 'CANCELLED' THEN
		RAISE EXCEPTION 'Cannot create revision on CANCELLED campaign period % (CANCELLED is terminal)', NEW.campaign_period_id;
	END IF;

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
		NEW.source_snapshot_id IS NOT DISTINCT FROM v_latest.source_snapshot_id AND
		NEW.parser_type IS NOT DISTINCT FROM v_latest.parser_type AND
		NEW.parser_version IS NOT DISTINCT FROM v_latest.parser_version AND
		NEW.parser_confidence IS NOT DISTINCT FROM v_latest.parser_confidence
	);

	IF NEW.operation = 'CREATE' THEN
		RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
	ELSIF NEW.operation = 'CONFIRM' THEN
		IF v_latest.lifecycle_status != 'REVIEW_REQUIRED' THEN
			RAISE EXCEPTION 'CONFIRM requires lifecycle_status REVIEW_REQUIRED, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'CONFIRM must set lifecycle_status ACTIVE, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'CONFIRM must not change visibility';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'CONFIRM must not change economic/rule/reward/merchant-scope/source/parser terms; use AMEND instead';
		END IF;
	ELSIF NEW.operation = 'AMEND' THEN
		IF v_latest.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'AMEND requires lifecycle_status ACTIVE, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'AMEND must keep lifecycle_status ACTIVE, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'AMEND must not change visibility; use HIDE/RESTORE instead';
		END IF;
	ELSIF NEW.operation = 'HIDE' THEN
		IF v_latest.visibility != 'VISIBLE' THEN
			RAISE EXCEPTION 'HIDE requires visibility VISIBLE, found %', v_latest.visibility;
		END IF;
		IF NEW.visibility != 'HIDDEN' THEN
			RAISE EXCEPTION 'HIDE must set visibility HIDDEN, found %', NEW.visibility;
		END IF;
		IF NEW.lifecycle_status != v_latest.lifecycle_status THEN
			RAISE EXCEPTION 'HIDE must not change lifecycle_status';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'HIDE must not change economic/rule/reward/merchant-scope/source/parser terms';
		END IF;
	ELSIF NEW.operation = 'RESTORE' THEN
		IF v_latest.visibility != 'HIDDEN' THEN
			RAISE EXCEPTION 'RESTORE requires visibility HIDDEN, found %', v_latest.visibility;
		END IF;
		IF NEW.visibility != 'VISIBLE' THEN
			RAISE EXCEPTION 'RESTORE must set visibility VISIBLE, found %', NEW.visibility;
		END IF;
		IF NEW.lifecycle_status != v_latest.lifecycle_status THEN
			RAISE EXCEPTION 'RESTORE must not change lifecycle_status';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'RESTORE must not change economic/rule/reward/merchant-scope/source/parser terms';
		END IF;
	ELSIF NEW.operation = 'END' THEN
		IF v_latest.lifecycle_status != 'ACTIVE' THEN
			RAISE EXCEPTION 'END requires lifecycle_status ACTIVE, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'ENDED' THEN
			RAISE EXCEPTION 'END must set lifecycle_status ENDED, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'END must not change visibility';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'END must not change economic/rule/reward/merchant-scope/source/parser terms';
		END IF;
	ELSIF NEW.operation = 'CANCEL' THEN
		IF v_latest.lifecycle_status NOT IN ('REVIEW_REQUIRED', 'ACTIVE') THEN
			RAISE EXCEPTION 'CANCEL requires lifecycle_status REVIEW_REQUIRED or ACTIVE, found %', v_latest.lifecycle_status;
		END IF;
		IF NEW.lifecycle_status != 'CANCELLED' THEN
			RAISE EXCEPTION 'CANCEL must set lifecycle_status CANCELLED, found %', NEW.lifecycle_status;
		END IF;
		IF NEW.visibility != v_latest.visibility THEN
			RAISE EXCEPTION 'CANCEL must not change visibility';
		END IF;
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'CANCEL must not change economic/rule/reward/merchant-scope/source/parser terms';
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown campaign period revision operation %', NEW.operation;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_period_revision_insert ON "campaign_period_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_period_revision_insert
BEFORE INSERT ON "campaign_period_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_period_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- J (part 2). CARD-SCOPE COPY-FORWARD SEALING (extends the existing deferred
-- completeness trigger to also compare the new revision's card companion set
-- against its predecessor's for lifecycle-only operations).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_period_card_scope_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_card_count INT;
	v_new_card_ids UUID[];
	v_prev_card_ids UUID[];
BEGIN
	IF NEW.lifecycle_status IN ('ACTIVE', 'ENDED') THEN
		SELECT count(*) INTO v_card_count FROM campaign_period_revision_cards WHERE revision_id = NEW.id;
		IF v_card_count = 0 THEN
			RAISE EXCEPTION 'Campaign period revision % is % but has zero linked cards at commit', NEW.id, NEW.lifecycle_status;
		END IF;
	END IF;

	IF NEW.operation IN ('CONFIRM', 'HIDE', 'RESTORE', 'END', 'CANCEL') AND NEW.previous_revision_id IS NOT NULL THEN
		SELECT COALESCE(array_agg(credit_card_id ORDER BY credit_card_id), ARRAY[]::UUID[])
		INTO v_new_card_ids
		FROM campaign_period_revision_cards WHERE revision_id = NEW.id;

		SELECT COALESCE(array_agg(credit_card_id ORDER BY credit_card_id), ARRAY[]::UUID[])
		INTO v_prev_card_ids
		FROM campaign_period_revision_cards WHERE revision_id = NEW.previous_revision_id;

		IF v_new_card_ids IS DISTINCT FROM v_prev_card_ids THEN
			RAISE EXCEPTION 'Campaign period revision % (%) must not change the bound card set relative to its predecessor (naked card-scope drift)', NEW.id, NEW.operation;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_period_card_scope_completeness ON "campaign_period_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_period_card_scope_completeness
AFTER INSERT ON "campaign_period_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_period_card_scope_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- H (part 2). SINGLE-ACTIVE-CREDIT SERIALIZATION: lock the owning
-- campaign_periods row FOR UPDATE as the very first statement.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_reward_credit_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_reward_account RECORD;
	v_latest_period_rev RECORD;
	v_existing RECORD;
	v_existing_latest RECORD;
BEGIN
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match credit user_id %', v_period.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_reward_account FROM reward_accounts WHERE id = NEW.reward_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
	END IF;
	IF v_reward_account.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward account user_id % does not match credit user_id %', v_reward_account.user_id, NEW.user_id;
	END IF;

	SELECT lifecycle_status, reward_kind, reward_account_id INTO v_latest_period_rev
	FROM campaign_period_revisions
	WHERE campaign_period_id = NEW.campaign_period_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_period_rev IS NULL THEN
		RAISE EXCEPTION 'Campaign period % has no revisions', NEW.campaign_period_id;
	END IF;
	IF v_latest_period_rev.lifecycle_status NOT IN ('ACTIVE', 'ENDED') THEN
		RAISE EXCEPTION 'Campaign period % is not ACTIVE/ENDED (found %)', NEW.campaign_period_id, v_latest_period_rev.lifecycle_status;
	END IF;
	IF v_latest_period_rev.reward_kind != 'REWARD_POINTS' THEN
		RAISE EXCEPTION 'Campaign period % reward_kind is not REWARD_POINTS (found %)', NEW.campaign_period_id, v_latest_period_rev.reward_kind;
	END IF;
	IF v_latest_period_rev.reward_account_id != NEW.reward_account_id THEN
		RAISE EXCEPTION 'Campaign period % is bound to reward account % not %', NEW.campaign_period_id, v_latest_period_rev.reward_account_id, NEW.reward_account_id;
	END IF;

	FOR v_existing IN
		SELECT id FROM campaign_reward_credits WHERE campaign_period_id = NEW.campaign_period_id AND id != NEW.id
	LOOP
		SELECT operation INTO v_existing_latest
		FROM campaign_reward_credit_revisions
		WHERE credit_id = v_existing.id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF v_existing_latest.operation IS DISTINCT FROM 'VOID' THEN
			RAISE EXCEPTION 'Campaign period % already has an ACTIVE reward credit identity %', NEW.campaign_period_id, v_existing.id;
		END IF;
	END LOOP;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_reward_credit_insert ON "campaign_reward_credits";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_reward_credit_insert
BEFORE INSERT ON "campaign_reward_credits"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_reward_credit_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- I (part 1). CAMPAIGN REWARD CREDIT REVISION INSERT: additionally require the
-- linked reward event's latest revision to still be CREATE (not already VOID)
-- before binding a fresh active credit.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_reward_credit_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_credit RECORD;
	v_latest RECORD;
	v_reward_event RECORD;
	v_reward_event_rev RECORD;
BEGIN
	SELECT * INTO v_credit FROM campaign_reward_credits WHERE id = NEW.credit_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign reward credit % not found', NEW.credit_id;
	END IF;
	IF v_credit.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Credit user_id % does not match revision user_id %', v_credit.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, operation, reward_event_id, actual_point_amount, expected_point_amount
	INTO v_latest
	FROM campaign_reward_credit_revisions
	WHERE credit_id = NEW.credit_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Credit % already has revisions; revision 1 cannot be created again', NEW.credit_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;

		SELECT * INTO v_reward_event FROM reward_events WHERE id = NEW.reward_event_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward event % not found', NEW.reward_event_id;
		END IF;
		IF v_reward_event.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reward event user_id % does not match revision user_id %', v_reward_event.user_id, NEW.user_id;
		END IF;
		IF v_reward_event.reward_account_id != v_credit.reward_account_id THEN
			RAISE EXCEPTION 'Reward event % reward_account_id % does not match credit reward_account_id %',
				NEW.reward_event_id, v_reward_event.reward_account_id, v_credit.reward_account_id;
		END IF;
		IF v_reward_event.event_type != 'EARN' THEN
			RAISE EXCEPTION 'Reward event % must have event_type EARN, found %', NEW.reward_event_id, v_reward_event.event_type;
		END IF;

		SELECT * INTO v_reward_event_rev
		FROM reward_event_revisions
		WHERE reward_event_id = NEW.reward_event_id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward event % has no revisions', NEW.reward_event_id;
		END IF;
		IF v_reward_event_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Reward event % latest revision must be CREATE (not already VOID) to bind a fresh active campaign credit', NEW.reward_event_id;
		END IF;
		IF v_reward_event_rev.source_type != 'CAMPAIGN' THEN
			RAISE EXCEPTION 'Reward event % source_type must be CAMPAIGN, found %', NEW.reward_event_id, v_reward_event_rev.source_type;
		END IF;
		IF v_reward_event_rev.source_ref IS DISTINCT FROM v_credit.campaign_period_id::text THEN
			RAISE EXCEPTION 'Reward event % source_ref % does not match campaign_period_id %',
				NEW.reward_event_id, v_reward_event_rev.source_ref, v_credit.campaign_period_id;
		END IF;
		IF v_reward_event_rev.point_amount != NEW.actual_point_amount THEN
			RAISE EXCEPTION 'Reward event % point_amount % does not match actual_point_amount %',
				NEW.reward_event_id, v_reward_event_rev.point_amount, NEW.actual_point_amount;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for credit %', NEW.credit_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of credit % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.credit_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID credit % (VOID is terminal)', NEW.credit_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID is permitted as a subsequent credit revision, found %', NEW.operation;
		END IF;
		IF NEW.reward_event_id != v_latest.reward_event_id THEN
			RAISE EXCEPTION 'VOID revision must reference the same reward_event_id %', v_latest.reward_event_id;
		END IF;
		IF NEW.actual_point_amount != v_latest.actual_point_amount THEN
			RAISE EXCEPTION 'VOID revision must keep the same actual_point_amount %', v_latest.actual_point_amount;
		END IF;
		IF NEW.expected_point_amount IS DISTINCT FROM v_latest.expected_point_amount THEN
			RAISE EXCEPTION 'VOID revision must keep the same expected_point_amount';
		END IF;

		SELECT operation INTO v_reward_event_rev
		FROM reward_event_revisions
		WHERE reward_event_id = NEW.reward_event_id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF v_reward_event_rev.operation IS DISTINCT FROM 'VOID' THEN
			RAISE EXCEPTION 'Reward event % must already be VOID before recording campaign credit VOID', NEW.reward_event_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_reward_credit_revision_insert ON "campaign_reward_credit_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_reward_credit_revision_insert
BEFORE INSERT ON "campaign_reward_credit_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_reward_credit_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- I (part 2). BIDIRECTIONAL CAMPAIGN <-> REWARD COMPANION (REWARD -> CAMPAIGN
-- direction). Deferred constraint trigger on reward_event_revisions rejects a
-- CAMPAIGN-sourced EARN CREATE/VOID with no matching campaign-side companion
-- committed in the same transaction. Immediately returns for every
-- non-CAMPAIGN-sourced or non-EARN row (zero interference with MANUAL flows).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_event_revision_campaign_companion()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_credit_rev RECORD;
BEGIN
	SELECT * INTO v_event FROM reward_events WHERE id = NEW.reward_event_id;
	IF v_event.event_type != 'EARN' OR NEW.source_type != 'CAMPAIGN' THEN
		RETURN NULL;
	END IF;

	IF NEW.operation = 'CREATE' THEN
		SELECT crr.* INTO v_credit_rev
		FROM campaign_reward_credit_revisions crr
		JOIN campaign_reward_credits crc ON crc.id = crr.credit_id
		WHERE crr.reward_event_id = NEW.reward_event_id
			AND crr.operation = 'CREATE'
			AND crc.campaign_period_id::text = NEW.source_ref
			AND crr.actual_point_amount = NEW.point_amount
			AND crc.user_id = NEW.user_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'CAMPAIGN-sourced reward EARN % has no matching campaign_reward_credit_revisions CREATE companion', NEW.reward_event_id;
		END IF;
	ELSIF NEW.operation = 'VOID' THEN
		SELECT crr.* INTO v_credit_rev
		FROM campaign_reward_credit_revisions crr
		WHERE crr.reward_event_id = NEW.reward_event_id
		ORDER BY crr.revision_no DESC LIMIT 1;
		IF NOT FOUND OR v_credit_rev.operation != 'VOID' THEN
			RAISE EXCEPTION 'CAMPAIGN-sourced reward EARN % VOID has no matching campaign_reward_credit VOID companion', NEW.reward_event_id;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_event_revision_campaign_companion ON "reward_event_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_reward_event_revision_campaign_companion
AFTER INSERT ON "reward_event_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_event_revision_campaign_companion();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- M. PURCHASE OVERRIDE REVISION CHAIN SERIALIZATION: lock the owning
-- campaign_purchase_overrides row FOR UPDATE as the very first statement.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_purchase_override_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_override RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_override FROM campaign_purchase_overrides WHERE id = NEW.override_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign purchase override % not found', NEW.override_id;
	END IF;
	IF v_override.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Override user_id % does not match revision user_id %', v_override.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no INTO v_latest
	FROM campaign_purchase_override_revisions
	WHERE override_id = NEW.override_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Override % already has revisions; revision 1 cannot be created again', NEW.override_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for override %', NEW.override_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of override % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.override_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_purchase_override_revision_insert ON "campaign_purchase_override_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_purchase_override_revision_insert
BEFORE INSERT ON "campaign_purchase_override_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_purchase_override_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- K. CAMPAIGN REVIEW CANDIDATES DOMAIN INTEGRITY (mirrors the
-- campaign_purchase_overrides pattern exactly): immutability, ownership +
-- chain guard, anchor completeness.
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_review_candidates ON "campaign_review_candidates";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_review_candidates
BEFORE UPDATE OR DELETE ON "campaign_review_candidates"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_campaign_review_candidate_revisions ON "campaign_review_candidate_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_campaign_review_candidate_revisions
BEFORE UPDATE OR DELETE ON "campaign_review_candidate_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_campaigns();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_period RECORD;
	v_snapshot RECORD;
BEGIN
	SELECT * INTO v_period FROM campaign_periods WHERE id = NEW.campaign_period_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign period % not found', NEW.campaign_period_id;
	END IF;
	IF v_period.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Campaign period user_id % does not match candidate user_id %', v_period.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_snapshot FROM campaign_source_snapshots WHERE id = NEW.source_snapshot_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign source snapshot % not found', NEW.source_snapshot_id;
	END IF;
	IF v_snapshot.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Source snapshot user_id % does not match candidate user_id %', v_snapshot.user_id, NEW.user_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_insert ON "campaign_review_candidates";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_review_candidate_insert
BEFORE INSERT ON "campaign_review_candidates"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_candidate RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_candidate FROM campaign_review_candidates WHERE id = NEW.candidate_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign review candidate % not found', NEW.candidate_id;
	END IF;
	IF v_candidate.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Candidate user_id % does not match revision user_id %', v_candidate.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, status INTO v_latest
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
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_revision_insert ON "campaign_review_candidate_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_campaign_review_candidate_revision_insert
BEFORE INSERT ON "campaign_review_candidate_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_revision_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT EXISTS(SELECT 1 FROM campaign_review_candidate_revisions WHERE candidate_id = NEW.id) INTO v_found;
	IF NOT v_found THEN
		RAISE EXCEPTION 'Campaign review candidate % has no revisions at commit (naked candidate anchor)', NEW.id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_campaign_review_candidate_anchor_completeness ON "campaign_review_candidates";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_campaign_review_candidate_anchor_completeness
AFTER INSERT ON "campaign_review_candidates"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_campaign_review_candidate_anchor_completeness();
