CREATE TABLE "budget_v2_recommendation_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"checkpoint_snapshot_id" uuid NOT NULL,
	"payment_event_id" uuid NOT NULL,
	"recommendation_id" varchar(256) NOT NULL,
	"recommendation_kind" varchar(64) NOT NULL,
	"recommendation_scope" varchar(128) NOT NULL,
	"recommendation_engine_version" varchar(64) NOT NULL,
	"behavior_engine_version" varchar(64) NOT NULL,
	"observation_contract_version" varchar(64) NOT NULL,
	"priority" integer NOT NULL,
	"recommendation_json" jsonb NOT NULL,
	"recommendation_fingerprint" varchar(64) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2recinst_fingerprint_check" CHECK ("budget_v2_recommendation_instances"."recommendation_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2recinst_rec_id_check" CHECK ("budget_v2_recommendation_instances"."recommendation_id" = btrim("budget_v2_recommendation_instances"."recommendation_id") AND length("budget_v2_recommendation_instances"."recommendation_id") BETWEEN 1 AND 256),
	CONSTRAINT "bv2recinst_kind_check" CHECK ("budget_v2_recommendation_instances"."recommendation_kind" IN (
				'DATA_COMPLETION_REQUIRED',
				'DEFICIT_STABILIZATION_REVIEW',
				'SURPLUS_OVERSUBSCRIPTION_REVIEW',
				'EMERGENCY_REBUILD_REVIEW',
				'BASELINE_RESET_REVIEW',
				'LANE_OVERRUN_REVIEW',
				'DISCRETIONARY_SPIKE_REVIEW',
				'OBLIGATION_LOAD_SPIKE_REVIEW',
				'TRUE_SURPLUS_RATE_DROP_REVIEW',
				'FOOD_OUTSIDE_SHARE_SPIKE_REVIEW',
				'UNUSED_DISCRETIONARY_SWEEP_REVIEW'
			)),
	CONSTRAINT "bv2recinst_priority_check" CHECK ("budget_v2_recommendation_instances"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_v2_recommendation_feedback_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recommendation_instance_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"decision" varchar(16) NOT NULL,
	"modification_json" jsonb,
	"source_kind" varchar(32) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2recfb_rev_no_check" CHECK ("budget_v2_recommendation_feedback_revisions"."revision_no" > 0),
	CONSTRAINT "bv2recfb_op_check" CHECK ("budget_v2_recommendation_feedback_revisions"."operation" IN ('CREATE', 'UPDATE')),
	CONSTRAINT "bv2recfb_decision_check" CHECK ("budget_v2_recommendation_feedback_revisions"."decision" IN ('ACCEPT', 'MODIFY', 'IGNORE')),
	CONSTRAINT "bv2recfb_source_kind_check" CHECK ("budget_v2_recommendation_feedback_revisions"."source_kind" IN ('USER_APPROVED')),
	CONSTRAINT "bv2recfb_fingerprint_check" CHECK ("budget_v2_recommendation_feedback_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2recfb_idempotency_check" CHECK ("budget_v2_recommendation_feedback_revisions"."idempotency_key" = btrim("budget_v2_recommendation_feedback_revisions"."idempotency_key") AND length("budget_v2_recommendation_feedback_revisions"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "bv2recfb_decision_mod_check" CHECK (("budget_v2_recommendation_feedback_revisions"."decision" IN ('ACCEPT', 'IGNORE') AND "budget_v2_recommendation_feedback_revisions"."modification_json" IS NULL) OR ("budget_v2_recommendation_feedback_revisions"."decision" = 'MODIFY' AND "budget_v2_recommendation_feedback_revisions"."modification_json" IS NOT NULL)),
	CONSTRAINT "bv2recfb_chain_check" CHECK (("budget_v2_recommendation_feedback_revisions"."revision_no" = 1 AND "budget_v2_recommendation_feedback_revisions"."previous_revision_id" IS NULL AND "budget_v2_recommendation_feedback_revisions"."operation" = 'CREATE') OR ("budget_v2_recommendation_feedback_revisions"."revision_no" > 1 AND "budget_v2_recommendation_feedback_revisions"."previous_revision_id" IS NOT NULL AND "budget_v2_recommendation_feedback_revisions"."operation" = 'UPDATE'))
);
--> statement-breakpoint
ALTER TABLE "budget_v2_recommendation_instances" ADD CONSTRAINT "budget_v2_recommendation_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_recommendation_instances" ADD CONSTRAINT "budget_v2_recommendation_instances_checkpoint_snapshot_id_budget_v2_checkpoint_snapshots_id_fk" FOREIGN KEY ("checkpoint_snapshot_id") REFERENCES "public"."budget_v2_checkpoint_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_recommendation_instances" ADD CONSTRAINT "budget_v2_recommendation_instances_payment_event_id_credit_card_statement_payment_events_id_fk" FOREIGN KEY ("payment_event_id") REFERENCES "public"."credit_card_statement_payment_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_recommendation_feedback_revisions" ADD CONSTRAINT "budget_v2_recommendation_feedback_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_recommendation_feedback_revisions" ADD CONSTRAINT "budget_v2_recommendation_feedback_revisions_recommendation_instance_id_budget_v2_recommendation_instances_id_fk" FOREIGN KEY ("recommendation_instance_id") REFERENCES "public"."budget_v2_recommendation_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_recommendation_feedback_revisions" ADD CONSTRAINT "budget_v2_recommendation_feedback_revisions_previous_revision_id_budget_v2_recommendation_feedback_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."budget_v2_recommendation_feedback_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2recinst_user_rec_id_idx" ON "budget_v2_recommendation_instances" USING btree ("user_id","recommendation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2recinst_user_semantic_idx" ON "budget_v2_recommendation_instances" USING btree ("user_id","payment_event_id","recommendation_kind","recommendation_scope");--> statement-breakpoint
CREATE INDEX "bv2recinst_user_checkpoint_idx" ON "budget_v2_recommendation_instances" USING btree ("user_id","checkpoint_snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2recfb_instance_rev_no_idx" ON "budget_v2_recommendation_feedback_revisions" USING btree ("recommendation_instance_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2recfb_prev_idx" ON "budget_v2_recommendation_feedback_revisions" USING btree ("previous_revision_id") WHERE "budget_v2_recommendation_feedback_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2recfb_user_idempotency_idx" ON "budget_v2_recommendation_feedback_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bv2recfb_user_instance_idx" ON "budget_v2_recommendation_feedback_revisions" USING btree ("user_id","recommendation_instance_id");--> statement-breakpoint

-- ============================================================================
-- 0071 (custom): BUDGET V2 RECOMMENDATION FEEDBACK LIFECYCLE
--
-- Forward-only. Two additive tables:
--   1. budget_v2_recommendation_instances
--      -- immutable captured snapshot of the exact recommendation shown to
--         and responded to by the user.
--   2. budget_v2_recommendation_feedback_revisions
--      -- append-only revision chain of user review decisions (ACCEPT/MODIFY/IGNORE).
--
-- NOT an economic event: NO canonical transaction, NO ledger posting, NO Midas
-- movement, NO policy change.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2rec_instances_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'budget_v2_recommendation_instances rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2rec_instances_immutability ON "budget_v2_recommendation_instances";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2rec_instances_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_recommendation_instances"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2rec_instances_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2rec_instances_insert()
RETURNS trigger AS $$
DECLARE
  v_snap RECORD;
BEGIN
  SELECT * INTO v_snap FROM budget_v2_checkpoint_snapshots WHERE id = NEW.checkpoint_snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkpoint snapshot % not found for recommendation instance', NEW.checkpoint_snapshot_id;
  END IF;
  IF v_snap.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'checkpoint snapshot user_id % does not match recommendation instance user_id %', v_snap.user_id, NEW.user_id;
  END IF;
  IF v_snap.payment_event_id != NEW.payment_event_id THEN
    RAISE EXCEPTION 'checkpoint snapshot payment_event_id % does not match recommendation instance payment_event_id %', v_snap.payment_event_id, NEW.payment_event_id;
  END IF;
  IF NEW.captured_at < v_snap.checkpoint_at THEN
    RAISE EXCEPTION 'recommendation instance captured_at % cannot be before checkpoint_at %', NEW.captured_at, v_snap.checkpoint_at;
  END IF;
  IF (NEW.recommendation_json->>'recommendationId') IS DISTINCT FROM NEW.recommendation_id THEN
    RAISE EXCEPTION 'recommendation_json recommendationId does not match column';
  END IF;
  IF (NEW.recommendation_json->>'kind') IS DISTINCT FROM NEW.recommendation_kind THEN
    RAISE EXCEPTION 'recommendation_json kind does not match column';
  END IF;
  IF (NEW.recommendation_json->>'scope') IS DISTINCT FROM NEW.recommendation_scope THEN
    RAISE EXCEPTION 'recommendation_json scope does not match column';
  END IF;
  IF (NEW.recommendation_json->>'throughPaymentEventId') IS DISTINCT FROM NEW.payment_event_id::text THEN
    RAISE EXCEPTION 'recommendation_json throughPaymentEventId does not match column';
  END IF;
  IF (NEW.recommendation_json->>'requiresUserApproval')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'recommendation_json requiresUserApproval must be true';
  END IF;
  IF (NEW.recommendation_json->>'automaticExecution')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'recommendation_json automaticExecution must be false';
  END IF;
  IF (NEW.recommendation_json->>'mutatesPolicy')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'recommendation_json mutatesPolicy must be false';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2rec_instances_insert ON "budget_v2_recommendation_instances";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2rec_instances_insert
BEFORE INSERT ON "budget_v2_recommendation_instances"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2rec_instances_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2rec_feedback_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'budget_v2_recommendation_feedback_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2rec_feedback_revisions_immutability ON "budget_v2_recommendation_feedback_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2rec_feedback_revisions_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_recommendation_feedback_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2rec_feedback_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2rec_feedback_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_inst RECORD;
  v_prev RECORD;
  v_snap RECORD;
BEGIN
  SELECT * INTO v_inst FROM budget_v2_recommendation_instances WHERE id = NEW.recommendation_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recommendation instance % not found for feedback revision', NEW.recommendation_instance_id;
  END IF;
  IF v_inst.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'recommendation instance user_id % does not match feedback revision user_id %', v_inst.user_id, NEW.user_id;
  END IF;

  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First feedback revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First feedback revision must have operation CREATE';
    END IF;
    SELECT * INTO v_snap FROM budget_v2_checkpoint_snapshots WHERE id = v_inst.checkpoint_snapshot_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'checkpoint snapshot % not found for recommendation instance', v_inst.checkpoint_snapshot_id;
    END IF;
    IF NEW.occurred_at < v_snap.checkpoint_at THEN
      RAISE EXCEPTION 'First feedback revision occurred_at % cannot be before checkpoint_at %', NEW.occurred_at, v_snap.checkpoint_at;
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent feedback revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent feedback revision must have operation UPDATE';
    END IF;
    SELECT * INTO v_prev FROM budget_v2_recommendation_feedback_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous feedback revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous feedback revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.recommendation_instance_id != NEW.recommendation_instance_id THEN
      RAISE EXCEPTION 'previous feedback revision recommendation_instance_id % does not match %', v_prev.recommendation_instance_id, NEW.recommendation_instance_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous feedback revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
    IF NEW.occurred_at <= v_prev.occurred_at THEN
      RAISE EXCEPTION 'subsequent feedback revision occurred_at % must be strictly after previous revision occurred_at %', NEW.occurred_at, v_prev.occurred_at;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2rec_feedback_revisions_insert ON "budget_v2_recommendation_feedback_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2rec_feedback_revisions_insert
BEFORE INSERT ON "budget_v2_recommendation_feedback_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2rec_feedback_revisions_insert();
