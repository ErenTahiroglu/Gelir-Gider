CREATE TABLE "midas_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "midas_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"midas_account_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"bucket_type" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "midas_allocation_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"midas_account_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"transfer_fingerprint" varchar(64) NOT NULL,
	"from_bucket_id" uuid,
	"to_bucket_id" uuid,
	"amount" numeric(18, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reversal_of_transfer_id" uuid,
	"memo" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "midas_accounts" ADD CONSTRAINT "midas_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midas_accounts" ADD CONSTRAINT "midas_accounts_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "midas_accounts_user_idx" ON "midas_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "midas_accounts_ledger_account_idx" ON "midas_accounts" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE INDEX "midas_accounts_user_id_idx" ON "midas_accounts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_midas_account_id_midas_accounts_id_fk" FOREIGN KEY ("midas_account_id") REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "midas_buckets_account_code_idx" ON "midas_buckets" USING btree ("midas_account_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "midas_buckets_singleton_type_idx" ON "midas_buckets" USING btree ("midas_account_id","bucket_type") WHERE "midas_buckets"."bucket_type" IN ('MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM');--> statement-breakpoint
CREATE INDEX "midas_buckets_account_idx" ON "midas_buckets" USING btree ("midas_account_id");--> statement-breakpoint
CREATE INDEX "midas_buckets_user_idx" ON "midas_buckets" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_type_check" CHECK ("midas_buckets"."bucket_type" IN ('CREDIT_CARD_RESERVE', 'SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM'));--> statement-breakpoint
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_code_check" CHECK ("midas_buckets"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$');--> statement-breakpoint
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_name_check" CHECK (length(trim("midas_buckets"."name")) >= 1 AND length("midas_buckets"."name") <= 120);--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_allocation_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_allocation_transfers_midas_account_id_midas_accounts_id_fk" FOREIGN KEY ("midas_account_id") REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_allocation_transfers_from_bucket_id_midas_buckets_id_fk" FOREIGN KEY ("from_bucket_id") REFERENCES "public"."midas_buckets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_allocation_transfers_to_bucket_id_midas_buckets_id_fk" FOREIGN KEY ("to_bucket_id") REFERENCES "public"."midas_buckets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_allocation_transfers_reversal_of_transfer_id_midas_allocation_transfers_id_fk" FOREIGN KEY ("reversal_of_transfer_id") REFERENCES "public"."midas_allocation_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "midas_transfers_user_idempotency_idx" ON "midas_allocation_transfers" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "midas_transfers_reversal_idx" ON "midas_allocation_transfers" USING btree ("reversal_of_transfer_id") WHERE "midas_allocation_transfers"."reversal_of_transfer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "midas_transfers_account_occurred_idx" ON "midas_allocation_transfers" USING btree ("midas_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "midas_transfers_from_bucket_idx" ON "midas_allocation_transfers" USING btree ("from_bucket_id");--> statement-breakpoint
CREATE INDEX "midas_transfers_to_bucket_idx" ON "midas_allocation_transfers" USING btree ("to_bucket_id");--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_amount_check" CHECK ("midas_allocation_transfers"."amount" > 0);--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_endpoints_check" CHECK ("midas_allocation_transfers"."from_bucket_id" IS NOT NULL OR "midas_allocation_transfers"."to_bucket_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_distinct_buckets_check" CHECK ("midas_allocation_transfers"."from_bucket_id" IS NULL OR "midas_allocation_transfers"."to_bucket_id" IS NULL OR "midas_allocation_transfers"."from_bucket_id" != "midas_allocation_transfers"."to_bucket_id");--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_fingerprint_check" CHECK ("midas_allocation_transfers"."transfer_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_idempotency_check" CHECK (length(trim("midas_allocation_transfers"."idempotency_key")) >= 1 AND length("midas_allocation_transfers"."idempotency_key") <= 128);--> statement-breakpoint
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_memo_check" CHECK ("midas_allocation_transfers"."memo" IS NULL OR length("midas_allocation_transfers"."memo") <= 500);--> statement-breakpoint

-- ============================================================================
-- MIDAS ACCOUNTS IMMUTABILITY & INSERT VALIDATION
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_accounts_immutability()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'midas_accounts rows are immutable and cannot be updated';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'midas_accounts rows cannot be deleted';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_accounts_immutability
BEFORE UPDATE OR DELETE ON "midas_accounts"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_accounts_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_accounts_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_user RECORD;
	v_ledger_acc RECORD;
BEGIN
	SELECT * INTO v_user FROM users WHERE id = NEW.user_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'User % not found', NEW.user_id;
	END IF;

	SELECT * INTO v_ledger_acc FROM ledger_accounts WHERE id = NEW.ledger_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Ledger account % not found', NEW.ledger_account_id;
	END IF;

	IF v_ledger_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Ledger account % does not belong to user %', NEW.ledger_account_id, NEW.user_id;
	END IF;

	IF v_ledger_acc.account_type != 'ASSET' THEN
		RAISE EXCEPTION 'Midas linked ledger account must have account_type ASSET, found %', v_ledger_acc.account_type;
	END IF;

	IF v_ledger_acc.normal_balance != 'DEBIT' THEN
		RAISE EXCEPTION 'Midas linked ledger account must have normal_balance DEBIT, found %', v_ledger_acc.normal_balance;
	END IF;

	IF v_ledger_acc.currency != v_user.currency THEN
		RAISE EXCEPTION 'Midas linked ledger account currency % does not match user currency %', v_ledger_acc.currency, v_user.currency;
	END IF;

	IF v_ledger_acc.archived_at IS NOT NULL THEN
		RAISE EXCEPTION 'Midas linked ledger account cannot be archived';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_accounts_insert
BEFORE INSERT ON "midas_accounts"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_accounts_insert();--> statement-breakpoint

-- ============================================================================
-- MIDAS BUCKETS IMMUTABILITY & INSERT VALIDATION
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_buckets_immutability()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'midas_buckets rows are immutable and cannot be updated';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'midas_buckets rows cannot be deleted';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_buckets_immutability
BEFORE UPDATE OR DELETE ON "midas_buckets"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_buckets_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_buckets_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_midas_acc RECORD;
BEGIN
	SELECT * INTO v_midas_acc FROM midas_accounts WHERE id = NEW.midas_account_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Midas account % not found', NEW.midas_account_id;
	END IF;

	IF v_midas_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Bucket user_id % does not match Midas account user_id %', NEW.user_id, v_midas_acc.user_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_buckets_insert
BEFORE INSERT ON "midas_buckets"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_buckets_insert();--> statement-breakpoint

-- ============================================================================
-- MIDAS ALLOCATION TRANSFERS IMMUTABILITY & GUARD TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_allocation_transfers_immutability()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'midas_allocation_transfers rows are immutable and cannot be updated';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'midas_allocation_transfers rows cannot be deleted';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_allocation_transfers_immutability
BEFORE UPDATE OR DELETE ON "midas_allocation_transfers"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_allocation_transfers_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_allocation_transfers_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_midas_acc RECORD;
	v_from_bucket RECORD;
	v_to_bucket RECORD;
	v_target_transfer RECORD;
	v_source_bucket_balance numeric;
	v_physical_balance numeric;
	v_total_earmarked numeric;
	v_delta numeric := 0;
BEGIN
	-- 1. Lock parent midas_accounts row FOR UPDATE to serialize all allocation transfers
	SELECT * INTO v_midas_acc
	FROM midas_accounts
	WHERE id = NEW.midas_account_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RAISE EXCEPTION 'midas_accounts row % not found', NEW.midas_account_id;
	END IF;

	IF v_midas_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Transfer user_id % does not match Midas account user_id %', NEW.user_id, v_midas_acc.user_id;
	END IF;

	-- 2. Validate from_bucket if present
	IF NEW.from_bucket_id IS NOT NULL THEN
		SELECT * INTO v_from_bucket
		FROM midas_buckets
		WHERE id = NEW.from_bucket_id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Source bucket % not found', NEW.from_bucket_id;
		END IF;

		IF v_from_bucket.midas_account_id != NEW.midas_account_id OR v_from_bucket.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Source bucket % does not belong to Midas account % / user %', NEW.from_bucket_id, NEW.midas_account_id, NEW.user_id;
		END IF;
	END IF;

	-- 3. Validate to_bucket if present
	IF NEW.to_bucket_id IS NOT NULL THEN
		SELECT * INTO v_to_bucket
		FROM midas_buckets
		WHERE id = NEW.to_bucket_id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Destination bucket % not found', NEW.to_bucket_id;
		END IF;

		IF v_to_bucket.midas_account_id != NEW.midas_account_id OR v_to_bucket.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Destination bucket % does not belong to Midas account % / user %', NEW.to_bucket_id, NEW.midas_account_id, NEW.user_id;
		END IF;
	END IF;

	-- 4. Validate reversal semantics if present
	IF NEW.reversal_of_transfer_id IS NOT NULL THEN
		IF NEW.reversal_of_transfer_id = NEW.id THEN
			RAISE EXCEPTION 'A transfer cannot reverse itself';
		END IF;

		SELECT * INTO v_target_transfer
		FROM midas_allocation_transfers
		WHERE id = NEW.reversal_of_transfer_id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Reversal target transfer % not found', NEW.reversal_of_transfer_id;
		END IF;

		IF v_target_transfer.midas_account_id != NEW.midas_account_id OR v_target_transfer.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Reversal target transfer belongs to a different Midas account / user';
		END IF;

		IF v_target_transfer.reversal_of_transfer_id IS NOT NULL THEN
			RAISE EXCEPTION 'Cannot reverse a reversal transfer';
		END IF;

		-- Check exact inverse
		IF (NEW.from_bucket_id IS DISTINCT FROM v_target_transfer.to_bucket_id) OR
		   (NEW.to_bucket_id IS DISTINCT FROM v_target_transfer.from_bucket_id) OR
		   (NEW.amount != v_target_transfer.amount) THEN
			RAISE EXCEPTION 'Reversal transfer must be the exact inverse of the target transfer';
		END IF;
	END IF;

	-- 5. Validate source bucket balance if from_bucket_id IS NOT NULL
	IF NEW.from_bucket_id IS NOT NULL THEN
		SELECT COALESCE(SUM(CASE WHEN to_bucket_id = NEW.from_bucket_id THEN amount WHEN from_bucket_id = NEW.from_bucket_id THEN -amount ELSE 0 END), 0)
		INTO v_source_bucket_balance
		FROM midas_allocation_transfers
		WHERE midas_account_id = NEW.midas_account_id;

		IF v_source_bucket_balance < NEW.amount THEN
			RAISE EXCEPTION 'Source bucket % has insufficient balance (%) for transfer amount (%)',
				NEW.from_bucket_id, v_source_bucket_balance, NEW.amount;
		END IF;
	END IF;

	-- 6. Compute resulting total earmarked and compare against physical ledger balance
	IF NEW.from_bucket_id IS NULL THEN
		v_delta := NEW.amount;
	ELSIF NEW.to_bucket_id IS NULL THEN
		v_delta := -NEW.amount;
	END IF;

	SELECT COALESCE(SUM(CASE WHEN from_bucket_id IS NULL THEN amount WHEN to_bucket_id IS NULL THEN -amount ELSE 0 END), 0)
	INTO v_total_earmarked
	FROM midas_allocation_transfers
	WHERE midas_account_id = NEW.midas_account_id;

	v_total_earmarked := v_total_earmarked + v_delta;

	SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
	INTO v_physical_balance
	FROM journal_lines jl
	JOIN journal_entries je ON je.id = jl.journal_entry_id
	WHERE jl.account_id = v_midas_acc.ledger_account_id
	  AND je.status = 'POSTED';

	IF v_total_earmarked > v_physical_balance THEN
		RAISE EXCEPTION 'Insufficient free liquidity: resulting total earmarked (%) would exceed physical balance (%) for Midas account %',
			v_total_earmarked, v_physical_balance, NEW.midas_account_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_allocation_transfers_insert
BEFORE INSERT ON "midas_allocation_transfers"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_allocation_transfers_insert();--> statement-breakpoint

-- ============================================================================
-- CROSS-LEDGER SOLVENCY GUARD ON JOURNAL ENTRY TRANSITION TO POSTED
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition()
RETURNS TRIGGER AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric;
	v_credit_sum numeric;
	v_account RECORD;
	v_midas_account RECORD;
	v_target_id uuid;
	v_target_user_id uuid;
	v_target_currency varchar(3);
	v_target_status varchar(10);
	v_target_line_count integer;
	v_physical_balance numeric;
	v_total_earmarked numeric;
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

			-- 1. Validate double-entry balance and line count using unconstrained numeric sums
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

			-- 2. If this is a reversal entry, validate target entry and exact inverse lines
			IF NEW.reversal_of_entry_id IS NOT NULL THEN
				SELECT
					id,
					user_id,
					currency,
					status
				INTO
					v_target_id,
					v_target_user_id,
					v_target_currency,
					v_target_status
				FROM "journal_entries"
				WHERE id = NEW.reversal_of_entry_id
				FOR UPDATE;

				IF v_target_id IS NULL THEN
					RAISE EXCEPTION 'Reversal target entry % does not exist', NEW.reversal_of_entry_id;
				END IF;

				IF v_target_id = NEW.id THEN
					RAISE EXCEPTION 'A journal entry cannot reverse itself';
				END IF;

				IF v_target_user_id != NEW.user_id THEN
					RAISE EXCEPTION 'Reversal target entry belongs to a different user';
				END IF;

				IF v_target_currency != NEW.currency THEN
					RAISE EXCEPTION 'Reversal currency % does not match target currency %', NEW.currency, v_target_currency;
				END IF;

				IF v_target_status != 'POSTED' THEN
					RAISE EXCEPTION 'Reversal target entry % is not in POSTED status (status=%)', NEW.reversal_of_entry_id, v_target_status;
				END IF;

				SELECT COUNT(*) INTO v_target_line_count
				FROM "journal_lines"
				WHERE journal_entry_id = NEW.reversal_of_entry_id;

				IF v_line_count != v_target_line_count THEN
					RAISE EXCEPTION 'Reversal line count % does not match target line count %', v_line_count, v_target_line_count;
				END IF;

				IF EXISTS (
					SELECT 1
					FROM "journal_lines" rl
					FULL OUTER JOIN "journal_lines" tl
						ON tl.journal_entry_id = NEW.reversal_of_entry_id
					   AND tl.line_no = rl.line_no
					WHERE rl.journal_entry_id = NEW.id
					  AND (
						tl.id IS NULL
						OR rl.account_id != tl.account_id
						OR rl.debit != tl.credit
						OR rl.credit != tl.debit
					  )
				) THEN
					RAISE EXCEPTION 'Reversal lines must be the exact inverse (swapped debit/credit) of target lines';
				END IF;
			END IF;

			-- 3. Lock any linked Midas accounts in deterministic sorted order
			FOR v_midas_account IN
				SELECT
					ma.id,
					ma.ledger_account_id,
					ma.user_id
				FROM "midas_accounts" ma
				WHERE ma.ledger_account_id IN (
					SELECT jl.account_id
					FROM "journal_lines" jl
					WHERE jl.journal_entry_id = NEW.id
				)
				ORDER BY ma.id
				FOR UPDATE
			LOOP
				-- Compute physical balance of this Midas ledger account including the entry being posted (NEW.id)
				SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
				INTO v_physical_balance
				FROM "journal_lines" jl
				JOIN "journal_entries" je ON je.id = jl.journal_entry_id
				WHERE jl.account_id = v_midas_account.ledger_account_id
				  AND (je.status = 'POSTED' OR je.id = NEW.id);

				-- Compute total active virtual earmarks for this Midas account
				SELECT COALESCE(SUM(CASE WHEN from_bucket_id IS NULL THEN amount WHEN to_bucket_id IS NULL THEN -amount ELSE 0 END), 0)
				INTO v_total_earmarked
				FROM "midas_allocation_transfers"
				WHERE midas_account_id = v_midas_account.id;

				IF v_physical_balance < v_total_earmarked THEN
					RAISE EXCEPTION 'Midas cross-ledger solvency violation: posting entry % would reduce physical balance (%) below total earmarked (%) for Midas account %',
						NEW.id, v_physical_balance, v_total_earmarked, v_midas_account.id;
				END IF;
			END LOOP;

			-- 4. Lock and validate all referenced ledger accounts in deterministic sorted order
			FOR v_account IN
				SELECT
					la.id,
					la.user_id,
					la.currency,
					la.archived_at
				FROM "ledger_accounts" la
				WHERE la.id IN (
					SELECT jl.account_id
					FROM "journal_lines" jl
					WHERE jl.journal_entry_id = NEW.id
				)
				ORDER BY la.id
				FOR UPDATE OF la
			LOOP
				IF v_account.user_id != NEW.user_id THEN
					RAISE EXCEPTION 'Account % belongs to a different user', v_account.id;
				END IF;

				IF v_account.currency != NEW.currency THEN
					RAISE EXCEPTION 'Account % currency % does not match entry currency %', v_account.id, v_account.currency, NEW.currency;
				END IF;

				IF NEW.reversal_of_entry_id IS NULL AND v_account.archived_at IS NOT NULL THEN
					RAISE EXCEPTION 'One or more accounts in journal lines are archived';
				END IF;
			END LOOP;

			RETURN NEW;
		END IF;

		IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
			RETURN NEW;
		END IF;

		RAISE EXCEPTION 'Invalid journal entry status transition from % to %', OLD.status, NEW.status;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
