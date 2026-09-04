-- ============================================================================
-- PHASE 8A-R1: MIDAS INTEGRITY HARDENING MIGRATION
-- ============================================================================

-- 1. Upgrade text check constraints on midas_buckets and midas_allocation_transfers
ALTER TABLE "midas_buckets" DROP CONSTRAINT IF EXISTS "midas_buckets_name_check";
ALTER TABLE "midas_buckets" ADD CONSTRAINT "midas_buckets_name_check" CHECK ("midas_buckets"."name" = btrim("midas_buckets"."name") AND length("midas_buckets"."name") >= 1 AND length("midas_buckets"."name") <= 120);

ALTER TABLE "midas_allocation_transfers" DROP CONSTRAINT IF EXISTS "midas_transfers_idempotency_check";
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_idempotency_check" CHECK ("midas_allocation_transfers"."idempotency_key" = btrim("midas_allocation_transfers"."idempotency_key") AND length("midas_allocation_transfers"."idempotency_key") >= 1 AND length("midas_allocation_transfers"."idempotency_key") <= 128);

ALTER TABLE "midas_allocation_transfers" DROP CONSTRAINT IF EXISTS "midas_transfers_memo_check";
ALTER TABLE "midas_allocation_transfers" ADD CONSTRAINT "midas_transfers_memo_check" CHECK ("midas_allocation_transfers"."memo" IS NULL OR ("midas_allocation_transfers"."memo" = btrim("midas_allocation_transfers"."memo") AND length("midas_allocation_transfers"."memo") >= 1 AND length("midas_allocation_transfers"."memo") <= 500));

-- 2. Harden midas_accounts insert trigger with FOR UPDATE on ledger_accounts and negative physical balance check
CREATE OR REPLACE FUNCTION trg_fn_guard_midas_accounts_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_user RECORD;
	v_ledger_acc RECORD;
	v_physical_balance numeric;
BEGIN
	SELECT * INTO v_user FROM users WHERE id = NEW.user_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'User % not found', NEW.user_id;
	END IF;

	SELECT * INTO v_ledger_acc
	FROM ledger_accounts
	WHERE id = NEW.ledger_account_id
	FOR UPDATE;

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

	SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
	INTO v_physical_balance
	FROM journal_lines jl
	JOIN journal_entries je ON je.id = jl.journal_entry_id
	WHERE jl.account_id = NEW.ledger_account_id
	  AND je.status = 'POSTED';

	IF v_physical_balance < 0 THEN
		RAISE EXCEPTION 'Cannot link Midas account to ledger account % with negative physical balance (%)', NEW.ledger_account_id, v_physical_balance;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Harden ledger_accounts archive protection trigger against Midas links
CREATE OR REPLACE FUNCTION trg_fn_guard_ledger_accounts_archive()
RETURNS TRIGGER AS $$
DECLARE
	v_midas_link RECORD;
BEGIN
	IF TG_OP = 'UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
		SELECT id INTO v_midas_link
		FROM midas_accounts
		WHERE ledger_account_id = NEW.id
		LIMIT 1;

		IF FOUND THEN
			RAISE EXCEPTION 'Cannot archive ledger account % because it is linked to Midas liquidity account %', NEW.id, v_midas_link.id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_ledger_accounts_archive ON "ledger_accounts";
CREATE TRIGGER trg_guard_ledger_accounts_archive
BEFORE UPDATE ON "ledger_accounts"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_ledger_accounts_archive();

-- 4. Reorder lock hierarchy in journal entry transition trigger (reversal target -> ledger accounts -> midas accounts)
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

			-- 3. Lock and validate all referenced ledger accounts in deterministic sorted order
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

			-- 4. Lock any linked Midas accounts in deterministic sorted order and verify solvency
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