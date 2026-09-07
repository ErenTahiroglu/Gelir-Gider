-- Migration 0054: Harden Import Contracts, Payload Integrity, Receipt DB Authority & Completeness

-- ============================================================================
-- 1. HARDEN NORMALIZED PAYLOAD INTEGRITY & COPY-FORWARD GUARDS
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revisions_payload_integrity()
RETURNS TRIGGER AS $$
DECLARE
	v_row RECORD;
	v_first_rev RECORD;
	v_prev_rev RECORD;
	v_keys TEXT[];
	v_rec_type TEXT;
	v_amount NUMERIC;
	v_cat TEXT;
	v_goal_id TEXT;
	v_inst_cnt INTEGER;
	v_merchant TEXT;
	v_desc TEXT;
	v_note TEXT;
	v_reason TEXT;
	v_ts_text TEXT;
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found', NEW.import_row_id;
	END IF;

	SELECT array_agg(k ORDER BY k) INTO v_keys
	FROM jsonb_object_keys(NEW.payload) AS k;

	v_rec_type := NEW.payload->>'recordType';

	IF v_rec_type IS DISTINCT FROM v_row.record_type THEN
		RAISE EXCEPTION 'Payload recordType % does not match import row record_type %', v_rec_type, v_row.record_type;
	END IF;

	IF jsonb_typeof(NEW.payload->'recordType') <> 'string' THEN
		RAISE EXCEPTION 'payload.recordType must be a JSON string';
	END IF;

	IF v_rec_type = 'CREDIT_CARD_PURCHASE' THEN
		IF v_keys <> ARRAY['amount', 'cardId', 'description', 'installmentCount', 'merchant', 'occurredAt', 'purchaseCategory', 'recordType', 'shortTermGoalId'] THEN
			RAISE EXCEPTION 'Invalid keys in CREDIT_CARD_PURCHASE payload: %', v_keys;
		END IF;

		-- JSON scalar type checks
		IF jsonb_typeof(NEW.payload->'amount') <> 'string' THEN
			RAISE EXCEPTION 'payload.amount must be a JSON string';
		END IF;
		IF jsonb_typeof(NEW.payload->'occurredAt') <> 'string' THEN
			RAISE EXCEPTION 'payload.occurredAt must be a JSON string';
		END IF;
		IF jsonb_typeof(NEW.payload->'cardId') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.cardId must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'purchaseCategory') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.purchaseCategory must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'shortTermGoalId') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.shortTermGoalId must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'merchant') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.merchant must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'description') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.description must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'installmentCount') NOT IN ('number', 'null') THEN
			RAISE EXCEPTION 'payload.installmentCount must be a JSON number or null';
		END IF;

		-- Amount formatting and range check (NUMERIC(18,2))
		IF NOT (NEW.payload->>'amount' ~ '^(0|[1-9][0-9]{0,15})\.[0-9]{2}$') THEN
			RAISE EXCEPTION 'Invalid amount format in CREDIT_CARD_PURCHASE payload: %', NEW.payload->>'amount';
		END IF;

		v_amount := (NEW.payload->>'amount')::numeric;
		IF v_amount <= 0 OR v_amount > 9999999999999999.99 THEN
			RAISE EXCEPTION 'Amount out of valid range in CREDIT_CARD_PURCHASE payload: %', v_amount;
		END IF;

		-- Timestamptz validation
		v_ts_text := NEW.payload->>'occurredAt';
		BEGIN
			PERFORM v_ts_text::timestamptz;
		EXCEPTION WHEN OTHERS THEN
			RAISE EXCEPTION 'occurredAt must be a valid timestamptz string, got %', v_ts_text;
		END;

		-- CardId UUID validation
		IF NEW.payload->>'cardId' IS NOT NULL AND NOT (NEW.payload->>'cardId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'Invalid cardId UUID in CREDIT_CARD_PURCHASE payload: %', NEW.payload->>'cardId';
		END IF;

		-- Purchase category validation
		v_cat := NEW.payload->>'purchaseCategory';
		IF v_cat IS NOT NULL AND v_cat NOT IN ('MANDATORY', 'DISCRETIONARY', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED') THEN
			RAISE EXCEPTION 'Invalid purchaseCategory in CREDIT_CARD_PURCHASE payload: %', v_cat;
		END IF;

		v_goal_id := NEW.payload->>'shortTermGoalId';
		IF v_cat = 'SHORT_TERM_PURCHASE' THEN
			IF v_goal_id IS NULL OR NOT (v_goal_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
				RAISE EXCEPTION 'shortTermGoalId required for SHORT_TERM_PURCHASE category: %', v_goal_id;
			END IF;
		ELSE
			IF v_goal_id IS NOT NULL THEN
				RAISE EXCEPTION 'shortTermGoalId must be NULL when category is not SHORT_TERM_PURCHASE: %', v_goal_id;
			END IF;
		END IF;

		-- Text length limits
		v_merchant := NEW.payload->>'merchant';
		IF v_merchant IS NOT NULL AND length(v_merchant) > 200 THEN
			RAISE EXCEPTION 'merchant exceeds maximum length of 200 characters in CREDIT_CARD_PURCHASE payload';
		END IF;

		v_desc := NEW.payload->>'description';
		IF v_desc IS NOT NULL AND length(v_desc) > 500 THEN
			RAISE EXCEPTION 'description exceeds maximum length of 500 characters in CREDIT_CARD_PURCHASE payload';
		END IF;

		-- Installment count 1..60
		IF NEW.payload->>'installmentCount' IS NOT NULL THEN
			v_inst_cnt := (NEW.payload->>'installmentCount')::integer;
			IF v_inst_cnt < 1 OR v_inst_cnt > 60 THEN
				RAISE EXCEPTION 'installmentCount must be between 1 and 60, got %', v_inst_cnt;
			END IF;
		END IF;

		IF NEW.status = 'READY' THEN
			IF NEW.payload->>'cardId' IS NULL THEN
				RAISE EXCEPTION 'cardId is required for READY status in CREDIT_CARD_PURCHASE';
			END IF;
			IF v_cat IS NULL THEN
				RAISE EXCEPTION 'purchaseCategory is required for READY status in CREDIT_CARD_PURCHASE';
			END IF;
		END IF;

	ELSIF v_rec_type = 'INCOME_RECEIPT' THEN
		IF v_keys <> ARRAY['amount', 'destinationAccountId', 'incomeSourceId', 'note', 'receivedAt', 'recordType'] THEN
			RAISE EXCEPTION 'Invalid keys in INCOME_RECEIPT payload: %', v_keys;
		END IF;

		-- JSON scalar type checks
		IF jsonb_typeof(NEW.payload->'amount') <> 'string' THEN
			RAISE EXCEPTION 'payload.amount must be a JSON string';
		END IF;
		IF jsonb_typeof(NEW.payload->'receivedAt') <> 'string' THEN
			RAISE EXCEPTION 'payload.receivedAt must be a JSON string';
		END IF;
		IF jsonb_typeof(NEW.payload->'incomeSourceId') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.incomeSourceId must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'destinationAccountId') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.destinationAccountId must be a JSON string or null';
		END IF;
		IF jsonb_typeof(NEW.payload->'note') NOT IN ('string', 'null') THEN
			RAISE EXCEPTION 'payload.note must be a JSON string or null';
		END IF;

		-- Amount formatting and range check (NUMERIC(18,2))
		IF NOT (NEW.payload->>'amount' ~ '^(0|[1-9][0-9]{0,15})\.[0-9]{2}$') THEN
			RAISE EXCEPTION 'Invalid amount format in INCOME_RECEIPT payload: %', NEW.payload->>'amount';
		END IF;

		v_amount := (NEW.payload->>'amount')::numeric;
		IF v_amount <= 0 OR v_amount > 9999999999999999.99 THEN
			RAISE EXCEPTION 'Amount out of valid range in INCOME_RECEIPT payload: %', v_amount;
		END IF;

		-- Timestamptz validation
		v_ts_text := NEW.payload->>'receivedAt';
		BEGIN
			PERFORM v_ts_text::timestamptz;
		EXCEPTION WHEN OTHERS THEN
			RAISE EXCEPTION 'receivedAt must be a valid timestamptz string, got %', v_ts_text;
		END;

		-- IncomeSourceId UUID validation
		IF NEW.payload->>'incomeSourceId' IS NOT NULL AND NOT (NEW.payload->>'incomeSourceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'Invalid incomeSourceId UUID in INCOME_RECEIPT payload: %', NEW.payload->>'incomeSourceId';
		END IF;

		-- DestinationAccountId UUID validation
		IF NEW.payload->>'destinationAccountId' IS NOT NULL AND NOT (NEW.payload->>'destinationAccountId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'Invalid destinationAccountId UUID in INCOME_RECEIPT payload: %', NEW.payload->>'destinationAccountId';
		END IF;

		-- Text length limits
		v_note := NEW.payload->>'note';
		IF v_note IS NOT NULL AND length(v_note) > 500 THEN
			RAISE EXCEPTION 'note exceeds maximum length of 500 characters in INCOME_RECEIPT payload';
		END IF;

		IF NEW.status = 'READY' THEN
			IF NEW.payload->>'incomeSourceId' IS NULL THEN
				RAISE EXCEPTION 'incomeSourceId is required for READY status in INCOME_RECEIPT';
			END IF;
			IF NEW.payload->>'destinationAccountId' IS NULL THEN
				RAISE EXCEPTION 'destinationAccountId is required for READY status in INCOME_RECEIPT';
			END IF;
		END IF;

	ELSIF v_rec_type = 'UNSUPPORTED' THEN
		IF v_keys <> ARRAY['reason', 'recordType'] THEN
			RAISE EXCEPTION 'Invalid keys in UNSUPPORTED payload: %', v_keys;
		END IF;
		IF jsonb_typeof(NEW.payload->'reason') <> 'string' THEN
			RAISE EXCEPTION 'payload.reason must be a JSON string';
		END IF;
		v_reason := NEW.payload->>'reason';
		IF length(v_reason) > 500 THEN
			RAISE EXCEPTION 'reason exceeds maximum length of 500 characters in UNSUPPORTED payload';
		END IF;
		IF NEW.status <> 'UNSUPPORTED' THEN
			RAISE EXCEPTION 'Status for UNSUPPORTED payload must be UNSUPPORTED, got %', NEW.status;
		END IF;
	END IF;

	-- Copy-forward economic facts on revision_no > 1
	IF NEW.revision_no > 1 THEN
		SELECT * INTO v_first_rev
		FROM "import_row_revisions"
		WHERE import_row_id = NEW.import_row_id AND revision_no = 1;

		IF FOUND THEN
			IF v_rec_type = 'CREDIT_CARD_PURCHASE' THEN
				IF NEW.payload->>'amount' IS DISTINCT FROM v_first_rev.payload->>'amount' THEN
					RAISE EXCEPTION 'Cannot modify amount in subsequent revisions: original %, attempted %', v_first_rev.payload->>'amount', NEW.payload->>'amount';
				END IF;
				IF NEW.payload->>'occurredAt' IS DISTINCT FROM v_first_rev.payload->>'occurredAt' THEN
					RAISE EXCEPTION 'Cannot modify occurredAt in subsequent revisions';
				END IF;
				IF (NEW.payload->>'merchant') IS DISTINCT FROM (v_first_rev.payload->>'merchant') THEN
					RAISE EXCEPTION 'Cannot modify merchant in subsequent revisions';
				END IF;
				IF (NEW.payload->>'description') IS DISTINCT FROM (v_first_rev.payload->>'description') THEN
					RAISE EXCEPTION 'Cannot modify description in subsequent revisions';
				END IF;
				IF (NEW.payload->>'installmentCount') IS DISTINCT FROM (v_first_rev.payload->>'installmentCount') THEN
					RAISE EXCEPTION 'Cannot modify installmentCount in subsequent revisions';
				END IF;
			ELSIF v_rec_type = 'INCOME_RECEIPT' THEN
				IF NEW.payload->>'amount' IS DISTINCT FROM v_first_rev.payload->>'amount' THEN
					RAISE EXCEPTION 'Cannot modify amount in subsequent revisions: original %, attempted %', v_first_rev.payload->>'amount', NEW.payload->>'amount';
				END IF;
				IF NEW.payload->>'receivedAt' IS DISTINCT FROM v_first_rev.payload->>'receivedAt' THEN
					RAISE EXCEPTION 'Cannot modify receivedAt in subsequent revisions';
				END IF;
				IF (NEW.payload->>'note') IS DISTINCT FROM (v_first_rev.payload->>'note') THEN
					RAISE EXCEPTION 'Cannot modify note in subsequent revisions';
				END IF;
			END IF;
		END IF;

		SELECT * INTO v_prev_rev
		FROM "import_row_revisions"
		WHERE id = NEW.previous_revision_id;

		IF FOUND THEN
			-- Link state machine check: previous status must be READY or POSSIBLE_DUPLICATE
			IF NEW.operation = 'LINK' THEN
				IF v_prev_rev.status NOT IN ('READY', 'POSSIBLE_DUPLICATE') THEN
					RAISE EXCEPTION 'Cannot perform LINK from status % (expected READY or POSSIBLE_DUPLICATE)', v_prev_rev.status;
				END IF;
				IF NEW.payload <> v_prev_rev.payload THEN
					RAISE EXCEPTION 'Operation LINK must copy forward the exact payload from previous revision';
				END IF;
			END IF;

			-- Other copy-forward operations
			IF NEW.operation IN ('APPLY', 'SKIP') THEN
				IF NEW.payload <> v_prev_rev.payload THEN
					RAISE EXCEPTION 'Operation % must copy forward the exact payload from previous revision', NEW.operation;
				END IF;
			END IF;

			-- CONFIRM_IMPORT check: POSSIBLE_DUPLICATE -> RESOLVE -> READY requires exact copy-forward
			IF v_prev_rev.status = 'POSSIBLE_DUPLICATE' AND NEW.operation = 'RESOLVE' AND NEW.status = 'READY' THEN
				IF NEW.payload <> v_prev_rev.payload THEN
					RAISE EXCEPTION 'CONFIRM_IMPORT (POSSIBLE_DUPLICATE -> RESOLVE -> READY) must copy forward the exact payload from previous revision';
				END IF;
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 2. HARDEN RESULT TARGET & CLAIM INTEGRITY BINDING (DEFERRED)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_result_integrity()
RETURNS TRIGGER AS $$
DECLARE
	v_row RECORD;
	v_latest_rev RECORD;
	v_card_event RECORD;
	v_card_event_rev RECORD;
	v_income_receipt RECORD;
	v_income_receipt_rev RECORD;
	v_claim RECORD;
	v_orig_result RECORD;
	v_expected_card_id UUID;
	v_expected_amount NUMERIC;
	v_expected_date DATE;
	v_expected_source_id UUID;
	v_expected_dest_id UUID;
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found for result %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and result %', NEW.import_row_id, NEW.id;
	END IF;

	SELECT * INTO v_latest_rev
	FROM "import_row_revisions"
	WHERE import_row_id = NEW.import_row_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'No revisions found for import row %', NEW.import_row_id;
	END IF;

	-- External Identity Claim Binding Check
	IF NEW.result_kind = 'EXACT_DUPLICATE' THEN
		IF NEW.external_identity_claim_id IS NULL THEN
			RAISE EXCEPTION 'Import result % is EXACT_DUPLICATE but external_identity_claim_id is NULL', NEW.id;
		END IF;

		SELECT * INTO v_claim FROM "import_external_identity_claims" WHERE id = NEW.external_identity_claim_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'External identity claim % not found for exact duplicate result %', NEW.external_identity_claim_id, NEW.id;
		END IF;

		IF v_claim.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between claim % and exact duplicate result %', v_claim.id, NEW.id;
		END IF;

		-- Check that target matches the authoritative result of the claim-owning row
		SELECT * INTO v_orig_result FROM "import_row_results" WHERE import_row_id = v_claim.import_row_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Claim owner row % has no authoritative result for exact duplicate %', v_claim.import_row_id, NEW.id;
		END IF;

		IF NEW.target_type IS DISTINCT FROM v_orig_result.target_type
		   OR NEW.target_id IS DISTINCT FROM v_orig_result.target_id
		   OR NEW.canonical_transaction_id IS DISTINCT FROM v_orig_result.canonical_transaction_id THEN
			RAISE EXCEPTION 'Exact duplicate result % target does not match original result target %', NEW.id, v_orig_result.id;
		END IF;

	ELSIF NEW.result_kind IN ('CREATED', 'LINKED_EXISTING') THEN
		IF v_row.external_transaction_id_hash IS NOT NULL THEN
			IF NEW.external_identity_claim_id IS NULL THEN
				RAISE EXCEPTION 'Import result % has external transaction hash but external_identity_claim_id is NULL', NEW.id;
			END IF;

			SELECT * INTO v_claim FROM "import_external_identity_claims" WHERE id = NEW.external_identity_claim_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'External identity claim % not found for result %', NEW.external_identity_claim_id, NEW.id;
			END IF;

			IF v_claim.import_row_id IS DISTINCT FROM NEW.import_row_id THEN
				RAISE EXCEPTION 'External identity claim % is not owned by import row %', v_claim.id, NEW.import_row_id;
			END IF;
		ELSE
			IF NEW.external_identity_claim_id IS NOT NULL THEN
				RAISE EXCEPTION 'Import result % has no external transaction hash but external_identity_claim_id is non-NULL', NEW.id;
			END IF;
		END IF;
	END IF;

	-- Target domain entity validation
	IF NEW.target_type = 'CREDIT_CARD_PURCHASE' THEN
		IF v_row.record_type IS DISTINCT FROM 'CREDIT_CARD_PURCHASE' THEN
			RAISE EXCEPTION 'Result target_type CREDIT_CARD_PURCHASE does not match row record_type %', v_row.record_type;
		END IF;

		-- Require complete cardId mapping for terminal result
		IF (v_latest_rev.payload->>'cardId') IS NULL THEN
			RAISE EXCEPTION 'cardId cannot be NULL for terminal result in CREDIT_CARD_PURCHASE';
		END IF;

		SELECT * INTO v_card_event
		FROM "credit_card_liability_events"
		WHERE id = NEW.target_id::uuid;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card liability event % not found', NEW.target_id;
		END IF;

		IF v_card_event.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between credit card event % and import result %', v_card_event.id, NEW.id;
		END IF;

		IF v_card_event.event_type IS DISTINCT FROM 'PURCHASE' THEN
			RAISE EXCEPTION 'Credit card event % must be event_type PURCHASE, got %', v_card_event.id, v_card_event.event_type;
		END IF;

		IF NEW.canonical_transaction_id IS NULL OR v_card_event.canonical_transaction_id IS DISTINCT FROM NEW.canonical_transaction_id THEN
			RAISE EXCEPTION 'Canonical transaction ID mismatch: event has %, result has %', v_card_event.canonical_transaction_id, NEW.canonical_transaction_id;
		END IF;

		SELECT * INTO v_card_event_rev
		FROM "credit_card_liability_event_revisions"
		WHERE event_id = v_card_event.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card liability event revision not found for event %', v_card_event.id;
		END IF;

		IF v_card_event_rev.operation = 'VOID' THEN
			RAISE EXCEPTION 'Target credit card liability event % is VOID', v_card_event.id;
		END IF;

		v_expected_card_id := (v_latest_rev.payload->>'cardId')::uuid;
		v_expected_amount := (v_latest_rev.payload->>'amount')::numeric;
		v_expected_date := ((v_latest_rev.payload->>'occurredAt')::timestamptz AT TIME ZONE 'Europe/Istanbul')::date;

		IF v_card_event.credit_card_id IS DISTINCT FROM v_expected_card_id THEN
			RAISE EXCEPTION 'Card ID mismatch: event has %, resolved import payload has %', v_card_event.credit_card_id, v_expected_card_id;
		END IF;

		IF v_card_event_rev.amount IS DISTINCT FROM v_expected_amount THEN
			RAISE EXCEPTION 'Amount mismatch: event has %, resolved import payload has %', v_card_event_rev.amount, v_expected_amount;
		END IF;

		IF v_card_event_rev.purchase_date IS DISTINCT FROM v_expected_date THEN
			RAISE EXCEPTION 'Purchase date mismatch: event has %, resolved import payload has %', v_card_event_rev.purchase_date, v_expected_date;
		END IF;

	ELSIF NEW.target_type = 'INCOME_RECEIPT' THEN
		IF v_row.record_type IS DISTINCT FROM 'INCOME_RECEIPT' THEN
			RAISE EXCEPTION 'Result target_type INCOME_RECEIPT does not match row record_type %', v_row.record_type;
		END IF;

		-- Require complete incomeSourceId and destinationAccountId mappings for terminal result
		IF (v_latest_rev.payload->>'incomeSourceId') IS NULL OR (v_latest_rev.payload->>'destinationAccountId') IS NULL THEN
			RAISE EXCEPTION 'incomeSourceId and destinationAccountId cannot be NULL for terminal result in INCOME_RECEIPT';
		END IF;

		SELECT * INTO v_income_receipt
		FROM "income_receipts"
		WHERE id = NEW.target_id::uuid;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Income receipt % not found', NEW.target_id;
		END IF;

		IF v_income_receipt.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between income receipt % and import result %', v_income_receipt.id, NEW.id;
		END IF;

		IF NEW.canonical_transaction_id IS NULL OR v_income_receipt.canonical_transaction_id IS DISTINCT FROM NEW.canonical_transaction_id THEN
			RAISE EXCEPTION 'Canonical transaction ID mismatch: receipt has %, result has %', v_income_receipt.canonical_transaction_id, NEW.canonical_transaction_id;
		END IF;

		SELECT * INTO v_income_receipt_rev
		FROM "income_receipt_revisions"
		WHERE income_receipt_id = v_income_receipt.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Income receipt revision not found for receipt %', v_income_receipt.id;
		END IF;

		IF v_income_receipt_rev.operation = 'VOID' THEN
			RAISE EXCEPTION 'Target income receipt % is VOID', v_income_receipt.id;
		END IF;

		v_expected_source_id := (v_latest_rev.payload->>'incomeSourceId')::uuid;
		v_expected_dest_id := (v_latest_rev.payload->>'destinationAccountId')::uuid;
		v_expected_amount := (v_latest_rev.payload->>'amount')::numeric;
		v_expected_date := ((v_latest_rev.payload->>'receivedAt')::timestamptz AT TIME ZONE 'Europe/Istanbul')::date;

		IF v_income_receipt.source_id IS DISTINCT FROM v_expected_source_id THEN
			RAISE EXCEPTION 'Income source mismatch: receipt has %, resolved import payload has %', v_income_receipt.source_id, v_expected_source_id;
		END IF;

		IF v_income_receipt_rev.destination_account_id IS DISTINCT FROM v_expected_dest_id THEN
			RAISE EXCEPTION 'Destination account mismatch: receipt has %, resolved import payload has %', v_income_receipt_rev.destination_account_id, v_expected_dest_id;
		END IF;

		IF v_income_receipt_rev.amount IS DISTINCT FROM v_expected_amount THEN
			RAISE EXCEPTION 'Amount mismatch: receipt has %, resolved import payload has %', v_income_receipt_rev.amount, v_expected_amount;
		END IF;

		IF (v_income_receipt_rev.occurred_at AT TIME ZONE 'Europe/Istanbul')::date IS DISTINCT FROM v_expected_date THEN
			RAISE EXCEPTION 'Received date mismatch: receipt has %, resolved import payload has %', (v_income_receipt_rev.occurred_at AT TIME ZONE 'Europe/Istanbul')::date, v_expected_date;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 3. HARDEN EXTERNAL CLAIM INTEGRITY (DEFERRED)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_external_claim_integrity()
RETURNS TRIGGER AS $$
DECLARE
	v_row RECORD;
	v_batch RECORD;
	v_latest_rev RECORD;
	v_expected_scope VARCHAR;
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found for external claim %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	SELECT * INTO v_batch FROM "import_batches" WHERE id = v_row.batch_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import batch % not found for claim %', v_row.batch_id, NEW.id;
	END IF;

	IF v_batch.provider IS DISTINCT FROM NEW.provider THEN
		RAISE EXCEPTION 'Provider mismatch: batch has %, claim has %', v_batch.provider, NEW.provider;
	END IF;

	IF v_row.external_transaction_id_hash IS NULL OR v_row.external_transaction_id_hash IS DISTINCT FROM NEW.external_transaction_id_hash THEN
		RAISE EXCEPTION 'External transaction ID hash mismatch between row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.record_type IS DISTINCT FROM NEW.record_type THEN
		RAISE EXCEPTION 'Record type mismatch between row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	SELECT * INTO v_latest_rev
	FROM "import_row_revisions"
	WHERE import_row_id = NEW.import_row_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF FOUND THEN
		IF NEW.record_type = 'CREDIT_CARD_PURCHASE' THEN
			v_expected_scope := v_latest_rev.payload->>'cardId';
		ELSIF NEW.record_type = 'INCOME_RECEIPT' THEN
			v_expected_scope := v_latest_rev.payload->>'destinationAccountId';
		END IF;

		IF v_expected_scope IS NULL THEN
			RAISE EXCEPTION 'Claim cannot be inserted when payload scope is NULL';
		END IF;

		IF NEW.scope_id IS DISTINCT FROM v_expected_scope THEN
			RAISE EXCEPTION 'Claim scope mismatch: expected %, got %', v_expected_scope, NEW.scope_id;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 4. HARDEN IDEMPOTENCY RECEIPT DB AUTHORITY TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_mutation_receipts_integrity()
RETURNS TRIGGER AS $$
DECLARE
	v_row RECORD;
	v_rev RECORD;
	v_res RECORD;
BEGIN
	-- 1. Row lookup and user match
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found for receipt %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and receipt %', v_row.id, NEW.id;
	END IF;

	-- 2. Revision lookup and ownership match
	SELECT * INTO v_rev FROM "import_row_revisions" WHERE id = NEW.import_row_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import revision % not found for receipt %', NEW.import_row_revision_id, NEW.id;
	END IF;

	IF v_rev.import_row_id IS DISTINCT FROM NEW.import_row_id THEN
		RAISE EXCEPTION 'Revision % does not belong to receipt import row %', v_rev.id, NEW.import_row_id;
	END IF;

	IF v_rev.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between revision % and receipt %', v_rev.id, NEW.id;
	END IF;

	-- 3. Idempotency key exact match
	IF v_rev.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
		RAISE EXCEPTION 'Receipt idempotency key % does not match revision idempotency key %', NEW.idempotency_key, v_rev.idempotency_key;
	END IF;

	-- 4. Operation to revision operation/status mapping
	IF NEW.operation = 'APPLY' THEN
		IF v_rev.operation <> 'APPLY' OR v_rev.status NOT IN ('APPLIED', 'EXACT_DUPLICATE') THEN
			RAISE EXCEPTION 'Receipt operation APPLY mapped to invalid revision operation % / status %', v_rev.operation, v_rev.status;
		END IF;
	ELSIF NEW.operation = 'LINK_EXISTING' THEN
		IF NOT ((v_rev.operation = 'LINK' AND v_rev.status = 'LINKED_EXISTING') OR (v_rev.operation IN ('LINK', 'RESOLVE') AND v_rev.status = 'EXACT_DUPLICATE')) THEN
			RAISE EXCEPTION 'Receipt operation LINK_EXISTING mapped to invalid revision operation % / status %', v_rev.operation, v_rev.status;
		END IF;
	ELSIF NEW.operation = 'SKIP' THEN
		IF v_rev.operation <> 'SKIP' OR v_rev.status <> 'SKIPPED' THEN
			RAISE EXCEPTION 'Receipt operation SKIP mapped to invalid revision operation % / status %', v_rev.operation, v_rev.status;
		END IF;
	ELSIF NEW.operation = 'CONFIRM_IMPORT' THEN
		IF v_rev.operation <> 'RESOLVE' OR v_rev.status <> 'READY' THEN
			RAISE EXCEPTION 'Receipt operation CONFIRM_IMPORT mapped to invalid revision operation % / status %', v_rev.operation, v_rev.status;
		END IF;
	ELSIF NEW.operation = 'RESOLVE_MAPPINGS' THEN
		IF v_rev.operation <> 'RESOLVE' OR v_rev.status NOT IN ('READY', 'NEEDS_REVIEW', 'EXACT_DUPLICATE') THEN
			RAISE EXCEPTION 'Receipt operation RESOLVE_MAPPINGS mapped to invalid revision operation % / status %', v_rev.operation, v_rev.status;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown receipt operation %', NEW.operation;
	END IF;

	-- 5. Result binding integrity
	IF v_rev.status IN ('APPLIED', 'LINKED_EXISTING', 'EXACT_DUPLICATE') THEN
		IF NEW.import_row_result_id IS NULL THEN
			RAISE EXCEPTION 'Receipt for terminal revision % (status %) must have non-null import_row_result_id', v_rev.id, v_rev.status;
		END IF;

		SELECT * INTO v_res FROM "import_row_results" WHERE id = NEW.import_row_result_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Referenced import_row_results % not found for receipt %', NEW.import_row_result_id, NEW.id;
		END IF;

		IF v_res.import_row_id IS DISTINCT FROM NEW.import_row_id OR v_res.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'Result % does not belong to same row/user as receipt %', v_res.id, NEW.id;
		END IF;
	ELSE
		IF NEW.import_row_result_id IS NOT NULL THEN
			RAISE EXCEPTION 'Receipt for non-terminal revision % (status %) must have NULL import_row_result_id', v_rev.id, v_rev.status;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_mutation_receipts_integrity ON "import_mutation_idempotency_receipts";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_mutation_receipts_integrity
BEFORE INSERT ON "import_mutation_idempotency_receipts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_mutation_receipts_integrity();--> statement-breakpoint

-- ============================================================================
-- 5. REVISION RECEIPT COMPLETENESS (DEFERRED CONSTRAINT TRIGGER)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revisions_receipt_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	IF NEW.idempotency_key IS NOT NULL THEN
		SELECT EXISTS (
			SELECT 1 FROM "import_mutation_idempotency_receipts"
			WHERE import_row_revision_id = NEW.id
			  AND idempotency_key = NEW.idempotency_key
			  AND user_id = NEW.user_id
		) INTO v_found;

		IF NOT v_found THEN
			RAISE EXCEPTION 'Import row revision % (operation %, idempotency_key %) has no matching mutation receipt at commit', NEW.id, NEW.operation, NEW.idempotency_key;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_revisions_receipt_completeness ON "import_row_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_row_revisions_receipt_completeness
AFTER INSERT ON "import_row_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_row_revisions_receipt_completeness();
