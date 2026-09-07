ALTER TABLE "backup_run_attempts" DROP CONSTRAINT "backup_run_attempts_no_check";--> statement-breakpoint
ALTER TABLE "backup_run_attempts" ADD CONSTRAINT "backup_run_attempts_no_check" CHECK ("backup_run_attempts"."attempt_no" > 0 AND "backup_run_attempts"."attempt_no" <= 10);--> statement-breakpoint
-- ============================================================================
-- PHASE 18-R1 SECTION A: one-active-backup-execution concurrency guard
--
-- `backup_run_attempts` is reframed from a plain "attempt" chain into an
-- EVENT sequence describing a state machine per backup_run_id:
--   (none) -> STARTED -> {COMPLETED | FAILED}
--   FAILED -> STARTED -> {COMPLETED | FAILED}
--   COMPLETED -> (terminal, nothing further)
--
-- The bound above was raised from 5 to 10 (5 logical executions x 2 events
-- each: a STARTED reservation event + its terminal COMPLETED/FAILED event)
-- to give the reservation+finalization design in src/backups/service.ts
-- room for a bounded number of retried logical executions per backup_run,
-- while still capping runaway retry loops.
--
-- trg_fn_guard_backup_run_attempt_insert is altered in place (CREATE OR
-- REPLACE, same function/trigger names, mirroring how Phase 16-R1/R2
-- iterated on trigger functions without dropping/recreating them) to add:
--   * STARTED -> STARTED is REJECTED (previously nothing stopped this for
--     attempt_no > 1 -- only attempt_no = 1 was pinned to STARTED).
--   * After FAILED, the next event MUST be STARTED (a fresh logical
--     execution reservation) -- anything else is rejected.
--   * After COMPLETED, no further event may ever be inserted (unchanged
--     behavior, now expressed via the same latest-status lookup instead of
--     a separate EXISTS(... status = 'COMPLETED') check).
-- The per-status shape checks (STARTED/COMPLETED/FAILED payload shape) and
-- the unbranched attempt_no sequence + FOR UPDATE lock on the parent
-- backup_runs row are unchanged from migration 0056.
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_fn_guard_backup_run_attempt_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_run RECORD;
	v_expected_no INT;
	v_latest_status TEXT;
BEGIN
	SELECT * INTO v_run FROM backup_runs WHERE id = NEW.backup_run_id FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Backup run % not found', NEW.backup_run_id;
	END IF;

	SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO v_expected_no
	FROM backup_run_attempts
	WHERE backup_run_id = NEW.backup_run_id;

	IF NEW.attempt_no != v_expected_no THEN
		RAISE EXCEPTION 'Backup run % attempt_no % does not match expected next attempt_no % (unbranched sequence required)',
			NEW.backup_run_id, NEW.attempt_no, v_expected_no;
	END IF;

	SELECT status INTO v_latest_status
	FROM backup_run_attempts
	WHERE backup_run_id = NEW.backup_run_id
	ORDER BY attempt_no DESC
	LIMIT 1;

	IF v_latest_status IS NULL THEN
		IF NEW.status != 'STARTED' THEN
			RAISE EXCEPTION 'Backup run % first event must have status STARTED, got %', NEW.backup_run_id, NEW.status;
		END IF;
	ELSIF v_latest_status = 'STARTED' THEN
		IF NEW.status NOT IN ('COMPLETED', 'FAILED') THEN
			RAISE EXCEPTION 'Backup run % event following a STARTED event must be COMPLETED or FAILED; STARTED -> STARTED is not permitted (got %)', NEW.backup_run_id, NEW.status;
		END IF;
	ELSIF v_latest_status = 'FAILED' THEN
		IF NEW.status != 'STARTED' THEN
			RAISE EXCEPTION 'Backup run % event following a FAILED event must be STARTED (a fresh execution reservation); got %', NEW.backup_run_id, NEW.status;
		END IF;
	ELSIF v_latest_status = 'COMPLETED' THEN
		RAISE EXCEPTION 'Backup run % already has a COMPLETED event; no further events may be inserted', NEW.backup_run_id;
	ELSE
		RAISE EXCEPTION 'Backup run % has an unrecognized latest event status %', NEW.backup_run_id, v_latest_status;
	END IF;

	IF NEW.status = 'STARTED' THEN
		IF NEW.object_key IS NOT NULL OR NEW.ciphertext_sha256 IS NOT NULL
			OR NEW.plaintext_size_bytes IS NOT NULL OR NEW.ciphertext_size_bytes IS NOT NULL
			OR NEW.safe_error_code IS NOT NULL THEN
			RAISE EXCEPTION 'Backup run % STARTED attempt must not carry object_key/ciphertext_sha256/plaintext_size_bytes/ciphertext_size_bytes/safe_error_code', NEW.backup_run_id;
		END IF;
	ELSIF NEW.status = 'COMPLETED' THEN
		IF NEW.object_key IS NULL OR NEW.ciphertext_sha256 IS NULL
			OR NEW.plaintext_size_bytes IS NULL OR NEW.ciphertext_size_bytes IS NULL THEN
			RAISE EXCEPTION 'Backup run % COMPLETED attempt must carry object_key, ciphertext_sha256, plaintext_size_bytes, and ciphertext_size_bytes', NEW.backup_run_id;
		END IF;
		IF NEW.safe_error_code IS NOT NULL THEN
			RAISE EXCEPTION 'Backup run % COMPLETED attempt must not carry safe_error_code', NEW.backup_run_id;
		END IF;
	ELSIF NEW.status = 'FAILED' THEN
		IF NEW.safe_error_code IS NULL THEN
			RAISE EXCEPTION 'Backup run % FAILED attempt must carry a safe_error_code', NEW.backup_run_id;
		END IF;
		IF NEW.object_key IS NOT NULL OR NEW.ciphertext_sha256 IS NOT NULL
			OR NEW.plaintext_size_bytes IS NOT NULL OR NEW.ciphertext_size_bytes IS NOT NULL THEN
			RAISE EXCEPTION 'Backup run % FAILED attempt must not carry object_key/ciphertext_sha256/plaintext_size_bytes/ciphertext_size_bytes', NEW.backup_run_id;
		END IF;
	ELSE
		RAISE EXCEPTION 'Unknown backup_run_attempts status %', NEW.status;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
