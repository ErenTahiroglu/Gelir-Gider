import { describe, expect, it } from "vitest";
import migration0047Sql from "../migrations/0047_harden_notification_dispatch_race_integrity.sql?raw";

describe("Notifications Domain Migration 0047 Verification (Phase 15-R2)", () => {
	const sql = migration0047Sql;

	// --------------------------------------------------------------------
	// A. Subscription-anchor lock serializes dispatch reservation against
	//    subscription REFRESH/REACTIVATE/DISABLE
	// --------------------------------------------------------------------
	it("locks the push_subscriptions anchor row FOR UPDATE before resolving latest revision", () => {
		expect(sql).toContain(
			"SELECT * INTO v_subscription FROM push_subscriptions WHERE id = v_delivery.push_subscription_id FOR UPDATE;",
		);
	});

	it("validates the locked subscription anchor's user_id matches the dispatch user_id", () => {
		expect(sql).toContain(
			"Push subscription % user_id % does not match dispatch user_id %",
		);
	});

	it("raises when the subscription anchor for the delivery cannot be found", () => {
		expect(sql).toContain("Push subscription % not found for delivery %");
	});

	// --------------------------------------------------------------------
	// E. Exact scheduler-hour-slot DB binding
	// --------------------------------------------------------------------
	it("requires scheduler_hour_slot to be exactly the UTC-hour truncation of reserved_at", () => {
		expect(sql).toContain(
			"NEW.scheduler_hour_slot IS DISTINCT FROM (date_trunc('hour', NEW.reserved_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
		);
		expect(sql).toContain(
			"does not correspond to the UTC-hour truncation of reserved_at",
		);
	});

	// --------------------------------------------------------------------
	// F. Dispatch eligibility DB authority
	// --------------------------------------------------------------------
	it("requires the underlying credit card statement to still be OPEN at dispatch reservation time", () => {
		expect(sql).toContain(
			"Credit card statement % latest status % is not OPEN; cannot reserve a new dispatch",
		);
	});

	it("raises when the statement resolved from the event has no revisions (dispatch reservation)", () => {
		expect(sql).toContain(
			"Credit card statement % has no revisions (dispatch reservation)",
		);
	});

	it("rejects a new dispatch reservation unless the latest attempt is RETRYABLE_FAILURE (terminal-delivery-state guard)", () => {
		expect(sql).toContain(
			"Notification delivery % latest attempt status % does not permit a new dispatch reservation (only RETRYABLE_FAILURE may be retried)",
		);
	});

	it("rejects a second unresolved dispatch reservation for the same delivery", () => {
		expect(sql).toContain(
			"Notification delivery % already has an unresolved dispatch reservation; cannot reserve a second one concurrently",
		);
		expect(sql).toContain(
			"NOT EXISTS (SELECT 1 FROM notification_delivery_attempts a WHERE a.dispatch_id = d.id)",
		);
	});

	it("still enforces the pre-existing unbranched dispatch_no chain and >=12:00-same-day time authority", () => {
		expect(sql).toContain(
			"dispatch_no % does not match expected next dispatch_no % (unbranched sequence required)",
		);
		expect(sql).toContain(
			"Dispatch reserved_at % is before event scheduled_for %",
		);
		expect(sql).toContain(
			"Dispatch reserved_at % Europe/Istanbul local date % does not match event scheduled_local_date %",
		);
	});

	it("guards against an unknown notification_type in the dispatch-reservation eligibility check", () => {
		expect(sql).toContain("Unknown notification_type % (dispatch reservation)");
	});

	// --------------------------------------------------------------------
	// F. SUPPRESSED_OBSOLETE requires the statement to be confirmed NOT OPEN
	// --------------------------------------------------------------------
	it("rejects a SUPPRESSED_OBSOLETE attempt recorded while the statement is still OPEN", () => {
		expect(sql).toContain(
			"Cannot record SUPPRESSED_OBSOLETE while credit card statement % is still OPEN",
		);
	});

	it("raises when the statement resolved for a suppression check has no revisions", () => {
		expect(sql).toContain(
			"Credit card statement % has no revisions (suppression check)",
		);
	});

	it("guards against an unknown notification_type in the suppression eligibility check", () => {
		expect(sql).toContain("Unknown notification_type % (suppression check)");
	});

	it("still requires SUPPRESSED_OBSOLETE attempts to carry no dispatch_id (Phase 15-R1 Section J/31, unchanged)", () => {
		expect(sql).toContain(
			"SUPPRESSED_OBSOLETE notification delivery attempts must not bind a dispatch reservation",
		);
	});

	it("still enforces the pre-existing dispatch_id binding integrity for non-suppressed attempts (unchanged)", () => {
		expect(sql).toContain(
			"must bind the exact dispatch reservation whose network call it resolves",
		);
		expect(sql).toContain("cross-delivery binding forbidden");
		expect(sql).toContain(
			"already has a bound attempt result (exactly one result per reservation)",
		);
	});

	// --------------------------------------------------------------------
	// Structural: CREATE OR REPLACE of the two existing 0045/0046 triggers,
	// no new tables/triggers introduced
	// --------------------------------------------------------------------
	it("uses CREATE OR REPLACE FUNCTION for both hardened trigger functions (no schema/table changes)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_dispatch_insert()",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_notification_delivery_attempt_insert()",
		);
		expect(sql).not.toContain("CREATE TABLE");
		expect(sql).not.toContain("ALTER TABLE");
	});
});
