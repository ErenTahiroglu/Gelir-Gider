import { describe, expect, it } from "vitest";
import type { BackupBucket, BackupBucketObject } from "../src/backups/bucket";
import { runBackupRetention } from "../src/backups/retention";

class FakeBucket implements BackupBucket {
	objects = new Map<string, BackupBucketObject>();
	deleted: string[] = [];

	async put(key: string, value: Uint8Array) {
		this.objects.set(key, { key, size: value.length, uploaded: new Date() });
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

describe("runBackupRetention", () => {
	it("with 36 well-formed successful objects, deletes the oldest 1 and keeps 35", async () => {
		const bucket = new FakeBucket();
		for (let i = 0; i < 36; i++) {
			// Not all valid calendar days for i > 27, but the shape regex only
			// requires \d{2}, so modulo to stay within 01-28 is sufficient here.
			const dd = ((i % 28) + 1).toString().padStart(2, "0");
			const mm = (1 + Math.floor(i / 28)).toString().padStart(2, "0");
			const key = `gelir-gider/v1/2026/${mm}/${dd}/2026${mm}${dd}run${i}.ggbak`;
			await bucket.put(key, new Uint8Array([1]));
			const stored = bucket.objects.get(key);
			if (stored) stored.uploaded = new Date(2026, 0, i + 1);
		}

		const result = await runBackupRetention({ bucket, keepCount: 35 });

		expect(result.status).toBe("COMPLETED");
		expect(result.deletedCount).toBe(1);
		expect(result.keptCount).toBe(35);
		expect(bucket.deleted).toHaveLength(1);
	});

	it("never deletes an object with an unrelated or malformed key shape", async () => {
		const bucket = new FakeBucket();
		for (let i = 0; i < 40; i++) {
			const dd = ((i % 28) + 1).toString().padStart(2, "0");
			const mm = (1 + Math.floor(i / 28)).toString().padStart(2, "0");
			await bucket.put(
				`gelir-gider/v1/2026/${mm}/${dd}/2026${mm}${dd}run${i}.ggbak`,
				new Uint8Array([1]),
			);
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

		const result = await runBackupRetention({ bucket, keepCount: 35 });

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
		const keys: string[] = [];
		for (let i = 0; i < 40; i++) {
			const dd = ((i % 28) + 1).toString().padStart(2, "0");
			const mm = (1 + Math.floor(i / 28)).toString().padStart(2, "0");
			const key = `gelir-gider/v1/2026/${mm}/${dd}/2026${mm}${dd}run${i}.ggbak`;
			keys.push(key);
			await bucket.put(key, new Uint8Array([1]));
		}
		// The oldest key (first inserted) would normally be evicted first once
		// there are more than `keepCount` objects.
		const oldestKey = keys[0] as string;

		const result = await runBackupRetention({
			bucket,
			keepCount: 35,
			currentObjectKey: oldestKey,
		});

		expect(bucket.deleted).not.toContain(oldestKey);
		expect(result.status).toBe("COMPLETED");
	});

	it("reports a FAILED result (not an exception) when listing fails, and never touches objects", async () => {
		const bucket = new FakeBucket();
		bucket.list = async () => {
			throw new Error("simulated R2 outage");
		};

		const result = await runBackupRetention({ bucket });
		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_RETENTION_FAILED");
	});
});
