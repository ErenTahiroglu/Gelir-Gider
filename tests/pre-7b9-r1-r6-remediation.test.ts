import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { BackupError } from "../src/backups/errors";
import {
	buildSnapshotPayload,
	calculateSimultaneousLiveMemoryUpperBound,
	DEFAULT_MAX_PLAINTEXT_BYTES,
	exportDatabaseSnapshot,
} from "../src/backups/export";
import { getBackupTableDescriptors } from "../src/backups/registry";
import type { DatabaseTransaction } from "../src/db/client";

describe("R1-R6.1 (B-01) Backup Worker Peak Live Memory Safety & Bound Model", () => {
	it("enforces default plaintext ceiling of 10 MiB", () => {
		expect(DEFAULT_MAX_PLAINTEXT_BYTES).toBe(10 * 1024 * 1024);
	});

	it("proves simultaneous live memory upper bound for 10 MiB is safely below 128 MB isolate budget", () => {
		const ceilingBytes = DEFAULT_MAX_PLAINTEXT_BYTES; // 10 MiB
		const bound = calculateSimultaneousLiveMemoryUpperBound(ceilingBytes, 7.5);

		// Peak simultaneous live memory: 10 MiB * 7.5 = 75 MiB = 78,643,200 bytes
		expect(bound.peakLiveBytes).toBe(75 * 1024 * 1024);
		expect(bound.peakLiveMegabytes).toBe(75);

		// Worker limit is 128 MB (134,217,728 bytes)
		expect(bound.workerMemoryLimitBytes).toBe(128 * 1024 * 1024);

		// Reserved safety headroom >= 48 MiB (>= 37.5% of total budget)
		expect(bound.safetyHeadroomBytes).toBeGreaterThanOrEqual(48 * 1024 * 1024);
		expect(bound.safetyHeadroomMegabytes).toBe(53);
		expect(bound.isSafeUnderLimit).toBe(true);
	});

	it("calculates deterministic simultaneous live bounds across various dataset sizes", () => {
		const sizes = [1, 5, 8, 10, 12, 16];
		for (const mib of sizes) {
			const bytes = mib * 1024 * 1024;
			const bound = calculateSimultaneousLiveMemoryUpperBound(bytes, 7.5);
			expect(bound.peakLiveBytes).toBe(bytes * 7.5);
			expect(bound.safetyHeadroomBytes).toBe(128 * 1024 * 1024 - bytes * 7.5);
			if (mib <= 16) {
				// 16 MiB * 7.5 = 120 MiB <= 128 MB
				expect(bound.isSafeUnderLimit).toBe(true);
			}
		}
	});

	it("early aborts chunked export queries as soon as size ceiling is exceeded, preventing later chunk/table queries", async () => {
		const registryDescriptors = getBackupTableDescriptors();
		expect(registryDescriptors.length).toBeGreaterThan(10);
		const firstName = registryDescriptors[0]?.tableName as string;

		let selectCount = 0;
		// Make a mock tx where each chunk is 6 MiB.
		// Chunk 1 = 6 MiB (cumulative 6 MiB < 10 MiB).
		// Chunk 2 = 6 MiB (cumulative 12 MiB > 10 MiB -> MUST ABORT HERE).
		// Chunk 3, Chunk 4, and other tables should never be queried.
		const chunk1 = Array.from({ length: 600 }, (_, i) => ({
			id: `c1-${String(i).padStart(4, "0")}`,
			data: "x".repeat(10240), // 10 KB per row -> 6 MB total
		}));
		const chunk2 = Array.from({ length: 600 }, (_, i) => ({
			id: `c2-${String(i).padStart(4, "0")}`,
			data: "y".repeat(10240), // 10 KB per row -> 6 MB total
		}));

		const mockTx = {
			select: () => ({
				from: (tbl: PgTable) => {
					selectCount++;
					const tName = getTableConfig(tbl).name;
					if (tName === firstName) {
						// Return chunk 1 on first call, chunk 2 on second call
						return {
							where: () => ({
								orderBy: () => ({
									limit: () => (selectCount === 1 ? chunk1 : chunk2),
								}),
							}),
							orderBy: () => ({
								limit: () => (selectCount === 1 ? chunk1 : chunk2),
							}),
						};
					}
					return {
						where: () => ({
							orderBy: () => ({
								limit: () => [],
							}),
						}),
						orderBy: () => ({
							limit: () => [],
						}),
					};
				},
			}),
		} as unknown as DatabaseTransaction;

		await expect(
			exportDatabaseSnapshot(mockTx, 10 * 1024 * 1024),
		).rejects.toThrow(BackupError);

		// It must have aborted immediately on the oversized chunk without querying remaining registry tables
		expect(selectCount).toBeLessThanOrEqual(3);
		expect(selectCount).toBeLessThan(registryDescriptors.length);
	});

	it("preserves exact determinism for identical database snapshots (same content hash and manifest)", async () => {
		const testRows = [
			{
				id: "row-1",
				amount: "100.50",
				category: "GROCERIES",
				date: "2026-09-01",
			},
			{
				id: "row-2",
				amount: "50.00",
				category: "TRANSPORT",
				date: "2026-09-02",
			},
		];

		const tables = [
			{
				tableName: "expenses",
				rowCount: testRows.length,
				rows: testRows,
				tableContentHash: "dummy-hash-1",
			},
		];

		const payload1 = await buildSnapshotPayload({
			formatVersion: "V1",
			backupId: "20260921-bk",
			createdAt: "2026-09-21T00:00:00.000Z",
			tables,
		});

		const payload2 = await buildSnapshotPayload({
			formatVersion: "V1",
			backupId: "20260921-bk",
			createdAt: "2026-09-21T00:00:00.000Z",
			tables,
		});

		expect(payload1.payload.manifest.manifestHash).toBe(
			payload2.payload.manifest.manifestHash,
		);
		expect(payload1.plaintextBytes).toEqual(payload2.plaintextBytes);
	});
});
