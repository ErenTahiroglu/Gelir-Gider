import { describe, expect, it } from "vitest";
import migration0041Sql from "../migrations/0041_add_long_term_investment_domain.sql?raw";

describe("Long-Term Investment Domain Migration 0041 Verification", () => {
	const sql = migration0041Sql;

	it("creates the two long-term tables", () => {
		expect(sql).toContain('CREATE TABLE "long_term_send_tasks"');
		expect(sql).toContain('CREATE TABLE "long_term_send_task_revisions"');
	});

	it("enforces INSERT-only immutability on both tables", () => {
		expect(sql).toContain("trg_deny_mutation_long_term_send_tasks");
		expect(sql).toContain("trg_deny_mutation_long_term_send_task_revisions");
		expect(sql).toContain("is immutable (INSERT-only)");
	});

	it("enforces the exact revision chain and transition table", () => {
		expect(sql).toContain("branching forbidden");
		expect(sql).toContain("First revision must have operation CREATE");
		expect(sql).toContain("First revision must have status PENDING");
		expect(sql).toContain("CANCELLED is terminal");
		expect(sql).toContain(
			"From PENDING status, only SENT or CANCEL are valid operations",
		);
		expect(sql).toContain("From SENT status, only REOPEN is a valid operation");
	});

	it("enforces amount and context (destinationLabel/note) immutability across the lifecycle", () => {
		expect(sql).toContain("Task amount is immutable");
		expect(sql).toContain(
			"Task destinationLabel is immutable and must copy forward exactly from CREATE",
		);
		expect(sql).toContain(
			"Task note is immutable and must copy forward exactly from CREATE",
		);
	});

	it("enforces exact Midas allocation transfer companion binding per operation", () => {
		expect(sql).toContain("Companion Midas allocation transfer");
		expect(sql).toContain("does not match task revision amount");
		expect(sql).toContain("does not match expected");
	});

	it("enforces canonical_revision_id NULL/NOT NULL per operation and exact SEND payload/ledger binding", () => {
		expect(sql).toContain("revision must have canonical_revision_id NULL");
		expect(sql).toContain("SENT canonical revision must have operation CREATE");
		expect(sql).toContain("SENT canonical transaction");
		expect(sql).toContain(
			"Unexpected key % in LONG_TERM_INVESTMENT_SEND canonical payload",
		);
		expect(sql).toContain("payload taskId");
		expect(sql).toContain("payload midasAccountId");
		expect(sql).toContain("payload pendingBucketId");
		expect(sql).toContain("payload amount");
		expect(sql).toContain("applied journal must have exactly 2 lines");
		expect(sql).toContain("is not SYS_LONG_TERM_EXTERNAL_COST");
		expect(sql).toContain("is not the Midas linked physical account");
	});

	it("validates both ledger account contracts for SENT (external cost + Midas linked)", () => {
		expect(sql).toContain(
			"SYS_LONG_TERM_EXTERNAL_COST account % is not a valid ASSET/DEBIT account",
		);
		expect(sql).toContain(
			"Midas linked ledger account % is not a valid ASSET/DEBIT account",
		);
		expect(sql).toContain("currency % does not match user currency %");
		expect(sql).toContain("is archived");
	});

	it("enforces the exact REOPEN canonical VOID binding to the preceding SENT transaction", () => {
		expect(sql).toContain(
			"REOPEN canonical_revision_id must reference a VOID revision",
		);
		expect(sql).toContain(
			"does not belong to the same canonical transaction as the preceding SENT revision",
		);
	});

	it("rejects naked task anchors at commit", () => {
		expect(sql).toContain("naked task anchor");
	});

	it("guards any generic Midas transfer touching PENDING_LONG_TERM without exactly one companion task revision", () => {
		expect(sql).toContain("trg_fn_guard_midas_pending_long_term_companion");
		expect(sql).toContain(
			"touches a PENDING_LONG_TERM bucket but has % companion long-term task revisions",
		);
	});

	it("enforces the PENDING_LONG_TERM bucket <-> sum(PENDING task amounts) reconciliation, retriggered from both companion tables", () => {
		expect(sql).toContain("trg_fn_guard_long_term_pending_reconciliation");
		expect(sql).toContain("does not match sum of PENDING task amounts");
		expect(sql).toContain('AFTER INSERT ON "long_term_send_task_revisions"');
		expect(sql).toContain('AFTER INSERT ON "midas_allocation_transfers"');
	});

	it("rejects an orphan canonical LONG_TERM_INVESTMENT_SEND transaction with no companion SENT task revision", () => {
		expect(sql).toContain(
			"has no linked long_term_send_task_revisions row at commit",
		);
	});
});
