import { describe, expect, it } from "vitest";
import migration0054Sql from "../migrations/0054_harden_import_contracts_and_receipt_authority.sql?raw";

describe("Migration 0054 — Final Import Contract & Replay Integrity Closeout", () => {
	const migrationSql = migration0054Sql;

	it("defines updated payload integrity trigger with 1..60 installment count and JSON scalar checks", () => {
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revisions_payload_integrity()",
		);
		expect(migrationSql).toContain("v_inst_cnt < 1 OR v_inst_cnt > 60");
		expect(migrationSql).toContain(
			"jsonb_typeof(NEW.payload->'amount') <> 'string'",
		);
		expect(migrationSql).toContain(
			"jsonb_typeof(NEW.payload->'installmentCount') NOT IN ('number', 'null')",
		);
		expect(migrationSql).toContain(
			"jsonb_typeof(NEW.payload->'cardId') NOT IN ('string', 'null')",
		);
		expect(migrationSql).toContain(
			"jsonb_typeof(NEW.payload->'incomeSourceId') NOT IN ('string', 'null')",
		);
		expect(migrationSql).toContain(
			"jsonb_typeof(NEW.payload->'destinationAccountId') NOT IN ('string', 'null')",
		);
		expect(migrationSql).toContain("timestamptz");
		expect(migrationSql).toContain("9999999999999999.99");
	});

	it("defines null-safe comparisons using IS DISTINCT FROM in result and claim triggers", () => {
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_result_integrity()",
		);
		expect(migrationSql).toContain("IS DISTINCT FROM");
		expect(migrationSql).toContain("cardId cannot be NULL for terminal result");
		expect(migrationSql).toContain(
			"incomeSourceId and destinationAccountId cannot be NULL for terminal result",
		);
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_external_claim_integrity()",
		);
		expect(migrationSql).toContain(
			"Claim cannot be inserted when payload scope is NULL",
		);
	});

	it("defines receipt DB authority trigger and deferred completeness constraint trigger", () => {
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_mutation_receipts_integrity()",
		);
		expect(migrationSql).toContain(
			"trg_guard_import_mutation_receipts_integrity",
		);
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revisions_receipt_completeness()",
		);
		expect(migrationSql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_import_row_revisions_receipt_completeness",
		);
		expect(migrationSql).toContain("DEFERRABLE INITIALLY DEFERRED");
	});

	it("enforces link state machine and CONFIRM_IMPORT copy-forward in trigger", () => {
		expect(migrationSql).toContain(
			"v_prev_rev.status NOT IN ('READY', 'POSSIBLE_DUPLICATE')",
		);
		expect(migrationSql).toContain(
			"Cannot perform LINK from status % (expected READY or POSSIBLE_DUPLICATE)",
		);
		expect(migrationSql).toContain(
			"CONFIRM_IMPORT (POSSIBLE_DUPLICATE -> RESOLVE -> READY) must copy forward the exact payload",
		);
	});
});
