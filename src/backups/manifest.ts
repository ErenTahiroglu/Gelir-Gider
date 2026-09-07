import { getTableConfig } from "drizzle-orm/pg-core";
import { BackupError } from "./errors";
import { getBackupTableDescriptors } from "./registry";

/**
 * A single table's exported rows plus their content hash. Rows are plain
 * JSON-safe records (see `src/backups/export.ts` for the exact
 * serialization rules -- NUMERIC as strings, timestamps as ISO strings,
 * UUIDs as strings, JSON/JSONB as-is, nulls as null).
 */
export interface TableSnapshot {
	tableName: string;
	rowCount: number;
	rows: Record<string, unknown>[];
	tableContentHash: string;
}

export interface ManifestTableEntry {
	tableName: string;
	rowCount: number;
	tableContentHash: string;
}

/**
 * A structural (never financial) descriptor of one table's columns as they
 * exist in the ACTUAL Drizzle registry at backup time. `columnType` is the
 * Drizzle discriminator string (e.g. "PgUUID", "PgText", "PgTimestamp",
 * "PgCustomColumn") -- the same discriminator `scripts/restore-backup.ts`
 * already keys denormalization decisions off of -- rather than the raw SQL
 * `dataType`, since it is what is actually meaningful for compatibility.
 */
export interface SchemaColumnDescriptor {
	columnName: string;
	columnType: string;
	notNull: boolean;
}

/** Columns sorted by `columnName` for a deterministic fingerprint. */
export interface SchemaTableDescriptor {
	tableName: string;
	columns: SchemaColumnDescriptor[];
}

/**
 * A snapshot of the application's schema (column names/types/nullability
 * only -- never row data) at backup time, used to detect a backup produced
 * under an incompatible application schema BEFORE any restore mutation is
 * attempted (Phase 18-R1 Section C). Tables sorted by `tableName`.
 */
export interface BackupManifestSchema {
	tables: SchemaTableDescriptor[];
	schemaFingerprint: string;
}

export interface BackupManifest {
	formatVersion: string;
	backupId: string;
	createdAt: string;
	tables: ManifestTableEntry[];
	manifestHash: string;
	schema: BackupManifestSchema;
}

export interface BackupSnapshotPayload {
	manifest: BackupManifest;
	tables: TableSnapshot[];
}

/**
 * Deterministically stringifies a JSON-safe value: object keys sorted
 * lexicographically at every level, arrays kept in their given order. Used
 * both for per-table content hashing and for the overall manifest hash, so
 * hashing is stable across runs of the same underlying data regardless of
 * column/property enumeration order.
 */
export function canonicalStringify(value: unknown): string {
	return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
	if (value === null || value === undefined) {
		return "null";
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new BackupError(
				"BACKUP_SNAPSHOT_FAILED",
				"Non-finite number encountered while canonicalizing backup row data",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stringifyCanonical(entry)).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		const parts = keys.map(
			(key) => `${JSON.stringify(key)}:${stringifyCanonical(record[key])}`,
		);
		return `{${parts.join(",")}}`;
	}
	throw new BackupError(
		"BACKUP_SNAPSHOT_FAILED",
		`Unsupported value type encountered while canonicalizing backup row data: ${typeof value}`,
	);
}

async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		bytes as unknown as BufferSource,
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Sorts rows deterministically by their OWN canonical JSON serialization
 * (not by any particular column) so the sort is well-defined even for
 * tables whose primary key is not a plain single `id` column, then computes
 * the table's content hash as SHA-256 of the canonical JSON array of the
 * sorted rows.
 */
export async function computeTableContentHash(
	rows: Record<string, unknown>[],
): Promise<{ sortedRows: Record<string, unknown>[]; hash: string }> {
	const decorated = rows.map((row) => ({ row, key: stringifyCanonical(row) }));
	decorated.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const sortedRows = decorated.map((entry) => entry.row);
	const hash = await sha256Hex(
		`[${decorated.map((entry) => entry.key).join(",")}]`,
	);
	return { sortedRows, hash };
}

/**
 * Builds the schema descriptor from the ACTUAL Drizzle registry (never a
 * manually maintained list, mirroring `discoverBackupTableRegistry`'s own
 * anti-drift rationale), sorted deterministically (tables by `tableName`,
 * columns within each table by `columnName`) so `schemaFingerprint` is
 * stable across runs with no actual schema change.
 */
export async function buildManifestSchema(): Promise<BackupManifestSchema> {
	const descriptors = getBackupTableDescriptors();
	const tables: SchemaTableDescriptor[] = descriptors
		.map((descriptor) => {
			const config = getTableConfig(descriptor.table);
			const columns: SchemaColumnDescriptor[] = config.columns
				.map((column) => ({
					columnName: column.name,
					columnType: column.columnType,
					notNull: column.notNull,
				}))
				.sort((a, b) => a.columnName.localeCompare(b.columnName));
			return { tableName: descriptor.tableName, columns };
		})
		.sort((a, b) => a.tableName.localeCompare(b.tableName));

	const schemaFingerprint = await sha256Hex(stringifyCanonical(tables));
	return { tables, schemaFingerprint };
}

export interface BuildManifestParams {
	formatVersion: string;
	backupId: string;
	createdAt: string;
	tables: TableSnapshot[];
}

export async function buildManifest(
	params: BuildManifestParams,
): Promise<BackupManifest> {
	const tableEntries: ManifestTableEntry[] = params.tables.map((t) => ({
		tableName: t.tableName,
		rowCount: t.rowCount,
		tableContentHash: t.tableContentHash,
	}));
	const manifestHash = await sha256Hex(
		stringifyCanonical({
			formatVersion: params.formatVersion,
			backupId: params.backupId,
			createdAt: params.createdAt,
			tables: tableEntries,
		}),
	);
	const schema = await buildManifestSchema();
	return {
		formatVersion: params.formatVersion,
		backupId: params.backupId,
		createdAt: params.createdAt,
		tables: tableEntries,
		manifestHash,
		schema,
	};
}

/**
 * Re-verifies a fully decrypted snapshot payload against its own manifest:
 * recomputes each table's row count and content hash from its actual rows,
 * and recomputes the overall manifest hash, comparing every value to what
 * the manifest claims. Throws `BACKUP_VERIFICATION_FAILED` on ANY mismatch.
 * Used both by `verifyEncryptedBackupSummary` (restore-adjacent integrity
 * check) and by the restore script before it mutates anything.
 */
export async function verifySnapshotAgainstManifest(
	payload: BackupSnapshotPayload,
): Promise<void> {
	const { manifest, tables } = payload;

	if (tables.length !== manifest.tables.length) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup snapshot table count does not match its manifest",
		);
	}

	const manifestByName = new Map(
		manifest.tables.map((entry) => [entry.tableName, entry]),
	);

	for (const table of tables) {
		const expected = manifestByName.get(table.tableName);
		if (!expected) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				`Backup snapshot contains table "${table.tableName}" absent from its manifest`,
			);
		}
		if (table.rowCount !== table.rows.length) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				`Backup snapshot table "${table.tableName}" rowCount does not match its actual row count`,
			);
		}
		if (table.rowCount !== expected.rowCount) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				`Backup snapshot table "${table.tableName}" row count does not match its manifest entry`,
			);
		}
		const { hash } = await computeTableContentHash(table.rows);
		if (hash !== expected.tableContentHash || hash !== table.tableContentHash) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				`Backup snapshot table "${table.tableName}" content hash does not match its manifest entry`,
			);
		}
	}

	const recomputedManifestHash = await sha256Hex(
		stringifyCanonical({
			formatVersion: manifest.formatVersion,
			backupId: manifest.backupId,
			createdAt: manifest.createdAt,
			tables: manifest.tables,
		}),
	);
	if (recomputedManifestHash !== manifest.manifestHash) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup manifest hash does not match its own recomputed value",
		);
	}
}

/**
 * Verifies a decrypted backup's schema descriptor (Phase 18-R1 Section C):
 *   - every table entry is well-formed and non-duplicated
 *   - every column entry is well-formed and non-duplicated within its table
 *   - the schema descriptor enumerates EXACTLY the same set of tables as the
 *     backup's own row-data payload (internal consistency -- not a
 *     comparison against the live registry)
 *   - no table in the schema descriptor is absent from the CURRENT local
 *     application registry ("unexpected registry table" -- a table later
 *     removed from the application, referenced by an old backup)
 *   - the recomputed `schemaFingerprint` matches the stored one
 * Always runs AFTER successful AES-GCM decryption, as part of the existing
 * verification pipeline in `verifyEncryptedBackupSummary`/
 * `decryptAndParseBackup`. Throws `BACKUP_VERIFICATION_FAILED` on ANY
 * violation.
 */
export async function verifyManifestSchemaAgainstRegistry(
	payload: BackupSnapshotPayload,
): Promise<void> {
	const schema = payload.manifest.schema;
	if (
		typeof schema !== "object" ||
		schema === null ||
		!Array.isArray(schema.tables) ||
		typeof schema.schemaFingerprint !== "string"
	) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup manifest is missing a valid schema descriptor",
		);
	}

	const seenTableNames = new Set<string>();
	for (const table of schema.tables) {
		if (
			typeof table !== "object" ||
			table === null ||
			typeof table.tableName !== "string" ||
			table.tableName === "" ||
			!Array.isArray(table.columns)
		) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				"Backup manifest schema descriptor contains a malformed table entry",
			);
		}
		if (seenTableNames.has(table.tableName)) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				`Backup manifest schema descriptor contains duplicate table "${table.tableName}"`,
			);
		}
		seenTableNames.add(table.tableName);

		const seenColumnNames = new Set<string>();
		for (const column of table.columns) {
			if (
				typeof column !== "object" ||
				column === null ||
				typeof column.columnName !== "string" ||
				column.columnName === "" ||
				typeof column.columnType !== "string" ||
				column.columnType === "" ||
				typeof column.notNull !== "boolean"
			) {
				throw new BackupError(
					"BACKUP_VERIFICATION_FAILED",
					`Backup manifest schema descriptor for table "${table.tableName}" contains a malformed column entry`,
				);
			}
			if (seenColumnNames.has(column.columnName)) {
				throw new BackupError(
					"BACKUP_VERIFICATION_FAILED",
					`Backup manifest schema descriptor for table "${table.tableName}" contains duplicate column "${column.columnName}"`,
				);
			}
			seenColumnNames.add(column.columnName);
		}
	}

	const payloadTableNames = new Set(payload.tables.map((t) => t.tableName));
	const enumeratesExactlyPayloadTables =
		seenTableNames.size === payloadTableNames.size &&
		[...seenTableNames].every((name) => payloadTableNames.has(name));
	if (!enumeratesExactlyPayloadTables) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup manifest schema descriptor does not enumerate exactly the tables present in the backup's row data",
		);
	}

	const registryTableNames = new Set(
		getBackupTableDescriptors().map((d) => d.tableName),
	);
	for (const tableName of seenTableNames) {
		if (!registryTableNames.has(tableName)) {
			throw new BackupError(
				"BACKUP_VERIFICATION_FAILED",
				`Backup manifest schema descriptor references table "${tableName}" that is not present in the current application registry`,
			);
		}
	}

	const recomputedFingerprint = await sha256Hex(
		stringifyCanonical(schema.tables),
	);
	if (recomputedFingerprint !== schema.schemaFingerprint) {
		throw new BackupError(
			"BACKUP_VERIFICATION_FAILED",
			"Backup manifest schema fingerprint does not match its own recomputed value",
		);
	}
}

export interface SchemaComparisonResult {
	compatible: boolean;
	details: string[];
}

/**
 * Compares a BACKUP's own schema descriptor (captured at backup time by
 * `buildManifestSchema()`) against the CURRENT APPLICATION's schema
 * descriptor (built by calling `buildManifestSchema()` again, at restore
 * time) -- two independently-built `BackupManifestSchema` values, NOT the
 * same value checked against itself (that's what
 * `verifyManifestSchemaAgainstRegistry` does; it is a decryption-integrity
 * check, not a compatibility check).
 *
 * V1 requires an EXACT match: same table set (no missing, no extra tables),
 * and for every table the exact same column set with the exact same
 * `columnType` and exact same `notNull` for every column. Since both
 * descriptors are produced by the SAME `buildManifestSchema()` function (so
 * there is no risk of two independently-written comparison paths drifting),
 * this reduces to a single, provably-correct check: comparing
 * `backup.schemaFingerprint` to `current.schemaFingerprint`. The fingerprint
 * is a SHA-256 over the exact canonical structure of `tables` (table set,
 * column set, `columnType`, and `notNull` all included), so equal
 * fingerprints prove the schemas are identical in every respect a mismatch
 * could occur, and unequal fingerprints prove some difference exists. On a
 * mismatch, `details` is built by directly diffing the two `tables` arrays
 * (table set first, then per-table column set/type/nullability) so the
 * restore operator gets a human-readable diagnosis rather than just
 * "fingerprint mismatch".
 */
export function compareSchemaDescriptorsExact(
	backup: BackupManifestSchema,
	current: BackupManifestSchema,
): SchemaComparisonResult {
	if (backup.schemaFingerprint === current.schemaFingerprint) {
		return { compatible: true, details: [] };
	}

	const details: string[] = [];
	const backupByName = new Map(backup.tables.map((t) => [t.tableName, t]));
	const currentByName = new Map(current.tables.map((t) => [t.tableName, t]));

	for (const tableName of backupByName.keys()) {
		if (!currentByName.has(tableName)) {
			details.push(
				`table "${tableName}" is present in the backup schema but missing from the current application schema`,
			);
		}
	}
	for (const tableName of currentByName.keys()) {
		if (!backupByName.has(tableName)) {
			details.push(
				`table "${tableName}" is required by the current application schema but missing from the backup schema`,
			);
		}
	}

	for (const [tableName, backupTable] of backupByName) {
		const currentTable = currentByName.get(tableName);
		if (!currentTable) continue;

		const backupColumnsByName = new Map(
			backupTable.columns.map((c) => [c.columnName, c]),
		);
		const currentColumnsByName = new Map(
			currentTable.columns.map((c) => [c.columnName, c]),
		);

		for (const columnName of backupColumnsByName.keys()) {
			if (!currentColumnsByName.has(columnName)) {
				details.push(
					`table "${tableName}" column "${columnName}" is present in the backup schema but missing from the current application schema`,
				);
			}
		}
		for (const columnName of currentColumnsByName.keys()) {
			if (!backupColumnsByName.has(columnName)) {
				details.push(
					`table "${tableName}" column "${columnName}" is required by the current application schema but missing from the backup schema`,
				);
			}
		}
		for (const [columnName, backupColumn] of backupColumnsByName) {
			const currentColumn = currentColumnsByName.get(columnName);
			if (!currentColumn) continue;
			if (backupColumn.columnType !== currentColumn.columnType) {
				details.push(
					`table "${tableName}" column "${columnName}" type differs: backup has "${backupColumn.columnType}", current application schema has "${currentColumn.columnType}"`,
				);
			}
			if (backupColumn.notNull !== currentColumn.notNull) {
				details.push(
					`table "${tableName}" column "${columnName}" nullability differs: backup has notNull=${backupColumn.notNull}, current application schema has notNull=${currentColumn.notNull}`,
				);
			}
		}
	}

	if (details.length === 0) {
		// Fingerprints differed but no structural difference was found by this
		// diff (should not happen given the fingerprint's canonical inputs
		// match exactly what is compared above) -- report the raw mismatch
		// rather than silently claiming compatibility.
		details.push(
			"backup schema fingerprint does not match the current application schema fingerprint",
		);
	}

	return { compatible: false, details };
}
