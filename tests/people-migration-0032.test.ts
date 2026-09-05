import { describe, expect, it } from "vitest";
import migration0032Sql from "../migrations/0032_harden_people_obligation_settlement_integrity.sql?raw";

describe("Migration 0032", () => {
	const sql = migration0032Sql;

	it("guards person_ledger_links inserts against wrong-user/type/currency accounts", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_ledger_links_insert",
		);
		expect(sql).toContain("must be ASSET/DEBIT");
		expect(sql).toContain("must be LIABILITY/CREDIT");
		expect(sql).toContain("currency does not match user currency");
		expect(sql).toContain("Receivable and payable accounts must differ");
	});

	it("enforces person anchor completeness (deferred, revision #1/CREATE/ACTIVE)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_anchor_completeness",
		);
		expect(sql).toContain('AFTER INSERT ON "people"');
		expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
	});

	it("guards people_system_income_links to the OVERPAYMENT_EXTRA contract", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_system_income_links_insert",
		);
		expect(sql).toContain("PEOPLE_OVERPAYMENT");
		expect(sql).toContain("nature EXTRA");
		expect(sql).toContain("reference_method EXCLUDED");
	});

	it("extends reconciliation to obligation and settlement revision inserts, fail-closed", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION people_check_reconciliation_for_person",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation_obligation",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation_settlement",
		);
		expect(sql).not.toContain("GREATEST(t.remaining, 0)");
		expect(sql).not.toContain("GREATEST(");
		expect(sql).toContain("invalid negative derived remaining");
	});

	it("checks archived-person status for every fresh obligation and settlement mutation", () => {
		expect(sql).toContain(
			"Cannot mutate obligation for archived or unknown person",
		);
		expect(sql).toContain(
			"Cannot mutate settlement for archived or unknown person",
		);
	});

	it("validates funding asset account currency inside the obligation revision guard", () => {
		expect(sql).toContain(
			"Funding asset account % currency does not match user currency",
		);
	});

	it("binds and validates the overpayment income receipt on settlement CREATE and VOID", () => {
		expect(sql).toContain("OVERPAYMENT_EXTRA system source");
		expect(sql).toContain("does not match excess_amount");
		expect(sql).toContain(
			"requires linked overpayment income receipt % to also be VOID",
		);
	});

	it("validates exact obligation ledger effect binding (2 lines, exact accounts/amounts, exact reversal mirror)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_ledger_effect",
		);
		expect(sql).toContain("must have exactly 2 lines");
		expect(sql).toContain("does not mirror original credit line");
		expect(sql).toContain("does not mirror original debit line");
	});

	it("validates exact settlement ledger effect binding (2 lines, exact accounts/amounts, exact reversal mirror)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_ledger_effect",
		);
	});
});
