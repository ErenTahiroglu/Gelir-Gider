import { describe, expect, it } from "vitest";
import migration0058Sql from "../migrations/0058_fix_credit_card_canonical_payload_null_key_bypass.sql?raw";

describe("Credit Card Canonical Payload Null-Key Bypass Fix Migration 0058 Verification", () => {
	const sql = migration0058Sql;

	it("replaces both affected trigger functions", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_cc_liability_event_revision_insert()",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_cc_stmt_payment_event_insert()",
		);
	});

	it("wraps every exact-binding jsonb_typeof check in COALESCE so a missing payload key cannot bypass the guard", () => {
		// Every "exact canonical payload binding" comparison must be of the
		// form `COALESCE(jsonb_typeof(...), '') != '<type>'`, never a bare
		// `jsonb_typeof(...) != '<type>'` -- a bare form evaluates to SQL NULL
		// (not TRUE) when the JSON key is entirely absent, and `NULL OR NULL`
		// is NULL, which PL/pgSQL's IF treats as FALSE, silently skipping the
		// RAISE EXCEPTION instead of rejecting the malformed payload.
		// Exclude the intentionally-untouched "must be null/absent" checks,
		// which are already safe: they gate the jsonb_typeof(...) != 'null'
		// comparison behind an `IS NOT NULL AND` on the same expression, so a
		// missing key (NULL) short-circuits the AND to FALSE before the bare
		// `!=` is ever evaluated.
		const bareTypeofBeforeNotEquals =
			/(?<!IS NOT NULL AND )jsonb_typeof\(v_can_rev\.payload->'[a-zA-Z]+'\)\s*!=\s*'(string|number)'/g;
		const bareMatches = sql.match(bareTypeofBeforeNotEquals) ?? [];
		expect(bareMatches).toEqual([]);

		const coalescedChecks = sql.match(
			/COALESCE\(jsonb_typeof\(v_can_rev\.payload->'[a-zA-Z]+'\), ''\) != '(string|number)'/g,
		);
		expect(coalescedChecks?.length).toBeGreaterThanOrEqual(14);
	});

	it("does not touch the absent/null-only checks, which already correctly guard with IS NOT NULL", () => {
		expect(sql).toContain(
			"IF v_can_rev.payload->'merchant' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'merchant') != 'null' THEN",
		);
		expect(sql).toContain(
			"IF v_can_rev.payload->'shortTermGoalId' IS NOT NULL AND jsonb_typeof(v_can_rev.payload->'shortTermGoalId') != 'null' THEN",
		);
	});

	it("preserves the FOR UPDATE anchor locks from migration 0029", () => {
		expect(sql).toContain(
			"SELECT * INTO v_event FROM credit_card_liability_events WHERE id = NEW.event_id FOR UPDATE;",
		);
		expect(sql).toContain(
			"SELECT * INTO v_stmt FROM credit_card_statements WHERE id = NEW.statement_id FOR UPDATE;",
		);
	});
});
