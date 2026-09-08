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
	// income receipts (one per source)
	await db.query(
		`insert into income_receipts (id,user_id,source_id,canonical_transaction_id) values
		 ('b1000000-0000-4000-8000-000000000001',$1,'a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-00000000000a'),
		 ('b1000000-0000-4000-8000-000000000002',$1,'a1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-00000000000b'),
		 ('b1000000-0000-4000-8000-000000000003',$1,'a1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-00000000000c')`,
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
		 ('f1000000-0000-4000-8000-000000000002',$1,'e1000000-0000-4000-8000-000000000001','B_G2','G2 bucket','SHORT_TERM_GOAL')`,
		[U1] as never[],
	);
	await db.query(
		`insert into short_term_goals (id,user_id,midas_account_id,midas_bucket_id) values
		 ('99999999-0000-4000-8000-000000000001',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001'),
		 ('99999999-0000-4000-8000-000000000002',$1,'e1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002')`,
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
	console.log("\n== PHASE 2: APPLY MIGRATION CHAIN 0000..0063 (empty disposable DB) ==");
	const db = new PGlite();
	await db.query("SET timezone='UTC'");
	try {
		await applyChain(db, 63);
		ok("migration chain 0000..0063 applied to an empty PostgreSQL database");
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
		"PERSONAL_BUDGET_V1 revision #1 (65/5/10/10/10) still accepted after 0063",
	);

	await db.close();
}

const probed = await probe();
console.log(probed ? "\nPROBE: PASS\n" : "\nPROBE: FAIL (aborting runtime phase)\n");
if (probed) await runtime();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
