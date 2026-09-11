/**
 * Real PostgreSQL Concurrency Verification for Checkpoint 7B.2-R3.
 *
 * Uses real PostgreSQL (e.g. postgres:16-alpine container in GitHub Actions CI
 * or local PostgreSQL instance) with independent connections to prove:
 * 1. Concurrent identical create race resolves to 1 row, matching ID, and replay split.
 * 2. Concurrent conflicting create race resolves to 1 row, 1 winner, and typed LEDGER_ACCOUNT_CODE_CONFLICT.
 * 3. No raw 23505 (unique_violation) or 25P02 (in_failed_sql_transaction) escapes.
 * 4. Post-race database usability remains completely healthy.
 *
 * Run: npm run test:pg:real
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createProductLedgerAccount } from "../src/ledger/product-accounts.ts";
import { LedgerError } from "../src/ledger/errors.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migDir = path.join(root, "migrations");

let pass = 0;
let fail = 0;
const ok = (name: string, extra = "") => {
	pass++;
	console.log(`  ✓ ${name}${extra ? " " + extra : ""}`);
};
const bad = (name: string, extra = "") => {
	fail++;
	console.log(`  ✗ ${name}${extra ? " " + extra : ""}`);
};

const eq = (a: unknown, b: unknown, name: string) =>
	a === b
		? ok(name)
		: bad(name, `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const chk = (c: boolean, name: string) => (c ? ok(name) : bad(name));

async function getMigrationFiles(): Promise<string[]> {
	const { readdirSync } = await import("node:fs");
	const all = readdirSync(migDir)
		.filter((f) => f.endsWith(".sql") && /^\d{4}_/.test(f))
		.sort();
	return all.map((f) => path.join(migDir, f));
}

async function run() {
	console.log("\n== CHECKPOINT 7B.2-R3: REAL POSTGRESQL MULTI-CONNECTION CONCURRENCY PROOF ==");

	const dbUrl =
		process.env.DATABASE_URL ||
		"postgresql://test:test@127.0.0.1:5432/gelirgider_test";

	// Test basic connection
	const testClient = new pg.Client({ connectionString: dbUrl });
	try {
		await testClient.connect();
	} catch (err) {
		if (process.env.CI) {
			console.error(`Fatal: Failed to connect to PostgreSQL service at ${dbUrl} in CI:`, err);
			process.exit(1);
		} else {
			console.log(`\n[INFO] Real PostgreSQL not reachable at ${dbUrl}.`);
			console.log("Skipping local real-PG execution. This verification will run authoritatively in GitHub Actions CI with postgres:16-alpine service.\n");
			process.exit(0);
		}
	}

	const versionRes = await testClient.query("SELECT version()");
	console.log(`Connected to: ${versionRes.rows[0].version}\n`);

	// Apply migrations
	console.log("Applying committed migration chain 0000..0071...");
	const migFiles = await getMigrationFiles();
	for (const migPath of migFiles) {
		const sqlContent = readFileSync(migPath, "utf-8");
		// Split by statement-breakpoint if present, or execute
		const statements = sqlContent
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		for (const statement of statements) {
			await testClient.query(statement);
		}
	}
	console.log(`Applied ${migFiles.length} migration files successfully.\n`);
	await testClient.end();

	// Establish 3 independent PostgreSQL connections:
	// - controlClient: barrier synchronization via table locking
	// - clientA: Competitor A
	// - clientB: Competitor B
	const controlClient = new pg.Client({ connectionString: dbUrl });
	const clientA = new pg.Client({ connectionString: dbUrl });
	const clientB = new pg.Client({ connectionString: dbUrl });

	await controlClient.connect();
	await clientA.connect();
	await clientB.connect();

	// biome-ignore lint/suspicious/noExplicitAny: node-postgres drizzle adapter
	const dbA = drizzle(clientA as any) as any;
	// biome-ignore lint/suspicious/noExplicitAny: node-postgres drizzle adapter
	const dbB = drizzle(clientB as any) as any;

	const USER_A = "11111111-1111-4111-8111-111111111111";

	// Seed user A
	await controlClient.query(
		"insert into users (id, display_name, currency, timezone, auth_initialized_at) values ($1, 'Real PG User', 'TRY', 'Europe/Istanbul', now()) ON CONFLICT (singleton_key) DO NOTHING",
		[USER_A],
	);

	// --------------------------------------------------------------------------
	// 1. REAL PG CONCURRENT IDENTICAL CREATE
	// --------------------------------------------------------------------------
	console.log("--- Test 1: Real PG Concurrent Identical Create Race ---");
	// Acquire table lock on control connection to guarantee both competitors start simultaneously
	await controlClient.query("BEGIN; LOCK TABLE ledger_accounts IN EXCLUSIVE MODE;");

	const promiseExactA = createProductLedgerAccount({
		db: dbA,
		userId: USER_A,
		code: "RACE_EXACT",
		name: "Concurrent Exact Account",
		accountType: "ASSET",
	});

	const promiseExactB = createProductLedgerAccount({
		db: dbB,
		userId: USER_A,
		code: "RACE_EXACT",
		name: "Concurrent Exact Account",
		accountType: "ASSET",
	});

	// Small delay to let both worker connections dispatch their queries and wait on the lock
	await new Promise((r) => setTimeout(r, 50));

	// Release lock to trigger simultaneous execution inside PostgreSQL
	await controlClient.query("COMMIT;");

	const [resExactA, resExactB] = await Promise.all([promiseExactA, promiseExactB]);

	eq(resExactA.account.code, "USR_RACE_EXACT", "7B.2-R3/1: competitor A returned stored code USR_RACE_EXACT");
	eq(resExactB.account.code, "USR_RACE_EXACT", "7B.2-R3/1: competitor B returned stored code USR_RACE_EXACT");
	eq(resExactA.account.id, resExactB.account.id, "7B.2-R3/1: both competitors resolved the SAME account ID");
	eq(resExactA.account.normalBalance, "DEBIT", "7B.2-R3/1: derived normalBalance is DEBIT");
	eq(resExactA.account.currency, "TRY", "7B.2-R3/1: derived currency is TRY");

	const exactReplays = [resExactA.idempotentReplay, resExactB.idempotentReplay];
	chk(
		exactReplays.includes(false) && exactReplays.includes(true),
		"7B.2-R3/1: exactly one competitor received idempotentReplay = false and the other idempotentReplay = true",
	);

	const exactRowCount = (
		await controlClient.query(
			"select count(*)::int as n from ledger_accounts where user_id = $1 and code = 'USR_RACE_EXACT'",
			[USER_A],
		)
	).rows[0].n;
	eq(exactRowCount, 1, "7B.2-R3/1: exactly ONE ledger_accounts row exists in PostgreSQL for USR_RACE_EXACT");

	// --------------------------------------------------------------------------
	// 2. REAL PG CONCURRENT CONFLICTING CREATE
	// --------------------------------------------------------------------------
	console.log("\n--- Test 2: Real PG Concurrent Conflicting Create Race ---");
	await controlClient.query("BEGIN; LOCK TABLE ledger_accounts IN EXCLUSIVE MODE;");

	const promiseConfA = createProductLedgerAccount({
		db: dbA,
		userId: USER_A,
		code: "RACE_CONF",
		name: "Definition Alpha",
		accountType: "ASSET",
	});

	const promiseConfB = createProductLedgerAccount({
		db: dbB,
		userId: USER_A,
		code: "RACE_CONF",
		name: "Definition Beta",
		accountType: "ASSET",
	});

	await new Promise((r) => setTimeout(r, 50));
	await controlClient.query("COMMIT;");

	const [settledA, settledB] = await Promise.allSettled([promiseConfA, promiseConfB]);

	const fulfilled = [settledA, settledB].find((s) => s.status === "fulfilled") as
		| PromiseFulfilledResult<Awaited<ReturnType<typeof createProductLedgerAccount>>>
		| undefined;
	const rejected = [settledA, settledB].find((s) => s.status === "rejected") as
		| PromiseRejectedResult
		| undefined;

	chk(fulfilled !== undefined, "7B.2-R3/2: exactly one competitor succeeded with fulfillment");
	chk(rejected !== undefined, "7B.2-R3/2: exactly one competitor was rejected");

	if (fulfilled) {
		eq(fulfilled.value.account.code, "USR_RACE_CONF", "7B.2-R3/2: winner resolved stored code USR_RACE_CONF");
		eq(fulfilled.value.idempotentReplay, false, "7B.2-R3/2: winner received idempotentReplay = false");
	}

	if (rejected) {
		chk(rejected.reason instanceof LedgerError, "7B.2-R3/2: loser threw typed LedgerError");
		eq(
			(rejected.reason as LedgerError).code,
			"LEDGER_ACCOUNT_CODE_CONFLICT",
			"7B.2-R3/2: loser threw typed LEDGER_ACCOUNT_CODE_CONFLICT",
		);
		chk(
			!(rejected.reason instanceof pg.DatabaseError),
			"7B.2-R3/2: raw PostgreSQL 23505 / 25P02 did not escape",
		);
	}

	const confRowCount = (
		await controlClient.query(
			"select count(*)::int as n from ledger_accounts where user_id = $1 and code = 'USR_RACE_CONF'",
			[USER_A],
		)
	).rows[0].n;
	eq(confRowCount, 1, "7B.2-R3/2: exactly ONE ledger_accounts row exists in PostgreSQL for USR_RACE_CONF");

	// --------------------------------------------------------------------------
	// 3. POST-RACE DATABASE USABILITY
	// --------------------------------------------------------------------------
	console.log("\n--- Test 3: Post-Race Database Usability ---");
	const postRaceRes = await createProductLedgerAccount({
		db: dbA,
		userId: USER_A,
		code: "POST_RACE_REAL",
		name: "Post Race Usable Account",
		accountType: "ASSET",
	});
	eq(postRaceRes.account.code, "USR_POST_RACE_REAL", "7B.2-R3/3: subsequent account creation succeeds as USR_POST_RACE_REAL");
	eq(postRaceRes.idempotentReplay, false, "7B.2-R3/3: subsequent creation is fresh (idempotentReplay = false)");

	await controlClient.end();
	await clientA.end();
	await clientB.end();

	console.log(`\nReal PostgreSQL Verification Summary: ${pass} passed, ${fail} failed\n`);
	if (fail > 0) {
		process.exit(1);
	}
}

run().catch((err) => {
	console.error("Unexpected failure in real PostgreSQL concurrency verification:", err);
	process.exit(1);
});
