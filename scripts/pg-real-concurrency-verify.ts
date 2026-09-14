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
 * ungranted relation lock on the specified relation before proceeding.
 *
 * Timeout acts strictly as a watchdog; time passing NEVER satisfies the barrier.
 */
async function waitUntilBothCompetitorsBlockedOnRelation(
	controlClient: pg.Client,
	relationName: string,
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
	timeoutMs = 5000,
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
			cardBrand: "VISA",
			last4: "4321",
			creditLimit: "10000.00",
			statementClosingDay: 25,
			paymentDueDaysAfterClosing: 10,
			occurredAt: new Date("2026-09-01T00:00:00Z"),
			idempotencyKey: "camp-race-card",
		});

		// Record qualifying purchase of 250.00 on 2026-09-10
		await recordCreditCardPurchase({
			db: dbA,
			userId: USER_A,
			cardId: campCard.card.id,
			amount: "250.00",
			merchant: "Race Merchant",
			description: "Qualifying spend",
			purchaseCategory: "GROCERY",
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
			requiredTransactionCount: 1,
			minimumTransactionAmount: "10.00",
			rewardKind: "REWARD_POINTS",
			rewardAccountId: campRewardAcc.account.id,
			expectedRewardPoints: "1000.0000",
			merchantScopeMode: "ALL_MERCHANTS",
			cardIds: [campCard.card.id],
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
				"select count(*)::int as n from reward_events where source_type = 'CAMPAIGN' and source_ref = $1",
				[campConfirmed.campaignPeriodId],
			)
		).rows[0].n;
		eq(rewardEventRowCount, 1, "7B.6/6: exactly ONE CAMPAIGN-owned reward_events row exists");

		const finalRewAcc = await getRewardAccount({
			db: dbA,
			userId: USER_A,
			rewardAccountId: campRewardAcc.account.id,
		});
		eq(finalRewAcc?.balancePoints, "1000.0000", "7B.6/6: reward account balance is exactly 1000.0000 points");

		const activeCredit = await dbA.transaction((tx) =>
			resolveActiveCampaignRewardCreditInTransaction(tx, campConfirmed.campaignPeriodId),
		);
		chk(activeCredit !== null, "7B.6/6: active credit resolver returns 1 active credit");
		eq(activeCredit?.actualPointAmount, "1000.0000", "7B.6/6: active credit amount is 1000.0000");

		// Post-race DB usability: execute read progress on campaign
		const progressAfterRace = await dbA.transaction((tx) =>
			getCampaignProgressInTransaction(tx, {
				userId: USER_A,
				campaignPeriodId: campConfirmed.campaignPeriodId,
			}),
		);
		eq(progressAfterRace.qualificationStatus, "REWARD_CREDITED", "7B.6/6: post-race progress is REWARD_CREDITED and DB is healthy");
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
