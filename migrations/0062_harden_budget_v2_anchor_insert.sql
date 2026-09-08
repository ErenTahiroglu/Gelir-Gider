-- ============================================================================
-- 0062: HARDEN monthly_budget_v2_plans ANCHOR INSERT
--
-- Forward-only. Migration 0061 added the V2 anchor table with a UPDATE/DELETE
-- immutability guard and the FULL revision insert guard on
-- monthly_budget_v2_plan_revisions -- but NOT a BEFORE INSERT semantic guard
-- on the anchor itself. A revision-less anchor row could therefore be inserted
-- (the FK only proves the canonical transaction EXISTS) with a canonical
-- transaction belonging to another user or of the wrong kind, permanently
-- consuming the (user_id, period_month) unique slot.
--
-- This migration adds ONE new V2-specific BEFORE INSERT guard that binds the
-- anchor to its canonical transaction's ownership and kind at insert time.
--
-- Does NOT: touch any table shape, the period-day / FK / unique constraints,
-- the 0061 guards, the V1 domain, or any data. No backfill, no UPDATEs, no
-- Drizzle snapshot (function/trigger-only, matching 0059/0060).
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plans_insert()
RETURNS trigger AS $$
DECLARE
  v_canon_tx RECORD;
BEGIN
  -- 1. Resolve the referenced canonical transaction. The FK also enforces
  --    existence, but a semantic guard fails clearly and before the FK in a
  --    single statement's evaluation order is irrelevant -- either way the
  --    INSERT is rejected.
  SELECT * INTO v_canon_tx
  FROM canonical_transactions
  WHERE id = NEW.canonical_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found for monthly_budget_v2_plans anchor', NEW.canonical_transaction_id;
  END IF;

  -- 2. Ownership binding.
  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'monthly_budget_v2_plans anchor user_id % does not match canonical_transaction user_id %',
      NEW.user_id, v_canon_tx.user_id;
  END IF;

  -- 3. Canonical kind binding.
  IF v_canon_tx.kind != 'MONTHLY_BUDGET_PLAN_V2' THEN
    RAISE EXCEPTION 'monthly_budget_v2_plans anchor canonical_transaction kind must be MONTHLY_BUDGET_PLAN_V2, found %',
      v_canon_tx.kind;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_monthly_budget_v2_plans_insert ON "monthly_budget_v2_plans";--> statement-breakpoint

CREATE TRIGGER trg_guard_monthly_budget_v2_plans_insert
BEFORE INSERT ON "monthly_budget_v2_plans"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_monthly_budget_v2_plans_insert();
