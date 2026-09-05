CREATE TABLE "month_close_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month_close_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(10) NOT NULL,
	"status" varchar(10) NOT NULL,
	"budget_plan_revision_no" integer NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reference_income" numeric(18, 2) NOT NULL,
	"mandatory_ceiling" numeric(18, 2) NOT NULL,
	"mandatory_expense" numeric(18, 2) NOT NULL,
	"mandatory_unused" numeric(18, 2) NOT NULL,
	"discretionary_ceiling" numeric(18, 2) NOT NULL,
	"discretionary_expense" numeric(18, 2) NOT NULL,
	"discretionary_unused" numeric(18, 2) NOT NULL,
	"unclassified_expense" numeric(18, 2) NOT NULL,
	"close_surplus" numeric(18, 2) NOT NULL,
	"route" varchar(20) NOT NULL,
	"decision" varchar(20) NOT NULL,
	"midas_account_id" uuid,
	"target_goal_id" uuid,
	"target_goal_revision_no" integer,
	"target_bucket_id" uuid,
	"full_offer_amount" numeric(18, 2) NOT NULL,
	"applied_amount" numeric(18, 2) NOT NULL,
	"unrouted_amount" numeric(18, 2) NOT NULL,
	"midas_allocation_transfer_id" uuid,
	"proposal_fingerprint" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_close_revisions_rev_no_check" CHECK ("month_close_revisions"."revision_no" = 1),
	CONSTRAINT "month_close_revisions_prev_rev_null_check" CHECK ("month_close_revisions"."previous_revision_id" IS NULL),
	CONSTRAINT "month_close_revisions_op_check" CHECK ("month_close_revisions"."operation" = 'CLOSE'),
	CONSTRAINT "month_close_revisions_status_check" CHECK ("month_close_revisions"."status" = 'CLOSED'),
	CONSTRAINT "month_close_revisions_budget_plan_rev_no_check" CHECK ("month_close_revisions"."budget_plan_revision_no" > 0),
	CONSTRAINT "month_close_revisions_policy_check" CHECK ("month_close_revisions"."policy_version" = 'PERSONAL_BUDGET_V1'),
	CONSTRAINT "month_close_revisions_currency_check" CHECK ("month_close_revisions"."currency" = btrim("month_close_revisions"."currency") AND length("month_close_revisions"."currency") = 3),
	CONSTRAINT "month_close_revisions_reference_income_check" CHECK ("month_close_revisions"."reference_income" >= 0),
	CONSTRAINT "month_close_revisions_mandatory_ceiling_check" CHECK ("month_close_revisions"."mandatory_ceiling" >= 0),
	CONSTRAINT "month_close_revisions_mandatory_unused_check" CHECK ("month_close_revisions"."mandatory_unused" >= 0 AND "month_close_revisions"."mandatory_unused" = GREATEST("month_close_revisions"."mandatory_ceiling" - GREATEST("month_close_revisions"."mandatory_expense", 0), 0)),
	CONSTRAINT "month_close_revisions_discretionary_ceiling_check" CHECK ("month_close_revisions"."discretionary_ceiling" >= 0),
	CONSTRAINT "month_close_revisions_discretionary_unused_check" CHECK ("month_close_revisions"."discretionary_unused" >= 0 AND "month_close_revisions"."discretionary_unused" = GREATEST("month_close_revisions"."discretionary_ceiling" - GREATEST("month_close_revisions"."discretionary_expense", 0), 0)),
	CONSTRAINT "month_close_revisions_unclassified_check" CHECK ("month_close_revisions"."unclassified_expense" = 0),
	CONSTRAINT "month_close_revisions_surplus_check" CHECK ("month_close_revisions"."close_surplus" = "month_close_revisions"."mandatory_unused" + "month_close_revisions"."discretionary_unused"),
	CONSTRAINT "month_close_revisions_unrouted_check" CHECK ("month_close_revisions"."unrouted_amount" = "month_close_revisions"."close_surplus" - "month_close_revisions"."applied_amount"),
	CONSTRAINT "month_close_revisions_applied_nonneg_check" CHECK ("month_close_revisions"."applied_amount" >= 0),
	CONSTRAINT "month_close_revisions_unrouted_nonneg_check" CHECK ("month_close_revisions"."unrouted_amount" >= 0),
	CONSTRAINT "month_close_revisions_full_offer_nonneg_check" CHECK ("month_close_revisions"."full_offer_amount" >= 0),
	CONSTRAINT "month_close_revisions_full_offer_scope_check" CHECK ("month_close_revisions"."route" = 'SHORT_TERM_GOAL' OR "month_close_revisions"."full_offer_amount" = 0),
	CONSTRAINT "month_close_revisions_route_check" CHECK ("month_close_revisions"."route" IN ('SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE', 'NONE')),
	CONSTRAINT "month_close_revisions_decision_check" CHECK ("month_close_revisions"."decision" IN ('FULL', 'PARTIAL', 'SKIP', 'AUTO_MEDIUM', 'NO_ACTION')),
	CONSTRAINT "month_close_revisions_goal_fields_check" CHECK (("month_close_revisions"."route" = 'SHORT_TERM_GOAL') = ("month_close_revisions"."target_goal_id" IS NOT NULL) AND ("month_close_revisions"."route" = 'SHORT_TERM_GOAL') = ("month_close_revisions"."target_goal_revision_no" IS NOT NULL) AND ("month_close_revisions"."route" IN ('SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE')) = ("month_close_revisions"."target_bucket_id" IS NOT NULL)),
	CONSTRAINT "month_close_revisions_shape_check" CHECK (
				("month_close_revisions"."route" = 'SHORT_TERM_GOAL' AND "month_close_revisions"."decision" = 'FULL' AND "month_close_revisions"."applied_amount" = "month_close_revisions"."full_offer_amount" AND "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL)
				OR ("month_close_revisions"."route" = 'SHORT_TERM_GOAL' AND "month_close_revisions"."decision" = 'PARTIAL' AND "month_close_revisions"."applied_amount" > 0 AND "month_close_revisions"."applied_amount" < "month_close_revisions"."full_offer_amount" AND "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL)
				OR ("month_close_revisions"."route" = 'SHORT_TERM_GOAL' AND "month_close_revisions"."decision" = 'SKIP' AND "month_close_revisions"."applied_amount" = 0 AND "month_close_revisions"."midas_allocation_transfer_id" IS NULL)
				OR ("month_close_revisions"."route" = 'MEDIUM_TERM_RESERVE' AND "month_close_revisions"."decision" = 'AUTO_MEDIUM' AND "month_close_revisions"."applied_amount" = "month_close_revisions"."close_surplus" AND "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL)
				OR ("month_close_revisions"."route" = 'NONE' AND "month_close_revisions"."decision" = 'NO_ACTION' AND "month_close_revisions"."close_surplus" = 0 AND "month_close_revisions"."applied_amount" = 0 AND "month_close_revisions"."midas_allocation_transfer_id" IS NULL)
			),
	CONSTRAINT "month_close_revisions_proposal_fingerprint_check" CHECK ("month_close_revisions"."proposal_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "month_close_revisions_fingerprint_check" CHECK ("month_close_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "month_close_revisions_idempotency_check" CHECK ("month_close_revisions"."idempotency_key" = btrim("month_close_revisions"."idempotency_key") AND length("month_close_revisions"."idempotency_key") >= 1 AND length("month_close_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "month_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"budget_plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_closes_period_month_check" CHECK (EXTRACT(DAY FROM "month_closes"."period_month") = 1)
);
--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_month_close_id_month_closes_id_fk" FOREIGN KEY ("month_close_id") REFERENCES "public"."month_closes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_previous_revision_id_month_close_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."month_close_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_midas_account_id_midas_accounts_id_fk" FOREIGN KEY ("midas_account_id") REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_target_goal_id_short_term_goals_id_fk" FOREIGN KEY ("target_goal_id") REFERENCES "public"."short_term_goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_target_bucket_id_midas_buckets_id_fk" FOREIGN KEY ("target_bucket_id") REFERENCES "public"."midas_buckets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_close_revisions" ADD CONSTRAINT "month_close_revisions_midas_allocation_transfer_id_midas_allocation_transfers_id_fk" FOREIGN KEY ("midas_allocation_transfer_id") REFERENCES "public"."midas_allocation_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_closes" ADD CONSTRAINT "month_closes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_closes" ADD CONSTRAINT "month_closes_budget_plan_id_monthly_budget_plans_id_fk" FOREIGN KEY ("budget_plan_id") REFERENCES "public"."monthly_budget_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "month_close_revisions_close_rev_idx" ON "month_close_revisions" USING btree ("month_close_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "month_close_revisions_user_idempotency_idx" ON "month_close_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "month_close_revisions_prev_rev_idx" ON "month_close_revisions" USING btree ("previous_revision_id") WHERE "month_close_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "month_close_revisions_transfer_idx" ON "month_close_revisions" USING btree ("midas_allocation_transfer_id") WHERE "month_close_revisions"."midas_allocation_transfer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "month_close_revisions_close_idx" ON "month_close_revisions" USING btree ("month_close_id");--> statement-breakpoint
CREATE INDEX "month_close_revisions_user_idx" ON "month_close_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "month_close_revisions_goal_idx" ON "month_close_revisions" USING btree ("target_goal_id");--> statement-breakpoint
CREATE INDEX "month_close_revisions_midas_account_idx" ON "month_close_revisions" USING btree ("midas_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "month_closes_user_period_idx" ON "month_closes" USING btree ("user_id","period_month");--> statement-breakpoint
CREATE INDEX "month_closes_user_idx" ON "month_closes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "month_closes_budget_plan_idx" ON "month_closes" USING btree ("budget_plan_id");--> statement-breakpoint

-- ============================================================================
-- PHASE 14: MONTH-END SURPLUS CLOSE & ROUTING DOMAIN INTEGRITY
--
-- A. Immutability (INSERT-only) on both new tables.
-- B. Anchor completeness (naked month-close anchor rejected at commit --
--    every month_closes row must have exactly one revision #1).
-- C. Revision insert guard (BEFORE INSERT): month-close <-> budget-plan
--    binding (same user, same period, exact ceiling/reference/policy/
--    currency equality against the referenced budget-plan revision) and
--    exact Midas allocation transfer companion binding per route (same
--    user, same Midas account, from UNALLOCATED only, exact target bucket
--    per route, exact amount, never a reversal, never PENDING_LONG_TERM).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_month_close()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is immutable (INSERT-only)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_month_closes ON "month_closes";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_month_closes
BEFORE UPDATE OR DELETE ON "month_closes"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_month_close();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_month_close_revisions ON "month_close_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_month_close_revisions
BEFORE UPDATE OR DELETE ON "month_close_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_month_close();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. ANCHOR COMPLETENESS: NAKED MONTH-CLOSE ANCHOR REJECTED
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_month_close_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_count INT;
BEGIN
	SELECT count(*) INTO v_count FROM month_close_revisions WHERE month_close_id = NEW.id;
	IF v_count != 1 THEN
		RAISE EXCEPTION 'Month close % has % linked month_close_revisions rows at commit (naked month-close anchor; expected exactly 1)', NEW.id, v_count;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_month_close_anchor_completeness ON "month_closes";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_month_close_anchor_completeness
AFTER INSERT ON "month_closes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_month_close_anchor_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- C. REVISION INSERT GUARD: BUDGET-PLAN BINDING + TRANSFER COMPANION BINDING
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_month_close_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_close RECORD;
	v_plan RECORD;
	v_plan_rev RECORD;
	v_transfer RECORD;
	v_bucket RECORD;
	v_goal RECORD;
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

	-- Route/decision-specific target binding (Section 27): SHORT_TERM_GOAL
	-- must resolve to a real goal owned by the same user/Midas account whose
	-- current bucket matches target_bucket_id exactly.
	IF NEW.route = 'SHORT_TERM_GOAL' THEN
		SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.target_goal_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target short-term goal % not found', NEW.target_goal_id;
		END IF;
		IF v_goal.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Target short-term goal % does not belong to user %', NEW.target_goal_id, NEW.user_id;
		END IF;
		IF NEW.midas_account_id IS NULL OR v_goal.midas_account_id != NEW.midas_account_id THEN
			RAISE EXCEPTION 'Target short-term goal % Midas account does not match month close midas_account_id %', NEW.target_goal_id, NEW.midas_account_id;
		END IF;
		IF v_goal.midas_bucket_id != NEW.target_bucket_id THEN
			RAISE EXCEPTION 'Target short-term goal % bucket % does not match target_bucket_id %', NEW.target_goal_id, v_goal.midas_bucket_id, NEW.target_bucket_id;
		END IF;
	END IF;

	-- Target bucket contract per route (defense-in-depth: bucket_type must
	-- match the route, and PENDING_LONG_TERM is never a valid month-close
	-- target under any route).
	IF NEW.target_bucket_id IS NOT NULL THEN
		SELECT * INTO v_bucket FROM midas_buckets WHERE id = NEW.target_bucket_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Target bucket % not found', NEW.target_bucket_id;
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
		IF v_bucket.midas_account_id != NEW.midas_account_id THEN
			RAISE EXCEPTION 'Target bucket % does not belong to month close midas_account_id %', NEW.target_bucket_id, NEW.midas_account_id;
		END IF;
	END IF;

	-- Exact Midas allocation transfer companion binding (Section 26).
	IF NEW.midas_allocation_transfer_id IS NOT NULL THEN
		SELECT * INTO v_transfer FROM midas_allocation_transfers WHERE id = NEW.midas_allocation_transfer_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Companion Midas allocation transfer % not found', NEW.midas_allocation_transfer_id;
		END IF;
		IF v_transfer.user_id != NEW.user_id THEN
			RAISE EXCEPTION 'Companion transfer user_id % does not match month close revision user_id %', v_transfer.user_id, NEW.user_id;
		END IF;
		IF v_transfer.midas_account_id != NEW.midas_account_id THEN
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