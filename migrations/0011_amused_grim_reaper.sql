CREATE TABLE "canonical_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"creation_idempotency_key" varchar(128) NOT NULL,
	"creation_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_transactions_kind_check" CHECK ("canonical_transactions"."kind" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "canonical_transactions_idempotency_check" CHECK (length(trim("canonical_transactions"."creation_idempotency_key")) >= 1 AND length("canonical_transactions"."creation_idempotency_key") <= 128),
	CONSTRAINT "canonical_transactions_fingerprint_check" CHECK ("canonical_transactions"."creation_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "transaction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"reason_code" varchar(64),
	"reason_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_revisions_rev_no_check" CHECK ("transaction_revisions"."revision_no" > 0),
	CONSTRAINT "transaction_revisions_operation_check" CHECK ("transaction_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "transaction_revisions_fingerprint_check" CHECK ("transaction_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transaction_revisions_idempotency_check" CHECK (length(trim("transaction_revisions"."idempotency_key")) >= 1 AND length("transaction_revisions"."idempotency_key") <= 128),
	CONSTRAINT "transaction_revisions_reason_code_check" CHECK ("transaction_revisions"."reason_code" IS NULL OR "transaction_revisions"."reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "transaction_revisions_reason_note_check" CHECK ("transaction_revisions"."reason_note" IS NULL OR length("transaction_revisions"."reason_note") <= 500),
	CONSTRAINT "transaction_revisions_payload_size_check" CHECK (octet_length("transaction_revisions"."payload"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "transaction_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_ref" varchar(256),
	"source_payload_hash" varchar(64),
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_sources_type_check" CHECK ("transaction_sources"."source_type" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "transaction_sources_ref_check" CHECK ("transaction_sources"."source_ref" IS NULL OR (length(trim("transaction_sources"."source_ref")) >= 1 AND length("transaction_sources"."source_ref") <= 256)),
	CONSTRAINT "transaction_sources_hash_check" CHECK ("transaction_sources"."source_payload_hash" IS NULL OR "transaction_sources"."source_payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "canonical_transactions" ADD CONSTRAINT "canonical_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_previous_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_transactions_user_idempotency_idx" ON "canonical_transactions" USING btree ("user_id","creation_idempotency_key");--> statement-breakpoint
CREATE INDEX "canonical_transactions_user_created_idx" ON "canonical_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_revisions_tx_rev_idx" ON "transaction_revisions" USING btree ("transaction_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_revisions_prev_rev_idx" ON "transaction_revisions" USING btree ("previous_revision_id") WHERE "transaction_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_revisions_user_idempotency_idx" ON "transaction_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "transaction_revisions_tx_created_idx" ON "transaction_revisions" USING btree ("transaction_id","created_at");--> statement-breakpoint
CREATE INDEX "transaction_revisions_user_occurred_idx" ON "transaction_revisions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_sources_user_type_ref_idx" ON "transaction_sources" USING btree ("user_id","source_type","source_ref") WHERE "transaction_sources"."source_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transaction_sources_tx_idx" ON "transaction_sources" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_sources_rev_idx" ON "transaction_sources" USING btree ("revision_id");--> statement-breakpoint

-- Custom triggers: Immutability protection and strict revision chain guards

CREATE OR REPLACE FUNCTION trg_fn_protect_canonical_transactions_immutability()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'canonical_transactions rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_canonical_transactions_mutation
BEFORE UPDATE OR DELETE ON "canonical_transactions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_canonical_transactions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_protect_transaction_revisions_immutability()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'transaction_revisions rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_transaction_revisions_mutation
BEFORE UPDATE OR DELETE ON "transaction_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_transaction_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_protect_transaction_sources_immutability()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'transaction_sources rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_transaction_sources_mutation
BEFORE UPDATE OR DELETE ON "transaction_sources"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_transaction_sources_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_transaction_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_parent_id uuid;
	v_parent_user_id uuid;
	v_latest_id uuid;
	v_latest_rev_no integer;
	v_latest_op varchar(10);
	v_latest_occurred timestamp with time zone;
	v_latest_payload jsonb;
BEGIN
	-- 1. Lock parent canonical transaction FOR UPDATE to serialize revision appends
	SELECT id, user_id INTO v_parent_id, v_parent_user_id
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

	-- 3. Enforce first revision invariants
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_transaction_revisions_insert
BEFORE INSERT ON "transaction_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_transaction_revisions_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_transaction_sources_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_rev_id uuid;
	v_rev_user_id uuid;
	v_rev_tx_id uuid;
BEGIN
	SELECT id, user_id, transaction_id INTO v_rev_id, v_rev_user_id, v_rev_tx_id
	FROM "transaction_revisions"
	WHERE id = NEW.revision_id;

	IF v_rev_id IS NULL THEN
		RAISE EXCEPTION 'Referenced revision % does not exist', NEW.revision_id;
	END IF;

	IF v_rev_user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Source user_id % does not match revision user_id %', NEW.user_id, v_rev_user_id;
	END IF;

	IF v_rev_tx_id != NEW.transaction_id THEN
		RAISE EXCEPTION 'Source transaction_id % does not match revision transaction_id %', NEW.transaction_id, v_rev_tx_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_transaction_sources_insert
BEFORE INSERT ON "transaction_sources"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_transaction_sources_insert();