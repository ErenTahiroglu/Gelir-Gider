CREATE TABLE "monthly_budget_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"budget_plan_id" uuid NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_budget_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reference_income_amount" numeric(18, 2) NOT NULL,
	"mandatory_ceiling_amount" numeric(18, 2) NOT NULL,
	"discretionary_ceiling_amount" numeric(18, 2) NOT NULL,
	"short_term_purchase_amount" numeric(18, 2) NOT NULL,
	"medium_term_reserve_amount" numeric(18, 2) NOT NULL,
	"long_term_investment_amount" numeric(18, 2) NOT NULL,
	"reference_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_budget_plan_revisions_rev_no_check" CHECK ("monthly_budget_plan_revisions"."revision_no" > 0),
	CONSTRAINT "monthly_budget_plan_revisions_op_check" CHECK ("monthly_budget_plan_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "monthly_budget_plan_revisions_policy_check" CHECK ("monthly_budget_plan_revisions"."policy_version" = 'PERSONAL_BUDGET_V1'),
	CONSTRAINT "monthly_budget_plan_revisions_currency_check" CHECK ("monthly_budget_plan_revisions"."currency" = btrim("monthly_budget_plan_revisions"."currency") AND length("monthly_budget_plan_revisions"."currency") = 3),
	CONSTRAINT "monthly_budget_plan_revisions_ref_amt_check" CHECK ("monthly_budget_plan_revisions"."reference_income_amount" >= 0),
	CONSTRAINT "monthly_budget_plan_revisions_mand_amt_check" CHECK ("monthly_budget_plan_revisions"."mandatory_ceiling_amount" >= 0),
	CONSTRAINT "monthly_budget_plan_revisions_disc_amt_check" CHECK ("monthly_budget_plan_revisions"."discretionary_ceiling_amount" >= 0),
	CONSTRAINT "monthly_budget_plan_revisions_short_amt_check" CHECK ("monthly_budget_plan_revisions"."short_term_purchase_amount" >= 0),
	CONSTRAINT "monthly_budget_plan_revisions_med_amt_check" CHECK ("monthly_budget_plan_revisions"."medium_term_reserve_amount" >= 0),
	CONSTRAINT "monthly_budget_plan_revisions_long_amt_check" CHECK ("monthly_budget_plan_revisions"."long_term_investment_amount" >= 0),
	CONSTRAINT "monthly_budget_plan_revisions_sum_check" CHECK ("monthly_budget_plan_revisions"."mandatory_ceiling_amount" + "monthly_budget_plan_revisions"."discretionary_ceiling_amount" + "monthly_budget_plan_revisions"."short_term_purchase_amount" + "monthly_budget_plan_revisions"."medium_term_reserve_amount" + "monthly_budget_plan_revisions"."long_term_investment_amount" = "monthly_budget_plan_revisions"."reference_income_amount")
);
--> statement-breakpoint
CREATE TABLE "monthly_budget_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_budget_plans_period_month_check" CHECK (EXTRACT(DAY FROM "monthly_budget_plans"."period_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "monthly_budget_plan_revisions" ADD CONSTRAINT "monthly_budget_plan_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_plan_revisions" ADD CONSTRAINT "monthly_budget_plan_revisions_budget_plan_id_monthly_budget_plans_id_fk" FOREIGN KEY ("budget_plan_id") REFERENCES "public"."monthly_budget_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_plan_revisions" ADD CONSTRAINT "monthly_budget_plan_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_plan_revisions" ADD CONSTRAINT "monthly_budget_plan_revisions_previous_budget_revision_id_monthly_budget_plan_revisions_id_fk" FOREIGN KEY ("previous_budget_revision_id") REFERENCES "public"."monthly_budget_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_plans" ADD CONSTRAINT "monthly_budget_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_budget_plans" ADD CONSTRAINT "monthly_budget_plans_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_plan_revisions_canonical_rev_idx" ON "monthly_budget_plan_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_plan_revisions_plan_rev_no_idx" ON "monthly_budget_plan_revisions" USING btree ("budget_plan_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_plan_revisions_prev_idx" ON "monthly_budget_plan_revisions" USING btree ("previous_budget_revision_id") WHERE "monthly_budget_plan_revisions"."previous_budget_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "monthly_budget_plan_revisions_user_plan_idx" ON "monthly_budget_plan_revisions" USING btree ("user_id","budget_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_plans_user_period_idx" ON "monthly_budget_plans" USING btree ("user_id","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_budget_plans_canonical_tx_idx" ON "monthly_budget_plans" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "monthly_budget_plans_user_idx" ON "monthly_budget_plans" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- IMMUTABILITY GUARDS (monthly_budget_plans & monthly_budget_plan_revisions)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_plans_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'monthly_budget_plans rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_plans_immutability
BEFORE UPDATE OR DELETE ON monthly_budget_plans
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_plans_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_plan_revisions_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'monthly_budget_plan_revisions rows are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_plan_revisions_immutability
BEFORE UPDATE OR DELETE ON monthly_budget_plan_revisions
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_plan_revisions_immutability();--> statement-breakpoint

-- ============================================================================
-- INSERTION GUARD & POLICY ENFORCEMENT TRIGGER (monthly_budget_plan_revisions)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_plan_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_plan RECORD;
  v_canon_tx RECORD;
  v_rev RECORD;
  v_prev_plan_rev RECORD;
  v_user RECORD;
  v_payload jsonb;
  v_allocations jsonb;
  v_top_keys_count integer;
  v_alloc_keys_count integer;
  v_cat jsonb;
  v_cat_keys_count integer;
  v_expected_occurred_at timestamptz;
  v_total_cents bigint;
  v_exp_mand_cents bigint;
  v_exp_disc_cents bigint;
  v_exp_short_cents bigint;
  v_exp_med_cents bigint;
  v_exp_long_cents bigint;
  v_act_mand_cents bigint;
  v_act_disc_cents bigint;
  v_act_short_cents bigint;
  v_act_med_cents bigint;
  v_act_long_cents bigint;
BEGIN
  -- 1. Lock parent monthly_budget_plans row FOR UPDATE
  SELECT * INTO v_plan
  FROM monthly_budget_plans
  WHERE id = NEW.budget_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'monthly_budget_plans row % not found', NEW.budget_plan_id;
  END IF;

  IF v_plan.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'monthly_budget_plan user_id % does not match revision user_id %',
      v_plan.user_id, NEW.user_id;
  END IF;

  -- 2. Validate canonical transaction
  SELECT * INTO v_canon_tx
  FROM canonical_transactions
  WHERE id = v_plan.canonical_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found', v_plan.canonical_transaction_id;
  END IF;

  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_transaction user_id % does not match revision user_id %',
      v_canon_tx.user_id, NEW.user_id;
  END IF;

  IF v_canon_tx.kind != 'MONTHLY_BUDGET_PLAN' THEN
    RAISE EXCEPTION 'canonical_transaction kind must be MONTHLY_BUDGET_PLAN, found %',
      v_canon_tx.kind;
  END IF;

  -- 3. Validate canonical revision
  SELECT * INTO v_rev
  FROM transaction_revisions
  WHERE id = NEW.canonical_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_revisions row % not found', NEW.canonical_revision_id;
  END IF;

  IF v_rev.transaction_id != v_plan.canonical_transaction_id THEN
    RAISE EXCEPTION 'canonical_revision transaction_id % does not match plan canonical_transaction_id %',
      v_rev.transaction_id, v_plan.canonical_transaction_id;
  END IF;

  IF v_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_revision user_id % does not match revision user_id %',
      v_rev.user_id, NEW.user_id;
  END IF;

  IF v_rev.revision_no != NEW.revision_no THEN
    RAISE EXCEPTION 'canonical_revision revision_no % does not match revision_no %',
      v_rev.revision_no, NEW.revision_no;
  END IF;

  IF v_rev.operation != NEW.operation THEN
    RAISE EXCEPTION 'canonical_revision operation % does not match revision operation %',
      v_rev.operation, NEW.operation;
  END IF;

  -- 4. Validate occurred_at anchored to period_month midnight Europe/Istanbul
  v_expected_occurred_at := (v_plan.period_month::text || ' 00:00:00 Europe/Istanbul')::timestamptz;
  IF v_rev.occurred_at != v_expected_occurred_at THEN
    RAISE EXCEPTION 'canonical_revision occurred_at % does not match period month Europe/Istanbul midnight %',
      v_rev.occurred_at, v_expected_occurred_at;
  END IF;

  -- 5. Revision chain validation
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_budget_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First budget plan revision must have NULL previous_budget_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First budget plan revision must have operation CREATE';
    END IF;
    IF v_rev.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First canonical revision must have NULL previous_revision_id';
    END IF;
  ELSE
    IF NEW.previous_budget_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent budget plan revision must have non-NULL previous_budget_revision_id';
    END IF;
    IF NEW.operation NOT IN ('UPDATE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent budget plan revision must have operation UPDATE or VOID';
    END IF;

    SELECT * INTO v_prev_plan_rev
    FROM monthly_budget_plan_revisions
    WHERE id = NEW.previous_budget_revision_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_budget_revision % not found', NEW.previous_budget_revision_id;
    END IF;

    IF v_prev_plan_rev.budget_plan_id != NEW.budget_plan_id THEN
      RAISE EXCEPTION 'previous_budget_revision budget_plan_id % does not match revision budget_plan_id %',
        v_prev_plan_rev.budget_plan_id, NEW.budget_plan_id;
    END IF;

    IF v_prev_plan_rev.user_id != NEW.user_id THEN
      RAISE EXCEPTION 'previous_budget_revision user_id % does not match revision user_id %',
        v_prev_plan_rev.user_id, NEW.user_id;
    END IF;

    IF v_prev_plan_rev.revision_no != NEW.revision_no - 1 THEN
      RAISE EXCEPTION 'previous_budget_revision revision_no % must be exactly %',
        v_prev_plan_rev.revision_no, NEW.revision_no - 1;
    END IF;

    IF v_prev_plan_rev.canonical_revision_id != v_rev.previous_revision_id THEN
      RAISE EXCEPTION 'previous_budget_revision canonical_revision_id % does not match canonical previous_revision_id %',
        v_prev_plan_rev.canonical_revision_id, v_rev.previous_revision_id;
    END IF;

    IF v_prev_plan_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'Cannot append revision to a VOIDED budget plan';
    END IF;
  END IF;

  -- 6. User currency validation
  SELECT * INTO v_user
  FROM users
  WHERE id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'users row % not found', NEW.user_id;
  END IF;

  IF NEW.currency != v_user.currency THEN
    RAISE EXCEPTION 'Budget revision currency % does not match user currency %',
      NEW.currency, v_user.currency;
  END IF;

  -- 7. Policy version validation
  IF NEW.policy_version != 'PERSONAL_BUDGET_V1' THEN
    RAISE EXCEPTION 'Budget revision policy_version must be PERSONAL_BUDGET_V1, found %',
      NEW.policy_version;
  END IF;

  -- 8. Canonical payload shape defense
  v_payload := v_rev.payload;
  IF v_payload IS NULL OR jsonb_typeof(v_payload) != 'object' THEN
    RAISE EXCEPTION 'canonical_revision payload must be a non-null JSON object';
  END IF;

  SELECT count(*) INTO v_top_keys_count FROM jsonb_object_keys(v_payload);
  IF v_top_keys_count != 6 THEN
    RAISE EXCEPTION 'canonical_revision payload must have exactly 6 keys, found %', v_top_keys_count;
  END IF;

  IF NOT (
    v_payload ? 'periodMonth' AND
    v_payload ? 'policyVersion' AND
    v_payload ? 'currency' AND
    v_payload ? 'referenceIncome' AND
    v_payload ? 'referenceSnapshot' AND
    v_payload ? 'allocations'
  ) THEN
    RAISE EXCEPTION 'canonical_revision payload is missing required top-level keys';
  END IF;

  IF (v_payload->>'periodMonth') != v_plan.period_month::text THEN
    RAISE EXCEPTION 'canonical payload periodMonth % does not match plan period_month %',
      (v_payload->>'periodMonth'), v_plan.period_month;
  END IF;

  IF (v_payload->>'policyVersion') != 'PERSONAL_BUDGET_V1' THEN
    RAISE EXCEPTION 'canonical payload policyVersion must be PERSONAL_BUDGET_V1, found %',
      (v_payload->>'policyVersion');
  END IF;

  IF (v_payload->>'currency') != NEW.currency THEN
    RAISE EXCEPTION 'canonical payload currency % does not match revision currency %',
      (v_payload->>'currency'), NEW.currency;
  END IF;

  IF (v_payload->>'referenceIncome')::numeric(18,2) != NEW.reference_income_amount THEN
    RAISE EXCEPTION 'canonical payload referenceIncome % does not match revision reference_income_amount %',
      (v_payload->>'referenceIncome'), NEW.reference_income_amount;
  END IF;

  IF (v_payload->'referenceSnapshot') != NEW.reference_snapshot THEN
    RAISE EXCEPTION 'canonical payload referenceSnapshot does not match revision reference_snapshot';
  END IF;

  -- 9. Allocation object and categories defense
  v_allocations := v_payload->'allocations';
  IF v_allocations IS NULL OR jsonb_typeof(v_allocations) != 'object' THEN
    RAISE EXCEPTION 'canonical payload allocations must be a JSON object';
  END IF;

  SELECT count(*) INTO v_alloc_keys_count FROM jsonb_object_keys(v_allocations);
  IF v_alloc_keys_count != 5 THEN
    RAISE EXCEPTION 'canonical payload allocations must contain exactly 5 categories, found %', v_alloc_keys_count;
  END IF;

  IF NOT (
    v_allocations ? 'MANDATORY_EXPENSE' AND
    v_allocations ? 'DISCRETIONARY_SPEND' AND
    v_allocations ? 'SHORT_TERM_PURCHASE' AND
    v_allocations ? 'MEDIUM_TERM_RESERVE' AND
    v_allocations ? 'LONG_TERM_INVESTMENT'
  ) THEN
    RAISE EXCEPTION 'canonical payload allocations is missing required categories or contains unexpected keys';
  END IF;

  -- Verify MANDATORY_EXPENSE category shape
  v_cat := v_allocations->'MANDATORY_EXPENSE';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 OR (v_cat->>'basisPoints')::int != 6500 OR (v_cat->>'role') != 'CEILING' OR (v_cat->>'amount')::numeric(18,2) != NEW.mandatory_ceiling_amount THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE category shape or amount mismatch in canonical payload';
  END IF;

  -- Verify DISCRETIONARY_SPEND category shape
  v_cat := v_allocations->'DISCRETIONARY_SPEND';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 OR (v_cat->>'basisPoints')::int != 500 OR (v_cat->>'role') != 'CEILING' OR (v_cat->>'amount')::numeric(18,2) != NEW.discretionary_ceiling_amount THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND category shape or amount mismatch in canonical payload';
  END IF;

  -- Verify SHORT_TERM_PURCHASE category shape
  v_cat := v_allocations->'SHORT_TERM_PURCHASE';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 OR (v_cat->>'basisPoints')::int != 1000 OR (v_cat->>'role') != 'TARGET' OR (v_cat->>'amount')::numeric(18,2) != NEW.short_term_purchase_amount THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE category shape or amount mismatch in canonical payload';
  END IF;

  -- Verify MEDIUM_TERM_RESERVE category shape
  v_cat := v_allocations->'MEDIUM_TERM_RESERVE';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 OR (v_cat->>'basisPoints')::int != 1000 OR (v_cat->>'role') != 'TARGET' OR (v_cat->>'amount')::numeric(18,2) != NEW.medium_term_reserve_amount THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE category shape or amount mismatch in canonical payload';
  END IF;

  -- Verify LONG_TERM_INVESTMENT category shape
  v_cat := v_allocations->'LONG_TERM_INVESTMENT';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 OR (v_cat->>'basisPoints')::int != 1000 OR (v_cat->>'role') != 'TARGET' OR (v_cat->>'amount')::numeric(18,2) != NEW.long_term_investment_amount THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT category shape or amount mismatch in canonical payload';
  END IF;

  -- 10. DB-Side Policy Formula Enforcement (Exact Cent Calculation)
  v_total_cents := (NEW.reference_income_amount * 100)::bigint;
  v_exp_mand_cents := (v_total_cents * 6500) / 10000;
  v_exp_disc_cents := (v_total_cents * 500) / 10000;
  v_exp_short_cents := (v_total_cents * 1000) / 10000;
  v_exp_med_cents := (v_total_cents * 1000) / 10000;
  v_exp_long_cents := v_total_cents - v_exp_mand_cents - v_exp_disc_cents - v_exp_short_cents - v_exp_med_cents;

  v_act_mand_cents := (NEW.mandatory_ceiling_amount * 100)::bigint;
  v_act_disc_cents := (NEW.discretionary_ceiling_amount * 100)::bigint;
  v_act_short_cents := (NEW.short_term_purchase_amount * 100)::bigint;
  v_act_med_cents := (NEW.medium_term_reserve_amount * 100)::bigint;
  v_act_long_cents := (NEW.long_term_investment_amount * 100)::bigint;

  IF v_act_mand_cents != v_exp_mand_cents THEN
    RAISE EXCEPTION 'mandatory_ceiling_amount % cents does not match PERSONAL_BUDGET_V1 formula % cents',
      v_act_mand_cents, v_exp_mand_cents;
  END IF;

  IF v_act_disc_cents != v_exp_disc_cents THEN
    RAISE EXCEPTION 'discretionary_ceiling_amount % cents does not match PERSONAL_BUDGET_V1 formula % cents',
      v_act_disc_cents, v_exp_disc_cents;
  END IF;

  IF v_act_short_cents != v_exp_short_cents THEN
    RAISE EXCEPTION 'short_term_purchase_amount % cents does not match PERSONAL_BUDGET_V1 formula % cents',
      v_act_short_cents, v_exp_short_cents;
  END IF;

  IF v_act_med_cents != v_exp_med_cents THEN
    RAISE EXCEPTION 'medium_term_reserve_amount % cents does not match PERSONAL_BUDGET_V1 formula % cents',
      v_act_med_cents, v_exp_med_cents;
  END IF;

  IF v_act_long_cents != v_exp_long_cents THEN
    RAISE EXCEPTION 'long_term_investment_amount % cents does not match PERSONAL_BUDGET_V1 formula % cents',
      v_act_long_cents, v_exp_long_cents;
  END IF;

  -- 11. VOID operation snapshot matching
  IF NEW.operation = 'VOID' THEN
    IF NEW.reference_income_amount != v_prev_plan_rev.reference_income_amount OR
       NEW.mandatory_ceiling_amount != v_prev_plan_rev.mandatory_ceiling_amount OR
       NEW.discretionary_ceiling_amount != v_prev_plan_rev.discretionary_ceiling_amount OR
       NEW.short_term_purchase_amount != v_prev_plan_rev.short_term_purchase_amount OR
       NEW.medium_term_reserve_amount != v_prev_plan_rev.medium_term_reserve_amount OR
       NEW.long_term_investment_amount != v_prev_plan_rev.long_term_investment_amount OR
       NEW.reference_snapshot != v_prev_plan_rev.reference_snapshot THEN
      RAISE EXCEPTION 'VOID revision must copy predecessor amounts and snapshot exactly';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_plan_revisions_insert
BEFORE INSERT ON monthly_budget_plan_revisions
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_plan_revisions_insert();