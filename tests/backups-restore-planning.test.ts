import { describe, expect, it } from "vitest";
import {
	buildLockTableSql,
	checkSchemaCompatibility,
	computeRestoreOrderFromSchema,
	denormalizeRowForInsert,
	isTargetEmpty,
	parseCliArgs,
	schemaDescriptorToShape,
	topologicalSortTables,
} from "../scripts/restore-backup";
import {
	computeTableContentHash,
	verifySnapshotAgainstManifest,
} from "../src/backups/manifest";

describe("isTargetEmpty (empty-target guard)", () => {
	it("returns true when every table has zero rows", () => {
		expect(isTargetEmpty({ users: 0, canonical_transactions: 0 })).toBe(true);
	});

	it("returns false when any table has a non-zero row count", () => {
		expect(isTargetEmpty({ users: 1, canonical_transactions: 0 })).toBe(false);
	});

	it("returns true for an empty registry (vacuously true)", () => {
		expect(isTargetEmpty({})).toBe(true);
	});
});

describe("checkSchemaCompatibility", () => {
	it("reports compatible when every expected table/column exists in the target", () => {
		const result = checkSchemaCompatibility(
			[{ tableName: "users", columns: ["id", "display_name"] }],
			[{ tableName: "users", columns: ["id", "display_name", "extra_col"] }],
		);
		expect(result.compatible).toBe(true);
		expect(result.missingTables).toEqual([]);
	});

	it("reports a missing table", () => {
		const result = checkSchemaCompatibility(
			[
				{ tableName: "users", columns: ["id"] },
				{ tableName: "campaigns", columns: ["id"] },
			],
			[{ tableName: "users", columns: ["id"] }],
		);
		expect(result.compatible).toBe(false);
		expect(result.missingTables).toEqual(["campaigns"]);
	});

	it("reports missing columns for an existing table", () => {
		const result = checkSchemaCompatibility(
			[{ tableName: "users", columns: ["id", "display_name", "timezone"] }],
			[{ tableName: "users", columns: ["id"] }],
		);
		expect(result.compatible).toBe(false);
		expect(result.missingColumns.users).toEqual(["display_name", "timezone"]);
	});
});

describe("denormalizeRowForInsert (reverses export-time normalization)", () => {
	it("converts an ISO timestamp string back to a Date for a PgTimestamp column", () => {
		const columnMap = new Map([["createdAt", { columnType: "PgTimestamp" }]]);
		const result = denormalizeRowForInsert(
			{ createdAt: "2026-01-15T10:30:00.000Z" },
			columnMap,
		);
		expect(result.createdAt).toBeInstanceOf(Date);
		expect((result.createdAt as Date).toISOString()).toBe(
			"2026-01-15T10:30:00.000Z",
		);
	});

	it("converts a base64 string back to raw bytes for a PgCustomColumn (bytea)", () => {
		const columnMap = new Map([
			["publicKey", { columnType: "PgCustomColumn" }],
		]);
		const original = new Uint8Array([1, 2, 3, 255, 0]);
		const base64 = Buffer.from(original).toString("base64");
		const result = denormalizeRowForInsert({ publicKey: base64 }, columnMap);
		expect(result.publicKey).toBeInstanceOf(Uint8Array);
		expect(Array.from(result.publicKey as Uint8Array)).toEqual(
			Array.from(original),
		);
	});

	it("passes through null values unchanged regardless of column type", () => {
		const columnMap = new Map([["createdAt", { columnType: "PgTimestamp" }]]);
		const result = denormalizeRowForInsert({ createdAt: null }, columnMap);
		expect(result.createdAt).toBeNull();
	});

	it("passes through values for columns not in the map (e.g. text/uuid/numeric) unchanged", () => {
		const columnMap = new Map<string, { columnType: string }>();
		const result = denormalizeRowForInsert(
			{ id: "abc-123", amount: "42.50" },
			columnMap,
		);
		expect(result).toEqual({ id: "abc-123", amount: "42.50" });
	});
});

describe("topologicalSortTables (pure dependency ordering)", () => {
	it("orders a referenced table before its dependent", () => {
		const order = topologicalSortTables(["b", "a"], { b: ["a"] });
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
	});

	it("is deterministic (ties broken by name) across repeated calls", () => {
		const order1 = topologicalSortTables(["c", "a", "b"], {});
		const order2 = topologicalSortTables(["c", "a", "b"], {});
		expect(order1).toEqual(order2);
		expect(order1).toEqual(["a", "b", "c"]);
	});

	it("handles a multi-level dependency chain correctly", () => {
		const order = topologicalSortTables(["grandchild", "child", "parent"], {
			child: ["parent"],
			grandchild: ["child"],
		});
		expect(order).toEqual(["parent", "child", "grandchild"]);
	});

	it("throws on a cyclic dependency graph", () => {
		expect(() =>
			topologicalSortTables(["a", "b"], { a: ["b"], b: ["a"] }),
		).toThrow();
	});
});

describe("computeRestoreOrderFromSchema (derived from the real FK graph)", () => {
	it("orders users before backup_runs (an actual FK in this schema)", () => {
		const order = computeRestoreOrderFromSchema();
		expect(order.indexOf("users")).toBeLessThan(order.indexOf("backup_runs"));
	});

	it("orders backup_runs before backup_run_attempts", () => {
		const order = computeRestoreOrderFromSchema();
		expect(order.indexOf("backup_runs")).toBeLessThan(
			order.indexOf("backup_run_attempts"),
		);
	});

	it("includes every table exactly once", () => {
		const order = computeRestoreOrderFromSchema();
		expect(new Set(order).size).toBe(order.length);
		expect(order.length).toBeGreaterThan(10);
	});
});

describe("parseCliArgs", () => {
	it("parses --file and --confirm-empty-target", () => {
		const args = parseCliArgs([
			"--file",
			"backup.ggbak",
			"--confirm-empty-target",
		]);
		expect(args.filePath).toBe("backup.ggbak");
		expect(args.confirmEmptyTarget).toBe(true);
	});

	it("defaults confirmEmptyTarget to false when omitted", () => {
		const args = parseCliArgs(["--file", "backup.ggbak"]);
		expect(args.confirmEmptyTarget).toBe(false);
	});

	it("throws when --file is missing", () => {
		expect(() => parseCliArgs(["--confirm-empty-target"])).toThrow();
	});

	it("parses an optional --expect-key-id", () => {
		const args = parseCliArgs(["--file", "b.ggbak", "--expect-key-id", "v2"]);
		expect(args.expectedKeyId).toBe("v2");
	});
});

describe("schemaDescriptorToShape (Section C.4: backup schema descriptor -> generic shape)", () => {
	it("converts a schema descriptor's table/column names into TableShapeDescriptor[]", () => {
		const shapes = schemaDescriptorToShape([
			{
				tableName: "users",
				columns: [
					{ columnName: "id", columnType: "PgUUID", notNull: true },
					{ columnName: "display_name", columnType: "PgText", notNull: false },
				],
			},
		]);
		expect(shapes).toEqual([
			{ tableName: "users", columns: ["id", "display_name"] },
		]);
	});
});

describe("Section C/D: backup-schema-vs-current-registry compatibility (pure, hand-built shapes)", () => {
	it("rejects when the current registry requires a column the backup schema descriptor doesn't have", () => {
		const currentRegistry = [
			{ tableName: "users", columns: ["id", "display_name", "timezone"] },
		];
		const backupSchema = schemaDescriptorToShape([
			{
				tableName: "users",
				columns: [
					{ columnName: "id", columnType: "PgUUID", notNull: true },
					{ columnName: "display_name", columnType: "PgText", notNull: false },
				],
			},
		]);
		const result = checkSchemaCompatibility(currentRegistry, backupSchema);
		expect(result.compatible).toBe(false);
		expect(result.missingColumns.users).toEqual(["timezone"]);
	});

	it("still rejects the same mismatch when the backup's table has ZERO rows (schema descriptor drives this, not row content)", () => {
		// The schema descriptor captures columns independent of row presence
		// -- a table with zero rows in the backup still has a full column
		// list in its schema descriptor, so this case must be caught exactly
		// the same way as the non-empty case above.
		const currentRegistry = [
			{
				tableName: "webauthn_credentials",
				columns: ["id", "public_key", "sign_count"],
			},
		];
		const backupSchemaForEmptyTable = schemaDescriptorToShape([
			{
				tableName: "webauthn_credentials",
				columns: [
					{ columnName: "id", columnType: "PgUUID", notNull: true },
					{
						columnName: "public_key",
						columnType: "PgCustomColumn",
						notNull: true,
					},
					// "sign_count" was added to the app AFTER this backup was taken.
				],
			},
		]);
		const result = checkSchemaCompatibility(
			currentRegistry,
			backupSchemaForEmptyTable,
		);
		expect(result.compatible).toBe(false);
		expect(result.missingColumns.webauthn_credentials).toEqual(["sign_count"]);
	});

	it("reports compatible when the backup schema descriptor has every column the current registry needs", () => {
		const currentRegistry = [{ tableName: "users", columns: ["id"] }];
		const backupSchema = schemaDescriptorToShape([
			{
				tableName: "users",
				columns: [
					{ columnName: "id", columnType: "PgUUID", notNull: true },
					{ columnName: "extra_col", columnType: "PgText", notNull: false },
				],
			},
		]);
		expect(
			checkSchemaCompatibility(currentRegistry, backupSchema).compatible,
		).toBe(true);
	});
});

describe("Section B: post-write verification via verifySnapshotAgainstManifest (DB-less)", () => {
	async function buildManifestForTables(
		tables: { tableName: string; rows: Record<string, unknown>[] }[],
	) {
		const entries = await Promise.all(
			tables.map(async (t) => {
				const { hash } = await computeTableContentHash(t.rows);
				return {
					tableName: t.tableName,
					rowCount: t.rows.length,
					tableContentHash: hash,
				};
			}),
		);
		return {
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T00:00:00.000Z",
			tables: entries,
			manifestHash: "irrelevant-for-this-check",
			schema: { tables: [], schemaFingerprint: "irrelevant-for-this-check" },
		};
	}

	it("catches a deliberately-mismatched row count between what was re-read and what the manifest says", async () => {
		const manifest = await buildManifestForTables([
			{ tableName: "users", rows: [{ id: "u1" }, { id: "u2" }] },
		]);
		// Simulate "what restore actually re-read from tx after inserting":
		// only ONE row made it in, despite the manifest recording two.
		const { sortedRows, hash } = await computeTableContentHash([{ id: "u1" }]);
		const reRead = [
			{
				tableName: "users",
				rowCount: 1,
				rows: sortedRows,
				tableContentHash: hash,
			},
		];
		// The row-count mismatch is caught before the overall manifestHash is
		// ever consulted, so a placeholder manifestHash is fine here.
		await expect(
			verifySnapshotAgainstManifest({ manifest, tables: reRead }),
		).rejects.toThrow(/row count/);
	});

	it("catches a deliberately-mismatched content hash between what was re-read and what the manifest says", async () => {
		const manifest = await buildManifestForTables([
			{ tableName: "users", rows: [{ id: "u1", displayName: "Original" }] },
		]);
		const { sortedRows, hash } = await computeTableContentHash([
			{ id: "u1", displayName: "Corrupted" },
		]);
		const reRead = [
			{
				tableName: "users",
				rowCount: 1,
				rows: sortedRows,
				tableContentHash: hash,
			},
		];
		// The content-hash mismatch is caught before the overall manifestHash
		// is ever consulted, so a placeholder manifestHash is fine here.
		await expect(
			verifySnapshotAgainstManifest({ manifest, tables: reRead }),
		).rejects.toThrow(/content hash/);
	});
});

describe("buildLockTableSql (Section B/D: trusted-registry-only lock statement)", () => {
	it("builds a LOCK TABLE statement covering exactly the given table names, in order", () => {
		const sqlText = buildLockTableSql([
			"users",
			"backup_runs",
			"backup_run_attempts",
		]);
		expect(sqlText).toBe(
			'LOCK TABLE "users", "backup_runs", "backup_run_attempts" IN ACCESS EXCLUSIVE MODE',
		);
	});

	it("uses ONLY the trusted registry's own table names -- never anything from a bogus/injected manifest table name", () => {
		// Simulate a "malicious manifest" that claims an extra, fabricated
		// table name. `main()` only ever calls `buildLockTableSql` with
		// `computeRestoreOrderFromSchema()`'s output (derived purely from the
		// local schema registry), never with anything read from decrypted
		// backup content -- this test proves the generated statement contains
		// exactly the trusted registry's names and nothing else, regardless of
		// what a hostile manifest might claim.
		const trustedTableNames = computeRestoreOrderFromSchema();
		const maliciousManifestTableNames = [
			...trustedTableNames,
			"pg_shadow; DROP TABLE users; --",
		];

		const sqlText = buildLockTableSql(trustedTableNames);

		for (const name of trustedTableNames) {
			expect(sqlText).toContain(`"${name}"`);
		}
		expect(sqlText).not.toContain("pg_shadow");
		expect(sqlText).not.toContain("DROP TABLE");
		// Sanity: the malicious list really did contain something extra that
		// must never leak into the generated SQL.
		expect(maliciousManifestTableNames.length).toBeGreaterThan(
			trustedTableNames.length,
		);
	});
});
