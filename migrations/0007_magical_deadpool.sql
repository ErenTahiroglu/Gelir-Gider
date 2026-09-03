CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"posting_fingerprint" varchar(64) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" varchar(10) DEFAULT 'DRAFT' NOT NULL,
	"posted_at" timestamp with time zone,
	"memo" varchar(500),
	"source_type" varchar(64),
	"source_ref" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_status_check" CHECK ("journal_entries"."status" IN ('DRAFT', 'POSTED')),
	CONSTRAINT "journal_entries_posted_at_check" CHECK (("journal_entries"."status" = 'DRAFT' AND "journal_entries"."posted_at" IS NULL) OR ("journal_entries"."status" = 'POSTED' AND "journal_entries"."posted_at" IS NOT NULL)),
	CONSTRAINT "journal_entries_currency_check" CHECK ("journal_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "journal_entries_fingerprint_check" CHECK ("journal_entries"."posting_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "journal_entries_idempotency_check" CHECK (length(trim("journal_entries"."idempotency_key")) >= 1 AND length("journal_entries"."idempotency_key") <= 128),
	CONSTRAINT "journal_entries_source_check" CHECK (("journal_entries"."source_type" IS NULL AND "journal_entries"."source_ref" IS NULL) OR ("journal_entries"."source_type" IS NOT NULL AND "journal_entries"."source_ref" IS NOT NULL)),
	CONSTRAINT "journal_entries_memo_check" CHECK ("journal_entries"."memo" IS NULL OR length("journal_entries"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"credit" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"memo" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_line_no_check" CHECK ("journal_lines"."line_no" > 0),
	CONSTRAINT "journal_lines_debit_check" CHECK ("journal_lines"."debit" >= 0),
	CONSTRAINT "journal_lines_credit_check" CHECK ("journal_lines"."credit" >= 0),
	CONSTRAINT "journal_lines_single_sided_check" CHECK (("journal_lines"."debit" > 0 AND "journal_lines"."credit" = 0) OR ("journal_lines"."credit" > 0 AND "journal_lines"."debit" = 0)),
	CONSTRAINT "journal_lines_memo_check" CHECK ("journal_lines"."memo" IS NULL OR length("journal_lines"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"normal_balance" varchar(10) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ledger_accounts_type_check" CHECK ("ledger_accounts"."account_type" IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
	CONSTRAINT "ledger_accounts_normal_balance_check" CHECK (("ledger_accounts"."account_type" IN ('ASSET', 'EXPENSE') AND "ledger_accounts"."normal_balance" = 'DEBIT') OR ("ledger_accounts"."account_type" IN ('LIABILITY', 'EQUITY', 'INCOME') AND "ledger_accounts"."normal_balance" = 'CREDIT')),
	CONSTRAINT "ledger_accounts_code_check" CHECK ("ledger_accounts"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "ledger_accounts_name_check" CHECK (length(trim("ledger_accounts"."name")) >= 1 AND length("ledger_accounts"."name") <= 100),
	CONSTRAINT "ledger_accounts_currency_check" CHECK ("ledger_accounts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_user_idempotency_idx" ON "journal_entries" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "journal_entries_user_occurred_idx" ON "journal_entries" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_idx" ON "journal_lines" USING btree ("journal_entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_journal_entry_idx" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_user_code_idx" ON "ledger_accounts" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX "ledger_accounts_user_id_idx" ON "ledger_accounts" USING btree ("user_id");--> statement-breakpoint

-- 1. Account identity and delete protection triggers
CREATE OR REPLACE FUNCTION trg_fn_protect_ledger_accounts()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'ledger_accounts hard delete is prohibited';
	END IF;

	IF TG_OP = 'UPDATE' THEN
		IF OLD.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'ledger_accounts user_id is immutable';
		END IF;
		IF OLD.code != NEW.code THEN
			RAISE EXCEPTION 'ledger_accounts code is immutable';
		END IF;
		IF OLD.account_type != NEW.account_type THEN
			RAISE EXCEPTION 'ledger_accounts account_type is immutable';
		END IF;
		IF OLD.normal_balance != NEW.normal_balance THEN
			RAISE EXCEPTION 'ledger_accounts normal_balance is immutable';
		END IF;
		IF OLD.currency != NEW.currency THEN
			RAISE EXCEPTION 'ledger_accounts currency is immutable';
		END IF;
		IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
			RAISE EXCEPTION 'ledger_accounts cannot be unarchived';
		END IF;
		RETURN NEW;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_protect_ledger_accounts_update
BEFORE UPDATE ON "ledger_accounts"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_ledger_accounts();--> statement-breakpoint

CREATE TRIGGER trg_protect_ledger_accounts_delete
BEFORE DELETE ON "ledger_accounts"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_protect_ledger_accounts();--> statement-breakpoint

-- 2. Journal entry INSERT guard trigger (entries must be created as DRAFT)
CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_insert()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.status != 'DRAFT' THEN
		RAISE EXCEPTION 'Direct insertion of non-DRAFT journal entries is prohibited. New entries must start in DRAFT status.';
	END IF;
	IF NEW.posted_at IS NOT NULL THEN
		RAISE EXCEPTION 'New journal entries must have null posted_at.';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_journal_entries_insert
BEFORE INSERT ON "journal_entries"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_journal_entries_insert();--> statement-breakpoint

-- 3. Journal lines mutability guard trigger (lines can only be mutated while parent is DRAFT)
CREATE OR REPLACE FUNCTION trg_fn_guard_journal_lines_mutability()
RETURNS TRIGGER AS $$
DECLARE
	v_parent_status varchar(10);
BEGIN
	IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
		SELECT status INTO v_parent_status FROM "journal_entries" WHERE id = NEW.journal_entry_id;
		IF v_parent_status IS NULL THEN
			RAISE EXCEPTION 'Parent journal entry % does not exist', NEW.journal_entry_id;
		END IF;
		IF v_parent_status != 'DRAFT' THEN
			RAISE EXCEPTION 'Cannot insert or modify journal lines on a % journal entry', v_parent_status;
		END IF;
		RETURN NEW;
	ELSIF TG_OP = 'DELETE' THEN
		SELECT status INTO v_parent_status FROM "journal_entries" WHERE id = OLD.journal_entry_id;
		IF v_parent_status IS NULL OR v_parent_status != 'DRAFT' THEN
			RAISE EXCEPTION 'Cannot delete journal lines on a non-DRAFT journal entry';
		END IF;
		RETURN OLD;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_journal_lines_mutability
BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_journal_lines_mutability();--> statement-breakpoint

-- 4. Journal entry transition & immutability trigger
CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition()
RETURNS TRIGGER AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric(18, 2);
	v_credit_sum numeric(18, 2);
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'Journal entries cannot be deleted';
	END IF;

	IF TG_OP = 'UPDATE' THEN
		IF OLD.status = 'POSTED' THEN
			RAISE EXCEPTION 'POSTED journal entries are immutable and cannot be updated';
		END IF;

		IF OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
			IF NEW.posted_at IS NULL THEN
				RAISE EXCEPTION 'Transitioning to POSTED requires non-null posted_at';
			END IF;

			-- Validate double-entry balance and line count
			SELECT
				COUNT(*),
				COALESCE(SUM(debit), 0),
				COALESCE(SUM(credit), 0)
			INTO
				v_line_count,
				v_debit_sum,
				v_credit_sum
			FROM "journal_lines"
			WHERE journal_entry_id = NEW.id;

			IF v_line_count < 2 THEN
				RAISE EXCEPTION 'Journal entry must have at least 2 lines to be POSTED (found %)', v_line_count;
			END IF;

			IF v_debit_sum != v_credit_sum THEN
				RAISE EXCEPTION 'Journal entry lines are unbalanced: DEBIT=% != CREDIT=%', v_debit_sum, v_credit_sum;
			END IF;

			IF v_debit_sum <= 0 THEN
				RAISE EXCEPTION 'Journal entry total must be strictly positive (found %)', v_debit_sum;
			END IF;

			-- Validate that all accounts belong to same user, same currency, and are not archived
			IF EXISTS (
				SELECT 1
				FROM "journal_lines" jl
				JOIN "ledger_accounts" la ON la.id = jl.account_id
				WHERE jl.journal_entry_id = NEW.id
				  AND (
					la.user_id != NEW.user_id
					OR la.currency != NEW.currency
					OR la.archived_at IS NOT NULL
				  )
			) THEN
				RAISE EXCEPTION 'One or more accounts in journal lines do not match user_id/currency or are archived';
			END IF;

			RETURN NEW;
		END IF;

		IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
			RETURN NEW;
		END IF;

		RAISE EXCEPTION 'Invalid journal entry status transition from % to %', OLD.status, NEW.status;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_journal_entries_transition
BEFORE UPDATE ON "journal_entries"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_journal_entries_transition();--> statement-breakpoint

CREATE TRIGGER trg_guard_journal_entries_delete
BEFORE DELETE ON "journal_entries"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_journal_entries_transition();