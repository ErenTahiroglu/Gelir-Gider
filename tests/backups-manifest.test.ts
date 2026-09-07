import { describe, expect, it } from "vitest";
import { BackupError } from "../src/backups/errors";
import {
	buildManifest,
	computeTableContentHash,
	type TableSnapshot,
	verifySnapshotAgainstManifest,
} from "../src/backups/manifest";

describe("Backup manifest", () => {
	it("computes a stable content hash regardless of input row order", async () => {
		const rowsA = [
			{ id: "2", name: "b" },
			{ id: "1", name: "a" },
		];
		const rowsB = [
			{ id: "1", name: "a" },
			{ id: "2", name: "b" },
		];
		const resultA = await computeTableContentHash(rowsA);
		const resultB = await computeTableContentHash(rowsB);
		expect(resultA.hash).toBe(resultB.hash);
	});

	it("computes a stable content hash regardless of key order within a row", async () => {
		const rowsA = [{ id: "1", name: "a", amount: "10.00" }];
		const rowsB = [{ amount: "10.00", name: "a", id: "1" }];
		const resultA = await computeTableContentHash(rowsA);
		const resultB = await computeTableContentHash(rowsB);
		expect(resultA.hash).toBe(resultB.hash);
	});

	it("produces a different hash when row data changes", async () => {
		const a = await computeTableContentHash([{ id: "1", value: "10" }]);
		const b = await computeTableContentHash([{ id: "1", value: "11" }]);
		expect(a.hash).not.toBe(b.hash);
	});

	async function buildValidPayload() {
		const usersTable: TableSnapshot = {
			tableName: "users",
			rowCount: 1,
			...(await computeTableContentHash([
				{ id: "u1", displayName: "Eren" },
			]).then(({ sortedRows, hash }) => ({
				rows: sortedRows,
				tableContentHash: hash,
			}))),
		};
		const txTable: TableSnapshot = {
			tableName: "canonical_transactions",
			rowCount: 2,
			...(await computeTableContentHash([
				{ id: "t1", amount: "5.00" },
				{ id: "t2", amount: "7.50" },
			]).then(({ sortedRows, hash }) => ({
				rows: sortedRows,
				tableContentHash: hash,
			}))),
		};
		const tables = [usersTable, txTable];
		const manifest = await buildManifest({
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T02:17:00.000Z",
			tables,
		});
		return { manifest, tables };
	}

	it("verifies a correctly constructed snapshot payload against its own manifest without throwing", async () => {
		const { manifest, tables } = await buildValidPayload();
		await expect(
			verifySnapshotAgainstManifest({ manifest, tables }),
		).resolves.toBeUndefined();
	});

	it("detects a row-count mismatch between a table's rows and its manifest entry", async () => {
		const { manifest, tables } = await buildValidPayload();
		const tampered = tables.map((t) =>
			t.tableName === "canonical_transactions" ? { ...t, rowCount: 999 } : t,
		);
		await expect(
			verifySnapshotAgainstManifest({ manifest, tables: tampered }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("detects a content-hash mismatch when a row is silently altered after manifest build", async () => {
		const { manifest, tables } = await buildValidPayload();
		const tampered = tables.map((t) =>
			t.tableName === "canonical_transactions"
				? {
						...t,
						rows: [
							{ id: "t1", amount: "999.00" },
							{ id: "t2", amount: "7.50" },
						],
					}
				: t,
		);
		await expect(
			verifySnapshotAgainstManifest({ manifest, tables: tampered }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("detects an overall manifest hash mismatch", async () => {
		const { manifest, tables } = await buildValidPayload();
		const tamperedManifest = { ...manifest, manifestHash: "0".repeat(64) };
		await expect(
			verifySnapshotAgainstManifest({ manifest: tamperedManifest, tables }),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("detects a table present in the snapshot but absent from the manifest", async () => {
		const { manifest, tables } = await buildValidPayload();
		const { sortedRows, hash } = await computeTableContentHash([{ id: "x1" }]);
		const extendedTables = [
			...tables,
			{
				tableName: "extra_table",
				rowCount: 1,
				rows: sortedRows,
				tableContentHash: hash,
			},
		];
		await expect(
			verifySnapshotAgainstManifest({ manifest, tables: extendedTables }),
		).rejects.toBeInstanceOf(BackupError);
	});
});
