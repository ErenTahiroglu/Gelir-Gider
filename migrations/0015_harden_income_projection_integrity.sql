-- =========================================================================
-- Migration 0015: Harden Income Projection Integrity
-- =========================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_income_receipt_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_receipt RECORD;
	v_source RECORD;
	v_tx RECORD;
	v_rev RECORD;
	v_prev_proj RECORD;
BEGIN
	-- 1. Fetch parent income receipt
	SELECT id, user_id, source_id, canonical_transaction_id
	INTO v_receipt
	FROM "income_receipts"
	WHERE id = NEW.income_receipt_id;

	IF v_receipt.id IS NULL THEN
		RAISE EXCEPTION 'Parent income receipt % not found', NEW.income_receipt_id;
	END IF;

	IF v_receipt.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'income_receipt_revisions user_id % does not match parent income_receipt user_id %',
			NEW.user_id, v_receipt.user_id;
	END IF;

	-- 2. Fetch and verify income source existence and ownership
	SELECT id, user_id
	INTO v_source
	FROM "income_sources"
	WHERE id = v_receipt.source_id;

	IF v_source.id IS NULL THEN
		RAISE EXCEPTION 'Income source % not found', v_receipt.source_id;
	END IF;

	IF v_source.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'income_sources user_id % does not match revision user_id %',
			v_source.user_id, NEW.user_id;
	END IF;

	IF v_source.user_id != v_receipt.user_id THEN
		RAISE EXCEPTION 'income_sources user_id % does not match income_receipt user_id %',
			v_source.user_id, v_receipt.user_id;
	END IF;

	-- 3. Fetch canonical transaction
	SELECT id, user_id, kind
	INTO v_tx
	FROM "canonical_transactions"
	WHERE id = v_receipt.canonical_transaction_id;

	IF v_tx.id IS NULL THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_receipt.canonical_transaction_id;
	END IF;

	IF v_tx.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical transaction user_id does not match revision user_id';
	END IF;

	IF v_tx.kind != 'INCOME_RECEIPT' THEN
		RAISE EXCEPTION 'Canonical transaction kind must be INCOME_RECEIPT, found %', v_tx.kind;
	END IF;

	-- 4. Fetch canonical revision
	SELECT id, user_id, transaction_id, revision_no, previous_revision_id, operation, occurred_at, payload
	INTO v_rev
	FROM "transaction_revisions"
	WHERE id = NEW.canonical_revision_id;

	IF v_rev.id IS NULL THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;

	IF v_rev.transaction_id != v_tx.id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match parent canonical transaction id %',
			v_rev.transaction_id, v_tx.id;
	END IF;

	IF v_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id does not match revision user_id';
	END IF;

	IF v_rev.revision_no != NEW.revision_no THEN
		RAISE EXCEPTION 'Domain revision_no % does not match canonical revision_no %',
			NEW.revision_no, v_rev.revision_no;
	END IF;

	IF v_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Domain operation % does not match canonical operation %',
			NEW.operation, v_rev.operation;
	END IF;

	IF v_rev.occurred_at != NEW.occurred_at THEN
		RAISE EXCEPTION 'Domain occurred_at % does not match canonical occurred_at %',
			NEW.occurred_at, v_rev.occurred_at;
	END IF;

	-- 5. Validate Canonical Revision Payload Keys Existence
	IF NOT (
		v_rev.payload ? 'incomeSourceId' AND
		v_rev.payload ? 'amount' AND
		v_rev.payload ? 'destinationAccountId' AND
		v_rev.payload ? 'note'
	) THEN
		RAISE EXCEPTION 'Canonical payload is missing one or more required keys (incomeSourceId, amount, destinationAccountId, note)';
	END IF;

	-- 6. Validate Exact Canonical Revision Payload Matching (Strict textual binding)
	IF (v_rev.payload->>'incomeSourceId') != (v_receipt.source_id::text) THEN
		RAISE EXCEPTION 'Canonical payload incomeSourceId % does not match receipt source_id %',
			v_rev.payload->>'incomeSourceId', v_receipt.source_id::text;
	END IF;

	IF (v_rev.payload->>'amount') != (NEW.amount::text) THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match domain amount %',
			v_rev.payload->>'amount', NEW.amount::text;
	END IF;

	IF (v_rev.payload->>'destinationAccountId') != (NEW.destination_account_id::text) THEN
		RAISE EXCEPTION 'Canonical payload destinationAccountId % does not match domain destination_account_id %',
			v_rev.payload->>'destinationAccountId', NEW.destination_account_id::text;
	END IF;

	-- Note exact type and equality binding
	IF jsonb_typeof(v_rev.payload->'note') = 'null' THEN
		IF NEW.note IS NOT NULL THEN
			RAISE EXCEPTION 'Canonical payload note is null but domain note is not null';
		END IF;
	ELSIF jsonb_typeof(v_rev.payload->'note') = 'string' THEN
		IF NEW.note IS NULL OR (v_rev.payload->>'note') != NEW.note THEN
			RAISE EXCEPTION 'Canonical payload note does not match domain note';
		END IF;
	ELSE
		RAISE EXCEPTION 'Canonical payload note must be a JSON string or null, found %', jsonb_typeof(v_rev.payload->'note');
	END IF;

	-- 7. Revision sequencing & predecessor verification
	IF NEW.operation = 'CREATE' THEN
		IF NEW.revision_no != 1 THEN
			RAISE EXCEPTION 'CREATE domain revision must have revision_no = 1';
		END IF;
		IF NEW.previous_receipt_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'CREATE domain revision must have null previous_receipt_revision_id';
		END IF;
	ELSE
		-- UPDATE or VOID
		IF NEW.revision_no <= 1 THEN
			RAISE EXCEPTION '% domain revision must have revision_no > 1', NEW.operation;
		END IF;

		IF NEW.previous_receipt_revision_id IS NULL THEN
			RAISE EXCEPTION '% domain revision requires previous_receipt_revision_id', NEW.operation;
		END IF;

		-- Find previous domain projection corresponding to canonical previous_revision_id
		SELECT id, amount, destination_account_id, note, occurred_at
		INTO v_prev_proj
		FROM "income_receipt_revisions"
		WHERE canonical_revision_id = v_rev.previous_revision_id;

		IF v_prev_proj.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor domain revision found for canonical revision %', v_rev.previous_revision_id;
		END IF;

		IF NEW.previous_receipt_revision_id != v_prev_proj.id THEN
			RAISE EXCEPTION 'previous_receipt_revision_id % does not match predecessor domain revision id %',
				NEW.previous_receipt_revision_id, v_prev_proj.id;
		END IF;

		-- For VOID: Verify domain projection copies previous values exactly
		IF NEW.operation = 'VOID' THEN
			IF NEW.amount != v_prev_proj.amount THEN
				RAISE EXCEPTION 'VOID domain revision must copy predecessor amount exactly';
			END IF;
			IF NEW.destination_account_id != v_prev_proj.destination_account_id THEN
				RAISE EXCEPTION 'VOID domain revision must copy predecessor destination_account_id exactly';
			END IF;
			IF NEW.note IS DISTINCT FROM v_prev_proj.note THEN
				RAISE EXCEPTION 'VOID domain revision must copy predecessor note exactly';
			END IF;
			IF NEW.occurred_at != v_prev_proj.occurred_at THEN
				RAISE EXCEPTION 'VOID domain revision must copy predecessor occurred_at exactly';
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;