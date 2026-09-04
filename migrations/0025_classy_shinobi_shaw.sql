CREATE TABLE IF NOT EXISTS "credit_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	"code" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_cards_code_check" CHECK ("credit_cards"."code" ~ '^[A-Z][A-Z0-9_]{1,31}$')
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "credit_card_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	"credit_card_id" uuid NOT NULL REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid REFERENCES "public"."credit_card_revisions"("id") ON DELETE restrict ON UPDATE no action,
	"operation" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"issuer" varchar(120) NOT NULL,
	"statement_day" integer NOT NULL,
	"due_day" integer NOT NULL,
	"credit_limit" numeric(18, 2) NOT NULL,
	"last_four" varchar(4),
	"note" varchar(500),
	"change_reason" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_revisions_rev_no_check" CHECK ("credit_card_revisions"."revision_no" > 0),
	CONSTRAINT "cc_revisions_operation_check" CHECK ("credit_card_revisions"."operation" IN ('CREATE', 'UPDATE', 'ARCHIVE')),
	CONSTRAINT "cc_revisions_status_check" CHECK ("credit_card_revisions"."status" IN ('ACTIVE', 'ARCHIVED')),
	CONSTRAINT "cc_revisions_display_name_check" CHECK ("credit_card_revisions"."display_name" = btrim("credit_card_revisions"."display_name") AND length("credit_card_revisions"."display_name") >= 1 AND length("credit_card_revisions"."display_name") <= 120),
	CONSTRAINT "cc_revisions_issuer_check" CHECK ("credit_card_revisions"."issuer" = btrim("credit_card_revisions"."issuer") AND length("credit_card_revisions"."issuer") >= 1 AND length("credit_card_revisions"."issuer") <= 120),
	CONSTRAINT "cc_revisions_statement_day_check" CHECK ("credit_card_revisions"."statement_day" >= 1 AND "credit_card_revisions"."statement_day" <= 31),
	CONSTRAINT "cc_revisions_due_day_check" CHECK ("credit_card_revisions"."due_day" >= 1 AND "credit_card_revisions"."due_day" <= 31),
	CONSTRAINT "cc_revisions_credit_limit_check" CHECK ("credit_card_revisions"."credit_limit" > 0),
	CONSTRAINT "cc_revisions_last_four_check" CHECK ("credit_card_revisions"."last_four" IS NULL OR ("credit_card_revisions"."last_four" ~ '^[0-9]{4}$')),
	CONSTRAINT "cc_revisions_note_check" CHECK ("credit_card_revisions"."note" IS NULL OR ("credit_card_revisions"."note" = btrim("credit_card_revisions"."note") AND length("credit_card_revisions"."note") >= 1 AND length("credit_card_revisions"."note") <= 500)),
	CONSTRAINT "cc_revisions_change_reason_check" CHECK ("credit_card_revisions"."change_reason" IS NULL OR ("credit_card_revisions"."change_reason" = btrim("credit_card_revisions"."change_reason") AND length("credit_card_revisions"."change_reason") >= 1 AND length("credit_card_revisions"."change_reason") <= 500)),
	CONSTRAINT "cc_revisions_fingerprint_check" CHECK ("credit_card_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cc_revisions_idempotency_check" CHECK ("credit_card_revisions"."idempotency_key" = btrim("credit_card_revisions"."idempotency_key") AND length("credit_card_revisions"."idempotency_key") >= 1 AND length("credit_card_revisions"."idempotency_key") <= 128)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "credit_card_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	"credit_card_id" uuid NOT NULL REFERENCES "public"."credit_cards"("id") ON DELETE restrict ON UPDATE no action,
	"midas_account_id" uuid NOT NULL REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action,
	"midas_reserve_bucket_id" uuid NOT NULL REFERENCES "public"."midas_buckets"("id") ON DELETE restrict ON UPDATE no action,
	"cycle_year" integer NOT NULL,
	"cycle_month" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_statements_cycle_year_check" CHECK ("credit_card_statements"."cycle_year" >= 2000 AND "credit_card_statements"."cycle_year" <= 2200),
	CONSTRAINT "cc_statements_cycle_month_check" CHECK ("credit_card_statements"."cycle_month" >= 1 AND "credit_card_statements"."cycle_month" <= 12)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "credit_card_statement_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	"statement_id" uuid NOT NULL REFERENCES "public"."credit_card_statements"("id") ON DELETE restrict ON UPDATE no action,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid REFERENCES "public"."credit_card_statement_revisions"("id") ON DELETE restrict ON UPDATE no action,
	"operation" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"statement_amount" numeric(18, 2) NOT NULL,
	"statement_date" date NOT NULL,
	"due_date" date NOT NULL,
	"reserve_placement" varchar(20) NOT NULL,
	"note" varchar(500),
	"reason_note" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_stmt_revisions_rev_no_check" CHECK ("credit_card_statement_revisions"."revision_no" > 0),
	CONSTRAINT "cc_stmt_revisions_operation_check" CHECK ("credit_card_statement_revisions"."operation" IN ('CREATE', 'UPDATE', 'VOID')),
	CONSTRAINT "cc_stmt_revisions_status_check" CHECK ("credit_card_statement_revisions"."status" IN ('OPEN', 'VOID')),
	CONSTRAINT "cc_stmt_revisions_amount_check" CHECK ("credit_card_statement_revisions"."statement_amount" > 0),
	CONSTRAINT "cc_stmt_revisions_placement_check" CHECK ("credit_card_statement_revisions"."reserve_placement" IN ('MIDAS_FUND', 'OUTSIDE_MIDAS')),
	CONSTRAINT "cc_stmt_revisions_due_after_statement_check" CHECK ("credit_card_statement_revisions"."due_date" > "credit_card_statement_revisions"."statement_date"),
	CONSTRAINT "cc_stmt_revisions_note_check" CHECK ("credit_card_statement_revisions"."note" IS NULL OR ("credit_card_statement_revisions"."note" = btrim("credit_card_statement_revisions"."note") AND length("credit_card_statement_revisions"."note") >= 1 AND length("credit_card_statement_revisions"."note") <= 500)),
	CONSTRAINT "cc_stmt_revisions_reason_note_check" CHECK ("credit_card_statement_revisions"."reason_note" IS NULL OR ("credit_card_statement_revisions"."reason_note" = btrim("credit_card_statement_revisions"."reason_note") AND length("credit_card_statement_revisions"."reason_note") >= 1 AND length("credit_card_statement_revisions"."reason_note") <= 500)),
	CONSTRAINT "cc_stmt_revisions_fingerprint_check" CHECK ("credit_card_statement_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cc_stmt_revisions_idempotency_check" CHECK ("credit_card_statement_revisions"."idempotency_key" = btrim("credit_card_statement_revisions"."idempotency_key") AND length("credit_card_statement_revisions"."idempotency_key") >= 1 AND length("credit_card_statement_revisions"."idempotency_key") <= 128)
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "credit_card_revisions" ADD COLUMN IF NOT EXISTS "change_reason" varchar(500);
EXCEPTION
	WHEN duplicate_column THEN NULL;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "credit_cards_user_code_idx" ON "credit_cards" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_cards_user_idx" ON "credit_cards" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_revisions_card_rev_idx" ON "credit_card_revisions" USING btree ("credit_card_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_revisions_user_idempotency_idx" ON "credit_card_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_revisions_prev_rev_idx" ON "credit_card_revisions" USING btree ("previous_revision_id") WHERE "credit_card_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_revisions_card_idx" ON "credit_card_revisions" USING btree ("credit_card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_revisions_user_idx" ON "credit_card_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_statements_card_cycle_idx" ON "credit_card_statements" USING btree ("credit_card_id","cycle_year","cycle_month");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_statements_reserve_bucket_idx" ON "credit_card_statements" USING btree ("midas_reserve_bucket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_statements_card_idx" ON "credit_card_statements" USING btree ("credit_card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_statements_user_idx" ON "credit_card_statements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_statements_midas_account_idx" ON "credit_card_statements" USING btree ("midas_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_stmt_revisions_stmt_rev_idx" ON "credit_card_statement_revisions" USING btree ("statement_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_stmt_revisions_user_idempotency_idx" ON "credit_card_statement_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cc_stmt_revisions_prev_rev_idx" ON "credit_card_statement_revisions" USING btree ("previous_revision_id") WHERE "credit_card_statement_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_stmt_revisions_stmt_idx" ON "credit_card_statement_revisions" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_stmt_revisions_user_idx" ON "credit_card_statement_revisions" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- CALENDAR HELPERS (IMMUTABLE, DETERMINISTIC, TIMEZONE-AGNOSTIC)
-- ============================================================================

CREATE OR REPLACE FUNCTION cc_last_day_of_month(p_year integer, p_month integer)
RETURNS integer AS $$
BEGIN
	IF p_month IN (1, 3, 5, 7, 8, 10, 12) THEN
		RETURN 31;
	ELSIF p_month IN (4, 6, 9, 11) THEN
		RETURN 30;
	ELSIF p_month = 2 THEN
		IF (p_year % 4 = 0 AND p_year % 100 != 0) OR (p_year % 400 = 0) THEN
			RETURN 29;
		ELSE
			RETURN 28;
		END IF;
	ELSE
		RAISE EXCEPTION 'Invalid month: %', p_month;
	END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;--> statement-breakpoint

CREATE OR REPLACE FUNCTION cc_clamped_date(p_year integer, p_month integer, p_day integer)
RETURNS date AS $$
DECLARE
	v_max_day integer;
	v_actual_day integer;
BEGIN
	v_max_day := cc_last_day_of_month(p_year, p_month);
	v_actual_day := LEAST(p_day, v_max_day);
	RETURN make_date(p_year, p_month, v_actual_day);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;--> statement-breakpoint

CREATE OR REPLACE FUNCTION cc_expected_due_date(p_stmt_date date, p_due_day integer)
RETURNS date AS $$
DECLARE
	v_stmt_year integer;
	v_stmt_month integer;
	v_same_month_candidate date;
	v_next_year integer;
	v_next_month integer;
BEGIN
	v_stmt_year := EXTRACT(YEAR FROM p_stmt_date)::integer;
	v_stmt_month := EXTRACT(MONTH FROM p_stmt_date)::integer;

	v_same_month_candidate := cc_clamped_date(v_stmt_year, v_stmt_month, p_due_day);
	IF v_same_month_candidate > p_stmt_date THEN
		RETURN v_same_month_candidate;
	END IF;

	IF v_stmt_month = 12 THEN
		v_next_year := v_stmt_year + 1;
		v_next_month := 1;
	ELSE
		v_next_year := v_stmt_year;
		v_next_month := v_stmt_month + 1;
	END IF;

	RETURN cc_clamped_date(v_next_year, v_next_month, p_due_day);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;--> statement-breakpoint

-- ============================================================================
-- IMMUTABILITY TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_credit_cards_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_cards rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_cards rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_credit_cards_immutable ON "credit_cards";--> statement-breakpoint
CREATE TRIGGER trg_guard_credit_cards_immutable
BEFORE UPDATE OR DELETE ON "credit_cards"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_credit_cards_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_revisions_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_revisions rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_revisions rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_revisions_immutable ON "credit_card_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_revisions_immutable
BEFORE UPDATE OR DELETE ON "credit_card_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_revisions_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_statements_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_statements rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_statements rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_statements_immutable ON "credit_card_statements";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_statements_immutable
BEFORE UPDATE OR DELETE ON "credit_card_statements"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_statements_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_revisions_immutable()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'credit_card_statement_revisions rows are immutable; UPDATE is forbidden';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'credit_card_statement_revisions rows are immutable; DELETE is forbidden';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_stmt_revisions_immutable ON "credit_card_statement_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_stmt_revisions_immutable
BEFORE UPDATE OR DELETE ON "credit_card_statement_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_stmt_revisions_immutable();--> statement-breakpoint

-- ============================================================================
-- REPLACED TRIGGER FUNCTIONS WITH DB-LEVEL LOCKS & EXACT DATE GUARDS
-- ============================================================================

-- 5. CARD REVISION INSERT GUARD (LOCKS CARD ANCHOR FOR UPDATE)
CREATE OR REPLACE FUNCTION trg_fn_guard_cc_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_card RECORD;
	v_latest RECORD;
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
			-- Verify all config fields are copied exactly from predecessor (change_reason is audit metadata and may differ)
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

-- 6. STATEMENT IDENTITY INSERT GUARD (LOCKS CARD ANCHOR FOR UPDATE)
CREATE OR REPLACE FUNCTION trg_fn_guard_cc_statement_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_card RECORD;
	v_card_rev RECORD;
	v_bucket RECORD;
BEGIN
	-- Validate card exists, belongs to user, and lock FOR UPDATE to serialize with card archive
	SELECT * INTO v_card FROM credit_cards WHERE id = NEW.credit_card_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Credit card % not found', NEW.credit_card_id;
	END IF;
	IF v_card.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Statement user_id % does not match card user_id %', NEW.user_id, v_card.user_id;
	END IF;

	-- Validate card is currently ACTIVE
	SELECT r.status INTO v_card_rev
	FROM credit_card_revisions r
	WHERE r.credit_card_id = NEW.credit_card_id
	ORDER BY r.revision_no DESC
	LIMIT 1;
	IF NOT FOUND OR v_card_rev.status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Cannot create statement for non-ACTIVE card %', NEW.credit_card_id;
	END IF;

	-- Validate reserve bucket exists, belongs to user, belongs to user Midas account, is CREDIT_CARD_RESERVE type
	SELECT b.id, b.user_id, b.midas_account_id, b.bucket_type INTO v_bucket
	FROM midas_buckets b
	WHERE b.id = NEW.midas_reserve_bucket_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Reserve bucket % not found', NEW.midas_reserve_bucket_id;
	END IF;
	IF v_bucket.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Reserve bucket user_id % does not match statement user_id %', v_bucket.user_id, NEW.user_id;
	END IF;
	IF v_bucket.midas_account_id != NEW.midas_account_id THEN
		RAISE EXCEPTION 'Reserve bucket midas_account_id % does not match statement midas_account_id %', v_bucket.midas_account_id, NEW.midas_account_id;
	END IF;
	IF v_bucket.bucket_type != 'CREDIT_CARD_RESERVE' THEN
		RAISE EXCEPTION 'Reserve bucket % must be of type CREDIT_CARD_RESERVE, found %', NEW.midas_reserve_bucket_id, v_bucket.bucket_type;
	END IF;

	-- Ensure bucket not already attached to another statement
	IF EXISTS (
		SELECT 1 FROM credit_card_statements s
		WHERE s.midas_reserve_bucket_id = NEW.midas_reserve_bucket_id
		  AND s.id != NEW.id
	) THEN
		RAISE EXCEPTION 'Reserve bucket % is already attached to another statement', NEW.midas_reserve_bucket_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_cc_statement_insert ON "credit_card_statements";--> statement-breakpoint
CREATE TRIGGER trg_guard_cc_statement_insert
BEFORE INSERT ON "credit_card_statements"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_cc_statement_insert();--> statement-breakpoint

-- 7. STATEMENT REVISION INSERT GUARD (VERIFIES EXACT CALENDAR DATES FOR REVISION 1)
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
	SELECT id, revision_no, status, statement_amount, statement_date, due_date, reserve_placement, note
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
			IF NEW.status != 'OPEN' THEN
				RAISE EXCEPTION 'UPDATE operation must retain OPEN status, found %', NEW.status;
			END IF;
			-- Dates must remain identical to predecessor (historical snapshot)
			IF NEW.statement_date != v_latest.statement_date OR NEW.due_date != v_latest.due_date THEN
				RAISE EXCEPTION 'UPDATE revision must preserve statement_date and due_date from predecessor';
			END IF;
		ELSIF NEW.operation = 'VOID' THEN
			IF NEW.status != 'VOID' THEN
				RAISE EXCEPTION 'VOID operation must set VOID status, found %', NEW.status;
			END IF;
			-- Snapshot fields must be copied exactly from predecessor
			IF NEW.statement_amount != v_latest.statement_amount OR
			   NEW.statement_date != v_latest.statement_date OR
			   NEW.due_date != v_latest.due_date OR
			   NEW.reserve_placement != v_latest.reserve_placement OR
			   (NEW.note IS DISTINCT FROM v_latest.note) THEN
				RAISE EXCEPTION 'VOID revision must copy all snapshot fields exactly from predecessor';
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
-- 8. DEFERRED COMMIT-TIME RESERVE BALANCE INVARIANT
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_cc_reserve_invariant()
RETURNS TRIGGER AS $$
DECLARE
	v_stmt RECORD;
	v_latest_rev RECORD;
	v_bucket_balance NUMERIC;
BEGIN
	-- Determine statement_id depending on table
	IF TG_TABLE_NAME = 'credit_card_statement_revisions' THEN
		-- Look up statement anchor
		SELECT cs.id, cs.midas_reserve_bucket_id, cs.midas_account_id
		INTO v_stmt
		FROM credit_card_statements cs
		WHERE cs.id = NEW.statement_id;
	ELSIF TG_TABLE_NAME = 'midas_allocation_transfers' THEN
		-- Find any statement whose reserve bucket is this from/to bucket
		SELECT cs.id, cs.midas_reserve_bucket_id, cs.midas_account_id
		INTO v_stmt
		FROM credit_card_statements cs
		WHERE cs.midas_reserve_bucket_id IN (NEW.from_bucket_id, NEW.to_bucket_id)
		LIMIT 1;
		IF NOT FOUND THEN
			RETURN NULL; -- Transfer does not touch any cc reserve bucket
		END IF;
	ELSE
		RETURN NULL;
	END IF;

	IF v_stmt.id IS NULL THEN
		RETURN NULL;
	END IF;

	-- Fetch latest revision for this statement
	SELECT r.status, r.statement_amount, r.reserve_placement
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

	-- Enforce invariant based on latest status and placement
	IF v_latest_rev.status = 'VOID' THEN
		IF v_bucket_balance != 0 THEN
			RAISE EXCEPTION 'VOID statement % must have reserve bucket balance 0, found %',
				v_stmt.id, v_bucket_balance;
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
-- 9. DEFERRED COMMIT-TIME ANCHOR REVISION COMPLETENESS INVARIANT
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
EXECUTE FUNCTION trg_fn_guard_cc_anchor_has_revision();