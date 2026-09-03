-- ============================================================================
-- Migration 0017: Harden Income Settlement Serialization & Cross-Domain DB Invariants
-- ============================================================================

-- 1. Hardened income_receipt_revisions insert trigger function
CREATE OR REPLACE FUNCTION trg_fn_guard_income_receipt_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_receipt RECORD;
	v_source RECORD;
	v_tx RECORD;
	v_rev RECORD;
	v_prev_proj RECORD;
	v_active_alloc_total numeric := 0;
BEGIN
	-- 1. Fetch and lock parent income receipt identity row
	SELECT id, user_id, source_id, canonical_transaction_id
	INTO v_receipt
	FROM "income_receipts"
	WHERE id = NEW.income_receipt_id
	FOR UPDATE;

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

	-- 6. Validate Exact Canonical Revision Payload Matching
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

		-- Calculate active settlement allocations for this receipt
		SELECT COALESCE(SUM((alloc_elem->>'amount')::numeric), 0)
		INTO v_active_alloc_total
		FROM (
			SELECT DISTINCT ON (settlement_batch_id) allocations
			FROM income_settlement_batch_revisions
			WHERE user_id = NEW.user_id
				AND settlement_batch_id IN (
					SELECT id FROM income_settlement_batches WHERE income_receipt_id = NEW.income_receipt_id
				)
			ORDER BY settlement_batch_id, revision_no DESC
		) latest_batch,
		LATERAL jsonb_array_elements(latest_batch.allocations) alloc_elem;

		IF NEW.operation = 'UPDATE' THEN
			IF (NEW.amount::numeric) < v_active_alloc_total THEN
				RAISE EXCEPTION 'Cannot reduce receipt amount % below active settlement allocations %',
					NEW.amount, v_active_alloc_total;
			END IF;
		ELSIF NEW.operation = 'VOID' THEN
			IF v_active_alloc_total > 0 THEN
				RAISE EXCEPTION 'Cannot void income receipt with active settlement allocations (allocated: %)',
					v_active_alloc_total;
			END IF;

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
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 2. Hardened income_entitlement_revisions insert trigger function
CREATE OR REPLACE FUNCTION trg_fn_guard_income_entitlement_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_entitlement RECORD;
  v_source RECORD;
  v_canon_tx RECORD;
  v_rev RECORD;
  v_prev_ent_rev RECORD;
  v_active_ent_alloc_total numeric := 0;
  v_expected_occurred_at timestamptz;
BEGIN
  -- 1. Fetch and lock entitlement identity row FOR UPDATE
  SELECT * INTO v_entitlement
  FROM income_entitlements
  WHERE id = NEW.entitlement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_entitlements row % not found', NEW.entitlement_id;
  END IF;

  IF v_entitlement.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_entitlement user_id % does not match revision user_id %',
      v_entitlement.user_id, NEW.user_id;
  END IF;

  -- 2. Validate income source exists and has nature = 'REGULAR'
  SELECT * INTO v_source
  FROM income_sources
  WHERE id = v_entitlement.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_sources row % not found', v_entitlement.source_id;
  END IF;

  IF v_source.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_sources user_id % does not match entitlement user_id %',
      v_source.user_id, NEW.user_id;
  END IF;

  IF v_source.nature != 'REGULAR' THEN
    RAISE EXCEPTION 'Entitlements are only permitted for REGULAR income sources, found %',
      v_source.nature;
  END IF;

  -- 3. Validate canonical transaction
  SELECT * INTO v_canon_tx
  FROM canonical_transactions
  WHERE id = v_entitlement.canonical_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found', v_entitlement.canonical_transaction_id;
  END IF;

  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_transaction user_id % does not match revision user_id %',
      v_canon_tx.user_id, NEW.user_id;
  END IF;

  IF v_canon_tx.kind != 'INCOME_ENTITLEMENT' THEN
    RAISE EXCEPTION 'canonical_transaction kind must be INCOME_ENTITLEMENT, found %',
      v_canon_tx.kind;
  END IF;

  -- 4. Validate canonical revision
  SELECT * INTO v_rev
  FROM transaction_revisions
  WHERE id = NEW.canonical_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_revisions row % not found', NEW.canonical_revision_id;
  END IF;

  IF v_rev.transaction_id != v_entitlement.canonical_transaction_id THEN
    RAISE EXCEPTION 'canonical_revision transaction_id % does not match entitlement canonical_transaction_id %',
      v_rev.transaction_id, v_entitlement.canonical_transaction_id;
  END IF;

  IF v_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_revision user_id % does not match revision user_id %',
      v_rev.user_id, NEW.user_id;
  END IF;

  IF v_rev.revision_no != NEW.revision_no THEN
    RAISE EXCEPTION 'canonical_revision revision_no % does not match revision_no %',
      v_rev.revision_no, NEW.revision_no;
  END IF;

  IF v_rev.operation != NEW.operation THEN
    RAISE EXCEPTION 'canonical_revision operation % does not match revision operation %',
      v_rev.operation, NEW.operation;
  END IF;

  -- Validate deterministic canonical occurred_at (midnight Europe/Istanbul)
  v_expected_occurred_at := (v_entitlement.period_month::timestamp AT TIME ZONE 'Europe/Istanbul');
  IF v_rev.occurred_at != v_expected_occurred_at THEN
    RAISE EXCEPTION 'canonical_revision occurred_at % does not match expected Europe/Istanbul midnight %',
      v_rev.occurred_at, v_expected_occurred_at;
  END IF;

  -- 5. Revision chain validation
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_entitlement_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First entitlement revision must have NULL previous_entitlement_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First entitlement revision must have operation CREATE';
    END IF;
    IF v_rev.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First canonical revision must have NULL previous_revision_id';
    END IF;
  ELSE
    IF NEW.previous_entitlement_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent entitlement revision must have non-NULL previous_entitlement_revision_id';
    END IF;
    IF NEW.operation NOT IN ('UPDATE', 'VOID') THEN
      RAISE EXCEPTION 'Subsequent entitlement revision must have operation UPDATE or VOID';
    END IF;

    SELECT * INTO v_prev_ent_rev
    FROM income_entitlement_revisions
    WHERE id = NEW.previous_entitlement_revision_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_entitlement_revision % not found', NEW.previous_entitlement_revision_id;
    END IF;

    IF v_prev_ent_rev.entitlement_id != NEW.entitlement_id THEN
      RAISE EXCEPTION 'previous_entitlement_revision entitlement_id does not match';
    END IF;

    IF v_prev_ent_rev.revision_no != (NEW.revision_no - 1) THEN
      RAISE EXCEPTION 'previous_entitlement_revision revision_no % does not equal expected %',
        v_prev_ent_rev.revision_no, (NEW.revision_no - 1);
    END IF;

    IF v_prev_ent_rev.canonical_revision_id != v_rev.previous_revision_id THEN
      RAISE EXCEPTION 'previous_entitlement_revision canonical_revision_id does not match canonical previous_revision_id';
    END IF;

    IF v_prev_ent_rev.operation = 'VOID' THEN
      RAISE EXCEPTION 'Cannot append new revision to an already VOIDED entitlement';
    END IF;

    -- Calculate active settlement allocations across latest batches for this entitlement
    SELECT COALESCE(SUM((alloc_elem->>'amount')::numeric), 0)
    INTO v_active_ent_alloc_total
    FROM (
      SELECT DISTINCT ON (settlement_batch_id) allocations
      FROM income_settlement_batch_revisions
      WHERE user_id = NEW.user_id
      ORDER BY settlement_batch_id, revision_no DESC
    ) latest_batches,
    LATERAL jsonb_array_elements(latest_batches.allocations) alloc_elem
    WHERE (alloc_elem->>'entitlementId') = (NEW.entitlement_id::text);

    IF NEW.operation = 'UPDATE' THEN
      IF (NEW.amount::numeric) < v_active_ent_alloc_total THEN
        RAISE EXCEPTION 'Cannot reduce entitlement amount % below active settlement allocations %',
          NEW.amount, v_active_ent_alloc_total;
      END IF;
    ELSIF NEW.operation = 'VOID' THEN
      IF v_active_ent_alloc_total > 0 THEN
        RAISE EXCEPTION 'Cannot void income entitlement with active settlement allocations (allocated: %)',
          v_active_ent_alloc_total;
      END IF;

      IF NEW.amount != v_prev_ent_rev.amount THEN
        RAISE EXCEPTION 'VOID entitlement revision must retain previous amount';
      END IF;
      IF (NEW.expected_receipt_on IS DISTINCT FROM v_prev_ent_rev.expected_receipt_on) THEN
        RAISE EXCEPTION 'VOID entitlement revision must retain previous expected_receipt_on';
      END IF;
      IF (NEW.note IS DISTINCT FROM v_prev_ent_rev.note) THEN
        RAISE EXCEPTION 'VOID entitlement revision must retain previous note';
      END IF;
    END IF;
  END IF;

  -- 6. Canonical payload exact validation
  IF NOT (v_rev.payload ? 'incomeSourceId') OR
     NOT (v_rev.payload ? 'periodMonth') OR
     NOT (v_rev.payload ? 'amount') OR
     NOT (v_rev.payload ? 'expectedReceiptOn') OR
     NOT (v_rev.payload ? 'note') THEN
    RAISE EXCEPTION 'canonical payload for INCOME_ENTITLEMENT missing required keys';
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(v_rev.payload)) != 5 THEN
    RAISE EXCEPTION 'canonical payload for INCOME_ENTITLEMENT contains unexpected extra keys';
  END IF;

  IF (v_rev.payload->>'incomeSourceId') != (v_entitlement.source_id::text) THEN
    RAISE EXCEPTION 'canonical payload incomeSourceId % does not match entitlement source_id %',
      (v_rev.payload->>'incomeSourceId'), v_entitlement.source_id;
  END IF;

  IF (v_rev.payload->>'periodMonth') != (v_entitlement.period_month::text) THEN
    RAISE EXCEPTION 'canonical payload periodMonth % does not match entitlement period_month %',
      (v_rev.payload->>'periodMonth'), v_entitlement.period_month;
  END IF;

  IF (v_rev.payload->>'amount') != (NEW.amount::text) THEN
    RAISE EXCEPTION 'canonical payload amount % does not match revision amount %',
      (v_rev.payload->>'amount'), NEW.amount::text;
  END IF;

  IF NEW.expected_receipt_on IS NULL THEN
    IF jsonb_typeof(v_rev.payload->'expectedReceiptOn') != 'null' THEN
      RAISE EXCEPTION 'canonical payload expectedReceiptOn must be JSON null when expected_receipt_on is NULL';
    END IF;
  ELSE
    IF (v_rev.payload->>'expectedReceiptOn') != (NEW.expected_receipt_on::text) THEN
      RAISE EXCEPTION 'canonical payload expectedReceiptOn % does not match revision %',
        (v_rev.payload->>'expectedReceiptOn'), NEW.expected_receipt_on::text;
    END IF;
  END IF;

  IF NEW.note IS NULL THEN
    IF jsonb_typeof(v_rev.payload->'note') != 'null' THEN
      RAISE EXCEPTION 'canonical payload note must be JSON null when note is NULL';
    END IF;
  ELSE
    IF jsonb_typeof(v_rev.payload->'note') != 'string' OR
       (v_rev.payload->>'note') != NEW.note THEN
      RAISE EXCEPTION 'canonical payload note does not match revision note';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 3. Hardened income_settlement_batch_revisions insert trigger function
CREATE OR REPLACE FUNCTION trg_fn_guard_income_settlement_batch_revisions_insert()
RETURNS trigger AS $$
DECLARE
  v_batch RECORD;
  v_receipt RECORD;
  v_latest_receipt_rev RECORD;
  v_canon_tx RECORD;
  v_rev RECORD;
  v_prev_batch_rev RECORD;
  v_alloc_elem jsonb;
  v_alloc_count integer;
  v_idx integer;
  v_prev_ent_id text := '';
  v_elem_ent_id text;
  v_elem_amount_str text;
  v_elem_amount numeric;
  v_total_alloc numeric := 0;
  v_ent RECORD;
  v_latest_ent_rev RECORD;
  v_other_alloc_total numeric;
  v_ent_ids uuid[];
  v_locked_count integer;
BEGIN
  -- 1. Validate batch exists and belongs to user
  SELECT * INTO v_batch
  FROM income_settlement_batches
  WHERE id = NEW.settlement_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_settlement_batches row % not found', NEW.settlement_batch_id;
  END IF;

  IF v_batch.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_settlement_batches user_id % does not match revision user_id %',
      v_batch.user_id, NEW.user_id;
  END IF;

  -- 2. Lock receipt identity row FOR UPDATE
  SELECT * INTO v_receipt
  FROM income_receipts
  WHERE id = v_batch.income_receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_receipts row % not found', v_batch.income_receipt_id;
  END IF;

  IF v_receipt.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'income_receipts user_id % does not match settlement user_id %',
      v_receipt.user_id, NEW.user_id;
  END IF;

  -- 3. AFTER receipt lock: reload authoritative latest receipt revision
  SELECT * INTO v_latest_receipt_rev
  FROM income_receipt_revisions
  WHERE income_receipt_id = v_receipt.id
  ORDER BY revision_no DESC
  LIMIT 1;

  IF NOT FOUND OR v_latest_receipt_rev.operation = 'VOID' THEN
    RAISE EXCEPTION 'Cannot settle against non-existent or VOIDED income receipt %', v_receipt.id;
  END IF;

  -- 4. Validate canonical transaction
  SELECT * INTO v_canon_tx
  FROM canonical_transactions
  WHERE id = v_batch.canonical_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical_transactions row % not found', v_batch.canonical_transaction_id;
  END IF;

  IF v_canon_tx.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_transaction user_id % does not match revision user_id %',
      v_canon_tx.user_id, NEW.user_id;
  END IF;

  IF v_canon_tx.kind != 'INCOME_SETTLEMENT' THEN
    RAISE EXCEPTION 'canonical_transaction kind must be INCOME_SETTLEMENT, found %',
      v_canon_tx.kind;
  END IF;

  -- 5. Validate canonical revision
  SELECT * INTO v_rev
  FROM transaction_revisions
  WHERE id = NEW.canonical_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction_revisions row % not found', NEW.canonical_revision_id;
  END IF;

  IF v_rev.transaction_id != v_batch.canonical_transaction_id THEN
    RAISE EXCEPTION 'canonical_revision transaction_id does not match batch canonical_transaction_id';
  END IF;

  IF v_rev.user_id != NEW.user_id THEN
    RAISE EXCEPTION 'canonical_revision user_id does not match revision user_id';
  END IF;

  IF v_rev.revision_no != NEW.revision_no THEN
    RAISE EXCEPTION 'canonical_revision revision_no does not match revision_no';
  END IF;

  IF v_rev.operation != NEW.operation THEN
    RAISE EXCEPTION 'canonical_revision operation does not match revision operation';
  END IF;

  -- Enforce settlement canonical revision occurred_at equals latest receipt occurred_at
  IF v_rev.occurred_at != v_latest_receipt_rev.occurred_at THEN
    RAISE EXCEPTION 'canonical_revision occurred_at % does not match receipt occurred_at %',
      v_rev.occurred_at, v_latest_receipt_rev.occurred_at;
  END IF;

  -- 6. Revision chain validation
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_settlement_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First settlement batch revision must have NULL previous_settlement_revision_id';
    END IF;
    IF NEW.operation != 'CREATE' THEN
      RAISE EXCEPTION 'First settlement batch revision must have operation CREATE';
    END IF;
    IF v_rev.previous_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'First canonical revision must have NULL previous_revision_id';
    END IF;
  ELSE
    IF NEW.previous_settlement_revision_id IS NULL THEN
      RAISE EXCEPTION 'Subsequent settlement batch revision must have non-NULL previous_settlement_revision_id';
    END IF;
    IF NEW.operation != 'UPDATE' THEN
      RAISE EXCEPTION 'Subsequent settlement batch revision must have operation UPDATE';
    END IF;

    SELECT * INTO v_prev_batch_rev
    FROM income_settlement_batch_revisions
    WHERE id = NEW.previous_settlement_revision_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_settlement_revision % not found', NEW.previous_settlement_revision_id;
    END IF;

    IF v_prev_batch_rev.settlement_batch_id != NEW.settlement_batch_id THEN
      RAISE EXCEPTION 'previous_settlement_revision settlement_batch_id does not match';
    END IF;

    IF v_prev_batch_rev.revision_no != (NEW.revision_no - 1) THEN
      RAISE EXCEPTION 'previous_settlement_revision revision_no does not equal expected';
    END IF;

    IF v_prev_batch_rev.canonical_revision_id != v_rev.previous_revision_id THEN
      RAISE EXCEPTION 'previous_settlement_revision canonical_revision_id does not match canonical previous_revision_id';
    END IF;
  END IF;

  -- 7. Canonical payload exact validation
  IF NOT (v_rev.payload ? 'incomeReceiptId') OR
     NOT (v_rev.payload ? 'allocations') OR
     NOT (v_rev.payload ? 'note') THEN
    RAISE EXCEPTION 'canonical payload for INCOME_SETTLEMENT missing required keys';
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(v_rev.payload)) != 3 THEN
    RAISE EXCEPTION 'canonical payload for INCOME_SETTLEMENT contains unexpected extra keys';
  END IF;

  IF (v_rev.payload->>'incomeReceiptId') != (v_batch.income_receipt_id::text) THEN
    RAISE EXCEPTION 'canonical payload incomeReceiptId does not match batch income_receipt_id';
  END IF;

  IF (v_rev.payload->'allocations') != NEW.allocations THEN
    RAISE EXCEPTION 'canonical payload allocations does not match revision allocations';
  END IF;

  IF NEW.note IS NULL THEN
    IF jsonb_typeof(v_rev.payload->'note') != 'null' THEN
      RAISE EXCEPTION 'canonical payload note must be JSON null when note is NULL';
    END IF;
  ELSE
    IF jsonb_typeof(v_rev.payload->'note') != 'string' OR
       (v_rev.payload->>'note') != NEW.note THEN
      RAISE EXCEPTION 'canonical payload note does not match revision note';
    END IF;
  END IF;

  -- 8. Validate allocations structure, shapes, types, and sorting
  IF jsonb_typeof(NEW.allocations) != 'array' THEN
    RAISE EXCEPTION 'allocations must be a JSON array';
  END IF;

  v_alloc_count := jsonb_array_length(NEW.allocations);

  IF NEW.revision_no = 1 AND v_alloc_count = 0 THEN
    RAISE EXCEPTION 'CREATE settlement batch revision requires at least 1 allocation';
  END IF;

  -- Collect entitlement IDs and lock them deterministically in SQL
  IF v_alloc_count > 0 THEN
    -- Validate item shapes before casting
    FOR v_idx IN 0..(v_alloc_count - 1) LOOP
      v_alloc_elem := NEW.allocations->v_idx;

      IF jsonb_typeof(v_alloc_elem) != 'object' THEN
        RAISE EXCEPTION 'Allocation item at index % is not a JSON object', v_idx;
      END IF;

      IF (SELECT count(*) FROM jsonb_object_keys(v_alloc_elem)) != 2 THEN
        RAISE EXCEPTION 'Allocation item at index % must contain exactly entitlementId and amount', v_idx;
      END IF;

      IF NOT (v_alloc_elem ? 'entitlementId') OR NOT (v_alloc_elem ? 'amount') THEN
        RAISE EXCEPTION 'Allocation item at index % missing entitlementId or amount', v_idx;
      END IF;

      IF jsonb_typeof(v_alloc_elem->'entitlementId') != 'string' THEN
        RAISE EXCEPTION 'Allocation item at index % entitlementId must be a string', v_idx;
      END IF;

      IF jsonb_typeof(v_alloc_elem->'amount') != 'string' THEN
        RAISE EXCEPTION 'Allocation item at index % amount must be a string', v_idx;
      END IF;

      v_elem_ent_id := v_alloc_elem->>'entitlementId';
      v_elem_amount_str := v_alloc_elem->>'amount';

      IF NOT (v_elem_ent_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'Allocation item at index % has invalid UUID format for entitlementId: %', v_idx, v_elem_ent_id;
      END IF;

      IF NOT (v_elem_amount_str ~ '^(0|[1-9][0-9]*)\.[0-9]{2}$') THEN
        RAISE EXCEPTION 'Allocation item at index % has unnormalized amount string %', v_idx, v_elem_amount_str;
      END IF;

      v_elem_amount := v_elem_amount_str::numeric;
      IF v_elem_amount <= 0 THEN
        RAISE EXCEPTION 'Allocation amount at index % must be strictly positive', v_idx;
      END IF;

      -- Strict sorting (entitlementId ASC) and no duplicates
      IF v_elem_ent_id <= v_prev_ent_id THEN
        RAISE EXCEPTION 'Allocations must be strictly sorted by entitlementId ASC without duplicates (found % after %)',
          v_elem_ent_id, v_prev_ent_id;
      END IF;
      v_prev_ent_id := v_elem_ent_id;
    END LOOP;

    -- Extract unique entitlement UUIDs
    SELECT array_agg((elem->>'entitlementId')::uuid)
    INTO v_ent_ids
    FROM jsonb_array_elements(NEW.allocations) elem;

    -- Lock all target entitlements deterministically ORDER BY id ASC FOR UPDATE
    SELECT count(*)::integer
    INTO v_locked_count
    FROM (
      SELECT id
      FROM income_entitlements
      WHERE user_id = NEW.user_id
        AND id = ANY(v_ent_ids)
      ORDER BY id ASC
      FOR UPDATE
    ) locked_ents;

    IF v_locked_count != array_length(v_ent_ids, 1) THEN
      RAISE EXCEPTION 'One or more allocated entitlements not found for user %', NEW.user_id;
    END IF;

    -- Validate each entitlement's source, status, and caps
    FOR v_idx IN 0..(v_alloc_count - 1) LOOP
      v_alloc_elem := NEW.allocations->v_idx;
      v_elem_ent_id := v_alloc_elem->>'entitlementId';
      v_elem_amount := (v_alloc_elem->>'amount')::numeric;

      SELECT * INTO v_ent
      FROM income_entitlements
      WHERE id = v_elem_ent_id::uuid;

      IF v_ent.source_id != v_receipt.source_id THEN
        RAISE EXCEPTION 'Allocated entitlement % source % does not match receipt source %',
          v_elem_ent_id, v_ent.source_id, v_receipt.source_id;
      END IF;

      -- Fetch latest entitlement revision
      SELECT * INTO v_latest_ent_rev
      FROM income_entitlement_revisions
      WHERE entitlement_id = v_ent.id
      ORDER BY revision_no DESC
      LIMIT 1;

      IF NOT FOUND OR v_latest_ent_rev.operation = 'VOID' THEN
        RAISE EXCEPTION 'Cannot allocate to non-existent or VOIDED entitlement %', v_elem_ent_id;
      END IF;

      -- Calculate current allocations to this entitlement across other active batches
      SELECT COALESCE(SUM((alloc_elem->>'amount')::numeric), 0)
      INTO v_other_alloc_total
      FROM (
        SELECT DISTINCT ON (settlement_batch_id) allocations
        FROM income_settlement_batch_revisions
        WHERE user_id = NEW.user_id
          AND settlement_batch_id != NEW.settlement_batch_id
        ORDER BY settlement_batch_id, revision_no DESC
      ) latest_other_batches,
      LATERAL jsonb_array_elements(latest_other_batches.allocations) alloc_elem
      WHERE (alloc_elem->>'entitlementId') = v_elem_ent_id;

      IF (v_other_alloc_total + v_elem_amount) > (v_latest_ent_rev.amount::numeric) THEN
        RAISE EXCEPTION 'Total allocation % exceeds active entitlement amount % for entitlement %',
          (v_other_alloc_total + v_elem_amount), v_latest_ent_rev.amount, v_elem_ent_id;
      END IF;

      v_total_alloc := v_total_alloc + v_elem_amount;
    END LOOP;
  END IF;

  -- 9. Validate receipt total cap
  IF v_total_alloc > (v_latest_receipt_rev.amount::numeric) THEN
    RAISE EXCEPTION 'Total allocations % exceed active income receipt amount %',
      v_total_alloc, v_latest_receipt_rev.amount;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;