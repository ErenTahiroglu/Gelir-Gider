ALTER TABLE "journal_entries" ADD COLUMN "reversal_of_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reversal_of_entry_idx" ON "journal_entries" USING btree ("reversal_of_entry_id") WHERE "journal_entries"."reversal_of_entry_id" IS NOT NULL;--> statement-breakpoint

-- Custom migration: Replace transition trigger with reversal target locking, exact-inverse line validation, and archived account exemption for reversals

CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition()
RETURNS TRIGGER AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric;
	v_credit_sum numeric;
	v_account RECORD;
	v_target_id uuid;
	v_target_user_id uuid;
	v_target_currency varchar(3);
	v_target_status varchar(10);
	v_target_line_count integer;
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
				-- Lock target journal row first in hierarchy to serialize concurrent reversals
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

				-- Target line count check
				SELECT COUNT(*) INTO v_target_line_count
				FROM "journal_lines"
				WHERE journal_entry_id = NEW.reversal_of_entry_id;

				IF v_line_count != v_target_line_count THEN
					RAISE EXCEPTION 'Reversal line count % does not match target line count %', v_line_count, v_target_line_count;
				END IF;

				-- Exact inverse lines check (reversal debit == target credit, reversal credit == target debit)
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

			-- 3. Lock and validate all referenced accounts in deterministic sorted order
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

				-- Normal postings require active accounts. Reversals are legitimately allowed to touch archived accounts.
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