-- Custom SQL migration: 0059_harden_remaining_database_null_semantics
-- Hardens remaining database triggers against SQL-NULL fail-open evaluation in PL/pgSQL IF predicates.
-- Enforces fail-closed evaluation for required and optional JSON payload keys across:
--   1. trg_fn_guard_person_obligation_revision_insert
--   2. trg_fn_guard_person_settlement_revision_insert
--   3. trg_fn_guard_person_obligation_ledger_effect
--   4. trg_fn_guard_cc_split_commit_check
--   5. trg_fn_guard_reward_event_revision_insert
--   6. trg_fn_long_term_validate_send_payload
--   7. trg_fn_notification_validate_credit_card_due_payload
--   8. trg_fn_guard_campaign_review_candidate_revision_insert

-- 1. trg_fn_guard_person_obligation_revision_insert
CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation_peek RECORD;
	v_latest_person_status TEXT;
	v_obligation RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_active_settled NUMERIC;
	v_funding_account RECORD;
	v_user_currency VARCHAR(3);
	v_split_rev RECORD;
	v_split RECORD;
	v_expense_account RECORD;
	v_expected_role TEXT;
	v_system_account_id UUID;
BEGIN
	-- Pre-read the immutable obligation anchor
	SELECT * INTO v_obligation_peek FROM person_obligations WHERE id = NEW.obligation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person obligation % not found', NEW.obligation_id;
	END IF;
	IF v_obligation_peek.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Obligation user_id % does not match revision user_id %', v_obligation_peek.user_id, NEW.user_id;
	END IF;

	-- Lock order: person first.
	PERFORM 1 FROM people WHERE id = v_obligation_peek.person_id FOR UPDATE;

	SELECT status INTO v_latest_person_status
	FROM person_revisions
	WHERE person_id = v_obligation_peek.person_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_person_status IS DISTINCT FROM 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot mutate obligation for archived or unknown person %', v_obligation_peek.person_id;
	END IF;

	-- Then obligation.
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id FOR UPDATE;

	-- Canonical revision binding
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id % does not match revision user_id %', v_can_rev.user_id, NEW.user_id;
	END IF;
	IF v_can_rev.transaction_id != v_obligation.canonical_transaction_id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match obligation canonical_transaction_id %',
			v_can_rev.transaction_id, v_obligation.canonical_transaction_id;
	END IF;
	IF v_can_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Canonical revision operation % does not match projection operation %',
			v_can_rev.operation, NEW.operation;
	END IF;
	IF NEW.occurred_at != v_can_rev.occurred_at THEN
		RAISE EXCEPTION 'Projection occurred_at % must match canonical revision occurred_at %',
			NEW.occurred_at, v_can_rev.occurred_at;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
	END IF;

	IF v_obligation.direction = 'RECEIVABLE' THEN
		IF v_can_tx.kind NOT IN ('PERSON_RECEIVABLE_ADVANCE', 'CREDIT_CARD_PURCHASE_SPLIT') THEN
			RAISE EXCEPTION 'Obligation direction RECEIVABLE requires canonical kind PERSON_RECEIVABLE_ADVANCE or CREDIT_CARD_PURCHASE_SPLIT, found %',
				v_can_tx.kind;
		END IF;
	ELSE
		IF v_can_tx.kind != 'PERSON_PAYABLE_EXPENSE' THEN
			RAISE EXCEPTION 'Obligation direction PAYABLE requires canonical kind PERSON_PAYABLE_EXPENSE, found %',
				v_can_tx.kind;
		END IF;
	END IF;

	-- Chain integrity
	SELECT id, revision_no, operation, principal_amount, funding_asset_account_id, budget_category, due_date, description
	INTO v_latest
	FROM person_obligation_revisions
	WHERE obligation_id = NEW.obligation_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Obligation % already has revisions; revision 1 cannot be created again', NEW.obligation_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for obligation %', NEW.obligation_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of obligation % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.obligation_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID obligation %', NEW.obligation_id;
		END IF;
		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
	END IF;

	-- Direction/kind-specific field consistency
	IF v_can_tx.kind = 'PERSON_RECEIVABLE_ADVANCE' THEN
		IF NEW.funding_asset_account_id IS NULL THEN
			RAISE EXCEPTION 'RECEIVABLE obligation revision requires funding_asset_account_id';
		END IF;
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'RECEIVABLE obligation revision must have budget_category NULL';
		END IF;

		SELECT * INTO v_funding_account FROM ledger_accounts WHERE id = NEW.funding_asset_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Funding asset account % not found', NEW.funding_asset_account_id;
		END IF;
		IF v_funding_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Funding asset account % belongs to a different user', NEW.funding_asset_account_id;
		END IF;
		IF v_funding_account.account_type != 'ASSET' OR v_funding_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Funding asset account % must be ASSET/DEBIT', NEW.funding_asset_account_id;
		END IF;

		SELECT currency INTO v_user_currency FROM users WHERE id = NEW.user_id;
		IF v_funding_account.currency != v_user_currency THEN
			RAISE EXCEPTION 'Funding asset account % currency does not match user currency', NEW.funding_asset_account_id;
		END IF;

		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'fundingAssetAccountId', 'dueDate', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in PERSON_RECEIVABLE_ADVANCE canonical payload', v_invalid_key;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'fundingAssetAccountId'), '') != 'string' OR
		   v_can_rev.payload->>'fundingAssetAccountId' != NEW.funding_asset_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload fundingAssetAccountId % does not match revision %',
				v_can_rev.payload->>'fundingAssetAccountId', NEW.funding_asset_account_id;
		END IF;

	ELSIF v_can_tx.kind = 'CREDIT_CARD_PURCHASE_SPLIT' THEN
		IF NEW.funding_asset_account_id IS NOT NULL THEN
			RAISE EXCEPTION 'CREDIT_CARD_PURCHASE_SPLIT obligation revision must have funding_asset_account_id NULL';
		END IF;
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'CREDIT_CARD_PURCHASE_SPLIT obligation revision must have budget_category NULL';
		END IF;

		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'splitId', 'splitRevisionId', 'splitParticipantId', 'purchaseEventId', 'personId', 'direction', 'amount', 'expenseAccountId', 'dueDate', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in CREDIT_CARD_PURCHASE_SPLIT canonical payload', v_invalid_key;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'expenseAccountId'), '') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload expenseAccountId missing or not a string';
		END IF;

		SELECT * INTO v_expense_account FROM ledger_accounts WHERE id = (v_can_rev.payload->>'expenseAccountId')::uuid;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Expense account % not found', v_can_rev.payload->>'expenseAccountId';
		END IF;
		IF v_expense_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Expense account % belongs to a different user', v_expense_account.id;
		END IF;
		IF v_expense_account.account_type != 'EXPENSE' OR v_expense_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Expense account % must be EXPENSE/DEBIT', v_expense_account.id;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'splitRevisionId'), '') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload splitRevisionId missing or not a string';
		END IF;

		SELECT sr.*, per.budget_category AS purchase_budget_category
		INTO v_split_rev
		FROM credit_card_purchase_split_revisions sr
		JOIN credit_card_liability_event_revisions per ON per.id = sr.purchase_event_revision_id
		WHERE sr.id = (v_can_rev.payload->>'splitRevisionId')::uuid;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Split revision % referenced by canonical payload not found', v_can_rev.payload->>'splitRevisionId';
		END IF;

		v_expected_role := CASE COALESCE(v_split_rev.purchase_budget_category, 'UNCLASSIFIED')
			WHEN 'MANDATORY_EXPENSE' THEN 'MANDATORY_EXPENSE'
			WHEN 'DISCRETIONARY_SPEND' THEN 'DISCRETIONARY_EXPENSE'
			WHEN 'SHORT_TERM_PURCHASE' THEN 'SHORT_TERM_PURCHASE'
			WHEN 'UNCLASSIFIED' THEN 'UNCLASSIFIED_EXPENSE'
			ELSE NULL
		END;
		IF v_expected_role IS NULL THEN
			RAISE EXCEPTION 'Referenced purchase revision has unknown budget_category %', v_split_rev.purchase_budget_category;
		END IF;

		SELECT ledger_account_id INTO v_system_account_id
		FROM credit_card_system_accounts WHERE user_id = NEW.user_id AND role = v_expected_role;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'No system expense account provisioned for role % (user %)', v_expected_role, NEW.user_id;
		END IF;

		IF v_expense_account.id != v_system_account_id THEN
			RAISE EXCEPTION 'CREDIT_CARD_PURCHASE_SPLIT expenseAccountId % is not the authoritative system expense account % for budget_category %',
				v_expense_account.id, v_system_account_id, v_split_rev.purchase_budget_category;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'splitId'), '') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload splitId missing or not a string';
		END IF;
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'purchaseEventId'), '') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload purchaseEventId missing or not a string';
		END IF;
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'splitParticipantId'), '') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload splitParticipantId missing or not a string';
		END IF;

		SELECT * INTO v_split FROM credit_card_purchase_splits WHERE id = (v_can_rev.payload->>'splitId')::uuid;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Split % referenced by canonical payload not found', v_can_rev.payload->>'splitId';
		END IF;
		IF v_split.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Split % belongs to a different user', v_split.id;
		END IF;
		IF v_split.purchase_event_id::text != v_can_rev.payload->>'purchaseEventId' THEN
			RAISE EXCEPTION 'Split % purchase_event_id % does not match canonical payload purchaseEventId %',
				v_split.id, v_split.purchase_event_id, v_can_rev.payload->>'purchaseEventId';
		END IF;
		IF v_split_rev.split_id != v_split.id THEN
			RAISE EXCEPTION 'Split revision % belongs to split % not matching canonical payload splitId %',
				v_split_rev.id, v_split_rev.split_id, v_split.id;
		END IF;

	ELSIF v_can_tx.kind = 'PERSON_PAYABLE_EXPENSE' THEN
		IF NEW.budget_category IS NULL THEN
			RAISE EXCEPTION 'PAYABLE obligation revision requires budget_category';
		END IF;
		IF NEW.funding_asset_account_id IS NOT NULL THEN
			RAISE EXCEPTION 'PAYABLE obligation revision must have funding_asset_account_id NULL';
		END IF;

		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'budgetCategory', 'dueDate', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in PERSON_PAYABLE_EXPENSE canonical payload', v_invalid_key;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'budgetCategory'), '') != 'string' OR
		   v_can_rev.payload->>'budgetCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload budgetCategory % does not match revision %',
				v_can_rev.payload->>'budgetCategory', NEW.budget_category;
		END IF;
	END IF;

	-- Standard canonical payload bindings shared by all kinds (fail-closed)
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'obligationId'), '') != 'string' OR
	   v_can_rev.payload->>'obligationId' != NEW.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match obligation %',
			v_can_rev.payload->>'obligationId', NEW.obligation_id;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'personId'), '') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'direction'), '') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'amount'), '') != 'string' OR
	   v_can_rev.payload->>'amount' != NEW.principal_amount::text THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match revision principal_amount %',
			v_can_rev.payload->>'amount', NEW.principal_amount;
	END IF;

	IF NEW.due_date IS NULL THEN
		IF v_can_rev.payload->'dueDate' IS NOT NULL AND COALESCE(jsonb_typeof(v_can_rev.payload->'dueDate'), '') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload dueDate must be null when projection due_date is null';
		END IF;
	ELSE
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'dueDate'), '') != 'string' OR
			 v_can_rev.payload->>'dueDate' != NEW.due_date::text THEN
			RAISE EXCEPTION 'Canonical payload dueDate % does not match revision due_date %',
				v_can_rev.payload->>'dueDate', NEW.due_date;
		END IF;
	END IF;

	IF NEW.description IS NULL THEN
		IF v_can_rev.payload->'description' IS NOT NULL AND COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload description must be null when projection description is null';
		END IF;
	ELSE
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'string' OR
			 v_can_rev.payload->>'description' != NEW.description THEN
			RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
				v_can_rev.payload->>'description', NEW.description;
		END IF;
	END IF;

	-- Active settlement limit
	SELECT COALESCE(SUM(latest.applied_amount), 0) INTO v_active_settled
	FROM (
		SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
		FROM person_settlement_revisions psr
		JOIN person_settlements ps ON ps.id = psr.settlement_id
		WHERE ps.obligation_id = NEW.obligation_id
		ORDER BY psr.settlement_id, psr.revision_no DESC
	) latest
	WHERE latest.operation != 'VOID';

	IF NEW.operation = 'VOID' THEN
		IF v_active_settled != 0 THEN
			RAISE EXCEPTION 'Cannot VOID obligation % with active settled amount %', NEW.obligation_id, v_active_settled;
		END IF;
		IF NEW.principal_amount != v_latest.principal_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward previous principal_amount';
		END IF;
	ELSIF NEW.operation = 'UPDATE' THEN
		IF NEW.principal_amount < v_active_settled THEN
			RAISE EXCEPTION 'Cannot revise obligation % principal to % below active settled amount %',
				NEW.obligation_id, NEW.principal_amount, v_active_settled;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 2. trg_fn_guard_person_settlement_revision_insert
CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_settlement_peek RECORD;
	v_obligation_peek RECORD;
	v_latest_person_status TEXT;
	v_obligation RECORD;
	v_settlement RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_obl_latest RECORD;
	v_active_settled NUMERIC;
	v_income_receipt RECORD;
	v_income_link RECORD;
	v_income_source RECORD;
	v_income_can_tx RECORD;
	v_income_rev RECORD;
	v_income_latest_rev RECORD;
BEGIN
	-- Pre-read immutable anchors to resolve which person to lock first.
	SELECT * INTO v_settlement_peek FROM person_settlements WHERE id = NEW.settlement_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person settlement % not found', NEW.settlement_id;
	END IF;
	IF v_settlement_peek.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Settlement user_id % does not match revision user_id %', v_settlement_peek.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_obligation_peek FROM person_obligations WHERE id = v_settlement_peek.obligation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Obligation % not found for settlement %', v_settlement_peek.obligation_id, NEW.settlement_id;
	END IF;

	-- Lock order: person -> obligation -> settlement.
	PERFORM 1 FROM people WHERE id = v_obligation_peek.person_id FOR UPDATE;

	SELECT status INTO v_latest_person_status
	FROM person_revisions
	WHERE person_id = v_obligation_peek.person_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_person_status IS DISTINCT FROM 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot mutate settlement for archived or unknown person %', v_obligation_peek.person_id;
	END IF;

	SELECT * INTO v_obligation FROM person_obligations WHERE id = v_settlement_peek.obligation_id FOR UPDATE;
	SELECT * INTO v_settlement FROM person_settlements WHERE id = NEW.settlement_id FOR UPDATE;

	-- Canonical revision binding
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id % does not match revision user_id %', v_can_rev.user_id, NEW.user_id;
	END IF;
	IF v_can_rev.transaction_id != v_settlement.canonical_transaction_id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match settlement canonical_transaction_id %',
			v_can_rev.transaction_id, v_settlement.canonical_transaction_id;
	END IF;
	IF v_can_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Canonical revision operation % does not match projection operation %',
			v_can_rev.operation, NEW.operation;
	END IF;
	IF NEW.occurred_at != v_can_rev.occurred_at THEN
		RAISE EXCEPTION 'Projection occurred_at % must match canonical revision occurred_at %',
			NEW.occurred_at, v_can_rev.occurred_at;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
	END IF;
	IF v_can_tx.kind != 'PERSON_OBLIGATION_SETTLEMENT' THEN
		RAISE EXCEPTION 'Settlement revision requires canonical kind PERSON_OBLIGATION_SETTLEMENT, found %', v_can_tx.kind;
	END IF;

	-- Chain integrity
	SELECT id, revision_no, operation, asset_account_id, cash_amount, applied_amount, excess_amount, overpayment_income_receipt_id, note
	INTO v_latest
	FROM person_settlement_revisions
	WHERE settlement_id = NEW.settlement_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Settlement % already has revisions; revision 1 cannot be created again', NEW.settlement_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for settlement %', NEW.settlement_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of settlement % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.settlement_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID settlement %', NEW.settlement_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID operation is allowed on subsequent settlement revisions, found %', NEW.operation;
		END IF;
		-- VOID must copy forward the CREATE snapshot exactly (no silent tampering)
		IF NEW.asset_account_id != v_latest.asset_account_id OR
		   NEW.cash_amount != v_latest.cash_amount OR
		   NEW.applied_amount != v_latest.applied_amount OR
		   NEW.excess_amount != v_latest.excess_amount OR
		   NEW.overpayment_income_receipt_id IS DISTINCT FROM v_latest.overpayment_income_receipt_id OR
		   NEW.note IS DISTINCT FROM v_latest.note THEN
			RAISE EXCEPTION 'VOID revision must copy forward the previous settlement snapshot unchanged';
		END IF;
	END IF;

	-- Direction consistency: PAYABLE settlements may never carry an overpayment
	IF v_obligation.direction = 'PAYABLE' AND NEW.excess_amount != 0 THEN
		RAISE EXCEPTION 'PAYABLE settlement % cannot have a non-zero excess_amount', NEW.settlement_id;
	END IF;

	-- Canonical payload key whitelist & exact binding (fail-closed)
	SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
	WHERE k NOT IN ('settlementId', 'obligationId', 'personId', 'direction', 'appliedAmount', 'cashAmount', 'excessAmount', 'assetAccountId', 'note')
	LIMIT 1;
	IF v_invalid_key IS NOT NULL THEN
		RAISE EXCEPTION 'Unexpected key % in PERSON_OBLIGATION_SETTLEMENT canonical payload', v_invalid_key;
	END IF;

	IF COALESCE(jsonb_typeof(v_can_rev.payload->'settlementId'), '') != 'string' OR
	   v_can_rev.payload->>'settlementId' != NEW.settlement_id::text THEN
		RAISE EXCEPTION 'Canonical payload settlementId % does not match settlement %',
			v_can_rev.payload->>'settlementId', NEW.settlement_id;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'obligationId'), '') != 'string' OR
	   v_can_rev.payload->>'obligationId' != v_settlement.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match settlement obligation %',
			v_can_rev.payload->>'obligationId', v_settlement.obligation_id;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'personId'), '') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'direction'), '') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'appliedAmount'), '') != 'string' OR
	   v_can_rev.payload->>'appliedAmount' != NEW.applied_amount::text THEN
		RAISE EXCEPTION 'Canonical payload appliedAmount % does not match revision %',
			v_can_rev.payload->>'appliedAmount', NEW.applied_amount;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'cashAmount'), '') != 'string' OR
	   v_can_rev.payload->>'cashAmount' != NEW.cash_amount::text THEN
		RAISE EXCEPTION 'Canonical payload cashAmount % does not match revision %',
			v_can_rev.payload->>'cashAmount', NEW.cash_amount;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'excessAmount'), '') != 'string' OR
	   v_can_rev.payload->>'excessAmount' != NEW.excess_amount::text THEN
		RAISE EXCEPTION 'Canonical payload excessAmount % does not match revision %',
			v_can_rev.payload->>'excessAmount', NEW.excess_amount;
	END IF;
	IF COALESCE(jsonb_typeof(v_can_rev.payload->'assetAccountId'), '') != 'string' OR
	   v_can_rev.payload->>'assetAccountId' != NEW.asset_account_id::text THEN
		RAISE EXCEPTION 'Canonical payload assetAccountId % does not match revision %',
			v_can_rev.payload->>'assetAccountId', NEW.asset_account_id;
	END IF;
	IF NEW.note IS NULL THEN
		IF v_can_rev.payload->'note' IS NOT NULL AND COALESCE(jsonb_typeof(v_can_rev.payload->'note'), '') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload note must be null when projection note is null';
		END IF;
	ELSE
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'note'), '') != 'string' OR
		   v_can_rev.payload->>'note' != NEW.note THEN
			RAISE EXCEPTION 'Canonical payload note % does not match revision note %',
				v_can_rev.payload->>'note', NEW.note;
		END IF;
	END IF;

	-- Oversettlement guard: fresh CREATE may not push active settled total beyond active principal
	IF NEW.operation = 'CREATE' THEN
		SELECT id, revision_no, operation, principal_amount INTO v_obl_latest
		FROM person_obligation_revisions
		WHERE obligation_id = v_settlement.obligation_id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF v_obl_latest.id IS NULL OR v_obl_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot settle obligation % that is VOID or has no revisions', v_settlement.obligation_id;
		END IF;

		SELECT COALESCE(SUM(latest.applied_amount), 0) INTO v_active_settled
		FROM (
			SELECT DISTINCT ON (psr.settlement_id) psr.settlement_id, psr.applied_amount, psr.operation
			FROM person_settlement_revisions psr
			JOIN person_settlements ps ON ps.id = psr.settlement_id
			WHERE ps.obligation_id = v_settlement.obligation_id AND psr.settlement_id != NEW.settlement_id
			ORDER BY psr.settlement_id, psr.revision_no DESC
		) latest
		WHERE latest.operation != 'VOID';

		IF (v_active_settled + NEW.applied_amount) > v_obl_latest.principal_amount THEN
			RAISE EXCEPTION 'Settlement % would push obligation % active settled total % beyond principal %',
				NEW.settlement_id, v_settlement.obligation_id, (v_active_settled + NEW.applied_amount), v_obl_latest.principal_amount;
		END IF;

		-- Overpayment income receipt binding
		IF NEW.excess_amount > 0 THEN
			SELECT * INTO v_income_receipt FROM income_receipts WHERE id = NEW.overpayment_income_receipt_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Overpayment income receipt % not found', NEW.overpayment_income_receipt_id;
			END IF;
			IF v_income_receipt.user_id != NEW.user_id THEN
				RAISE EXCEPTION 'Overpayment income receipt % belongs to a different user', NEW.overpayment_income_receipt_id;
			END IF;

			IF EXISTS (
				SELECT 1 FROM person_settlement_revisions
				WHERE overpayment_income_receipt_id = NEW.overpayment_income_receipt_id
				  AND settlement_id != NEW.settlement_id
			) THEN
				RAISE EXCEPTION 'Overpayment income receipt % is already linked to a different settlement', NEW.overpayment_income_receipt_id;
			END IF;

			SELECT * INTO v_income_link FROM people_system_income_links
			WHERE user_id = NEW.user_id AND role = 'OVERPAYMENT_EXTRA';
			IF NOT FOUND OR v_income_link.income_source_id != v_income_receipt.source_id THEN
				RAISE EXCEPTION 'Overpayment income receipt % is not linked to the OVERPAYMENT_EXTRA system source', NEW.overpayment_income_receipt_id;
			END IF;

			SELECT * INTO v_income_source FROM income_sources WHERE id = v_income_receipt.source_id;
			IF v_income_source.nature != 'EXTRA' OR v_income_source.reference_method != 'EXCLUDED' THEN
				RAISE EXCEPTION 'Overpayment income source % must be EXTRA/EXCLUDED', v_income_source.id;
			END IF;

			SELECT * INTO v_income_can_tx FROM canonical_transactions WHERE id = v_income_receipt.canonical_transaction_id;
			IF NOT FOUND OR v_income_can_tx.kind != 'INCOME_RECEIPT' THEN
				RAISE EXCEPTION 'Overpayment income receipt % canonical kind must be INCOME_RECEIPT', NEW.overpayment_income_receipt_id;
			END IF;

			SELECT * INTO v_income_rev FROM income_receipt_revisions
			WHERE income_receipt_id = v_income_receipt.id AND revision_no = 1;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Overpayment income receipt % missing revision #1', NEW.overpayment_income_receipt_id;
			END IF;
			IF v_income_rev.amount != NEW.excess_amount THEN
				RAISE EXCEPTION 'Overpayment income receipt amount % does not match excess_amount %',
					v_income_rev.amount, NEW.excess_amount;
			END IF;
			IF v_income_rev.destination_account_id != NEW.asset_account_id THEN
				RAISE EXCEPTION 'Overpayment income receipt destination_account_id does not match settlement asset_account_id';
			END IF;
			IF v_income_rev.occurred_at != NEW.occurred_at THEN
				RAISE EXCEPTION 'Overpayment income receipt occurred_at does not match settlement occurred_at';
			END IF;
		ELSIF NEW.overpayment_income_receipt_id IS NOT NULL THEN
			RAISE EXCEPTION 'Settlement % has overpayment_income_receipt_id set but excess_amount is 0', NEW.settlement_id;
		END IF;
	END IF;

	-- VOID: if the settlement carried a linked overpayment income receipt, it must already be VOID
	IF NEW.operation = 'VOID' AND NEW.overpayment_income_receipt_id IS NOT NULL THEN
		SELECT * INTO v_income_latest_rev FROM income_receipt_revisions
		WHERE income_receipt_id = NEW.overpayment_income_receipt_id
		ORDER BY revision_no DESC LIMIT 1;
		IF NOT FOUND OR v_income_latest_rev.operation != 'VOID' THEN
			RAISE EXCEPTION 'Settlement % VOID requires linked overpayment income receipt % to also be VOID',
				NEW.settlement_id, NEW.overpayment_income_receipt_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 3. trg_fn_guard_person_obligation_ledger_effect
CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_ledger_effect()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_can_tx RECORD;
	v_can_rev RECORD;
	v_link RECORD;
	v_binding RECORD;
	v_line_count INT;
	v_dr_account UUID;
	v_dr_amount NUMERIC;
	v_cr_account UUID;
	v_cr_amount NUMERIC;
	v_expected_role TEXT;
	v_expense_account_id UUID;
	v_prev_rev RECORD;
	v_prev_binding RECORD;
	v_prev_dr_account UUID;
	v_prev_dr_amount NUMERIC;
	v_prev_cr_account UUID;
	v_prev_cr_amount NUMERIC;
BEGIN
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Obligation % not found for ledger effect check', NEW.obligation_id;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_obligation.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found for obligation %', v_obligation.canonical_transaction_id, NEW.obligation_id;
	END IF;

	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found for obligation %', NEW.canonical_revision_id, NEW.obligation_id;
	END IF;

	SELECT * INTO v_link FROM person_ledger_links WHERE person_id = v_obligation.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person ledger link missing for person %', v_obligation.person_id;
	END IF;

	SELECT * INTO v_binding FROM transaction_ledger_bindings WHERE revision_id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'No transaction_ledger_bindings row for obligation revision %', NEW.id;
	END IF;

	IF NEW.operation IN ('CREATE', 'UPDATE') THEN
		IF v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Obligation revision % has no applied journal entry', NEW.id;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Obligation % applied journal entry must have exactly 2 lines, found %', NEW.obligation_id, v_line_count;
		END IF;

		SELECT account_id, debit INTO v_dr_account, v_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND debit > 0;
		SELECT account_id, credit INTO v_cr_account, v_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND credit > 0;

		IF v_can_tx.kind = 'CREDIT_CARD_PURCHASE_SPLIT' THEN
			IF v_dr_account != v_link.receivable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match person receivable account %',
					NEW.obligation_id, v_dr_account, v_link.receivable_account_id;
			END IF;
			IF v_cr_account IS DISTINCT FROM (v_can_rev.payload->>'expenseAccountId')::uuid THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match split expense account %',
					NEW.obligation_id, v_cr_account, v_can_rev.payload->>'expenseAccountId';
			END IF;
		ELSIF v_can_tx.kind = 'PERSON_RECEIVABLE_ADVANCE' THEN
			IF v_dr_account != v_link.receivable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match person receivable account %',
					NEW.obligation_id, v_dr_account, v_link.receivable_account_id;
			END IF;
			IF v_cr_account != NEW.funding_asset_account_id THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match funding_asset_account_id %',
					NEW.obligation_id, v_cr_account, NEW.funding_asset_account_id;
			END IF;
		ELSIF v_can_tx.kind = 'PERSON_PAYABLE_EXPENSE' THEN
			v_expected_role := CASE NEW.budget_category
				WHEN 'MANDATORY_EXPENSE' THEN 'MANDATORY_EXPENSE'
				WHEN 'DISCRETIONARY_SPEND' THEN 'DISCRETIONARY_EXPENSE'
				WHEN 'SHORT_TERM_PURCHASE' THEN 'SHORT_TERM_PURCHASE'
				WHEN 'UNCLASSIFIED' THEN 'UNCLASSIFIED_EXPENSE'
				ELSE NULL
			END;
			IF v_expected_role IS NULL THEN
				RAISE EXCEPTION 'Obligation % has unknown budget_category %', NEW.obligation_id, NEW.budget_category;
			END IF;
			SELECT ledger_account_id INTO v_expense_account_id
				FROM credit_card_system_accounts WHERE user_id = NEW.user_id AND role = v_expected_role;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No system expense account provisioned for role % (user %)', v_expected_role, NEW.user_id;
			END IF;
			IF v_dr_account != v_expense_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match expense account % for budget_category %',
					NEW.obligation_id, v_dr_account, v_expense_account_id, NEW.budget_category;
			END IF;
			IF v_cr_account != v_link.payable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match person payable account %',
					NEW.obligation_id, v_cr_account, v_link.payable_account_id;
			END IF;
		END IF;

		IF v_dr_amount != NEW.principal_amount OR v_cr_amount != NEW.principal_amount THEN
			RAISE EXCEPTION 'Obligation % applied journal amount does not match principal_amount %',
				NEW.obligation_id, NEW.principal_amount;
		END IF;

	ELSIF NEW.operation = 'VOID' THEN
		IF v_binding.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Obligation VOID revision % has no reversal journal entry', NEW.id;
		END IF;
		IF v_binding.applied_journal_entry_id IS NOT NULL THEN
			RAISE EXCEPTION 'Obligation VOID revision % must not have an applied journal entry', NEW.id;
		END IF;

		SELECT * INTO v_prev_rev FROM person_obligation_revisions WHERE id = NEW.previous_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'VOID revision % missing previous revision for reversal check', NEW.id;
		END IF;
		SELECT * INTO v_prev_binding FROM transaction_ledger_bindings WHERE revision_id = v_prev_rev.canonical_revision_id;
		IF NOT FOUND OR v_prev_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Previous revision % has no applied journal entry to reverse', v_prev_rev.id;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Obligation VOID revision % reversal journal entry must have exactly 2 lines, found %', NEW.id, v_line_count;
		END IF;

		SELECT account_id, debit INTO v_dr_account, v_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id AND debit > 0;
		SELECT account_id, credit INTO v_cr_account, v_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id AND credit > 0;

		SELECT account_id, credit INTO v_prev_cr_account, v_prev_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_prev_binding.applied_journal_entry_id AND credit > 0;
		SELECT account_id, debit INTO v_prev_dr_account, v_prev_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_prev_binding.applied_journal_entry_id AND debit > 0;

		IF v_dr_account != v_prev_cr_account OR v_dr_amount != v_prev_cr_amount THEN
			RAISE EXCEPTION 'Obligation % VOID reversal debit line does not mirror original credit line', NEW.obligation_id;
		END IF;
		IF v_cr_account != v_prev_dr_account OR v_cr_amount != v_prev_dr_amount THEN
			RAISE EXCEPTION 'Obligation % VOID reversal credit line does not mirror original debit line', NEW.obligation_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 4. trg_fn_guard_cc_split_commit_check
CREATE OR REPLACE FUNCTION trg_fn_guard_cc_split_commit_check()
RETURNS TRIGGER AS $$
DECLARE
	v_target_split_id UUID;
	v_split RECORD;
	v_latest_split_rev RECORD;
	v_prev_split_rev RECORD;
	v_latest_purchase_rev RECORD;
	v_item_count INT;
	v_item_sum NUMERIC;
	v_item RECORD;
	v_participant RECORD;
	v_obl RECORD;
	v_obl_rev RECORD;
	v_inactive_participant RECORD;
	v_inactive_obl_rev RECORD;
	v_seal RECORD;
	v_any_participant RECORD;
	v_referenced BOOLEAN;
	v_prev_item RECORD;
	v_can_kind TEXT;
	v_obl_payload JSONB;
	v_companion_count INT;
BEGIN
	IF TG_TABLE_NAME = 'credit_card_purchase_splits' THEN
		v_target_split_id := NEW.id;
	ELSIF TG_TABLE_NAME = 'credit_card_purchase_split_revisions' THEN
		v_target_split_id := NEW.split_id;
	ELSIF TG_TABLE_NAME = 'credit_card_purchase_split_participants' THEN
		v_target_split_id := NEW.split_id;
	ELSIF TG_TABLE_NAME = 'credit_card_purchase_split_revision_items' THEN
		SELECT split_id INTO v_target_split_id FROM credit_card_purchase_split_revisions WHERE id = NEW.split_revision_id;
	ELSIF TG_TABLE_NAME = 'person_obligation_revisions' THEN
		SELECT split_id INTO v_target_split_id FROM credit_card_purchase_split_participants WHERE person_obligation_id = NEW.obligation_id;
		IF v_target_split_id IS NULL THEN
			RETURN NULL;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unexpected trigger table % for split commit check', TG_TABLE_NAME;
	END IF;

	IF v_target_split_id IS NULL THEN
		RETURN NULL;
	END IF;

	FOR v_split IN
		SELECT DISTINCT s.*
		FROM credit_card_purchase_splits s
		WHERE s.id = v_target_split_id
	LOOP
		-- 1. Naked anchor check
		SELECT * INTO v_latest_split_rev
		FROM credit_card_purchase_split_revisions
		WHERE split_id = v_split.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF v_latest_split_rev IS NULL THEN
			RAISE EXCEPTION 'Split % has no revisions at commit (naked split anchor)', v_split.id;
		END IF;

		-- 2. Seal completeness
		FOR v_prev_split_rev IN
			SELECT * FROM credit_card_purchase_split_revisions WHERE split_id = v_split.id
		LOOP
			SELECT * INTO v_seal FROM credit_card_purchase_split_revision_seals WHERE split_revision_id = v_prev_split_rev.id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Split revision % has no seal at commit', v_prev_split_rev.id;
			END IF;
		END LOOP;

		-- 3. Orphan participant + provenance
		FOR v_any_participant IN
			SELECT * FROM credit_card_purchase_split_participants WHERE split_id = v_split.id
		LOOP
			SELECT EXISTS (
				SELECT 1 FROM credit_card_purchase_split_revision_items i
				WHERE i.participant_id = v_any_participant.id
				  AND i.person_id = v_any_participant.person_id
			) INTO v_referenced;

			IF NOT v_referenced THEN
				RAISE EXCEPTION 'Participant % has no revision-item history at commit (orphan participant anchor)', v_any_participant.id;
			END IF;

			SELECT * INTO v_obl FROM person_obligations WHERE id = v_any_participant.person_obligation_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Obligation % not found for participant %', v_any_participant.person_obligation_id, v_any_participant.id;
			END IF;
			IF v_obl.direction != 'RECEIVABLE' OR v_obl.person_id != v_any_participant.person_id OR v_obl.user_id != v_split.user_id THEN
				RAISE EXCEPTION 'Obligation % does not match split participant (direction/person/user)', v_obl.id;
			END IF;

			SELECT ct.kind INTO v_can_kind FROM canonical_transactions ct WHERE ct.id = v_obl.canonical_transaction_id;
			IF v_can_kind IS DISTINCT FROM 'CREDIT_CARD_PURCHASE_SPLIT' THEN
				RAISE EXCEPTION 'Split participant % obligation % is not a CREDIT_CARD_PURCHASE_SPLIT obligation (found canonical kind %)',
					v_any_participant.id, v_obl.id, v_can_kind;
			END IF;

			SELECT tr.payload INTO v_obl_payload
			FROM person_obligation_revisions por
			JOIN transaction_revisions tr ON tr.id = por.canonical_revision_id
			WHERE por.obligation_id = v_obl.id
			ORDER BY por.revision_no DESC
			LIMIT 1;

			IF v_obl_payload IS NULL THEN
				RAISE EXCEPTION 'Obligation % has no canonical payload at commit', v_obl.id;
			END IF;
			IF COALESCE(v_obl_payload->>'splitParticipantId', '') != v_any_participant.id::text THEN
				RAISE EXCEPTION 'Obligation % payload splitParticipantId % does not match participant %',
					v_obl.id, v_obl_payload->>'splitParticipantId', v_any_participant.id;
			END IF;
			IF COALESCE(v_obl_payload->>'splitId', '') != v_split.id::text THEN
				RAISE EXCEPTION 'Obligation % payload splitId % does not match split %',
					v_obl.id, v_obl_payload->>'splitId', v_split.id;
			END IF;
			IF COALESCE(v_obl_payload->>'purchaseEventId', '') != v_split.purchase_event_id::text THEN
				RAISE EXCEPTION 'Obligation % payload purchaseEventId % does not match split purchase_event_id %',
					v_obl.id, v_obl_payload->>'purchaseEventId', v_split.purchase_event_id;
			END IF;
			IF NOT EXISTS (
				SELECT 1 FROM credit_card_purchase_split_revisions sr2
				WHERE sr2.id = (v_obl_payload->>'splitRevisionId')::uuid AND sr2.split_id = v_split.id
			) THEN
				RAISE EXCEPTION 'Obligation % payload splitRevisionId % does not identify a revision of split %',
					v_obl.id, v_obl_payload->>'splitRevisionId', v_split.id;
			END IF;

			SELECT count(*) INTO v_companion_count
			FROM credit_card_purchase_split_revision_items i
			WHERE i.split_revision_id = (v_obl_payload->>'splitRevisionId')::uuid
			  AND i.participant_id = v_any_participant.id
			  AND i.person_id = v_any_participant.person_id
			  AND i.share_amount = (v_obl_payload->>'amount')::numeric;

			IF v_companion_count != 1 THEN
				RAISE EXCEPTION 'Split revision % referenced by obligation % payload must contain exactly one matching revision item (participant/person/amount), found %',
					v_obl_payload->>'splitRevisionId', v_obl.id, v_companion_count;
			END IF;
		END LOOP;

		IF v_latest_split_rev.operation != 'VOID' THEN
			-- 4. ACTIVE final invariant.
			SELECT count(*), COALESCE(SUM(share_amount), 0)
			INTO v_item_count, v_item_sum
			FROM credit_card_purchase_split_revision_items
			WHERE split_revision_id = v_latest_split_rev.id;

			IF v_item_count < 1 OR v_item_count > 9 THEN
				RAISE EXCEPTION 'Active split revision % must have between 1 and 9 external participants, found %',
					v_latest_split_rev.id, v_item_count;
			END IF;

			IF v_item_sum != v_latest_split_rev.external_share_amount THEN
				RAISE EXCEPTION 'Active split revision % sum of item shares % does not match external_share_amount %',
					v_latest_split_rev.id, v_item_sum, v_latest_split_rev.external_share_amount;
			END IF;

			IF v_latest_split_rev.user_share_amount + v_latest_split_rev.external_share_amount != v_latest_split_rev.gross_amount THEN
				RAISE EXCEPTION 'Active split revision % user_share + external_share does not equal gross_amount', v_latest_split_rev.id;
			END IF;

			FOR v_item IN
				SELECT * FROM credit_card_purchase_split_revision_items
				WHERE split_revision_id = v_latest_split_rev.id
			LOOP
				SELECT * INTO v_participant FROM credit_card_purchase_split_participants WHERE id = v_item.participant_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Participant % not found for split item %', v_item.participant_id, v_item.id;
				END IF;

				SELECT * INTO v_obl FROM person_obligations WHERE id = v_participant.person_obligation_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Obligation % not found for participant %', v_participant.person_obligation_id, v_participant.id;
				END IF;

				IF v_obl.direction != 'RECEIVABLE' OR v_obl.person_id != v_item.person_id OR v_obl.user_id != v_split.user_id THEN
					RAISE EXCEPTION 'Obligation % does not match split participant (direction/person/user)', v_obl.id;
				END IF;

				SELECT * INTO v_obl_rev
				FROM person_obligation_revisions
				WHERE obligation_id = v_obl.id
				ORDER BY revision_no DESC
				LIMIT 1;

				IF v_obl_rev IS NULL OR v_obl_rev.operation = 'VOID' THEN
					RAISE EXCEPTION 'Active split item obligation % is void or missing', v_obl.id;
				END IF;

				IF v_obl_rev.principal_amount != v_item.share_amount THEN
					RAISE EXCEPTION 'Active split item obligation % principal % does not match item share_amount %',
						v_obl.id, v_obl_rev.principal_amount, v_item.share_amount;
				END IF;
			END LOOP;

			-- Removed participants must have their obligation VOID.
			FOR v_inactive_participant IN
				SELECT p.*
				FROM credit_card_purchase_split_participants p
				WHERE p.split_id = v_split.id
				  AND p.id NOT IN (
					SELECT participant_id FROM credit_card_purchase_split_revision_items WHERE split_revision_id = v_latest_split_rev.id
				  )
			LOOP
				SELECT * INTO v_inactive_obl_rev
				FROM person_obligation_revisions
				WHERE obligation_id = v_inactive_participant.person_obligation_id
				ORDER BY revision_no DESC
				LIMIT 1;

				IF v_inactive_obl_rev IS NOT NULL AND v_inactive_obl_rev.operation != 'VOID' THEN
					RAISE EXCEPTION 'Removed split participant % obligation % must be VOID',
						v_inactive_participant.id, v_inactive_participant.person_obligation_id;
				END IF;
			END LOOP;

			SELECT * INTO v_latest_purchase_rev
			FROM credit_card_liability_event_revisions
			WHERE event_id = v_split.purchase_event_id
			ORDER BY revision_no DESC
			LIMIT 1;

			IF v_latest_purchase_rev IS NULL OR v_latest_purchase_rev.operation = 'VOID' THEN
				RAISE EXCEPTION 'Active split % cannot exist for voided purchase %', v_split.id, v_split.purchase_event_id;
			END IF;

			IF v_latest_split_rev.purchase_event_revision_id != v_latest_purchase_rev.id THEN
				RAISE EXCEPTION 'Active split % purchase_event_revision_id % does not match latest purchase revision id %',
					v_split.id, v_latest_split_rev.purchase_event_revision_id, v_latest_purchase_rev.id;
			END IF;
		ELSE
			-- 5. VOID final invariant
			SELECT * INTO v_prev_split_rev
			FROM credit_card_purchase_split_revisions
			WHERE id = v_latest_split_rev.previous_revision_id;

			IF NOT FOUND THEN
				RAISE EXCEPTION 'VOID split revision % has no predecessor to validate against', v_latest_split_rev.id;
			END IF;

			IF v_latest_split_rev.method != v_prev_split_rev.method THEN
				RAISE EXCEPTION 'VOID split revision % must copy forward prior method', v_latest_split_rev.id;
			END IF;
			IF v_latest_split_rev.gross_amount != v_prev_split_rev.gross_amount THEN
				RAISE EXCEPTION 'VOID split revision % must copy forward prior gross_amount', v_latest_split_rev.id;
			END IF;
			IF v_latest_split_rev.purchase_event_revision_id != v_prev_split_rev.purchase_event_revision_id THEN
				RAISE EXCEPTION 'VOID split revision % must copy forward prior purchase_event_revision_id', v_latest_split_rev.id;
			END IF;
			IF v_latest_split_rev.user_weight IS DISTINCT FROM v_prev_split_rev.user_weight THEN
				RAISE EXCEPTION 'VOID split revision % must copy forward prior user_weight', v_latest_split_rev.id;
			END IF;
			IF v_latest_split_rev.user_share_amount != v_latest_split_rev.gross_amount THEN
				RAISE EXCEPTION 'VOID split revision % user_share_amount must equal gross_amount', v_latest_split_rev.id;
			END IF;
			IF v_latest_split_rev.external_share_amount != 0 THEN
				RAISE EXCEPTION 'VOID split revision % external_share_amount must be zero', v_latest_split_rev.id;
			END IF;

			SELECT count(*) INTO v_item_count
			FROM credit_card_purchase_split_revision_items
			WHERE split_revision_id = v_latest_split_rev.id;
			IF v_item_count != 0 THEN
				RAISE EXCEPTION 'VOID split revision % must have zero revision items, found %', v_latest_split_rev.id, v_item_count;
			END IF;

			FOR v_prev_item IN
				SELECT * FROM credit_card_purchase_split_revision_items
				WHERE split_revision_id = v_prev_split_rev.id
			LOOP
				SELECT * INTO v_participant FROM credit_card_purchase_split_participants WHERE id = v_prev_item.participant_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Participant % not found for prior split item %', v_prev_item.participant_id, v_prev_item.id;
				END IF;

				SELECT * INTO v_obl_rev
				FROM person_obligation_revisions
				WHERE obligation_id = v_participant.person_obligation_id
				ORDER BY revision_no DESC
				LIMIT 1;

				IF v_obl_rev IS NULL OR v_obl_rev.operation != 'VOID' THEN
					RAISE EXCEPTION 'Split % VOID leaves participant obligation % active', v_split.id, v_participant.person_obligation_id;
				END IF;
			END LOOP;
		END IF;
	END LOOP;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 5. trg_fn_guard_reward_event_revision_insert
CREATE OR REPLACE FUNCTION trg_fn_guard_reward_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_account RECORD;
	v_latest_account_status TEXT;
	v_latest RECORD;
	v_other_active_opening_id UUID;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_expected_role TEXT;
	v_expense_account RECORD;
	v_reward_benefit_account RECORD;
	v_user_currency TEXT;
	v_line_count INT;
	v_debit_line RECORD;
	v_credit_line RECORD;
	v_expected_economic NUMERIC;
	v_goal RECORD;
	v_goal_status TEXT;
BEGIN
	SELECT * INTO v_event FROM reward_events WHERE id = NEW.reward_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward event % not found', NEW.reward_event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reward event user_id % does not match revision user_id %', v_event.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_account FROM reward_accounts WHERE id = v_event.reward_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reward account % not found for event %', v_event.reward_account_id, NEW.reward_event_id;
	END IF;

	IF v_account.user_id != v_event.user_id THEN
		RAISE EXCEPTION 'Reward account % user_id % does not match reward event % user_id %',
			v_account.id, v_account.user_id, v_event.id, v_event.user_id;
	END IF;

	SELECT status INTO v_latest_account_status
	FROM reward_account_revisions
	WHERE reward_account_id = v_account.id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF v_latest_account_status IS DISTINCT FROM 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot mutate reward event for non-ACTIVE reward account %', v_account.id;
	END IF;

	SELECT id, revision_no, operation, point_amount, conversion_rate, economic_amount,
		purchase_category, short_term_goal_id, merchant, description, occurred_at,
		source_type, source_ref
	INTO v_latest
	FROM reward_event_revisions
	WHERE reward_event_id = NEW.reward_event_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Reward event % already has revisions; revision 1 cannot be created again', NEW.reward_event_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;

		IF v_event.event_type = 'OPENING_BALANCE' THEN
			SELECT re.id INTO v_other_active_opening_id
			FROM reward_events re
			WHERE re.reward_account_id = v_account.id
				AND re.event_type = 'OPENING_BALANCE'
				AND re.id != v_event.id
				AND (
					SELECT rer.operation
					FROM reward_event_revisions rer
					WHERE rer.reward_event_id = re.id
					ORDER BY rer.revision_no DESC
					LIMIT 1
				) != 'VOID';

			IF v_other_active_opening_id IS NOT NULL THEN
				RAISE EXCEPTION 'Reward account % already has an active OPENING_BALANCE event %', v_account.id, v_other_active_opening_id;
			END IF;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for reward event %', NEW.reward_event_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of reward event % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.reward_event_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID reward event % (VOID is terminal)', NEW.reward_event_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID is permitted as a subsequent reward event revision, found %', NEW.operation;
		END IF;

		IF NEW.point_amount != v_latest.point_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward point_amount exactly (expected %, found %)', v_latest.point_amount, NEW.point_amount;
		END IF;
		IF NEW.conversion_rate != v_latest.conversion_rate THEN
			RAISE EXCEPTION 'VOID revision must copy forward conversion_rate exactly (expected %, found %)', v_latest.conversion_rate, NEW.conversion_rate;
		END IF;
		IF NEW.economic_amount IS DISTINCT FROM v_latest.economic_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward economic_amount exactly';
		END IF;
		IF NEW.purchase_category IS DISTINCT FROM v_latest.purchase_category THEN
			RAISE EXCEPTION 'VOID revision must copy forward purchase_category exactly';
		END IF;
		IF NEW.short_term_goal_id IS DISTINCT FROM v_latest.short_term_goal_id THEN
			RAISE EXCEPTION 'VOID revision must copy forward short_term_goal_id exactly';
		END IF;
		IF NEW.merchant IS DISTINCT FROM v_latest.merchant THEN
			RAISE EXCEPTION 'VOID revision must copy forward merchant exactly';
		END IF;
		IF NEW.description IS DISTINCT FROM v_latest.description THEN
			RAISE EXCEPTION 'VOID revision must copy forward description exactly';
		END IF;
		IF NEW.occurred_at != v_latest.occurred_at THEN
			RAISE EXCEPTION 'VOID revision must copy forward occurred_at exactly (expected %, found %)', v_latest.occurred_at, NEW.occurred_at;
		END IF;
		IF NEW.source_type != v_latest.source_type THEN
			RAISE EXCEPTION 'VOID revision must copy forward source_type exactly (expected %, found %)', v_latest.source_type, NEW.source_type;
		END IF;
		IF NEW.source_ref IS DISTINCT FROM v_latest.source_ref THEN
			RAISE EXCEPTION 'VOID revision must copy forward source_ref exactly';
		END IF;
	END IF;

	IF v_event.event_type != 'REDEEM_PURCHASE' THEN
		IF NEW.economic_amount IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have economic_amount NULL', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have purchase_category NULL', NEW.reward_event_id;
		END IF;
		IF NEW.short_term_goal_id IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have short_term_goal_id NULL', NEW.reward_event_id;
		END IF;
		IF NEW.canonical_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'Non-economic reward event % must have canonical_revision_id NULL', NEW.reward_event_id;
		END IF;
	ELSE
		IF NEW.economic_amount IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires economic_amount', NEW.reward_event_id;
		END IF;
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires canonical_revision_id', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category IS NULL THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % requires purchase_category', NEW.reward_event_id;
		END IF;
		IF NEW.purchase_category NOT IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED') THEN
			RAISE EXCEPTION 'Reward purchase has unknown purchase_category %', NEW.purchase_category;
		END IF;

		v_expected_economic := floor(NEW.point_amount * NEW.conversion_rate * 100 + 0.5) / 100;
		IF NEW.economic_amount != v_expected_economic THEN
			RAISE EXCEPTION 'Reward event % economic_amount % does not match authoritative derivation % (point_amount % x conversion_rate %)',
				NEW.reward_event_id, NEW.economic_amount, v_expected_economic, NEW.point_amount, NEW.conversion_rate;
		END IF;

		SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_can_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical revision user_id % does not match reward event revision user_id %', v_can_rev.user_id, NEW.user_id;
		END IF;
		IF v_can_rev.transaction_id != v_event.canonical_transaction_id THEN
			RAISE EXCEPTION 'Canonical revision transaction_id % does not match reward event canonical_transaction_id %',
				v_can_rev.transaction_id, v_event.canonical_transaction_id;
		END IF;
		IF v_can_rev.operation != NEW.operation THEN
			RAISE EXCEPTION 'Canonical revision operation % does not match reward event revision operation %',
				v_can_rev.operation, NEW.operation;
		END IF;
		IF v_can_rev.occurred_at != NEW.occurred_at THEN
			RAISE EXCEPTION 'Canonical revision occurred_at % does not match reward event revision occurred_at %',
				v_can_rev.occurred_at, NEW.occurred_at;
		END IF;

		SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
		END IF;
		IF v_can_tx.kind != 'REWARD_FUNDED_PURCHASE' THEN
			RAISE EXCEPTION 'REDEEM_PURCHASE reward event % canonical transaction % has wrong kind %',
				NEW.reward_event_id, v_can_tx.id, v_can_tx.kind;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload), '') != 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_can_rev.payload)) != 9 THEN
			RAISE EXCEPTION 'REWARD_FUNDED_PURCHASE canonical payload must contain exactly 9 keys, found %', (SELECT count(*) FROM jsonb_object_keys(v_can_rev.payload));
		END IF;

		IF NOT (v_can_rev.payload ?& ARRAY['rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description']) THEN
			RAISE EXCEPTION 'REWARD_FUNDED_PURCHASE canonical payload is missing required keys';
		END IF;

		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in REWARD_FUNDED_PURCHASE canonical payload', v_invalid_key;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'rewardEventId'), '') != 'string' OR
		   v_can_rev.payload->>'rewardEventId' != NEW.reward_event_id::text THEN
			RAISE EXCEPTION 'Canonical payload rewardEventId % does not match reward event %',
				v_can_rev.payload->>'rewardEventId', NEW.reward_event_id;
		END IF;
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'rewardAccountId'), '') != 'string' OR
		   v_can_rev.payload->>'rewardAccountId' != v_event.reward_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload rewardAccountId % does not match reward account %',
				v_can_rev.payload->>'rewardAccountId', v_event.reward_account_id;
		END IF;
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'points'), '') != 'string' OR
		   v_can_rev.payload->>'points' != NEW.point_amount::text THEN
			RAISE EXCEPTION 'Canonical payload points % does not match revision point_amount %',
				v_can_rev.payload->>'points', NEW.point_amount;
		END IF;
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'conversionRate'), '') != 'string' OR
		   v_can_rev.payload->>'conversionRate' != NEW.conversion_rate::text THEN
			RAISE EXCEPTION 'Canonical payload conversionRate % does not match revision conversion_rate %',
				v_can_rev.payload->>'conversionRate', NEW.conversion_rate;
		END IF;
		IF COALESCE(jsonb_typeof(v_can_rev.payload->'economicAmount'), '') != 'string' OR
		   v_can_rev.payload->>'economicAmount' != NEW.economic_amount::text THEN
			RAISE EXCEPTION 'Canonical payload economicAmount % does not match revision economic_amount %',
				v_can_rev.payload->>'economicAmount', NEW.economic_amount;
		END IF;

		IF COALESCE(jsonb_typeof(v_can_rev.payload->'purchaseCategory'), '') != 'string' OR
		   v_can_rev.payload->>'purchaseCategory' != NEW.purchase_category THEN
			RAISE EXCEPTION 'Canonical payload purchaseCategory % does not match revision purchase_category %',
				v_can_rev.payload->>'purchaseCategory', NEW.purchase_category;
		END IF;

		IF NEW.short_term_goal_id IS NULL THEN
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'shortTermGoalId'), '') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload shortTermGoalId must be null when revision short_term_goal_id is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'shortTermGoalId'), '') != 'string' OR
			   v_can_rev.payload->>'shortTermGoalId' != NEW.short_term_goal_id::text THEN
				RAISE EXCEPTION 'Canonical payload shortTermGoalId % does not match revision short_term_goal_id %',
					v_can_rev.payload->>'shortTermGoalId', NEW.short_term_goal_id;
			END IF;
		END IF;

		IF NEW.merchant IS NULL THEN
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'merchant'), '') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload merchant must be null when revision merchant is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'merchant'), '') != 'string' OR
			   v_can_rev.payload->>'merchant' != NEW.merchant THEN
				RAISE EXCEPTION 'Canonical payload merchant % does not match revision merchant %',
					v_can_rev.payload->>'merchant', NEW.merchant;
			END IF;
		END IF;

		IF NEW.description IS NULL THEN
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload description must be null when revision description is null';
			END IF;
		ELSE
			IF COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'string' OR
			   v_can_rev.payload->>'description' != NEW.description THEN
				RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
					v_can_rev.payload->>'description', NEW.description;
			END IF;
		END IF;

		-- Fresh CREATE only: goal binding + exact ledger binding.
		IF NEW.operation = 'CREATE' THEN
			IF NEW.purchase_category = 'SHORT_TERM_PURCHASE' THEN
				IF NEW.short_term_goal_id IS NULL THEN
					RAISE EXCEPTION 'Reward purchase % with category SHORT_TERM_PURCHASE requires short_term_goal_id', NEW.reward_event_id;
				END IF;
				SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.short_term_goal_id;
				IF NOT FOUND THEN
					RAISE EXCEPTION 'Short-term goal % not found', NEW.short_term_goal_id;
				END IF;
				IF v_goal.user_id != NEW.user_id THEN
					RAISE EXCEPTION 'Short-term goal % belongs to a different user than reward event %', NEW.short_term_goal_id, NEW.reward_event_id;
				END IF;
				SELECT status INTO v_goal_status
				FROM short_term_goal_revisions
				WHERE goal_id = NEW.short_term_goal_id
				ORDER BY revision_no DESC
				LIMIT 1;
				IF v_goal_status IS DISTINCT FROM 'ACTIVE' THEN
					RAISE EXCEPTION 'Short-term goal % is not ACTIVE (found %)', NEW.short_term_goal_id, v_goal_status;
				END IF;
			ELSE
				IF NEW.short_term_goal_id IS NOT NULL THEN
					RAISE EXCEPTION 'Reward purchase % with category % must not have short_term_goal_id', NEW.reward_event_id, NEW.purchase_category;
				END IF;
			END IF;

			v_expected_role := CASE NEW.purchase_category
				WHEN 'MANDATORY_EXPENSE' THEN 'MANDATORY_EXPENSE'
				WHEN 'DISCRETIONARY_SPEND' THEN 'DISCRETIONARY_EXPENSE'
				WHEN 'SHORT_TERM_PURCHASE' THEN 'SHORT_TERM_PURCHASE'
				WHEN 'UNCLASSIFIED' THEN 'UNCLASSIFIED_EXPENSE'
				ELSE NULL
			END;
			IF v_expected_role IS NULL THEN
				RAISE EXCEPTION 'Reward purchase has unknown purchase_category %', NEW.purchase_category;
			END IF;

			SELECT u.currency INTO v_user_currency FROM users u WHERE u.id = NEW.user_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'User % not found', NEW.user_id;
			END IF;

			SELECT la.* INTO v_expense_account
			FROM credit_card_system_accounts ccsa
			JOIN ledger_accounts la ON la.id = ccsa.ledger_account_id
			WHERE ccsa.user_id = NEW.user_id AND ccsa.role = v_expected_role;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No system expense account provisioned for role % (user %)', v_expected_role, NEW.user_id;
			END IF;
			IF v_expense_account.user_id != NEW.user_id THEN
				RAISE EXCEPTION 'Authoritative expense account % does not belong to user %', v_expense_account.id, NEW.user_id;
			END IF;
			IF v_expense_account.account_type != 'EXPENSE' OR v_expense_account.normal_balance != 'DEBIT' THEN
				RAISE EXCEPTION 'Authoritative expense account % is not a valid EXPENSE/DEBIT account (type %, normal_balance %)',
					v_expense_account.id, v_expense_account.account_type, v_expense_account.normal_balance;
			END IF;
			IF v_expense_account.currency != v_user_currency THEN
				RAISE EXCEPTION 'Authoritative expense account % currency % does not match user currency %',
					v_expense_account.id, v_expense_account.currency, v_user_currency;
			END IF;
			IF v_expense_account.archived_at IS NOT NULL THEN
				RAISE EXCEPTION 'Authoritative expense account % is archived', v_expense_account.id;
			END IF;

			SELECT la.* INTO v_reward_benefit_account
			FROM ledger_accounts la WHERE la.user_id = NEW.user_id AND la.code = 'SYS_REWARD_BENEFIT';
			IF NOT FOUND THEN
				RAISE EXCEPTION 'No REWARD_BENEFIT system account provisioned (user %)', NEW.user_id;
			END IF;
			IF v_reward_benefit_account.account_type != 'INCOME' OR v_reward_benefit_account.normal_balance != 'CREDIT' THEN
				RAISE EXCEPTION 'REWARD_BENEFIT account % is not a valid INCOME/CREDIT account (type %, normal_balance %)',
					v_reward_benefit_account.id, v_reward_benefit_account.account_type, v_reward_benefit_account.normal_balance;
			END IF;
			IF v_reward_benefit_account.currency != v_user_currency THEN
				RAISE EXCEPTION 'REWARD_BENEFIT account % currency % does not match user currency %',
					v_reward_benefit_account.id, v_reward_benefit_account.currency, v_user_currency;
			END IF;
			IF v_reward_benefit_account.archived_at IS NOT NULL THEN
				RAISE EXCEPTION 'REWARD_BENEFIT account % is archived', v_reward_benefit_account.id;
			END IF;

			SELECT count(*) INTO v_line_count
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id;

			IF v_line_count != 2 THEN
				RAISE EXCEPTION 'Reward purchase % applied journal must have exactly 2 lines, found %',
					NEW.reward_event_id, v_line_count;
			END IF;

			SELECT jl.* INTO v_debit_line
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.debit > 0;

			SELECT jl.* INTO v_credit_line
			FROM transaction_ledger_bindings tlb
			JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
			WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.credit > 0;

			IF v_debit_line IS NULL OR v_credit_line IS NULL THEN
				RAISE EXCEPTION 'Reward purchase % applied journal must have exactly one debit line and one credit line', NEW.reward_event_id;
			END IF;
			IF v_debit_line.account_id != v_expense_account.id THEN
				RAISE EXCEPTION 'Reward purchase % debit line account % is not the authoritative expense account %',
					NEW.reward_event_id, v_debit_line.account_id, v_expense_account.id;
			END IF;
			IF v_credit_line.account_id != v_reward_benefit_account.id THEN
				RAISE EXCEPTION 'Reward purchase % credit line account % is not the REWARD_BENEFIT account %',
					NEW.reward_event_id, v_credit_line.account_id, v_reward_benefit_account.id;
			END IF;
			IF v_debit_line.debit != NEW.economic_amount THEN
				RAISE EXCEPTION 'Reward purchase % debit amount % does not match economic_amount %',
					NEW.reward_event_id, v_debit_line.debit, NEW.economic_amount;
			END IF;
			IF v_credit_line.credit != NEW.economic_amount THEN
				RAISE EXCEPTION 'Reward purchase % credit amount % does not match economic_amount %',
					NEW.reward_event_id, v_credit_line.credit, NEW.economic_amount;
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 6. trg_fn_long_term_validate_send_payload
CREATE OR REPLACE FUNCTION trg_fn_long_term_validate_send_payload(
	p_payload JSONB,
	p_task_id UUID,
	p_midas_account_id UUID,
	p_pending_bucket_id UUID,
	p_amount NUMERIC,
	p_destination_label VARCHAR,
	p_note VARCHAR,
	p_context TEXT
) RETURNS VOID AS $$
DECLARE
	v_key_count INT;
BEGIN
	IF COALESCE(jsonb_typeof(p_payload), '') != 'object' THEN
		RAISE EXCEPTION '% payload must be a JSON object', p_context;
	END IF;

	SELECT count(*) INTO v_key_count FROM jsonb_object_keys(p_payload);
	IF v_key_count != 6 THEN
		RAISE EXCEPTION '% payload must have exactly 6 keys, found %', p_context, v_key_count;
	END IF;

	IF NOT (
		p_payload ? 'taskId' AND p_payload ? 'midasAccountId' AND p_payload ? 'pendingBucketId'
		AND p_payload ? 'amount' AND p_payload ? 'destinationLabel' AND p_payload ? 'note'
	) THEN
		RAISE EXCEPTION '% payload is missing one or more required keys (taskId, midasAccountId, pendingBucketId, amount, destinationLabel, note)', p_context;
	END IF;

	IF COALESCE(jsonb_typeof(p_payload->'taskId'), '') != 'string' OR p_payload->>'taskId' != p_task_id::text THEN
		RAISE EXCEPTION '% payload taskId % does not match task %', p_context, p_payload->>'taskId', p_task_id;
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'midasAccountId'), '') != 'string' OR p_payload->>'midasAccountId' != p_midas_account_id::text THEN
		RAISE EXCEPTION '% payload midasAccountId % does not match task Midas account %', p_context, p_payload->>'midasAccountId', p_midas_account_id;
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'pendingBucketId'), '') != 'string' OR p_payload->>'pendingBucketId' != p_pending_bucket_id::text THEN
		RAISE EXCEPTION '% payload pendingBucketId % does not match task pending bucket %', p_context, p_payload->>'pendingBucketId', p_pending_bucket_id;
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'amount'), '') != 'string' OR p_payload->>'amount' != p_amount::text THEN
		RAISE EXCEPTION '% payload amount % does not match amount %', p_context, p_payload->>'amount', p_amount;
	END IF;

	IF p_destination_label IS NULL THEN
		IF COALESCE(jsonb_typeof(p_payload->'destinationLabel'), '') != 'null' THEN
			RAISE EXCEPTION '% payload destinationLabel must be explicit JSON null when destination_label is null', p_context;
		END IF;
	ELSE
		IF COALESCE(jsonb_typeof(p_payload->'destinationLabel'), '') != 'string' OR p_payload->>'destinationLabel' != p_destination_label THEN
			RAISE EXCEPTION '% payload destinationLabel % does not match %', p_context, p_payload->>'destinationLabel', p_destination_label;
		END IF;
	END IF;

	IF p_note IS NULL THEN
		IF COALESCE(jsonb_typeof(p_payload->'note'), '') != 'null' THEN
			RAISE EXCEPTION '% payload note must be explicit JSON null when note is null', p_context;
		END IF;
	ELSE
		IF COALESCE(jsonb_typeof(p_payload->'note'), '') != 'string' OR p_payload->>'note' != p_note THEN
			RAISE EXCEPTION '% payload note % does not match %', p_context, p_payload->>'note', p_note;
		END IF;
	END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 7. trg_fn_notification_validate_credit_card_due_payload
CREATE OR REPLACE FUNCTION trg_fn_notification_validate_credit_card_due_payload(
	p_payload JSONB,
	p_statement_id UUID,
	p_credit_card_id UUID,
	p_due_date DATE
) RETURNS VOID AS $$
DECLARE
	v_key_count INT;
	v_data_key_count INT;
BEGIN
	IF COALESCE(jsonb_typeof(p_payload), '') != 'object' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload must be a JSON object';
	END IF;

	SELECT count(*) INTO v_key_count FROM jsonb_object_keys(p_payload);
	IF v_key_count != 3 THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload must have exactly 3 keys, found %', v_key_count;
	END IF;
	IF NOT (p_payload ? 'title' AND p_payload ? 'body' AND p_payload ? 'data') THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload is missing one or more required keys (title, body, data)';
	END IF;

	IF COALESCE(jsonb_typeof(p_payload->'title'), '') != 'string' OR p_payload->>'title' != 'Kredi kartı son ödeme hatırlatması' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload title % does not match the required exact text', p_payload->>'title';
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'body'), '') != 'string' OR p_payload->>'body' != 'Bir kredi kartı ekstresinin son ödeme günü bugün. Ödeme durumunu kontrol et.' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload body % does not match the required exact text', p_payload->>'body';
	END IF;

	IF COALESCE(jsonb_typeof(p_payload->'data'), '') != 'object' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data must be a JSON object';
	END IF;
	SELECT count(*) INTO v_data_key_count FROM jsonb_object_keys(p_payload->'data');
	IF v_data_key_count != 5 THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data must have exactly 5 keys, found %', v_data_key_count;
	END IF;
	IF NOT (
		p_payload->'data' ? 'type' AND p_payload->'data' ? 'statementId' AND p_payload->'data' ? 'creditCardId'
		AND p_payload->'data' ? 'dueDate' AND p_payload->'data' ? 'deepLink'
	) THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data is missing one or more required keys (type, statementId, creditCardId, dueDate, deepLink)';
	END IF;

	IF COALESCE(jsonb_typeof(p_payload->'data'->'type'), '') != 'string' OR p_payload->'data'->>'type' != 'CREDIT_CARD_DUE' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.type % does not equal CREDIT_CARD_DUE', p_payload->'data'->>'type';
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'data'->'statementId'), '') != 'string' OR p_payload->'data'->>'statementId' != p_statement_id::text THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.statementId % does not match statement %', p_payload->'data'->>'statementId', p_statement_id;
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'data'->'creditCardId'), '') != 'string' OR p_payload->'data'->>'creditCardId' != p_credit_card_id::text THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.creditCardId % does not match credit card %', p_payload->'data'->>'creditCardId', p_credit_card_id;
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'data'->'dueDate'), '') != 'string' OR p_payload->'data'->>'dueDate' != p_due_date::text THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.dueDate % does not match due date %', p_payload->'data'->>'dueDate', p_due_date;
	END IF;
	IF COALESCE(jsonb_typeof(p_payload->'data'->'deepLink'), '') != 'string' OR p_payload->'data'->>'deepLink' != ('/credit-cards/statements/' || p_statement_id::text) THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.deepLink % does not match the expected deep link', p_payload->'data'->>'deepLink';
	END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 8. trg_fn_guard_campaign_review_candidate_revision_insert
CREATE OR REPLACE FUNCTION trg_fn_guard_campaign_review_candidate_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_candidate RECORD;
	v_latest RECORD;
	v_unchanged BOOLEAN;
	v_card RECORD;
	v_card_id_text TEXT;
	v_card_count INT;
	v_card_distinct_count INT;
	v_reward_account RECORD;
BEGIN
	SELECT * INTO v_candidate FROM campaign_review_candidates WHERE id = NEW.candidate_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Campaign review candidate % not found', NEW.candidate_id;
	END IF;
	IF v_candidate.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Candidate user_id % does not match revision user_id %', v_candidate.user_id, NEW.user_id;
	END IF;

	IF COALESCE(jsonb_typeof(NEW.proposed_card_ids), '') != 'array' THEN
		RAISE EXCEPTION 'proposed_card_ids must be a JSON array for candidate revision %', NEW.id;
	END IF;
	IF jsonb_array_length(NEW.proposed_card_ids) < 1 THEN
		RAISE EXCEPTION 'proposed_card_ids must not be empty for candidate revision %', NEW.id;
	END IF;
	SELECT count(*), count(DISTINCT elem) INTO v_card_count, v_card_distinct_count
	FROM jsonb_array_elements_text(NEW.proposed_card_ids) AS elem;
	IF v_card_count != v_card_distinct_count THEN
		RAISE EXCEPTION 'proposed_card_ids must not contain duplicate ids for candidate revision %', NEW.id;
	END IF;
	FOR v_card_id_text IN SELECT jsonb_array_elements_text(NEW.proposed_card_ids) LOOP
		IF v_card_id_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
			RAISE EXCEPTION 'proposed_card_ids element % is not a valid UUID for candidate revision %', v_card_id_text, NEW.id;
		END IF;
		SELECT * INTO v_card FROM credit_cards WHERE id = v_card_id_text::uuid;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card % not found', v_card_id_text;
		END IF;
		IF v_card.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Credit card % does not belong to candidate user %', v_card_id_text, NEW.user_id;
		END IF;
	END LOOP;

	IF NEW.reward_kind = 'REWARD_POINTS' THEN
		SELECT * INTO v_reward_account FROM reward_accounts WHERE id = NEW.reward_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reward account % not found', NEW.reward_account_id;
		END IF;
		IF v_reward_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reward account % does not belong to candidate user %', NEW.reward_account_id, NEW.user_id;
		END IF;
	END IF;

	SELECT id, revision_no, status, title, starts_on, ends_on, rule_mode, target_spend_amount,
		required_transaction_count, minimum_transaction_amount, step_spend_amount,
		reward_points_per_step, max_steps, reward_kind, reward_account_id, expected_reward_points,
		merchant_scope_mode, required_canonical_merchant_names, allowed_mcc_codes, reward_expiry_date,
		parser_type, parser_version, parser_confidence, proposed_card_ids
	INTO v_latest
	FROM campaign_review_candidate_revisions
	WHERE candidate_id = NEW.candidate_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Candidate % already has revisions; revision 1 cannot be created again', NEW.candidate_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'PENDING' THEN
			RAISE EXCEPTION 'First revision must have status PENDING, found %', NEW.status;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for candidate %', NEW.candidate_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of candidate % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.candidate_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status != 'PENDING' THEN
			RAISE EXCEPTION 'Cannot create revision on non-PENDING candidate % (% is terminal)', NEW.candidate_id, v_latest.status;
		END IF;
		IF NEW.operation NOT IN ('APPLY', 'DISMISS') THEN
			RAISE EXCEPTION 'Only APPLY or DISMISS is permitted as a subsequent candidate revision, found %', NEW.operation;
		END IF;
		IF NEW.operation = 'APPLY' AND NEW.status != 'APPLIED' THEN
			RAISE EXCEPTION 'APPLY must set status APPLIED, found %', NEW.status;
		END IF;
		IF NEW.operation = 'DISMISS' AND NEW.status != 'DISMISSED' THEN
			RAISE EXCEPTION 'DISMISS must set status DISMISSED, found %', NEW.status;
		END IF;

		v_unchanged := (
			NEW.title IS NOT DISTINCT FROM v_latest.title AND
			NEW.starts_on IS NOT DISTINCT FROM v_latest.starts_on AND
			NEW.ends_on IS NOT DISTINCT FROM v_latest.ends_on AND
			NEW.rule_mode IS NOT DISTINCT FROM v_latest.rule_mode AND
			NEW.target_spend_amount IS NOT DISTINCT FROM v_latest.target_spend_amount AND
			NEW.required_transaction_count IS NOT DISTINCT FROM v_latest.required_transaction_count AND
			NEW.minimum_transaction_amount IS NOT DISTINCT FROM v_latest.minimum_transaction_amount AND
			NEW.step_spend_amount IS NOT DISTINCT FROM v_latest.step_spend_amount AND
			NEW.reward_points_per_step IS NOT DISTINCT FROM v_latest.reward_points_per_step AND
			NEW.max_steps IS NOT DISTINCT FROM v_latest.max_steps AND
			NEW.reward_kind IS NOT DISTINCT FROM v_latest.reward_kind AND
			NEW.reward_account_id IS NOT DISTINCT FROM v_latest.reward_account_id AND
			NEW.expected_reward_points IS NOT DISTINCT FROM v_latest.expected_reward_points AND
			NEW.merchant_scope_mode IS NOT DISTINCT FROM v_latest.merchant_scope_mode AND
			NEW.required_canonical_merchant_names IS NOT DISTINCT FROM v_latest.required_canonical_merchant_names AND
			NEW.allowed_mcc_codes IS NOT DISTINCT FROM v_latest.allowed_mcc_codes AND
			NEW.reward_expiry_date IS NOT DISTINCT FROM v_latest.reward_expiry_date AND
			NEW.parser_type IS NOT DISTINCT FROM v_latest.parser_type AND
			NEW.parser_version IS NOT DISTINCT FROM v_latest.parser_version AND
			NEW.parser_confidence IS NOT DISTINCT FROM v_latest.parser_confidence AND
			NEW.proposed_card_ids IS NOT DISTINCT FROM v_latest.proposed_card_ids
		);
		IF NOT v_unchanged THEN
			RAISE EXCEPTION 'APPLY/DISMISS must copy forward the exact reviewed terms from the predecessor revision (candidate %)', NEW.candidate_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
