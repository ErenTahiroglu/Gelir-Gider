import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
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
 * Derives the R2 object key for a backup: `gelir-gider/v1/YYYY/MM/DD/<backupId>.ggbak`,
 * derived entirely from `scheduledAt` (UTC) and `backupId` -- never a user
 * name, email, financial value, or DB host.
 */
export function deriveObjectKey(scheduledAt: Date, backupId: string): string {
	const y = scheduledAt.getUTCFullYear().toString().padStart(4, "0");
	const m = (scheduledAt.getUTCMonth() + 1).toString().padStart(2, "0");
	const d = scheduledAt.getUTCDate().toString().padStart(2, "0");
	return `${BACKUP_OBJECT_KEY_PREFIX}/${y}/${m}/${d}/${backupId}.ggbak`;
}

export interface RunDatabaseBackupParams {
	db: Database;
	bucket: BackupBucket;
	encryptionKey: Uint8Array;
	keyId: string;
	scheduledAt: Date;
	maxPlaintextBytes?: number | undefined;
}

export interface BackupRunResult {
	status: "COMPLETED" | "FAILED";
	backupRunId: string;
	backupId: string;
	objectKey: string | null;
	safeErrorCode: string | null;
}

async function getOrCreateAnchorRun(
	db: Database,
	userId: string,
	backupId: string,
	scheduledAt: Date,
): Promise<{ id: string }> {
	await db
		.insert(backupRuns)
		.values({ userId, backupId, scheduledFor: scheduledAt })
		.onConflictDoNothing({ target: [backupRuns.userId, backupRuns.backupId] });

	const [row] = await db
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
	const anchor = await getOrCreateAnchorRun(db, user.id, backupId, scheduledAt);
	const objectKey = deriveObjectKey(scheduledAt, backupId);

	// If a COMPLETED attempt already exists for this run (e.g. a retried
	// cron invocation for a day already backed up), this is a no-op success.
	const existingCompleted = await db
		.select({
			id: backupRunAttempts.id,
			objectKey: backupRunAttempts.objectKey,
		})
		.from(backupRunAttempts)
		.where(eq(backupRunAttempts.backupRunId, anchor.id));
	const completed = existingCompleted.find((a) => a.objectKey !== null);
	if (completed) {
		return {
			status: "COMPLETED",
			backupRunId: anchor.id,
			backupId,
			objectKey: completed.objectKey,
			safeErrorCode: null,
		};
	}

	const nextAttemptNo = existingCompleted.length + 1;

	async function insertAttemptRow(row: {
		attemptNo: number;
		status: "STARTED" | "COMPLETED" | "FAILED";
		objectKey?: string | null;
		ciphertextSha256?: string | null;
		plaintextSizeBytes?: number | null;
		ciphertextSizeBytes?: number | null;
		safeErrorCode?: string | null;
	}): Promise<void> {
		await db.insert(backupRunAttempts).values({
			backupRunId: anchor.id,
			attemptNo: row.attemptNo,
			status: row.status,
			objectKey: row.objectKey ?? null,
			ciphertextSha256: row.ciphertextSha256 ?? null,
			plaintextSizeBytes: row.plaintextSizeBytes ?? null,
			ciphertextSizeBytes: row.ciphertextSizeBytes ?? null,
			safeErrorCode: row.safeErrorCode ?? null,
			occurredAt: new Date(),
		});
	}

	await insertAttemptRow({ attemptNo: nextAttemptNo, status: "STARTED" });

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
			if (
				readBackEnvelope.ciphertextSha256 !== envelope.ciphertextSha256 ||
				readBack.customMetadata?.ciphertextSha256 !== envelope.ciphertextSha256
			) {
				throw new BackupError(
					"BACKUP_VERIFICATION_FAILED",
					"Uploaded backup object does not match the expected ciphertext digest",
				);
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

		await insertAttemptRow({
			attemptNo: nextAttemptNo + 1,
			status: "COMPLETED",
			objectKey,
			ciphertextSha256: envelope.ciphertextSha256,
			plaintextSizeBytes: buildResult.plaintextBytes.length,
			ciphertextSizeBytes: envelopeBytes.length,
		});

		return {
			status: "COMPLETED",
			backupRunId: anchor.id,
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
			// failure mask the original failure.
			try {
				await bucket.delete(objectKey);
			} catch {
				// ignored -- best effort only
			}
		}

		await insertAttemptRow({
			attemptNo: nextAttemptNo + 1,
			status: "FAILED",
			safeErrorCode,
		});

		return {
			status: "FAILED",
			backupRunId: anchor.id,
			backupId,
			objectKey: null,
			safeErrorCode,
		};
	}
}
