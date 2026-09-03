-- Custom migration: Harden journal line immutability, parent locking, and aggregate sum types

-- 1. Replace journal lines mutability guard with parent row locking and reparenting prevention
CREATE OR REPLACE FUNCTION trg_fn_guard_journal_lines_mutability()
RETURNS TRIGGER AS $$
DECLARE
	v_parent_status varchar(10);
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT status INTO v_parent_status
		FROM "journal_entries"
		WHERE id = NEW.journal_entry_id
		FOR UPDATE;

		IF v_parent_status IS NULL THEN
			RAISE EXCEPTION 'Parent journal entry % does not exist', NEW.journal_entry_id;
		END IF;

		IF v_parent_status != 'DRAFT' THEN
			RAISE EXCEPTION 'Cannot insert or modify journal lines on a % journal entry', v_parent_status;
		END IF;

		RETURN NEW;
	ELSIF TG_OP = 'UPDATE' THEN
		IF OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
			RAISE EXCEPTION 'journal_lines journal_entry_id is immutable and line reparenting is prohibited';
		END IF;

		SELECT status INTO v_parent_status
		FROM "journal_entries"
		WHERE id = NEW.journal_entry_id
		FOR UPDATE;

		IF v_parent_status IS NULL THEN
			RAISE EXCEPTION 'Parent journal entry % does not exist', NEW.journal_entry_id;
		END IF;

		IF v_parent_status != 'DRAFT' THEN
			RAISE EXCEPTION 'Cannot insert or modify journal lines on a % journal entry', v_parent_status;
		END IF;

		RETURN NEW;
	ELSIF TG_OP = 'DELETE' THEN
		SELECT status INTO v_parent_status
		FROM "journal_entries"
		WHERE id = OLD.journal_entry_id
		FOR UPDATE;

		IF v_parent_status IS NULL THEN
			RAISE EXCEPTION 'Parent journal entry % does not exist', OLD.journal_entry_id;
		END IF;

		IF v_parent_status != 'DRAFT' THEN
			RAISE EXCEPTION 'Cannot delete journal lines on a % journal entry', v_parent_status;
		END IF;

		RETURN OLD;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 2. Replace journal entries transition guard with unconstrained numeric aggregate types
CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition()
RETURNS TRIGGER AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric;
	v_credit_sum numeric;
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
$$ LANGUAGE plpgsql;