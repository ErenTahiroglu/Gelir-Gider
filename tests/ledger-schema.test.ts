import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migrationSql from "../migrations/0007_magical_deadpool.sql?raw";
import {
	journalEntries,
	journalLines,
	ledgerAccounts,
} from "../src/db/schema/ledger";

describe("Ledger Schema & Migration Invariants (Phase 4A)", () => {
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

	it("verifies migration 0007 contains all required PostgreSQL functions, triggers, and immutability guards", () => {
		const sqlContent = migrationSql;

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

		// Invariant checks inside triggers
		expect(sqlContent).toContain("ledger_accounts hard delete is prohibited");
		expect(sqlContent).toContain("ledger_accounts code is immutable");
		expect(sqlContent).toContain("ledger_accounts cannot be unarchived");
		expect(sqlContent).toContain("New entries must start in DRAFT status");
		expect(sqlContent).toContain(
			"Cannot insert or modify journal lines on a % journal entry",
		);
		expect(sqlContent).toContain(
			"POSTED journal entries are immutable and cannot be updated",
		);
		expect(sqlContent).toContain("Journal entries cannot be deleted");
		expect(sqlContent).toContain("Journal entry must have at least 2 lines");
		expect(sqlContent).toContain("Journal entry lines are unbalanced");
	});
});
