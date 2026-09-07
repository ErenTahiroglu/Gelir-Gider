import type { PgTable } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "../db/client";
import { BackupError } from "./errors";
import {
	type BackupSnapshotPayload,
	buildManifest,
	computeTableContentHash,
	type TableSnapshot,
} from "./manifest";
import { getBackupTableDescriptors } from "./registry";

/** Default plaintext size ceiling: 25 MiB. Overridable for tests. */
export const DEFAULT_MAX_PLAINTEXT_BYTES = 25 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	return btoa(binary);
}

/**
 * Normalizes a single raw column value read back via Drizzle's query
 * builder into a plain JSON-safe value: `Date` -> ISO string, `Uint8Array`
 * (the `bytea` custom type) -> base64 string, everything else (string
 * numeric columns, plain numbers, booleans, null, JSONB-decoded
 * objects/arrays) passed through unchanged.
 */
function normalizeCellValue(value: unknown): unknown {
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Uint8Array) {
		return bytesToBase64(value);
	}
	return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		normalized[key] = normalizeCellValue(value);
	}
	return normalized;
}

/**
 * Reads and serializes every row of one table, deterministically. MUST be
 * called with a transaction the caller already opened as
 * `REPEATABLE READ READ ONLY` (see `runDatabaseBackup` in
 * `src/backups/service.ts`) so the entire multi-table snapshot observes one
 * consistent point-in-time view of the database.
 */
/**
 * A minimal structural view of `DatabaseTransaction.select().from(table)`
 * used here instead of `any`, since the registry is built by introspecting
 * the schema barrel at runtime -- no static generic table type is available
 * for a dynamically-selected `PgTable`.
 */
interface SelectableTransaction {
	select(): { from(table: PgTable): Promise<Record<string, unknown>[]> };
}

async function exportTable(
	tx: DatabaseTransaction,
	tableName: string,
	table: PgTable,
): Promise<TableSnapshot> {
	const rawRows = await (tx as unknown as SelectableTransaction)
		.select()
		.from(table);
	const rows = rawRows.map(normalizeRow);
	const { sortedRows, hash } = await computeTableContentHash(rows);
	return {
		tableName,
		rowCount: sortedRows.length,
		rows: sortedRows,
		tableContentHash: hash,
	};
}

export interface ExportDatabaseSnapshotResult {
	tables: TableSnapshot[];
	plaintextSizeBytes: number;
}

/**
 * Exports a deterministic snapshot of every table in the backup registry.
 * The CALLER is responsible for having opened `tx` as
 * `REPEATABLE READ READ ONLY` -- this function does not and cannot verify
 * the isolation level itself, since Drizzle exposes no runtime introspection
 * of the active transaction's isolation mode.
 */
export async function exportDatabaseSnapshot(
	tx: DatabaseTransaction,
): Promise<ExportDatabaseSnapshotResult> {
	const descriptors = getBackupTableDescriptors();
	const tables: TableSnapshot[] = [];
	for (const descriptor of descriptors) {
		tables.push(await exportTable(tx, descriptor.tableName, descriptor.table));
	}
	const plaintextSizeBytes = tables.reduce(
		(sum, t) => sum + new TextEncoder().encode(JSON.stringify(t.rows)).length,
		0,
	);
	return { tables, plaintextSizeBytes };
}

export interface BuildSnapshotPayloadParams {
	formatVersion: string;
	backupId: string;
	createdAt: string;
	tables: TableSnapshot[];
	maxPlaintextBytes?: number | undefined;
}

/**
 * Builds the full plaintext snapshot payload (manifest + per-table rows)
 * and enforces the plaintext size ceiling BEFORE any encryption or upload
 * is attempted. Throws `BACKUP_TOO_LARGE` (never logging the payload
 * itself) if the serialized snapshot would exceed the limit.
 */
export async function buildSnapshotPayload(
	params: BuildSnapshotPayloadParams,
): Promise<{ payload: BackupSnapshotPayload; plaintextBytes: Uint8Array }> {
	const manifest = await buildManifest({
		formatVersion: params.formatVersion,
		backupId: params.backupId,
		createdAt: params.createdAt,
		tables: params.tables,
	});
	const payload: BackupSnapshotPayload = { manifest, tables: params.tables };
	const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));

	const maxBytes = params.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES;
	if (plaintextBytes.length > maxBytes) {
		throw new BackupError(
			"BACKUP_TOO_LARGE",
			"Backup snapshot plaintext exceeds the maximum allowed size",
		);
	}

	return { payload, plaintextBytes };
}
