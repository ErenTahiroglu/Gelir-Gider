import { describe, expect, it } from "vitest";
import migration0040Sql from "../migrations/0040_giant_power_pack.sql?raw";

describe("Rewards Domain Migration 0040 Verification (Phase 12-R2 Hardening)", () => {
	const sql = migration0040Sql;

	it("drops the old all-time opening unique index forward-only", () => {
		expect(sql).toContain(
			'DROP INDEX IF EXISTS "reward_events_account_opening_idx"',
		);
	});

	it("enforces serialized active-opening check inside event revision guard", () => {
		expect(sql).toContain("already has an active OPENING_BALANCE event %");
		expect(sql).toContain("re.event_type = 'OPENING_BALANCE'");
		expect(sql).toContain("!= 'VOID'");
	});

	it("enforces purchase_category NOT NULL on REDEEM_PURCHASE revisions without COALESCE fallback", () => {
		expect(sql).toContain(
			"REDEEM_PURCHASE reward event % requires purchase_category",
		);
		expect(sql).toContain("Reward purchase has unknown purchase_category %");
		expect(sql).not.toContain(
			"COALESCE(NEW.purchase_category, 'UNCLASSIFIED')",
		);
	});

	it("enforces exact 9-key canonical payload key set", () => {
		expect(sql).toContain(
			"REWARD_FUNDED_PURCHASE canonical payload must contain exactly 9 keys",
		);
		expect(sql).toContain(
			"ARRAY['rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description']",
		);
		expect(sql).toContain(
			"REWARD_FUNDED_PURCHASE canonical payload is missing required keys",
		);
	});

	it("validates that purchaseCategory in canonical payload is a matching non-null string", () => {
		expect(sql).toContain(
			"jsonb_typeof(v_can_rev.payload->'purchaseCategory') != 'string'",
		);
		expect(sql).toContain(
			"Canonical payload purchaseCategory % does not match revision purchase_category %",
		);
	});

	it("validates nullable canonical keys are present as json null when revision columns are null", () => {
		expect(sql).toContain(
			"Canonical payload shortTermGoalId must be null when revision short_term_goal_id is null",
		);
		expect(sql).toContain(
			"Canonical payload merchant must be null when revision merchant is null",
		);
		expect(sql).toContain(
			"Canonical payload description must be null when revision description is null",
		);
	});
});
