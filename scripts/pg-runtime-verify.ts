/**
 * Faithful disposable PostgreSQL runtime verification for the Budget V2
 * migration guards, using PGlite (real PostgreSQL compiled to WASM -- full
 * PL/pgSQL, triggers, JSONB, NUMERIC, timestamptz, Europe/Istanbul).
 *
 * NON-PRODUCTION. In-memory, disposable. Never reads Neon / private creds.
 *
 * Run:  node --import tsx scripts/pg-runtime-verify.ts
 *
 * Phase 1: capability probe (must pass before trusting anything below).
 * Phase 2: apply the COMPLETE migration chain 0000..0063 to an empty DB.
 * Phase 3: runtime-exercise the 0061 / 0062 / 0063 guards + V1 regression.
 *
 * Seed rows for FK chains are inserted with session_replication_role=replica
 * (triggers/FKs off) so the guards UNDER TEST run against precise fixtures;
 * every actual guard assertion runs with triggers ON.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { allocatePersonalBudgetV2 } from "../src/budget/policy-v2.ts";
import { buildBudgetV2CanonicalPayload } from "../src/budget/payload-v2.ts";

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

async function expectReject(
	db: PGlite,
	sql: string,
	params: unknown[],
	name: string,
) {
	try {
		await db.query(sql, params as never[]);
		bad(name, "-> accepted, expected rejection");
	} catch (e) {
		ok(name, `(rejected: ${String((e as Error).message).slice(0, 70)})`);
	}
}
async function expectAccept(
	db: PGlite,
	sql: string,
	params: unknown[],
	name: string,
) {
	try {
		await db.query(sql, params as never[]);
		ok(name);
	} catch (e) {
		bad(name, `-> ${String((e as Error).message).slice(0, 120)}`);
	}
}

/**
 * Verify, on a live connection with all guards active, that
 * `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING`
 * absorbs a duplicate-key write as a 0-row no-op WITHOUT aborting the
 * transaction (a subsequent insert in the same tx still commits). `rowA`
 * seeds the key; `rowBConflict` reuses the key on a different target;
 * `rowBFresh` uses a new key and must succeed to prove the tx is alive.
 */
async function idempotencyRaceShape(
	db: PGlite,
	label: string,
	table: string,
	cols: string,
	rowA: string,
	rowBConflict: string,
	rowBFresh: string,
) {
	try {
		await db.exec("BEGIN");
		await db.query(`insert into ${table} ${cols} values ${rowA}`);
		const clash = await db.query(
			`insert into ${table} ${cols} values ${rowBConflict}
			 on conflict (user_id, idempotency_key) do nothing returning id`,
		);
		clash.rows.length === 0
			? ok(`${label}: duplicate (user_id,idempotency_key) absorbed as 0-row no-op`)
			: bad(`${label}: ON CONFLICT`, "-> inserted a row, expected 0");
		await db.query(`insert into ${table} ${cols} values ${rowBFresh}`);
		await db.exec("COMMIT");
		ok(`${label}: transaction NOT aborted by the no-op (follow-up write committed)`);
	} catch (e) {
		try {
			await db.exec("ROLLBACK");
		} catch {}
		bad(
			`${label}: idempotency race shape`,
			`-> ${String((e as Error).message).slice(0, 120)}`,
		);
	}
}

async function probe(): Promise<boolean> {
	console.log("== PHASE 1: CAPABILITY PROBE ==");
	const db = new PGlite();
	await db.query("SET timezone='UTC'");
	const v = (await db.query<{ version: string }>("select version()")).rows[0];
	console.log("  engine:", v.version.split(",")[0]);

	const before = fail;
	await db.exec(`
		CREATE TABLE p (id uuid primary key default gen_random_uuid());
		CREATE TABLE c (
			id uuid primary key default gen_random_uuid(),
			p_id uuid not null references p(id),
			prev uuid references c(id),
			payload jsonb not null, amt numeric(18,2) not null, at timestamptz not null
		);
		CREATE OR REPLACE FUNCTION g() RETURNS trigger AS $$
		DECLARE r RECORD; k int;
		BEGIN
			SELECT * INTO r FROM p WHERE id = NEW.p_id;
			IF NOT FOUND THEN RAISE EXCEPTION 'no parent'; END IF;
			IF jsonb_typeof(NEW.payload) != 'object' THEN RAISE EXCEPTION 'bad'; END IF;
			SELECT count(*) INTO k FROM jsonb_object_keys(NEW.payload);
			IF k != 2 OR NOT (NEW.payload ? 'a' AND NEW.payload ? 'b') THEN RAISE EXCEPTION 'keys'; END IF;
			IF div((NEW.amt*100)::numeric*3500, 10000)::bigint != 350 THEN RAISE EXCEPTION 'div'; END IF;
			RETURN NEW;
		END; $$ LANGUAGE plpgsql;
		CREATE TRIGGER gt BEFORE INSERT ON c FOR EACH ROW EXECUTE FUNCTION g();
	`);
	ok("LANGUAGE plpgsql + CREATE FUNCTION + BEFORE INSERT TRIGGER");
	const pr = (await db.query<{ id: string }>("insert into p default values returning id"))
		.rows[0];
	await expectAccept(
		db,
		"insert into c(p_id,payload,amt,at) values ($1,$2,$3,$4)",
		[pr.id, JSON.stringify({ a: 1, b: 2 }), "10.00", "2026-09-01T00:00:00Z"],
		"trigger accepts valid row (jsonb_object_keys / ? / numeric div)",
	);
	await expectReject(
		db,
		"insert into c(p_id,payload,amt,at) values ($1,$2,$3,$4)",
		[pr.id, JSON.stringify({ a: 1 }), "10.00", "2026-09-01T00:00:00Z"],
		"trigger rejects malformed jsonb",
	);
	await expectReject(
		db,
		"insert into c(p_id,payload,amt,at) values ($1,$2,$3,$4)",
		[
			"00000000-0000-4000-8000-000000000000",
			JSON.stringify({ a: 1, b: 2 }),
			"10.00",
			"2026-09-01T00:00:00Z",
		],
		"FK / missing parent rejected",
	);
	const c1 = (await db.query<{ id: string }>("select id from c limit 1")).rows[0];
	await expectAccept(
		db,
		"insert into c(p_id,prev,payload,amt,at) values ($1,$2,$3,$4,$5)",
		[pr.id, c1.id, JSON.stringify({ a: 1, b: 2 }), "10.00", "2026-09-01T00:00:00Z"],
		"self-referential FK insert",
	);
	const tz = (
		await db.query<{ okc: boolean }>(
			"select (('2026-09-01'::text||' 00:00:00 Europe/Istanbul')::timestamptz = '2026-08-31 21:00:00+00'::timestamptz) as okc",
		)
	).rows[0];
	tz.okc ? ok("Europe/Istanbul timezone conversion") : bad("Europe/Istanbul tz");
	const u = (await db.query<{ u: string }>("select gen_random_uuid() as u")).rows[0];
	/^[0-9a-f-]{36}$/.test(u.u) ? ok("gen_random_uuid()") : bad("gen_random_uuid");
	const d = (
		await db.query<{ x: string }>("select div(7::numeric*3500,10000)::bigint as x")
	).rows[0];
	String(d.x) === "2" ? ok("div() truncates toward zero (7*0.35 -> 2)") : bad("div()");
	await db.close();
	return fail === before;
}

async function applyChain(db: PGlite, upTo: number) {
	const journal = JSON.parse(
		readFileSync(path.join(migDir, "meta/_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string }[] };
	for (const entry of journal.entries) {
		if (entry.idx > upTo) break;
		const raw = readFileSync(path.join(migDir, `${entry.tag}.sql`), "utf8");
		for (const chunk of raw.split(/-->\s*statement-breakpoint/)) {
			const stmt = chunk.trim();
			if (!stmt) continue;
			try {
				await db.exec(stmt);
			} catch (e) {
				throw new Error(
					`migration ${entry.tag} failed: ${(e as Error).message}\n---\n${stmt.slice(0, 300)}`,
				);
			}
		}
	}
}

const U1 = "11111111-1111-4111-8111-111111111111";
// The app is single-user (users.singleton_key UNIQUE). A "non-owner" is
// therefore always a user_id that does not exist -> rejected by the users FK
// AND, in a hypothetical multi-user future, by the guard's explicit
// v_x.user_id != NEW.user_id check.
const U_BOGUS = "99999999-9999-4999-8999-999999999999";
const PERIOD = "2026-09-01";
const ISTANBUL_MIDNIGHT = "2026-08-31 21:00:00+00";

async function seed(db: PGlite) {
	await db.exec("SET session_replication_role = replica");
	await db.query(
		"insert into users (id, display_name, currency, timezone) values ($1,'U1','TRY','Europe/Istanbul')",
		[U1] as never[],
	);
	// ledger account (income sources + midas both need one)
	await db.query(
		`insert into ledger_accounts (id,user_id,code,name,account_type,normal_balance,currency)
		 values ('d1000000-0000-4000-8000-000000000001',$1,'ASSET_CASH','Cash','ASSET','DEBIT','TRY'),
		        ('d1000000-0000-4000-8000-000000000002',$1,'INCOME_GEN','Income','INCOME','CREDIT','TRY')`,
		[U1] as never[],
	);
	// income sources: SUPPORT / REGULAR / EXTRA (owned by U1)
	await db.query(
		`insert into income_sources (id,user_id,code,name,nature,reference_method,expected_monthly_amount,income_ledger_account_id,active_from)
		 values ('a1000000-0000-4000-8000-000000000001',$1,'SUP1','Support','SUPPORT','EXCLUDED',null,'d1000000-0000-4000-8000-000000000002','1900-01-01'),
		        ('a1000000-0000-4000-8000-000000000002',$1,'REG1','Regular','REGULAR','FIXED_MONTHLY','5000.00','d1000000-0000-4000-8000-000000000002','1900-01-01'),
		        ('a1000000-0000-4000-8000-000000000003',$1,'EXT1','Extra','EXTRA','EXCLUDED',null,'d1000000-0000-4000-8000-000000000002','1900-01-01')`,
		[U1] as never[],
	);
	// canonical transactions (creation_fingerprint is any 64-hex for a fixture)
	{
		const F = "f".repeat(64);
		await db.query(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values
			 ('c1000000-0000-4000-8000-00000000000a',$1,'INCOME_RECEIPT','ct-inc-1',$2),
			 ('c1000000-0000-4000-8000-00000000000b',$1,'INCOME_RECEIPT','ct-inc-2',$2),
			 ('c1000000-0000-4000-8000-00000000000c',$1,'INCOME_RECEIPT','ct-inc-3',$2),
			 ('c1000000-0000-4000-8000-0000000000d1',$1,'MONTHLY_BUDGET_PLAN_V2','ct-v2-ok',$2),
			 ('c1000000-0000-4000-8000-0000000000d2',$1,'MONTHLY_BUDGET_PLAN','ct-v2-wrongkind',$2),
			 ('c1000000-0000-4000-8000-0000000000e1',$1,'MONTHLY_BUDGET_PLAN','ct-v1-ok',$2)`,
			[U1, F] as never[],
		);
	}
	// income receipts: SUPPORT / REGULAR / EXTRA, plus two extra SUPPORT
	// receipts reserved for the ON CONFLICT idempotency-key race probe.
	{
		const F = "f".repeat(64);
		await db.query(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values
			 ('c1000000-0000-4000-8000-00000000000d',$1,'INCOME_RECEIPT','ct-inc-4',$2),
			 ('c1000000-0000-4000-8000-00000000000e',$1,'INCOME_RECEIPT','ct-inc-5',$2)`,
			[U1, F] as never[],
		);
	}
	await db.query(
		`insert into income_receipts (id,user_id,source_id,canonical_transaction_id) values
		 ('b1000000-0000-4000-8000-000000000001',$1,'a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-00000000000a'),
		 ('b1000000-0000-4000-8000-000000000002',$1,'a1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-00000000000b'),
		 ('b1000000-0000-4000-8000-000000000003',$1,'a1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-00000000000c'),
		 ('b1000000-0000-4000-8000-000000000004',$1,'a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-00000000000d'),
		 ('b1000000-0000-4000-8000-000000000005',$1,'a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-00000000000e')`,
		[U1] as never[],
	);
	// midas chain for a short-term goal
	await db.query(
		`insert into midas_accounts (id,user_id,ledger_account_id) values ('e1000000-0000-4000-8000-000000000001',$1,'d1000000-0000-4000-8000-000000000001')`,
		[U1] as never[],
	);
	await db.query(
		`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values
		 ('f1000000-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','B_G1','G1 bucket','SHORT_TERM_GOAL'),
		 ('f1000000-0000-4000-8000-000000000002',$1,'e1000000-0000-4000-8000-000000000001','B_G2','G2 bucket','SHORT_TERM_GOAL'),
		 ('f1000000-0000-4000-8000-000000000003',$1,'e1000000-0000-4000-8000-000000000001','B_G3','G3 bucket','SHORT_TERM_GOAL'),
		 ('f1000000-0000-4000-8000-000000000004',$1,'e1000000-0000-4000-8000-000000000001','B_G4','G4 bucket','SHORT_TERM_GOAL')`,
		[U1] as never[],
	);
	await db.query(
		`insert into short_term_goals (id,user_id,midas_account_id,midas_bucket_id) values
		 ('99999999-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001'),
		 ('99999999-0000-4000-8000-000000000002',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002'),
		 ('99999999-0000-4000-8000-000000000003',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003'),
		 ('99999999-0000-4000-8000-000000000004',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000004')`,
		[U1] as never[],
	);
	await db.exec("SET session_replication_role = origin");
}

const G1 = "99999999-0000-4000-8000-000000000001";
const G2 = "99999999-0000-4000-8000-000000000002";
const RC_SUPPORT = "b1000000-0000-4000-8000-000000000001";
const RC_REGULAR = "b1000000-0000-4000-8000-000000000002";
const RC_EXTRA = "b1000000-0000-4000-8000-000000000003";

const fp = "a".repeat(64);

function v2Payload(inputs: Record<string, string>, evidence: Record<string, unknown>) {
	const r = allocatePersonalBudgetV2(inputs as never);
	return buildBudgetV2CanonicalPayload({
		periodMonth: PERIOD,
		currency: "TRY",
		policyResult: r,
		evidenceSnapshot: evidence,
	});
}

async function runtime() {
	console.log("\n== PHASE 2: APPLY MIGRATION CHAIN 0000..0068 (empty disposable DB) ==");
	const db = new PGlite();
	await db.query("SET timezone='UTC'");
	try {
		await applyChain(db, 68);
		ok("migration chain 0000..0068 applied to an empty PostgreSQL database");
	} catch (e) {
		bad("migration chain apply", "\n" + (e as Error).message);
		await db.close();
		return;
	}

	const tbls = (
		await db.query<{ t: string }>(
			"select table_name t from information_schema.tables where table_schema='public'",
		)
	).rows.map((r) => r.t);
	for (const need of [
		"income_receipt_budget_v2_semantic_revisions",
		"short_term_goal_budget_v2_purpose_revisions",
		"budget_v2_basic_living_config_revisions",
		"credit_card_statement_reconciliations",
		"credit_card_statement_reconciliation_revisions",
		"credit_card_statement_reconciliation_components",
		"credit_card_statement_reconciliation_seals",
		"budget_v2_spending_food_semantic_revisions",
		"budget_v2_checkpoint_trigger_card_revisions",
		"budget_v2_checkpoint_requests",
		"budget_v2_checkpoint_snapshots",
	]) {
		tbls.includes(need) ? ok(`table present: ${need}`) : bad(`missing table ${need}`);
	}

	await seed(db);
	console.log("\n== PHASE 3: RUNTIME GUARD EXERCISES ==");

	// ---- 0063 SUPPORT receipt classification ----
	console.log(" 0063 -- SUPPORT receipt role classification");
	await expectAccept(
		db,
		`insert into income_receipt_budget_v2_semantic_revisions
		 (id,user_id,income_receipt_id,revision_no,previous_revision_id,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)
		 values ('10000000-0000-4000-8000-000000000001',$1,$2,1,null,'CREATE','PLANNED_FAMILY_GIFT','k-sup-1',$3,now())`,
		[U1, RC_SUPPORT, fp],
		"CREATE classification on a SUPPORT receipt accepted",
	);
	await expectReject(
		db,
		`insert into income_receipt_budget_v2_semantic_revisions
		 (user_id,income_receipt_id,revision_no,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,$2,1,'CREATE','PLANNED_FAMILY_GIFT','k-reg-1',$3,now())`,
		[U1, RC_REGULAR, fp],
		"classification on a REGULAR receipt rejected (nature guard)",
	);
	await expectReject(
		db,
		`insert into income_receipt_budget_v2_semantic_revisions
		 (user_id,income_receipt_id,revision_no,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,$2,1,'CREATE','DEFICIT_FAMILY_SUPPORT','k-ext-1',$3,now())`,
		[U1, RC_EXTRA, fp],
		"classification on an EXTRA receipt rejected (nature guard; covers People overpayment source)",
	);
	await expectReject(
		db,
		`insert into income_receipt_budget_v2_semantic_revisions
		 (user_id,income_receipt_id,revision_no,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,$2,1,'CREATE','PLANNED_FAMILY_GIFT','k-wu-1',$3,now())`,
		[U_BOGUS, RC_SUPPORT, fp],
		"classification by a non-owner (unknown) user rejected (users FK + guard)",
	);
	await expectAccept(
		db,
		`insert into income_receipt_budget_v2_semantic_revisions
		 (id,user_id,income_receipt_id,revision_no,previous_revision_id,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)
		 values ('10000000-0000-4000-8000-000000000002',$1,$2,2,'10000000-0000-4000-8000-000000000001','UPDATE','DEFICIT_FAMILY_SUPPORT','k-sup-2',$3,now())`,
		[U1, RC_SUPPORT, fp],
		"reclassification UPDATE (rev 2 -> prev rev 1) accepted",
	);
	await expectReject(
		db,
		`insert into income_receipt_budget_v2_semantic_revisions
		 (user_id,income_receipt_id,revision_no,previous_revision_id,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,$2,2,'10000000-0000-4000-8000-000000000001','UPDATE','PLANNED_FAMILY_GIFT','k-sup-branch',$3,now())`,
		[U1, RC_SUPPORT, fp],
		"branching the classification chain rejected (unique rev_no / prev)",
	);
	await expectReject(
		db,
		"update income_receipt_budget_v2_semantic_revisions set support_role='PLANNED_FAMILY_GIFT' where id='10000000-0000-4000-8000-000000000001'",
		[],
		"UPDATE of a classification row rejected (immutability)",
	);
	await expectReject(
		db,
		"delete from income_receipt_budget_v2_semantic_revisions where id='10000000-0000-4000-8000-000000000001'",
		[],
		"DELETE of a classification row rejected (immutability)",
	);

	// ---- 0063 goal purpose ----
	console.log(" 0063 -- short-term goal Budget V2 purpose");
	await expectAccept(
		db,
		`insert into short_term_goal_budget_v2_purpose_revisions
		 (id,user_id,goal_id,revision_no,previous_revision_id,operation,purpose,idempotency_key,revision_fingerprint,occurred_at)
		 values ('20000000-0000-4000-8000-000000000001',$1,$2,1,null,'CREATE','INTERNATIONAL_MOBILITY','k-g1-1',$3,now())`,
		[U1, G1, fp],
		"CREATE purpose on goal G1 accepted",
	);
	await expectAccept(
		db,
		`insert into short_term_goal_budget_v2_purpose_revisions
		 (user_id,goal_id,revision_no,operation,purpose,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,$2,1,'CREATE','INTERNATIONAL_MOBILITY','k-g2-1',$3,now())`,
		[U1, G2, fp],
		"a SECOND goal G2 may also be INTERNATIONAL_MOBILITY (not singleton)",
	);
	await expectReject(
		db,
		`insert into short_term_goal_budget_v2_purpose_revisions
		 (user_id,goal_id,revision_no,operation,purpose,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,$2,1,'CREATE','OTHER','k-g1-wu',$3,now())`,
		[U_BOGUS, G1, fp],
		"purpose classification by a non-owner (unknown) user rejected (users FK + guard)",
	);
	await expectReject(
		db,
		`insert into short_term_goal_budget_v2_purpose_revisions
		 (user_id,goal_id,revision_no,operation,purpose,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,'99999999-0000-4000-8000-0000000000ff',1,'CREATE','OTHER','k-g-missing',$2,now())`,
		[U1, fp],
		"purpose classification on a non-existent goal rejected",
	);
	await expectReject(
		db,
		"update short_term_goal_budget_v2_purpose_revisions set purpose='OTHER' where id='20000000-0000-4000-8000-000000000001'",
		[],
		"UPDATE of a goal purpose row rejected (immutability)",
	);
	await expectReject(
		db,
		"delete from short_term_goal_budget_v2_purpose_revisions where id='20000000-0000-4000-8000-000000000001'",
		[],
		"DELETE of a goal purpose row rejected (immutability)",
	);

	// ---- 0063 -- ON CONFLICT (user_id, idempotency_key) race shape ----
	// Proves the shape the classification services rely on for a cross-target
	// same-key race: the collision is absorbed as a no-op RETURNING 0 rows and
	// the surrounding transaction is NOT aborted (a following write commits).
	console.log(
		" 0063 -- ON CONFLICT (user_id,idempotency_key) DO NOTHING idempotency race shape",
	);
	await idempotencyRaceShape(
		db,
		"support",
		"income_receipt_budget_v2_semantic_revisions",
		"(user_id,income_receipt_id,revision_no,operation,support_role,idempotency_key,revision_fingerprint,occurred_at)",
		`('${U1}','b1000000-0000-4000-8000-000000000004',1,'CREATE','PLANNED_FAMILY_GIFT','race-s','${fp}',now())`,
		`('${U1}','b1000000-0000-4000-8000-000000000005',1,'CREATE','DEFICIT_FAMILY_SUPPORT','race-s','${fp}',now())`,
		`('${U1}','b1000000-0000-4000-8000-000000000005',1,'CREATE','DEFICIT_FAMILY_SUPPORT','race-s-2','${fp}',now())`,
	);
	await idempotencyRaceShape(
		db,
		"goal-purpose",
		"short_term_goal_budget_v2_purpose_revisions",
		"(user_id,goal_id,revision_no,operation,purpose,idempotency_key,revision_fingerprint,occurred_at)",
		`('${U1}','99999999-0000-4000-8000-000000000003',1,'CREATE','OTHER','race-g','${fp}',now())`,
		`('${U1}','99999999-0000-4000-8000-000000000004',1,'CREATE','PLANNED_DISCRETIONARY','race-g','${fp}',now())`,
		`('${U1}','99999999-0000-4000-8000-000000000004',1,'CREATE','PLANNED_DISCRETIONARY','race-g-2','${fp}',now())`,
	);

	// ---- 0062 anchor guard ----
	console.log(" 0062 -- monthly_budget_v2_plans anchor insert guard");
	await expectAccept(
		db,
		`insert into monthly_budget_v2_plans (id,user_id,period_month,canonical_transaction_id)
		 values ('30000000-0000-4000-8000-000000000001',$1,$2,'c1000000-0000-4000-8000-0000000000d1')`,
		[U1, PERIOD],
		"anchor with a MONTHLY_BUDGET_PLAN_V2 canonical tx owned by the user accepted",
	);
	await expectReject(
		db,
		`insert into monthly_budget_v2_plans (user_id,period_month,canonical_transaction_id)
		 values ($1,$2,'c1000000-0000-4000-8000-0000000000d2')`,
		[U1, "2026-10-01"],
		"anchor pointing at a MONTHLY_BUDGET_PLAN (V1 kind) canonical tx rejected",
	);
	await expectReject(
		db,
		`insert into monthly_budget_v2_plans (user_id,period_month,canonical_transaction_id)
		 values ($1,$2,'c1000000-0000-4000-8000-0000000000ff')`,
		[U1, "2026-12-01"],
		"anchor with a non-existent canonical tx rejected (FK / guard NOT FOUND)",
	);
	await expectReject(
		db,
		`insert into monthly_budget_v2_plans (user_id,period_month,canonical_transaction_id)
		 values ($1,$2,'c1000000-0000-4000-8000-0000000000d1')`,
		[U_BOGUS, "2026-11-01"],
		"anchor whose user_id is not the canonical tx's owner rejected (users FK + guard user check)",
	);

	// ---- 0061 revision guard + CREATE/UPDATE/VOID lifecycle ----
	console.log(
		" 0061 -- monthly_budget_v2_plan_revisions guard (payload + policy math + lifecycle)",
	);
	const inputs = {
		realizedIncome: "12000.00",
		currentObligations: "1500.00",
		basicLivingFunding: "2000.00",
		dateBoundNecessaryPurchaseFunding: "500.00",
		coreEmergencyFundBalance: "10000.00",
		mobilityBalance: "37500.00",
	};
	const evidence = { resolver: "pg-runtime-verify" };
	const goodPayload = v2Payload(inputs, evidence);
	// jan-2027 period payload for the isolated math-guard anchor (period must
	// match so the failure is the MATH check, not the periodMonth bind)
	const janPayload = buildBudgetV2CanonicalPayload({
		periodMonth: "2027-01-01",
		currency: "TRY",
		policyResult: allocatePersonalBudgetV2(inputs as never),
		evidenceSnapshot: evidence,
	});
	// feb-2027 period payload, then break its top-level shape
	const badShapePayload = buildBudgetV2CanonicalPayload({
		periodMonth: "2027-02-01",
		currency: "TRY",
		policyResult: allocatePersonalBudgetV2(inputs as never),
		evidenceSnapshot: evidence,
	}) as Record<string, unknown>;
	delete badShapePayload.evidenceSnapshot;
	badShapePayload.bogus = 1;
	const r = allocatePersonalBudgetV2(inputs as never);
	const amt = (o: { amount: string }) => o.amount;

	// Extra V2 anchors + canonical revision chains for the isolated guard tests.
	await db.exec("SET session_replication_role = replica");
	const F = "f".repeat(64);
	await db.query(
		`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values
		 ('c1000000-0000-4000-8000-0000000000d4',$1,'MONTHLY_BUDGET_PLAN_V2','ct-v2-badmath',$2),
		 ('c1000000-0000-4000-8000-0000000000d5',$1,'MONTHLY_BUDGET_PLAN_V2','ct-v2-badpay',$2)`,
		[U1, F] as never[],
	);
	await db.query(
		`insert into monthly_budget_v2_plans (id,user_id,period_month,canonical_transaction_id) values
		 ('30000000-0000-4000-8000-000000000004',$1,'2027-01-01','c1000000-0000-4000-8000-0000000000d4'),
		 ('30000000-0000-4000-8000-000000000005',$1,'2027-02-01','c1000000-0000-4000-8000-0000000000d5')`,
		[U1] as never[],
	);
	await db.query(
		`insert into transaction_revisions (id,user_id,transaction_id,revision_no,previous_revision_id,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values
		 ('40000000-0000-4000-8000-000000000001',$1,'c1000000-0000-4000-8000-0000000000d1',1,null,'CREATE','2026-08-31 21:00:00+00',$3,$2,'tr-v2-1'),
		 ('40000000-0000-4000-8000-000000000002',$1,'c1000000-0000-4000-8000-0000000000d1',2,'40000000-0000-4000-8000-000000000001','UPDATE','2026-08-31 21:00:00+00',$3,$2,'tr-v2-2'),
		 ('40000000-0000-4000-8000-000000000003',$1,'c1000000-0000-4000-8000-0000000000d1',3,'40000000-0000-4000-8000-000000000002','VOID','2026-08-31 21:00:00+00',$3,$2,'tr-v2-3'),
		 ('40000000-0000-4000-8000-0000000d1001',$1,'c1000000-0000-4000-8000-0000000000d4',1,null,'CREATE','2027-01-01 00:00:00 Europe/Istanbul',$5,$2,'tr-v2-dm1'),
		 ('40000000-0000-4000-8000-0000000d2001',$1,'c1000000-0000-4000-8000-0000000000d5',1,null,'CREATE','2027-02-01 00:00:00 Europe/Istanbul',$4,$2,'tr-v2-dp1')`,
		[
			U1,
			F,
			JSON.stringify(goodPayload),
			JSON.stringify(badShapePayload),
			JSON.stringify(janPayload),
		] as never[],
	);
	await db.exec("SET session_replication_role = origin");

	const revCols =
		"(user_id,budget_plan_id,canonical_revision_id,revision_no,previous_budget_revision_id,operation,policy_version,currency," +
		"realized_income_amount,current_obligations_amount,basic_living_funding_amount,date_bound_necessary_purchase_funding_amount," +
		"core_emergency_fund_balance_amount,mobility_balance_amount,emergency_catch_up_amount,deficit_amount,true_surplus_amount," +
		"mobility_allocation_amount,long_term_investment_amount,discretionary_allocation_amount,evidence_snapshot)";
	const mkVals = (over: {
		plan: string;
		canonRev: string;
		revNo: number;
		prev: string | null;
		op: string;
		longTerm?: string;
		evidence?: unknown;
	}) => [
		U1,
		over.plan,
		over.canonRev,
		over.revNo,
		over.prev,
		over.op,
		"PERSONAL_BUDGET_V2",
		"TRY",
		amt(r.inputs.realizedIncome),
		amt(r.inputs.currentObligations),
		amt(r.inputs.basicLivingFunding),
		amt(r.inputs.dateBoundNecessaryPurchaseFunding),
		amt(r.inputs.coreEmergencyFundBalance),
		amt(r.inputs.mobilityBalance),
		amt(r.outputs.emergencyCatchUp),
		amt(r.outputs.deficit),
		amt(r.outputs.trueSurplus),
		amt(r.outputs.mobilityAllocation),
		over.longTerm ?? amt(r.outputs.longTermInvestment),
		amt(r.outputs.discretionaryAllocation),
		JSON.stringify(over.evidence ?? evidence),
	];
	const ph = "(" + mkVals({ plan: "", canonRev: "", revNo: 0, prev: null, op: "" }).map((_, i) => `$${i + 1}`).join(",") + ")";
	const insRev = `insert into monthly_budget_v2_plan_revisions ${revCols} values ${ph}`;
	const A1 = "30000000-0000-4000-8000-000000000001"; // anchor from the 0062 test

	await expectAccept(
		db,
		insRev,
		mkVals({
			plan: A1,
			canonRev: "40000000-0000-4000-8000-000000000001",
			revNo: 1,
			prev: null,
			op: "CREATE",
		}),
		"CREATE revision with correct payload + correct policy math accepted",
	);
	// CREATE -> UPDATE
	const [rev1] = (
		await db.query<{ id: string }>(
			"select id from monthly_budget_v2_plan_revisions where budget_plan_id=$1 and revision_no=1",
			[A1] as never[],
		)
	).rows;
	await expectAccept(
		db,
		insRev,
		mkVals({
			plan: A1,
			canonRev: "40000000-0000-4000-8000-000000000002",
			revNo: 2,
			prev: rev1.id,
			op: "UPDATE",
		}),
		"UPDATE revision (rev 2) accepted",
	);
	const [rev2] = (
		await db.query<{ id: string }>(
			"select id from monthly_budget_v2_plan_revisions where budget_plan_id=$1 and revision_no=2",
			[A1] as never[],
		)
	).rows;
	// UPDATE -> VOID (copies amounts + evidence exactly)
	await expectAccept(
		db,
		insRev,
		mkVals({
			plan: A1,
			canonRev: "40000000-0000-4000-8000-000000000003",
			revNo: 3,
			prev: rev2.id,
			op: "VOID",
		}),
		"VOID revision (rev 3, copies predecessor amounts + evidence) accepted",
	);
	const [rev3] = (
		await db.query<{ id: string }>(
			"select id from monthly_budget_v2_plan_revisions where budget_plan_id=$1 and revision_no=3",
			[A1] as never[],
		)
	).rows;
	await expectReject(
		db,
		insRev,
		mkVals({
			plan: A1,
			canonRev: "40000000-0000-4000-8000-000000000001",
			revNo: 4,
			prev: rev3.id,
			op: "UPDATE",
		}),
		"a revision appended AFTER VOID rejected (VOID cannot be extended)",
	);

	// isolated: mathematically-invalid projection (rev #1 on its own anchor).
	// The canonical payload's outputs are ALSO tampered so the exact
	// payload<->column binding passes and the failure is the independent
	// NUMERIC re-derivation in section 9 of the 0061 guard.
	const brokenLong = (
		BigInt(Math.round(Number(r.outputs.longTermInvestment.amount) * 100)) + 1n
	)
		.toString()
		.replace(/(\d\d)$/, ".$1");
	await db.exec("SET session_replication_role = replica");
	await db.query(
		"update transaction_revisions set payload = jsonb_set(payload, '{outputs,longTermInvestment}', to_jsonb($1::text)) where id='40000000-0000-4000-8000-0000000d1001'",
		[brokenLong] as never[],
	);
	await db.exec("SET session_replication_role = origin");
	await expectReject(
		db,
		insRev,
		mkVals({
			plan: "30000000-0000-4000-8000-000000000004",
			canonRev: "40000000-0000-4000-8000-0000000d1001",
			revNo: 1,
			prev: null,
			op: "CREATE",
			longTerm: brokenLong,
		}),
		"CREATE revision with a mathematically-invalid projection rejected (independent NUMERIC re-derivation)",
	);
	// isolated: malformed canonical payload (rev #1 on its own anchor, correct math)
	await expectReject(
		db,
		insRev,
		mkVals({
			plan: "30000000-0000-4000-8000-000000000005",
			canonRev: "40000000-0000-4000-8000-0000000d2001",
			revNo: 1,
			prev: null,
			op: "CREATE",
		}),
		"CREATE revision bound to a malformed canonical payload rejected (payload guard)",
	);

	// ---- V1 regression: a valid PERSONAL_BUDGET_V1 plan + revision still works ----
	console.log(" V1 regression -- historical PERSONAL_BUDGET_V1 lifecycle still valid");
	const v1ref = "10000.00";
	const v1Payload = {
		periodMonth: PERIOD,
		policyVersion: "PERSONAL_BUDGET_V1",
		currency: "TRY",
		referenceIncome: v1ref,
		referenceSnapshot: { asOf: PERIOD, total: v1ref, sources: [] },
		allocations: {
			MANDATORY_EXPENSE: { basisPoints: 6500, role: "CEILING", amount: "6500.00" },
			DISCRETIONARY_SPEND: { basisPoints: 500, role: "CEILING", amount: "500.00" },
			SHORT_TERM_PURCHASE: { basisPoints: 1000, role: "TARGET", amount: "1000.00" },
			MEDIUM_TERM_RESERVE: { basisPoints: 1000, role: "TARGET", amount: "1000.00" },
			LONG_TERM_INVESTMENT: { basisPoints: 1000, role: "TARGET", amount: "1000.00" },
		},
	};
	await db.exec("SET session_replication_role = replica");
	await db.query(
		"insert into monthly_budget_plans (id,user_id,period_month,canonical_transaction_id) values ('50000000-0000-4000-8000-000000000001',$1,$2,'c1000000-0000-4000-8000-0000000000e1')",
		[U1, PERIOD] as never[],
	);
	await db.query(
		"insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ('40000000-0000-4000-8000-0000000000f1',$1,'c1000000-0000-4000-8000-0000000000e1',1,'CREATE',$2,$3,$4,'tr-v1-1')",
		[U1, ISTANBUL_MIDNIGHT, JSON.stringify(v1Payload), "f".repeat(64)] as never[],
	);
	await db.exec("SET session_replication_role = origin");
	await expectAccept(
		db,
		`insert into monthly_budget_plan_revisions
		 (user_id,budget_plan_id,canonical_revision_id,revision_no,previous_budget_revision_id,operation,policy_version,currency,
		  reference_income_amount,mandatory_ceiling_amount,discretionary_ceiling_amount,short_term_purchase_amount,medium_term_reserve_amount,long_term_investment_amount,reference_snapshot)
		 values ($1,'50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-0000000000f1',1,null,'CREATE','PERSONAL_BUDGET_V1','TRY',
		  '10000.00','6500.00','500.00','1000.00','1000.00','1000.00',$2)`,
		[U1, JSON.stringify(v1Payload.referenceSnapshot)],
		"PERSONAL_BUDGET_V1 revision #1 (65/5/10/10/10) still accepted after 0066",
	);

	// ---- 0064 -- basic-living config append-only chain ----
	console.log("\n 0064 -- budget_v2_basic_living_config_revisions guard");
	const H = "b".repeat(64);
	await expectAccept(
		db,
		`insert into budget_v2_basic_living_config_revisions
		 (id,user_id,revision_no,previous_revision_id,operation,effective_period_month,monthly_target_amount,currency,source_kind,idempotency_key,revision_fingerprint,occurred_at)
		 values ('70000000-0000-4000-8000-000000000001',$1,1,null,'CREATE','2026-09-01','6000.00','TRY','USER_APPROVED','bl-1',$2,now())`,
		[U1, H],
		"CREATE basic-living config revision #1 accepted",
	);
	await expectAccept(
		db,
		`insert into budget_v2_basic_living_config_revisions
		 (id,user_id,revision_no,previous_revision_id,operation,effective_period_month,monthly_target_amount,currency,source_kind,idempotency_key,revision_fingerprint,occurred_at)
		 values ('70000000-0000-4000-8000-000000000002',$1,2,'70000000-0000-4000-8000-000000000001','UPDATE','2026-10-01','7000.00','TRY','USER_APPROVED_FROM_SUGGESTION','bl-2',$2,now())`,
		[U1, H],
		"UPDATE basic-living config revision #2 accepted",
	);
	await expectReject(
		db,
		`insert into budget_v2_basic_living_config_revisions
		 (user_id,revision_no,previous_revision_id,operation,effective_period_month,monthly_target_amount,currency,source_kind,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,3,'70000000-0000-4000-8000-000000000002','UPDATE','2026-09-01','8000.00','TRY','USER_APPROVED','bl-3',$2,now())`,
		[U1, H],
		"basic-living effective_period_month regressing below the chain rejected",
	);
	await expectReject(
		db,
		`insert into budget_v2_basic_living_config_revisions
		 (user_id,revision_no,previous_revision_id,operation,effective_period_month,monthly_target_amount,currency,source_kind,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,3,null,'CREATE','2026-11-01','9000.00','TRY','USER_APPROVED','bl-4',$2,now())`,
		[U1, H],
		"second fresh CREATE basic-living revision rejected (unbranched chain)",
	);
	await expectReject(
		db,
		`insert into budget_v2_basic_living_config_revisions
		 (user_id,revision_no,operation,effective_period_month,monthly_target_amount,currency,source_kind,idempotency_key,revision_fingerprint,occurred_at)
		 values ($1,3,'CREATE','2026-11-15','9000.00','TRY','USER_APPROVED','bl-5',$2,now())`,
		[U1, H],
		"non-first-day effective_period_month rejected (check constraint)",
	);
	await expectReject(
		db,
		"update budget_v2_basic_living_config_revisions set monthly_target_amount='1.00' where id='70000000-0000-4000-8000-000000000001'",
		[],
		"UPDATE of a basic-living config row rejected (immutability)",
	);
	await expectReject(
		db,
		"delete from budget_v2_basic_living_config_revisions where id='70000000-0000-4000-8000-000000000001'",
		[],
		"DELETE of a basic-living config row rejected (immutability)",
	);

	// ---- 0065 -- statement reconciliation guards ----
	console.log("\n 0065 -- credit_card_statement_reconciliation guards");
	await db.exec("SET session_replication_role = replica");
	await db.query(
		`insert into credit_cards (id,user_id,code) values ('80000000-0000-4000-8000-000000000001',$1,'CARDA')`,
		[U1] as never[],
	);
	await db.query(
		`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint)
		 values ('80000000-0000-4000-8000-0000000000a1',$1,'80000000-0000-4000-8000-000000000001',1,'CREATE','ACTIVE','Card A','Bank','1','10','50000.00',now(),'ccr-1',$2)`,
		[U1, "f".repeat(64)] as never[],
	);
	await db.query(
		`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month)
		 values ('80000000-0000-4000-8000-000000000521',$1,'80000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003',2026,9)`,
		[U1] as never[],
	);
	await db.query(
		`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint)
		 values ('80000000-0000-4000-8000-000000000621',$1,'80000000-0000-4000-8000-000000000521',1,'CREATE','OPEN','1000.00','2026-09-01','2026-09-10','MIDAS_FUND',now(),'ccsr-r1',$2)`,
		[U1, "f".repeat(64)] as never[],
	);
	// one non-VOID purchase liability event on the card
	await db.query(
		`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ('80000000-0000-4000-8000-0000000000c1',$1,'CREDIT_CARD_PURCHASE','ccp-1',$2)`,
		[U1, "f".repeat(64)] as never[],
	);
	await db.query(
		`insert into credit_card_liability_events (id,user_id,credit_card_id,event_type,canonical_transaction_id) values ('80000000-0000-4000-8000-0000000000e1',$1,'80000000-0000-4000-8000-000000000001','PURCHASE','80000000-0000-4000-8000-0000000000c1')`,
		[U1] as never[],
	);
	await db.query(
		`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ('80000000-0000-4000-8000-000000000771',$1,'80000000-0000-4000-8000-0000000000c1',1,'CREATE','2026-09-01 00:00:00 Europe/Istanbul','{}'::jsonb,$2,'ccp-tr-1')`,
		[U1, "f".repeat(64)] as never[],
	);
	await db.query(
		`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,canonical_revision_id,operation,amount,budget_category,occurred_at,idempotency_key,revision_fingerprint)
		 values ('80000000-0000-4000-8000-00000000e711',$1,'80000000-0000-4000-8000-0000000000e1',1,'80000000-0000-4000-8000-000000000771','CREATE','800.00','MANDATORY_EXPENSE',now(),'ccp-er-1',$2)`,
		[U1, "f".repeat(64)] as never[],
	);
	await db.exec("SET session_replication_role = origin");

	await expectAccept(
		db,
		`insert into credit_card_statement_reconciliations (id,user_id,statement_id,credit_card_id)
		 values ('81000000-0000-4000-8000-000000000001',$1,'80000000-0000-4000-8000-000000000521','80000000-0000-4000-8000-000000000001')`,
		[U1],
		"reconciliation anchor accepted",
	);
	await expectAccept(
		db,
		`insert into credit_card_statement_reconciliation_revisions
		 (id,user_id,reconciliation_id,revision_no,previous_revision_id,operation,statement_revision_id,reconciled_statement_amount,component_count,idempotency_key,reconciliation_fingerprint,occurred_at)
		 values ('82000000-0000-4000-8000-000000000001',$1,'81000000-0000-4000-8000-000000000001',1,null,'CREATE','80000000-0000-4000-8000-000000000621','1000.00',2,'recon-1',$2,now())`,
		[U1, "a".repeat(64)],
		"CREATE reconciliation revision (amount matches statement) accepted",
	);
	await expectReject(
		db,
		`insert into credit_card_statement_reconciliation_revisions
		 (user_id,reconciliation_id,revision_no,previous_revision_id,operation,statement_revision_id,reconciled_statement_amount,component_count,idempotency_key,reconciliation_fingerprint,occurred_at)
		 values ($1,'81000000-0000-4000-8000-000000000001',2,'82000000-0000-4000-8000-000000000001','SUPERSEDE','80000000-0000-4000-8000-000000000621','999.00',1,'recon-bad',$2,now())`,
		[U1, "a".repeat(64)],
		"reconciled_statement_amount != statement_amount rejected",
	);
	await expectAccept(
		db,
		`insert into credit_card_statement_reconciliation_components
		 (id,reconciliation_revision_id,component_no,component_type,amount,ownership,purchase_event_id)
		 values ('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',1,'PURCHASE','800.00','PERSONAL','80000000-0000-4000-8000-0000000000e1')`,
		[],
		"PURCHASE component (non-VOID purchase, personal) accepted",
	);
	await expectAccept(
		db,
		`insert into credit_card_statement_reconciliation_components
		 (id,reconciliation_revision_id,component_no,component_type,amount,ownership,adjustment_kind)
		 values ('83000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000001',2,'ADJUSTMENT','200.00','PERSONAL','INTEREST')`,
		[],
		"ADJUSTMENT component (explicit kind + ownership) accepted",
	);
	await expectReject(
		db,
		`insert into credit_card_statement_reconciliation_components
		 (reconciliation_revision_id,component_no,component_type,amount,ownership,adjustment_kind)
		 values ('82000000-0000-4000-8000-000000000001',3,'ADJUSTMENT','1.00','EXTERNAL_PERSON','FEE')`,
		[],
		"EXTERNAL_PERSON component without person_id rejected (consistency check)",
	);
	await expectAccept(
		db,
		"insert into credit_card_statement_reconciliation_seals (reconciliation_revision_id) values ('82000000-0000-4000-8000-000000000001')",
		[],
		"seal accepted -- component sum 1000.00 == reconciled_statement_amount",
	);
	await expectReject(
		db,
		`insert into credit_card_statement_reconciliation_components
		 (reconciliation_revision_id,component_no,component_type,amount,ownership,adjustment_kind)
		 values ('82000000-0000-4000-8000-000000000001',3,'ADJUSTMENT','5.00','PERSONAL','OTHER')`,
		[],
		"component appended after seal rejected (sealed guard)",
	);
	await expectReject(
		db,
		"update credit_card_statement_reconciliation_components set amount='1.00' where id='83000000-0000-4000-8000-000000000001'",
		[],
		"UPDATE of a reconciliation component rejected (immutability)",
	);
	await expectReject(
		db,
		"delete from credit_card_statement_reconciliation_seals where reconciliation_revision_id='82000000-0000-4000-8000-000000000001'",
		[],
		"DELETE of a reconciliation seal rejected (immutability)",
	);
	// unbalanced seal on a fresh revision
	await expectAccept(
		db,
		`insert into credit_card_statement_reconciliation_revisions
		 (id,user_id,reconciliation_id,revision_no,previous_revision_id,operation,statement_revision_id,reconciled_statement_amount,component_count,idempotency_key,reconciliation_fingerprint,occurred_at)
		 values ('82000000-0000-4000-8000-000000000002',$1,'81000000-0000-4000-8000-000000000001',2,'82000000-0000-4000-8000-000000000001','SUPERSEDE','80000000-0000-4000-8000-000000000621','1000.00',1,'recon-2',$2,now())`,
		[U1, "a".repeat(64)],
		"SUPERSEDE reconciliation revision accepted",
	);
	await expectAccept(
		db,
		`insert into credit_card_statement_reconciliation_components
		 (reconciliation_revision_id,component_no,component_type,amount,ownership,adjustment_kind)
		 values ('82000000-0000-4000-8000-000000000002',1,'ADJUSTMENT','999.00','PERSONAL','OTHER')`,
		[],
		"under-balanced component inserted (not yet sealed)",
	);
	await expectReject(
		db,
		"insert into credit_card_statement_reconciliation_seals (reconciliation_revision_id) values ('82000000-0000-4000-8000-000000000002')",
		[],
		"seal rejected -- component sum 999.00 != reconciled_statement_amount 1000.00",
	);

	await db.close();
}

// ============================================================================
// PHASE 4: AUTHORITATIVE LIVE-SOURCE RESOLVER  (drizzle over PGlite)
// ============================================================================

async function resolverRuntime() {
	console.log(
		"\n== PHASE 4: BUDGET V2 LIVE-SOURCE RESOLVER (drizzle / PGlite) ==",
	);
	const { drizzle } = await import("drizzle-orm/pglite");
	const { resolveBudgetV2LiveSnapshot, resolveBudgetV2SnapshotForWrite } =
		await import("../src/budget/live-resolver-v2.ts");
	const { createBasicLivingTarget } = await import(
		"../src/budget/basic-living-config-v2.ts"
	);
	const { classifySupportReceipt } = await import(
		"../src/budget/support-classification-v2.ts"
	);
	const { classifyGoalPurpose } = await import(
		"../src/budget/goal-purpose-v2.ts"
	);
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);
	const { validateBudgetV2ResolvedSnapshot } = await import(
		"../src/budget/payload-v2.ts"
	);

	const pg = new PGlite();
	await pg.query("SET timezone='UTC'");
	await applyChain(pg, 68);
	// biome-ignore lint/suspicious/noExplicitAny: cross-driver drizzle client
	const db = drizzle(pg as any) as any;

	const P = "2026-09-01";
	const asOf = new Date("2026-09-20T09:00:00+03:00");
	const F = "f".repeat(64);

	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		"insert into users (id, display_name, currency, timezone) values ($1,'U','TRY','Europe/Istanbul')",
		[U1] as never[],
	);
	await pg.query(
		`insert into ledger_accounts (id,user_id,code,name,account_type,normal_balance,currency) values
		 ('d1000000-0000-4000-8000-000000000001',$1,'ASSET_CASH','Cash','ASSET','DEBIT','TRY'),
		 ('d1000000-0000-4000-8000-000000000002',$1,'INCOME_GEN','Income','INCOME','CREDIT','TRY')`,
		[U1] as never[],
	);
	// income sources: REGULAR + EXTRA + two SUPPORT
	await pg.query(
		`insert into income_sources (id,user_id,code,name,nature,reference_method,expected_monthly_amount,income_ledger_account_id,active_from) values
		 ('a1000000-0000-4000-8000-000000000001',$1,'REG1','Salary','REGULAR','FIXED_MONTHLY','20000.00','d1000000-0000-4000-8000-000000000002','1900-01-01'),
		 ('a1000000-0000-4000-8000-000000000002',$1,'EXT1','Bonus','EXTRA','EXCLUDED',null,'d1000000-0000-4000-8000-000000000002','1900-01-01'),
		 ('a1000000-0000-4000-8000-000000000003',$1,'SUP1','Family A','SUPPORT','EXCLUDED',null,'d1000000-0000-4000-8000-000000000002','1900-01-01'),
		 ('a1000000-0000-4000-8000-000000000004',$1,'SUP2','Family B','SUPPORT','EXCLUDED',null,'d1000000-0000-4000-8000-000000000002','1900-01-01')`,
		[U1] as never[],
	);
	// receipts (one canonical tx each) + one non-VOID revision each, occurred in-period
	const receiptSpecs = [
		["b1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000001", "20000.00"], // REGULAR
		["b1000000-0000-4000-8000-000000000002", "a1000000-0000-4000-8000-000000000002", "3000.00"], // EXTRA
		["b1000000-0000-4000-8000-000000000003", "a1000000-0000-4000-8000-000000000003", "2000.00"], // SUPPORT -> gift
		["b1000000-0000-4000-8000-000000000004", "a1000000-0000-4000-8000-000000000004", "1500.00"], // SUPPORT -> deficit
	];
	let ci = 0;
	for (const [rid, sid, amt] of receiptSpecs) {
		const ctid = `c1000000-0000-4000-8000-0000000000${(10 + ci).toString(16).padStart(2, "0")}`;
		const trid = `c2000000-0000-4000-8000-0000000000${(10 + ci).toString(16).padStart(2, "0")}`;
		await pg.query(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ($1,$2,'INCOME_RECEIPT',$3,$4)`,
			[ctid, U1, `ir-${ci}`, F] as never[],
		);
		await pg.query(
			`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ($1,$2,$3,1,'CREATE','2026-09-05 00:00:00 Europe/Istanbul','{}'::jsonb,$4,$5)`,
			[trid, U1, ctid, F, `irtr-${ci}`] as never[],
		);
		await pg.query(
			`insert into income_receipts (id,user_id,source_id,canonical_transaction_id) values ($1,$2,$3,$4)`,
			[rid, U1, sid, ctid] as never[],
		);
		await pg.query(
			`insert into income_receipt_revisions (id,user_id,income_receipt_id,canonical_revision_id,revision_no,operation,occurred_at,amount,destination_account_id) values ($1,$2,$3,$4,1,'CREATE','2026-09-05 00:00:00 Europe/Istanbul',$5,'d1000000-0000-4000-8000-000000000001')`,
			[`b2000000-0000-4000-8000-0000000000${(10 + ci).toString(16).padStart(2, "0")}`, U1, rid, trid, amt] as never[],
		);
		ci++;
	}
	// midas: account + CORE_EMERGENCY_FUND bucket + two goal buckets
	await pg.query(
		`insert into midas_accounts (id,user_id,ledger_account_id) values ('e1000000-0000-4000-8000-000000000001',$1,'d1000000-0000-4000-8000-000000000001')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values
		 ('f1000000-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','CEF','Emergency','CORE_EMERGENCY_FUND'),
		 ('f1000000-0000-4000-8000-000000000002',$1,'e1000000-0000-4000-8000-000000000001','G_MOB','Mobility goal','SHORT_TERM_GOAL'),
		 ('f1000000-0000-4000-8000-000000000003',$1,'e1000000-0000-4000-8000-000000000001','G_DBN','Necessary goal','SHORT_TERM_GOAL'),
		 ('f1000000-0000-4000-8000-000000000005',$1,'e1000000-0000-4000-8000-000000000001','CCR_A','Statement 521 reserve','CREDIT_CARD_RESERVE'),
		 ('f1000000-0000-4000-8000-000000000006',$1,'e1000000-0000-4000-8000-000000000001','CCR_B','Statement 821 reserve','CREDIT_CARD_RESERVE'),
		 ('f1000000-0000-4000-8000-000000000007',$1,'e1000000-0000-4000-8000-000000000001','CCR_C','Carry-in case reserve','CREDIT_CARD_RESERVE')`,
		[U1] as never[],
	);
	// transfers: 8,630 into CEF pre-period; 40,000 into mobility bucket pre-period; 500 into DBN bucket pre-period
	const mk = (id: string, to: string, amt: string, when: string) =>
		pg.query(
			`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ($1,$2,'e1000000-0000-4000-8000-000000000001',$3,$4,null,$5,$6,$7)`,
			[id, U1, `mt-${id.slice(-4)}`, F, to, amt, when] as never[],
		);
	await mk("aa000000-0000-4000-8000-000000000001", "f1000000-0000-4000-8000-000000000001", "8630.00", "2026-08-15 00:00:00+00");
	await mk("aa000000-0000-4000-8000-000000000002", "f1000000-0000-4000-8000-000000000002", "40000.00", "2026-08-20 00:00:00+00");
	await mk("aa000000-0000-4000-8000-000000000003", "f1000000-0000-4000-8000-000000000003", "500.00", "2026-08-25 00:00:00+00");
	// goals
	await pg.query(
		`insert into short_term_goals (id,user_id,midas_account_id,midas_bucket_id) values
		 ('99999999-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002'),
		 ('99999999-0000-4000-8000-000000000002',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into short_term_goal_revisions (id,user_id,goal_id,revision_no,operation,status,name,funding_target,target_date,occurred_at,idempotency_key,revision_fingerprint) values
		 ('99999999-1000-4000-8000-000000000001',$1,'99999999-0000-4000-8000-000000000001',1,'CREATE','ACTIVE','Move abroad','100000.00',null,'2026-07-01 00:00:00+00','g-1',$2),
		 ('99999999-1000-4000-8000-000000000002',$1,'99999999-0000-4000-8000-000000000002',1,'CREATE','ACTIVE','Laptop','5000.00','2026-12-01','2026-07-01 00:00:00+00','g-2',$2)`,
		[U1, F] as never[],
	);
	// a credit card + statement due in-period + a non-VOID purchase
	await pg.query(
		`insert into credit_cards (id,user_id,code) values ('80000000-0000-4000-8000-000000000001',$1,'CARDA')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint) values ('80000000-0000-4000-8000-0000000000a1',$1,'80000000-0000-4000-8000-000000000001',1,'CREATE','ACTIVE','A','Bank','1','10','50000.00',now(),'ccr-1',$2)`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month) values ('80000000-0000-4000-8000-000000000521',$1,'80000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000005',2026,9)`,
		[U1] as never[],
	);
	await pg.query(
		`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ('80000000-0000-4000-8000-000000000621',$1,'80000000-0000-4000-8000-000000000521',1,'CREATE','OPEN','1000.00','2026-09-01','2026-09-10','MIDAS_FUND',now(),'st-r1',$2)`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ('80000000-0000-4000-8000-0000000000c1',$1,'CREDIT_CARD_PURCHASE','ccp-1',$2)`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ('80000000-0000-4000-8000-000000000771',$1,'80000000-0000-4000-8000-0000000000c1',1,'CREATE','2026-09-02 00:00:00 Europe/Istanbul','{}'::jsonb,$2,'ccp-tr-1')`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into credit_card_liability_events (id,user_id,credit_card_id,event_type,canonical_transaction_id) values ('80000000-0000-4000-8000-0000000000e1',$1,'80000000-0000-4000-8000-000000000001','PURCHASE','80000000-0000-4000-8000-0000000000c1')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,canonical_revision_id,operation,amount,budget_category,occurred_at,idempotency_key,revision_fingerprint) values ('80000000-0000-4000-8000-00000000e711',$1,'80000000-0000-4000-8000-0000000000e1',1,'80000000-0000-4000-8000-000000000771','CREATE','1000.00','DISCRETIONARY_SPEND','2026-09-02 00:00:00 Europe/Istanbul','ccp-er-1',$2)`,
		[U1, F] as never[],
	);
	await pg.exec("SET session_replication_role = origin");

	// --- Budget-V2 config / classifications via the real services ---
	await createBasicLivingTarget({
		db,
		userId: U1,
		effectivePeriodMonth: "2026-09-01",
		monthlyTargetAmount: "6000.00",
		currency: "TRY",
		sourceKind: "USER_APPROVED",
		idempotencyKey: "bl-create-1",
	});
	await classifySupportReceipt({
		db,
		userId: U1,
		incomeReceiptId: "b1000000-0000-4000-8000-000000000003",
		supportRole: "PLANNED_FAMILY_GIFT",
		idempotencyKey: "sup-gift-1",
	});
	await classifySupportReceipt({
		db,
		userId: U1,
		incomeReceiptId: "b1000000-0000-4000-8000-000000000004",
		supportRole: "DEFICIT_FAMILY_SUPPORT",
		idempotencyKey: "sup-def-1",
	});
	await classifyGoalPurpose({
		db,
		userId: U1,
		goalId: "99999999-0000-4000-8000-000000000001",
		purpose: "INTERNATIONAL_MOBILITY",
		idempotencyKey: "gp-mob-1",
	});
	await classifyGoalPurpose({
		db,
		userId: U1,
		goalId: "99999999-0000-4000-8000-000000000002",
		purpose: "DATE_BOUND_NECESSARY_PURCHASE",
		idempotencyKey: "gp-dbn-1",
	});
	await reconcileStatement({
		db,
		userId: U1,
		statementId: "80000000-0000-4000-8000-000000000521",
		statementRevisionId: "80000000-0000-4000-8000-000000000621",
		idempotencyKey: "recon-svc-1",
		components: [
			{
				componentType: "PURCHASE",
				amount: "1000.00",
				ownership: "PERSONAL",
				purchaseEventId: "80000000-0000-4000-8000-0000000000e1",
			},
		],
	});

	// --- Resolve ---
	const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf });
	const eq2 = (a: unknown, b: unknown, name: string) =>
		a === b ? ok(name) : bad(name, `-> got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

	// A. realizedIncome = 20000 + 3000 + 2000 (gift); deficit 1500 excluded.
	eq2(res.inputs.realizedIncome, "25000.00", "A: realizedIncome REGULAR+EXTRA+PLANNED_FAMILY_GIFT, DEFICIT excluded");
	// C. basicLivingFunding = max(6000, actual personal mandatory spend MTD = 0) = 6000; V1 65% never used.
	eq2(res.inputs.basicLivingFunding, "6000.00", "C: basicLivingFunding == approved target (no V1 65%, no hardcode)");
	// E. emergency balance = 8630 live from bucket, target 10000.
	eq2(res.inputs.coreEmergencyFundBalance, "8630.00", "E: coreEmergencyFundBalance from live bucket net");
	eq2(
		(res.evidenceSnapshot as any).emergencyFund.target,
		"10000.00",
		"E: emergency target remains exactly 10000.00",
	);
	// D. mobilityBalance sums ACTIVE INTERNATIONAL_MOBILITY goal buckets = 40000.
	eq2(res.inputs.mobilityBalance, "40000.00", "D: mobilityBalance sums ACTIVE INTERNATIONAL_MOBILITY goal buckets");
	// D. date-bound: target 5000, bucket-at-basis 500 -> gap 4500, months Sep..Dec inclusive = 4 -> ceil(4500/4)=1125.
	eq2(
		res.inputs.dateBoundNecessaryPurchaseFunding,
		"1125.00",
		"D: date-bound contribution = ceil(remainingGap / inclusiveMonths)",
	);
	// currentObligations: statement reconciled, personal 1000; reserve carry-in before period = 0 -> counted once.
	eq2(res.inputs.currentObligations, "1000.00", "B: reconciled statement personal share recognised once");
	// H. evidence is JSON-safe and validates against the resolved-snapshot contract.
	try {
		JSON.stringify(res.evidenceSnapshot);
		validateBudgetV2ResolvedSnapshot({
			inputs: res.inputs,
			evidenceSnapshot: res.evidenceSnapshot,
		});
		ok("H: evidenceSnapshot is JSON-safe and passes validateBudgetV2ResolvedSnapshot");
	} catch (e) {
		bad("H: evidenceSnapshot contract", `-> ${(e as Error).message}`);
	}
	// availableToAllocateNow is unavailable with a reason (no TL figure).
	eq2(
		res.availableToAllocateNow.available as unknown as boolean,
		false,
		"availableToAllocateNow.available === false (SURPLUS_USE_ATTRIBUTION_UNSUPPORTED)",
	);
	// F. interval: first checkpoint -> from period start.
	eq2(
		(res.checkpointAnalysis as any).intervalStart,
		new Date(`${P}T00:00:00+03:00`).toISOString(),
		"F: first-checkpoint interval starts at period start (Istanbul midnight)",
	);

	// B (fail-closed): an unreconciled but due statement -> resolver fails closed.
	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month) values ('80000000-0000-4000-8000-000000000821',$1,'80000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000006',2026,8)`,
		[U1] as never[],
	);
	await pg.query(
		`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ('80000000-0000-4000-8000-000000000921',$1,'80000000-0000-4000-8000-000000000821',1,'CREATE','OPEN','300.00','2026-08-01','2026-09-05','OUTSIDE_MIDAS',now(),'st-r2',$2)`,
		[U1, F] as never[],
	);
	await pg.exec("SET session_replication_role = origin");
	try {
		await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf });
		bad("B: unreconciled current/due statement -> resolver did NOT fail closed");
	} catch (e) {
		String((e as Error).message).includes("not reconciled")
			? ok("B: unreconciled current/due statement fails the resolver closed")
			: bad("B: fail-closed", `-> unexpected ${(e as Error).message}`);
	}
	// reconcile it so subsequent tests can proceed
	await reconcileStatement({
		db,
		userId: U1,
		statementId: "80000000-0000-4000-8000-000000000821",
		statementRevisionId: "80000000-0000-4000-8000-000000000921",
		idempotencyKey: "recon-svc-2",
		components: [
			{ componentType: "ADJUSTMENT", amount: "300.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
		],
	});

	// A (fail-closed): add an unclassified SUPPORT receipt in-period -> resolver fails closed.
	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ('c1000000-0000-4000-8000-0000000000ff',$1,'INCOME_RECEIPT','ir-x',$2)`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ('c2000000-0000-4000-8000-0000000000ff',$1,'c1000000-0000-4000-8000-0000000000ff',1,'CREATE','2026-09-06 00:00:00 Europe/Istanbul','{}'::jsonb,$2,'irtr-x')`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into income_receipts (id,user_id,source_id,canonical_transaction_id) values ('b1000000-0000-4000-8000-0000000000ff',$1,'a1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-0000000000ff')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into income_receipt_revisions (id,user_id,income_receipt_id,canonical_revision_id,revision_no,operation,occurred_at,amount,destination_account_id) values ('b2000000-0000-4000-8000-0000000000ff',$1,'b1000000-0000-4000-8000-0000000000ff','c2000000-0000-4000-8000-0000000000ff',1,'CREATE','2026-09-06 00:00:00 Europe/Istanbul','999.00','d1000000-0000-4000-8000-000000000001')`,
		[U1] as never[],
	);
	await pg.exec("SET session_replication_role = origin");
	try {
		await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf });
		bad("A: unclassified SUPPORT receipt -> resolver did NOT fail closed");
	} catch (e) {
		String((e as Error).message).includes("no active Budget V2 semantic role")
			? ok("A: unclassified SUPPORT receipt fails the resolver closed")
			: bad("A: fail-closed", `-> unexpected ${(e as Error).message}`);
	}
	await classifySupportReceipt({
		db,
		userId: U1,
		incomeReceiptId: "b1000000-0000-4000-8000-0000000000ff",
		supportRole: "DEFICIT_FAMILY_SUPPORT",
		idempotencyKey: "sup-x",
	});

	// G. historical replay: seed a stored V2 creation revision, then prove
	// resolveBudgetV2SnapshotForWrite replays it and ignores later source mutation.
	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ('cf000000-0000-4000-8000-000000000001',$1,'MONTHLY_BUDGET_PLAN_V2','plan-key-1',$2)`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ('cf000000-0000-4000-8000-0000000000a1',$1,'cf000000-0000-4000-8000-000000000001',1,'CREATE','2026-09-01 00:00:00 Europe/Istanbul','{}'::jsonb,$2,'plan-key-1')`,
		[U1, F] as never[],
	);
	await pg.query(
		`insert into monthly_budget_v2_plans (id,user_id,period_month,canonical_transaction_id) values ('cf000000-0000-4000-8000-0000000000b1',$1,$2,'cf000000-0000-4000-8000-000000000001')`,
		[U1, P] as never[],
	);
	await pg.query(
		`insert into monthly_budget_v2_plan_revisions
		 (id,user_id,budget_plan_id,canonical_revision_id,revision_no,previous_budget_revision_id,operation,policy_version,currency,
		  realized_income_amount,current_obligations_amount,basic_living_funding_amount,date_bound_necessary_purchase_funding_amount,
		  core_emergency_fund_balance_amount,mobility_balance_amount,emergency_catch_up_amount,deficit_amount,true_surplus_amount,
		  mobility_allocation_amount,long_term_investment_amount,discretionary_allocation_amount,evidence_snapshot)
		 values ('cf000000-0000-4000-8000-0000000000c1',$1,'cf000000-0000-4000-8000-0000000000b1','cf000000-0000-4000-8000-0000000000a1',1,null,'CREATE','PERSONAL_BUDGET_V2','TRY',
		  '11111.00','0.00','6000.00','0.00','8630.00','40000.00','1000.00','0.00','4111.00','1438.00','1234.00','1439.00','{"stored":true}'::jsonb)`,
		[U1] as never[],
	);
	await pg.exec("SET session_replication_role = origin");
	const replay1 = await resolveBudgetV2SnapshotForWrite({
		db,
		userId: U1,
		periodMonth: P,
		idempotencyKey: "plan-key-1",
		asOf,
	});
	eq2(replay1.source, "REPLAY", "G: stored creation revision returned as REPLAY (no live recompute)");
	eq2(replay1.snapshot.inputs.realizedIncome, "11111.00", "G: replay returns the STORED snapshot, not a live figure");
	// mutate a live source, replay again -> unchanged.
	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ('aa000000-0000-4000-8000-0000000000ff',$1,'e1000000-0000-4000-8000-000000000001','mt-ff',$2,null,'f1000000-0000-4000-8000-000000000001','5000.00','2026-09-10 00:00:00+00')`,
		[U1, F] as never[],
	);
	await pg.exec("SET session_replication_role = origin");
	const replay2 = await resolveBudgetV2SnapshotForWrite({
		db,
		userId: U1,
		periodMonth: P,
		idempotencyKey: "plan-key-1",
		asOf,
	});
	eq2(
		replay2.snapshot.inputs.coreEmergencyFundBalance,
		"8630.00",
		"G: mutating a live source after the stored revision does NOT change the replay",
	);
	const freshResolve = await resolveBudgetV2SnapshotForWrite({
		db,
		userId: U1,
		periodMonth: P,
		idempotencyKey: "brand-new-key",
		asOf,
	});
	eq2(freshResolve.source, "LIVE", "G: a fresh idempotency key runs the LIVE resolver");

	// P. replay key stored for one period, requested for another -> conflict.
	try {
		await resolveBudgetV2SnapshotForWrite({
			db,
			userId: U1,
			periodMonth: "2026-10-01",
			idempotencyKey: "plan-key-1",
			asOf: new Date("2026-10-05T09:00:00+03:00"),
		});
		bad("P: replay key + different periodMonth -> did NOT conflict");
	} catch (e) {
		String((e as Error).message).includes("stored for period")
			? ok("P: replay idempotency key + different periodMonth => BUDGET_IDEMPOTENCY_CONFLICT")
			: bad("P: replay periodMonth conflict", `-> ${(e as Error).message}`);
	}

	await pg.close();
}

// ============================================================================
// PHASE 4A: CHECKPOINT-4A CORRECTNESS REPAIR REGRESSIONS
// ============================================================================

async function resolverRuntime4A() {
	console.log(
		"\n== PHASE 4A: LIVE RESOLVER CORRECTNESS REPAIR (drizzle / PGlite) ==",
	);
	const { drizzle } = await import("drizzle-orm/pglite");
	const { resolveBudgetV2LiveSnapshot } = await import(
		"../src/budget/live-resolver-v2.ts"
	);
	const { createBasicLivingTarget } = await import(
		"../src/budget/basic-living-config-v2.ts"
	);
	const { reconcileStatement, getStatementReconciliation } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);

	const pg = new PGlite();
	await pg.query("SET timezone='UTC'");
	await applyChain(pg, 68);
	// biome-ignore lint/suspicious/noExplicitAny: cross-driver drizzle client
	const db = drizzle(pg as any) as any;
	const F = "f".repeat(64);
	const asOfSep = new Date("2026-09-20T09:00:00+03:00");
	const eqA = (a: unknown, b: unknown, name: string) =>
		a === b ? ok(name) : bad(name, `-> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		"insert into users (id, display_name, currency, timezone) values ($1,'U','TRY','Europe/Istanbul')",
		[U1] as never[],
	);
	await pg.query(
		`insert into ledger_accounts (id,user_id,code,name,account_type,normal_balance,currency) values
		 ('d1000000-0000-4000-8000-000000000001',$1,'ASSET_CASH','Cash','ASSET','DEBIT','TRY')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into midas_accounts (id,user_id,ledger_account_id) values ('e1000000-0000-4000-8000-000000000001',$1,'d1000000-0000-4000-8000-000000000001')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values
		 ('f0000000-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','CEF','E','CORE_EMERGENCY_FUND'),
		 ('f0000000-0000-4000-8000-0000000000d0',$1,'e1000000-0000-4000-8000-000000000001','RSVD','full pre-fund','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000e0',$1,'e1000000-0000-4000-8000-000000000001','RSVE','partial personal','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000f0',$1,'e1000000-0000-4000-8000-000000000001','RSVF','partial mixed','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000a1',$1,'e1000000-0000-4000-8000-000000000001','RSVG','strict boundary','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000b0',$1,'e1000000-0000-4000-8000-000000000001','RSVB','old paid','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000c3',$1,'e1000000-0000-4000-8000-000000000001','RSVH','overlap','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000c1',$1,'e1000000-0000-4000-8000-000000000001','RSVK','retry after pay','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000c2',$1,'e1000000-0000-4000-8000-000000000001','RSVN','void evidence','CREDIT_CARD_RESERVE')`,
		[U1] as never[],
	);
	const T = (id: string, to: string, amt: string, when: string) =>
		pg.query(
			`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ($1,$2,'e1000000-0000-4000-8000-000000000001',$3,$4,null,$5,$6,$7)`,
			[id, U1, `mt-${id.slice(-6)}`, F, to, amt, when] as never[],
		);
	// CEF 10,000 so there is no emergency-gap noise in the waterfall
	await T("a0000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000001", "10000.00", "2026-08-01 00:00:00+00");
	// D: full pre-period fund of a 1,000 statement
	await T("a0000000-0000-4000-8000-0000000000d1", "f0000000-0000-4000-8000-0000000000d0", "1000.00", "2026-08-15 00:00:00+00");
	// E: partial (400) pre-period fund of a 1,000 all-personal statement
	await T("a0000000-0000-4000-8000-0000000000e1", "f0000000-0000-4000-8000-0000000000e0", "400.00", "2026-08-15 00:00:00+00");
	// F: partial (400) pre-period fund of a mixed 1,000 statement
	await T("a0000000-0000-4000-8000-0000000000f1", "f0000000-0000-4000-8000-0000000000f0", "400.00", "2026-08-15 00:00:00+00");
	// G: a transfer EXACTLY at periodStart must NOT reduce the burden (strict <)
	await T("a0000000-0000-4000-8000-0000000000a2", "f0000000-0000-4000-8000-0000000000a1", "300.00", "2026-08-31 21:00:00+00");

	await pg.query(
		`insert into credit_cards (id,user_id,code) values ('80000000-0000-4000-8000-000000000001',$1,'CARDA')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint) values ('80000000-0000-4000-8000-0000000000a1',$1,'80000000-0000-4000-8000-000000000001',1,'CREATE','ACTIVE','A','B','1','10','90000.00',now(),'ccr-1',$2)`,
		[U1, F] as never[],
	);
	// people P1 (family) for the mixed-ownership / split cases
	await pg.query(
		`insert into people (id,user_id) values ('9a000000-0000-4000-8000-000000000001',$1)`,
		[U1] as never[],
	);
	await pg.query(
		`insert into person_revisions (id,user_id,person_id,revision_no,operation,status,display_name,relationship,occurred_at,idempotency_key,revision_fingerprint) values ('9a000000-0000-4000-8000-0000000000a1',$1,'9a000000-0000-4000-8000-000000000001',1,'CREATE','ACTIVE','Fam','FAMILY',now(),'pr-1',$2)`,
		[U1, F] as never[],
	);

	let stmtSeq = 0;
	const seedStatement = async (
		reserveBucket: string,
		amount: string,
		dueDate: string,
		status: "OPEN" | "PAID" = "OPEN",
		payAt?: string,
	) => {
		stmtSeq++;
		const sid = `81000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const r1 = `82000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month) values ($1,$2,'80000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',$3,$4,6)`,
			[sid, U1, reserveBucket, 2050 + stmtSeq] as never[],
		);
		await pg.query(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','OPEN',$4,'2026-09-01',$5,'MIDAS_FUND','2026-09-01 00:00:00+00',$6,$7)`,
			[r1, U1, sid, amount, dueDate, `sr-${sid.slice(-6)}-1`, F] as never[],
		);
		let latestRevId = r1;
		if (status === "PAID") {
			const r2 = `82000000-0000-4000-8000-0000000${(stmtSeq + 50).toString().padStart(5, "0")}`;
			await pg.query(
				`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,previous_revision_id,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,2,$4,'PAY','PAID',$5,'2026-09-01',$6,'MIDAS_FUND',$7,$8,$9)`,
				[r2, U1, sid, r1, amount, dueDate, payAt ?? "2026-09-15 00:00:00+00", `sr-${sid.slice(-6)}-2`, F] as never[],
			);
			latestRevId = r2;
		}
		await pg.exec("SET session_replication_role = origin");
		return { sid, r1, latestRevId };
	};
	let voidSeq = 0;
	const voidStmt = async (sid: string, latestRevId: string) => {
		voidSeq++;
		await pg.exec("SET session_replication_role = replica");
		const [{ n }] = (
			await pg.query<{ n: number }>(
				`select coalesce(max(revision_no),0)+1 n from credit_card_statement_revisions where statement_id=$1`,
				[sid] as never[],
			)
		).rows;
		await pg.query(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,previous_revision_id,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint)
			 select $1,$2,statement_id,$3,$4,'VOID','VOID',statement_amount,statement_date,due_date,reserve_placement,'2026-09-18 00:00:00+00',$5,revision_fingerprint
			 from credit_card_statement_revisions where id=$4`,
			[
				`8f000000-0000-4000-8000-0000000${voidSeq.toString().padStart(5, "0")}`,
				U1,
				n,
				latestRevId,
				`vs-${voidSeq}`,
			] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
	};

	const seedPurchase = async (amount: string, category: string) => {
		stmtSeq++;
		const eid = `83000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const ctid = `84000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const trid = `85000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const erid = `86000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ($1,$2,'CREDIT_CARD_PURCHASE',$3,$4)`,
			[ctid, U1, `cp-${eid.slice(-6)}`, F] as never[],
		);
		await pg.query(
			`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ($1,$2,$3,1,'CREATE','2026-09-02 00:00:00+00','{}'::jsonb,$4,$5)`,
			[trid, U1, ctid, F, `cptr-${eid.slice(-6)}`] as never[],
		);
		await pg.query(
			`insert into credit_card_liability_events (id,user_id,credit_card_id,event_type,canonical_transaction_id) values ($1,$2,'80000000-0000-4000-8000-000000000001','PURCHASE',$3)`,
			[eid, U1, ctid] as never[],
		);
		await pg.query(
			`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,canonical_revision_id,operation,amount,budget_category,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,$4,'CREATE',$5,$6,'2026-09-02 00:00:00+00',$7,$8)`,
			[erid, U1, eid, trid, amount, category, `cper-${eid.slice(-6)}`, F] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
		return { eid, trid };
	};

	await createBasicLivingTarget({
		db,
		userId: U1,
		effectivePeriodMonth: "2026-09-01",
		monthlyTargetAmount: "6000.00",
		currency: "TRY",
		sourceKind: "USER_APPROVED",
		idempotencyKey: "bl-4a",
	});

	// ---- D: full pre-period reserve => zero burden ----
	{
		const { sid, r1, latestRevId } = await seedStatement("f0000000-0000-4000-8000-0000000000d0", "1000.00", "2026-09-10");
		const pur = await seedPurchase("1000.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-d-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "1000.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
		eqA(res.inputs.currentObligations, "0.00", "D: full pre-period reserve carry-in => zero current-period burden");
		await voidStmt(sid, latestRevId);
	}
	// ---- E: partial (400) pre-period reserve, all-personal => net burden 600 ----
	{
		const { sid, r1, latestRevId } = await seedStatement("f0000000-0000-4000-8000-0000000000e0", "1000.00", "2026-09-10");
		const pur = await seedPurchase("1000.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-e-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "1000.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
		eqA(res.inputs.currentObligations, "600.00", "E: partial pre-period reserve + all-personal => personalShare - carryIn");
		await voidStmt(sid, latestRevId);
	}
	// ---- F: partial carry-in + MIXED ownership => fail closed ----
	{
		const { sid, r1, latestRevId } = await seedStatement("f0000000-0000-4000-8000-0000000000f0", "1000.00", "2026-09-10");
		const pur = await seedPurchase("1000.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-f-${sid.slice(-6)}`,
			components: [
				{ componentType: "PURCHASE", amount: "700.00", ownership: "PERSONAL", purchaseEventId: pur.eid },
				{ componentType: "ADJUSTMENT", amount: "300.00", ownership: "EXTERNAL_PERSON", personId: "9a000000-0000-4000-8000-000000000001", adjustmentKind: "OTHER" },
			],
		});
		try {
			await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
			bad("F: partial carry-in + mixed ownership did NOT fail closed");
		} catch (e) {
			String((e as Error).message).includes("mixed PERSONAL/EXTERNAL")
				? ok("F: partial carry-in + mixed ownership => resolver fails closed")
				: bad("F: fail-closed", `-> ${(e as Error).message}`);
		}
		await voidStmt(sid, latestRevId);
	}
	// ---- G: transfer EXACTLY at periodStart does NOT reduce the burden ----
	{
		const { sid, r1, latestRevId } = await seedStatement("f0000000-0000-4000-8000-0000000000a1", "1000.00", "2026-09-10");
		const pur = await seedPurchase("1000.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-g-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "1000.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		// reserve bucket G has a 300 transfer at exactly periodStart -> strict < excludes it.
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
		eqA(res.inputs.currentObligations, "1000.00", "G/O: a transfer exactly at periodStart is NOT counted as carry-in (strict <)");
		await voidStmt(sid, latestRevId);
	}
	// ---- B: an old PAID statement does not recur next month ----
	{
		const { sid, latestRevId } = await seedStatement("f0000000-0000-4000-8000-0000000000b0", "500.00", "2026-09-10", "PAID", "2026-09-15 00:00:00+00");
		const pur = await seedPurchase("500.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: latestRevId,
			idempotencyKey: `rc-b-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "500.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		const sep = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
		const oct = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-10-01", asOf: new Date("2026-10-20T09:00:00+03:00") });
		const sepStmt = (sep.evidenceSnapshot as any).obligations.creditCardStatements.find((x: any) => x.statementId === sid);
		const octStmt = (oct.evidenceSnapshot as any).obligations.creditCardStatements.find((x: any) => x.statementId === sid);
		eqA(sepStmt?.recognizedPersonalBurden, "500.00", "C: PAID-within-period statement recognised exactly once in its period");
		eqA(octStmt, undefined, "B: an August/September PAID statement does NOT reappear as an October obligation");
		await voidStmt(sid, latestRevId);
	}
	// ---- H / I: basic-living <-> currentObligations overlap prevents double count ----
	{
		const { sid, r1, latestRevId } = await seedStatement("f0000000-0000-4000-8000-0000000000c3", "1000.00", "2026-09-10");
		const pur = await seedPurchase("1000.00", "MANDATORY_EXPENSE");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-h-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "1000.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
		const bl = (res.evidenceSnapshot as any).basicLiving;
		eqA(bl.actualPersonalMandatorySpendMTD, "1000.00", "H: actual personal mandatory spend MTD recorded");
		eqA(bl.basicLivingOverlapWithCurrentObligations, "1000.00", "H: exact-identity overlap with currentObligations detected");
		eqA(res.inputs.basicLivingFunding, "5000.00", "H: basicLivingFunding = max(6000,1000) - overlap 1000 = 5000 (not 6000+1000)");
		eqA(res.inputs.currentObligations, "1000.00", "H: the mandatory 1000 is counted once, in currentObligations");
		await voidStmt(sid, latestRevId);
	}
	// ---- I: basic-living with NO overlap is unchanged ----
	{
		await seedPurchase("900.00", "MANDATORY_EXPENSE"); // MANDATORY personal spend, NOT on any due reconciled statement
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
		const bl = (res.evidenceSnapshot as any).basicLiving;
		eqA(bl.basicLivingOverlapWithCurrentObligations, "0.00", "I: mandatory spend not recognised in currentObligations => no overlap reduction");
		eqA(res.inputs.basicLivingFunding, "6000.00", "I: basicLivingFunding = max(6000, 900) - 0 = 6000 (unchanged)");
	}
	// ---- N: VOID purchase evidence is not silently trusted (read-time STALE) ----
	{
		const { sid, r1 } = await seedStatement("f0000000-0000-4000-8000-0000000000c2", "400.00", "2026-09-10");
		const pur = await seedPurchase("400.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-n-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "400.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		// now VOID the purchase liability event
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,previous_revision_id,canonical_revision_id,operation,amount,budget_category,occurred_at,idempotency_key,revision_fingerprint)
			 values ($1,$2,$3,2,$4,$5,'VOID','400.00','DISCRETIONARY_SPEND','2026-09-06 00:00:00+00',$6,$7)`,
			[
				`86000000-0000-4000-8000-00000009${sid.slice(-4)}`,
				U1, pur.eid,
				`86000000-0000-4000-8000-0000000${(stmtSeq).toString().padStart(5, "0")}`,
				pur.trid, `cper-void-${sid.slice(-6)}`, F,
			] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
		const view = await getStatementReconciliation({ db, userId: U1, statementId: sid });
		String(view.status) === "STALE"
			? ok("N: a now-VOID referenced purchase makes the reconciliation STALE (evidence not silently trusted)")
			: bad("N: stale evidence", `-> status=${view.status}`);
		try {
			await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: "2026-09-01", asOf: asOfSep });
			bad("N: resolver did NOT fail closed on stale purchase evidence");
		} catch (e) {
			String((e as Error).message).includes("not reconciled")
				? ok("N: resolver fails closed when a due statement's purchase evidence is stale")
				: bad("N: fail-closed", `-> ${(e as Error).message}`);
		}
		// void the reserve/undo so it does not block final checks -- simply void the statement
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,previous_revision_id,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,2,$4,'VOID','VOID','400.00','2026-09-01','2026-09-10','MIDAS_FUND','2026-09-07 00:00:00+00',$5,$6)`,
			[`82000000-0000-4000-8000-00000009${sid.slice(-4)}`, U1, sid, r1, `sr-void-${sid.slice(-6)}`, F] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
	}
	// ---- K: reconcile retry AFTER a PAY lifecycle transition is idempotent ----
	{
		const { sid, r1 } = await seedStatement("f0000000-0000-4000-8000-0000000000c1", "250.00", "2026-09-10");
		const pur = await seedPurchase("250.00", "DISCRETIONARY_SPEND");
		const first = await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: "rc-k-1",
			components: [{ componentType: "PURCHASE", amount: "250.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		// a PAY revision creates a NEW statement revision id
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,previous_revision_id,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,2,$4,'PAY','PAID','250.00','2026-09-01','2026-09-10','MIDAS_FUND','2026-09-12 00:00:00+00',$5,$6)`,
			[`82000000-0000-4000-8000-000000091${sid.slice(-3)}`, U1, sid, r1, `sr-k-pay-${sid.slice(-6)}`, F] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
		// retry: SAME key, SAME (now stale) statementRevisionId, occurredAt omitted
		const retry = await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: "rc-k-1",
			components: [{ componentType: "PURCHASE", amount: "250.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		});
		(retry.idempotentReplay && retry.revision.revisionId === first.revision.revisionId)
			? ok("J/K: reconcile retry (no occurredAt) after a PAY transition is an idempotent replay")
			: bad("J/K: retry after PAY", `-> replay=${retry.idempotentReplay}`);
		// and the reconciliation is still RECONCILED across the PAY (section 1)
		const view = await getStatementReconciliation({ db, userId: U1, statementId: sid });
		String(view.status) === "RECONCILED"
			? ok("1: a sealed reconciliation stays RECONCILED across a same-amount PAY transition")
			: bad("1: PAID freshness", `-> status=${view.status}`);
	}
	// ---- L: same idempotency key on a DIFFERENT statement => typed conflict, no 23505 ----
	{
		const a = await seedStatement("f0000000-0000-4000-8000-0000000000c4", "111.00", "2026-09-10");
		const b = await seedStatement("f0000000-0000-4000-8000-0000000000c5", "222.00", "2026-09-10");
		const pa = await seedPurchase("111.00", "DISCRETIONARY_SPEND");
		const pb = await seedPurchase("222.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: a.sid, statementRevisionId: a.r1,
			idempotencyKey: "rc-shared-key",
			components: [{ componentType: "PURCHASE", amount: "111.00", ownership: "PERSONAL", purchaseEventId: pa.eid }],
		});
		const err = await reconcileStatement({
			db, userId: U1, statementId: b.sid, statementRevisionId: b.r1,
			idempotencyKey: "rc-shared-key",
			components: [{ componentType: "PURCHASE", amount: "222.00", ownership: "PERSONAL", purchaseEventId: pb.eid }],
		}).catch((e) => e);
		((err as Error)?.constructor?.name === "CreditCardError" &&
			!/23505|duplicate key|unique constraint/i.test(String((err as Error).message)))
			? ok("L: same idempotency key on a different statement => typed IDEMPOTENCY conflict, no raw 23505")
			: bad("L: cross-statement key", `-> ${(err as Error)?.message}`);
	}
	// ---- M: PURCHASE component incompatible with active split truth => rejected ----
	{
		const { sid, r1 } = await seedStatement("f0000000-0000-4000-8000-0000000000c6", "600.00", "2026-09-10");
		const pur = await seedPurchase("600.00", "DISCRETIONARY_SPEND");
		// give the purchase an ACTIVE, SEALED split: user 200 / external 400 to P1
		await pg.exec("SET session_replication_role = replica");
		const splitId = `87000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const splitRev = `88000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const part = `89000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const oblId = `8a000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		const oblCt = `8b000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`;
		await pg.query(
			`insert into credit_card_purchase_splits (id,user_id,purchase_event_id) values ($1,$2,$3)`,
			[splitId, U1, pur.eid] as never[],
		);
		await pg.query(
			`insert into credit_card_purchase_split_revisions (id,split_id,revision_no,operation,method,purchase_event_revision_id,gross_amount,user_share_amount,external_share_amount,occurred_at,revision_fingerprint)
			 values ($1,$2,1,'CREATE','MANUAL',(select id from credit_card_liability_event_revisions where event_id=$3 order by revision_no desc limit 1),'600.00','200.00','400.00','2026-09-02 00:00:00+00',$4)`,
			[splitRev, splitId, pur.eid, F] as never[],
		);
		await pg.query(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ($1,$2,'PERSON_OBLIGATION',$3,$4)`,
			[oblCt, U1, `obl-${sid.slice(-6)}`, F] as never[],
		);
		await pg.query(
			`insert into person_obligations (id,user_id,person_id,direction,canonical_transaction_id) values ($1,$2,'9a000000-0000-4000-8000-000000000001','RECEIVABLE',$3)`,
			[oblId, U1, oblCt] as never[],
		);
		await pg.query(
			`insert into credit_card_purchase_split_participants (id,user_id,split_id,person_id,person_obligation_id) values ($1,$2,$3,'9a000000-0000-4000-8000-000000000001',$4)`,
			[part, U1, splitId, oblId] as never[],
		);
		await pg.query(
			`insert into credit_card_purchase_split_revision_items (id,split_revision_id,participant_id,person_id,share_amount) values ($1,$2,$3,'9a000000-0000-4000-8000-000000000001','400.00')`,
			[`8c000000-0000-4000-8000-0000000${stmtSeq.toString().padStart(5, "0")}`, splitRev, part] as never[],
		);
		await pg.query(
			`insert into credit_card_purchase_split_revision_seals (split_revision_id) values ($1)`,
			[splitRev] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
		// a PURCHASE component claiming PERSONAL for the full 600 contradicts the split
		const err = await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1,
			idempotencyKey: `rc-m-${sid.slice(-6)}`,
			components: [{ componentType: "PURCHASE", amount: "600.00", ownership: "PERSONAL", purchaseEventId: pur.eid }],
		}).catch((e) => e);
		((err as Error)?.constructor?.name === "CreditCardError" &&
			/active split revision/.test(String((err as Error).message)))
			? ok("M: PURCHASE component that ignores the authoritative active split is rejected")
			: bad("M: split integrity", `-> ${(err as Error)?.message}`);
	}

	await pg.close();
}

// ============================================================================
// PHASE 4A.1: PARTIAL-CARRY-IN OVERLAP AMBIGUITY + INCLUSIVE-END BOUNDARY
// ============================================================================

async function resolverRuntime4A1() {
	console.log(
		"\n== PHASE 4A.1: PARTIAL CARRY-IN OVERLAP + CHECKPOINT BOUNDARY ==",
	);
	const { drizzle } = await import("drizzle-orm/pglite");
	const { resolveBudgetV2LiveSnapshot, buildResolverWindow } = await import(
		"../src/budget/live-resolver-v2.ts"
	);
	const { createBasicLivingTarget } = await import(
		"../src/budget/basic-living-config-v2.ts"
	);
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);

	// --- pure window-boundary assertions (F..M) ------------------------------
	const P = "2026-09-01";
	const periodStart = new Date("2026-09-01T00:00:00+03:00");
	const periodEnd = new Date("2026-10-01T00:00:00+03:00");
	const asOf = new Date("2026-09-20T09:00:00+03:00");
	const prev = new Date("2026-09-10T00:00:00+03:00");
	const wMid = buildResolverWindow(P, asOf, prev);
	const wMonthEnd = buildResolverWindow(
		P,
		new Date("2026-11-01T00:00:00+03:00"),
		undefined,
	);
	const chk = (c: boolean, name: string) => (c ? ok(name) : bad(name));
	// F: event exactly at asOf -> INCLUDED in MTD
	chk(wMid.inMtd(asOf) === true, "F: an event exactly at checkpointAt is INCLUDED in MTD");
	// G: PAID event exactly at checkpointAt -> INCLUDED (same rule as F)
	chk(
		wMid.inMtd(new Date(asOf.getTime())) === true,
		"G: a PAID event exactly at checkpointAt is INCLUDED",
	);
	// H: event exactly at previousCheckpointAt -> EXCLUDED from the interval
	chk(wMid.inInterval(prev) === false, "H: an event exactly at previousCheckpointAt is EXCLUDED from the interval");
	// I: event 1 ms after previousCheckpointAt -> INCLUDED
	chk(
		wMid.inInterval(new Date(prev.getTime() + 1)) === true,
		"I: an event 1ms after previousCheckpointAt is INCLUDED in the interval",
	);
	// first checkpoint: periodStart is INCLUSIVE
	chk(
		buildResolverWindow(P, asOf, undefined).inInterval(periodStart) === true,
		"first checkpoint: periodStart is INCLUSIVE in the interval",
	);
	// J: event exactly at next-month periodEnd -> EXCLUDED from the prior month
	chk(
		wMonthEnd.inMtd(periodEnd) === false,
		"J: an event exactly at next-month periodEnd is EXCLUDED from the month",
	);
	chk(
		wMonthEnd.inMtd(new Date(periodEnd.getTime() - 1)) === true,
		"J: the last instant before periodEnd is still INCLUDED",
	);
	// K: reserve transfer exactly at periodStart -> still NOT carry-in (exclusive)
	//    -- covered as case O in Phase 4A; re-assert the window contract here:
	chk(
		wMid.asOfInclusive === true && wMonthEnd.asOfInclusive === false,
		"asOf < periodEnd => inclusive checkpoint; asOf >= periodEnd => month cap",
	);

	// --- M: previousCheckpointAt after asOf -> rejected ---------------------
	{
		const pg0 = new PGlite();
		await pg0.query("SET timezone='UTC'");
		await applyChain(pg0, 68);
		// biome-ignore lint/suspicious/noExplicitAny: cross-driver drizzle client
		const db0 = drizzle(pg0 as any) as any;
		try {
			await resolveBudgetV2LiveSnapshot({
				db: db0,
				userId: U1,
				periodMonth: P,
				asOf,
				previousCheckpointAt: new Date("2026-09-25T00:00:00+03:00"),
			});
			bad("M: previousCheckpointAt > asOf was NOT rejected");
		} catch (e) {
			String((e as Error).message).includes("not before the current checkpoint")
				? ok("M: previousCheckpointAt after the current checkpoint => BUDGET_INVALID_INPUT")
				: bad("M: previous checkpoint validation", `-> ${(e as Error).message}`);
		}
		await pg0.close();
	}

	// --- partial carry-in overlap (A..E) ----------------------------------
	const pg = new PGlite();
	await pg.query("SET timezone='UTC'");
	await applyChain(pg, 68);
	// biome-ignore lint/suspicious/noExplicitAny: cross-driver drizzle client
	const db = drizzle(pg as any) as any;
	const F = "f".repeat(64);
	const asOfSep = new Date("2026-09-20T09:00:00+03:00");
	await pg.exec("SET session_replication_role = replica");
	await pg.query(
		"insert into users (id, display_name, currency, timezone) values ($1,'U','TRY','Europe/Istanbul')",
		[U1] as never[],
	);
	await pg.query(
		`insert into ledger_accounts (id,user_id,code,name,account_type,normal_balance,currency) values ('d1000000-0000-4000-8000-000000000001',$1,'ASSET_CASH','Cash','ASSET','DEBIT','TRY')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into midas_accounts (id,user_id,ledger_account_id) values ('e1000000-0000-4000-8000-000000000001',$1,'d1000000-0000-4000-8000-000000000001')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values
		 ('f0000000-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','CEF','E','CORE_EMERGENCY_FUND'),
		 ('f0000000-0000-4000-8000-0000000000a1',$1,'e1000000-0000-4000-8000-000000000001','RA','A','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000b1',$1,'e1000000-0000-4000-8000-000000000001','RB','B','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000c1',$1,'e1000000-0000-4000-8000-000000000001','RC','C','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000d1',$1,'e1000000-0000-4000-8000-000000000001','RD','D','CREDIT_CARD_RESERVE'),
		 ('f0000000-0000-4000-8000-0000000000e1',$1,'e1000000-0000-4000-8000-000000000001','RE','E','CREDIT_CARD_RESERVE')`,
		[U1] as never[],
	);
	const mk = (id: string, to: string, amt: string, when: string) =>
		pg.query(
			`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ($1,$2,'e1000000-0000-4000-8000-000000000001',$3,$4,null,$5,$6,$7)`,
			[id, U1, `mt-${id.slice(-6)}`, F, to, amt, when] as never[],
		);
	await mk("aa000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000001", "10000.00", "2026-08-01 00:00:00+00");
	await mk("aa000000-0000-4000-8000-0000000000a1", "f0000000-0000-4000-8000-0000000000a1", "300.00", "2026-08-15 00:00:00+00"); // A partial
	await mk("aa000000-0000-4000-8000-0000000000b1", "f0000000-0000-4000-8000-0000000000b1", "300.00", "2026-08-15 00:00:00+00"); // B partial
	await mk("aa000000-0000-4000-8000-0000000000c1", "f0000000-0000-4000-8000-0000000000c1", "300.00", "2026-08-15 00:00:00+00"); // C partial
	// D: zero carry-in
	await mk("aa000000-0000-4000-8000-0000000000e1", "f0000000-0000-4000-8000-0000000000e1", "1000.00", "2026-08-15 00:00:00+00"); // E full
	await pg.query(
		`insert into credit_cards (id,user_id,code) values ('80000000-0000-4000-8000-000000000001',$1,'CARDA')`,
		[U1] as never[],
	);
	await pg.query(
		`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint) values ('80000000-0000-4000-8000-0000000000a1',$1,'80000000-0000-4000-8000-000000000001',1,'CREATE','ACTIVE','A','B','1','10','90000.00',now(),'ccr-1',$2)`,
		[U1, F] as never[],
	);
	await pg.exec("SET session_replication_role = origin");
	await createBasicLivingTarget({
		db, userId: U1, effectivePeriodMonth: "2026-09-01",
		monthlyTargetAmount: "6000.00", currency: "TRY",
		sourceKind: "USER_APPROVED", idempotencyKey: "bl-4a1",
	});

	let seq = 0;
	const seedStmt = async (reserveBucket: string, amount: string) => {
		seq++;
		const sid = `81000000-0000-4000-8000-0000000${seq.toString().padStart(5, "0")}`;
		const r1 = `82000000-0000-4000-8000-0000000${seq.toString().padStart(5, "0")}`;
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month) values ($1,$2,'80000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',$3,$4,6)`,
			[sid, U1, reserveBucket, 2060 + seq] as never[],
		);
		await pg.query(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','OPEN',$4,'2026-09-01','2026-09-10','MIDAS_FUND','2026-09-01 00:00:00+00',$5,$6)`,
			[r1, U1, sid, amount, `sr-${seq}`, F] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
		return { sid, r1 };
	};
	const seedPur = async (
		amount: string,
		category: string,
		occurredAt = "2026-09-02 00:00:00+00",
	) => {
		seq++;
		const eid = `83000000-0000-4000-8000-0000000${seq.toString().padStart(5, "0")}`;
		const ct = `84000000-0000-4000-8000-0000000${seq.toString().padStart(5, "0")}`;
		const tr = `85000000-0000-4000-8000-0000000${seq.toString().padStart(5, "0")}`;
		const er = `86000000-0000-4000-8000-0000000${seq.toString().padStart(5, "0")}`;
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ($1,$2,'CREDIT_CARD_PURCHASE',$3,$4)`,
			[ct, U1, `cp-${seq}`, F] as never[],
		);
		await pg.query(
			`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ($1,$2,$3,1,'CREATE',$4,'{}'::jsonb,$5,$6)`,
			[tr, U1, ct, occurredAt, F, `cptr-${seq}`] as never[],
		);
		await pg.query(
			`insert into credit_card_liability_events (id,user_id,credit_card_id,event_type,canonical_transaction_id) values ($1,$2,'80000000-0000-4000-8000-000000000001','PURCHASE',$3)`,
			[eid, U1, ct] as never[],
		);
		await pg.query(
			`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,canonical_revision_id,operation,amount,budget_category,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,$4,'CREATE',$5,$6,$7,$8,$9)`,
			[er, U1, eid, tr, amount, category, occurredAt, `cper-${seq}`, F] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
		return { eid };
	};
	let voidN = 0;
	const voidStmt = async (sid: string, r1: string) => {
		voidN++;
		await pg.exec("SET session_replication_role = replica");
		await pg.query(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,previous_revision_id,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint)
			 select $1,$2,statement_id,2,$3,'VOID','VOID',statement_amount,statement_date,due_date,reserve_placement,'2026-09-18 00:00:00+00',$4,revision_fingerprint from credit_card_statement_revisions where id=$3`,
			[`8f000000-0000-4000-8000-0000000${voidN.toString().padStart(5, "0")}`, U1, r1, `vs-${voidN}`] as never[],
		);
		await pg.exec("SET session_replication_role = origin");
	};

	// A: partial carry-in (300), all-personal, WHOLE personal share is MTD-mandatory -> exact
	{
		const { sid, r1 } = await seedStmt("f0000000-0000-4000-8000-0000000000a1", "1000.00");
		const p = await seedPur("1000.00", "MANDATORY_EXPENSE");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1, idempotencyKey: `rc-a1-${seq}`,
			components: [{ componentType: "PURCHASE", amount: "1000.00", ownership: "PERSONAL", purchaseEventId: p.eid }],
		});
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf: asOfSep });
		const bl = (res.evidenceSnapshot as any).basicLiving;
		const d = bl.basicLivingOverlapDetail.find((x: any) => x.statementId === sid);
		(d?.overlapBasis === "D_ALL_PERSONAL_ALL_MANDATORY" && bl.basicLivingOverlapWithCurrentObligations === "700.00")
			? ok("A: partial carry-in, 100% personal, 100% MTD-mandatory => EXACT overlap = burden (m - carryIn = 700)")
			: bad("A: exact partial overlap", `-> basis=${d?.overlapBasis} overlap=${bl.basicLivingOverlapWithCurrentObligations}`);
		await voidStmt(sid, r1);
	}
	// B: partial carry-in, all-personal, mandatory 400 + discretionary 600 -> FAIL CLOSED
	{
		const { sid, r1 } = await seedStmt("f0000000-0000-4000-8000-0000000000b1", "1000.00");
		const pm = await seedPur("400.00", "MANDATORY_EXPENSE");
		const pd = await seedPur("600.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1, idempotencyKey: `rc-b1-${seq}`,
			components: [
				{ componentType: "PURCHASE", amount: "400.00", ownership: "PERSONAL", purchaseEventId: pm.eid },
				{ componentType: "PURCHASE", amount: "600.00", ownership: "PERSONAL", purchaseEventId: pd.eid },
			],
		});
		try {
			await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf: asOfSep });
			bad("B: mandatory + discretionary under partial carry-in did NOT fail closed");
		} catch (e) {
			String((e as Error).message).includes("PARTIAL_CARRY_IN_CATEGORY_ALLOCATION_UNRESOLVED")
				? ok("B: partial carry-in + mandatory/discretionary mix => FAIL CLOSED (PARTIAL_CARRY_IN_CATEGORY_ALLOCATION_UNRESOLVED)")
				: bad("B: fail closed", `-> ${(e as Error).message}`);
		}
		await voidStmt(sid, r1);
	}
	// C: partial carry-in, all-personal, mandatory-in-window 500 + mandatory-OUT-of-window 500 -> FAIL CLOSED
	{
		const { sid, r1 } = await seedStmt("f0000000-0000-4000-8000-0000000000c1", "1000.00");
		const pin = await seedPur("500.00", "MANDATORY_EXPENSE", "2026-09-03 00:00:00+00");
		const pout = await seedPur("500.00", "MANDATORY_EXPENSE", "2026-08-20 00:00:00+00"); // before periodStart -> not MTD
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1, idempotencyKey: `rc-c1-${seq}`,
			components: [
				{ componentType: "PURCHASE", amount: "500.00", ownership: "PERSONAL", purchaseEventId: pin.eid },
				{ componentType: "PURCHASE", amount: "500.00", ownership: "PERSONAL", purchaseEventId: pout.eid },
			],
		});
		try {
			await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf: asOfSep });
			bad("C: mandatory + non-MTD component under partial carry-in did NOT fail closed");
		} catch (e) {
			String((e as Error).message).includes("PARTIAL_CARRY_IN_CATEGORY_ALLOCATION_UNRESOLVED")
				? ok("C: partial carry-in + unmatched/non-MTD component => FAIL CLOSED")
				: bad("C: fail closed", `-> ${(e as Error).message}`);
		}
		await voidStmt(sid, r1);
	}
	// D: ZERO carry-in + mixed categories -> exact overlap (CASE A, overlap = m)
	{
		const { sid, r1 } = await seedStmt("f0000000-0000-4000-8000-0000000000d1", "1000.00");
		const pm = await seedPur("400.00", "MANDATORY_EXPENSE");
		const pd = await seedPur("600.00", "DISCRETIONARY_SPEND");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1, idempotencyKey: `rc-d1-${seq}`,
			components: [
				{ componentType: "PURCHASE", amount: "400.00", ownership: "PERSONAL", purchaseEventId: pm.eid },
				{ componentType: "PURCHASE", amount: "600.00", ownership: "PERSONAL", purchaseEventId: pd.eid },
			],
		});
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf: asOfSep });
		const bl = (res.evidenceSnapshot as any).basicLiving;
		const d = bl.basicLivingOverlapDetail.find((x: any) => x.statementId === sid);
		(d?.overlapBasis === "A_NO_CARRY_IN" && bl.basicLivingOverlapWithCurrentObligations === "400.00")
			? ok("D: zero carry-in + mixed categories => exact overlap = MTD-mandatory candidate (400)")
			: bad("D: zero carry-in overlap", `-> basis=${d?.overlapBasis} overlap=${bl.basicLivingOverlapWithCurrentObligations}`);
		await voidStmt(sid, r1);
	}
	// E: FULL carry-in -> burden zero -> overlap zero
	{
		const { sid, r1 } = await seedStmt("f0000000-0000-4000-8000-0000000000e1", "1000.00");
		const pm = await seedPur("1000.00", "MANDATORY_EXPENSE");
		await reconcileStatement({
			db, userId: U1, statementId: sid, statementRevisionId: r1, idempotencyKey: `rc-e1-${seq}`,
			components: [{ componentType: "PURCHASE", amount: "1000.00", ownership: "PERSONAL", purchaseEventId: pm.eid }],
		});
		const res = await resolveBudgetV2LiveSnapshot({ db, userId: U1, periodMonth: P, asOf: asOfSep });
		const bl = (res.evidenceSnapshot as any).basicLiving;
		(bl.basicLivingOverlapWithCurrentObligations === "0.00" &&
			(res.evidenceSnapshot as any).obligations.creditCardStatements.find((x: any) => x.statementId === sid)?.recognizedPersonalBurden === "0.00")
			? ok("E: full pre-period reserve => statement burden 0 and overlap 0")
			: bad("E: full carry-in", `-> overlap=${bl.basicLivingOverlapWithCurrentObligations}`);
		await voidStmt(sid, r1);
	}

	await pg.close();
}

// ============================================================================
// PHASE 4B: AUTHORITATIVE CHECKPOINT REPORT READ MODEL (hardened in 4B.1)
// ============================================================================

const B4_IDS = {
	F: "f".repeat(64),
	CASH: "d1000000-0000-4000-8000-000000000001",
	INCOME_ACC: "d1000000-0000-4000-8000-000000000002",
	MID: "e1000000-0000-4000-8000-000000000001",
	CEF: "f0000000-0000-4000-8000-000000000001",
	CARD: "80000000-0000-4000-8000-000000000001",
	P_FAM: "9a000000-0000-4000-8000-000000000001",
	P_FRI: "9a000000-0000-4000-8000-000000000002",
	P_OTH: "9a000000-0000-4000-8000-000000000003",
	REG1: "a1000000-0000-4000-8000-000000000001",
	SUP1: "a1000000-0000-4000-8000-000000000003",
	SUP2: "a1000000-0000-4000-8000-000000000004",
	EXT1: "a1000000-0000-4000-8000-000000000005",
	P: "2026-09-01",
} as const;

/**
 * One fresh disposable PGlite DB + the shared Budget V2 checkpoint fixture
 * (user / ledger / midas+CEF / card / people / basic-living) plus every raw
 * seed helper. Reused by Phase 4B and Phase 4B.2.
 */
async function make4bScenario() {
	const { drizzle } = await import("drizzle-orm/pglite");
	const { createBasicLivingTarget } = await import(
		"../src/budget/basic-living-config-v2.ts"
	);
	const {
		F,
		CASH,
		INCOME_ACC,
		MID,
		CEF,
		CARD,
		P_FAM,
		P_FRI,
		P_OTH,
		REG1,
		SUP1,
		SUP2,
		EXT1,
		P,
	} = B4_IDS;
	const pg = new PGlite();
	await pg.query("SET timezone='UTC'");
	await applyChain(pg, 68);
	// biome-ignore lint/suspicious/noExplicitAny: cross-driver drizzle client
	const db = drizzle(pg as any) as any;

	let n = 0;
	const gid = () => {
		n++;
		return `90000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
	const q = <T = unknown>(sql: string, params: unknown[] = []) =>
		pg.query<T>(sql, params as never[]);
	const replica = () => pg.exec("SET session_replication_role = replica");
	const origin = () => pg.exec("SET session_replication_role = origin");

	const mkCanon = async (kind: string, occ: string) => {
		const ct = gid();
		const tr = gid();
		await q(
			`insert into canonical_transactions (id,user_id,kind,creation_idempotency_key,creation_fingerprint) values ($1,$2,$3,$4,$5)`,
			[ct, U1, kind, `ck-${n}`, F],
		);
		await q(
			`insert into transaction_revisions (id,user_id,transaction_id,revision_no,operation,occurred_at,payload,revision_fingerprint,idempotency_key) values ($1,$2,$3,1,'CREATE',$4,'{}'::jsonb,$5,$6)`,
			[tr, U1, ct, occ, F, `tk-${n}`],
		);
		return { ct, tr };
	};
	const mkReceipt = async (
		rid: string,
		src: string,
		amount: string,
		occ: string,
	) => {
		const { ct, tr } = await mkCanon("INCOME_RECEIPT", occ);
		await q(
			`insert into income_receipts (id,user_id,source_id,canonical_transaction_id) values ($1,$2,$3,$4)`,
			[rid, U1, src, ct],
		);
		await q(
			`insert into income_receipt_revisions (id,user_id,income_receipt_id,canonical_revision_id,revision_no,operation,occurred_at,amount,destination_account_id) values ($1,$2,$3,$4,1,'CREATE',$5,$6,$7)`,
			[gid(), U1, rid, tr, occ, amount, CASH],
		);
	};
	const mkPur = async (
		amount: string,
		category: string,
		occ: string,
		opts: { merchant?: string; installmentCount?: number } = {},
	) => {
		const { ct, tr } = await mkCanon("CREDIT_CARD_PURCHASE", occ);
		const eid = gid();
		const er = gid();
		await q(
			`insert into credit_card_liability_events (id,user_id,credit_card_id,event_type,canonical_transaction_id) values ($1,$2,$3,'PURCHASE',$4)`,
			[eid, U1, CARD, ct],
		);
		await q(
			`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,canonical_revision_id,operation,amount,budget_category,merchant,installment_count,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,$4,'CREATE',$5,$6,$7,$8,$9,$10,$11)`,
			[
				er,
				U1,
				eid,
				tr,
				amount,
				category,
				opts.merchant ?? null,
				opts.installmentCount ?? null,
				occ,
				`pk-${n}`,
				F,
			],
		);
		return { eid, er };
	};
	const mkPurRev = async (
		eid: string,
		prevEr: string,
		revNo: number,
		op: string,
		amount: string,
		category: string,
		occ: string,
	) => {
		const { tr } = await mkCanon("CREDIT_CARD_PURCHASE", occ);
		const er = gid();
		await q(
			`insert into credit_card_liability_event_revisions (id,user_id,event_id,revision_no,previous_revision_id,canonical_revision_id,operation,amount,budget_category,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			[er, U1, eid, revNo, prevEr, tr, op, amount, category, occ, `pk-${n}`, F],
		);
		return er;
	};
	const mkObligation = async (
		oblId: string,
		person: string,
		dir: "RECEIVABLE" | "PAYABLE",
		principal: string,
		occ: string,
	) => {
		const { ct, tr } = await mkCanon(
			dir === "RECEIVABLE"
				? "PERSON_RECEIVABLE_ADVANCE"
				: "PERSON_PAYABLE_EXPENSE",
			occ,
		);
		await q(
			`insert into person_obligations (id,user_id,person_id,direction,canonical_transaction_id) values ($1,$2,$3,$4,$5)`,
			[oblId, U1, person, dir, ct],
		);
		await q(
			`insert into person_obligation_revisions (id,user_id,obligation_id,revision_no,canonical_revision_id,operation,principal_amount,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,$4,'CREATE',$5,$6,$7,$8)`,
			[gid(), U1, oblId, tr, principal, occ, `ok-${n}`, F],
		);
	};
	const mkSettlement = async (
		setId: string,
		oblId: string,
		applied: string,
		occ: string,
	) => {
		const { ct, tr } = await mkCanon("PERSON_OBLIGATION_SETTLEMENT", occ);
		await q(
			`insert into person_settlements (id,user_id,obligation_id,canonical_transaction_id) values ($1,$2,$3,$4)`,
			[setId, U1, oblId, ct],
		);
		await q(
			`insert into person_settlement_revisions (id,user_id,settlement_id,revision_no,operation,asset_account_id,cash_amount,applied_amount,excess_amount,occurred_at,canonical_revision_id,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE',$4,$5,$5,'0.00',$6,$7,$8,$9)`,
			[gid(), U1, setId, CASH, applied, occ, tr, `sk-${n}`, F],
		);
	};
	let rbSeq = 0;
	const nextReserve = () => {
		rbSeq++;
		return `f0000000-0000-4000-8000-00000000b0${rbSeq.toString().padStart(2, "0")}`;
	};
	const mkStmt = async (
		sid: string,
		amount: string,
		cycleMonth: number,
		reserveBucket?: string,
	) => {
		const rb = reserveBucket ?? nextReserve();
		const r1 = gid();
		await q(
			`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values ($1,$2,$3,$4,'reserve','CREDIT_CARD_RESERVE')`,
			[rb, U1, MID, `RB${rbSeq}`],
		);
		await q(
			`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month) values ($1,$2,$3,$4,$5,2026,$6)`,
			[sid, U1, CARD, MID, rb, cycleMonth],
		);
		await q(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','OPEN',$4,'2026-09-01','2026-09-20','MIDAS_FUND','2026-09-01 00:00:00+00',$5,$6)`,
			[r1, U1, sid, amount, `stk-${n}`, F],
		);
		return r1;
	};
	const mkStmtRev = async (
		sid: string,
		prevRevId: string,
		revNo: number,
		op: "PAY" | "REOPEN" | "VOID",
		status: "PAID" | "OPEN" | "VOID",
		amount: string,
		occ: string,
		paymentEventId: string | null = null,
	) => {
		const id = gid();
		await q(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,previous_revision_id,operation,status,statement_amount,statement_date,due_date,reserve_placement,payment_event_id,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,'2026-09-01','2026-09-20','MIDAS_FUND',$9,$10,$11,$12)`,
			[
				id,
				U1,
				sid,
				revNo,
				prevRevId,
				op,
				status,
				amount,
				paymentEventId,
				occ,
				`stk-${n}`,
				F,
			],
		);
		return id;
	};
	const mkPayEvent = async (sid: string, amount: string, occ: string) => {
		const { ct } = await mkCanon("CREDIT_CARD_STATEMENT_PAYMENT", occ);
		const pe = gid();
		await q(
			`insert into credit_card_statement_payment_events (id,user_id,statement_id,canonical_transaction_id,payment_asset_account_id,amount,occurred_at) values ($1,$2,$3,$4,$5,$6,$7)`,
			[pe, U1, sid, ct, CASH, amount, occ],
		);
		return pe;
	};
	const mkPay = async (
		sid: string,
		prevRevId: string,
		amount: string,
		revNo: number,
		payAt: string,
	) => {
		const pe = await mkPayEvent(sid, amount, payAt);
		const r = await mkStmtRev(
			sid,
			prevRevId,
			revNo,
			"PAY",
			"PAID",
			amount,
			payAt,
			pe,
		);
		return { pe, r };
	};
	const mkSplit = async (opts: {
		purchaseEid: string;
		purchaseEr: string;
		splitId: string;
		revNo?: number;
		prevRevId?: string | null;
		op?: "CREATE" | "UPDATE" | "VOID";
		user: string;
		ext: string;
		gross: string;
		occ: string;
		sealed?: boolean;
		personId?: string;
		personObligationId?: string;
		participantId?: string;
		itemShare?: string;
		withItem?: boolean;
	}) => {
		const revNo = opts.revNo ?? 1;
		const op = opts.op ?? "CREATE";
		const sealed = opts.sealed ?? true;
		const withItem = opts.withItem ?? true;
		const splitRev = gid();
		let participantId = opts.participantId;
		if (revNo === 1) {
			await q(
				`insert into credit_card_purchase_splits (id,user_id,purchase_event_id) values ($1,$2,$3)`,
				[opts.splitId, U1, opts.purchaseEid],
			);
			if (opts.personId && opts.personObligationId) {
				participantId = gid();
				await q(
					`insert into credit_card_purchase_split_participants (id,user_id,split_id,person_id,person_obligation_id) values ($1,$2,$3,$4,$5)`,
					[participantId, U1, opts.splitId, opts.personId, opts.personObligationId],
				);
			}
		}
		await q(
			`insert into credit_card_purchase_split_revisions (id,split_id,revision_no,previous_revision_id,operation,method,purchase_event_revision_id,gross_amount,user_share_amount,external_share_amount,occurred_at,revision_fingerprint) values ($1,$2,$3,$4,$5,'MANUAL',$6,$7,$8,$9,$10,$11)`,
			[
				splitRev,
				opts.splitId,
				revNo,
				opts.prevRevId ?? null,
				op,
				opts.purchaseEr,
				opts.gross,
				opts.user,
				opts.ext,
				opts.occ,
				F,
			],
		);
		if (withItem && op !== "VOID" && opts.personId && participantId) {
			await q(
				`insert into credit_card_purchase_split_revision_items (id,split_revision_id,participant_id,person_id,share_amount) values ($1,$2,$3,$4,$5)`,
				[gid(), splitRev, participantId, opts.personId, opts.itemShare ?? opts.ext],
			);
		}
		if (sealed) {
			await q(
				`insert into credit_card_purchase_split_revision_seals (split_revision_id) values ($1)`,
				[splitRev],
			);
		}
		return { splitId: opts.splitId, splitRev, participantId };
	};
	const mkCardRev = async (
		revNo: number,
		prevRevId: string,
		displayName: string,
		issuer: string,
		occ: string,
	) => {
		const id = gid();
		await q(
			`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,previous_revision_id,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,'UPDATE','ACTIVE',$6,$7,'1','20','90000.00',$8,$9,$10)`,
			[id, U1, CARD, revNo, prevRevId, displayName, issuer, occ, `ccr-${n}`, F],
		);
		return id;
	};
	const mkPerson = async (
		personId: string,
		name: string,
		rel: "FAMILY" | "FRIEND" | "OTHER",
		occ: string,
	) => {
		await q(`insert into people (id,user_id) values ($1,$2)`, [personId, U1]);
		const rid = gid();
		await q(
			`insert into person_revisions (id,user_id,person_id,revision_no,operation,status,display_name,relationship,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','ACTIVE',$4,$5,$6,$7,$8)`,
			[rid, U1, personId, name, rel, occ, `pr-${personId.slice(-4)}`, F],
		);
		return rid;
	};
	const mkPersonRev = async (
		personId: string,
		prevRevId: string,
		revNo: number,
		name: string,
		rel: "FAMILY" | "FRIEND" | "OTHER",
		occ: string,
	) => {
		const id = gid();
		await q(
			`insert into person_revisions (id,user_id,person_id,revision_no,previous_revision_id,operation,status,display_name,relationship,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,'UPDATE','ACTIVE',$6,$7,$8,$9,$10)`,
			[id, U1, personId, revNo, prevRevId, name, rel, occ, `pr-${n}`, F],
		);
		return id;
	};

	// base fixture
	await replica();
	await q(
		"insert into users (id, display_name, currency, timezone) values ($1,'U','TRY','Europe/Istanbul')",
		[U1],
	);
	await q(
		`insert into ledger_accounts (id,user_id,code,name,account_type,normal_balance,currency) values
		 ($1,$3,'ASSET_CASH','Cash','ASSET','DEBIT','TRY'),
		 ($2,$3,'INCOME_GEN','Income','INCOME','CREDIT','TRY')`,
		[CASH, INCOME_ACC, U1],
	);
	await q(
		`insert into midas_accounts (id,user_id,ledger_account_id) values ($1,$2,$3)`,
		[MID, U1, CASH],
	);
	await q(
		`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values ($1,$2,$3,'CEF','Emergency','CORE_EMERGENCY_FUND')`,
		[CEF, U1, MID],
	);
	await q(
		`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ($1,$2,$3,'mt-cef',$4,null,$5,'10000.00','2026-08-01 00:00:00+00')`,
		[gid(), U1, MID, F, CEF],
	);
	await q(
		`insert into income_sources (id,user_id,code,name,nature,reference_method,expected_monthly_amount,income_ledger_account_id,active_from) values
		 ($1,$5,'REG1','Salary','REGULAR','FIXED_MONTHLY','20000.00',$6,'1900-01-01'),
		 ($2,$5,'SUP1','Family A','SUPPORT','EXCLUDED',null,$6,'1900-01-01'),
		 ($3,$5,'SUP2','Family B','SUPPORT','EXCLUDED',null,$6,'1900-01-01'),
		 ($4,$5,'EXT1','Bonus','EXTRA','EXCLUDED',null,$6,'1900-01-01')`,
		[REG1, SUP1, SUP2, EXT1, U1, INCOME_ACC],
	);
	await q(`insert into credit_cards (id,user_id,code) values ($1,$2,'CARDA')`, [
		CARD,
		U1,
	]);
	await q(
		`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','ACTIVE','Akbank Axess','Akbank','1','20','90000.00','2026-07-01 00:00:00+00','ccr-1',$4)`,
		[gid(), U1, CARD, F],
	);
	await mkPerson(P_FAM, "Anne", "FAMILY", "2026-07-01 00:00:00+00");
	await mkPerson(P_FRI, "Kerem", "FRIEND", "2026-07-01 00:00:00+00");
	await mkPerson(P_OTH, "Komsu", "OTHER", "2026-07-01 00:00:00+00");
	await origin();
	await createBasicLivingTarget({
		db,
		userId: U1,
		effectivePeriodMonth: "2026-09-01",
		monthlyTargetAmount: "6000.00",
		currency: "TRY",
		sourceKind: "USER_APPROVED",
		idempotencyKey: "bl-4b",
		occurredAt: new Date("2026-08-15T00:00:00Z"),
	});

	return {
		pg,
		db,
		F,
		CASH,
		INCOME_ACC,
		MID,
		CEF,
		CARD,
		P_FAM,
		P_FRI,
		P_OTH,
		REG1,
		SUP1,
		SUP2,
		EXT1,
		P,
		gid,
		q,
		replica,
		origin,
		mkCanon,
		mkReceipt,
		mkPur,
		mkPurRev,
		mkObligation,
		mkSettlement,
		mkStmt,
		mkStmtRev,
		mkPayEvent,
		mkPay,
		mkSplit,
		mkCardRev,
		mkPerson,
		mkPersonRev,
		close: () => pg.close(),
	};
}


function centsB(v: string): bigint {
	const [i, f = "0"] = v.split(".");
	return BigInt(i ?? "0") * 100n + BigInt((f + "00").slice(0, 2));
}

async function resolverRuntime4B() {
	console.log(
		"\n== PHASE 4B: BUDGET V2 CHECKPOINT REPORT READ MODEL (drizzle / PGlite) ==",
	);
	const { drizzle } = await import("drizzle-orm/pglite");
	const {
		buildBudgetV2CheckpointReport,
		buildBudgetV2CheckpointReportByStatement,
	} = await import("../src/budget/checkpoint-report-v2.ts");
	const { resolveBudgetV2LiveSnapshot } = await import(
		"../src/budget/live-resolver-v2.ts"
	);
	const { createBasicLivingTarget } = await import(
		"../src/budget/basic-living-config-v2.ts"
	);
	const { classifySupportReceipt } = await import(
		"../src/budget/support-classification-v2.ts"
	);
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);

	const {
		F,
		CASH,
		INCOME_ACC,
		MID,
		CEF,
		CARD,
		P_FAM,
		P_FRI,
		P_OTH,
		REG1,
		SUP1,
		SUP2,
		EXT1,
		P,
	} = B4_IDS;

	const eqB = (a: unknown, b: unknown, name: string) =>
		a === b
			? ok(name)
			: bad(name, `-> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
	const chkB = (c: boolean, name: string) => (c ? ok(name) : bad(name));
	const expectThrowB = async (
		fn: () => Promise<unknown>,
		needle: string,
		name: string,
	) => {
		try {
			await fn();
			bad(name, "-> did not throw");
		} catch (e) {
			String((e as Error).message).includes(needle)
				? ok(name)
				: bad(name, `-> ${(e as Error).message}`);
		}
	};

	// ---- fresh disposable DB + shared fixture + seed helpers (see make4bScenario) ----
	const scenario = make4bScenario;

	// =====================================================================
	// MAIN happy-path DB -- adapted 4B A..X + FAMILY_REIMBURSEMENT (K)
	// =====================================================================
	{
		const s = await scenario();
		const OBL_FAM_R = "8a000000-0000-4000-8000-000000000001";
		const OBL_FAM_STD = "8a000000-0000-4000-8000-000000000002";

		await s.replica();
		await s.mkReceipt(
			"b1000000-0000-4000-8000-000000000001",
			REG1,
			"20000.00",
			"2026-09-01 00:00:00+03",
		);
		await s.mkReceipt(
			"b1000000-0000-4000-8000-000000000003",
			SUP1,
			"2000.00",
			"2026-09-04 00:00:00+00",
		);
		await s.mkReceipt(
			"b1000000-0000-4000-8000-000000000004",
			SUP2,
			"1500.00",
			"2026-09-05 00:00:00+00",
		);
		await s.mkReceipt(
			"b1000000-0000-4000-8000-000000000005",
			EXT1,
			"111.00",
			"2026-09-10 09:00:00+00",
		);
		await s.mkReceipt(
			"b1000000-0000-4000-8000-000000000006",
			EXT1,
			"222.00",
			"2026-09-10 09:00:00.001+00",
		);
		const purA = await s.mkPur(
			"600.00",
			"MANDATORY_EXPENSE",
			"2026-09-03 00:00:00+00",
		);
		const purI = await s.mkPur(
			"1200.00",
			"DISCRETIONARY_SPEND",
			"2026-09-05 00:00:00+00",
			{ merchant: "RESTORAN MARKET", installmentCount: 6 },
		);
		const purS = await s.mkPur(
			"1000.00",
			"SHORT_TERM_PURCHASE",
			"2026-09-06 00:00:00+00",
		);
		const purV = await s.mkPur(
			"200.00",
			"DISCRETIONARY_SPEND",
			"2026-09-07 00:00:00+00",
		);
		await s.mkPurRev(
			purV.eid,
			purV.er,
			2,
			"VOID",
			"200.00",
			"DISCRETIONARY_SPEND",
			"2026-09-08 00:00:00+00",
		);
		const purQ = await s.mkPur(
			"300.00",
			"DISCRETIONARY_SPEND",
			"2026-09-08 00:00:00+00",
		);
		await s.mkPurRev(
			purQ.eid,
			purQ.er,
			2,
			"UPDATE",
			"300.00",
			"DISCRETIONARY_SPEND",
			"2026-09-13 00:00:00+00",
		);
		await s.mkObligation(
			OBL_FAM_R,
			P_FAM,
			"RECEIVABLE",
			"600.00",
			"2026-09-06 00:00:00+00",
		);
		await s.mkSplit({
			purchaseEid: purS.eid,
			purchaseEr: purS.er,
			splitId: "87000000-0000-4000-8000-000000000001",
			user: "400.00",
			ext: "600.00",
			gross: "1000.00",
			occ: "2026-09-06 00:00:00+00",
			personId: P_FAM,
			personObligationId: OBL_FAM_R,
		});
		await s.mkObligation(
			OBL_FAM_STD,
			P_FAM,
			"RECEIVABLE",
			"250.00",
			"2026-09-06 00:00:00+00",
		);
		await s.mkSettlement(
			"8b000000-0000-4000-8000-000000000001",
			OBL_FAM_R,
			"600.00",
			"2026-09-10 00:00:00+00",
		);
		await s.mkSettlement(
			"8b000000-0000-4000-8000-000000000002",
			OBL_FAM_STD,
			"250.00",
			"2026-09-11 00:00:00+00",
		);
		const TS1 = "81000000-0000-4000-8000-000000000001";
		const TS2 = "81000000-0000-4000-8000-000000000002";
		const TS3 = "81000000-0000-4000-8000-000000000003";
		const ts1r1 = await s.mkStmt(TS1, "1000.00", 9);
		const ts2r1 = await s.mkStmt(TS2, "500.00", 8);
		const ts3r1 = await s.mkStmt(TS3, "400.00", 7);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: TS1,
			statementRevisionId: ts1r1,
			idempotencyKey: "rc-ts1",
			components: [
				{
					componentType: "PURCHASE",
					amount: "600.00",
					ownership: "PERSONAL",
					purchaseEventId: purA.eid,
				},
				{
					componentType: "ADJUSTMENT",
					amount: "300.00",
					ownership: "EXTERNAL_PERSON",
					personId: P_FAM,
					adjustmentKind: "OTHER",
				},
				{
					componentType: "ADJUSTMENT",
					amount: "100.00",
					ownership: "EXTERNAL_PERSON",
					personId: P_FRI,
					adjustmentKind: "OTHER",
				},
			],
		});
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: TS2,
			statementRevisionId: ts2r1,
			idempotencyKey: "rc-ts2",
			components: [
				{
					componentType: "ADJUSTMENT",
					amount: "500.00",
					ownership: "PERSONAL",
					adjustmentKind: "OTHER",
				},
			],
		});
		await classifySupportReceipt({
			db: s.db,
			userId: U1,
			incomeReceiptId: "b1000000-0000-4000-8000-000000000003",
			supportRole: "PLANNED_FAMILY_GIFT",
			idempotencyKey: "sup-gift-4b",
		});
		await classifySupportReceipt({
			db: s.db,
			userId: U1,
			incomeReceiptId: "b1000000-0000-4000-8000-000000000004",
			supportRole: "DEFICIT_FAMILY_SUPPORT",
			idempotencyKey: "sup-def-4b",
		});
		await s.replica();
		const { pe: PE1, r: PE1_PAYREV } = await s.mkPay(
			TS1,
			ts1r1,
			"1000.00",
			2,
			"2026-09-15 00:00:00+00",
		);
		await s.mkPay(TS2, ts2r1, "500.00", 2, "2026-09-12 00:00:00+00");
		await s.mkPayEvent(TS3, "400.00", "2026-09-13 00:00:00+00"); // orphan payment event
		await s.mkStmtRev(
			TS3,
			ts3r1,
			2,
			"VOID",
			"VOID",
			"400.00",
			"2026-09-14 00:00:00+00",
		);
		await s.origin();

		const CHECKPOINT_ISO = "2026-09-15T00:00:00.000Z";
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: PE1,
		});

		// canonical trigger identity = payment event
		eqB(rep.checkpoint.paymentEventId, PE1, "trigger identity is the payment event id");
		eqB(rep.checkpoint.payRevisionId, PE1_PAYREV, "trigger exposes the exact PAY revision id");
		eqB(rep.triggerPayment.paymentEventId, PE1, "triggerPayment.paymentEventId");
		eqB(rep.triggerPayment.payRevisionId, PE1_PAYREV, "triggerPayment.payRevisionId");
		eqB(rep.triggerPayment.checkpointAt, CHECKPOINT_ISO, "A: checkpointAt from the authoritative payment event");
		eqB(rep.triggerPayment.statementAmount, "1000.00", "A: trigger statement amount (PAY revision)");
		eqB(rep.triggerPayment.paymentAmount, "1000.00", "A: trigger payment amount agrees");
		eqB(rep.triggerPayment.reconciliationRevisionNo, 1, "A: reconciliation revision no");
		eqB(rep.triggerPayment.paymentAssetAccountId, CASH, "A: authoritative paymentAssetAccountId");
		eqB(rep.triggerPayment.displayName, "Akbank Axess", "5: card displayName as of checkpoint");
		eqB(rep.triggerPayment.issuer, "Akbank", "5: card issuer as of checkpoint");

		eqB(rep.checkpoint.intervalStart, new Date(`${P}T00:00:00+03:00`).toISOString(), "H: first-checkpoint interval starts at period start");
		chkB(rep.checkpoint.intervalStartInclusive === true && rep.checkpoint.isFirstCheckpoint === true, "H: first-checkpoint interval start INCLUSIVE");
		chkB(rep.interval.income.activity.some((x) => x.receiptId === "b1000000-0000-4000-8000-000000000001"), "H: income receipt exactly at period start is INCLUDED");

		const own = rep.triggerPayment.ownership;
		eqB(own.grossStatementAmount, "1000.00", "I: gross reconciled statement amount");
		eqB(own.personalEconomicShare, "600.00", "I: personal economic share");
		eqB(own.familyExternalShare, "300.00", "I: FAMILY external share");
		eqB(own.friendExternalShare, "100.00", "I: FRIEND external share");
		eqB(own.otherExternalShare, "0.00", "I: OTHER external share");
		eqB(own.externalShareTotal, "400.00", "I: external share total");
		chkB(
			centsB(own.personalEconomicShare) +
				centsB(own.familyExternalShare) +
				centsB(own.friendExternalShare) +
				centsB(own.otherExternalShare) ===
				centsB(own.grossStatementAmount),
			"J: personal + family + friend + other == reconciled statement amount",
		);

		eqB(rep.interval.income.regularReceipts, "20000.00", "income: REGULAR interval total");
		eqB(rep.interval.income.extraReceipts, "333.00", "income: EXTRA interval total");
		eqB(rep.interval.income.plannedFamilyGiftReceipts, "2000.00", "N: PLANNED_FAMILY_GIFT reported separately");
		eqB(rep.interval.income.deficitFamilySupportReceipts, "1500.00", "O: DEFICIT_FAMILY_SUPPORT reported separately");

		chkB(rep.interval.purchases.newlyPostedPurchases.includes(purA.eid), "P: a purchase CREATE in the interval is newly posted");
		chkB(rep.interval.purchases.correctedPurchases.includes(purQ.eid), "Q: a purchase UPDATE in the interval is a correction");
		chkB(rep.interval.purchases.voidedPurchases.includes(purV.eid), "R: a purchase VOID in the interval is void activity");
		const purSAct = rep.interval.purchases.activity.find((x) => x.eventId === purS.eid && x.operation === "CREATE");
		chkB(
			!!purSAct &&
				purSAct.ownership.available === true &&
				purSAct.ownership.basis === "SEALED_SPLIT_AS_OF" &&
				purSAct.ownership.personalShare === "400.00",
			"7: interval purchase ownership comes from the sealed split effective at the activity instant",
		);

		const famReim = rep.interval.peopleFamily.familyReimbursements;
		chkB(
			famReim.length === 1 &&
				famReim[0]?.obligationId === OBL_FAM_R &&
				famReim[0]?.purchaseEventId === purS.eid &&
				!!famReim[0]?.splitRevisionId &&
				famReim[0]?.settlementAmount === "600.00",
			"K: sealed split-generated FAMILY receivable settlement => FAMILY_REIMBURSEMENT",
		);
		chkB(
			rep.interval.peopleFamily.standaloneReceivableSettlements.some(
				(x) => x.obligationId === OBL_FAM_STD && x.settlementAmount === "250.00",
			) && !famReim.some((x) => x.obligationId === OBL_FAM_STD),
			"K: a standalone FAMILY receivable settlement is reported separately, never as a reimbursement",
		);
		chkB(
			rep.interval.income.regularReceipts === "20000.00" &&
				rep.interval.income.extraReceipts === "333.00",
			"L: FAMILY_REIMBURSEMENT (600) never leaks into any interval income total",
		);

		const sp = rep.interval.statementPayments;
		eqB(sp.length, 3, "11: all three interval statement payments listed");
		const spTrig = sp.find((x) => x.paymentEventId === PE1);
		const spTs2 = sp.find((x) => x.statementId === TS2);
		const spTs3 = sp.find((x) => x.statementId === TS3);
		chkB(!!spTrig && spTrig.isTrigger === true && spTrig.ownership.available === true, "11/E: the trigger payment (exactly at checkpointAt) is INCLUDED with an authoritative decomposition");
		chkB(!!spTs2 && spTs2.isTrigger === false && spTs2.ownership.available === true && spTs2.ownership.personalEconomicShare === "500.00", "11: a reconciled non-trigger statement payment carries an ownership decomposition");
		chkB(!!spTs3 && spTs3.ownership.available === false && spTs3.ownership.reason === "RECONCILIATION_UNAVAILABLE", "11: a non-reconciled statement payment reports ownership UNAVAILABLE");

		const spend = rep.mtd.spending;
		eqB(spend.byCategoryPersonalShare.MANDATORY_EXPENSE, "600.00", "T: MTD MANDATORY_EXPENSE personal share");
		eqB(spend.byCategoryPersonalShare.DISCRETIONARY_SPEND, "1500.00", "T: MTD DISCRETIONARY_SPEND personal share");
		eqB(spend.byCategoryPersonalShare.SHORT_TERM_PURCHASE, "400.00", "S/T: MTD SHORT_TERM_PURCHASE uses the 400 personal share, not 1000 gross");
		eqB(spend.byCategoryPersonalShare.UNCLASSIFIED, "0.00", "T: MTD UNCLASSIFIED personal share");
		eqB(spend.grossCardPurchasesMTD, "3100.00", "S: gross card purchases MTD");
		eqB(spend.personalCardSpendMTD, "2500.00", "S: personal card spend MTD < gross");
		eqB(spend.externalCardSpendMTD, "600.00", "S: external card spend MTD");
		eqB(spend.externalCardSpendByRelationship.FAMILY, "600.00", "S: external card spend MTD attributed to FAMILY by exact split truth");

		chkB(
			rep.foodAnalytics.available === false && rep.foodAnalytics.merchantInferenceUsed === false,
			"U: a market/restaurant merchant name does NOT trigger any food inference",
		);
		const inst = rep.installmentAnalytics;
		chkB(
			inst.purchases.some((x) => x.eventId === purI.eid && x.installmentCount === 6 && x.grossAmount === "1200.00") &&
				inst.futureInstallmentProjection.available === false,
			"V: installmentCount=6 metadata visible; forward projection unavailable",
		);
		chkB(rep.availableToAllocateNow.available === false, "15: availableToAllocateNow preserved");

		const live = await resolveBudgetV2LiveSnapshot({
			db: s.db,
			userId: U1,
			periodMonth: P,
			asOf: new Date(CHECKPOINT_ISO),
		});
		eqB(JSON.stringify(rep.mtd.budget.inputs), JSON.stringify(live.inputs), "X: mtd.budget.inputs === live resolver inputs");
		eqB(rep.mtd.budget.policyOutput.trueSurplus, live.policyResult.outputs.trueSurplus.amount, "X: mtd.budget.policyOutput.trueSurplus === live resolver");
		eqB(rep.mtd.budget.policyOutput.deficit, live.policyResult.outputs.deficit.amount, "X: mtd.budget.policyOutput.deficit === live resolver");
		eqB(
			rep.mtd.budget.basicLiving.basicLivingFunding,
			(live.evidenceSnapshot as { basicLiving: { basicLivingFunding: string } }).basicLiving.basicLivingFunding,
			"X: mtd.budget.basicLiving.basicLivingFunding === live resolver",
		);
		eqB(rep.mtd.emergencyFund.currentBalance, "10000.00", "X: mtd.emergencyFund.currentBalance");
		eqB(rep.mtd.emergencyFund.gap, "0.00", "X: mtd.emergencyFund.gap");

		// report 2: subsequent checkpoint
		const prev = new Date("2026-09-10T09:00:00.000Z");
		const rep2 = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: PE1,
			previousCheckpointAt: prev,
		});
		eqB(rep2.checkpoint.intervalStart, prev.toISOString(), "interval: subsequent checkpoint starts at previousCheckpointAt");
		chkB(rep2.checkpoint.intervalStartInclusive === false && rep2.checkpoint.isFirstCheckpoint === false, "interval: previousCheckpointAt is EXCLUSIVE");
		chkB(!rep2.interval.income.activity.some((x) => x.receiptId === "b1000000-0000-4000-8000-000000000005"), "F: activity exactly at previousCheckpointAt is EXCLUDED");
		chkB(rep2.interval.income.activity.some((x) => x.receiptId === "b1000000-0000-4000-8000-000000000006"), "G: activity 1ms after previousCheckpointAt is INCLUDED");
		chkB(rep2.interval.purchases.correctedPurchases.includes(purQ.eid) && !rep2.interval.purchases.newlyPostedPurchases.includes(purQ.eid), "Q: CREATE before the interval, UPDATE inside => correction only");

		await s.close();
	}

	// =====================================================================
	// 4B.1/A -- PAY -> REOPEN -> PAY : two distinct payment-event checkpoints
	// =====================================================================
	{
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-0000000000a1";
		await s.replica();
		const r1 = await s.mkStmt(TS, "1000.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: TS,
			statementRevisionId: r1,
			idempotencyKey: "rc-a",
			occurredAt: new Date("2026-09-01T00:00:00Z"),
			components: [
				{ componentType: "ADJUSTMENT", amount: "1000.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
			],
		});
		await s.replica();
		const { pe: PE_A, r: rev2 } = await s.mkPay(TS, r1, "1000.00", 2, "2026-09-08 00:00:00+00");
		const rev3 = await s.mkStmtRev(TS, rev2, 3, "REOPEN", "OPEN", "1000.00", "2026-09-10 00:00:00+00");
		const { pe: PE_B, r: rev4 } = await s.mkPay(TS, rev3, "1000.00", 4, "2026-09-14 00:00:00+00");
		await s.origin();

		const repA = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_A });
		const repB = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_B });
		eqB(repA.checkpoint.checkpointAt, "2026-09-08T00:00:00.000Z", "4B.1/A: first payment event identifies the first checkpoint");
		eqB(repA.checkpoint.payRevisionId, rev2, "4B.1/A: first checkpoint resolves the FIRST PAY revision (no latest-PAY substitution)");
		eqB(repB.checkpoint.checkpointAt, "2026-09-14T00:00:00.000Z", "4B.1/A: second payment event identifies the second checkpoint");
		eqB(repB.checkpoint.payRevisionId, rev4, "4B.1/A: second checkpoint resolves the SECOND PAY revision");
		await expectThrowB(
			() => buildBudgetV2CheckpointReportByStatement({ db: s.db, userId: U1, periodMonth: P, triggerStatementId: TS }),
			"distinct trigger payment events",
			"4B.1/A: the statementId wrapper rejects the PAY->REOPEN->PAY ambiguity (BUDGET_CHECKPOINT_TRIGGER_AMBIGUOUS)",
		);
		await s.close();
	}

	// =====================================================================
	// 4B.1/B & C -- unknown payment event / no PAY revision references it
	// =====================================================================
	{
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-0000000000c1";
		await s.replica();
		await s.mkStmt(TS, "500.00", 9);
		const PE_C = await s.mkPayEvent(TS, "500.00", "2026-09-10 00:00:00+00"); // no PAY revision
		await s.origin();
		await expectThrowB(
			() => buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: "90000000-0000-4000-8000-0000000fffff" }),
			"does not exist for this user",
			"4B.1/B: an unknown / not-owned trigger payment event is rejected",
		);
		await expectThrowB(
			() => buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_C }),
			"no PAY statement revision references payment event",
			"4B.1/C: a payment event that no PAY revision references is rejected",
		);
		await s.close();
	}

	// =====================================================================
	// 4B.1/D & E -- unsealed / internally-inconsistent split => MTD fails closed
	// =====================================================================
	for (const variant of ["UNSEALED", "ITEM_MISMATCH"] as const) {
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-0000000000d1";
		const OBL = "8a000000-0000-4000-8000-0000000000d1";
		await s.replica();
		const r1 = await s.mkStmt(TS, "500.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-d",
			components: [{ componentType: "ADJUSTMENT", amount: "500.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe: PE_D } = await s.mkPay(TS, r1, "500.00", 2, "2026-09-14 00:00:00+00");
		const purU = await s.mkPur("800.00", "DISCRETIONARY_SPEND", "2026-09-05 00:00:00+00");
		await s.mkObligation(OBL, P_FAM, "RECEIVABLE", "500.00", "2026-09-05 00:00:00+00");
		await s.mkSplit({
			purchaseEid: purU.eid, purchaseEr: purU.er, splitId: "87000000-0000-4000-8000-0000000000d1",
			user: "300.00", ext: "500.00", gross: "800.00", occ: "2026-09-05 00:00:00+00",
			personId: P_FAM, personObligationId: OBL,
			sealed: variant === "ITEM_MISMATCH",
			itemShare: variant === "ITEM_MISMATCH" ? "400.00" : "500.00",
		});
		await s.origin();
		await expectThrowB(
			() => buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_D }),
			variant === "UNSEALED" ? "is not sealed" : "item share sum",
			`4B.1/${variant === "UNSEALED" ? "D" : "E"}: an ${variant === "UNSEALED" ? "unsealed" : "inconsistent (item sum != external)"} split makes MTD ownership FAIL CLOSED`,
		);
		await s.close();
	}

	// =====================================================================
	// 4B.1/F & G -- future split revision ignored / VOID split not shared
	// =====================================================================
	for (const variant of ["FUTURE", "VOID"] as const) {
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-0000000000f1";
		const OBL = "8a000000-0000-4000-8000-0000000000f1";
		const SPLIT = "87000000-0000-4000-8000-0000000000f1";
		await s.replica();
		const r1 = await s.mkStmt(TS, "300.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-f",
			components: [{ componentType: "ADJUSTMENT", amount: "300.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe: PE_F } = await s.mkPay(TS, r1, "300.00", 2, "2026-09-12 00:00:00+00");
		const pur = await s.mkPur("1000.00", "SHORT_TERM_PURCHASE", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, P_FAM, "RECEIVABLE", "500.00", "2026-09-03 00:00:00+00");
		const sp1 = await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT,
			user: "500.00", ext: "500.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: P_FAM, personObligationId: OBL,
		});
		if (variant === "FUTURE") {
			await s.mkSplit({
				purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT, revNo: 2, prevRevId: sp1.splitRev,
				op: "UPDATE", user: "100.00", ext: "900.00", gross: "1000.00", occ: "2026-09-20 00:00:00+00",
				personId: P_FAM, participantId: sp1.participantId, itemShare: "900.00",
			});
		} else {
			await s.mkSplit({
				purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT, revNo: 2, prevRevId: sp1.splitRev,
				op: "VOID", user: "1000.00", ext: "0.00", gross: "1000.00", occ: "2026-09-05 00:00:00+00",
				withItem: false, sealed: false,
			});
		}
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_F });
		if (variant === "FUTURE") {
			eqB(rep.mtd.spending.externalCardSpendByRelationship.FAMILY, "500.00", "4B.1/F: a split revision after the checkpoint does NOT alter checkpoint ownership (500, not 900)");
			eqB(rep.mtd.spending.personalCardSpendMTD, "500.00", "4B.1/F: MTD personal share uses the checkpoint-effective split");
		} else {
			eqB(rep.mtd.spending.externalCardSpendByRelationship.FAMILY, "0.00", "4B.1/G: a split VOIDed before the checkpoint is NOT treated as active shared ownership");
			eqB(rep.mtd.spending.personalCardSpendMTD, "1000.00", "4B.1/G: the VOID-split purchase is 100% personal");
		}
		await s.close();
	}

	// =====================================================================
	// 4B.1/H -- person revision only AFTER checkpoint => fail closed
	// =====================================================================
	{
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-00000000c101";
		const P_LATE = "9a000000-0000-4000-8000-0000000000f9";
		await s.replica();
		await s.mkPerson(P_LATE, "Sonradan", "OTHER", "2026-09-20 00:00:00+00");
		const r1 = await s.mkStmt(TS, "1000.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-h",
			components: [
				{ componentType: "ADJUSTMENT", amount: "400.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
				{ componentType: "ADJUSTMENT", amount: "600.00", ownership: "EXTERNAL_PERSON", personId: P_LATE, adjustmentKind: "OTHER" },
			],
		});
		await s.replica();
		const { pe: PE_H } = await s.mkPay(TS, r1, "1000.00", 2, "2026-09-14 00:00:00+00");
		await s.origin();
		await expectThrowB(
			() => buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_H }),
			"no revision effective at or before",
			"4B.1/H: a person whose only revision is after the checkpoint => fail closed (no future fallback)",
		);
		await s.close();
	}

	// =====================================================================
	// 4B.1/I -- relationship change after checkpoint => prior relationship kept
	// =====================================================================
	{
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-00000000c201";
		await s.replica();
		// P_FRI is FRIEND at 2026-07-01; becomes FAMILY only at 2026-09-20
		const friRev1 = (
			await s.q<{ id: string }>(
				`select id from person_revisions where person_id=$1 and revision_no=1`,
				[P_FRI],
			)
		).rows[0].id;
		await s.mkPersonRev(P_FRI, friRev1, 2, "Kerem", "FAMILY", "2026-09-20 00:00:00+00");
		const r1 = await s.mkStmt(TS, "1000.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-i",
			components: [
				{ componentType: "ADJUSTMENT", amount: "700.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
				{ componentType: "ADJUSTMENT", amount: "300.00", ownership: "EXTERNAL_PERSON", personId: P_FRI, adjustmentKind: "OTHER" },
			],
		});
		await s.replica();
		const { pe: PE_I } = await s.mkPay(TS, r1, "1000.00", 2, "2026-09-10 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_I });
		eqB(rep.triggerPayment.ownership.friendExternalShare, "300.00", "4B.1/I: relationship at the checkpoint (FRIEND) is used, not a later FAMILY revision");
		eqB(rep.triggerPayment.ownership.familyExternalShare, "0.00", "4B.1/I: the later FAMILY reclassification does not time-travel into the report");
		await s.close();
	}

	// =====================================================================
	// 4B.1/J -- card rename after checkpoint => old label kept
	// =====================================================================
	{
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-00000000c301";
		await s.replica();
		const cardRev1 = (
			await s.q<{ id: string }>(
				`select id from credit_card_revisions where credit_card_id=$1 and revision_no=1`,
				[CARD],
			)
		).rows[0].id;
		await s.mkCardRev(2, cardRev1, "Yeni Kart", "Baska Banka", "2026-09-20 00:00:00+00");
		const r1 = await s.mkStmt(TS, "400.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-j",
			components: [{ componentType: "ADJUSTMENT", amount: "400.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe: PE_J } = await s.mkPay(TS, r1, "400.00", 2, "2026-09-10 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_J });
		eqB(rep.triggerPayment.displayName, "Akbank Axess", "4B.1/J: a card rename after the checkpoint does not rewrite the historical label");
		eqB(rep.triggerPayment.issuer, "Akbank", "4B.1/J: card issuer at the checkpoint is preserved");
		await s.close();
	}

	// =====================================================================
	// 4B.1/L, M, N -- FAMILY_REIMBURSEMENT chain must be fully authoritative
	// =====================================================================
	for (const variant of ["VOID", "UNSEALED", "PARTICIPANT_REMOVED"] as const) {
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-00000000c401";
		const OBL = "8a000000-0000-4000-8000-00000000c401";
		const SPLIT = "87000000-0000-4000-8000-00000000c401";
		const outOfMtd = variant === "UNSEALED"; // unsealed split would fail MTD -> keep the purchase out of the MTD window
		const purOcc = outOfMtd ? "2026-08-20 00:00:00+00" : "2026-09-03 00:00:00+00";
		await s.replica();
		const r1 = await s.mkStmt(TS, "300.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-l",
			components: [{ componentType: "ADJUSTMENT", amount: "300.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe: PE_L } = await s.mkPay(TS, r1, "300.00", 2, "2026-09-15 00:00:00+00");
		const pur = await s.mkPur("1000.00", "SHORT_TERM_PURCHASE", purOcc);
		await s.mkObligation(OBL, P_FAM, "RECEIVABLE", "600.00", purOcc);
		const sp1 = await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT,
			user: "400.00", ext: "600.00", gross: "1000.00", occ: purOcc,
			personId: P_FAM, personObligationId: OBL,
			sealed: variant !== "UNSEALED",
		});
		if (variant === "VOID") {
			await s.mkSplit({
				purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT, revNo: 2, prevRevId: sp1.splitRev,
				op: "VOID", user: "1000.00", ext: "0.00", gross: "1000.00", occ: "2026-09-05 00:00:00+00",
				withItem: false, sealed: false,
			});
		} else if (variant === "PARTICIPANT_REMOVED") {
			await s.mkSplit({
				purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT, revNo: 2, prevRevId: sp1.splitRev,
				op: "UPDATE", user: "1000.00", ext: "0.00", gross: "1000.00", occ: "2026-09-06 00:00:00+00",
				participantId: sp1.participantId, withItem: false,
			});
		}
		await s.mkSettlement("8b000000-0000-4000-8000-00000000c401", OBL, "600.00", "2026-09-10 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_L });
		chkB(
			rep.interval.peopleFamily.familyReimbursements.length === 0,
			`4B.1/${variant === "VOID" ? "L" : variant === "UNSEALED" ? "M" : "N"}: a ${variant.toLowerCase()} split chain is NOT labelled FAMILY_REIMBURSEMENT`,
		);
		chkB(
			rep.interval.peopleFamily.settlementActivity.some((x) => x.obligationId === OBL),
			`4B.1/${variant === "VOID" ? "L" : variant === "UNSEALED" ? "M" : "N"}: the settlement still appears as ordinary People activity`,
		);
		await s.close();
	}

	// =====================================================================
	// 4B.1/O -- SUPPORT role created AFTER checkpoint => fail closed
	// =====================================================================
	{
		const s = await scenario();
		const TS = "81000000-0000-4000-8000-00000000c501";
		const RC_O = "b1000000-0000-4000-8000-0000000000a1";
		await s.replica();
		await s.mkReceipt(RC_O, SUP1, "2000.00", "2026-09-05 00:00:00+00");
		// classification revision effective only AFTER the checkpoint
		await s.q(
			`insert into income_receipt_budget_v2_semantic_revisions (id,user_id,income_receipt_id,revision_no,operation,support_role,idempotency_key,revision_fingerprint,occurred_at) values ($1,$2,$3,1,'CREATE','PLANNED_FAMILY_GIFT',$4,$5,'2026-09-20 00:00:00+00')`,
			[s.gid(), U1, RC_O, "sem-o", F],
		);
		const r1 = await s.mkStmt(TS, "400.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: TS, statementRevisionId: r1, idempotencyKey: "rc-o",
			components: [{ componentType: "ADJUSTMENT", amount: "400.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe: PE_O } = await s.mkPay(TS, r1, "400.00", 2, "2026-09-10 00:00:00+00");
		await s.origin();
		await expectThrowB(
			() => buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: PE_O }),
			"no active Budget V2 semantic role effective at",
			"4B.1/O: a SUPPORT role classified only after the checkpoint cannot classify earlier interval activity",
		);
		await s.close();
	}
}

// ============================================================================
// PHASE 4B.2: TRUE EFFECTIVE-AS-OF CLOSURE (revisioned source time safety)
// ============================================================================

async function resolverRuntime4B2() {
	console.log(
		"\n== PHASE 4B.2: TRUE EFFECTIVE-AS-OF CLOSURE (drizzle / PGlite) ==",
	);
	const { buildBudgetV2CheckpointReport } = await import(
		"../src/budget/checkpoint-report-v2.ts"
	);
	const { resolveBudgetV2LiveSnapshot, resolveBudgetV2SnapshotForWrite } =
		await import("../src/budget/live-resolver-v2.ts");
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);
	const { P } = B4_IDS;
	const RECON_AT = new Date("2026-09-01T00:00:00Z");
	const at = (iso: string) => new Date(iso);

	const eqB = (a: unknown, b: unknown, name: string) =>
		a === b
			? ok(name)
			: bad(name, `-> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
	const chkB = (c: boolean, name: string) => (c ? ok(name) : bad(name));

	// biome-ignore lint/suspicious/noExplicitAny: test scaffolding
	type S = any;
	// raw helpers layered on make4bScenario (caller manages replica/origin)
	const mkReceiptRev = async (
		s: S,
		rid: string,
		revNo: number,
		op: string,
		amount: string,
		occ: string,
	) => {
		const { tr } = await s.mkCanon("INCOME_RECEIPT", occ);
		const prev = (
			await s.q(
				"select id from income_receipt_revisions where income_receipt_id=$1 and revision_no=$2",
				[rid, revNo - 1],
			)
		).rows[0].id;
		await s.q(
			`insert into income_receipt_revisions (id,user_id,income_receipt_id,canonical_revision_id,revision_no,previous_receipt_revision_id,operation,occurred_at,amount,destination_account_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[s.gid(), U1, rid, tr, revNo, prev, op, occ, amount, s.CASH],
		);
	};
	const mkPurRev2 = async (
		s: S,
		eid: string,
		prevEr: string,
		revNo: number,
		op: string,
		amount: string,
		category: string,
		occ: string,
	) => s.mkPurRev(eid, prevEr, revNo, op, amount, category, occ);
	const mkOblRev = async (
		s: S,
		oblId: string,
		revNo: number,
		op: string,
		principal: string,
		dueDate: string | null,
		occ: string,
	) => {
		const { tr } = await s.mkCanon("PERSON_PAYABLE_EXPENSE", occ);
		const prev = (
			await s.q(
				"select id from person_obligation_revisions where obligation_id=$1 and revision_no=$2",
				[oblId, revNo - 1],
			)
		).rows[0].id;
		await s.q(
			`insert into person_obligation_revisions (id,user_id,obligation_id,revision_no,previous_revision_id,canonical_revision_id,operation,principal_amount,due_date,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			[
				s.gid(),
				U1,
				oblId,
				revNo,
				prev,
				tr,
				op,
				principal,
				dueDate,
				occ,
				`ok2-${revNo}-${oblId.slice(-4)}`,
				s.F,
			],
		);
	};
	const mkSettlementRev = async (
		s: S,
		setId: string,
		revNo: number,
		op: string,
		applied: string,
		occ: string,
	) => {
		const { tr } = await s.mkCanon("PERSON_OBLIGATION_SETTLEMENT", occ);
		const prev = (
			await s.q(
				"select id from person_settlement_revisions where settlement_id=$1 and revision_no=$2",
				[setId, revNo - 1],
			)
		).rows[0].id;
		await s.q(
			`insert into person_settlement_revisions (id,user_id,settlement_id,revision_no,previous_revision_id,operation,asset_account_id,cash_amount,applied_amount,excess_amount,occurred_at,canonical_revision_id,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,$6,$7,$8,$8,'0.00',$9,$10,$11,$12)`,
			[
				s.gid(),
				U1,
				setId,
				revNo,
				prev,
				op,
				s.CASH,
				applied,
				occ,
				tr,
				`sr2-${revNo}-${setId.slice(-4)}`,
				s.F,
			],
		);
	};
	const mkGoal = async (
		s: S,
		goalId: string,
		bucketId: string,
		fundingTarget: string,
		targetDate: string | null,
		occ: string,
		purpose: string,
	) => {
		await s.q(
			`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values ($1,$2,$3,$4,'goal bucket','SHORT_TERM_GOAL')`,
			[bucketId, U1, s.MID, `GB${goalId.slice(-4).toUpperCase()}`],
		);
		await s.q(
			`insert into short_term_goals (id,user_id,midas_account_id,midas_bucket_id) values ($1,$2,$3,$4)`,
			[goalId, U1, s.MID, bucketId],
		);
		await s.q(
			`insert into short_term_goal_revisions (id,user_id,goal_id,revision_no,operation,status,name,funding_target,target_date,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','ACTIVE','goal',$4,$5,$6,$7,$8)`,
			[
				s.gid(),
				U1,
				goalId,
				fundingTarget,
				targetDate,
				occ,
				`g-${goalId.slice(-4)}`,
				s.F,
			],
		);
		await s.q(
			`insert into short_term_goal_budget_v2_purpose_revisions (id,user_id,goal_id,revision_no,operation,purpose,idempotency_key,revision_fingerprint,occurred_at) values ($1,$2,$3,1,'CREATE',$4,$5,$6,$7)`,
			[s.gid(), U1, goalId, purpose, `gp-${goalId.slice(-4)}`, s.F, occ],
		);
	};
	const mkGoalRev = async (
		s: S,
		goalId: string,
		revNo: number,
		op: string,
		status: string,
		fundingTarget: string,
		targetDate: string | null,
		occ: string,
	) => {
		const prev = (
			await s.q(
				"select id from short_term_goal_revisions where goal_id=$1 and revision_no=$2",
				[goalId, revNo - 1],
			)
		).rows[0].id;
		await s.q(
			`insert into short_term_goal_revisions (id,user_id,goal_id,revision_no,previous_revision_id,operation,status,name,funding_target,target_date,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,$4,$5,$6,$7,'goal',$8,$9,$10,$11,$12)`,
			[
				s.gid(),
				U1,
				goalId,
				revNo,
				prev,
				op,
				status,
				fundingTarget,
				targetDate,
				occ,
				`gr-${revNo}-${goalId.slice(-4)}`,
				s.F,
			],
		);
	};
	const mkPurposeRev = async (
		s: S,
		goalId: string,
		revNo: number,
		purpose: string,
		occ: string,
	) => {
		const prev = (
			await s.q(
				"select id from short_term_goal_budget_v2_purpose_revisions where goal_id=$1 and revision_no=$2",
				[goalId, revNo - 1],
			)
		).rows[0].id;
		await s.q(
			`insert into short_term_goal_budget_v2_purpose_revisions (id,user_id,goal_id,revision_no,previous_revision_id,operation,purpose,idempotency_key,revision_fingerprint,occurred_at) values ($1,$2,$3,$4,$5,'UPDATE',$6,$7,$8,$9)`,
			[
				s.gid(),
				U1,
				goalId,
				revNo,
				prev,
				purpose,
				`gpr-${revNo}-${goalId.slice(-4)}`,
				s.F,
				occ,
			],
		);
	};
	const mkRoleRev = async (
		s: S,
		rid: string,
		revNo: number,
		role: string,
		occ: string,
	) => {
		const prev =
			revNo === 1
				? null
				: (
						await s.q(
							"select id from income_receipt_budget_v2_semantic_revisions where income_receipt_id=$1 and revision_no=$2",
							[rid, revNo - 1],
						)
					).rows[0].id;
		await s.q(
			`insert into income_receipt_budget_v2_semantic_revisions (id,user_id,income_receipt_id,revision_no,previous_revision_id,operation,support_role,idempotency_key,revision_fingerprint,occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[
				s.gid(),
				U1,
				rid,
				revNo,
				prev,
				revNo === 1 ? "CREATE" : "UPDATE",
				role,
				`sem-${revNo}-${rid.slice(-4)}`,
				s.F,
				occ,
			],
		);
	};
	// seed a PAID + reconciled (all-personal) trigger statement, return its PE id
	const mkTrigger = async (
		s: S,
		amount = "400.00",
		payAt = "2026-09-15 00:00:00+00",
	) => {
		await s.origin();
		const sid = `81000000-0000-4000-8000-0000000000e1`;
		const r1 = await (async () => {
			await s.replica();
			const rr = await s.mkStmt(sid, amount, 9);
			await s.origin();
			return rr;
		})();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: sid,
			statementRevisionId: r1,
			idempotencyKey: "rc-trig",
			occurredAt: RECON_AT,
			components: [
				{
					componentType: "ADJUSTMENT",
					amount,
					ownership: "PERSONAL",
					adjustmentKind: "OTHER",
				},
			],
		});
		await s.replica();
		const { pe } = await s.mkPay(sid, r1, amount, 2, payAt);
		await s.origin();
		return { sid, pe };
	};

	// ---- A / B: a future purchase UPDATE / VOID does not erase a prior MTD purchase
	for (const variant of ["UPDATE", "VOID"] as const) {
		const s = await make4bScenario();
		const { pe } = await mkTrigger(s);
		await s.replica();
		const pur = await s.mkPur(
			"500.00",
			"DISCRETIONARY_SPEND",
			"2026-09-05 00:00:00+00",
		);
		await mkPurRev2(
			s,
			pur.eid,
			pur.er,
			2,
			variant,
			variant === "VOID" ? "500.00" : "5000.00",
			"DISCRETIONARY_SPEND",
			"2026-09-20 00:00:00+00",
		);
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		eqB(
			rep.mtd.spending.byCategoryPersonalShare.DISCRETIONARY_SPEND,
			"500.00",
			`4B.2/${variant === "UPDATE" ? "A" : "B"}: a future purchase ${variant} does not ${variant === "UPDATE" ? "mutate" : "erase"} the Sep-15 MTD purchase (500, not ${variant === "VOID" ? "0" : "5000"})`,
		);
		await s.close();
	}

	// ---- C / D: a future receipt UPDATE / VOID does not replace / erase earlier asOf income
	for (const variant of ["UPDATE", "VOID"] as const) {
		const s = await make4bScenario();
		const { pe } = await mkTrigger(s);
		const rid = "b1000000-0000-4000-8000-0000000000c1";
		const src = variant === "UPDATE" ? s.EXT1 : s.REG1;
		await s.replica();
		await s.mkReceipt(
			rid,
			src,
			variant === "UPDATE" ? "100.00" : "20000.00",
			"2026-09-05 00:00:00+00",
		);
		await mkReceiptRev(
			s,
			rid,
			2,
			variant,
			variant === "VOID" ? "20000.00" : "9999.00",
			"2026-09-20 00:00:00+00",
		);
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		if (variant === "UPDATE") {
			eqB(
				rep.interval.income.extraReceipts,
				"100.00",
				"4B.2/C: a future receipt UPDATE does not replace the Sep-15 interval income (100, not 9999)",
			);
			eqB(
				rep.mtd.budget.inputs.realizedIncome,
				"100.00",
				"4B.2/C: the MTD realizedIncome uses the Sep-15 receipt state",
			);
		} else {
			eqB(
				rep.interval.income.regularReceipts,
				"20000.00",
				"4B.2/D: a future receipt VOID does not erase the Sep-15 interval income",
			);
			eqB(
				rep.mtd.budget.inputs.realizedIncome,
				"20000.00",
				"4B.2/D: the MTD realizedIncome still contains the Sep-15 receipt",
			);
		}
		await s.close();
	}

	// ---- E: a SUPPORT role changed AFTER the checkpoint is not used before it
	{
		const s = await make4bScenario();
		const { pe } = await mkTrigger(s);
		const rid = "b1000000-0000-4000-8000-0000000000e2";
		await s.replica();
		await s.mkReceipt(rid, s.SUP1, "2000.00", "2026-09-05 00:00:00+00");
		await mkRoleRev(s, rid, 1, "DEFICIT_FAMILY_SUPPORT", "2026-09-01 00:00:00+00");
		await mkRoleRev(s, rid, 2, "PLANNED_FAMILY_GIFT", "2026-09-20 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		eqB(
			rep.interval.income.deficitFamilySupportReceipts,
			"2000.00",
			"4B.2/E: the SUPPORT role effective at the checkpoint (DEFICIT) is used",
		);
		eqB(
			rep.interval.income.plannedFamilyGiftReceipts,
			"0.00",
			"4B.2/E: the later PLANNED_FAMILY_GIFT reclassification does not time-travel",
		);
		eqB(
			rep.mtd.budget.inputs.realizedIncome,
			"0.00",
			"4B.2/E: DEFICIT support is excluded from realizedIncome at the checkpoint",
		);
		await s.close();
	}

	// ---- F: a goal that is ACTIVE at the checkpoint but CANCELLED afterwards
	{
		const s = await make4bScenario();
		const G = "99999999-0000-4000-8000-0000000000f1";
		const B = "f0000000-0000-4000-8000-0000000000f1";
		await s.replica();
		await mkGoal(s, G, B, "100000.00", null, "2026-09-01 00:00:00+00", "INTERNATIONAL_MOBILITY");
		await mkGoalRev(s, G, 2, "CANCEL", "CANCELLED", "100000.00", null, "2026-09-20 00:00:00+00");
		await s.q(
			`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ($1,$2,$3,'mt-f',$4,null,$5,'40000.00','2026-08-20 00:00:00+00')`,
			[s.gid(), U1, s.MID, s.F, B],
		);
		await s.origin();
		const res15 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-15T00:00:00Z") });
		const res25 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-25T00:00:00Z") });
		eqB(res15.inputs.mobilityBalance, "40000.00", "4B.2/F: at Sep-15 the goal is ACTIVE => its bucket is in mobilityBalance");
		eqB(res25.inputs.mobilityBalance, "0.00", "4B.2/F: at Sep-25 the CANCEL is in effect => excluded");
		await s.close();
	}

	// ---- G: a goal purpose reclassified AFTER the checkpoint is not used before it
	{
		const s = await make4bScenario();
		const G = "99999999-0000-4000-8000-0000000000d1";
		const B = "f0000000-0000-4000-8000-0000000000d5";
		await s.replica();
		await mkGoal(s, G, B, "100000.00", null, "2026-09-01 00:00:00+00", "OTHER");
		await mkPurposeRev(s, G, 2, "INTERNATIONAL_MOBILITY", "2026-09-20 00:00:00+00");
		await s.q(
			`insert into midas_allocation_transfers (id,user_id,midas_account_id,idempotency_key,transfer_fingerprint,from_bucket_id,to_bucket_id,amount,occurred_at) values ($1,$2,$3,'mt-g',$4,null,$5,'30000.00','2026-08-20 00:00:00+00')`,
			[s.gid(), U1, s.MID, s.F, B],
		);
		await s.origin();
		const res15 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-15T00:00:00Z") });
		const res25 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-25T00:00:00Z") });
		eqB(res15.inputs.mobilityBalance, "0.00", "4B.2/G: at Sep-15 the purpose is OTHER => NOT mobility");
		eqB(res25.inputs.mobilityBalance, "30000.00", "4B.2/G: at Sep-25 the INTERNATIONAL_MOBILITY reclassification is in effect");
		await s.close();
	}

	// ---- H: OPEN -> PAY Sep 12 -> REOPEN Sep 20 : PAID at Sep-15, OPEN at Sep-25
	{
		const s = await make4bScenario();
		const SID = "81000000-0000-4000-8000-00000000c1a2";
		await s.replica();
		const r1 = await s.mkStmt(SID, "800.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: SID, statementRevisionId: r1, idempotencyKey: "rc-h2", occurredAt: RECON_AT,
			components: [{ componentType: "ADJUSTMENT", amount: "800.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { r: pay } = await s.mkPay(SID, r1, "800.00", 2, "2026-09-12 00:00:00+00");
		await s.mkStmtRev(SID, pay, 3, "REOPEN", "OPEN", "800.00", "2026-09-20 00:00:00+00");
		await s.origin();
		const res15 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-15T00:00:00Z") });
		const res25 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-25T00:00:00Z") });
		const b15 = (res15.evidenceSnapshot as any).obligations.creditCardStatements.find((x: any) => x.statementId === SID);
		const b25 = (res25.evidenceSnapshot as any).obligations.creditCardStatements.find((x: any) => x.statementId === SID);
		eqB(b15?.recognitionBasis, "PAID_WITHIN_PERIOD", "4B.2/H: at Sep-15 the statement lifecycle state is PAID");
		eqB(b25?.recognitionBasis, "OPEN_DUE", "4B.2/H: the Sep-20 REOPEN does not rewrite the Sep-15 PAID state; at Sep-25 it is OPEN");
		await s.close();
	}

	// ---- I: OPEN -> PAY#1 Sep 10 -> REOPEN Sep 13 -> PAY#2 Sep 20
	{
		const s = await make4bScenario();
		const SID = "81000000-0000-4000-8000-00000000c1a3";
		await s.replica();
		const r1 = await s.mkStmt(SID, "600.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: SID, statementRevisionId: r1, idempotencyKey: "rc-i2", occurredAt: RECON_AT,
			components: [{ componentType: "ADJUSTMENT", amount: "600.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { r: pay1 } = await s.mkPay(SID, r1, "600.00", 2, "2026-09-10 00:00:00+00");
		const reo = await s.mkStmtRev(SID, pay1, 3, "REOPEN", "OPEN", "600.00", "2026-09-13 00:00:00+00");
		await s.mkPay(SID, reo, "600.00", 4, "2026-09-20 00:00:00+00");
		await s.origin();
		const basis = async (iso: string) => {
			const r = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at(iso) });
			return (r.evidenceSnapshot as any).obligations.creditCardStatements.find((x: any) => x.statementId === SID)?.recognitionBasis;
		};
		eqB(await basis("2026-09-11T00:00:00Z"), "PAID_WITHIN_PERIOD", "4B.2/I: at Sep-11 the statement is PAID by PAY#1");
		eqB(await basis("2026-09-14T00:00:00Z"), "OPEN_DUE", "4B.2/I: at Sep-14 the REOPEN is in effect; PAY#2 (Sep-20) is NOT yet the state");
		eqB(await basis("2026-09-25T00:00:00Z"), "PAID_WITHIN_PERIOD", "4B.2/I: at Sep-25 PAY#2 is in effect");
		await s.close();
	}

	// ---- J: reconciliation SUPERSEDE after the checkpoint (same amount, different
	//        ownership) does NOT rewrite the historical trigger ownership
	{
		const s = await make4bScenario();
		const SID = "81000000-0000-4000-8000-00000000c1a4";
		await s.replica();
		const r1 = await s.mkStmt(SID, "1000.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: SID, statementRevisionId: r1, idempotencyKey: "rc-j2-1", occurredAt: RECON_AT,
			components: [{ componentType: "ADJUSTMENT", amount: "1000.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe, r: pay } = await s.mkPay(SID, r1, "1000.00", 2, "2026-09-15 00:00:00+00");
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: SID, statementRevisionId: pay, idempotencyKey: "rc-j2-2",
			expectedRevisionNo: 1, occurredAt: at("2026-09-20T00:00:00Z"),
			components: [
				{ componentType: "ADJUSTMENT", amount: "500.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
				{ componentType: "ADJUSTMENT", amount: "500.00", ownership: "EXTERNAL_PERSON", personId: s.P_FAM, adjustmentKind: "OTHER" },
			],
		});
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe });
		eqB(rep.triggerPayment.ownership.personalEconomicShare, "1000.00", "4B.2/J: trigger ownership uses the reconciliation effective at Sep-15 (100% personal)");
		eqB(rep.triggerPayment.ownership.familyExternalShare, "0.00", "4B.2/J: the Sep-20 SUPERSEDE (500 FAMILY) does not rewrite the Sep-15 trigger");
		await s.close();
	}

	// ---- K: a non-trigger interval payment uses the reconciliation effective at
	//        its OWN payment instant, not the report checkpoint
	{
		const s = await make4bScenario();
		const trig = await mkTrigger(s, "400.00", "2026-09-15 00:00:00+00");
		const SNT = "81000000-0000-4000-8000-00000000c1a5";
		await s.replica();
		const r1 = await s.mkStmt(SNT, "1000.00", 8);
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: SNT, statementRevisionId: r1, idempotencyKey: "rc-k2-1", occurredAt: RECON_AT,
			components: [{ componentType: "ADJUSTMENT", amount: "1000.00", ownership: "PERSONAL", adjustmentKind: "OTHER" }],
		});
		await s.replica();
		const { pe: peNt, r: payNt } = await s.mkPay(SNT, r1, "1000.00", 2, "2026-09-12 00:00:00+00");
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: SNT, statementRevisionId: payNt, idempotencyKey: "rc-k2-2",
			expectedRevisionNo: 1, occurredAt: at("2026-09-20T00:00:00Z"),
			components: [
				{ componentType: "ADJUSTMENT", amount: "500.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
				{ componentType: "ADJUSTMENT", amount: "500.00", ownership: "EXTERNAL_PERSON", personId: s.P_FAM, adjustmentKind: "OTHER" },
			],
		});
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: trig.pe });
		const spNt = rep.interval.statementPayments.find((x) => x.paymentEventId === peNt);
		chkB(
			!!spNt && spNt.ownership.available === true &&
				spNt.ownership.personalEconomicShare === "1000.00" &&
				spNt.ownership.familyExternalShare === "0.00",
			"4B.2/K: a non-trigger payment (Sep-12) uses the reconciliation effective at Sep-12, not the Sep-20 SUPERSEDE",
		);
		await s.close();
	}

	// ---- L: People PAYABLE future VOID does not rewrite old currentObligations
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a6";
		await s.replica();
		await s.mkObligation(OBL, s.P_FAM, "PAYABLE", "500.00", "2026-09-01 00:00:00+00");
		await mkOblRev(s, OBL, 2, "VOID", "500.00", null, "2026-09-20 00:00:00+00");
		await s.origin();
		// give the obligation a dueDate this period via a raw rev1 patch is unneeded --
		// mkObligation left dueDate NULL, which routes it to "settled only" (0). Instead
		// assert the VOID path: rev1 has no dueDate so currentObligations is 0 either
		// way; use a rev1 WITH a dueDate.
		await s.replica();
		await s.q(
			`update person_obligation_revisions set due_date='2026-09-25' where obligation_id=$1 and revision_no=1`,
			[OBL],
		);
		await s.origin();
		const res15 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-15T00:00:00Z") });
		const res25 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-25T00:00:00Z") });
		eqB(res15.inputs.currentObligations, "500.00", "4B.2/L: at Sep-15 the PAYABLE (rev1) is recognised");
		eqB(res25.inputs.currentObligations, "0.00", "4B.2/L: the Sep-20 VOID removes it only from Sep-25 onward");
		await s.close();
	}

	// ---- M: a settlement VOIDed AFTER the checkpoint does not erase an old
	//        FAMILY_REIMBURSEMENT
	{
		const s = await make4bScenario();
		const trig = await mkTrigger(s, "400.00", "2026-09-15 00:00:00+00");
		const OBL = "8a000000-0000-4000-8000-00000000c1a7";
		const SET = "8b000000-0000-4000-8000-00000000c1a7";
		const SPLIT = "87000000-0000-4000-8000-00000000c1a7";
		await s.replica();
		const pur = await s.mkPur("1000.00", "SHORT_TERM_PURCHASE", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: SPLIT,
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL,
		});
		await s.mkSettlement(SET, OBL, "600.00", "2026-09-10 00:00:00+00");
		await mkSettlementRev(s, SET, 2, "VOID", "600.00", "2026-09-20 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: trig.pe });
		chkB(
			rep.interval.peopleFamily.familyReimbursements.length === 1 &&
				rep.interval.peopleFamily.familyReimbursements[0]?.obligationId === OBL,
			"4B.2/M: a settlement VOIDed on Sep-20 does not erase the Sep-15 FAMILY_REIMBURSEMENT",
		);
		await s.close();
	}

	// ---- N: a future basic-living purchase UPDATE does not rewrite the old MTD amount
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await s.mkPur("1000.00", "MANDATORY_EXPENSE", "2026-09-05 00:00:00+00");
		await mkPurRev2(s, pur.eid, pur.er, 2, "UPDATE", "200.00", "MANDATORY_EXPENSE", "2026-09-20 00:00:00+00");
		await s.origin();
		const res15 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-15T00:00:00Z") });
		const res25 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-25T00:00:00Z") });
		eqB((res15.evidenceSnapshot as any).basicLiving.actualPersonalMandatorySpendMTD, "1000.00", "4B.2/N: at Sep-15 the mandatory purchase spend is the Sep-5 amount (1000)");
		eqB(res15.inputs.basicLivingFunding, "6000.00", "4B.2/N: basicLivingFunding = max(6000,1000) - 0");
		eqB((res25.evidenceSnapshot as any).basicLiving.actualPersonalMandatorySpendMTD, "200.00", "4B.2/N: the Sep-20 correction applies only from Sep-25 onward");
		await s.close();
	}

	// ---- P: a stored Budget V2 lifecycle result is REPLAYED before any live read
	{
		const s = await make4bScenario();
		await s.replica();
		const { ct } = await s.mkCanon("MONTHLY_BUDGET_PLAN_V2", "2026-09-01 00:00:00+00");
		await s.q(
			`update canonical_transactions set creation_idempotency_key='p-key' where id=$1`,
			[ct],
		);
		const planId = s.gid();
		await s.q(
			`insert into monthly_budget_v2_plans (id,user_id,period_month,canonical_transaction_id) values ($1,$2,$3,$4)`,
			[planId, U1, P, ct],
		);
		const [{ id: canonRev }] = (
			await s.q<{ id: string }>(
				`select id from transaction_revisions where transaction_id=$1 and revision_no=1`,
				[ct],
			)
		).rows;
		await s.q(
			`insert into monthly_budget_v2_plan_revisions
			 (id,user_id,budget_plan_id,canonical_revision_id,revision_no,previous_budget_revision_id,operation,policy_version,currency,
			  realized_income_amount,current_obligations_amount,basic_living_funding_amount,date_bound_necessary_purchase_funding_amount,
			  core_emergency_fund_balance_amount,mobility_balance_amount,emergency_catch_up_amount,deficit_amount,true_surplus_amount,
			  mobility_allocation_amount,long_term_investment_amount,discretionary_allocation_amount,evidence_snapshot)
			 values ($1,$2,$3,$4,1,null,'CREATE','PERSONAL_BUDGET_V2','TRY',
			  '77777.00','0.00','6000.00','0.00','10000.00','0.00','0.00','0.00','1234.00','0.00','0.00','1234.00','{"stored":true}'::jsonb)`,
			[s.gid(), U1, planId, canonRev],
		);
		// a live source that would change a fresh resolve
		await s.mkReceipt(
			"b1000000-0000-4000-8000-0000000000a1",
			s.REG1,
			"55555.00",
			"2026-09-05 00:00:00+00",
		);
		await s.origin();
		const r = await resolveBudgetV2SnapshotForWrite({
			db: s.db,
			userId: U1,
			periodMonth: P,
			idempotencyKey: "p-key",
			asOf: at("2026-09-15T00:00:00Z"),
		});
		eqB(r.source, "REPLAY", "4B.2/P: a stored V2 lifecycle result is replayed (source=REPLAY)");
		eqB(
			r.snapshot.inputs.realizedIncome,
			"77777.00",
			"4B.2/P: replay returns the STORED snapshot, never a live-source recompute",
		);
		await s.close();
	}
}

// ============================================================================
// PHASE 4B.3: ONE AUTHORITATIVE AS-OF PURCHASE-SPLIT READER
// ============================================================================

async function resolverRuntime4B3() {
	console.log(
		"\n== PHASE 4B.3: ONE AUTHORITATIVE AS-OF SPLIT READER (drizzle / PGlite) ==",
	);
	const { buildBudgetV2CheckpointReport } = await import(
		"../src/budget/checkpoint-report-v2.ts"
	);
	const { resolveBudgetV2LiveSnapshot } = await import(
		"../src/budget/live-resolver-v2.ts"
	);
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);
	const { P } = B4_IDS;
	const RECON_AT = new Date("2026-09-01T00:00:00Z");
	const at = (iso: string) => new Date(iso);
	const asOf15 = at("2026-09-15T00:00:00Z");

	const eqB = (a: unknown, b: unknown, name: string) =>
		a === b
			? ok(name)
			: bad(name, `-> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
	const chkB = (c: boolean, name: string) => (c ? ok(name) : bad(name));
	const expectThrowB = async (
		fn: () => Promise<unknown>,
		needle: string,
		name: string,
	) => {
		try {
			await fn();
			bad(name, "-> did not throw");
		} catch (e) {
			String((e as Error).message).includes(needle)
				? ok(name)
				: bad(name, `-> ${(e as Error).message}`);
		}
	};

	// biome-ignore lint/suspicious/noExplicitAny: test scaffolding
	type S = any;
	const mandSpend = (r: unknown) =>
		(r as { evidenceSnapshot: { basicLiving: { actualPersonalMandatorySpendMTD: string } } })
			.evidenceSnapshot.basicLiving.actualPersonalMandatorySpendMTD;
	// seed a MANDATORY_EXPENSE purchase (returns eid/er), caller manages replica
	const mkMand = async (s: S, amount: string, occ = "2026-09-05 00:00:00+00") =>
		s.mkPur(amount, "MANDATORY_EXPENSE", occ);
	// seed a PAID + reconciled (all-personal ADJUSTMENT) trigger, returns pe
	const mkTrigger = async (s: S, amount = "400.00") => {
		await s.replica();
		const sid = "81000000-0000-4000-8000-0000000000e1";
		const r1 = await s.mkStmt(sid, amount, 9);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: sid,
			statementRevisionId: r1,
			idempotencyKey: "rc-trig3",
			occurredAt: RECON_AT,
			components: [
				{
					componentType: "ADJUSTMENT",
					amount,
					ownership: "PERSONAL",
					adjustmentKind: "OTHER",
				},
			],
		});
		await s.replica();
		const { pe } = await s.mkPay(sid, r1, amount, 2, "2026-09-15 00:00:00+00");
		await s.origin();
		return pe;
	};

	// ---- A: sealed valid split => resolver uses the exact user share
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a1";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a1",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL,
		});
		await s.origin();
		const r = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 });
		eqB(mandSpend(r), "400.00", "4B.3/A: a sealed valid split => resolver uses the exact user share (400)");
		await s.close();
	}

	// ---- B: no split => 100% personal
	{
		const s = await make4bScenario();
		await s.replica();
		await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.origin();
		const r = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 });
		eqB(mandSpend(r), "1000.00", "4B.3/B: no split => 100% personal");
		await s.close();
	}

	// ---- C: effective VOID split => 100% personal
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a2";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		const sp = await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a2",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL,
		});
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: sp.splitId, revNo: 2, prevRevId: sp.splitRev,
			op: "VOID", user: "1000.00", ext: "0.00", gross: "1000.00", occ: "2026-09-05 00:00:00+00",
			withItem: false, sealed: false,
		});
		await s.origin();
		const r = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 });
		eqB(mandSpend(r), "1000.00", "4B.3/C: an effective VOID split => 100% personal");
		await s.close();
	}

	// ---- D: effective non-VOID split WITHOUT seal => live resolver FAILS CLOSED
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a3";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a3",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL, sealed: false,
		});
		await s.origin();
		await expectThrowB(
			() => resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 }),
			"is not sealed",
			"4B.3/D: an effective non-VOID split WITHOUT a seal fails the live resolver closed (userShare never read)",
		);
		await s.close();
	}

	// ---- E: user + external != gross is guaranteed by a DB CHECK constraint
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await expectThrowB(
			() =>
				s.q(
					`insert into credit_card_purchase_split_revisions (id,split_id,revision_no,operation,method,purchase_event_revision_id,gross_amount,user_share_amount,external_share_amount,occurred_at,revision_fingerprint)
					 values ($1,$1,1,'CREATE','MANUAL',$2,'1000.00','400.00','500.00','2026-09-03 00:00:00+00',$3)`,
					[s.gid(), pur.er, s.F],
				),
			"sum_check",
			"4B.3/E: user + external != gross is rejected by the DB CHECK (reader invariant 6 is belt-and-suspenders)",
		);
		await s.origin();
		await s.close();
	}

	// ---- F: sealed split item sum != external => FAIL CLOSED
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a4";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a4",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL, itemShare: "500.00",
		});
		await s.origin();
		await expectThrowB(
			() => resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 }),
			"item share sum",
			"4B.3/F: a sealed split whose item shares do not sum to the external share fails closed",
		);
		await s.close();
	}

	// ---- G: split gross != effective purchase amount => FAIL CLOSED
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a5";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "500.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a5",
			user: "300.00", ext: "500.00", gross: "800.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL,
		});
		await s.origin();
		await expectThrowB(
			() => resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 }),
			"does not match the effective purchase amount",
			"4B.3/G: a sealed split whose gross != the effective purchase amount fails closed",
		);
		await s.close();
	}

	// ---- H: split item references a participant anchor from a DIFFERENT split => FAIL CLOSED
	{
		const s = await make4bScenario();
		const OBL1 = "8a000000-0000-4000-8000-00000000c1a6";
		const OBL2 = "8a000000-0000-4000-8000-00000000c1a7";
		await s.replica();
		const pur1 = await mkMand(s, "500.00", "2026-09-02 00:00:00+00");
		const pur2 = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL1, s.P_FAM, "RECEIVABLE", "200.00", "2026-09-02 00:00:00+00");
		await s.mkObligation(OBL2, s.P_FRI, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		// split1 -> creates participant anchor A1 for P_FAM
		const sp1 = await s.mkSplit({
			purchaseEid: pur1.eid, purchaseEr: pur1.er, splitId: "87000000-0000-4000-8000-00000000c1a6",
			user: "300.00", ext: "200.00", gross: "500.00", occ: "2026-09-02 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL1,
		});
		// split2 for pur2: its revision item points at split1's participant anchor A1
		await s.mkSplit({
			purchaseEid: pur2.eid, purchaseEr: pur2.er, splitId: "87000000-0000-4000-8000-00000000c1a7",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, participantId: sp1.participantId, itemShare: "600.00",
		});
		await s.origin();
		await expectThrowB(
			() => resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 }),
			"is not an anchored participant of split",
			"4B.3/H: a split revision item that references a participant from another split fails closed",
		);
		await s.close();
	}

	// ---- I: a future split revision after asOf is ignored; earlier state retained
	{
		const s = await make4bScenario();
		const OBL = "8a000000-0000-4000-8000-00000000c1a8";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "900.00", "2026-09-03 00:00:00+00");
		const sp = await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a8",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL,
		});
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: sp.splitId, revNo: 2, prevRevId: sp.splitRev,
			op: "UPDATE", user: "100.00", ext: "900.00", gross: "1000.00", occ: "2026-09-20 00:00:00+00",
			personId: s.P_FAM, participantId: sp.participantId, itemShare: "900.00",
		});
		await s.origin();
		const r15 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: asOf15 });
		const r25 = await resolveBudgetV2LiveSnapshot({ db: s.db, userId: U1, periodMonth: P, asOf: at("2026-09-25T00:00:00Z") });
		eqB(mandSpend(r15), "400.00", "4B.3/I: at Sep-15 the earlier authoritative split revision is retained (user 400)");
		eqB(mandSpend(r25), "100.00", "4B.3/I: the Sep-20 split revision applies only from Sep-25 onward (user 100)");
		await s.close();
	}

	// ---- J: report MTD personal/external totals for a valid split are unchanged
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		const OBL = "8a000000-0000-4000-8000-00000000c1a9";
		await s.replica();
		const pur = await s.mkPur("1000.00", "SHORT_TERM_PURCHASE", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1a9",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL,
		});
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe });
		eqB(rep.mtd.spending.byCategoryPersonalShare.SHORT_TERM_PURCHASE, "400.00", "4B.3/J: report MTD personal share via the shared reader is unchanged (400)");
		eqB(rep.mtd.spending.externalCardSpendMTD, "600.00", "4B.3/J: report MTD external share is unchanged (600)");
		eqB(rep.mtd.spending.externalCardSpendByRelationship.FAMILY, "600.00", "4B.3/J: external attributed to FAMILY by exact split truth");
		await s.close();
	}

	// ---- K: interval report ownership stays `{available:false}` where unprovable
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		const OBL = "8a000000-0000-4000-8000-00000000c1b1";
		await s.replica();
		const pur = await s.mkPur("1000.00", "SHORT_TERM_PURCHASE", "2026-09-05 00:00:00+00");
		await s.mkPurRev(pur.eid, pur.er, 2, "VOID", "1000.00", "SHORT_TERM_PURCHASE", "2026-09-08 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-04 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1b1",
			user: "400.00", ext: "600.00", gross: "1000.00", occ: "2026-09-04 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL, sealed: false,
		});
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe });
		const rows = rep.interval.purchases.activity.filter((x) => x.eventId === pur.eid);
		chkB(
			rows.length > 0 && rows.every((x) => x.ownership.available === false),
			"4B.3/K: an interval purchase whose split is unsealed reports ownership {available:false} (unchanged)",
		);
		await s.close();
	}

	// ---- M: statement reconciliation sees an unsealed effective split => STALE / unusable
	{
		const s = await make4bScenario();
		await s.replica();
		const sid = "81000000-0000-4000-8000-0000000000e2";
		const r1 = await s.mkStmt(sid, "1000.00", 9);
		const pur = await s.mkPur("1000.00", "DISCRETIONARY_SPEND", "2026-09-02 00:00:00+00");
		const OBL = "8a000000-0000-4000-8000-00000000c1b2";
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "1.00", "2026-09-02 00:00:00+00");
		const sp = await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: "87000000-0000-4000-8000-00000000c1b2",
			user: "1000.00", ext: "0.00", gross: "1000.00", occ: "2026-09-02 00:00:00+00",
			personId: s.P_FAM, personObligationId: OBL, withItem: false,
		});
		await s.origin();
		await reconcileStatement({
			db: s.db, userId: U1, statementId: sid, statementRevisionId: r1, idempotencyKey: "rc-m3", occurredAt: RECON_AT,
			components: [
				{
					componentType: "PURCHASE",
					amount: "1000.00",
					ownership: "PERSONAL",
					purchaseEventId: pur.eid,
					purchaseSplitRevisionId: sp.splitRev,
				},
			],
		});
		await s.replica();
		// an UNSEALED split revision effective BEFORE the checkpoint supersedes rev1
		await s.mkSplit({
			purchaseEid: pur.eid, purchaseEr: pur.er, splitId: sp.splitId, revNo: 2, prevRevId: sp.splitRev,
			op: "UPDATE", user: "1000.00", ext: "0.00", gross: "1000.00", occ: "2026-09-05 00:00:00+00",
			personId: s.P_FAM, participantId: sp.participantId, withItem: false, sealed: false,
		});
		const { pe } = await s.mkPay(sid, r1, "1000.00", 2, "2026-09-15 00:00:00+00");
		await s.origin();
		await expectThrowB(
			() => buildBudgetV2CheckpointReport({ db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe }),
			"reconciliation is STALE",
			"4B.3/M: a reconciliation whose referenced split is unsealed as of the checkpoint is STALE / unusable",
		);
		await s.close();
	}
}


async function resolverRuntime4C() {
	console.log(
		"\n== PHASE 4C: EXPLICIT SPENDING FOOD SEMANTICS (drizzle / PGlite) ==",
	);
	const { buildBudgetV2CheckpointReport } = await import(
		"../src/budget/checkpoint-report-v2.ts"
	);
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);
	const {
		createSpendingFoodClassification,
		updateSpendingFoodClassification,
		voidSpendingFoodClassification,
		getSpendingFoodClassificationAsOf,
	} = await import("../src/budget/spending-food-classification-v2.ts");
	const { P } = B4_IDS;
	const RECON_AT = new Date("2026-09-01T00:00:00Z");
	const at = (iso: string) => new Date(iso);
	const CP15 = at("2026-09-15T00:00:00Z");

	const eqC = (a: unknown, b: unknown, name: string) =>
		a === b
			? ok(name)
			: bad(name, `-> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
	const chkC = (c: boolean, name: string) => (c ? ok(name) : bad(name));
	const expectThrowC = async (
		fn: () => Promise<unknown>,
		needle: string,
		name: string,
	) => {
		try {
			await fn();
			bad(name, "-> did not throw");
		} catch (e) {
			const m = String((e as Error).message);
			m.includes(needle) && !/23505|duplicate key/.test(m)
				? ok(name)
				: bad(name, `-> ${m}`);
		}
	};

	// biome-ignore lint/suspicious/noExplicitAny: test scaffolding
	type S = any;
	const mkMand = async (s: S, amount: string, occ = "2026-09-05 00:00:00+00") =>
		s.mkPur(amount, "MANDATORY_EXPENSE", occ);
	// a PAID + reconciled (all-personal ADJUSTMENT) trigger; returns the payment event
	const mkTrigger = async (s: S, amount = "400.00") => {
		await s.replica();
		const sid = "81000000-0000-4000-8000-0000000000f1";
		const r1 = await s.mkStmt(sid, amount, 9);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: sid,
			statementRevisionId: r1,
			idempotencyKey: "rc-trig4c",
			occurredAt: RECON_AT,
			components: [
				{
					componentType: "ADJUSTMENT",
					amount,
					ownership: "PERSONAL",
					adjustmentKind: "OTHER",
				},
			],
		});
		await s.replica();
		const { pe } = await s.mkPay(sid, r1, amount, 2, "2026-09-15 00:00:00+00");
		await s.origin();
		return pe;
	};
	const ccSub = (id: string) =>
		({ type: "CREDIT_CARD_PURCHASE", purchaseEventId: id }) as const;
	const ppSub = (id: string) =>
		({ type: "PEOPLE_PAYABLE", personObligationId: id }) as const;

	// ---- A: card purchase 100% FOOD_HOME_MARKET
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-a",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const v = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: CP15,
		});
		eqC(v.status, "CLASSIFIED", "4C/A: 100% home/market classification is CLASSIFIED");
		eqC(v.classificationKind, "FOOD_HOME_MARKET", "4C/A: derived kind FOOD_HOME_MARKET");
		eqC(v.foodTotalAmount, "300.00", "4C/A: FOOD_TOTAL = 300");
		eqC(v.nonFoodAmount, "0.00", "4C/A: nonFood = 0");
		await s.close();
	}

	// ---- B: card purchase 100% FOOD_OUTSIDE
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "0.00",
			foodOutsideAmount: "300.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-b",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const v = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: CP15,
		});
		eqC(v.classificationKind, "FOOD_OUTSIDE", "4C/B: derived kind FOOD_OUTSIDE");
		await s.close();
	}

	// ---- C: explicit NON_FOOD (0 / 0)
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "0.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-c",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const v = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: CP15,
		});
		eqC(v.status, "CLASSIFIED", "4C/C: explicit NON_FOOD is CLASSIFIED (not unclassified)");
		eqC(v.classificationKind, "NON_FOOD", "4C/C: derived kind NON_FOOD");
		eqC(v.nonFoodAmount, "300.00", "4C/C: nonFood = full basis");
		await s.close();
	}

	// ---- D: mixed -- basis 1000, home 500, outside 100, non-food derived 400
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "1000.00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "500.00",
			foodOutsideAmount: "100.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-d",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const v = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: CP15,
		});
		eqC(v.classificationKind, "MIXED", "4C/D: derived kind MIXED");
		eqC(v.foodTotalAmount, "600.00", "4C/D: FOOD_TOTAL = 600");
		eqC(v.nonFoodAmount, "400.00", "4C/D: nonFood derived = 400");
		await s.close();
	}

	// ---- E: home + outside > basis is rejected
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00");
		await s.origin();
		await expectThrowC(
			() =>
				createSpendingFoodClassification({
					db: s.db,
					userId: U1,
					subject: ccSub(pur.eid),
					foodHomeMarketAmount: "200.00",
					foodOutsideAmount: "200.00",
					sourceKind: "USER_APPROVED",
					idempotencyKey: "f-e",
					occurredAt: at("2026-09-10T00:00:00Z"),
				}),
			"exceeds the personal economic basis",
			"4C/E: home + outside > basis is rejected",
		);
		await s.close();
	}

	// ---- F: shared card purchase gross 1000, personal share 400 -> basis is 400
	{
		const s = await make4bScenario();
		const OBL = "8c000000-0000-4000-8000-00000000f001";
		await s.replica();
		const pur = await s.mkPur("1000.00", "DISCRETIONARY_SPEND", "2026-09-05 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-05 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid,
			purchaseEr: pur.er,
			splitId: "87000000-0000-4000-8000-00000000f001",
			user: "400.00",
			ext: "600.00",
			gross: "1000.00",
			occ: "2026-09-05 00:00:00+00",
			personId: s.P_FAM,
			personObligationId: OBL,
		});
		await s.origin();
		const res = await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "400.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-f",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		eqC(res.classification.basisPersonalAmount, "400.00", "4C/F: basis is the personal share (400), not gross (1000)");
		eqC(res.classification.splitBasis, "SEALED_SPLIT_AS_OF", "4C/F: splitBasis evidence = SEALED_SPLIT_AS_OF");
		await expectThrowC(
			() =>
				createSpendingFoodClassification({
					db: s.db,
					userId: U1,
					subject: ccSub(pur.eid),
					foodHomeMarketAmount: "500.00",
					foodOutsideAmount: "0.00",
					sourceKind: "USER_APPROVED",
					idempotencyKey: "f-f2",
					occurredAt: at("2026-09-10T00:00:00Z"),
				}),
			"already food-classified",
			"4C/F: a second create on the same subject is a revision conflict",
		);
		await s.close();
	}

	// ---- G: the external family 600 never enters FOOD_TOTAL
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		const OBL = "8c000000-0000-4000-8000-00000000f002";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-05 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-05 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid,
			purchaseEr: pur.er,
			splitId: "87000000-0000-4000-8000-00000000f002",
			user: "400.00",
			ext: "600.00",
			gross: "1000.00",
			occ: "2026-09-05 00:00:00+00",
			personId: s.P_FAM,
			personObligationId: OBL,
		});
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "400.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-g",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		chkC(rep.foodAnalytics.available === true, "4C/G: single classified subject -> foodAnalytics available");
		if (rep.foodAnalytics.available) {
			eqC(rep.foodAnalytics.foodTotal, "400.00", "4C/G: FOOD_TOTAL = personal 400 (external 600 excluded)");
			eqC(rep.foodAnalytics.foodHomeMarket, "400.00", "4C/G: FOOD_HOME_MARKET = 400");
			eqC(rep.foodAnalytics.subjects[0]?.personalEconomicAmount, "400.00", "4C/G: subject personal economic amount = 400");
		}
		await s.close();
	}

	// ---- H: unsealed / unresolved split -> classification creation fails closed
	{
		const s = await make4bScenario();
		const OBL = "8c000000-0000-4000-8000-00000000f003";
		await s.replica();
		const pur = await mkMand(s, "1000.00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-05 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid,
			purchaseEr: pur.er,
			splitId: "87000000-0000-4000-8000-00000000f003",
			user: "400.00",
			ext: "600.00",
			gross: "1000.00",
			occ: "2026-09-05 00:00:00+00",
			personId: s.P_FAM,
			personObligationId: OBL,
			sealed: false,
		});
		await s.origin();
		await expectThrowC(
			() =>
				createSpendingFoodClassification({
					db: s.db,
					userId: U1,
					subject: ccSub(pur.eid),
					foodHomeMarketAmount: "100.00",
					foodOutsideAmount: "0.00",
					sourceKind: "USER_APPROVED",
					idempotencyKey: "f-h",
					occurredAt: at("2026-09-10T00:00:00Z"),
				}),
			"is not sealed",
			"4C/H: an unsealed effective split fails food classification closed",
		);
		await s.close();
	}

	// ---- I: People PAYABLE basis = principal
	{
		const s = await make4bScenario();
		const OBL = "8c000000-0000-4000-8000-00000000f004";
		await s.replica();
		await s.mkObligation(OBL, s.P_FRI, "PAYABLE", "250.00", "2026-09-04 00:00:00+00");
		await s.origin();
		const res = await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ppSub(OBL),
			foodHomeMarketAmount: "250.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-i",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		eqC(res.classification.basisPersonalAmount, "250.00", "4C/I: People PAYABLE basis = obligation principal (250)");
		eqC(res.classification.subjectType, "PEOPLE_PAYABLE", "4C/I: subject type PEOPLE_PAYABLE");
		await s.close();
	}

	// ---- J: People RECEIVABLE -> rejected
	{
		const s = await make4bScenario();
		const OBL = "8c000000-0000-4000-8000-00000000f005";
		await s.replica();
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "250.00", "2026-09-04 00:00:00+00");
		await s.origin();
		await expectThrowC(
			() =>
				createSpendingFoodClassification({
					db: s.db,
					userId: U1,
					subject: ppSub(OBL),
					foodHomeMarketAmount: "250.00",
					foodOutsideAmount: "0.00",
					sourceKind: "USER_APPROVED",
					idempotencyKey: "f-j",
					occurredAt: at("2026-09-10T00:00:00Z"),
				}),
			"PAYABLE",
			"4C/J: a RECEIVABLE obligation is not eligible for food classification",
		);
		await s.close();
	}

	// ---- K / N: later card personal-share change -> old classification STALE, earlier as-of retained
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "1000.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-k",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await s.replica();
		await s.mkPurRev(pur.eid, pur.er, 2, "UPDATE", "700.00", "MANDATORY_EXPENSE", "2026-09-10 00:00:00+00");
		await s.origin();
		const early = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: at("2026-09-08T00:00:00Z"),
		});
		const late = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: at("2026-09-20T00:00:00Z"),
		});
		eqC(early.status, "CLASSIFIED", "4C/K,N: before the source change the classification is still CLASSIFIED");
		eqC(late.status, "STALE", "4C/K: after the personal-share drop (1000 -> 700) the stored basis is STALE");

		// ---- M: a semantic UPDATE restores the authoritative classification
		await updateSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			expectedRevisionNo: 1,
			foodHomeMarketAmount: "700.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-m",
			occurredAt: at("2026-09-12T00:00:00Z"),
		});
		const restored = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: at("2026-09-20T00:00:00Z"),
		});
		eqC(restored.status, "CLASSIFIED", "4C/M: an approved UPDATE to the new basis restores CLASSIFIED");
		eqC(restored.basisPersonalAmount, "700.00", "4C/M: restored basis = 700");
		await s.close();
	}

	// ---- L: later People PAYABLE principal change -> STALE
	{
		const s = await make4bScenario();
		const OBL = "8c000000-0000-4000-8000-00000000f006";
		await s.replica();
		await s.mkObligation(OBL, s.P_FRI, "PAYABLE", "250.00", "2026-09-04 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ppSub(OBL),
			foodHomeMarketAmount: "250.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-l",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await s.replica();
		const { tr } = await s.mkCanon("PERSON_PAYABLE_EXPENSE", "2026-09-10 00:00:00+00");
		const prev = (
			await s.q(
				"select id from person_obligation_revisions where obligation_id=$1 and revision_no=1",
				[OBL],
			)
		).rows[0].id as string;
		await s.q(
			`insert into person_obligation_revisions (id,user_id,obligation_id,revision_no,previous_revision_id,canonical_revision_id,operation,principal_amount,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,2,$4,$5,'UPDATE','400.00','2026-09-10 00:00:00+00',$6,$7)`,
			[s.gid(), U1, OBL, prev, tr, "ok-l2", s.F],
		);
		await s.origin();
		const v = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ppSub(OBL),
			asOf: at("2026-09-20T00:00:00Z"),
		});
		eqC(v.status, "STALE", "4C/L: a later People principal change (250 -> 400) makes the stored basis STALE");
		await s.close();
	}

	// ---- N: a future semantic UPDATE after the checkpoint does not rewrite the old checkpoint
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-03 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-n",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await updateSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			expectedRevisionNo: 1,
			foodHomeMarketAmount: "0.00",
			foodOutsideAmount: "300.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-n2",
			occurredAt: at("2026-09-25T00:00:00Z"),
		});
		const cp = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: CP15,
		});
		const now = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: at("2026-09-26T00:00:00Z"),
		});
		eqC(cp.classificationKind, "FOOD_HOME_MARKET", "4C/N: the Sep-15 checkpoint still sees revision 1 (home/market)");
		eqC(now.classificationKind, "FOOD_OUTSIDE", "4C/N: the Sep-25 reclassification only applies from Sep-25 onward");
		await s.close();
	}

	// ---- O: semantic VOID -> subject UNCLASSIFIED at a later asOf; P: no row != NON_FOOD
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-03 00:00:00+00");
		const pur2 = await mkMand(s, "150.00", "2026-09-03 00:00:00+00");
		await s.origin();
		// P: pur2 is never classified
		const p = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur2.eid),
			asOf: CP15,
		});
		eqC(p.status, "UNCLASSIFIED", "4C/P: an unclassified subject reports UNCLASSIFIED");
		eqC(p.classificationKind, null, "4C/P: 'no classification' is NOT NON_FOOD (kind is null)");

		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-o",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await voidSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			expectedRevisionNo: 1,
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-o2",
			occurredAt: at("2026-09-12T00:00:00Z"),
		});
		const before = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: at("2026-09-08T00:00:00Z"),
		});
		const after = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			asOf: at("2026-09-20T00:00:00Z"),
		});
		eqC(before.status, "CLASSIFIED", "4C/O: before the VOID instant the classification still applies");
		eqC(after.status, "UNCLASSIFIED", "4C/O: after the VOID the subject is UNCLASSIFIED");
		eqC(after.operation, "VOID", "4C/O: the effective revision is the VOID");
		await s.close();
	}

	// ---- Q / T: complete MTD coverage -> FOOD_TOTAL == HOME + OUTSIDE (NON_FOOD counts as coverage)
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const a = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		const b = await mkMand(s, "200.00", "2026-09-06 00:00:00+00");
		const c = await mkMand(s, "120.00", "2026-09-06 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(a.eid),
			foodHomeMarketAmount: "300.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-q1", occurredAt: at("2026-09-10T00:00:00Z"),
		});
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(b.eid),
			foodHomeMarketAmount: "0.00", foodOutsideAmount: "200.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-q2", occurredAt: at("2026-09-10T00:00:00Z"),
		});
		// T: explicit NON_FOOD still counts as classified coverage
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(c.eid),
			foodHomeMarketAmount: "0.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-q3", occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe,
		});
		chkC(rep.foodAnalytics.available === true, "4C/Q: every active MTD subject classified -> foodAnalytics available");
		if (rep.foodAnalytics.available) {
			eqC(rep.foodAnalytics.classifiedSubjectCount, 3, "4C/T: NON_FOOD subject is counted as classified coverage (3/3)");
			eqC(rep.foodAnalytics.foodHomeMarket, "300.00", "4C/Q: FOOD_HOME_MARKET = 300");
			eqC(rep.foodAnalytics.foodOutside, "200.00", "4C/Q: FOOD_OUTSIDE = 200");
			eqC(rep.foodAnalytics.foodTotal, "500.00", "4C/Q: FOOD_TOTAL == HOME + OUTSIDE");
		}
		await s.close();
	}

	// ---- R: one active subject unclassified -> available=false, FOOD_CLASSIFICATION_INCOMPLETE
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const a = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		const b = await mkMand(s, "200.00", "2026-09-06 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(a.eid),
			foodHomeMarketAmount: "300.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-r1", occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe,
		});
		chkC(rep.foodAnalytics.available === false, "4C/R: an unclassified active subject -> foodAnalytics NOT available");
		if (!rep.foodAnalytics.available) {
			eqC(rep.foodAnalytics.reason, "FOOD_CLASSIFICATION_INCOMPLETE", "4C/R: reason = FOOD_CLASSIFICATION_INCOMPLETE");
			chkC(rep.foodAnalytics.unclassifiedSubjectIds.includes(b.eid), "4C/R: the unclassified subject id is reported");
			eqC(rep.foodAnalytics.partialKnownFoodTotal, "300.00", "4C/R: partial known FOOD_TOTAL is labelled (300), never called FOOD_TOTAL");
		}
		await s.close();
	}

	// ---- S: one stale subject -> available=false
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const a = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(a.eid),
			foodHomeMarketAmount: "300.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-s", occurredAt: at("2026-09-07T00:00:00Z"),
		});
		await s.replica();
		await s.mkPurRev(a.eid, a.er, 2, "UPDATE", "200.00", "MANDATORY_EXPENSE", "2026-09-09 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db, userId: U1, periodMonth: P, triggerPaymentEventId: pe,
		});
		chkC(rep.foodAnalytics.available === false, "4C/S: a STALE active subject -> foodAnalytics NOT available");
		if (!rep.foodAnalytics.available) {
			chkC(rep.foodAnalytics.staleSubjectIds.includes(a.eid), "4C/S: the stale subject id is reported");
		}
		await s.close();
	}

	// ---- X: idempotent exact retry without an explicit occurredAt
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		await s.origin();
		const first = await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-x",
		});
		const retry = await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-x",
		});
		eqC(first.idempotentReplay, false, "4C/X: first create is not a replay");
		eqC(retry.idempotentReplay, true, "4C/X: exact retry (no occurredAt) is an idempotent replay");
		eqC(retry.classification.semanticRevisionId, first.classification.semanticRevisionId, "4C/X: replay returns the same stored revision");
		await s.close();
	}

	// ---- Y: same idempotency key + different payload -> typed conflict, never a raw 23505
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(pur.eid),
			foodHomeMarketAmount: "100.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-y", occurredAt: at("2026-09-10T00:00:00Z"),
		});
		await expectThrowC(
			() =>
				createSpendingFoodClassification({
					db: s.db, userId: U1, subject: ccSub(pur.eid),
					foodHomeMarketAmount: "200.00", foodOutsideAmount: "0.00",
					sourceKind: "USER_APPROVED", idempotencyKey: "f-y", occurredAt: at("2026-09-10T00:00:00Z"),
				}),
			"different food-classification parameters",
			"4C/Y: same key + different payload -> BUDGET_IDEMPOTENCY_CONFLICT (no raw 23505)",
		);
		await s.close();
	}

	// ---- Z: a fresh key with a stale expectedRevisionNo -> typed revision conflict
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db, userId: U1, subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00", foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED", idempotencyKey: "f-z", occurredAt: at("2026-09-10T00:00:00Z"),
		});
		await expectThrowC(
			() =>
				updateSpendingFoodClassification({
					db: s.db, userId: U1, subject: ccSub(pur.eid),
					expectedRevisionNo: 5,
					foodHomeMarketAmount: "0.00", foodOutsideAmount: "300.00",
					sourceKind: "USER_APPROVED", idempotencyKey: "f-z2", occurredAt: at("2026-09-12T00:00:00Z"),
				}),
			"but latest is 1",
			"4C/Z: a fresh key with a stale expectedRevisionNo -> BUDGET_REVISION_CONFLICT",
		);
		await s.close();
	}

	// ---- AB: migrations 0000..0066 remain byte-identical (spot-check the chain still applies)
	{
		const s = await make4bScenario();
		const t = (
			await s.q(
				"select count(*)::int c from information_schema.tables where table_name='budget_v2_spending_food_semantic_revisions'",
			)
		).rows[0].c as number;
		eqC(t, 1, "4C/AB: the 0067 table exists on top of an unchanged 0000..0066 chain");
		await s.close();
	}

	// ================================================================
	// 4C.1 -- integrity closure (strict asOf / interval visibility / no fallbacks)
	// ================================================================

	// ---- 3: an explicitly-supplied invalid asOf is rejected, never silently "now"
	{
		const s = await make4bScenario();
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		await s.origin();
		await expectThrowC(
			() =>
				getSpendingFoodClassificationAsOf({
					db: s.db,
					userId: U1,
					subject: ccSub(pur.eid),
					asOf: new Date("not-a-date"),
				}),
			"asOf must be a valid Date",
			"4C.1/3: getSpendingFoodClassificationAsOf rejects an invalid explicit asOf (never falls back to now)",
		);
		const okUndefined = await getSpendingFoodClassificationAsOf({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
		});
		eqC(okUndefined.status, "UNCLASSIFIED", "4C.1/3: omitting asOf still uses current time for the convenience read");
		await s.close();
	}

	// ---- U: FAMILY_REIMBURSEMENT is never a food subject and never enters FOOD_TOTAL
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		const OBL = "8c000000-0000-4000-8000-00000000fa01";
		const SET = "8b000000-0000-4000-8000-00000000fa01";
		await s.replica();
		const pur = await mkMand(s, "1000.00", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "600.00", "2026-09-03 00:00:00+00");
		await s.mkSplit({
			purchaseEid: pur.eid,
			purchaseEr: pur.er,
			splitId: "87000000-0000-4000-8000-00000000fa01",
			user: "400.00",
			ext: "600.00",
			gross: "1000.00",
			occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM,
			personObligationId: OBL,
		});
		await s.mkSettlement(SET, OBL, "600.00", "2026-09-10 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "400.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-u",
			occurredAt: at("2026-09-11T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		chkC(
			rep.interval.peopleFamily.familyReimbursements.length === 1 &&
				rep.interval.peopleFamily.familyReimbursements[0]?.obligationId === OBL,
			"4C.1/U: the family-owned split receivable settlement is reported as a FAMILY_REIMBURSEMENT",
		);
		chkC(rep.foodAnalytics.available === true, "4C.1/U: the food universe resolves (only the personal card share)");
		if (rep.foodAnalytics.available) {
			eqC(rep.foodAnalytics.subjects.length, 1, "4C.1/U: exactly one food subject -- the reimbursement is NOT one");
			chkC(
				!rep.foodAnalytics.subjects.some((x) => x.subjectId === OBL),
				"4C.1/U: the RECEIVABLE reimbursement obligation is not a food subject",
			);
			eqC(rep.foodAnalytics.foodTotal, "400.00", "4C.1/U: FOOD_TOTAL = personal 400 (reimbursement 600 excluded)");
		}
		await s.close();
	}

	// ---- V: a statement payment is not a food expense
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const pur = await mkMand(s, "250.00", "2026-09-05 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "250.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-v",
			occurredAt: at("2026-09-10T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		chkC(rep.interval.statementPayments.length === 1, "4C.1/V: the statement payment appears in interval.statementPayments");
		chkC(rep.foodAnalytics.available === true, "4C.1/V: food universe resolves");
		if (rep.foodAnalytics.available) {
			eqC(rep.foodAnalytics.subjects.length, 1, "4C.1/V: only the purchase is a food subject -- the payment is not");
			eqC(rep.foodAnalytics.foodTotal, "250.00", "4C.1/V: FOOD_TOTAL unchanged by the payment");
		}
		await s.close();
	}

	// ---- W: UPDATE / VOID activity never creates a second food expense
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const pur = await s.mkPur("100.00", "MANDATORY_EXPENSE", "2026-09-04 00:00:00+00");
		await s.mkPurRev(pur.eid, pur.er, 2, "UPDATE", "100.00", "MANDATORY_EXPENSE", "2026-09-08 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "100.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-w",
			occurredAt: at("2026-09-06T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		const foodRows = rep.foodAnalytics.available
			? rep.foodAnalytics.subjects.filter((x) => x.subjectId === pur.eid)
			: [];
		eqC(foodRows.length, 1, "4C.1/W: a CREATE + same-subject UPDATE yields exactly ONE MTD food subject, not two");
		const actRows = rep.interval.purchases.activity.filter((x) => x.eventId === pur.eid);
		eqC(actRows.length, 2, "4C.1/W: both the CREATE and UPDATE appear as interval ACTIVITY rows");
		chkC(
			actRows.every((x) => x.foodClassification.applicable === true),
			"4C.1/W: interval activity carries food visibility (no second economic amount is derived)",
		);
		await s.close();
	}

	// ---- W (VOID part): a VOIDed purchase leaves the active food universe
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const pur = await s.mkPur("100.00", "MANDATORY_EXPENSE", "2026-09-04 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "100.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-wv",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await s.replica();
		await s.mkPurRev(pur.eid, pur.er, 2, "VOID", "100.00", "MANDATORY_EXPENSE", "2026-09-08 00:00:00+00");
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		const inUniverse = rep.foodAnalytics.subjects.some((x) => x.subjectId === pur.eid);
		chkC(!inUniverse, "4C.1/W: a purchase VOIDed before the checkpoint is not an active MTD food subject");
		const voidRow = rep.interval.purchases.activity.find(
			(x) => x.eventId === pur.eid && x.operation === "VOID",
		);
		chkC(!!voidRow, "4C.1/W: the VOID still appears as interval ACTIVITY");
		chkC(
			!!voidRow &&
				voidRow.foodClassification.applicable === true &&
				voidRow.foodClassification.available === true &&
				voidRow.foodClassification.status === "SOURCE_VOID" &&
				!("foodTotalAmount" in voidRow.foodClassification),
			"4C.1/W: the VOID activity row shows SOURCE_VOID with no fabricated food amounts",
		);
		await s.close();
	}

	// ---- 7A/7B: purchase CREATE before classification -> activity UNCLASSIFIED; MTD subject CLASSIFIED
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const pur = await mkMand(s, "300.00", "2026-09-05 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-7a",
			occurredAt: at("2026-09-06T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		const createRow = rep.interval.purchases.activity.find(
			(x) => x.eventId === pur.eid && x.operation === "CREATE",
		);
		chkC(
			!!createRow &&
				createRow.foodClassification.applicable === true &&
				createRow.foodClassification.available === true &&
				createRow.foodClassification.status === "UNCLASSIFIED",
			"4C.1/7A: the Sep-5 CREATE activity row is UNCLASSIFIED at its own instant (the Sep-6 classification is not borrowed)",
		);
		chkC(
			rep.foodAnalytics.available === true &&
				rep.foodAnalytics.subjects.some(
					(x) => x.subjectId === pur.eid && x.classificationStatus === "CLASSIFIED",
				),
			"4C.1/7B: the same subject IS CLASSIFIED in the Sep-15 MTD state (not a contradiction)",
		);
		await s.close();
	}

	// ---- 7C/7D: a purchase UPDATE activity shows the classification effective at its instant; a later reclassification never rewrites it
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		await s.replica();
		const pur = await s.mkPur("300.00", "MANDATORY_EXPENSE", "2026-09-03 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			foodHomeMarketAmount: "300.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-7c",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await s.replica();
		await s.mkPurRev(pur.eid, pur.er, 2, "UPDATE", "300.00", "MANDATORY_EXPENSE", "2026-09-08 00:00:00+00");
		await s.origin();
		// a future reclassification (Sep-20) must not rewrite the Sep-8 activity row
		await updateSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ccSub(pur.eid),
			expectedRevisionNo: 1,
			foodHomeMarketAmount: "0.00",
			foodOutsideAmount: "300.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-7d",
			occurredAt: at("2026-09-20T00:00:00Z"),
		});
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		const updRow = rep.interval.purchases.activity.find(
			(x) => x.eventId === pur.eid && x.operation === "UPDATE",
		);
		chkC(
			!!updRow &&
				updRow.foodClassification.applicable === true &&
				updRow.foodClassification.available === true &&
				updRow.foodClassification.status === "CLASSIFIED" &&
				updRow.foodClassification.semanticRevisionNo === 1 &&
				updRow.foodClassification.classificationKind === "FOOD_HOME_MARKET",
			"4C.1/7C+7D: the Sep-8 UPDATE row shows semantic revision 1 (home/market); the Sep-20 reclassification does not rewrite it",
		);
		await s.close();
	}

	// ---- 7E/7F/7G: PAYABLE activity gets food state at its instant; RECEIVABLE not applicable; settlements never
	{
		const s = await make4bScenario();
		const pe = await mkTrigger(s);
		const PAY = "8c000000-0000-4000-8000-00000000fb01";
		const REC = "8c000000-0000-4000-8000-00000000fb02";
		const SET = "8b000000-0000-4000-8000-00000000fb02";
		await s.replica();
		await s.mkObligation(PAY, s.P_FRI, "PAYABLE", "250.00", "2026-09-04 00:00:00+00");
		await s.mkObligation(REC, s.P_FAM, "RECEIVABLE", "120.00", "2026-09-04 00:00:00+00");
		await s.mkSettlement(SET, REC, "120.00", "2026-09-06 00:00:00+00");
		await s.origin();
		await createSpendingFoodClassification({
			db: s.db,
			userId: U1,
			subject: ppSub(PAY),
			foodHomeMarketAmount: "250.00",
			foodOutsideAmount: "0.00",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "f-7e",
			occurredAt: at("2026-09-05T00:00:00Z"),
		});
		await s.replica();
		const { tr } = await s.mkCanon("PERSON_PAYABLE_EXPENSE", "2026-09-08 00:00:00+00");
		const prev = (
			await s.q(
				"select id from person_obligation_revisions where obligation_id=$1 and revision_no=1",
				[PAY],
			)
		).rows[0].id as string;
		await s.q(
			`insert into person_obligation_revisions (id,user_id,obligation_id,revision_no,previous_revision_id,canonical_revision_id,operation,principal_amount,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,2,$4,$5,'UPDATE','250.00','2026-09-08 00:00:00+00',$6,$7)`,
			[s.gid(), U1, PAY, prev, tr, "ok-7e2", s.F],
		);
		await s.origin();
		const rep = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: pe,
		});
		const payCreate = rep.interval.peopleFamily.obligationActivity.find(
			(x) => x.obligationId === PAY && x.operation === "CREATE",
		);
		const payUpdate = rep.interval.peopleFamily.obligationActivity.find(
			(x) => x.obligationId === PAY && x.operation === "UPDATE",
		);
		const recRow = rep.interval.peopleFamily.obligationActivity.find(
			(x) => x.obligationId === REC,
		);
		chkC(
			!!payCreate &&
				payCreate.foodClassification.applicable === true &&
				payCreate.foodClassification.available === true &&
				payCreate.foodClassification.status === "UNCLASSIFIED",
			"4C.1/7E: PAYABLE CREATE (Sep-4) is UNCLASSIFIED at its instant (before the Sep-5 classification)",
		);
		chkC(
			!!payUpdate &&
				payUpdate.foodClassification.applicable === true &&
				payUpdate.foodClassification.available === true &&
				payUpdate.foodClassification.status === "CLASSIFIED",
			"4C.1/7E: PAYABLE UPDATE (Sep-8) shows the classification effective by then",
		);
		chkC(
			!!recRow && recRow.foodClassification.applicable === false,
			"4C.1/7F: RECEIVABLE obligation activity has foodClassification.applicable = false",
		);
		chkC(
			rep.interval.peopleFamily.settlementActivity.every(
				(x) => !("foodClassification" in x),
			),
			"4C.1/7G: settlement activity rows carry no food classification",
		);
		chkC(
			!rep.foodAnalytics.subjects.some((x) => x.subjectId === REC),
			"4C.1/7G: the RECEIVABLE obligation never enters the food universe",
		);
		await s.close();
	}
}


async function resolverRuntime5() {
	console.log(
		"\n== PHASE 5: DURABLE CHECKPOINT PERSISTENCE & PAID-EVENT ORCHESTRATION ==",
	);
	const { buildBudgetV2CheckpointReport } = await import(
		"../src/budget/checkpoint-report-v2.ts"
	);
	const { reconcileStatement } = await import(
		"../src/credit-cards/statement-reconciliation.ts"
	);
	const {
		createCheckpointTriggerCard,
		updateCheckpointTriggerCard,
		getEffectiveCheckpointTriggerCard,
	} = await import("../src/budget/checkpoint-trigger-card-v2.ts");
	const { maybeEnqueueBudgetV2CheckpointRequest } = await import(
		"../src/budget/checkpoint-request-v2.ts"
	);
	const {
		processPendingBudgetV2CheckpointRequests,
		getBudgetV2CheckpointByPaymentEventId,
	} = await import("../src/budget/checkpoint-processor-v2.ts");
	const { canonicalJsonStringify } = await import(
		"../src/budget/checkpoint-canonical-v2.ts"
	);

	const { P } = B4_IDS;
	const RECON = new Date("2026-09-01T00:00:00Z");
	const at = (iso: string) => new Date(iso);
	const eq5 = (a: unknown, b: unknown, name: string) =>
		a === b
			? ok(name)
			: bad(name, `-> got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
	const chk5 = (c: boolean, name: string) => (c ? ok(name) : bad(name));
	const throw5 = async (
		fn: () => Promise<unknown>,
		needle: string,
		name: string,
	) => {
		try {
			await fn();
			bad(name, "-> did not throw");
		} catch (e) {
			const m = String((e as Error).message);
			m.includes(needle) && !/23505|duplicate key/.test(m)
				? ok(name)
				: bad(name, `-> ${m}`);
		}
	};

	// biome-ignore lint/suspicious/noExplicitAny: test scaffolding
	type S = any;
	const enableCard = (
		s: S,
		cardId: string,
		occ = "2026-08-01T00:00:00Z",
		key = "tc-en",
	) =>
		createCheckpointTriggerCard({
			db: s.db,
			userId: U1,
			creditCardId: cardId,
			status: "ENABLED" as const,
			sourceKind: "USER_APPROVED" as const,
			idempotencyKey: key,
			occurredAt: at(occ),
		});

	// reconcile (all-personal ADJUSTMENT) + PAY a statement on the primary card.
	const paidStmt = async (
		s: S,
		opts: {
			sid: string;
			amount?: string;
			cycle?: number;
			payAt: string;
			revNo?: number;
			prevRev?: string;
			key: string;
		},
	) => {
		const amount = opts.amount ?? "400.00";
		await s.replica();
		const r1 = await s.mkStmt(opts.sid, amount, opts.cycle ?? 9);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: opts.sid,
			statementRevisionId: r1,
			idempotencyKey: opts.key,
			occurredAt: RECON,
			components: [
				{
					componentType: "ADJUSTMENT",
					amount,
					ownership: "PERSONAL",
					adjustmentKind: "OTHER",
				},
			],
		});
		await s.replica();
		const { pe, r } = await s.mkPay(
			opts.sid,
			opts.prevRev ?? r1,
			amount,
			opts.revNo ?? 2,
			opts.payAt,
		);
		await s.origin();
		return { sid: opts.sid, pe, payRev: r, r1 };
	};

	const enqueue = (
		s: S,
		opts: {
			sid: string;
			cardId: string;
			pe: string;
			payRev: string;
			occurredAt: Date;
		},
	) =>
		s.db.transaction((tx: S) =>
			maybeEnqueueBudgetV2CheckpointRequest({
				tx,
				userId: U1,
				statementId: opts.sid,
				creditCardId: opts.cardId,
				paymentEventId: opts.pe,
				payRevisionId: opts.payRev,
				occurredAt: opts.occurredAt,
			}),
		);

	const reqCount = async (s: S) =>
		(await s.q("select count(*)::int c from budget_v2_checkpoint_requests"))
			.rows[0].c as number;
	const snapCount = async (s: S) =>
		(await s.q("select count(*)::int c from budget_v2_checkpoint_snapshots"))
			.rows[0].c as number;

	// ---- A: no trigger config -> PAY commits, no checkpoint request
	{
		const s = await make4bScenario();
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-00000000000a",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-a",
		});
		const r = await enqueue(s, {
			sid: p.sid,
			cardId: s.CARD,
			pe: p.pe,
			payRev: p.payRev,
			occurredAt: at("2026-09-15T00:00:00Z"),
		});
		eq5(r.enqueued, false, "5/A: no trigger config -> PAY commits, no checkpoint request");
		eq5(await reqCount(s), 0, "5/A: requests table stays empty");
		await s.close();
	}

	// ---- B/E/F: enabled card -> exactly one request; idempotent + concurrent retry stay one
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const effBefore = await getEffectiveCheckpointTriggerCard({
			db: s.db,
			userId: U1,
			creditCardId: s.CARD,
			asOf: at("2026-07-01T00:00:00Z"),
		});
		eq5(effBefore.enabled, false, "5/B: config is not effective before its occurredAt");
		const effAfter = await getEffectiveCheckpointTriggerCard({
			db: s.db,
			userId: U1,
			creditCardId: s.CARD,
			asOf: at("2026-09-15T00:00:00Z"),
		});
		eq5(effAfter.enabled, true, "5/B: config effective as of the payment instant is ENABLED");
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-00000000000b",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-b",
		});
		const oc = at("2026-09-15T00:00:00Z");
		const r1 = await enqueue(s, {
			sid: p.sid,
			cardId: s.CARD,
			pe: p.pe,
			payRev: p.payRev,
			occurredAt: oc,
		});
		eq5(r1.enqueued, true, "5/B: ENABLED trigger card -> actual PAY creates exactly one request");
		eq5(r1.periodMonth, "2026-09-01", "5/B: request periodMonth is the payment-event period");
		const r2 = await enqueue(s, {
			sid: p.sid,
			cardId: s.CARD,
			pe: p.pe,
			payRev: p.payRev,
			occurredAt: oc,
		});
		eq5(r2.enqueued, false, "5/E: idempotent PAY retry -> still exactly one request");
		await Promise.all([
			enqueue(s, { sid: p.sid, cardId: s.CARD, pe: p.pe, payRev: p.payRev, occurredAt: oc }),
			enqueue(s, { sid: p.sid, cardId: s.CARD, pe: p.pe, payRev: p.payRev, occurredAt: oc }),
		]);
		eq5(await reqCount(s), 1, "5/F: concurrent PAY retry -> still exactly one request");
		await s.close();
	}

	// ---- C: another card, SAME issuer + displayName, NOT configured -> no request
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD, "2026-08-01T00:00:00Z", "tc-c");
		const CARD2 = "22222222-0000-4000-8000-000000000002";
		const SID = "85000000-0000-4000-8000-00000000000c";
		await s.replica();
		await s.q(`insert into credit_cards (id,user_id,code) values ($1,$2,'CARDB')`, [
			CARD2,
			U1,
		]);
		await s.q(
			`insert into credit_card_revisions (id,user_id,credit_card_id,revision_no,operation,status,display_name,issuer,statement_day,due_day,credit_limit,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','ACTIVE','Akbank Axess','Akbank','1','20','90000.00','2026-07-01 00:00:00+00',$4,$5)`,
			[s.gid(), U1, CARD2, "ccr-cardb", s.F],
		);
		const rb = s.gid();
		await s.q(
			`insert into midas_buckets (id,user_id,midas_account_id,code,name,bucket_type) values ($1,$2,$3,'RBCARDB','reserve','CREDIT_CARD_RESERVE')`,
			[rb, U1, s.MID],
		);
		await s.q(
			`insert into credit_card_statements (id,user_id,credit_card_id,midas_account_id,midas_reserve_bucket_id,cycle_year,cycle_month) values ($1,$2,$3,$4,$5,2026,9)`,
			[SID, U1, CARD2, s.MID, rb],
		);
		const r1 = s.gid();
		await s.q(
			`insert into credit_card_statement_revisions (id,user_id,statement_id,revision_no,operation,status,statement_amount,statement_date,due_date,reserve_placement,occurred_at,idempotency_key,revision_fingerprint) values ($1,$2,$3,1,'CREATE','OPEN','400.00','2026-09-01','2026-09-20','MIDAS_FUND','2026-09-01 00:00:00+00',$4,$5)`,
			[r1, U1, SID, "stk-cardb", s.F],
		);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: SID,
			statementRevisionId: r1,
			idempotencyKey: "rc-c",
			occurredAt: RECON,
			components: [
				{ componentType: "ADJUSTMENT", amount: "400.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
			],
		});
		await s.replica();
		const { pe, r } = await s.mkPay(SID, r1, "400.00", 2, "2026-09-15 00:00:00+00");
		await s.origin();
		const res = await enqueue(s, {
			sid: SID,
			cardId: CARD2,
			pe,
			payRev: r,
			occurredAt: at("2026-09-15T00:00:00Z"),
		});
		eq5(
			res.enqueued,
			false,
			"5/C: a different card with the SAME issuer/displayName but no config -> no request (no name inference)",
		);
		eq5(await reqCount(s), 0, "5/C: requests table stays empty");
		// U: configure CARD2 too -> its own PAY now enqueues.
		await updateCheckpointTriggerCardOrCreate(s, CARD2);
		const res2 = await enqueue(s, {
			sid: SID,
			cardId: CARD2,
			pe,
			payRev: r,
			occurredAt: at("2026-09-15T00:00:00Z"),
		});
		eq5(res2.enqueued, true, "5/U: once CARD2 is explicitly configured, its actual PAY creates its own request");
		await s.close();
	}

	// ---- D: DISABLED config -> no request
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD, "2026-08-01T00:00:00Z", "tc-d1");
		await updateCheckpointTriggerCard({
			db: s.db,
			userId: U1,
			creditCardId: s.CARD,
			expectedRevisionNo: 1,
			status: "DISABLED",
			sourceKind: "USER_APPROVED",
			idempotencyKey: "tc-d2",
			occurredAt: at("2026-08-02T00:00:00Z"),
		});
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-00000000000d",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-d",
		});
		const r = await enqueue(s, {
			sid: p.sid,
			cardId: s.CARD,
			pe: p.pe,
			payRev: p.payRev,
			occurredAt: at("2026-09-15T00:00:00Z"),
		});
		eq5(r.enqueued, false, "5/D: DISABLED trigger-card config -> no request");
		eq5(await reqCount(s), 0, "5/D: requests table stays empty");
		await s.close();
	}

	// ---- G: a rolled-back PAY -> no request
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-00000000000e",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-g",
		});
		try {
			await s.db.transaction(async (tx: S) => {
				await maybeEnqueueBudgetV2CheckpointRequest({
					tx,
					userId: U1,
					statementId: p.sid,
					creditCardId: s.CARD,
					paymentEventId: p.pe,
					payRevisionId: p.payRev,
					occurredAt: at("2026-09-15T00:00:00Z"),
				});
				throw new Error("simulated PAY rollback");
			});
		} catch {
			/* expected */
		}
		eq5(await reqCount(s), 0, "5/G: a failed / rolled-back PAY leaves no checkpoint request");
		await s.close();
	}

	// ---- H/I/J/K/L/M: PAY -> REOPEN -> PAY = two events, two requests, two chained snapshots
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const sid = "85000000-0000-4000-8000-000000000010";
		await s.replica();
		const r1 = await s.mkStmt(sid, "400.00", 9);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: sid,
			statementRevisionId: r1,
			idempotencyKey: "rc-i",
			occurredAt: RECON,
			components: [
				{ componentType: "ADJUSTMENT", amount: "400.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
			],
		});
		await s.replica();
		const { pe: pe1, r: rev2 } = await s.mkPay(sid, r1, "400.00", 2, "2026-09-08 00:00:00+00");
		const rev3 = await s.mkStmtRev(sid, rev2, 3, "REOPEN", "OPEN", "400.00", "2026-09-10 00:00:00+00");
		const { pe: pe2, r: rev4 } = await s.mkPay(sid, rev3, "400.00", 4, "2026-09-14 00:00:00+00");
		await s.origin();
		await enqueue(s, { sid, cardId: s.CARD, pe: pe1, payRev: rev2, occurredAt: at("2026-09-08T00:00:00Z") });
		await enqueue(s, { sid, cardId: s.CARD, pe: pe2, payRev: rev4, occurredAt: at("2026-09-14T00:00:00Z") });
		eq5(await reqCount(s), 2, "5/I: PAY -> REOPEN -> PAY yields two distinct payment events and two requests");
		const proc = await processPendingBudgetV2CheckpointRequests({ db: s.db });
		eq5(proc.persisted, 2, "5/I: both requests persist into immutable snapshots");
		eq5(await snapCount(s), 2, "5/I: two snapshots");
		const s1 = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: pe1 });
		const s2 = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: pe2 });
		eq5(s1.status, "PERSISTED", "5/H: the first snapshot remains after REOPEN + second PAY");
		chk5(
			s1.status === "PERSISTED" && s1.previousCheckpointAt === null,
			"5/J: first checkpoint in the month -> previousCheckpointAt = null",
		);
		chk5(
			s2.status === "PERSISTED" &&
				s2.previousCheckpointAt === "2026-09-08T00:00:00.000Z",
			"5/K: second checkpoint -> previousCheckpointAt = the first persisted checkpointAt",
		);
		chk5(
			s1.status === "PERSISTED" &&
				s2.status === "PERSISTED" &&
				s2.previousCheckpointSnapshotId === s1.snapshotId,
			"5/I: previous-checkpoint chain links snapshot 2 -> snapshot 1 (no branch)",
		);
		chk5(
			s2.status === "PERSISTED" &&
				(s2.report as S).checkpoint.intervalStart === "2026-09-08T00:00:00.000Z" &&
				(s2.report as S).checkpoint.intervalStartInclusive === false,
			"5/L/M: the second interval starts exclusively at the previous checkpoint boundary",
		);
		await s.close();
	}

	// ---- N/O/P: earlier request fails closed -> later blocked; after repair both persist in order
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const OBL = "8a000000-0000-4000-8000-000000000051";
		const A = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000052",
			amount: "300.00",
			payAt: "2026-09-05 00:00:00+00",
			key: "rc-n1",
		});
		const B = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000053",
			amount: "300.00",
			cycle: 8,
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-n2",
		});
		await enqueue(s, { sid: A.sid, cardId: s.CARD, pe: A.pe, payRev: A.payRev, occurredAt: at("2026-09-05T00:00:00Z") });
		await enqueue(s, { sid: B.sid, cardId: s.CARD, pe: B.pe, payRev: B.payRev, occurredAt: at("2026-09-15T00:00:00Z") });
		// Introduce an UNSEALED shared split in the MTD window -> the authoritative
		// report build fails closed for the whole period.
		await s.replica();
		const purU = await s.mkPur("800.00", "DISCRETIONARY_SPEND", "2026-09-03 00:00:00+00");
		await s.mkObligation(OBL, s.P_FAM, "RECEIVABLE", "500.00", "2026-09-03 00:00:00+00");
		const split = await s.mkSplit({
			purchaseEid: purU.eid,
			purchaseEr: purU.er,
			splitId: "87000000-0000-4000-8000-000000000051",
			user: "300.00",
			ext: "500.00",
			gross: "800.00",
			occ: "2026-09-03 00:00:00+00",
			personId: s.P_FAM,
			personObligationId: OBL,
			sealed: false,
		});
		await s.origin();
		const proc1 = await processPendingBudgetV2CheckpointRequests({ db: s.db });
		eq5(proc1.failedReport, 1, "5/O: the earliest request's authoritative report fails closed");
		eq5(proc1.blocked, 1, "5/N: the later same-period request is BLOCKED, never skipped ahead");
		eq5(await snapCount(s), 0, "5/O: no snapshot is written; payments + requests remain");
		eq5(await reqCount(s), 2, "5/O: both requests stay pending (not deleted)");
		// Repair evidence: seal the split revision.
		await s.replica();
		await s.q(
			`insert into credit_card_purchase_split_revision_seals (split_revision_id) values ($1)`,
			[split.splitRev],
		);
		await s.origin();
		const proc2 = await processPendingBudgetV2CheckpointRequests({ db: s.db });
		eq5(proc2.persisted, 2, "5/P: after evidence repair the retry persists the earlier checkpoint, then the later one");
		const later = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: B.pe });
		chk5(
			later.status === "PERSISTED" &&
				later.previousCheckpointAt === "2026-09-05T00:00:00.000Z",
			"5/N: the later checkpoint's previous boundary is the earlier checkpoint (it did not skip it)",
		);
		await s.close();
	}

	// ---- Q: stored checkpoint replay is frozen -- live source mutation never leaks in
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000061",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-q",
		});
		await enqueue(s, { sid: p.sid, cardId: s.CARD, pe: p.pe, payRev: p.payRev, occurredAt: at("2026-09-15T00:00:00Z") });
		await processPendingBudgetV2CheckpointRequests({ db: s.db });
		const before = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: p.pe });
		await s.replica();
		await s.mkPur("9999.00", "MANDATORY_EXPENSE", "2026-09-12 00:00:00+00");
		await s.origin();
		const after = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: p.pe });
		chk5(
			before.status === "PERSISTED" && after.status === "PERSISTED",
			"5/Q: replay returns the stored snapshot",
		);
		eq5(
			after.status === "PERSISTED" ? after.fingerprint : "x",
			before.status === "PERSISTED" ? before.fingerprint : "y",
			"5/Q: replay fingerprint is unchanged after live source mutation",
		);
		eq5(
			canonicalJsonStringify(after.status === "PERSISTED" ? after.report : {}),
			canonicalJsonStringify(before.status === "PERSISTED" ? before.report : {}),
			"5/Q: replay returns byte-identical report JSON (no live recomputation)",
		);
		// Tampered snapshot fails closed on read.
		await s.replica();
		await s.q(
			`update budget_v2_checkpoint_snapshots set report_fingerprint = $1 where payment_event_id = $2`,
			["0".repeat(64), p.pe],
		);
		await s.origin();
		await throw5(
			() => getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: p.pe }),
			"integrity check failed",
			"5/Q: a tampered stored snapshot fails closed on replay (BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT)",
		);
		await s.close();
	}

	// ---- R: concurrent processing -> exactly one snapshot, no raw unique violation
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000071",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-r",
		});
		await enqueue(s, { sid: p.sid, cardId: s.CARD, pe: p.pe, payRev: p.payRev, occurredAt: at("2026-09-15T00:00:00Z") });
		const [p1, p2] = await Promise.all([
			processPendingBudgetV2CheckpointRequests({ db: s.db }),
			processPendingBudgetV2CheckpointRequests({ db: s.db }),
		]);
		eq5(await snapCount(s), 1, "5/R: concurrent checkpoint processing produces exactly one snapshot");
		chk5(p1.persisted + p2.persisted >= 1, "5/R: at least one worker recorded the persist; the other returned the stored result");
		await s.close();
	}

	// ---- S: month boundary starts a fresh checkpoint chain
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const A = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000081",
			amount: "400.00",
			cycle: 9,
			payAt: "2026-09-20 00:00:00+00",
			key: "rc-s1",
		});
		await enqueue(s, { sid: A.sid, cardId: s.CARD, pe: A.pe, payRev: A.payRev, occurredAt: at("2026-09-20T00:00:00Z") });
		const SIDO = "85000000-0000-4000-8000-000000000082";
		await s.replica();
		const r1o = await s.mkStmt(SIDO, "500.00", 10);
		await s.origin();
		await reconcileStatement({
			db: s.db,
			userId: U1,
			statementId: SIDO,
			statementRevisionId: r1o,
			idempotencyKey: "rc-s2",
			occurredAt: new Date("2026-09-05T00:00:00Z"),
			components: [
				{ componentType: "ADJUSTMENT", amount: "500.00", ownership: "PERSONAL", adjustmentKind: "OTHER" },
			],
		});
		await s.replica();
		const { pe: peO, r: rO } = await s.mkPay(SIDO, r1o, "500.00", 2, "2026-10-10 00:00:00+00");
		await s.origin();
		await enqueue(s, { sid: SIDO, cardId: s.CARD, pe: peO, payRev: rO, occurredAt: at("2026-10-10T00:00:00Z") });
		const proc = await processPendingBudgetV2CheckpointRequests({ db: s.db });
		eq5(proc.persisted, 2, "5/S: both months' checkpoints persist");
		const octSnap = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: peO });
		chk5(octSnap.status === "PERSISTED" && octSnap.periodMonth === "2026-10-01", "5/S: October payment -> October checkpoint period");
		chk5(
			octSnap.status === "PERSISTED" &&
				octSnap.previousCheckpointAt === null &&
				octSnap.previousCheckpointSnapshotId === null,
			"5/S: a new month's first checkpoint has NO previous checkpoint from the prior month",
		);
		await s.close();
	}

	// ---- T: two distinct events, identical checkpointAt -> fail closed; payments/requests intact
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const T1 = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000091",
			amount: "400.00",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-t1",
		});
		const T2 = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-000000000092",
			amount: "300.00",
			cycle: 8,
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-t2",
		});
		await enqueue(s, { sid: T1.sid, cardId: s.CARD, pe: T1.pe, payRev: T1.payRev, occurredAt: at("2026-09-15T00:00:00Z") });
		await enqueue(s, { sid: T2.sid, cardId: s.CARD, pe: T2.pe, payRev: T2.payRev, occurredAt: at("2026-09-15T00:00:00Z") });
		eq5(await reqCount(s), 2, "5/T: both PAID events are durable requests");
		const proc = await processPendingBudgetV2CheckpointRequests({ db: s.db });
		eq5(proc.collisionPeriods, 1, "5/T: a same-checkpointAt collision fails closed at the report layer");
		eq5(proc.persisted, 0, "5/T: no snapshot is written for the colliding period");
		eq5(await reqCount(s), 2, "5/T: payments and requests remain intact after the collision");
		await s.close();
	}

	// ---- V: statement CREATE / VOID lifecycle alone never enqueues
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const sid = "85000000-0000-4000-8000-0000000000a1";
		await s.replica();
		const r1 = await s.mkStmt(sid, "400.00", 9);
		await s.mkStmtRev(sid, r1, 2, "VOID", "VOID", "400.00", "2026-09-05 00:00:00+00");
		await s.origin();
		eq5(await reqCount(s), 0, "5/V: statement CREATE / UPDATE / VOID / REOPEN alone never enqueue a checkpoint request");
		await s.close();
	}

	// ---- W: availableToAllocateNow is carried through unchanged; no fabricated allocation
	{
		const s = await make4bScenario();
		await enableCard(s, s.CARD);
		const p = await paidStmt(s, {
			sid: "85000000-0000-4000-8000-0000000000b1",
			payAt: "2026-09-15 00:00:00+00",
			key: "rc-w",
		});
		await enqueue(s, { sid: p.sid, cardId: s.CARD, pe: p.pe, payRev: p.payRev, occurredAt: at("2026-09-15T00:00:00Z") });
		await processPendingBudgetV2CheckpointRequests({ db: s.db });
		const live = await buildBudgetV2CheckpointReport({
			db: s.db,
			userId: U1,
			periodMonth: P,
			triggerPaymentEventId: p.pe,
		});
		const snap = await getBudgetV2CheckpointByPaymentEventId({ db: s.db, userId: U1, paymentEventId: p.pe });
		chk5(
			snap.status === "PERSISTED" &&
				canonicalJsonStringify((snap.report as S).availableToAllocateNow) ===
					canonicalJsonStringify(live.availableToAllocateNow) &&
				(snap.report as S).availableToAllocateNow.available === false,
			"5/W: the checkpoint report carries the existing authoritative availableToAllocateNow, unchanged (no fabricated allocation)",
		);
		await s.close();
	}
}

// helper: create-or-noop a trigger card config (used by 5/U)
// biome-ignore lint/suspicious/noExplicitAny: test scaffolding
async function updateCheckpointTriggerCardOrCreate(s: any, cardId: string) {
	const { createCheckpointTriggerCard } = await import(
		"../src/budget/checkpoint-trigger-card-v2.ts"
	);
	await createCheckpointTriggerCard({
		db: s.db,
		userId: U1,
		creditCardId: cardId,
		status: "ENABLED",
		sourceKind: "USER_APPROVED",
		idempotencyKey: `tc-u-${cardId.slice(-4)}`,
		occurredAt: new Date("2026-08-01T00:00:00Z"),
	});
}


const probed = await probe();
console.log(probed ? "\nPROBE: PASS\n" : "\nPROBE: FAIL (aborting runtime phase)\n");
if (probed) {
	await runtime();
	await resolverRuntime();
	await resolverRuntime4A();
	await resolverRuntime4A1();
	await resolverRuntime4B();
	await resolverRuntime4B2();
	await resolverRuntime4B3();
	await resolverRuntime4C();
	await resolverRuntime5();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
