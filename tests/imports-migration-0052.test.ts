import { describe, expect, it } from "vitest";
import migration0052Sql from "../migrations/0052_colossal_luminals.sql?raw";

describe("Phase 17 - Migration 0052 Verification", () => {
	const sql = migration0052Sql;

	it("creates all 6 tables for the imports domain", () => {
		expect(sql).toContain('CREATE TABLE "import_batches"');
		expect(sql).toContain('CREATE TABLE "import_rows"');
		expect(sql).toContain('CREATE TABLE "import_row_revisions"');
		expect(sql).toContain('CREATE TABLE "import_external_identity_claims"');
		expect(sql).toContain('CREATE TABLE "import_duplicate_candidates"');
		expect(sql).toContain('CREATE TABLE "import_row_results"');
	});

	it("enforces immutability triggers on all 6 tables", () => {
		expect(sql).toContain("trg_fn_prevent_import_mutation()");
		expect(sql).toContain("trg_guard_import_batches_immutable");
		expect(sql).toContain("trg_guard_import_rows_immutable");
		expect(sql).toContain("trg_guard_import_row_revisions_immutable");
		expect(sql).toContain(
			"trg_guard_import_external_identity_claims_immutable",
		);
		expect(sql).toContain("trg_guard_import_duplicate_candidates_immutable");
		expect(sql).toContain("trg_guard_import_row_results_immutable");
	});

	it("enforces revision chain and transition integrity trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_row_revision_chain()");
		expect(sql).toContain("trg_guard_import_row_revision_chain");
	});

	it("enforces anchor completeness constraint trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_row_anchor_completeness()");
		expect(sql).toContain("trg_guard_import_row_anchor_completeness");
	});

	it("enforces terminal result binding constraint trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_terminal_result_binding()");
		expect(sql).toContain("trg_guard_import_terminal_result_binding");
	});

	it("enforces result target integrity binding trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_row_result_integrity()");
		expect(sql).toContain("trg_guard_import_row_result_integrity");
	});

	it("enforces external identity claim integrity trigger", () => {
		expect(sql).toContain("trg_fn_guard_import_external_claim_integrity()");
		expect(sql).toContain("trg_guard_import_external_claim_integrity");
	});
});
