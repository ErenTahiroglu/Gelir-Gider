-- Custom SQL migration file, put your code below! --

-- ============================================================================
-- 0019: HARDEN MONTHLY BUDGET PLAN INTEGRITY
-- Replaces trg_fn_guard_monthly_budget_plan_revisions_insert() with:
--   A. Overflow-safe policy arithmetic (NUMERIC intermediate, no BIGINT overflow)
--   B. Canonical money-string contract (regex + exact text binding)
--   C. JSON scalar type enforcement (jsonb_typeof for all fields)
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
  v_ref_income_text text;
  v_cat_amount_text text;
  v_money_regex text := '^(0|[1-9][0-9]{0,15})\.[0-9]{2}$';
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

  -- 8. Canonical payload top-level shape defense
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

  -- 8a. Top-level scalar type enforcement (DEFECT F FIX)
  IF jsonb_typeof(v_payload->'periodMonth') != 'string' THEN
    RAISE EXCEPTION 'canonical payload periodMonth must be a JSON string, found type %',
      jsonb_typeof(v_payload->'periodMonth');
  END IF;
  IF jsonb_typeof(v_payload->'policyVersion') != 'string' THEN
    RAISE EXCEPTION 'canonical payload policyVersion must be a JSON string, found type %',
      jsonb_typeof(v_payload->'policyVersion');
  END IF;
  IF jsonb_typeof(v_payload->'currency') != 'string' THEN
    RAISE EXCEPTION 'canonical payload currency must be a JSON string, found type %',
      jsonb_typeof(v_payload->'currency');
  END IF;
  IF jsonb_typeof(v_payload->'referenceIncome') != 'string' THEN
    RAISE EXCEPTION 'canonical payload referenceIncome must be a JSON string, found type %',
      jsonb_typeof(v_payload->'referenceIncome');
  END IF;
  IF jsonb_typeof(v_payload->'referenceSnapshot') != 'object' THEN
    RAISE EXCEPTION 'canonical payload referenceSnapshot must be a JSON object, found type %',
      jsonb_typeof(v_payload->'referenceSnapshot');
  END IF;
  IF jsonb_typeof(v_payload->'allocations') != 'object' THEN
    RAISE EXCEPTION 'canonical payload allocations must be a JSON object, found type %',
      jsonb_typeof(v_payload->'allocations');
  END IF;

  -- 8b. Canonical money-string validation for referenceIncome
  v_ref_income_text := v_payload->>'referenceIncome';
  IF NOT (v_ref_income_text ~ v_money_regex) THEN
    RAISE EXCEPTION 'canonical payload referenceIncome "%" is not a canonical NUMERIC(18,2) money string',
      v_ref_income_text;
  END IF;

  -- 8c. Period month and policy text matches
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

  -- 8d. Exact text binding for referenceIncome (not numeric cast-and-compare)
  IF v_ref_income_text != NEW.reference_income_amount::text THEN
    RAISE EXCEPTION 'canonical payload referenceIncome text "%" does not exactly match revision reference_income_amount "%"',
      v_ref_income_text, NEW.reference_income_amount::text;
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

  -- 9a. MANDATORY_EXPENSE category shape + type + money-string + exact text binding
  v_cat := v_allocations->'MANDATORY_EXPENSE';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE must have exactly 3 keys, found %', v_cat_keys_count;
  END IF;
  IF jsonb_typeof(v_cat->'basisPoints') != 'number' THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.basisPoints must be a JSON number, found type %', jsonb_typeof(v_cat->'basisPoints');
  END IF;
  IF (v_cat->>'basisPoints')::int != 6500 THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.basisPoints must be 6500, found %', (v_cat->>'basisPoints');
  END IF;
  IF jsonb_typeof(v_cat->'role') != 'string' THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.role must be a JSON string, found type %', jsonb_typeof(v_cat->'role');
  END IF;
  IF (v_cat->>'role') != 'CEILING' THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.role must be CEILING, found %', (v_cat->>'role');
  END IF;
  IF jsonb_typeof(v_cat->'amount') != 'string' THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.amount must be a JSON string, found type %', jsonb_typeof(v_cat->'amount');
  END IF;
  v_cat_amount_text := v_cat->>'amount';
  IF NOT (v_cat_amount_text ~ v_money_regex) THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.amount "%" is not a canonical money string', v_cat_amount_text;
  END IF;
  IF v_cat_amount_text != NEW.mandatory_ceiling_amount::text THEN
    RAISE EXCEPTION 'MANDATORY_EXPENSE.amount text "%" does not exactly match mandatory_ceiling_amount "%"',
      v_cat_amount_text, NEW.mandatory_ceiling_amount::text;
  END IF;

  -- 9b. DISCRETIONARY_SPEND category
  v_cat := v_allocations->'DISCRETIONARY_SPEND';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND must have exactly 3 keys, found %', v_cat_keys_count;
  END IF;
  IF jsonb_typeof(v_cat->'basisPoints') != 'number' THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.basisPoints must be a JSON number, found type %', jsonb_typeof(v_cat->'basisPoints');
  END IF;
  IF (v_cat->>'basisPoints')::int != 500 THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.basisPoints must be 500, found %', (v_cat->>'basisPoints');
  END IF;
  IF jsonb_typeof(v_cat->'role') != 'string' THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.role must be a JSON string, found type %', jsonb_typeof(v_cat->'role');
  END IF;
  IF (v_cat->>'role') != 'CEILING' THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.role must be CEILING, found %', (v_cat->>'role');
  END IF;
  IF jsonb_typeof(v_cat->'amount') != 'string' THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.amount must be a JSON string, found type %', jsonb_typeof(v_cat->'amount');
  END IF;
  v_cat_amount_text := v_cat->>'amount';
  IF NOT (v_cat_amount_text ~ v_money_regex) THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.amount "%" is not a canonical money string', v_cat_amount_text;
  END IF;
  IF v_cat_amount_text != NEW.discretionary_ceiling_amount::text THEN
    RAISE EXCEPTION 'DISCRETIONARY_SPEND.amount text "%" does not exactly match discretionary_ceiling_amount "%"',
      v_cat_amount_text, NEW.discretionary_ceiling_amount::text;
  END IF;

  -- 9c. SHORT_TERM_PURCHASE category
  v_cat := v_allocations->'SHORT_TERM_PURCHASE';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE must have exactly 3 keys, found %', v_cat_keys_count;
  END IF;
  IF jsonb_typeof(v_cat->'basisPoints') != 'number' THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.basisPoints must be a JSON number, found type %', jsonb_typeof(v_cat->'basisPoints');
  END IF;
  IF (v_cat->>'basisPoints')::int != 1000 THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.basisPoints must be 1000, found %', (v_cat->>'basisPoints');
  END IF;
  IF jsonb_typeof(v_cat->'role') != 'string' THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.role must be a JSON string, found type %', jsonb_typeof(v_cat->'role');
  END IF;
  IF (v_cat->>'role') != 'TARGET' THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.role must be TARGET, found %', (v_cat->>'role');
  END IF;
  IF jsonb_typeof(v_cat->'amount') != 'string' THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.amount must be a JSON string, found type %', jsonb_typeof(v_cat->'amount');
  END IF;
  v_cat_amount_text := v_cat->>'amount';
  IF NOT (v_cat_amount_text ~ v_money_regex) THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.amount "%" is not a canonical money string', v_cat_amount_text;
  END IF;
  IF v_cat_amount_text != NEW.short_term_purchase_amount::text THEN
    RAISE EXCEPTION 'SHORT_TERM_PURCHASE.amount text "%" does not exactly match short_term_purchase_amount "%"',
      v_cat_amount_text, NEW.short_term_purchase_amount::text;
  END IF;

  -- 9d. MEDIUM_TERM_RESERVE category
  v_cat := v_allocations->'MEDIUM_TERM_RESERVE';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE must have exactly 3 keys, found %', v_cat_keys_count;
  END IF;
  IF jsonb_typeof(v_cat->'basisPoints') != 'number' THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.basisPoints must be a JSON number, found type %', jsonb_typeof(v_cat->'basisPoints');
  END IF;
  IF (v_cat->>'basisPoints')::int != 1000 THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.basisPoints must be 1000, found %', (v_cat->>'basisPoints');
  END IF;
  IF jsonb_typeof(v_cat->'role') != 'string' THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.role must be a JSON string, found type %', jsonb_typeof(v_cat->'role');
  END IF;
  IF (v_cat->>'role') != 'TARGET' THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.role must be TARGET, found %', (v_cat->>'role');
  END IF;
  IF jsonb_typeof(v_cat->'amount') != 'string' THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.amount must be a JSON string, found type %', jsonb_typeof(v_cat->'amount');
  END IF;
  v_cat_amount_text := v_cat->>'amount';
  IF NOT (v_cat_amount_text ~ v_money_regex) THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.amount "%" is not a canonical money string', v_cat_amount_text;
  END IF;
  IF v_cat_amount_text != NEW.medium_term_reserve_amount::text THEN
    RAISE EXCEPTION 'MEDIUM_TERM_RESERVE.amount text "%" does not exactly match medium_term_reserve_amount "%"',
      v_cat_amount_text, NEW.medium_term_reserve_amount::text;
  END IF;

  -- 9e. LONG_TERM_INVESTMENT category
  v_cat := v_allocations->'LONG_TERM_INVESTMENT';
  SELECT count(*) INTO v_cat_keys_count FROM jsonb_object_keys(v_cat);
  IF v_cat_keys_count != 3 THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT must have exactly 3 keys, found %', v_cat_keys_count;
  END IF;
  IF jsonb_typeof(v_cat->'basisPoints') != 'number' THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.basisPoints must be a JSON number, found type %', jsonb_typeof(v_cat->'basisPoints');
  END IF;
  IF (v_cat->>'basisPoints')::int != 1000 THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.basisPoints must be 1000, found %', (v_cat->>'basisPoints');
  END IF;
  IF jsonb_typeof(v_cat->'role') != 'string' THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.role must be a JSON string, found type %', jsonb_typeof(v_cat->'role');
  END IF;
  IF (v_cat->>'role') != 'TARGET' THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.role must be TARGET, found %', (v_cat->>'role');
  END IF;
  IF jsonb_typeof(v_cat->'amount') != 'string' THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.amount must be a JSON string, found type %', jsonb_typeof(v_cat->'amount');
  END IF;
  v_cat_amount_text := v_cat->>'amount';
  IF NOT (v_cat_amount_text ~ v_money_regex) THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.amount "%" is not a canonical money string', v_cat_amount_text;
  END IF;
  IF v_cat_amount_text != NEW.long_term_investment_amount::text THEN
    RAISE EXCEPTION 'LONG_TERM_INVESTMENT.amount text "%" does not exactly match long_term_investment_amount "%"',
      v_cat_amount_text, NEW.long_term_investment_amount::text;
  END IF;

  -- 10. DB-Side Policy Formula Enforcement — OVERFLOW-SAFE (DEFECT A FIX)
  -- NUMERIC intermediate prevents BIGINT overflow for NUMERIC(18,2) upper-range values.
  -- e.g. max ref = 9999999999999999.99 => total_cents = 999999999999999999
  --      999999999999999999 * 6500 overflows BIGINT; cast to NUMERIC first is exact.
  v_total_cents := (NEW.reference_income_amount * 100)::bigint;

  v_exp_mand_cents  := div(v_total_cents::numeric * 6500, 10000)::bigint;
  v_exp_disc_cents  := div(v_total_cents::numeric *  500, 10000)::bigint;
  v_exp_short_cents := div(v_total_cents::numeric * 1000, 10000)::bigint;
  v_exp_med_cents   := div(v_total_cents::numeric * 1000, 10000)::bigint;
  v_exp_long_cents  := v_total_cents
                       - v_exp_mand_cents
                       - v_exp_disc_cents
                       - v_exp_short_cents
                       - v_exp_med_cents;

  v_act_mand_cents  := (NEW.mandatory_ceiling_amount    * 100)::bigint;
  v_act_disc_cents  := (NEW.discretionary_ceiling_amount * 100)::bigint;
  v_act_short_cents := (NEW.short_term_purchase_amount   * 100)::bigint;
  v_act_med_cents   := (NEW.medium_term_reserve_amount   * 100)::bigint;
  v_act_long_cents  := (NEW.long_term_investment_amount  * 100)::bigint;

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
$$ LANGUAGE plpgsql;