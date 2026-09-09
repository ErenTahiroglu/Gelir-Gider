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
	console.log("\n== PHASE 2: APPLY MIGRATION CHAIN 0000..0066 (empty disposable DB) ==");
	const db = new PGlite();
	await db.query("SET timezone='UTC'");
	try {
		await applyChain(db, 66);
		ok("migration chain 0000..0066 applied to an empty PostgreSQL database");
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
	await applyChain(pg, 66);
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
	await applyChain(pg, 66);
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
			 select $1,$2,statement_id,$3,$4,'VOID','VOID',statement_amount,statement_date,due_date,reserve_placement,'2026-09-30 00:00:00+00',$5,revision_fingerprint
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
		await applyChain(pg0, 66);
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
	await applyChain(pg, 66);
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
			 select $1,$2,statement_id,2,$3,'VOID','VOID',statement_amount,statement_date,due_date,reserve_placement,'2026-09-29 00:00:00+00',$4,revision_fingerprint from credit_card_statement_revisions where id=$3`,
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

const probed = await probe();
console.log(probed ? "\nPROBE: PASS\n" : "\nPROBE: FAIL (aborting runtime phase)\n");
if (probed) {
	await runtime();
	await resolverRuntime();
	await resolverRuntime4A();
	await resolverRuntime4A1();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
