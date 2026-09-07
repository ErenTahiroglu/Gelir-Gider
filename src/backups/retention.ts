import type { BackupBucket, BackupBucketObject } from "./bucket";
import { BACKUP_OBJECT_KEY_PREFIX } from "./service";

export const DEFAULT_BACKUP_RETENTION_KEEP_COUNT = 35;

const OBJECT_KEY_PATTERN = new RegExp(
	`^${BACKUP_OBJECT_KEY_PREFIX}/(\\d{4})/(\\d{2})/(\\d{2})/[A-Za-z0-9_-]+\\.ggbak$`,
);

/**
 * Extracts the sort key (the UTC date embedded in the object key) for a
 * correctly-shaped backup object key. Returns `null` for anything that
 * doesn't match the expected shape -- those objects are NEVER touched by
 * retention, deliberately excluded from both the "keep" and "delete" sets.
 */
export function parseBackupObjectKeyDate(key: string): string | null {
	const match = OBJECT_KEY_PATTERN.exec(key);
	if (!match) return null;
	const [, y, m, d] = match;
	return `${y}-${m}-${d}`;
}

export interface RunBackupRetentionParams {
	bucket: BackupBucket;
	keepCount?: number;
	/**
	 * The object key of the backup currently in progress (if any). This
	 * exact key is NEVER deleted, regardless of how it sorts, since it may
	 * not be fully committed/verified yet.
	 */
	currentObjectKey?: string | null;
}

export interface RetentionResult {
	status: "COMPLETED" | "FAILED";
	keptCount: number;
	deletedCount: number;
	skippedCount: number;
	safeErrorCode: string | null;
}

/**
 * Lists every object under the backup key prefix, filters to
 * correctly-shaped keys, sorts them newest-first by the UTC date embedded in
 * the key, and returns the full list plus which ones are eligible for
 * deletion (i.e. beyond `keepCount`, excluding `currentObjectKey`).
 */
export async function planBackupRetention(
	objects: BackupBucketObject[],
	keepCount: number,
	currentObjectKey: string | null | undefined,
): Promise<{ kept: string[]; deleted: string[]; skipped: string[] }> {
	const skipped: string[] = [];
	const wellShaped: { key: string; dateKey: string }[] = [];

	for (const obj of objects) {
		const dateKey = parseBackupObjectKeyDate(obj.key);
		if (dateKey === null) {
			skipped.push(obj.key);
			continue;
		}
		wellShaped.push({ key: obj.key, dateKey });
	}

	// Newest-first: compare embedded date descending, tie-broken by key
	// descending (lexicographic, which is also chronological for the
	// zero-padded YYYYMMDD backupId embedded at the end of the key).
	wellShaped.sort((a, b) => {
		if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
		return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
	});

	const kept: string[] = [];
	const deleted: string[] = [];
	for (const entry of wellShaped) {
		const isCurrent =
			currentObjectKey != null && entry.key === currentObjectKey;
		if (isCurrent || kept.length < keepCount) {
			kept.push(entry.key);
		} else {
			deleted.push(entry.key);
		}
	}

	return { kept, deleted, skipped };
}

async function listAllBackupObjects(
	bucket: BackupBucket,
): Promise<BackupBucketObject[]> {
	const all: BackupBucketObject[] = [];
	let cursor: string | undefined;
	do {
		const listOptions: { prefix: string; cursor?: string } = {
			prefix: `${BACKUP_OBJECT_KEY_PREFIX}/`,
		};
		if (cursor !== undefined) listOptions.cursor = cursor;
		const page = await bucket.list(listOptions);
		all.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return all;
}

/**
 * Applies backup retention: keeps the most recent `keepCount`
 * correctly-shaped backup objects (plus, always, the currently-in-progress
 * backup's own key), deletes the rest. Never touches anything outside the
 * `gelir-gider/v1/` prefix or with an unrecognized key shape. A retention
 * failure (list/delete error) is caught and returned as a FAILED result --
 * it must NEVER cause a successfully completed backup run to be marked
 * failed or retried; callers must treat retention as fully independent of
 * backup success/failure.
 */
export async function runBackupRetention(
	params: RunBackupRetentionParams,
): Promise<RetentionResult> {
	const keepCount = params.keepCount ?? DEFAULT_BACKUP_RETENTION_KEEP_COUNT;

	try {
		const objects = await listAllBackupObjects(params.bucket);
		const { kept, deleted, skipped } = await planBackupRetention(
			objects,
			keepCount,
			params.currentObjectKey,
		);

		for (const key of deleted) {
			await params.bucket.delete(key);
		}

		return {
			status: "COMPLETED",
			keptCount: kept.length,
			deletedCount: deleted.length,
			skippedCount: skipped.length,
			safeErrorCode: null,
		};
	} catch {
		return {
			status: "FAILED",
			keptCount: 0,
			deletedCount: 0,
			skippedCount: 0,
			safeErrorCode: "BACKUP_RETENTION_FAILED",
		};
	}
}
