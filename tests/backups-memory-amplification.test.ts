import { describe, expect, it } from "vitest";
import {
	buildSnapshotPayload,
	DEFAULT_MAX_PLAINTEXT_BYTES,
	exportDatabaseSnapshot,
} from "../src/backups/export";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	type AmplificationResult,
	buildStaticProfileTx,
	MIB,
	makeSyntheticRawRows,
	runAmplificationPipeline,
} from "./helpers/backup-memory-profile";

// ============================================================================
// Backup memory / byte amplification profiling  (Post-Phase-20 follow-up 3B)
// ----------------------------------------------------------------------------
// Permanent regression coverage for two facts about `src/backups/*`:
//
//   * The 25 MiB `DEFAULT_MAX_PLAINTEXT_BYTES` limit is a *serialized-payload*
//     ceiling enforced by `buildSnapshotPayload` -- NOT a memory ceiling, and
//     NOT enforced by `exportDatabaseSnapshot`, which fully materializes,
//     normalizes, sorts and hashes every table (and runs its own full
//     `TextEncoder` pass) for an over-limit dataset before the ceiling is
//     ever checked.
//
//   * Deterministic byte amplification through the export -> encrypt ->
//     upload -> read-back -> verify pipeline: the uploaded envelope is ~1.33x
//     the plaintext, and the pipeline walks through ~10x the plaintext size
//     in transient buffers/strings end to end.
//
// The full 1/5/10/15/20/25/over-limit sweep with Node heap/rss diagnostics
// lives in `scripts/profile-backup-memory.ts` (run:
// `node --expose-gc --import tsx scripts/profile-backup-memory.ts`) and,
// env-gated, in the last `describe` block below.
// ============================================================================

describe("backup size guard timing", () => {
	it("exportDatabaseSnapshot fully materializes an over-limit dataset; only buildSnapshotPayload enforces the 25 MiB ceiling", async () => {
		// ~26 MiB of synthetic rows in the first registry table.
		const rawByTable = makeSyntheticRawRows(26 * MIB, 1);
		const registryNames = getBackupTableDescriptors().map((d) => d.tableName);
		const firstName = registryNames[0] as string;
		const bigRows = rawByTable[firstName] ?? [];
		expect(bigRows.length).toBeGreaterThan(1000);

		const { tx } = buildStaticProfileTx(bigRows);

		// exportDatabaseSnapshot does NOT throw for an over-limit dataset...
		const snapshot = await exportDatabaseSnapshot(tx);

		// ...it has already materialized EVERY registry table (normalized,
		// sorted, per-table SHA-256 hashed) ...
		expect(snapshot.tables).toHaveLength(registryNames.length);
		const firstSnapshot = snapshot.tables.find(
			(t) => t.tableName === firstName,
		);
		expect(firstSnapshot?.rows.length).toBe(bigRows.length);
		expect(firstSnapshot?.tableContentHash).toMatch(/^[0-9a-f]{64}$/);

		// ...and it has run its own full JSON + TextEncoder pass to compute a
		// plaintext size that is ALREADY well over the 25 MiB ceiling.
		expect(snapshot.plaintextSizeBytes).toBeGreaterThan(
			DEFAULT_MAX_PLAINTEXT_BYTES,
		);

		// The ceiling is enforced only now, by buildSnapshotPayload, which
		// re-serializes the whole payload (manifest + tables) a second time
		// before throwing.
		await expect(
			buildSnapshotPayload({
				formatVersion: "V1",
				backupId: "20260907",
				createdAt: "2026-09-07T02:17:00.000Z",
				tables: snapshot.tables,
			}),
		).rejects.toMatchObject({
			name: "BackupError",
			code: "BACKUP_TOO_LARGE",
		});
	});

	it("a within-limit dataset passes through both stages unchanged", async () => {
		const rawByTable = makeSyntheticRawRows(1 * MIB, 1);
		const registryNames = getBackupTableDescriptors().map((d) => d.tableName);
		const firstName = registryNames[0] as string;
		const { tx } = buildStaticProfileTx(rawByTable[firstName] ?? []);

		const snapshot = await exportDatabaseSnapshot(tx);
		expect(snapshot.plaintextSizeBytes).toBeLessThan(
			DEFAULT_MAX_PLAINTEXT_BYTES,
		);

		const built = await buildSnapshotPayload({
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T02:17:00.000Z",
			tables: snapshot.tables,
		});
		expect(built.plaintextBytes.length).toBeGreaterThan(1 * MIB);
		expect(built.payload.manifest.tables).toHaveLength(registryNames.length);
	});
});

describe("backup pipeline byte amplification", () => {
	function roundedStageTable(result: AmplificationResult): string {
		const lines = result.stages.map(
			(s) =>
				`${s.stage}. ${s.label.padEnd(58)} ${(s.bytes / result.plaintextBytes)
					.toFixed(2)
					.padStart(6)}x`,
		);
		return lines.join("\n");
	}

	it("uploaded envelope is ~1.33x the plaintext and the pipeline walks ~10x the plaintext in transient bytes (1 MiB)", async () => {
		const result = await runAmplificationPipeline(1 * MIB);

		// Plaintext payload tracks the nominal target within a few percent.
		expect(result.plaintextBytes).toBeGreaterThan(0.98 * MIB);
		expect(result.plaintextBytes).toBeLessThan(1.15 * MIB);

		// base64(ciphertext + 16B GCM tag) -> 4/3 expansion.
		expect(result.envelopeAmplification).toBeGreaterThan(1.3);
		expect(result.envelopeAmplification).toBeLessThan(1.4);

		// Sum of every transient buffer/string stages 1..9 allocate.
		expect(result.cumulativeAmplification).toBeGreaterThan(8);
		expect(result.cumulativeAmplification).toBeLessThan(13);
	});

	it("amplification ratios are size-independent (5 MiB, full pipeline, snapshotted)", async () => {
		const result = await runAmplificationPipeline(5 * MIB);

		expect(result.envelopeAmplification).toBeGreaterThan(1.3);
		expect(result.envelopeAmplification).toBeLessThan(1.4);
		expect(result.cumulativeAmplification).toBeGreaterThan(8);
		expect(result.cumulativeAmplification).toBeLessThan(13);

		// Per-stage transient size as a multiple of the plaintext payload.
		// A change here means the export/encrypt/verify memory profile moved.
		expect(roundedStageTable(result)).toMatchInlineSnapshot(`
			"1. raw table object graph (JSON.stringify bytes)                0.98x
			2. normalized + sorted TableSnapshot rows                       0.98x
			3. serialized plaintext payload (Uint8Array)                    1.00x
			4. AES-GCM ciphertext (ArrayBuffer)                             1.00x
			5. ciphertext base64 string                                     1.33x
			6. serialized envelope (uploaded bytes)                         1.33x
			7. R2 read-back ArrayBuffer                                     1.33x
			8. parsed read-back envelope (re-materialized ciphertext base64)   1.33x
			9. decrypted plaintext + verification re-parse                  1.00x"
		`);
	});
});

// Full 1/5/10/15/20/25/over-limit sweep -- deterministic byte amplification
// only (no Node heap/rss here; workerd reports zeroed `process.memoryUsage()`
// and exposes no `gc`). The richer Node-diagnostic version of this same sweep
// is `scripts/profile-backup-memory.ts`
// (`node --expose-gc --import tsx scripts/profile-backup-memory.ts`).
describe("backup pipeline amplification sweep (deterministic bytes)", () => {
	for (const targetMib of [1, 5, 10, 15, 20, 25, 30]) {
		it(`profiles ${targetMib} MiB (${
			targetMib > 25 ? "over" : "within"
		} the 25 MiB ceiling)`, async () => {
			const result = await runAmplificationPipeline(targetMib * MIB);
			expect(result.plaintextBytes / MIB).toBeGreaterThan(targetMib * 0.98);
			expect(result.plaintextBytes / MIB).toBeLessThan(targetMib * 1.05 + 0.2);
			// Envelope (uploaded to R2) is base64(ciphertext + GCM tag): 4/3.
			expect(result.envelopeAmplification).toBeGreaterThan(1.3);
			expect(result.envelopeAmplification).toBeLessThan(1.4);
			// End-to-end the pipeline walks ~10x the plaintext in transient bytes.
			expect(result.cumulativeAmplification).toBeGreaterThan(8);
			expect(result.cumulativeAmplification).toBeLessThan(13);
		});
	}
});
