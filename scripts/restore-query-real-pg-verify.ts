/**
 * Real PostgreSQL regression for scripts/restore-backup.ts `fetchActualShapes`.
 *
 * The previous `table_name = ANY(${tableNames})` form made Drizzle emit a ROW
 * constructor `($1, $2, ...)`, which real PostgreSQL rejects. This script is
 * READ-ONLY (information_schema only) and expects a migrated database.
 *
 * Run: npm run test:pg:real (after the concurrency verification applied migrations)
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { fetchActualShapes } from "./restore-backup.ts";

function assert(cond: unknown, msg: string): void {
	if (!cond) {
		throw new Error(`ASSERTION FAILED: ${msg}`);
	}
	console.log(`  PASS: ${msg}`);
}

async function run() {
	console.log("\n== RESTORE QUERY: REAL POSTGRESQL fetchActualShapes ==");
	const dbUrl =
		process.env.DATABASE_URL ||
		"postgresql://test:test@127.0.0.1:5432/gelirgider_test";
	const client = new pg.Client({ connectionString: dbUrl });
	try {
		await client.connect();
	} catch (err) {
		if (process.env.CI) {
			console.error("Real PostgreSQL unreachable in CI.");
			process.exit(1);
		}
		console.log("[INFO] Real PostgreSQL not reachable; skipping locally.");
		process.exit(0);
	}
	const db = drizzle(client);

	const names = ["users", "webauthn_credentials", "backup_runs"];
	const shapes = await fetchActualShapes(db, names);
	assert(shapes.length === 3, "returns one descriptor per requested table");
	assert(
		shapes.map((s) => s.tableName).join() === names.join(),
		"descriptor order follows request order",
	);
	for (const s of shapes) {
		assert(s.columns.length > 0, `${s.tableName} has live columns`);
		assert(s.columns.includes("id"), `${s.tableName} exposes column id`);
	}
	const users = shapes[0];
	assert(users?.columns.includes("created_at") === true, "users.created_at present");

	const missing = await fetchActualShapes(db, ["users", "no_such_table"]);
	assert(
		missing[1]?.columns.length === 0 && (missing[0]?.columns.length ?? 0) > 0,
		"unknown table yields empty columns, known table unaffected",
	);

	assert(
		(await fetchActualShapes(db, [])).length === 0,
		"empty list is handled without invalid IN ()",
	);

	const hostile = "x'); DROP TABLE users; --";
	const h = await fetchActualShapes(db, [hostile, "users"]);
	assert(h[0]?.columns.length === 0, "hostile name matches nothing (parameterized)");
	const still = await client.query(
		"SELECT to_regclass('public.users') IS NOT NULL AS ok",
	);
	assert(still.rows[0].ok === true, "users table survives hostile name");

	await client.end();
	console.log("\nRESTORE QUERY REAL-PG VERIFICATION PASSED\n");
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
