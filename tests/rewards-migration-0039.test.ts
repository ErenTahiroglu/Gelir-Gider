import { describe, expect, it } from "vitest";
import migration0039Sql from "../migrations/0039_harden_rewards_domain_integrity.sql?raw";

describe("Rewards Domain Migration 0039 Verification (Phase 12-R1 Hardening)", () => {
	const sql = migration0039Sql;

	it("enforces same-user ownership between a reward account and its associated credit card", () => {
		expect(sql).toContain("trg_fn_guard_reward_account_insert");
		expect(sql).toContain(
			"Credit card % belongs to a different user than reward account %",
		);
		expect(sql).toContain('BEFORE INSERT ON "reward_accounts"');
	});

	it("enforces same-user ownership between a reward event and its reward account", () => {
		expect(sql).toContain("trg_fn_guard_reward_event_insert");
		expect(sql).toContain(
			"Reward account % belongs to a different user than reward event %",
		);
		expect(sql).toContain('BEFORE INSERT ON "reward_events"');
	});

	it("rechecks reward account/event ownership equality inside the event-revision guard", () => {
		expect(sql).toContain(
			"Reward account % user_id % does not match reward event % user_id %",
		);
	});

	it("independently derives economic_amount via ROUND HALF UP rather than trusting a supplied value", () => {
		expect(sql).toContain(
			"floor(NEW.point_amount * NEW.conversion_rate * 100 + 0.5) / 100",
		);
		expect(sql).toContain("does not match authoritative derivation");
	});

	it("requires a DB-authoritative short-term goal binding for SHORT_TERM_PURCHASE and forbids one otherwise", () => {
		expect(sql).toContain(
			"with category SHORT_TERM_PURCHASE requires short_term_goal_id",
		);
		expect(sql).toContain("is not ACTIVE (found %)");
		expect(sql).toContain("must not have short_term_goal_id");
		expect(sql).toContain("belongs to a different user than reward event %");
	});

	it("enforces exact VOID snapshot copy-forward for every immutable economic/unit/provenance field", () => {
		expect(sql).toContain(
			"VOID revision must copy forward point_amount exactly",
		);
		expect(sql).toContain(
			"VOID revision must copy forward conversion_rate exactly",
		);
		expect(sql).toContain(
			"VOID revision must copy forward economic_amount exactly",
		);
		expect(sql).toContain(
			"VOID revision must copy forward purchase_category exactly",
		);
		expect(sql).toContain(
			"VOID revision must copy forward short_term_goal_id exactly",
		);
		expect(sql).toContain("VOID revision must copy forward merchant exactly");
		expect(sql).toContain(
			"VOID revision must copy forward description exactly",
		);
		expect(sql).toContain(
			"VOID revision must copy forward occurred_at exactly",
		);
		expect(sql).toContain(
			"VOID revision must copy forward source_type exactly",
		);
		expect(sql).toContain("VOID revision must copy forward source_ref exactly");
	});

	it("enforces exact ARCHIVE snapshot copy-forward for reward account config fields", () => {
		expect(sql).toContain(
			"ARCHIVE revision must copy forward display_name exactly",
		);
		expect(sql).toContain(
			"ARCHIVE revision must copy forward provider exactly",
		);
		expect(sql).toContain(
			"ARCHIVE revision must copy forward unit_name exactly",
		);
		expect(sql).toContain(
			"ARCHIVE revision must copy forward default_conversion_rate exactly",
		);
		expect(sql).toContain("ARCHIVE revision must copy forward note exactly");
	});

	it("validates the authoritative expense account and REWARD_BENEFIT account against their full ledger contract", () => {
		expect(sql).toContain(
			"is not a valid EXPENSE/DEBIT account (type %, normal_balance %)",
		);
		expect(sql).toContain(
			"is not a valid INCOME/CREDIT account (type %, normal_balance %)",
		);
		expect(sql).toContain("currency % does not match user currency %");
		expect(sql).toContain("Authoritative expense account % is archived");
		expect(sql).toContain("REWARD_BENEFIT account % is archived");
	});
});
