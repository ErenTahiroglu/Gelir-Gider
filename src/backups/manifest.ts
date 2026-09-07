import { BackupError } from "./errors";

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

export interface BackupManifest {
	formatVersion: string;
	backupId: string;
	createdAt: string;
	tables: ManifestTableEntry[];
	manifestHash: string;
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
	return {
		formatVersion: params.formatVersion,
		backupId: params.backupId,
		createdAt: params.createdAt,
		tables: tableEntries,
		manifestHash,
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
