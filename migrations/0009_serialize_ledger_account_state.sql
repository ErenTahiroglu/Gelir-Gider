-- Custom migration: Replace transition trigger with deterministic account row locking (FOR UPDATE OF la ORDER BY la.id)

CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition()
RETURNS TRIGGER AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric;
	v_credit_sum numeric;
	v_account RECORD;
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

			-- Validate double-entry balance and line count using unconstrained numeric sums
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

			-- Lock and validate all referenced accounts with deterministic order to eliminate race conditions with concurrent archiving
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
				IF v_account.user_id != NEW.user_id
				   OR v_account.currency != NEW.currency
				   OR v_account.archived_at IS NOT NULL THEN
					RAISE EXCEPTION 'One or more accounts in journal lines do not match user_id/currency or are archived';
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