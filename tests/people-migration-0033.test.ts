import { describe, expect, it } from "vitest";
import migration0033Sql from "../migrations/0033_close_people_domain_integrity_gaps.sql?raw";

describe("Migration 0033", () => {
	const sql = migration0033Sql;

	it("denies UPDATE/DELETE on every People table (true append-only immutability)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_deny_people_table_mutation",
		);
		for (const table of [
			"people",
			"person_revisions",
			"person_ledger_links",
			"person_obligations",
			"person_obligation_revisions",
			"person_settlements",
			"person_settlement_revisions",
			"people_system_income_links",
		]) {
			expect(sql).toContain(`BEFORE UPDATE OR DELETE ON "${table}"`);
		}
	});

	it("fixes the latest-status bug: reads the LATEST person revision, not any historical ACTIVE row", () => {
		// The buggy pattern filtered status='ACTIVE' before ORDER BY/LIMIT, which
		// checks "does any ACTIVE revision exist ever" rather than "is the latest
		// revision ACTIVE". The fix selects status with no WHERE-status filter,
		// orders by revision_no DESC, and compares the single latest value.
		expect(sql).toContain("v_latest_person_status IS DISTINCT FROM 'ACTIVE'");
		// The buggy shape filtered status='ACTIVE' in the WHERE clause before
		// ORDER BY/LIMIT; the fix selects status unconditionally and compares
		// the single latest value afterward.
		expect(sql).not.toMatch(
			/WHERE person_id = v_obligation_peek\.person_id AND status = 'ACTIVE'/,
		);
	});

	it("locks person before obligation before settlement in both revision guards", () => {
		const obligationGuardStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert",
		);
		const obligationGuardBody = sql.slice(
			obligationGuardStart,
			obligationGuardStart + 3000,
		);
		const personLockIdx = obligationGuardBody.indexOf(
			"FROM people WHERE id = v_obligation_peek.person_id FOR UPDATE",
		);
		const obligationLockIdx = obligationGuardBody.indexOf(
			"FROM person_obligations WHERE id = NEW.obligation_id FOR UPDATE",
		);
		expect(personLockIdx).toBeGreaterThan(-1);
		expect(obligationLockIdx).toBeGreaterThan(personLockIdx);

		const settlementGuardStart = sql.indexOf(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_revision_insert",
		);
		const settlementGuardBody = sql.slice(
			settlementGuardStart,
			settlementGuardStart + 3000,
		);
		const sPersonLockIdx = settlementGuardBody.indexOf(
			"FROM people WHERE id = v_obligation_peek.person_id FOR UPDATE",
		);
		const sObligationLockIdx = settlementGuardBody.indexOf(
			"FROM person_obligations WHERE id = v_settlement_peek.obligation_id FOR UPDATE",
		);
		const sSettlementLockIdx = settlementGuardBody.indexOf(
			"FROM person_settlements WHERE id = NEW.settlement_id FOR UPDATE",
		);
		expect(sPersonLockIdx).toBeGreaterThan(-1);
		expect(sObligationLockIdx).toBeGreaterThan(sPersonLockIdx);
		expect(sSettlementLockIdx).toBeGreaterThan(sObligationLockIdx);
	});

	it("enforces DB-authoritative ARCHIVE economic preconditions", () => {
		expect(sql).toContain(
			"Cannot archive person % with non-zero receivable balance",
		);
		expect(sql).toContain(
			"Cannot archive person % with non-zero payable balance",
		);
		expect(sql).toContain(
			"PERFORM people_check_reconciliation_for_person(NEW.person_id)",
		);
	});

	it("enforces one-receipt-one-settlement and rejects reuse for a different settlement", () => {
		expect(sql).toContain("is already linked to a different settlement");
	});

	it("adds a reverse companion guard on income_receipt_revisions scoped to OVERPAYMENT_EXTRA", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_overpayment_income_companion",
		);
		expect(sql).toContain('AFTER INSERT ON "income_receipt_revisions"');
		expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
		expect(sql).toContain("cannot be independently updated");
		expect(sql).toContain(
			"requires a matching People settlement VOID revision",
		);
		expect(sql).toContain(
			"must have exactly one linking settlement CREATE revision",
		);
	});

	it("binds overpayment occurred_at to the settlement's occurred_at", () => {
		expect(sql).toContain(
			"Overpayment income receipt occurred_at does not match settlement occurred_at",
		);
	});
});
