-- ============================================================================
-- Phase 11A-R2: Close People Domain Integrity Gaps
-- 1. True append-only immutability (deny UPDATE/DELETE) on all People tables
-- 2. Fix "latest revision ACTIVE" bug (was "any ACTIVE revision ever exists")
-- 3. Correct global lock order in triggers: person -> obligation -> settlement
-- 4. DB-authoritative person ARCHIVE economic preconditions
-- 5. Bidirectional overpayment-income <-> settlement companion binding,
--    including a reverse guard on income_receipt_revisions
-- ============================================================================

-- ============================================================================
-- 1. TRUE APPEND-ONLY IMMUTABILITY
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_deny_people_table_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION '% is append-only (INSERT-only); % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_people ON "people";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_people
BEFORE UPDATE OR DELETE ON "people"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_person_revisions ON "person_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_person_revisions
BEFORE UPDATE OR DELETE ON "person_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_person_ledger_links ON "person_ledger_links";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_person_ledger_links
BEFORE UPDATE OR DELETE ON "person_ledger_links"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_person_obligations ON "person_obligations";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_person_obligations
BEFORE UPDATE OR DELETE ON "person_obligations"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_person_obligation_revisions ON "person_obligation_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_person_obligation_revisions
BEFORE UPDATE OR DELETE ON "person_obligation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_person_settlements ON "person_settlements";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_person_settlements
BEFORE UPDATE OR DELETE ON "person_settlements"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_person_settlement_revisions ON "person_settlement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_person_settlement_revisions
BEFORE UPDATE OR DELETE ON "person_settlement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_people_system_income_links ON "people_system_income_links";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_people_system_income_links
BEFORE UPDATE OR DELETE ON "people_system_income_links"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_people_table_mutation();--> statement-breakpoint

-- ============================================================================
-- 2. PERSON REVISION GUARD: ARCHIVE ECONOMIC PRECONDITIONS
-- (chain-integrity logic unchanged from 0031; this adds the ARCHIVE branch)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_person RECORD;
	v_latest RECORD;
	v_link RECORD;
	v_receivable_balance NUMERIC;
	v_payable_balance NUMERIC;
BEGIN
	SELECT * INTO v_person FROM people WHERE id = NEW.person_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person % not found', NEW.person_id;
	END IF;
	IF v_person.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Person user_id % does not match revision user_id %', v_person.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, status INTO v_latest
	FROM person_revisions WHERE person_id = NEW.person_id ORDER BY revision_no DESC LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Person % already has revisions; revision 1 cannot be created again', NEW.person_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for person %', NEW.person_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of person % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.person_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status = 'ARCHIVED' THEN
			RAISE EXCEPTION 'Cannot create revision on ARCHIVED person %', NEW.person_id;
		END IF;
		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
	END IF;

	-- DB-authoritative ARCHIVE economic preconditions: independently re-verify
	-- what the service layer already checks, so a direct-SQL ARCHIVE cannot
	-- bypass it.
	IF NEW.operation = 'ARCHIVE' THEN
		SELECT * INTO v_link FROM person_ledger_links WHERE person_id = NEW.person_id;
		IF FOUND THEN
			-- Reuses the same non-negativity/reconciliation check used for
			-- ordinary obligation/settlement mutations.
			PERFORM people_check_reconciliation_for_person(NEW.person_id);

			SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) INTO v_receivable_balance
			FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
			WHERE jl.account_id = v_link.receivable_account_id AND je.status = 'POSTED';
			IF v_receivable_balance != 0 THEN
				RAISE EXCEPTION 'Cannot archive person % with non-zero receivable balance %', NEW.person_id, v_receivable_balance;
			END IF;

			SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) INTO v_payable_balance
			FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
			WHERE jl.account_id = v_link.payable_account_id AND je.status = 'POSTED';
			IF v_payable_balance != 0 THEN
				RAISE EXCEPTION 'Cannot archive person % with non-zero payable balance %', NEW.person_id, v_payable_balance;
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_revision_insert ON "person_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_revision_insert
BEFORE INSERT ON "person_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 3. OBLIGATION REVISION GUARD: FIXED LATEST-STATUS CHECK + CORRECT LOCK ORDER
-- (person -> obligation, instead of obligation -> person; the archived-person
-- check now reads the LATEST person revision's status directly instead of
-- "does any ACTIVE revision exist anywhere in history")
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation_peek RECORD;
	v_latest_person_status TEXT;
	v_obligation RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_expected_kind TEXT;
	v_invalid_key TEXT;
	v_active_settled NUMERIC;
	v_funding_account RECORD;
	v_user_currency VARCHAR(3);
BEGIN
	-- Pre-read the immutable obligation anchor (id/user_id/person_id/direction
	-- never change) to resolve which person to lock, without yet locking the
	-- obligation row itself.
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
		v_expected_kind := 'PERSON_RECEIVABLE_ADVANCE';
	ELSE
		v_expected_kind := 'PERSON_PAYABLE_EXPENSE';
	END IF;
	IF v_can_tx.kind != v_expected_kind THEN
		RAISE EXCEPTION 'Obligation direction % requires canonical kind %, found %',
			v_obligation.direction, v_expected_kind, v_can_tx.kind;
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

	-- Direction-specific field consistency
	IF v_obligation.direction = 'RECEIVABLE' THEN
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
	ELSE
		IF NEW.budget_category IS NULL THEN
			RAISE EXCEPTION 'PAYABLE obligation revision requires budget_category';
		END IF;
		IF NEW.funding_asset_account_id IS NOT NULL THEN
			RAISE EXCEPTION 'PAYABLE obligation revision must have funding_asset_account_id NULL';
		END IF;
	END IF;

	-- Canonical payload key whitelist & exact binding
	IF v_obligation.direction = 'RECEIVABLE' THEN
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'fundingAssetAccountId', 'dueDate', 'description')
		LIMIT 1;
	ELSE
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'budgetCategory', 'dueDate', 'description')
		LIMIT 1;
	END IF;
	IF v_invalid_key IS NOT NULL THEN
		RAISE EXCEPTION 'Unexpected key % in % canonical payload', v_invalid_key, v_can_tx.kind;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'obligationId') != 'string' OR
	   v_can_rev.payload->>'obligationId' != NEW.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match obligation %',
			v_can_rev.payload->>'obligationId', NEW.obligation_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'personId') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'direction') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR
	   v_can_rev.payload->>'amount' != NEW.principal_amount::text THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match revision principal_amount %',
			v_can_rev.payload->>'amount', NEW.principal_amount;
	END IF;

	IF v_obligation.direction = 'RECEIVABLE' THEN
		IF jsonb_typeof(v_can_rev.payload->'fundingAssetAccountId') != 'string' OR
		   v_can_rev.payload->>'fundingAssetAccountId' != NEW.funding_asset_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload fundingAssetAccountId % does not match revision %',
				v_can_rev.payload->>'fundingAssetAccountId', NEW.funding_asset_account_id;
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'budgetCategory') != 'string' OR
		   v_can_rev.payload->>'budgetCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload budgetCategory % does not match revision %',
				v_can_rev.payload->>'budgetCategory', NEW.budget_category;
		END IF;
	END IF;

	IF NEW.due_date IS NULL THEN
		IF v_can_rev.payload->'dueDate' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'dueDate') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload dueDate must be null when projection due_date is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'dueDate') != 'string' OR
		   v_can_rev.payload->>'dueDate' != NEW.due_date::text THEN
			RAISE EXCEPTION 'Canonical payload dueDate % does not match revision due_date %',
				v_can_rev.payload->>'dueDate', NEW.due_date;
		END IF;
	END IF;

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
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_obligation_revision_insert ON "person_obligation_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_obligation_revision_insert
BEFORE INSERT ON "person_obligation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_obligation_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 4. SETTLEMENT REVISION GUARD: FIXED LATEST-STATUS CHECK, CORRECT LOCK ORDER
-- (person -> obligation -> settlement), + one-receipt-one-settlement guard
-- ============================================================================

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

	-- Canonical payload key whitelist & exact binding
	SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
	WHERE k NOT IN ('settlementId', 'obligationId', 'personId', 'direction', 'appliedAmount', 'cashAmount', 'excessAmount', 'assetAccountId', 'note')
	LIMIT 1;
	IF v_invalid_key IS NOT NULL THEN
		RAISE EXCEPTION 'Unexpected key % in PERSON_OBLIGATION_SETTLEMENT canonical payload', v_invalid_key;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'settlementId') != 'string' OR
	   v_can_rev.payload->>'settlementId' != NEW.settlement_id::text THEN
		RAISE EXCEPTION 'Canonical payload settlementId % does not match settlement %',
			v_can_rev.payload->>'settlementId', NEW.settlement_id;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'obligationId') != 'string' OR
	   v_can_rev.payload->>'obligationId' != v_settlement.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match settlement obligation %',
			v_can_rev.payload->>'obligationId', v_settlement.obligation_id;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'personId') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'direction') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'appliedAmount') != 'string' OR
	   v_can_rev.payload->>'appliedAmount' != NEW.applied_amount::text THEN
		RAISE EXCEPTION 'Canonical payload appliedAmount % does not match revision %',
			v_can_rev.payload->>'appliedAmount', NEW.applied_amount;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'cashAmount') != 'string' OR
	   v_can_rev.payload->>'cashAmount' != NEW.cash_amount::text THEN
		RAISE EXCEPTION 'Canonical payload cashAmount % does not match revision %',
			v_can_rev.payload->>'cashAmount', NEW.cash_amount;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'excessAmount') != 'string' OR
	   v_can_rev.payload->>'excessAmount' != NEW.excess_amount::text THEN
		RAISE EXCEPTION 'Canonical payload excessAmount % does not match revision %',
			v_can_rev.payload->>'excessAmount', NEW.excess_amount;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'assetAccountId') != 'string' OR
	   v_can_rev.payload->>'assetAccountId' != NEW.asset_account_id::text THEN
		RAISE EXCEPTION 'Canonical payload assetAccountId % does not match revision %',
			v_can_rev.payload->>'assetAccountId', NEW.asset_account_id;
	END IF;
	IF NEW.note IS NULL THEN
		IF v_can_rev.payload->'note' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'note') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload note must be null when projection note is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'note') != 'string' OR
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

			-- One receipt -> exactly one settlement: reject if already linked
			-- to a DIFFERENT settlement (either direction of the race).
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

	-- VOID: if the settlement carried a linked overpayment income receipt, it
	-- must already be VOID (the app layer voids it first, in the same outer
	-- transaction, before inserting this VOID projection row).
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_settlement_revision_insert ON "person_settlement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_settlement_revision_insert
BEFORE INSERT ON "person_settlement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_settlement_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 5. REVERSE COMPANION GUARD ON income_receipt_revisions
-- Applies only to receipts whose source is linked via
-- people_system_income_links.role = OVERPAYMENT_EXTRA. Deferred, since the
-- income receipt revision is always inserted (by the app layer, in the same
-- outer transaction) before the corresponding People settlement revision.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_people_overpayment_income_companion()
RETURNS TRIGGER AS $$
DECLARE
	v_receipt RECORD;
	v_link RECORD;
	v_create_count INT;
	v_settlement_rev RECORD;
BEGIN
	SELECT * INTO v_receipt FROM income_receipts WHERE id = NEW.income_receipt_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT l.* INTO v_link FROM people_system_income_links l
	WHERE l.income_source_id = v_receipt.source_id AND l.role = 'OVERPAYMENT_EXTRA';
	IF NOT FOUND THEN
		-- Not a People overpayment receipt; not our concern.
		RETURN NULL;
	END IF;

	IF NEW.operation = 'CREATE' THEN
		SELECT count(*) INTO v_create_count
		FROM person_settlement_revisions
		WHERE overpayment_income_receipt_id = NEW.income_receipt_id AND operation = 'CREATE';

		IF v_create_count != 1 THEN
			RAISE EXCEPTION 'People overpayment income receipt % must have exactly one linking settlement CREATE revision, found %',
				NEW.income_receipt_id, v_create_count;
		END IF;

		SELECT * INTO v_settlement_rev FROM person_settlement_revisions
		WHERE overpayment_income_receipt_id = NEW.income_receipt_id AND operation = 'CREATE'
		LIMIT 1;

		IF v_settlement_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Overpayment income receipt % settlement companion belongs to a different user', NEW.income_receipt_id;
		END IF;
		IF v_settlement_rev.excess_amount != NEW.amount THEN
			RAISE EXCEPTION 'Overpayment income receipt % amount % does not match settlement excess_amount %',
				NEW.income_receipt_id, NEW.amount, v_settlement_rev.excess_amount;
		END IF;
		IF v_settlement_rev.asset_account_id != NEW.destination_account_id THEN
			RAISE EXCEPTION 'Overpayment income receipt % destination_account_id does not match settlement asset_account_id', NEW.income_receipt_id;
		END IF;
		IF v_settlement_rev.occurred_at != NEW.occurred_at THEN
			RAISE EXCEPTION 'Overpayment income receipt % occurred_at does not match settlement occurred_at', NEW.income_receipt_id;
		END IF;

	ELSIF NEW.operation = 'UPDATE' THEN
		RAISE EXCEPTION 'People overpayment income receipt % cannot be independently updated', NEW.income_receipt_id;

	ELSIF NEW.operation = 'VOID' THEN
		SELECT * INTO v_settlement_rev FROM person_settlement_revisions
		WHERE overpayment_income_receipt_id = NEW.income_receipt_id AND operation = 'VOID'
		LIMIT 1;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'People overpayment income receipt % VOID requires a matching People settlement VOID revision', NEW.income_receipt_id;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_overpayment_income_companion ON "income_receipt_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_overpayment_income_companion
AFTER INSERT ON "income_receipt_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_overpayment_income_companion();
