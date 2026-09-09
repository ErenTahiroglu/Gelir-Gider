CREATE TABLE "budget_v2_surplus_use_attribution_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"subject_type" varchar(32) NOT NULL,
	"purchase_event_id" uuid,
	"person_obligation_id" uuid,
	"midas_allocation_transfer_id" uuid,
	"long_term_send_task_id" uuid,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"lane" varchar(24) NOT NULL,
	"basis_amount" numeric(18, 2) NOT NULL,
	"current_surplus_amount" numeric(18, 2) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"purchase_event_revision_id" uuid,
	"purchase_split_revision_id" uuid,
	"person_obligation_revision_id" uuid,
	"mobility_goal_id" uuid,
	"mobility_purpose_revision_id" uuid,
	"long_term_task_revision_id" uuid,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2surplus_rev_no_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."revision_no" > 0),
	CONSTRAINT "bv2surplus_op_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "bv2surplus_lane_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."lane" IN ('DISCRETIONARY', 'INTERNATIONAL_MOBILITY', 'LONG_TERM_INVESTMENT')),
	CONSTRAINT "bv2surplus_subject_type_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."subject_type" IN ('CREDIT_CARD_PURCHASE', 'PEOPLE_PAYABLE', 'MOBILITY_MIDAS_TRANSFER', 'LONG_TERM_SEND_TASK')),
	CONSTRAINT "bv2surplus_source_kind_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."source_kind" IN ('USER_APPROVED')),
	CONSTRAINT "bv2surplus_fingerprint_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2surplus_idempotency_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."idempotency_key" = btrim("budget_v2_surplus_use_attribution_revisions"."idempotency_key") AND length("budget_v2_surplus_use_attribution_revisions"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "bv2surplus_basis_positive_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."basis_amount" > 0),
	CONSTRAINT "bv2surplus_current_nonneg_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."current_surplus_amount" >= 0),
	CONSTRAINT "bv2surplus_current_le_basis_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."current_surplus_amount" <= "budget_v2_surplus_use_attribution_revisions"."basis_amount"),
	CONSTRAINT "bv2surplus_void_zero_current_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."operation" <> 'VOID' OR "budget_v2_surplus_use_attribution_revisions"."current_surplus_amount" = 0),
	CONSTRAINT "bv2surplus_subject_identity_check" CHECK ((
				"budget_v2_surplus_use_attribution_revisions"."subject_type" = 'CREDIT_CARD_PURCHASE'
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."midas_allocation_transfer_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_send_task_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_revision_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_goal_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_purpose_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_task_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."lane" = 'DISCRETIONARY'
			) OR (
				"budget_v2_surplus_use_attribution_revisions"."subject_type" = 'PEOPLE_PAYABLE'
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."midas_allocation_transfer_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_send_task_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_revision_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_split_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_goal_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_purpose_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_task_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."lane" = 'DISCRETIONARY'
			) OR (
				"budget_v2_surplus_use_attribution_revisions"."subject_type" = 'MOBILITY_MIDAS_TRANSFER'
					AND "budget_v2_surplus_use_attribution_revisions"."midas_allocation_transfer_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_send_task_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_goal_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_split_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_task_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."lane" = 'INTERNATIONAL_MOBILITY'
			) OR (
				"budget_v2_surplus_use_attribution_revisions"."subject_type" = 'LONG_TERM_SEND_TASK'
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_send_task_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."midas_allocation_transfer_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."long_term_task_revision_id" IS NOT NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_event_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."purchase_split_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."person_obligation_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_goal_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."mobility_purpose_revision_id" IS NULL
					AND "budget_v2_surplus_use_attribution_revisions"."lane" = 'LONG_TERM_INVESTMENT'
			)),
	CONSTRAINT "bv2surplus_create_chain_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."revision_no" <> 1 OR ("budget_v2_surplus_use_attribution_revisions"."previous_revision_id" IS NULL AND "budget_v2_surplus_use_attribution_revisions"."operation" = 'CREATE')),
	CONSTRAINT "bv2surplus_noncreate_chain_check" CHECK ("budget_v2_surplus_use_attribution_revisions"."revision_no" = 1 OR ("budget_v2_surplus_use_attribution_revisions"."previous_revision_id" IS NOT NULL AND "budget_v2_surplus_use_attribution_revisions"."operation" IN ('UPDATE', 'VOID')))
);
--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_purchase_event_id_credit_card_liability_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."credit_card_liability_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_person_obligation_id_person_obligations_id_fk" FOREIGN KEY ("person_obligation_id") REFERENCES "public"."person_obligations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_midas_allocation_transfer_id_midas_allocation_transfers_id_fk" FOREIGN KEY ("midas_allocation_transfer_id") REFERENCES "public"."midas_allocation_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_long_term_send_task_id_long_term_send_tasks_id_fk" FOREIGN KEY ("long_term_send_task_id") REFERENCES "public"."long_term_send_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_previous_revision_id_budget_v2_surplus_use_attribution_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."budget_v2_surplus_use_attribution_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_purchase_event_revision_id_credit_card_liability_event_revisions_id_fk" FOREIGN KEY ("purchase_event_revision_id") REFERENCES "public"."credit_card_liability_event_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_purchase_split_revision_id_credit_card_purchase_split_revisions_id_fk" FOREIGN KEY ("purchase_split_revision_id") REFERENCES "public"."credit_card_purchase_split_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_person_obligation_revision_id_person_obligation_revisions_id_fk" FOREIGN KEY ("person_obligation_revision_id") REFERENCES "public"."person_obligation_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_mobility_goal_id_short_term_goals_id_fk" FOREIGN KEY ("mobility_goal_id") REFERENCES "public"."short_term_goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_mobility_purpose_revision_id_short_term_goal_budget_v2_purpose_revisions_id_fk" FOREIGN KEY ("mobility_purpose_revision_id") REFERENCES "public"."short_term_goal_budget_v2_purpose_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_surplus_use_attribution_revisions" ADD CONSTRAINT "budget_v2_surplus_use_attribution_revisions_long_term_task_revision_id_long_term_send_task_revisions_id_fk" FOREIGN KEY ("long_term_task_revision_id") REFERENCES "public"."long_term_send_task_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2surplus_purchase_rev_no_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("purchase_event_id","period_month","revision_no") WHERE "budget_v2_surplus_use_attribution_revisions"."purchase_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2surplus_obligation_rev_no_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("person_obligation_id","period_month","revision_no") WHERE "budget_v2_surplus_use_attribution_revisions"."person_obligation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2surplus_transfer_rev_no_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("midas_allocation_transfer_id","period_month","revision_no") WHERE "budget_v2_surplus_use_attribution_revisions"."midas_allocation_transfer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2surplus_task_rev_no_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("long_term_send_task_id","period_month","revision_no") WHERE "budget_v2_surplus_use_attribution_revisions"."long_term_send_task_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2surplus_prev_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("previous_revision_id") WHERE "budget_v2_surplus_use_attribution_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2surplus_user_idempotency_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bv2surplus_user_period_idx" ON "budget_v2_surplus_use_attribution_revisions" USING btree ("user_id","period_month");--> statement-breakpoint

-- ============================================================================
-- 0070 (custom): BUDGET V2 SURPLUS-USE ATTRIBUTION
--
-- Forward-only. One additive append-only USER-APPROVED semantic projection:
--   budget_v2_surplus_use_attribution_revisions
--     -- how much of a Budget V2 period's current-period trueSurplus a realized
--        source event actually consumed (exact partial attribution supported).
--
-- NOT an economic event: NO canonical transaction, NO ledger posting, NO Midas
-- movement, NO statement-liability change, NO People-principal change. Funding
-- provenance is never inferred from merchant / memo / amount / card / bank /
-- timing / bucket balance / destination label -- least of all in SQL. No
-- historical backfill; existing source events stay UNATTRIBUTED until an
-- explicit user-approved CREATE.
--
-- Gets an UPDATE/DELETE immutability guard + a BEFORE INSERT guard that binds
-- ownership + subject validity (CREDIT_CARD_PURCHASE -> a PURCHASE liability
-- event owned by the user; PEOPLE_PAYABLE -> a PAYABLE obligation owned by the
-- user; MOBILITY_MIDAS_TRANSFER -> an allocation transfer owned by the user;
-- LONG_TERM_SEND_TASK -> a task owned by the user), enforces period_month as
-- the first calendar day of a month, and enforces the append-only, unbranched
-- CREATE(1) -> UPDATE/VOID(n) chain (previous revision same user / period /
-- subject identity, revision_no exactly n-1). The service/read layer owns the
-- mutable as-of basis / staleness truth; SQL only proves structural identity.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2surplus_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'budget_v2_surplus_use_attribution_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2surplus_revisions_immutability ON "budget_v2_surplus_use_attribution_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2surplus_revisions_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_surplus_use_attribution_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2surplus_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2surplus_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_event RECORD;
  v_obl RECORD;
  v_transfer RECORD;
  v_task RECORD;
  v_goal RECORD;
  v_prev RECORD;
BEGIN
  IF EXTRACT(DAY FROM NEW.period_month) <> 1 THEN
    RAISE EXCEPTION 'surplus-use attribution period_month % must be the first calendar day of a month', NEW.period_month;
  END IF;

  -- 1. Lock + validate the polymorphic source subject.
  IF NEW.subject_type = 'CREDIT_CARD_PURCHASE' THEN
    SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.purchase_event_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_card_liability_events row % not found for surplus-use attribution', NEW.purchase_event_id;
    END IF;
    IF v_event.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'credit_card_liability_events user_id % does not match surplus-use attribution user_id %', v_event.user_id, NEW.user_id;
    END IF;
    IF v_event.event_type != 'PURCHASE' THEN
      RAISE EXCEPTION 'surplus-use attribution target credit_card_liability_events % is event_type %, expected PURCHASE', NEW.purchase_event_id, v_event.event_type;
    END IF;
  ELSIF NEW.subject_type = 'PEOPLE_PAYABLE' THEN
    SELECT * INTO v_obl FROM person_obligations WHERE id = NEW.person_obligation_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'person_obligations row % not found for surplus-use attribution', NEW.person_obligation_id;
    END IF;
    IF v_obl.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'person_obligations user_id % does not match surplus-use attribution user_id %', v_obl.user_id, NEW.user_id;
    END IF;
    IF v_obl.direction != 'PAYABLE' THEN
      RAISE EXCEPTION 'surplus-use attribution target person_obligations % is direction %, expected PAYABLE', NEW.person_obligation_id, v_obl.direction;
    END IF;
  ELSIF NEW.subject_type = 'MOBILITY_MIDAS_TRANSFER' THEN
    SELECT * INTO v_transfer FROM midas_allocation_transfers WHERE id = NEW.midas_allocation_transfer_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'midas_allocation_transfers row % not found for surplus-use attribution', NEW.midas_allocation_transfer_id;
    END IF;
    IF v_transfer.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'midas_allocation_transfers user_id % does not match surplus-use attribution user_id %', v_transfer.user_id, NEW.user_id;
    END IF;
    SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.mobility_goal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'short_term_goals row % not found for surplus-use attribution mobility evidence', NEW.mobility_goal_id;
    END IF;
    IF v_goal.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'short_term_goals user_id % does not match surplus-use attribution user_id %', v_goal.user_id, NEW.user_id;
    END IF;
  ELSIF NEW.subject_type = 'LONG_TERM_SEND_TASK' THEN
    SELECT * INTO v_task FROM long_term_send_tasks WHERE id = NEW.long_term_send_task_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'long_term_send_tasks row % not found for surplus-use attribution', NEW.long_term_send_task_id;
    END IF;
    IF v_task.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'long_term_send_tasks user_id % does not match surplus-use attribution user_id %', v_task.user_id, NEW.user_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown surplus-use attribution subject_type %', NEW.subject_type;
  END IF;

  -- 2. Append-only, unbranched CREATE(1) -> UPDATE/VOID(n) chain.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First surplus-use attribution revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First surplus-use attribution revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent surplus-use attribution revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation NOT IN ('UPDATE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent surplus-use attribution revision must have operation UPDATE or VOID';
    END IF;
    SELECT * INTO v_prev FROM budget_v2_surplus_use_attribution_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous surplus-use attribution revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous surplus-use attribution revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.period_month != NEW.period_month THEN
      RAISE EXCEPTION 'previous surplus-use attribution revision period_month % does not match %', v_prev.period_month, NEW.period_month;
    END IF;
    IF v_prev.subject_type != NEW.subject_type
       OR v_prev.purchase_event_id IS DISTINCT FROM NEW.purchase_event_id
       OR v_prev.person_obligation_id IS DISTINCT FROM NEW.person_obligation_id
       OR v_prev.midas_allocation_transfer_id IS DISTINCT FROM NEW.midas_allocation_transfer_id
       OR v_prev.long_term_send_task_id IS DISTINCT FROM NEW.long_term_send_task_id THEN
      RAISE EXCEPTION 'previous surplus-use attribution revision subject does not match %', NEW.previous_revision_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous surplus-use attribution revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2surplus_revisions_insert ON "budget_v2_surplus_use_attribution_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2surplus_revisions_insert
BEFORE INSERT ON "budget_v2_surplus_use_attribution_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2surplus_revisions_insert();
