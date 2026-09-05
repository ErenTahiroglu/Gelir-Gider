import { describe, expect, it } from "vitest";
import migration0036Sql from "../migrations/0036_close_credit_card_shared_split_integrity_gaps.sql?raw";

describe("Credit Card Splits Migration 0036 Verification", () => {
	const sql = migration0036Sql;

	it("adds the revision seal table with an INSERT-only immutability trigger", () => {
		expect(sql).toContain(
			'CREATE TABLE "credit_card_purchase_split_revision_seals"',
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_revision_seals",
		);
	});

	it("restores the 0033 person-lock -> latest-ACTIVE-check -> obligation-lock order in the obligation guard", () => {
		const start = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert",
		);
		const body = sql.slice(start, start + 4000);
		const personLockIdx = body.indexOf(
			"FROM people WHERE id = v_obligation_peek.person_id FOR UPDATE",
		);
		const statusCheckIdx = body.indexOf(
			"v_latest_person_status IS DISTINCT FROM 'ACTIVE'",
		);
		const obligationLockIdx = body.indexOf(
			"FROM person_obligations WHERE id = NEW.obligation_id FOR UPDATE",
		);
		expect(personLockIdx).toBeGreaterThan(-1);
		expect(statusCheckIdx).toBeGreaterThan(personLockIdx);
		expect(obligationLockIdx).toBeGreaterThan(statusCheckIdx);
	});

	it("supports CREDIT_CARD_PURCHASE_SPLIT as a RECEIVABLE canonical kind alongside PERSON_RECEIVABLE_ADVANCE", () => {
		expect(sql).toContain(
			"v_can_tx.kind NOT IN ('PERSON_RECEIVABLE_ADVANCE', 'CREDIT_CARD_PURCHASE_SPLIT')",
		);
	});

	it("binds expenseAccountId to the authoritative system account for the referenced purchase revision's budget_category", () => {
		expect(sql).toContain("is not the authoritative system expense account");
		expect(sql).toContain("credit_card_purchase_split_revisions sr");
		expect(sql).toContain("purchase_budget_category");
	});

	it("rejects appending an item to an already-sealed split revision", () => {
		expect(sql).toContain("is sealed; no further items may be appended");
	});

	it("enforces seal completeness (exactly one seal, correct item-count bounds) at seal insert time", () => {
		expect(sql).toContain(
			"FUNCTION trg_fn_guard_cc_split_revision_seal_insert()",
		);
		expect(sql).toContain("must have zero revision items at seal time");
		expect(sql).toContain("must have between 1 and 9 items at seal time");
	});

	it("rejects a naked split anchor (zero revisions) at commit", () => {
		expect(sql).toContain("naked split anchor");
	});

	it("rejects an orphan participant anchor with no revision-item history at commit", () => {
		expect(sql).toContain("orphan participant anchor");
	});

	it("requires every split revision to have a seal at commit", () => {
		expect(sql).toContain("has no seal at commit");
	});

	it("enforces the VOID split final invariant instead of skipping it", () => {
		expect(sql).toContain("must copy forward prior method");
		expect(sql).toContain("must copy forward prior gross_amount");
		expect(sql).toContain("must copy forward prior purchase_event_revision_id");
		expect(sql).toContain("must copy forward prior user_weight");
		expect(sql).toContain("leaves participant obligation");
	});

	it("retriggers split reconciliation on person_obligation_revisions inserts", () => {
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_cc_split_commit_check_obligations",
		);
		expect(sql).toContain('AFTER INSERT ON "person_obligation_revisions"');
	});

	it("extends commit-check trigger coverage to participants and revision items directly", () => {
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_cc_split_commit_check_participants",
		);
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_cc_split_commit_check_items",
		);
	});
});
