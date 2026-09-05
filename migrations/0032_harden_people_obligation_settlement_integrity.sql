-- ============================================================================
-- Phase 11A-R1: Harden People Obligation/Settlement Integrity
-- 1. Person ledger link insert guard (wrong-user/wrong-type/wrong-currency)
-- 2. Person anchor completeness (deferred, mirrors Phase 10 pattern)
-- 3. People system income link insert guard (OVERPAYMENT_EXTRA role)
-- 4. Person subledger <-> ledger reconciliation, extended to obligation and
--    settlement revision inserts (not just journal_lines), with fail-closed
--    negative-remaining detection (no GREATEST clamp)
-- 5. Obligation revision guard: archived-person check for ALL fresh
--    operations (not just revision #1) + funding asset currency check
-- 6. Settlement revision guard: archived-person check for CREATE/VOID +
--    overpayment income receipt binding (CREATE) + linked-receipt-must-be-
--    VOID invariant (VOID)
-- 7. Exact obligation ledger effect binding (applied/reversal journal lines)
-- 8. Exact settlement ledger effect binding (applied/reversal journal lines)
-- ============================================================================

-- ============================================================================
-- 1. PERSON LEDGER LINK INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_ledger_links_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_person RECORD;
	v_user RECORD;
	v_receivable RECORD;
	v_payable RECORD;
BEGIN
	SELECT * INTO v_person FROM people WHERE id = NEW.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person % not found for ledger link', NEW.person_id;
	END IF;
	IF v_person.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Person user_id % does not match link user_id %', v_person.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_user FROM users WHERE id = NEW.user_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'User % not found for ledger link', NEW.user_id;
	END IF;

	IF NEW.receivable_account_id = NEW.payable_account_id THEN
		RAISE EXCEPTION 'Receivable and payable accounts must differ for person %', NEW.person_id;
	END IF;

	SELECT * INTO v_receivable FROM ledger_accounts WHERE id = NEW.receivable_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Receivable account % not found', NEW.receivable_account_id;
	END IF;
	IF v_receivable.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Receivable account % belongs to a different user', NEW.receivable_account_id;
	END IF;
	IF v_receivable.account_type != 'ASSET' OR v_receivable.normal_balance != 'DEBIT' THEN
		RAISE EXCEPTION 'Receivable account % must be ASSET/DEBIT', NEW.receivable_account_id;
	END IF;
	IF v_receivable.currency != v_user.currency THEN
		RAISE EXCEPTION 'Receivable account % currency does not match user currency', NEW.receivable_account_id;
	END IF;
	IF v_receivable.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Receivable account % is archived', NEW.receivable_account_id;
	END IF;

	SELECT * INTO v_payable FROM ledger_accounts WHERE id = NEW.payable_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Payable account % not found', NEW.payable_account_id;
	END IF;
	IF v_payable.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Payable account % belongs to a different user', NEW.payable_account_id;
	END IF;
	IF v_payable.account_type != 'LIABILITY' OR v_payable.normal_balance != 'CREDIT' THEN
		RAISE EXCEPTION 'Payable account % must be LIABILITY/CREDIT', NEW.payable_account_id;
	END IF;
	IF v_payable.currency != v_user.currency THEN
		RAISE EXCEPTION 'Payable account % currency does not match user currency', NEW.payable_account_id;
	END IF;
	IF v_payable.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Payable account % is archived', NEW.payable_account_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_ledger_links_insert ON "person_ledger_links";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_ledger_links_insert
BEFORE INSERT ON "person_ledger_links"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_ledger_links_insert();--> statement-breakpoint

-- ============================================================================
-- 2. PERSON ANCHOR COMPLETENESS (deferred, Phase 10 0030 pattern)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_people_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_rev RECORD;
BEGIN
	SELECT * INTO v_rev FROM person_revisions WHERE person_id = NEW.id AND revision_no = 1;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person % has no initial revision #1 at commit', NEW.id;
	END IF;
	IF v_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Person % revision #1 must have operation CREATE, found %', NEW.id, v_rev.operation;
	END IF;
	IF v_rev.status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Person % revision #1 must have status ACTIVE, found %', NEW.id, v_rev.status;
	END IF;
	IF v_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Person % revision user_id % does not match anchor user_id %', NEW.id, v_rev.user_id, NEW.user_id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_anchor_completeness ON "people";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_anchor_completeness
AFTER INSERT ON "people"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_anchor_completeness();--> statement-breakpoint

-- ============================================================================
-- 3. PEOPLE SYSTEM INCOME LINK INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_people_system_income_links_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_source RECORD;
	v_account RECORD;
	v_user RECORD;
BEGIN
	IF NEW.role = 'OVERPAYMENT_EXTRA' THEN
		SELECT * INTO v_source FROM income_sources WHERE id = NEW.income_source_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Income source % not found for people system income link', NEW.income_source_id;
		END IF;
		IF v_source.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Income source % belongs to a different user', NEW.income_source_id;
		END IF;
		IF v_source.code != 'PEOPLE_OVERPAYMENT' THEN
			RAISE EXCEPTION 'OVERPAYMENT_EXTRA role requires income source code PEOPLE_OVERPAYMENT, found %', v_source.code;
		END IF;
		IF v_source.nature != 'EXTRA' THEN
			RAISE EXCEPTION 'OVERPAYMENT_EXTRA role requires income source nature EXTRA, found %', v_source.nature;
		END IF;
		IF v_source.reference_method != 'EXCLUDED' THEN
			RAISE EXCEPTION 'OVERPAYMENT_EXTRA role requires income source reference_method EXCLUDED, found %', v_source.reference_method;
		END IF;
		IF v_source.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'OVERPAYMENT_EXTRA role requires an active (non-archived) income source';
		END IF;

		SELECT * INTO v_user FROM users WHERE id = NEW.user_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'User % not found for people system income link', NEW.user_id;
		END IF;

		SELECT * INTO v_account FROM ledger_accounts WHERE id = v_source.income_ledger_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Income ledger account % not found', v_source.income_ledger_account_id;
		END IF;
		IF v_account.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Income ledger account % belongs to a different user', v_account.id;
		END IF;
		IF v_account.account_type != 'INCOME' OR v_account.normal_balance != 'CREDIT' THEN
			RAISE EXCEPTION 'Income ledger account % must be INCOME/CREDIT', v_account.id;
		END IF;
		IF v_account.currency != v_user.currency THEN
			RAISE EXCEPTION 'Income ledger account % currency does not match user currency', v_account.id;
		END IF;
		IF v_account.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'Income ledger account % is archived', v_account.id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_system_income_links_insert ON "people_system_income_links";--> statement-breakpoint
CREATE TRIGGER trg_guard_people_system_income_links_insert
BEFORE INSERT ON "people_system_income_links"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_people_system_income_links_insert();--> statement-breakpoint

-- ============================================================================
-- 4. RECONCILIATION: SHARED HELPER + EXTENDED TRIGGER COVERAGE
-- Fail-closed: negative derived remaining is itself an invalid state and
-- raises, rather than being clamped to 0 and hidden from the reconciliation
-- comparison.
-- ============================================================================

CREATE OR REPLACE FUNCTION people_check_reconciliation_for_person(p_person_id UUID)
RETURNS VOID AS $$
DECLARE
	v_link RECORD;
	v_receivable_balance NUMERIC;
	v_payable_balance NUMERIC;
	v_receivable_expected NUMERIC;
	v_receivable_min NUMERIC;
	v_payable_expected NUMERIC;
	v_payable_min NUMERIC;
BEGIN
	SELECT * INTO v_link FROM person_ledger_links WHERE person_id = p_person_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) INTO v_receivable_balance
	FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
	WHERE jl.account_id = v_link.receivable_account_id AND je.status = 'POSTED';

	SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) INTO v_payable_balance
	FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
	WHERE jl.account_id = v_link.payable_account_id AND je.status = 'POSTED';

	SELECT COALESCE(SUM(t.remaining), 0), COALESCE(MIN(t.remaining), 0)
	INTO v_receivable_expected, v_receivable_min
	FROM (
		SELECT
			(latest_rev.principal_amount - COALESCE(settled.total, 0)) AS remaining
		FROM person_obligations po
		JOIN LATERAL (
			SELECT * FROM person_obligation_revisions
			WHERE obligation_id = po.id ORDER BY revision_no DESC LIMIT 1
		) latest_rev ON true
		LEFT JOIN LATERAL (
			SELECT SUM(x.applied_amount) AS total FROM (
				SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
				FROM person_settlement_revisions psr
				JOIN person_settlements ps ON ps.id = psr.settlement_id
				WHERE ps.obligation_id = po.id
				ORDER BY psr.settlement_id, psr.revision_no DESC
			) x WHERE x.operation != 'VOID'
		) settled ON true
		WHERE po.person_id = p_person_id AND po.direction = 'RECEIVABLE' AND latest_rev.operation != 'VOID'
	) t;

	SELECT COALESCE(SUM(t.remaining), 0), COALESCE(MIN(t.remaining), 0)
	INTO v_payable_expected, v_payable_min
	FROM (
		SELECT
			(latest_rev.principal_amount - COALESCE(settled.total, 0)) AS remaining
		FROM person_obligations po
		JOIN LATERAL (
			SELECT * FROM person_obligation_revisions
			WHERE obligation_id = po.id ORDER BY revision_no DESC LIMIT 1
		) latest_rev ON true
		LEFT JOIN LATERAL (
			SELECT SUM(x.applied_amount) AS total FROM (
				SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
				FROM person_settlement_revisions psr
				JOIN person_settlements ps ON ps.id = psr.settlement_id
				WHERE ps.obligation_id = po.id
				ORDER BY psr.settlement_id, psr.revision_no DESC
			) x WHERE x.operation != 'VOID'
		) settled ON true
		WHERE po.person_id = p_person_id AND po.direction = 'PAYABLE' AND latest_rev.operation != 'VOID'
	) t;

	IF v_receivable_min < 0 THEN
		RAISE EXCEPTION 'Person % has a RECEIVABLE obligation with invalid negative derived remaining', p_person_id;
	END IF;
	IF v_payable_min < 0 THEN
		RAISE EXCEPTION 'Person % has a PAYABLE obligation with invalid negative derived remaining', p_person_id;
	END IF;
	IF v_receivable_balance < 0 THEN
		RAISE EXCEPTION 'Person % receivable ledger balance cannot become negative (%)', p_person_id, v_receivable_balance;
	END IF;
	IF v_payable_balance < 0 THEN
		RAISE EXCEPTION 'Person % payable ledger balance cannot become negative (%)', p_person_id, v_payable_balance;
	END IF;
	IF v_receivable_balance != v_receivable_expected THEN
		RAISE EXCEPTION 'Person % receivable ledger balance % does not reconcile with derived obligation remaining %',
			p_person_id, v_receivable_balance, v_receivable_expected;
	END IF;
	IF v_payable_balance != v_payable_expected THEN
		RAISE EXCEPTION 'Person % payable ledger balance % does not reconcile with derived obligation remaining %',
			p_person_id, v_payable_balance, v_payable_expected;
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation()
RETURNS TRIGGER AS $$
DECLARE
	v_link RECORD;
BEGIN
	SELECT * INTO v_link FROM person_ledger_links
	WHERE receivable_account_id = NEW.account_id OR payable_account_id = NEW.account_id;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	PERFORM people_check_reconciliation_for_person(v_link.person_id);
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_ledger_reconciliation ON "journal_lines";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_ledger_reconciliation
AFTER INSERT ON "journal_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_ledger_reconciliation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation_obligation()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
BEGIN
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	PERFORM people_check_reconciliation_for_person(v_obligation.person_id);
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_ledger_reconciliation_obligation ON "person_obligation_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_ledger_reconciliation_obligation
AFTER INSERT ON "person_obligation_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_ledger_reconciliation_obligation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation_settlement()
RETURNS TRIGGER AS $$
DECLARE
	v_settlement RECORD;
	v_obligation RECORD;
BEGIN
	SELECT * INTO v_settlement FROM person_settlements WHERE id = NEW.settlement_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	SELECT * INTO v_obligation FROM person_obligations WHERE id = v_settlement.obligation_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	PERFORM people_check_reconciliation_for_person(v_obligation.person_id);
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_ledger_reconciliation_settlement ON "person_settlement_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_ledger_reconciliation_settlement
AFTER INSERT ON "person_settlement_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_ledger_reconciliation_settlement();--> statement-breakpoint

-- ============================================================================
-- 5. OBLIGATION REVISION GUARD: ARCHIVED-PERSON FOR ALL OPS + CURRENCY CHECK
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_person RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_expected_kind TEXT;
	v_invalid_key TEXT;
	v_active_settled NUMERIC;
	v_funding_account RECORD;
	v_user_currency VARCHAR(3);
BEGIN
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person obligation % not found', NEW.obligation_id;
	END IF;
	IF v_obligation.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Obligation user_id % does not match revision user_id %', v_obligation.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_person FROM people WHERE id = v_obligation.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person % not found for obligation %', v_obligation.person_id, NEW.obligation_id;
	END IF;

	-- Archived-person guard applies to EVERY fresh obligation revision (CREATE,
	-- UPDATE, and VOID alike): once a person is archived, all fresh mutations
	-- are closed. Historical exact replay never reaches this INSERT.
	IF NOT EXISTS (
		SELECT 1 FROM person_revisions
		WHERE person_id = v_obligation.person_id AND status = 'ACTIVE'
		ORDER BY revision_no DESC LIMIT 1
	) THEN
		RAISE EXCEPTION 'Cannot mutate obligation for archived or unknown person %', v_obligation.person_id;
	END IF;

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
		IF v_person.user_id IS NULL THEN
			RAISE EXCEPTION 'Person lookup failed';
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
-- 6. SETTLEMENT REVISION GUARD: ARCHIVED-PERSON + OVERPAYMENT INCOME BINDING
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_settlement RECORD;
	v_obligation RECORD;
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
	SELECT * INTO v_settlement FROM person_settlements WHERE id = NEW.settlement_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person settlement % not found', NEW.settlement_id;
	END IF;
	IF v_settlement.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Settlement user_id % does not match revision user_id %', v_settlement.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_obligation FROM person_obligations WHERE id = v_settlement.obligation_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Obligation % not found for settlement %', v_settlement.obligation_id, NEW.settlement_id;
	END IF;

	-- Archived-person guard applies to fresh settlement CREATE and VOID alike.
	IF NOT EXISTS (
		SELECT 1 FROM person_revisions
		WHERE person_id = v_obligation.person_id AND status = 'ACTIVE'
		ORDER BY revision_no DESC LIMIT 1
	) THEN
		RAISE EXCEPTION 'Cannot mutate settlement for archived or unknown person %', v_obligation.person_id;
	END IF;

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

		-- Overpayment income receipt binding: only RECEIVABLE settlements with
		-- excess_amount > 0 may carry a linked income receipt, and it must
		-- resolve to the OVERPAYMENT_EXTRA system source with an exact amount
		-- and destination-account match.
		IF NEW.excess_amount > 0 THEN
			SELECT * INTO v_income_receipt FROM income_receipts WHERE id = NEW.overpayment_income_receipt_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Overpayment income receipt % not found', NEW.overpayment_income_receipt_id;
			END IF;
			IF v_income_receipt.user_id != NEW.user_id THEN
				RAISE EXCEPTION 'Overpayment income receipt % belongs to a different user', NEW.overpayment_income_receipt_id;
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
-- 7. EXACT OBLIGATION LEDGER EFFECT BINDING
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_ledger_effect()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_link RECORD;
	v_binding RECORD;
	v_expected_role TEXT;
	v_expense_account_id UUID;
	v_line_count INT;
	v_dr_account UUID;
	v_dr_amount NUMERIC;
	v_cr_account UUID;
	v_cr_amount NUMERIC;
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

	SELECT * INTO v_link FROM person_ledger_links WHERE person_id = v_obligation.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person ledger link missing for person % (obligation %)', v_obligation.person_id, NEW.obligation_id;
	END IF;

	SELECT * INTO v_binding FROM transaction_ledger_bindings WHERE revision_id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'No transaction_ledger_bindings row for obligation revision %', NEW.id;
	END IF;

	IF NEW.operation IN ('CREATE', 'UPDATE') THEN
		IF v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Obligation revision % (%) has no applied journal entry', NEW.id, NEW.operation;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Obligation revision % applied journal entry % must have exactly 2 lines, found %',
				NEW.id, v_binding.applied_journal_entry_id, v_line_count;
		END IF;

		SELECT account_id, debit INTO v_dr_account, v_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND debit > 0;
		SELECT account_id, credit INTO v_cr_account, v_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND credit > 0;

		IF v_obligation.direction = 'RECEIVABLE' THEN
			IF v_dr_account != v_link.receivable_account_id THEN
				RAISE EXCEPTION 'Obligation % applied debit account % does not match person receivable account %',
					NEW.obligation_id, v_dr_account, v_link.receivable_account_id;
			END IF;
			IF v_cr_account != NEW.funding_asset_account_id THEN
				RAISE EXCEPTION 'Obligation % applied credit account % does not match funding_asset_account_id %',
					NEW.obligation_id, v_cr_account, NEW.funding_asset_account_id;
			END IF;
		ELSE
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_obligation_ledger_effect ON "person_obligation_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_obligation_ledger_effect
AFTER INSERT ON "person_obligation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_obligation_ledger_effect();--> statement-breakpoint

-- ============================================================================
-- 8. EXACT SETTLEMENT LEDGER EFFECT BINDING
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_ledger_effect()
RETURNS TRIGGER AS $$
DECLARE
	v_settlement RECORD;
	v_obligation RECORD;
	v_link RECORD;
	v_binding RECORD;
	v_line_count INT;
	v_dr_account UUID;
	v_dr_amount NUMERIC;
	v_cr_account UUID;
	v_cr_amount NUMERIC;
	v_prev_rev RECORD;
	v_prev_binding RECORD;
	v_prev_dr_account UUID;
	v_prev_dr_amount NUMERIC;
	v_prev_cr_account UUID;
	v_prev_cr_amount NUMERIC;
BEGIN
	SELECT * INTO v_settlement FROM person_settlements WHERE id = NEW.settlement_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Settlement % not found for ledger effect check', NEW.settlement_id;
	END IF;
	SELECT * INTO v_obligation FROM person_obligations WHERE id = v_settlement.obligation_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Obligation % not found for settlement %', v_settlement.obligation_id, NEW.settlement_id;
	END IF;
	SELECT * INTO v_link FROM person_ledger_links WHERE person_id = v_obligation.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person ledger link missing for person %', v_obligation.person_id;
	END IF;

	SELECT * INTO v_binding FROM transaction_ledger_bindings WHERE revision_id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'No transaction_ledger_bindings row for settlement revision %', NEW.id;
	END IF;

	IF NEW.operation = 'CREATE' THEN
		IF v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Settlement CREATE revision % has no applied journal entry', NEW.id;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Settlement % applied journal entry must have exactly 2 lines, found %', NEW.settlement_id, v_line_count;
		END IF;

		SELECT account_id, debit INTO v_dr_account, v_dr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND debit > 0;
		SELECT account_id, credit INTO v_cr_account, v_cr_amount
			FROM journal_lines WHERE journal_entry_id = v_binding.applied_journal_entry_id AND credit > 0;

		IF v_obligation.direction = 'RECEIVABLE' THEN
			IF v_dr_account != NEW.asset_account_id THEN
				RAISE EXCEPTION 'Settlement % applied debit account % does not match asset_account_id %',
					NEW.settlement_id, v_dr_account, NEW.asset_account_id;
			END IF;
			IF v_cr_account != v_link.receivable_account_id THEN
				RAISE EXCEPTION 'Settlement % applied credit account % does not match person receivable account %',
					NEW.settlement_id, v_cr_account, v_link.receivable_account_id;
			END IF;
		ELSE
			IF v_dr_account != v_link.payable_account_id THEN
				RAISE EXCEPTION 'Settlement % applied debit account % does not match person payable account %',
					NEW.settlement_id, v_dr_account, v_link.payable_account_id;
			END IF;
			IF v_cr_account != NEW.asset_account_id THEN
				RAISE EXCEPTION 'Settlement % applied credit account % does not match asset_account_id %',
					NEW.settlement_id, v_cr_account, NEW.asset_account_id;
			END IF;
		END IF;

		IF v_dr_amount != NEW.applied_amount OR v_cr_amount != NEW.applied_amount THEN
			RAISE EXCEPTION 'Settlement % applied journal amount does not match applied_amount %',
				NEW.settlement_id, NEW.applied_amount;
		END IF;

	ELSIF NEW.operation = 'VOID' THEN
		IF v_binding.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Settlement VOID revision % has no reversal journal entry', NEW.id;
		END IF;
		IF v_binding.applied_journal_entry_id IS NOT NULL THEN
			RAISE EXCEPTION 'Settlement VOID revision % must not have an applied journal entry', NEW.id;
		END IF;

		SELECT * INTO v_prev_rev FROM person_settlement_revisions WHERE id = NEW.previous_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'VOID revision % missing previous revision for reversal check', NEW.id;
		END IF;
		SELECT * INTO v_prev_binding FROM transaction_ledger_bindings WHERE revision_id = v_prev_rev.canonical_revision_id;
		IF NOT FOUND OR v_prev_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Previous settlement revision % has no applied journal entry to reverse', v_prev_rev.id;
		END IF;

		SELECT count(*) INTO v_line_count FROM journal_lines WHERE journal_entry_id = v_binding.reversal_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Settlement VOID revision % reversal journal entry must have exactly 2 lines, found %', NEW.id, v_line_count;
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
			RAISE EXCEPTION 'Settlement % VOID reversal debit line does not mirror original credit line', NEW.settlement_id;
		END IF;
		IF v_cr_account != v_prev_dr_account OR v_cr_amount != v_prev_dr_amount THEN
			RAISE EXCEPTION 'Settlement % VOID reversal credit line does not mirror original debit line', NEW.settlement_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_settlement_ledger_effect ON "person_settlement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_settlement_ledger_effect
AFTER INSERT ON "person_settlement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_settlement_ledger_effect();
