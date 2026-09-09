-- ============================================================================
-- 0069 (custom, forward-only): CHECKPOINT REQUEST PROVENANCE HARDENING
--
-- Migration 0068 is immutable. This migration only CREATE OR REPLACEs the
-- BEFORE INSERT guard function `trg_fn_guard_bv2ckreq_insert` (added in 0068)
-- so an immutable checkpoint REQUEST row can never carry a caller-invented
-- checkpoint time / period / trigger config:
--
--   * NEW.checkpoint_at MUST equal the payment event's occurred_at exactly
--     (no ±1ms, no clamp).
--   * NEW.period_month MUST equal
--       date_trunc('month', payment_event.occurred_at
--                           AT TIME ZONE 'Europe/Istanbul')::date
--     (the "first day" CHECK is not enough; the statement cycle month is never
--     used).
--   * the referenced PAY revision's occurred_at MUST also equal the payment
--     event instant (the existing PAY-domain authoritative contract).
--   * NEW.trigger_config_revision_id MUST be the EXACT trigger-card config
--     effective at the payment instant -- the greatest revision_no for
--     (user_id, credit_card_id) whose occurred_at <= payment_event.occurred_at
--     -- and that effective config MUST be status ENABLED and source_kind
--     USER_APPROVED. A superseded ENABLED revision, a future ENABLED revision,
--     or the absence of any effective config are all rejected.
--
-- No table changes, no data backfill, no timestamp repair. No issuer / name
-- inference (the config is keyed on the literal credit_card_id).
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_bv2ckreq_insert()
RETURNS trigger AS $$
DECLARE
  v_pe RECORD;
  v_stmt RECORD;
  v_payrev RECORD;
  v_cfg RECORD;
  v_expected_period date;
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

  -- 2. checkpoint_at is the payment event instant verbatim.
  IF NEW.checkpoint_at IS DISTINCT FROM v_pe.occurred_at THEN
    RAISE EXCEPTION 'checkpoint request checkpoint_at % does not match payment event occurred_at %', NEW.checkpoint_at, v_pe.occurred_at;
  END IF;

  -- 3. period_month is the Europe/Istanbul calendar month of the payment instant.
  v_expected_period := date_trunc('month', v_pe.occurred_at AT TIME ZONE 'Europe/Istanbul')::date;
  IF NEW.period_month IS DISTINCT FROM v_expected_period THEN
    RAISE EXCEPTION 'checkpoint request period_month % is not the Europe/Istanbul month of the payment event (expected %)', NEW.period_month, v_expected_period;
  END IF;

  -- 4. The statement is owned and its card matches.
  SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statements row % not found for checkpoint request', NEW.statement_id;
  END IF;
  IF v_stmt.user_id != NEW.user_id OR v_stmt.credit_card_id != NEW.credit_card_id THEN
    RAISE EXCEPTION 'checkpoint request statement % / card % mismatch', NEW.statement_id, NEW.credit_card_id;
  END IF;

  -- 5. The pay revision is a PAID PAY revision referencing exactly this event,
  --    at the same instant.
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
  IF v_payrev.occurred_at IS DISTINCT FROM v_pe.occurred_at THEN
    RAISE EXCEPTION 'checkpoint request pay_revision occurred_at % does not match payment event occurred_at %', v_payrev.occurred_at, v_pe.occurred_at;
  END IF;

  -- 6. trigger_config_revision_id MUST be the EXACT config effective at the
  --    payment instant, and that effective config MUST be an ENABLED
  --    user-approved config for this card.
  SELECT * INTO v_cfg
  FROM budget_v2_checkpoint_trigger_card_revisions
  WHERE user_id = NEW.user_id
    AND credit_card_id = NEW.credit_card_id
    AND occurred_at <= v_pe.occurred_at
  ORDER BY revision_no DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no checkpoint trigger-card config is effective for card % at the payment instant', NEW.credit_card_id;
  END IF;
  IF v_cfg.id != NEW.trigger_config_revision_id THEN
    RAISE EXCEPTION 'checkpoint request trigger config % is not the config effective at the payment instant (effective is %)', NEW.trigger_config_revision_id, v_cfg.id;
  END IF;
  IF v_cfg.status != 'ENABLED' THEN
    RAISE EXCEPTION 'the checkpoint trigger-card config effective for card % is %, not ENABLED', NEW.credit_card_id, v_cfg.status;
  END IF;
  IF v_cfg.source_kind != 'USER_APPROVED' THEN
    RAISE EXCEPTION 'the checkpoint trigger-card config effective for card % is not USER_APPROVED', NEW.credit_card_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_bv2ckreq_insert ON "budget_v2_checkpoint_requests";--> statement-breakpoint

CREATE TRIGGER trg_guard_bv2ckreq_insert
BEFORE INSERT ON "budget_v2_checkpoint_requests"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_bv2ckreq_insert();
