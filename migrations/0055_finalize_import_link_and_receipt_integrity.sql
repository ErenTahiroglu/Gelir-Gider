-- Migration 0055: Finalize Import Link and Receipt Integrity

-- ============================================================================
-- 1. HARDEN IMPORT ROW REVISION CHAIN TRIGGER (LINK -> EXACT_DUPLICATE & MANDATORY IDEMPOTENCY KEY)
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
		IF NEW.idempotency_key IS NOT NULL THEN
			RAISE EXCEPTION 'Initial revision (revision_no=1) must have NULL idempotency_key';
		END IF;
	ELSE
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Subsequent revision (revision_no=%) must have non-NULL previous_revision_id', NEW.revision_no;
		END IF;
		IF NEW.idempotency_key IS NULL THEN
			RAISE EXCEPTION 'Mutation revision (revision_no=%) must have non-NULL idempotency_key', NEW.revision_no;
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

	IF NEW.operation = 'APPLY' AND NEW.status NOT IN ('APPLIED', 'EXACT_DUPLICATE') THEN
		RAISE EXCEPTION 'APPLY operation must have status APPLIED or EXACT_DUPLICATE, found %', NEW.status;
	END IF;

	IF NEW.operation = 'LINK' AND NEW.status NOT IN ('LINKED_EXISTING', 'EXACT_DUPLICATE') THEN
		RAISE EXCEPTION 'LINK operation must have status LINKED_EXISTING or EXACT_DUPLICATE, found %', NEW.status;
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
		IF v_prev.status NOT IN ('READY', 'POSSIBLE_DUPLICATE') THEN
			RAISE EXCEPTION 'Cannot LINK import row when current status is % (must be READY or POSSIBLE_DUPLICATE)', v_prev.status;
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
-- 2. HARDEN IDEMPOTENCY RECEIPT DB AUTHORITY & RESULT KIND EXACTNESS TRIGGER
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
		IF v_rev.operation <> 'LINK' OR v_rev.status NOT IN ('LINKED_EXISTING', 'EXACT_DUPLICATE') THEN
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

	-- 5. Result binding & result_kind exactness
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

		IF NEW.operation = 'APPLY' AND v_rev.status = 'APPLIED' AND v_res.result_kind <> 'CREATED' THEN
			RAISE EXCEPTION 'Receipt APPLY + APPLIED requires result_kind CREATED, found %', v_res.result_kind;
		END IF;

		IF NEW.operation = 'APPLY' AND v_rev.status = 'EXACT_DUPLICATE' AND v_res.result_kind <> 'EXACT_DUPLICATE' THEN
			RAISE EXCEPTION 'Receipt APPLY + EXACT_DUPLICATE requires result_kind EXACT_DUPLICATE, found %', v_res.result_kind;
		END IF;

		IF NEW.operation = 'LINK_EXISTING' AND v_rev.status = 'LINKED_EXISTING' AND v_res.result_kind <> 'LINKED_EXISTING' THEN
			RAISE EXCEPTION 'Receipt LINK_EXISTING + LINKED_EXISTING requires result_kind LINKED_EXISTING, found %', v_res.result_kind;
		END IF;

		IF NEW.operation = 'LINK_EXISTING' AND v_rev.status = 'EXACT_DUPLICATE' AND v_res.result_kind <> 'EXACT_DUPLICATE' THEN
			RAISE EXCEPTION 'Receipt LINK_EXISTING + EXACT_DUPLICATE requires result_kind EXACT_DUPLICATE, found %', v_res.result_kind;
		END IF;

		IF NEW.operation = 'RESOLVE_MAPPINGS' AND v_rev.status = 'EXACT_DUPLICATE' AND v_res.result_kind <> 'EXACT_DUPLICATE' THEN
			RAISE EXCEPTION 'Receipt RESOLVE_MAPPINGS + EXACT_DUPLICATE requires result_kind EXACT_DUPLICATE, found %', v_res.result_kind;
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
-- 3. REVISION RECEIPT COMPLETENESS (DEFERRED CONSTRAINT TRIGGER)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revisions_receipt_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_count INTEGER;
BEGIN
	IF NEW.revision_no > 1 THEN
		IF NEW.idempotency_key IS NULL THEN
			RAISE EXCEPTION 'Import row revision % (operation %, revision_no %) requires non-null idempotency_key', NEW.id, NEW.operation, NEW.revision_no;
		END IF;

		SELECT count(*) INTO v_count
		FROM "import_mutation_idempotency_receipts"
		WHERE import_row_revision_id = NEW.id
		  AND idempotency_key = NEW.idempotency_key
		  AND user_id = NEW.user_id;

		IF v_count <> 1 THEN
			RAISE EXCEPTION 'Import row revision % (operation %, revision_no %) requires exactly one matching mutation receipt at commit, found %', NEW.id, NEW.operation, NEW.revision_no, v_count;
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
