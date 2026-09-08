CREATE TABLE "monthly_budget_v2_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"budget_plan_id" uuid NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_budget_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"realized_income_amount" numeric(18, 2) NOT NULL,
	"current_obligations_amount" numeric(18, 2) NOT NULL,
	"basic_living_funding_amount" numeric(18, 2) NOT NULL,
	"date_bound_necessary_purchase_funding_amount" numeric(18, 2) NOT NULL,
	"core_emergency_fund_balance_amount" numeric(18, 2) NOT NULL,
	"mobility_balance_amount" numeric(18, 2) NOT NULL,
	"emergency_catch_up_amount" numeric(18, 2) NOT NULL,
	"deficit_amount" numeric(18, 2) NOT NULL,
	"true_surplus_amount" numeric(18, 2) NOT NULL,
	"mobility_allocation_amount" numeric(18, 2) NOT NULL,
	"long_term_investment_amount" numeric(18, 2) NOT NULL,
	"discretionary_allocation_amount" numeric(18, 2) NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_budget_v2_plan_revisions_rev_no_check" CHECK ("monthly_budget_v2_plan_revisions"."revision_no" > 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_op_check" CHECK ("monthly_budget_v2_plan_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "monthly_budget_v2_plan_revisions_policy_check" CHECK ("monthly_budget_v2_plan_revisions"."policy_version" = 'PERSONAL_BUDGET_V2'),
	CONSTRAINT "monthly_budget_v2_plan_revisions_currency_check" CHECK ("monthly_budget_v2_plan_revisions"."currency" = btrim("monthly_budget_v2_plan_revisions"."currency") AND length("monthly_budget_v2_plan_revisions"."currency") = 3),
	CONSTRAINT "monthly_budget_v2_plan_revisions_realized_income_check" CHECK ("monthly_budget_v2_plan_revisions"."realized_income_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_current_obligations_check" CHECK ("monthly_budget_v2_plan_revisions"."current_obligations_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_basic_living_check" CHECK ("monthly_budget_v2_plan_revisions"."basic_living_funding_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_necessary_purchase_check" CHECK ("monthly_budget_v2_plan_revisions"."date_bound_necessary_purchase_funding_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_emergency_balance_check" CHECK ("monthly_budget_v2_plan_revisions"."core_emergency_fund_balance_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_mobility_balance_check" CHECK ("monthly_budget_v2_plan_revisions"."mobility_balance_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_emergency_catch_up_check" CHECK ("monthly_budget_v2_plan_revisions"."emergency_catch_up_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_deficit_check" CHECK ("monthly_budget_v2_plan_revisions"."deficit_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_true_surplus_check" CHECK ("monthly_budget_v2_plan_revisions"."true_surplus_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_mobility_alloc_check" CHECK ("monthly_budget_v2_plan_revisions"."mobility_allocation_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_long_term_check" CHECK ("monthly_budget_v2_plan_revisions"."long_term_investment_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_discretionary_check" CHECK ("monthly_budget_v2_plan_revisions"."discretionary_allocation_amount" >= 0),
	CONSTRAINT "monthly_budget_v2_plan_revisions_allocation_sum_check" CHECK ("monthly_budget_v2_plan_revisions"."mobility_allocation_amount" + "monthly_budget_v2_plan_revisions"."long_term_investment_amount" + "monthly_budget_v2_plan_revisions"."discretionary_allocation_amount" = "monthly_budget_v2_plan_revisions"."true_surplus_amount")
);
--> statement-breakpoint
CREATE TABLE "monthly_budget_v2_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_budget_v2_plans_period_month_check" CHECK (EXTRACT(DAY FROM "monthly_budget_v2_plans"."period_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "midas_buckets" DROP CONSTRAINT "midas_buckets_type_check";--> statement-breakpoint
DROP INDEX "midas_buckets_singleton_type_idx";--> statement-breakpoint
ALTER TABLE "monthly_budget_v2_plan_revisions" ADD CONSTRAINT "monthly_budget_v2_plan_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_v2_plan_revisions" ADD CONSTRAINT "monthly_budget_v2_plan_revisions_budget_plan_id_monthly_budget_v2_plans_id_fk" FOREIGN KEY ("budget_plan_id") REFERENCES "public"."monthly_budget_v2_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_v2_plan_revisions" ADD CONSTRAINT "monthly_budget_v2_plan_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_v2_plan_revisions" ADD CONSTRAINT "monthly_budget_v2_plan_revisions_previous_budget_revision_id_monthly_budget_v2_plan_revisions_id_fk" FOREIGN KEY ("previous_budget_revision_id") REFERENCES "public"."monthly_budget_v2_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_v2_plans" ADD CONSTRAINT "monthly_budget_v2_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_v2_plans" ADD CONSTRAINT "monthly_budget_v2_plans_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_v2_plan_revisions_canonical_rev_idx" ON "monthly_budget_v2_plan_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_v2_plan_revisions_plan_rev_no_idx" ON "monthly_budget_v2_plan_revisions" USING btree ("budget_plan_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_v2_plan_revisions_prev_idx" ON "monthly_budget_v2_plan_revisions" USING btree ("previous_budget_revision_id") WHERE "monthly_budget_v2_plan_revisions"."previous_budget_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "monthly_budget_v2_plan_revisions_user_plan_idx" ON "monthly_budget_v2_plan_revisions" USING btree ("user_id","budget_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_v2_plans_user_period_idx" ON "monthly_budget_v2_plans" USING btree ("user_id","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_v2_plans_canonical_tx_idx" ON "monthly_budget_v2_plans" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "monthly_budget_v2_plans_user_idx" ON "monthly_budget_v2_plans" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "midas_buckets_singleton_type_idx" ON "midas_buckets" USING btree ("midas_account_id","bucket_type") WHERE "midas_buckets"."bucket_type" IN ('MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM', 'CORE_EMERGENCY_FUND');--> statement-breakpoint
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_type_check" CHECK ("midas_buckets"."bucket_type" IN ('CREDIT_CARD_RESERVE', 'SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM', 'CORE_EMERGENCY_FUND'));--> statement-breakpoint

-- ============================================================================
-- 0061 (custom): PERSONAL_BUDGET_V2 CORE FOUNDATION
--
-- Forward-only. Adds a SEPARATE V2 monthly-budget anchor/revision projection
-- bound to canonical kind MONTHLY_BUDGET_PLAN_V2, plus a NEW independent
-- DB-authoritative guard that re-derives and rejects any V2 projection that
-- does not match the exact PERSONAL_BUDGET_V2 deterministic waterfall +
-- mobility taper + 60k target-gap saturation + residual-kurus policy.
--
-- The historical PERSONAL_BUDGET_V1 domain
-- (monthly_budget_plans / monthly_budget_plan_revisions, guard
-- trg_fn_guard_monthly_budget_plan_revisions_insert from migration 0019) is
-- NOT touched, relaxed, or branched. V1 remains a closed contract.
--
-- Also promotes CORE_EMERGENCY_FUND to a valid singleton Midas bucket type
-- (check constraint + partial unique index above). INCOME_BUFFER is neither
-- renamed nor backfilled; no rows are moved.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plans_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'monthly_budget_v2_plans rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_monthly_budget_v2_plans_immutability ON "monthly_budget_v2_plans";--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_v2_plans_immutability
BEFORE UPDATE OR DELETE ON "monthly_budget_v2_plans"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_v2_plans_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'monthly_budget_v2_plan_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_monthly_budget_v2_plan_revisions_immutability ON "monthly_budget_v2_plan_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_v2_plan_revisions_immutability
BEFORE UPDATE OR DELETE ON "monthly_budget_v2_plan_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_immutability();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- V2 revision insert guard: structural integrity + exact policy re-derivation
-- + canonical payload/projection exact binding. Integer-safe arithmetic only.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_plan RECORD;
  v_canon_tx RECORD;
  v_rev RECORD;
  v_prev_plan_rev RECORD;
  v_user RECORD;
  v_payload jsonb;
  v_inputs jsonb;
  v_outputs jsonb;
  v_expected_occurred_at timestamptz;
  v_money_regex text := '^(0|[1-9][0-9]{0,15})\.[0-9]{2}$';

  -- PERSONAL_BUDGET_V2 policy constants, in exact kurus (cents)
  c_emergency_target constant bigint := 1000000;   -- 10,000.00 TRY
  c_mobility_lower   constant bigint := 3000000;   -- 30,000.00 TRY
  c_mobility_upper   constant bigint := 6000000;   -- 60,000.00 TRY

  v_R bigint; v_O bigint; v_B bigint; v_N bigint; v_E bigint; v_M bigint;
  v_pre bigint;
  v_gap bigint;
  v_mob_gap bigint;
  v_cand bigint;
  v_exp_deficit bigint;
  v_exp_catchup bigint;
  v_exp_true bigint;
  v_exp_disc bigint;
  v_exp_mob bigint;
  v_exp_long bigint;
  v_act_catchup bigint;
  v_act_deficit bigint;
  v_act_true bigint;
  v_act_mob bigint;
  v_act_long bigint;
  v_act_disc bigint;
BEGIN
  -- 1. Lock parent V2 plan FOR UPDATE + ownership
  SELECT * INTO v_plan FROM monthly_budget_v2_plans WHERE id = NEW.budget_plan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'monthly_budget_v2_plans row % not found', NEW.budget_plan_id;
  END IF;
  IF v_plan.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'monthly_budget_v2_plan user_id % does not match revision user_id %', v_plan.user_id, NEW.user_id;
  END IF;

  -- 2. Canonical transaction: exists, ownership, kind binding
  SELECT * INTO v_canon_tx FROM canonical_transactions WHERE id = v_plan.canonical_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found', v_plan.canonical_transaction_id;
  END IF;
  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_transaction user_id % does not match revision user_id %', v_canon_tx.user_id, NEW.user_id;
  END IF;
  IF v_canon_tx.kind != 'MONTHLY_BUDGET_PLAN_V2' THEN
    RAISE EXCEPTION 'canonical_transaction kind must be MONTHLY_BUDGET_PLAN_V2, found %', v_canon_tx.kind;
  END IF;

  -- 3. Canonical revision: exists, tx match, ownership, revision_no, operation
  SELECT * INTO v_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_revisions row % not found', NEW.canonical_revision_id;
  END IF;
  IF v_rev.transaction_id != v_plan.canonical_transaction_id THEN
    RAISE EXCEPTION 'canonical_revision transaction_id % does not match plan canonical_transaction_id %', v_rev.transaction_id, v_plan.canonical_transaction_id;
  END IF;
  IF v_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_revision user_id % does not match revision user_id %', v_rev.user_id, NEW.user_id;
  END IF;
  IF v_rev.revision_no != NEW.revision_no THEN
    RAISE EXCEPTION 'canonical_revision revision_no % does not match revision_no %', v_rev.revision_no, NEW.revision_no;
  END IF;
  IF v_rev.operation != NEW.operation THEN
    RAISE EXCEPTION 'canonical_revision operation % does not match revision operation %', v_rev.operation, NEW.operation;
  END IF;

  -- 4. occurred_at anchored to period_month midnight Europe/Istanbul
  v_expected_occurred_at := (v_plan.period_month::text || ' 00:00:00 Europe/Istanbul')::timestamptz;
  IF v_rev.occurred_at != v_expected_occurred_at THEN
    RAISE EXCEPTION 'canonical_revision occurred_at % does not match period month Europe/Istanbul midnight %', v_rev.occurred_at, v_expected_occurred_at;
  END IF;

  -- 5. Append-only, unbranched revision chain
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_budget_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First V2 budget plan revision must have NULL previous_budget_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First V2 budget plan revision must have operation CREATE';
    END IF;
    IF v_rev.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First canonical revision must have NULL previous_revision_id';
    END IF;
  ELSE
    IF NEW.previous_budget_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent V2 budget plan revision must have non-NULL previous_budget_revision_id';
    END IF;
    IF NEW.operation NOT IN ('UPDATE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent V2 budget plan revision must have operation UPDATE or VOID';
    END IF;

    SELECT * INTO v_prev_plan_rev FROM monthly_budget_v2_plan_revisions WHERE id = NEW.previous_budget_revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_budget_revision % not found', NEW.previous_budget_revision_id;
    END IF;
    IF v_prev_plan_rev.budget_plan_id != NEW.budget_plan_id THEN
      RAISE EXCEPTION 'previous_budget_revision budget_plan_id % does not match revision budget_plan_id %', v_prev_plan_rev.budget_plan_id, NEW.budget_plan_id;
    END IF;
    IF v_prev_plan_rev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous_budget_revision user_id % does not match revision user_id %', v_prev_plan_rev.user_id, NEW.user_id;
    END IF;
    IF v_prev_plan_rev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous_budget_revision revision_no % must be exactly %', v_prev_plan_rev.revision_no, NEW.revision_no - 1;
    END IF;
    IF v_prev_plan_rev.canonical_revision_id != v_rev.previous_revision_id THEN
      RAISE EXCEPTION 'previous_budget_revision canonical_revision_id % does not match canonical previous_revision_id %', v_prev_plan_rev.canonical_revision_id, v_rev.previous_revision_id;
    END IF;
    IF v_prev_plan_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'Cannot append revision to a VOIDED V2 budget plan';
    END IF;
  END IF;

  -- 6. Currency binding to user
  SELECT * INTO v_user FROM users WHERE id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'users row % not found', NEW.user_id;
  END IF;
  IF NEW.currency != v_user.currency THEN
    RAISE EXCEPTION 'V2 budget revision currency % does not match user currency %', NEW.currency, v_user.currency;
  END IF;

  -- 7. Policy version binding
  IF NEW.policy_version != 'PERSONAL_BUDGET_V2' THEN
    RAISE EXCEPTION 'V2 budget revision policy_version must be PERSONAL_BUDGET_V2, found %', NEW.policy_version;
  END IF;

  -- 8. Canonical payload: bounded shape, exact key sets, fail-closed types
  v_payload := v_rev.payload;
  IF v_payload IS NULL OR jsonb_typeof(v_payload) != 'object' THEN
    RAISE EXCEPTION 'canonical_revision payload must be a non-null JSON object';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_payload)) != 6 THEN
    RAISE EXCEPTION 'canonical_revision V2 payload must have exactly 6 top-level keys';
  END IF;
  IF NOT (
    v_payload ? 'periodMonth' AND v_payload ? 'policyVersion' AND v_payload ? 'currency' AND
    v_payload ? 'inputs' AND v_payload ? 'outputs' AND v_payload ? 'evidenceSnapshot'
  ) THEN
    RAISE EXCEPTION 'canonical_revision V2 payload is missing required top-level keys or has unexpected keys';
  END IF;
  IF COALESCE(jsonb_typeof(v_payload->'periodMonth'), '') != 'string' THEN
    RAISE EXCEPTION 'canonical payload periodMonth must be a JSON string';
  END IF;
  IF COALESCE(jsonb_typeof(v_payload->'policyVersion'), '') != 'string' THEN
    RAISE EXCEPTION 'canonical payload policyVersion must be a JSON string';
  END IF;
  IF COALESCE(jsonb_typeof(v_payload->'currency'), '') != 'string' THEN
    RAISE EXCEPTION 'canonical payload currency must be a JSON string';
  END IF;
  IF COALESCE(jsonb_typeof(v_payload->'inputs'), '') != 'object' THEN
    RAISE EXCEPTION 'canonical payload inputs must be a JSON object';
  END IF;
  IF COALESCE(jsonb_typeof(v_payload->'outputs'), '') != 'object' THEN
    RAISE EXCEPTION 'canonical payload outputs must be a JSON object';
  END IF;
  IF COALESCE(jsonb_typeof(v_payload->'evidenceSnapshot'), '') != 'object' THEN
    RAISE EXCEPTION 'canonical payload evidenceSnapshot must be a JSON object';
  END IF;

  IF (v_payload->>'periodMonth') != v_plan.period_month::text THEN
    RAISE EXCEPTION 'canonical payload periodMonth % does not match plan period_month %', (v_payload->>'periodMonth'), v_plan.period_month;
  END IF;
  IF (v_payload->>'policyVersion') != 'PERSONAL_BUDGET_V2' THEN
    RAISE EXCEPTION 'canonical payload policyVersion must be PERSONAL_BUDGET_V2, found %', (v_payload->>'policyVersion');
  END IF;
  IF (v_payload->>'currency') != NEW.currency THEN
    RAISE EXCEPTION 'canonical payload currency % does not match revision currency %', (v_payload->>'currency'), NEW.currency;
  END IF;
  IF (v_payload->'evidenceSnapshot') != NEW.evidence_snapshot THEN
    RAISE EXCEPTION 'canonical payload evidenceSnapshot does not match revision evidence_snapshot';
  END IF;

  -- 8a. inputs / outputs exact key sets
  v_inputs := v_payload->'inputs';
  IF (SELECT count(*) FROM jsonb_object_keys(v_inputs)) != 6 THEN
    RAISE EXCEPTION 'canonical payload inputs must have exactly 6 keys';
  END IF;
  IF NOT (
    v_inputs ? 'realizedIncome' AND v_inputs ? 'currentObligations' AND
    v_inputs ? 'basicLivingFunding' AND v_inputs ? 'dateBoundNecessaryPurchaseFunding' AND
    v_inputs ? 'coreEmergencyFundBalance' AND v_inputs ? 'mobilityBalance'
  ) THEN
    RAISE EXCEPTION 'canonical payload inputs is missing required keys or has unexpected keys';
  END IF;
  v_outputs := v_payload->'outputs';
  IF (SELECT count(*) FROM jsonb_object_keys(v_outputs)) != 6 THEN
    RAISE EXCEPTION 'canonical payload outputs must have exactly 6 keys';
  END IF;
  IF NOT (
    v_outputs ? 'emergencyCatchUp' AND v_outputs ? 'deficit' AND v_outputs ? 'trueSurplus' AND
    v_outputs ? 'mobilityAllocation' AND v_outputs ? 'longTermInvestment' AND
    v_outputs ? 'discretionaryAllocation'
  ) THEN
    RAISE EXCEPTION 'canonical payload outputs is missing required keys or has unexpected keys';
  END IF;

  -- 8b. Every money field: JSON string + canonical money regex + exact text
  --     binding to its NUMERIC(18,2) projection column.
  IF COALESCE(jsonb_typeof(v_inputs->'realizedIncome'), '') != 'string'
     OR NOT ((v_inputs->>'realizedIncome') ~ v_money_regex)
     OR (v_inputs->>'realizedIncome') != NEW.realized_income_amount::text THEN
    RAISE EXCEPTION 'canonical payload inputs.realizedIncome "%" does not exactly bind realized_income_amount "%"', (v_inputs->>'realizedIncome'), NEW.realized_income_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_inputs->'currentObligations'), '') != 'string'
     OR NOT ((v_inputs->>'currentObligations') ~ v_money_regex)
     OR (v_inputs->>'currentObligations') != NEW.current_obligations_amount::text THEN
    RAISE EXCEPTION 'canonical payload inputs.currentObligations "%" does not exactly bind current_obligations_amount "%"', (v_inputs->>'currentObligations'), NEW.current_obligations_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_inputs->'basicLivingFunding'), '') != 'string'
     OR NOT ((v_inputs->>'basicLivingFunding') ~ v_money_regex)
     OR (v_inputs->>'basicLivingFunding') != NEW.basic_living_funding_amount::text THEN
    RAISE EXCEPTION 'canonical payload inputs.basicLivingFunding "%" does not exactly bind basic_living_funding_amount "%"', (v_inputs->>'basicLivingFunding'), NEW.basic_living_funding_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_inputs->'dateBoundNecessaryPurchaseFunding'), '') != 'string'
     OR NOT ((v_inputs->>'dateBoundNecessaryPurchaseFunding') ~ v_money_regex)
     OR (v_inputs->>'dateBoundNecessaryPurchaseFunding') != NEW.date_bound_necessary_purchase_funding_amount::text THEN
    RAISE EXCEPTION 'canonical payload inputs.dateBoundNecessaryPurchaseFunding "%" does not exactly bind date_bound_necessary_purchase_funding_amount "%"', (v_inputs->>'dateBoundNecessaryPurchaseFunding'), NEW.date_bound_necessary_purchase_funding_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_inputs->'coreEmergencyFundBalance'), '') != 'string'
     OR NOT ((v_inputs->>'coreEmergencyFundBalance') ~ v_money_regex)
     OR (v_inputs->>'coreEmergencyFundBalance') != NEW.core_emergency_fund_balance_amount::text THEN
    RAISE EXCEPTION 'canonical payload inputs.coreEmergencyFundBalance "%" does not exactly bind core_emergency_fund_balance_amount "%"', (v_inputs->>'coreEmergencyFundBalance'), NEW.core_emergency_fund_balance_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_inputs->'mobilityBalance'), '') != 'string'
     OR NOT ((v_inputs->>'mobilityBalance') ~ v_money_regex)
     OR (v_inputs->>'mobilityBalance') != NEW.mobility_balance_amount::text THEN
    RAISE EXCEPTION 'canonical payload inputs.mobilityBalance "%" does not exactly bind mobility_balance_amount "%"', (v_inputs->>'mobilityBalance'), NEW.mobility_balance_amount::text;
  END IF;

  IF COALESCE(jsonb_typeof(v_outputs->'emergencyCatchUp'), '') != 'string'
     OR NOT ((v_outputs->>'emergencyCatchUp') ~ v_money_regex)
     OR (v_outputs->>'emergencyCatchUp') != NEW.emergency_catch_up_amount::text THEN
    RAISE EXCEPTION 'canonical payload outputs.emergencyCatchUp "%" does not exactly bind emergency_catch_up_amount "%"', (v_outputs->>'emergencyCatchUp'), NEW.emergency_catch_up_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_outputs->'deficit'), '') != 'string'
     OR NOT ((v_outputs->>'deficit') ~ v_money_regex)
     OR (v_outputs->>'deficit') != NEW.deficit_amount::text THEN
    RAISE EXCEPTION 'canonical payload outputs.deficit "%" does not exactly bind deficit_amount "%"', (v_outputs->>'deficit'), NEW.deficit_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_outputs->'trueSurplus'), '') != 'string'
     OR NOT ((v_outputs->>'trueSurplus') ~ v_money_regex)
     OR (v_outputs->>'trueSurplus') != NEW.true_surplus_amount::text THEN
    RAISE EXCEPTION 'canonical payload outputs.trueSurplus "%" does not exactly bind true_surplus_amount "%"', (v_outputs->>'trueSurplus'), NEW.true_surplus_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_outputs->'mobilityAllocation'), '') != 'string'
     OR NOT ((v_outputs->>'mobilityAllocation') ~ v_money_regex)
     OR (v_outputs->>'mobilityAllocation') != NEW.mobility_allocation_amount::text THEN
    RAISE EXCEPTION 'canonical payload outputs.mobilityAllocation "%" does not exactly bind mobility_allocation_amount "%"', (v_outputs->>'mobilityAllocation'), NEW.mobility_allocation_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_outputs->'longTermInvestment'), '') != 'string'
     OR NOT ((v_outputs->>'longTermInvestment') ~ v_money_regex)
     OR (v_outputs->>'longTermInvestment') != NEW.long_term_investment_amount::text THEN
    RAISE EXCEPTION 'canonical payload outputs.longTermInvestment "%" does not exactly bind long_term_investment_amount "%"', (v_outputs->>'longTermInvestment'), NEW.long_term_investment_amount::text;
  END IF;
  IF COALESCE(jsonb_typeof(v_outputs->'discretionaryAllocation'), '') != 'string'
     OR NOT ((v_outputs->>'discretionaryAllocation') ~ v_money_regex)
     OR (v_outputs->>'discretionaryAllocation') != NEW.discretionary_allocation_amount::text THEN
    RAISE EXCEPTION 'canonical payload outputs.discretionaryAllocation "%" does not exactly bind discretionary_allocation_amount "%"', (v_outputs->>'discretionaryAllocation'), NEW.discretionary_allocation_amount::text;
  END IF;

  -- 9. Independent DB re-derivation of the PERSONAL_BUDGET_V2 waterfall in
  --    exact kurus. NUMERIC intermediates => no BIGINT overflow for the
  --    NUMERIC(18,2) upper range. div() truncates toward zero (== floor for
  --    the non-negative operands here).
  v_R := (NEW.realized_income_amount * 100)::bigint;
  v_O := (NEW.current_obligations_amount * 100)::bigint;
  v_B := (NEW.basic_living_funding_amount * 100)::bigint;
  v_N := (NEW.date_bound_necessary_purchase_funding_amount * 100)::bigint;
  v_E := (NEW.core_emergency_fund_balance_amount * 100)::bigint;
  v_M := (NEW.mobility_balance_amount * 100)::bigint;

  v_pre := v_R - v_O - v_B - v_N;

  IF v_pre < 0 THEN
    -- CASE 1: affordability deficit. No catch-up, no surplus allocations.
    v_exp_deficit := -v_pre;
    v_exp_catchup := 0;
    v_exp_true    := 0;
    v_exp_disc    := 0;
    v_exp_mob     := 0;
    v_exp_long    := 0;
  ELSE
    -- CASE 2: no affordability deficit.
    v_exp_deficit := 0;
    v_gap := GREATEST(c_emergency_target - v_E, 0);
    v_exp_catchup := LEAST(v_pre, v_gap);
    v_exp_true := v_pre - v_exp_catchup;

    v_exp_disc := div(v_exp_true::numeric * 3500, 10000)::bigint;

    IF v_M < c_mobility_lower THEN
      v_cand := div(v_exp_true::numeric * 3500, 10000)::bigint;
    ELSIF v_M < c_mobility_upper THEN
      v_cand := div(
        v_exp_true::numeric * 3500 * (c_mobility_upper - v_M),
        10000::numeric * 3000000
      )::bigint;
    ELSE
      v_cand := 0;
    END IF;

    v_mob_gap := GREATEST(c_mobility_upper - v_M, 0);
    v_exp_mob := LEAST(v_cand, v_mob_gap);
    v_exp_long := v_exp_true - v_exp_mob - v_exp_disc;
  END IF;

  v_act_catchup := (NEW.emergency_catch_up_amount * 100)::bigint;
  v_act_deficit := (NEW.deficit_amount * 100)::bigint;
  v_act_true    := (NEW.true_surplus_amount * 100)::bigint;
  v_act_mob     := (NEW.mobility_allocation_amount * 100)::bigint;
  v_act_long    := (NEW.long_term_investment_amount * 100)::bigint;
  v_act_disc    := (NEW.discretionary_allocation_amount * 100)::bigint;

  IF v_act_deficit != v_exp_deficit THEN
    RAISE EXCEPTION 'deficit_amount % kurus does not match PERSONAL_BUDGET_V2 waterfall % kurus', v_act_deficit, v_exp_deficit;
  END IF;
  IF v_act_catchup != v_exp_catchup THEN
    RAISE EXCEPTION 'emergency_catch_up_amount % kurus does not match PERSONAL_BUDGET_V2 waterfall % kurus', v_act_catchup, v_exp_catchup;
  END IF;
  IF v_act_true != v_exp_true THEN
    RAISE EXCEPTION 'true_surplus_amount % kurus does not match PERSONAL_BUDGET_V2 waterfall % kurus', v_act_true, v_exp_true;
  END IF;
  IF v_act_mob != v_exp_mob THEN
    RAISE EXCEPTION 'mobility_allocation_amount % kurus does not match PERSONAL_BUDGET_V2 mobility taper/gap % kurus', v_act_mob, v_exp_mob;
  END IF;
  IF v_act_disc != v_exp_disc THEN
    RAISE EXCEPTION 'discretionary_allocation_amount % kurus does not match PERSONAL_BUDGET_V2 35%% base share % kurus', v_act_disc, v_exp_disc;
  END IF;
  IF v_act_long != v_exp_long THEN
    RAISE EXCEPTION 'long_term_investment_amount % kurus does not match PERSONAL_BUDGET_V2 residual % kurus', v_act_long, v_exp_long;
  END IF;

  -- 9a. Explicit invariant: allocations sum to trueSurplus, exactly.
  IF v_act_mob + v_act_long + v_act_disc != v_act_true THEN
    RAISE EXCEPTION 'mobility + longTerm + discretionary (% kurus) must equal trueSurplus (% kurus)', v_act_mob + v_act_long + v_act_disc, v_act_true;
  END IF;

  -- 9b. Deficit implies every surplus/catch-up allocation is zero.
  IF v_exp_deficit > 0 AND (v_act_true != 0 OR v_act_mob != 0 OR v_act_long != 0 OR v_act_disc != 0 OR v_act_catchup != 0) THEN
    RAISE EXCEPTION 'During an affordability deficit all surplus/catch-up allocations must be zero';
  END IF;

  -- 9c. Automatic V2 allocation must never push Mobility above the 60k target.
  IF v_act_mob > GREATEST(c_mobility_upper - v_M, 0) THEN
    RAISE EXCEPTION 'mobility_allocation_amount % kurus exceeds the remaining 60k target gap % kurus', v_act_mob, GREATEST(c_mobility_upper - v_M, 0);
  END IF;

  -- 10. VOID revision copies predecessor input/output amounts + evidence exactly
  IF NEW.operation = 'VOID' THEN
    IF NEW.realized_income_amount != v_prev_plan_rev.realized_income_amount
       OR NEW.current_obligations_amount != v_prev_plan_rev.current_obligations_amount
       OR NEW.basic_living_funding_amount != v_prev_plan_rev.basic_living_funding_amount
       OR NEW.date_bound_necessary_purchase_funding_amount != v_prev_plan_rev.date_bound_necessary_purchase_funding_amount
       OR NEW.core_emergency_fund_balance_amount != v_prev_plan_rev.core_emergency_fund_balance_amount
       OR NEW.mobility_balance_amount != v_prev_plan_rev.mobility_balance_amount
       OR NEW.emergency_catch_up_amount != v_prev_plan_rev.emergency_catch_up_amount
       OR NEW.deficit_amount != v_prev_plan_rev.deficit_amount
       OR NEW.true_surplus_amount != v_prev_plan_rev.true_surplus_amount
       OR NEW.mobility_allocation_amount != v_prev_plan_rev.mobility_allocation_amount
       OR NEW.long_term_investment_amount != v_prev_plan_rev.long_term_investment_amount
       OR NEW.discretionary_allocation_amount != v_prev_plan_rev.discretionary_allocation_amount
       OR NEW.evidence_snapshot != v_prev_plan_rev.evidence_snapshot THEN
      RAISE EXCEPTION 'VOID revision must copy predecessor input/output amounts and evidence snapshot exactly';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_monthly_budget_v2_plan_revisions_insert ON "monthly_budget_v2_plan_revisions";--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_v2_plan_revisions_insert
BEFORE INSERT ON "monthly_budget_v2_plan_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_insert();