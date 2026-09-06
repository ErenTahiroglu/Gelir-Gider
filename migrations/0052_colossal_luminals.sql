CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_content_hash" varchar(64) NOT NULL,
	"source_file_name" varchar(255),
	"parser_type" varchar(64) NOT NULL,
	"parser_version" varchar(32) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_source_kind_check" CHECK ("import_batches"."source_kind" IN ('NORMALIZED_ROWS', 'GENERIC_CSV_V1')),
	CONSTRAINT "import_batches_content_hash_check" CHECK ("import_batches"."source_content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_batches_provider_check" CHECK ("import_batches"."provider" = btrim("import_batches"."provider") AND length("import_batches"."provider") BETWEEN 1 AND 64),
	CONSTRAINT "import_batches_parser_type_check" CHECK ("import_batches"."parser_type" = btrim("import_batches"."parser_type") AND length("import_batches"."parser_type") BETWEEN 1 AND 64),
	CONSTRAINT "import_batches_parser_version_check" CHECK ("import_batches"."parser_version" = btrim("import_batches"."parser_version") AND length("import_batches"."parser_version") BETWEEN 1 AND 32),
	CONSTRAINT "import_batches_file_name_check" CHECK ("import_batches"."source_file_name" IS NULL OR ("import_batches"."source_file_name" = btrim("import_batches"."source_file_name") AND length("import_batches"."source_file_name") BETWEEN 1 AND 255))
);
--> statement-breakpoint
CREATE TABLE "import_duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"import_row_id" uuid NOT NULL,
	"candidate_type" varchar(32) NOT NULL,
	"candidate_id" varchar(64) NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_duplicate_candidates_type_check" CHECK ("import_duplicate_candidates"."candidate_type" IN ('IMPORT_ROW', 'CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT')),
	CONSTRAINT "import_duplicate_candidates_id_check" CHECK ("import_duplicate_candidates"."candidate_id" = btrim("import_duplicate_candidates"."candidate_id") AND length("import_duplicate_candidates"."candidate_id") BETWEEN 1 AND 64),
	CONSTRAINT "import_duplicate_candidates_reason_check" CHECK ("import_duplicate_candidates"."reason_code" IN ('SAME_CARD_DATE_AMOUNT', 'SAME_CARD_DATE_AMOUNT_MERCHANT', 'SAME_INCOME_SOURCE_DATE_AMOUNT', 'SAME_BATCH_SEMANTICS'))
);
--> statement-breakpoint
CREATE TABLE "import_external_identity_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"record_type" varchar(32) NOT NULL,
	"scope_id" varchar(64) NOT NULL,
	"external_transaction_id_hash" varchar(64) NOT NULL,
	"import_row_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_ext_claims_record_type_check" CHECK ("import_external_identity_claims"."record_type" IN ('CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT')),
	CONSTRAINT "import_ext_claims_provider_check" CHECK ("import_external_identity_claims"."provider" = btrim("import_external_identity_claims"."provider") AND length("import_external_identity_claims"."provider") BETWEEN 1 AND 64),
	CONSTRAINT "import_ext_claims_scope_check" CHECK ("import_external_identity_claims"."scope_id" = btrim("import_external_identity_claims"."scope_id") AND length("import_external_identity_claims"."scope_id") BETWEEN 1 AND 64),
	CONSTRAINT "import_ext_claims_hash_check" CHECK ("import_external_identity_claims"."external_transaction_id_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_row_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"import_row_id" uuid NOT NULL,
	"result_kind" varchar(32) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(64) NOT NULL,
	"canonical_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_row_results_kind_check" CHECK ("import_row_results"."result_kind" IN ('CREATED', 'LINKED_EXISTING', 'EXACT_DUPLICATE')),
	CONSTRAINT "import_row_results_target_type_check" CHECK ("import_row_results"."target_type" IN ('CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT')),
	CONSTRAINT "import_row_results_target_id_check" CHECK ("import_row_results"."target_id" = btrim("import_row_results"."target_id") AND length("import_row_results"."target_id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "import_row_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"import_row_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(16) NOT NULL,
	"status" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"reason_note" varchar(500),
	"occurred_at" timestamp with time zone,
	"idempotency_key" varchar(128),
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_row_revisions_rev_no_check" CHECK ("import_row_revisions"."revision_no" >= 1),
	CONSTRAINT "import_row_revisions_operation_check" CHECK ("import_row_revisions"."operation" IN ('STAGE', 'RESOLVE', 'APPLY', 'LINK', 'SKIP')),
	CONSTRAINT "import_row_revisions_status_check" CHECK ("import_row_revisions"."status" IN ('READY', 'NEEDS_REVIEW', 'POSSIBLE_DUPLICATE', 'EXACT_DUPLICATE', 'APPLIED', 'LINKED_EXISTING', 'SKIPPED', 'UNSUPPORTED')),
	CONSTRAINT "import_row_revisions_fp_check" CHECK ("import_row_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_row_revisions_idempotency_check" CHECK ("import_row_revisions"."idempotency_key" IS NULL OR ("import_row_revisions"."idempotency_key" = btrim("import_row_revisions"."idempotency_key") AND length("import_row_revisions"."idempotency_key") BETWEEN 1 AND 128)),
	CONSTRAINT "import_row_revisions_reason_note_check" CHECK ("import_row_revisions"."reason_note" IS NULL OR ("import_row_revisions"."reason_note" = btrim("import_row_revisions"."reason_note") AND length("import_row_revisions"."reason_note") BETWEEN 1 AND 500)),
	CONSTRAINT "import_row_revisions_payload_size_check" CHECK (octet_length("import_row_revisions"."payload"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_ordinal" integer NOT NULL,
	"record_type" varchar(32) NOT NULL,
	"raw_row_hash" varchar(64) NOT NULL,
	"semantic_fingerprint" varchar(64) NOT NULL,
	"external_transaction_id_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_ordinal_check" CHECK ("import_rows"."row_ordinal" >= 0),
	CONSTRAINT "import_rows_record_type_check" CHECK ("import_rows"."record_type" IN ('CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT', 'UNSUPPORTED')),
	CONSTRAINT "import_rows_raw_hash_check" CHECK ("import_rows"."raw_row_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_rows_semantic_fp_check" CHECK ("import_rows"."semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_rows_ext_id_hash_check" CHECK ("import_rows"."external_transaction_id_hash" IS NULL OR "import_rows"."external_transaction_id_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_duplicate_candidates" ADD CONSTRAINT "import_duplicate_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_duplicate_candidates" ADD CONSTRAINT "import_duplicate_candidates_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_external_identity_claims" ADD CONSTRAINT "import_external_identity_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_external_identity_claims" ADD CONSTRAINT "import_external_identity_claims_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_results" ADD CONSTRAINT "import_row_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_results" ADD CONSTRAINT "import_row_results_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_results" ADD CONSTRAINT "import_row_results_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_revisions" ADD CONSTRAINT "import_row_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_revisions" ADD CONSTRAINT "import_row_revisions_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_revisions" ADD CONSTRAINT "import_row_revisions_previous_revision_id_import_row_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."import_row_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_identity_idx" ON "import_batches" USING btree ("user_id","provider","source_content_hash","parser_type","parser_version");--> statement-breakpoint
CREATE INDEX "import_batches_user_created_idx" ON "import_batches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "import_duplicate_candidates_row_idx" ON "import_duplicate_candidates" USING btree ("import_row_id");--> statement-breakpoint
CREATE INDEX "import_duplicate_candidates_target_idx" ON "import_duplicate_candidates" USING btree ("user_id","candidate_type","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_ext_claims_identity_idx" ON "import_external_identity_claims" USING btree ("user_id","provider","record_type","scope_id","external_transaction_id_hash");--> statement-breakpoint
CREATE INDEX "import_ext_claims_row_idx" ON "import_external_identity_claims" USING btree ("import_row_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_results_row_idx" ON "import_row_results" USING btree ("import_row_id");--> statement-breakpoint
CREATE INDEX "import_row_results_target_idx" ON "import_row_results" USING btree ("user_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_revisions_row_rev_idx" ON "import_row_revisions" USING btree ("import_row_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_revisions_prev_rev_idx" ON "import_row_revisions" USING btree ("previous_revision_id") WHERE "import_row_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_revisions_user_idempotency_idx" ON "import_row_revisions" USING btree ("user_id","idempotency_key") WHERE "import_row_revisions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "import_row_revisions_row_created_idx" ON "import_row_revisions" USING btree ("import_row_id","created_at");--> statement-breakpoint
CREATE INDEX "import_row_revisions_user_status_idx" ON "import_row_revisions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_batch_ordinal_idx" ON "import_rows" USING btree ("batch_id","row_ordinal");--> statement-breakpoint
CREATE INDEX "import_rows_user_created_idx" ON "import_rows" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "import_rows_user_semantic_idx" ON "import_rows" USING btree ("user_id","semantic_fingerprint");--> statement-breakpoint
CREATE INDEX "import_rows_user_ext_id_idx" ON "import_rows" USING btree ("user_id","external_transaction_id_hash") WHERE "import_rows"."external_transaction_id_hash" IS NOT NULL;--> statement-breakpoint

-- ============================================================================
-- 1. IMMUTABILITY TRIGGERS (UPDATE AND DELETE FORBIDDEN)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_prevent_import_mutation()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'table % is immutable: UPDATE and DELETE operations are forbidden', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_batches_immutable ON "import_batches";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_batches_immutable
BEFORE UPDATE OR DELETE ON "import_batches"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_rows_immutable ON "import_rows";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_rows_immutable
BEFORE UPDATE OR DELETE ON "import_rows"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_revisions_immutable ON "import_row_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_row_revisions_immutable
BEFORE UPDATE OR DELETE ON "import_row_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_external_identity_claims_immutable ON "import_external_identity_claims";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_external_identity_claims_immutable
BEFORE UPDATE OR DELETE ON "import_external_identity_claims"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_duplicate_candidates_immutable ON "import_duplicate_candidates";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_duplicate_candidates_immutable
BEFORE UPDATE OR DELETE ON "import_duplicate_candidates"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_results_immutable ON "import_row_results";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_row_results_immutable
BEFORE UPDATE OR DELETE ON "import_row_results"
FOR EACH ROW EXECUTE FUNCTION trg_fn_prevent_import_mutation();--> statement-breakpoint

-- ============================================================================
-- 2. IMPORT ROW REVISION CHAIN INTEGRITY & STATE TRANSITIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revision_chain()
RETURNS TRIGGER AS $$
DECLARE
	v_prev RECORD;
	v_row RECORD;
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Parent import row % not found', NEW.import_row_id;
	END IF;
	IF v_row.user_id <> NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and revision %', NEW.import_row_id, NEW.id;
	END IF;

	IF NEW.revision_no = 1 THEN
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'Initial revision (revision_no=1) must have NULL previous_revision_id';
		END IF;
		IF NEW.operation <> 'STAGE' THEN
			RAISE EXCEPTION 'Initial revision (revision_no=1) must have operation STAGE, found %', NEW.operation;
		END IF;
	ELSE
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Subsequent revision (revision_no=%) must have non-NULL previous_revision_id', NEW.revision_no;
		END IF;

		SELECT * INTO v_prev FROM "import_row_revisions" WHERE id = NEW.previous_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Previous revision % not found', NEW.previous_revision_id;
		END IF;

		IF v_prev.import_row_id <> NEW.import_row_id THEN
			RAISE EXCEPTION 'Previous revision % belongs to different import row %', NEW.previous_revision_id, v_prev.import_row_id;
		END IF;

		IF v_prev.revision_no <> NEW.revision_no - 1 THEN
			RAISE EXCEPTION 'Revision sequence gap: expected revision_no=%, got %', v_prev.revision_no + 1, NEW.revision_no;
		END IF;

		IF v_prev.status IN ('APPLIED', 'LINKED_EXISTING', 'SKIPPED', 'EXACT_DUPLICATE') THEN
			RAISE EXCEPTION 'Cannot append new revision to terminal row status % (import_row_id=%)', v_prev.status, NEW.import_row_id;
		END IF;
	END IF;

	IF NEW.operation = 'APPLY' AND NEW.status <> 'APPLIED' THEN
		RAISE EXCEPTION 'APPLY operation must have status APPLIED, found %', NEW.status;
	END IF;

	IF NEW.operation = 'LINK' AND NEW.status <> 'LINKED_EXISTING' THEN
		RAISE EXCEPTION 'LINK operation must have status LINKED_EXISTING, found %', NEW.status;
	END IF;

	IF NEW.operation = 'SKIP' AND NEW.status <> 'SKIPPED' THEN
		RAISE EXCEPTION 'SKIP operation must have status SKIPPED, found %', NEW.status;
	END IF;

	IF NEW.operation IN ('STAGE', 'RESOLVE') AND NEW.status IN ('APPLIED', 'LINKED_EXISTING', 'SKIPPED') THEN
		RAISE EXCEPTION 'Operation % cannot transition directly to terminal status %', NEW.operation, NEW.status;
	END IF;

	IF NEW.operation = 'APPLY' THEN
		IF v_prev.status <> 'READY' THEN
			RAISE EXCEPTION 'Cannot APPLY import row when current status is % (must be READY)', v_prev.status;
		END IF;
	END IF;

	IF NEW.operation = 'LINK' THEN
		IF v_prev.status = 'UNSUPPORTED' THEN
			RAISE EXCEPTION 'Cannot LINK import row with UNSUPPORTED status';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_revision_chain ON "import_row_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_import_row_revision_chain
BEFORE INSERT ON "import_row_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_row_revision_chain();--> statement-breakpoint

-- ============================================================================
-- 3. ANCHOR COMPLETENESS CONSTRAINTS (DEFERRED)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT EXISTS(
		SELECT 1 FROM "import_row_revisions"
		WHERE import_row_id = NEW.id AND revision_no = 1
	) INTO v_found;

	IF NOT v_found THEN
		RAISE EXCEPTION 'Import row % has no stage revision at commit (naked import row anchor)', NEW.id;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_anchor_completeness ON "import_rows";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_row_anchor_completeness
AFTER INSERT ON "import_rows"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_row_anchor_completeness();--> statement-breakpoint

-- ============================================================================
-- 4. TERMINAL RESULT BINDING GUARDS (DEFERRED)
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
	ELSIF NEW.status = 'SKIPPED' THEN
		IF EXISTS (SELECT 1 FROM "import_row_results" WHERE import_row_id = NEW.import_row_id) THEN
			RAISE EXCEPTION 'Import row revision % is SKIPPED but has an associated import_row_results record', NEW.id;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_terminal_result_binding ON "import_row_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_terminal_result_binding
AFTER INSERT ON "import_row_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_terminal_result_binding();--> statement-breakpoint

-- ============================================================================
-- 5. RESULT TARGET INTEGRITY BINDING (DEFERRED)
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

		SELECT * INTO v_card_event_rev
		FROM "credit_card_liability_event_revisions"
		WHERE event_id = v_card_event.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card liability event revision not found for event %', v_card_event.id;
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

		SELECT * INTO v_income_receipt_rev
		FROM "income_receipt_revisions"
		WHERE income_receipt_id = v_income_receipt.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Income receipt revision not found for receipt %', v_income_receipt.id;
		END IF;

		v_expected_source_id := (v_latest_rev.payload->>'incomeSourceId')::uuid;
		v_expected_dest_id := (v_latest_rev.payload->>'destinationAccountId')::uuid;
		v_expected_amount := (v_latest_rev.payload->>'amount')::numeric;

		IF v_income_receipt.source_id <> v_expected_source_id THEN
			RAISE EXCEPTION 'Income source mismatch: receipt has %, resolved import payload has %', v_income_receipt.source_id, v_expected_source_id;
		END IF;

		IF v_income_receipt_rev.destination_account_id <> v_expected_dest_id THEN
			RAISE EXCEPTION 'Destination account mismatch: receipt has %, resolved import payload has %', v_income_receipt_rev.destination_account_id, v_expected_dest_id;
		END IF;

		IF v_income_receipt_rev.amount <> v_expected_amount THEN
			RAISE EXCEPTION 'Amount mismatch: receipt has %, resolved import payload has %', v_income_receipt_rev.amount, v_expected_amount;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_row_result_integrity ON "import_row_results";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_row_result_integrity
AFTER INSERT ON "import_row_results"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_row_result_integrity();--> statement-breakpoint

-- ============================================================================
-- 6. EXTERNAL CLAIM INTEGRITY (DEFERRED)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_external_claim_integrity()
RETURNS TRIGGER AS $$
DECLARE
	v_row RECORD;
BEGIN
	SELECT * INTO v_row FROM "import_rows" WHERE id = NEW.import_row_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Import row % not found for external claim %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.user_id <> NEW.user_id THEN
		RAISE EXCEPTION 'User ID mismatch between import row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.external_transaction_id_hash IS NULL OR v_row.external_transaction_id_hash <> NEW.external_transaction_id_hash THEN
		RAISE EXCEPTION 'External transaction ID hash mismatch between row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	IF v_row.record_type <> NEW.record_type THEN
		RAISE EXCEPTION 'Record type mismatch between row % and claim %', NEW.import_row_id, NEW.id;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_import_external_claim_integrity ON "import_external_identity_claims";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_import_external_claim_integrity
AFTER INSERT ON "import_external_identity_claims"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_import_external_claim_integrity();