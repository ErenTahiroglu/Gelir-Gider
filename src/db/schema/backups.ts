import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const BACKUP_RUN_ATTEMPT_STATUSES = [
	"STARTED",
	"COMPLETED",
	"FAILED",
] as const;
export type BackupRunAttemptStatus =
	(typeof BACKUP_RUN_ATTEMPT_STATUSES)[number];

/**
 * Backup Runs Table (Append-Only Anchor)
 * One row per deterministic backup identity, ever. `backupId` is derived
 * (application-side, see `src/backups/service.ts`) from the UTC calendar day
 * of the cron's `scheduledAt` instant, so two overlapping/duplicate cron
 * invocations for the same scheduled day resolve to the SAME anchor row via
 * the conflict-safe INSERT ... ON CONFLICT DO NOTHING + re-read idiom used
 * elsewhere in this codebase (e.g. campaign review candidate idempotency
 * receipts). The identity is `(user_id, backup_id)` -- NOT
 * `(user_id, scheduled_for)` -- because `backupId` is the value the rest of
 * the domain (R2 object key, attempts, envelope header) is keyed off of, so
 * binding uniqueness to it directly is the simplest correct choice.
 */
export const backupRuns = pgTable(
	"backup_runs",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		backupId: text("backup_id").notNull(),
		scheduledFor: timestamp("scheduled_for", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("backup_runs_user_backup_id_idx").on(
			table.userId,
			table.backupId,
		),
		index("backup_runs_user_idx").on(table.userId),
		check(
			"backup_runs_backup_id_check",
			sql`${table.backupId} = btrim(${table.backupId}) AND length(${table.backupId}) >= 1 AND length(${table.backupId}) <= 200`,
		),
	],
);

/**
 * Backup Run Attempts Table (Append-Only Attempt Chain)
 * `attempt_no` is a strictly-increasing unbranched sequence per
 * `backup_run_id`, starting at 1, enforced by a DB trigger (migration 0056)
 * that also enforces the STARTED -> {COMPLETED | FAILED} shape rules and
 * that no attempt may follow a COMPLETED attempt. A COMPLETED attempt is
 * only ever appended by `runDatabaseBackup` AFTER the encrypted object has
 * been uploaded to R2 and its metadata/hash verified -- never before.
 */
export const backupRunAttempts = pgTable(
	"backup_run_attempts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		backupRunId: uuid("backup_run_id")
			.notNull()
			.references(() => backupRuns.id, { onDelete: "restrict" }),
		attemptNo: integer("attempt_no").notNull(),
		status: text("status").notNull(),
		objectKey: text("object_key"),
		ciphertextSha256: text("ciphertext_sha256"),
		plaintextSizeBytes: bigint("plaintext_size_bytes", { mode: "number" }),
		ciphertextSizeBytes: bigint("ciphertext_size_bytes", { mode: "number" }),
		safeErrorCode: text("safe_error_code"),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("backup_run_attempts_run_no_idx").on(
			table.backupRunId,
			table.attemptNo,
		),
		// Defense in depth (mirrors the dual app+trigger enforcement pattern
		// used throughout this engagement): at most one COMPLETED attempt per
		// run, enforced directly by the DB independent of the trigger's
		// "no attempt after COMPLETED" rule.
		uniqueIndex("backup_run_attempts_run_completed_idx")
			.on(table.backupRunId)
			.where(sql`${table.status} = 'COMPLETED'`),
		index("backup_run_attempts_run_idx").on(table.backupRunId),
		check(
			"backup_run_attempts_status_check",
			sql`${table.status} IN ('STARTED', 'COMPLETED', 'FAILED')`,
		),
		check(
			"backup_run_attempts_no_check",
			sql`${table.attemptNo} > 0 AND ${table.attemptNo} <= 10`,
		),
		check(
			"backup_run_attempts_ciphertext_sha256_check",
			sql`${table.ciphertextSha256} IS NULL OR ${table.ciphertextSha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"backup_run_attempts_plaintext_size_check",
			sql`${table.plaintextSizeBytes} IS NULL OR ${table.plaintextSizeBytes} > 0`,
		),
		check(
			"backup_run_attempts_ciphertext_size_check",
			sql`${table.ciphertextSizeBytes} IS NULL OR ${table.ciphertextSizeBytes} > 0`,
		),
		check(
			"backup_run_attempts_safe_error_code_check",
			sql`${table.safeErrorCode} IS NULL OR (length(${table.safeErrorCode}) >= 1 AND length(${table.safeErrorCode}) <= 64)`,
		),
		check(
			"backup_run_attempts_object_key_check",
			sql`${table.objectKey} IS NULL OR (length(${table.objectKey}) >= 1 AND length(${table.objectKey}) <= 500)`,
		),
		// Shape-per-status invariants are also enforced by a DB trigger
		// (migration 0056) with FOR UPDATE serialization against the parent
		// run; these plain CHECKs are a cheap redundant backstop.
		check(
			"backup_run_attempts_started_shape_check",
			sql`${table.status} != 'STARTED' OR (${table.objectKey} IS NULL AND ${table.ciphertextSha256} IS NULL AND ${table.plaintextSizeBytes} IS NULL AND ${table.ciphertextSizeBytes} IS NULL AND ${table.safeErrorCode} IS NULL)`,
		),
		check(
			"backup_run_attempts_completed_shape_check",
			sql`${table.status} != 'COMPLETED' OR (${table.objectKey} IS NOT NULL AND ${table.ciphertextSha256} IS NOT NULL AND ${table.plaintextSizeBytes} IS NOT NULL AND ${table.ciphertextSizeBytes} IS NOT NULL AND ${table.safeErrorCode} IS NULL)`,
		),
		check(
			"backup_run_attempts_failed_shape_check",
			sql`${table.status} != 'FAILED' OR (${table.safeErrorCode} IS NOT NULL AND ${table.objectKey} IS NULL AND ${table.ciphertextSha256} IS NULL AND ${table.plaintextSizeBytes} IS NULL AND ${table.ciphertextSizeBytes} IS NULL)`,
		),
	],
);
