import { describe, expect, it } from "vitest";
import migration0056Sql from "../migrations/0056_add_backup_audit_domain.sql?raw";

describe("Backup Domain Migration 0056 Verification (Phase 18)", () => {
	const sql = migration0056Sql;

	it("creates the backup_runs and backup_run_attempts tables", () => {
		expect(sql).toContain('CREATE TABLE "backup_run_attempts"');
		expect(sql).toContain('CREATE TABLE "backup_runs"');
	});

	it("enforces the per-status shape via CHECK constraints", () => {
		expect(sql).toContain("backup_run_attempts_started_shape_check");
		expect(sql).toContain("backup_run_attempts_completed_shape_check");
		expect(sql).toContain("backup_run_attempts_failed_shape_check");
	});

	it("has a partial unique index enforcing at most one COMPLETED attempt per run", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "backup_run_attempts_run_completed_idx" ON "backup_run_attempts" USING btree ("backup_run_id") WHERE "backup_run_attempts"."status" = \'COMPLETED\'',
		);
	});

	it("defines a generic deny-mutation trigger function for the backup domain", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_backups()",
		);
		expect(sql).toContain("is append-only;");
	});

	it("denies UPDATE/DELETE on backup_runs", () => {
		expect(sql).toContain("CREATE TRIGGER trg_deny_mutation_backup_runs");
		expect(sql).toContain('BEFORE UPDATE OR DELETE ON "backup_runs"');
	});

	it("denies UPDATE/DELETE on backup_run_attempts", () => {
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_backup_run_attempts",
		);
		expect(sql).toContain('BEFORE UPDATE OR DELETE ON "backup_run_attempts"');
	});

	it("locks the parent backup_runs row FOR UPDATE before computing the next attempt_no", () => {
		expect(sql).toContain(
			"SELECT * INTO v_run FROM backup_runs WHERE id = NEW.backup_run_id FOR UPDATE;",
		);
	});

	it("enforces an unbranched attempt_no sequence per backup_run_id", () => {
		expect(sql).toContain(
			"SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO v_expected_no",
		);
		expect(sql).toContain("does not match expected next attempt_no");
	});

	it("requires the first attempt to be STARTED", () => {
		expect(sql).toContain("NEW.attempt_no = 1 AND NEW.status != 'STARTED'");
	});

	it("forbids any attempt once a COMPLETED attempt already exists for the run", () => {
		expect(sql).toContain(
			"SELECT EXISTS (\n\t\tSELECT 1 FROM backup_run_attempts WHERE backup_run_id = NEW.backup_run_id AND status = 'COMPLETED'",
		);
		expect(sql).toContain("no further attempts may be inserted");
	});

	it("enforces STARTED attempt shape in the trigger", () => {
		expect(sql).toContain(
			"must not carry object_key/ciphertext_sha256/plaintext_size_bytes/ciphertext_size_bytes/safe_error_code",
		);
	});

	it("enforces COMPLETED attempt shape in the trigger", () => {
		expect(sql).toContain(
			"COMPLETED attempt must carry object_key, ciphertext_sha256, plaintext_size_bytes, and ciphertext_size_bytes",
		);
	});

	it("enforces FAILED attempt shape in the trigger", () => {
		expect(sql).toContain("FAILED attempt must carry a safe_error_code");
	});

	it("registers the BEFORE INSERT guard trigger on backup_run_attempts", () => {
		expect(sql).toContain("CREATE TRIGGER trg_guard_backup_run_attempt_insert");
		expect(sql).toContain('BEFORE INSERT ON "backup_run_attempts"');
	});
});
