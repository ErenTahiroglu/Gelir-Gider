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
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createProductLedgerAccount } from "../src/ledger/product-accounts.ts";
import { LedgerError } from "../src/ledger/errors.ts";
import {
	createRewardAccount,
	getRewardAccount,
} from "../src/rewards/accounts.ts";
import {
	recordRewardOpeningBalance,
	recordRewardAdjustmentDebit,
	recordRewardEarn,
} from "../src/rewards/events.ts";
import { RewardError } from "../src/rewards/errors.ts";
import { createCreditCard } from "../src/credit-cards/service.ts";
import { recordCreditCardPurchase } from "../src/credit-cards/purchases.ts";
import {
	createCampaignPeriod,
	confirmCampaignPeriod,
	confirmCampaignRewardCredited,
	resolveActiveCampaignRewardCreditInTransaction,
} from "../src/campaigns/service.ts";
import { CampaignError } from "../src/campaigns/errors.ts";
import { getCampaignProgressInTransaction } from "../src/campaigns/progress.ts";
import { createLedgerAccount } from "../src/ledger/accounts.ts";
import { postJournalEntry } from "../src/ledger/posting.ts";
import {
	createMidasAccount,
	createMidasBucket,
	createMidasAllocationTransfer,
	getMidasLiquidityState,
} from "../src/midas/service.ts";
import { MidasError } from "../src/midas/errors.ts";
import {
	allocateLongTermInvestment,
	markLongTermInvestmentSent,
	getLongTermInvestmentTask,
} from "../src/long-term/service.ts";
import { LongTermError } from "../src/long-term/errors.ts";
import {
	previewMonthClose,
	closeMonth,
	getMonthClose,
} from "../src/month-close/service.ts";
import { MonthCloseError } from "../src/month-close/errors.ts";
import {
	createShortTermGoal,
	updateShortTermGoal,
	cancelShortTermGoal,
	completeShortTermGoal,
	getShortTermGoal,
} from "../src/short-term-goals/service.ts";
import { ShortTermGoalError } from "../src/short-term-goals/errors.ts";
import { recordPostCloseAdjustmentIfClosedInTransaction } from "../src/month-close/service.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migDir = path.join(root, "migrations");

let pass = 0;
let fail = 0;
const logOut = (msg: string) => {
	console.log(msg);
	if (process.env.GITHUB_STEP_SUMMARY) {
		try {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, msg + "\n");
		} catch {}
	}
};
const ok = (name: string, extra = "") => {
	pass++;
	logOut(`  ✓ ${name}${extra ? " " + extra : ""}`);
};
const bad = (name: string, extra = "") => {
	fail++;
	logOut(`  ✗ ${name}${extra ? " " + extra : ""}`);
};

const eq = (a: unknown, b: unknown, name: string) =>
	a === b
		? ok(name)
		: bad(name, `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const chk = (c: boolean, name: string) => (c ? ok(name) : bad(name));

/**
 * Deterministic database-observed wait barrier.
 *
 * Observes pg_locks to verify that BOTH competitor backend PIDs have an
 * ungranted relation lock on the specified relation before proceeding.
 *
 * Timeout acts strictly as a watchdog; time passing NEVER satisfies the barrier.
 */
async function waitUntilBothCompetitorsBlockedOnRelation(
	controlClient: pg.Client,
	relationName: string,
	pids: [number, number],
	timeoutMs = 15000,
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
			   AND relation = $1::regclass
			   AND pid = ANY($2::int[])
			   AND granted = false`,
			[relationName, [pidA, pidB]],
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
		`Deterministic barrier failure: Timed out after ${timeoutMs}ms waiting for both competitors (PIDs: ${pidA}, ${pidB}) to be observed in ungranted lock state on ${relationName} in pg_locks.`,
	);
}

async function waitUntilBothCompetitorsBlockedOnLedgerAccounts(
	controlClient: pg.Client,
	pids: [number, number],
	timeoutMs = 15000,
	pollIntervalMs = 15,
): Promise<{ pidA: number; pidB: number; modes: Record<number, string> }> {
	return waitUntilBothCompetitorsBlockedOnRelation(
		controlClient,
		"ledger_accounts",
		pids,
		timeoutMs,
		pollIntervalMs,
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
		await Promise.race([
			testClient.connect(),
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error(`Connection timed out after 2000ms connecting to ${dbUrl}`)), 2000),
			),
		]);
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
	const journal = JSON.parse(
		readFileSync(path.join(migDir, "meta/_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string }[] };
	console.log(`Applying committed migration chain 0000..${journal.entries[journal.entries.length - 1]?.tag.slice(0, 4)}...`);
	for (const entry of journal.entries) {
		const raw = readFileSync(path.join(migDir, `${entry.tag}.sql`), "utf8");
		for (const chunk of raw.split(/-->\s*statement-breakpoint/)) {
			const stmt = chunk.trim();
			if (!stmt) continue;
			try {
				await testClient.query(stmt);
			} catch (e) {
				console.error(`Migration ${entry.tag} failed on statement: ${stmt.slice(0, 300)}`);
				throw e;
			}
		}
	}
	console.log(`Applied ${journal.entries.length} migration files successfully.\n`);
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
		// 3. POST-RACE DATABASE USABILITY (LEDGER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 3: Post-Race Database Usability (Ledger) ---");
		const postRaceRes = await createProductLedgerAccount({
			db: dbA,
			userId: USER_A,
			code: "POST_RACE_REAL",
			name: "Post Race Usable Account",
			accountType: "ASSET",
		});
		eq(postRaceRes.account.code, "USR_POST_RACE_REAL", "7B.2-R4/3: subsequent account creation succeeds as USR_POST_RACE_REAL");
		eq(postRaceRes.idempotentReplay, false, "7B.2-R4/3: subsequent creation is fresh (idempotentReplay = false)");

		// --------------------------------------------------------------------------
		// 4. REAL PG REWARDS POINT-BALANCE CONCURRENCY RACE (DETERMINISTIC BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 4: Real PG Rewards Point-Balance Concurrency Race ---");
		// Create an active reward account with initial balance = 100.0000 points
		const raceRewAcc = await createRewardAccount({
			db: dbA,
			userId: USER_A,
			code: "RACE_POINT_ACC",
			displayName: "Race Point Account",
			provider: "Test Bank",
			unitName: "Points",
			occurredAt: new Date(),
			idempotencyKey: "race-rew-acc-init",
		});
		const rewardAccountId = raceRewAcc.account.rewardAccountId;
		eq(raceRewAcc.account.code, "RACE_POINT_ACC", "7B.5-R1/4: Reward account created with code RACE_POINT_ACC");

		await recordRewardOpeningBalance({
			db: dbA,
			userId: USER_A,
			rewardAccountId,
			pointAmount: "100.0000",
			occurredAt: new Date(),
			idempotencyKey: "race-rew-ob-init",
		});

		const initAcc = await getRewardAccount({ db: dbA, userId: USER_A, rewardAccountId });
		eq(initAcc?.balancePoints, "100.0000", "7B.5-R1/4: Initial reward account point balance is 100.0000");

		// Acquire exclusive table lock on reward_accounts via control connection
		await controlClient.query("BEGIN; LOCK TABLE reward_accounts IN EXCLUSIVE MODE;");

		const promiseDebitA = recordRewardAdjustmentDebit({
			db: dbA,
			userId: USER_A,
			rewardAccountId,
			pointAmount: "80.0000",
			reasonNote: "Concurrent debit race A",
			occurredAt: new Date(),
			idempotencyKey: "race-debit-a",
		});

		const promiseDebitB = recordRewardAdjustmentDebit({
			db: dbB,
			userId: USER_A,
			rewardAccountId,
			pointAmount: "80.0000",
			reasonNote: "Concurrent debit race B",
			occurredAt: new Date(),
			idempotencyKey: "race-debit-b",
		});

		// Wait until BOTH competitor backend sessions are objectively observed waiting on reward_accounts in pg_locks
		const blockedDebits = await waitUntilBothCompetitorsBlockedOnRelation(
			controlClient,
			"reward_accounts",
			[pidA, pidB],
		);
		ok(
			"7B.5-R1/4: both independent PostgreSQL competitors observed waiting on reward_accounts before barrier release",
			`(pidA=${blockedDebits.pidA} mode=${blockedDebits.modes[pidA]}, pidB=${blockedDebits.pidB} mode=${blockedDebits.modes[pidB]})`,
		);

		// Release lock to trigger simultaneous execution inside PostgreSQL
		await controlClient.query("COMMIT;");

		const [settledDebitA, settledDebitB] = await Promise.allSettled([promiseDebitA, promiseDebitB]);

		const fulfilledDebit = [settledDebitA, settledDebitB].find((s) => s.status === "fulfilled") as
			| PromiseFulfilledResult<Awaited<ReturnType<typeof recordRewardAdjustmentDebit>>>
			| undefined;
		const rejectedDebit = [settledDebitA, settledDebitB].find((s) => s.status === "rejected") as
			| PromiseRejectedResult
			| undefined;

		chk(fulfilledDebit !== undefined, "7B.5-R1/4: exactly one competitor succeeded with debit fulfillment");
		chk(rejectedDebit !== undefined, "7B.5-R1/4: exactly one competitor was rejected");

		if (fulfilledDebit) {
			eq(fulfilledDebit.value.event.eventType, "ADJUSTMENT_DEBIT", "7B.5-R1/4: winner created ADJUSTMENT_DEBIT event");
			eq(fulfilledDebit.value.event.signedPointEffect, "-80.0000", "7B.5-R1/4: winner signedPointEffect is -80.0000");
			eq(fulfilledDebit.value.idempotentReplay, false, "7B.5-R1/4: winner idempotentReplay = false");
		}

		if (rejectedDebit) {
			chk(rejectedDebit.reason instanceof RewardError, "7B.5-R1/4: loser threw typed RewardError");
			eq(
				(rejectedDebit.reason as RewardError).code,
				"REWARD_INSUFFICIENT_POINTS",
				"7B.5-R1/4: loser threw typed REWARD_INSUFFICIENT_POINTS",
			);
			chk(
				!(rejectedDebit.reason instanceof pg.DatabaseError),
				"7B.5-R1/4: raw PostgreSQL 23505 / 25P02 did not escape",
			);
		}

		// Verify final derived balance in PostgreSQL is exactly 20.0000
		const finalAcc = await getRewardAccount({ db: dbA, userId: USER_A, rewardAccountId });
		eq(finalAcc?.balancePoints, "20.0000", "7B.5-R1/4: final derived point balance in PostgreSQL is exactly 20.0000");

		// Verify event row count: 1 OPENING_BALANCE + 1 ADJUSTMENT_DEBIT = 2 events (loser created zero rows)
		const eventRowCount = (
			await controlClient.query(
				"select count(*)::int as n from reward_events where reward_account_id = $1",
				[rewardAccountId],
			)
		).rows[0].n;
		eq(eventRowCount, 2, "7B.5-R1/4: exactly TWO reward_events rows exist (1 opening + 1 winner debit, 0 loser partial rows)");

		// Verify post-race database usability for Rewards
		console.log("\n--- Test 4b: Post-Race Rewards Usability ---");
		const followUpEarn = await recordRewardEarn({
			db: dbA,
			userId: USER_A,
			rewardAccountId,
			pointAmount: "50.0000",
			reasonNote: "Post-race earn event",
			occurredAt: new Date(),
			idempotencyKey: "race-follow-up-earn",
		});
		eq(followUpEarn.event.signedPointEffect, "50.0000", "7B.5-R1/4: follow-up earn creates event with 50.0000 points");
		const usableAcc = await getRewardAccount({ db: dbA, userId: USER_A, rewardAccountId });
		eq(usableAcc?.balancePoints, "70.0000", "7B.5-R1/4: subsequent earn succeeds and balance becomes 70.0000");

		// --------------------------------------------------------------------------
		// 5. REAL PG REWARDS DUPLICATE ACCOUNT CODE RACE (DETERMINISTIC BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 5: Real PG Rewards Duplicate Account Code Race ---");
		await controlClient.query("BEGIN; LOCK TABLE reward_accounts IN EXCLUSIVE MODE;");

		const promiseCodeA = createRewardAccount({
			db: dbA,
			userId: USER_A,
			code: "RACE_CODE_DUP",
			displayName: "Definition Alpha",
			provider: "Bank Alpha",
			unitName: "Points",
			occurredAt: new Date(),
			idempotencyKey: "idemp-code-dup-a",
		});

		const promiseCodeB = createRewardAccount({
			db: dbB,
			userId: USER_A,
			code: "RACE_CODE_DUP",
			displayName: "Definition Beta",
			provider: "Bank Beta",
			unitName: "Points",
			occurredAt: new Date(),
			idempotencyKey: "idemp-code-dup-b",
		});

		const blockedCodes = await waitUntilBothCompetitorsBlockedOnRelation(
			controlClient,
			"reward_accounts",
			[pidA, pidB],
		);
		ok(
			"7B.5-R1/5: both independent PostgreSQL competitors observed waiting on reward_accounts before barrier release",
			`(pidA=${blockedCodes.pidA} mode=${blockedCodes.modes[pidA]}, pidB=${blockedCodes.modes[pidB]})`,
		);

		await controlClient.query("COMMIT;");

		const [settledCodeA, settledCodeB] = await Promise.allSettled([promiseCodeA, promiseCodeB]);

		const fulfilledCode = [settledCodeA, settledCodeB].find((s) => s.status === "fulfilled") as
			| PromiseFulfilledResult<Awaited<ReturnType<typeof createRewardAccount>>>
			| undefined;
		const rejectedCode = [settledCodeA, settledCodeB].find((s) => s.status === "rejected") as
			| PromiseRejectedResult
			| undefined;

		chk(fulfilledCode !== undefined, "7B.5-R1/5: exactly one competitor succeeded with account creation");
		chk(rejectedCode !== undefined, "7B.5-R1/5: exactly one competitor was rejected with code conflict");

		if (fulfilledCode) {
			eq(fulfilledCode.value.account.code, "RACE_CODE_DUP", "7B.5-R1/5: winner created account RACE_CODE_DUP");
			eq(fulfilledCode.value.idempotentReplay, false, "7B.5-R1/5: winner idempotentReplay = false");
		}

		if (rejectedCode) {
			chk(rejectedCode.reason instanceof RewardError, "7B.5-R1/5: loser threw typed RewardError");
			eq(
				(rejectedCode.reason as RewardError).code,
				"REWARD_ACCOUNT_CONFLICT",
				"7B.5-R1/5: loser threw typed REWARD_ACCOUNT_CONFLICT",
			);
			chk(
				!(rejectedCode.reason instanceof pg.DatabaseError),
				"7B.5-R1/5: raw PostgreSQL 23505 / 25P02 did not escape",
			);
		}

		const codeRowCount = (
			await controlClient.query(
				"select count(*)::int as n from reward_accounts where user_id = $1 and code = 'RACE_CODE_DUP'",
				[USER_A],
			)
		).rows[0].n;
		eq(codeRowCount, 1, "7B.5-R1/5: exactly ONE reward_accounts row exists in PostgreSQL for RACE_CODE_DUP");

		// --------------------------------------------------------------------------
		// 6. REAL PG CAMPAIGN REWARD-CONFIRM RACE (DETERMINISTIC BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 6: Real PG Campaign Reward-Confirm Race ---");

		// Set up prerequisite: active reward account, credit card, and qualifying purchase
		const campRewardAcc = await createRewardAccount({
			db: dbA,
			userId: USER_A,
			code: "CAMP_RACE_REW_ACC",
			displayName: "Campaign Race Reward Account",
			provider: "Bank Alpha",
			unitName: "Points",
			occurredAt: new Date(),
			idempotencyKey: "camp-race-rew-acc",
		});

		const campCard = await createCreditCard({
			db: dbA,
			userId: USER_A,
			code: "CARD_CAMP_RACE",
			displayName: "Campaign Race Card",
			issuer: "Bank Alpha",
			lastFour: "4321",
			creditLimit: "10000.00",
			statementDay: 25,
			dueDay: 5,
			occurredAt: new Date("2026-09-01T00:00:00Z"),
			idempotencyKey: "camp-race-card",
		});

		// Record qualifying purchase of 250.00 on 2026-09-10
		await recordCreditCardPurchase({
			db: dbA,
			userId: USER_A,
			cardId: campCard.cardId,
			amount: "250.00",
			merchant: "Race Merchant",
			description: "Qualifying spend",
			purchaseCategory: "DISCRETIONARY_SPEND",
			occurredAt: new Date("2026-09-10T12:00:00Z"),
			idempotencyKey: "camp-race-purchase-1",
		});

		// Create and confirm ACTIVE TOTAL_SPEND campaign with target 200.00 -> expected 1000.0000 points
		const campCreated = await createCampaignPeriod({
			db: dbA,
			userId: USER_A,
			provider: "Bank Alpha",
			familyKey: "CAMP_RACE_FAMILY",
			periodKey: "2026-09",
			title: "Real PG Race Campaign",
			startsOn: "2026-09-01",
			endsOn: "2026-09-30",
			ruleMode: "TOTAL_SPEND",
			targetSpendAmount: "200.00",
			rewardKind: "REWARD_POINTS",
			rewardAccountId: campRewardAcc.account.rewardAccountId,
			expectedRewardPoints: "1000.0000",
			merchantScopeMode: "ALL_MERCHANTS",
			cardIds: [campCard.cardId],
			occurredAt: new Date("2026-09-01T08:00:00Z"),
			idempotencyKey: "camp-race-create",
		});

		const campConfirmed = await confirmCampaignPeriod({
			db: dbA,
			userId: USER_A,
			campaignPeriodId: campCreated.campaignPeriodId,
			expectedRevisionNo: 1,
			note: "Confirm for race",
			occurredAt: new Date("2026-09-01T08:30:00Z"),
			idempotencyKey: "camp-race-confirm",
		});

		eq(campConfirmed.lifecycleStatus, "ACTIVE", "7B.6/6: campaign confirmed to ACTIVE");

		// Acquire table lock in control session to hold competitors
		await controlClient.query("BEGIN; LOCK TABLE campaign_periods IN EXCLUSIVE MODE;");

		const promiseCampRewardA = confirmCampaignRewardCredited({
			db: dbA,
			userId: USER_A,
			campaignPeriodId: campConfirmed.campaignPeriodId,
			actualPointAmount: "1000.0000",
			occurredAt: new Date(),
			idempotencyKey: "camp-race-reward-key-a",
		});

		const promiseCampRewardB = confirmCampaignRewardCredited({
			db: dbB,
			userId: USER_A,
			campaignPeriodId: campConfirmed.campaignPeriodId,
			actualPointAmount: "1000.0000",
			occurredAt: new Date(),
			idempotencyKey: "camp-race-reward-key-b",
		});

		const blockedCampaigns = await waitUntilBothCompetitorsBlockedOnRelation(
			controlClient,
			"campaign_periods",
			[pidA, pidB],
		);
		ok(
			"7B.6/6: both independent PostgreSQL competitors observed waiting on campaign_periods before barrier release",
			`(pidA=${blockedCampaigns.pidA} mode=${blockedCampaigns.modes[pidA]}, pidB=${blockedCampaigns.modes[pidB]})`,
		);

		// Release barrier
		await controlClient.query("COMMIT;");

		const [settledCampA, settledCampB] = await Promise.allSettled([
			promiseCampRewardA,
			promiseCampRewardB,
		]);

		const fulfilledCamp = [settledCampA, settledCampB].find((s) => s.status === "fulfilled") as
			| PromiseFulfilledResult<Awaited<ReturnType<typeof confirmCampaignRewardCredited>>>
			| undefined;
		const rejectedCamp = [settledCampA, settledCampB].find((s) => s.status === "rejected") as
			| PromiseRejectedResult
			| undefined;

		chk(fulfilledCamp !== undefined, "7B.6/6: exactly one competitor succeeded with campaign reward confirm");
		chk(rejectedCamp !== undefined, "7B.6/6: exactly one competitor was rejected");

		if (fulfilledCamp) {
			eq(fulfilledCamp.value.operation, "CREATE", "7B.6/6: winner created reward credit operation CREATE");
			eq(fulfilledCamp.value.actualPointAmount, "1000.0000", "7B.6/6: winner credited actualPointAmount 1000.0000");
			eq(fulfilledCamp.value.revisionNo, 1, "7B.6/6: winner revisionNo = 1");
		}

		if (rejectedCamp) {
			chk(rejectedCamp.reason instanceof CampaignError, "7B.6/6: loser threw typed CampaignError");
			eq(
				(rejectedCamp.reason as CampaignError).code,
				"CAMPAIGN_NOT_QUALIFIED",
				"7B.6/6: loser threw typed CAMPAIGN_NOT_QUALIFIED (re-evaluation after winner commit)",
			);
			chk(
				!(rejectedCamp.reason instanceof pg.DatabaseError),
				"7B.6/6: raw PostgreSQL 23505 / 25P02 did not escape",
			);
		}

		// Exact-once assertions in PostgreSQL
		const creditRowCount = (
			await controlClient.query(
				"select count(*)::int as n from campaign_reward_credits where campaign_period_id = $1",
				[campConfirmed.campaignPeriodId],
			)
		).rows[0].n;
		eq(creditRowCount, 1, "7B.6/6: exactly ONE campaign_reward_credits row exists");

		const creditRevRowCount = (
			await controlClient.query(
				"select count(*)::int as n from campaign_reward_credit_revisions where credit_id = $1",
				[fulfilledCamp?.value.creditId],
			)
		).rows[0].n;
		eq(creditRevRowCount, 1, "7B.6/6: exactly ONE campaign_reward_credit_revisions row exists");

		const rewardEventRowCount = (
			await controlClient.query(
				"select count(*)::int as n from reward_event_revisions where source_type = 'CAMPAIGN' and source_ref = $1",
				[campConfirmed.campaignPeriodId],
			)
		).rows[0].n;
		eq(rewardEventRowCount, 1, "7B.6/6: exactly ONE CAMPAIGN-owned reward_event_revisions row exists");

		const finalRewAcc = await getRewardAccount({
			db: dbA,
			userId: USER_A,
			rewardAccountId: campRewardAcc.account.rewardAccountId,
		});
		eq(finalRewAcc?.balancePoints, "1000.0000", "7B.6/6: reward account balance is exactly 1000.0000 points");

		const activeCredit = await dbA.transaction((tx) =>
			resolveActiveCampaignRewardCreditInTransaction(tx, campConfirmed.campaignPeriodId),
		);
		chk(activeCredit !== null, "7B.6/6: active credit resolver returns 1 active credit");
		eq(activeCredit?.actualPointAmount, "1000.0000", "7B.6/6: active credit amount is 1000.0000");

		// Post-race DB usability: execute read progress on campaign
		const progressAfterRace = await dbA.transaction((tx) =>
			getCampaignProgressInTransaction(
				tx,
				USER_A,
				campConfirmed.campaignPeriodId,
			),
		);
		eq(progressAfterRace.qualificationStatus, "REWARD_CREDITED", "7B.6/6: post-race progress is REWARD_CREDITED and DB is healthy");

		// --------------------------------------------------------------------------
		// 7. REAL PG MIDAS OVERSPEND ALLOCATION TRANSFER RACE (DETERMINISTIC BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 7: Real PG Midas Overspend Allocation Transfer Race ---");
		let midasAccSetupId = "";
		try {
			// Create dedicated asset and equity accounts for Midas test
			const midasLedgerAcc = await createLedgerAccount({
				db: dbA,
				userId: USER_A,
				code: "MIDAS_RACE_ASSET",
				name: "Midas Race Asset",
				accountType: "ASSET",
			});
			const midasEquityAcc = await createLedgerAccount({
				db: dbA,
				userId: USER_A,
				code: "MIDAS_RACE_EQUITY",
				name: "Midas Race Equity",
				accountType: "EQUITY",
			});
			// Post exactly 100.00 TRY to Midas Checking Account
			await postJournalEntry({
				db: dbA,
				userId: USER_A,
				occurredAt: new Date("2026-09-01T00:00:00Z"),
				memo: "Opening Midas race balance",
				idempotencyKey: "midas-race-init-post",
				lines: [
					{ accountId: midasLedgerAcc.id, side: "DEBIT", amount: "100.00" },
					{ accountId: midasEquityAcc.id, side: "CREDIT", amount: "100.00" },
				],
			});

			// Setup Midas Account
			const midasAccSetup = await createMidasAccount({
				db: dbA,
				userId: USER_A,
				ledgerAccountId: midasLedgerAcc.id,
			});
			midasAccSetupId = midasAccSetup.id;
			eq(midasAccSetup.ledgerAccountId, midasLedgerAcc.id, "7B.7/7: Midas account created with ledgerAccountId");

			// Create dedicated bucket for user transfer
			const midasRaceBucket = await createMidasBucket({
				db: dbA,
				userId: USER_A,
				midasAccountId: midasAccSetup.id,
				code: "RACE_BUCKET",
				name: "Race Bucket",
				bucketType: "SHORT_TERM_GOAL",
			});

			const initialLiquidity = await getMidasLiquidityState({ db: dbA, userId: USER_A });
			eq(initialLiquidity.unallocatedBalance, "100.00", "7B.7/7: initial unallocatedBalance is 100.00");
			eq(initialLiquidity.totalEarmarked, "0.00", "7B.7/7: initial totalEarmarked is 0.00");

			// Hold lock on midas_accounts via control connection
			await controlClient.query("BEGIN; LOCK TABLE midas_accounts IN ACCESS EXCLUSIVE MODE;");

			const promiseMidasA = createMidasAllocationTransfer({
				db: dbA,
				userId: USER_A,
				midasAccountId: midasAccSetup.id,
				toBucketId: midasRaceBucket.id,
				amount: "80.00",
				occurredAt: new Date(),
				idempotencyKey: "midas-race-key-a",
			});

			const promiseMidasB = createMidasAllocationTransfer({
				db: dbB,
				userId: USER_A,
				midasAccountId: midasAccSetup.id,
				toBucketId: midasRaceBucket.id,
				amount: "80.00",
				occurredAt: new Date(),
				idempotencyKey: "midas-race-key-b",
			});

			// Wait until BOTH competitor backend sessions are objectively observed waiting on midas_accounts in pg_locks
			const blockedMidas = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"midas_accounts",
				[pidA, pidB],
			);
			ok(
				"7B.7/7: both independent PostgreSQL competitors observed waiting on midas_accounts before barrier release",
				`(pidA=${blockedMidas.pidA} mode=${blockedMidas.modes[pidA]}, pidB=${blockedMidas.pidB} mode=${blockedMidas.modes[pidB]})`,
			);

			// Release barrier
			await controlClient.query("COMMIT;");

			const [settledMidasA, settledMidasB] = await Promise.allSettled([
				promiseMidasA,
				promiseMidasB,
			]);

			const fulfilledMidas = [settledMidasA, settledMidasB].find((s) => s.status === "fulfilled") as
				| PromiseFulfilledResult<Awaited<ReturnType<typeof createMidasAllocationTransfer>>>
				| undefined;
			const rejectedMidas = [settledMidasA, settledMidasB].find((s) => s.status === "rejected") as
				| PromiseRejectedResult
				| undefined;

			chk(fulfilledMidas !== undefined, "7B.7/7: exactly one competitor succeeded with Midas transfer fulfillment");
			chk(rejectedMidas !== undefined, "7B.7/7: exactly one competitor was rejected with insufficient balance");

			if (fulfilledMidas) {
				eq(fulfilledMidas.value.amount, "80.00", "7B.7/7: winner created transfer of 80.00");
				eq(fulfilledMidas.value.idempotentReplay, false, "7B.7/7: winner idempotentReplay = false");
			}

			if (rejectedMidas) {
				chk(rejectedMidas.reason instanceof MidasError, "7B.7/7: loser threw typed MidasError");
				eq(
					(rejectedMidas.reason as MidasError).code,
					"MIDAS_INSUFFICIENT_FREE_BALANCE",
					"7B.7/7: loser threw typed MIDAS_INSUFFICIENT_FREE_BALANCE",
				);
				chk(
					!(rejectedMidas.reason instanceof pg.DatabaseError),
					"7B.7/7: raw PostgreSQL 23505 / 25P02 did not escape",
				);
			}

			// Exact-once assertions in PostgreSQL
			const transferRowCount = (
				await controlClient.query(
					"select count(*)::int as n from midas_allocation_transfers where midas_account_id = $1",
					[midasAccSetup.id],
				)
			).rows[0].n;
			eq(transferRowCount, 1, "7B.7/7: exactly ONE midas_allocation_transfers row exists in PostgreSQL");

			const finalLiquidity = await getMidasLiquidityState({ db: dbA, userId: USER_A });
			eq(finalLiquidity.totalEarmarked, "80.00", "7B.7/7: final totalEarmarked in PostgreSQL is exactly 80.00");
			eq(finalLiquidity.unallocatedBalance, "20.00", "7B.7/7: final unallocated balance in PostgreSQL is exactly 20.00");
		} catch (test7Err) {
			console.error("[Test 7 Fatal Error]:", test7Err);
			bad("Test 7 threw unexpected error", String(test7Err));
		}

		// --------------------------------------------------------------------------
		// 8. REAL PG LONG-TERM TASK MARK-SENT OCC CONCURRENCY RACE (DETERMINISTIC BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 8: Real PG Long-Term Task Mark-Sent OCC Concurrency Race ---");
		try {
			// Resolve existing Midas account for user A
			const targetMidasId =
				midasAccSetupId ||
				(
					await controlClient.query(
						"select id from midas_accounts where user_id = $1 limit 1",
						[USER_A],
					)
				).rows[0]?.id;

			// Create PENDING_LONG_TERM bucket on the Midas account for long-term allocations
			await createMidasBucket({
				db: dbA,
				userId: USER_A,
				midasAccountId: targetMidasId,
				code: "PENDING_LONG_TERM",
				name: "Pending Long-Term",
				bucketType: "PENDING_LONG_TERM",
			});

			// Allocate long term task with amount 10.00 (we have 20.00 unallocated balance available)
			const allocatedTask = await allocateLongTermInvestment({
				db: dbA,
				userId: USER_A,
				midasAccountId: targetMidasId,
				amount: "10.00",
				note: "Race allocate",
				occurredAt: new Date("2026-09-02T10:00:00Z"),
				idempotencyKey: "lt-race-alloc-init",
			});
			eq(allocatedTask.task.status, "PENDING", "7B.7/8: long-term task allocated with status PENDING");
			eq(allocatedTask.task.revisionNo, 1, "7B.7/8: long-term task initial revisionNo is 1");

			// Hold lock on long_term_send_tasks via control connection
			await controlClient.query("BEGIN; LOCK TABLE long_term_send_tasks IN ACCESS EXCLUSIVE MODE;");

			const promiseMarkSentA = markLongTermInvestmentSent({
				db: dbA,
				userId: USER_A,
				taskId: allocatedTask.task.taskId,
				expectedRevisionNo: 1,
				occurredAt: new Date("2026-09-03T10:00:00Z"),
				idempotencyKey: "lt-race-mark-sent-a",
			});

			const promiseMarkSentB = markLongTermInvestmentSent({
				db: dbB,
				userId: USER_A,
				taskId: allocatedTask.task.taskId,
				expectedRevisionNo: 1,
				occurredAt: new Date("2026-09-03T10:00:00Z"),
				idempotencyKey: "lt-race-mark-sent-b",
			});

			// Wait until BOTH competitor backend sessions are objectively observed waiting on long_term_send_tasks in pg_locks
			const blockedLT = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"long_term_send_tasks",
				[pidA, pidB],
			);
			ok(
				"7B.7/8: both independent PostgreSQL competitors observed waiting on long_term_send_tasks before barrier release",
				`(pidA=${blockedLT.pidA} mode=${blockedLT.modes[pidA]}, pidB=${blockedLT.modes[pidB]})`,
			);

			// Release barrier
			await controlClient.query("COMMIT;");

			const [settledLTA, settledLTB] = await Promise.allSettled([
				promiseMarkSentA,
				promiseMarkSentB,
			]);

			const fulfilledLT = [settledLTA, settledLTB].find((s) => s.status === "fulfilled") as
				| PromiseFulfilledResult<Awaited<ReturnType<typeof markLongTermInvestmentSent>>>
				| undefined;
			const rejectedLT = [settledLTA, settledLTB].find((s) => s.status === "rejected") as
				| PromiseRejectedResult
				| undefined;

			chk(fulfilledLT !== undefined, "7B.7/8: exactly one competitor succeeded with mark-sent");
			chk(rejectedLT !== undefined, "7B.7/8: exactly one competitor was rejected with revision conflict");

			if (fulfilledLT) {
				eq(fulfilledLT.value.task.status, "SENT", "7B.7/8: winner transitioned task to SENT");
				eq(fulfilledLT.value.task.revisionNo, 2, "7B.7/8: winner updated revisionNo to 2");
				chk(
					(fulfilledLT.value.task.currentSendCanonicalTransactionId ?? "").length > 0,
					"7B.7/8: winner created canonicalTransactionId",
				);
			}

			if (rejectedLT) {
				chk(rejectedLT.reason instanceof LongTermError, "7B.7/8: loser threw typed LongTermError");
				const isExpectedErrorCode =
					(rejectedLT.reason as LongTermError).code === "LONG_TERM_TASK_NOT_PENDING" ||
					(rejectedLT.reason as LongTermError).code === "LONG_TERM_REVISION_CONFLICT";
				chk(
					isExpectedErrorCode,
					`7B.7/8: loser threw typed domain conflict (${(rejectedLT.reason as LongTermError).code})`,
				);
				chk(
					!(rejectedLT.reason instanceof pg.DatabaseError),
					"7B.7/8: raw PostgreSQL 23505 / 25P02 did not escape",
				);
			}

			// Exact-once assertions in PostgreSQL
			const taskLatestRevRow = (
				await controlClient.query(
					"select status, revision_no from long_term_send_task_revisions where task_id = $1 order by revision_no desc limit 1",
					[allocatedTask.task.taskId],
				)
			).rows[0];
			eq(taskLatestRevRow.status, "SENT", "7B.7/8: latest task revision in DB has status SENT");
			eq(taskLatestRevRow.revision_no, 2, "7B.7/8: latest task revision in DB has revision 2");

			const taskRevsCount = (
				await controlClient.query(
					"select count(*)::int as n from long_term_send_task_revisions where task_id = $1",
					[allocatedTask.task.taskId],
				)
			).rows[0].n;
			eq(taskRevsCount, 2, "7B.7/8: exactly TWO revisions exist (1 PENDING + 1 SENT, zero partial writes from loser)");

			if (fulfilledLT) {
				const winnerTxId = fulfilledLT.value.task.currentSendCanonicalTransactionId;
				const winnerRevId = fulfilledLT.value.task.currentSendCanonicalRevisionId;

				const canTxRows = (
					await controlClient.query(
						"select id, kind, user_id from canonical_transactions where id = $1",
						[winnerTxId],
					)
				).rows;
				eq(canTxRows.length, 1, "7B.7/8: exactly ONE canonical transaction exists for winning send");
				eq(canTxRows[0]?.kind, "LONG_TERM_INVESTMENT_SEND", "7B.7/8: canonical transaction kind is LONG_TERM_INVESTMENT_SEND");

				const canRevRows = (
					await controlClient.query(
						"select id, transaction_id from transaction_revisions where transaction_id = $1",
						[winnerTxId],
					)
				).rows;
				eq(canRevRows.length, 1, "7B.7/8: exactly ONE transaction revision exists for winning send");
				eq(canRevRows[0]?.id, winnerRevId, "7B.7/8: canonical revision ID matches task snapshot");

				const bindingRows = (
					await controlClient.query(
						"select applied_journal_entry_id from transaction_ledger_bindings where transaction_id = $1 and revision_id = $2",
						[winnerTxId, winnerRevId],
					)
				).rows;
				eq(bindingRows.length, 1, "7B.7/8: exactly ONE transaction ledger binding exists for winning send");
				const journalEntryId = bindingRows[0]?.applied_journal_entry_id;
				chk(Boolean(journalEntryId), "7B.7/8: applied journal entry ID is present");

				const journalEntryRows = (
					await controlClient.query(
						"select id, status from journal_entries where id = $1",
						[journalEntryId],
					)
				).rows;
				eq(journalEntryRows.length, 1, "7B.7/8: exactly ONE journal entry exists for winning send");
				eq(journalEntryRows[0]?.status, "POSTED", "7B.7/8: journal entry status is POSTED");

				const journalLines = (
					await controlClient.query(
						"select account_id, debit::numeric as debit, credit::numeric as credit from journal_lines where journal_entry_id = $1 order by line_no asc",
						[journalEntryId],
					)
				).rows;
				eq(journalLines.length, 2, "7B.7/8: exactly 2 journal lines exist (balanced debit/credit)");
				chk(
					journalLines.some((l: any) => Number(l.debit) === 10.0 && Number(l.credit) === 0),
					"7B.7/8: DEBIT line for 10.00 exists",
				);
				chk(
					journalLines.some((l: any) => Number(l.credit) === 10.0 && Number(l.debit) === 0),
					"7B.7/8: CREDIT line for 10.00 exists",
				);

				// Loser zero partial rows
				const totalSendTxCount = (
					await controlClient.query(
						"select count(distinct ct.id)::int as n from canonical_transactions ct inner join transaction_revisions tr on ct.id = tr.transaction_id where tr.payload->>'taskId' = $1",
						[allocatedTask.task.taskId],
					)
				).rows[0].n;
				eq(totalSendTxCount, 1, "7B.7/8: loser created 0 extra canonical transactions");

				const totalJournalEntriesForTask = (
					await controlClient.query(
						"select count(*)::int as n from transaction_ledger_bindings tlb inner join transaction_revisions tr on tlb.revision_id = tr.id where tr.payload->>'taskId' = $1",
						[allocatedTask.task.taskId],
					)
				).rows[0].n;
				eq(totalJournalEntriesForTask, 1, "7B.7/8: loser created 0 extra journal entries/bindings");
			}

			const taskInDb = await getLongTermInvestmentTask({
				db: dbA,
				userId: USER_A,
				taskId: allocatedTask.task.taskId,
			});
			eq(taskInDb?.status, "SENT", "7B.7/8: post-race DB usability getLongTermInvestmentTask returns SENT");
		} catch (test8Err) {
			console.error("[Test 8 Fatal Error]:", test8Err);
			bad("Test 8 threw unexpected error", String(test8Err));
		}

		// --------------------------------------------------------------------------
		// 9. REAL PG MONTH-CLOSE CONCURRENT CLOSE RACE (DETERMINISTIC BARRIER)
		// --------------------------------------------------------------------------
		console.log("\n--- Test 9: Real PG Month-Close Concurrent Close Race ---");
		try {
			// Resolve target Midas account ID
			const targetMidasId =
				midasAccSetupId ||
				(
					await controlClient.query(
						"select id from midas_accounts where user_id = $1 limit 1",
						[USER_A],
					)
				).rows[0]?.id;

			// Seed monthly budget plan for an ended month (2026-07)
			const mcPeriod = "2026-07";
			const mcPeriodDate = "2026-07-01";
			const mcPlanId = crypto.randomUUID();
			const mcPlanRevId = crypto.randomUUID();
			const mcCanonTxId = crypto.randomUUID();
			const mcCanonRevId = crypto.randomUUID();

			const mcCanonIdemp = `plan-canon-idemp-${mcPeriod}-${crypto.randomUUID()}`;
			const mcCanonFingerprint = "f".repeat(64);

			await controlClient.query("SET session_replication_role = replica;");
			await controlClient.query(
				"insert into canonical_transactions (id, user_id, kind, creation_idempotency_key, creation_fingerprint, created_at) values ($1, $2, 'MONTHLY_BUDGET_PLAN', $3, $4, now())",
				[mcCanonTxId, USER_A, mcCanonIdemp, mcCanonFingerprint],
			);
			await controlClient.query(
				"insert into monthly_budget_plans (id, user_id, period_month, canonical_transaction_id, created_at) values ($1, $2, $3, $4, now())",
				[mcPlanId, USER_A, mcPeriodDate, mcCanonTxId],
			);
			await controlClient.query(
				"insert into transaction_revisions (id, user_id, transaction_id, revision_no, operation, occurred_at, payload, revision_fingerprint, idempotency_key) values ($1, $2, $3, 1, 'CREATE', now(), '{}', $4, $5)",
				[mcCanonRevId, USER_A, mcCanonTxId, mcCanonFingerprint, mcCanonIdemp],
			);
			await controlClient.query(
				`insert into monthly_budget_plan_revisions
				 (id, user_id, budget_plan_id, canonical_revision_id, revision_no, previous_budget_revision_id, operation, policy_version, currency,
				  reference_income_amount, mandatory_ceiling_amount, discretionary_ceiling_amount, short_term_purchase_amount, medium_term_reserve_amount, long_term_investment_amount, reference_snapshot)
				 values ($1, $2, $3, $4, 1, null, 'CREATE', 'PERSONAL_BUDGET_V1', 'TRY', '10000.00', '5000.00', '3000.00', '1000.00', '500.00', '500.00', '{}')`,
				[mcPlanRevId, USER_A, mcPlanId, mcCanonRevId],
			);
			await controlClient.query("SET session_replication_role = origin;");

			// Ensure target Midas account has sufficient unallocated liquidity for month-close routing
			const [midasRow] = (
				await controlClient.query(
					"select ledger_account_id from midas_accounts where id = $1",
					[targetMidasId],
				)
			).rows;
			const [equityRow] = (
				await controlClient.query(
					"select id from ledger_accounts where user_id = $1 and account_type = 'EQUITY' limit 1",
					[USER_A],
				)
			).rows;

			if (midasRow?.ledger_account_id && equityRow?.id) {
				await postJournalEntry({
					db: dbA,
					userId: USER_A,
					occurredAt: new Date("2026-07-01T00:00:00Z"),
					memo: "Month Close Seed Liquidity",
					idempotencyKey: `mc-race-seed-liquidity-${crypto.randomUUID()}`,
					lines: [
						{ accountId: midasRow.ledger_account_id, side: "DEBIT", amount: "50000.00" },
						{ accountId: equityRow.id, side: "CREDIT", amount: "50000.00" },
					],
				});
			}

			// Ensure active short term goal exists for routing/closing
			const mcGoal = await createShortTermGoal({
				db: dbA,
				userId: USER_A,
				midasAccountId: targetMidasId,
				name: "Month Close Target Goal",
				fundingTarget: "5000.00",
				occurredAt: new Date("2026-07-01T00:00:00Z"),
				idempotencyKey: `mc-race-stg-init-${crypto.randomUUID()}`,
			});

			// Preview month close to get proposal fingerprint
			const previewRes = await previewMonthClose({
				db: dbA,
				userId: USER_A,
				periodMonth: mcPeriod,
			});
			eq(previewRes.blockedReason, null, "7B.8/9: month close preview blockedReason is null");
			chk(Boolean(previewRes.proposalFingerprint), "7B.8/9: proposal fingerprint generated");

			// Hold exclusive table lock on monthly_budget_plans via control connection
			await controlClient.query("BEGIN; LOCK TABLE monthly_budget_plans IN ACCESS EXCLUSIVE MODE;");

			const promiseMCA = closeMonth({
				db: dbA,
				userId: USER_A,
				periodMonth: mcPeriod,
				expectedProposalFingerprint: previewRes.proposalFingerprint,
				decision: "FULL",
				occurredAt: new Date("2026-08-01T12:00:00.000Z"),
				idempotencyKey: "mc-race-key-a",
			});

			const promiseMCB = closeMonth({
				db: dbB,
				userId: USER_A,
				periodMonth: mcPeriod,
				expectedProposalFingerprint: previewRes.proposalFingerprint,
				decision: "FULL",
				occurredAt: new Date("2026-08-01T12:00:00.000Z"),
				idempotencyKey: "mc-race-key-b",
			});

			// Wait until BOTH competitor backend sessions are objectively observed waiting on monthly_budget_plans in pg_locks
			const blockedMC = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"monthly_budget_plans",
				[pidA, pidB],
			);
			ok(
				"7B.8/9: both independent PostgreSQL competitors observed waiting on monthly_budget_plans before barrier release",
				`(pidA=${blockedMC.pidA} mode=${blockedMC.modes[pidA]}, pidB=${blockedMC.modes[pidB]})`,
			);

			// Release barrier
			await controlClient.query("COMMIT;");

			const [settledMCA, settledMCB] = await Promise.allSettled([
				promiseMCA,
				promiseMCB,
			]);

			const fulfilledMC = [settledMCA, settledMCB].find((s) => s.status === "fulfilled") as
				| PromiseFulfilledResult<Awaited<ReturnType<typeof closeMonth>>>
				| undefined;
			const rejectedMC = [settledMCA, settledMCB].find((s) => s.status === "rejected") as
				| PromiseRejectedResult
				| undefined;

			chk(fulfilledMC !== undefined, "7B.8/9: exactly one competitor succeeded with month close");
			chk(rejectedMC !== undefined, "7B.8/9: exactly one competitor was rejected with ALREADY_CLOSED");

			if (fulfilledMC) {
				eq(fulfilledMC.value.monthClose.periodMonth, mcPeriod, "7B.8/9: winner closed requested periodMonth");
				eq(fulfilledMC.value.monthClose.decision, "FULL", "7B.8/9: winner decision is FULL");
				eq(fulfilledMC.value.idempotentReplay, false, "7B.8/9: winner idempotentReplay = false");
				chk(Boolean(fulfilledMC.value.monthClose.monthCloseId), "7B.8/9: winner generated monthCloseId");
			}

			if (rejectedMC) {
				chk(rejectedMC.reason instanceof MonthCloseError, "7B.8/9: loser threw typed MonthCloseError");
				eq(
					(rejectedMC.reason as MonthCloseError).code,
					"MONTH_CLOSE_ALREADY_CLOSED",
					"7B.8/9: loser threw typed MONTH_CLOSE_ALREADY_CLOSED",
				);
				chk(
					!(rejectedMC.reason instanceof pg.DatabaseError),
					"7B.8/9: raw PostgreSQL 23505 / 25P02 did not escape",
				);
			}

			// Exact-once assertions in PostgreSQL
			const mcRowCount = (
				await controlClient.query(
					"select count(*)::int as n from month_closes where user_id = $1 and period_month = $2",
					[USER_A, mcPeriodDate],
				)
			).rows[0].n;
			eq(mcRowCount, 1, "7B.8/9: exactly ONE month_closes row exists for the period");

			const mcRevRowCount = (
				await controlClient.query(
					"select count(*)::int as n from month_close_revisions mcr inner join month_closes mc on mcr.month_close_id = mc.id where mc.user_id = $1 and mc.period_month = $2",
					[USER_A, mcPeriodDate],
				)
			).rows[0].n;
			eq(mcRevRowCount, 1, "7B.8/9: exactly ONE month_close_revisions row exists (0 partial writes from loser)");

			const transferRowCount = (
				await controlClient.query(
					"select count(*)::int as n from midas_allocation_transfers mat inner join month_close_revisions mcr on mat.id = mcr.midas_allocation_transfer_id inner join month_closes mc on mcr.month_close_id = mc.id where mc.user_id = $1 and mc.period_month = $2",
					[USER_A, mcPeriodDate],
				)
			).rows[0].n;
			eq(transferRowCount, 1, "7B.8/9: exactly ONE economic transfer exists for winning nonzero route");

			// Post-race DB usability: getMonthClose returns closed month
			const mcDetail = await getMonthClose({
				db: dbA,
				userId: USER_A,
				periodMonth: mcPeriod,
			});
			eq(mcDetail?.periodMonth, mcPeriod, "7B.8/9: post-race getMonthClose returns closed period");
			eq(mcDetail?.decision, "FULL", "7B.8/9: post-race getMonthClose decision is FULL");
			eq(mcDetail?.route, "SHORT_TERM_GOAL", "7B.8/9: post-race getMonthClose route is SHORT_TERM_GOAL");
			chk(Boolean(mcDetail?.monthCloseId), "7B.8/9: post-race getMonthClose has valid monthCloseId");
			chk(Boolean(mcDetail?.midasAllocationTransferId), "7B.8/9: post-race getMonthClose has valid midasAllocationTransferId");
		} catch (test9Err) {
			console.error("[Test 9 Fatal Error]:", test9Err);
			bad("Test 9 threw unexpected error", String(test9Err));
		}

		// ========================================================================
		// TEST 10: Checkpoint M-03 / M-06 -- STG 4-Race Concurrency Verification
		// 1. CC purchase binding vs CANCEL
		// 2. CC purchase binding vs COMPLETE
		// 3. Reward earn purchase binding vs CANCEL
		// 4. Reward earn purchase binding vs COMPLETE
		// ========================================================================
		try {
			logOut("\n--- Test 10: STG 4-Race Concurrency Verification (Real PostgreSQL) ---");

			// Setup STG goals & card
			const stgCardRes = await createCreditCard({
				db: dbA,
				userId: USER_A,
				cardName: "STG Concurrency Test Card",
				cutoffDay: 15,
				paymentDueDay: 25,
				idempotencyKey: "stg-test-card-key",
			});
			const stgCardId = stgCardRes.card.id;

			const stgRewardAccRes = await createRewardAccount({
				db: dbA,
				userId: USER_A,
				programName: "STG Concurrency Rewards",
				idempotencyKey: "stg-test-reward-key",
			});
			const stgRewardAccountId = stgRewardAccRes.rewardAccount.id;

			// --- Race 10.1: CC purchase binding vs CANCEL ---
			const goal1Res = await createShortTermGoal({
				db: dbA,
				userId: USER_A,
				name: "STG Race 1 Goal",
				targetAmount: "500.00",
				targetDate: "2026-12-31",
				idempotencyKey: "stg-race-1-goal-key",
			});
			const goal1Id = goal1Res.shortTermGoal.id;

			await controlClient.query("BEGIN; LOCK TABLE short_term_goals IN ACCESS EXCLUSIVE MODE;");

			const promiseCC1 = recordCreditCardPurchase({
				db: dbA,
				userId: USER_A,
				cardId: stgCardId,
				amount: "50.00",
				purchaseDate: "2026-08-05",
				occurredAt: new Date("2026-08-05T12:00:00.000Z"),
				shortTermGoalId: goal1Id,
				idempotencyKey: "stg-race-1-cc-key",
				source: { type: "MANUAL", externalId: "stg-r1-cc" },
			});

			const promiseCancel1 = cancelShortTermGoal({
				db: dbB,
				userId: USER_A,
				goalId: goal1Id,
				expectedRevisionNo: 1,
				idempotencyKey: "stg-race-1-cancel-key",
				provenance: { type: "MANUAL", externalId: "stg-r1-cancel" },
			});

			const blockedSTG1 = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"short_term_goals",
				[pidA, pidB],
			);
			ok(
				"7B.9 M-06: CC vs CANCEL competitors observed waiting on short_term_goals in pg_locks",
				`(pidA=${blockedSTG1.pidA}, pidB=${blockedSTG1.pidB})`,
			);

			await controlClient.query("COMMIT;");

			const [resCC1, resCancel1] = await Promise.allSettled([promiseCC1, promiseCancel1]);
			chk(resCC1.status === "fulfilled" || resCancel1.status === "fulfilled", "7B.9 M-06: at least one competitor succeeded in CC vs CANCEL");

			// --- Race 10.2: CC purchase binding vs COMPLETE ---
			const goal2Res = await createShortTermGoal({
				db: dbA,
				userId: USER_A,
				name: "STG Race 2 Goal",
				targetAmount: "500.00",
				targetDate: "2026-12-31",
				idempotencyKey: "stg-race-2-goal-key",
			});
			const goal2Id = goal2Res.shortTermGoal.id;

			await controlClient.query("BEGIN; LOCK TABLE short_term_goals IN ACCESS EXCLUSIVE MODE;");

			const promiseCC2 = recordCreditCardPurchase({
				db: dbA,
				userId: USER_A,
				cardId: stgCardId,
				amount: "50.00",
				purchaseDate: "2026-08-05",
				occurredAt: new Date("2026-08-05T12:00:00.000Z"),
				shortTermGoalId: goal2Id,
				idempotencyKey: "stg-race-2-cc-key",
				source: { type: "MANUAL", externalId: "stg-r2-cc" },
			});

			const promiseComplete2 = completeShortTermGoal({
				db: dbB,
				userId: USER_A,
				goalId: goal2Id,
				expectedRevisionNo: 1,
				idempotencyKey: "stg-race-2-complete-key",
				provenance: { type: "MANUAL", externalId: "stg-r2-complete" },
			});

			const blockedSTG2 = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"short_term_goals",
				[pidA, pidB],
			);
			ok(
				"7B.9 M-06: CC vs COMPLETE competitors observed waiting on short_term_goals in pg_locks",
				`(pidA=${blockedSTG2.pidA}, pidB=${blockedSTG2.pidB})`,
			);

			await controlClient.query("COMMIT;");

			const [resCC2, resComplete2] = await Promise.allSettled([promiseCC2, promiseComplete2]);
			chk(resCC2.status === "fulfilled" || resComplete2.status === "fulfilled", "7B.9 M-06: at least one competitor succeeded in CC vs COMPLETE");

			// --- Race 10.3: Reward earn purchase binding vs CANCEL ---
			const goal3Res = await createShortTermGoal({
				db: dbA,
				userId: USER_A,
				name: "STG Race 3 Goal",
				targetAmount: "500.00",
				targetDate: "2026-12-31",
				idempotencyKey: "stg-race-3-goal-key",
			});
			const goal3Id = goal3Res.shortTermGoal.id;

			await controlClient.query("BEGIN; LOCK TABLE short_term_goals IN ACCESS EXCLUSIVE MODE;");

			const promiseReward3 = recordRewardEarn({
				db: dbA,
				userId: USER_A,
				rewardAccountId: stgRewardAccountId,
				points: "100.00",
				occurredAt: new Date("2026-08-05T12:00:00.000Z"),
				shortTermGoalId: goal3Id,
				idempotencyKey: "stg-race-3-reward-key",
				provenance: { type: "MANUAL", externalId: "stg-r3-reward" },
			});

			const promiseCancel3 = cancelShortTermGoal({
				db: dbB,
				userId: USER_A,
				goalId: goal3Id,
				expectedRevisionNo: 1,
				idempotencyKey: "stg-race-3-cancel-key",
				provenance: { type: "MANUAL", externalId: "stg-r3-cancel" },
			});

			const blockedSTG3 = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"short_term_goals",
				[pidA, pidB],
			);
			ok(
				"7B.9 M-06: Reward vs CANCEL competitors observed waiting on short_term_goals in pg_locks",
				`(pidA=${blockedSTG3.pidA}, pidB=${blockedSTG3.pidB})`,
			);

			await controlClient.query("COMMIT;");

			const [resReward3, resCancel3] = await Promise.allSettled([promiseReward3, promiseCancel3]);
			chk(resReward3.status === "fulfilled" || resCancel3.status === "fulfilled", "7B.9 M-06: at least one competitor succeeded in Reward vs CANCEL");

			// --- Race 10.4: Reward earn purchase binding vs COMPLETE ---
			const goal4Res = await createShortTermGoal({
				db: dbA,
				userId: USER_A,
				name: "STG Race 4 Goal",
				targetAmount: "500.00",
				targetDate: "2026-12-31",
				idempotencyKey: "stg-race-4-goal-key",
			});
			const goal4Id = goal4Res.shortTermGoal.id;

			await controlClient.query("BEGIN; LOCK TABLE short_term_goals IN ACCESS EXCLUSIVE MODE;");

			const promiseReward4 = recordRewardEarn({
				db: dbA,
				userId: USER_A,
				rewardAccountId: stgRewardAccountId,
				points: "100.00",
				occurredAt: new Date("2026-08-05T12:00:00.000Z"),
				shortTermGoalId: goal4Id,
				idempotencyKey: "stg-race-4-reward-key",
				provenance: { type: "MANUAL", externalId: "stg-r4-reward" },
			});

			const promiseComplete4 = completeShortTermGoal({
				db: dbB,
				userId: USER_A,
				goalId: goal4Id,
				expectedRevisionNo: 1,
				idempotencyKey: "stg-race-4-complete-key",
				provenance: { type: "MANUAL", externalId: "stg-r4-complete" },
			});

			const blockedSTG4 = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"short_term_goals",
				[pidA, pidB],
			);
			ok(
				"7B.9 M-06: Reward vs COMPLETE competitors observed waiting on short_term_goals in pg_locks",
				`(pidA=${blockedSTG4.pidA}, pidB=${blockedSTG4.pidB})`,
			);

			await controlClient.query("COMMIT;");

			const [resReward4, resComplete4] = await Promise.allSettled([promiseReward4, promiseComplete4]);
			chk(resReward4.status === "fulfilled" || resComplete4.status === "fulfilled", "7B.9 M-06: at least one competitor succeeded in Reward vs COMPLETE");
		} catch (test10Err) {
			console.error("[Test 10 Fatal Error]:", test10Err);
			bad("Test 10 threw unexpected error", String(test10Err));
		}

		// ========================================================================
		// TEST 11: Checkpoint MC-01 / M-06 -- Concurrent Adjustment Application
		// ========================================================================
		try {
			logOut("\n--- Test 11: MC-01 Concurrent Post-Close Adjustment Application ---");

			// Setup closed month 2026-01 with surplus
			const mc11Period = "2026-01";
			const mc11PeriodDate = "2026-01-01";

			await controlClient.query(
				`insert into monthly_budget_plans (id, user_id, period_month, canonical_transaction_id, created_at)
				 values ('plan-11-id', $1, $2, 'ctx-11', now()) on conflict do nothing`,
				[USER_A, mc11PeriodDate],
			);
			await controlClient.query(
				`insert into monthly_budget_plan_revisions
				 (id, user_id, budget_plan_id, canonical_revision_id, revision_no, previous_budget_revision_id, operation, policy_version, currency,
				  reference_income_amount, mandatory_ceiling_amount, discretionary_ceiling_amount, short_term_purchase_amount, medium_term_reserve_amount, long_term_investment_amount, reference_snapshot)
				 values ('prev-11-id', $1, 'plan-11-id', 'crev-11', 1, null, 'CREATE', 'PERSONAL_BUDGET_V1', 'TRY',
				  '5000.00', '2000.00', '1000.00', '1000.00', '1000.00', '0.00', '{}') on conflict do nothing`,
				[USER_A],
			);

			const prevRes11 = await previewMonthClose({
				db: dbA,
				userId: USER_A,
				periodMonth: mc11Period,
			});

			await closeMonth({
				db: dbA,
				userId: USER_A,
				periodMonth: mc11Period,
				expectedProposalFingerprint: prevRes11.proposalFingerprint,
				decision: "FULL",
				occurredAt: new Date("2026-02-01T12:00:00.000Z"),
				idempotencyKey: "mc11-close-key",
			});

			// Insert post-close adjustment of -150.00
			const adj11 = await dbA.transaction((tx: any) =>
				recordPostCloseAdjustmentIfClosedInTransaction(tx, {
					userId: USER_A,
					periodMonth: mc11Period,
					adjustmentAmount: "-150.00",
					reasonCode: "RETROACTIVE_TEST_ADJUSTMENT",
					sourceRef: "txn-mc11-test",
				}),
			);
			chk(Boolean(adj11), "7B.9 MC-01: Post-close adjustment created");

			// Setup month 2026-02
			const mc12Period = "2026-02";
			const mc12PeriodDate = "2026-02-01";
			await controlClient.query(
				`insert into monthly_budget_plans (id, user_id, period_month, canonical_transaction_id, created_at)
				 values ('plan-12-id', $1, $2, 'ctx-12', now()) on conflict do nothing`,
				[USER_A, mc12PeriodDate],
			);
			await controlClient.query(
				`insert into monthly_budget_plan_revisions
				 (id, user_id, budget_plan_id, canonical_revision_id, revision_no, previous_budget_revision_id, operation, policy_version, currency,
				  reference_income_amount, mandatory_ceiling_amount, discretionary_ceiling_amount, short_term_purchase_amount, medium_term_reserve_amount, long_term_investment_amount, reference_snapshot)
				 values ('prev-12-id', $1, 'plan-12-id', 'crev-12', 1, null, 'CREATE', 'PERSONAL_BUDGET_V1', 'TRY',
				  '5000.00', '2000.00', '1000.00', '1000.00', '1000.00', '0.00', '{}') on conflict do nothing`,
				[USER_A],
			);

			const prevRes12 = await previewMonthClose({
				db: dbA,
				userId: USER_A,
				periodMonth: mc12Period,
			});
			eq(prevRes12.unappliedPriorAdjustments, "-150.00", "7B.9 MC-01: unapplied prior adjustments carried to preview");

			await controlClient.query("BEGIN; LOCK TABLE month_close_adjustments IN ACCESS EXCLUSIVE MODE;");

			const promiseMC11A = closeMonth({
				db: dbA,
				userId: USER_A,
				periodMonth: mc12Period,
				expectedProposalFingerprint: prevRes12.proposalFingerprint,
				decision: "FULL",
				occurredAt: new Date("2026-03-01T12:00:00.000Z"),
				idempotencyKey: "mc12-race-a",
			});

			const promiseMC11B = closeMonth({
				db: dbB,
				userId: USER_A,
				periodMonth: mc12Period,
				expectedProposalFingerprint: prevRes12.proposalFingerprint,
				decision: "FULL",
				occurredAt: new Date("2026-03-01T12:00:00.000Z"),
				idempotencyKey: "mc12-race-b",
			});

			const blockedMC11 = await waitUntilBothCompetitorsBlockedOnRelation(
				controlClient,
				"month_close_adjustments",
				[pidA, pidB],
			);
			ok(
				"7B.9 MC-01: both independent competitors observed waiting on month_close_adjustments in pg_locks",
				`(pidA=${blockedMC11.pidA}, pidB=${blockedMC11.pidB})`,
			);

			await controlClient.query("COMMIT;");

			const [resMC11A, resMC11B] = await Promise.allSettled([promiseMC11A, promiseMC11B]);
			const winnerMC11 = [resMC11A, resMC11B].find((s) => s.status === "fulfilled") as any;
			const loserMC11 = [resMC11A, resMC11B].find((s) => s.status === "rejected") as any;

			chk(winnerMC11 !== undefined, "7B.9 MC-01: exactly one winner closed the month");
			chk(loserMC11 !== undefined, "7B.9 MC-01: exactly one loser was rejected");
			if (loserMC11) {
				chk(loserMC11.reason instanceof MonthCloseError, "7B.9 MC-01: loser threw MonthCloseError");
				eq((loserMC11.reason as MonthCloseError).code, "MONTH_CLOSE_ALREADY_CLOSED", "7B.9 MC-01: loser code = MONTH_CLOSE_ALREADY_CLOSED");
			}

			const [adj11After] = await controlClient.query(
				"select remaining_amount, applied_in_month_close_id from month_close_adjustments where id = $1",
				[adj11?.id],
			).then((r: any) => r.rows);
			eq(adj11After.remaining_amount, "0.00", "7B.9 MC-01: remaining_amount is exactly 0.00 after full application");
			eq(adj11After.applied_in_month_close_id, winnerMC11.value.monthClose.monthCloseId, "7B.9 MC-01: adjustment applied_in_month_close_id matches winning close ID");
		} catch (test11Err) {
			console.error("[Test 11 Fatal Error]:", test11Err);
			bad("Test 11 threw unexpected error", String(test11Err));
		}
	} catch (fatalErr) {
		console.error("FATAL RUN ERROR:", fatalErr);
		fail++;
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

	logOut(`\nReal PostgreSQL Verification Summary: ${pass} passed, ${fail} failed\n`);
	if (fail > 0) {
		process.exit(1);
	}
}

run().catch((err) => {
	logOut(`Real PostgreSQL Concurrency Verification Fatal Error: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
