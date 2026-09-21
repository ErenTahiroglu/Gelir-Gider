import { asc, gt } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "../db/client";
import { BackupError } from "./errors";
import {
	type BackupSnapshotPayload,
	buildManifest,
	computeTableContentHash,
	type TableSnapshot,
} from "./manifest";
import { getBackupTableDescriptors } from "./registry";

/**
 * Safe plaintext size ceiling: 10 MiB.
 * Proven safe for Cloudflare Worker 128 MB memory limit under measured ~8.2x
 * peak live heap amplification during snapshot, encryption, and verification.
 * Overridable for tests.
 */
export const DEFAULT_MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024;

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
export const BACKUP_CHUNK_SIZE = 500;

interface DynamicSelectableQuery {
	where?(clause: unknown): DynamicSelectableQuery;
	limit?(limit: number): DynamicSelectableQuery;
	offset?(offset: number): DynamicSelectableQuery;
	orderBy?(...clauses: unknown[]): DynamicSelectableQuery;
	then?: unknown;
}

interface DynamicSelectableTransaction {
	select(): {
		from(table: PgTable): {
			orderBy(
				...clauses: unknown[]
			): DynamicSelectableQuery & Promise<Record<string, unknown>[]>;
		} & DynamicSelectableQuery &
			Promise<Record<string, unknown>[]>;
	};
}

async function exportTable(
	tx: DatabaseTransaction,
	tableName: string,
	table: PgTable,
	onChunkBytes?: (chunkBytes: number) => void,
	chunkSize = BACKUP_CHUNK_SIZE,
): Promise<TableSnapshot> {
	const allRows: Record<string, unknown>[] = [];
	const config = getTableConfig(table);
	const pkColumns = config.columns.filter((c) => c.primary);
	const orderColumns = pkColumns.length > 0 ? pkColumns : config.columns;
	const orderClauses = orderColumns.map((c) => asc(c));

	const dynamicTx = tx as unknown as DynamicSelectableTransaction;
	const probe = dynamicTx.select().from(table);

	if (typeof probe?.orderBy === "function") {
		if (pkColumns.length === 1) {
			const pkCol = pkColumns[0];
			if (!pkCol) {
				return {
					tableName,
					rowCount: 0,
					rows: [],
					tableContentHash: "",
				};
			}
			let lastPk: unknown;
			while (true) {
				let query = dynamicTx
					.select()
					.from(table)
					.orderBy(asc(pkCol)) as DynamicSelectableQuery &
					Promise<Record<string, unknown>[]>;
				if (typeof query.limit === "function") {
					query = query.limit(chunkSize) as DynamicSelectableQuery &
						Promise<Record<string, unknown>[]>;
				}
				if (lastPk !== undefined && typeof query.where === "function") {
					query = query.where(gt(pkCol, lastPk)) as DynamicSelectableQuery &
						Promise<Record<string, unknown>[]>;
				}
				const rawChunk = await query;
				if (!rawChunk || rawChunk.length === 0) {
					break;
				}
				const normalizedChunk = rawChunk.map(normalizeRow);
				allRows.push(...normalizedChunk);

				if (onChunkBytes) {
					const chunkBytes = new TextEncoder().encode(
						JSON.stringify(normalizedChunk),
					).length;
					onChunkBytes(chunkBytes);
				}

				if (rawChunk.length < chunkSize) {
					break;
				}
				const lastRow = rawChunk[rawChunk.length - 1];
				lastPk = lastRow ? lastRow[pkCol.name] : undefined;
			}
		} else {
			let offset = 0;
			while (true) {
				let query = dynamicTx
					.select()
					.from(table)
					.orderBy(...orderClauses) as DynamicSelectableQuery &
					Promise<Record<string, unknown>[]>;
				if (typeof query.limit === "function") {
					query = query.limit(chunkSize) as DynamicSelectableQuery &
						Promise<Record<string, unknown>[]>;
				}
				if (typeof query.offset === "function") {
					query = query.offset(offset) as DynamicSelectableQuery &
						Promise<Record<string, unknown>[]>;
				}
				const rawChunk = await query;
				if (!rawChunk || rawChunk.length === 0) {
					break;
				}
				const normalizedChunk = rawChunk.map(normalizeRow);
				allRows.push(...normalizedChunk);

				if (onChunkBytes) {
					const chunkBytes = new TextEncoder().encode(
						JSON.stringify(normalizedChunk),
					).length;
					onChunkBytes(chunkBytes);
				}

				if (rawChunk.length < chunkSize) {
					break;
				}
				offset += rawChunk.length;
			}
		}
	} else {
		// Simple direct Promise support (e.g. static mock query in tests)
		const rawRows = await probe;
		const normalizedRows = (rawRows ?? []).map(normalizeRow);
		allRows.push(...normalizedRows);
		if (onChunkBytes) {
			const chunkBytes = new TextEncoder().encode(
				JSON.stringify(normalizedRows),
			).length;
			onChunkBytes(chunkBytes);
		}
	}

	const { sortedRows, hash } = await computeTableContentHash(allRows);
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
	maxPlaintextBytes?: number | undefined,
): Promise<ExportDatabaseSnapshotResult> {
	const descriptors = getBackupTableDescriptors();
	const tables: TableSnapshot[] = [];
	const maxBytes = maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES;
	let cumulativePlaintextSizeBytes = 0;

	for (const descriptor of descriptors) {
		const tableSnapshot = await exportTable(
			tx,
			descriptor.tableName,
			descriptor.table,
			(chunkBytes) => {
				cumulativePlaintextSizeBytes += chunkBytes;
				if (cumulativePlaintextSizeBytes > maxBytes) {
					throw new BackupError(
						"BACKUP_TOO_LARGE",
						"Backup snapshot plaintext exceeds the maximum allowed size",
					);
				}
			},
		);
		tables.push(tableSnapshot);
	}

	return { tables, plaintextSizeBytes: cumulativePlaintextSizeBytes };
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
