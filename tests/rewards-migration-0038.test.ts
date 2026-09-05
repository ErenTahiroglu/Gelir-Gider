import { describe, expect, it } from "vitest";
import migration0038Sql from "../migrations/0038_add_rewards_domain.sql?raw";

describe("Rewards Domain Migration 0038 Verification", () => {
	const sql = migration0038Sql;

	it("creates the four reward tables", () => {
		expect(sql).toContain('CREATE TABLE "reward_accounts"');
		expect(sql).toContain('CREATE TABLE "reward_account_revisions"');
		expect(sql).toContain('CREATE TABLE "reward_events"');
		expect(sql).toContain('CREATE TABLE "reward_event_revisions"');
	});

	it("enforces INSERT-only immutability on all four reward tables", () => {
		expect(sql).toContain("trg_deny_mutation_reward_accounts");
		expect(sql).toContain("trg_deny_mutation_reward_account_revisions");
		expect(sql).toContain("trg_deny_mutation_reward_events");
		expect(sql).toContain("trg_deny_mutation_reward_event_revisions");
		expect(sql).toContain("is immutable (INSERT-only)");
	});

	it("enforces a same-row CHECK binding canonical_transaction_id to event_type (REDEEM_PURCHASE only)", () => {
		expect(sql).toContain("reward_events_canonical_binding_check");
	});

	it("restricts a reward account to at most one OPENING_BALANCE event via a DB unique index", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "reward_events_account_opening_idx"',
		);
	});

	it("enforces reward account revision chain integrity and status lifecycle (CREATE -> UPDATE* -> ARCHIVE terminal)", () => {
		expect(sql).toContain("branching forbidden");
		expect(sql).toContain("ARCHIVE is terminal");
		expect(sql).toContain("UPDATE revision must keep status ACTIVE");
		expect(sql).toContain("ARCHIVE revision must set status ARCHIVED");
	});

	it("enforces reward event revision chain integrity (CREATE then at most one terminal VOID, no UPDATE)", () => {
		expect(sql).toContain("VOID is terminal");
		expect(sql).toContain(
			"Only VOID is permitted as a subsequent reward event revision",
		);
	});

	it("rejects fresh reward event mutation on a non-ACTIVE reward account", () => {
		expect(sql).toContain(
			"Cannot mutate reward event for non-ACTIVE reward account",
		);
	});

	it("enforces non-economic event fields must be NULL (no fake canonical/ledger transactions)", () => {
		expect(sql).toContain(
			"Non-economic reward event % must have economic_amount NULL",
		);
		expect(sql).toContain(
			"Non-economic reward event % must have purchase_category NULL",
		);
		expect(sql).toContain(
			"Non-economic reward event % must have short_term_goal_id NULL",
		);
		expect(sql).toContain(
			"Non-economic reward event % must have canonical_revision_id NULL",
		);
	});

	it("requires REDEEM_PURCHASE to carry all financial companion fields and exact canonical payload binding", () => {
		expect(sql).toContain(
			"REDEEM_PURCHASE reward event % requires economic_amount",
		);
		expect(sql).toContain(
			"REDEEM_PURCHASE reward event % requires canonical_revision_id",
		);
		expect(sql).toContain("canonical transaction % has wrong kind");
		expect(sql).toContain(
			"Unexpected key % in REWARD_FUNDED_PURCHASE canonical payload",
		);
		expect(sql).toContain("payload rewardEventId");
		expect(sql).toContain("payload rewardAccountId");
		expect(sql).toContain("payload points");
		expect(sql).toContain("payload conversionRate");
		expect(sql).toContain("payload economicAmount");
	});

	it("requires the exact 2-line ledger binding (expense debit, REWARD_BENEFIT credit) for a fresh reward purchase", () => {
		expect(sql).toContain("applied journal must have exactly 2 lines");
		expect(sql).toContain("is not the authoritative expense account");
		expect(sql).toContain("is not the REWARD_BENEFIT account");
		expect(sql).toContain("SYS_REWARD_BENEFIT");
	});

	it("rejects naked reward account and naked reward event anchors at commit", () => {
		expect(sql).toContain("naked account anchor");
		expect(sql).toContain("naked event anchor");
	});

	it("enforces point balance non-negativity and the archive-zero-balance gate, deferred and order-independent", () => {
		expect(sql).toContain("point balance would become negative");
		expect(sql).toContain(
			"Cannot archive reward account % with non-zero point balance",
		);
		expect(sql).toContain('AFTER INSERT ON "reward_account_revisions"');
		expect(sql).toContain('AFTER INSERT ON "reward_event_revisions"');
	});

	it("rejects an orphan canonical REWARD_FUNDED_PURCHASE transaction with no companion reward event", () => {
		expect(sql).toContain("has no linked reward_events anchor at commit");
		expect(sql).toContain("has no linked reward_event_revisions row at commit");
	});
});
