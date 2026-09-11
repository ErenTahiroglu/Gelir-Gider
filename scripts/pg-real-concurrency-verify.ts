/**
 * Real PostgreSQL Concurrency Verification for Checkpoint 7B.2-R4.
 *
 * Uses real PostgreSQL (e.g. postgres:16-alpine container in GitHub Actions CI
 * or local PostgreSQL instance) with independent connections to prove:
 * 1. Control and competitor connections have distinct backend PIDs in PostgreSQL.
 * 2. Deterministic pg_locks wait-state barrier: both competitors are objectively
 *    observed waiting on ungranted ledger_accounts locks BEFORE releasing control lock.
 * 3. Concurrent identical create race resolves to 1 row, matching ID, and replay split.
 * 4. Concurrent conflicting create race resolves to 1 row, 1 winner, and typed LEDGER_ACCOUNT_CODE_CONFLICT.
 * 5. No raw 23505 (unique_violation) or 25P02 (in_failed_sql_transaction) escapes.
 * 6. Post-race database usability remains completely healthy.
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

/**
 * Deterministic database-observed wait barrier.
 *
 * Observes pg_locks to verify that BOTH competitor backend PIDs have an
 * ungranted relation lock on ledger_accounts before proceeding.
 *
 * Timeout acts strictly as a watchdog; time passing NEVER satisfies the barrier.
 */
async function waitUntilBothCompetitorsBlockedOnLedgerAccounts(
	controlClient: pg.Client,
	pids: [number, number],
	timeoutMs = 5000,
	pollIntervalMs = 15,
): Promise<{ pidA: number; pidB: number; modes: Record<number, string> }> {
	const [pidA, pidB] = pids;
	const deadline = Date.now() + timeoutMs;
	const modes: Record<number, string> = {};

	while (Date.now() < deadline) {
		const res = await controlClient.query<{ pid: number; mode: string; granted: boolean }>(
			`SELECT pid, mode, granted
			 FROM pg_locks
			 WHERE locktype = 'relation'
			   AND relation = 'ledger_accounts'::regclass
			   AND pid = ANY($1::int[])
			   AND granted = false`,
			[[pidA, pidB]],
		);

		let blockedA = false;
		let blockedB = false;

		for (const row of res.rows) {
			if (Number(row.pid) === pidA) {
				blockedA = true;
				modes[pidA] = row.mode;
			}
			if (Number(row.pid) === pidB) {
				blockedB = true;
				modes[pidB] = row.mode;
			}
		}

		if (blockedA && blockedB) {
			return { pidA, pidB, modes };
		}

		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}

	throw new Error(
		`Deterministic barrier failure: Timed out after ${timeoutMs}ms waiting for both competitors (PIDs: ${pidA}, ${pidB}) to be observed in ungranted lock state on ledger_accounts in pg_locks.`,
	);
}

async function run() {
	console.log("\n== CHECKPOINT 7B.2-R4: REAL POSTGRESQL DETERMINISTIC CONCURRENCY BARRIER ==");

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

	try {
		// Capture and verify backend PIDs
		const getPid = async (client: pg.Client): Promise<number> => {
			const res = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
			return Number(res.rows[0].pid);
		};

		const controlPid = await getPid(controlClient);
		const pidA = await getPid(clientA);
		const pidB = await getPid(clientB);

		console.log(`Backend PIDs: control=${controlPid}, competitorA=${pidA}, competitorB=${pidB}\n`);

		chk(controlPid !== pidA, "7B.2-R4/PID: control PID differs from competitor A PID");
		chk(controlPid !== pidB, "7B.2-R4/PID: control PID differs from competitor B PID");
		chk(pidA !== pidB, "7B.2-R4/PID: competitor A PID differs from competitor B PID");

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
		// 1. REAL PG CONCURRENT IDENTICAL CREATE (WITH DETERMINISTIC WAIT BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 1: Real PG Concurrent Identical Create Race ---");
		// Acquire table lock on control connection
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

		// Wait until BOTH competitor backend sessions are objectively observed waiting on ledger_accounts in pg_locks
		const blockedExact = await waitUntilBothCompetitorsBlockedOnLedgerAccounts(controlClient, [pidA, pidB]);
		ok(
			"7B.2-R4/1: both independent PostgreSQL competitors observed waiting on ledger_accounts before barrier release",
			`(pidA=${blockedExact.pidA} mode=${blockedExact.modes[pidA]}, pidB=${blockedExact.pidB} mode=${blockedExact.modes[pidB]})`,
		);

		// Release lock to trigger simultaneous execution inside PostgreSQL
		await controlClient.query("COMMIT;");

		const [resExactA, resExactB] = await Promise.all([promiseExactA, promiseExactB]);

		eq(resExactA.account.code, "USR_RACE_EXACT", "7B.2-R4/1: competitor A returned stored code USR_RACE_EXACT");
		eq(resExactB.account.code, "USR_RACE_EXACT", "7B.2-R4/1: competitor B returned stored code USR_RACE_EXACT");
		eq(resExactA.account.id, resExactB.account.id, "7B.2-R4/1: both competitors resolved the SAME account ID");
		eq(resExactA.account.normalBalance, "DEBIT", "7B.2-R4/1: derived normalBalance is DEBIT");
		eq(resExactA.account.currency, "TRY", "7B.2-R4/1: derived currency is TRY");

		const exactReplays = [resExactA.idempotentReplay, resExactB.idempotentReplay];
		chk(
			exactReplays.includes(false) && exactReplays.includes(true),
			"7B.2-R4/1: exactly one competitor received idempotentReplay = false and the other idempotentReplay = true",
		);

		const exactRowCount = (
			await controlClient.query(
				"select count(*)::int as n from ledger_accounts where user_id = $1 and code = 'USR_RACE_EXACT'",
				[USER_A],
			)
		).rows[0].n;
		eq(exactRowCount, 1, "7B.2-R4/1: exactly ONE ledger_accounts row exists in PostgreSQL for USR_RACE_EXACT");

		// --------------------------------------------------------------------------
		// 2. REAL PG CONCURRENT CONFLICTING CREATE (WITH DETERMINISTIC WAIT BARRIER)
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

		// Wait until BOTH competitor backend sessions are objectively observed waiting on ledger_accounts in pg_locks
		const blockedConf = await waitUntilBothCompetitorsBlockedOnLedgerAccounts(controlClient, [pidA, pidB]);
		ok(
			"7B.2-R4/2: both independent PostgreSQL competitors observed waiting on ledger_accounts before barrier release",
			`(pidA=${blockedConf.pidA} mode=${blockedConf.modes[pidA]}, pidB=${blockedConf.pidB} mode=${blockedConf.modes[pidB]})`,
		);

		await controlClient.query("COMMIT;");

		const [settledA, settledB] = await Promise.allSettled([promiseConfA, promiseConfB]);

		const fulfilled = [settledA, settledB].find((s) => s.status === "fulfilled") as
			| PromiseFulfilledResult<Awaited<ReturnType<typeof createProductLedgerAccount>>>
			| undefined;
		const rejected = [settledA, settledB].find((s) => s.status === "rejected") as
			| PromiseRejectedResult
			| undefined;

		chk(fulfilled !== undefined, "7B.2-R4/2: exactly one competitor succeeded with fulfillment");
		chk(rejected !== undefined, "7B.2-R4/2: exactly one competitor was rejected");

		if (fulfilled) {
			eq(fulfilled.value.account.code, "USR_RACE_CONF", "7B.2-R4/2: winner resolved stored code USR_RACE_CONF");
			eq(fulfilled.value.idempotentReplay, false, "7B.2-R4/2: winner received idempotentReplay = false");
		}

		if (rejected) {
			chk(rejected.reason instanceof LedgerError, "7B.2-R4/2: loser threw typed LedgerError");
			eq(
				(rejected.reason as LedgerError).code,
				"LEDGER_ACCOUNT_CODE_CONFLICT",
				"7B.2-R4/2: loser threw typed LEDGER_ACCOUNT_CODE_CONFLICT",
			);
			chk(
				!(rejected.reason instanceof pg.DatabaseError),
				"7B.2-R4/2: raw PostgreSQL 23505 / 25P02 did not escape",
			);
		}

		const confRowCount = (
			await controlClient.query(
				"select count(*)::int as n from ledger_accounts where user_id = $1 and code = 'USR_RACE_CONF'",
				[USER_A],
			)
		).rows[0].n;
		eq(confRowCount, 1, "7B.2-R4/2: exactly ONE ledger_accounts row exists in PostgreSQL for USR_RACE_CONF");

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
		eq(postRaceRes.account.code, "USR_POST_RACE_REAL", "7B.2-R4/3: subsequent account creation succeeds as USR_POST_RACE_REAL");
		eq(postRaceRes.idempotentReplay, false, "7B.2-R4/3: subsequent creation is fresh (idempotentReplay = false)");
	} finally {
		// Failure-safe lock and client cleanup
		try {
			await controlClient.query("ROLLBACK;");
		} catch {}
		try {
			await controlClient.end();
		} catch {}
		try {
			await clientA.end();
		} catch {}
		try {
			await clientB.end();
		} catch {}
	}

	console.log(`\nReal PostgreSQL Verification Summary: ${pass} passed, ${fail} failed\n`);
	if (fail > 0) {
		process.exit(1);
	}
}

run().catch((err) => {
	console.error("Real PostgreSQL Concurrency Verification Fatal Error:", err);
	process.exit(1);
});
