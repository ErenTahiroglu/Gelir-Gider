CREATE TABLE "reward_account_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reward_account_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"provider" varchar(120) NOT NULL,
	"unit_name" varchar(40) NOT NULL,
	"default_conversion_rate" numeric(18, 6) NOT NULL,
	"note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_account_revisions_rev_no_check" CHECK ("reward_account_revisions"."revision_no" > 0),
	CONSTRAINT "reward_account_revisions_op_check" CHECK ("reward_account_revisions"."operation" IN ('CREATE', 'UPDATE', 'ARCHIVE')),
	CONSTRAINT "reward_account_revisions_status_check" CHECK ("reward_account_revisions"."status" IN ('ACTIVE', 'ARCHIVED')),
	CONSTRAINT "reward_account_revisions_display_name_check" CHECK ("reward_account_revisions"."display_name" = btrim("reward_account_revisions"."display_name") AND length("reward_account_revisions"."display_name") >= 1 AND length("reward_account_revisions"."display_name") <= 120),
	CONSTRAINT "reward_account_revisions_provider_check" CHECK ("reward_account_revisions"."provider" = btrim("reward_account_revisions"."provider") AND length("reward_account_revisions"."provider") >= 1 AND length("reward_account_revisions"."provider") <= 120),
	CONSTRAINT "reward_account_revisions_unit_name_check" CHECK ("reward_account_revisions"."unit_name" = btrim("reward_account_revisions"."unit_name") AND length("reward_account_revisions"."unit_name") >= 1 AND length("reward_account_revisions"."unit_name") <= 40),
	CONSTRAINT "reward_account_revisions_rate_check" CHECK ("reward_account_revisions"."default_conversion_rate" > 0),
	CONSTRAINT "reward_account_revisions_note_check" CHECK ("reward_account_revisions"."note" IS NULL OR ("reward_account_revisions"."note" = btrim("reward_account_revisions"."note") AND length("reward_account_revisions"."note") >= 1 AND length("reward_account_revisions"."note") <= 500)),
	CONSTRAINT "reward_account_revisions_fingerprint_check" CHECK ("reward_account_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reward_account_revisions_idempotency_check" CHECK ("reward_account_revisions"."idempotency_key" = btrim("reward_account_revisions"."idempotency_key") AND length("reward_account_revisions"."idempotency_key") >= 1 AND length("reward_account_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "reward_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"credit_card_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_accounts_code_check" CHECK ("reward_accounts"."code" ~ '^[A-Z][A-Z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "reward_event_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reward_event_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(20) NOT NULL,
	"point_amount" numeric(20, 4) NOT NULL,
	"conversion_rate" numeric(18, 6) NOT NULL,
	"economic_amount" numeric(18, 2),
	"purchase_category" varchar(32),
	"short_term_goal_id" uuid,
	"merchant" varchar(200),
	"description" varchar(500),
	"reason_note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"canonical_revision_id" uuid,
	"source_type" varchar(20) DEFAULT 'MANUAL' NOT NULL,
	"source_ref" varchar(128),
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_event_revisions_rev_no_check" CHECK ("reward_event_revisions"."revision_no" > 0),
	CONSTRAINT "reward_event_revisions_op_check" CHECK ("reward_event_revisions"."operation" IN ('CREATE', 'VOID')),
	CONSTRAINT "reward_event_revisions_point_amount_check" CHECK ("reward_event_revisions"."point_amount" > 0),
	CONSTRAINT "reward_event_revisions_rate_check" CHECK ("reward_event_revisions"."conversion_rate" > 0),
	CONSTRAINT "reward_event_revisions_economic_amount_check" CHECK ("reward_event_revisions"."economic_amount" IS NULL OR "reward_event_revisions"."economic_amount" > 0),
	CONSTRAINT "reward_event_revisions_category_check" CHECK ("reward_event_revisions"."purchase_category" IS NULL OR "reward_event_revisions"."purchase_category" IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED')),
	CONSTRAINT "reward_event_revisions_merchant_check" CHECK ("reward_event_revisions"."merchant" IS NULL OR ("reward_event_revisions"."merchant" = btrim("reward_event_revisions"."merchant") AND length("reward_event_revisions"."merchant") >= 1 AND length("reward_event_revisions"."merchant") <= 200)),
	CONSTRAINT "reward_event_revisions_description_check" CHECK ("reward_event_revisions"."description" IS NULL OR ("reward_event_revisions"."description" = btrim("reward_event_revisions"."description") AND length("reward_event_revisions"."description") >= 1 AND length("reward_event_revisions"."description") <= 500)),
	CONSTRAINT "reward_event_revisions_reason_note_check" CHECK ("reward_event_revisions"."reason_note" IS NULL OR ("reward_event_revisions"."reason_note" = btrim("reward_event_revisions"."reason_note") AND length("reward_event_revisions"."reason_note") >= 1 AND length("reward_event_revisions"."reason_note") <= 500)),
	CONSTRAINT "reward_event_revisions_source_type_check" CHECK ("reward_event_revisions"."source_type" IN ('MANUAL', 'CAMPAIGN', 'IMPORT')),
	CONSTRAINT "reward_event_revisions_source_ref_check" CHECK ("reward_event_revisions"."source_ref" IS NULL OR ("reward_event_revisions"."source_ref" = btrim("reward_event_revisions"."source_ref") AND length("reward_event_revisions"."source_ref") >= 1 AND length("reward_event_revisions"."source_ref") <= 128)),
	CONSTRAINT "reward_event_revisions_fingerprint_check" CHECK ("reward_event_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reward_event_revisions_idempotency_check" CHECK ("reward_event_revisions"."idempotency_key" = btrim("reward_event_revisions"."idempotency_key") AND length("reward_event_revisions"."idempotency_key") >= 1 AND length("reward_event_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "reward_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reward_account_id" uuid NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"canonical_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_events_type_check" CHECK ("reward_events"."event_type" IN ('OPENING_BALANCE', 'EARN', 'EXPIRE', 'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT', 'REDEEM_PURCHASE')),
	CONSTRAINT "reward_events_canonical_binding_check" CHECK (("reward_events"."event_type" = 'REDEEM_PURCHASE' AND "reward_events"."canonical_transaction_id" IS NOT NULL) OR ("reward_events"."event_type" != 'REDEEM_PURCHASE' AND "reward_events"."canonical_transaction_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "reward_account_revisions" ADD CONSTRAINT "reward_account_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_account_revisions" ADD CONSTRAINT "reward_account_revisions_reward_account_id_reward_accounts_id_fk" FOREIGN KEY ("reward_account_id") REFERENCES "public"."reward_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_account_revisions" ADD CONSTRAINT "reward_account_revisions_previous_revision_id_reward_account_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."reward_account_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_accounts" ADD CONSTRAINT "reward_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_accounts" ADD CONSTRAINT "reward_accounts_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_event_revisions" ADD CONSTRAINT "reward_event_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_event_revisions" ADD CONSTRAINT "reward_event_revisions_reward_event_id_reward_events_id_fk" FOREIGN KEY ("reward_event_id") REFERENCES "public"."reward_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_event_revisions" ADD CONSTRAINT "reward_event_revisions_previous_revision_id_reward_event_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."reward_event_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_event_revisions" ADD CONSTRAINT "reward_event_revisions_short_term_goal_id_short_term_goals_id_fk" FOREIGN KEY ("short_term_goal_id") REFERENCES "public"."short_term_goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_event_revisions" ADD CONSTRAINT "reward_event_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_reward_account_id_reward_accounts_id_fk" FOREIGN KEY ("reward_account_id") REFERENCES "public"."reward_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_account_revisions_account_rev_idx" ON "reward_account_revisions" USING btree ("reward_account_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_account_revisions_user_idempotency_idx" ON "reward_account_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_account_revisions_prev_rev_idx" ON "reward_account_revisions" USING btree ("previous_revision_id") WHERE "reward_account_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reward_account_revisions_account_idx" ON "reward_account_revisions" USING btree ("reward_account_id");--> statement-breakpoint
CREATE INDEX "reward_account_revisions_user_idx" ON "reward_account_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_accounts_user_code_idx" ON "reward_accounts" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX "reward_accounts_user_idx" ON "reward_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reward_accounts_card_idx" ON "reward_accounts" USING btree ("credit_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_event_revisions_event_rev_idx" ON "reward_event_revisions" USING btree ("reward_event_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_event_revisions_user_idempotency_idx" ON "reward_event_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_event_revisions_prev_rev_idx" ON "reward_event_revisions" USING btree ("previous_revision_id") WHERE "reward_event_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reward_event_revisions_event_idx" ON "reward_event_revisions" USING btree ("reward_event_id");--> statement-breakpoint
CREATE INDEX "reward_event_revisions_user_idx" ON "reward_event_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_events_canonical_tx_idx" ON "reward_events" USING btree ("canonical_transaction_id") WHERE "reward_events"."canonical_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_events_account_opening_idx" ON "reward_events" USING btree ("reward_account_id") WHERE "reward_events"."event_type" = 'OPENING_BALANCE';--> statement-breakpoint
CREATE INDEX "reward_events_account_idx" ON "reward_events" USING btree ("reward_account_id");--> statement-breakpoint
CREATE INDEX "reward_events_user_idx" ON "reward_events" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- PHASE 12: REWARDS DOMAIN INTEGRITY
--
-- A. Immutability (INSERT-only) on all four reward tables.
-- B. Reward account revision chain + status lifecycle guard (BEFORE INSERT).
-- C. Reward event revision chain + non-economic/redemption field consistency
--    + exact canonical/ledger binding proof (BEFORE INSERT).
-- D. Anchor completeness (naked account/event anchor rejected at commit).
-- E. Point balance non-negativity + archive-zero-balance gate (deferred,
--    order-independent across account revisions and event revisions).
-- F. Canonical REWARD_FUNDED_PURCHASE anchor completeness (no orphan
--    canonical transaction without a companion reward event).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_rewards()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is immutable (INSERT-only)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_reward_accounts ON "reward_accounts";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_reward_accounts
BEFORE UPDATE OR DELETE ON "reward_accounts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_rewards();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_reward_account_revisions ON "reward_account_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_reward_account_revisions
BEFORE UPDATE OR DELETE ON "reward_account_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_rewards();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_reward_events ON "reward_events";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_reward_events
BEFORE UPDATE OR DELETE ON "reward_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_rewards();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_reward_event_revisions ON "reward_event_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_reward_event_revisions
BEFORE UPDATE OR DELETE ON "reward_event_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_rewards();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. REWARD ACCOUNT REVISION CHAIN + STATUS LIFECYCLE
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_account_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_account RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_account FROM reward_accounts WHERE id = NEW.reward_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
	END IF;
	IF v_account.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward account user_id % does not match revision user_id %', v_account.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, operation, status
	INTO v_latest
	FROM reward_account_revisions
	WHERE reward_account_id = NEW.reward_account_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Reward account % already has revisions; revision 1 cannot be created again', NEW.reward_account_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'First revision must have status ACTIVE, found %', NEW.status;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for reward account %', NEW.reward_account_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of reward account % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.reward_account_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'ARCHIVE' THEN
			RAISE EXCEPTION 'Cannot create revision on ARCHIVED reward account % (ARCHIVE is terminal)', NEW.reward_account_id;
		END IF;
		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
		IF NEW.operation = 'UPDATE' AND NEW.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'UPDATE revision must keep status ACTIVE, found %', NEW.status;
		END IF;
		IF NEW.operation = 'ARCHIVE' AND NEW.status != 'ARCHIVED' THEN
			RAISE EXCEPTION 'ARCHIVE revision must set status ARCHIVED, found %', NEW.status;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_account_revision_insert ON "reward_account_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_reward_account_revision_insert
BEFORE INSERT ON "reward_account_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_account_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- C. REWARD EVENT REVISION CHAIN + NON-ECONOMIC/REDEMPTION CONSISTENCY +
--    EXACT CANONICAL/LEDGER BINDING PROOF
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_account RECORD;
	v_latest_account_status TEXT;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_expected_role TEXT;
	v_expense_account_id UUID;
	v_reward_benefit_account_id UUID;
	v_line_count INT;
	v_debit_line RECORD;
	v_credit_line RECORD;
BEGIN
	SELECT * INTO v_event FROM reward_events WHERE id = NEW.reward_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward event % not found', NEW.reward_event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward event user_id % does not match revision user_id %', v_event.user_id, NEW.user_id;
	END IF;

	-- Lock the owning reward account and require it ACTIVE for any FRESH
	-- mutation (a historical exact-idempotent replay never reaches this
	-- trigger, since the service layer returns the replay without inserting).
	SELECT * INTO v_account FROM reward_accounts WHERE id = v_event.reward_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found for event %', v_event.reward_account_id, NEW.reward_event_id;
	END IF;

	SELECT status INTO v_latest_account_status
	FROM reward_account_revisions
	WHERE reward_account_id = v_account.id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_account_status IS DISTINCT FROM 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot mutate reward event for non-ACTIVE reward account %', v_account.id;
	END IF;

	-- Chain integrity: revision #1 must be CREATE; the only other permitted
	-- operation is a single terminal VOID (no UPDATE in V1).
	SELECT id, revision_no, operation
	INTO v_latest
	FROM reward_event_revisions
	WHERE reward_event_id = NEW.reward_event_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Reward event % already has revisions; revision 1 cannot be created again', NEW.reward_event_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for reward event %', NEW.reward_event_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of reward event % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.reward_event_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID reward event % (VOID is terminal)', NEW.reward_event_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID is permitted as a subsequent reward event revision, found %', NEW.operation;
		END IF;
	END IF;

	-- Non-economic vs redemption field consistency, per event_type.
	IF v_event.event_type != 'REDEEM_PURCHASE' THEN
		IF NEW.economic_amount IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have economic_amount NULL', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have purchase_category NULL', NEW.reward_event_id;
		END IF;
		IF NEW.short_term_goal_id IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have short_term_goal_id NULL', NEW.reward_event_id;
		END IF;
		IF NEW.canonical_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have canonical_revision_id NULL', NEW.reward_event_id;
		END IF;
	ELSE
		IF NEW.economic_amount IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires economic_amount', NEW.reward_event_id;
		END IF;
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires canonical_revision_id', NEW.reward_event_id;
		END IF;

		-- Exact canonical revision binding.
		SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_can_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical revision user_id % does not match reward event revision user_id %', v_can_rev.user_id, NEW.user_id;
		END IF;
		IF v_can_rev.transaction_id != v_event.canonical_transaction_id THEN
			RAISE EXCEPTION 'Canonical revision transaction_id % does not match reward event canonical_transaction_id %',
				v_can_rev.transaction_id, v_event.canonical_transaction_id;
		END IF;
		IF v_can_rev.operation != NEW.operation THEN
			RAISE EXCEPTION 'Canonical revision operation % does not match reward event revision operation %',
				v_can_rev.operation, NEW.operation;
		END IF;
		IF v_can_rev.occurred_at != NEW.occurred_at THEN
			RAISE EXCEPTION 'Canonical revision occurred_at % does not match reward event revision occurred_at %',
				v_can_rev.occurred_at, NEW.occurred_at;
		END IF;

		SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
		END IF;
		IF v_can_tx.kind != 'REWARD_FUNDED_PURCHASE' THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % canonical transaction % has wrong kind %',
				NEW.reward_event_id, v_can_tx.id, v_can_tx.kind;
		END IF;

		-- Exact canonical payload binding: whitelist + exact values.
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in REWARD_FUNDED_PURCHASE canonical payload', v_invalid_key;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'rewardEventId') != 'string' OR
		   v_can_rev.payload->>'rewardEventId' != NEW.reward_event_id::text THEN
			RAISE EXCEPTION 'Canonical payload rewardEventId % does not match reward event %',
				v_can_rev.payload->>'rewardEventId', NEW.reward_event_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'rewardAccountId') != 'string' OR
		   v_can_rev.payload->>'rewardAccountId' != v_event.reward_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload rewardAccountId % does not match reward account %',
				v_can_rev.payload->>'rewardAccountId', v_event.reward_account_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'points') != 'string' OR
		   v_can_rev.payload->>'points' != NEW.point_amount::text THEN
			RAISE EXCEPTION 'Canonical payload points % does not match revision point_amount %',
				v_can_rev.payload->>'points', NEW.point_amount;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'conversionRate') != 'string' OR
		   v_can_rev.payload->>'conversionRate' != NEW.conversion_rate::text THEN
			RAISE EXCEPTION 'Canonical payload conversionRate % does not match revision conversion_rate %',
				v_can_rev.payload->>'conversionRate', NEW.conversion_rate;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'economicAmount') != 'string' OR
		   v_can_rev.payload->>'economicAmount' != NEW.economic_amount::text THEN
			RAISE EXCEPTION 'Canonical payload economicAmount % does not match revision economic_amount %',
				v_can_rev.payload->>'economicAmount', NEW.economic_amount;
		END IF;

		IF NEW.purchase_category IS NULL THEN
			IF v_can_rev.payload->'purchaseCategory' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload purchaseCategory must be null when revision purchase_category is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'string' OR
			   v_can_rev.payload->>'purchaseCategory' != NEW.purchase_category THEN
				RAISE EXCEPTION 'Canonical payload purchaseCategory % does not match revision purchase_category %',
					v_can_rev.payload->>'purchaseCategory', NEW.purchase_category;
			END IF;
		END IF;

		IF NEW.short_term_goal_id IS NULL THEN
			IF v_can_rev.payload->'shortTermGoalId' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload shortTermGoalId must be null when revision short_term_goal_id is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'string' OR
			   v_can_rev.payload->>'shortTermGoalId' != NEW.short_term_goal_id::text THEN
				RAISE EXCEPTION 'Canonical payload shortTermGoalId % does not match revision short_term_goal_id %',
					v_can_rev.payload->>'shortTermGoalId', NEW.short_term_goal_id;
			END IF;
		END IF;

		IF NEW.merchant IS NULL THEN
			IF v_can_rev.payload->'merchant' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload merchant must be null when revision merchant is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'merchant') != 'string' OR
			   v_can_rev.payload->>'merchant' != NEW.merchant THEN
				RAISE EXCEPTION 'Canonical payload merchant % does not match revision merchant %',
					v_can_rev.payload->>'merchant', NEW.merchant;
			END IF;
		END IF;

		IF NEW.description IS NULL THEN
			IF v_can_rev.payload->'description' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload description must be null when revision description is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'description') != 'string' OR
			   v_can_rev.payload->>'description' != NEW.description THEN
				RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
					v_can_rev.payload->>'description', NEW.description;
			END IF;
		END IF;

		-- Exact ledger binding: for a fresh CREATE, the applied journal must
		-- contain EXACTLY two lines -- Dr the authoritative system expense
		-- account for purchase_category, Cr the REWARD_BENEFIT account --
		-- each for exactly economic_amount. No third line, no ASSET/
		-- CREDIT_CARD_LIABILITY/MIDAS/person account may ever appear.
		IF NEW.operation = 'CREATE' THEN
			v_expected_role := CASE COALESCE(NEW.purchase_category, 'UNCLASSIFIED')
				WHEN 'MANDATORY_EXPENSE' THEN 'MANDATORY_EXPENSE'
				WHEN 'DISCRETIONARY_SPEND' THEN 'DISCRETIONARY_EXPENSE'
				WHEN 'SHORT_TERM_PURCHASE' THEN 'SHORT_TERM_PURCHASE'
				WHEN 'UNCLASSIFIED' THEN 'UNCLASSIFIED_EXPENSE'
				ELSE NULL
			END;
			IF v_expected_role IS NULL THEN
				RAISE EXCEPTION 'Reward purchase has unknown purchase_category %', NEW.purchase_category;
			END IF;

			SELECT ledger_account_id INTO v_expense_account_id
			FROM credit_card_system_accounts WHERE user_id = NEW.user_id AND role = v_expected_role;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No system expense account provisioned for role % (user %)', v_expected_role, NEW.user_id;
			END IF;

			SELECT id INTO v_reward_benefit_account_id
			FROM ledger_accounts WHERE user_id = NEW.user_id AND code = 'SYS_REWARD_BENEFIT';
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No REWARD_BENEFIT system account provisioned (user %)', NEW.user_id;
			END IF;

			SELECT count(*) INTO v_line_count
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id;

			IF v_line_count != 2 THEN
				RAISE EXCEPTION 'Reward purchase % applied journal must have exactly 2 lines, found %',
					NEW.reward_event_id, v_line_count;
			END IF;

			SELECT jl.* INTO v_debit_line
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.debit > 0;

			SELECT jl.* INTO v_credit_line
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.credit > 0;

			IF v_debit_line IS NULL OR v_credit_line IS NULL THEN
				RAISE EXCEPTION 'Reward purchase % applied journal must have exactly one debit line and one credit line', NEW.reward_event_id;
			END IF;
			IF v_debit_line.account_id != v_expense_account_id THEN
				RAISE EXCEPTION 'Reward purchase % debit line account % is not the authoritative expense account %',
					NEW.reward_event_id, v_debit_line.account_id, v_expense_account_id;
			END IF;
			IF v_credit_line.account_id != v_reward_benefit_account_id THEN
				RAISE EXCEPTION 'Reward purchase % credit line account % is not the REWARD_BENEFIT account %',
					NEW.reward_event_id, v_credit_line.account_id, v_reward_benefit_account_id;
			END IF;
			IF v_debit_line.debit != NEW.economic_amount THEN
				RAISE EXCEPTION 'Reward purchase % debit amount % does not match economic_amount %',
					NEW.reward_event_id, v_debit_line.debit, NEW.economic_amount;
			END IF;
			IF v_credit_line.credit != NEW.economic_amount THEN
				RAISE EXCEPTION 'Reward purchase % credit amount % does not match economic_amount %',
					NEW.reward_event_id, v_credit_line.credit, NEW.economic_amount;
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_event_revision_insert ON "reward_event_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_reward_event_revision_insert
BEFORE INSERT ON "reward_event_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_event_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- D. ANCHOR COMPLETENESS: NAKED REWARD ACCOUNT / EVENT ANCHOR REJECTED
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	IF TG_TABLE_NAME = 'reward_accounts' THEN
		SELECT EXISTS(SELECT 1 FROM reward_account_revisions WHERE reward_account_id = NEW.id) INTO v_found;
		IF NOT v_found THEN
			RAISE EXCEPTION 'Reward account % has no revisions at commit (naked account anchor)', NEW.id;
		END IF;
	ELSIF TG_TABLE_NAME = 'reward_events' THEN
		SELECT EXISTS(SELECT 1 FROM reward_event_revisions WHERE reward_event_id = NEW.id) INTO v_found;
		IF NOT v_found THEN
			RAISE EXCEPTION 'Reward event % has no revisions at commit (naked event anchor)', NEW.id;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_account_anchor_completeness ON "reward_accounts";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_reward_account_anchor_completeness
AFTER INSERT ON "reward_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_anchor_completeness();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_event_anchor_completeness ON "reward_events";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_reward_event_anchor_completeness
AFTER INSERT ON "reward_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_anchor_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- E. POINT BALANCE NON-NEGATIVITY + ARCHIVE-ZERO-BALANCE GATE
--    Deferred, order-independent: fires from reward_account_revisions AND
--    reward_event_revisions inserts, deriving the current balance from the
--    LATEST revision of every event belonging to the account (no cached
--    mutable balance column).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_point_balance_commit_check()
RETURNS TRIGGER AS $$
DECLARE
	v_target_account_id UUID;
	v_balance NUMERIC;
	v_latest_account_rev RECORD;
BEGIN
	IF TG_TABLE_NAME = 'reward_account_revisions' THEN
		v_target_account_id := NEW.reward_account_id;
	ELSIF TG_TABLE_NAME = 'reward_event_revisions' THEN
		SELECT reward_account_id INTO v_target_account_id FROM reward_events WHERE id = NEW.reward_event_id;
	ELSE
		RAISE EXCEPTION 'Unexpected trigger table % for reward point balance check', TG_TABLE_NAME;
	END IF;

	IF v_target_account_id IS NULL THEN
		RETURN NULL;
	END IF;

	SELECT COALESCE(SUM(
		CASE
			WHEN latest.operation = 'VOID' THEN 0
			WHEN e.event_type IN ('OPENING_BALANCE', 'EARN', 'ADJUSTMENT_CREDIT') THEN latest.point_amount
			ELSE -latest.point_amount
		END
	), 0) INTO v_balance
	FROM (
		SELECT DISTINCT ON (rer.reward_event_id) rer.reward_event_id, rer.operation, rer.point_amount
		FROM reward_event_revisions rer
		JOIN reward_events re2 ON re2.id = rer.reward_event_id
		WHERE re2.reward_account_id = v_target_account_id
		ORDER BY rer.reward_event_id, rer.revision_no DESC
	) latest
	JOIN reward_events e ON e.id = latest.reward_event_id;

	IF v_balance < 0 THEN
		RAISE EXCEPTION 'Reward account % point balance would become negative (%)', v_target_account_id, v_balance;
	END IF;

	SELECT * INTO v_latest_account_rev
	FROM reward_account_revisions
	WHERE reward_account_id = v_target_account_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_account_rev IS NOT NULL AND v_latest_account_rev.operation = 'ARCHIVE' AND v_balance != 0 THEN
		RAISE EXCEPTION 'Cannot archive reward account % with non-zero point balance %', v_target_account_id, v_balance;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_point_balance_check_account ON "reward_account_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_reward_point_balance_check_account
AFTER INSERT ON "reward_account_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_point_balance_commit_check();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_point_balance_check_event ON "reward_event_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_reward_point_balance_check_event
AFTER INSERT ON "reward_event_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_point_balance_commit_check();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- F. CANONICAL REWARD_FUNDED_PURCHASE ANCHOR COMPLETENESS
--    No orphan canonical transaction of this kind without a companion
--    reward event anchor + CREATE revision referencing it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_reward_canonical_transaction_anchors()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_event RECORD;
	v_event_rev RECORD;
BEGIN
	IF NEW.kind != 'REWARD_FUNDED_PURCHASE' THEN
		RETURN NULL;
	END IF;

	SELECT * INTO v_can_rev
	FROM transaction_revisions
	WHERE transaction_id = NEW.id AND revision_no = 1;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical REWARD_FUNDED_PURCHASE transaction % has no initial revision #1 at commit', NEW.id;
	END IF;
	IF v_can_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical REWARD_FUNDED_PURCHASE transaction % revision #1 must have operation CREATE, found %',
			NEW.id, v_can_rev.operation;
	END IF;

	SELECT * INTO v_event FROM reward_events WHERE canonical_transaction_id = NEW.id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical REWARD_FUNDED_PURCHASE transaction % has no linked reward_events anchor at commit', NEW.id;
	END IF;
	IF v_event.event_type != 'REDEEM_PURCHASE' THEN
		RAISE EXCEPTION 'Canonical REWARD_FUNDED_PURCHASE transaction % linked reward event % has invalid event_type %',
			NEW.id, v_event.id, v_event.event_type;
	END IF;

	SELECT * INTO v_event_rev
	FROM reward_event_revisions
	WHERE canonical_revision_id = v_can_rev.id;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical REWARD_FUNDED_PURCHASE transaction % revision % has no linked reward_event_revisions row at commit',
			NEW.id, v_can_rev.id;
	END IF;
	IF v_event_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical REWARD_FUNDED_PURCHASE transaction % reward event revision % must have operation CREATE, found %',
			NEW.id, v_event_rev.id, v_event_rev.operation;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_reward_canonical_transaction_anchors ON "canonical_transactions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_reward_canonical_transaction_anchors
AFTER INSERT ON "canonical_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_reward_canonical_transaction_anchors();
