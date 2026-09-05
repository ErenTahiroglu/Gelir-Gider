CREATE UNIQUE INDEX "long_term_task_revisions_canonical_rev_idx" ON "long_term_send_task_revisions" USING btree ("canonical_revision_id") WHERE "long_term_send_task_revisions"."canonical_revision_id" IS NOT NULL;--> statement-breakpoint

-- ============================================================================
-- PHASE 13-R1: LONG-TERM SEND INTEGRITY HARDENING
--
-- A. Exact 6-key canonical payload (all keys present, nullable fields
--    present as explicit JSON null, no extras) -- shared helper used by
--    both the SENT canonical CREATE payload and the REOPEN canonical VOID
--    payload (which must copy the SEND snapshot forward unchanged).
-- B. Canonical revision lifecycle sealing: a deferred trigger on
--    transaction_revisions makes the reverse direction (canonical -> task)
--    equally authoritative for EVERY revision (not just the anchor), for
--    the entire lifetime of a LONG_TERM_INVESTMENT_SEND transaction --
--    UPDATE is always rejected; CREATE requires exactly one companion
--    SENT/SENT task revision; VOID requires exactly one companion
--    REOPEN/PENDING task revision.
-- C. REOPEN must prove the exact bound-ledger reversal of the preceding
--    SENT (chain adjacency, ledger binding shape, exact reversed 2-line
--    journal, both account contracts revalidated).
-- D/one-to-one: long_term_task_revisions_canonical_rev_idx (above) ensures
--    a canonical revision belongs to at most one task revision.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. SHARED EXACT SEND-PAYLOAD VALIDATOR
-- ----------------------------------------------------------------------------

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
	IF jsonb_typeof(p_payload) != 'object' THEN
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

	IF jsonb_typeof(p_payload->'taskId') != 'string' OR p_payload->>'taskId' != p_task_id::text THEN
		RAISE EXCEPTION '% payload taskId % does not match task %', p_context, p_payload->>'taskId', p_task_id;
	END IF;
	IF jsonb_typeof(p_payload->'midasAccountId') != 'string' OR p_payload->>'midasAccountId' != p_midas_account_id::text THEN
		RAISE EXCEPTION '% payload midasAccountId % does not match task Midas account %', p_context, p_payload->>'midasAccountId', p_midas_account_id;
	END IF;
	IF jsonb_typeof(p_payload->'pendingBucketId') != 'string' OR p_payload->>'pendingBucketId' != p_pending_bucket_id::text THEN
		RAISE EXCEPTION '% payload pendingBucketId % does not match task pending bucket %', p_context, p_payload->>'pendingBucketId', p_pending_bucket_id;
	END IF;
	IF jsonb_typeof(p_payload->'amount') != 'string' OR p_payload->>'amount' != p_amount::text THEN
		RAISE EXCEPTION '% payload amount % does not match amount %', p_context, p_payload->>'amount', p_amount;
	END IF;

	IF p_destination_label IS NULL THEN
		IF jsonb_typeof(p_payload->'destinationLabel') != 'null' THEN
			RAISE EXCEPTION '% payload destinationLabel must be explicit JSON null when destination_label is null', p_context;
		END IF;
	ELSE
		IF jsonb_typeof(p_payload->'destinationLabel') != 'string' OR p_payload->>'destinationLabel' != p_destination_label THEN
			RAISE EXCEPTION '% payload destinationLabel % does not match %', p_context, p_payload->>'destinationLabel', p_destination_label;
		END IF;
	END IF;

	IF p_note IS NULL THEN
		IF jsonb_typeof(p_payload->'note') != 'null' THEN
			RAISE EXCEPTION '% payload note must be explicit JSON null when note is null', p_context;
		END IF;
	ELSE
		IF jsonb_typeof(p_payload->'note') != 'string' OR p_payload->>'note' != p_note THEN
			RAISE EXCEPTION '% payload note % does not match %', p_context, p_payload->>'note', p_note;
		END IF;
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. REPLACE trg_fn_guard_long_term_task_revision_insert:
--    - SENT branch now uses the shared exact-6-key payload validator.
--    - REOPEN branch now proves exact canonical VOID chain adjacency,
--      copies-forward payload validation, exact reversal ledger binding
--      (previous_binding_id chain, applied/reversal null shape, exact
--      2-line reversed journal), and revalidates both account contracts.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_long_term_task_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_task RECORD;
	v_midas_account RECORD;
	v_pending_bucket RECORD;
	v_latest RECORD;
	v_create RECORD;
	v_transfer RECORD;
	v_expected_from UUID;
	v_expected_to UUID;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_user_currency TEXT;
	v_external_account RECORD;
	v_midas_ledger_account_id UUID;
	v_midas_account_ledger RECORD;
	v_line_count INT;
	v_debit_line RECORD;
	v_credit_line RECORD;
	v_void_rev RECORD;
	v_prev_can_rev RECORD;
	v_void_binding RECORD;
	v_prev_binding RECORD;
BEGIN
	SELECT * INTO v_task FROM long_term_send_tasks WHERE id = NEW.task_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Long-term send task % not found', NEW.task_id;
	END IF;
	IF v_task.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Long-term send task user_id % does not match revision user_id %', v_task.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_midas_account FROM midas_accounts WHERE id = v_task.midas_account_id;
	IF NOT FOUND OR v_midas_account.user_id != v_task.user_id THEN
		RAISE EXCEPTION 'Long-term send task % Midas account % does not belong to the same user', NEW.task_id, v_task.midas_account_id;
	END IF;

	SELECT * INTO v_pending_bucket FROM midas_buckets WHERE id = v_task.pending_bucket_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Long-term send task % pending bucket % not found', NEW.task_id, v_task.pending_bucket_id;
	END IF;
	IF v_pending_bucket.user_id != v_task.user_id OR v_pending_bucket.midas_account_id != v_task.midas_account_id THEN
		RAISE EXCEPTION 'Long-term send task % pending bucket % does not belong to the same user/Midas account', NEW.task_id, v_task.pending_bucket_id;
	END IF;
	IF v_pending_bucket.bucket_type != 'PENDING_LONG_TERM' THEN
		RAISE EXCEPTION 'Long-term send task % pending bucket % has wrong bucket_type %', NEW.task_id, v_task.pending_bucket_id, v_pending_bucket.bucket_type;
	END IF;

	-- Chain integrity + transition table.
	SELECT id, revision_no, operation, status, amount, destination_label, note, canonical_revision_id
	INTO v_latest
	FROM long_term_send_task_revisions
	WHERE task_id = NEW.task_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Long-term send task % already has revisions; revision 1 cannot be created again', NEW.task_id;
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
			RAISE EXCEPTION 'No predecessor revision exists for long-term send task %', NEW.task_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of long-term send task % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.task_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;

		IF v_latest.status = 'CANCELLED' THEN
			RAISE EXCEPTION 'Cannot create revision on CANCELLED long-term send task % (CANCELLED is terminal)', NEW.task_id;
		ELSIF v_latest.status = 'PENDING' THEN
			IF NEW.operation = 'SENT' THEN
				IF NEW.status != 'SENT' THEN
					RAISE EXCEPTION 'SENT operation must set status SENT, found %', NEW.status;
				END IF;
			ELSIF NEW.operation = 'CANCEL' THEN
				IF NEW.status != 'CANCELLED' THEN
					RAISE EXCEPTION 'CANCEL operation must set status CANCELLED, found %', NEW.status;
				END IF;
			ELSE
				RAISE EXCEPTION 'From PENDING status, only SENT or CANCEL are valid operations, found %', NEW.operation;
			END IF;
		ELSIF v_latest.status = 'SENT' THEN
			IF NEW.operation != 'REOPEN' THEN
				RAISE EXCEPTION 'From SENT status, only REOPEN is a valid operation, found %', NEW.operation;
			END IF;
			IF NEW.status != 'PENDING' THEN
				RAISE EXCEPTION 'REOPEN operation must set status PENDING, found %', NEW.status;
			END IF;
		ELSE
			RAISE EXCEPTION 'Unexpected predecessor status % for long-term send task %', v_latest.status, NEW.task_id;
		END IF;
	END IF;

	-- Amount and immutable context snapshot (destinationLabel/note) must copy
	-- forward exactly from the CREATE revision across the entire lifecycle.
	SELECT amount, destination_label, note INTO v_create
	FROM long_term_send_task_revisions
	WHERE task_id = NEW.task_id AND revision_no = 1;

	IF v_create.amount IS NOT NULL THEN
		IF NEW.amount != v_create.amount THEN
			RAISE EXCEPTION 'Task amount is immutable: expected %, found %', v_create.amount, NEW.amount;
		END IF;
		IF NEW.destination_label IS DISTINCT FROM v_create.destination_label THEN
			RAISE EXCEPTION 'Task destinationLabel is immutable and must copy forward exactly from CREATE';
		END IF;
		IF NEW.note IS DISTINCT FROM v_create.note THEN
			RAISE EXCEPTION 'Task note is immutable and must copy forward exactly from CREATE';
		END IF;
	END IF;

	-- Exact Midas allocation transfer companion binding (Section 7/8).
	SELECT * INTO v_transfer FROM midas_allocation_transfers WHERE id = NEW.midas_allocation_transfer_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Companion Midas allocation transfer % not found', NEW.midas_allocation_transfer_id;
	END IF;
	IF v_transfer.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Companion transfer user_id % does not match task revision user_id %', v_transfer.user_id, NEW.user_id;
	END IF;
	IF v_transfer.midas_account_id != v_task.midas_account_id THEN
		RAISE EXCEPTION 'Companion transfer midas_account_id % does not match task midas_account_id %', v_transfer.midas_account_id, v_task.midas_account_id;
	END IF;
	IF v_transfer.amount != NEW.amount THEN
		RAISE EXCEPTION 'Companion transfer amount % does not match task revision amount %', v_transfer.amount, NEW.amount;
	END IF;
	IF v_transfer.reversal_of_transfer_id IS NOT NULL THEN
		RAISE EXCEPTION 'Companion transfer % must not be a generic Midas reversal (reversal_of_transfer_id must be NULL); task lifecycle corrections are modeled exclusively via REOPEN', v_transfer.id;
	END IF;

	IF NEW.operation IN ('CREATE', 'REOPEN') THEN
		v_expected_from := NULL;
		v_expected_to := v_task.pending_bucket_id;
	ELSE
		v_expected_from := v_task.pending_bucket_id;
		v_expected_to := NULL;
	END IF;

	IF v_transfer.from_bucket_id IS DISTINCT FROM v_expected_from THEN
		RAISE EXCEPTION 'Companion transfer % from_bucket_id % does not match expected % for operation %',
			v_transfer.id, v_transfer.from_bucket_id, v_expected_from, NEW.operation;
	END IF;
	IF v_transfer.to_bucket_id IS DISTINCT FROM v_expected_to THEN
		RAISE EXCEPTION 'Companion transfer % to_bucket_id % does not match expected % for operation %',
			v_transfer.id, v_transfer.to_bucket_id, v_expected_to, NEW.operation;
	END IF;

	-- canonical_revision_id NULL/NOT NULL per operation, and exact bindings.
	IF NEW.operation IN ('CREATE', 'CANCEL') THEN
		IF NEW.canonical_revision_id IS NOT NULL THEN
			RAISE EXCEPTION '% revision must have canonical_revision_id NULL', NEW.operation;
		END IF;
	ELSIF NEW.operation = 'SENT' THEN
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'SENT revision requires canonical_revision_id';
		END IF;

		SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_can_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical revision user_id % does not match task revision user_id %', v_can_rev.user_id, NEW.user_id;
		END IF;
		IF v_can_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'SENT canonical revision must have operation CREATE, found %', v_can_rev.operation;
		END IF;
		IF v_can_rev.occurred_at != NEW.occurred_at THEN
			RAISE EXCEPTION 'Canonical revision occurred_at % does not match task revision occurred_at %', v_can_rev.occurred_at, NEW.occurred_at;
		END IF;

		SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
		END IF;
		IF v_can_tx.kind != 'LONG_TERM_INVESTMENT_SEND' THEN
			RAISE EXCEPTION 'SENT canonical transaction % has wrong kind %', v_can_tx.id, v_can_tx.kind;
		END IF;

		PERFORM trg_fn_long_term_validate_send_payload(
			v_can_rev.payload,
			NEW.task_id,
			v_task.midas_account_id,
			v_task.pending_bucket_id,
			NEW.amount,
			NEW.destination_label,
			NEW.note,
			'SENT canonical CREATE'
		);

		-- Exact 2-line ledger binding: Dr SYS_LONG_TERM_EXTERNAL_COST, Cr the
		-- Midas account's linked physical ASSET account, both for exactly
		-- the task amount. Both account contracts are independently
		-- validated, not merely resolved by code/id lookup.
		SELECT u.currency INTO v_user_currency FROM users u WHERE u.id = NEW.user_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'User % not found', NEW.user_id;
		END IF;

		SELECT * INTO v_external_account FROM ledger_accounts WHERE user_id = NEW.user_id AND code = 'SYS_LONG_TERM_EXTERNAL_COST';
		IF NOT FOUND THEN
			RAISE EXCEPTION 'No SYS_LONG_TERM_EXTERNAL_COST account provisioned (user %)', NEW.user_id;
		END IF;
		IF v_external_account.account_type != 'ASSET' OR v_external_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % is not a valid ASSET/DEBIT account (type %, normal_balance %)',
				v_external_account.id, v_external_account.account_type, v_external_account.normal_balance;
		END IF;
		IF v_external_account.currency != v_user_currency THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % currency % does not match user currency %',
				v_external_account.id, v_external_account.currency, v_user_currency;
		END IF;
		IF v_external_account.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % is archived', v_external_account.id;
		END IF;

		v_midas_ledger_account_id := v_midas_account.ledger_account_id;
		SELECT * INTO v_midas_account_ledger FROM ledger_accounts WHERE id = v_midas_ledger_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Midas linked ledger account % not found', v_midas_ledger_account_id;
		END IF;
		IF v_midas_account_ledger.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Midas linked ledger account % does not belong to user %', v_midas_ledger_account_id, NEW.user_id;
		END IF;
		IF v_midas_account_ledger.account_type != 'ASSET' OR v_midas_account_ledger.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Midas linked ledger account % is not a valid ASSET/DEBIT account (type %, normal_balance %)',
				v_midas_account_ledger.id, v_midas_account_ledger.account_type, v_midas_account_ledger.normal_balance;
		END IF;
		IF v_midas_account_ledger.currency != v_user_currency THEN
			RAISE EXCEPTION 'Midas linked ledger account % currency % does not match user currency %',
				v_midas_account_ledger.id, v_midas_account_ledger.currency, v_user_currency;
		END IF;
		IF v_midas_account_ledger.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'Midas linked ledger account % is archived', v_midas_account_ledger.id;
		END IF;

		SELECT count(*) INTO v_line_count
		FROM transaction_ledger_bindings tlb
		JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
		WHERE tlb.revision_id = NEW.canonical_revision_id;

		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Long-term send task % applied journal must have exactly 2 lines, found %', NEW.task_id, v_line_count;
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
			RAISE EXCEPTION 'Long-term send task % applied journal must have exactly one debit line and one credit line', NEW.task_id;
		END IF;
		IF v_debit_line.account_id != v_external_account.id THEN
			RAISE EXCEPTION 'Long-term send task % debit line account % is not SYS_LONG_TERM_EXTERNAL_COST %',
				NEW.task_id, v_debit_line.account_id, v_external_account.id;
		END IF;
		IF v_credit_line.account_id != v_midas_ledger_account_id THEN
			RAISE EXCEPTION 'Long-term send task % credit line account % is not the Midas linked physical account %',
				NEW.task_id, v_credit_line.account_id, v_midas_ledger_account_id;
		END IF;
		IF v_debit_line.debit != NEW.amount THEN
			RAISE EXCEPTION 'Long-term send task % debit amount % does not match task amount %', NEW.task_id, v_debit_line.debit, NEW.amount;
		END IF;
		IF v_credit_line.credit != NEW.amount THEN
			RAISE EXCEPTION 'Long-term send task % credit amount % does not match task amount %', NEW.task_id, v_credit_line.credit, NEW.amount;
		END IF;
	ELSIF NEW.operation = 'REOPEN' THEN
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'REOPEN revision requires canonical_revision_id (the exact VOID of the preceding SENT)';
		END IF;

		SELECT * INTO v_void_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical VOID revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_void_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical VOID revision user_id % does not match task revision user_id %', v_void_rev.user_id, NEW.user_id;
		END IF;
		IF v_void_rev.operation != 'VOID' THEN
			RAISE EXCEPTION 'REOPEN canonical_revision_id must reference a VOID revision, found %', v_void_rev.operation;
		END IF;

		IF v_latest.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'Preceding SENT revision has no canonical_revision_id to reopen';
		END IF;
		SELECT * INTO v_prev_can_rev FROM transaction_revisions WHERE id = v_latest.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Preceding SENT canonical revision % not found', v_latest.canonical_revision_id;
		END IF;
		IF v_prev_can_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Preceding SENT canonical revision % must have operation CREATE, found %', v_latest.canonical_revision_id, v_prev_can_rev.operation;
		END IF;
		IF v_void_rev.transaction_id != v_prev_can_rev.transaction_id THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % does not belong to the same canonical transaction as the preceding SENT revision %',
				NEW.canonical_revision_id, v_latest.canonical_revision_id;
		END IF;

		-- Exact chain adjacency: the VOID must be the IMMEDIATE next revision
		-- after the preceding SENT's canonical CREATE -- no intervening
		-- revision (UPDATE is impossible for this domain; this also blocks
		-- a VOID belonging to a later/different SEND generation).
		IF v_void_rev.previous_revision_id IS DISTINCT FROM v_prev_can_rev.id THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % previous_revision_id % does not match the preceding SENT canonical revision %',
				NEW.canonical_revision_id, v_void_rev.previous_revision_id, v_prev_can_rev.id;
		END IF;
		IF v_void_rev.revision_no != v_prev_can_rev.revision_no + 1 THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % revision_no % is not the immediate successor of preceding SENT canonical revision_no %',
				NEW.canonical_revision_id, v_void_rev.revision_no, v_prev_can_rev.revision_no;
		END IF;

		-- VOID payload must copy forward the exact SEND snapshot unchanged.
		PERFORM trg_fn_long_term_validate_send_payload(
			v_void_rev.payload,
			NEW.task_id,
			v_task.midas_account_id,
			v_task.pending_bucket_id,
			NEW.amount,
			NEW.destination_label,
			NEW.note,
			'REOPEN canonical VOID'
		);

		-- Exact reversal ledger binding: applied NULL / reversal NOT NULL,
		-- chained to the exact binding of the preceding SENT CREATE
		-- revision, with an exact 2-line reversed journal.
		SELECT * INTO v_void_binding FROM transaction_ledger_bindings WHERE revision_id = v_void_rev.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % has no transaction_ledger_bindings row', NEW.canonical_revision_id;
		END IF;
		IF v_void_binding.applied_journal_entry_id IS NOT NULL THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % binding must have applied_journal_entry_id NULL', NEW.canonical_revision_id;
		END IF;
		IF v_void_binding.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % binding must have reversal_journal_entry_id NOT NULL', NEW.canonical_revision_id;
		END IF;

		SELECT * INTO v_prev_binding FROM transaction_ledger_bindings WHERE revision_id = v_prev_can_rev.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Preceding SENT canonical revision % has no transaction_ledger_bindings row', v_prev_can_rev.id;
		END IF;
		IF v_void_binding.previous_binding_id IS DISTINCT FROM v_prev_binding.id THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % binding previous_binding_id % does not match the preceding SENT binding %',
				NEW.canonical_revision_id, v_void_binding.previous_binding_id, v_prev_binding.id;
		END IF;

		SELECT u.currency INTO v_user_currency FROM users u WHERE u.id = NEW.user_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'User % not found', NEW.user_id;
		END IF;

		SELECT * INTO v_external_account FROM ledger_accounts WHERE user_id = NEW.user_id AND code = 'SYS_LONG_TERM_EXTERNAL_COST';
		IF NOT FOUND THEN
			RAISE EXCEPTION 'No SYS_LONG_TERM_EXTERNAL_COST account provisioned (user %)', NEW.user_id;
		END IF;
		IF v_external_account.account_type != 'ASSET' OR v_external_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % is not a valid ASSET/DEBIT account (type %, normal_balance %)',
				v_external_account.id, v_external_account.account_type, v_external_account.normal_balance;
		END IF;
		IF v_external_account.currency != v_user_currency THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % currency % does not match user currency %',
				v_external_account.id, v_external_account.currency, v_user_currency;
		END IF;
		IF v_external_account.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % is archived', v_external_account.id;
		END IF;

		v_midas_ledger_account_id := v_midas_account.ledger_account_id;
		SELECT * INTO v_midas_account_ledger FROM ledger_accounts WHERE id = v_midas_ledger_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Midas linked ledger account % not found', v_midas_ledger_account_id;
		END IF;
		IF v_midas_account_ledger.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Midas linked ledger account % does not belong to user %', v_midas_ledger_account_id, NEW.user_id;
		END IF;
		IF v_midas_account_ledger.account_type != 'ASSET' OR v_midas_account_ledger.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Midas linked ledger account % is not a valid ASSET/DEBIT account (type %, normal_balance %)',
				v_midas_account_ledger.id, v_midas_account_ledger.account_type, v_midas_account_ledger.normal_balance;
		END IF;
		IF v_midas_account_ledger.currency != v_user_currency THEN
			RAISE EXCEPTION 'Midas linked ledger account % currency % does not match user currency %',
				v_midas_account_ledger.id, v_midas_account_ledger.currency, v_user_currency;
		END IF;
		IF v_midas_account_ledger.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'Midas linked ledger account % is archived', v_midas_account_ledger.id;
		END IF;

		SELECT count(*) INTO v_line_count
		FROM journal_lines jl
		WHERE jl.journal_entry_id = v_void_binding.reversal_journal_entry_id;

		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'REOPEN reversal journal for long-term send task % must have exactly 2 lines, found %', NEW.task_id, v_line_count;
		END IF;

		SELECT jl.* INTO v_debit_line
		FROM journal_lines jl
		WHERE jl.journal_entry_id = v_void_binding.reversal_journal_entry_id AND jl.debit > 0;

		SELECT jl.* INTO v_credit_line
		FROM journal_lines jl
		WHERE jl.journal_entry_id = v_void_binding.reversal_journal_entry_id AND jl.credit > 0;

		IF v_debit_line IS NULL OR v_credit_line IS NULL THEN
			RAISE EXCEPTION 'REOPEN reversal journal for long-term send task % must have exactly one debit line and one credit line', NEW.task_id;
		END IF;
		IF v_debit_line.account_id != v_midas_ledger_account_id THEN
			RAISE EXCEPTION 'REOPEN reversal journal for long-term send task % debit line account % is not the Midas linked physical account %',
				NEW.task_id, v_debit_line.account_id, v_midas_ledger_account_id;
		END IF;
		IF v_credit_line.account_id != v_external_account.id THEN
			RAISE EXCEPTION 'REOPEN reversal journal for long-term send task % credit line account % is not SYS_LONG_TERM_EXTERNAL_COST %',
				NEW.task_id, v_credit_line.account_id, v_external_account.id;
		END IF;
		IF v_debit_line.debit != NEW.amount THEN
			RAISE EXCEPTION 'REOPEN reversal journal for long-term send task % debit amount % does not match task amount %', NEW.task_id, v_debit_line.debit, NEW.amount;
		END IF;
		IF v_credit_line.credit != NEW.amount THEN
			RAISE EXCEPTION 'REOPEN reversal journal for long-term send task % credit amount % does not match task amount %', NEW.task_id, v_credit_line.credit, NEW.amount;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- (trigger itself already exists from migration 0041 and is unaffected by a
-- CREATE OR REPLACE FUNCTION of its underlying function body)

-- ----------------------------------------------------------------------------
-- C. CANONICAL REVISION LIFECYCLE SEALING (NEW)
--    Deferred trigger on transaction_revisions INSERT: for a
--    LONG_TERM_INVESTMENT_SEND parent transaction, makes canonical -> task
--    equally authoritative for EVERY revision (not just the anchor).
--    UPDATE is always rejected. CREATE requires exactly one companion
--    SENT/SENT task revision. VOID requires exactly one companion
--    REOPEN/PENDING task revision. Filters out (cheap no-op) for every
--    other canonical transaction kind in the system.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_long_term_canonical_revision_lifecycle()
RETURNS TRIGGER AS $$
DECLARE
	v_tx RECORD;
	v_task_rev RECORD;
	v_companion_count INT;
BEGIN
	SELECT * INTO v_tx FROM canonical_transactions WHERE id = NEW.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found for revision %', NEW.transaction_id, NEW.id;
	END IF;
	IF v_tx.kind != 'LONG_TERM_INVESTMENT_SEND' THEN
		RETURN NULL;
	END IF;

	IF NEW.operation = 'UPDATE' THEN
		RAISE EXCEPTION 'LONG_TERM_INVESTMENT_SEND canonical transaction % does not support UPDATE revisions (correction = VOID + a new SEND generation via REOPEN/SENT)', NEW.transaction_id;
	END IF;

	SELECT count(*) INTO v_companion_count
	FROM long_term_send_task_revisions
	WHERE canonical_revision_id = NEW.id;

	IF v_companion_count != 1 THEN
		RAISE EXCEPTION 'LONG_TERM_INVESTMENT_SEND canonical % revision % has % companion long_term_send_task_revisions rows (expected exactly 1)',
			NEW.operation, NEW.id, v_companion_count;
	END IF;

	SELECT * INTO v_task_rev FROM long_term_send_task_revisions WHERE canonical_revision_id = NEW.id;

	IF NEW.operation = 'CREATE' THEN
		IF NEW.revision_no != 1 THEN
			RAISE EXCEPTION 'LONG_TERM_INVESTMENT_SEND canonical CREATE revision % must be revision_no 1, found %', NEW.id, NEW.revision_no;
		END IF;
		IF v_task_rev.operation != 'SENT' OR v_task_rev.status != 'SENT' THEN
			RAISE EXCEPTION 'LONG_TERM_INVESTMENT_SEND canonical CREATE revision % companion task revision must be operation SENT / status SENT, found % / %',
				NEW.id, v_task_rev.operation, v_task_rev.status;
		END IF;
	ELSIF NEW.operation = 'VOID' THEN
		IF v_task_rev.operation != 'REOPEN' OR v_task_rev.status != 'PENDING' THEN
			RAISE EXCEPTION 'LONG_TERM_INVESTMENT_SEND canonical VOID revision % companion task revision must be operation REOPEN / status PENDING, found % / %',
				NEW.id, v_task_rev.operation, v_task_rev.status;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_long_term_canonical_revision_lifecycle ON "transaction_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_long_term_canonical_revision_lifecycle
AFTER INSERT ON "transaction_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_long_term_canonical_revision_lifecycle();