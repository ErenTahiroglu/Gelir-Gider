import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BackupBucket,
	BackupBucketObjectBody,
} from "../src/backups/bucket";
import { computeTableContentHash } from "../src/backups/manifest";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import { backupRunAttempts, backupRuns } from "../src/db/schema/backups";

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
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	BACKUP_MAX_EVENTS_PER_RUN,
	BACKUP_STARTED_STALE_AFTER_MS,
	runDatabaseBackup,
} from "../src/backups/service";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const ENCRYPTION_KEY = new Uint8Array(32).fill(7);
const SCHEDULED_AT = new Date("2026-09-07T02:17:00.000Z");

// ============================================================================
// A small, purpose-built in-memory fake `Database`. It does NOT attempt to
// generically interpret arbitrary Drizzle SQL (that would require
// reimplementing a query planner) -- it only needs to support the exact,
// known call shapes `src/backups/service.ts` issues: `select(...).from(t)`
// (optionally `.where(eq(col, val))`, `.orderBy(desc(col))`, `.limit(n)`) and
// `insert(t).values(row)` (optionally `.onConflictDoNothing(...)` or
// `.returning(cols)`). `where`'s `eq(...)` condition is decoded via
// Drizzle's own `SQL.queryChunks` (a `Param` chunk carries the value, a
// Column chunk carries the SQL column name), which is resilient to argument
// order and avoids hand-parsing SQL text.
// ============================================================================

interface FakeRow extends Record<string, unknown> {
	id: string;
}

function extractEqCondition(cond: unknown): {
	columnName: string;
	value: unknown;
} {
	const chunks = (cond as { queryChunks: unknown[] }).queryChunks;
	const param = chunks.find(
		(c) =>
			(c as { constructor: { name: string } })?.constructor?.name === "Param",
	) as { value: unknown } | undefined;
	const column = chunks.find(
		(c) =>
			c !== null &&
			typeof c === "object" &&
			"name" in (c as object) &&
			(c as { constructor: { name: string } }).constructor?.name !== "Param" &&
			(c as { constructor: { name: string } }).constructor?.name !==
				"StringChunk",
	) as { name: string } | undefined;
	if (!param || !column) {
		throw new Error("FakeDb: could not decode eq() condition");
	}
	return { columnName: column.name, value: param.value };
}

function columnJsKey(table: unknown, sqlColumnName: string): string {
	for (const [jsKey, col] of Object.entries(table as Record<string, unknown>)) {
		if (
			col &&
			typeof col === "object" &&
			(col as { name?: unknown }).name === sqlColumnName
		) {
			return jsKey;
		}
	}
	throw new Error(`FakeDb: unknown column "${sqlColumnName}"`);
}

interface FakeDbHandle {
	db: Database;
	runsRows: FakeRow[];
	attemptsRows: FakeRow[];
	usersRows: FakeRow[];
}

function createFakeDatabase(seedUserId: string): FakeDbHandle {
	const usersRows: FakeRow[] = [{ id: seedUserId }];
	const runsRows: FakeRow[] = [];
	const attemptsRows: FakeRow[] = [];
	let counter = 0;
	const genId = () => `gen-${++counter}`;

	function tableStore(table: unknown): FakeRow[] {
		if (table === users) return usersRows;
		if (table === backupRuns) return runsRows;
		if (table === backupRunAttempts) return attemptsRows;
		throw new Error("FakeDb: unrecognized table");
	}

	function makeDbx() {
		function select(_cols?: unknown) {
			let table: unknown;
			let rows: FakeRow[] = [];
			let limitN: number | undefined;
			const builder = {
				from(t: unknown) {
					table = t;
					rows = [...tableStore(t)];
					return builder;
				},
				where(cond: unknown) {
					const { columnName, value } = extractEqCondition(cond);
					const jsKey = columnJsKey(table, columnName);
					rows = rows.filter((r) => r[jsKey] === value);
					return builder;
				},
				orderBy(_col: unknown) {
					// Only ever used for `desc(backupRunAttempts.attemptNo)` in this
					// codebase.
					rows = [...rows].sort(
						(a, b) => (b.attemptNo as number) - (a.attemptNo as number),
					);
					return builder;
				},
				limit(n: number) {
					limitN = n;
					return builder;
				},
				// biome-ignore lint/suspicious/noThenProperty: intentional thenable mock query builder
				then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
					try {
						resolve(limitN !== undefined ? rows.slice(0, limitN) : rows);
					} catch (e) {
						reject(e);
					}
				},
			};
			return builder;
		}

		function insert(table: unknown) {
			let valuesToInsert: FakeRow | undefined;
			let conflictTarget: unknown;
			let returning = false;
			const builder = {
				values(v: Record<string, unknown>) {
					valuesToInsert = v as FakeRow;
					return builder;
				},
				onConflictDoNothing(_opts?: unknown) {
					conflictTarget = true;
					return builder;
				},
				returning(_cols?: unknown) {
					returning = true;
					return builder;
				},
				// biome-ignore lint/suspicious/noThenProperty: intentional thenable mock query builder
				then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
					try {
						const store = tableStore(table);
						if (conflictTarget && table === backupRuns) {
							const exists = store.some(
								(r) =>
									r.userId === valuesToInsert?.userId &&
									r.backupId === valuesToInsert?.backupId,
							);
							if (exists) {
								resolve([]);
								return;
							}
						}
						const row: FakeRow = { id: genId(), ...valuesToInsert };
						store.push(row);
						resolve(returning ? [{ id: row.id }] : [row]);
					} catch (e) {
						reject(e);
					}
				},
			};
			return builder;
		}

		// A no-op: this single-threaded fake never actually contends on the
		// lock, so the explicit `FOR UPDATE` lock statement `reserveExecution`
		// issues before its decision read has nothing to serialize against
		// here -- it only needs to not throw "unsupported operation".
		async function execute(_query: unknown) {
			return { rows: [] };
		}

		return { select, insert, execute };
	}

	const db = {
		...makeDbx(),
		transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
			work(makeDbx()),
		),
	} as unknown as Database;

	return { db, runsRows, attemptsRows, usersRows };
}

// ============================================================================
// FakeBucket (unchanged conventions from the pre-Phase-18-R1 test)
// ============================================================================

class FakeBucket implements BackupBucket {
	store = new Map<
		string,
		{ bytes: Uint8Array; customMetadata?: Record<string, string> | undefined }
	>();
	calls: string[] = [];
	failPut = false;
	corruptOnGet = false;
	corruptMetadataOnGet: Record<string, string> | null = null;

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
		let customMetadata = entry.customMetadata;
		if (this.corruptOnGet) {
			bytes = new TextEncoder().encode(
				JSON.stringify({
					...JSON.parse(new TextDecoder().decode(entry.bytes)),
					ciphertextSha256: "f".repeat(64),
				}),
			);
		}
		if (this.corruptMetadataOnGet) {
			customMetadata = { ...customMetadata, ...this.corruptMetadataOnGet };
		}
		return {
			key,
			size: bytes.length,
			uploaded: new Date(),
			customMetadata,
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

function createDeferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A FakeBucket whose `put` blocks until the test explicitly releases it,
 * used to simulate one invocation "pausing" mid-Phase-2 while a second
 * invocation runs concurrently against the same reservation state. */
class PausableFakeBucket extends FakeBucket {
	putStarted = createDeferred<void>();
	putGate = createDeferred<void>();

	override async put(
		key: string,
		value: Uint8Array,
		options?: { customMetadata?: Record<string, string> },
	) {
		this.calls.push(`put:${key}`);
		this.putStarted.resolve();
		await this.putGate.promise;
		this.store.set(key, {
			bytes: value,
			customMetadata: options?.customMetadata,
		});
		if (this.failPut) throw new Error("simulated R2 put failure");
	}
}

/** A FakeBucket whose `get` (the post-upload readback verification call,
 * which happens AFTER upload/before Phase 3 finalization) blocks until the
 * test explicitly releases it -- used to simulate one invocation "pausing"
 * between a successful upload and its own finalization, so a test can
 * directly manipulate the fake DB's row state in between (Section A). */
class PausableOnGetFakeBucket extends FakeBucket {
	getStarted = createDeferred<void>();
	getGate = createDeferred<void>();

	override async get(key: string): Promise<BackupBucketObjectBody | null> {
		this.getStarted.resolve();
		await this.getGate.promise;
		return super.get(key);
	}
}

/**
 * `buildManifestSchema()` (Phase 18-R1 Section C) enumerates the ENTIRE real
 * table registry, and `verifyManifestSchemaAgainstRegistry` requires the
 * snapshot payload's own table set to match it exactly. So this fixture
 * builds one (mostly empty) TableSnapshot per REAL registry table, with a
 * single row only for `users`, rather than a hand-picked subset.
 */
async function makeSmallSnapshot() {
	const descriptors = getBackupTableDescriptors();
	const tables = await Promise.all(
		descriptors.map(async (descriptor) => {
			if (descriptor.tableName === "users") {
				const { sortedRows, hash } = await computeTableContentHash([
					{ id: "u1", displayName: "Eren" },
				]);
				return {
					tableName: "users",
					rowCount: 1,
					rows: sortedRows,
					tableContentHash: hash,
				};
			}
			const { sortedRows, hash } = await computeTableContentHash([]);
			return {
				tableName: descriptor.tableName,
				rowCount: 0,
				rows: sortedRows,
				tableContentHash: hash,
			};
		}),
	);
	return { tables, plaintextSizeBytes: 100 };
}

beforeEach(() => {
	vi.mocked(exportDatabaseSnapshot).mockReset();
});

describe("runDatabaseBackup", () => {
	it("happy path: reserves STARTED -> COMPLETED, uploads before completing, verifies readback", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, attemptsRows } = createFakeDatabase(USER_ID);
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
			/^gelir-gider\/v1\/2026\/09\/07\/\d{8}-.+\.ggbak$/,
		);
		expect(bucket.calls[0]).toMatch(/^put:/);
		expect(bucket.store.size).toBe(1);
		expect(attemptsRows.map((a) => a.status)).toEqual(["STARTED", "COMPLETED"]);
	});

	it("upload failure produces a FAILED result and never a COMPLETED attempt", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, attemptsRows } = createFakeDatabase(USER_ID);
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
		expect(attemptsRows.map((a) => a.status)).toEqual(["STARTED", "FAILED"]);
	});

	it("post-upload verification mismatch (content hash) produces a FAILED result and best-effort deletes the object", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createFakeDatabase(USER_ID);
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
		expect(bucket.store.size).toBe(0);
	});

	it("post-upload verification mismatch (R2 custom metadata field) is caught even when the hash matches", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();
		bucket.corruptMetadataOnGet = { formatVersion: "V9" };

		const result = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_VERIFICATION_FAILED");
	});

	it("throws a sanitized BACKUP_ANCHOR_FAILED-triggering path when no user row exists", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, usersRows } = createFakeDatabase(USER_ID);
		usersRows.length = 0;
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

	it("a duplicate invocation after COMPLETED returns the historical result with ZERO uploads", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();

		const first = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(first.status).toBe("COMPLETED");
		expect(bucket.calls.filter((c) => c.startsWith("put:")).length).toBe(1);

		const second = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(second.status).toBe("COMPLETED");
		expect(second.objectKey).toBe(first.objectKey);
		// No additional uploads for the duplicate/retried invocation.
		expect(bucket.calls.filter((c) => c.startsWith("put:")).length).toBe(1);
	});

	it("a concurrent invocation while another is live gets IN_PROGRESS with ZERO uploads; the first still completes normally with exactly one upload", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createFakeDatabase(USER_ID);
		const bucket = new PausableFakeBucket();

		const pendingA = runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		// Wait until invocation A has reserved STARTED, run Phase 2 up through
		// calling bucket.put, and is now blocked inside it.
		await bucket.putStarted.promise;
		expect(bucket.calls.filter((c) => c.startsWith("put:")).length).toBe(1);

		const resultB = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(resultB.status).toBe("IN_PROGRESS");
		expect(resultB.objectKey).toBeNull();
		// B performed zero uploads.
		expect(bucket.calls.filter((c) => c.startsWith("put:")).length).toBe(1);

		bucket.putGate.resolve();
		const resultA = await pendingA;
		expect(resultA.status).toBe("COMPLETED");
		expect(bucket.calls.filter((c) => c.startsWith("put:")).length).toBe(1);
	});

	it("a FAILED execution allows the next invocation to reserve the next logical execution and reach COMPLETED", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, attemptsRows } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();
		bucket.failPut = true;

		const failed = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(failed.status).toBe("FAILED");

		bucket.failPut = false;
		const succeeded = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(succeeded.status).toBe("COMPLETED");
		expect(attemptsRows.map((a) => a.status)).toEqual([
			"STARTED",
			"FAILED",
			"STARTED",
			"COMPLETED",
		]);
	});

	it("two failed logical executions still allow a third execution to reach COMPLETED (bound raised to 10)", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, attemptsRows } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();
		bucket.failPut = true;

		await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(attemptsRows).toHaveLength(4); // STARTED,FAILED,STARTED,FAILED

		bucket.failPut = false;
		const third = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(third.status).toBe("COMPLETED");
		expect(attemptsRows).toHaveLength(6); // + STARTED,COMPLETED
	});

	it("a stale STARTED event resolves to BACKUP_OUTCOME_UNKNOWN and allows a bounded retry", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, runsRows, attemptsRows } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();

		// Seed a run with a STARTED event well past the staleness window,
		// simulating a crashed/abandoned prior invocation.
		const runId = "run-1";
		runsRows.push({
			id: runId,
			userId: USER_ID,
			backupId: "20260907",
			scheduledFor: SCHEDULED_AT,
		});
		attemptsRows.push({
			id: "att-1",
			backupRunId: runId,
			attemptNo: 1,
			status: "STARTED",
			objectKey: null,
			occurredAt: new Date(Date.now() - BACKUP_STARTED_STALE_AFTER_MS - 60_000),
		});

		const result = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		expect(result.status).toBe("COMPLETED");
		const statuses = attemptsRows.map((a) => a.status);
		expect(statuses).toEqual(["STARTED", "FAILED", "STARTED", "COMPLETED"]);
		const staleFailedEvent = attemptsRows.find((a) => a.attemptNo === 2);
		expect(staleFailedEvent?.safeErrorCode).toBe("BACKUP_OUTCOME_UNKNOWN");
	});

	it("exhausting the attempt budget produces a graceful FAILED result, never an unhandled exception", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, runsRows, attemptsRows } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();

		const runId = "run-budget";
		runsRows.push({
			id: runId,
			userId: USER_ID,
			backupId: "20260907",
			scheduledFor: SCHEDULED_AT,
		});
		// Seed exactly BACKUP_MAX_EVENTS_PER_RUN events: 5 logical executions,
		// each STARTED immediately FAILED, leaving zero budget for a 6th.
		for (let i = 0; i < BACKUP_MAX_EVENTS_PER_RUN; i += 2) {
			attemptsRows.push({
				id: `att-${i}`,
				backupRunId: runId,
				attemptNo: i + 1,
				status: "STARTED",
				objectKey: null,
				occurredAt: new Date(),
			});
			attemptsRows.push({
				id: `att-${i + 1}`,
				backupRunId: runId,
				attemptNo: i + 2,
				status: "FAILED",
				objectKey: null,
				occurredAt: new Date(),
				safeErrorCode: "BACKUP_UPLOAD_FAILED",
			});
		}
		expect(attemptsRows).toHaveLength(BACKUP_MAX_EVENTS_PER_RUN);

		const result = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBeTruthy();
		// No new reservation was made -- zero R2 work was ever attempted.
		expect(bucket.calls).toHaveLength(0);
		expect(attemptsRows).toHaveLength(BACKUP_MAX_EVENTS_PER_RUN);
	});

	// ==========================================================================
	// Section A (Phase 18-R2): finalizeExecution re-locks the SAME backup_runs
	// anchor row FOR UPDATE and re-checks id/status/attemptNo as an exact-match
	// triple before appending a terminal event. This fake DB is
	// single-threaded/sequential, so it cannot model REAL lock contention --
	// instead these tests directly control the ORDER of fake DB operations
	// (by pausing the invocation between its successful upload/readback and
	// its own Phase 3 finalization, then mutating the fake DB's row state as
	// if another process had already resolved the same reservation) to prove
	// the OUTCOME stays coherent: no raw/unhandled exception escapes the
	// service layer, and no wrong terminal event is ever recorded.
	// ==========================================================================
	it("Section A: a conflicting terminal event already recorded by the time finalization runs produces a graceful FAILED/conflict result, never an unhandled exception or a stomped event", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, attemptsRows } = createFakeDatabase(USER_ID);
		const bucket = new PausableOnGetFakeBucket();

		const pending = runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		// Wait until the invocation has reserved STARTED, uploaded successfully,
		// and is now blocked inside the post-upload readback (i.e. it is about
		// to enter Phase 3 finalization next).
		await bucket.getStarted.promise;
		expect(attemptsRows.map((a) => a.status)).toEqual(["STARTED"]);

		// Simulate a conflicting process having ALREADY appended a terminal
		// event for this exact reservation (attemptNo 1's STARTED event) in the
		// gap before this invocation's own finalization transaction runs --
		// this is exactly the class of race Section A's explicit FOR UPDATE
		// lock (plus the id/status/attemptNo triple-check) exists to detect and
		// handle gracefully, since the single-threaded fake cannot otherwise
		// model true concurrent lock contention.
		attemptsRows.push({
			id: "conflicting-terminal-event",
			backupRunId: attemptsRows[0]?.backupRunId as string,
			attemptNo: 2,
			status: "FAILED",
			objectKey: null,
			occurredAt: new Date(),
			safeErrorCode: "BACKUP_OUTCOME_UNKNOWN",
		});

		bucket.getGate.resolve();
		const result = await pending;

		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_RESERVATION_CONFLICT");
		// The conflicting event is untouched, and NO additional (stomping)
		// terminal event was appended by this invocation.
		expect(attemptsRows).toHaveLength(2);
		expect(attemptsRows[1]?.id).toBe("conflicting-terminal-event");
		expect(attemptsRows[1]?.status).toBe("FAILED");
		// Best-effort cleanup still ran against this invocation's OWN object
		// key -- never against anything else.
		expect(bucket.calls.some((c) => c.startsWith("delete:"))).toBe(true);
	});

	it("Section A: an attemptNo mismatch alone (id and status otherwise matching) is caught by the added defense-in-depth check", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db, attemptsRows } = createFakeDatabase(USER_ID);
		const bucket = new PausableOnGetFakeBucket();

		const pending = runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});

		await bucket.getStarted.promise;
		expect(attemptsRows).toHaveLength(1);

		// Tamper with the reserved event's own attemptNo in place (same id,
		// same STARTED status) -- an artificial stand-in for "attemptNo no
		// longer matches what was reserved", which `id`/`status` alone would
		// NOT catch. This proves the added `attemptNo` check in
		// `finalizeExecution` is actually load-bearing, not dead code.
		const reservedEvent = attemptsRows[0];
		if (reservedEvent) reservedEvent.attemptNo = 99;

		bucket.getGate.resolve();
		const result = await pending;

		expect(result.status).toBe("FAILED");
		expect(result.safeErrorCode).toBe("BACKUP_RESERVATION_CONFLICT");
		// No terminal event was appended on top of the tampered row.
		expect(attemptsRows).toHaveLength(1);
		expect(attemptsRows[0]?.status).toBe("STARTED");
	});

	// ==========================================================================
	// Section B (Phase 18-R2): the object key is now execution-scoped (derived
	// from the reservation's own event id), so two logical executions for the
	// SAME day never share an object key, and a cleanup delete in one
	// execution's failure path can never reference or match the other's key.
	// ==========================================================================
	it("Section B: two logical executions for the same day derive two DIFFERENT execution-scoped object keys", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();
		bucket.failPut = true;

		const first = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(first.status).toBe("FAILED");

		const second = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(second.status).toBe("FAILED");

		const putCalls = bucket.calls.filter((c) => c.startsWith("put:"));
		expect(putCalls).toHaveLength(2);
		const [firstKey, secondKey] = putCalls.map((c) => c.slice("put:".length));
		expect(firstKey).not.toBe(secondKey);
		// Both still belong to the same calendar day/backupId prefix.
		expect(firstKey).toMatch(/^gelir-gider\/v1\/2026\/09\/07\/20260907-/);
		expect(secondKey).toMatch(/^gelir-gider\/v1\/2026\/09\/07\/20260907-/);
	});

	it("Section B: a cleanup delete in one execution's failure path targets ONLY that execution's own execution-scoped key, never the other's", async () => {
		vi.mocked(exportDatabaseSnapshot).mockResolvedValue(
			await makeSmallSnapshot(),
		);
		const { db } = createFakeDatabase(USER_ID);
		const bucket = new FakeBucket();
		// Post-upload verification failure -- this path uploads successfully
		// (uploaded = true) and then deletes the exact key it just wrote.
		bucket.corruptOnGet = true;

		const first = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(first.status).toBe("FAILED");
		expect(first.safeErrorCode).toBe("BACKUP_VERIFICATION_FAILED");

		const second = await runDatabaseBackup({
			db,
			bucket,
			encryptionKey: ENCRYPTION_KEY,
			keyId: "v1",
			scheduledAt: SCHEDULED_AT,
		});
		expect(second.status).toBe("FAILED");
		expect(second.safeErrorCode).toBe("BACKUP_VERIFICATION_FAILED");

		const putKeys = bucket.calls
			.filter((c) => c.startsWith("put:"))
			.map((c) => c.slice("put:".length));
		const deleteKeys = bucket.calls
			.filter((c) => c.startsWith("delete:"))
			.map((c) => c.slice("delete:".length));

		expect(putKeys).toHaveLength(2);
		expect(deleteKeys).toHaveLength(2);
		expect(putKeys[0]).not.toBe(putKeys[1]);
		// Each execution's delete matches ONLY its own put key, never the
		// other's -- the exact guarantee execution-scoped keys provide.
		expect(deleteKeys[0]).toBe(putKeys[0]);
		expect(deleteKeys[1]).toBe(putKeys[1]);
		expect(deleteKeys[0]).not.toBe(putKeys[1]);
		expect(deleteKeys[1]).not.toBe(putKeys[0]);
	});
});
