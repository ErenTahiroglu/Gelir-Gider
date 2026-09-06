-- ============================================================================
-- PHASE 15-R2: CLOSE REMAINING SCHEDULED NOTIFICATION DELIVERY DEFECT CLASSES
--
-- A. notification_delivery_dispatches: the dispatch-reservation insert guard
--    now ALSO locks the push_subscriptions anchor row (FOR UPDATE) -- the
--    same row trg_fn_guard_push_subscription_revision_insert already locks
--    for a REFRESH/REACTIVATE/DISABLE revision insert -- so a concurrent
--    subscription-lifecycle mutation and a dispatch reservation serialize on
--    that row instead of racing each other.
-- E. notification_delivery_dispatches: scheduler_hour_slot must be EXACTLY
--    the UTC-hour truncation of reserved_at, independent of DB session
--    timezone (mirrors truncateToSchedulerHourSlot in delivery.ts).
-- F. notification_delivery_dispatches: dispatch eligibility DB authority --
--    the underlying credit card statement must still be OPEN, the prior
--    attempt (if any) must be RETRYABLE_FAILURE, and no other unresolved
--    dispatch may already exist for the same delivery.
-- F. notification_delivery_attempts: SUPPRESSED_OBSOLETE may only be
--    recorded once the statement is confirmed NOT OPEN.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A/E/F. notification_delivery_dispatches: subscription-anchor lock + exact
-- hour-slot binding + statement-OPEN/terminal-state/unresolved-dispatch
-- eligibility guards (CREATE OR REPLACE of the existing 0046 dispatch-insert
-- guard)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_dispatch_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_delivery RECORD;
	v_event RECORD;
	v_revision RECORD;
	v_subscription RECORD;
	v_statement_rev RECORD;
	v_last_attempt_status TEXT;
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

	-- Phase 15-R2 Section A: lock the SAME push_subscriptions anchor row that
	-- trg_fn_guard_push_subscription_revision_insert locks for a
	-- REFRESH/REACTIVATE/DISABLE revision insert, so a concurrent subscription
	-- lifecycle mutation and this dispatch reservation serialize against each
	-- other rather than racing the latest-revision check below.
	SELECT * INTO v_subscription FROM push_subscriptions WHERE id = v_delivery.push_subscription_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Push subscription % not found for delivery %', v_delivery.push_subscription_id, NEW.delivery_id;
	END IF;
	IF v_subscription.user_id IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'Push subscription % user_id % does not match dispatch user_id %', v_delivery.push_subscription_id, v_subscription.user_id, NEW.user_id;
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
	-- time, not a superseded one). This check now happens AFTER the
	-- push_subscriptions anchor lock above is held, closing the race window
	-- against a concurrent REFRESH/REACTIVATE/DISABLE.
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

	-- Phase 15-R2 Section F: the statement this event was materialized from
	-- must still be OPEN at reservation time -- defense-in-depth beyond the
	-- app's own re-check in reserveInTransaction. Only CREDIT_CARD_DUE exists
	-- today; any other notification_type is an unreachable/forward-
	-- compatibility case handled explicitly.
	IF v_event.notification_type = 'CREDIT_CARD_DUE' THEN
		SELECT * INTO v_statement_rev
		FROM credit_card_statement_revisions
		WHERE statement_id = v_event.subject_id
		ORDER BY revision_no DESC
		LIMIT 1;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'Credit card statement % has no revisions (dispatch reservation)', v_event.subject_id;
		END IF;
		IF v_statement_rev.status != 'OPEN' THEN
			RAISE EXCEPTION 'Credit card statement % latest status % is not OPEN; cannot reserve a new dispatch', v_event.subject_id, v_statement_rev.status;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown notification_type % (dispatch reservation)', v_event.notification_type;
	END IF;

	-- Phase 15-R2 Section F: no dispatch after a terminal delivery state --
	-- only a RETRYABLE_FAILURE latest attempt (or no attempt at all yet) may
	-- be followed by a new dispatch reservation.
	SELECT status INTO v_last_attempt_status
	FROM notification_delivery_attempts
	WHERE delivery_id = NEW.delivery_id
	ORDER BY attempt_no DESC
	LIMIT 1;
	IF FOUND THEN
		IF v_last_attempt_status != 'RETRYABLE_FAILURE' THEN
			RAISE EXCEPTION 'Notification delivery % latest attempt status % does not permit a new dispatch reservation (only RETRYABLE_FAILURE may be retried)', NEW.delivery_id, v_last_attempt_status;
		END IF;
	END IF;

	-- Phase 15-R2 Section F: no second unresolved dispatch -- there must be
	-- no existing dispatch reservation for this delivery lacking a bound
	-- attempt result before a new one may be reserved.
	IF EXISTS (
		SELECT 1 FROM notification_delivery_dispatches d
		WHERE d.delivery_id = NEW.delivery_id
		AND NOT EXISTS (SELECT 1 FROM notification_delivery_attempts a WHERE a.dispatch_id = d.id)
	) THEN
		RAISE EXCEPTION 'Notification delivery % already has an unresolved dispatch reservation; cannot reserve a second one concurrently', NEW.delivery_id;
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

	-- Phase 15-R2 Section E: scheduler_hour_slot must be EXACTLY the UTC-hour
	-- truncation of reserved_at, independent of DB session timezone. Mirrors
	-- truncateToSchedulerHourSlot in src/notifications/delivery.ts
	-- (ms - (ms % 3_600_000)), which is exactly UTC-hour flooring.
	IF NEW.scheduler_hour_slot IS DISTINCT FROM (date_trunc('hour', NEW.reserved_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
		RAISE EXCEPTION 'Dispatch scheduler_hour_slot % does not correspond to the UTC-hour truncation of reserved_at % (expected %)',
			NEW.scheduler_hour_slot, NEW.reserved_at, (date_trunc('hour', NEW.reserved_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- F. notification_delivery_attempts: SUPPRESSED_OBSOLETE requires the
--    underlying statement to be confirmed NOT OPEN at the moment of
--    suppression (CREATE OR REPLACE of the existing 0046 attempt-insert
--    guard)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_attempt_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_delivery RECORD;
	v_event RECORD;
	v_dispatch RECORD;
	v_statement_rev RECORD;
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

	SELECT * INTO v_event FROM notification_events WHERE id = v_delivery.notification_event_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Notification event % not found for delivery %', v_delivery.notification_event_id, NEW.delivery_id;
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
	-- status permitted to skip the network entirely (no dispatch needed) --
	-- and, as of Phase 15-R2 Section F, it may only be recorded once the
	-- underlying statement is confirmed NOT OPEN, so a suppression can never
	-- be used to silently swallow a delivery that is still actually due.
	IF NEW.status = 'SUPPRESSED_OBSOLETE' THEN
		IF NEW.dispatch_id IS NOT NULL THEN
			RAISE EXCEPTION 'SUPPRESSED_OBSOLETE notification delivery attempts must not bind a dispatch reservation (no network call was ever attempted)';
		END IF;
		IF v_event.notification_type = 'CREDIT_CARD_DUE' THEN
			SELECT * INTO v_statement_rev
			FROM credit_card_statement_revisions
			WHERE statement_id = v_event.subject_id
			ORDER BY revision_no DESC
			LIMIT 1;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Credit card statement % has no revisions (suppression check)', v_event.subject_id;
			END IF;
			IF v_statement_rev.status = 'OPEN' THEN
				RAISE EXCEPTION 'Cannot record SUPPRESSED_OBSOLETE while credit card statement % is still OPEN', v_event.subject_id;
			END IF;
		ELSE
			RAISE EXCEPTION 'Unknown notification_type % (suppression check)', v_event.notification_type;
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
$$ LANGUAGE plpgsql;
