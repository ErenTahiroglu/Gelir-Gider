import { describe, expect, it } from "vitest";
import migration0046Sql from "../migrations/0046_harden_scheduled_notification_delivery_integrity.sql?raw";

describe("Notifications Domain Migration 0046 Verification (Phase 15-R1)", () => {
	const sql = migration0046Sql;

	// --------------------------------------------------------------------
	// Schema: new dispatch-reservation table + attempts.dispatch_id
	// --------------------------------------------------------------------
	it("creates the notification_delivery_dispatches table", () => {
		expect(sql).toContain('CREATE TABLE "notification_delivery_dispatches"');
		expect(sql).toContain('"dispatch_no" integer NOT NULL');
		expect(sql).toContain('"push_subscription_revision_id" uuid NOT NULL');
		expect(sql).toContain(
			'"scheduler_hour_slot" timestamp with time zone NOT NULL',
		);
		expect(sql).toContain('"reserved_at" timestamp with time zone NOT NULL');
	});

	it("adds a nullable dispatch_id column to notification_delivery_attempts", () => {
		expect(sql).toContain(
			'ALTER TABLE "notification_delivery_attempts" ADD COLUMN "dispatch_id" uuid;',
		);
	});

	it("enforces UNIQUE(delivery_id, dispatch_no) -- (K.9)", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "notification_delivery_dispatches_delivery_no_idx" ON "notification_delivery_dispatches" USING btree ("delivery_id","dispatch_no")',
		);
	});

	it("enforces UNIQUE(delivery_id, scheduler_hour_slot) -- (K.10, Section 21)", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "notification_delivery_dispatches_delivery_hour_idx" ON "notification_delivery_dispatches" USING btree ("delivery_id","scheduler_hour_slot")',
		);
	});

	it("enforces UNIQUE(dispatch_id) on attempts where not null -- (K.12: no two results per reservation)", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "notification_delivery_attempts_dispatch_idx" ON "notification_delivery_attempts" USING btree ("dispatch_id") WHERE "notification_delivery_attempts"."dispatch_id" IS NOT NULL',
		);
	});

	// --------------------------------------------------------------------
	// A. Immutability
	// --------------------------------------------------------------------
	it("denies UPDATE/DELETE on notification_delivery_dispatches", () => {
		expect(sql).toContain("trg_deny_mutation_notification_delivery_dispatches");
	});

	// --------------------------------------------------------------------
	// B. Dispatch reservation ownership/chain/provenance/time-authority
	// --------------------------------------------------------------------
	it("binds dispatch.user_id to the delivery's user_id", () => {
		expect(sql).toContain(
			"Notification delivery % user_id % does not match dispatch user_id %",
		);
	});

	it("binds dispatch.user_id to the event's user_id", () => {
		expect(sql).toContain(
			"Notification event % user_id % does not match dispatch user_id %",
		);
	});

	it("requires the bound revision to belong to the delivery's subscription", () => {
		expect(sql).toContain("does not match delivery push_subscription_id");
	});

	it("requires the bound revision to be ACTIVE at reservation time", () => {
		expect(sql).toContain("cannot reserve a dispatch against it");
	});

	it("requires the bound revision to be the CURRENT latest revision (Section B/11 provenance)", () => {
		expect(sql).toContain(
			"is not the current latest revision % of subscription % (a newer revision exists",
		);
	});

	it("enforces an unbranched dispatch_no chain starting at 1", () => {
		expect(sql).toContain(
			"dispatch_no % does not match expected next dispatch_no % (unbranched sequence required)",
		);
	});

	it("rejects a dispatch reserved before the event's scheduled_for -- (K.7)", () => {
		expect(sql).toContain(
			"Dispatch reserved_at % is before event scheduled_for %",
		);
	});

	it("rejects a dispatch reserved on a different Istanbul calendar day -- (K.8)", () => {
		expect(sql).toContain(
			"Dispatch reserved_at % Europe/Istanbul local date % does not match event scheduled_local_date %",
		);
		expect(sql).toContain(
			"(NEW.reserved_at AT TIME ZONE 'UTC') + INTERVAL '3 hours'",
		);
	});

	// --------------------------------------------------------------------
	// C. Attempt dispatch_id binding integrity
	// --------------------------------------------------------------------
	it("requires SUPPRESSED_OBSOLETE attempts to carry no dispatch_id (no-network path, Section J/31)", () => {
		expect(sql).toContain(
			"SUPPRESSED_OBSOLETE notification delivery attempts must not bind a dispatch reservation",
		);
	});

	it("requires every non-suppressed attempt to bind a dispatch reservation -- (K.11)", () => {
		expect(sql).toContain(
			"must bind the exact dispatch reservation whose network call it resolves",
		);
	});

	it("rejects a dispatch reservation bound to a different delivery -- (cross-delivery binding forbidden)", () => {
		expect(sql).toContain("cross-delivery binding forbidden");
	});

	it("rejects a second result bound to the same dispatch reservation -- (K.12)", () => {
		expect(sql).toContain(
			"already has a bound attempt result (exactly one result per reservation)",
		);
	});

	it("re-applies the >=12:00-same-day time authority to attempted_at", () => {
		expect(sql).toContain(
			"Attempt attempted_at % is before event scheduled_for %",
		);
		expect(sql).toContain(
			"does not match event scheduled_local_date % for delivery %",
		);
	});

	// --------------------------------------------------------------------
	// D. Delivery anchor completeness widened (Section 8)
	// --------------------------------------------------------------------
	it("permits a delivery to commit with a dispatch reservation OR an attempt, never neither", () => {
		expect(sql).toContain(
			"OR EXISTS(SELECT 1 FROM notification_delivery_dispatches WHERE delivery_id = NEW.id)",
		);
		expect(sql).toContain(
			"has no attempts or dispatch reservations at commit (naked delivery anchor)",
		);
	});

	// --------------------------------------------------------------------
	// E. Subscription revision endpoint immutability + DISABLE copy-forward
	// --------------------------------------------------------------------
	it("rejects endpoint drift on any revision after #1 -- (K.13)", () => {
		expect(sql).toContain(
			"revision endpoint must exactly match the immutable anchor endpoint established at REGISTER (endpoint drift forbidden)",
		);
	});

	it("requires DISABLE to copy forward p256dh/auth/expiration_time/user_agent exactly -- (K.14)", () => {
		expect(sql).toContain(
			"DISABLE revision must copy forward p256dh/auth/expiration_time/user_agent exactly from the preceding ACTIVE revision",
		);
	});

	// --------------------------------------------------------------------
	// F. Exact base64url length hardening (Section 14)
	// --------------------------------------------------------------------
	it("requires p256dh to be exactly 87 chars (65 raw bytes, unpadded base64url)", () => {
		expect(sql).toContain(
			'CONSTRAINT "push_sub_revisions_p256dh_length_check"',
		);
		expect(sql).toContain(
			'length("push_subscription_revisions"."p256dh") = 87',
		);
	});

	it("requires auth to be exactly 22 chars (16 raw bytes, unpadded base64url)", () => {
		expect(sql).toContain('CONSTRAINT "push_sub_revisions_auth_length_check"');
		expect(sql).toContain('length("push_subscription_revisions"."auth") = 22');
	});

	// --------------------------------------------------------------------
	// G. Exact CREDIT_CARD_DUE payload shape (Section D/18, K.1-6)
	// --------------------------------------------------------------------
	it("requires exactly 3 top-level keys", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload must have exactly 3 keys, found %",
		);
	});

	it("rejects an extra top-level/nested key -- (K.1: e.g. statementAmount)", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload data must have exactly 5 keys, found %",
		);
	});

	it("rejects a missing required key -- (K.2)", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload is missing one or more required keys (title, body, data)",
		);
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload data is missing one or more required keys (type, statementId, creditCardId, dueDate, deepLink)",
		);
	});

	it("requires the exact title/body text", () => {
		expect(sql).toContain("Kredi kartı son ödeme hatırlatması");
		expect(sql).toContain(
			"Bir kredi kartı ekstresinin son ödeme günü bugün. Ödeme durumunu kontrol et.",
		);
	});

	it("rejects a wrong statementId -- (K.3)", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload data.statementId % does not match statement %",
		);
	});

	it("rejects a wrong creditCardId -- (K.4)", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload data.creditCardId % does not match credit card %",
		);
	});

	it("rejects a wrong dueDate -- (K.5)", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload data.dueDate % does not match due date %",
		);
	});

	it("rejects a wrong deepLink -- (K.6)", () => {
		expect(sql).toContain(
			"CREDIT_CARD_DUE payload data.deepLink % does not match the expected deep link",
		);
		expect(sql).toContain(
			"'/credit-cards/statements/' || p_statement_id::text",
		);
	});

	it("validates the payload atomically inside the existing event-binding trigger (not a separate trigger)", () => {
		expect(sql).toContain(
			"PERFORM trg_fn_notification_validate_credit_card_due_payload(",
		);
	});
});
