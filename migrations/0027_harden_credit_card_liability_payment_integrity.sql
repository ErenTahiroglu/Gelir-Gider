-- ============================================================================
-- Phase 10B-R1: Harden Credit Card Liability Payment Integrity
-- 1. Deferred commit-time trigger ensuring Credit Card Liability accounts never end in negative balance
-- 2. Refined canonical payload validation and projection binding for liability event revisions
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_non_negative()
RETURNS TRIGGER AS $$
DECLARE
	v_is_cc_liability BOOLEAN;
	v_balance NUMERIC;
BEGIN
	SELECT EXISTS(
		SELECT 1 FROM credit_card_ledger_links WHERE ledger_account_id = NEW.account_id
	) INTO v_is_cc_liability;

	IF v_is_cc_liability THEN
		SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0.00)
		INTO v_balance
		FROM journal_lines jl
		JOIN journal_entries je ON jl.journal_entry_id = je.id
		WHERE jl.account_id = NEW.account_id
		  AND je.status = 'POSTED';

		IF v_balance < 0.00 THEN
			RAISE EXCEPTION 'Credit card liability account % balance cannot be negative, current balance is %',
				NEW.account_id, v_balance;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_non_negative ON "journal_lines";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_liability_non_negative
AFTER INSERT ON "journal_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_liability_non_negative();--> statement-breakpoint

-- ============================================================================
-- REFINED LIABILITY EVENT REVISION INSERT GUARD WITH STRICT CANONICAL CHECK
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_expected_purchase_date date;
BEGIN
	-- Lock liability event anchor FOR UPDATE
	SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.event_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Liability event % not found', NEW.event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Event user_id % does not match revision user_id %', v_event.user_id, NEW.user_id;
	END IF;

	-- Verify canonical revision
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id % does not match revision user_id %', v_can_rev.user_id, NEW.user_id;
	END IF;
	IF v_can_rev.transaction_id != v_event.canonical_transaction_id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match event canonical_transaction_id %',
			v_can_rev.transaction_id, v_event.canonical_transaction_id;
	END IF;
	IF v_can_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Canonical revision operation % does not match projection operation %',
			v_can_rev.operation, NEW.operation;
	END IF;

	-- Check latest projection revision
	SELECT id, revision_no, operation, amount, budget_category, merchant, description, installment_count, purchase_date
	INTO v_latest
	FROM credit_card_liability_event_revisions
	WHERE event_id = NEW.event_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Event % already has revisions; revision 1 cannot be created again', NEW.event_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for event %', NEW.event_id;
		END IF;
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of event % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.event_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID event %', NEW.event_id;
		END IF;

		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
	END IF;

	-- Validate field rules according to event_type
	IF v_event.event_type = 'PURCHASE' THEN
		IF NEW.budget_category IS NULL THEN
			RAISE EXCEPTION 'PURCHASE revision requires budget_category';
		END IF;
		IF NEW.purchase_date IS NULL THEN
			RAISE EXCEPTION 'PURCHASE revision requires purchase_date';
		END IF;
		v_expected_purchase_date := (NEW.occurred_at AT TIME ZONE 'Europe/Istanbul')::date;
		IF NEW.purchase_date != v_expected_purchase_date THEN
			RAISE EXCEPTION 'purchase_date % must match Istanbul date % from occurred_at %',
				NEW.purchase_date, v_expected_purchase_date, NEW.occurred_at;
		END IF;
	ELSIF v_event.event_type = 'OPENING_BALANCE' THEN
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have budget_category NULL';
		END IF;
		IF NEW.purchase_date IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have purchase_date NULL';
		END IF;
		IF NEW.installment_count IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have installment_count NULL';
		END IF;
		IF NEW.merchant IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have merchant NULL';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_event_revision_insert ON "credit_card_liability_event_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_liability_event_revision_insert
BEFORE INSERT ON "credit_card_liability_event_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_liability_event_revision_insert();