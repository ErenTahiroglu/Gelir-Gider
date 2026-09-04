CREATE TABLE "short_term_goal_priority_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"midas_account_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"ordered_goal_ids" jsonb NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"priority_fingerprint" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stg_priority_rev_no_check" CHECK ("short_term_goal_priority_revisions"."revision_no" > 0),
	CONSTRAINT "stg_priority_fingerprint_check" CHECK ("short_term_goal_priority_revisions"."priority_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stg_priority_idempotency_check" CHECK ("short_term_goal_priority_revisions"."idempotency_key" = btrim("short_term_goal_priority_revisions"."idempotency_key") AND length("short_term_goal_priority_revisions"."idempotency_key") >= 1 AND length("short_term_goal_priority_revisions"."idempotency_key") <= 128),
	CONSTRAINT "stg_priority_json_array_check" CHECK (jsonb_typeof("short_term_goal_priority_revisions"."ordered_goal_ids") = 'array')
);
--> statement-breakpoint
CREATE TABLE "short_term_goal_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"name" varchar(120) NOT NULL,
	"funding_target" numeric(18, 2) NOT NULL,
	"target_date" date,
	"max_budget" numeric(18, 2),
	"target_price" numeric(18, 2),
	"product_url" varchar(2048),
	"note" varchar(500),
	"change_reason" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stg_revisions_rev_no_check" CHECK ("short_term_goal_revisions"."revision_no" > 0),
	CONSTRAINT "stg_revisions_operation_check" CHECK ("short_term_goal_revisions"."operation" IN ('CREATE', 'UPDATE', 'COMPLETE', 'CANCEL')),
	CONSTRAINT "stg_revisions_status_check" CHECK ("short_term_goal_revisions"."status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "stg_revisions_name_check" CHECK ("short_term_goal_revisions"."name" = btrim("short_term_goal_revisions"."name") AND length("short_term_goal_revisions"."name") >= 1 AND length("short_term_goal_revisions"."name") <= 120),
	CONSTRAINT "stg_revisions_target_check" CHECK ("short_term_goal_revisions"."funding_target" > 0),
	CONSTRAINT "stg_revisions_max_budget_check" CHECK ("short_term_goal_revisions"."max_budget" IS NULL OR ("short_term_goal_revisions"."max_budget" > 0 AND "short_term_goal_revisions"."funding_target" <= "short_term_goal_revisions"."max_budget")),
	CONSTRAINT "stg_revisions_target_price_check" CHECK ("short_term_goal_revisions"."target_price" IS NULL OR "short_term_goal_revisions"."target_price" > 0),
	CONSTRAINT "stg_revisions_product_url_check" CHECK ("short_term_goal_revisions"."product_url" IS NULL OR ("short_term_goal_revisions"."product_url" = btrim("short_term_goal_revisions"."product_url") AND length("short_term_goal_revisions"."product_url") >= 1 AND length("short_term_goal_revisions"."product_url") <= 2048 AND "short_term_goal_revisions"."product_url" ~* '^https?://')),
	CONSTRAINT "stg_revisions_note_check" CHECK ("short_term_goal_revisions"."note" IS NULL OR ("short_term_goal_revisions"."note" = btrim("short_term_goal_revisions"."note") AND length("short_term_goal_revisions"."note") >= 1 AND length("short_term_goal_revisions"."note") <= 500)),
	CONSTRAINT "stg_revisions_change_reason_check" CHECK ("short_term_goal_revisions"."change_reason" IS NULL OR ("short_term_goal_revisions"."change_reason" = btrim("short_term_goal_revisions"."change_reason") AND length("short_term_goal_revisions"."change_reason") >= 1 AND length("short_term_goal_revisions"."change_reason") <= 500)),
	CONSTRAINT "stg_revisions_fingerprint_check" CHECK ("short_term_goal_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stg_revisions_idempotency_check" CHECK ("short_term_goal_revisions"."idempotency_key" = btrim("short_term_goal_revisions"."idempotency_key") AND length("short_term_goal_revisions"."idempotency_key") >= 1 AND length("short_term_goal_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "short_term_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"midas_account_id" uuid NOT NULL,
	"midas_bucket_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "short_term_goal_priority_revisions" ADD CONSTRAINT "short_term_goal_priority_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_priority_revisions" ADD CONSTRAINT "short_term_goal_priority_revisions_midas_account_id_midas_accounts_id_fk" FOREIGN KEY ("midas_account_id") REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_priority_revisions" ADD CONSTRAINT "short_term_goal_priority_revisions_previous_revision_id_short_term_goal_priority_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."short_term_goal_priority_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_revisions" ADD CONSTRAINT "short_term_goal_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_revisions" ADD CONSTRAINT "short_term_goal_revisions_goal_id_short_term_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."short_term_goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goal_revisions" ADD CONSTRAINT "short_term_goal_revisions_previous_revision_id_short_term_goal_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."short_term_goal_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goals" ADD CONSTRAINT "short_term_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goals" ADD CONSTRAINT "short_term_goals_midas_account_id_midas_accounts_id_fk" FOREIGN KEY ("midas_account_id") REFERENCES "public"."midas_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_term_goals" ADD CONSTRAINT "short_term_goals_midas_bucket_id_midas_buckets_id_fk" FOREIGN KEY ("midas_bucket_id") REFERENCES "public"."midas_buckets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stg_priority_acc_rev_idx" ON "short_term_goal_priority_revisions" USING btree ("midas_account_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stg_priority_user_idempotency_idx" ON "short_term_goal_priority_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stg_priority_prev_rev_idx" ON "short_term_goal_priority_revisions" USING btree ("previous_revision_id") WHERE "short_term_goal_priority_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stg_priority_account_idx" ON "short_term_goal_priority_revisions" USING btree ("midas_account_id");--> statement-breakpoint
CREATE INDEX "stg_priority_user_idx" ON "short_term_goal_priority_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stg_revisions_goal_rev_idx" ON "short_term_goal_revisions" USING btree ("goal_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stg_revisions_user_idempotency_idx" ON "short_term_goal_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stg_revisions_prev_rev_idx" ON "short_term_goal_revisions" USING btree ("previous_revision_id") WHERE "short_term_goal_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stg_revisions_goal_idx" ON "short_term_goal_revisions" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "stg_revisions_user_idx" ON "short_term_goal_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "short_term_goals_bucket_idx" ON "short_term_goals" USING btree ("midas_bucket_id");--> statement-breakpoint
CREATE INDEX "short_term_goals_account_idx" ON "short_term_goals" USING btree ("midas_account_id");--> statement-breakpoint
CREATE INDEX "short_term_goals_user_idx" ON "short_term_goals" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- 1. SHORT_TERM_GOALS IMMUTABILITY & INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_short_term_goals_immutability()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'short_term_goals rows are immutable and cannot be updated';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'short_term_goals rows cannot be deleted';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_short_term_goals_immutability
BEFORE UPDATE OR DELETE ON "short_term_goals"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_short_term_goals_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_short_term_goals_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_bucket RECORD;
BEGIN
	SELECT * INTO v_bucket FROM midas_buckets WHERE id = NEW.midas_bucket_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Midas bucket % not found', NEW.midas_bucket_id;
	END IF;

	IF v_bucket.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Midas bucket user_id % does not match goal user_id %', v_bucket.user_id, NEW.user_id;
	END IF;

	IF v_bucket.midas_account_id != NEW.midas_account_id THEN
		RAISE EXCEPTION 'Midas bucket account_id % does not match goal account_id %', v_bucket.midas_account_id, NEW.midas_account_id;
	END IF;

	IF v_bucket.bucket_type != 'SHORT_TERM_GOAL' THEN
		RAISE EXCEPTION 'Short-term goal bucket must have bucket_type SHORT_TERM_GOAL, found %', v_bucket.bucket_type;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_short_term_goals_insert
BEFORE INSERT ON "short_term_goals"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_short_term_goals_insert();--> statement-breakpoint

-- ============================================================================
-- 2. SHORT_TERM_GOAL_REVISIONS IMMUTABILITY & INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_stg_revisions_immutability()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'short_term_goal_revisions rows are immutable and cannot be updated';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'short_term_goal_revisions rows cannot be deleted';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_stg_revisions_immutability
BEFORE UPDATE OR DELETE ON "short_term_goal_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_stg_revisions_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_stg_revisions_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_goal RECORD;
	v_midas_acc RECORD;
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

	-- 2. Lock parent Midas account FOR UPDATE
	SELECT * INTO v_midas_acc FROM midas_accounts WHERE id = v_goal.midas_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Midas account % not found', v_goal.midas_account_id;
	END IF;

	-- 3. Derive current linked bucket balance
	SELECT COALESCE(SUM(CASE WHEN to_bucket_id = v_goal.midas_bucket_id THEN amount WHEN from_bucket_id = v_goal.midas_bucket_id THEN -amount ELSE 0 END), 0)
	INTO v_bucket_balance
	FROM midas_allocation_transfers
	WHERE midas_account_id = v_goal.midas_account_id;

	-- 4. Validate revision sequence & lifecycle state machine
	IF NEW.revision_no = 1 THEN
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
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;

		SELECT * INTO v_pred
		FROM short_term_goal_revisions
		WHERE id = NEW.previous_revision_id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Previous revision % not found', NEW.previous_revision_id;
		END IF;

		IF v_pred.goal_id != NEW.goal_id THEN
			RAISE EXCEPTION 'Previous revision % belongs to different goal %', NEW.previous_revision_id, v_pred.goal_id;
		END IF;

		IF v_pred.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Previous revision_no % is not predecessor of %', v_pred.revision_no, NEW.revision_no;
		END IF;

		IF v_pred.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Cannot create revision on non-active goal (current status %)', v_pred.status;
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
			IF NEW.name != v_pred.name OR
			   NEW.funding_target != v_pred.funding_target OR
			   (NEW.target_date IS DISTINCT FROM v_pred.target_date) OR
			   (NEW.max_budget IS DISTINCT FROM v_pred.max_budget) OR
			   (NEW.target_price IS DISTINCT FROM v_pred.target_price) OR
			   (NEW.product_url IS DISTINCT FROM v_pred.product_url) OR
			   (NEW.note IS DISTINCT FROM v_pred.note) THEN
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
			IF NEW.name != v_pred.name OR
			   NEW.funding_target != v_pred.funding_target OR
			   (NEW.target_date IS DISTINCT FROM v_pred.target_date) OR
			   (NEW.max_budget IS DISTINCT FROM v_pred.max_budget) OR
			   (NEW.target_price IS DISTINCT FROM v_pred.target_price) OR
			   (NEW.product_url IS DISTINCT FROM v_pred.product_url) OR
			   (NEW.note IS DISTINCT FROM v_pred.note) THEN
				RAISE EXCEPTION 'CANCEL revision must copy configuration exactly from predecessor';
			END IF;

			IF v_bucket_balance != 0 THEN
				RAISE EXCEPTION 'Cannot cancel short-term goal with non-zero funding balance (%)', v_bucket_balance;
			END IF;
		ELSE
			RAISE EXCEPTION 'Invalid operation %', NEW.operation;
		END IF;
	END IF;

	-- 5. Validate max_budget vs current balance
	IF NEW.max_budget IS NOT NULL THEN
		IF v_bucket_balance > NEW.max_budget THEN
			RAISE EXCEPTION 'Current funding balance (%) exceeds new max_budget (%)', v_bucket_balance, NEW.max_budget;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_stg_revisions_insert
BEFORE INSERT ON "short_term_goal_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_stg_revisions_insert();--> statement-breakpoint

-- ============================================================================
-- 3. SHORT_TERM_GOAL_PRIORITY_REVISIONS IMMUTABILITY & INSERT GUARD
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_stg_priority_immutability()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'short_term_goal_priority_revisions rows are immutable and cannot be updated';
	ELSIF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'short_term_goal_priority_revisions rows cannot be deleted';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_stg_priority_immutability
BEFORE UPDATE OR DELETE ON "short_term_goal_priority_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_stg_priority_immutability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_fn_guard_stg_priority_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_midas_acc RECORD;
	v_pred RECORD;
	v_item jsonb;
	v_goal_id uuid;
	v_goal_rec RECORD;
	v_active_goals_count integer;
	v_supplied_count integer := 0;
	v_seen_ids uuid[] := '{}';
BEGIN
	-- 1. Lock parent Midas account FOR UPDATE
	SELECT * INTO v_midas_acc FROM midas_accounts WHERE id = NEW.midas_account_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Midas account % not found', NEW.midas_account_id;
	END IF;

	IF v_midas_acc.user_id != NEW.user_id THEN
		RAISE EXCEPTION 'Midas account user_id % does not match priority revision user_id %', v_midas_acc.user_id, NEW.user_id;
	END IF;

	-- 2. Validate revision sequence
	IF NEW.revision_no = 1 THEN
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First priority revision must have previous_revision_id NULL';
		END IF;
	ELSE
		IF NEW.previous_revision_id IS NULL THEN
			RAISE EXCEPTION 'Priority revision % must have non-null previous_revision_id', NEW.revision_no;
		END IF;

		SELECT * INTO v_pred
		FROM short_term_goal_priority_revisions
		WHERE id = NEW.previous_revision_id;

		IF NOT FOUND THEN
			RAISE EXCEPTION 'Previous priority revision % not found', NEW.previous_revision_id;
		END IF;

		IF v_pred.midas_account_id != NEW.midas_account_id THEN
			RAISE EXCEPTION 'Previous priority revision % belongs to different Midas account', NEW.previous_revision_id;
		END IF;

		IF v_pred.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Previous priority revision_no % is not predecessor of %', v_pred.revision_no, NEW.revision_no;
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
		IF v_goal_id = ANY(v_seen_ids) THEN
			RAISE EXCEPTION 'Duplicate goal ID in ordered_goal_ids: %', v_goal_id;
		END IF;
		v_seen_ids := array_append(v_seen_ids, v_goal_id);
		v_supplied_count := v_supplied_count + 1;

		-- Check goal belongs to this user and Midas account
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

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_stg_priority_insert
BEFORE INSERT ON "short_term_goal_priority_revisions"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_stg_priority_insert();--> statement-breakpoint

-- ============================================================================
-- 4. DEFERRED CONSTRAINT TRIGGER FOR PRIORITY CONSISTENCY
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_stg_priority_deferred()
RETURNS TRIGGER AS $$
DECLARE
	v_goal RECORD;
	v_latest_priority RECORD;
	v_active_goal_ids uuid[];
	v_priority_goal_ids uuid[] := '{}';
	v_item jsonb;
	v_gid uuid;
BEGIN
	SELECT * INTO v_goal FROM short_term_goals WHERE id = NEW.goal_id;
	IF NOT FOUND THEN
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
	WHERE g.midas_account_id = v_goal.midas_account_id
	  AND r.status = 'ACTIVE';

	IF v_active_goal_ids IS NULL THEN
		v_active_goal_ids := '{}';
	END IF;

	-- Fetch latest priority revision for this Midas account
	SELECT * INTO v_latest_priority
	FROM short_term_goal_priority_revisions
	WHERE midas_account_id = v_goal.midas_account_id
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_guard_stg_priority_deferred
AFTER INSERT ON "short_term_goal_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_stg_priority_deferred();--> statement-breakpoint

-- ============================================================================
-- 5. MIDAS ALLOCATION TRANSFERS GOAL CAP & ACTIVE STATUS GUARD TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_midas_transfers_goal_cap()
RETURNS TRIGGER AS $$
DECLARE
	v_goal RECORD;
	v_latest_rev RECORD;
	v_current_balance NUMERIC;
	v_resulting_balance NUMERIC;
BEGIN
	-- Check if destination bucket belongs to a short-term goal
	SELECT * INTO v_goal
	FROM short_term_goals
	WHERE midas_bucket_id = NEW.to_bucket_id;

	IF FOUND THEN
		-- Lock parent Midas account FOR UPDATE
		PERFORM 1 FROM midas_accounts WHERE id = v_goal.midas_account_id FOR UPDATE;

		-- Fetch latest revision for this goal
		SELECT * INTO v_latest_rev
		FROM short_term_goal_revisions
		WHERE goal_id = v_goal.id
		ORDER BY revision_no DESC
		LIMIT 1;

		IF NOT FOUND OR v_latest_rev.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'Cannot fund short-term goal % because it is not in ACTIVE status', v_goal.id;
		END IF;

		-- Derive current bucket balance
		SELECT COALESCE(SUM(CASE WHEN to_bucket_id = v_goal.midas_bucket_id THEN amount WHEN from_bucket_id = v_goal.midas_bucket_id THEN -amount ELSE 0 END), 0)
		INTO v_current_balance
		FROM midas_allocation_transfers
		WHERE midas_account_id = v_goal.midas_account_id;

		v_resulting_balance := v_current_balance + NEW.amount;

		IF v_latest_rev.max_budget IS NOT NULL AND v_resulting_balance > v_latest_rev.max_budget THEN
			RAISE EXCEPTION 'Funding would exceed short-term goal max budget cap (resulting: %, max: %)', v_resulting_balance, v_latest_rev.max_budget;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER trg_guard_midas_transfers_goal_cap
BEFORE INSERT ON "midas_allocation_transfers"
FOR EACH ROW
EXECUTE FUNCTION trg_fn_guard_midas_transfers_goal_cap();