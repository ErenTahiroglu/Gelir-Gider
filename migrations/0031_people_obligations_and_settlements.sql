CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_system_income_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(32) NOT NULL,
	"income_source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_system_income_links_role_check" CHECK ("people_system_income_links"."role" IN ('OVERPAYMENT_EXTRA'))
);
--> statement-breakpoint
CREATE TABLE "person_ledger_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"receivable_account_id" uuid NOT NULL,
	"payable_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_obligation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"principal_amount" numeric(18, 2) NOT NULL,
	"funding_asset_account_id" uuid,
	"budget_category" varchar(32),
	"due_date" date,
	"description" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_obligation_revisions_rev_no_check" CHECK ("person_obligation_revisions"."revision_no" > 0),
	CONSTRAINT "person_obligation_revisions_op_check" CHECK ("person_obligation_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "person_obligation_revisions_principal_check" CHECK ("person_obligation_revisions"."principal_amount" > 0),
	CONSTRAINT "person_obligation_revisions_budget_category_check" CHECK ("person_obligation_revisions"."budget_category" IS NULL OR "person_obligation_revisions"."budget_category" IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED')),
	CONSTRAINT "person_obligation_revisions_description_check" CHECK ("person_obligation_revisions"."description" IS NULL OR ("person_obligation_revisions"."description" = btrim("person_obligation_revisions"."description") AND length("person_obligation_revisions"."description") BETWEEN 1 AND 500)),
	CONSTRAINT "person_obligation_revisions_fingerprint_check" CHECK ("person_obligation_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "person_obligation_revisions_idempotency_check" CHECK ("person_obligation_revisions"."idempotency_key" = btrim("person_obligation_revisions"."idempotency_key") AND length("person_obligation_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "person_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"direction" varchar(10) NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_obligations_direction_check" CHECK ("person_obligations"."direction" IN ('RECEIVABLE', 'PAYABLE'))
);
--> statement-breakpoint
CREATE TABLE "person_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"status" varchar(10) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"relationship" varchar(10) NOT NULL,
	"note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_revisions_rev_no_check" CHECK ("person_revisions"."revision_no" > 0),
	CONSTRAINT "person_revisions_op_check" CHECK ("person_revisions"."operation" IN ('CREATE', 'UPDATE', 'ARCHIVE')),
	CONSTRAINT "person_revisions_status_check" CHECK ("person_revisions"."status" IN ('ACTIVE', 'ARCHIVED')),
	CONSTRAINT "person_revisions_status_op_check" CHECK (("person_revisions"."operation" = 'ARCHIVE' AND "person_revisions"."status" = 'ARCHIVED') OR ("person_revisions"."operation" IN ('CREATE', 'UPDATE') AND "person_revisions"."status" = 'ACTIVE')),
	CONSTRAINT "person_revisions_display_name_check" CHECK ("person_revisions"."display_name" = btrim("person_revisions"."display_name") AND length("person_revisions"."display_name") BETWEEN 1 AND 120),
	CONSTRAINT "person_revisions_relationship_check" CHECK ("person_revisions"."relationship" IN ('FAMILY', 'FRIEND', 'OTHER')),
	CONSTRAINT "person_revisions_note_check" CHECK ("person_revisions"."note" IS NULL OR ("person_revisions"."note" = btrim("person_revisions"."note") AND length("person_revisions"."note") BETWEEN 1 AND 500)),
	CONSTRAINT "person_revisions_fingerprint_check" CHECK ("person_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "person_revisions_idempotency_check" CHECK ("person_revisions"."idempotency_key" = btrim("person_revisions"."idempotency_key") AND length("person_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "person_settlement_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"cash_amount" numeric(18, 2) NOT NULL,
	"applied_amount" numeric(18, 2) NOT NULL,
	"excess_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"overpayment_income_receipt_id" uuid,
	"note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"canonical_revision_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_settlement_revisions_rev_no_check" CHECK ("person_settlement_revisions"."revision_no" > 0),
	CONSTRAINT "person_settlement_revisions_op_check" CHECK ("person_settlement_revisions"."operation" IN ('CREATE', 'VOID')),
	CONSTRAINT "person_settlement_revisions_cash_check" CHECK ("person_settlement_revisions"."cash_amount" > 0),
	CONSTRAINT "person_settlement_revisions_applied_check" CHECK ("person_settlement_revisions"."applied_amount" > 0 AND "person_settlement_revisions"."applied_amount" <= "person_settlement_revisions"."cash_amount"),
	CONSTRAINT "person_settlement_revisions_excess_check" CHECK ("person_settlement_revisions"."excess_amount" >= 0 AND "person_settlement_revisions"."excess_amount" = "person_settlement_revisions"."cash_amount" - "person_settlement_revisions"."applied_amount"),
	CONSTRAINT "person_settlement_revisions_overpayment_link_check" CHECK (("person_settlement_revisions"."excess_amount" = 0 AND "person_settlement_revisions"."overpayment_income_receipt_id" IS NULL) OR ("person_settlement_revisions"."excess_amount" > 0 AND "person_settlement_revisions"."overpayment_income_receipt_id" IS NOT NULL)),
	CONSTRAINT "person_settlement_revisions_note_check" CHECK ("person_settlement_revisions"."note" IS NULL OR ("person_settlement_revisions"."note" = btrim("person_settlement_revisions"."note") AND length("person_settlement_revisions"."note") BETWEEN 1 AND 500)),
	CONSTRAINT "person_settlement_revisions_fingerprint_check" CHECK ("person_settlement_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "person_settlement_revisions_idempotency_check" CHECK ("person_settlement_revisions"."idempotency_key" = btrim("person_settlement_revisions"."idempotency_key") AND length("person_settlement_revisions"."idempotency_key") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "person_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_system_income_links" ADD CONSTRAINT "people_system_income_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_system_income_links" ADD CONSTRAINT "people_system_income_links_income_source_id_income_sources_id_fk" FOREIGN KEY ("income_source_id") REFERENCES "public"."income_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_ledger_links" ADD CONSTRAINT "person_ledger_links_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_ledger_links" ADD CONSTRAINT "person_ledger_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_ledger_links" ADD CONSTRAINT "person_ledger_links_receivable_account_id_ledger_accounts_id_fk" FOREIGN KEY ("receivable_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_ledger_links" ADD CONSTRAINT "person_ledger_links_payable_account_id_ledger_accounts_id_fk" FOREIGN KEY ("payable_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligation_revisions" ADD CONSTRAINT "person_obligation_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligation_revisions" ADD CONSTRAINT "person_obligation_revisions_obligation_id_person_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."person_obligations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligation_revisions" ADD CONSTRAINT "person_obligation_revisions_previous_revision_id_person_obligation_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."person_obligation_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligation_revisions" ADD CONSTRAINT "person_obligation_revisions_funding_asset_account_id_ledger_accounts_id_fk" FOREIGN KEY ("funding_asset_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligation_revisions" ADD CONSTRAINT "person_obligation_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligations" ADD CONSTRAINT "person_obligations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligations" ADD CONSTRAINT "person_obligations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_obligations" ADD CONSTRAINT "person_obligations_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_revisions" ADD CONSTRAINT "person_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_revisions" ADD CONSTRAINT "person_revisions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_revisions" ADD CONSTRAINT "person_revisions_previous_revision_id_person_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."person_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlement_revisions" ADD CONSTRAINT "person_settlement_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlement_revisions" ADD CONSTRAINT "person_settlement_revisions_settlement_id_person_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."person_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlement_revisions" ADD CONSTRAINT "person_settlement_revisions_previous_revision_id_person_settlement_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."person_settlement_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlement_revisions" ADD CONSTRAINT "person_settlement_revisions_asset_account_id_ledger_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlement_revisions" ADD CONSTRAINT "person_settlement_revisions_overpayment_income_receipt_id_income_receipts_id_fk" FOREIGN KEY ("overpayment_income_receipt_id") REFERENCES "public"."income_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlement_revisions" ADD CONSTRAINT "person_settlement_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlements" ADD CONSTRAINT "person_settlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlements" ADD CONSTRAINT "person_settlements_obligation_id_person_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."person_obligations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settlements" ADD CONSTRAINT "person_settlements_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_user_idx" ON "people" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_system_income_links_user_role_idx" ON "people_system_income_links" USING btree ("user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "people_system_income_links_source_idx" ON "people_system_income_links" USING btree ("income_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_ledger_links_person_idx" ON "person_ledger_links" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_ledger_links_receivable_idx" ON "person_ledger_links" USING btree ("receivable_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_ledger_links_payable_idx" ON "person_ledger_links" USING btree ("payable_account_id");--> statement-breakpoint
CREATE INDEX "person_ledger_links_user_idx" ON "person_ledger_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_obligation_revisions_obl_rev_idx" ON "person_obligation_revisions" USING btree ("obligation_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "person_obligation_revisions_prev_rev_idx" ON "person_obligation_revisions" USING btree ("previous_revision_id") WHERE "person_obligation_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "person_obligation_revisions_user_idempotency_idx" ON "person_obligation_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "person_obligation_revisions_canonical_rev_idx" ON "person_obligation_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE INDEX "person_obligation_revisions_obl_idx" ON "person_obligation_revisions" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "person_obligation_revisions_user_idx" ON "person_obligation_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "person_obligation_revisions_due_date_idx" ON "person_obligation_revisions" USING btree ("due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "person_obligations_canonical_tx_idx" ON "person_obligations" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "person_obligations_person_idx" ON "person_obligations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_obligations_user_idx" ON "person_obligations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_revisions_person_rev_idx" ON "person_revisions" USING btree ("person_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "person_revisions_prev_rev_idx" ON "person_revisions" USING btree ("previous_revision_id") WHERE "person_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "person_revisions_user_idempotency_idx" ON "person_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "person_revisions_person_idx" ON "person_revisions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_revisions_user_idx" ON "person_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_settlement_revisions_settle_rev_idx" ON "person_settlement_revisions" USING btree ("settlement_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "person_settlement_revisions_prev_rev_idx" ON "person_settlement_revisions" USING btree ("previous_revision_id") WHERE "person_settlement_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "person_settlement_revisions_user_idempotency_idx" ON "person_settlement_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "person_settlement_revisions_canonical_rev_idx" ON "person_settlement_revisions" USING btree ("canonical_revision_id");--> statement-breakpoint
CREATE INDEX "person_settlement_revisions_settle_idx" ON "person_settlement_revisions" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "person_settlement_revisions_user_idx" ON "person_settlement_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_settlements_canonical_tx_idx" ON "person_settlements" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "person_settlements_obl_idx" ON "person_settlements" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "person_settlements_user_idx" ON "person_settlements" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- Phase 11A: People, Receivable/Payable Obligations, Partial Settlements
-- 1. Person revision chain-integrity guard
-- 2. Person obligation revision chain-integrity, canonical binding & settlement-limit guard
-- 3. Person settlement revision chain-integrity, canonical binding & oversettlement guard
-- 4. Canonical anchor completeness for People canonical kinds (Phase 10 0030 pattern)
-- 5. Orphan canonical revision guard for People kinds (Phase 10 0028 pattern)
-- 6. Ledger account archive protection extension (person links + system income source)
-- 7. Income source archive protection extension (people system income role)
-- 8. Person subledger <-> ledger reconciliation and non-negative balance guard
-- ============================================================================

-- ============================================================================
-- 1. PERSON REVISION CHAIN-INTEGRITY GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_person RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_person FROM people WHERE id = NEW.person_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person % not found', NEW.person_id;
	END IF;
	IF v_person.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Person user_id % does not match revision user_id %', v_person.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, status INTO v_latest
	FROM person_revisions WHERE person_id = NEW.person_id ORDER BY revision_no DESC LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Person % already has revisions; revision 1 cannot be created again', NEW.person_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for person %', NEW.person_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of person % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.person_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status = 'ARCHIVED' THEN
			RAISE EXCEPTION 'Cannot create revision on ARCHIVED person %', NEW.person_id;
		END IF;
		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_revision_insert ON "person_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_revision_insert
BEFORE INSERT ON "person_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 2. PERSON OBLIGATION REVISION CHAIN-INTEGRITY, CANONICAL BINDING & SETTLEMENT-LIMIT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_person RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_expected_kind TEXT;
	v_invalid_key TEXT;
	v_active_settled NUMERIC;
BEGIN
	SELECT * INTO v_obligation FROM person_obligations WHERE id = NEW.obligation_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person obligation % not found', NEW.obligation_id;
	END IF;
	IF v_obligation.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Obligation user_id % does not match revision user_id %', v_obligation.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_person FROM people WHERE id = v_obligation.person_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person % not found for obligation %', v_obligation.person_id, NEW.obligation_id;
	END IF;

	-- Canonical revision binding
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id % does not match revision user_id %', v_can_rev.user_id, NEW.user_id;
	END IF;
	IF v_can_rev.transaction_id != v_obligation.canonical_transaction_id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match obligation canonical_transaction_id %',
			v_can_rev.transaction_id, v_obligation.canonical_transaction_id;
	END IF;
	IF v_can_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Canonical revision operation % does not match projection operation %',
			v_can_rev.operation, NEW.operation;
	END IF;
	IF NEW.occurred_at != v_can_rev.occurred_at THEN
		RAISE EXCEPTION 'Projection occurred_at % must match canonical revision occurred_at %',
			NEW.occurred_at, v_can_rev.occurred_at;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
	END IF;

	IF v_obligation.direction = 'RECEIVABLE' THEN
		v_expected_kind := 'PERSON_RECEIVABLE_ADVANCE';
	ELSE
		v_expected_kind := 'PERSON_PAYABLE_EXPENSE';
	END IF;
	IF v_can_tx.kind != v_expected_kind THEN
		RAISE EXCEPTION 'Obligation direction % requires canonical kind %, found %',
			v_obligation.direction, v_expected_kind, v_can_tx.kind;
	END IF;

	-- Chain integrity
	SELECT id, revision_no, operation, principal_amount, funding_asset_account_id, budget_category, due_date, description
	INTO v_latest
	FROM person_obligation_revisions
	WHERE obligation_id = NEW.obligation_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Obligation % already has revisions; revision 1 cannot be created again', NEW.obligation_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF v_person.user_id IS NULL THEN
			RAISE EXCEPTION 'Person lookup failed';
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for obligation %', NEW.obligation_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of obligation % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.obligation_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID obligation %', NEW.obligation_id;
		END IF;
		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
	END IF;

	-- Fresh obligations may not be created against an archived person
	IF NEW.revision_no = 1 THEN
		IF NOT EXISTS (
			SELECT 1 FROM person_revisions
			WHERE person_id = v_obligation.person_id AND status = 'ACTIVE'
			ORDER BY revision_no DESC LIMIT 1
		) THEN
			RAISE EXCEPTION 'Cannot create obligation for archived or unknown person %', v_obligation.person_id;
		END IF;
	END IF;

	-- Direction-specific field consistency
	IF v_obligation.direction = 'RECEIVABLE' THEN
		IF NEW.funding_asset_account_id IS NULL THEN
			RAISE EXCEPTION 'RECEIVABLE obligation revision requires funding_asset_account_id';
		END IF;
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'RECEIVABLE obligation revision must have budget_category NULL';
		END IF;
	ELSE
		IF NEW.budget_category IS NULL THEN
			RAISE EXCEPTION 'PAYABLE obligation revision requires budget_category';
		END IF;
		IF NEW.funding_asset_account_id IS NOT NULL THEN
			RAISE EXCEPTION 'PAYABLE obligation revision must have funding_asset_account_id NULL';
		END IF;
	END IF;

	-- Canonical payload key whitelist & exact binding
	IF v_obligation.direction = 'RECEIVABLE' THEN
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'fundingAssetAccountId', 'dueDate', 'description')
		LIMIT 1;
	ELSE
		SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
		WHERE k NOT IN ('obligationId', 'personId', 'direction', 'amount', 'budgetCategory', 'dueDate', 'description')
		LIMIT 1;
	END IF;
	IF v_invalid_key IS NOT NULL THEN
		RAISE EXCEPTION 'Unexpected key % in % canonical payload', v_invalid_key, v_can_tx.kind;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'obligationId') != 'string' OR
	   v_can_rev.payload->>'obligationId' != NEW.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match obligation %',
			v_can_rev.payload->>'obligationId', NEW.obligation_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'personId') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'direction') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'amount') != 'string' OR
	   v_can_rev.payload->>'amount' != NEW.principal_amount::text THEN
		RAISE EXCEPTION 'Canonical payload amount % does not match revision principal_amount %',
			v_can_rev.payload->>'amount', NEW.principal_amount;
	END IF;

	IF v_obligation.direction = 'RECEIVABLE' THEN
		IF jsonb_typeof(v_can_rev.payload->'fundingAssetAccountId') != 'string' OR
		   v_can_rev.payload->>'fundingAssetAccountId' != NEW.funding_asset_account_id::text THEN
			RAISE EXCEPTION 'Canonical payload fundingAssetAccountId % does not match revision %',
				v_can_rev.payload->>'fundingAssetAccountId', NEW.funding_asset_account_id;
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'budgetCategory') != 'string' OR
		   v_can_rev.payload->>'budgetCategory' != NEW.budget_category THEN
			RAISE EXCEPTION 'Canonical payload budgetCategory % does not match revision %',
				v_can_rev.payload->>'budgetCategory', NEW.budget_category;
		END IF;
	END IF;

	IF NEW.due_date IS NULL THEN
		IF v_can_rev.payload->'dueDate' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'dueDate') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload dueDate must be null when projection due_date is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'dueDate') != 'string' OR
		   v_can_rev.payload->>'dueDate' != NEW.due_date::text THEN
			RAISE EXCEPTION 'Canonical payload dueDate % does not match revision due_date %',
				v_can_rev.payload->>'dueDate', NEW.due_date;
		END IF;
	END IF;

	IF NEW.description IS NULL THEN
		IF v_can_rev.payload->'description' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'description') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload description must be null when projection description is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'description') != 'string' OR
		   v_can_rev.payload->>'description' != NEW.description THEN
			RAISE EXCEPTION 'Canonical payload description % does not match revision description %',
				v_can_rev.payload->>'description', NEW.description;
		END IF;
	END IF;

	-- Active settlement limit (sections 22, 23, 49)
	SELECT COALESCE(SUM(latest.applied_amount), 0) INTO v_active_settled
	FROM (
		SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
		FROM person_settlement_revisions psr
		JOIN person_settlements ps ON ps.id = psr.settlement_id
		WHERE ps.obligation_id = NEW.obligation_id
		ORDER BY psr.settlement_id, psr.revision_no DESC
	) latest
	WHERE latest.operation != 'VOID';

	IF NEW.operation = 'VOID' THEN
		IF v_active_settled != 0 THEN
			RAISE EXCEPTION 'Cannot VOID obligation % with active settled amount %', NEW.obligation_id, v_active_settled;
		END IF;
		IF NEW.principal_amount != v_latest.principal_amount THEN
			RAISE EXCEPTION 'VOID revision must copy forward previous principal_amount';
		END IF;
	ELSIF NEW.operation = 'UPDATE' THEN
		IF NEW.principal_amount < v_active_settled THEN
			RAISE EXCEPTION 'Cannot revise obligation % principal to % below active settled amount %',
				NEW.obligation_id, NEW.principal_amount, v_active_settled;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_obligation_revision_insert ON "person_obligation_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_obligation_revision_insert
BEFORE INSERT ON "person_obligation_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_obligation_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 3. PERSON SETTLEMENT REVISION CHAIN-INTEGRITY, CANONICAL BINDING & OVERSETTLEMENT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_settlement RECORD;
	v_obligation RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_can_tx RECORD;
	v_invalid_key TEXT;
	v_obl_latest RECORD;
	v_active_settled NUMERIC;
BEGIN
	SELECT * INTO v_settlement FROM person_settlements WHERE id = NEW.settlement_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Person settlement % not found', NEW.settlement_id;
	END IF;
	IF v_settlement.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Settlement user_id % does not match revision user_id %', v_settlement.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_obligation FROM person_obligations WHERE id = v_settlement.obligation_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Obligation % not found for settlement %', v_settlement.obligation_id, NEW.settlement_id;
	END IF;

	-- Canonical revision binding
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id % does not match revision user_id %', v_can_rev.user_id, NEW.user_id;
	END IF;
	IF v_can_rev.transaction_id != v_settlement.canonical_transaction_id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match settlement canonical_transaction_id %',
			v_can_rev.transaction_id, v_settlement.canonical_transaction_id;
	END IF;
	IF v_can_rev.operation != NEW.operation THEN
		RAISE EXCEPTION 'Canonical revision operation % does not match projection operation %',
			v_can_rev.operation, NEW.operation;
	END IF;
	IF NEW.occurred_at != v_can_rev.occurred_at THEN
		RAISE EXCEPTION 'Projection occurred_at % must match canonical revision occurred_at %',
			NEW.occurred_at, v_can_rev.occurred_at;
	END IF;

	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = v_can_rev.transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', v_can_rev.transaction_id;
	END IF;
	IF v_can_tx.kind != 'PERSON_OBLIGATION_SETTLEMENT' THEN
		RAISE EXCEPTION 'Settlement revision requires canonical kind PERSON_OBLIGATION_SETTLEMENT, found %', v_can_tx.kind;
	END IF;

	-- Chain integrity
	SELECT id, revision_no, operation, asset_account_id, cash_amount, applied_amount, excess_amount, overpayment_income_receipt_id, note
	INTO v_latest
	FROM person_settlement_revisions
	WHERE settlement_id = NEW.settlement_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Settlement % already has revisions; revision 1 cannot be created again', NEW.settlement_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for settlement %', NEW.settlement_id;
		END IF;
		IF NEW.previous_revision_id IS NULL OR NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of settlement % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.settlement_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID settlement %', NEW.settlement_id;
		END IF;
		IF NEW.operation != 'VOID' THEN
			RAISE EXCEPTION 'Only VOID operation is allowed on subsequent settlement revisions, found %', NEW.operation;
		END IF;
		-- VOID must copy forward the CREATE snapshot exactly (no silent tampering)
		IF NEW.asset_account_id != v_latest.asset_account_id OR
		   NEW.cash_amount != v_latest.cash_amount OR
		   NEW.applied_amount != v_latest.applied_amount OR
		   NEW.excess_amount != v_latest.excess_amount OR
		   NEW.overpayment_income_receipt_id IS DISTINCT FROM v_latest.overpayment_income_receipt_id OR
		   NEW.note IS DISTINCT FROM v_latest.note THEN
			RAISE EXCEPTION 'VOID revision must copy forward the previous settlement snapshot unchanged';
		END IF;
	END IF;

	-- Direction consistency: PAYABLE settlements may never carry an overpayment
	IF v_obligation.direction = 'PAYABLE' AND NEW.excess_amount != 0 THEN
		RAISE EXCEPTION 'PAYABLE settlement % cannot have a non-zero excess_amount', NEW.settlement_id;
	END IF;

	-- Canonical payload key whitelist & exact binding
	SELECT k INTO v_invalid_key FROM jsonb_object_keys(v_can_rev.payload) AS k
	WHERE k NOT IN ('settlementId', 'obligationId', 'personId', 'direction', 'appliedAmount', 'cashAmount', 'excessAmount', 'assetAccountId', 'note')
	LIMIT 1;
	IF v_invalid_key IS NOT NULL THEN
		RAISE EXCEPTION 'Unexpected key % in PERSON_OBLIGATION_SETTLEMENT canonical payload', v_invalid_key;
	END IF;

	IF jsonb_typeof(v_can_rev.payload->'settlementId') != 'string' OR
	   v_can_rev.payload->>'settlementId' != NEW.settlement_id::text THEN
		RAISE EXCEPTION 'Canonical payload settlementId % does not match settlement %',
			v_can_rev.payload->>'settlementId', NEW.settlement_id;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'obligationId') != 'string' OR
	   v_can_rev.payload->>'obligationId' != v_settlement.obligation_id::text THEN
		RAISE EXCEPTION 'Canonical payload obligationId % does not match settlement obligation %',
			v_can_rev.payload->>'obligationId', v_settlement.obligation_id;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'personId') != 'string' OR
	   v_can_rev.payload->>'personId' != v_obligation.person_id::text THEN
		RAISE EXCEPTION 'Canonical payload personId % does not match obligation person %',
			v_can_rev.payload->>'personId', v_obligation.person_id;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'direction') != 'string' OR
	   v_can_rev.payload->>'direction' != v_obligation.direction THEN
		RAISE EXCEPTION 'Canonical payload direction % does not match obligation direction %',
			v_can_rev.payload->>'direction', v_obligation.direction;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'appliedAmount') != 'string' OR
	   v_can_rev.payload->>'appliedAmount' != NEW.applied_amount::text THEN
		RAISE EXCEPTION 'Canonical payload appliedAmount % does not match revision %',
			v_can_rev.payload->>'appliedAmount', NEW.applied_amount;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'cashAmount') != 'string' OR
	   v_can_rev.payload->>'cashAmount' != NEW.cash_amount::text THEN
		RAISE EXCEPTION 'Canonical payload cashAmount % does not match revision %',
			v_can_rev.payload->>'cashAmount', NEW.cash_amount;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'excessAmount') != 'string' OR
	   v_can_rev.payload->>'excessAmount' != NEW.excess_amount::text THEN
		RAISE EXCEPTION 'Canonical payload excessAmount % does not match revision %',
			v_can_rev.payload->>'excessAmount', NEW.excess_amount;
	END IF;
	IF jsonb_typeof(v_can_rev.payload->'assetAccountId') != 'string' OR
	   v_can_rev.payload->>'assetAccountId' != NEW.asset_account_id::text THEN
		RAISE EXCEPTION 'Canonical payload assetAccountId % does not match revision %',
			v_can_rev.payload->>'assetAccountId', NEW.asset_account_id;
	END IF;
	IF NEW.note IS NULL THEN
		IF v_can_rev.payload->'note' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'note') != 'null' THEN
			RAISE EXCEPTION 'Canonical payload note must be null when projection note is null';
		END IF;
	ELSE
		IF jsonb_typeof(v_can_rev.payload->'note') != 'string' OR
		   v_can_rev.payload->>'note' != NEW.note THEN
			RAISE EXCEPTION 'Canonical payload note % does not match revision note %',
				v_can_rev.payload->>'note', NEW.note;
		END IF;
	END IF;

	-- Oversettlement guard: fresh CREATE may not push active settled total beyond active principal
	IF NEW.operation = 'CREATE' THEN
		SELECT id, revision_no, operation, principal_amount INTO v_obl_latest
		FROM person_obligation_revisions
		WHERE obligation_id = v_settlement.obligation_id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF v_obl_latest.id IS NULL OR v_obl_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot settle obligation % that is VOID or has no revisions', v_settlement.obligation_id;
		END IF;

		SELECT COALESCE(SUM(latest.applied_amount), 0) INTO v_active_settled
		FROM (
			SELECT DISTINCT ON (psr.settlement_id) psr.settlement_id, psr.applied_amount, psr.operation
			FROM person_settlement_revisions psr
			JOIN person_settlements ps ON ps.id = psr.settlement_id
			WHERE ps.obligation_id = v_settlement.obligation_id AND psr.settlement_id != NEW.settlement_id
			ORDER BY psr.settlement_id, psr.revision_no DESC
		) latest
		WHERE latest.operation != 'VOID';

		IF (v_active_settled + NEW.applied_amount) > v_obl_latest.principal_amount THEN
			RAISE EXCEPTION 'Settlement % would push obligation % active settled total % beyond principal %',
				NEW.settlement_id, v_settlement.obligation_id, (v_active_settled + NEW.applied_amount), v_obl_latest.principal_amount;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_person_settlement_revision_insert ON "person_settlement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_person_settlement_revision_insert
BEFORE INSERT ON "person_settlement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_person_settlement_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 4. CANONICAL ANCHOR COMPLETENESS FOR PEOPLE CANONICAL KINDS (Phase 10 0030 pattern)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_people_canonical_transaction_anchors()
RETURNS TRIGGER AS $$
DECLARE
	v_can_rev RECORD;
	v_obligation RECORD;
	v_obligation_rev RECORD;
	v_settlement RECORD;
	v_settlement_rev RECORD;
BEGIN
	IF NEW.kind NOT IN ('PERSON_RECEIVABLE_ADVANCE', 'PERSON_PAYABLE_EXPENSE', 'PERSON_OBLIGATION_SETTLEMENT') THEN
		RETURN NULL;
	END IF;

	SELECT * INTO v_can_rev FROM transaction_revisions WHERE transaction_id = NEW.id AND revision_no = 1;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical % transaction % has no initial revision #1 at commit', NEW.kind, NEW.id;
	END IF;
	IF v_can_rev.operation != 'CREATE' THEN
		RAISE EXCEPTION 'Canonical % transaction % revision #1 must have operation CREATE, found %',
			NEW.kind, NEW.id, v_can_rev.operation;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical % transaction % user_id % does not match revision user_id %',
			NEW.kind, NEW.id, NEW.user_id, v_can_rev.user_id;
	END IF;

	IF NEW.kind IN ('PERSON_RECEIVABLE_ADVANCE', 'PERSON_PAYABLE_EXPENSE') THEN
		SELECT * INTO v_obligation FROM person_obligations WHERE canonical_transaction_id = NEW.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical % transaction % has no linked person_obligations anchor at commit', NEW.kind, NEW.id;
		END IF;

		SELECT * INTO v_obligation_rev FROM person_obligation_revisions WHERE canonical_revision_id = v_can_rev.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical % transaction % revision % has no linked person_obligation_revisions row at commit',
				NEW.kind, NEW.id, v_can_rev.id;
		END IF;
		IF v_obligation_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical % transaction % obligation revision % must have operation CREATE, found %',
				NEW.kind, NEW.id, v_obligation_rev.id, v_obligation_rev.operation;
		END IF;
	ELSIF NEW.kind = 'PERSON_OBLIGATION_SETTLEMENT' THEN
		SELECT * INTO v_settlement FROM person_settlements WHERE canonical_transaction_id = NEW.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical PERSON_OBLIGATION_SETTLEMENT transaction % has no linked person_settlements anchor at commit', NEW.id;
		END IF;

		SELECT * INTO v_settlement_rev FROM person_settlement_revisions WHERE canonical_revision_id = v_can_rev.id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Canonical PERSON_OBLIGATION_SETTLEMENT transaction % revision % has no linked person_settlement_revisions row at commit',
				NEW.id, v_can_rev.id;
		END IF;
		IF v_settlement_rev.operation != 'CREATE' THEN
			RAISE EXCEPTION 'Canonical PERSON_OBLIGATION_SETTLEMENT transaction % settlement revision % must have operation CREATE, found %',
				NEW.id, v_settlement_rev.id, v_settlement_rev.operation;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_canonical_transaction_anchors ON "canonical_transactions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_canonical_transaction_anchors
AFTER INSERT ON "canonical_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_canonical_transaction_anchors();--> statement-breakpoint

-- ============================================================================
-- 5. ORPHAN CANONICAL REVISION GUARD FOR PEOPLE KINDS (Phase 10 0028 pattern)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_people_orphan_canonical_revision()
RETURNS TRIGGER AS $$
DECLARE
	v_obligation RECORD;
	v_settlement RECORD;
BEGIN
	SELECT * INTO v_obligation FROM person_obligations WHERE canonical_transaction_id = NEW.transaction_id;
	IF FOUND THEN
		IF NOT EXISTS (
			SELECT 1 FROM person_obligation_revisions
			WHERE canonical_revision_id = NEW.id AND operation = NEW.operation
		) THEN
			RAISE EXCEPTION 'No matching person obligation revision found for canonical revision % and operation %',
				NEW.id, NEW.operation;
		END IF;
		RETURN NULL;
	END IF;

	SELECT * INTO v_settlement FROM person_settlements WHERE canonical_transaction_id = NEW.transaction_id;
	IF FOUND THEN
		IF NOT EXISTS (
			SELECT 1 FROM person_settlement_revisions
			WHERE canonical_revision_id = NEW.id AND operation = NEW.operation
		) THEN
			RAISE EXCEPTION 'No matching person settlement revision found for canonical revision % and operation %',
				NEW.id, NEW.operation;
		END IF;
		RETURN NULL;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_orphan_canonical_revision ON "transaction_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_orphan_canonical_revision
AFTER INSERT ON "transaction_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_orphan_canonical_revision();--> statement-breakpoint

-- ============================================================================
-- 6. LEDGER ACCOUNT ARCHIVE PROTECTION EXTENSION (person links + system income source)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_ledger_accounts_archive()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
		IF EXISTS (SELECT 1 FROM midas_accounts WHERE ledger_account_id = OLD.id) THEN
			RAISE EXCEPTION 'Cannot archive ledger account % because it is linked to Midas liquidity account', OLD.id;
		END IF;
		IF EXISTS (SELECT 1 FROM credit_card_ledger_links WHERE ledger_account_id = OLD.id) THEN
			RAISE EXCEPTION 'Cannot archive ledger account % because it is linked to credit card liability', OLD.id;
		END IF;
		IF EXISTS (SELECT 1 FROM credit_card_system_accounts WHERE ledger_account_id = OLD.id) THEN
			RAISE EXCEPTION 'Cannot archive ledger account % because it is linked to credit card system account', OLD.id;
		END IF;
		IF EXISTS (SELECT 1 FROM person_ledger_links WHERE receivable_account_id = OLD.id OR payable_account_id = OLD.id) THEN
			RAISE EXCEPTION 'Cannot archive ledger account % because it is linked to a People receivable/payable account', OLD.id;
		END IF;
		IF EXISTS (
			SELECT 1 FROM income_sources s
			JOIN people_system_income_links l ON l.income_source_id = s.id
			WHERE s.income_ledger_account_id = OLD.id
		) THEN
			RAISE EXCEPTION 'Cannot archive ledger account % because it is linked to a People system income role', OLD.id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ledger_accounts_archive ON "ledger_accounts";--> statement-breakpoint
CREATE TRIGGER trg_guard_ledger_accounts_archive
BEFORE UPDATE ON "ledger_accounts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ledger_accounts_archive();--> statement-breakpoint

-- ============================================================================
-- 7. INCOME SOURCE ARCHIVE PROTECTION EXTENSION (people system income role)
-- ============================================================================

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

		IF EXISTS (SELECT 1 FROM people_system_income_links WHERE income_source_id = OLD.id) THEN
			RAISE EXCEPTION 'Cannot archive income source % because it is linked to a People system income role', OLD.id;
		END IF;

		RETURN NEW;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ============================================================================
-- 8. PERSON SUBLEDGER <-> LEDGER RECONCILIATION AND NON-NEGATIVE BALANCE GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation()
RETURNS TRIGGER AS $$
DECLARE
	v_link RECORD;
	v_receivable_balance NUMERIC;
	v_payable_balance NUMERIC;
	v_receivable_expected NUMERIC;
	v_payable_expected NUMERIC;
BEGIN
	SELECT * INTO v_link FROM person_ledger_links
	WHERE receivable_account_id = NEW.account_id OR payable_account_id = NEW.account_id;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) INTO v_receivable_balance
	FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
	WHERE jl.account_id = v_link.receivable_account_id AND je.status = 'POSTED';

	SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) INTO v_payable_balance
	FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
	WHERE jl.account_id = v_link.payable_account_id AND je.status = 'POSTED';

	SELECT COALESCE(SUM(GREATEST(t.remaining, 0)), 0) INTO v_receivable_expected
	FROM (
		SELECT
			(latest_rev.principal_amount - COALESCE(settled.total, 0)) AS remaining
		FROM person_obligations po
		JOIN LATERAL (
			SELECT * FROM person_obligation_revisions
			WHERE obligation_id = po.id ORDER BY revision_no DESC LIMIT 1
		) latest_rev ON true
		LEFT JOIN LATERAL (
			SELECT SUM(x.applied_amount) AS total FROM (
				SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
				FROM person_settlement_revisions psr
				JOIN person_settlements ps ON ps.id = psr.settlement_id
				WHERE ps.obligation_id = po.id
				ORDER BY psr.settlement_id, psr.revision_no DESC
			) x WHERE x.operation != 'VOID'
		) settled ON true
		WHERE po.person_id = v_link.person_id AND po.direction = 'RECEIVABLE' AND latest_rev.operation != 'VOID'
	) t;

	SELECT COALESCE(SUM(GREATEST(t.remaining, 0)), 0) INTO v_payable_expected
	FROM (
		SELECT
			(latest_rev.principal_amount - COALESCE(settled.total, 0)) AS remaining
		FROM person_obligations po
		JOIN LATERAL (
			SELECT * FROM person_obligation_revisions
			WHERE obligation_id = po.id ORDER BY revision_no DESC LIMIT 1
		) latest_rev ON true
		LEFT JOIN LATERAL (
			SELECT SUM(x.applied_amount) AS total FROM (
				SELECT DISTINCT ON (psr.settlement_id) psr.applied_amount, psr.operation
				FROM person_settlement_revisions psr
				JOIN person_settlements ps ON ps.id = psr.settlement_id
				WHERE ps.obligation_id = po.id
				ORDER BY psr.settlement_id, psr.revision_no DESC
			) x WHERE x.operation != 'VOID'
		) settled ON true
		WHERE po.person_id = v_link.person_id AND po.direction = 'PAYABLE' AND latest_rev.operation != 'VOID'
	) t;

	IF v_receivable_balance < 0 THEN
		RAISE EXCEPTION 'Person % receivable ledger balance cannot become negative (%)', v_link.person_id, v_receivable_balance;
	END IF;
	IF v_payable_balance < 0 THEN
		RAISE EXCEPTION 'Person % payable ledger balance cannot become negative (%)', v_link.person_id, v_payable_balance;
	END IF;
	IF v_receivable_balance != v_receivable_expected THEN
		RAISE EXCEPTION 'Person % receivable ledger balance % does not reconcile with derived obligation remaining %',
			v_link.person_id, v_receivable_balance, v_receivable_expected;
	END IF;
	IF v_payable_balance != v_payable_expected THEN
		RAISE EXCEPTION 'Person % payable ledger balance % does not reconcile with derived obligation remaining %',
			v_link.person_id, v_payable_balance, v_payable_expected;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_people_ledger_reconciliation ON "journal_lines";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_people_ledger_reconciliation
AFTER INSERT ON "journal_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_people_ledger_reconciliation();