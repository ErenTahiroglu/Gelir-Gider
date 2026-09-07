import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";

/**
 * The deterministic set of tables backed up on every run: EVERY `pgTable`
 * exported from `src/db/schema/index.ts`, discovered by introspecting the
 * schema barrel module itself (never a manually maintained list) so a newly
 * added schema table can never be silently forgotten here -- see
 * `tests/backups-export.test.ts` for the permanent regression test that
 * fails if this registry and the schema barrel's actual exports diverge.
 *
 * There are no Drizzle-managed infrastructure tables to exclude: Drizzle's
 * own migration bookkeeping lives in its internal `drizzle` schema, not
 * `public`, and is never exported from `src/db/schema/index.ts`.
 */
export function discoverBackupTableRegistry(): PgTable[] {
	const tables: PgTable[] = [];
	for (const value of Object.values(schema)) {
		if (is(value, PgTable)) {
			tables.push(value);
		}
	}
	// Sort by SQL table name for a stable, deterministic iteration order.
	tables.sort((a, b) =>
		getTableConfig(a).name.localeCompare(getTableConfig(b).name),
	);
	return tables;
}

export interface BackupTableDescriptor {
	tableName: string;
	table: PgTable;
}

export function getBackupTableDescriptors(): BackupTableDescriptor[] {
	return discoverBackupTableRegistry().map((table) => ({
		tableName: getTableConfig(table).name,
		table,
	}));
}
