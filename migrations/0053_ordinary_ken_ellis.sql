CREATE TABLE "import_mutation_idempotency_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"operation" varchar(32) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"import_row_id" uuid NOT NULL,
	"import_row_revision_id" uuid NOT NULL,
	"import_row_result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_mutation_receipts_op_check" CHECK ("import_mutation_idempotency_receipts"."operation" IN ('RESOLVE_MAPPINGS', 'CONFIRM_IMPORT', 'LINK_EXISTING', 'SKIP', 'APPLY')),
	CONSTRAINT "import_mutation_receipts_key_check" CHECK ("import_mutation_idempotency_receipts"."idempotency_key" = btrim("import_mutation_idempotency_receipts"."idempotency_key") AND length("import_mutation_idempotency_receipts"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "import_mutation_receipts_fp_check" CHECK ("import_mutation_idempotency_receipts"."request_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "import_row_results" ADD COLUMN "external_identity_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "import_mutation_idempotency_receipts" ADD CONSTRAINT "import_mutation_idempotency_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mutation_idempotency_receipts" ADD CONSTRAINT "import_mutation_idempotency_receipts_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mutation_idempotency_receipts" ADD CONSTRAINT "import_mutation_idempotency_receipts_import_row_revision_id_import_row_revisions_id_fk" FOREIGN KEY ("import_row_revision_id") REFERENCES "public"."import_row_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mutation_idempotency_receipts" ADD CONSTRAINT "import_mutation_idempotency_receipts_import_row_result_id_import_row_results_id_fk" FOREIGN KEY ("import_row_result_id") REFERENCES "public"."import_row_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_mutation_receipts_user_key_idx" ON "import_mutation_idempotency_receipts" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "import_mutation_receipts_row_idx" ON "import_mutation_idempotency_receipts" USING btree ("import_row_id");--> statement-breakpoint
ALTER TABLE "import_row_results" ADD CONSTRAINT "import_row_results_external_identity_claim_id_import_external_identity_claims_id_fk" FOREIGN KEY ("external_identity_claim_id") REFERENCES "public"."import_external_identity_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_row_results_claim_idx" ON "import_row_results" USING btree ("external_identity_claim_id");--> statement-breakpoint

-- ============================================================================
-- 1. IMMUTABILITY TRIGGER FOR IDEMPOTENCY RECEIPTS
-- ============================================================================

DROP TRIGGER IF EXISTS trg_guard_import_mutation_receipts_immutable ON "import_mutation_idempotency_receipts";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_mutation_receipts_immutable
BEFORE UPDATE OR DELETE ON "import_mutation_idempotency_receipts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

-- ============================================================================
-- 2. HARDEN TERMINAL RESULT BINDING GUARDS (DEFERRED)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_terminal_result_binding()
RETURNS TRIGGER AS $$
DECLARE
	v_result RECORD;
BEGIN
	IF NEW.status = 'APPLIED' THEN
		SELECT * INTO v_result FROM "import_row_results" WHERE import_row_id = NEW.import_row_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Import row revision % is APPLIED but has no matching import_row_results at commit', NEW.id;
		END IF;
		IF v_result.result_kind <> 'CREATED' THEN
			RAISE EXCEPTION 'Import row revision % is APPLIED but import_row_results result_kind is % (expected CREATED)', NEW.id, v_result.result_kind;
		END IF;
	ELSIF NEW.status = 'LINKED_EXISTING' THEN
		SELECT * INTO v_result FROM "import_row_results" WHERE import_row_id = NEW.import_row_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Import row revision % is LINKED_EXISTING but has no matching import_row_results at commit', NEW.id;
		END IF;
		IF v_result.result_kind <> 'LINKED_EXISTING' THEN
			RAISE EXCEPTION 'Import row revision % is LINKED_EXISTING but import_row_results result_kind is % (expected LINKED_EXISTING)', NEW.id, v_result.result_kind;
		END IF;
	ELSIF NEW.status = 'EXACT_DUPLICATE' THEN
		SELECT * INTO v_result FROM "import_row_results" WHERE import_row_id = NEW.import_row_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Import row revision % is EXACT_DUPLICATE but has no matching import_row_results at commit', NEW.id;
		END IF;
		IF v_result.result_kind <> 'EXACT_DUPLICATE' THEN
			RAISE EXCEPTION 'Import row revision % is EXACT_DUPLICATE but import_row_results result_kind is % (expected EXACT_DUPLICATE)', NEW.id, v_result.result_kind;
		END IF;
	ELSIF NEW.status = 'SKIPPED' THEN
		IF EXISTS (SELECT 1 FROM "import_row_results" WHERE import_row_id = NEW.import_row_id) THEN
			RAISE EXCEPTION 'Import row revision % is SKIPPED but has an associated import_row_results record', NEW.id;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 3. HARDEN RESULT TARGET & CLAIM INTEGRITY BINDING (DEFERRED)
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

	IF v_row.user_id <> NEW.user_id THEN
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

		IF v_claim.user_id <> NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between claim % and exact duplicate result %', v_claim.id, NEW.id;
		END IF;

		-- Check that target matches the authoritative result of the claim-owning row
		SELECT * INTO v_orig_result FROM "import_row_results" WHERE import_row_id = v_claim.import_row_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Claim owner row % has no authoritative result for exact duplicate %', v_claim.import_row_id, NEW.id;
		END IF;

		IF NEW.target_type <> v_orig_result.target_type OR NEW.target_id <> v_orig_result.target_id OR NEW.canonical_transaction_id <> v_orig_result.canonical_transaction_id THEN
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

			IF v_claim.import_row_id <> NEW.import_row_id THEN
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
		IF v_row.record_type <> 'CREDIT_CARD_PURCHASE' THEN
			RAISE EXCEPTION 'Result target_type CREDIT_CARD_PURCHASE does not match row record_type %', v_row.record_type;
		END IF;

		SELECT * INTO v_card_event
		FROM "credit_card_liability_events"
		WHERE id = NEW.target_id::uuid;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card liability event % not found', NEW.target_id;
		END IF;

		IF v_card_event.user_id <> NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between credit card event % and import result %', v_card_event.id, NEW.id;
		END IF;

		IF v_card_event.event_type <> 'PURCHASE' THEN
			RAISE EXCEPTION 'Credit card event % must be event_type PURCHASE, got %', v_card_event.id, v_card_event.event_type;
		END IF;

		IF NEW.canonical_transaction_id IS NULL OR v_card_event.canonical_transaction_id <> NEW.canonical_transaction_id THEN
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

		IF v_card_event.credit_card_id <> v_expected_card_id THEN
			RAISE EXCEPTION 'Card ID mismatch: event has %, resolved import payload has %', v_card_event.credit_card_id, v_expected_card_id;
		END IF;

		IF v_card_event_rev.amount <> v_expected_amount THEN
			RAISE EXCEPTION 'Amount mismatch: event has %, resolved import payload has %', v_card_event_rev.amount, v_expected_amount;
		END IF;

		IF v_card_event_rev.purchase_date <> v_expected_date THEN
			RAISE EXCEPTION 'Purchase date mismatch: event has %, resolved import payload has %', v_card_event_rev.purchase_date, v_expected_date;
		END IF;

	ELSIF NEW.target_type = 'INCOME_RECEIPT' THEN
		IF v_row.record_type <> 'INCOME_RECEIPT' THEN
			RAISE EXCEPTION 'Result target_type INCOME_RECEIPT does not match row record_type %', v_row.record_type;
		END IF;

		SELECT * INTO v_income_receipt
		FROM "income_receipts"
		WHERE id = NEW.target_id::uuid;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Income receipt % not found', NEW.target_id;
		END IF;

		IF v_income_receipt.user_id <> NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between income receipt % and import result %', v_income_receipt.id, NEW.id;
		END IF;

		IF NEW.canonical_transaction_id IS NULL OR v_income_receipt.canonical_transaction_id <> NEW.canonical_transaction_id THEN
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

		IF v_income_receipt.source_id <> v_expected_source_id THEN
			RAISE EXCEPTION 'Income source mismatch: receipt has %, resolved import payload has %', v_income_receipt.source_id, v_expected_source_id;
		END IF;

		IF v_income_receipt_rev.destination_account_id <> v_expected_dest_id THEN
			RAISE EXCEPTION 'Destination account mismatch: receipt has %, resolved import payload has %', v_income_receipt_rev.destination_account_id, v_expected_dest_id;
		END IF;

		IF v_income_receipt_rev.amount <> v_expected_amount THEN
			RAISE EXCEPTION 'Amount mismatch: receipt has %, resolved import payload has %', v_income_receipt_rev.amount, v_expected_amount;
		END IF;

		IF (v_income_receipt_rev.occurred_at AT TIME ZONE 'Europe/Istanbul')::date <> v_expected_date THEN
			RAISE EXCEPTION 'Received date mismatch: receipt has %, resolved import payload has %', (v_income_receipt_rev.occurred_at AT TIME ZONE 'Europe/Istanbul')::date, v_expected_date;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 4. HARDEN EXTERNAL CLAIM INTEGRITY & COMPLETENESS (DEFERRED)
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

	IF v_row.user_id <> NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	SELECT * INTO v_batch FROM "import_batches" WHERE id = v_row.batch_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import batch % not found for claim %', v_row.batch_id, NEW.id;
	END IF;

	IF v_batch.provider <> NEW.provider THEN
		RAISE EXCEPTION 'Provider mismatch: batch has %, claim has %', v_batch.provider, NEW.provider;
	END IF;

	IF v_row.external_transaction_id_hash IS NULL OR v_row.external_transaction_id_hash <> NEW.external_transaction_id_hash THEN
		RAISE EXCEPTION 'External transaction ID hash mismatch between row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.record_type <> NEW.record_type THEN
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

		IF v_expected_scope IS NOT NULL AND NEW.scope_id <> v_expected_scope THEN
			RAISE EXCEPTION 'Claim scope mismatch: expected %, got %', v_expected_scope, NEW.scope_id;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_import_external_claim_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT EXISTS (
		SELECT 1 FROM "import_row_results"
		WHERE import_row_id = NEW.import_row_id
		  AND result_kind IN ('CREATED', 'LINKED_EXISTING')
		  AND external_identity_claim_id = NEW.id
	) INTO v_found;

	IF NOT v_found THEN
		RAISE EXCEPTION 'External identity claim % owned by import row % has no matching CREATED or LINKED_EXISTING result at commit (naked claim)', NEW.id, NEW.import_row_id;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_external_claim_completeness ON "import_external_identity_claims";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_external_claim_completeness
AFTER INSERT ON "import_external_identity_claims"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_external_claim_completeness();--> statement-breakpoint

-- ============================================================================
-- 5. DUPLICATE CANDIDATE TARGET INTEGRITY (DEFERRED)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_duplicate_candidates_integrity()
RETURNS TRIGGER AS $$
DECLARE
	v_row RECORD;
	v_target_row RECORD;
	v_card_event RECORD;
	v_income_receipt RECORD;
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found for duplicate candidate %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.user_id <> NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and candidate %', NEW.import_row_id, NEW.id;
	END IF;

	IF NEW.candidate_type = 'IMPORT_ROW' THEN
		BEGIN
			SELECT * INTO v_target_row FROM "import_rows" WHERE id = NEW.candidate_id::uuid;
		EXCEPTION WHEN OTHERS THEN
			RAISE EXCEPTION 'Invalid UUID for IMPORT_ROW candidate_id: %', NEW.candidate_id;
		END;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target candidate import row % not found', NEW.candidate_id;
		END IF;

		IF v_target_row.user_id <> NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between candidate target row % and candidate %', v_target_row.id, NEW.id;
		END IF;

		IF v_target_row.batch_id <> v_row.batch_id THEN
			RAISE EXCEPTION 'Batch ID mismatch between candidate target row % and candidate row %', v_target_row.batch_id, v_row.batch_id;
		END IF;

		IF v_target_row.id = v_row.id THEN
			RAISE EXCEPTION 'Import row % cannot have duplicate candidate pointing to itself', v_row.id;
		END IF;

	ELSIF NEW.candidate_type = 'CREDIT_CARD_PURCHASE' THEN
		BEGIN
			SELECT * INTO v_card_event FROM "credit_card_liability_events" WHERE id = NEW.candidate_id::uuid;
		EXCEPTION WHEN OTHERS THEN
			RAISE EXCEPTION 'Invalid UUID for CREDIT_CARD_PURCHASE candidate_id: %', NEW.candidate_id;
		END;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target credit card liability event % not found', NEW.candidate_id;
		END IF;

		IF v_card_event.user_id <> NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between card event % and candidate %', v_card_event.id, NEW.id;
		END IF;

		IF v_card_event.event_type <> 'PURCHASE' THEN
			RAISE EXCEPTION 'Target credit card event % must be PURCHASE, found %', v_card_event.id, v_card_event.event_type;
		END IF;

	ELSIF NEW.candidate_type = 'INCOME_RECEIPT' THEN
		BEGIN
			SELECT * INTO v_income_receipt FROM "income_receipts" WHERE id = NEW.candidate_id::uuid;
		EXCEPTION WHEN OTHERS THEN
			RAISE EXCEPTION 'Invalid UUID for INCOME_RECEIPT candidate_id: %', NEW.candidate_id;
		END;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target income receipt % not found', NEW.candidate_id;
		END IF;

		IF v_income_receipt.user_id <> NEW.user_id THEN
			RAISE EXCEPTION 'User ID mismatch between income receipt % and candidate %', v_income_receipt.id, NEW.id;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_duplicate_candidates_integrity ON "import_duplicate_candidates";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_duplicate_candidates_integrity
AFTER INSERT ON "import_duplicate_candidates"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_duplicate_candidates_integrity();--> statement-breakpoint

-- ============================================================================
-- 6. DB-AUTHORITATIVE NORMALIZED PAYLOAD & COPY-FORWARD GUARDS
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
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found', NEW.import_row_id;
	END IF;

	SELECT array_agg(k ORDER BY k) INTO v_keys
	FROM jsonb_object_keys(NEW.payload) AS k;

	v_rec_type := NEW.payload->>'recordType';

	IF v_rec_type <> v_row.record_type THEN
		RAISE EXCEPTION 'Payload recordType % does not match import row record_type %', v_rec_type, v_row.record_type;
	END IF;

	IF v_rec_type = 'CREDIT_CARD_PURCHASE' THEN
		IF v_keys <> ARRAY['amount', 'cardId', 'description', 'installmentCount', 'merchant', 'occurredAt', 'purchaseCategory', 'recordType', 'shortTermGoalId'] THEN
			RAISE EXCEPTION 'Invalid keys in CREDIT_CARD_PURCHASE payload: %', v_keys;
		END IF;

		IF NOT (NEW.payload->>'amount' ~ '^[0-9]+(\.[0-9]{2})$') THEN
			RAISE EXCEPTION 'Invalid amount format in CREDIT_CARD_PURCHASE payload: %', NEW.payload->>'amount';
		END IF;

		v_amount := (NEW.payload->>'amount')::numeric;
		IF v_amount <= 0 THEN
			RAISE EXCEPTION 'Amount must be positive in CREDIT_CARD_PURCHASE payload: %', v_amount;
		END IF;

		IF NEW.payload->>'cardId' IS NOT NULL AND NOT (NEW.payload->>'cardId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'Invalid cardId UUID in CREDIT_CARD_PURCHASE payload: %', NEW.payload->>'cardId';
		END IF;

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

		IF NEW.payload->>'installmentCount' IS NOT NULL THEN
			v_inst_cnt := (NEW.payload->>'installmentCount')::integer;
			IF v_inst_cnt < 1 OR v_inst_cnt > 36 THEN
				RAISE EXCEPTION 'installmentCount must be between 1 and 36, got %', v_inst_cnt;
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

		IF NOT (NEW.payload->>'amount' ~ '^[0-9]+(\.[0-9]{2})$') THEN
			RAISE EXCEPTION 'Invalid amount format in INCOME_RECEIPT payload: %', NEW.payload->>'amount';
		END IF;

		v_amount := (NEW.payload->>'amount')::numeric;
		IF v_amount <= 0 THEN
			RAISE EXCEPTION 'Amount must be positive in INCOME_RECEIPT payload: %', v_amount;
		END IF;

		IF NEW.payload->>'incomeSourceId' IS NOT NULL AND NOT (NEW.payload->>'incomeSourceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'Invalid incomeSourceId UUID in INCOME_RECEIPT payload: %', NEW.payload->>'incomeSourceId';
		END IF;

		IF NEW.payload->>'destinationAccountId' IS NOT NULL AND NOT (NEW.payload->>'destinationAccountId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'Invalid destinationAccountId UUID in INCOME_RECEIPT payload: %', NEW.payload->>'destinationAccountId';
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
				IF NEW.payload->>'amount' <> v_first_rev.payload->>'amount' THEN
					RAISE EXCEPTION 'Cannot modify amount in subsequent revisions: original %, attempted %', v_first_rev.payload->>'amount', NEW.payload->>'amount';
				END IF;
				IF NEW.payload->>'occurredAt' <> v_first_rev.payload->>'occurredAt' THEN
					RAISE EXCEPTION 'Cannot modify occurredAt in subsequent revisions';
				END IF;
				IF COALESCE(NEW.payload->>'merchant', '') <> COALESCE(v_first_rev.payload->>'merchant', '') THEN
					RAISE EXCEPTION 'Cannot modify merchant in subsequent revisions';
				END IF;
				IF COALESCE(NEW.payload->>'description', '') <> COALESCE(v_first_rev.payload->>'description', '') THEN
					RAISE EXCEPTION 'Cannot modify description in subsequent revisions';
				END IF;
				IF COALESCE(NEW.payload->>'installmentCount', '') <> COALESCE(v_first_rev.payload->>'installmentCount', '') THEN
					RAISE EXCEPTION 'Cannot modify installmentCount in subsequent revisions';
				END IF;
			ELSIF v_rec_type = 'INCOME_RECEIPT' THEN
				IF NEW.payload->>'amount' <> v_first_rev.payload->>'amount' THEN
					RAISE EXCEPTION 'Cannot modify amount in subsequent revisions: original %, attempted %', v_first_rev.payload->>'amount', NEW.payload->>'amount';
				END IF;
				IF NEW.payload->>'receivedAt' <> v_first_rev.payload->>'receivedAt' THEN
					RAISE EXCEPTION 'Cannot modify receivedAt in subsequent revisions';
				END IF;
				IF COALESCE(NEW.payload->>'note', '') <> COALESCE(v_first_rev.payload->>'note', '') THEN
					RAISE EXCEPTION 'Cannot modify note in subsequent revisions';
				END IF;
			END IF;
		END IF;

		SELECT * INTO v_prev_rev
		FROM "import_row_revisions"
		WHERE id = NEW.previous_revision_id;

		IF FOUND AND NEW.operation IN ('CONFIRM_IMPORT', 'APPLY', 'SKIP', 'LINK') THEN
			IF NEW.payload <> v_prev_rev.payload THEN
				RAISE EXCEPTION 'Operation % must copy forward the exact payload from previous revision', NEW.operation;
			END IF;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_revisions_payload_integrity ON "import_row_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_row_revisions_payload_integrity
BEFORE INSERT ON "import_row_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_row_revisions_payload_integrity();