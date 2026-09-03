ALTER TABLE "canonical_transactions" DROP CONSTRAINT "canonical_transactions_idempotency_check";--> statement-breakpoint
ALTER TABLE "transaction_revisions" DROP CONSTRAINT "transaction_revisions_idempotency_check";--> statement-breakpoint
ALTER TABLE "transaction_revisions" DROP CONSTRAINT "transaction_revisions_reason_note_check";--> statement-breakpoint
ALTER TABLE "transaction_sources" DROP CONSTRAINT "transaction_sources_ref_check";--> statement-breakpoint
ALTER TABLE "canonical_transactions" ADD CONSTRAINT "canonical_transactions_idempotency_check" CHECK ("canonical_transactions"."creation_idempotency_key" = btrim("canonical_transactions"."creation_idempotency_key") AND length("canonical_transactions"."creation_idempotency_key") BETWEEN 1 AND 128);--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_idempotency_check" CHECK ("transaction_revisions"."idempotency_key" = btrim("transaction_revisions"."idempotency_key") AND length("transaction_revisions"."idempotency_key") BETWEEN 1 AND 128);--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_reason_note_check" CHECK ("transaction_revisions"."reason_note" IS NULL OR ("transaction_revisions"."reason_note" = btrim("transaction_revisions"."reason_note") AND length("transaction_revisions"."reason_note") BETWEEN 1 AND 500));--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_ref_check" CHECK ("transaction_sources"."source_ref" IS NULL OR ("transaction_sources"."source_ref" = btrim("transaction_sources"."source_ref") AND length("transaction_sources"."source_ref") BETWEEN 1 AND 256));--> statement-breakpoint

-- Re-define trg_fn_guard_transaction_revisions_insert with cryptographic & idempotency binding between canonical parent and initial revision
CREATE OR REPLACE FUNCTION trg_fn_guard_transaction_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_parent_id uuid;
	v_parent_user_id uuid;
	v_parent_creation_key varchar(128);
	v_parent_creation_fingerprint varchar(64);
	v_latest_id uuid;
	v_latest_rev_no integer;
	v_latest_op varchar(10);
	v_latest_occurred timestamp with time zone;
	v_latest_payload jsonb;
BEGIN
	-- 1. Lock parent canonical transaction FOR UPDATE to serialize revision appends and fetch creation identity
	SELECT id, user_id, creation_idempotency_key, creation_fingerprint
	INTO v_parent_id, v_parent_user_id, v_parent_creation_key, v_parent_creation_fingerprint
	FROM "canonical_transactions"
	WHERE id = NEW.transaction_id
	FOR UPDATE;

	IF v_parent_id IS NULL THEN
		RAISE EXCEPTION 'Parent canonical transaction % does not exist', NEW.transaction_id;
	END IF;

	IF v_parent_user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Revision user_id % does not match parent transaction user_id %', NEW.user_id, v_parent_user_id;
	END IF;

	-- 2. Inspect latest revision in the linear chain
	SELECT id, revision_no, operation, occurred_at, payload
	INTO v_latest_id, v_latest_rev_no, v_latest_op, v_latest_occurred, v_latest_payload
	FROM "transaction_revisions"
	WHERE transaction_id = NEW.transaction_id
	ORDER BY revision_no DESC
	LIMIT 1;

	-- 3. Enforce first revision invariants & cryptographic/identity binding to canonical parent
	IF v_latest_id IS NULL THEN
		IF NEW.revision_no != 1 THEN
			RAISE EXCEPTION 'First revision must have revision_no = 1 (found %)', NEW.revision_no;
		END IF;

		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have null previous_revision_id';
		END IF;

		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE (found %)', NEW.operation;
		END IF;

		IF NEW.reason_code IS NOT NULL THEN
			RAISE EXCEPTION 'CREATE revision must not have reason_code';
		END IF;

		IF NEW.reason_note IS NOT NULL THEN
			RAISE EXCEPTION 'CREATE revision must not have reason_note';
		END IF;

		IF NEW.idempotency_key != v_parent_creation_key THEN
			RAISE EXCEPTION 'First revision idempotency_key % does not match parent creation_idempotency_key %', NEW.idempotency_key, v_parent_creation_key;
		END IF;

		IF NEW.revision_fingerprint != v_parent_creation_fingerprint THEN
			RAISE EXCEPTION 'First revision revision_fingerprint % does not match parent creation_fingerprint %', NEW.revision_fingerprint, v_parent_creation_fingerprint;
		END IF;

		RETURN NEW;
	END IF;

	-- 4. Enforce subsequent revision invariants
	IF v_latest_op = 'VOID' THEN
		RAISE EXCEPTION 'Cannot append revision after VOID terminal state';
	END IF;

	IF NEW.operation = 'CREATE' THEN
		RAISE EXCEPTION 'CREATE operation is only allowed for the first revision';
	END IF;

	IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest_id THEN
		RAISE EXCEPTION 'previous_revision_id must match latest revision id %', v_latest_id;
	END IF;

	IF NEW.revision_no != v_latest_rev_no + 1 THEN
		RAISE EXCEPTION 'revision_no % is not consecutive successor to latest %', NEW.revision_no, v_latest_rev_no;
	END IF;

	IF NEW.reason_code IS NULL THEN
		RAISE EXCEPTION 'UPDATE and VOID operations require non-null reason_code';
	END IF;

	-- 5. Enforce VOID terminal snapshot invariants
	IF NEW.operation = 'VOID' THEN
		IF NEW.occurred_at != v_latest_occurred THEN
			RAISE EXCEPTION 'VOID revision must preserve latest occurred_at exactly';
		END IF;

		IF NEW.payload != v_latest_payload THEN
			RAISE EXCEPTION 'VOID revision must copy latest payload exactly';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;