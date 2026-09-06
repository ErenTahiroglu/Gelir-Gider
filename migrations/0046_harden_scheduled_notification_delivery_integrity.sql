CREATE TABLE "notification_delivery_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"dispatch_no" integer NOT NULL,
	"push_subscription_revision_id" uuid NOT NULL,
	"scheduler_hour_slot" timestamp with time zone NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_dispatches_no_check" CHECK ("notification_delivery_dispatches"."dispatch_no" > 0 AND "notification_delivery_dispatches"."dispatch_no" <= 5)
);
--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD COLUMN "dispatch_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_delivery_dispatches" ADD CONSTRAINT "notification_delivery_dispatches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_dispatches" ADD CONSTRAINT "notification_delivery_dispatches_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_dispatches" ADD CONSTRAINT "notification_delivery_dispatches_push_subscription_revision_id_push_subscription_revisions_id_fk" FOREIGN KEY ("push_subscription_revision_id") REFERENCES "public"."push_subscription_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_dispatches_delivery_no_idx" ON "notification_delivery_dispatches" USING btree ("delivery_id","dispatch_no");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_dispatches_delivery_hour_idx" ON "notification_delivery_dispatches" USING btree ("delivery_id","scheduler_hour_slot");--> statement-breakpoint
CREATE INDEX "notification_delivery_dispatches_delivery_idx" ON "notification_delivery_dispatches" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_dispatches_user_idx" ON "notification_delivery_dispatches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_dispatches_revision_idx" ON "notification_delivery_dispatches" USING btree ("push_subscription_revision_id");--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_dispatch_id_notification_delivery_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."notification_delivery_dispatches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_attempts_dispatch_idx" ON "notification_delivery_attempts" USING btree ("dispatch_id") WHERE "notification_delivery_attempts"."dispatch_id" IS NOT NULL;

-- ============================================================================
-- PHASE 15-R1: HARDEN SCHEDULED NOTIFICATION DELIVERY INTEGRITY
--
-- A/K. notification_delivery_dispatches: append-only (INSERT-only), exact
--      ownership binding (dispatch.user_id = delivery.user_id =
--      event.user_id = revision.user_id), unbranched dispatch_no chain,
--      exact subscription-revision provenance (must belong to the delivery's
--      subscription, same user, ACTIVE, and be the LATEST revision at
--      reservation time), and >=12:00-same-day dispatch-time authority
--      (BEFORE INSERT). Uniqueness on (delivery_id, dispatch_no) and
--      (delivery_id, scheduler_hour_slot) is what makes "at most one network
--      dispatch per delivery per hourly scheduler slot" DB-provable.
-- B.   notification_delivery_attempts: dispatch_id binding integrity (a
--      completed network attempt result binds to exactly one dispatch
--      reservation belonging to the same delivery; SUPPRESSED_OBSOLETE
--      never carries a dispatch_id) + the same >=12:00-same-day time
--      authority re-applied to attempted_at.
-- C.   notification_deliveries anchor completeness widened: a delivery may
--      now legitimately commit with >=1 dispatch reservation OR >=1 attempt
--      (never neither).
-- D.   push_subscription_revisions: endpoint immutability across every
--      revision after #1, and exact DISABLE copy-forward of
--      endpoint/p256dh/auth/expiration_time/user_agent.
-- E.   push_subscription_revisions: exact base64url length hardening for
--      p256dh (65 raw bytes -> 87 chars) and auth (16 raw bytes -> 22
--      chars).
-- F.   notification_events: exact 3-key / nested-5-key CREDIT_CARD_DUE
--      payload shape validator (privacy-safe, no financial figures),
--      folded into the existing trg_fn_guard_notification_event_insert.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. IMMUTABILITY ON notification_delivery_dispatches
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_deny_mutation_notification_delivery_dispatches ON "notification_delivery_dispatches";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_notification_delivery_dispatches
BEFORE UPDATE OR DELETE ON "notification_delivery_dispatches"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_notifications();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- B. notification_delivery_dispatches: OWNERSHIP + CHAIN + PROVENANCE + TIME
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_dispatch_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_delivery RECORD;
	v_event RECORD;
	v_revision RECORD;
	v_latest_revision_id UUID;
	v_expected_no INT;
	v_reserved_local_date DATE;
BEGIN
	SELECT * INTO v_delivery FROM notification_deliveries WHERE id = NEW.delivery_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Notification delivery % not found', NEW.delivery_id;
	END IF;
	IF v_delivery.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Notification delivery % user_id % does not match dispatch user_id %', NEW.delivery_id, v_delivery.user_id, NEW.user_id;
	END IF;

	SELECT * INTO v_event FROM notification_events WHERE id = v_delivery.notification_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Notification event % not found for delivery %', v_delivery.notification_event_id, NEW.delivery_id;
	END IF;
	IF v_event.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Notification event % user_id % does not match dispatch user_id %', v_delivery.notification_event_id, v_event.user_id, NEW.user_id;
	END IF;

	-- Exact subscription-revision provenance (Section B/14/30): the bound
	-- revision must belong to this delivery's subscription, the same user,
	-- be currently ACTIVE, and be the LATEST revision for that subscription
	-- right now (i.e. it genuinely IS "the" active revision at reservation
	-- time, not a superseded one).
	SELECT * INTO v_revision FROM push_subscription_revisions WHERE id = NEW.push_subscription_revision_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Push subscription revision % not found', NEW.push_subscription_revision_id;
	END IF;
	IF v_revision.subscription_id IS DISTINCT FROM v_delivery.push_subscription_id THEN
		RAISE EXCEPTION 'Push subscription revision % subscription_id % does not match delivery push_subscription_id %',
			NEW.push_subscription_revision_id, v_revision.subscription_id, v_delivery.push_subscription_id;
	END IF;
	IF v_revision.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Push subscription revision % user_id % does not match dispatch user_id %', NEW.push_subscription_revision_id, v_revision.user_id, NEW.user_id;
	END IF;
	IF v_revision.status != 'ACTIVE' THEN
		RAISE EXCEPTION 'Push subscription revision % status % is not ACTIVE; cannot reserve a dispatch against it', NEW.push_subscription_revision_id, v_revision.status;
	END IF;

	SELECT id INTO v_latest_revision_id
	FROM push_subscription_revisions
	WHERE subscription_id = v_delivery.push_subscription_id
	ORDER BY revision_no DESC
	LIMIT 1;
	IF v_latest_revision_id IS DISTINCT FROM NEW.push_subscription_revision_id THEN
		RAISE EXCEPTION 'Push subscription revision % is not the current latest revision % of subscription % (a newer revision exists; reservation must bind to the exact revision in use)',
			NEW.push_subscription_revision_id, v_latest_revision_id, v_delivery.push_subscription_id;
	END IF;

	-- Unbranched dispatch_no chain (mirrors the attempt chain, Section A).
	SELECT COALESCE(MAX(dispatch_no), 0) + 1 INTO v_expected_no
	FROM notification_delivery_dispatches
	WHERE delivery_id = NEW.delivery_id;
	IF NEW.dispatch_no != v_expected_no THEN
		RAISE EXCEPTION 'Notification delivery % dispatch_no % does not match expected next dispatch_no % (unbranched sequence required)',
			NEW.delivery_id, NEW.dispatch_no, v_expected_no;
	END IF;

	-- >=12:00-and-same-day dispatch-time authority (Section E/20): a
	-- dispatch may only be reserved at or after the event's scheduled_for
	-- instant, and on the exact same Europe/Istanbul calendar date as the
	-- event's scheduled_local_date. Fixed +03:00 arithmetic (no tzdata
	-- dependency), mirroring migration 0045's local-date -> UTC direction.
	IF NEW.reserved_at < v_event.scheduled_for THEN
		RAISE EXCEPTION 'Dispatch reserved_at % is before event scheduled_for % for delivery %', NEW.reserved_at, v_event.scheduled_for, NEW.delivery_id;
	END IF;
	v_reserved_local_date := ((NEW.reserved_at AT TIME ZONE 'UTC') + INTERVAL '3 hours')::date;
	IF v_reserved_local_date IS DISTINCT FROM v_event.scheduled_local_date THEN
		RAISE EXCEPTION 'Dispatch reserved_at % Europe/Istanbul local date % does not match event scheduled_local_date % for delivery %',
			NEW.reserved_at, v_reserved_local_date, v_event.scheduled_local_date, NEW.delivery_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_notification_delivery_dispatch_insert ON "notification_delivery_dispatches";--> statement-breakpoint
CREATE TRIGGER trg_guard_notification_delivery_dispatch_insert
BEFORE INSERT ON "notification_delivery_dispatches"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_notification_delivery_dispatch_insert();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- C. notification_delivery_attempts: dispatch_id BINDING + TIME AUTHORITY
--    (CREATE OR REPLACE of the existing 0045 chain-integrity trigger)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_attempt_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_delivery RECORD;
	v_event RECORD;
	v_dispatch RECORD;
	v_expected_no INT;
	v_last_status TEXT;
	v_attempted_local_date DATE;
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

	-- Dispatch reservation binding (Phase 15-R1 Section A/J/31): every
	-- network-attempted outcome must bind to exactly one dispatch
	-- reservation belonging to the SAME delivery, and that reservation must
	-- not already have a bound result. SUPPRESSED_OBSOLETE is the only
	-- status permitted to skip the network entirely (no dispatch needed).
	IF NEW.status = 'SUPPRESSED_OBSOLETE' THEN
		IF NEW.dispatch_id IS NOT NULL THEN
			RAISE EXCEPTION 'SUPPRESSED_OBSOLETE notification delivery attempts must not bind a dispatch reservation (no network call was ever attempted)';
		END IF;
	ELSE
		IF NEW.dispatch_id IS NULL THEN
			RAISE EXCEPTION 'Notification delivery attempt with status % must bind the exact dispatch reservation whose network call it resolves', NEW.status;
		END IF;
		SELECT * INTO v_dispatch FROM notification_delivery_dispatches WHERE id = NEW.dispatch_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Notification delivery dispatch reservation % not found', NEW.dispatch_id;
		END IF;
		IF v_dispatch.delivery_id IS DISTINCT FROM NEW.delivery_id THEN
			RAISE EXCEPTION 'Dispatch reservation % belongs to delivery %, not attempt delivery % (cross-delivery binding forbidden)',
				NEW.dispatch_id, v_dispatch.delivery_id, NEW.delivery_id;
		END IF;
		IF EXISTS (SELECT 1 FROM notification_delivery_attempts WHERE dispatch_id = NEW.dispatch_id) THEN
			RAISE EXCEPTION 'Dispatch reservation % already has a bound attempt result (exactly one result per reservation)', NEW.dispatch_id;
		END IF;
	END IF;

	-- >=12:00-and-same-day time authority re-applied to attempted_at
	-- (Section E/20 defense-in-depth: attempts carry an independent
	-- attempted_at distinct from the dispatch's reserved_at).
	SELECT * INTO v_event FROM notification_events WHERE id = v_delivery.notification_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Notification event % not found for delivery %', v_delivery.notification_event_id, NEW.delivery_id;
	END IF;
	IF NEW.attempted_at < v_event.scheduled_for THEN
		RAISE EXCEPTION 'Attempt attempted_at % is before event scheduled_for % for delivery %', NEW.attempted_at, v_event.scheduled_for, NEW.delivery_id;
	END IF;
	v_attempted_local_date := ((NEW.attempted_at AT TIME ZONE 'UTC') + INTERVAL '3 hours')::date;
	IF v_attempted_local_date IS DISTINCT FROM v_event.scheduled_local_date THEN
		RAISE EXCEPTION 'Attempt attempted_at % Europe/Istanbul local date % does not match event scheduled_local_date % for delivery %',
			NEW.attempted_at, v_attempted_local_date, v_event.scheduled_local_date, NEW.delivery_id;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- D. notification_deliveries ANCHOR COMPLETENESS WIDENED (Section 8)
--    (CREATE OR REPLACE of the existing 0045 deferred completeness trigger)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_anchor_completeness()
RETURNS TRIGGER AS $$
DECLARE
	v_found BOOLEAN;
BEGIN
	SELECT
		EXISTS(SELECT 1 FROM notification_delivery_attempts WHERE delivery_id = NEW.id)
		OR EXISTS(SELECT 1 FROM notification_delivery_dispatches WHERE delivery_id = NEW.id)
	INTO v_found;
	IF NOT v_found THEN
		RAISE EXCEPTION 'Notification delivery % has no attempts or dispatch reservations at commit (naked delivery anchor)', NEW.id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- E. push_subscription_revisions: ENDPOINT IMMUTABILITY + DISABLE
--    COPY-FORWARD (CREATE OR REPLACE of the existing 0045 lifecycle guard)
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

	SELECT * INTO v_latest
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

		-- Section 22: a push_subscriptions anchor represents one immutable
		-- endpoint identity forever -- only revision #1/REGISTER establishes
		-- it; every subsequent revision (REFRESH/DISABLE/REACTIVATE alike)
		-- must carry that exact same endpoint.
		IF NEW.endpoint IS DISTINCT FROM v_latest.endpoint THEN
			RAISE EXCEPTION 'Push subscription % revision endpoint must exactly match the immutable anchor endpoint established at REGISTER (endpoint drift forbidden)', NEW.subscription_id;
		END IF;

		IF v_latest.status = 'ACTIVE' THEN
			IF NEW.operation = 'DISABLE' THEN
				IF NEW.status != 'DISABLED' THEN
					RAISE EXCEPTION 'DISABLE operation must set status DISABLED, found %', NEW.status;
				END IF;
				-- Section 23: DISABLE is lifecycle-only -- it must copy
				-- forward p256dh/auth/expiration_time/user_agent EXACTLY
				-- from the preceding ACTIVE revision (endpoint already
				-- checked above).
				IF NEW.p256dh IS DISTINCT FROM v_latest.p256dh
					OR NEW.auth IS DISTINCT FROM v_latest.auth
					OR NEW.expiration_time IS DISTINCT FROM v_latest.expiration_time
					OR NEW.user_agent IS DISTINCT FROM v_latest.user_agent THEN
					RAISE EXCEPTION 'DISABLE revision must copy forward p256dh/auth/expiration_time/user_agent exactly from the preceding ACTIVE revision % (lifecycle-only transition)', v_latest.id;
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

-- ----------------------------------------------------------------------------
-- F. push_subscription_revisions: EXACT p256dh/auth BASE64URL LENGTH
--    HARDENING (Section 14). Unpadded base64url length for N raw bytes is
--    ceil(N*4/3): 65 bytes (p256dh) -> 87 chars; 16 bytes (auth) -> 22 chars.
--    This cannot prove on-curve-ness (that is the application crypto
--    import's job, Section C) but it DOES catch gross length corruption
--    that the existing 1-128 / 1-64 pattern checks alone would miss.
-- ----------------------------------------------------------------------------

ALTER TABLE "push_subscription_revisions"
	ADD CONSTRAINT "push_sub_revisions_p256dh_length_check"
	CHECK (length("push_subscription_revisions"."p256dh") = 87);--> statement-breakpoint

ALTER TABLE "push_subscription_revisions"
	ADD CONSTRAINT "push_sub_revisions_auth_length_check"
	CHECK (length("push_subscription_revisions"."auth") = 22);--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- G. notification_events: EXACT CREDIT_CARD_DUE PAYLOAD SHAPE (Section D/18)
--    (CREATE OR REPLACE of the existing 0045 event-binding guard, folding in
--    a new exact-key-count JSON payload validator, mirroring
--    trg_fn_long_term_validate_send_payload from migration 0042)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_notification_validate_credit_card_due_payload(
	p_payload JSONB,
	p_statement_id UUID,
	p_credit_card_id UUID,
	p_due_date DATE
) RETURNS VOID AS $$
DECLARE
	v_key_count INT;
	v_data_key_count INT;
BEGIN
	IF jsonb_typeof(p_payload) != 'object' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload must be a JSON object';
	END IF;

	SELECT count(*) INTO v_key_count FROM jsonb_object_keys(p_payload);
	IF v_key_count != 3 THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload must have exactly 3 keys, found %', v_key_count;
	END IF;
	IF NOT (p_payload ? 'title' AND p_payload ? 'body' AND p_payload ? 'data') THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload is missing one or more required keys (title, body, data)';
	END IF;

	IF jsonb_typeof(p_payload->'title') != 'string' OR p_payload->>'title' != 'Kredi kartı son ödeme hatırlatması' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload title % does not match the required exact text', p_payload->>'title';
	END IF;
	IF jsonb_typeof(p_payload->'body') != 'string' OR p_payload->>'body' != 'Bir kredi kartı ekstresinin son ödeme günü bugün. Ödeme durumunu kontrol et.' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload body % does not match the required exact text', p_payload->>'body';
	END IF;

	IF jsonb_typeof(p_payload->'data') != 'object' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data must be a JSON object';
	END IF;
	SELECT count(*) INTO v_data_key_count FROM jsonb_object_keys(p_payload->'data');
	IF v_data_key_count != 5 THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data must have exactly 5 keys, found %', v_data_key_count;
	END IF;
	IF NOT (
		p_payload->'data' ? 'type' AND p_payload->'data' ? 'statementId' AND p_payload->'data' ? 'creditCardId'
		AND p_payload->'data' ? 'dueDate' AND p_payload->'data' ? 'deepLink'
	) THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data is missing one or more required keys (type, statementId, creditCardId, dueDate, deepLink)';
	END IF;

	IF jsonb_typeof(p_payload->'data'->'type') != 'string' OR p_payload->'data'->>'type' != 'CREDIT_CARD_DUE' THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.type % does not equal CREDIT_CARD_DUE', p_payload->'data'->>'type';
	END IF;
	IF jsonb_typeof(p_payload->'data'->'statementId') != 'string' OR p_payload->'data'->>'statementId' != p_statement_id::text THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.statementId % does not match statement %', p_payload->'data'->>'statementId', p_statement_id;
	END IF;
	IF jsonb_typeof(p_payload->'data'->'creditCardId') != 'string' OR p_payload->'data'->>'creditCardId' != p_credit_card_id::text THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.creditCardId % does not match credit card %', p_payload->'data'->>'creditCardId', p_credit_card_id;
	END IF;
	IF jsonb_typeof(p_payload->'data'->'dueDate') != 'string' OR p_payload->'data'->>'dueDate' != p_due_date::text THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.dueDate % does not match due date %', p_payload->'data'->>'dueDate', p_due_date;
	END IF;
	IF jsonb_typeof(p_payload->'data'->'deepLink') != 'string' OR p_payload->'data'->>'deepLink' != ('/credit-cards/statements/' || p_statement_id::text) THEN
		RAISE EXCEPTION 'CREDIT_CARD_DUE payload data.deepLink % does not match the expected deep link', p_payload->'data'->>'deepLink';
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

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

		-- Section D/18: exact privacy-safe payload shape, validated
		-- atomically in this same BEFORE INSERT trigger.
		PERFORM trg_fn_notification_validate_credit_card_due_payload(
			NEW.payload,
			NEW.subject_id,
			v_statement.credit_card_id,
			NEW.scheduled_local_date
		);
	ELSE
		RAISE EXCEPTION 'Unknown notification_type %', NEW.notification_type;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_notification_event_insert ON "notification_events";--> statement-breakpoint
CREATE TRIGGER trg_guard_notification_event_insert
BEFORE INSERT ON "notification_events"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_notification_event_insert();