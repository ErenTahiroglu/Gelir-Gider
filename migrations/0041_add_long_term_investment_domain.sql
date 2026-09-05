CREATE TABLE "long_term_send_task_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"destination_label" varchar(120),
	"note" varchar(500),
	"reason_note" varchar(500),
	"midas_allocation_transfer_id" uuid NOT NULL,
	"canonical_revision_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_term_task_revisions_rev_no_check" CHECK ("long_term_send_task_revisions"."revision_no" > 0),
	CONSTRAINT "long_term_task_revisions_op_check" CHECK ("long_term_send_task_revisions"."operation" IN ('CREATE', 'SENT', 'REOPEN', 'CANCEL')),
	CONSTRAINT "long_term_task_revisions_status_check" CHECK ("long_term_send_task_revisions"."status" IN ('PENDING', 'SENT', 'CANCELLED')),
	CONSTRAINT "long_term_task_revisions_amount_check" CHECK ("long_term_send_task_revisions"."amount" > 0),
	CONSTRAINT "long_term_task_revisions_destination_label_check" CHECK ("long_term_send_task_revisions"."destination_label" IS NULL OR ("long_term_send_task_revisions"."destination_label" = btrim("long_term_send_task_revisions"."destination_label") AND length("long_term_send_task_revisions"."destination_label") >= 1 AND length("long_term_send_task_revisions"."destination_label") <= 120)),
	CONSTRAINT "long_term_task_revisions_note_check" CHECK ("long_term_send_task_revisions"."note" IS NULL OR ("long_term_send_task_revisions"."note" = btrim("long_term_send_task_revisions"."note") AND length("long_term_send_task_revisions"."note") >= 1 AND length("long_term_send_task_revisions"."note") <= 500)),
	CONSTRAINT "long_term_task_revisions_reason_note_check" CHECK ("long_term_send_task_revisions"."reason_note" IS NULL OR ("long_term_send_task_revisions"."reason_note" = btrim("long_term_send_task_revisions"."reason_note") AND length("long_term_send_task_revisions"."reason_note") >= 1 AND length("long_term_send_task_revisions"."reason_note") <= 500)),
	CONSTRAINT "long_term_task_revisions_fingerprint_check" CHECK ("long_term_send_task_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "long_term_task_revisions_idempotency_check" CHECK ("long_term_send_task_revisions"."idempotency_key" = btrim("long_term_send_task_revisions"."idempotency_key") AND length("long_term_send_task_revisions"."idempotency_key") >= 1 AND length("long_term_send_task_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "long_term_send_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"midas_account_id" uuid NOT NULL,
	"pending_bucket_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "long_term_send_task_revisions" ADD CONSTRAINT "long_term_send_task_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_task_revisions" ADD CONSTRAINT "long_term_send_task_revisions_task_id_long_term_send_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."long_term_send_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_task_revisions" ADD CONSTRAINT "long_term_send_task_revisions_previous_revision_id_long_term_send_task_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."long_term_send_task_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_task_revisions" ADD CONSTRAINT "long_term_send_task_revisions_midas_allocation_transfer_id_midas_allocation_transfers_id_fk" FOREIGN KEY ("midas_allocation_transfer_id") REFERENCES "public"."midas_allocation_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_task_revisions" ADD CONSTRAINT "long_term_send_task_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_tasks" ADD CONSTRAINT "long_term_send_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_tasks" ADD CONSTRAINT "long_term_send_tasks_midas_account_id_midas_accounts_id_fk" FOREIGN KEY ("midas_account_id") REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_term_send_tasks" ADD CONSTRAINT "long_term_send_tasks_pending_bucket_id_midas_buckets_id_fk" FOREIGN KEY ("pending_bucket_id") REFERENCES "public"."midas_buckets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "long_term_task_revisions_task_rev_idx" ON "long_term_send_task_revisions" USING btree ("task_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "long_term_task_revisions_user_idempotency_idx" ON "long_term_send_task_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "long_term_task_revisions_prev_rev_idx" ON "long_term_send_task_revisions" USING btree ("previous_revision_id") WHERE "long_term_send_task_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "long_term_task_revisions_transfer_idx" ON "long_term_send_task_revisions" USING btree ("midas_allocation_transfer_id");--> statement-breakpoint
CREATE INDEX "long_term_task_revisions_task_idx" ON "long_term_send_task_revisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "long_term_task_revisions_user_idx" ON "long_term_send_task_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "long_term_send_tasks_user_idx" ON "long_term_send_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "long_term_send_tasks_account_idx" ON "long_term_send_tasks" USING btree ("midas_account_id");--> statement-breakpoint
CREATE INDEX "long_term_send_tasks_bucket_idx" ON "long_term_send_tasks" USING btree ("pending_bucket_id");--> statement-breakpoint

-- ============================================================================
-- PHASE 13: LONG-TERM INVESTMENT SEND TASK DOMAIN INTEGRITY
--
-- A. Immutability (INSERT-only) on both new tables.
-- B. Task revision chain + status transition table + amount/context
--    immutability + exact Midas allocation transfer companion binding +
--    exact canonical SEND payload/ledger binding + exact REOPEN VOID
--    binding (BEFORE INSERT).
-- C. Anchor completeness (naked task anchor rejected at commit).
-- D. Generic Midas guard: any transfer touching a PENDING_LONG_TERM bucket
--    must resolve to exactly one companion task revision.
-- E. Pending-bucket <-> PENDING task-sum reconciliation (deferred,
--    order-independent, retriggered from both companion tables).
-- F. Canonical LONG_TERM_INVESTMENT_SEND anchor completeness (no orphan
--    canonical send without a companion task SENT revision).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_long_term()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is immutable (INSERT-only)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_long_term_send_tasks ON "long_term_send_tasks";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_long_term_send_tasks
BEFORE UPDATE OR DELETE ON "long_term_send_tasks"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_long_term();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_long_term_send_task_revisions ON "long_term_send_task_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_long_term_send_task_revisions
BEFORE UPDATE OR DELETE ON "long_term_send_task_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_long_term();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. TASK REVISION CHAIN + TRANSITIONS + COMPANION + CANONICAL/LEDGER BINDING
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_long_term_task_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_task RECORD;
	v_midas_account RECORD;
	v_pending_bucket RECORD;
	v_latest RECORD;
	v_create RECORD;
	v_transfer RECORD;
	v_expected_from UUID;
	v_expected_to UUID;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_user_currency TEXT;
	v_external_account RECORD;
	v_midas_ledger_account_id UUID;
	v_midas_account_ledger RECORD;
	v_line_count INT;
	v_debit_line RECORD;
	v_credit_line RECORD;
	v_void_rev RECORD;
	v_prev_can_rev RECORD;
BEGIN
	SELECT * INTO v_task FROM long_term_send_tasks WHERE id = NEW.task_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Long-term send task % not found', NEW.task_id;
	END IF;
	IF v_task.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Long-term send task user_id % does not match revision user_id %', v_task.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_midas_account FROM midas_accounts WHERE id = v_task.midas_account_id;
	IF NOT FOUND OR v_midas_account.user_id != v_task.user_id THEN
		RAISE EXCEPTION 'Long-term send task % Midas account % does not belong to the same user', NEW.task_id, v_task.midas_account_id;
	END IF;

	SELECT * INTO v_pending_bucket FROM midas_buckets WHERE id = v_task.pending_bucket_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Long-term send task % pending bucket % not found', NEW.task_id, v_task.pending_bucket_id;
	END IF;
	IF v_pending_bucket.user_id != v_task.user_id OR v_pending_bucket.midas_account_id != v_task.midas_account_id THEN
		RAISE EXCEPTION 'Long-term send task % pending bucket % does not belong to the same user/Midas account', NEW.task_id, v_task.pending_bucket_id;
	END IF;
	IF v_pending_bucket.bucket_type != 'PENDING_LONG_TERM' THEN
		RAISE EXCEPTION 'Long-term send task % pending bucket % has wrong bucket_type %', NEW.task_id, v_task.pending_bucket_id, v_pending_bucket.bucket_type;
	END IF;

	-- Chain integrity + transition table.
	SELECT id, revision_no, operation, status, amount, destination_label, note, canonical_revision_id
	INTO v_latest
	FROM long_term_send_task_revisions
	WHERE task_id = NEW.task_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Long-term send task % already has revisions; revision 1 cannot be created again', NEW.task_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'PENDING' THEN
			RAISE EXCEPTION 'First revision must have status PENDING, found %', NEW.status;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for long-term send task %', NEW.task_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of long-term send task % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.task_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;

		IF v_latest.status = 'CANCELLED' THEN
			RAISE EXCEPTION 'Cannot create revision on CANCELLED long-term send task % (CANCELLED is terminal)', NEW.task_id;
		ELSIF v_latest.status = 'PENDING' THEN
			IF NEW.operation = 'SENT' THEN
				IF NEW.status != 'SENT' THEN
					RAISE EXCEPTION 'SENT operation must set status SENT, found %', NEW.status;
				END IF;
			ELSIF NEW.operation = 'CANCEL' THEN
				IF NEW.status != 'CANCELLED' THEN
					RAISE EXCEPTION 'CANCEL operation must set status CANCELLED, found %', NEW.status;
				END IF;
			ELSE
				RAISE EXCEPTION 'From PENDING status, only SENT or CANCEL are valid operations, found %', NEW.operation;
			END IF;
		ELSIF v_latest.status = 'SENT' THEN
			IF NEW.operation != 'REOPEN' THEN
				RAISE EXCEPTION 'From SENT status, only REOPEN is a valid operation, found %', NEW.operation;
			END IF;
			IF NEW.status != 'PENDING' THEN
				RAISE EXCEPTION 'REOPEN operation must set status PENDING, found %', NEW.status;
			END IF;
		ELSE
			RAISE EXCEPTION 'Unexpected predecessor status % for long-term send task %', v_latest.status, NEW.task_id;
		END IF;
	END IF;

	-- Amount and immutable context snapshot (destinationLabel/note) must copy
	-- forward exactly from the CREATE revision across the entire lifecycle.
	SELECT amount, destination_label, note INTO v_create
	FROM long_term_send_task_revisions
	WHERE task_id = NEW.task_id AND revision_no = 1;

	IF v_create.amount IS NOT NULL THEN
		IF NEW.amount != v_create.amount THEN
			RAISE EXCEPTION 'Task amount is immutable: expected %, found %', v_create.amount, NEW.amount;
		END IF;
		IF NEW.destination_label IS DISTINCT FROM v_create.destination_label THEN
			RAISE EXCEPTION 'Task destinationLabel is immutable and must copy forward exactly from CREATE';
		END IF;
		IF NEW.note IS DISTINCT FROM v_create.note THEN
			RAISE EXCEPTION 'Task note is immutable and must copy forward exactly from CREATE';
		END IF;
	END IF;

	-- Exact Midas allocation transfer companion binding (Section 7/8).
	SELECT * INTO v_transfer FROM midas_allocation_transfers WHERE id = NEW.midas_allocation_transfer_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Companion Midas allocation transfer % not found', NEW.midas_allocation_transfer_id;
	END IF;
	IF v_transfer.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Companion transfer user_id % does not match task revision user_id %', v_transfer.user_id, NEW.user_id;
	END IF;
	IF v_transfer.midas_account_id != v_task.midas_account_id THEN
		RAISE EXCEPTION 'Companion transfer midas_account_id % does not match task midas_account_id %', v_transfer.midas_account_id, v_task.midas_account_id;
	END IF;
	IF v_transfer.amount != NEW.amount THEN
		RAISE EXCEPTION 'Companion transfer amount % does not match task revision amount %', v_transfer.amount, NEW.amount;
	END IF;

	IF NEW.operation IN ('CREATE', 'REOPEN') THEN
		v_expected_from := NULL;
		v_expected_to := v_task.pending_bucket_id;
	ELSE
		v_expected_from := v_task.pending_bucket_id;
		v_expected_to := NULL;
	END IF;

	IF v_transfer.from_bucket_id IS DISTINCT FROM v_expected_from THEN
		RAISE EXCEPTION 'Companion transfer % from_bucket_id % does not match expected % for operation %',
			v_transfer.id, v_transfer.from_bucket_id, v_expected_from, NEW.operation;
	END IF;
	IF v_transfer.to_bucket_id IS DISTINCT FROM v_expected_to THEN
		RAISE EXCEPTION 'Companion transfer % to_bucket_id % does not match expected % for operation %',
			v_transfer.id, v_transfer.to_bucket_id, v_expected_to, NEW.operation;
	END IF;

	-- canonical_revision_id NULL/NOT NULL per operation, and exact bindings.
	IF NEW.operation IN ('CREATE', 'CANCEL') THEN
		IF NEW.canonical_revision_id IS NOT NULL THEN
			RAISE EXCEPTION '% revision must have canonical_revision_id NULL', NEW.operation;
		END IF;
	ELSIF NEW.operation = 'SENT' THEN
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'SENT revision requires canonical_revision_id';
		END IF;

		SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_can_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical revision user_id % does not match task revision user_id %', v_can_rev.user_id, NEW.user_id;
		END IF;
		IF v_can_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'SENT canonical revision must have operation CREATE, found %', v_can_rev.operation;
		END IF;
		IF v_can_rev.occurred_at != NEW.occurred_at THEN
			RAISE EXCEPTION 'Canonical revision occurred_at % does not match task revision occurred_at %', v_can_rev.occurred_at, NEW.occurred_at;
		END IF;

		SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
		END IF;
		IF v_can_tx.kind != 'LONG_TERM_INVESTMENT_SEND' THEN
			RAISE EXCEPTION 'SENT canonical transaction % has wrong kind %', v_can_tx.id, v_can_tx.kind;
		END IF;

		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('taskId', 'midasAccountId', 'pendingBucketId', 'amount', 'destinationLabel', 'note')
		LIMIT 1;
		IF v_invalid_key IS NOT NULL THEN
			RAISE EXCEPTION 'Unexpected key % in LONG_TERM_INVESTMENT_SEND canonical payload', v_invalid_key;
		END IF;

		IF jsonb_typeof(v_can_rev.payload->'taskId') != 'string' OR v_can_rev.payload->>'taskId' != NEW.task_id::text THEN
			RAISE EXCEPTION 'Canonical payload taskId % does not match task %', v_can_rev.payload->>'taskId', NEW.task_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'midasAccountId') != 'string' OR v_can_rev.payload->>'midasAccountId' != v_task.midas_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload midasAccountId % does not match task Midas account %', v_can_rev.payload->>'midasAccountId', v_task.midas_account_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'pendingBucketId') != 'string' OR v_can_rev.payload->>'pendingBucketId' != v_task.pending_bucket_id::text THEN
			RAISE EXCEPTION 'Canonical payload pendingBucketId % does not match task pending bucket %', v_can_rev.payload->>'pendingBucketId', v_task.pending_bucket_id;
		END IF;
		IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR v_can_rev.payload->>'amount' != NEW.amount::text THEN
			RAISE EXCEPTION 'Canonical payload amount % does not match revision amount %', v_can_rev.payload->>'amount', NEW.amount;
		END IF;

		IF NEW.destination_label IS NULL THEN
			IF v_can_rev.payload->'destinationLabel' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'destinationLabel') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload destinationLabel must be null when revision destination_label is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'destinationLabel') != 'string' OR v_can_rev.payload->>'destinationLabel' != NEW.destination_label THEN
				RAISE EXCEPTION 'Canonical payload destinationLabel % does not match revision destination_label %', v_can_rev.payload->>'destinationLabel', NEW.destination_label;
			END IF;
		END IF;

		IF NEW.note IS NULL THEN
			IF v_can_rev.payload->'note' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'note') != 'null' THEN
				RAISE EXCEPTION 'Canonical payload note must be null when revision note is null';
			END IF;
		ELSE
			IF jsonb_typeof(v_can_rev.payload->'note') != 'string' OR v_can_rev.payload->>'note' != NEW.note THEN
				RAISE EXCEPTION 'Canonical payload note % does not match revision note %', v_can_rev.payload->>'note', NEW.note;
			END IF;
		END IF;

		-- Exact 2-line ledger binding: Dr SYS_LONG_TERM_EXTERNAL_COST, Cr the
		-- Midas account's linked physical ASSET account, both for exactly
		-- the task amount. Both account contracts are independently
		-- validated, not merely resolved by code/id lookup.
		SELECT u.currency INTO v_user_currency FROM users u WHERE u.id = NEW.user_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'User % not found', NEW.user_id;
		END IF;

		SELECT * INTO v_external_account FROM ledger_accounts WHERE user_id = NEW.user_id AND code = 'SYS_LONG_TERM_EXTERNAL_COST';
		IF NOT FOUND THEN
			RAISE EXCEPTION 'No SYS_LONG_TERM_EXTERNAL_COST account provisioned (user %)', NEW.user_id;
		END IF;
		IF v_external_account.account_type != 'ASSET' OR v_external_account.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % is not a valid ASSET/DEBIT account (type %, normal_balance %)',
				v_external_account.id, v_external_account.account_type, v_external_account.normal_balance;
		END IF;
		IF v_external_account.currency != v_user_currency THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % currency % does not match user currency %',
				v_external_account.id, v_external_account.currency, v_user_currency;
		END IF;
		IF v_external_account.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'SYS_LONG_TERM_EXTERNAL_COST account % is archived', v_external_account.id;
		END IF;

		v_midas_ledger_account_id := v_midas_account.ledger_account_id;
		SELECT * INTO v_midas_account_ledger FROM ledger_accounts WHERE id = v_midas_ledger_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Midas linked ledger account % not found', v_midas_ledger_account_id;
		END IF;
		IF v_midas_account_ledger.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Midas linked ledger account % does not belong to user %', v_midas_ledger_account_id, NEW.user_id;
		END IF;
		IF v_midas_account_ledger.account_type != 'ASSET' OR v_midas_account_ledger.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'Midas linked ledger account % is not a valid ASSET/DEBIT account (type %, normal_balance %)',
				v_midas_account_ledger.id, v_midas_account_ledger.account_type, v_midas_account_ledger.normal_balance;
		END IF;
		IF v_midas_account_ledger.currency != v_user_currency THEN
			RAISE EXCEPTION 'Midas linked ledger account % currency % does not match user currency %',
				v_midas_account_ledger.id, v_midas_account_ledger.currency, v_user_currency;
		END IF;
		IF v_midas_account_ledger.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'Midas linked ledger account % is archived', v_midas_account_ledger.id;
		END IF;

		SELECT count(*) INTO v_line_count
		FROM transaction_ledger_bindings tlb
		JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
		WHERE tlb.revision_id = NEW.canonical_revision_id;

		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Long-term send task % applied journal must have exactly 2 lines, found %', NEW.task_id, v_line_count;
		END IF;

		SELECT jl.* INTO v_debit_line
		FROM transaction_ledger_bindings tlb
		JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
		WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.debit > 0;

		SELECT jl.* INTO v_credit_line
		FROM transaction_ledger_bindings tlb
		JOIN journal_lines jl ON jl.journal_entry_id = tlb.applied_journal_entry_id
		WHERE tlb.revision_id = NEW.canonical_revision_id AND jl.credit > 0;

		IF v_debit_line IS NULL OR v_credit_line IS NULL THEN
			RAISE EXCEPTION 'Long-term send task % applied journal must have exactly one debit line and one credit line', NEW.task_id;
		END IF;
		IF v_debit_line.account_id != v_external_account.id THEN
			RAISE EXCEPTION 'Long-term send task % debit line account % is not SYS_LONG_TERM_EXTERNAL_COST %',
				NEW.task_id, v_debit_line.account_id, v_external_account.id;
		END IF;
		IF v_credit_line.account_id != v_midas_ledger_account_id THEN
			RAISE EXCEPTION 'Long-term send task % credit line account % is not the Midas linked physical account %',
				NEW.task_id, v_credit_line.account_id, v_midas_ledger_account_id;
		END IF;
		IF v_debit_line.debit != NEW.amount THEN
			RAISE EXCEPTION 'Long-term send task % debit amount % does not match task amount %', NEW.task_id, v_debit_line.debit, NEW.amount;
		END IF;
		IF v_credit_line.credit != NEW.amount THEN
			RAISE EXCEPTION 'Long-term send task % credit amount % does not match task amount %', NEW.task_id, v_credit_line.credit, NEW.amount;
		END IF;
	ELSIF NEW.operation = 'REOPEN' THEN
		IF NEW.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'REOPEN revision requires canonical_revision_id (the exact VOID of the preceding SENT)';
		END IF;

		SELECT * INTO v_void_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical VOID revision % not found', NEW.canonical_revision_id;
		END IF;
		IF v_void_rev.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Canonical VOID revision user_id % does not match task revision user_id %', v_void_rev.user_id, NEW.user_id;
		END IF;
		IF v_void_rev.operation != 'VOID' THEN
			RAISE EXCEPTION 'REOPEN canonical_revision_id must reference a VOID revision, found %', v_void_rev.operation;
		END IF;

		IF v_latest.canonical_revision_id IS NULL THEN
			RAISE EXCEPTION 'Preceding SENT revision has no canonical_revision_id to reopen';
		END IF;
		SELECT * INTO v_prev_can_rev FROM transaction_revisions WHERE id = v_latest.canonical_revision_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Preceding SENT canonical revision % not found', v_latest.canonical_revision_id;
		END IF;
		IF v_void_rev.transaction_id != v_prev_can_rev.transaction_id THEN
			RAISE EXCEPTION 'REOPEN canonical VOID % does not belong to the same canonical transaction as the preceding SENT revision %',
				NEW.canonical_revision_id, v_latest.canonical_revision_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_long_term_task_revision_insert ON "long_term_send_task_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_long_term_task_revision_insert
BEFORE INSERT ON "long_term_send_task_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_long_term_task_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- C. ANCHOR COMPLETENESS: NAKED TASK ANCHOR REJECTED
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_long_term_task_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT EXISTS(SELECT 1 FROM long_term_send_task_revisions WHERE task_id = NEW.id) INTO v_found;
	IF NOT v_found THEN
		RAISE EXCEPTION 'Long-term send task % has no revisions at commit (naked task anchor)', NEW.id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_long_term_task_anchor_completeness ON "long_term_send_tasks";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_long_term_task_anchor_completeness
AFTER INSERT ON "long_term_send_tasks"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_long_term_task_anchor_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- D. GENERIC MIDAS GUARD: ANY TRANSFER TOUCHING PENDING_LONG_TERM MUST HAVE
--    EXACTLY ONE COMPANION TASK REVISION
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_pending_long_term_companion()
RETURNS TRIGGER AS $$
DECLARE
	v_from_type TEXT;
	v_to_type TEXT;
	v_touches_pending BOOLEAN := false;
	v_companion_count INT;
BEGIN
	IF NEW.from_bucket_id IS NOT NULL THEN
		SELECT bucket_type INTO v_from_type FROM midas_buckets WHERE id = NEW.from_bucket_id;
		IF v_from_type = 'PENDING_LONG_TERM' THEN
			v_touches_pending := true;
		END IF;
	END IF;
	IF NEW.to_bucket_id IS NOT NULL THEN
		SELECT bucket_type INTO v_to_type FROM midas_buckets WHERE id = NEW.to_bucket_id;
		IF v_to_type = 'PENDING_LONG_TERM' THEN
			v_touches_pending := true;
		END IF;
	END IF;

	IF NOT v_touches_pending THEN
		RETURN NULL;
	END IF;

	SELECT count(*) INTO v_companion_count
	FROM long_term_send_task_revisions
	WHERE midas_allocation_transfer_id = NEW.id;

	IF v_companion_count != 1 THEN
		RAISE EXCEPTION 'Midas allocation transfer % touches a PENDING_LONG_TERM bucket but has % companion long-term task revisions (expected exactly 1)',
			NEW.id, v_companion_count;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_midas_pending_long_term_companion ON "midas_allocation_transfers";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_midas_pending_long_term_companion
AFTER INSERT ON "midas_allocation_transfers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_midas_pending_long_term_companion();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- E. PENDING_LONG_TERM BUCKET <-> SUM(PENDING TASK AMOUNTS) RECONCILIATION
--    Deferred, order-independent: retriggered from both companion tables.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_long_term_pending_reconciliation()
RETURNS TRIGGER AS $$
DECLARE
	v_bucket RECORD;
	v_transfer_balance NUMERIC;
	v_task_sum NUMERIC;
BEGIN
	FOR v_bucket IN SELECT id, midas_account_id FROM midas_buckets WHERE bucket_type = 'PENDING_LONG_TERM' LOOP
		SELECT COALESCE(SUM(
			CASE
				WHEN to_bucket_id = v_bucket.id THEN amount
				WHEN from_bucket_id = v_bucket.id THEN -amount
				ELSE 0
			END
		), 0) INTO v_transfer_balance
		FROM midas_allocation_transfers
		WHERE midas_account_id = v_bucket.midas_account_id
			AND (to_bucket_id = v_bucket.id OR from_bucket_id = v_bucket.id);

		SELECT COALESCE(SUM(latest.amount), 0) INTO v_task_sum
		FROM (
			SELECT DISTINCT ON (ltr.task_id) ltr.task_id, ltr.amount, ltr.status
			FROM long_term_send_task_revisions ltr
			JOIN long_term_send_tasks t ON t.id = ltr.task_id
			WHERE t.pending_bucket_id = v_bucket.id
			ORDER BY ltr.task_id, ltr.revision_no DESC
		) latest
		WHERE latest.status = 'PENDING';

		IF v_transfer_balance != v_task_sum THEN
			RAISE EXCEPTION 'PENDING_LONG_TERM bucket % transfer-derived balance % does not match sum of PENDING task amounts % for Midas account %',
				v_bucket.id, v_transfer_balance, v_task_sum, v_bucket.midas_account_id;
		END IF;
	END LOOP;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_long_term_pending_reconciliation_task ON "long_term_send_task_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_long_term_pending_reconciliation_task
AFTER INSERT ON "long_term_send_task_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_long_term_pending_reconciliation();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_long_term_pending_reconciliation_transfer ON "midas_allocation_transfers";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_long_term_pending_reconciliation_transfer
AFTER INSERT ON "midas_allocation_transfers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_long_term_pending_reconciliation();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- F. CANONICAL LONG_TERM_INVESTMENT_SEND ANCHOR COMPLETENESS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_long_term_canonical_transaction_anchors()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_task_rev RECORD;
BEGIN
	IF NEW.kind != 'LONG_TERM_INVESTMENT_SEND' THEN
		RETURN NULL;
	END IF;

	SELECT * INTO v_can_rev
	FROM transaction_revisions
	WHERE transaction_id = NEW.id AND revision_no = 1;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical LONG_TERM_INVESTMENT_SEND transaction % has no initial revision #1 at commit', NEW.id;
	END IF;
	IF v_can_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical LONG_TERM_INVESTMENT_SEND transaction % revision #1 must have operation CREATE, found %',
			NEW.id, v_can_rev.operation;
	END IF;

	SELECT * INTO v_task_rev FROM long_term_send_task_revisions WHERE canonical_revision_id = v_can_rev.id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical LONG_TERM_INVESTMENT_SEND transaction % revision % has no linked long_term_send_task_revisions row at commit',
			NEW.id, v_can_rev.id;
	END IF;
	IF v_task_rev.operation != 'SENT' THEN
		RAISE EXCEPTION 'Canonical LONG_TERM_INVESTMENT_SEND transaction % linked task revision % must have operation SENT, found %',
			NEW.id, v_task_rev.id, v_task_rev.operation;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_long_term_canonical_transaction_anchors ON "canonical_transactions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_long_term_canonical_transaction_anchors
AFTER INSERT ON "canonical_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_long_term_canonical_transaction_anchors();