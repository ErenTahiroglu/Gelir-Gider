CREATE TABLE "income_receipt_budget_v2_semantic_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"income_receipt_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"support_role" varchar(32) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "irbv2sem_rev_no_check" CHECK ("income_receipt_budget_v2_semantic_revisions"."revision_no" > 0),
	CONSTRAINT "irbv2sem_op_check" CHECK ("income_receipt_budget_v2_semantic_revisions"."operation" IN ('CREATE', 'UPDATE')),
	CONSTRAINT "irbv2sem_role_check" CHECK ("income_receipt_budget_v2_semantic_revisions"."support_role" IN ('PLANNED_FAMILY_GIFT', 'DEFICIT_FAMILY_SUPPORT')),
	CONSTRAINT "irbv2sem_fingerprint_check" CHECK ("income_receipt_budget_v2_semantic_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "irbv2sem_idempotency_check" CHECK ("income_receipt_budget_v2_semantic_revisions"."idempotency_key" = btrim("income_receipt_budget_v2_semantic_revisions"."idempotency_key") AND length("income_receipt_budget_v2_semantic_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "short_term_goal_budget_v2_purpose_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"purpose" varchar(40) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stgbv2purpose_rev_no_check" CHECK ("short_term_goal_budget_v2_purpose_revisions"."revision_no" > 0),
	CONSTRAINT "stgbv2purpose_op_check" CHECK ("short_term_goal_budget_v2_purpose_revisions"."operation" IN ('CREATE', 'UPDATE')),
	CONSTRAINT "stgbv2purpose_purpose_check" CHECK ("short_term_goal_budget_v2_purpose_revisions"."purpose" IN ('INTERNATIONAL_MOBILITY', 'DATE_BOUND_NECESSARY_PURCHASE', 'PLANNED_DISCRETIONARY', 'OTHER')),
	CONSTRAINT "stgbv2purpose_fingerprint_check" CHECK ("short_term_goal_budget_v2_purpose_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stgbv2purpose_idempotency_check" CHECK ("short_term_goal_budget_v2_purpose_revisions"."idempotency_key" = btrim("short_term_goal_budget_v2_purpose_revisions"."idempotency_key") AND length("short_term_goal_budget_v2_purpose_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "income_receipt_budget_v2_semantic_revisions" ADD CONSTRAINT "income_receipt_budget_v2_semantic_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipt_budget_v2_semantic_revisions" ADD CONSTRAINT "income_receipt_budget_v2_semantic_revisions_income_receipt_id_income_receipts_id_fk" FOREIGN KEY ("income_receipt_id") REFERENCES "public"."income_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipt_budget_v2_semantic_revisions" ADD CONSTRAINT "income_receipt_budget_v2_semantic_revisions_previous_revision_id_income_receipt_budget_v2_semantic_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."income_receipt_budget_v2_semantic_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_budget_v2_purpose_revisions" ADD CONSTRAINT "short_term_goal_budget_v2_purpose_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_budget_v2_purpose_revisions" ADD CONSTRAINT "short_term_goal_budget_v2_purpose_revisions_goal_id_short_term_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."short_term_goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_budget_v2_purpose_revisions" ADD CONSTRAINT "short_term_goal_budget_v2_purpose_revisions_previous_revision_id_short_term_goal_budget_v2_purpose_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."short_term_goal_budget_v2_purpose_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "irbv2sem_receipt_rev_no_idx" ON "income_receipt_budget_v2_semantic_revisions" USING btree ("income_receipt_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "irbv2sem_prev_idx" ON "income_receipt_budget_v2_semantic_revisions" USING btree ("previous_revision_id") WHERE "income_receipt_budget_v2_semantic_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "irbv2sem_user_idempotency_idx" ON "income_receipt_budget_v2_semantic_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "irbv2sem_user_receipt_idx" ON "income_receipt_budget_v2_semantic_revisions" USING btree ("user_id","income_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stgbv2purpose_goal_rev_no_idx" ON "short_term_goal_budget_v2_purpose_revisions" USING btree ("goal_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stgbv2purpose_prev_idx" ON "short_term_goal_budget_v2_purpose_revisions" USING btree ("previous_revision_id") WHERE "short_term_goal_budget_v2_purpose_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stgbv2purpose_user_idempotency_idx" ON "short_term_goal_budget_v2_purpose_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stgbv2purpose_user_goal_idx" ON "short_term_goal_budget_v2_purpose_revisions" USING btree ("user_id","goal_id");--> statement-breakpoint

-- ============================================================================
-- 0063 (custom): BUDGET V2 SEMANTIC CLASSIFICATION INTEGRITY
--
-- Forward-only. Two additive append-only metadata projections:
--   * income_receipt_budget_v2_semantic_revisions  -- SUPPORT receipt role
--   * short_term_goal_budget_v2_purpose_revisions   -- goal Budget V2 purpose
--
-- Neither is an economic event: NO canonical transaction, NO ledger posting,
-- NO Midas movement. No financial-row backfill, no inferred classification
-- backfill, no UPDATE of Income / People / Midas / Goal records, no V1 DDL.
--
-- Each gets a UPDATE/DELETE immutability guard + a BEFORE INSERT guard that
-- binds ownership + target validity and enforces the append-only, unbranched
-- CREATE(1)->UPDATE(n) revision chain.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_irbv2sem_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'income_receipt_budget_v2_semantic_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_irbv2sem_revisions_immutability ON "income_receipt_budget_v2_semantic_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_irbv2sem_revisions_immutability
BEFORE UPDATE OR DELETE ON "income_receipt_budget_v2_semantic_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_irbv2sem_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_stgbv2purpose_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'short_term_goal_budget_v2_purpose_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_stgbv2purpose_revisions_immutability ON "short_term_goal_budget_v2_purpose_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_stgbv2purpose_revisions_immutability
BEFORE UPDATE OR DELETE ON "short_term_goal_budget_v2_purpose_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_stgbv2purpose_revisions_immutability();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- SUPPORT receipt role classification insert guard
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_irbv2sem_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_receipt RECORD;
  v_source RECORD;
  v_prev RECORD;
BEGIN
  -- 1. Lock the income receipt anchor + ownership binding.
  SELECT * INTO v_receipt FROM income_receipts WHERE id = NEW.income_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_receipts row % not found for Budget V2 support classification', NEW.income_receipt_id;
  END IF;
  IF v_receipt.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_receipt user_id % does not match classification user_id %', v_receipt.user_id, NEW.user_id;
  END IF;

  -- 2. The receipt's income source nature MUST be exactly SUPPORT. A
  --    REGULAR or EXTRA receipt (incl. the People settlement overpayment
  --    source, which is nature=EXTRA) can never carry a family-support role.
  SELECT * INTO v_source FROM income_sources WHERE id = v_receipt.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_sources row % not found for receipt %', v_receipt.source_id, NEW.income_receipt_id;
  END IF;
  IF v_source.nature != 'SUPPORT' THEN
    RAISE EXCEPTION 'Budget V2 support classification requires income source nature SUPPORT, found % for source %', v_source.nature, v_source.id;
  END IF;

  -- 3. Append-only, unbranched CREATE(1) -> UPDATE(n) chain.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First support classification revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First support classification revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent support classification revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent support classification revision must have operation UPDATE';
    END IF;
    SELECT * INTO v_prev FROM income_receipt_budget_v2_semantic_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous support classification revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.income_receipt_id != NEW.income_receipt_id THEN
      RAISE EXCEPTION 'previous support classification revision income_receipt_id % does not match %', v_prev.income_receipt_id, NEW.income_receipt_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous support classification revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous support classification revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_irbv2sem_revisions_insert ON "income_receipt_budget_v2_semantic_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_irbv2sem_revisions_insert
BEFORE INSERT ON "income_receipt_budget_v2_semantic_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_irbv2sem_revisions_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Short-term goal Budget V2 purpose classification insert guard
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_stgbv2purpose_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_goal RECORD;
  v_prev RECORD;
BEGIN
  -- 1. Lock the goal anchor + ownership binding.
  SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.goal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'short_term_goals row % not found for Budget V2 purpose classification', NEW.goal_id;
  END IF;
  IF v_goal.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'short_term_goal user_id % does not match classification user_id %', v_goal.user_id, NEW.user_id;
  END IF;

  -- 2. Append-only, unbranched CREATE(1) -> UPDATE(n) chain.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First goal purpose revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First goal purpose revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent goal purpose revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent goal purpose revision must have operation UPDATE';
    END IF;
    SELECT * INTO v_prev FROM short_term_goal_budget_v2_purpose_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous goal purpose revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.goal_id != NEW.goal_id THEN
      RAISE EXCEPTION 'previous goal purpose revision goal_id % does not match %', v_prev.goal_id, NEW.goal_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous goal purpose revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous goal purpose revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_stgbv2purpose_revisions_insert ON "short_term_goal_budget_v2_purpose_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_stgbv2purpose_revisions_insert
BEFORE INSERT ON "short_term_goal_budget_v2_purpose_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_stgbv2purpose_revisions_insert();