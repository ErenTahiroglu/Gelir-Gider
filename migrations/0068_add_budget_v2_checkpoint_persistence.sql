CREATE TABLE "budget_v2_checkpoint_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payment_event_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"pay_revision_id" uuid NOT NULL,
	"trigger_config_revision_id" uuid NOT NULL,
	"checkpoint_at" timestamp with time zone NOT NULL,
	"period_month" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2ckreq_period_first_day_check" CHECK (EXTRACT(DAY FROM "budget_v2_checkpoint_requests"."period_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "budget_v2_checkpoint_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"payment_event_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"checkpoint_at" timestamp with time zone NOT NULL,
	"previous_checkpoint_snapshot_id" uuid,
	"previous_checkpoint_at" timestamp with time zone,
	"report_schema_version" varchar(64) NOT NULL,
	"report_json" jsonb NOT NULL,
	"report_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2cksnap_period_first_day_check" CHECK (EXTRACT(DAY FROM "budget_v2_checkpoint_snapshots"."period_month") = 1),
	CONSTRAINT "bv2cksnap_fingerprint_check" CHECK ("budget_v2_checkpoint_snapshots"."report_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2cksnap_prev_pair_check" CHECK (("budget_v2_checkpoint_snapshots"."previous_checkpoint_snapshot_id" IS NULL) = ("budget_v2_checkpoint_snapshots"."previous_checkpoint_at" IS NULL)),
	CONSTRAINT "bv2cksnap_prev_before_check" CHECK ("budget_v2_checkpoint_snapshots"."previous_checkpoint_at" IS NULL OR "budget_v2_checkpoint_snapshots"."previous_checkpoint_at" < "budget_v2_checkpoint_snapshots"."checkpoint_at")
);
--> statement-breakpoint
CREATE TABLE "budget_v2_checkpoint_trigger_card_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"status" varchar(16) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2ckcard_rev_no_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."revision_no" > 0),
	CONSTRAINT "bv2ckcard_op_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."operation" IN ('CREATE', 'UPDATE')),
	CONSTRAINT "bv2ckcard_status_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."status" IN ('ENABLED', 'DISABLED')),
	CONSTRAINT "bv2ckcard_source_kind_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."source_kind" IN ('USER_APPROVED')),
	CONSTRAINT "bv2ckcard_fingerprint_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2ckcard_idempotency_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."idempotency_key" = btrim("budget_v2_checkpoint_trigger_card_revisions"."idempotency_key") AND length("budget_v2_checkpoint_trigger_card_revisions"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "bv2ckcard_create_chain_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."revision_no" <> 1 OR ("budget_v2_checkpoint_trigger_card_revisions"."previous_revision_id" IS NULL AND "budget_v2_checkpoint_trigger_card_revisions"."operation" = 'CREATE')),
	CONSTRAINT "bv2ckcard_noncreate_chain_check" CHECK ("budget_v2_checkpoint_trigger_card_revisions"."revision_no" = 1 OR ("budget_v2_checkpoint_trigger_card_revisions"."previous_revision_id" IS NOT NULL AND "budget_v2_checkpoint_trigger_card_revisions"."operation" = 'UPDATE'))
);
--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_requests" ADD CONSTRAINT "budget_v2_checkpoint_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_requests" ADD CONSTRAINT "budget_v2_checkpoint_requests_payment_event_id_credit_card_statement_payment_events_id_fk" FOREIGN KEY ("payment_event_id") REFERENCES "public"."credit_card_statement_payment_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_requests" ADD CONSTRAINT "budget_v2_checkpoint_requests_statement_id_credit_card_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."credit_card_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_requests" ADD CONSTRAINT "budget_v2_checkpoint_requests_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_requests" ADD CONSTRAINT "budget_v2_checkpoint_requests_pay_revision_id_credit_card_statement_revisions_id_fk" FOREIGN KEY ("pay_revision_id") REFERENCES "public"."credit_card_statement_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_requests" ADD CONSTRAINT "budget_v2_checkpoint_requests_trigger_config_revision_id_budget_v2_checkpoint_trigger_card_revisions_id_fk" FOREIGN KEY ("trigger_config_revision_id") REFERENCES "public"."budget_v2_checkpoint_trigger_card_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_snapshots" ADD CONSTRAINT "budget_v2_checkpoint_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_snapshots" ADD CONSTRAINT "budget_v2_checkpoint_snapshots_request_id_budget_v2_checkpoint_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."budget_v2_checkpoint_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_snapshots" ADD CONSTRAINT "budget_v2_checkpoint_snapshots_payment_event_id_credit_card_statement_payment_events_id_fk" FOREIGN KEY ("payment_event_id") REFERENCES "public"."credit_card_statement_payment_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_snapshots" ADD CONSTRAINT "budget_v2_checkpoint_snapshots_previous_checkpoint_snapshot_id_budget_v2_checkpoint_snapshots_id_fk" FOREIGN KEY ("previous_checkpoint_snapshot_id") REFERENCES "public"."budget_v2_checkpoint_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_trigger_card_revisions" ADD CONSTRAINT "budget_v2_checkpoint_trigger_card_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_trigger_card_revisions" ADD CONSTRAINT "budget_v2_checkpoint_trigger_card_revisions_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_checkpoint_trigger_card_revisions" ADD CONSTRAINT "budget_v2_checkpoint_trigger_card_revisions_previous_revision_id_budget_v2_checkpoint_trigger_card_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."budget_v2_checkpoint_trigger_card_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2ckreq_payment_event_idx" ON "budget_v2_checkpoint_requests" USING btree ("payment_event_id");--> statement-breakpoint
CREATE INDEX "bv2ckreq_user_period_idx" ON "budget_v2_checkpoint_requests" USING btree ("user_id","period_month","checkpoint_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2cksnap_request_idx" ON "budget_v2_checkpoint_snapshots" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2cksnap_payment_event_idx" ON "budget_v2_checkpoint_snapshots" USING btree ("payment_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2cksnap_prev_idx" ON "budget_v2_checkpoint_snapshots" USING btree ("previous_checkpoint_snapshot_id") WHERE "budget_v2_checkpoint_snapshots"."previous_checkpoint_snapshot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bv2cksnap_user_period_idx" ON "budget_v2_checkpoint_snapshots" USING btree ("user_id","period_month","checkpoint_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2ckcard_user_card_rev_no_idx" ON "budget_v2_checkpoint_trigger_card_revisions" USING btree ("user_id","credit_card_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2ckcard_prev_idx" ON "budget_v2_checkpoint_trigger_card_revisions" USING btree ("previous_revision_id") WHERE "budget_v2_checkpoint_trigger_card_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2ckcard_user_idempotency_idx" ON "budget_v2_checkpoint_trigger_card_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bv2ckcard_user_card_idx" ON "budget_v2_checkpoint_trigger_card_revisions" USING btree ("user_id","credit_card_id");--> statement-breakpoint

-- ============================================================================
-- 0068 (custom): BUDGET V2 DURABLE CHECKPOINT PERSISTENCE & PAID-EVENT TRIGGER
-- ORCHESTRATION
--
-- Forward-only. Three additive tables:
--   budget_v2_checkpoint_trigger_card_revisions  -- append-only user-approved
--     config marking an EXACT owned creditCardId as a checkpoint-trigger card.
--     No issuer / displayName / last-four / merchant inference -- the row is
--     keyed by the literal card id and nothing else.
--   budget_v2_checkpoint_requests                -- immutable OUTBOX row; one
--     row = one actual eligible PAID payment event that requires a checkpoint.
--   budget_v2_checkpoint_snapshots               -- immutable successful
--     checkpoint report snapshot; exactly one per request; the sole historical
--     replay source.
--
-- NOT economic events: NO canonical transaction, NO ledger posting, NO Midas
-- movement, NO statement-liability change, NO People-principal change. No
-- issuer / bank-name detection anywhere (least of all in SQL). Month-close
-- stays a separate lifecycle and is never invoked from here.
--
-- One shared UPDATE/DELETE immutability guard for all three tables, plus a
-- BEFORE INSERT guard per table binding ownership + the append-only /
-- previous-checkpoint chain invariants.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2ckpt_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only and cannot be updated or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2ckcard_revisions_immutability ON "budget_v2_checkpoint_trigger_card_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_bv2ckcard_revisions_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_checkpoint_trigger_card_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2ckpt_immutability();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2ckreq_immutability ON "budget_v2_checkpoint_requests";--> statement-breakpoint
CREATE TRIGGER trg_guard_bv2ckreq_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_checkpoint_requests"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2ckpt_immutability();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2cksnap_immutability ON "budget_v2_checkpoint_snapshots";--> statement-breakpoint
CREATE TRIGGER trg_guard_bv2cksnap_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_checkpoint_snapshots"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2ckpt_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2ckcard_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_card RECORD;
  v_prev RECORD;
BEGIN
  -- 1. Exact owned card. NO issuer / name / last-four inference.
  SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_cards row % not found for checkpoint trigger-card config', NEW.credit_card_id;
  END IF;
  IF v_card.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'credit_cards user_id % does not match checkpoint trigger-card config user_id %', v_card.user_id, NEW.user_id;
  END IF;

  -- 2. Append-only, unbranched CREATE(1) -> UPDATE(n) chain per user+card.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First checkpoint trigger-card revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First checkpoint trigger-card revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent checkpoint trigger-card revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent checkpoint trigger-card revision must have operation UPDATE';
    END IF;
    SELECT * INTO v_prev FROM budget_v2_checkpoint_trigger_card_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous checkpoint trigger-card revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.user_id != NEW.user_id OR v_prev.credit_card_id != NEW.credit_card_id THEN
      RAISE EXCEPTION 'previous checkpoint trigger-card revision % has a different user/card', NEW.previous_revision_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous checkpoint trigger-card revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2ckcard_revisions_insert ON "budget_v2_checkpoint_trigger_card_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_bv2ckcard_revisions_insert
BEFORE INSERT ON "budget_v2_checkpoint_trigger_card_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2ckcard_revisions_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2ckreq_insert()
RETURNS trigger AS $$
DECLARE
  v_pe RECORD;
  v_stmt RECORD;
  v_payrev RECORD;
  v_cfg RECORD;
BEGIN
  -- 1. The payment event is real, owned, and belongs to the named statement.
  SELECT * INTO v_pe FROM credit_card_statement_payment_events WHERE id = NEW.payment_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_payment_events row % not found for checkpoint request', NEW.payment_event_id;
  END IF;
  IF v_pe.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'payment event user_id % does not match checkpoint request user_id %', v_pe.user_id, NEW.user_id;
  END IF;
  IF v_pe.statement_id != NEW.statement_id THEN
    RAISE EXCEPTION 'payment event statement_id % does not match checkpoint request statement_id %', v_pe.statement_id, NEW.statement_id;
  END IF;

  -- 2. The statement is owned and its card matches.
  SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statements row % not found for checkpoint request', NEW.statement_id;
  END IF;
  IF v_stmt.user_id != NEW.user_id OR v_stmt.credit_card_id != NEW.credit_card_id THEN
    RAISE EXCEPTION 'checkpoint request statement % / card % mismatch', NEW.statement_id, NEW.credit_card_id;
  END IF;

  -- 3. The pay revision is a PAID PAY revision referencing exactly this event.
  SELECT * INTO v_payrev FROM credit_card_statement_revisions WHERE id = NEW.pay_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_revisions row % not found for checkpoint request', NEW.pay_revision_id;
  END IF;
  IF v_payrev.user_id != NEW.user_id
     OR v_payrev.statement_id != NEW.statement_id
     OR v_payrev.payment_event_id IS DISTINCT FROM NEW.payment_event_id
     OR v_payrev.operation != 'PAY'
     OR v_payrev.status != 'PAID' THEN
    RAISE EXCEPTION 'checkpoint request pay_revision % is not a PAID PAY revision for payment event %', NEW.pay_revision_id, NEW.payment_event_id;
  END IF;

  -- 4. The trigger config revision is an ENABLED user-approved config for the card.
  SELECT * INTO v_cfg FROM budget_v2_checkpoint_trigger_card_revisions WHERE id = NEW.trigger_config_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'budget_v2_checkpoint_trigger_card_revisions row % not found for checkpoint request', NEW.trigger_config_revision_id;
  END IF;
  IF v_cfg.user_id != NEW.user_id
     OR v_cfg.credit_card_id != NEW.credit_card_id
     OR v_cfg.status != 'ENABLED' THEN
    RAISE EXCEPTION 'checkpoint request trigger config % is not an ENABLED config for card %', NEW.trigger_config_revision_id, NEW.credit_card_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2ckreq_insert ON "budget_v2_checkpoint_requests";--> statement-breakpoint
CREATE TRIGGER trg_guard_bv2ckreq_insert
BEFORE INSERT ON "budget_v2_checkpoint_requests"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2ckreq_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2cksnap_insert()
RETURNS trigger AS $$
DECLARE
  v_req RECORD;
  v_prev RECORD;
BEGIN
  IF NEW.report_schema_version IS NULL OR btrim(NEW.report_schema_version) = '' THEN
    RAISE EXCEPTION 'checkpoint snapshot report_schema_version must be non-empty';
  END IF;

  -- 1. The request exists, is owned, and identity columns match it exactly.
  SELECT * INTO v_req FROM budget_v2_checkpoint_requests WHERE id = NEW.request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'budget_v2_checkpoint_requests row % not found for checkpoint snapshot', NEW.request_id;
  END IF;
  IF v_req.user_id != NEW.user_id
     OR v_req.payment_event_id != NEW.payment_event_id
     OR v_req.period_month != NEW.period_month
     OR v_req.checkpoint_at != NEW.checkpoint_at THEN
    RAISE EXCEPTION 'checkpoint snapshot identity does not match request %', NEW.request_id;
  END IF;

  -- 2. Previous-checkpoint chain: set together, same user+period, strictly earlier.
  IF NEW.previous_checkpoint_snapshot_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM budget_v2_checkpoint_snapshots WHERE id = NEW.previous_checkpoint_snapshot_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous checkpoint snapshot % not found', NEW.previous_checkpoint_snapshot_id;
    END IF;
    IF v_prev.user_id != NEW.user_id OR v_prev.period_month != NEW.period_month THEN
      RAISE EXCEPTION 'previous checkpoint snapshot % has a different user/period', NEW.previous_checkpoint_snapshot_id;
    END IF;
    IF v_prev.checkpoint_at IS DISTINCT FROM NEW.previous_checkpoint_at THEN
      RAISE EXCEPTION 'previous_checkpoint_at % does not match previous snapshot checkpoint_at %', NEW.previous_checkpoint_at, v_prev.checkpoint_at;
    END IF;
    IF v_prev.checkpoint_at >= NEW.checkpoint_at THEN
      RAISE EXCEPTION 'previous checkpoint snapshot % is not strictly earlier than this checkpoint', NEW.previous_checkpoint_snapshot_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2cksnap_insert ON "budget_v2_checkpoint_snapshots";--> statement-breakpoint
CREATE TRIGGER trg_guard_bv2cksnap_insert
BEFORE INSERT ON "budget_v2_checkpoint_snapshots"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2cksnap_insert();
