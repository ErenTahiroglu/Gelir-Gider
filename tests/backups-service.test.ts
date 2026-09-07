import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BackupBucket,
	BackupBucketObjectBody,
} from "../src/backups/bucket";
import { computeTableContentHash } from "../src/backups/manifest";
import type { Database } from "../src/db/client";

vi.mock("../src/backups/export", async () => {
	const actual = await vi.importActual<typeof import("../src/backups/export")>(
		"../src/backups/export",
	);
	return {
		...actual,
		exportDatabaseSnapshot: vi.fn(),
	};
});

import { exportDatabaseSnapshot } from "../src/backups/export";
import { runDatabaseBackup } from "../src/backups/service";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const ENCRYPTION_KEY = new Uint8Array(32).fill(7);
const SCHEDULED_AT = new Date("2026-09-07T02:17:00.000Z");

// ============================================================================
// A queue-based fake Database, mirroring the call-order-based mocking
// pattern used in tests/campaigns-review-candidates.test.ts: each
// chain-terminating call resolves to the next queued response, in the exact
// order runDatabaseBackup's orchestration issues them (traced from source).
// ============================================================================

function createQueueDb(responses: unknown[][]): {
	db: Database;
	events: string[];
} {
	let i = 0;
	const events: string[] = [];

	function nextResponse(label: string): unknown[] {
		events.push(label);
		if (i >= responses.length) {
			throw new Error(`FakeDb: no queued response for call #${i} (${label})`);
		}
		const value = responses[i];
		i++;
		if (value === undefined)
			throw new Error(`FakeDb: queued response #${i - 1} was undefined`);
		return value;
	}

	function chain(label: string) {
		const obj = {
			from: () => obj,
			where: () => obj,
			limit: () => obj,
			values: () => obj,
			onConflictDoNothing: () => obj,
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable mock query builder
			then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
				try {
					resolve(nextResponse(label));
				} catch (err) {
					reject(err);
				}
			},
		};
		return obj;
	}

	const db = {
		select: () => chain("select"),
		insert: () => chain("insert"),
		transaction: vi.fn(async (work: (tx: unknown) => unknown) => work({})),
	} as unknown as Database;

	return { db, events };
}

class FakeBucket implements BackupBucket {
	store = new Map<
		string,
		{ bytes: Uint8Array; customMetadata?: Record<string, string> | undefined }
	>();
	calls: string[] = [];
	failPut = false;
	corruptOnGet = false;

	async put(
		key: string,
		value: Uint8Array,
		options?: { customMetadata?: Record<string, string> },
	) {
		this.calls.push(`put:${key}`);
		if (this.failPut) throw new Error("simulated R2 put failure");
		this.store.set(key, {
			bytes: value,
			customMetadata: options?.customMetadata,
		});
	}

	async get(key: string): Promise<BackupBucketObjectBody | null> {
		this.calls.push(`get:${key}`);
		const entry = this.store.get(key);
		if (!entry) return null;
		let bytes = entry.bytes;
		if (this.corruptOnGet) {
			bytes = new TextEncoder().encode(
				JSON.stringify({
					...JSON.parse(new TextDecoder().decode(entry.bytes)),
					ciphertextSha256: "f".repeat(64),
				}),
			);
		}
		return {
			key,
			size: bytes.length,
			uploaded: new Date(),
			customMetadata: entry.customMetadata,
			arrayBuffer: async () => bytes.buffer as ArrayBuffer,
		};
	}

	async head(key: string) {
		this.calls.push(`head:${key}`);
		const entry = this.store.get(key);
		if (!entry) return null;
		return {
			key,
			size: entry.bytes.length,
			uploaded: new Date(),
			customMetadata: entry.customMetadata,
		};
	}

	async delete(key: string) {
		this.calls.push(`delete:${key}`);
		this.store.delete(key);
	}

	async list() {
		return {
			objects: [...this.store.entries()].map(([key, v]) => ({
				key,
				size: v.bytes.length,
				uploaded: new Date(),
			})),
			truncated: false,
		};
	}
}

async function makeSmallSnapshot() {
	const { sortedRows, hash } = await computeTableContentHash([
		{ id: "u1", displayName: "Eren" },
	]);
	return {
		tables: [
			{
				tableName: "users",
				rowCount: 1,
				rows: sortedRows,
				tableContentHash: hash,
			},
		],
		plaintextSizeBytes: 100,
	};
}

beforeEach(() => {
	vi.mocked(exportDatabaseSnapshot).mockReset();
});

describe("runDatabaseBackup", () => {
	it("happy path: STARTED -> COMPLETED, uploads before completing, verifies readback", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);

		const { db } = createQueueDb([
			[{ id: USER_ID }], // select users
			[], // insert backupRuns onConflictDoNothing
			[{ id: RUN_ID }], // select backupRuns id
			[], // select existing attempts (none)
			[], // insert STARTED attempt
			[], // insert COMPLETED attempt
		]);
		const bucket = new FakeBucket();

		const result = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		expect(result.status).toBe("COMPLETED");
		expect(result.objectKey).toMatch(
			/^gelir-gider\/v1\/2026\/09\/07\/\d+\.ggbak$/,
		);

		// R2-first ordering: put must happen before the object is declared
		// COMPLETED (there is no direct signal from FakeBucket to the attempt
		// insert, but the object must exist in the store by the time
		// runDatabaseBackup returns COMPLETED).
		expect(bucket.calls[0]).toMatch(/^put:/);
		expect(bucket.store.size).toBe(1);
	});

	it("upload failure produces a FAILED result and never a COMPLETED attempt", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);

		const { db } = createQueueDb([
			[{ id: USER_ID }],
			[],
			[{ id: RUN_ID }],
			[],
			[],
			[],
		]);
		const bucket = new FakeBucket();
		bucket.failPut = true;

		const result = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_UPLOAD_FAILED");
		expect(result.objectKey).toBeNull();
		expect(bucket.store.size).toBe(0);
	});

	it("post-upload verification mismatch produces a FAILED result and best-effort deletes the object", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);

		const { db } = createQueueDb([
			[{ id: USER_ID }],
			[],
			[{ id: RUN_ID }],
			[],
			[],
			[],
		]);
		const bucket = new FakeBucket();
		bucket.corruptOnGet = true;

		const result = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_VERIFICATION_FAILED");
		// Best-effort cleanup: the object it just wrote should have been removed.
		expect(bucket.store.size).toBe(0);
	});

	it("throws a sanitized BACKUP_ANCHOR_FAILED-triggering path when no user row exists", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createQueueDb([[]]); // select users -> empty
		const bucket = new FakeBucket();

		await expect(
			runDatabaseBackup({
				db,
				bucket,
				encryptionKey: ENCRYPTION_KEY,
				keyId: "v1",
				scheduledAt: SCHEDULED_AT,
			}),
		).rejects.toMatchObject({ code: "BACKUP_ANCHOR_FAILED" });
	});
});
