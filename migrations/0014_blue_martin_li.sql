CREATE TABLE "income_receipt_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"income_receipt_id" uuid NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_receipt_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"destination_account_id" uuid NOT NULL,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_receipt_revisions_rev_no_check" CHECK ("income_receipt_revisions"."revision_no" > 0),
	CONSTRAINT "income_receipt_revisions_op_check" CHECK ("income_receipt_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "income_receipt_revisions_amount_check" CHECK ("income_receipt_revisions"."amount" > 0),
	CONSTRAINT "income_receipt_revisions_note_check" CHECK ("income_receipt_revisions"."note" IS NULL OR ("income_receipt_revisions"."note" = btrim("income_receipt_revisions"."note") AND length("income_receipt_revisions"."note") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "income_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "income_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"nature" varchar(16) NOT NULL,
	"reference_method" varchar(32) NOT NULL,
	"expected_monthly_amount" numeric(18, 2),
	"seasonal_months_per_year" smallint,
	"rolling_median_months" smallint,
	"income_ledger_account_id" uuid NOT NULL,
	"active_from" date NOT NULL,
	"active_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "income_sources_code_check" CHECK ("income_sources"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "income_sources_name_check" CHECK ("income_sources"."name" = btrim("income_sources"."name") AND length("income_sources"."name") BETWEEN 1 AND 120),
	CONSTRAINT "income_sources_nature_check" CHECK ("income_sources"."nature" IN ('REGULAR', 'EXTRA', 'SUPPORT')),
	CONSTRAINT "income_sources_reference_method_check" CHECK ("income_sources"."reference_method" IN ('FIXED_MONTHLY', 'SEASONAL_ANNUALIZED', 'ROLLING_MEDIAN', 'EXCLUDED')),
	CONSTRAINT "income_sources_nature_method_consistency_check" CHECK (("income_sources"."nature" IN ('EXTRA', 'SUPPORT') AND "income_sources"."reference_method" = 'EXCLUDED') OR ("income_sources"."nature" = 'REGULAR')),
	CONSTRAINT "income_sources_method_params_check" CHECK (
				("income_sources"."reference_method" = 'FIXED_MONTHLY' AND "income_sources"."expected_monthly_amount" > 0 AND "income_sources"."seasonal_months_per_year" IS NULL AND "income_sources"."rolling_median_months" IS NULL) OR
				("income_sources"."reference_method" = 'SEASONAL_ANNUALIZED' AND "income_sources"."expected_monthly_amount" > 0 AND "income_sources"."seasonal_months_per_year" BETWEEN 1 AND 12 AND "income_sources"."rolling_median_months" IS NULL) OR
				("income_sources"."reference_method" = 'ROLLING_MEDIAN' AND "income_sources"."rolling_median_months" BETWEEN 1 AND 24 AND "income_sources"."seasonal_months_per_year" IS NULL) OR
				("income_sources"."reference_method" = 'EXCLUDED' AND "income_sources"."seasonal_months_per_year" IS NULL AND "income_sources"."rolling_median_months" IS NULL)
			),
	CONSTRAINT "income_sources_active_window_check" CHECK ("income_sources"."active_until" IS NULL OR "income_sources"."active_until" >= "income_sources"."active_from")
);
--> statement-breakpoint
ALTER TABLE "income_receipt_revisions" ADD CONSTRAINT "income_receipt_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipt_revisions" ADD CONSTRAINT "income_receipt_revisions_income_receipt_id_income_receipts_id_fk" FOREIGN KEY ("income_receipt_id") REFERENCES "public"."income_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipt_revisions" ADD CONSTRAINT "income_receipt_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipt_revisions" ADD CONSTRAINT "income_receipt_revisions_previous_receipt_revision_id_income_receipt_revisions_id_fk" FOREIGN KEY ("previous_receipt_revision_id") REFERENCES "public"."income_receipt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipt_revisions" ADD CONSTRAINT "income_receipt_revisions_destination_account_id_ledger_accounts_id_fk" FOREIGN KEY ("destination_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipts" ADD CONSTRAINT "income_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipts" ADD CONSTRAINT "income_receipts_source_id_income_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."income_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipts" ADD CONSTRAINT "income_receipts_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_income_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("income_ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "income_receipt_revisions_canonical_rev_idx" ON "income_receipt_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_receipt_revisions_receipt_rev_no_idx" ON "income_receipt_revisions" USING btree ("income_receipt_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "income_receipt_revisions_prev_idx" ON "income_receipt_revisions" USING btree ("previous_receipt_revision_id") WHERE "income_receipt_revisions"."previous_receipt_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "income_receipt_revisions_user_receipt_idx" ON "income_receipt_revisions" USING btree ("user_id","income_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_receipts_canonical_tx_idx" ON "income_receipts" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "income_receipts_user_source_idx" ON "income_receipts" USING btree ("user_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "income_sources_user_code_idx" ON "income_sources" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX "income_sources_user_active_idx" ON "income_sources" USING btree ("user_id","active_from","active_until");--> statement-breakpoint

-- =========================================================================
-- Custom Trigger Functions & Triggers for Income Domain
-- =========================================================================

-- 1. Income sources immutability guard
CREATE OR REPLACE FUNCTION trg_fn_protect_income_sources()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'Income sources cannot be deleted';
	END IF;

	IF TG_OP = 'UPDATE' THEN
		IF OLD.user_id IS DISTINCT FROM NEW.user_id OR
		   OLD.code IS DISTINCT FROM NEW.code OR
		   OLD.name IS DISTINCT FROM NEW.name OR
		   OLD.nature IS DISTINCT FROM NEW.nature OR
		   OLD.reference_method IS DISTINCT FROM NEW.reference_method OR
		   OLD.expected_monthly_amount IS DISTINCT FROM NEW.expected_monthly_amount OR
		   OLD.seasonal_months_per_year IS DISTINCT FROM NEW.seasonal_months_per_year OR
		   OLD.rolling_median_months IS DISTINCT FROM NEW.rolling_median_months OR
		   OLD.income_ledger_account_id IS DISTINCT FROM NEW.income_ledger_account_id OR
		   OLD.active_from IS DISTINCT FROM NEW.active_from OR
		   OLD.active_until IS DISTINCT FROM NEW.active_until OR
		   OLD.created_at IS DISTINCT FROM NEW.created_at THEN
			RAISE EXCEPTION 'Income source configuration is immutable and cannot be updated';
		END IF;

		IF OLD.archived_at IS NOT NULL THEN
			RAISE EXCEPTION 'Archived income source cannot be unarchived or have archived_at updated';
		END IF;

		IF NEW.archived_at IS NULL THEN
			RAISE EXCEPTION 'archived_at cannot be set to NULL';
		END IF;

		RETURN NEW;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_income_sources_mutation
BEFORE UPDATE OR DELETE ON "income_sources"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_income_sources();--> statement-breakpoint

-- 2. Income receipts identity immutability guard
CREATE OR REPLACE FUNCTION trg_fn_protect_income_receipts()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'income_receipts are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_income_receipts_mutation
BEFORE UPDATE OR DELETE ON "income_receipts"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_income_receipts();--> statement-breakpoint

-- 3. Income receipt revisions immutability guard
CREATE OR REPLACE FUNCTION trg_fn_protect_income_receipt_revisions()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'income_receipt_revisions are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_income_receipt_revisions_mutation
BEFORE UPDATE OR DELETE ON "income_receipt_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_income_receipt_revisions();--> statement-breakpoint

-- 4. Income receipt revisions insert consistency guard
CREATE OR REPLACE FUNCTION trg_fn_guard_income_receipt_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_receipt RECORD;
	v_tx RECORD;
	v_rev RECORD;
	v_prev_proj RECORD;
	v_expected_prev_proj_id uuid;
	v_payload_note text;
BEGIN
	-- 4.1 Fetch parent income receipt
	SELECT id, user_id, source_id, canonical_transaction_id
	INTO v_receipt
	FROM "income_receipts"
	WHERE id = NEW.income_receipt_id;

	IF v_receipt.id IS NULL THEN
		RAISE EXCEPTION 'Parent income receipt % not found', NEW.income_receipt_id;
	END IF;

	IF v_receipt.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'income_receipt_revisions user_id % does not match parent income_receipt user_id %',
			NEW.user_id, v_receipt.user_id;
	END IF;

	-- 4.2 Fetch canonical transaction
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

	-- 4.3 Fetch canonical revision
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

	-- 4.4 Validate Canonical Revision Payload Matching
	IF (v_rev.payload->>'incomeSourceId')::uuid != v_receipt.source_id THEN
		RAISE EXCEPTION 'Canonical payload incomeSourceId % does not match receipt source_id %',
			v_rev.payload->>'incomeSourceId', v_receipt.source_id;
	END IF;

	IF (v_rev.payload->>'amount')::numeric(18,2) != NEW.amount THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match domain amount %',
			v_rev.payload->>'amount', NEW.amount;
	END IF;

	IF (v_rev.payload->>'destinationAccountId')::uuid != NEW.destination_account_id THEN
		RAISE EXCEPTION 'Canonical payload destinationAccountId % does not match domain destination_account_id %',
			v_rev.payload->>'destinationAccountId', NEW.destination_account_id;
	END IF;

	v_payload_note := v_rev.payload->>'note';
	IF (v_payload_note IS NULL AND NEW.note IS NOT NULL) OR
	   (v_payload_note IS NOT NULL AND NEW.note IS NULL) OR
	   (v_payload_note IS NOT NULL AND v_payload_note != NEW.note) THEN
		RAISE EXCEPTION 'Canonical payload note does not match domain note';
	END IF;

	-- 4.5 Revision sequencing & predecessor verification
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

		-- For VOID: Verify domain projection copies previous values exactly
		IF NEW.operation = 'VOID' THEN
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

CREATE TRIGGER trg_guard_income_receipt_revisions_insert
BEFORE INSERT ON "income_receipt_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_income_receipt_revisions_insert();