import { describe, expect, it } from "vitest";
import migration0055Sql from "../migrations/0055_finalize_import_link_and_receipt_integrity.sql?raw";

describe("Migration 0055 — Final Link and Receipt Integrity Closeout", () => {
	const migrationSql = migration0055Sql;

	it("defines updated revision chain trigger allowing LINK -> EXACT_DUPLICATE and mandatory idempotency keys", () => {
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revision_chain()",
		);
		expect(migrationSql).toContain(
			"NEW.operation = 'LINK' AND NEW.status NOT IN ('LINKED_EXISTING', 'EXACT_DUPLICATE')",
		);
		expect(migrationSql).toContain(
			"NEW.operation = 'LINK' THEN\n\t\tIF v_prev.status NOT IN ('READY', 'POSSIBLE_DUPLICATE')",
		);
		expect(migrationSql).toContain(
			"Initial revision (revision_no=1) must have NULL idempotency_key",
		);
		expect(migrationSql).toContain(
			"Mutation revision (revision_no=%) must have non-NULL idempotency_key",
		);
	});

	it("defines receipt DB authority trigger with exact result kind mappings", () => {
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_mutation_receipts_integrity()",
		);
		expect(migrationSql).toContain(
			"Receipt APPLY + APPLIED requires result_kind CREATED",
		);
		expect(migrationSql).toContain(
			"Receipt APPLY + EXACT_DUPLICATE requires result_kind EXACT_DUPLICATE",
		);
		expect(migrationSql).toContain(
			"Receipt LINK_EXISTING + LINKED_EXISTING requires result_kind LINKED_EXISTING",
		);
		expect(migrationSql).toContain(
			"Receipt LINK_EXISTING + EXACT_DUPLICATE requires result_kind EXACT_DUPLICATE",
		);
		expect(migrationSql).toContain(
			"Receipt RESOLVE_MAPPINGS + EXACT_DUPLICATE requires result_kind EXACT_DUPLICATE",
		);
		expect(migrationSql).toContain(
			"Receipt for non-terminal revision % (status %) must have NULL import_row_result_id",
		);
	});

	it("defines deferred revision receipt completeness constraint trigger", () => {
		expect(migrationSql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_import_row_revisions_receipt_completeness()",
		);
		expect(migrationSql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_import_row_revisions_receipt_completeness",
		);
		expect(migrationSql).toContain("DEFERRABLE INITIALLY DEFERRED");
		expect(migrationSql).toContain(
			"requires exactly one matching mutation receipt at commit",
		);
	});
});
