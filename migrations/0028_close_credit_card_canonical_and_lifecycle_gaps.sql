-- ============================================================================
-- Phase 10B-R2: Close Credit Card Canonical and Lifecycle Gaps
-- 1. Exact DB-bound canonical payload validation for liability event revisions
-- 2. Deferred trigger preventing orphan canonical liability revisions
-- 3. Exact DB-bound canonical payload validation & source asset rules for statement payment events
-- 4. REOPEN card ACTIVE validation and card->statement lock ordering
-- 5. Strict canonical payment transaction operation checks on PAID (CREATE) and REOPEN (VOID)
-- ============================================================================

-- ============================================================================
-- 1. HARDEN LIABILITY EVENT REVISION INSERT GUARD WITH EXACT CANONICAL BINDING
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_latest RECORD;
	v_can_tx RECORD;
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
		IF jsonb_typeof(v_can_rev.payload->'eventId') != 'string' OR
		   v_can_rev.payload->>'eventId' != NEW.event_id::text THEN
			RAISE EXCEPTION 'Canonical payload eventId % does not match liability event %',
				v_can_rev.payload->>'eventId', NEW.event_id;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'cardId') != 'string' OR
		   v_can_rev.payload->>'cardId' != v_event.credit_card_id::text THEN
			RAISE EXCEPTION 'Canonical payload cardId % does not match event cardId %',
				v_can_rev.payload->>'cardId', v_event.credit_card_id;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR
		   v_can_rev.payload->>'amount' != NEW.amount::text THEN
			RAISE EXCEPTION 'Canonical payload amount % does not match revision amount %',
				v_can_rev.payload->>'amount', NEW.amount;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'string' OR
		   v_can_rev.payload->>'purchaseCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload purchaseCategory % does not match revision category %',
				v_can_rev.payload->>'purchaseCategory', NEW.budget_category;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'purchaseDate') != 'string' OR
		   v_can_rev.payload->>'purchaseDate' != to_char(NEW.purchase_date, 'YYYY-MM-DD') THEN
			RAISE EXCEPTION 'Canonical payload purchaseDate % does not match revision date %',
				v_can_rev.payload->>'purchaseDate', NEW.purchase_date;
		END IF;

		-- Merchant binding
		IF NEW.merchant IS NULL THEN
			IF v_can_rev.payload->'merchant' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload merchant must be null when projection merchant is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'merchant') != 'string' OR
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
			IF jsonb_typeof(v_can_rev.payload->'description') != 'string' OR
			   v_can_rev.payload->>'description' != NEW.description THEN
				RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
					v_can_rev.payload->>'description', NEW.description;
			END IF;
		END IF;

		-- Installment count binding
		IF NEW.installment_count IS NULL THEN
			IF v_can_rev.payload->'installmentCount' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'installmentCount') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload installmentCount must be null when projection installmentCount is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'installmentCount') != 'number' OR
			   (v_can_rev.payload->>'installmentCount')::int != NEW.installment_count THEN
				RAISE EXCEPTION 'Canonical payload installmentCount % does not match revision installmentCount %',
					v_can_rev.payload->>'installmentCount', NEW.installment_count;
			END IF;
		END IF;

		-- Short term goal binding
		IF NEW.budget_category = 'SHORT_TERM_PURCHASE' THEN
			IF jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'string' THEN
				RAISE EXCEPTION 'SHORT_TERM_PURCHASE requires shortTermGoalId string in canonical payload';
			END IF;
			IF NOT EXISTS (
				SELECT 1 FROM short_term_goals
				WHERE id = (v_can_rev.payload->>'shortTermGoalId')::uuid
				  AND user_id = NEW.user_id
			) THEN
				RAISE EXCEPTION 'shortTermGoalId % not found for user %',
					v_can_rev.payload->>'shortTermGoalId', NEW.user_id;
			END IF;
		ELSE
			IF v_can_rev.payload->'shortTermGoalId' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'null' THEN
				RAISE EXCEPTION 'Non-SHORT_TERM_PURCHASE budget category must have null shortTermGoalId in canonical payload';
			END IF;
		END IF;

	ELSIF v_event.event_type = 'OPENING_BALANCE' THEN
		IF v_can_tx.kind != 'CREDIT_CARD_OPENING_BALANCE' THEN
			RAISE EXCEPTION 'OPENING_BALANCE canonical transaction must have kind CREDIT_CARD_OPENING_BALANCE, found %', v_can_tx.kind;
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
		IF jsonb_typeof(v_can_rev.payload->'eventId') != 'string' OR
		   v_can_rev.payload->>'eventId' != NEW.event_id::text THEN
			RAISE EXCEPTION 'Canonical payload eventId % does not match liability event %',
				v_can_rev.payload->>'eventId', NEW.event_id;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'cardId') != 'string' OR
		   v_can_rev.payload->>'cardId' != v_event.credit_card_id::text THEN
			RAISE EXCEPTION 'Canonical payload cardId % does not match event cardId %',
				v_can_rev.payload->>'cardId', v_event.credit_card_id;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR
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
			IF jsonb_typeof(v_can_rev.payload->'description') != 'string' OR
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

DROP TRIGGER IF EXISTS trg_guard_cc_liability_event_revision_insert ON "credit_card_liability_event_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_liability_event_revision_insert
BEFORE INSERT ON "credit_card_liability_event_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_liability_event_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 2. DEFERRED CONSTRAINT TRIGGER PREVENTING ORPHAN CANONICAL LIABILITY REVISIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_orphan_canonical_revision()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
BEGIN
	SELECT * INTO v_event FROM credit_card_liability_events WHERE canonical_transaction_id = NEW.transaction_id;
	IF FOUND THEN
		IF NOT EXISTS (
			SELECT 1 FROM credit_card_liability_event_revisions
			WHERE canonical_revision_id = NEW.id
			  AND operation = NEW.operation
		) THEN
			RAISE EXCEPTION 'No matching credit card liability event revision found for canonical revision % and operation %',
				NEW.id, NEW.operation;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_orphan_canonical_revision ON "transaction_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_orphan_canonical_revision
AFTER INSERT ON "transaction_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_orphan_canonical_revision();--> statement-breakpoint

-- ============================================================================
-- 3. HARDEN STATEMENT PAYMENT EVENT INSERT GUARD (CANONICAL BINDING & ASSET RULES)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_payment_event_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_stmt_rev RECORD;
	v_can_tx RECORD;
	v_can_rev RECORD;
	v_asset_acc RECORD;
	v_midas_ledger_id UUID;
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
		RAISE EXCEPTION 'Statement payment canonical transaction must have kind CREDIT_CARD_STATEMENT_PAYMENT, found %', v_can_tx.kind;
	END IF;

	-- Validate canonical CREATE revision payload
	SELECT * INTO v_can_rev
	FROM transaction_revisions
	WHERE transaction_id = NEW.canonical_transaction_id AND revision_no = 1;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical CREATE revision not found for transaction %', NEW.canonical_transaction_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'paymentEventId') != 'string' OR
	   v_can_rev.payload->>'paymentEventId' != NEW.id::text THEN
		RAISE EXCEPTION 'Payment canonical payload paymentEventId % does not match event id %',
			v_can_rev.payload->>'paymentEventId', NEW.id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'statementId') != 'string' OR
	   v_can_rev.payload->>'statementId' != NEW.statement_id::text THEN
		RAISE EXCEPTION 'Payment canonical payload statementId % does not match statement %',
			v_can_rev.payload->>'statementId', NEW.statement_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'cardId') != 'string' OR
	   v_can_rev.payload->>'cardId' != v_stmt.credit_card_id::text THEN
		RAISE EXCEPTION 'Payment canonical payload cardId % does not match statement cardId %',
			v_can_rev.payload->>'cardId', v_stmt.credit_card_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR
	   v_can_rev.payload->>'amount' != NEW.amount::text THEN
		RAISE EXCEPTION 'Payment canonical payload amount % does not match event amount %',
			v_can_rev.payload->>'amount', NEW.amount;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'paymentAssetAccountId') != 'string' OR
	   v_can_rev.payload->>'paymentAssetAccountId' != NEW.payment_asset_account_id::text THEN
		RAISE EXCEPTION 'Payment canonical payload paymentAssetAccountId % does not match event asset %',
			v_can_rev.payload->>'paymentAssetAccountId', NEW.payment_asset_account_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'reservePlacement') != 'string' OR
	   v_can_rev.payload->>'reservePlacement' != v_stmt_rev.reserve_placement THEN
		RAISE EXCEPTION 'Payment canonical payload reservePlacement % does not match statement reserve placement %',
			v_can_rev.payload->>'reservePlacement', v_stmt_rev.reserve_placement;
	END IF;

	-- Validate payment asset account
	SELECT * INTO v_asset_acc FROM ledger_accounts WHERE id = NEW.payment_asset_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Payment asset account % not found', NEW.payment_asset_account_id;
	END IF;
	IF v_asset_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Payment asset account user_id % does not match event user_id %', v_asset_acc.user_id, NEW.user_id;
	END IF;
	IF v_asset_acc.account_type != 'ASSET' OR v_asset_acc.normal_balance != 'DEBIT' THEN
		RAISE EXCEPTION 'Payment asset account % must be ASSET/DEBIT, found %/%',
			NEW.payment_asset_account_id, v_asset_acc.account_type, v_asset_acc.normal_balance;
	END IF;
	IF v_asset_acc.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot use archived asset account % for statement payment', NEW.payment_asset_account_id;
	END IF;

	-- Payment source rules: MIDAS_FUND vs OUTSIDE_MIDAS
	IF v_stmt_rev.reserve_placement = 'MIDAS_FUND' THEN
		SELECT ledger_account_id INTO v_midas_ledger_id
		FROM midas_accounts
		WHERE id = v_stmt.midas_account_id AND user_id = NEW.user_id;

		IF v_midas_ledger_id IS NULL OR NEW.payment_asset_account_id != v_midas_ledger_id THEN
			RAISE EXCEPTION 'MIDAS_FUND statement payment must use Midas physical ledger account %, found %',
				v_midas_ledger_id, NEW.payment_asset_account_id;
		END IF;
	ELSIF v_stmt_rev.reserve_placement = 'OUTSIDE_MIDAS' THEN
		IF EXISTS (SELECT 1 FROM midas_accounts WHERE ledger_account_id = NEW.payment_asset_account_id) THEN
			RAISE EXCEPTION 'OUTSIDE_MIDAS statement payment cannot use Midas physical ledger account %',
				NEW.payment_asset_account_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_stmt_payment_event_insert ON "credit_card_statement_payment_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_stmt_payment_event_insert
BEFORE INSERT ON "credit_card_statement_payment_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_stmt_payment_event_insert();--> statement-breakpoint

-- ============================================================================
-- 4. HARDEN STATEMENT REVISION INSERT GUARD (CARD ACTIVE & LOCK ORDER ON REOPEN)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_latest RECORD;
	v_card_rev RECORD;
	v_card_id UUID;
	v_card_lock RECORD;
	v_expected_stmt_date date;
	v_expected_due_date date;
BEGIN
	-- REOPEN specific lock ordering: lock credit_cards first, then statement
	IF NEW.operation = 'REOPEN' THEN
		SELECT credit_card_id INTO v_card_id FROM credit_card_statements WHERE id = NEW.statement_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card statement % not found', NEW.statement_id;
		END IF;

		SELECT * INTO v_card_lock FROM credit_cards WHERE id = v_card_id FOR UPDATE;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card % not found', v_card_id;
		END IF;

		SELECT status INTO v_card_rev
		FROM credit_card_revisions
		WHERE credit_card_id = v_card_id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF NOT FOUND OR v_card_rev.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Cannot REOPEN statement on non-active card %', v_card_id;
		END IF;
	END IF;

	-- Validate statement anchor exists, belongs to user, and lock FOR UPDATE
	SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card statement % not found', NEW.statement_id;
	END IF;
	IF v_stmt.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Statement user_id % does not match revision user_id %', v_stmt.user_id, NEW.user_id;
	END IF;

	-- Check current latest revision
	SELECT id, revision_no, status, statement_amount, statement_date, due_date, reserve_placement, note, payment_event_id
	INTO v_latest
	FROM credit_card_statement_revisions
	WHERE statement_id = NEW.statement_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Statement % already has revisions; revision 1 cannot be created again', NEW.statement_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'OPEN' THEN
			RAISE EXCEPTION 'First revision must have status OPEN, found %', NEW.status;
		END IF;
		IF NEW.payment_event_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have payment_event_id NULL';
		END IF;

		-- Fetch authoritative card configuration to verify exact statement and due dates
		SELECT r.statement_day, r.due_day, r.status INTO v_card_rev
		FROM credit_card_revisions r
		WHERE r.credit_card_id = v_stmt.credit_card_id
		ORDER BY r.revision_no DESC
		LIMIT 1;

		IF NOT FOUND OR v_card_rev.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Card % is not in ACTIVE status', v_stmt.credit_card_id;
		END IF;

		v_expected_stmt_date := cc_clamped_date(v_stmt.cycle_year, v_stmt.cycle_month, v_card_rev.statement_day);
		v_expected_due_date := cc_expected_due_date(v_expected_stmt_date, v_card_rev.due_day);

		IF NEW.statement_date != v_expected_stmt_date THEN
			RAISE EXCEPTION 'statement_date % does not match expected % for cycle %-% and statement_day %',
				NEW.statement_date, v_expected_stmt_date, v_stmt.cycle_year, v_stmt.cycle_month, v_card_rev.statement_day;
		END IF;

		IF NEW.due_date != v_expected_due_date THEN
			RAISE EXCEPTION 'due_date % does not match expected % for statement_date % and due_day %',
				NEW.due_date, v_expected_due_date, NEW.statement_date, v_card_rev.due_day;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for statement %', NEW.statement_id;
		END IF;
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of statement % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.statement_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID statement %', NEW.statement_id;
		END IF;

		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		ELSIF NEW.operation = 'UPDATE' THEN
			IF v_latest.status != 'OPEN' THEN
				RAISE EXCEPTION 'Cannot UPDATE statement when status is %, must be OPEN', v_latest.status;
			END IF;
			IF NEW.status != 'OPEN' THEN
				RAISE EXCEPTION 'UPDATE operation must retain OPEN status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS NOT NULL THEN
				RAISE EXCEPTION 'UPDATE operation must have payment_event_id NULL';
			END IF;
			IF NEW.statement_date != v_latest.statement_date OR NEW.due_date != v_latest.due_date THEN
				RAISE EXCEPTION 'UPDATE revision must preserve statement_date and due_date from predecessor';
			END IF;
		ELSIF NEW.operation = 'VOID' THEN
			IF v_latest.status != 'OPEN' THEN
				RAISE EXCEPTION 'Cannot VOID statement when status is %, must be OPEN', v_latest.status;
			END IF;
			IF NEW.status != 'VOID' THEN
				RAISE EXCEPTION 'VOID operation must set VOID status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS NOT NULL THEN
				RAISE EXCEPTION 'VOID operation must have payment_event_id NULL';
			END IF;
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'VOID revision must copy all snapshot fields exactly from predecessor';
			END IF;
		ELSIF NEW.operation = 'PAY' THEN
			IF v_latest.status != 'OPEN' THEN
				RAISE EXCEPTION 'Cannot PAY statement when status is %, must be OPEN', v_latest.status;
			END IF;
			IF NEW.status != 'PAID' THEN
				RAISE EXCEPTION 'PAY operation must set PAID status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS NULL THEN
				RAISE EXCEPTION 'PAY operation requires non-null payment_event_id';
			END IF;
			-- Obligation snapshot must remain identical
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'PAY revision must copy all obligation snapshot fields exactly from predecessor';
			END IF;
		ELSIF NEW.operation = 'REOPEN' THEN
			IF v_latest.status != 'PAID' THEN
				RAISE EXCEPTION 'Cannot REOPEN statement when status is %, must be PAID', v_latest.status;
			END IF;
			IF NEW.status != 'OPEN' THEN
				RAISE EXCEPTION 'REOPEN operation must set OPEN status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS DISTINCT FROM v_latest.payment_event_id THEN
				RAISE EXCEPTION 'REOPEN operation must reference the payment_event_id being reversed';
			END IF;
			-- Obligation snapshot must remain identical
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'REOPEN revision must copy all obligation snapshot fields exactly from predecessor';
			END IF;
		ELSE
			RAISE EXCEPTION 'Invalid statement operation %', NEW.operation;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_stmt_revision_insert ON "credit_card_statement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_stmt_revision_insert
BEFORE INSERT ON "credit_card_statement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_stmt_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 5. HARDEN DEFERRED STATEMENT RESERVE & PAYMENT INVARIANT (CREATE on PAID, VOID on REOPEN)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_reserve_invariant()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_latest_rev RECORD;
	v_bucket_balance NUMERIC;
	v_pay_event RECORD;
	v_binding RECORD;
	v_can_tx RECORD;
	v_liability_acc_id UUID;
	v_cr_line RECORD;
	v_dr_line RECORD;
	v_line_count INT;
BEGIN
	-- Determine statement_id depending on table
	IF TG_TABLE_NAME = 'credit_card_statement_revisions' THEN
		SELECT cs.id, cs.credit_card_id, cs.midas_reserve_bucket_id, cs.midas_account_id, cs.user_id
		INTO v_stmt
		FROM credit_card_statements cs
		WHERE cs.id = NEW.statement_id;
	ELSIF TG_TABLE_NAME = 'midas_allocation_transfers' THEN
		SELECT cs.id, cs.credit_card_id, cs.midas_reserve_bucket_id, cs.midas_account_id, cs.user_id
		INTO v_stmt
		FROM credit_card_statements cs
		WHERE cs.midas_reserve_bucket_id IN (NEW.from_bucket_id, NEW.to_bucket_id)
		LIMIT 1;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;
	ELSE
		RETURN NULL;
	END IF;

	IF v_stmt.id IS NULL THEN
		RETURN NULL;
	END IF;

	-- Fetch latest revision for this statement
	SELECT r.id, r.revision_no, r.operation, r.status, r.statement_amount, r.reserve_placement, r.payment_event_id
	INTO v_latest_rev
	FROM credit_card_statement_revisions r
	WHERE r.statement_id = v_stmt.id
	ORDER BY r.revision_no DESC
	LIMIT 1;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	-- Compute current reserve bucket balance
	SELECT COALESCE(SUM(CASE
		WHEN to_bucket_id = v_stmt.midas_reserve_bucket_id THEN amount
		WHEN from_bucket_id = v_stmt.midas_reserve_bucket_id THEN -amount
		ELSE 0
	END), 0)
	INTO v_bucket_balance
	FROM midas_allocation_transfers
	WHERE midas_account_id = v_stmt.midas_account_id;

	-- Invariants based on latest status
	IF v_latest_rev.status = 'VOID' THEN
		IF v_bucket_balance != 0 THEN
			RAISE EXCEPTION 'VOID statement % must have reserve bucket balance 0, found %',
				v_stmt.id, v_bucket_balance;
		END IF;
	ELSIF v_latest_rev.status = 'PAID' THEN
		IF v_bucket_balance != 0 THEN
			RAISE EXCEPTION 'PAID statement % must have reserve bucket balance 0, found %',
				v_stmt.id, v_bucket_balance;
		END IF;

		-- Validate payment event & canonical transaction
		SELECT * INTO v_pay_event FROM credit_card_statement_payment_events WHERE id = v_latest_rev.payment_event_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Payment event % not found for PAID statement %', v_latest_rev.payment_event_id, v_stmt.id;
		END IF;
		IF v_pay_event.statement_id != v_stmt.id THEN
			RAISE EXCEPTION 'Payment event statement_id % does not match statement %', v_pay_event.statement_id, v_stmt.id;
		END IF;
		IF v_pay_event.amount != v_latest_rev.statement_amount THEN
			RAISE EXCEPTION 'Payment event amount % does not match statement amount %', v_pay_event.amount, v_latest_rev.statement_amount;
		END IF;

		SELECT ledger_account_id INTO v_liability_acc_id
		FROM credit_card_ledger_links
		WHERE credit_card_id = v_stmt.credit_card_id;

		-- Check latest revision of canonical payment transaction - MUST BE CREATE
		SELECT tr.id, tr.operation INTO v_can_tx
		FROM transaction_revisions tr
		WHERE tr.transaction_id = v_pay_event.canonical_transaction_id
		ORDER BY tr.revision_no DESC
		LIMIT 1;

		IF NOT FOUND OR v_can_tx.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical payment transaction % latest operation must be CREATE for PAID statement %, found %',
				v_pay_event.canonical_transaction_id, v_stmt.id, v_can_tx.operation;
		END IF;

		SELECT * INTO v_binding
		FROM transaction_ledger_bindings
		WHERE revision_id = v_can_tx.id;

		IF NOT FOUND OR v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Applied journal entry missing for payment canonical revision %', v_can_tx.id;
		END IF;

		-- Verify journal lines: Dr card liability, Cr payment asset
		SELECT COUNT(*) INTO v_line_count
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Payment journal entry % must have exactly 2 lines, found %',
				v_binding.applied_journal_entry_id, v_line_count;
		END IF;

		SELECT * INTO v_dr_line
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id AND account_id = v_liability_acc_id;
		IF NOT FOUND OR v_dr_line.debit != v_latest_rev.statement_amount OR v_dr_line.credit != 0.00 THEN
			RAISE EXCEPTION 'Payment journal entry % must debit card liability account % with exact amount %',
				v_binding.applied_journal_entry_id, v_liability_acc_id, v_latest_rev.statement_amount;
		END IF;

		SELECT * INTO v_cr_line
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id AND account_id = v_pay_event.payment_asset_account_id;
		IF NOT FOUND OR v_cr_line.credit != v_latest_rev.statement_amount OR v_cr_line.debit != 0.00 THEN
			RAISE EXCEPTION 'Payment journal entry % must credit payment asset account % with exact amount %',
				v_binding.applied_journal_entry_id, v_pay_event.payment_asset_account_id, v_latest_rev.statement_amount;
		END IF;
	ELSIF v_latest_rev.status = 'OPEN' THEN
		IF v_latest_rev.reserve_placement = 'MIDAS_FUND' THEN
			IF v_bucket_balance != v_latest_rev.statement_amount THEN
				RAISE EXCEPTION 'OPEN MIDAS_FUND statement % must have reserve bucket balance exactly %, found %',
					v_stmt.id, v_latest_rev.statement_amount, v_bucket_balance;
			END IF;
		ELSIF v_latest_rev.reserve_placement = 'OUTSIDE_MIDAS' THEN
			IF v_bucket_balance != 0 THEN
				RAISE EXCEPTION 'OPEN OUTSIDE_MIDAS statement % must have reserve bucket balance 0, found %',
					v_stmt.id, v_bucket_balance;
			END IF;
		END IF;

		IF v_latest_rev.operation = 'REOPEN' THEN
			-- Check that the payment canonical transaction has been VOIDED with reversal journal entry
			SELECT * INTO v_pay_event FROM credit_card_statement_payment_events WHERE id = v_latest_rev.payment_event_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Payment event % not found for REOPEN statement %', v_latest_rev.payment_event_id, v_stmt.id;
			END IF;

			SELECT tr.id, tr.operation INTO v_can_tx
			FROM transaction_revisions tr
			WHERE tr.transaction_id = v_pay_event.canonical_transaction_id
			ORDER BY tr.revision_no DESC
			LIMIT 1;

			IF NOT FOUND OR v_can_tx.operation != 'VOID' THEN
				RAISE EXCEPTION 'Canonical payment transaction % must be VOIDED for REOPEN statement %',
					v_pay_event.canonical_transaction_id, v_stmt.id;
			END IF;

			SELECT * INTO v_binding
			FROM transaction_ledger_bindings
			WHERE revision_id = v_can_tx.id;

			IF NOT FOUND OR v_binding.reversal_journal_entry_id IS NULL THEN
				RAISE EXCEPTION 'Reversal journal entry missing for VOID payment revision %', v_can_tx.id;
			END IF;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_reserve_invariant_on_stmt_rev ON "credit_card_statement_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_reserve_invariant_on_stmt_rev
AFTER INSERT ON "credit_card_statement_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_reserve_invariant();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_reserve_invariant_on_transfers ON "midas_allocation_transfers";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_reserve_invariant_on_transfers
AFTER INSERT ON "midas_allocation_transfers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_reserve_invariant();
