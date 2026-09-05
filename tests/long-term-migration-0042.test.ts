import { describe, expect, it } from "vitest";
import migration0042Sql from "../migrations/0042_harden_long_term_send_integrity.sql?raw";

describe("Long-Term Investment Domain Migration 0042 Verification (Phase 13-R1 Hardening)", () => {
	const sql = migration0042Sql;

	it("enforces one-to-one canonical_revision_id via a partial unique index", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "long_term_task_revisions_canonical_rev_idx" ON "long_term_send_task_revisions" USING btree ("canonical_revision_id")',
		);
	});

	it("validates the exact 6-key canonical SEND payload contract (all keys present, no extras)", () => {
		expect(sql).toContain("trg_fn_long_term_validate_send_payload");
		expect(sql).toContain("payload must have exactly 6 keys");
		expect(sql).toContain("payload is missing one or more required keys");
		expect(sql).toContain(
			"payload destinationLabel must be explicit JSON null when destination_label is null",
		);
		expect(sql).toContain(
			"payload note must be explicit JSON null when note is null",
		);
	});

	it("applies the exact payload validator to both the SENT canonical CREATE and the REOPEN canonical VOID", () => {
		expect(sql).toContain("'SENT canonical CREATE'");
		expect(sql).toContain("'REOPEN canonical VOID'");
	});

	it("seals the canonical revision lifecycle: UPDATE always rejected, CREATE/VOID require exactly one companion", () => {
		expect(sql).toContain(
			"trg_fn_guard_long_term_canonical_revision_lifecycle",
		);
		expect(sql).toContain("does not support UPDATE revisions");
		expect(sql).toContain(
			"companion long_term_send_task_revisions rows (expected exactly 1)",
		);
		expect(sql).toContain(
			"companion task revision must be operation SENT / status SENT",
		);
		expect(sql).toContain(
			"companion task revision must be operation REOPEN / status PENDING",
		);
		expect(sql).toContain('AFTER INSERT ON "transaction_revisions"');
	});

	it("proves the exact REOPEN canonical VOID chain adjacency to the preceding SENT", () => {
		expect(sql).toContain(
			"must have operation CREATE, found %', v_latest.canonical_revision_id",
		);
		expect(sql).toContain(
			"previous_revision_id % does not match the preceding SENT canonical revision",
		);
		expect(sql).toContain(
			"revision_no % is not the immediate successor of preceding SENT canonical revision_no",
		);
	});

	it("proves the exact REOPEN reversal ledger binding (applied NULL, reversal NOT NULL, chained previous binding)", () => {
		expect(sql).toContain("binding must have applied_journal_entry_id NULL");
		expect(sql).toContain(
			"binding must have reversal_journal_entry_id NOT NULL",
		);
		expect(sql).toContain(
			"binding previous_binding_id % does not match the preceding SENT binding",
		);
	});

	it("proves the exact reversed 2-line REOPEN journal (Dr Midas physical / Cr external cost)", () => {
		expect(sql).toContain(
			"REOPEN reversal journal for long-term send task % must have exactly 2 lines",
		);
		expect(sql).toContain(
			"debit line account % is not the Midas linked physical account",
		);
		expect(sql).toContain(
			"credit line account % is not SYS_LONG_TERM_EXTERNAL_COST",
		);
	});

	it("requires task companion transfers to never be a generic Midas reversal", () => {
		expect(sql).toContain("reversal_of_transfer_id IS NOT NULL");
		expect(sql).toContain("must not be a generic Midas reversal");
	});
});
