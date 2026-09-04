-- Migration 0023: Short-Term Goals DB Integrity Hardening
-- Hardens revision latest predecessor checks, priority insert completeness, and deferred consistency triggers.

-- 1. HARDEN REVISION INSERT TRIGGER (PREVENT BRANCHING & PREDECESSOR VALIDATION)
CREATE OR REPLACE FUNCTION trg_fn_guard_stg_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_goal RECORD;
	v_midas_acc RECORD;
	v_latest_existing RECORD;
	v_pred RECORD;
	v_bucket_balance NUMERIC;
BEGIN
	-- 1. Validate goal anchor exists and belongs to user
	SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.goal_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Short-term goal % not found', NEW.goal_id;
	END IF;

	IF v_goal.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Goal user_id % does not match revision user_id %', v_goal.user_id, NEW.user_id;
	END IF;

	-- 2. Lock parent Midas account FOR UPDATE to serialize revision and priority insertion
	SELECT * INTO v_midas_acc FROM midas_accounts WHERE id = v_goal.midas_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Midas account % not found', v_goal.midas_account_id;
	END IF;

	-- 3. Check current latest revision for goal (DB defense against branching)
	SELECT id, revision_no, status, name, funding_target, target_date, max_budget, target_price, product_url, note
	INTO v_latest_existing
	FROM short_term_goal_revisions
	WHERE goal_id = NEW.goal_id
	ORDER BY revision_no DESC
	LIMIT 1;

	-- 4. Derive current linked bucket balance
	SELECT COALESCE(SUM(CASE WHEN to_bucket_id = v_goal.midas_bucket_id THEN amount WHEN from_bucket_id = v_goal.midas_bucket_id THEN -amount ELSE 0 END), 0)
	INTO v_bucket_balance
	FROM midas_allocation_transfers
	WHERE midas_account_id = v_goal.midas_account_id;

	-- 5. Validate revision sequence & lifecycle state machine
	IF NEW.revision_no = 1 THEN
		IF v_latest_existing.id IS NOT NULL THEN
			RAISE EXCEPTION 'Goal % already has revisions; revision 1 cannot be created again', NEW.goal_id;
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
	ELSE
		IF v_latest_existing.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for goal %', NEW.goal_id;
		END IF;

		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;

		IF NEW.previous_revision_id != v_latest_existing.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of goal % (branching forbidden)',
				NEW.previous_revision_id, v_latest_existing.id, NEW.goal_id;
		END IF;

		IF v_latest_existing.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest_existing.revision_no, NEW.revision_no;
		END IF;

		IF v_latest_existing.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Cannot create revision on non-active goal (current status %)', v_latest_existing.status;
		END IF;

		IF NEW.operation = 'CREATE' THEN
			RAISE EXCEPTION 'Cannot use CREATE operation on subsequent revision %', NEW.revision_no;
		ELSIF NEW.operation = 'UPDATE' THEN
			IF NEW.status != 'ACTIVE' THEN
				RAISE EXCEPTION 'UPDATE operation must retain ACTIVE status, found %', NEW.status;
			END IF;
		ELSIF NEW.operation = 'COMPLETE' THEN
			IF NEW.status != 'COMPLETED' THEN
				RAISE EXCEPTION 'COMPLETE operation must set COMPLETED status, found %', NEW.status;
			END IF;

			-- Exact copy of configuration fields from predecessor
			IF NEW.name != v_latest_existing.name OR
			   NEW.funding_target != v_latest_existing.funding_target OR
			   (NEW.target_date IS DISTINCT FROM v_latest_existing.target_date) OR
			   (NEW.max_budget IS DISTINCT FROM v_latest_existing.max_budget) OR
			   (NEW.target_price IS DISTINCT FROM v_latest_existing.target_price) OR
			   (NEW.product_url IS DISTINCT FROM v_latest_existing.product_url) OR
			   (NEW.note IS DISTINCT FROM v_latest_existing.note) THEN
				RAISE EXCEPTION 'COMPLETE revision must copy configuration exactly from predecessor';
			END IF;

			IF v_bucket_balance != 0 THEN
				RAISE EXCEPTION 'Cannot complete short-term goal with non-zero funding balance (%)', v_bucket_balance;
			END IF;
		ELSIF NEW.operation = 'CANCEL' THEN
			IF NEW.status != 'CANCELLED' THEN
				RAISE EXCEPTION 'CANCEL operation must set CANCELLED status, found %', NEW.status;
			END IF;

			-- Exact copy of configuration fields from predecessor
			IF NEW.name != v_latest_existing.name OR
			   NEW.funding_target != v_latest_existing.funding_target OR
			   (NEW.target_date IS DISTINCT FROM v_latest_existing.target_date) OR
			   (NEW.max_budget IS DISTINCT FROM v_latest_existing.max_budget) OR
			   (NEW.target_price IS DISTINCT FROM v_latest_existing.target_price) OR
			   (NEW.product_url IS DISTINCT FROM v_latest_existing.product_url) OR
			   (NEW.note IS DISTINCT FROM v_latest_existing.note) THEN
				RAISE EXCEPTION 'CANCEL revision must copy configuration exactly from predecessor';
			END IF;

			IF v_bucket_balance != 0 THEN
				RAISE EXCEPTION 'Cannot cancel short-term goal with non-zero funding balance (%)', v_bucket_balance;
			END IF;
		ELSE
			RAISE EXCEPTION 'Invalid operation %', NEW.operation;
		END IF;
	END IF;

	-- 6. Validate max_budget vs current balance
	IF NEW.max_budget IS NOT NULL THEN
		IF v_bucket_balance > NEW.max_budget THEN
			RAISE EXCEPTION 'Current funding balance (%) exceeds new max_budget (%)', v_bucket_balance, NEW.max_budget;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. HARDEN PRIORITY INSERT TRIGGER (LATEST PREDECESSOR & COMPLETENESS CHECK)
CREATE OR REPLACE FUNCTION trg_fn_guard_stg_priority_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_midas_acc RECORD;
	v_latest_existing RECORD;
	v_item jsonb;
	v_goal_id uuid;
	v_goal_rec RECORD;
	v_active_goal_ids uuid[];
	v_supplied_ids uuid[] := '{}';
	v_sorted_supplied uuid[] := '{}';
BEGIN
	-- 1. Lock parent Midas account FOR UPDATE
	SELECT * INTO v_midas_acc FROM midas_accounts WHERE id = NEW.midas_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Midas account % not found', NEW.midas_account_id;
	END IF;

	IF v_midas_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Midas account user_id % does not match priority revision user_id %', v_midas_acc.user_id, NEW.user_id;
	END IF;

	-- 2. Check current latest priority revision for account (DB defense against branching)
	SELECT id, revision_no
	INTO v_latest_existing
	FROM short_term_goal_priority_revisions
	WHERE midas_account_id = NEW.midas_account_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest_existing.id IS NOT NULL THEN
			RAISE EXCEPTION 'Priority revisions already exist for account %; revision 1 cannot be re-inserted', NEW.midas_account_id;
		END IF;

		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First priority revision must have previous_revision_id NULL';
		END IF;
	ELSE
		IF v_latest_existing.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor priority revision exists for account %', NEW.midas_account_id;
		END IF;

		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Priority revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;

		IF NEW.previous_revision_id != v_latest_existing.id THEN
			RAISE EXCEPTION 'Previous priority revision % is not current latest priority revision % of account % (branching forbidden)',
				NEW.previous_revision_id, v_latest_existing.id, NEW.midas_account_id;
		END IF;

		IF v_latest_existing.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Previous priority revision_no % is not predecessor of %', v_latest_existing.revision_no, NEW.revision_no;
		END IF;
	END IF;

	-- 3. Validate elements in ordered_goal_ids
	FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.ordered_goal_ids)
	LOOP
		IF jsonb_typeof(v_item) != 'string' THEN
			RAISE EXCEPTION 'Each member of ordered_goal_ids must be a string UUID';
		END IF;

		BEGIN
			v_goal_id := (v_item #>> '{}')::uuid;
		EXCEPTION WHEN OTHERS THEN
			RAISE EXCEPTION 'Invalid UUID format in ordered_goal_ids: %', v_item;
		END;

		-- Check lowercase canonical format
		IF (v_item #>> '{}') != lower(v_item #>> '{}') THEN
			RAISE EXCEPTION 'Goal ID in ordered_goal_ids must be canonical lowercase: %', v_item;
		END IF;

		-- Check duplicates
		IF v_goal_id = ANY(v_supplied_ids) THEN
			RAISE EXCEPTION 'Duplicate goal ID in ordered_goal_ids: %', v_goal_id;
		END IF;
		v_supplied_ids := array_append(v_supplied_ids, v_goal_id);

		-- Check goal belongs to this user and Midas account and is active
		SELECT g.*, r.status
		INTO v_goal_rec
		FROM short_term_goals g
		JOIN (
			SELECT goal_id, status,
			       ROW_NUMBER() OVER (PARTITION BY goal_id ORDER BY revision_no DESC) as rn
			FROM short_term_goal_revisions
		) r ON r.goal_id = g.id AND r.rn = 1
		WHERE g.id = v_goal_id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Goal % in priority list not found', v_goal_id;
		END IF;

		IF v_goal_rec.user_id != NEW.user_id OR v_goal_rec.midas_account_id != NEW.midas_account_id THEN
			RAISE EXCEPTION 'Goal % in priority list does not belong to this Midas account/user', v_goal_id;
		END IF;

		IF v_goal_rec.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Goal % in priority list is not in ACTIVE status (status %)', v_goal_id, v_goal_rec.status;
		END IF;
	END LOOP;

	-- 4. Enforce at INSERT time that ordered_goal_ids contains ALL and ONLY currently ACTIVE goals
	SELECT array_agg(g.id ORDER BY g.id)
	INTO v_active_goal_ids
	FROM short_term_goals g
	JOIN (
		SELECT goal_id, status,
		       ROW_NUMBER() OVER (PARTITION BY goal_id ORDER BY revision_no DESC) as rn
		FROM short_term_goal_revisions
	) r ON r.goal_id = g.id AND r.rn = 1
	WHERE g.midas_account_id = NEW.midas_account_id
	  AND r.status = 'ACTIVE';

	IF v_active_goal_ids IS NULL THEN
		v_active_goal_ids := '{}';
	END IF;

	SELECT array_agg(x ORDER BY x)
	INTO v_sorted_supplied
	FROM unnest(v_supplied_ids) x;

	IF v_sorted_supplied IS NULL THEN
		v_sorted_supplied := '{}';
	END IF;

	IF v_active_goal_ids != v_sorted_supplied THEN
		RAISE EXCEPTION 'Priority list must contain all and only current active goals for Midas account. Active count %, supplied count %',
			array_length(v_active_goal_ids, 1), array_length(v_sorted_supplied, 1);
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. HARDEN DEFERRED CONSTRAINT TRIGGER FOR PRIORITY CONSISTENCY
CREATE OR REPLACE FUNCTION trg_fn_guard_stg_priority_deferred()
RETURNS TRIGGER AS $$
DECLARE
	v_midas_account_id uuid;
	v_latest_priority RECORD;
	v_active_goal_ids uuid[];
	v_priority_goal_ids uuid[] := '{}';
	v_item jsonb;
	v_gid uuid;
BEGIN
	IF TG_TABLE_NAME = 'short_term_goal_revisions' THEN
		SELECT midas_account_id INTO v_midas_account_id
		FROM short_term_goals
		WHERE id = NEW.goal_id;
	ELSIF TG_TABLE_NAME = 'short_term_goal_priority_revisions' THEN
		v_midas_account_id := NEW.midas_account_id;
	ELSE
		RETURN NULL;
	END IF;

	IF v_midas_account_id IS NULL THEN
		RETURN NULL;
	END IF;

	-- Fetch all currently ACTIVE goals for this Midas account
	SELECT array_agg(g.id ORDER BY g.id)
	INTO v_active_goal_ids
	FROM short_term_goals g
	JOIN (
		SELECT goal_id, status,
		       ROW_NUMBER() OVER (PARTITION BY goal_id ORDER BY revision_no DESC) as rn
		FROM short_term_goal_revisions
	) r ON r.goal_id = g.id AND r.rn = 1
	WHERE g.midas_account_id = v_midas_account_id
	  AND r.status = 'ACTIVE';

	IF v_active_goal_ids IS NULL THEN
		v_active_goal_ids := '{}';
	END IF;

	-- Fetch latest priority revision for this Midas account
	SELECT * INTO v_latest_priority
	FROM short_term_goal_priority_revisions
	WHERE midas_account_id = v_midas_account_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF FOUND THEN
		FOR v_item IN SELECT * FROM jsonb_array_elements(v_latest_priority.ordered_goal_ids)
		LOOP
			v_gid := (v_item #>> '{}')::uuid;
			v_priority_goal_ids := array_append(v_priority_goal_ids, v_gid);
		END LOOP;
	END IF;

	-- Compare sets: array sorted comparison
	SELECT array_agg(x ORDER BY x) INTO v_priority_goal_ids FROM unnest(v_priority_goal_ids) x;
	IF v_priority_goal_ids IS NULL THEN
		v_priority_goal_ids := '{}';
	END IF;

	IF v_active_goal_ids != v_priority_goal_ids THEN
		RAISE EXCEPTION 'Priority ordering inconsistency detected at transaction commit. Active goals % do not match priority list %',
			v_active_goal_ids, v_priority_goal_ids;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Attach deferred trigger to short_term_goal_priority_revisions as well
DROP TRIGGER IF EXISTS trg_guard_stg_priority_deferred_on_priority ON "short_term_goal_priority_revisions";
CREATE CONSTRAINT TRIGGER trg_guard_stg_priority_deferred_on_priority
AFTER INSERT ON "short_term_goal_priority_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_stg_priority_deferred();
