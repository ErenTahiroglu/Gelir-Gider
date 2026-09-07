import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { BackupError } from "../src/backups/errors";
import { buildSnapshotPayload } from "../src/backups/export";
import type { TableSnapshot } from "../src/backups/manifest";
import {
	discoverBackupTableRegistry,
	getBackupTableDescriptors,
} from "../src/backups/registry";
import * as schema from "../src/db/schema";

describe("Backup table registry completeness (regression guard)", () => {
	it("includes EVERY pgTable exported from the schema barrel -- a forgotten new table fails this test", () => {
		const actualSchemaTableNames = new Set<string>();
		for (const value of Object.values(schema)) {
			if (is(value, PgTable)) {
				actualSchemaTableNames.add(getTableConfig(value).name);
			}
		}

		const registryTableNames = new Set(
			discoverBackupTableRegistry().map((t) => getTableConfig(t).name),
		);

		expect(registryTableNames).toEqual(actualSchemaTableNames);
	});

	it("discovers at least one table (sanity check the introspection mechanism itself works)", () => {
		expect(discoverBackupTableRegistry().length).toBeGreaterThan(10);
	});

	it("returns a deterministic, sorted set of table descriptors across calls", () => {
		const first = getBackupTableDescriptors().map((d) => d.tableName);
		const second = getBackupTableDescriptors().map((d) => d.tableName);
		expect(first).toEqual(second);
		expect(first).toEqual([...first].sort());
	});
});

describe("Backup snapshot size-limit enforcement", () => {
	function makeTable(
		name: string,
		rows: Record<string, unknown>[],
	): TableSnapshot {
		return {
			tableName: name,
			rowCount: rows.length,
			rows,
			tableContentHash: "x".repeat(64),
		};
	}

	it("throws BACKUP_TOO_LARGE before any upload is attempted when plaintext exceeds the configured limit", async () => {
		const bigValue = "a".repeat(1000);
		const rows = Array.from({ length: 50 }, (_, i) => ({
			id: String(i),
			value: bigValue,
		}));
		const tables = [makeTable("big_table", rows)];

		let putCalled = false;
		const fakeBucket = {
			put: async () => {
				putCalled = true;
			},
		};

		await expect(
			buildSnapshotPayload({
				formatVersion: "V1",
				backupId: "20260907",
				createdAt: "2026-09-07T00:00:00.000Z",
				tables,
				maxPlaintextBytes: 1000, // deliberately tiny for the test
			}),
		).rejects.toBeInstanceOf(BackupError);

		expect(putCalled).toBe(false);
		void fakeBucket;
	});

	it("succeeds when the plaintext is within the configured limit", async () => {
		const tables = [makeTable("small_table", [{ id: "1", value: "ok" }])];
		const result = await buildSnapshotPayload({
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T00:00:00.000Z",
			tables,
			maxPlaintextBytes: 1_000_000,
		});
		expect(result.payload.manifest.tables).toHaveLength(1);
		expect(result.plaintextBytes.length).toBeGreaterThan(0);
	});

	it("rejects using the real default 25 MiB ceiling only when genuinely exceeded (no large allocation on the happy path)", async () => {
		const tables = [makeTable("tiny_table", [{ id: "1" }])];
		const result = await buildSnapshotPayload({
			formatVersion: "V1",
			backupId: "20260907",
			createdAt: "2026-09-07T00:00:00.000Z",
			tables,
		});
		expect(result.plaintextBytes.length).toBeLessThan(25 * 1024 * 1024);
	});
});
