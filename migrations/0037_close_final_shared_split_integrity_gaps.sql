-- ============================================================================
-- PHASE 11B-R2: FINAL SPLIT PROVENANCE & COMMIT-TIME BINDING CLOSEOUT
--
-- A. Extends trg_fn_guard_person_obligation_revision_insert (0036 baseline) to
--    additionally bind, at the moment a CREDIT_CARD_PURCHASE_SPLIT obligation
--    revision is inserted: payload.splitId must identify a real split owned
--    by the same user, payload.purchaseEventId must match that split's
--    purchase_event_id, and the referenced splitRevisionId must belong to
--    that same split. (Participant-level provenance -- payload.splitParticipantId
--    and the revision-item companion -- cannot be checked here immediately,
--    because the legitimate service transaction inserts the participant row
--    and revision item AFTER the obligation revision; those are enforced as a
--    deferred, order-independent commit-time check below.)
--
-- B. Extends trg_fn_guard_cc_split_commit_check (0036 baseline, already
--    deferred and already registered on credit_card_purchase_splits,
--    credit_card_purchase_split_revisions, credit_card_purchase_split_participants,
--    credit_card_purchase_split_revision_items, and person_obligation_revisions)
--    to additionally require, for every split participant anchor:
--      1. its person_obligation's canonical transaction kind is exactly
--         CREDIT_CARD_PURCHASE_SPLIT (a standalone PERSON_RECEIVABLE_ADVANCE
--         obligation can never back a split participant, even if its
--         user/person/principal happen to match);
--      2. the obligation's latest stored canonical payload exactly identifies
--         this participant (splitParticipantId), this split (splitId), this
--         split's purchase event (purchaseEventId), and a splitRevisionId
--         that belongs to this split;
--      3. that referenced splitRevisionId contains exactly one revision item
--         whose participant_id/person_id/share_amount match the obligation's
--         own payload -- the "revision item companion" requirement, which
--         covers CREATE/UPDATE (payload's splitRevisionId is the split's
--         current revision) and VOID (payload's splitRevisionId is preserved
--         from before the void, since the canonical VOID layer always copies
--         forward the previous revision's payload unchanged).
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

		IF jsonb_typeof(v_can_rev.payload->'fundingAssetAccountId') != 'string' OR
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

		IF jsonb_typeof(v_can_rev.payload->'expenseAccountId') != 'string' THEN
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

		-- Authoritative binding: expenseAccountId must equal the exact shared
		-- system expense account implied by the referenced split revision's
		-- underlying purchase revision budget_category (same mapping as gross
		-- purchase), not merely "any EXPENSE/DEBIT account".
		IF jsonb_typeof(v_can_rev.payload->'splitRevisionId') != 'string' THEN
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

		-- PHASE 11B-R2: exact split/purchase-event provenance. payload.splitId
		-- must identify a real split owned by this user, whose purchase_event_id
		-- matches payload.purchaseEventId, and the referenced splitRevisionId
		-- must belong to that same split. (Participant-level provenance --
		-- splitParticipantId and the revision-item companion -- is enforced by
		-- the deferred commit-time check, since the participant/item rows are
		-- inserted after the obligation revision in the legitimate service flow.)
		IF jsonb_typeof(v_can_rev.payload->'splitId') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload splitId missing or not a string';
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'purchaseEventId') != 'string' THEN
			RAISE EXCEPTION 'Canonical payload purchaseEventId missing or not a string';
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'splitParticipantId') != 'string' THEN
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

		IF jsonb_typeof(v_can_rev.payload->'budgetCategory') != 'string' OR
		   v_can_rev.payload->>'budgetCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload budgetCategory % does not match revision %',
				v_can_rev.payload->>'budgetCategory', NEW.budget_category;
		END IF;
	END IF;

	-- Standard canonical payload bindings shared by all kinds
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

-- ============================================================================
-- B. DEFERRED COMMIT-TIME PROVENANCE: canonical kind + exact participant
--    binding + revision-item companion (order-independent; already registered
--    on all 5 relevant tables from 0036, only the function body changes).
-- ============================================================================

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
		-- 1. Naked anchor: a split identity with zero revisions must not exist
		-- at commit (this also protects the purchase_event_id 1:1 slot from
		-- being silently occupied without a real split ever forming).
		SELECT * INTO v_latest_split_rev
		FROM credit_card_purchase_split_revisions
		WHERE split_id = v_split.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF v_latest_split_rev IS NULL THEN
			RAISE EXCEPTION 'Split % has no revisions at commit (naked split anchor)', v_split.id;
		END IF;

		-- 2. Seal completeness: every revision of this split must have exactly
		-- one seal by commit time.
		FOR v_prev_split_rev IN
			SELECT * FROM credit_card_purchase_split_revisions WHERE split_id = v_split.id
		LOOP
			SELECT * INTO v_seal FROM credit_card_purchase_split_revision_seals WHERE split_revision_id = v_prev_split_rev.id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Split revision % has no seal at commit', v_prev_split_rev.id;
			END IF;
		END LOOP;

		-- 3. Orphan participant + PHASE 11B-R2 provenance: every participant
		-- anchor on this split must (a) be referenced by at least one revision
		-- item, (b) be backed by a person_obligation whose canonical kind is
		-- exactly CREDIT_CARD_PURCHASE_SPLIT (a standalone
		-- PERSON_RECEIVABLE_ADVANCE obligation can never back a participant,
		-- even with matching user/person/principal), (c) have that obligation's
		-- latest stored payload exactly identify this participant/split/
		-- purchase-event, and (d) have the payload's referenced splitRevisionId
		-- contain exactly one matching revision item (the "revision item
		-- companion", covering CREATE/UPDATE and VOID alike since a VOID's
		-- canonical payload is preserved unchanged from before the void).
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
			IF v_obl_payload->>'splitParticipantId' != v_any_participant.id::text THEN
				RAISE EXCEPTION 'Obligation % payload splitParticipantId % does not match participant %',
					v_obl.id, v_obl_payload->>'splitParticipantId', v_any_participant.id;
			END IF;
			IF v_obl_payload->>'splitId' != v_split.id::text THEN
				RAISE EXCEPTION 'Obligation % payload splitId % does not match split %',
					v_obl.id, v_obl_payload->>'splitId', v_split.id;
			END IF;
			IF v_obl_payload->>'purchaseEventId' != v_split.purchase_event_id::text THEN
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
			-- 5. VOID final invariant (previously skipped entirely; now enforced).
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

			-- Every participant obligation active in the preceding snapshot must
			-- now be VOID; a raw split VOID that leaves receivables active is
			-- rejected.
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
