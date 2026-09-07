import { desc, eq, sql } from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import { backupRunAttempts, backupRuns } from "../db/schema/backups";
import type { BackupBucket } from "./bucket";
import type { BackupEnvelope } from "./crypto";
import { encryptBackupPayload } from "./crypto";
import { BackupError } from "./errors";
import { buildSnapshotPayload, exportDatabaseSnapshot } from "./export";
import { verifyEncryptedBackupSummary } from "./verify";

export const BACKUP_OBJECT_KEY_PREFIX = "gelir-gider/v1";

/**
 * How long a STARTED event may remain the latest event for a backup_run
 * before a subsequent invocation treats it as abandoned (e.g. the process
 * that reserved it crashed or was evicted before it could finalize). See the
 * "exactly-once" doc comment on `runDatabaseBackup` below for the precise
 * guarantee (and non-guarantee) this provides.
 */
export const BACKUP_STARTED_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * 5 logical executions x 2 events each (a STARTED reservation + its terminal
 * COMPLETED/FAILED event) = 10 events maximum per backup_run, mirroring the
 * `backup_run_attempts_no_check` CHECK constraint bound (migration 0057).
 */
export const BACKUP_MAX_EVENTS_PER_RUN = 10;

/**
 * Derives the deterministic backup identity for a given scheduled UTC
 * instant: the UTC calendar day, `YYYYMMDD`. Two overlapping/duplicate cron
 * invocations scheduled for the same day resolve to the SAME backupId, so
 * the `backup_runs` anchor insert (INSERT ... ON CONFLICT DO NOTHING +
 * re-read) makes the whole run idempotent per day.
 */
export function deriveBackupId(scheduledAt: Date): string {
	const y = scheduledAt.getUTCFullYear().toString().padStart(4, "0");
	const m = (scheduledAt.getUTCMonth() + 1).toString().padStart(2, "0");
	const d = scheduledAt.getUTCDate().toString().padStart(2, "0");
	return `${y}${m}${d}`;
}

/**
 * Derives the R2 object key for a backup:
 * `gelir-gider/v1/YYYY/MM/DD/<backupId>-<reservationEventId>.ggbak`.
 * `backupId` (`YYYYMMDD`) stays the deterministic DAILY identity; the
 * `reservationEventId` suffix is the UUID of the `STARTED` event this
 * specific logical execution reserved in Phase 1 (`reservation.eventId`),
 * making the key EXECUTION-scoped rather than merely day-scoped. This is
 * what lets `bucket.delete(objectKey)` cleanup calls (see `runDatabaseBackup`
 * below) safely delete only the object THIS execution itself wrote, even
 * when a stale/racing execution for the same day is involved (Section B).
 * Derived entirely from `scheduledAt` (UTC), `backupId`, and an opaque UUID
 * -- never a user name, email, financial value, or DB host.
 */
export function deriveObjectKey(
	scheduledAt: Date,
	backupId: string,
	reservationEventId: string,
): string {
	const y = scheduledAt.getUTCFullYear().toString().padStart(4, "0");
	const m = (scheduledAt.getUTCMonth() + 1).toString().padStart(2, "0");
	const d = scheduledAt.getUTCDate().toString().padStart(2, "0");
	return `${BACKUP_OBJECT_KEY_PREFIX}/${y}/${m}/${d}/${backupId}-${reservationEventId}.ggbak`;
}

export interface RunDatabaseBackupParams {
	db: Database;
	bucket: BackupBucket;
	encryptionKey: Uint8Array;
	keyId: string;
	scheduledAt: Date;
	maxPlaintextBytes?: number | undefined;
}

/**
 * `IN_PROGRESS` means: another (still-live, non-stale) invocation currently
 * holds the reservation for this backup_run. The caller performed ZERO
 * network/R2 work to reach this result -- it is a benign, expected outcome
 * for a legitimate concurrent/retried invocation, never a failure. Callers
 * (notably `src/index.ts`'s scheduled() handler) must not log it as an error
 * or rethrow because of it.
 */
export interface BackupRunResult {
	status: "COMPLETED" | "FAILED" | "IN_PROGRESS";
	backupRunId: string;
	backupId: string;
	objectKey: string | null;
	safeErrorCode: string | null;
}

export interface CompletedBackupObject {
	objectKey: string;
	ciphertextSha256: string;
}

/**
 * Queries every `COMPLETED` `backup_run_attempts` row that has a non-null
 * `object_key`/`ciphertext_sha256` (the DB trigger/constraints from migration
 * 0057 guarantee a `COMPLETED` row always has both set), returning the exact
 * `{objectKey, ciphertextSha256}` pairs. This is the DB-authoritative source
 * of truth `runBackupRetention` (Section D) uses to decide which R2 objects
 * correspond to a genuine successful backup -- `retention.ts` itself stays a
 * pure R2-plus-input-data module and never imports DB schema/query code
 * directly; the caller (`src/index.ts`'s scheduled handler) queries this and
 * passes the result in.
 */
export async function listCompletedBackupObjects(
	db: Database,
): Promise<CompletedBackupObject[]> {
	const rows = await db
		.select({
			objectKey: backupRunAttempts.objectKey,
			ciphertextSha256: backupRunAttempts.ciphertextSha256,
		})
		.from(backupRunAttempts)
		.where(eq(backupRunAttempts.status, "COMPLETED"));

	const results: CompletedBackupObject[] = [];
	for (const row of rows) {
		if (row.objectKey && row.ciphertextSha256) {
			results.push({
				objectKey: row.objectKey,
				ciphertextSha256: row.ciphertextSha256,
			});
		}
	}
	return results;
}

async function getOrCreateAnchorRun(
	dbx: DatabaseOrTransaction,
	userId: string,
	backupId: string,
	scheduledAt: Date,
): Promise<{ id: string }> {
	await dbx
		.insert(backupRuns)
		.values({ userId, backupId, scheduledFor: scheduledAt })
		.onConflictDoNothing({ target: [backupRuns.userId, backupRuns.backupId] });

	const [row] = await dbx
		.select({ id: backupRuns.id })
		.from(backupRuns)
		.where(eq(backupRuns.backupId, backupId))
		.limit(1);

	if (!row) {
		throw new BackupError(
			"BACKUP_ANCHOR_FAILED",
			"Failed to create or read the backup run anchor",
		);
	}
	return row;
}

interface LatestEvent {
	id: string;
	attemptNo: number;
	status: "STARTED" | "COMPLETED" | "FAILED";
	objectKey: string | null;
	occurredAt: Date;
}

async function getLatestEvent(
	dbx: DatabaseOrTransaction,
	backupRunId: string,
): Promise<LatestEvent | undefined> {
	const [row] = await dbx
		.select({
			id: backupRunAttempts.id,
			attemptNo: backupRunAttempts.attemptNo,
			status: backupRunAttempts.status,
			objectKey: backupRunAttempts.objectKey,
			occurredAt: backupRunAttempts.occurredAt,
		})
		.from(backupRunAttempts)
		.where(eq(backupRunAttempts.backupRunId, backupRunId))
		.orderBy(desc(backupRunAttempts.attemptNo))
		.limit(1);
	return row as LatestEvent | undefined;
}

interface InsertEventRow {
	attemptNo: number;
	status: "STARTED" | "COMPLETED" | "FAILED";
	objectKey?: string | null;
	ciphertextSha256?: string | null;
	plaintextSizeBytes?: number | null;
	ciphertextSizeBytes?: number | null;
	safeErrorCode?: string | null;
}

async function insertEvent(
	dbx: DatabaseOrTransaction,
	backupRunId: string,
	row: InsertEventRow,
): Promise<{ id: string }> {
	const [inserted] = await dbx
		.insert(backupRunAttempts)
		.values({
			backupRunId,
			attemptNo: row.attemptNo,
			status: row.status,
			objectKey: row.objectKey ?? null,
			ciphertextSha256: row.ciphertextSha256 ?? null,
			plaintextSizeBytes: row.plaintextSizeBytes ?? null,
			ciphertextSizeBytes: row.ciphertextSizeBytes ?? null,
			safeErrorCode: row.safeErrorCode ?? null,
			occurredAt: new Date(),
		})
		.returning({ id: backupRunAttempts.id });

	if (!inserted) {
		throw new BackupError(
			"BACKUP_ANCHOR_FAILED",
			"Failed to insert a backup run event",
		);
	}
	return inserted;
}

type Reservation =
	| { kind: "completed"; anchorId: string; objectKey: string | null }
	| { kind: "in_progress"; anchorId: string }
	| { kind: "reserved"; anchorId: string; attemptNo: number; eventId: string }
	| { kind: "budget_exhausted"; anchorId: string; safeErrorCode: string };

/**
 * Phase 1: a short reservation transaction (no network I/O). Explicitly
 * locks the `backup_runs` anchor row FOR UPDATE BEFORE reading the latest
 * event or deciding anything -- without this, `getLatestEvent`'s read and
 * the subsequent `insertEvent` call are two separate unlocked statements,
 * and two truly concurrent invocations could both read the same "latest"
 * state (e.g. both see no events yet, or both see the same FAILED event) and
 * both attempt to insert the same next `attempt_no`; the loser would then
 * fail with a raw, unhandled unbranched-sequence exception from the trigger
 * instead of a graceful `in_progress`/`conflict` result. Acquiring the lock
 * FIRST serializes the read-decide-insert sequence: the second invocation's
 * lock acquisition blocks until the first transaction commits, and it then
 * re-reads the now-up-to-date latest event before deciding anything.
 *
 * Then decides what this invocation may do:
 *   - latest COMPLETED -> return the historical result, no reservation.
 *   - latest STARTED and not stale -> another invocation is live; return
 *     `in_progress`, no reservation.
 *   - latest STARTED and stale -> append a FAILED event for it
 *     (BACKUP_OUTCOME_UNKNOWN) and, if attempt budget remains, ALSO reserve
 *     a fresh STARTED event in the same transaction.
 *   - latest FAILED, or no events at all -> reserve a fresh STARTED event
 *     (subject to the attempt budget).
 */
async function reserveExecution(
	tx: DatabaseOrTransaction,
	userId: string,
	backupId: string,
	scheduledAt: Date,
): Promise<Reservation> {
	const anchor = await getOrCreateAnchorRun(tx, userId, backupId, scheduledAt);

	// Explicit lock BEFORE the decision read -- see doc comment above. Row
	// locks in Postgres are per-row regardless of which statement acquires
	// them, so this blocks a concurrent invocation until this transaction
	// commits or rolls back, exactly as the trigger's own internal
	// `FOR UPDATE` would for the INSERT alone -- the point here is extending
	// that same lock to cover the READ that precedes the INSERT decision.
	await tx.execute(
		sql`SELECT id FROM backup_runs WHERE id = ${anchor.id} FOR UPDATE`,
	);

	const latest = await getLatestEvent(tx, anchor.id);

	if (!latest) {
		const started = await insertEvent(tx, anchor.id, {
			attemptNo: 1,
			status: "STARTED",
		});
		return {
			kind: "reserved",
			anchorId: anchor.id,
			attemptNo: 1,
			eventId: started.id,
		};
	}

	if (latest.status === "COMPLETED") {
		return {
			kind: "completed",
			anchorId: anchor.id,
			objectKey: latest.objectKey,
		};
	}

	if (latest.status === "STARTED") {
		const isStale =
			Date.now() - latest.occurredAt.getTime() >= BACKUP_STARTED_STALE_AFTER_MS;
		if (!isStale) {
			return { kind: "in_progress", anchorId: anchor.id };
		}

		// Stale STARTED: resolve it as FAILED (outcome genuinely unknown -- see
		// the exactly-once doc comment on runDatabaseBackup), then attempt a
		// fresh reservation if budget remains.
		const failedNo = latest.attemptNo + 1;
		if (failedNo > BACKUP_MAX_EVENTS_PER_RUN) {
			// Should not happen in practice (a STARTED event implies at least one
			// more slot was available when it was inserted), but never let a
			// raw constraint violation escape.
			return {
				kind: "budget_exhausted",
				anchorId: anchor.id,
				safeErrorCode: "BACKUP_OUTCOME_UNKNOWN",
			};
		}
		await insertEvent(tx, anchor.id, {
			attemptNo: failedNo,
			status: "FAILED",
			safeErrorCode: "BACKUP_OUTCOME_UNKNOWN",
		});

		const startedNo = failedNo + 1;
		if (startedNo > BACKUP_MAX_EVENTS_PER_RUN) {
			return {
				kind: "budget_exhausted",
				anchorId: anchor.id,
				safeErrorCode: "BACKUP_OUTCOME_UNKNOWN",
			};
		}
		const started = await insertEvent(tx, anchor.id, {
			attemptNo: startedNo,
			status: "STARTED",
		});
		return {
			kind: "reserved",
			anchorId: anchor.id,
			attemptNo: startedNo,
			eventId: started.id,
		};
	}

	// latest.status === "FAILED": a fresh logical execution may be reserved.
	const startedNo = latest.attemptNo + 1;
	if (startedNo > BACKUP_MAX_EVENTS_PER_RUN) {
		return {
			kind: "budget_exhausted",
			anchorId: anchor.id,
			safeErrorCode: "BACKUP_ATTEMPT_BUDGET_EXHAUSTED",
		};
	}
	const started = await insertEvent(tx, anchor.id, {
		attemptNo: startedNo,
		status: "STARTED",
	});
	return {
		kind: "reserved",
		anchorId: anchor.id,
		attemptNo: startedNo,
		eventId: started.id,
	};
}

type Finalization = { kind: "ok" } | { kind: "conflict" };

/**
 * Phase 3: a short finalization transaction. Explicitly re-locks the same
 * `backup_runs` anchor row FOR UPDATE BEFORE reading the latest event --
 * mirroring exactly the same rationale/pattern as `reserveExecution`'s own
 * lock above: without it, `getLatestEvent`'s read here and the subsequent
 * `insertEvent` are two separate unlocked statements, and a concurrent
 * process (e.g. a new invocation running its own Phase 1 stale-recovery
 * logic against the same anchor) could interleave between them, causing this
 * finalization to act on a stale view of "latest event" or race the other
 * process's own insert. The INSERT trigger's own internal locking only
 * protects the INSERT itself -- too late to protect the READ that precedes
 * this finalization's conflict decision. Acquiring the lock FIRST serializes
 * the read-decide-insert sequence exactly as it does in `reserveExecution`.
 *
 * Only if the re-read latest event is EXACTLY the event this invocation
 * reserved in Phase 1 -- matched on `id`, `status === "STARTED"`, AND
 * `attemptNo` (an exact-match belt-and-suspenders check: `id` should already
 * be unique, but all three are checked defensively) -- does it append the
 * terminal COMPLETED/FAILED event. Otherwise returns `conflict` -- some
 * other process already resolved this reservation (structurally very rare
 * given the Phase 1 locking, but must still be checked defensively) -- and
 * the caller must NOT write a COMPLETED/FAILED row that could stomp on a
 * different execution's outcome.
 */
async function finalizeExecution(
	tx: DatabaseOrTransaction,
	reservation: { anchorId: string; attemptNo: number; eventId: string },
	terminal: Omit<InsertEventRow, "attemptNo">,
): Promise<Finalization> {
	// Explicit lock BEFORE the decision read -- see doc comment above.
	await tx.execute(
		sql`SELECT id FROM backup_runs WHERE id = ${reservation.anchorId} FOR UPDATE`,
	);

	const latest = await getLatestEvent(tx, reservation.anchorId);
	if (
		!latest ||
		latest.id !== reservation.eventId ||
		latest.status !== "STARTED" ||
		latest.attemptNo !== reservation.attemptNo
	) {
		return { kind: "conflict" };
	}
	await insertEvent(tx, reservation.anchorId, {
		...terminal,
		attemptNo: reservation.attemptNo + 1,
	});
	return { kind: "ok" };
}

/**
 * Runs (at most) one database backup execution end-to-end, in three phases:
 *
 *   Phase 1 (short reservation transaction, no network I/O): locks the
 *     `backup_runs` anchor row FOR UPDATE and decides, from the latest event
 *     for this run, whether this invocation may proceed. Only an invocation
 *     that commits a fresh STARTED event here proceeds to Phase 2 -- this is
 *     what prevents two concurrent/retried invocations for the same day from
 *     both redoing the snapshot/encrypt/upload against the same deterministic
 *     R2 object key.
 *   Phase 2 (no open DB transaction): snapshot (its own separate
 *     REPEATABLE READ READ ONLY transaction, opened only after Phase 1's
 *     transaction has committed and closed), encrypt, upload, and
 *     read-back-verify. Never holds a DB transaction open across this
 *     network work -- that is the core structural fix this phase makes.
 *   Phase 3 (short finalization transaction): re-locks the anchor row,
 *     confirms this invocation's reservation is still the latest event, and
 *     appends the terminal COMPLETED/FAILED event.
 *
 * IMPORTANT LIMIT: exactly-once semantics across a process CRASH combined
 * with an external R2 side effect (i.e. the crash happens after the R2
 * upload succeeds but before this process could reach Phase 3) is
 * fundamentally impossible to guarantee without a second durable
 * side-channel this system does not have -- a crashed invocation leaves its
 * STARTED event as the latest event indefinitely, resolved only by the
 * stale-STARTED policy (`BACKUP_STARTED_STALE_AFTER_MS`) the NEXT invocation
 * applies, which may itself re-upload to the same object key. What IS
 * guaranteed, and is the actual goal here, is eliminating duplicate
 * concurrent/retried uploads under NORMAL (non-crash) concurrent execution --
 * which this reservation+lock design achieves.
 */
export async function runDatabaseBackup(
	params: RunDatabaseBackupParams,
): Promise<BackupRunResult> {
	const { db, bucket, encryptionKey, keyId, scheduledAt } = params;

	const [user] = await db.select({ id: users.id }).from(users).limit(1);
	if (!user) {
		throw new BackupError(
			"BACKUP_ANCHOR_FAILED",
			"No user row exists to attribute the backup run to",
		);
	}

	const backupId = deriveBackupId(scheduledAt);

	const reservation = await db.transaction(async (tx) =>
		reserveExecution(tx, user.id, backupId, scheduledAt),
	);

	if (reservation.kind === "completed") {
		return {
			status: "COMPLETED",
			backupRunId: reservation.anchorId,
			backupId,
			objectKey: reservation.objectKey,
			safeErrorCode: null,
		};
	}
	if (reservation.kind === "in_progress") {
		return {
			status: "IN_PROGRESS",
			backupRunId: reservation.anchorId,
			backupId,
			objectKey: null,
			safeErrorCode: null,
		};
	}
	if (reservation.kind === "budget_exhausted") {
		return {
			status: "FAILED",
			backupRunId: reservation.anchorId,
			backupId,
			objectKey: null,
			safeErrorCode: reservation.safeErrorCode,
		};
	}

	// reservation.kind === "reserved" -- proceed to Phase 2. The object key is
	// derived ONLY NOW, from THIS execution's own reservation event id
	// (Section B) -- never before Phase 1 -- so it is execution-scoped and
	// cannot collide with any other logical execution's object, even for the
	// same day (see `deriveObjectKey`'s doc comment).
	const objectKey = deriveObjectKey(scheduledAt, backupId, reservation.eventId);
	let uploaded = false;
	try {
		const snapshot = await db.transaction(
			async (tx) => exportDatabaseSnapshot(tx),
			{ isolationLevel: "repeatable read", accessMode: "read only" },
		);

		const createdAt = new Date().toISOString();
		let buildResult: Awaited<ReturnType<typeof buildSnapshotPayload>>;
		try {
			buildResult = await buildSnapshotPayload({
				formatVersion: "V1",
				backupId,
				createdAt,
				tables: snapshot.tables,
				maxPlaintextBytes: params.maxPlaintextBytes,
			});
		} catch (err) {
			if (err instanceof BackupError && err.code === "BACKUP_TOO_LARGE") {
				throw err;
			}
			throw new BackupError(
				"BACKUP_SNAPSHOT_FAILED",
				"Failed to build the backup snapshot payload",
			);
		}

		let envelope: BackupEnvelope;
		try {
			envelope = await encryptBackupPayload({
				plaintext: buildResult.plaintextBytes,
				backupId,
				createdAt,
				key: encryptionKey,
				keyId,
			});
		} catch {
			throw new BackupError(
				"BACKUP_ENCRYPTION_FAILED",
				"Failed to encrypt the backup snapshot",
			);
		}

		const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

		try {
			await bucket.put(objectKey, envelopeBytes, {
				customMetadata: {
					formatVersion: envelope.formatVersion,
					backupId: envelope.backupId,
					createdAt: envelope.createdAt,
					ciphertextSha256: envelope.ciphertextSha256,
				},
			});
			uploaded = true;
		} catch {
			throw new BackupError(
				"BACKUP_UPLOAD_FAILED",
				"Failed to upload the encrypted backup to object storage",
			);
		}

		// Read back and verify the uploaded object before declaring success.
		try {
			const readBack = await bucket.get(objectKey);
			if (!readBack) {
				throw new BackupError(
					"BACKUP_VERIFICATION_FAILED",
					"Uploaded backup object could not be read back",
				);
			}
			const readBackBytes = new Uint8Array(await readBack.arrayBuffer());
			const readBackEnvelope = JSON.parse(
				new TextDecoder().decode(readBackBytes),
			) as BackupEnvelope;

			// Full comparison of ALL FOUR safe custom-metadata fields -- both the
			// re-parsed envelope body's own fields AND the R2 object's
			// customMetadata fields -- against the original locally-built
			// envelope. A single-field mismatch on ANY of these (not just the
			// ciphertext hash) fails verification: e.g. a fake/compromised R2
			// implementation could return the right bytes but wrong metadata.
			const safeFields: Array<
				keyof Pick<
					BackupEnvelope,
					"formatVersion" | "backupId" | "createdAt" | "ciphertextSha256"
				>
			> = ["formatVersion", "backupId", "createdAt", "ciphertextSha256"];
			for (const field of safeFields) {
				if (readBackEnvelope[field] !== envelope[field]) {
					throw new BackupError(
						"BACKUP_VERIFICATION_FAILED",
						`Uploaded backup object's re-parsed envelope field "${field}" does not match the expected value`,
					);
				}
				if (readBack.customMetadata?.[field] !== envelope[field]) {
					throw new BackupError(
						"BACKUP_VERIFICATION_FAILED",
						`Uploaded backup object's R2 custom metadata field "${field}" does not match the expected value`,
					);
				}
			}

			// Full cryptographic verification (decrypt + manifest check) as a
			// last-mile guarantee that the exact bytes written to R2 restore
			// correctly -- never trust the local pre-upload envelope alone.
			await verifyEncryptedBackupSummary(readBackEnvelope, encryptionKey);
		} catch (err) {
			if (err instanceof BackupError) throw err;
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				"Uploaded backup object failed post-upload verification",
			);
		}

		const finalized = await db.transaction(async (tx) =>
			finalizeExecution(tx, reservation, {
				status: "COMPLETED",
				objectKey,
				ciphertextSha256: envelope.ciphertextSha256,
				plaintextSizeBytes: buildResult.plaintextBytes.length,
				ciphertextSizeBytes: envelopeBytes.length,
			}),
		);

		if (finalized.kind === "conflict") {
			// Structurally very rare (see doc comment above). We already
			// uploaded successfully, but another process's view of this run's
			// latest event no longer matches our reservation -- do not write a
			// COMPLETED row that could stomp on a different outcome. Best-effort
			// clean up the object we just wrote, since it will not be recorded.
			// `objectKey` is execution-scoped (derived from THIS execution's own
			// reservation.eventId, Section B) -- it therefore cannot ever match
			// any other execution's object key, even one for the same day, so
			// this delete can never remove data belonging to another execution.
			try {
				await bucket.delete(objectKey);
			} catch {
				// ignored -- best effort only
			}
			return {
				status: "FAILED",
				backupRunId: reservation.anchorId,
				backupId,
				objectKey: null,
				safeErrorCode: "BACKUP_RESERVATION_CONFLICT",
			};
		}

		return {
			status: "COMPLETED",
			backupRunId: reservation.anchorId,
			backupId,
			objectKey,
			safeErrorCode: null,
		};
	} catch (err) {
		const safeErrorCode =
			err instanceof BackupError ? err.code : "BACKUP_SNAPSHOT_FAILED";

		if (uploaded) {
			// Best-effort cleanup of the exact key this run just wrote -- never
			// delete a key not constructed by this run, and never let a delete
			// failure mask the original failure. `objectKey` is execution-scoped
			// (Section B: derived from THIS execution's own reservation.eventId),
			// so it can never collide with, and therefore can never delete,
			// another execution's object even for the same calendar day. A
			// crash-orphaned upload (this process dies before reaching this
			// catch, or before Phase 3) is an ACCEPTED tradeoff -- it may remain
			// in R2 indefinitely for manual operator cleanup; correctness
			// (never deleting the wrong object) is prioritized over aggressive
			// deletion.
			try {
				await bucket.delete(objectKey);
			} catch {
				// ignored -- best effort only
			}
		}

		const finalized = await db.transaction(async (tx) =>
			finalizeExecution(tx, reservation, {
				status: "FAILED",
				safeErrorCode,
			}),
		);

		if (finalized.kind === "conflict") {
			return {
				status: "FAILED",
				backupRunId: reservation.anchorId,
				backupId,
				objectKey: null,
				safeErrorCode: "BACKUP_RESERVATION_CONFLICT",
			};
		}

		return {
			status: "FAILED",
			backupRunId: reservation.anchorId,
			backupId,
			objectKey: null,
			safeErrorCode,
		};
	}
}
