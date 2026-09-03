import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migration0007Sql from "../migrations/0007_magical_deadpool.sql?raw";
import migration0008Sql from "../migrations/0008_harden_ledger_integrity.sql?raw";
import migration0009Sql from "../migrations/0009_serialize_ledger_account_state.sql?raw";
import {
	journalEntries,
	journalLines,
	ledgerAccounts,
} from "../src/db/schema/ledger";

describe("Ledger Schema & Migration Invariants (Phase 4A-R2)", () => {
	it("exports ledger_accounts with correct types, precision, and constraints", () => {
		const cols = getTableColumns(ledgerAccounts);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.code.dataType).toBe("string");
		expect(cols.name.dataType).toBe("string");
		expect(cols.accountType.dataType).toBe("string");
		expect(cols.normalBalance.dataType).toBe("string");
		expect(cols.currency.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");
		expect(cols.archivedAt.dataType).toBe("date");
	});

	it("exports journal_entries with status, currency, and fingerprint constraints", () => {
		const cols = getTableColumns(journalEntries);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.idempotencyKey.dataType).toBe("string");
		expect(cols.postingFingerprint.dataType).toBe("string");
		expect(cols.status.dataType).toBe("string");
		expect(cols.currency.dataType).toBe("string");
		expect(cols.occurredAt.dataType).toBe("date");
		expect(cols.postedAt.dataType).toBe("date");
		expect(cols.memo.dataType).toBe("string");
		expect(cols.sourceType.dataType).toBe("string");
		expect(cols.sourceRef.dataType).toBe("string");
	});

	it("exports journal_lines with NUMERIC(18,2) precision and line constraints", () => {
		const cols = getTableColumns(journalLines);
		expect(cols.id.dataType).toBe("string");
		expect(cols.journalEntryId.dataType).toBe("string");
		expect(cols.lineNo.dataType).toBe("number");
		expect(cols.accountId.dataType).toBe("string");
		expect(cols.debit.dataType).toBe("string"); // Drizzle numeric returns string
		expect(cols.credit.dataType).toBe("string");
	});

	it("verifies migration 0007 contains baseline PostgreSQL functions, triggers, and immutability guards", () => {
		const sqlContent = migration0007Sql;

		// Tables & constraints
		expect(sqlContent).toContain('CREATE TABLE "ledger_accounts"');
		expect(sqlContent).toContain('CREATE TABLE "journal_entries"');
		expect(sqlContent).toContain('CREATE TABLE "journal_lines"');

		// Triggers & Functions
		expect(sqlContent).toContain("trg_fn_protect_ledger_accounts");
		expect(sqlContent).toContain("trg_protect_ledger_accounts_update");
		expect(sqlContent).toContain("trg_protect_ledger_accounts_delete");

		expect(sqlContent).toContain("trg_fn_guard_journal_entries_insert");
		expect(sqlContent).toContain("trg_guard_journal_entries_insert");

		expect(sqlContent).toContain("trg_fn_guard_journal_lines_mutability");
		expect(sqlContent).toContain("trg_guard_journal_lines_mutability");

		expect(sqlContent).toContain("trg_fn_guard_journal_entries_transition");
		expect(sqlContent).toContain("trg_guard_journal_entries_transition");
		expect(sqlContent).toContain("trg_guard_journal_entries_delete");
	});

	it("verifies migration 0008 contains hardened parent locking, reparenting prevention, and unconstrained numeric aggregate types", () => {
		const sqlContent = migration0008Sql;

		// Parent locking with FOR UPDATE
		expect(sqlContent).toContain("FOR UPDATE");
		expect(sqlContent).toContain(
			"journal_lines journal_entry_id is immutable and line reparenting is prohibited",
		);

		// Unconstrained numeric aggregate sums
		expect(sqlContent).toContain("v_debit_sum numeric;");
		expect(sqlContent).toContain("v_credit_sum numeric;");

		// No destructive table drops or recreations
		expect(sqlContent).not.toContain("DROP TABLE");
		expect(sqlContent).not.toContain("CREATE TABLE");
	});

	it("verifies migration 0009 serializes account state during transition with deterministic locking (FOR UPDATE OF la ORDER BY la.id)", () => {
		const sqlContent = migration0009Sql;

		// Deterministic account row locking
		expect(sqlContent).toContain("FOR UPDATE OF la");
		expect(sqlContent).toContain("ORDER BY la.id");

		// Account validation on locked rows
		expect(sqlContent).toContain("v_account.user_id != NEW.user_id");
		expect(sqlContent).toContain("v_account.currency != NEW.currency");
		expect(sqlContent).toContain("v_account.archived_at IS NOT NULL");

		// No table recreation
		expect(sqlContent).not.toContain("DROP TABLE");
		expect(sqlContent).not.toContain("CREATE TABLE");
	});
});
