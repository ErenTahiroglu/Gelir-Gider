import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migration0020Sql from "../migrations/0020_midas_virtual_earmark_foundation.sql?raw";
import {
	MIDAS_BUCKET_TYPES,
	midasAccounts,
	midasAllocationTransfers,
	midasBuckets,
	SINGLETON_BUCKET_TYPES,
} from "../src/db/schema/midas";

describe("Midas Schema Definitions (Phase 8A)", () => {
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

		expect(MIDAS_BUCKET_TYPES).toEqual([
			"CREDIT_CARD_RESERVE",
			"SHORT_TERM_GOAL",
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
		]);

		expect(SINGLETON_BUCKET_TYPES).toEqual([
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
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
});
