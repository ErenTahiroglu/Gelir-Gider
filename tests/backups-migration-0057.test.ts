import { describe, expect, it } from "vitest";
import migration0057Sql from "../migrations/0057_harden_backup_execution_and_restore_integrity.sql?raw";

describe("Backup Domain Migration 0057 Verification (Phase 18-R1 Section A)", () => {
	const sql = migration0057Sql;

	it("raises the attempt_no CHECK constraint bound from 5 to 10 (5 logical executions x 2 events)", () => {
		expect(sql).toContain(
			'ALTER TABLE "backup_run_attempts" DROP CONSTRAINT "backup_run_attempts_no_check"',
		);
		expect(sql).toContain(
			'ADD CONSTRAINT "backup_run_attempts_no_check" CHECK ("backup_run_attempts"."attempt_no" > 0 AND "backup_run_attempts"."attempt_no" <= 10)',
		);
	});

	it("re-declares trg_fn_guard_backup_run_attempt_insert in place via CREATE OR REPLACE", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_backup_run_attempt_insert()",
		);
	});

	it("rejects a STARTED event following another STARTED event", () => {
		expect(sql).toContain("STARTED -> STARTED is not permitted");
	});

	it("requires the event following a FAILED event to be STARTED", () => {
		expect(sql).toContain(
			"event following a FAILED event must be STARTED (a fresh execution reservation)",
		);
	});

	it("still rejects any event once a COMPLETED event already exists", () => {
		expect(sql).toContain(
			"already has a COMPLETED event; no further events may be inserted",
		);
	});

	it("still locks the parent backup_runs row FOR UPDATE before computing the next attempt_no", () => {
		expect(sql).toContain(
			"SELECT * INTO v_run FROM backup_runs WHERE id = NEW.backup_run_id FOR UPDATE;",
		);
	});

	it("still enforces an unbranched attempt_no sequence per backup_run_id", () => {
		expect(sql).toContain(
			"SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO v_expected_no",
		);
	});

	it("does not drop or recreate the trigger itself (function altered in place)", () => {
		expect(sql).not.toContain("DROP TRIGGER");
		expect(sql).not.toContain("CREATE TRIGGER");
	});
});
