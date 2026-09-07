-- Migration: 0060_seal_canonical_payload_key_presence
-- Supplemental DB-authoritative BEFORE INSERT guards for exact canonical payload key sets and explicit JSON null presence

CREATE OR REPLACE FUNCTION trg_fn_seal_person_obligation_canonical_payload()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_payload JSONB;
	v_key_count INT;
	v_expected_keys TEXT[];
	v_k TEXT;
BEGIN
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
	END IF;

	v_payload := v_can_rev.payload;

	IF COALESCE(jsonb_typeof(v_payload), '') != 'object' THEN
		RAISE EXCEPTION 'Canonical revision payload must be a JSON object';
	END IF;

	IF v_can_tx.kind = 'PERSON_RECEIVABLE_ADVANCE' THEN
		v_expected_keys := ARRAY['obligationId', 'personId', 'direction', 'amount', 'fundingAssetAccountId', 'dueDate', 'description'];
	ELSIF v_can_tx.kind = 'PERSON_PAYABLE_EXPENSE' THEN
		v_expected_keys := ARRAY['obligationId', 'personId', 'direction', 'amount', 'budgetCategory', 'dueDate', 'description'];
	ELSIF v_can_tx.kind = 'CREDIT_CARD_PURCHASE_SPLIT' THEN
		v_expected_keys := ARRAY['obligationId', 'splitId', 'splitRevisionId', 'splitParticipantId', 'purchaseEventId', 'personId', 'direction', 'amount', 'expenseAccountId', 'dueDate', 'description'];
	ELSE
		RAISE EXCEPTION 'Unsupported canonical transaction kind % for person obligation revision', v_can_tx.kind;
	END IF;

	-- Exact key presence and count
	SELECT count(*) INTO v_key_count FROM jsonb_object_keys(v_payload);
	IF v_key_count != array_length(v_expected_keys, 1) THEN
		RAISE EXCEPTION 'Canonical payload for % must contain exactly % keys, found %',
			v_can_tx.kind, array_length(v_expected_keys, 1), v_key_count;
	END IF;

	FOREACH v_k IN ARRAY v_expected_keys LOOP
		IF NOT (v_payload ? v_k) THEN
			RAISE EXCEPTION 'Canonical payload for % missing required key %', v_can_tx.kind, v_k;
		END IF;
	END LOOP;

	-- Nullable value semantics: dueDate
	IF NEW.due_date IS NULL THEN
		IF jsonb_typeof(v_payload->'dueDate') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload dueDate must be explicit JSON null when due_date is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_payload->'dueDate') != 'string' OR v_payload->>'dueDate' != NEW.due_date::text THEN
			RAISE EXCEPTION 'Canonical payload dueDate % does not match revision due_date %',
				v_payload->>'dueDate', NEW.due_date;
		END IF;
	END IF;

	-- Nullable value semantics: description
	IF NEW.description IS NULL THEN
		IF jsonb_typeof(v_payload->'description') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload description must be explicit JSON null when description is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_payload->'description') != 'string' OR v_payload->>'description' != NEW.description THEN
			RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
				v_payload->>'description', NEW.description;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_seal_person_obligation_canonical_payload ON "person_obligation_revisions";
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_a_seal_person_obligation_canonical_payload ON "person_obligation_revisions";
--> statement-breakpoint

CREATE TRIGGER trg_a_seal_person_obligation_canonical_payload
BEFORE INSERT ON "person_obligation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_seal_person_obligation_canonical_payload();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_seal_person_settlement_canonical_payload()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_payload JSONB;
	v_key_count INT;
	v_expected_keys TEXT[];
	v_k TEXT;
BEGIN
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
	END IF;

	v_payload := v_can_rev.payload;

	IF COALESCE(jsonb_typeof(v_payload), '') != 'object' THEN
		RAISE EXCEPTION 'Canonical revision payload must be a JSON object';
	END IF;

	IF v_can_tx.kind != 'PERSON_OBLIGATION_SETTLEMENT' THEN
		RAISE EXCEPTION 'Canonical transaction kind must be PERSON_OBLIGATION_SETTLEMENT, found %', v_can_tx.kind;
	END IF;

	v_expected_keys := ARRAY['settlementId', 'obligationId', 'personId', 'direction', 'appliedAmount', 'cashAmount', 'excessAmount', 'assetAccountId', 'note'];

	SELECT count(*) INTO v_key_count FROM jsonb_object_keys(v_payload);
	IF v_key_count != array_length(v_expected_keys, 1) THEN
		RAISE EXCEPTION 'Canonical payload for PERSON_OBLIGATION_SETTLEMENT must contain exactly % keys, found %',
			array_length(v_expected_keys, 1), v_key_count;
	END IF;

	FOREACH v_k IN ARRAY v_expected_keys LOOP
		IF NOT (v_payload ? v_k) THEN
			RAISE EXCEPTION 'Canonical payload for PERSON_OBLIGATION_SETTLEMENT missing required key %', v_k;
		END IF;
	END LOOP;

	-- Nullable value semantics: note
	IF NEW.note IS NULL THEN
		IF jsonb_typeof(v_payload->'note') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload note must be explicit JSON null when note is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_payload->'note') != 'string' OR v_payload->>'note' != NEW.note THEN
			RAISE EXCEPTION 'Canonical payload note % does not match revision note %',
				v_payload->>'note', NEW.note;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_seal_person_settlement_canonical_payload ON "person_settlement_revisions";
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_a_seal_person_settlement_canonical_payload ON "person_settlement_revisions";
--> statement-breakpoint

CREATE TRIGGER trg_a_seal_person_settlement_canonical_payload
BEFORE INSERT ON "person_settlement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_seal_person_settlement_canonical_payload();
