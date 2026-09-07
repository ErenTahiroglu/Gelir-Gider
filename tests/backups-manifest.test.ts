import { describe, expect, it } from "vitest";
import { BackupError } from "../src/backups/errors";
import {
	buildManifest,
	buildManifestSchema,
	computeTableContentHash,
	type SchemaTableDescriptor,
	type TableSnapshot,
	verifyManifestSchemaAgainstRegistry,
	verifySnapshotAgainstManifest,
} from "../src/backups/manifest";
import { getBackupTableDescriptors } from "../src/backups/registry";

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

describe("Backup manifest schema fingerprint (Phase 18-R1 Section C)", () => {
	it("builds a deterministic schema fingerprint across repeated calls with no schema change", async () => {
		const a = await buildManifestSchema();
		const b = await buildManifestSchema();
		expect(a.schemaFingerprint).toBe(b.schemaFingerprint);
		expect(a.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	it("sorts tables by tableName and columns by columnName", async () => {
		const schema = await buildManifestSchema();
		const tableNames = schema.tables.map((t) => t.tableName);
		expect(tableNames).toEqual([...tableNames].sort());
		for (const table of schema.tables) {
			const columnNames = table.columns.map((c) => c.columnName);
			expect(columnNames).toEqual([...columnNames].sort());
		}
	});

	it("enumerates every table in the real backup registry", async () => {
		const schema = await buildManifestSchema();
		const registryNames = getBackupTableDescriptors()
			.map((d) => d.tableName)
			.sort();
		expect(schema.tables.map((t) => t.tableName)).toEqual(registryNames);
	});

	it("buildManifest includes the schema descriptor", async () => {
		const { sortedRows, hash } = await computeTableContentHash([{ id: "u1" }]);
		const manifest = await buildManifest({
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T00:00:00.000Z",
			tables: [
				{
					tableName: "users",
					rowCount: 1,
					rows: sortedRows,
					tableContentHash: hash,
				},
			],
		});
		expect(manifest.schema.tables.length).toBeGreaterThan(0);
		expect(manifest.schema.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("verifyManifestSchemaAgainstRegistry (Phase 18-R1 Section C)", () => {
	async function buildValidSchemaPayload() {
		const schema = await buildManifestSchema();
		const tables = await Promise.all(
			schema.tables.map(async (t) => {
				const { sortedRows, hash } = await computeTableContentHash([]);
				return {
					tableName: t.tableName,
					rowCount: 0,
					rows: sortedRows,
					tableContentHash: hash,
				};
			}),
		);
		const manifest = {
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T00:00:00.000Z",
			tables: tables.map((t) => ({
				tableName: t.tableName,
				rowCount: t.rowCount,
				tableContentHash: t.tableContentHash,
			})),
			manifestHash: "irrelevant-for-this-check",
			schema,
		};
		return { manifest, tables };
	}

	it("accepts a correctly constructed schema descriptor without throwing", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		await expect(
			verifyManifestSchemaAgainstRegistry({ manifest, tables }),
		).resolves.toBeUndefined();
	});

	it("rejects a duplicate table name in the schema descriptor", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		const duplicated: SchemaTableDescriptor[] = [
			...manifest.schema.tables,
			manifest.schema.tables[0] as SchemaTableDescriptor,
		];
		await expect(
			verifyManifestSchemaAgainstRegistry({
				manifest: {
					...manifest,
					schema: { ...manifest.schema, tables: duplicated },
				},
				tables,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects a table in the schema descriptor absent from the current local registry (removed table)", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		const withUnexpectedTable: SchemaTableDescriptor[] = [
			...manifest.schema.tables,
			{
				tableName: "no_longer_exists",
				columns: [{ columnName: "id", columnType: "PgUUID", notNull: true }],
			},
		];
		const extendedTables = [
			...tables,
			{
				tableName: "no_longer_exists",
				rowCount: 0,
				rows: [],
				tableContentHash: (await computeTableContentHash([])).hash,
			},
		];
		await expect(
			verifyManifestSchemaAgainstRegistry({
				manifest: {
					...manifest,
					schema: { ...manifest.schema, tables: withUnexpectedTable },
				},
				tables: extendedTables,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects when the schema descriptor does not enumerate exactly the tables present in the row-data payload", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		// Drop one table from the schema descriptor while leaving it in the
		// row-data payload -- internal inconsistency.
		const trimmedSchemaTables = manifest.schema.tables.slice(1);
		await expect(
			verifyManifestSchemaAgainstRegistry({
				manifest: {
					...manifest,
					schema: { ...manifest.schema, tables: trimmedSchemaTables },
				},
				tables,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects a duplicate column name within one table's descriptor", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		const [first, ...rest] = manifest.schema.tables;
		const tampered: SchemaTableDescriptor[] = [
			{
				tableName: (first as SchemaTableDescriptor).tableName,
				columns: [
					...(first as SchemaTableDescriptor).columns,
					(first as SchemaTableDescriptor).columns[0] as {
						columnName: string;
						columnType: string;
						notNull: boolean;
					},
				],
			},
			...rest,
		];
		await expect(
			verifyManifestSchemaAgainstRegistry({
				manifest: {
					...manifest,
					schema: { ...manifest.schema, tables: tampered },
				},
				tables,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects a malformed column descriptor (missing columnType)", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		const [first, ...rest] = manifest.schema.tables;
		const tampered: SchemaTableDescriptor[] = [
			{
				tableName: (first as SchemaTableDescriptor).tableName,
				columns: [
					{ columnName: "bogus_column", notNull: true } as unknown as {
						columnName: string;
						columnType: string;
						notNull: boolean;
					},
				],
			},
			...rest,
		];
		await expect(
			verifyManifestSchemaAgainstRegistry({
				manifest: {
					...manifest,
					schema: { ...manifest.schema, tables: tampered },
				},
				tables,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});

	it("rejects a schemaFingerprint mismatch (recomputed vs stored)", async () => {
		const { manifest, tables } = await buildValidSchemaPayload();
		await expect(
			verifyManifestSchemaAgainstRegistry({
				manifest: {
					...manifest,
					schema: { ...manifest.schema, schemaFingerprint: "0".repeat(64) },
				},
				tables,
			}),
		).rejects.toBeInstanceOf(BackupError);
	});
});
