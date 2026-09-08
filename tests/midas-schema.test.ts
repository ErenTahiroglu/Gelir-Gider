import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migration0020Sql from "../migrations/0020_midas_virtual_earmark_foundation.sql?raw";
import migration0021Sql from "../migrations/0021_unusual_bug.sql?raw";
import {
	MIDAS_BUCKET_TYPES,
	midasAccounts,
	midasAllocationTransfers,
	midasBuckets,
	SINGLETON_BUCKET_TYPES,
} from "../src/db/schema/midas";

describe("Midas Schema Definitions (Phase 8A & 8A-R1)", () => {
	it("exports midas_accounts with exact physical identity columns and NO duplicate balance column", () => {
		const cols = getTableColumns(midasAccounts);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.ledgerAccountId.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");

		// Crucial architectural invariant: NO duplicate physical balance column
		expect((cols as Record<string, unknown>).balance).toBeUndefined();
		expect((cols as Record<string, unknown>).available_balance).toBeUndefined();
		expect((cols as Record<string, unknown>).cash_balance).toBeUndefined();
		expect((cols as Record<string, unknown>).tp2_balance).toBeUndefined();
	});

	it("exports midas_buckets with proper types and supported bucket types", () => {
		const cols = getTableColumns(midasBuckets);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.midasAccountId.dataType).toBe("string");
		expect(cols.code.dataType).toBe("string");
		expect(cols.name.dataType).toBe("string");
		expect(cols.bucketType.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");

		// CORE_EMERGENCY_FUND appended for PERSONAL_BUDGET_V2 (migration 0061);
		// every pre-existing type keeps its identity and order.
		expect(MIDAS_BUCKET_TYPES).toEqual([
			"CREDIT_CARD_RESERVE",
			"SHORT_TERM_GOAL",
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
			"CORE_EMERGENCY_FUND",
		]);

		expect(SINGLETON_BUCKET_TYPES).toEqual([
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
			"CORE_EMERGENCY_FUND",
		]);
	});

	it("exports midas_allocation_transfers with exact NUMERIC(18,2) amount, SHA-256 fingerprint, and reversal columns", () => {
		const cols = getTableColumns(midasAllocationTransfers);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.midasAccountId.dataType).toBe("string");
		expect(cols.idempotencyKey.dataType).toBe("string");
		expect(cols.transferFingerprint.dataType).toBe("string");
		expect(cols.fromBucketId.dataType).toBe("string");
		expect(cols.toBucketId.dataType).toBe("string");
		expect(cols.amount.dataType).toBe("string"); // Drizzle numeric maps to string
		expect(cols.occurredAt.dataType).toBe("date");
		expect(cols.reversalOfTransferId.dataType).toBe("string");
		expect(cols.memo.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("verifies migration 0020 contains required DDL, immutability triggers, and guard functions", () => {
		const sqlContent = migration0020Sql;

		// Tables
		expect(sqlContent).toContain('CREATE TABLE "midas_accounts"');
		expect(sqlContent).toContain('CREATE TABLE "midas_buckets"');
		expect(sqlContent).toContain('CREATE TABLE "midas_allocation_transfers"');

		// Unique constraints
		expect(sqlContent).toContain("midas_accounts_user_idx");
		expect(sqlContent).toContain("midas_accounts_ledger_account_idx");
		expect(sqlContent).toContain("midas_buckets_account_code_idx");
		expect(sqlContent).toContain("midas_buckets_singleton_type_idx");
		expect(sqlContent).toContain("midas_transfers_user_idempotency_idx");
		expect(sqlContent).toContain("midas_transfers_reversal_idx");

		// Immutability triggers
		expect(sqlContent).toContain("trg_fn_guard_midas_accounts_immutability");
		expect(sqlContent).toContain("trg_fn_guard_midas_buckets_immutability");
		expect(sqlContent).toContain(
			"trg_fn_guard_midas_allocation_transfers_immutability",
		);

		// Insert guards
		expect(sqlContent).toContain("trg_fn_guard_midas_accounts_insert");
		expect(sqlContent).toContain("trg_fn_guard_midas_buckets_insert");
		expect(sqlContent).toContain(
			"trg_fn_guard_midas_allocation_transfers_insert",
		);

		// Cross-ledger solvency guard
		expect(sqlContent).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition",
		);
		expect(sqlContent).toContain("Midas cross-ledger solvency violation");
		expect(sqlContent).toContain("FOR v_midas_account IN");
	});

	it("verifies migration 0021 contains btrim check constraints, FOR UPDATE insert guard, archive protection, and lock hierarchy reordering", () => {
		const sqlContent = migration0021Sql;

		// btrim check constraints
		expect(sqlContent).toContain('btrim("midas_buckets"."name")');
		expect(sqlContent).toContain(
			'btrim("midas_allocation_transfers"."idempotency_key")',
		);
		expect(sqlContent).toContain('btrim("midas_allocation_transfers"."memo")');

		// FOR UPDATE and negative balance check on midas_accounts insert
		expect(sqlContent).toContain("WHERE id = NEW.ledger_account_id");
		expect(sqlContent).toContain("FOR UPDATE");
		expect(sqlContent).toContain("v_physical_balance < 0");

		// Ledger account archive protection trigger
		expect(sqlContent).toContain("trg_fn_guard_ledger_accounts_archive");
		expect(sqlContent).toContain("trg_guard_ledger_accounts_archive");
		expect(sqlContent).toContain(
			"Cannot archive ledger account % because it is linked to Midas liquidity account %",
		);

		// Lock reordering in transition guard: ledger_accounts locked before midas_accounts
		expect(sqlContent).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_journal_entries_transition",
		);
		const ledgerLockIndex = sqlContent.indexOf("FOR v_account IN");
		const midasLockIndex = sqlContent.indexOf("FOR v_midas_account IN");
		expect(ledgerLockIndex).toBeGreaterThan(0);
		expect(midasLockIndex).toBeGreaterThan(0);
		expect(ledgerLockIndex).toBeLessThan(midasLockIndex);
	});
});
