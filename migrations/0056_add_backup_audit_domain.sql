CREATE TABLE "backup_run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_run_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" text NOT NULL,
	"object_key" text,
	"ciphertext_sha256" text,
	"plaintext_size_bytes" bigint,
	"ciphertext_size_bytes" bigint,
	"safe_error_code" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_run_attempts_status_check" CHECK ("backup_run_attempts"."status" IN ('STARTED', 'COMPLETED', 'FAILED')),
	CONSTRAINT "backup_run_attempts_no_check" CHECK ("backup_run_attempts"."attempt_no" > 0 AND "backup_run_attempts"."attempt_no" <= 5),
	CONSTRAINT "backup_run_attempts_ciphertext_sha256_check" CHECK ("backup_run_attempts"."ciphertext_sha256" IS NULL OR "backup_run_attempts"."ciphertext_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "backup_run_attempts_plaintext_size_check" CHECK ("backup_run_attempts"."plaintext_size_bytes" IS NULL OR "backup_run_attempts"."plaintext_size_bytes" > 0),
	CONSTRAINT "backup_run_attempts_ciphertext_size_check" CHECK ("backup_run_attempts"."ciphertext_size_bytes" IS NULL OR "backup_run_attempts"."ciphertext_size_bytes" > 0),
	CONSTRAINT "backup_run_attempts_safe_error_code_check" CHECK ("backup_run_attempts"."safe_error_code" IS NULL OR (length("backup_run_attempts"."safe_error_code") >= 1 AND length("backup_run_attempts"."safe_error_code") <= 64)),
	CONSTRAINT "backup_run_attempts_object_key_check" CHECK ("backup_run_attempts"."object_key" IS NULL OR (length("backup_run_attempts"."object_key") >= 1 AND length("backup_run_attempts"."object_key") <= 500)),
	CONSTRAINT "backup_run_attempts_started_shape_check" CHECK ("backup_run_attempts"."status" != 'STARTED' OR ("backup_run_attempts"."object_key" IS NULL AND "backup_run_attempts"."ciphertext_sha256" IS NULL AND "backup_run_attempts"."plaintext_size_bytes" IS NULL AND "backup_run_attempts"."ciphertext_size_bytes" IS NULL AND "backup_run_attempts"."safe_error_code" IS NULL)),
	CONSTRAINT "backup_run_attempts_completed_shape_check" CHECK ("backup_run_attempts"."status" != 'COMPLETED' OR ("backup_run_attempts"."object_key" IS NOT NULL AND "backup_run_attempts"."ciphertext_sha256" IS NOT NULL AND "backup_run_attempts"."plaintext_size_bytes" IS NOT NULL AND "backup_run_attempts"."ciphertext_size_bytes" IS NOT NULL AND "backup_run_attempts"."safe_error_code" IS NULL)),
	CONSTRAINT "backup_run_attempts_failed_shape_check" CHECK ("backup_run_attempts"."status" != 'FAILED' OR ("backup_run_attempts"."safe_error_code" IS NOT NULL AND "backup_run_attempts"."object_key" IS NULL AND "backup_run_attempts"."ciphertext_sha256" IS NULL AND "backup_run_attempts"."plaintext_size_bytes" IS NULL AND "backup_run_attempts"."ciphertext_size_bytes" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"backup_id" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_runs_backup_id_check" CHECK ("backup_runs"."backup_id" = btrim("backup_runs"."backup_id") AND length("backup_runs"."backup_id") >= 1 AND length("backup_runs"."backup_id") <= 200)
);
--> statement-breakpoint
ALTER TABLE "backup_run_attempts" ADD CONSTRAINT "backup_run_attempts_backup_run_id_backup_runs_id_fk" FOREIGN KEY ("backup_run_id") REFERENCES "public"."backup_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_run_attempts_run_no_idx" ON "backup_run_attempts" USING btree ("backup_run_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_run_attempts_run_completed_idx" ON "backup_run_attempts" USING btree ("backup_run_id") WHERE "backup_run_attempts"."status" = 'COMPLETED';--> statement-breakpoint
CREATE INDEX "backup_run_attempts_run_idx" ON "backup_run_attempts" USING btree ("backup_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_user_backup_id_idx" ON "backup_runs" USING btree ("user_id","backup_id");--> statement-breakpoint
CREATE INDEX "backup_runs_user_idx" ON "backup_runs" USING btree ("user_id");--> statement-breakpoint
-- ============================================================================
-- PHASE 18: BACKUP DOMAIN INTEGRITY (append-only anchor + attempt chain)
--
-- backup_runs and backup_run_attempts are both append-only: neither table
-- may ever be UPDATEd or DELETEd (a generic deny-mutation trigger function,
-- reused across both tables, mirrors trg_fn_deny_mutation_campaigns from
-- migration 0051).
--
-- backup_run_attempts additionally requires a BEFORE INSERT guard
-- enforcing:
--   * attempt_no is an unbranched sequence per backup_run_id, starting at 1
--     (COALESCE(MAX(attempt_no), 0) + 1), checked under a FOR UPDATE lock on
--     the parent backup_runs row to serialize concurrent attempt inserts for
--     the same run.
--   * attempt #1 must be STARTED.
--   * STARTED must have object_key/ciphertext_sha256/plaintext_size_bytes/
--     ciphertext_size_bytes/safe_error_code all NULL.
--   * COMPLETED must have object_key + ciphertext_sha256 +
--     plaintext_size_bytes + ciphertext_size_bytes all NOT NULL and
--     safe_error_code NULL.
--   * FAILED must have safe_error_code NOT NULL and object_key/
--     ciphertext_sha256/plaintext_size_bytes/ciphertext_size_bytes all NULL.
--   * No attempt may be inserted once a COMPLETED attempt already exists for
--     that run.
-- (The per-status shape rules are ALSO enforced by plain CHECK constraints
-- on the table itself, and "at most one COMPLETED attempt per run" is ALSO
-- enforced by the backup_run_attempts_run_completed_idx partial unique
-- index -- dual app+trigger+constraint defense in depth, mirroring the
-- pattern used throughout this engagement.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Generic deny-mutation trigger function for the backup domain's append-only
-- tables.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_deny_mutation_backups()
RETURNS TRIGGER AS $$
BEGIN
	RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_backup_runs ON "backup_runs";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_backup_runs
BEFORE UPDATE OR DELETE ON "backup_runs"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_backups();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_deny_mutation_backup_run_attempts ON "backup_run_attempts";--> statement-breakpoint
CREATE TRIGGER trg_deny_mutation_backup_run_attempts
BEFORE UPDATE OR DELETE ON "backup_run_attempts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_deny_mutation_backups();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- backup_run_attempts: unbranched attempt chain + per-status shape +
-- no-attempt-after-COMPLETED insert guard.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_fn_guard_backup_run_attempt_insert()
RETURNS TRIGGER AS $$
DECLARE
	v_run RECORD;
	v_expected_no INT;
	v_completed_exists BOOLEAN;
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

	IF NEW.attempt_no = 1 AND NEW.status != 'STARTED' THEN
		RAISE EXCEPTION 'Backup run % first attempt must have status STARTED, got %', NEW.backup_run_id, NEW.status;
	END IF;

	SELECT EXISTS (
		SELECT 1 FROM backup_run_attempts WHERE backup_run_id = NEW.backup_run_id AND status = 'COMPLETED'
	) INTO v_completed_exists;
	IF v_completed_exists THEN
		RAISE EXCEPTION 'Backup run % already has a COMPLETED attempt; no further attempts may be inserted', NEW.backup_run_id;
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_backup_run_attempt_insert ON "backup_run_attempts";--> statement-breakpoint
CREATE TRIGGER trg_guard_backup_run_attempt_insert
BEFORE INSERT ON "backup_run_attempts"
FOR EACH ROW EXECUTE FUNCTION trg_fn_guard_backup_run_attempt_insert();