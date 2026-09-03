import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migration0011Sql from "../migrations/0011_amused_grim_reaper.sql?raw";
import {
	canonicalTransactions,
	transactionRevisions,
	transactionSources,
} from "../src/db/schema/transactions";

describe("Canonical Transaction Schema & Migration Invariants (Phase 5A)", () => {
	it("exports canonical_transactions with correct types, columns, and constraints", () => {
		const cols = getTableColumns(canonicalTransactions);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.kind.dataType).toBe("string");
		expect(cols.creationIdempotencyKey.dataType).toBe("string");
		expect(cols.creationFingerprint.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("exports transaction_revisions with correct types, columns, and payload", () => {
		const cols = getTableColumns(transactionRevisions);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.transactionId.dataType).toBe("string");
		expect(cols.revisionNo.dataType).toBe("number");
		expect(cols.previousRevisionId.dataType).toBe("string");
		expect(cols.operation.dataType).toBe("string");
		expect(cols.occurredAt.dataType).toBe("date");
		expect(cols.payload.dataType).toBe("json");
		expect(cols.revisionFingerprint.dataType).toBe("string");
		expect(cols.idempotencyKey.dataType).toBe("string");
		expect(cols.reasonCode.dataType).toBe("string");
		expect(cols.reasonNote.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("exports transaction_sources with correct types and columns", () => {
		const cols = getTableColumns(transactionSources);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.transactionId.dataType).toBe("string");
		expect(cols.revisionId.dataType).toBe("string");
		expect(cols.sourceType.dataType).toBe("string");
		expect(cols.sourceRef.dataType).toBe("string");
		expect(cols.sourcePayloadHash.dataType).toBe("string");
		expect(cols.observedAt.dataType).toBe("date");
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("verifies migration 0011 contains immutability triggers and revision chain guards", () => {
		const sqlContent = migration0011Sql;

		// Tables
		expect(sqlContent).toContain('CREATE TABLE "canonical_transactions"');
		expect(sqlContent).toContain('CREATE TABLE "transaction_revisions"');
		expect(sqlContent).toContain('CREATE TABLE "transaction_sources"');

		// Immutability functions
		expect(sqlContent).toContain(
			"trg_fn_protect_canonical_transactions_immutability",
		);
		expect(sqlContent).toContain(
			"trg_fn_protect_transaction_revisions_immutability",
		);
		expect(sqlContent).toContain(
			"trg_fn_protect_transaction_sources_immutability",
		);

		// Revision insert guard
		expect(sqlContent).toContain("trg_fn_guard_transaction_revisions_insert");
		expect(sqlContent).toContain("trg_guard_transaction_revisions_insert");
		expect(sqlContent).toContain("FOR UPDATE");
		expect(sqlContent).toContain("First revision must have revision_no = 1");
		expect(sqlContent).toContain(
			"Cannot append revision after VOID terminal state",
		);
		expect(sqlContent).toContain(
			"VOID revision must copy latest payload exactly",
		);

		// Source consistency guard
		expect(sqlContent).toContain("trg_fn_guard_transaction_sources_insert");
		expect(sqlContent).toContain("trg_guard_transaction_sources_insert");
	});

	it("verifies migration 0012 updates check constraints to btrim and enforces first revision binding", async () => {
		const migration0012Module = await import(
			"../migrations/0012_spooky_giant_man.sql?raw"
		);
		const sqlContent = migration0012Module.default;

		// Normalized check constraints
		expect(sqlContent).toContain(
			'CHECK ("canonical_transactions"."creation_idempotency_key" = btrim("canonical_transactions"."creation_idempotency_key")',
		);
		expect(sqlContent).toContain(
			'CHECK ("transaction_revisions"."idempotency_key" = btrim("transaction_revisions"."idempotency_key")',
		);
		expect(sqlContent).toContain(
			'CHECK ("transaction_revisions"."reason_note" IS NULL OR ("transaction_revisions"."reason_note" = btrim("transaction_revisions"."reason_note")',
		);
		expect(sqlContent).toContain(
			'CHECK ("transaction_sources"."source_ref" IS NULL OR ("transaction_sources"."source_ref" = btrim("transaction_sources"."source_ref")',
		);

		// First revision binding
		expect(sqlContent).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_transaction_revisions_insert()",
		);
		expect(sqlContent).toContain("v_parent_creation_key");
		expect(sqlContent).toContain("v_parent_creation_fingerprint");
		expect(sqlContent).toContain(
			"First revision idempotency_key % does not match parent creation_idempotency_key %",
		);
		expect(sqlContent).toContain(
			"First revision revision_fingerprint % does not match parent creation_fingerprint %",
		);
	});
});
