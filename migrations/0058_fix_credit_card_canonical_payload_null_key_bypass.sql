-- ============================================================================
-- Phase 19: Fix nullable-equality bypass in credit card canonical payload
-- binding guards (migration 0029)
--
-- Bug: every "exact canonical payload binding" check in
-- trg_fn_guard_cc_liability_event_revision_insert and
-- trg_fn_guard_cc_stmt_payment_event_insert used the pattern
--   IF jsonb_typeof(payload->'x') != 'string' OR payload->>'x' != NEW.col THEN RAISE
-- jsonb `->` returns SQL NULL when the key is entirely absent (not merely
-- JSON null). jsonb_typeof(NULL) is NULL, so both sides of the OR evaluate to
-- NULL, NULL OR NULL is NULL, and PL/pgSQL treats a NULL IF condition as
-- FALSE -- the guard silently PASSES instead of raising when a required key
-- is missing from the payload entirely. This defeats the exact-binding
-- invariant these triggers exist to enforce. Not reachable through current
-- application code (which always populates these keys), but a defense-in-
-- depth gap that must be closed since it would silently accept a
-- non-conforming canonical payload if ever reached.
--
-- Fix: wrap every jsonb_typeof(...) call in this binding-check pattern with
-- COALESCE(..., '') so a missing key evaluates to the sentinel '' (never
-- matching 'string'/'number'), making the left side of the OR TRUE (not
-- NULL) and guaranteeing the RAISE fires. No other behavior changes.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_latest RECORD;
	v_can_tx RECORD;
	v_can_rev RECORD;
	v_expected_purchase_date date;
	v_invalid_key TEXT;
BEGIN
	-- Lock liability event anchor FOR UPDATE
	SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.event_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Liability event % not found', NEW.event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Event user_id % does not match revision user_id %', v_event.user_id, NEW.user_id;
	END IF;

	-- Fetch canonical transaction
	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_event.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found for event %', v_event.canonical_transaction_id, NEW.event_id;
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

	-- Occurred-at binding for CREATE and UPDATE
	IF NEW.operation IN ('CREATE', 'UPDATE') THEN
		IF NEW.occurred_at != v_can_rev.occurred_at THEN
			RAISE EXCEPTION 'Projection occurred_at % must match canonical revision occurred_at %',
				NEW.occurred_at, v_can_rev.occurred_at;
		END IF;
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

	-- Validate field rules and canonical JSON payload according to event_type
	IF v_event.event_type = 'PURCHASE' THEN
		IF v_can_tx.kind != 'CREDIT_CARD_PURCHASE' THEN
			RAISE EXCEPTION 'PURCHASE canonical transaction must have kind CREDIT_CARD_PURCHASE, found %', v_can_tx.kind;
		END IF;

		-- Key set whitelisting
		SELECT k INTO v_invalid_key
		FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN (
			'eventId', 'cardId', 'amount', 'purchaseCategory',
			'shortTermGoalId', 'merchant', 'description',
			'installmentCount', 'purchaseDate'
		)
		LIMIT 1;

		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in CREDIT_CARD_PURCHASE canonical payload', v_invalid_key;
		END IF;

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

		-- Exact canonical payload binding: eventId, cardId, amount, purchaseCategory, purchaseDate
		-- (COALESCE guards against a missing key producing a NULL-vs-NULL IF that silently passes)
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'eventId'), '') != 'string' OR
		   v_can_rev.payload->>'eventId' != NEW.event_id::text THEN
			RAISE EXCEPTION 'Canonical payload eventId % does not match liability event %',
				v_can_rev.payload->>'eventId', NEW.event_id;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'cardId'), '') != 'string' OR
		   v_can_rev.payload->>'cardId' != v_event.credit_card_id::text THEN
			RAISE EXCEPTION 'Canonical payload cardId % does not match event cardId %',
				v_can_rev.payload->>'cardId', v_event.credit_card_id;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'amount'), '') != 'string' OR
		   v_can_rev.payload->>'amount' != NEW.amount::text THEN
			RAISE EXCEPTION 'Canonical payload amount % does not match revision amount %',
				v_can_rev.payload->>'amount', NEW.amount;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'purchaseCategory'), '') != 'string' OR
		   v_can_rev.payload->>'purchaseCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload purchaseCategory % does not match revision budget_category %',
				v_can_rev.payload->>'purchaseCategory', NEW.budget_category;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'purchaseDate'), '') != 'string' OR
		   v_can_rev.payload->>'purchaseDate' != NEW.purchase_date::text THEN
			RAISE EXCEPTION 'Canonical payload purchaseDate % does not match revision purchase_date %',
				v_can_rev.payload->>'purchaseDate', NEW.purchase_date;
		END IF;

		-- Merchant binding
		IF NEW.merchant IS NULL THEN
			IF v_can_rev.payload->'merchant' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload merchant must be null when projection merchant is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'merchant'), '') != 'string' OR
			   v_can_rev.payload->>'merchant' != NEW.merchant THEN
				RAISE EXCEPTION 'Canonical payload merchant % does not match revision merchant %',
					v_can_rev.payload->>'merchant', NEW.merchant;
			END IF;
		END IF;

		-- Description binding
		IF NEW.description IS NULL THEN
			IF v_can_rev.payload->'description' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload description must be null when projection description is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'string' OR
			   v_can_rev.payload->>'description' != NEW.description THEN
				RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
					v_can_rev.payload->>'description', NEW.description;
			END IF;
		END IF;

		-- Installment count binding
		IF NEW.installment_count IS NULL THEN
			IF v_can_rev.payload->'installmentCount' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'installmentCount') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload installmentCount must be null when projection installment_count is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'installmentCount'), '') != 'number' OR
			   (v_can_rev.payload->>'installmentCount')::int != NEW.installment_count THEN
				RAISE EXCEPTION 'Canonical payload installmentCount % does not match revision installment_count %',
					v_can_rev.payload->>'installmentCount', NEW.installment_count;
			END IF;
		END IF;

	ELSIF v_event.event_type = 'OPENING_BALANCE' THEN
		IF v_can_tx.kind != 'CREDIT_CARD_OPENING_BALANCE' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical transaction must have kind CREDIT_CARD_OPENING_BALANCE, found %', v_can_tx.kind;
		END IF;

		-- Key set whitelisting
		SELECT k INTO v_invalid_key
		FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('eventId', 'cardId', 'amount', 'description')
		LIMIT 1;

		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in CREDIT_CARD_OPENING_BALANCE canonical payload', v_invalid_key;
		END IF;

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

		-- Exact canonical payload binding: eventId, cardId, amount
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'eventId'), '') != 'string' OR
		   v_can_rev.payload->>'eventId' != NEW.event_id::text THEN
			RAISE EXCEPTION 'Canonical payload eventId % does not match liability event %',
				v_can_rev.payload->>'eventId', NEW.event_id;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'cardId'), '') != 'string' OR
		   v_can_rev.payload->>'cardId' != v_event.credit_card_id::text THEN
			RAISE EXCEPTION 'Canonical payload cardId % does not match event cardId %',
				v_can_rev.payload->>'cardId', v_event.credit_card_id;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'amount'), '') != 'string' OR
		   v_can_rev.payload->>'amount' != NEW.amount::text THEN
			RAISE EXCEPTION 'Canonical payload amount % does not match revision amount %',
				v_can_rev.payload->>'amount', NEW.amount;
		END IF;

		-- Description binding
		IF NEW.description IS NULL THEN
			IF v_can_rev.payload->'description' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload description must be null when projection description is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'string' OR
			   v_can_rev.payload->>'description' != NEW.description THEN
				RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
					v_can_rev.payload->>'description', NEW.description;
			END IF;
		END IF;

		-- Purchase-only fields must be null/absent
		IF v_can_rev.payload->'purchaseCategory' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'null' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical payload cannot contain purchaseCategory';
		END IF;
		IF v_can_rev.payload->'purchaseDate' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'purchaseDate') != 'null' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical payload cannot contain purchaseDate';
		END IF;
		IF v_can_rev.payload->'installmentCount' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'installmentCount') != 'null' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical payload cannot contain installmentCount';
		END IF;
		IF v_can_rev.payload->'merchant' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical payload cannot contain merchant';
		END IF;
		IF v_can_rev.payload->'shortTermGoalId' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'null' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical payload cannot contain shortTermGoalId';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_payment_event_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_stmt_rev RECORD;
	v_can_tx RECORD;
	v_can_rev RECORD;
	v_asset_acc RECORD;
	v_midas_ledger_id UUID;
	v_user_currency TEXT;
	v_invalid_key TEXT;
BEGIN
	-- Validate statement exists, belongs to user, and lock statement FOR UPDATE
	SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Statement % not found', NEW.statement_id;
	END IF;
	IF v_stmt.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Statement user_id % does not match payment event user_id %', v_stmt.user_id, NEW.user_id;
	END IF;

	-- Fetch latest statement revision (must be OPEN)
	SELECT * INTO v_stmt_rev
	FROM credit_card_statement_revisions
	WHERE statement_id = NEW.statement_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NOT FOUND OR v_stmt_rev.status != 'OPEN' THEN
		RAISE EXCEPTION 'Statement % must be in OPEN status to insert payment event', NEW.statement_id;
	END IF;

	-- Validate canonical transaction
	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = NEW.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', NEW.canonical_transaction_id;
	END IF;
	IF v_can_tx.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical transaction user_id % does not match payment event user_id %', v_can_tx.user_id, NEW.user_id;
	END IF;
	IF v_can_tx.kind != 'CREDIT_CARD_STATEMENT_PAYMENT' THEN
		RAISE EXCEPTION 'Canonical transaction kind must be CREDIT_CARD_STATEMENT_PAYMENT, found %', v_can_tx.kind;
	END IF;

	-- Validate canonical revision (revision 1 CREATE)
	SELECT * INTO v_can_rev
	FROM transaction_revisions
	WHERE transaction_id = NEW.canonical_transaction_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'No canonical revision found for payment canonical transaction %', NEW.canonical_transaction_id;
	END IF;
	IF v_can_rev.revision_no != 1 OR v_can_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical transaction for new payment event must have revision 1 CREATE, found rev % operation %',
			v_can_rev.revision_no, v_can_rev.operation;
	END IF;

	-- Occurred-at binding: payment event occurred_at must match canonical CREATE occurred_at
	IF NEW.occurred_at != v_can_rev.occurred_at THEN
		RAISE EXCEPTION 'Payment event occurred_at % does not match canonical revision occurred_at %',
			NEW.occurred_at, v_can_rev.occurred_at;
	END IF;

	-- Key set whitelisting for statement payment payload
	SELECT k INTO v_invalid_key
	FROM jsonb_object_keys(v_can_rev.payload) AS k
	WHERE k NOT IN (
		'paymentEventId', 'statementId', 'cardId', 'amount',
		'paymentAssetAccountId', 'reservePlacement'
	)
	LIMIT 1;

	IF v_invalid_key IS NOT NULL THEN
		RAISE EXCEPTION 'Unexpected key % in CREDIT_CARD_STATEMENT_PAYMENT canonical payload', v_invalid_key;
	END IF;

	-- Validate canonical payload fields
	-- (COALESCE guards against a missing key producing a NULL-vs-NULL IF that silently passes)
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'paymentEventId'), '') != 'string' OR
	   v_can_rev.payload->>'paymentEventId' != NEW.id::text THEN
		RAISE EXCEPTION 'Canonical payload paymentEventId % does not match payment event %',
			v_can_rev.payload->>'paymentEventId', NEW.id;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'statementId'), '') != 'string' OR
	   v_can_rev.payload->>'statementId' != NEW.statement_id::text THEN
		RAISE EXCEPTION 'Canonical payload statementId % does not match statement %',
			v_can_rev.payload->>'statementId', NEW.statement_id;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'cardId'), '') != 'string' OR
	   v_can_rev.payload->>'cardId' != v_stmt.credit_card_id::text THEN
		RAISE EXCEPTION 'Canonical payload cardId % does not match statement cardId %',
			v_can_rev.payload->>'cardId', v_stmt.credit_card_id;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'amount'), '') != 'string' OR
	   v_can_rev.payload->>'amount' != NEW.amount::text THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match payment event amount %',
			v_can_rev.payload->>'amount', NEW.amount;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'paymentAssetAccountId'), '') != 'string' OR
	   v_can_rev.payload->>'paymentAssetAccountId' != NEW.payment_asset_account_id::text THEN
		RAISE EXCEPTION 'Canonical payload paymentAssetAccountId % does not match payment event asset %',
			v_can_rev.payload->>'paymentAssetAccountId', NEW.payment_asset_account_id;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'reservePlacement'), '') != 'string' OR
	   v_can_rev.payload->>'reservePlacement' != v_stmt_rev.reserve_placement THEN
		RAISE EXCEPTION 'Canonical payload reservePlacement % does not match statement reserve placement %',
			v_can_rev.payload->>'reservePlacement', v_stmt_rev.reserve_placement;
	END IF;

	-- Validate payment asset account rules
	SELECT * INTO v_asset_acc FROM ledger_accounts WHERE id = NEW.payment_asset_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Payment asset account % not found', NEW.payment_asset_account_id;
	END IF;
	IF v_asset_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Payment asset account % belongs to different user', NEW.payment_asset_account_id;
	END IF;
	IF v_asset_acc.account_type != 'ASSET' OR v_asset_acc.normal_balance != 'DEBIT' THEN
		RAISE EXCEPTION 'Payment asset account % must be ASSET / DEBIT', NEW.payment_asset_account_id;
	END IF;
	IF v_asset_acc.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Payment asset account % is archived', NEW.payment_asset_account_id;
	END IF;

	-- Currency invariant check (ledger_accounts.currency = users.currency)
	SELECT currency INTO v_user_currency FROM users WHERE id = NEW.user_id;
	IF v_asset_acc.currency != v_user_currency THEN
		RAISE EXCEPTION 'Payment asset account % currency % must match user currency %',
			NEW.payment_asset_account_id, v_asset_acc.currency, v_user_currency;
	END IF;

	IF v_stmt_rev.reserve_placement = 'MIDAS_FUND' THEN
		SELECT ledger_account_id INTO v_midas_ledger_id
		FROM midas_accounts
		WHERE id = v_stmt.midas_account_id AND user_id = NEW.user_id;

		IF v_midas_ledger_id IS NULL THEN
			RAISE EXCEPTION 'Midas account % has no ledger account', v_stmt.midas_account_id;
		END IF;
		IF NEW.payment_asset_account_id != v_midas_ledger_id THEN
			RAISE EXCEPTION 'MIDAS_FUND statement payment must use Midas physical ledger account %, got %',
				v_midas_ledger_id, NEW.payment_asset_account_id;
		END IF;
	ELSIF v_stmt_rev.reserve_placement = 'OUTSIDE_MIDAS' THEN
		IF EXISTS (SELECT 1 FROM midas_accounts WHERE ledger_account_id = NEW.payment_asset_account_id) THEN
			RAISE EXCEPTION 'OUTSIDE_MIDAS statement payment cannot use Midas-linked ledger account %',
				NEW.payment_asset_account_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
