ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_midas_account_route_check" CHECK (("month_close_revisions"."route" IN ('SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE')) = ("month_close_revisions"."midas_account_id" IS NOT NULL));
--> statement-breakpoint

-- ============================================================================
-- PHASE 14-R1: MONTH-END SURPLUS CLOSE & ROUTING DOMAIN HARDENING
--
-- E. Target goal revision DB binding: `target_goal_revision_no` must
--    reference a REAL `short_term_goal_revisions` row for the exact claimed
--    goal, that row must be the LATEST revision for that goal, and its
--    status must be ACTIVE. Applies to every decision under the
--    SHORT_TERM_GOAL route (FULL, PARTIAL, and SKIP).
-- F. Route <-> Midas account shape: SHORT_TERM_GOAL and MEDIUM_TERM_RESERVE
--    both DB-require midas_account_id IS NOT NULL (see the CHECK constraint
--    above); NONE requires it NULL. Any non-null midas_account_id must
--    reference a real midas_accounts row owned by the same user. The target
--    bucket must belong to the same user (in addition to the pre-existing
--    same-Midas-account and bucket_type-per-route checks). Every
--    identity-comparison where either side can be NULL now uses the
--    NULL-safe `IS DISTINCT FROM` operator instead of `!=` (a NULL on
--    either side of `!=` evaluates to NULL/unknown, which silently fails to
--    raise the guarding exception).
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_month_close_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_close RECORD;
	v_plan RECORD;
	v_plan_rev RECORD;
	v_transfer RECORD;
	v_bucket RECORD;
	v_goal RECORD;
	v_midas_account RECORD;
	v_goal_rev RECORD;
	v_max_goal_rev_no INT;
BEGIN
	SELECT * INTO v_close FROM month_closes WHERE id = NEW.month_close_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Month close % not found', NEW.month_close_id;
	END IF;
	IF v_close.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Month close % user_id % does not match revision user_id %', NEW.month_close_id, v_close.user_id, NEW.user_id;
	END IF;

	-- Budget-plan binding (Section 25): the referenced budget plan must
	-- belong to the same user and exact same period, and the referenced
	-- revision must exist and its economic fields must equal the stored
	-- snapshot exactly (never trust an app-supplied copy).
	SELECT * INTO v_plan FROM monthly_budget_plans WHERE id = v_close.budget_plan_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Budget plan % referenced by month close % not found', v_close.budget_plan_id, NEW.month_close_id;
	END IF;
	IF v_plan.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Budget plan % user_id % does not match month close user_id %', v_plan.id, v_plan.user_id, NEW.user_id;
	END IF;
	IF v_plan.period_month != v_close.period_month THEN
		RAISE EXCEPTION 'Budget plan % period_month % does not match month close period_month %', v_plan.id, v_plan.period_month, v_close.period_month;
	END IF;

	SELECT * INTO v_plan_rev
	FROM monthly_budget_plan_revisions
	WHERE budget_plan_id = v_plan.id AND revision_no = NEW.budget_plan_revision_no;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Budget plan revision % not found for budget plan %', NEW.budget_plan_revision_no, v_plan.id;
	END IF;
	IF v_plan_rev.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Budget plan revision % user_id % does not match month close revision user_id %', v_plan_rev.id, v_plan_rev.user_id, NEW.user_id;
	END IF;
	IF v_plan_rev.policy_version != NEW.policy_version THEN
		RAISE EXCEPTION 'Month close revision policy_version % does not match budget plan revision policy_version %', NEW.policy_version, v_plan_rev.policy_version;
	END IF;
	IF v_plan_rev.currency != NEW.currency THEN
		RAISE EXCEPTION 'Month close revision currency % does not match budget plan revision currency %', NEW.currency, v_plan_rev.currency;
	END IF;
	IF v_plan_rev.reference_income_amount != NEW.reference_income THEN
		RAISE EXCEPTION 'Month close revision reference_income % does not match budget plan revision reference_income_amount %', NEW.reference_income, v_plan_rev.reference_income_amount;
	END IF;
	IF v_plan_rev.mandatory_ceiling_amount != NEW.mandatory_ceiling THEN
		RAISE EXCEPTION 'Month close revision mandatory_ceiling % does not match budget plan revision mandatory_ceiling_amount % (forged ceiling)', NEW.mandatory_ceiling, v_plan_rev.mandatory_ceiling_amount;
	END IF;
	IF v_plan_rev.discretionary_ceiling_amount != NEW.discretionary_ceiling THEN
		RAISE EXCEPTION 'Month close revision discretionary_ceiling % does not match budget plan revision discretionary_ceiling_amount % (forged ceiling)', NEW.discretionary_ceiling, v_plan_rev.discretionary_ceiling_amount;
	END IF;

	-- Section F (Phase 14-R1): any non-null midas_account_id must reference a
	-- real Midas account belonging to the same user as this revision.
	IF NEW.midas_account_id IS NOT NULL THEN
		SELECT * INTO v_midas_account FROM midas_accounts WHERE id = NEW.midas_account_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Month close revision midas_account_id % not found', NEW.midas_account_id;
		END IF;
		IF v_midas_account.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'Midas account % does not belong to month close revision user %', NEW.midas_account_id, NEW.user_id;
		END IF;
	END IF;

	-- Route/decision-specific target binding (Section 27) + Section E
	-- (Phase 14-R1) goal-revision DB binding: SHORT_TERM_GOAL must resolve to
	-- a real goal owned by the same user/Midas account whose current bucket
	-- matches target_bucket_id exactly, AND target_goal_revision_no must
	-- reference a REAL short_term_goal_revisions row for that exact goal
	-- which is BOTH the LATEST revision for that goal AND currently ACTIVE.
	-- This applies under every decision (FULL, PARTIAL, and SKIP) -- SKIP
	-- still records the exact proposal goal snapshot. This is
	-- defense-in-depth against raw/direct SQL and any future projection
	-- drift; the service layer already independently re-checks this via its
	-- own proposal-fingerprint recomputation before apply.
	IF NEW.route = 'SHORT_TERM_GOAL' THEN
		SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.target_goal_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target short-term goal % not found', NEW.target_goal_id;
		END IF;
		IF v_goal.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'Target short-term goal % does not belong to user %', NEW.target_goal_id, NEW.user_id;
		END IF;
		IF v_goal.midas_account_id IS DISTINCT FROM NEW.midas_account_id THEN
			RAISE EXCEPTION 'Target short-term goal % Midas account does not match month close midas_account_id %', NEW.target_goal_id, NEW.midas_account_id;
		END IF;
		IF v_goal.midas_bucket_id IS DISTINCT FROM NEW.target_bucket_id THEN
			RAISE EXCEPTION 'Target short-term goal % bucket % does not match target_bucket_id %', NEW.target_goal_id, v_goal.midas_bucket_id, NEW.target_bucket_id;
		END IF;

		SELECT * INTO v_goal_rev
		FROM short_term_goal_revisions
		WHERE goal_id = NEW.target_goal_id
		  AND revision_no = NEW.target_goal_revision_no
		  AND user_id = NEW.user_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target short-term goal revision % not found for goal % (user %)', NEW.target_goal_revision_no, NEW.target_goal_id, NEW.user_id;
		END IF;

		SELECT MAX(revision_no) INTO v_max_goal_rev_no
		FROM short_term_goal_revisions
		WHERE goal_id = NEW.target_goal_id;
		IF v_max_goal_rev_no IS DISTINCT FROM NEW.target_goal_revision_no THEN
			RAISE EXCEPTION 'Target short-term goal revision % for goal % is not the latest revision (latest is %)', NEW.target_goal_revision_no, NEW.target_goal_id, v_max_goal_rev_no;
		END IF;

		IF v_goal_rev.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Target short-term goal revision % for goal % is not ACTIVE (status=%)', NEW.target_goal_revision_no, NEW.target_goal_id, v_goal_rev.status;
		END IF;
	END IF;

	-- Target bucket contract per route (defense-in-depth: ownership and
	-- bucket_type must match the route, and PENDING_LONG_TERM is never a
	-- valid month-close target under any route).
	IF NEW.target_bucket_id IS NOT NULL THEN
		SELECT * INTO v_bucket FROM midas_buckets WHERE id = NEW.target_bucket_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target bucket % not found', NEW.target_bucket_id;
		END IF;
		IF v_bucket.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'Target bucket % does not belong to user %', NEW.target_bucket_id, NEW.user_id;
		END IF;
		IF v_bucket.bucket_type = 'PENDING_LONG_TERM' THEN
			RAISE EXCEPTION 'Month close revision % may never target the PENDING_LONG_TERM bucket', NEW.id;
		END IF;
		IF NEW.route = 'SHORT_TERM_GOAL' AND v_bucket.bucket_type != 'SHORT_TERM_GOAL' THEN
			RAISE EXCEPTION 'SHORT_TERM_GOAL route target bucket % has wrong bucket_type %', NEW.target_bucket_id, v_bucket.bucket_type;
		END IF;
		IF NEW.route = 'MEDIUM_TERM_RESERVE' AND v_bucket.bucket_type != 'MEDIUM_TERM_RESERVE' THEN
			RAISE EXCEPTION 'MEDIUM_TERM_RESERVE route target bucket % has wrong bucket_type %', NEW.target_bucket_id, v_bucket.bucket_type;
		END IF;
		IF v_bucket.midas_account_id IS DISTINCT FROM NEW.midas_account_id THEN
			RAISE EXCEPTION 'Target bucket % does not belong to month close midas_account_id %', NEW.target_bucket_id, NEW.midas_account_id;
		END IF;
	END IF;

	-- Exact Midas allocation transfer companion binding (Section 26).
	IF NEW.midas_allocation_transfer_id IS NOT NULL THEN
		SELECT * INTO v_transfer FROM midas_allocation_transfers WHERE id = NEW.midas_allocation_transfer_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Companion Midas allocation transfer % not found', NEW.midas_allocation_transfer_id;
		END IF;
		IF v_transfer.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'Companion transfer user_id % does not match month close revision user_id %', v_transfer.user_id, NEW.user_id;
		END IF;
		IF v_transfer.midas_account_id IS DISTINCT FROM NEW.midas_account_id THEN
			RAISE EXCEPTION 'Companion transfer midas_account_id % does not match month close midas_account_id %', v_transfer.midas_account_id, NEW.midas_account_id;
		END IF;
		IF v_transfer.reversal_of_transfer_id IS NOT NULL THEN
			RAISE EXCEPTION 'Companion transfer % must not be a Midas reversal', v_transfer.id;
		END IF;
		IF v_transfer.from_bucket_id IS NOT NULL THEN
			RAISE EXCEPTION 'Companion transfer % must originate from UNALLOCATED (from_bucket_id must be NULL), found %', v_transfer.id, v_transfer.from_bucket_id;
		END IF;
		IF v_transfer.to_bucket_id IS DISTINCT FROM NEW.target_bucket_id THEN
			RAISE EXCEPTION 'Companion transfer % to_bucket_id % does not match target_bucket_id %', v_transfer.id, v_transfer.to_bucket_id, NEW.target_bucket_id;
		END IF;
		IF v_transfer.amount != NEW.applied_amount THEN
			RAISE EXCEPTION 'Companion transfer % amount % does not match applied_amount %', v_transfer.id, v_transfer.amount, NEW.applied_amount;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_month_close_revision_insert ON "month_close_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_month_close_revision_insert
BEFORE INSERT ON "month_close_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_month_close_revision_insert();
