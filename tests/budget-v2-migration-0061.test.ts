import { describe, expect, it } from "vitest";
import migration0018Sql from "../migrations/0018_mushy_sleepwalker.sql?raw";
import migration0019Sql from "../migrations/0019_harden_budget_plan_integrity.sql?raw";
import migration0061Sql from "../migrations/0061_add_budget_policy_v2_foundation.sql?raw";
import journal from "../migrations/meta/_journal.json";
import {
	SINGLETON_BUCKET_TYPES,
	SINGLETON_BUCKET_TYPES_SQL_LIST,
} from "../src/db/schema/midas";

const sql = migration0061Sql;

describe("Migration 0061 -- Budget Policy V2 core foundation", () => {
	// --- Forward-only journal placement ---------------------------------
	it("is journal entry idx 61 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const last = entries[entries.length - 1];
		expect(last?.idx).toBe(61);
		expect(last?.tag).toBe("0061_add_budget_policy_v2_foundation");
		const prev = entries[entries.length - 2];
		expect(last?.when).toBeGreaterThan(prev?.when ?? 0);
	});

	// --- Separate V2 identity / revision projection --------------------
	it("creates the separate V2 anchor and append-only revision projection tables", () => {
		expect(sql).toContain('CREATE TABLE "monthly_budget_v2_plans"');
		expect(sql).toContain('CREATE TABLE "monthly_budget_v2_plan_revisions"');
		// One V2 plan per user + period; canonical + user ownership integrity.
		expect(sql).toContain('"monthly_budget_v2_plans_user_period_idx"');
		expect(sql).toContain('"monthly_budget_v2_plans_canonical_tx_idx"');
		expect(sql).toContain(
			'EXTRACT(DAY FROM "monthly_budget_v2_plans"."period_month") = 1',
		);
		expect(sql).toContain(
			'"monthly_budget_v2_plan_revisions_canonical_revision_id_transaction_revisions_id_fk"',
		);
		expect(sql).toContain(
			'"monthly_budget_v2_plan_revisions_budget_plan_id_monthly_budget_v2_plans_id_fk"',
		);
	});

	it("carries the 6 input + 6 output NUMERIC(18,2) snapshot columns and a JSONB evidence field", () => {
		for (const col of [
			"realized_income_amount",
			"current_obligations_amount",
			"basic_living_funding_amount",
			"date_bound_necessary_purchase_funding_amount",
			"core_emergency_fund_balance_amount",
			"mobility_balance_amount",
			"emergency_catch_up_amount",
			"deficit_amount",
			"true_surplus_amount",
			"mobility_allocation_amount",
			"long_term_investment_amount",
			"discretionary_allocation_amount",
		]) {
			expect(sql).toContain(`"${col}" numeric(18, 2) NOT NULL`);
		}
		expect(sql).toContain('"evidence_snapshot" jsonb NOT NULL');
	});

	it("binds V2 to the distinct canonical kind MONTHLY_BUDGET_PLAN_V2 and policy version PERSONAL_BUDGET_V2", () => {
		expect(sql).toContain(
			"canonical_transaction kind must be MONTHLY_BUDGET_PLAN_V2",
		);
		expect(sql).toContain(`"policy_version" = 'PERSONAL_BUDGET_V2'`);
		expect(sql).toContain("policy_version must be PERSONAL_BUDGET_V2");
	});

	// --- V2 revision integrity: NEW guard, not a V1 branch ------------
	it("adds NEW V2-specific guard functions/triggers (never touching the V1 guard)", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plans_immutability()",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_immutability()",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_monthly_budget_v2_plan_revisions_insert()",
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_guard_monthly_budget_v2_plan_revisions_insert",
		);
		// The V1 guard function is NEVER (re)defined here (only referenced by
		// name in an explanatory comment).
		expect(sql).not.toMatch(
			/(CREATE|REPLACE)\s+FUNCTION\s+trg_fn_guard_monthly_budget_plan_revisions_insert/,
		);
		// No DDL is issued against the V1 tables.
		expect(sql).not.toMatch(
			/(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|INDEX)[^;]*"monthly_budget_plans?"/i,
		);
		expect(sql).not.toMatch(
			/(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|INDEX)[^;]*"monthly_budget_plan_revisions"/i,
		);
	});

	it("enforces append-only, unbranched revision chain semantics", () => {
		expect(sql).toContain(
			"First V2 budget plan revision must have operation CREATE",
		);
		expect(sql).toContain(
			"First V2 budget plan revision must have NULL previous_budget_revision_id",
		);
		expect(sql).toContain(
			"Subsequent V2 budget plan revision must have operation UPDATE or VOID",
		);
		expect(sql).toContain("Cannot append revision to a VOIDED V2 budget plan");
		expect(sql).toContain(
			"VOID revision must copy predecessor input/output amounts and evidence snapshot exactly",
		);
		expect(sql).toContain("FOR UPDATE"); // parent plan lock
		expect(sql).toContain(
			"does not match period month Europe/Istanbul midnight",
		);
	});

	// --- DB-authoritative exact policy re-derivation ------------------
	it("independently re-derives the PERSONAL_BUDGET_V2 waterfall in integer-safe SQL (no floating point)", () => {
		// Exact policy constants in kurus.
		expect(sql).toContain("c_emergency_target constant bigint := 1000000");
		expect(sql).toContain("c_mobility_lower   constant bigint := 3000000");
		expect(sql).toContain("c_mobility_upper   constant bigint := 6000000");

		// Waterfall.
		expect(sql).toContain("v_pre := v_R - v_O - v_B - v_N;");
		expect(sql).toContain("v_exp_deficit := -v_pre;");
		expect(sql).toContain("v_gap := GREATEST(c_emergency_target - v_E, 0);");
		expect(sql).toContain("v_exp_catchup := LEAST(v_pre, v_gap);");
		expect(sql).toContain("v_exp_true := v_pre - v_exp_catchup;");

		// Discretionary always exactly 35% base.
		expect(sql).toContain(
			"v_exp_disc := div(v_exp_true::numeric * 3500, 10000)::bigint;",
		);

		// Mobility taper: integer rational arithmetic, not float percentages.
		expect(sql).toContain(
			"v_exp_true::numeric * 3500 * (c_mobility_upper - v_M)",
		);
		expect(sql).toContain("10000::numeric * 3000000");

		// 60k target-gap saturation.
		expect(sql).toContain("v_mob_gap := GREATEST(c_mobility_upper - v_M, 0);");
		expect(sql).toContain("v_exp_mob := LEAST(v_cand, v_mob_gap);");
		expect(sql).toContain("v_exp_long := v_exp_true - v_exp_mob - v_exp_disc;");

		// It must never use floating approximations.
		expect(sql).not.toMatch(/::float|::double|::real/i);
	});

	it("rejects every class of mathematically wrong V2 projection", () => {
		expect(sql).toContain("deficit_amount % kurus does not match");
		expect(sql).toContain("emergency_catch_up_amount % kurus does not match");
		expect(sql).toContain("true_surplus_amount % kurus does not match");
		expect(sql).toContain("mobility_allocation_amount % kurus does not match");
		expect(sql).toContain(
			"discretionary_allocation_amount % kurus does not match",
		);
		expect(sql).toContain("long_term_investment_amount % kurus does not match");
		expect(sql).toContain("must equal trueSurplus");
		expect(sql).toContain(
			"During an affordability deficit all surplus/catch-up allocations must be zero",
		);
		expect(sql).toContain("exceeds the remaining 60k target gap");
	});

	it("binds every canonical payload money field exactly to its projection column with the canonical money regex", () => {
		expect(sql).toContain(
			"v_money_regex text := '^(0|[1-9][0-9]{0,15})\\.[0-9]{2}$'",
		);
		expect(sql).toContain(
			"canonical_revision V2 payload must have exactly 6 top-level keys",
		);
		expect(sql).toContain("canonical payload inputs must have exactly 6 keys");
		expect(sql).toContain("canonical payload outputs must have exactly 6 keys");
		expect(sql).toContain("does not exactly bind realized_income_amount");
		expect(sql).toContain(
			"does not exactly bind discretionary_allocation_amount",
		);
		expect(sql).toContain(
			"canonical payload evidenceSnapshot does not match revision evidence_snapshot",
		);
		// Fail-closed jsonb type checks (COALESCE guard against missing keys).
		expect(sql).toContain("COALESCE(jsonb_typeof(");
	});

	// --- CORE_EMERGENCY_FUND singleton bucket primitive --------------
	it("forward-updates the midas_buckets check + partial unique index to make CORE_EMERGENCY_FUND valid and singleton", () => {
		expect(sql).toContain(
			'ALTER TABLE "midas_buckets" DROP CONSTRAINT "midas_buckets_type_check"',
		);
		expect(sql).toContain('DROP INDEX "midas_buckets_singleton_type_idx"');
		expect(sql).toContain(
			`CHECK ("midas_buckets"."bucket_type" IN ('CREDIT_CARD_RESERVE', 'SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM', 'CORE_EMERGENCY_FUND'))`,
		);
		expect(sql).toContain(
			`WHERE "midas_buckets"."bucket_type" IN ('MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM', 'CORE_EMERGENCY_FUND')`,
		);
		// Every previously-valid bucket type is preserved in the new check list.
		for (const t of [
			"CREDIT_CARD_RESERVE",
			"SHORT_TERM_GOAL",
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
		]) {
			expect(sql).toContain(`'${t}'`);
		}
		// The new singleton index predicate is exactly the constant-derived list
		// (drift guard between SINGLETON_BUCKET_TYPES and the DB predicate).
		expect(sql).toContain(
			`bucket_type" IN (${SINGLETON_BUCKET_TYPES_SQL_LIST})`,
		);
		for (const t of SINGLETON_BUCKET_TYPES) {
			expect(sql).toContain(`'${t}'`);
		}
	});

	it("performs NO INCOME_BUFFER reinterpretation and NO row backfill/UPDATE", () => {
		expect(sql).not.toMatch(/UPDATE\s+"?midas_buckets"?/i);
		expect(sql).not.toMatch(/INSERT\s+INTO\s+"?midas_buckets"?/i);
		expect(sql).not.toMatch(/INSERT\s+INTO\s+"?monthly_budget/i);
		expect(sql).not.toMatch(/UPDATE\s+"?monthly_budget/i);
		// INCOME_BUFFER only ever appears inside the preserved IN(...) type lists,
		// never in an `= 'INCOME_BUFFER'` predicate that would single it out.
		expect(sql).not.toMatch(/=\s*'INCOME_BUFFER'/);
		expect(sql).not.toMatch(/bucket_type\s*=\s*'INCOME_BUFFER'/i);
	});
});

describe("Migration 0061 -- V1 historical contract isolation", () => {
	it("does not modify migrations 0018/0019 (V1 domain + hardening)", () => {
		// The V1 domain migrations still declare the V1-only policy constraint
		// and V1-only guard -- proving 0061 did not go back and edit them.
		expect(migration0018Sql).toContain(
			`"policy_version" = 'PERSONAL_BUDGET_V1'`,
		);
		expect(migration0019Sql).toContain(
			"Budget revision policy_version must be PERSONAL_BUDGET_V1, found",
		);
		expect(migration0019Sql).toContain(
			"canonical_transaction kind must be MONTHLY_BUDGET_PLAN",
		);
		expect(migration0019Sql).not.toContain("MONTHLY_BUDGET_PLAN_V2");
		expect(migration0019Sql).not.toContain("PERSONAL_BUDGET_V2");
	});

	it("0061 never binds to the V1 policy version or V1 canonical kind, and never redefines the V1 guard", () => {
		// No V1 policy-version string literal (predicate or RAISE).
		expect(sql).not.toContain("'PERSONAL_BUDGET_V1'");
		expect(sql).not.toMatch(/policy_version[^;]*PERSONAL_BUDGET_V1/i);
		// No V1 canonical-kind string literal ('MONTHLY_BUDGET_PLAN' without _V2).
		expect(sql).not.toContain("'MONTHLY_BUDGET_PLAN'");
		// V1 guard/immutability functions are not (re)created.
		expect(sql).not.toMatch(
			/FUNCTION\s+trg_fn_guard_monthly_budget_plan_revisions_(insert|immutability)/,
		);
		expect(sql).not.toMatch(
			/FUNCTION\s+trg_fn_guard_monthly_budget_plans_immutability/,
		);
	});
});
