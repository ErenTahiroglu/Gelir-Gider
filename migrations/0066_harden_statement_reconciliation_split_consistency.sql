-- ============================================================================
-- 0066 (custom, forward-only): STATEMENT RECONCILIATION <-> PURCHASE SPLIT
-- CONSISTENCY HARDENING
--
-- Migration 0065 is immutable. This migration only CREATE OR REPLACEs the
-- BEFORE INSERT guard function `trg_fn_guard_ccsrc_insert` (added in 0065) to
-- also enforce that a PURCHASE reconciliation component cannot contradict the
-- authoritative purchase-split truth:
--
--   * purchase HAS an active split (latest non-VOID split revision):
--       - purchase_split_revision_id MUST identify that exact active revision
--       - the active split revision MUST be sealed
--       - EXTERNAL_PERSON person_id MUST be a participant of that revision
--       - PERSONAL ownership requires a positive user share
--   * purchase has NO active split (no split, or latest split revision VOID):
--       - ownership MUST be PERSONAL and purchase_split_revision_id MUST be NULL
--
-- No table changes, no data backfill, no proportional installment allocation.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_ccsrc_insert()
RETURNS trigger AS $$
DECLARE
  v_rev RECORD;
  v_recon RECORD;
  v_event RECORD;
  v_latest_event_rev RECORD;
  v_split RECORD;
  v_person RECORD;
  v_active_split RECORD;
BEGIN
  SELECT * INTO v_rev FROM credit_card_statement_reconciliation_revisions WHERE id = NEW.reconciliation_revision_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_card_statement_reconciliation_revisions row % not found', NEW.reconciliation_revision_id;
  END IF;
  IF v_rev.operation = 'VOID' THEN
    RAISE EXCEPTION 'a VOID reconciliation revision carries no components';
  END IF;
  IF EXISTS (SELECT 1 FROM credit_card_statement_reconciliation_seals WHERE reconciliation_revision_id = NEW.reconciliation_revision_id) THEN
    RAISE EXCEPTION 'reconciliation revision % is sealed; no further components may be added', NEW.reconciliation_revision_id;
  END IF;

  SELECT * INTO v_recon FROM credit_card_statement_reconciliations WHERE id = v_rev.reconciliation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation anchor % not found for revision %', v_rev.reconciliation_id, NEW.reconciliation_revision_id;
  END IF;

  IF NEW.component_type = 'PURCHASE' THEN
    SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.purchase_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit_card_liability_events row % not found for PURCHASE component', NEW.purchase_event_id;
    END IF;
    IF v_event.event_type != 'PURCHASE' THEN
      RAISE EXCEPTION 'PURCHASE component must reference a PURCHASE liability event, got %', v_event.event_type;
    END IF;
    IF v_event.user_id != v_rev.user_id THEN
      RAISE EXCEPTION 'PURCHASE component liability event user_id % does not match reconciliation user_id %', v_event.user_id, v_rev.user_id;
    END IF;
    IF v_event.credit_card_id != v_recon.credit_card_id THEN
      RAISE EXCEPTION 'PURCHASE component liability event card % does not match reconciliation card %', v_event.credit_card_id, v_recon.credit_card_id;
    END IF;
    SELECT * INTO v_latest_event_rev
      FROM credit_card_liability_event_revisions
      WHERE event_id = NEW.purchase_event_id
      ORDER BY revision_no DESC
      LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'liability event % has no revisions', NEW.purchase_event_id;
    END IF;
    IF v_latest_event_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'PURCHASE component references a VOID purchase liability event %', NEW.purchase_event_id;
    END IF;
    IF NEW.purchase_split_revision_id IS NOT NULL THEN
      SELECT s.* INTO v_split
        FROM credit_card_purchase_split_revisions r
        JOIN credit_card_purchase_splits s ON s.id = r.split_id
        WHERE r.id = NEW.purchase_split_revision_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_card_purchase_split_revisions row % not found', NEW.purchase_split_revision_id;
      END IF;
      IF v_split.purchase_event_id != NEW.purchase_event_id THEN
        RAISE EXCEPTION 'split revision % belongs to purchase % not component purchase %', NEW.purchase_split_revision_id, v_split.purchase_event_id, NEW.purchase_event_id;
      END IF;
    END IF;

    -- 0066: reconcile against the AUTHORITATIVE active split.
    SELECT r.id AS id, r.operation AS operation, r.user_share_amount AS user_share_amount
      INTO v_active_split
      FROM credit_card_purchase_split_revisions r
      JOIN credit_card_purchase_splits s ON s.id = r.split_id
      WHERE s.purchase_event_id = NEW.purchase_event_id
      ORDER BY r.revision_no DESC
      LIMIT 1;

    IF NOT FOUND OR v_active_split.operation = 'VOID' THEN
      -- purchase is currently unsplit / 100% user
      IF NEW.ownership != 'PERSONAL' THEN
        RAISE EXCEPTION 'PURCHASE component for purchase % has no active split; ownership must be PERSONAL, got %', NEW.purchase_event_id, NEW.ownership;
      END IF;
      IF NEW.purchase_split_revision_id IS NOT NULL THEN
        RAISE EXCEPTION 'PURCHASE component for purchase % has no active split; purchase_split_revision_id must be NULL', NEW.purchase_event_id;
      END IF;
    ELSE
      IF NEW.purchase_split_revision_id IS DISTINCT FROM v_active_split.id THEN
        RAISE EXCEPTION 'PURCHASE component purchase_split_revision_id % must be the active split revision % for purchase %', NEW.purchase_split_revision_id, v_active_split.id, NEW.purchase_event_id;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM credit_card_purchase_split_revision_seals WHERE split_revision_id = v_active_split.id) THEN
        RAISE EXCEPTION 'active split revision % for purchase % is not sealed', v_active_split.id, NEW.purchase_event_id;
      END IF;
      IF NEW.ownership = 'EXTERNAL_PERSON' THEN
        IF NOT EXISTS (SELECT 1 FROM credit_card_purchase_split_revision_items WHERE split_revision_id = v_active_split.id AND person_id = NEW.person_id) THEN
          RAISE EXCEPTION 'person % is not a participant of split revision % for purchase %', NEW.person_id, v_active_split.id, NEW.purchase_event_id;
        END IF;
      ELSE
        IF v_active_split.user_share_amount <= 0 THEN
          RAISE EXCEPTION 'split revision % has zero user share; PERSONAL ownership incompatible for purchase %', v_active_split.id, NEW.purchase_event_id;
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW.ownership = 'EXTERNAL_PERSON' THEN
    SELECT * INTO v_person FROM people WHERE id = NEW.person_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'people row % not found for EXTERNAL_PERSON component', NEW.person_id;
    END IF;
    IF v_person.user_id != v_rev.user_id THEN
      RAISE EXCEPTION 'component person user_id % does not match reconciliation user_id %', v_person.user_id, v_rev.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ccsrc_insert ON "credit_card_statement_reconciliation_components";--> statement-breakpoint

CREATE TRIGGER trg_guard_ccsrc_insert
BEFORE INSERT ON "credit_card_statement_reconciliation_components"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ccsrc_insert();
