#!/usr/bin/env -S npx tsx
/// <reference types="node" />
/**
 * Standalone restore tool for encrypted database backups produced by
 * `src/backups/service.ts`. Run with:
 *
 *   BACKUP_ENCRYPTION_KEY=<base64url> DATABASE_URL=<postgres-url> \
 *     npx tsx scripts/restore-backup.ts --file path/to/backup.ggbak --confirm-empty-target
 *
 * This is the FIRST script under `scripts/` in this repo -- plain
 * `process.argv` parsing, no new CLI-framework dependency, matching the
 * existing conventions used for one-off verification scripts elsewhere in
 * this engagement.
 *
 * `BACKUP_ENCRYPTION_KEY`/`DATABASE_URL` are read directly from
 * `process.env`, supplied by the operator's own shell -- this is the
 * normal, correct way for a standalone Node script to receive secrets (this
 * is NOT the same situation as an interactive session secretly sourcing
 * `.dev.vars`; the operator running this script controls their own
 * environment).
 *
 * The script refuses to mutate anything unless BOTH:
 *   1. `--confirm-empty-target` is passed, AND
 *   2. an independent live check confirms the target database has zero
 *      rows in EVERY table the backup registry covers.
 *
 * Restore happens inside ONE transaction, in a deterministic
 * dependency-respecting table order (see `computeRestoreOrder` below,
 * derived from the actual FK graph declared in `src/db/schema/*.ts`), and
 * is verified against the backup's manifest (row counts + content hashes)
 * BEFORE commit. Any mismatch rolls back.
 */
import { Column, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";
import { getBackupEncryptionKey } from "../src/config/env";
import { createDatabase } from "../src/db/client";
import type { BackupEnvelope } from "../src/backups/crypto";
import { envelopeKeyIdMatches } from "../src/backups/crypto";
import { decryptAndParseBackup } from "../src/backups/verify";
import { exportDatabaseSnapshot } from "../src/backups/export";
import type {
	BackupSnapshotPayload,
	SchemaTableDescriptor,
} from "../src/backups/manifest";
import { verifySnapshotAgainstManifest } from "../src/backups/manifest";

// ============================================================================
// Pure, DB-less logic (unit tested in tests/backups-restore-planning.test.ts)
// ============================================================================

export interface CliArgs {
	filePath: string;
	confirmEmptyTarget: boolean;
	expectedKeyId?: string | undefined;
}

export function parseCliArgs(argv: string[]): CliArgs {
	let filePath: string | undefined;
	let confirmEmptyTarget = false;
	let expectedKeyId: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--file") {
			filePath = argv[++i];
		} else if (arg === "--confirm-empty-target") {
			confirmEmptyTarget = true;
		} else if (arg === "--expect-key-id") {
			expectedKeyId = argv[++i];
		}
	}

	if (!filePath) {
		throw new Error("Missing required argument: --file <path-to-.ggbak-file>");
	}

	return { filePath, confirmEmptyTarget, expectedKeyId };
}

/**
 * The empty-target guard, extracted as a small pure predicate: `rowCounts`
 * maps table name -> live row count in the target database, covering EVERY
 * table in the backup registry. Returns `true` only if every count is
 * exactly zero.
 */
export function isTargetEmpty(rowCounts: Record<string, number>): boolean {
	return Object.values(rowCounts).every((count) => count === 0);
}

export interface TableShapeDescriptor {
	tableName: string;
	columns: string[];
}

export interface SchemaCompatibilityResult {
	compatible: boolean;
	missingTables: string[];
	missingColumns: Record<string, string[]>;
}

/**
 * Pure schema-compatibility check over two shape descriptors: for every
 * table the backup registry expects, the target database must have that
 * table with (at least) every expected column present. Extra tables/columns
 * in the target are fine.
 */
export function checkSchemaCompatibility(
	expected: TableShapeDescriptor[],
	actual: TableShapeDescriptor[],
): SchemaCompatibilityResult {
	const actualByName = new Map(actual.map((t) => [t.tableName, new Set(t.columns)]));
	const missingTables: string[] = [];
	const missingColumns: Record<string, string[]> = {};

	for (const table of expected) {
		const actualColumns = actualByName.get(table.tableName);
		if (!actualColumns) {
			missingTables.push(table.tableName);
			continue;
		}
		const missing = table.columns.filter((col) => !actualColumns.has(col));
		if (missing.length > 0) {
			missingColumns[table.tableName] = missing;
		}
	}

	return {
		compatible: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
		missingTables,
		missingColumns,
	};
}

/**
 * Converts a backup's decrypted schema descriptor (Phase 18-R1 Section C)
 * into the generic `TableShapeDescriptor[]` shape `checkSchemaCompatibility`
 * already accepts, so the "was this backup produced by a schema compatible
 * with what this codebase currently expects?" check (Section C.4) reuses
 * that existing pure comparison function directly instead of a parallel one.
 */
export function schemaDescriptorToShape(
	tables: SchemaTableDescriptor[],
): TableShapeDescriptor[] {
	return tables.map((table) => ({
		tableName: table.tableName,
		columns: table.columns.map((c) => c.columnName),
	}));
}

/**
 * Builds a deterministic `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` statement
 * covering every given table name, in the exact order given (the caller must
 * pass a fixed, deterministic order -- the same topological order already
 * computed for the restore itself -- to avoid any lock-ordering deadlock
 * risk). CRITICAL: `tableNames` must come ONLY from the trusted local schema
 * registry (`getBackupTableDescriptors()`/`getTableConfig(table).name`),
 * NEVER from the untrusted decrypted backup content itself, even though in
 * practice they should match. This function itself is agnostic to where its
 * input came from -- the caller (`main()` below) is what enforces that
 * constraint by only ever calling it with `computeRestoreOrderFromSchema()`'s
 * output.
 */
export function buildLockTableSql(tableNames: string[]): string {
	const quoted = tableNames.map((name) => `"${name}"`).join(", ");
	return `LOCK TABLE ${quoted} IN ACCESS EXCLUSIVE MODE`;
}

/**
 * A minimal structural view of a Drizzle `Column` used for
 * denormalization decisions: only the `columnType` discriminator matters
 * ("PgTimestamp" for `mode: "date"` timestamp columns, "PgCustomColumn"
 * for the hand-rolled `bytea` custom type used by
 * `webauthn_credentials.public_key`).
 */
export interface ColumnTypeDescriptor {
	columnType: string;
}

/**
 * Reverses the export-time normalization (`normalizeCellValue` in
 * `src/backups/export.ts`) column-by-column, using each column's actual
 * Drizzle type: an ISO string stored under a `PgTimestamp` column becomes a
 * `Date` again (Drizzle's timestamp `mode: "date"` driver mapping calls
 * `.toISOString()` on whatever it's given, which throws for a plain
 * string), and a base64 string stored under a `PgCustomColumn` (the
 * `bytea` custom type has no built-in encode/decode, so it passes values
 * through as-is) becomes raw bytes again. Every other column type's
 * normalized JSON representation (numeric strings, UUID strings, JSONB,
 * plain booleans/numbers, null) is already exactly what Drizzle's insert
 * path expects, so it passes through unchanged.
 *
 * Without this step, restoring `webauthn_credentials` would silently
 * corrupt every stored public key (a base64 STRING would be written into a
 * `bytea` column, not the bytes it represents), and restoring any table
 * with a timestamp column would throw during insert.
 */
export function denormalizeRowForInsert(
	row: Record<string, unknown>,
	columnMap: Map<string, ColumnTypeDescriptor>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		const column = columnMap.get(key);
		if (value !== null && column) {
			if (column.columnType === "PgTimestamp" && typeof value === "string") {
				result[key] = new Date(value);
				continue;
			}
			if (column.columnType === "PgCustomColumn" && typeof value === "string") {
				result[key] = new Uint8Array(Buffer.from(value, "base64"));
				continue;
			}
		}
		result[key] = value;
	}
	return result;
}

/**
 * Maps each JS field name of a Drizzle table object (e.g. `publicKey`) to
 * its `Column` instance, by introspecting the table object's own
 * properties -- `getTableConfig` exposes columns only as an array keyed by
 * SQL name, not the JS property name that `tx.select().from(table)` rows
 * are actually keyed by.
 */
export function getColumnMap(table: PgTable): Map<string, Column> {
	const map = new Map<string, Column>();
	for (const [key, value] of Object.entries(
		table as unknown as Record<string, unknown>,
	)) {
		if (is(value, Column)) {
			map.set(key, value);
		}
	}
	return map;
}

/**
 * Kahn's-algorithm topological sort: `dependencies[table]` lists tables
 * that MUST be restored before `table` (i.e. tables `table` has a foreign
 * key referencing). Ties are broken by table name for a fully deterministic
 * result. Throws if the dependency graph contains a cycle (should never
 * happen for this schema -- a defensive check, not an expected path).
 */
export function topologicalSortTables(
	tableNames: string[],
	dependencies: Record<string, string[]>,
): string[] {
	const remaining = new Set(tableNames);
	const result: string[] = [];

	const dependsOn = (table: string): string[] =>
		(dependencies[table] ?? []).filter((dep) => remaining.has(dep));

	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter((table) => dependsOn(table).length === 0)
			.sort();
		if (ready.length === 0) {
			throw new Error(
				`Cycle detected in table dependency graph among: ${[...remaining].sort().join(", ")}`,
			);
		}
		for (const table of ready) {
			result.push(table);
			remaining.delete(table);
		}
	}

	return result;
}

/**
 * Builds the dependency graph from the ACTUAL Drizzle schema's foreign
 * keys: for each table, the set of tables it references (which must be
 * restored first), then topologically sorts. This is what
 * `computeRestoreOrder` uses in production; `topologicalSortTables` above
 * is independently unit-testable with a hand-built graph.
 */
export function computeRestoreOrderFromSchema(): string[] {
	const tables: PgTable[] = [];
	for (const value of Object.values(schema)) {
		if (is(value, PgTable)) tables.push(value);
	}

	const tableNames = tables.map((t) => getTableConfig(t).name);
	const dependencies: Record<string, string[]> = {};

	for (const table of tables) {
		const config = getTableConfig(table);
		const deps = new Set<string>();
		for (const fk of config.foreignKeys) {
			const referencedTable = fk.reference().foreignTable;
			const referencedName = getTableConfig(referencedTable as PgTable).name;
			if (referencedName !== config.name) {
				deps.add(referencedName);
			}
		}
		dependencies[config.name] = [...deps];
	}

	return topologicalSortTables(tableNames, dependencies);
}

// ============================================================================
// DB-touching restore flow -- never executed by tests, only by direct
// invocation of this script.
// ============================================================================

async function countRowsPerTable(
	// biome-ignore lint/suspicious/noExplicitAny: dynamically typed Database
	db: any,
	descriptors: { tableName: string; table: PgTable }[],
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const descriptor of descriptors) {
		const rows = await db.select().from(descriptor.table);
		counts[descriptor.tableName] = rows.length;
	}
	return counts;
}

/**
 * Queries `information_schema.columns` for the ACTUAL live shape of every
 * expected table in the target database. This is the one live-DB-dependent
 * half of `checkSchemaCompatibility` (the function itself stays pure and
 * unit-testable over two already-resolved shape descriptors).
 */
async function fetchActualShapes(
	// biome-ignore lint/suspicious/noExplicitAny: dynamically typed Database
	db: any,
	tableNames: string[],
): Promise<TableShapeDescriptor[]> {
	const result = await db.execute(sql`
		SELECT table_name, column_name
		FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = ANY(${tableNames})
	`);
	const rows: { table_name: string; column_name: string }[] =
		result.rows ?? result;
	const columnsByTable = new Map<string, string[]>();
	for (const row of rows) {
		const existing = columnsByTable.get(row.table_name) ?? [];
		existing.push(row.column_name);
		columnsByTable.set(row.table_name, existing);
	}
	return tableNames.map((tableName) => ({
		tableName,
		columns: columnsByTable.get(tableName) ?? [],
	}));
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));

	const rawKey = process.env.BACKUP_ENCRYPTION_KEY;
	if (!rawKey) {
		console.error("BACKUP_ENCRYPTION_KEY environment variable is required");
		process.exitCode = 1;
		return;
	}
	const encryptionKey = getBackupEncryptionKey({ BACKUP_ENCRYPTION_KEY: rawKey });

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error("DATABASE_URL environment variable is required");
		process.exitCode = 1;
		return;
	}

	if (!args.confirmEmptyTarget) {
		console.error(
			"Refusing to run without --confirm-empty-target. This tool will only " +
				"ever restore into a target database with zero rows in every table " +
				"the backup covers.",
		);
		process.exitCode = 1;
		return;
	}

	const fs = await import("node:fs/promises");
	const raw = await fs.readFile(args.filePath, "utf-8");
	const envelope = JSON.parse(raw) as BackupEnvelope;

	if (args.expectedKeyId && !envelopeKeyIdMatches(envelope, args.expectedKeyId)) {
		console.error(
			`Backup envelope keyId "${envelope.keyId}" does not match --expect-key-id ` +
				`"${args.expectedKeyId}". Aborting before attempting decryption.`,
		);
		process.exitCode = 1;
		return;
	}

	const { getBackupTableDescriptors } = await import("../src/backups/registry");
	const descriptors = getBackupTableDescriptors();

	const db = createDatabase(databaseUrl);

	const rowCounts = await countRowsPerTable(db, descriptors);
	if (!isTargetEmpty(rowCounts)) {
		console.error(
			"Refusing to restore: target database is not empty. " +
				`Non-zero tables: ${Object.entries(rowCounts)
					.filter(([, c]) => c > 0)
					.map(([t]) => t)
					.join(", ")}`,
		);
		process.exitCode = 1;
		return;
	}

	const payload: BackupSnapshotPayload = await decryptAndParseBackup(
		envelope,
		encryptionKey,
	);

	const expectedShapes: TableShapeDescriptor[] = descriptors.map((d) => ({
		tableName: d.tableName,
		columns: getTableConfig(d.table).columns.map((c) => c.name),
	}));

	// Section C.4: was this backup produced by a schema compatible with what
	// THIS codebase currently expects? Compared BEFORE the live-target-DB
	// check and BEFORE any mutation. Reuses `checkSchemaCompatibility`
	// directly (expected = current registry, actual = the backup's own
	// decrypted schema descriptor) rather than a parallel comparison
	// function. Works correctly even for a table with ZERO rows in the
	// backup, since the schema descriptor captures columns independent of
	// row presence.
	const backupSchemaShapes = schemaDescriptorToShape(
		payload.manifest.schema.tables,
	);
	const backupCompatibility = checkSchemaCompatibility(
		expectedShapes,
		backupSchemaShapes,
	);
	if (!backupCompatibility.compatible) {
		console.error(
			`Backup schema is not compatible with the current application schema: ` +
				`missing tables ${backupCompatibility.missingTables.join(", ")}; ` +
				`missing columns ${JSON.stringify(backupCompatibility.missingColumns)}`,
		);
		process.exitCode = 1;
		return;
	}

	const actualShapes = await fetchActualShapes(
		db,
		expectedShapes.map((t) => t.tableName),
	);
	const compatibility = checkSchemaCompatibility(expectedShapes, actualShapes);
	if (!compatibility.compatible) {
		console.error(
			`Target schema is not compatible with the backup: missing tables ` +
				`${compatibility.missingTables.join(", ")}; missing columns ` +
				`${JSON.stringify(compatibility.missingColumns)}`,
		);
		process.exitCode = 1;
		return;
	}

	const restoreOrder = computeRestoreOrderFromSchema();
	const tableByName = new Map(payload.tables.map((t) => [t.tableName, t]));

	await db.transaction(async (tx) => {
		// Block all concurrent application writes to every backed-up table for
		// the duration of this transaction, in the SAME deterministic
		// (topological) order the restore itself uses, to avoid any
		// lock-ordering deadlock risk. `restoreOrder` comes ONLY from the
		// trusted local schema registry (`computeRestoreOrderFromSchema`) --
		// NEVER from the decrypted backup content.
		await tx.execute(sql.raw(buildLockTableSql(restoreOrder)));

		// Re-check the target is empty INSIDE this same locked transaction --
		// the earlier `isTargetEmpty` check ran on a separate, unprotected
		// connection before this transaction even opened, so a concurrent
		// write could have slipped through the gap. Refuse to restore if the
		// target is no longer empty.
		// biome-ignore lint/suspicious/noExplicitAny: dynamically typed Database/tx
		const lockedRowCounts = await countRowsPerTable(tx as any, descriptors);
		if (!isTargetEmpty(lockedRowCounts)) {
			throw new Error(
				"Refusing to restore: target database is no longer empty (a " +
					"concurrent write occurred between the initial precheck and " +
					"acquiring the table locks). Non-zero tables: " +
					Object.entries(lockedRowCounts)
						.filter(([, c]) => c > 0)
						.map(([t]) => t)
						.join(", "),
			);
		}

		for (const tableName of restoreOrder) {
			const snapshot = tableByName.get(tableName);
			if (!snapshot || snapshot.rows.length === 0) continue;
			const descriptor = descriptors.find((d) => d.tableName === tableName);
			if (!descriptor) continue;
			const columnMap = getColumnMap(descriptor.table);
			const rows = snapshot.rows.map((row) =>
				denormalizeRowForInsert(row, columnMap),
			);
			// biome-ignore lint/suspicious/noExplicitAny: dynamically typed insert
			await (tx as any).insert(descriptor.table).values(rows);
		}
		// Force evaluation of any deferred constraint triggers before commit.
		await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);

		// Post-write verification: re-read EVERY restored table from `tx`
		// (reusing `exportDatabaseSnapshot`, the exact same
		// read-every-registry-table-and-hash logic the backup itself used) and
		// compare row counts + content hashes against the backup's own
		// manifest (reusing `verifySnapshotAgainstManifest`). ANY mismatch
		// throws here, rolling back the entire transaction -- never commit a
		// partially-verified restore.
		const reExported = await exportDatabaseSnapshot(tx);
		await verifySnapshotAgainstManifest({
			manifest: payload.manifest,
			tables: reExported.tables,
		});
	});

	console.log(
		`Restore complete: backupId=${envelope.backupId} tables=${restoreOrder.length}`,
	);
}

const currentModuleUrl = (import.meta as ImportMeta & { url: string }).url;

const isDirectRun =
	typeof process !== "undefined" &&
	process.argv[1] !== undefined &&
	currentModuleUrl === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
	main().catch((err) => {
		console.error("Restore failed:", err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
