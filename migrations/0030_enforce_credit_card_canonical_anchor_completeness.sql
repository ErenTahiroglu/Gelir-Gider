-- ============================================================================
-- Phase 10B-R4: Enforce Credit Card Canonical Anchor Completeness
-- 1. Deferred constraint trigger on canonical_transactions (AFTER INSERT)
-- 2. Validates that CREDIT_CARD_PURCHASE, CREDIT_CARD_OPENING_BALANCE, and
--    CREDIT_CARD_STATEMENT_PAYMENT canonical anchors have required initial
--    revision, domain events, and domain projections at transaction COMMIT.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_canonical_transaction_anchors()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_liability_event RECORD;
	v_liability_rev RECORD;
	v_pay_event RECORD;
	v_stmt_rev RECORD;
BEGIN
	-- Only apply to Credit Card canonical transaction kinds
	IF NEW.kind NOT IN ('CREDIT_CARD_PURCHASE', 'CREDIT_CARD_OPENING_BALANCE', 'CREDIT_CARD_STATEMENT_PAYMENT') THEN
		RETURN NULL;
	END IF;

	-- 1. Must have an initial revision #1 with operation CREATE
	SELECT * INTO v_can_rev
	FROM transaction_revisions
	WHERE transaction_id = NEW.id AND revision_no = 1;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical % transaction % has no initial revision #1 at commit',
			NEW.kind, NEW.id;
	END IF;

	IF v_can_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical % transaction % revision #1 must have operation CREATE, found %',
			NEW.kind, NEW.id, v_can_rev.operation;
	END IF;

	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical % transaction % user_id % does not match revision user_id %',
			NEW.kind, NEW.id, NEW.user_id, v_can_rev.user_id;
	END IF;

	IF NEW.kind = 'CREDIT_CARD_PURCHASE' THEN
		-- 2. Must have liability event with event_type = 'PURCHASE'
		SELECT * INTO v_liability_event
		FROM credit_card_liability_events
		WHERE canonical_transaction_id = NEW.id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_PURCHASE transaction % has no linked credit_card_liability_events anchor at commit',
				NEW.id;
		END IF;

		IF v_liability_event.event_type != 'PURCHASE' THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_PURCHASE transaction % linked liability event % has invalid event_type %',
				NEW.id, v_liability_event.id, v_liability_event.event_type;
		END IF;

		-- 3. Must have matching liability event revision linked to canonical revision #1 with operation CREATE
		SELECT * INTO v_liability_rev
		FROM credit_card_liability_event_revisions
		WHERE canonical_revision_id = v_can_rev.id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_PURCHASE transaction % revision % has no linked credit_card_liability_event_revisions row at commit',
				NEW.id, v_can_rev.id;
		END IF;

		IF v_liability_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_PURCHASE transaction % liability revision % must have operation CREATE, found %',
				NEW.id, v_liability_rev.id, v_liability_rev.operation;
		END IF;

	ELSIF NEW.kind = 'CREDIT_CARD_OPENING_BALANCE' THEN
		-- 2. Must have liability event with event_type = 'OPENING_BALANCE'
		SELECT * INTO v_liability_event
		FROM credit_card_liability_events
		WHERE canonical_transaction_id = NEW.id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_OPENING_BALANCE transaction % has no linked credit_card_liability_events anchor at commit',
				NEW.id;
		END IF;

		IF v_liability_event.event_type != 'OPENING_BALANCE' THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_OPENING_BALANCE transaction % linked liability event % has invalid event_type %',
				NEW.id, v_liability_event.id, v_liability_event.event_type;
		END IF;

		-- 3. Must have matching liability event revision linked to canonical revision #1 with operation CREATE
		SELECT * INTO v_liability_rev
		FROM credit_card_liability_event_revisions
		WHERE canonical_revision_id = v_can_rev.id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_OPENING_BALANCE transaction % revision % has no linked credit_card_liability_event_revisions row at commit',
				NEW.id, v_can_rev.id;
		END IF;

		IF v_liability_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_OPENING_BALANCE transaction % liability revision % must have operation CREATE, found %',
				NEW.id, v_liability_rev.id, v_liability_rev.operation;
		END IF;

	ELSIF NEW.kind = 'CREDIT_CARD_STATEMENT_PAYMENT' THEN
		-- 2. Must have statement payment event
		SELECT * INTO v_pay_event
		FROM credit_card_statement_payment_events
		WHERE canonical_transaction_id = NEW.id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_STATEMENT_PAYMENT transaction % has no linked credit_card_statement_payment_events anchor at commit',
				NEW.id;
		END IF;

		-- 3. Must have statement revision referencing this payment event with operation PAY and status PAID
		SELECT * INTO v_stmt_rev
		FROM credit_card_statement_revisions
		WHERE payment_event_id = v_pay_event.id AND operation = 'PAY' AND status = 'PAID';

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical CREDIT_CARD_STATEMENT_PAYMENT transaction % has no companion PAID statement revision at commit',
				NEW.id;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_canonical_transaction_anchors ON "canonical_transactions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_canonical_transaction_anchors
AFTER INSERT ON "canonical_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_canonical_transaction_anchors();
