import { describe, expect, it } from "vitest";
import type { BackupBucket, BackupBucketObject } from "../src/backups/bucket";
import type { CompletedBackupObjectInput } from "../src/backups/retention";
import { runBackupRetention } from "../src/backups/retention";

class FakeBucket implements BackupBucket {
	objects = new Map<string, BackupBucketObject>();
	deleted: string[] = [];

	async put(
		key: string,
		value: Uint8Array,
		options?: { customMetadata?: Record<string, string> },
	) {
		this.objects.set(key, {
			key,
			size: value.length,
			uploaded: new Date(),
			customMetadata: options?.customMetadata,
		});
	}
	async get() {
		return null;
	}
	async head(key: string) {
		return this.objects.get(key) ?? null;
	}
	async delete(key: string) {
		this.deleted.push(key);
		this.objects.delete(key);
	}
	async list(options?: { prefix?: string }) {
		const objects = [...this.objects.values()].filter(
			(o) => !options?.prefix || o.key.startsWith(options.prefix),
		);
		return { objects, truncated: false };
	}
}

const CIPHERTEXT_SHA256 = "a".repeat(64);

/** Builds a well-shaped, execution-scoped object key: the new Phase 18-R2
 * Section B shape `<backupId (YYYYMMDD)>-<uuid>.ggbak`. */
function makeKey(index: number): string {
	const dd = ((index % 28) + 1).toString().padStart(2, "0");
	const mm = (1 + Math.floor(index / 28)).toString().padStart(2, "0");
	const uuid = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
	return `gelir-gider/v1/2026/${mm}/${dd}/2026${mm}${dd}-${uuid}.ggbak`;
}

/** Puts a well-shaped, DB-authoritatively-valid ("successful") backup object
 * into the bucket, and returns the matching `completedBackups` entry the
 * caller is expected to pass in alongside it. */
async function putSuccessfulObject(
	bucket: FakeBucket,
	index: number,
): Promise<CompletedBackupObjectInput> {
	const key = makeKey(index);
	await bucket.put(key, new Uint8Array([1]), {
		customMetadata: {
			formatVersion: "V1",
			ciphertextSha256: CIPHERTEXT_SHA256,
		},
	});
	return { objectKey: key, ciphertextSha256: CIPHERTEXT_SHA256 };
}

describe("runBackupRetention", () => {
	it("with 36 successful (DB-completed + R2-metadata-verified) objects, deletes the oldest 1 and keeps 35", async () => {
		const bucket = new FakeBucket();
		const completedBackups: CompletedBackupObjectInput[] = [];
		for (let i = 0; i < 36; i++) {
			completedBackups.push(await putSuccessfulObject(bucket, i));
		}

		const result = await runBackupRetention({
			bucket,
			keepCount: 35,
			completedBackups,
		});

		expect(result.status).toBe("COMPLETED");
		expect(result.deletedCount).toBe(1);
		expect(result.keptCount).toBe(35);
		expect(bucket.deleted).toHaveLength(1);
	});

	it("never deletes an object with an unrelated or malformed key shape, regardless of completedBackups", async () => {
		const bucket = new FakeBucket();
		const completedBackups: CompletedBackupObjectInput[] = [];
		for (let i = 0; i < 40; i++) {
			completedBackups.push(await putSuccessfulObject(bucket, i));
		}
		await bucket.put(
			"gelir-gider/v1/not-a-date/whatever.ggbak",
			new Uint8Array([1]),
		);
		await bucket.put(
			"gelir-gider/v1/2026/01/01/malformed-no-extension",
			new Uint8Array([1]),
		);
		await bucket.put("some-other-prefix/unrelated.txt", new Uint8Array([1]));

		const result = await runBackupRetention({
			bucket,
			keepCount: 35,
			completedBackups,
		});

		expect(bucket.deleted).not.toContain(
			"gelir-gider/v1/not-a-date/whatever.ggbak",
		);
		expect(bucket.deleted).not.toContain(
			"gelir-gider/v1/2026/01/01/malformed-no-extension",
		);
		expect(bucket.deleted).not.toContain("some-other-prefix/unrelated.txt");
		expect(result.skippedCount).toBe(2); // "some-other-prefix" isn't even listed (wrong prefix)
	});

	it("never deletes the currently-in-progress backup's own object key, even if it would otherwise be eligible", async () => {
		const bucket = new FakeBucket();
		const completedBackups: CompletedBackupObjectInput[] = [];
		for (let i = 0; i < 40; i++) {
			completedBackups.push(await putSuccessfulObject(bucket, i));
		}
		const oldestKey = completedBackups[0]?.objectKey as string;

		const result = await runBackupRetention({
			bucket,
			keepCount: 35,
			currentObjectKey: oldestKey,
			completedBackups,
		});

		expect(bucket.deleted).not.toContain(oldestKey);
		expect(result.status).toBe("COMPLETED");
	});

	it("reports a FAILED result (not an exception) when listing fails, and never touches objects", async () => {
		const bucket = new FakeBucket();
		bucket.list = async () => {
			throw new Error("simulated R2 outage");
		};

		const result = await runBackupRetention({ bucket, completedBackups: [] });
		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_RETENTION_FAILED");
	});

	// ==========================================================================
	// Section D (Phase 18-R2): retention must be DB-authoritative -- a
	// well-shaped object with no matching COMPLETED DB row, or with R2 metadata
	// that doesn't match what the DB recorded, is SKIPPED (never kept, never
	// deleted), regardless of how many of them exist or how they'd otherwise
	// sort.
	// ==========================================================================
	it("35 malformed/orphan objects (well-shaped keys, but no matching COMPLETED DB row) plus 10 successful: all 10 successful are retained, the 35 orphans are untouched", async () => {
		const bucket = new FakeBucket();
		const completedBackups: CompletedBackupObjectInput[] = [];

		// 35 orphaned uploads: well-shaped keys, R2 metadata even looks correct,
		// but NO corresponding COMPLETED backup_run_attempts row exists (e.g. a
		// crashed/lost-race execution per Section B).
		for (let i = 0; i < 35; i++) {
			const key = makeKey(i);
			await bucket.put(key, new Uint8Array([1]), {
				customMetadata: {
					formatVersion: "V1",
					ciphertextSha256: CIPHERTEXT_SHA256,
				},
			});
		}
		// 10 genuine successful backups.
		for (let i = 35; i < 45; i++) {
			completedBackups.push(await putSuccessfulObject(bucket, i));
		}

		const result = await runBackupRetention({
			bucket,
			keepCount: 35,
			completedBackups,
		});

		expect(result.status).toBe("COMPLETED");
		expect(result.keptCount).toBe(10);
		expect(result.deletedCount).toBe(0);
		expect(result.skippedCount).toBe(35);
		expect(bucket.deleted).toHaveLength(0);
		for (const { objectKey } of completedBackups) {
			expect(bucket.objects.has(objectKey)).toBe(true);
		}
	});

	it("a well-shaped object with NO matching COMPLETED DB row is never deleted, even when it would otherwise be the oldest of 36", async () => {
		const bucket = new FakeBucket();
		const completedBackups: CompletedBackupObjectInput[] = [];
		// Object 0 is an orphan (no DB row); objects 1-35 are genuine.
		const orphanKey = makeKey(0);
		await bucket.put(orphanKey, new Uint8Array([1]), {
			customMetadata: {
				formatVersion: "V1",
				ciphertextSha256: CIPHERTEXT_SHA256,
			},
		});
		for (let i = 1; i <= 35; i++) {
			completedBackups.push(await putSuccessfulObject(bucket, i));
		}

		const result = await runBackupRetention({
			bucket,
			keepCount: 35,
			completedBackups,
		});

		expect(bucket.deleted).not.toContain(orphanKey);
		expect(result.keptCount).toBe(35);
		expect(result.deletedCount).toBe(0);
		expect(result.skippedCount).toBe(1);
	});

	it("wrong formatVersion in R2 metadata (vs a COMPLETED DB row that does exist for the key) is never deleted", async () => {
		const bucket = new FakeBucket();
		const key = makeKey(0);
		await bucket.put(key, new Uint8Array([1]), {
			customMetadata: {
				formatVersion: "V9",
				ciphertextSha256: CIPHERTEXT_SHA256,
			},
		});
		const completedBackups: CompletedBackupObjectInput[] = [
			{ objectKey: key, ciphertextSha256: CIPHERTEXT_SHA256 },
		];

		const result = await runBackupRetention({
			bucket,
			keepCount: 0,
			completedBackups,
		});

		expect(bucket.deleted).not.toContain(key);
		expect(result.skippedCount).toBe(1);
		expect(result.deletedCount).toBe(0);
	});

	it("wrong ciphertextSha256 in R2 metadata (vs. what the DB recorded) is never deleted", async () => {
		const bucket = new FakeBucket();
		const key = makeKey(0);
		await bucket.put(key, new Uint8Array([1]), {
			customMetadata: { formatVersion: "V1", ciphertextSha256: "f".repeat(64) },
		});
		const completedBackups: CompletedBackupObjectInput[] = [
			{ objectKey: key, ciphertextSha256: CIPHERTEXT_SHA256 },
		];

		const result = await runBackupRetention({
			bucket,
			keepCount: 0,
			completedBackups,
		});

		expect(bucket.deleted).not.toContain(key);
		expect(result.skippedCount).toBe(1);
		expect(result.deletedCount).toBe(0);
	});
});
