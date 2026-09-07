import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
	type BackupEnvelope,
	decryptBackupPayload,
	encryptBackupPayload,
} from "../../src/backups/crypto";
import { buildSnapshotPayload } from "../../src/backups/export";
import {
	computeTableContentHash,
	type TableSnapshot,
} from "../../src/backups/manifest";
import { getBackupTableDescriptors } from "../../src/backups/registry";
import { verifyEncryptedBackupSummary } from "../../src/backups/verify";
import type { DatabaseTransaction } from "../../src/db/client";

/**
 * Reproducible in-memory profiling harness for the GG_BACKUP_V1 export /
 * encrypt / upload / read-back / verify pipeline.
 *
 * It exists to answer, with deterministic evidence, the two Post-Phase-20
 * follow-up questions about `src/backups/*`:
 *
 *   1. Is the 25 MiB `DEFAULT_MAX_PLAINTEXT_BYTES` ceiling only a
 *      *serialized-payload* ceiling, and how much data is materialized before
 *      it is enforced? (see `buildStaticProfileTx` + the guard-timing test)
 *   2. What is the deterministic *byte* amplification between the nominal
 *      plaintext size and the transient buffers/strings each stage allocates?
 *      (see `runAmplificationPipeline`)
 *
 * Byte amplification measured here is runtime-independent (it is pure
 * `TextEncoder` / base64 / AES-GCM output length arithmetic). Node heap /
 * rss diagnostics are layered on top by `scripts/profile-backup-memory.ts`
 * via an injected `sample` callback and are explicitly diagnostic, never an
 * authoritative Cloudflare isolate peak-memory figure.
 */

export const MIB = 1024 * 1024;

/** Small deterministic LCG so every run produces byte-identical fixtures. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function pseudoUuid(rng: () => number): string {
	const hex = "0123456789abcdef";
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += hex[Math.floor(rng() * 16)];
	}
	return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(
		16,
		20,
	)}-${out.slice(20)}`;
}

const WORDS = [
	"alpha",
	"beta",
	"gamma",
	"delta",
	"epsilon",
	"zeta",
	"eta",
	"theta",
];

/**
 * One representative synthetic row: ordinary scalar columns, strings, a
 * numeric-as-string money column, ISO timestamp strings, a JSON-like nested
 * object, and a JSON-like array -- the shapes `normalizeRow` in
 * `src/backups/export.ts` produces for a real table. Rows are already
 * JSON-safe (no `Date` / `Uint8Array`), so the normalization step is an
 * identity map and the measured cost of stage 2 is exactly the
 * sort-by-canonical-JSON + SHA-256 that `computeTableContentHash` really does.
 */
function makeRow(rng: () => number, i: number): Record<string, unknown> {
	const description = Array.from(
		{ length: 8 },
		() => WORDS[Math.floor(rng() * WORDS.length)],
	).join(" ");
	return {
		id: pseudoUuid(rng),
		user_id: pseudoUuid(rng),
		seq: i,
		amount: `${Math.floor(rng() * 1_000_000)}.${String(
			Math.floor(rng() * 100),
		).padStart(2, "0")}`,
		currency: "TRY",
		status: ["POSTED", "PENDING", "VOID"][i % 3],
		occurred_at: new Date(1_750_000_000_000 + i * 1000).toISOString(),
		created_at: new Date(1_750_000_500_000 + i * 1000).toISOString(),
		description,
		note: rng() < 0.5 ? null : description.slice(0, 24),
		metadata: {
			source: ["import", "manual", "api"][i % 3],
			tags: [WORDS[i % WORDS.length], WORDS[(i + 3) % WORDS.length]],
			nested: {
				attempt: i % 5,
				flag: rng() < 0.5,
				ratio: Math.round(rng() * 1e4) / 1e4,
			},
		},
		lines: [
			{ account: pseudoUuid(rng), side: "DEBIT", amount: "100.00" },
			{ account: pseudoUuid(rng), side: "CREDIT", amount: "100.00" },
		],
	};
}

/** Serialized size of a single representative row (stable across runs). */
export function sampleRowBytes(): number {
	const rng = makeRng(1);
	let total = 0;
	for (let i = 0; i < 32; i++) {
		total += new TextEncoder().encode(JSON.stringify(makeRow(rng, i))).length;
	}
	return Math.round(total / 32);
}

/**
 * Generates synthetic rows whose combined `JSON.stringify` length is
 * approximately `targetBytes`, keyed by REAL backup-registry table names so
 * the pipeline's stage 9 (`verifyEncryptedBackupSummary` ->
 * `verifyManifestSchemaAgainstRegistry`) accepts the payload -- that check
 * requires the snapshot's tables to be exactly the live registry set. The
 * synthetic rows are concentrated in the first `spreadAcross` registry
 * tables (to model the additive per-table `computeTableContentHash` cost);
 * every other registry table gets an empty row array.
 */
export function makeSyntheticRawRows(
	targetBytes: number,
	spreadAcross = 4,
): Record<string, Record<string, unknown>[]> {
	const registryNames = getBackupTableDescriptors().map((d) => d.tableName);
	const tableCount = Math.min(spreadAcross, registryNames.length);
	const perRow = sampleRowBytes();
	const totalRows = Math.max(tableCount, Math.round(targetBytes / perRow));
	const rng = makeRng(0x9e3779b9 ^ targetBytes);
	const out: Record<string, Record<string, unknown>[]> = {};
	for (const name of registryNames) {
		out[name] = [];
	}
	let produced = 0;
	for (let t = 0; t < tableCount; t++) {
		const name = registryNames[t] as string;
		const rowsForThisTable =
			t === tableCount - 1
				? totalRows - produced
				: Math.floor(totalRows / tableCount);
		const rows: Record<string, unknown>[] = [];
		for (let r = 0; r < rowsForThisTable; r++) {
			rows.push(makeRow(rng, produced + r));
		}
		produced += rowsForThisTable;
		out[name] = rows;
	}
	return out;
}

export interface StageByteMetric {
	stage: number;
	label: string;
	bytes: number;
}

export interface AmplificationResult {
	targetBytes: number;
	rowCount: number;
	stages: StageByteMetric[];
	/** stage 3 serialized plaintext payload length. */
	plaintextBytes: number;
	/** stage 6 serialized envelope length actually uploaded to R2. */
	envelopeBytes: number;
	/** envelopeBytes / plaintextBytes. */
	envelopeAmplification: number;
	/** sum of the transient allocations stages 1..9 walk through. */
	cumulativeTransientBytes: number;
	/** cumulativeTransientBytes / plaintextBytes. */
	cumulativeAmplification: number;
}

export type SampleFn = (label: string) => void;

const KEY = new Uint8Array(32).fill(7);
const KEY_ID = "profile-key";
const BACKUP_ID = "20260907";
const CREATED_AT = "2026-09-07T02:17:00.000Z";

/**
 * Walks the real export/encrypt/upload/read-back/verify pipeline for one
 * synthetic dataset, recording the byte size of every transient buffer or
 * string each of the nine stages produces. `sample(label)` is invoked at
 * every stage boundary so a Node caller can additionally snapshot
 * `process.memoryUsage()` there.
 */
export async function runAmplificationPipeline(
	targetBytes: number,
	sample: SampleFn = () => {},
): Promise<AmplificationResult> {
	const enc = new TextEncoder();
	const stages: StageByteMetric[] = [];
	const record = (stage: number, label: string, bytes: number) => {
		stages.push({ stage, label, bytes });
		sample(label);
	};

	// ---- Stage 1: synthetic / exported table object graph -----------------
	const rawByTable = makeSyntheticRawRows(targetBytes);
	const rawTableNames = Object.keys(rawByTable);
	let rowCount = 0;
	let stage1Bytes = 0;
	for (const name of rawTableNames) {
		const rows = rawByTable[name] ?? [];
		rowCount += rows.length;
		stage1Bytes += enc.encode(JSON.stringify(rows)).length;
	}
	record(1, "raw table object graph (JSON.stringify bytes)", stage1Bytes);

	// ---- Stage 2: normalization / sort / per-table content hash -----------
	const snapshots: TableSnapshot[] = [];
	let stage2Bytes = 0;
	for (const name of rawTableNames) {
		const rows = rawByTable[name] ?? [];
		const { sortedRows, hash } = await computeTableContentHash(rows);
		snapshots.push({
			tableName: name,
			rowCount: sortedRows.length,
			rows: sortedRows,
			tableContentHash: hash,
		});
		stage2Bytes += enc.encode(JSON.stringify(sortedRows)).length;
	}
	record(2, "normalized + sorted TableSnapshot rows", stage2Bytes);

	// ---- Stage 3: full snapshot payload JSON + TextEncoder ----------------
	const { payload, plaintextBytes } = await buildSnapshotPayload({
		formatVersion: "V1",
		backupId: BACKUP_ID,
		createdAt: CREATED_AT,
		tables: snapshots,
		// Deliberately high so this harness can profile within-limit AND
		// over-limit sizes without the ceiling short-circuiting the pipeline.
		maxPlaintextBytes: Number.MAX_SAFE_INTEGER,
	});
	void payload;
	record(3, "serialized plaintext payload (Uint8Array)", plaintextBytes.length);

	// ---- Stage 4: AES-GCM encryption ------------------------------------
	const envelope: BackupEnvelope = await encryptBackupPayload({
		plaintext: plaintextBytes,
		backupId: BACKUP_ID,
		createdAt: CREATED_AT,
		key: KEY,
		keyId: KEY_ID,
	});
	// GCM ciphertext = plaintext length + 16-byte auth tag.
	const ciphertextBytes = Math.floor(
		(envelope.ciphertextBase64.length * 3) / 4,
	);
	record(4, "AES-GCM ciphertext (ArrayBuffer)", ciphertextBytes);

	// ---- Stage 5: ciphertext -> base64 --------------------------------
	record(5, "ciphertext base64 string", envelope.ciphertextBase64.length);

	// ---- Stage 6: envelope JSON + TextEncoder -------------------------
	const envelopeBytes = enc.encode(JSON.stringify(envelope));
	record(6, "serialized envelope (uploaded bytes)", envelopeBytes.length);

	// ---- Stage 7: R2-equivalent read-back ArrayBuffer ------------------
	const readBackBytes = new Uint8Array(envelopeBytes.byteLength);
	readBackBytes.set(envelopeBytes);
	record(7, "R2 read-back ArrayBuffer", readBackBytes.byteLength);

	// ---- Stage 8: JSON parse of the read-back envelope -----------------
	const readBackEnvelope = JSON.parse(
		new TextDecoder().decode(readBackBytes),
	) as BackupEnvelope;
	record(
		8,
		"parsed read-back envelope (re-materialized ciphertext base64)",
		readBackEnvelope.ciphertextBase64.length,
	);

	// ---- Stage 9: decrypt + manifest verification ---------------------
	const decrypted = await decryptBackupPayload({
		envelope: readBackEnvelope,
		key: KEY,
	});
	await verifyEncryptedBackupSummary(readBackEnvelope, KEY);
	record(9, "decrypted plaintext + verification re-parse", decrypted.length);

	const cumulativeTransientBytes = stages.reduce((s, m) => s + m.bytes, 0);
	return {
		targetBytes,
		rowCount,
		stages,
		plaintextBytes: plaintextBytes.length,
		envelopeBytes: envelopeBytes.length,
		envelopeAmplification: envelopeBytes.length / plaintextBytes.length,
		cumulativeTransientBytes,
		cumulativeAmplification: cumulativeTransientBytes / plaintextBytes.length,
	};
}

/**
 * A fake `DatabaseTransaction` whose `select().from(table)` returns the
 * supplied synthetic rows for the FIRST real backup-registry table and an
 * empty array for every other table. Used to prove exactly how much data
 * `exportDatabaseSnapshot` materializes for an over-limit dataset before
 * `buildSnapshotPayload` is ever called.
 */
export function buildStaticProfileTx(
	rowsForFirstTable: Record<string, unknown>[],
): { tx: DatabaseTransaction; firstTableName: string } {
	const descriptors = getBackupTableDescriptors();
	const firstTableName = descriptors[0]?.tableName ?? "";
	const tx = {
		select: () => ({
			from: (table: PgTable) => {
				const name = getTableConfig(table).name;
				return Promise.resolve(
					name === firstTableName ? rowsForFirstTable : [],
				);
			},
		}),
	};
	return { tx: tx as unknown as DatabaseTransaction, firstTableName };
}
