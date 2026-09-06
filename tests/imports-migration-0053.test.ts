import { describe, expect, it } from "vitest";
import migration0053Sql from "../migrations/0053_ordinary_ken_ellis.sql?raw";

describe("Phase 17-R1 - Migration 0053 Verification", () => {
	const sql = migration0053Sql;

	it("creates import_mutation_idempotency_receipts table and external_identity_claim_id column", () => {
		expect(sql).toContain(
			'CREATE TABLE "import_mutation_idempotency_receipts"',
		);
		expect(sql).toContain(
			'ALTER TABLE "import_row_results" ADD COLUMN "external_identity_claim_id"',
		);
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "import_mutation_receipts_user_key_idx"',
		);
	});

	it("enforces immutability trigger on import_mutation_idempotency_receipts", () => {
		expect(sql).toContain("trg_guard_import_mutation_receipts_immutable");
		expect(sql).toContain("trg_fn_prevent_import_mutation()");
	});

	it("enforces EXACT_DUPLICATE terminal result binding trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_terminal_result_binding()");
		expect(sql).toContain("ELSIF NEW.status = 'EXACT_DUPLICATE' THEN");
	});

	it("enforces hardened result target and claim integrity trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_row_result_integrity()");
		expect(sql).toContain("v_claim.user_id <> NEW.user_id");
		expect(sql).toContain(
			"Exact duplicate result % target does not match original result target %",
		);
	});

	it("enforces external identity claim integrity trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_external_claim_integrity()");
		expect(sql).toContain("Provider mismatch: batch has %, claim has %");
		expect(sql).toContain("Claim scope mismatch: expected %, got %");
	});

	it("enforces external identity claim completeness trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_external_claim_completeness()");
		expect(sql).toContain(
			"has no matching CREATED or LINKED_EXISTING result at commit (naked claim)",
		);
	});

	it("enforces duplicate candidate target integrity trigger", () => {
		expect(sql).toContain(
			"trg_fn_guard_import_duplicate_candidates_integrity()",
		);
		expect(sql).toContain("trg_guard_import_duplicate_candidates_integrity");
	});

	it("enforces payload check and copy-forward triggers", () => {
		expect(sql).toContain(
			"trg_fn_guard_import_row_revisions_payload_integrity()",
		);
		expect(sql).toContain("trg_guard_import_row_revisions_payload_integrity");
		expect(sql).toContain("Cannot modify amount in subsequent revisions");
	});
});
