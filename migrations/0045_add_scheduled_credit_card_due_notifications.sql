CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_event_id" uuid NOT NULL,
	"push_subscription_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" varchar(30) NOT NULL,
	"http_status" integer,
	"error_code" varchar(64),
	"attempted_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_attempts_no_check" CHECK ("notification_delivery_attempts"."attempt_no" > 0 AND "notification_delivery_attempts"."attempt_no" <= 5),
	CONSTRAINT "notification_delivery_attempts_status_check" CHECK ("notification_delivery_attempts"."status" IN ('SUCCESS', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE', 'SUPPRESSED_OBSOLETE')),
	CONSTRAINT "notification_delivery_attempts_http_status_check" CHECK ("notification_delivery_attempts"."http_status" IS NULL OR ("notification_delivery_attempts"."http_status" >= 100 AND "notification_delivery_attempts"."http_status" <= 599)),
	CONSTRAINT "notification_delivery_attempts_error_code_check" CHECK ("notification_delivery_attempts"."error_code" IS NULL OR (length("notification_delivery_attempts"."error_code") >= 1 AND length("notification_delivery_attempts"."error_code") <= 64))
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_type" varchar(30) NOT NULL,
	"subject_id" uuid NOT NULL,
	"scheduled_local_date" date NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_type_check" CHECK ("notification_events"."notification_type" IN ('CREDIT_CARD_DUE'))
);
--> statement-breakpoint
CREATE TABLE "push_subscription_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"previous_revision_id" uuid,
	"operation" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"endpoint" varchar(2048) NOT NULL,
	"p256dh" varchar(128) NOT NULL,
	"auth" varchar(64) NOT NULL,
	"expiration_time" timestamp with time zone,
	"user_agent" varchar(500),
	"disable_reason" varchar(500),
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"revision_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_sub_revisions_rev_no_check" CHECK ("push_subscription_revisions"."revision_no" > 0),
	CONSTRAINT "push_sub_revisions_op_check" CHECK ("push_subscription_revisions"."operation" IN ('REGISTER', 'REFRESH', 'DISABLE', 'REACTIVATE')),
	CONSTRAINT "push_sub_revisions_status_check" CHECK ("push_subscription_revisions"."status" IN ('ACTIVE', 'DISABLED')),
	CONSTRAINT "push_sub_revisions_endpoint_check" CHECK ("push_subscription_revisions"."endpoint" = btrim("push_subscription_revisions"."endpoint") AND length("push_subscription_revisions"."endpoint") >= 1 AND length("push_subscription_revisions"."endpoint") <= 2048 AND "push_subscription_revisions"."endpoint" LIKE 'https://%'),
	CONSTRAINT "push_sub_revisions_p256dh_check" CHECK ("push_subscription_revisions"."p256dh" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "push_sub_revisions_auth_check" CHECK ("push_subscription_revisions"."auth" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "push_sub_revisions_user_agent_check" CHECK ("push_subscription_revisions"."user_agent" IS NULL OR (length("push_subscription_revisions"."user_agent") >= 1 AND length("push_subscription_revisions"."user_agent") <= 500)),
	CONSTRAINT "push_sub_revisions_disable_reason_check" CHECK ("push_subscription_revisions"."disable_reason" IS NULL OR ("push_subscription_revisions"."disable_reason" = btrim("push_subscription_revisions"."disable_reason") AND length("push_subscription_revisions"."disable_reason") >= 1 AND length("push_subscription_revisions"."disable_reason") <= 500)),
	CONSTRAINT "push_sub_revisions_fingerprint_check" CHECK ("push_subscription_revisions"."revision_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "push_sub_revisions_idempotency_check" CHECK ("push_subscription_revisions"."idempotency_key" = btrim("push_subscription_revisions"."idempotency_key") AND length("push_subscription_revisions"."idempotency_key") >= 1 AND length("push_subscription_revisions"."idempotency_key") <= 128)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_hash_check" CHECK ("push_subscriptions"."endpoint_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_event_id_notification_events_id_fk" FOREIGN KEY ("notification_event_id") REFERENCES "public"."notification_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_push_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("push_subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription_revisions" ADD CONSTRAINT "push_subscription_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription_revisions" ADD CONSTRAINT "push_subscription_revisions_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription_revisions" ADD CONSTRAINT "push_subscription_revisions_previous_revision_id_push_subscription_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."push_subscription_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_sub_idx" ON "notification_deliveries" USING btree ("notification_event_id","push_subscription_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_idx" ON "notification_deliveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_event_idx" ON "notification_deliveries" USING btree ("notification_event_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_sub_idx" ON "notification_deliveries" USING btree ("push_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_attempts_delivery_no_idx" ON "notification_delivery_attempts" USING btree ("delivery_id","attempt_no");--> statement-breakpoint
CREATE INDEX "notification_delivery_attempts_delivery_idx" ON "notification_delivery_attempts" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_attempts_user_idx" ON "notification_delivery_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_user_type_subject_idx" ON "notification_events" USING btree ("user_id","notification_type","subject_id");--> statement-breakpoint
CREATE INDEX "notification_events_user_idx" ON "notification_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_events_scheduled_local_date_idx" ON "notification_events" USING btree ("scheduled_local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "push_sub_revisions_sub_rev_idx" ON "push_subscription_revisions" USING btree ("subscription_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "push_sub_revisions_user_idempotency_idx" ON "push_subscription_revisions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "push_sub_revisions_prev_rev_idx" ON "push_subscription_revisions" USING btree ("previous_revision_id") WHERE "push_subscription_revisions"."previous_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "push_sub_revisions_sub_idx" ON "push_subscription_revisions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "push_sub_revisions_user_idx" ON "push_subscription_revisions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_user_endpoint_hash_idx" ON "push_subscriptions" USING btree ("user_id","endpoint_hash");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint

-- ============================================================================
-- PHASE 15: SCHEDULED CREDIT CARD DUE NOTIFICATIONS & WEB PUSH -- DOMAIN
-- INTEGRITY
--
-- A. Immutability (INSERT-only) on all five new tables.
-- B. Push subscription revision chain + lifecycle transition table +
--    user_id binding (BEFORE INSERT).
-- C. Push subscription anchor completeness (naked anchor rejected at
--    commit; revision #1 must be REGISTER/ACTIVE).
-- D. CREDIT_CARD_DUE notification_events binding: subject_id resolves to a
--    real statement owned by the same user whose LATEST revision is OPEN
--    with a matching due_date, and scheduled_for is exactly 12:00
--    Europe/Istanbul (09:00 UTC) on scheduled_local_date (BEFORE INSERT).
-- E. notification_deliveries cross-user guard + subscription-must-be-
--    ACTIVE guard (BEFORE INSERT).
-- F. notification_deliveries anchor completeness (naked delivery-with-
--    zero-attempts rejected at commit).
-- G. notification_delivery_attempts chain integrity: attempt_no strictly
--    increasing from 1, no attempt after SUCCESS/TERMINAL_FAILURE/
--    SUPPRESSED_OBSOLETE, user_id must match the delivery's user_id
--    (BEFORE INSERT).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_notifications()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is immutable (INSERT-only)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_push_subscriptions ON "push_subscriptions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_push_subscriptions
BEFORE UPDATE OR DELETE ON "push_subscriptions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_notifications();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_push_subscription_revisions ON "push_subscription_revisions";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_push_subscription_revisions
BEFORE UPDATE OR DELETE ON "push_subscription_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_notifications();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_notification_events ON "notification_events";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_notification_events
BEFORE UPDATE OR DELETE ON "notification_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_notifications();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_notification_deliveries ON "notification_deliveries";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_notification_deliveries
BEFORE UPDATE OR DELETE ON "notification_deliveries"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_notifications();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_notification_delivery_attempts ON "notification_delivery_attempts";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_notification_delivery_attempts
BEFORE UPDATE OR DELETE ON "notification_delivery_attempts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_notifications();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. PUSH SUBSCRIPTION REVISION CHAIN + TRANSITIONS + USER BINDING
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_push_subscription_revision_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_anchor RECORD;
	v_latest RECORD;
BEGIN
	SELECT * INTO v_anchor FROM push_subscriptions WHERE id = NEW.subscription_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Push subscription % not found', NEW.subscription_id;
	END IF;
	IF v_anchor.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Push subscription % user_id % does not match revision user_id %', NEW.subscription_id, v_anchor.user_id, NEW.user_id;
	END IF;

	SELECT id, revision_no, operation, status INTO v_latest
	FROM push_subscription_revisions
	WHERE subscription_id = NEW.subscription_id
	ORDER BY revision_no DESC
	LIMIT 1;

	IF NEW.revision_no = 1 THEN
		IF v_latest.id IS NOT NULL THEN
			RAISE EXCEPTION 'Push subscription % already has revisions; revision 1 cannot be created again', NEW.subscription_id;
		END IF;
		IF NEW.previous_revision_id IS NOT NULL THEN
			RAISE EXCEPTION 'First revision must have previous_revision_id NULL';
		END IF;
		IF NEW.operation != 'REGISTER' THEN
			RAISE EXCEPTION 'First revision must have operation REGISTER, found %', NEW.operation;
		END IF;
		IF NEW.status != 'ACTIVE' THEN
			RAISE EXCEPTION 'First revision must have status ACTIVE, found %', NEW.status;
		END IF;
	ELSE
		IF v_latest.id IS NULL THEN
			RAISE EXCEPTION 'No predecessor revision exists for push subscription %', NEW.subscription_id;
		END IF;
		IF NEW.previous_revision_id IS DISTINCT FROM v_latest.id THEN
			RAISE EXCEPTION 'Previous revision % is not current latest revision % of push subscription % (branching forbidden)',
				NEW.previous_revision_id, v_latest.id, NEW.subscription_id;
		END IF;
		IF v_latest.revision_no != (NEW.revision_no - 1) THEN
			RAISE EXCEPTION 'Latest revision_no % is not predecessor of %', v_latest.revision_no, NEW.revision_no;
		END IF;

		IF v_latest.status = 'ACTIVE' THEN
			IF NEW.operation = 'DISABLE' THEN
				IF NEW.status != 'DISABLED' THEN
					RAISE EXCEPTION 'DISABLE operation must set status DISABLED, found %', NEW.status;
				END IF;
			ELSIF NEW.operation = 'REFRESH' THEN
				IF NEW.status != 'ACTIVE' THEN
					RAISE EXCEPTION 'REFRESH operation must set status ACTIVE, found %', NEW.status;
				END IF;
			ELSE
				RAISE EXCEPTION 'From ACTIVE status, only DISABLE or REFRESH are valid operations, found %', NEW.operation;
			END IF;
		ELSIF v_latest.status = 'DISABLED' THEN
			IF NEW.operation != 'REACTIVATE' THEN
				RAISE EXCEPTION 'From DISABLED status, only REACTIVATE is a valid operation, found %', NEW.operation;
			END IF;
			IF NEW.status != 'ACTIVE' THEN
				RAISE EXCEPTION 'REACTIVATE operation must set status ACTIVE, found %', NEW.status;
			END IF;
		ELSE
			RAISE EXCEPTION 'Unexpected predecessor status % for push subscription %', v_latest.status, NEW.subscription_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_push_subscription_revision_insert ON "push_subscription_revisions";--> statement-breakpoint
CREATE TRIGGER trg_guard_push_subscription_revision_insert
BEFORE INSERT ON "push_subscription_revisions"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_push_subscription_revision_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- C. PUSH SUBSCRIPTION ANCHOR COMPLETENESS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_push_subscription_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT EXISTS(SELECT 1 FROM push_subscription_revisions WHERE subscription_id = NEW.id) INTO v_found;
	IF NOT v_found THEN
		RAISE EXCEPTION 'Push subscription % has no revisions at commit (naked subscription anchor)', NEW.id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_push_subscription_anchor_completeness ON "push_subscriptions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_push_subscription_anchor_completeness
AFTER INSERT ON "push_subscriptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_push_subscription_anchor_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- D. CREDIT_CARD_DUE NOTIFICATION_EVENTS BINDING
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_event_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_statement RECORD;
	v_latest_rev RECORD;
	v_expected_scheduled_for TIMESTAMPTZ;
BEGIN
	IF NEW.notification_type = 'CREDIT_CARD_DUE' THEN
		SELECT * INTO v_statement FROM credit_card_statements WHERE id = NEW.subject_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'CREDIT_CARD_DUE event subject_id % does not resolve to a real credit card statement', NEW.subject_id;
		END IF;
		IF v_statement.user_id IS DISTINCT FROM NEW.user_id THEN
			RAISE EXCEPTION 'Credit card statement % user_id % does not match event user_id %', NEW.subject_id, v_statement.user_id, NEW.user_id;
		END IF;

		SELECT * INTO v_latest_rev
		FROM credit_card_statement_revisions
		WHERE statement_id = NEW.subject_id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card statement % has no revisions', NEW.subject_id;
		END IF;
		IF v_latest_rev.status != 'OPEN' THEN
			RAISE EXCEPTION 'Credit card statement % latest revision status % is not OPEN', NEW.subject_id, v_latest_rev.status;
		END IF;
		IF v_latest_rev.due_date IS DISTINCT FROM NEW.scheduled_local_date THEN
			RAISE EXCEPTION 'Credit card statement % latest due_date % does not match event scheduled_local_date %',
				NEW.subject_id, v_latest_rev.due_date, NEW.scheduled_local_date;
		END IF;

		-- Europe/Istanbul is a fixed UTC+03:00 offset (no DST since 2016):
		-- 12:00 local == 09:00 UTC on the same calendar date.
		v_expected_scheduled_for := (NEW.scheduled_local_date + TIME '09:00:00') AT TIME ZONE 'UTC';
		IF NEW.scheduled_for IS DISTINCT FROM v_expected_scheduled_for THEN
			RAISE EXCEPTION 'Event scheduled_for % does not match expected 12:00 Europe/Istanbul instant % for scheduled_local_date %',
				NEW.scheduled_for, v_expected_scheduled_for, NEW.scheduled_local_date;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown notification_type %', NEW.notification_type;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_notification_event_insert ON "notification_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_notification_event_insert
BEFORE INSERT ON "notification_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_notification_event_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- E. NOTIFICATION_DELIVERIES CROSS-USER + ACTIVE-SUBSCRIPTION GUARD
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_event RECORD;
	v_subscription RECORD;
	v_latest_sub_rev RECORD;
BEGIN
	SELECT * INTO v_event FROM notification_events WHERE id = NEW.notification_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Notification event % not found', NEW.notification_event_id;
	END IF;
	IF v_event.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Notification event % user_id % does not match delivery user_id %', NEW.notification_event_id, v_event.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_subscription FROM push_subscriptions WHERE id = NEW.push_subscription_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Push subscription % not found', NEW.push_subscription_id;
	END IF;
	IF v_subscription.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Push subscription % user_id % does not match delivery user_id % (cross-user delivery forbidden)',
			NEW.push_subscription_id, v_subscription.user_id, NEW.user_id;
	END IF;

	SELECT status INTO v_latest_sub_rev
	FROM push_subscription_revisions
	WHERE subscription_id = NEW.push_subscription_id
	ORDER BY revision_no DESC
	LIMIT 1;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Push subscription % has no revisions', NEW.push_subscription_id;
	END IF;
	IF v_latest_sub_rev.status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Push subscription % latest status % is not ACTIVE; cannot create a new delivery', NEW.push_subscription_id, v_latest_sub_rev.status;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_notification_delivery_insert ON "notification_deliveries";--> statement-breakpoint
CREATE TRIGGER trg_guard_notification_delivery_insert
BEFORE INSERT ON "notification_deliveries"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_notification_delivery_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- F. NOTIFICATION_DELIVERIES ANCHOR COMPLETENESS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT EXISTS(SELECT 1 FROM notification_delivery_attempts WHERE delivery_id = NEW.id) INTO v_found;
	IF NOT v_found THEN
		RAISE EXCEPTION 'Notification delivery % has no attempts at commit (naked delivery anchor)', NEW.id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_notification_delivery_anchor_completeness ON "notification_deliveries";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_guard_notification_delivery_anchor_completeness
AFTER INSERT ON "notification_deliveries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_notification_delivery_anchor_completeness();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- G. NOTIFICATION_DELIVERY_ATTEMPTS CHAIN INTEGRITY
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_attempt_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_delivery RECORD;
	v_expected_no INT;
	v_last_status TEXT;
BEGIN
	SELECT * INTO v_delivery FROM notification_deliveries WHERE id = NEW.delivery_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Notification delivery % not found', NEW.delivery_id;
	END IF;
	IF v_delivery.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Notification delivery % user_id % does not match attempt user_id %', NEW.delivery_id, v_delivery.user_id, NEW.user_id;
	END IF;

	SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO v_expected_no
	FROM notification_delivery_attempts
	WHERE delivery_id = NEW.delivery_id;

	IF NEW.attempt_no != v_expected_no THEN
		RAISE EXCEPTION 'Notification delivery % attempt_no % does not match expected next attempt_no % (unbranched sequence required)',
			NEW.delivery_id, NEW.attempt_no, v_expected_no;
	END IF;

	IF NEW.attempt_no > 1 THEN
		SELECT status INTO v_last_status
		FROM notification_delivery_attempts
		WHERE delivery_id = NEW.delivery_id AND attempt_no = NEW.attempt_no - 1;

		IF v_last_status != 'RETRYABLE_FAILURE' THEN
			RAISE EXCEPTION 'Notification delivery % preceding attempt status % does not permit a next attempt (only RETRYABLE_FAILURE may be retried)',
				NEW.delivery_id, v_last_status;
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_notification_delivery_attempt_insert ON "notification_delivery_attempts";--> statement-breakpoint
CREATE TRIGGER trg_guard_notification_delivery_attempt_insert
BEFORE INSERT ON "notification_delivery_attempts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_notification_delivery_attempt_insert();