CREATE TABLE "credit_card_ledger_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_card_liability_event_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"canonical_revision_id" uuid NOT NULL,
	"operation" varchar(20) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"budget_category" varchar(32),
	"merchant" varchar(200),
	"description" varchar(500),
	"installment_count" integer,
	"purchase_date" date,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_liability_event_revisions_rev_no_check" CHECK ("credit_card_liability_event_revisions"."revision_no" > 0),
	CONSTRAINT "cc_liability_event_revisions_op_check" CHECK ("credit_card_liability_event_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "cc_liability_event_revisions_amount_check" CHECK ("credit_card_liability_event_revisions"."amount" > 0),
	CONSTRAINT "cc_liability_event_revisions_category_check" CHECK ("credit_card_liability_event_revisions"."budget_category" IS NULL OR "credit_card_liability_event_revisions"."budget_category" IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED')),
	CONSTRAINT "cc_liability_event_revisions_installment_check" CHECK ("credit_card_liability_event_revisions"."installment_count" IS NULL OR ("credit_card_liability_event_revisions"."installment_count" >= 1 AND "credit_card_liability_event_revisions"."installment_count" <= 60)),
	CONSTRAINT "cc_liability_event_revisions_merchant_check" CHECK ("credit_card_liability_event_revisions"."merchant" IS NULL OR ("credit_card_liability_event_revisions"."merchant" = btrim("credit_card_liability_event_revisions"."merchant") AND length("credit_card_liability_event_revisions"."merchant") >= 1 AND length("credit_card_liability_event_revisions"."merchant") <= 200)),
	CONSTRAINT "cc_liability_event_revisions_description_check" CHECK ("credit_card_liability_event_revisions"."description" IS NULL OR ("credit_card_liability_event_revisions"."description" = btrim("credit_card_liability_event_revisions"."description") AND length("credit_card_liability_event_revisions"."description") >= 1 AND length("credit_card_liability_event_revisions"."description") <= 500)),
	CONSTRAINT "cc_liability_event_revisions_fingerprint_check" CHECK ("credit_card_liability_event_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cc_liability_event_revisions_idempotency_check" CHECK ("credit_card_liability_event_revisions"."idempotency_key" = btrim("credit_card_liability_event_revisions"."idempotency_key") AND length("credit_card_liability_event_revisions"."idempotency_key") >= 1 AND length("credit_card_liability_event_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "credit_card_liability_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credit_card_id" uuid NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_liability_events_type_check" CHECK ("credit_card_liability_events"."event_type" IN ('PURCHASE', 'OPENING_BALANCE'))
);
--> statement-breakpoint
CREATE TABLE "credit_card_statement_payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"payment_asset_account_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_stmt_payment_events_amount_check" CHECK ("credit_card_statement_payment_events"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_card_system_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(32) NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_system_accounts_role_check" CHECK ("credit_card_system_accounts"."role" IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_EXPENSE', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED_EXPENSE', 'OPENING_EQUITY'))
);
--> statement-breakpoint
ALTER TABLE "credit_card_statement_revisions" DROP CONSTRAINT IF EXISTS "cc_stmt_revisions_operation_check";--> statement-breakpoint
ALTER TABLE "credit_card_statement_revisions" DROP CONSTRAINT IF EXISTS "cc_stmt_revisions_status_check";--> statement-breakpoint
ALTER TABLE "credit_card_statement_revisions" ADD COLUMN IF NOT EXISTS "payment_event_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_card_ledger_links" ADD CONSTRAINT "credit_card_ledger_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_ledger_links" ADD CONSTRAINT "credit_card_ledger_links_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_ledger_links" ADD CONSTRAINT "credit_card_ledger_links_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_event_revisions" ADD CONSTRAINT "credit_card_liability_event_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_event_revisions" ADD CONSTRAINT "credit_card_liability_event_revisions_event_id_credit_card_liability_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."credit_card_liability_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_event_revisions" ADD CONSTRAINT "credit_card_liability_event_revisions_previous_revision_id_credit_card_liability_event_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."credit_card_liability_event_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_event_revisions" ADD CONSTRAINT "credit_card_liability_event_revisions_canonical_revision_id_transaction_revisions_id_fk" FOREIGN KEY ("canonical_revision_id") REFERENCES "public"."transaction_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_events" ADD CONSTRAINT "credit_card_liability_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_events" ADD CONSTRAINT "credit_card_liability_events_credit_card_id_credit_cards_id_fk" FOREIGN KEY ("credit_card_id") REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_liability_events" ADD CONSTRAINT "credit_card_liability_events_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_payment_events" ADD CONSTRAINT "credit_card_statement_payment_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_payment_events" ADD CONSTRAINT "credit_card_statement_payment_events_statement_id_credit_card_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."credit_card_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_payment_events" ADD CONSTRAINT "credit_card_statement_payment_events_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_statement_payment_events" ADD CONSTRAINT "credit_card_statement_payment_events_payment_asset_account_id_ledger_accounts_id_fk" FOREIGN KEY ("payment_asset_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_system_accounts" ADD CONSTRAINT "credit_card_system_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_system_accounts" ADD CONSTRAINT "credit_card_system_accounts_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_ledger_links_card_idx" ON "credit_card_ledger_links" USING btree ("credit_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_ledger_links_account_idx" ON "credit_card_ledger_links" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_ledger_links_user_idx" ON "credit_card_ledger_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_liability_event_revisions_event_rev_idx" ON "credit_card_liability_event_revisions" USING btree ("event_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_liability_event_revisions_user_idempotency_idx" ON "credit_card_liability_event_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_liability_event_revisions_prev_rev_idx" ON "credit_card_liability_event_revisions" USING btree ("previous_revision_id") WHERE "credit_card_liability_event_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_liability_event_revisions_event_idx" ON "credit_card_liability_event_revisions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_liability_event_revisions_user_idx" ON "credit_card_liability_event_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_liability_event_revisions_purchase_date_idx" ON "credit_card_liability_event_revisions" USING btree ("purchase_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_liability_events_canonical_tx_idx" ON "credit_card_liability_events" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_liability_events_card_opening_idx" ON "credit_card_liability_events" USING btree ("credit_card_id") WHERE "credit_card_liability_events"."event_type" = 'OPENING_BALANCE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_liability_events_card_idx" ON "credit_card_liability_events" USING btree ("credit_card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_liability_events_user_idx" ON "credit_card_liability_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_stmt_payment_events_canonical_tx_idx" ON "credit_card_statement_payment_events" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_stmt_payment_events_stmt_idx" ON "credit_card_statement_payment_events" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_stmt_payment_events_user_idx" ON "credit_card_statement_payment_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_stmt_payment_events_asset_account_idx" ON "credit_card_statement_payment_events" USING btree ("payment_asset_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_system_accounts_user_role_idx" ON "credit_card_system_accounts" USING btree ("user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_system_accounts_account_idx" ON "credit_card_system_accounts" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_system_accounts_user_idx" ON "credit_card_system_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_stmt_revisions_payment_event_idx" ON "credit_card_statement_revisions" USING btree ("payment_event_id");--> statement-breakpoint
ALTER TABLE "credit_card_statement_revisions" ADD CONSTRAINT "cc_stmt_revisions_operation_check" CHECK ("credit_card_statement_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID', 'PAY', 'REOPEN'));--> statement-breakpoint
ALTER TABLE "credit_card_statement_revisions" ADD CONSTRAINT "cc_stmt_revisions_status_check" CHECK ("credit_card_statement_revisions"."status" IN ('OPEN', 'VOID', 'PAID'));--> statement-breakpoint

-- ============================================================================
-- 1. IMMUTABILITY TRIGGERS FOR NEW TABLES
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_ledger_links_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_ledger_links rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_ledger_links rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_ledger_links_immutable ON "credit_card_ledger_links";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_ledger_links_immutable
BEFORE UPDATE OR DELETE ON "credit_card_ledger_links"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_ledger_links_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_system_accounts_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_system_accounts rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_system_accounts rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_system_accounts_immutable ON "credit_card_system_accounts";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_system_accounts_immutable
BEFORE UPDATE OR DELETE ON "credit_card_system_accounts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_system_accounts_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_events_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_liability_events rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_liability_events rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_events_immutable ON "credit_card_liability_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_liability_events_immutable
BEFORE UPDATE OR DELETE ON "credit_card_liability_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_liability_events_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_revisions_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_liability_event_revisions rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_liability_event_revisions rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_event_revisions_immutable ON "credit_card_liability_event_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_liability_event_revisions_immutable
BEFORE UPDATE OR DELETE ON "credit_card_liability_event_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_liability_event_revisions_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_payment_events_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_statement_payment_events rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_statement_payment_events rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_stmt_payment_events_immutable ON "credit_card_statement_payment_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_stmt_payment_events_immutable
BEFORE UPDATE OR DELETE ON "credit_card_statement_payment_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_stmt_payment_events_immutable();--> statement-breakpoint

-- ============================================================================
-- 2. GUARDS FOR LEDGER LINKS & SYSTEM ACCOUNTS
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_ledger_link_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_card RECORD;
	v_acc RECORD;
	v_user_currency VARCHAR(3);
BEGIN
	SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card % not found', NEW.credit_card_id;
	END IF;
	IF v_card.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Card user_id % does not match link user_id %', v_card.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_acc FROM ledger_accounts WHERE id = NEW.ledger_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Ledger account % not found', NEW.ledger_account_id;
	END IF;
	IF v_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Ledger account user_id % does not match link user_id %', v_acc.user_id, NEW.user_id;
	END IF;
	IF v_acc.account_type != 'LIABILITY' THEN
		RAISE EXCEPTION 'Linked credit card ledger account % must have account_type LIABILITY, found %', NEW.ledger_account_id, v_acc.account_type;
	END IF;
	IF v_acc.normal_balance != 'CREDIT' THEN
		RAISE EXCEPTION 'Linked credit card ledger account % must have normal_balance CREDIT, found %', NEW.ledger_account_id, v_acc.normal_balance;
	END IF;
	IF v_acc.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot link archived ledger account %', NEW.ledger_account_id;
	END IF;

	SELECT currency INTO v_user_currency FROM users WHERE id = NEW.user_id;
	IF v_acc.currency != v_user_currency THEN
		RAISE EXCEPTION 'Linked ledger account currency % does not match user currency %', v_acc.currency, v_user_currency;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_ledger_link_insert ON "credit_card_ledger_links";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_ledger_link_insert
BEFORE INSERT ON "credit_card_ledger_links"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_ledger_link_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_system_account_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_acc RECORD;
	v_user_currency VARCHAR(3);
BEGIN
	SELECT * INTO v_acc FROM ledger_accounts WHERE id = NEW.ledger_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Ledger account % not found', NEW.ledger_account_id;
	END IF;
	IF v_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Ledger account user_id % does not match system account user_id %', v_acc.user_id, NEW.user_id;
	END IF;
	IF v_acc.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot link archived ledger account %', NEW.ledger_account_id;
	END IF;

	SELECT currency INTO v_user_currency FROM users WHERE id = NEW.user_id;
	IF v_acc.currency != v_user_currency THEN
		RAISE EXCEPTION 'System ledger account currency % does not match user currency %', v_acc.currency, v_user_currency;
	END IF;

	IF NEW.role IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_EXPENSE', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED_EXPENSE') THEN
		IF v_acc.account_type != 'EXPENSE' OR v_acc.normal_balance != 'DEBIT' THEN
			RAISE EXCEPTION 'System account for role % must be EXPENSE/DEBIT, found %/%', NEW.role, v_acc.account_type, v_acc.normal_balance;
		END IF;
	ELSIF NEW.role = 'OPENING_EQUITY' THEN
		IF v_acc.account_type != 'EQUITY' OR v_acc.normal_balance != 'CREDIT' THEN
			RAISE EXCEPTION 'System account for role OPENING_EQUITY must be EQUITY/CREDIT, found %/%', v_acc.account_type, v_acc.normal_balance;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_system_account_insert ON "credit_card_system_accounts";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_system_account_insert
BEFORE INSERT ON "credit_card_system_accounts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_system_account_insert();--> statement-breakpoint

-- ============================================================================
-- 3. ARCHIVE GUARD TRIGGER FOR LEDGER ACCOUNTS (PROTECTS CC & SYSTEM ACCOUNTS)
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
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_ledger_accounts_archive ON "ledger_accounts";--> statement-breakpoint
CREATE TRIGGER trg_guard_ledger_accounts_archive
BEFORE UPDATE ON "ledger_accounts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_ledger_accounts_archive();--> statement-breakpoint

-- ============================================================================
-- 4. CARD REVISION INSERT GUARD (EXTENDED FOR LIABILITY BALANCE & OPEN STMTS)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_card RECORD;
	v_latest RECORD;
	v_liability_acc_id UUID;
	v_liability_balance NUMERIC;
BEGIN
	-- Validate card anchor exists and lock FOR UPDATE to serialize revision creation & archive
	SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card % not found', NEW.credit_card_id;
	END IF;
	IF v_card.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Card user_id % does not match revision user_id %', v_card.user_id, NEW.user_id;
	END IF;

	-- Check current latest revision
	SELECT id, revision_no, status, display_name, issuer, statement_day, due_day, credit_limit, last_four, note, change_reason
	INTO v_latest
	FROM credit_card_revisions
	WHERE credit_card_id = NEW.credit_card_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Card % already has revisions; revision 1 cannot be created again', NEW.credit_card_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'First revision must have status ACTIVE, found %', NEW.status;
		END IF;
		IF NEW.change_reason IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have change_reason NULL';
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for card %', NEW.credit_card_id;
		END IF;
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of card % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.credit_card_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status = 'ARCHIVED' THEN
			RAISE EXCEPTION 'Cannot create revision on archived card %', NEW.credit_card_id;
		END IF;

		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		ELSIF NEW.operation = 'UPDATE' THEN
			IF NEW.status != 'ACTIVE' THEN
				RAISE EXCEPTION 'UPDATE operation must retain ACTIVE status, found %', NEW.status;
			END IF;
		ELSIF NEW.operation = 'ARCHIVE' THEN
			IF NEW.status != 'ARCHIVED' THEN
				RAISE EXCEPTION 'ARCHIVE operation must set ARCHIVED status, found %', NEW.status;
			END IF;
			-- Verify all config fields are copied exactly from predecessor
			IF NEW.display_name != v_latest.display_name OR
			   NEW.issuer != v_latest.issuer OR
			   NEW.statement_day != v_latest.statement_day OR
			   NEW.due_day != v_latest.due_day OR
			   NEW.credit_limit != v_latest.credit_limit OR
			   (NEW.last_four IS DISTINCT FROM v_latest.last_four) OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'ARCHIVE revision must copy all config fields exactly from predecessor';
			END IF;
			-- Verify no OPEN statements exist for this card
			IF EXISTS (
				SELECT 1 FROM credit_card_statements s
				WHERE s.credit_card_id = NEW.credit_card_id
				  AND s.user_id = NEW.user_id
				  AND EXISTS (
					SELECT 1 FROM credit_card_statement_revisions r
					WHERE r.statement_id = s.id
					ORDER BY r.revision_no DESC
					LIMIT 1
				  )
				  AND (
					SELECT r2.status FROM credit_card_statement_revisions r2
					WHERE r2.statement_id = s.id
					ORDER BY r2.revision_no DESC
					LIMIT 1
				  ) = 'OPEN'
			) THEN
				RAISE EXCEPTION 'Cannot archive card % with OPEN statements', NEW.credit_card_id;
			END IF;
			-- Verify card liability balance is 0.00
			SELECT ledger_account_id INTO v_liability_acc_id
			FROM credit_card_ledger_links
			WHERE credit_card_id = NEW.credit_card_id;

			IF v_liability_acc_id IS NOT NULL THEN
				SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0.00) INTO v_liability_balance
				FROM journal_lines jl
				JOIN journal_entries je ON jl.journal_entry_id = je.id
				WHERE jl.account_id = v_liability_acc_id
				  AND je.status = 'POSTED';

				IF v_liability_balance != 0.00 THEN
					RAISE EXCEPTION 'Cannot archive credit card % with non-zero liability balance %', NEW.credit_card_id, v_liability_balance;
				END IF;
			END IF;
		ELSE
			RAISE EXCEPTION 'Invalid card operation %', NEW.operation;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_revision_insert ON "credit_card_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_revision_insert
BEFORE INSERT ON "credit_card_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 5. LIABILITY EVENT INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_card RECORD;
	v_card_rev RECORD;
	v_can_tx RECORD;
BEGIN
	-- Lock card anchor FOR UPDATE
	SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card % not found', NEW.credit_card_id;
	END IF;
	IF v_card.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Card user_id % does not match event user_id %', v_card.user_id, NEW.user_id;
	END IF;

	-- Verify card is ACTIVE
	SELECT r.status INTO v_card_rev
	FROM credit_card_revisions r
	WHERE r.credit_card_id = NEW.credit_card_id
	ORDER BY r.revision_no DESC
	LIMIT 1;
	IF NOT FOUND OR v_card_rev.status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot create liability event on non-ACTIVE card %', NEW.credit_card_id;
	END IF;

	-- Verify card has a linked liability account
	IF NOT EXISTS (SELECT 1 FROM credit_card_ledger_links WHERE credit_card_id = NEW.credit_card_id) THEN
		RAISE EXCEPTION 'Card % does not have a linked ledger liability account', NEW.credit_card_id;
	END IF;

	-- Verify canonical transaction matches
	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = NEW.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', NEW.canonical_transaction_id;
	END IF;
	IF v_can_tx.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical transaction user_id % does not match event user_id %', v_can_tx.user_id, NEW.user_id;
	END IF;

	IF NEW.event_type = 'PURCHASE' THEN
		IF v_can_tx.kind != 'CREDIT_CARD_PURCHASE' THEN
			RAISE EXCEPTION 'PURCHASE event must have canonical transaction kind CREDIT_CARD_PURCHASE, found %', v_can_tx.kind;
		END IF;
	ELSIF NEW.event_type = 'OPENING_BALANCE' THEN
		IF v_can_tx.kind != 'CREDIT_CARD_OPENING_BALANCE' THEN
			RAISE EXCEPTION 'OPENING_BALANCE event must have canonical transaction kind CREDIT_CARD_OPENING_BALANCE, found %', v_can_tx.kind;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_event_insert ON "credit_card_liability_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_liability_event_insert
BEFORE INSERT ON "credit_card_liability_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_liability_event_insert();--> statement-breakpoint

-- ============================================================================
-- 6. LIABILITY EVENT REVISION INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_latest RECORD;
	v_can_rev RECORD;
	v_expected_purchase_date date;
BEGIN
	-- Lock liability event anchor FOR UPDATE
	SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.event_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Liability event % not found', NEW.event_id;
	END IF;
	IF v_event.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Event user_id % does not match revision user_id %', v_event.user_id, NEW.user_id;
	END IF;

	-- Verify canonical revision
	SELECT * INTO v_can_rev FROM transaction_revisions WHERE id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical revision % not found', NEW.canonical_revision_id;
	END IF;
	IF v_can_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical revision user_id % does not match revision user_id %', v_can_rev.user_id, NEW.user_id;
	END IF;
	IF v_can_rev.transaction_id != v_event.canonical_transaction_id THEN
		RAISE EXCEPTION 'Canonical revision transaction_id % does not match event canonical_transaction_id %',
			v_can_rev.transaction_id, v_event.canonical_transaction_id;
	END IF;

	-- Check latest projection revision
	SELECT id, revision_no, operation, amount, budget_category, merchant, description, installment_count, purchase_date
	INTO v_latest
	FROM credit_card_liability_event_revisions
	WHERE event_id = NEW.event_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Event % already has revisions; revision 1 cannot be created again', NEW.event_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for event %', NEW.event_id;
		END IF;
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of event % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.event_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.operation = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID event %', NEW.event_id;
		END IF;

		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		END IF;
	END IF;

	-- Validate field rules according to event_type
	IF v_event.event_type = 'PURCHASE' THEN
		IF NEW.budget_category IS NULL THEN
			RAISE EXCEPTION 'PURCHASE revision requires budget_category';
		END IF;
		IF NEW.purchase_date IS NULL THEN
			RAISE EXCEPTION 'PURCHASE revision requires purchase_date';
		END IF;
		v_expected_purchase_date := (NEW.occurred_at AT TIME ZONE 'Europe/Istanbul')::date;
		IF NEW.purchase_date != v_expected_purchase_date THEN
			RAISE EXCEPTION 'purchase_date % must match Istanbul date % from occurred_at %',
				NEW.purchase_date, v_expected_purchase_date, NEW.occurred_at;
		END IF;
	ELSIF v_event.event_type = 'OPENING_BALANCE' THEN
		IF NEW.budget_category IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have budget_category NULL';
		END IF;
		IF NEW.purchase_date IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have purchase_date NULL';
		END IF;
		IF NEW.installment_count IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have installment_count NULL';
		END IF;
		IF NEW.merchant IS NOT NULL THEN
			RAISE EXCEPTION 'OPENING_BALANCE revision must have merchant NULL';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_event_revision_insert ON "credit_card_liability_event_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_liability_event_revision_insert
BEFORE INSERT ON "credit_card_liability_event_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_liability_event_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 7. DEFERRED COMMIT-TIME LIABILITY LEDGER EFFECT INVARIANT
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_ledger_effect()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_binding RECORD;
	v_liability_acc_id UUID;
	v_expense_role VARCHAR(32);
	v_expense_acc_id UUID;
	v_line_count INT;
	v_cr_line RECORD;
	v_dr_line RECORD;
BEGIN
	SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.event_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT * INTO v_binding FROM transaction_ledger_bindings WHERE revision_id = NEW.canonical_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'No ledger binding found for canonical revision %', NEW.canonical_revision_id;
	END IF;

	SELECT ledger_account_id INTO v_liability_acc_id
	FROM credit_card_ledger_links
	WHERE credit_card_id = v_event.credit_card_id;
	IF v_liability_acc_id IS NULL THEN
		RAISE EXCEPTION 'No linked liability account found for card %', v_event.credit_card_id;
	END IF;

	IF NEW.operation IN ('CREATE', 'UPDATE') THEN
		IF v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Applied journal entry missing for active liability revision %', NEW.id;
		END IF;

		-- Determine target expense or opening equity role
		IF v_event.event_type = 'PURCHASE' THEN
			IF NEW.budget_category = 'MANDATORY_EXPENSE' THEN
				v_expense_role := 'MANDATORY_EXPENSE';
			ELSIF NEW.budget_category = 'DISCRETIONARY_SPEND' THEN
				v_expense_role := 'DISCRETIONARY_EXPENSE';
			ELSIF NEW.budget_category = 'SHORT_TERM_PURCHASE' THEN
				v_expense_role := 'SHORT_TERM_PURCHASE';
			ELSIF NEW.budget_category = 'UNCLASSIFIED' THEN
				v_expense_role := 'UNCLASSIFIED_EXPENSE';
			ELSE
				RAISE EXCEPTION 'Unknown budget category %', NEW.budget_category;
			END IF;
		ELSE
			v_expense_role := 'OPENING_EQUITY';
		END IF;

		SELECT ledger_account_id INTO v_expense_acc_id
		FROM credit_card_system_accounts
		WHERE user_id = NEW.user_id AND role = v_expense_role;
		IF v_expense_acc_id IS NULL THEN
			RAISE EXCEPTION 'System ledger account for role % not found for user %', v_expense_role, NEW.user_id;
		END IF;

		-- Validate journal lines: exactly 2 lines
		SELECT COUNT(*) INTO v_line_count
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Liability journal entry % must have exactly 2 lines, found %',
				v_binding.applied_journal_entry_id, v_line_count;
		END IF;

		-- Credit line: card liability account
		SELECT * INTO v_cr_line
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id AND account_id = v_liability_acc_id;
		IF NOT FOUND OR v_cr_line.credit != NEW.amount OR v_cr_line.debit != 0.00 THEN
			RAISE EXCEPTION 'Liability journal entry % must credit card liability account % with exact amount %',
				v_binding.applied_journal_entry_id, v_liability_acc_id, NEW.amount;
		END IF;

		-- Debit line: expense or equity account
		SELECT * INTO v_dr_line
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id AND account_id = v_expense_acc_id;
		IF NOT FOUND OR v_dr_line.debit != NEW.amount OR v_dr_line.credit != 0.00 THEN
			RAISE EXCEPTION 'Liability journal entry % must debit system account % with exact amount %',
				v_binding.applied_journal_entry_id, v_expense_acc_id, NEW.amount;
		END IF;
	ELSIF NEW.operation = 'VOID' THEN
		IF v_binding.reversal_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Reversal journal entry missing for VOID liability revision %', NEW.id;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_ledger_effect ON "credit_card_liability_event_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_liability_ledger_effect
AFTER INSERT ON "credit_card_liability_event_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_liability_ledger_effect();--> statement-breakpoint

-- ============================================================================
-- 8. STATEMENT PAYMENT EVENT INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_payment_event_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_can_tx RECORD;
	v_asset_acc RECORD;
BEGIN
	-- Validate statement exists, belongs to user, and lock statement FOR UPDATE
	SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Statement % not found', NEW.statement_id;
	END IF;
	IF v_stmt.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Statement user_id % does not match payment event user_id %', v_stmt.user_id, NEW.user_id;
	END IF;

	-- Validate canonical transaction
	SELECT * INTO v_can_tx FROM canonical_transactions WHERE id = NEW.canonical_transaction_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Canonical transaction % not found', NEW.canonical_transaction_id;
	END IF;
	IF v_can_tx.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Canonical transaction user_id % does not match payment event user_id %', v_can_tx.user_id, NEW.user_id;
	END IF;
	IF v_can_tx.kind != 'CREDIT_CARD_STATEMENT_PAYMENT' THEN
		RAISE EXCEPTION 'Statement payment canonical transaction must have kind CREDIT_CARD_STATEMENT_PAYMENT, found %', v_can_tx.kind;
	END IF;

	-- Validate payment asset account
	SELECT * INTO v_asset_acc FROM ledger_accounts WHERE id = NEW.payment_asset_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Payment asset account % not found', NEW.payment_asset_account_id;
	END IF;
	IF v_asset_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Payment asset account user_id % does not match event user_id %', v_asset_acc.user_id, NEW.user_id;
	END IF;
	IF v_asset_acc.account_type != 'ASSET' OR v_asset_acc.normal_balance != 'DEBIT' THEN
		RAISE EXCEPTION 'Payment asset account % must be ASSET/DEBIT, found %/%',
			NEW.payment_asset_account_id, v_asset_acc.account_type, v_asset_acc.normal_balance;
	END IF;
	IF v_asset_acc.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Cannot use archived asset account % for statement payment', NEW.payment_asset_account_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_stmt_payment_event_insert ON "credit_card_statement_payment_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_stmt_payment_event_insert
BEFORE INSERT ON "credit_card_statement_payment_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_stmt_payment_event_insert();--> statement-breakpoint

-- ============================================================================
-- 9. STATEMENT REVISION INSERT GUARD (EXTENDED FOR PAY AND REOPEN)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_latest RECORD;
	v_card_rev RECORD;
	v_expected_stmt_date date;
	v_expected_due_date date;
BEGIN
	-- Validate statement anchor exists, belongs to user, and lock FOR UPDATE
	SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card statement % not found', NEW.statement_id;
	END IF;
	IF v_stmt.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Statement user_id % does not match revision user_id %', v_stmt.user_id, NEW.user_id;
	END IF;

	-- Check current latest revision
	SELECT id, revision_no, status, statement_amount, statement_date, due_date, reserve_placement, note, payment_event_id
	INTO v_latest
	FROM credit_card_statement_revisions
	WHERE statement_id = NEW.statement_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Statement % already has revisions; revision 1 cannot be created again', NEW.statement_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'CREATE' THEN
			RAISE EXCEPTION 'First revision must have operation CREATE, found %', NEW.operation;
		END IF;
		IF NEW.status != 'OPEN' THEN
			RAISE EXCEPTION 'First revision must have status OPEN, found %', NEW.status;
		END IF;
		IF NEW.payment_event_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have payment_event_id NULL';
		END IF;

		-- Fetch authoritative card configuration to verify exact statement and due dates
		SELECT r.statement_day, r.due_day, r.status INTO v_card_rev
		FROM credit_card_revisions r
		WHERE r.credit_card_id = v_stmt.credit_card_id
		ORDER BY r.revision_no DESC
		LIMIT 1;

		IF NOT FOUND OR v_card_rev.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Card % is not in ACTIVE status', v_stmt.credit_card_id;
		END IF;

		v_expected_stmt_date := cc_clamped_date(v_stmt.cycle_year, v_stmt.cycle_month, v_card_rev.statement_day);
		v_expected_due_date := cc_expected_due_date(v_expected_stmt_date, v_card_rev.due_day);

		IF NEW.statement_date != v_expected_stmt_date THEN
			RAISE EXCEPTION 'statement_date % does not match expected % for cycle %-% and statement_day %',
				NEW.statement_date, v_expected_stmt_date, v_stmt.cycle_year, v_stmt.cycle_month, v_card_rev.statement_day;
		END IF;

		IF NEW.due_date != v_expected_due_date THEN
			RAISE EXCEPTION 'due_date % does not match expected % for statement_date % and due_day %',
				NEW.due_date, v_expected_due_date, NEW.statement_date, v_card_rev.due_day;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for statement %', NEW.statement_id;
		END IF;
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;
		IF NEW.previous_revision_id != v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of statement % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.statement_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;
		IF v_latest.status = 'VOID' THEN
			RAISE EXCEPTION 'Cannot create revision on VOID statement %', NEW.statement_id;
		END IF;

		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		ELSIF NEW.operation = 'UPDATE' THEN
			IF v_latest.status != 'OPEN' THEN
				RAISE EXCEPTION 'Cannot UPDATE statement when status is %, must be OPEN', v_latest.status;
			END IF;
			IF NEW.status != 'OPEN' THEN
				RAISE EXCEPTION 'UPDATE operation must retain OPEN status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS NOT NULL THEN
				RAISE EXCEPTION 'UPDATE operation must have payment_event_id NULL';
			END IF;
			IF NEW.statement_date != v_latest.statement_date OR NEW.due_date != v_latest.due_date THEN
				RAISE EXCEPTION 'UPDATE revision must preserve statement_date and due_date from predecessor';
			END IF;
		ELSIF NEW.operation = 'VOID' THEN
			IF v_latest.status != 'OPEN' THEN
				RAISE EXCEPTION 'Cannot VOID statement when status is %, must be OPEN', v_latest.status;
			END IF;
			IF NEW.status != 'VOID' THEN
				RAISE EXCEPTION 'VOID operation must set VOID status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS NOT NULL THEN
				RAISE EXCEPTION 'VOID operation must have payment_event_id NULL';
			END IF;
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'VOID revision must copy all snapshot fields exactly from predecessor';
			END IF;
		ELSIF NEW.operation = 'PAY' THEN
			IF v_latest.status != 'OPEN' THEN
				RAISE EXCEPTION 'Cannot PAY statement when status is %, must be OPEN', v_latest.status;
			END IF;
			IF NEW.status != 'PAID' THEN
				RAISE EXCEPTION 'PAY operation must set PAID status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS NULL THEN
				RAISE EXCEPTION 'PAY operation requires non-null payment_event_id';
			END IF;
			-- Obligation snapshot must remain identical
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'PAY revision must copy all obligation snapshot fields exactly from predecessor';
			END IF;
		ELSIF NEW.operation = 'REOPEN' THEN
			IF v_latest.status != 'PAID' THEN
				RAISE EXCEPTION 'Cannot REOPEN statement when status is %, must be PAID', v_latest.status;
			END IF;
			IF NEW.status != 'OPEN' THEN
				RAISE EXCEPTION 'REOPEN operation must set OPEN status, found %', NEW.status;
			END IF;
			IF NEW.payment_event_id IS DISTINCT FROM v_latest.payment_event_id THEN
				RAISE EXCEPTION 'REOPEN operation must reference the payment_event_id being reversed';
			END IF;
			-- Obligation snapshot must remain identical
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'REOPEN revision must copy all obligation snapshot fields exactly from predecessor';
			END IF;
		ELSE
			RAISE EXCEPTION 'Invalid statement operation %', NEW.operation;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_stmt_revision_insert ON "credit_card_statement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_stmt_revision_insert
BEFORE INSERT ON "credit_card_statement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_stmt_revision_insert();--> statement-breakpoint

-- ============================================================================
-- 10. DEFERRED COMMIT-TIME STATEMENT RESERVE & PAYMENT INVARIANT
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_reserve_invariant()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_latest_rev RECORD;
	v_bucket_balance NUMERIC;
	v_pay_event RECORD;
	v_binding RECORD;
	v_can_tx RECORD;
	v_liability_acc_id UUID;
	v_cr_line RECORD;
	v_dr_line RECORD;
	v_line_count INT;
BEGIN
	-- Determine statement_id depending on table
	IF TG_TABLE_NAME = 'credit_card_statement_revisions' THEN
		SELECT cs.id, cs.credit_card_id, cs.midas_reserve_bucket_id, cs.midas_account_id, cs.user_id
		INTO v_stmt
		FROM credit_card_statements cs
		WHERE cs.id = NEW.statement_id;
	ELSIF TG_TABLE_NAME = 'midas_allocation_transfers' THEN
		SELECT cs.id, cs.credit_card_id, cs.midas_reserve_bucket_id, cs.midas_account_id, cs.user_id
		INTO v_stmt
		FROM credit_card_statements cs
		WHERE cs.midas_reserve_bucket_id IN (NEW.from_bucket_id, NEW.to_bucket_id)
		LIMIT 1;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;
	ELSE
		RETURN NULL;
	END IF;

	IF v_stmt.id IS NULL THEN
		RETURN NULL;
	END IF;

	-- Fetch latest revision for this statement
	SELECT r.id, r.revision_no, r.operation, r.status, r.statement_amount, r.reserve_placement, r.payment_event_id
	INTO v_latest_rev
	FROM credit_card_statement_revisions r
	WHERE r.statement_id = v_stmt.id
	ORDER BY r.revision_no DESC
	LIMIT 1;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	-- Compute current reserve bucket balance
	SELECT COALESCE(SUM(CASE
		WHEN to_bucket_id = v_stmt.midas_reserve_bucket_id THEN amount
		WHEN from_bucket_id = v_stmt.midas_reserve_bucket_id THEN -amount
		ELSE 0
	END), 0)
	INTO v_bucket_balance
	FROM midas_allocation_transfers
	WHERE midas_account_id = v_stmt.midas_account_id;

	-- Invariants based on latest status
	IF v_latest_rev.status = 'VOID' THEN
		IF v_bucket_balance != 0 THEN
			RAISE EXCEPTION 'VOID statement % must have reserve bucket balance 0, found %',
				v_stmt.id, v_bucket_balance;
		END IF;
	ELSIF v_latest_rev.status = 'PAID' THEN
		IF v_bucket_balance != 0 THEN
			RAISE EXCEPTION 'PAID statement % must have reserve bucket balance 0, found %',
				v_stmt.id, v_bucket_balance;
		END IF;

		-- Validate payment event & canonical transaction
		SELECT * INTO v_pay_event FROM credit_card_statement_payment_events WHERE id = v_latest_rev.payment_event_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Payment event % not found for PAID statement %', v_latest_rev.payment_event_id, v_stmt.id;
		END IF;
		IF v_pay_event.statement_id != v_stmt.id THEN
			RAISE EXCEPTION 'Payment event statement_id % does not match statement %', v_pay_event.statement_id, v_stmt.id;
		END IF;
		IF v_pay_event.amount != v_latest_rev.statement_amount THEN
			RAISE EXCEPTION 'Payment event amount % does not match statement amount %', v_pay_event.amount, v_latest_rev.statement_amount;
		END IF;

		SELECT ledger_account_id INTO v_liability_acc_id
		FROM credit_card_ledger_links
		WHERE credit_card_id = v_stmt.credit_card_id;

		-- Check latest revision of canonical payment transaction
		SELECT tr.id, tr.operation INTO v_can_tx
		FROM transaction_revisions tr
		WHERE tr.transaction_id = v_pay_event.canonical_transaction_id
		ORDER BY tr.revision_no DESC
		LIMIT 1;

		IF NOT FOUND OR v_can_tx.operation = 'VOID' THEN
			RAISE EXCEPTION 'Canonical payment transaction % must be active for PAID statement %',
				v_pay_event.canonical_transaction_id, v_stmt.id;
		END IF;

		SELECT * INTO v_binding
		FROM transaction_ledger_bindings
		WHERE revision_id = v_can_tx.id;

		IF NOT FOUND OR v_binding.applied_journal_entry_id IS NULL THEN
			RAISE EXCEPTION 'Applied journal entry missing for payment canonical revision %', v_can_tx.id;
		END IF;

		-- Verify journal lines: Dr card liability, Cr payment asset
		SELECT COUNT(*) INTO v_line_count
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id;
		IF v_line_count != 2 THEN
			RAISE EXCEPTION 'Payment journal entry % must have exactly 2 lines, found %',
				v_binding.applied_journal_entry_id, v_line_count;
		END IF;

		SELECT * INTO v_dr_line
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id AND account_id = v_liability_acc_id;
		IF NOT FOUND OR v_dr_line.debit != v_latest_rev.statement_amount OR v_dr_line.credit != 0.00 THEN
			RAISE EXCEPTION 'Payment journal entry % must debit card liability account % with exact amount %',
				v_binding.applied_journal_entry_id, v_liability_acc_id, v_latest_rev.statement_amount;
		END IF;

		SELECT * INTO v_cr_line
		FROM journal_lines
		WHERE journal_entry_id = v_binding.applied_journal_entry_id AND account_id = v_pay_event.payment_asset_account_id;
		IF NOT FOUND OR v_cr_line.credit != v_latest_rev.statement_amount OR v_cr_line.debit != 0.00 THEN
			RAISE EXCEPTION 'Payment journal entry % must credit payment asset account % with exact amount %',
				v_binding.applied_journal_entry_id, v_pay_event.payment_asset_account_id, v_latest_rev.statement_amount;
		END IF;
	ELSIF v_latest_rev.status = 'OPEN' THEN
		IF v_latest_rev.reserve_placement = 'MIDAS_FUND' THEN
			IF v_bucket_balance != v_latest_rev.statement_amount THEN
				RAISE EXCEPTION 'OPEN MIDAS_FUND statement % must have reserve bucket balance exactly %, found %',
					v_stmt.id, v_latest_rev.statement_amount, v_bucket_balance;
			END IF;
		ELSIF v_latest_rev.reserve_placement = 'OUTSIDE_MIDAS' THEN
			IF v_bucket_balance != 0 THEN
				RAISE EXCEPTION 'OPEN OUTSIDE_MIDAS statement % must have reserve bucket balance 0, found %',
					v_stmt.id, v_bucket_balance;
			END IF;
		END IF;

		IF v_latest_rev.operation = 'REOPEN' THEN
			-- Check that the payment canonical transaction has been VOIDED with reversal journal entry
			SELECT * INTO v_pay_event FROM credit_card_statement_payment_events WHERE id = v_latest_rev.payment_event_id;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Payment event % not found for REOPEN statement %', v_latest_rev.payment_event_id, v_stmt.id;
			END IF;

			SELECT tr.id, tr.operation INTO v_can_tx
			FROM transaction_revisions tr
			WHERE tr.transaction_id = v_pay_event.canonical_transaction_id
			ORDER BY tr.revision_no DESC
			LIMIT 1;

			IF NOT FOUND OR v_can_tx.operation != 'VOID' THEN
				RAISE EXCEPTION 'Canonical payment transaction % must be VOIDED for REOPEN statement %',
					v_pay_event.canonical_transaction_id, v_stmt.id;
			END IF;

			SELECT * INTO v_binding
			FROM transaction_ledger_bindings
			WHERE revision_id = v_can_tx.id;

			IF NOT FOUND OR v_binding.reversal_journal_entry_id IS NULL THEN
				RAISE EXCEPTION 'Reversal journal entry missing for VOID payment revision %', v_can_tx.id;
			END IF;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_reserve_invariant_on_stmt_rev ON "credit_card_statement_revisions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_reserve_invariant_on_stmt_rev
AFTER INSERT ON "credit_card_statement_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_reserve_invariant();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_reserve_invariant_on_transfers ON "midas_allocation_transfers";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_reserve_invariant_on_transfers
AFTER INSERT ON "midas_allocation_transfers"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_reserve_invariant();--> statement-breakpoint

-- ============================================================================
-- 11. DEFERRED COMMIT-TIME ANCHOR REVISION COMPLETENESS (EXTENDED FOR EVENTS)
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_anchor_has_revision()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_TABLE_NAME = 'credit_cards' THEN
		IF NOT EXISTS (
			SELECT 1 FROM credit_card_revisions
			WHERE credit_card_id = NEW.id AND revision_no = 1
		) THEN
			RAISE EXCEPTION 'credit_cards anchor % must have revision 1 committed', NEW.id;
		END IF;
	ELSIF TG_TABLE_NAME = 'credit_card_statements' THEN
		IF NOT EXISTS (
			SELECT 1 FROM credit_card_statement_revisions
			WHERE statement_id = NEW.id AND revision_no = 1
		) THEN
			RAISE EXCEPTION 'credit_card_statements anchor % must have revision 1 committed', NEW.id;
		END IF;
	ELSIF TG_TABLE_NAME = 'credit_card_liability_events' THEN
		IF NOT EXISTS (
			SELECT 1 FROM credit_card_liability_event_revisions
			WHERE event_id = NEW.id AND revision_no = 1
		) THEN
			RAISE EXCEPTION 'credit_card_liability_events anchor % must have revision 1 committed', NEW.id;
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_credit_cards_has_revision ON "credit_cards";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_credit_cards_has_revision
AFTER INSERT ON "credit_cards"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_anchor_has_revision();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_statements_has_revision ON "credit_card_statements";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_statements_has_revision
AFTER INSERT ON "credit_card_statements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_anchor_has_revision();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_liability_events_has_revision ON "credit_card_liability_events";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_cc_liability_events_has_revision
AFTER INSERT ON "credit_card_liability_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_cc_anchor_has_revision();