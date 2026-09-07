import type { BackupBucket, BackupBucketObject } from "./bucket";
import { BACKUP_OBJECT_KEY_PREFIX } from "./service";

export const DEFAULT_BACKUP_RETENTION_KEEP_COUNT = 35;

/**
 * Matches the execution-scoped object key shape introduced in Phase 18-R2
 * Section B: `<backupId (YYYYMMDD)>-<reservationEventId (UUID)>.ggbak`. This
 * is used ONLY to extract a sort key (the embedded UTC date) for
 * already-DB-verified objects -- it is NOT, by itself, treated as proof an
 * object is a genuine backup (see `planBackupRetention`'s doc comment: that
 * authority now comes from `completedBackups`, a DB-sourced set of
 * `COMPLETED` `backup_run_attempts` rows).
 */
const OBJECT_KEY_PATTERN = new RegExp(
	`^${BACKUP_OBJECT_KEY_PREFIX}/(\\d{4})/(\\d{2})/(\\d{2})/\\d{8}-[0-9a-f-]{36}\\.ggbak$`,
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

export interface CompletedBackupObjectInput {
	objectKey: string;
	ciphertextSha256: string;
}

export interface RunBackupRetentionParams {
	bucket: BackupBucket;
	keepCount?: number;
	/**
	 * The object key of the backup currently in progress (if any). This
	 * exact key is NEVER deleted, regardless of how it sorts, since it may
	 * not be fully committed/verified yet. Kept as an explicit defense-in-depth
	 * exclusion even though, after Section D's DB-authoritative rework, it
	 * would also never be a deletion candidate on its own merits (an
	 * in-progress execution has no `COMPLETED` row yet).
	 */
	currentObjectKey?: string | null;
	/**
	 * DB-authoritative source of truth (Phase 18-R2 Section D): every
	 * `COMPLETED` `backup_run_attempts` row's `{objectKey, ciphertextSha256}`
	 * pair, queried by the caller (see
	 * `src/backups/service.ts`'s `listCompletedBackupObjects`) and passed in
	 * here so `retention.ts` itself never needs to import DB schema/query
	 * code directly and stays a pure R2-plus-input-data module.
	 */
	completedBackups: CompletedBackupObjectInput[];
}

export interface RetentionResult {
	status: "COMPLETED" | "FAILED";
	keptCount: number;
	deletedCount: number;
	skippedCount: number;
	safeErrorCode: string | null;
}

/**
 * Lists every object under the backup key prefix, filters to objects that
 * are AUTHORITATIVELY verified as a genuine successful backup, sorts them
 * newest-first by the UTC date embedded in the key, and returns the full
 * list plus which ones are eligible for deletion (i.e. beyond `keepCount`,
 * excluding `currentObjectKey`).
 *
 * An object is authoritative ONLY if ALL of the following hold:
 *   1. its key is correctly shaped (`OBJECT_KEY_PATTERN`);
 *   2. its exact key appears in `completedBackups` (a genuine `COMPLETED`
 *      `backup_run_attempts` row exists for it);
 *   3. its own R2 safe custom metadata confirms `formatVersion === "V1"` and
 *      `ciphertextSha256` matches the value the DB recorded for that key.
 *
 * Any object failing ANY of these is SKIPPED -- it counts toward NEITHER the
 * kept-N nor the deleted set; it is simply left untouched. This is what
 * prevents an orphaned upload from a crashed/lost-race execution (Section B),
 * or any malformed/corrupted object that happens to have a correctly-shaped
 * key, from ever counting toward the "keep latest N" rule or displacing a
 * genuinely successful older backup out of the keep-window.
 */
export function planBackupRetention(
	objects: BackupBucketObject[],
	keepCount: number,
	currentObjectKey: string | null | undefined,
	completedBackups: CompletedBackupObjectInput[],
): { kept: string[]; deleted: string[]; skipped: string[] } {
	const completedByKey = new Map(
		completedBackups.map((c) => [c.objectKey, c.ciphertextSha256]),
	);

	const skipped: string[] = [];
	const authoritative: { key: string; dateKey: string }[] = [];

	for (const obj of objects) {
		const dateKey = parseBackupObjectKeyDate(obj.key);
		if (dateKey === null) {
			skipped.push(obj.key);
			continue;
		}
		const expectedSha256 = completedByKey.get(obj.key);
		if (expectedSha256 === undefined) {
			// No matching COMPLETED DB row -- never touched by retention.
			skipped.push(obj.key);
			continue;
		}
		if (
			obj.customMetadata?.formatVersion !== "V1" ||
			obj.customMetadata?.ciphertextSha256 !== expectedSha256
		) {
			// R2 metadata doesn't match what the DB recorded -- never touched.
			skipped.push(obj.key);
			continue;
		}
		authoritative.push({ key: obj.key, dateKey });
	}

	// Newest-first: compare embedded date descending, tie-broken by key
	// descending (lexicographic, which is also chronological for the
	// zero-padded YYYYMMDD backupId embedded at the start of the key's final
	// path segment).
	authoritative.sort((a, b) => {
		if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
		return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
	});

	const kept: string[] = [];
	const deleted: string[] = [];
	for (const entry of authoritative) {
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
 * DB-authoritatively-verified (Section D) backup objects (plus, always, the
 * currently-in-progress backup's own key), deletes the rest. Never touches
 * anything outside the `gelir-gider/v1/` prefix, with an unrecognized key
 * shape, or without a matching genuine `COMPLETED` DB row + matching R2
 * metadata. A retention failure (list/delete error) is caught and returned
 * as a FAILED result -- it must NEVER cause a successfully completed backup
 * run to be marked failed or retried; callers must treat retention as fully
 * independent of backup success/failure.
 *
 * Relies on `bucket.list()` returning each object's `customMetadata` inline
 * (the real R2 adapter, `toBackupBucket` in `src/backups/bucket.ts`, passes
 * `include: ["customMetadata"]` to the underlying `R2Bucket.list()` call to
 * guarantee this) rather than issuing a separate `head()` call per
 * candidate object -- see that file's doc comment for the tradeoff.
 */
export async function runBackupRetention(
	params: RunBackupRetentionParams,
): Promise<RetentionResult> {
	const keepCount = params.keepCount ?? DEFAULT_BACKUP_RETENTION_KEEP_COUNT;

	try {
		const objects = await listAllBackupObjects(params.bucket);
		const { kept, deleted, skipped } = planBackupRetention(
			objects,
			keepCount,
			params.currentObjectKey,
			params.completedBackups,
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
