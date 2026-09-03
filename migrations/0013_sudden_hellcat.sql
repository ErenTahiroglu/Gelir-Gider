CREATE TABLE "transaction_ledger_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"previous_binding_id" uuid,
	"applied_journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_ledger_bindings_distinct_check" CHECK ("transaction_ledger_bindings"."applied_journal_entry_id" IS NULL OR "transaction_ledger_bindings"."reversal_journal_entry_id" IS NULL OR "transaction_ledger_bindings"."applied_journal_entry_id" != "transaction_ledger_bindings"."reversal_journal_entry_id")
);
--> statement-breakpoint
ALTER TABLE "transaction_ledger_bindings" ADD CONSTRAINT "transaction_ledger_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_bindings" ADD CONSTRAINT "transaction_ledger_bindings_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_bindings" ADD CONSTRAINT "transaction_ledger_bindings_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_bindings" ADD CONSTRAINT "transaction_ledger_bindings_previous_binding_id_transaction_ledger_bindings_id_fk" FOREIGN KEY ("previous_binding_id") REFERENCES "public"."transaction_ledger_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_bindings" ADD CONSTRAINT "transaction_ledger_bindings_applied_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("applied_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_bindings" ADD CONSTRAINT "transaction_ledger_bindings_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_ledger_bindings_rev_idx" ON "transaction_ledger_bindings" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_ledger_bindings_prev_idx" ON "transaction_ledger_bindings" USING btree ("previous_binding_id") WHERE "transaction_ledger_bindings"."previous_binding_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_ledger_bindings_applied_idx" ON "transaction_ledger_bindings" USING btree ("applied_journal_entry_id") WHERE "transaction_ledger_bindings"."applied_journal_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_ledger_bindings_reversal_idx" ON "transaction_ledger_bindings" USING btree ("reversal_journal_entry_id") WHERE "transaction_ledger_bindings"."reversal_journal_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transaction_ledger_bindings_tx_idx" ON "transaction_ledger_bindings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_ledger_bindings_user_idx" ON "transaction_ledger_bindings" USING btree ("user_id");--> statement-breakpoint

-- Custom triggers: Immutability protection and strict ledger binding guards

CREATE OR REPLACE FUNCTION trg_fn_protect_transaction_ledger_bindings_immutability()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'transaction_ledger_bindings rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_transaction_ledger_bindings_mutation
BEFORE UPDATE OR DELETE ON "transaction_ledger_bindings"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_transaction_ledger_bindings_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_transaction_ledger_bindings_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_rev_id uuid;
	v_rev_user_id uuid;
	v_rev_tx_id uuid;
	v_rev_no integer;
	v_rev_prev_id uuid;
	v_rev_op varchar(10);
	v_rev_occurred timestamp with time zone;
	v_prev_b_id uuid;
	v_prev_b_applied_j_id uuid;
	v_prev_b_user_id uuid;
	v_prev_b_tx_id uuid;
	v_app_j_id uuid;
	v_app_j_user uuid;
	v_app_j_status varchar(20);
	v_app_j_rev_of uuid;
	v_app_j_occurred timestamp with time zone;
	v_app_j_src_type varchar(64);
	v_app_j_src_ref varchar(128);
	v_app_j_idem_key varchar(128);
	v_rev_j_id uuid;
	v_rev_j_user uuid;
	v_rev_j_status varchar(20);
	v_rev_j_rev_of uuid;
	v_rev_j_occurred timestamp with time zone;
	v_rev_j_src_type varchar(64);
	v_rev_j_src_ref varchar(128);
	v_rev_j_idem_key varchar(128);
	v_prev_app_j_occurred timestamp with time zone;
BEGIN
	-- 1. Fetch owning revision
	SELECT id, user_id, transaction_id, revision_no, previous_revision_id, operation, occurred_at
	INTO v_rev_id, v_rev_user_id, v_rev_tx_id, v_rev_no, v_rev_prev_id, v_rev_op, v_rev_occurred
	FROM "transaction_revisions"
	WHERE id = NEW.revision_id;

	IF v_rev_id IS NULL THEN
		RAISE EXCEPTION 'Referenced transaction revision % does not exist', NEW.revision_id;
	END IF;

	IF NEW.user_id != v_rev_user_id THEN
		RAISE EXCEPTION 'Binding user_id % does not match revision user_id %', NEW.user_id, v_rev_user_id;
	END IF;

	IF NEW.transaction_id != v_rev_tx_id THEN
		RAISE EXCEPTION 'Binding transaction_id % does not match revision transaction_id %', NEW.transaction_id, v_rev_tx_id;
	END IF;

	-- 2. Verify binding shape by operation
	IF v_rev_op = 'CREATE' THEN
		IF v_rev_no != 1 THEN
			RAISE EXCEPTION 'CREATE binding must reference revision_no 1 (found %)', v_rev_no;
		END IF;
		IF NEW.previous_binding_id IS NOT NULL THEN
			RAISE EXCEPTION 'CREATE binding must have null previous_binding_id';
		END IF;
		IF NEW.reversal_journal_entry_id IS NOT NULL THEN
			RAISE EXCEPTION 'CREATE binding must not have reversal_journal_entry_id';
		END IF;
		IF NEW.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'CREATE binding requires applied_journal_entry_id';
		END IF;
	ELSIF v_rev_op = 'UPDATE' THEN
		IF NEW.previous_binding_id IS NULL THEN
			RAISE EXCEPTION 'UPDATE binding requires previous_binding_id';
		END IF;
		IF NEW.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'UPDATE binding requires reversal_journal_entry_id';
		END IF;
		IF NEW.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'UPDATE binding requires applied_journal_entry_id';
		END IF;
	ELSIF v_rev_op = 'VOID' THEN
		IF NEW.previous_binding_id IS NULL THEN
			RAISE EXCEPTION 'VOID binding requires previous_binding_id';
		END IF;
		IF NEW.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'VOID binding requires reversal_journal_entry_id';
		END IF;
		IF NEW.applied_journal_entry_id IS NOT NULL THEN
			RAISE EXCEPTION 'VOID binding must not have applied_journal_entry_id';
		END IF;
	ELSE
		RAISE EXCEPTION 'Unsupported revision operation % for ledger binding', v_rev_op;
	END IF;

	-- 3. Verify binding chain consistency for UPDATE / VOID
	IF v_rev_prev_id IS NOT NULL THEN
		SELECT id, applied_journal_entry_id, user_id, transaction_id
		INTO v_prev_b_id, v_prev_b_applied_j_id, v_prev_b_user_id, v_prev_b_tx_id
		FROM "transaction_ledger_bindings"
		WHERE revision_id = v_rev_prev_id;

		IF v_prev_b_id IS NULL THEN
			RAISE EXCEPTION 'Previous revision % has no ledger binding', v_rev_prev_id;
		END IF;

		IF NEW.previous_binding_id != v_prev_b_id THEN
			RAISE EXCEPTION 'previous_binding_id % must match previous revision binding id %', NEW.previous_binding_id, v_prev_b_id;
		END IF;

		IF v_prev_b_applied_j_id IS NULL THEN
			RAISE EXCEPTION 'Previous binding % has no active applied journal entry to reverse', v_prev_b_id;
		END IF;
	END IF;

	-- 4. Validate applied journal entry if present
	IF NEW.applied_journal_entry_id IS NOT NULL THEN
		SELECT id, user_id, status, reversal_of_entry_id, occurred_at, source_type, source_ref, idempotency_key
		INTO v_app_j_id, v_app_j_user, v_app_j_status, v_app_j_rev_of, v_app_j_occurred, v_app_j_src_type, v_app_j_src_ref, v_app_j_idem_key
		FROM "journal_entries"
		WHERE id = NEW.applied_journal_entry_id;

		IF v_app_j_id IS NULL THEN
			RAISE EXCEPTION 'Applied journal entry % does not exist', NEW.applied_journal_entry_id;
		END IF;

		IF v_app_j_user != NEW.user_id THEN
			RAISE EXCEPTION 'Applied journal entry user % does not match binding user %', v_app_j_user, NEW.user_id;
		END IF;

		IF v_app_j_status != 'POSTED' THEN
			RAISE EXCEPTION 'Applied journal entry must be POSTED (found %)', v_app_j_status;
		END IF;

		IF v_app_j_rev_of IS NOT NULL THEN
			RAISE EXCEPTION 'Applied journal entry cannot be a reversal journal';
		END IF;

		IF v_app_j_occurred != v_rev_occurred THEN
			RAISE EXCEPTION 'Applied journal occurred_at % does not match revision occurred_at %', v_app_j_occurred, v_rev_occurred;
		END IF;

		IF v_app_j_src_type != 'CANONICAL_REVISION' OR v_app_j_src_ref != NEW.revision_id::text THEN
			RAISE EXCEPTION 'Applied journal source must be CANONICAL_REVISION with ref %', NEW.revision_id;
		END IF;

		IF v_app_j_idem_key != ('txrev:' || NEW.revision_id::text || ':apply') THEN
			RAISE EXCEPTION 'Applied journal idempotency key must be txrev:%:apply', NEW.revision_id;
		END IF;
	END IF;

	-- 5. Validate reversal journal entry if present
	IF NEW.reversal_journal_entry_id IS NOT NULL THEN
		SELECT id, user_id, status, reversal_of_entry_id, occurred_at, source_type, source_ref, idempotency_key
		INTO v_rev_j_id, v_rev_j_user, v_rev_j_status, v_rev_j_rev_of, v_rev_j_occurred, v_rev_j_src_type, v_rev_j_src_ref, v_rev_j_idem_key
		FROM "journal_entries"
		WHERE id = NEW.reversal_journal_entry_id;

		IF v_rev_j_id IS NULL THEN
			RAISE EXCEPTION 'Reversal journal entry % does not exist', NEW.reversal_journal_entry_id;
		END IF;

		IF v_rev_j_user != NEW.user_id THEN
			RAISE EXCEPTION 'Reversal journal entry user % does not match binding user %', v_rev_j_user, NEW.user_id;
		END IF;

		IF v_rev_j_status != 'POSTED' THEN
			RAISE EXCEPTION 'Reversal journal entry must be POSTED (found %)', v_rev_j_status;
		END IF;

		IF v_rev_j_rev_of IS NULL OR v_rev_j_rev_of != v_prev_b_applied_j_id THEN
			RAISE EXCEPTION 'Reversal journal must reverse previous applied journal %', v_prev_b_applied_j_id;
		END IF;

		-- Fetch previous applied journal to check economic date match
		SELECT occurred_at INTO v_prev_app_j_occurred
		FROM "journal_entries"
		WHERE id = v_prev_b_applied_j_id;

		IF v_rev_j_occurred != v_prev_app_j_occurred THEN
			RAISE EXCEPTION 'Reversal journal occurred_at % must match previous applied journal occurred_at %', v_rev_j_occurred, v_prev_app_j_occurred;
		END IF;

		IF v_rev_j_src_type != 'REVERSAL' OR v_rev_j_src_ref != v_prev_b_applied_j_id::text THEN
			RAISE EXCEPTION 'Reversal journal source must be REVERSAL with ref %', v_prev_b_applied_j_id;
		END IF;

		IF v_rev_j_idem_key != ('txrev:' || NEW.revision_id::text || ':reverse') THEN
			RAISE EXCEPTION 'Reversal journal idempotency key must be txrev:%:reverse', NEW.revision_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_transaction_ledger_bindings_insert
BEFORE INSERT ON "transaction_ledger_bindings"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_transaction_ledger_bindings_insert();