CREATE TABLE "budget_v2_basic_living_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"effective_period_month" date NOT NULL,
	"monthly_target_amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bv2bl_rev_no_check" CHECK ("budget_v2_basic_living_config_revisions"."revision_no" > 0),
	CONSTRAINT "bv2bl_op_check" CHECK ("budget_v2_basic_living_config_revisions"."operation" IN ('CREATE', 'UPDATE')),
	CONSTRAINT "bv2bl_target_check" CHECK ("budget_v2_basic_living_config_revisions"."monthly_target_amount" > 0),
	CONSTRAINT "bv2bl_currency_check" CHECK ("budget_v2_basic_living_config_revisions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bv2bl_effective_month_first_day_check" CHECK (EXTRACT(DAY FROM "budget_v2_basic_living_config_revisions"."effective_period_month") = 1),
	CONSTRAINT "bv2bl_source_kind_check" CHECK ("budget_v2_basic_living_config_revisions"."source_kind" IN ('USER_APPROVED', 'USER_APPROVED_FROM_SUGGESTION')),
	CONSTRAINT "bv2bl_fingerprint_check" CHECK ("budget_v2_basic_living_config_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bv2bl_idempotency_check" CHECK ("budget_v2_basic_living_config_revisions"."idempotency_key" = btrim("budget_v2_basic_living_config_revisions"."idempotency_key") AND length("budget_v2_basic_living_config_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "budget_v2_basic_living_config_revisions" ADD CONSTRAINT "budget_v2_basic_living_config_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_v2_basic_living_config_revisions" ADD CONSTRAINT "budget_v2_basic_living_config_revisions_previous_revision_id_budget_v2_basic_living_config_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."budget_v2_basic_living_config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2bl_user_rev_no_idx" ON "budget_v2_basic_living_config_revisions" USING btree ("user_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "bv2bl_prev_idx" ON "budget_v2_basic_living_config_revisions" USING btree ("previous_revision_id") WHERE "budget_v2_basic_living_config_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bv2bl_user_idempotency_idx" ON "budget_v2_basic_living_config_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bv2bl_user_effective_idx" ON "budget_v2_basic_living_config_revisions" USING btree ("user_id","effective_period_month");

-- ============================================================================
-- 0064 (custom): BUDGET V2 BASIC-LIVING CONFIG INTEGRITY
--
-- Forward-only. One additive append-only policy-config projection:
--   budget_v2_basic_living_config_revisions -- user-approved monthly target
--
-- NOT an economic event: NO canonical transaction, NO ledger posting, NO Midas
-- movement, NO financial-row backfill, NO UPDATE of Income/People/Midas/Goal
-- records, NO V1 Budget DDL.
--
-- Guards: an UPDATE/DELETE immutability guard + a BEFORE INSERT guard that
-- binds ownership and enforces the append-only, unbranched CREATE(1)->UPDATE(n)
-- chain with a non-decreasing effective_period_month (so "the revision
-- effective for month M" == "greatest revision_no with effective_period_month
-- <= firstDayOf(M)" is unambiguous).
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2bl_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'budget_v2_basic_living_config_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2bl_revisions_immutability ON "budget_v2_basic_living_config_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2bl_revisions_immutability
BEFORE UPDATE OR DELETE ON "budget_v2_basic_living_config_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2bl_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2bl_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_user RECORD;
  v_prev RECORD;
BEGIN
  -- 1. Ownership binding (single-user app; the users FK also enforces this).
  SELECT * INTO v_user FROM users WHERE id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'users row % not found for basic-living config revision', NEW.user_id;
  END IF;

  -- 2. Append-only, unbranched CREATE(1) -> UPDATE(n) chain.
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First basic-living config revision must have NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First basic-living config revision must have operation CREATE';
    END IF;
  ELSE
    IF NEW.previous_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent basic-living config revision must have non-NULL previous_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent basic-living config revision must have operation UPDATE';
    END IF;
    SELECT * INTO v_prev FROM budget_v2_basic_living_config_revisions WHERE id = NEW.previous_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous basic-living config revision % not found', NEW.previous_revision_id;
    END IF;
    IF v_prev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous basic-living config revision user_id % does not match %', v_prev.user_id, NEW.user_id;
    END IF;
    IF v_prev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous basic-living config revision_no % must be exactly %', v_prev.revision_no, NEW.revision_no - 1;
    END IF;
    IF NEW.effective_period_month < v_prev.effective_period_month THEN
      RAISE EXCEPTION 'basic-living config effective_period_month % must not precede the previous revision effective_period_month %', NEW.effective_period_month, v_prev.effective_period_month;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2bl_revisions_insert ON "budget_v2_basic_living_config_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2bl_revisions_insert
BEFORE INSERT ON "budget_v2_basic_living_config_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2bl_revisions_insert();
