import { describe, expect, it } from "vitest";
import migration0048Sql from "../migrations/0048_add_credit_card_campaign_tracking.sql?raw";

describe("Campaign Domain Migration 0048 Verification", () => {
	const sql = migration0048Sql;

	it("creates all ten new campaign tables", () => {
		expect(sql).toContain('CREATE TABLE "campaign_families"');
		expect(sql).toContain('CREATE TABLE "campaign_periods"');
		expect(sql).toContain('CREATE TABLE "campaign_period_revisions"');
		expect(sql).toContain('CREATE TABLE "campaign_period_revision_cards"');
		expect(sql).toContain('CREATE TABLE "campaign_source_snapshots"');
		expect(sql).toContain('CREATE TABLE "merchant_aliases"');
		expect(sql).toContain('CREATE TABLE "campaign_purchase_overrides"');
		expect(sql).toContain(
			'CREATE TABLE "campaign_purchase_override_revisions"',
		);
		expect(sql).toContain('CREATE TABLE "campaign_reward_credits"');
		expect(sql).toContain('CREATE TABLE "campaign_reward_credit_revisions"');
	});

	it("enforces INSERT-only immutability on all ten campaign tables", () => {
		expect(sql).toContain("trg_deny_mutation_campaign_families");
		expect(sql).toContain("trg_deny_mutation_campaign_periods");
		expect(sql).toContain("trg_deny_mutation_campaign_period_revisions");
		expect(sql).toContain("trg_deny_mutation_campaign_period_revision_cards");
		expect(sql).toContain("trg_deny_mutation_campaign_source_snapshots");
		expect(sql).toContain("trg_deny_mutation_merchant_aliases");
		expect(sql).toContain("trg_deny_mutation_campaign_purchase_overrides");
		expect(sql).toContain(
			"trg_deny_mutation_campaign_purchase_override_revisions",
		);
		expect(sql).toContain("trg_deny_mutation_campaign_reward_credits");
		expect(sql).toContain("trg_deny_mutation_campaign_reward_credit_revisions");
		expect(sql).toContain("is immutable (INSERT-only)");
	});

	it("enforces the HTTPS-only source URL constraint (Section 7)", () => {
		expect(sql).toContain("campaign_source_snapshots_https_check");
		expect(sql).toContain("LIKE 'https://%'");
	});

	it("enforces the date-window invariant starts_on <= ends_on (Section 11)", () => {
		expect(sql).toContain("campaign_period_revisions_date_window_check");
		expect(sql).toContain(
			'"campaign_period_revisions"."starts_on" <= "campaign_period_revisions"."ends_on"',
		);
	});

	it("enforces exactly one rule mode with correct required/forbidden fields (Section 12-15)", () => {
		expect(sql).toContain("campaign_period_revisions_rule_shape_check");
		expect(sql).toContain("'TOTAL_SPEND'");
		expect(sql).toContain("'TRANSACTION_COUNT'");
		expect(sql).toContain("'REPEATABLE_SPEND'");
	});

	it("enforces reward definition shape per reward kind (Section 17-18)", () => {
		expect(sql).toContain("campaign_period_revisions_reward_shape_check");
		expect(sql).toContain("'REWARD_POINTS'");
	});

	it("enforces merchant scope shape (Section 23)", () => {
		expect(sql).toContain(
			"campaign_period_revisions_merchant_scope_shape_check",
		);
	});

	it("enforces campaign period revision chain + lifecycle transition matrix (Section 4/38)", () => {
		expect(sql).toContain("branching forbidden");
		expect(sql).toContain("CANCELLED is terminal");
		expect(sql).toContain("CONFIRM requires lifecycle_status REVIEW_REQUIRED");
		expect(sql).toContain("AMEND requires lifecycle_status ACTIVE");
		expect(sql).toContain("HIDE requires visibility VISIBLE");
		expect(sql).toContain("RESTORE requires visibility HIDDEN");
		expect(sql).toContain("END requires lifecycle_status ACTIVE");
		expect(sql).toContain(
			"CANCEL requires lifecycle_status REVIEW_REQUIRED or ACTIVE",
		);
	});

	it("rejects HIDE/RESTORE/END/CANCEL from changing economic terms (Section 35)", () => {
		expect(sql).toContain("HIDE must not change economic/rule/reward");
		expect(sql).toContain("RESTORE must not change economic/rule/reward");
		expect(sql).toContain("END must not change economic/rule/reward");
		expect(sql).toContain("CANCEL must not change economic/rule/reward");
	});

	it("rejects CONFIRM changing economic terms (must use AMEND instead)", () => {
		expect(sql).toContain(
			"CONFIRM must not change economic/rule/reward/merchant-scope terms",
		);
	});

	it("requires an ACTIVE/ENDED campaign period revision to carry at least one linked card (Section 39/40)", () => {
		expect(sql).toContain(
			"trg_fn_guard_campaign_period_card_scope_completeness",
		);
		expect(sql).toContain("has zero linked cards at commit");
	});

	it("enforces credit card ownership on campaign_period_revision_cards (Section 40)", () => {
		expect(sql).toContain("does not belong to campaign period user");
	});

	it("enforces naked anchor rejection for family/period/override/credit (Section 37)", () => {
		expect(sql).toContain("naked family anchor");
		expect(sql).toContain("naked period anchor");
		expect(sql).toContain("naked override anchor");
		expect(sql).toContain("naked credit anchor");
	});

	it("enforces override purchase identity + card scope binding (Section 26/42)", () => {
		expect(sql).toContain("is not a PURCHASE identity");
		expect(sql).toContain("is not within campaign period");
		expect(sql).toContain("card scope");
	});

	it("enforces reward account ownership on campaign period revisions (Section 41)", () => {
		expect(sql).toContain(
			"Reward account user_id % does not match revision user_id",
		);
	});

	it("enforces exactly one ACTIVE reward credit identity per campaign period (Section 21/49)", () => {
		expect(sql).toContain("already has an ACTIVE reward credit identity");
	});

	it("enforces exact reward-event provenance binding on campaign reward credits (Section 41)", () => {
		expect(sql).toContain("source_type must be CAMPAIGN");
		expect(sql).toContain("does not match campaign_period_id");
		expect(sql).toContain("does not match actual_point_amount");
		expect(sql).toContain("must have event_type EARN");
	});

	it("enforces VOID-terminal + same-reward-event binding on reward credit revisions (Section 22)", () => {
		expect(sql).toContain("VOID is terminal");
		expect(sql).toContain(
			"VOID revision must reference the same reward_event_id",
		);
		expect(sql).toContain(
			"must already be VOID before recording campaign credit VOID",
		);
	});
});
