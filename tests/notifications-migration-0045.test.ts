import { describe, expect, it } from "vitest";
import migration0045Sql from "../migrations/0045_add_scheduled_credit_card_due_notifications.sql?raw";

describe("Notifications Domain Migration 0045 Verification (Phase 15)", () => {
	const sql = migration0045Sql;

	it("creates all five new tables", () => {
		expect(sql).toContain('CREATE TABLE "push_subscriptions"');
		expect(sql).toContain('CREATE TABLE "push_subscription_revisions"');
		expect(sql).toContain('CREATE TABLE "notification_events"');
		expect(sql).toContain('CREATE TABLE "notification_deliveries"');
		expect(sql).toContain('CREATE TABLE "notification_delivery_attempts"');
	});

	// --------------------------------------------------------------------
	// A. Immutability
	// --------------------------------------------------------------------
	it("denies UPDATE/DELETE on all five new tables (Section 35)", () => {
		for (const table of [
			"push_subscriptions",
			"push_subscription_revisions",
			"notification_events",
			"notification_deliveries",
			"notification_delivery_attempts",
		]) {
			expect(sql).toContain(`trg_deny_mutation_${table}`);
		}
		expect(sql).toContain("trg_fn_deny_mutation_notifications()");
		expect(sql).toContain("is immutable (INSERT-only)");
	});

	// --------------------------------------------------------------------
	// B/C. Push subscription lifecycle guard + anchor completeness
	// --------------------------------------------------------------------
	it("enforces revision #1 must be REGISTER/ACTIVE (Section 37)", () => {
		expect(sql).toContain(
			"First revision must have operation REGISTER, found %",
		);
		expect(sql).toContain("First revision must have status ACTIVE, found %");
	});

	it("enforces the ACTIVE/DISABLED transition table (Section 37)", () => {
		expect(sql).toContain(
			"From ACTIVE status, only DISABLE or REFRESH are valid operations",
		);
		expect(sql).toContain(
			"From DISABLED status, only REACTIVATE is a valid operation",
		);
	});

	it("enforces the revision chain is unbranched (Section 37)", () => {
		expect(sql).toContain("branching forbidden");
	});

	it("binds revision.user_id to the anchor's user_id using IS DISTINCT FROM (Section 37)", () => {
		expect(sql).toContain("v_anchor.user_id IS DISTINCT FROM NEW.user_id");
	});

	it("rejects a naked push subscription anchor with zero revisions at commit (Section 37)", () => {
		expect(sql).toContain("naked subscription anchor");
		expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
	});

	// --------------------------------------------------------------------
	// D. notification_events CREDIT_CARD_DUE binding (Section 11/38)
	// --------------------------------------------------------------------
	it("rejects an event for another user's statement (Section 38)", () => {
		expect(sql).toContain("v_statement.user_id IS DISTINCT FROM NEW.user_id");
	});

	it("requires the latest statement revision to be OPEN (Section 38: PAID/VOID rejected)", () => {
		expect(sql).toContain(
			"Credit card statement % latest revision status % is not OPEN",
		);
	});

	it("requires the event's scheduled_local_date to match the statement's latest due_date (Section 38)", () => {
		expect(sql).toContain("does not match event scheduled_local_date");
	});

	it("requires scheduled_for to be exactly 12:00 Europe/Istanbul (09:00 UTC) (Section 11/38)", () => {
		expect(sql).toContain(
			"v_expected_scheduled_for := (NEW.scheduled_local_date + TIME '09:00:00') AT TIME ZONE 'UTC';",
		);
		expect(sql).toContain(
			"does not match expected 12:00 Europe/Istanbul instant",
		);
	});

	it("rejects an unknown/invalid notification_type (Section 38)", () => {
		expect(sql).toContain("Unknown notification_type %");
	});

	it("does not resolve subject_id for an unknown statement (Section 38)", () => {
		expect(sql).toContain("does not resolve to a real credit card statement");
	});

	// --------------------------------------------------------------------
	// E/F. notification_deliveries cross-user guard + anchor completeness
	// --------------------------------------------------------------------
	it("rejects cross-user delivery via event or subscription mismatch (Section 39)", () => {
		expect(sql).toContain("v_event.user_id IS DISTINCT FROM NEW.user_id");
		expect(sql).toContain("cross-user delivery forbidden");
	});

	it("rejects delivery to a subscription whose latest status is not ACTIVE (Section 39)", () => {
		expect(sql).toContain("is not ACTIVE; cannot create a new delivery");
	});

	it("rejects a naked delivery-with-zero-attempts anchor at commit (Section 39)", () => {
		expect(sql).toContain("naked delivery anchor");
	});

	// --------------------------------------------------------------------
	// G. notification_delivery_attempts chain integrity (Section 39)
	// --------------------------------------------------------------------
	it("requires attempt_no to be the exact next value in an unbranched sequence (Section 39)", () => {
		expect(sql).toContain(
			"does not match expected next attempt_no % (unbranched sequence required)",
		);
	});

	it("only permits a next attempt when the preceding attempt was RETRYABLE_FAILURE (Section 39: rejects after SUCCESS/TERMINAL_FAILURE/SUPPRESSED_OBSOLETE)", () => {
		expect(sql).toContain(
			"does not permit a next attempt (only RETRYABLE_FAILURE may be retried)",
		);
	});

	it("binds attempt.user_id to the delivery's user_id", () => {
		expect(sql).toContain("does not match attempt user_id");
	});

	it("hard-caps attempt_no at 5 via the column CHECK constraint (Section 16)", () => {
		expect(sql).toContain('"notification_delivery_attempts_no_check"');
	});
});
