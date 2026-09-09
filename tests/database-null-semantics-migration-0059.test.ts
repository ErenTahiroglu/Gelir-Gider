import { describe, expect, it } from "vitest";
import journal from "../migrations/meta/_journal.json";

describe("Database Null-Semantics & Migration 0059 Effective Function Audit", () => {
	// Reconstruct the final effective function definition for every function across all migrations in journal order using Vite eager glob
	const migrationFiles = (
		import.meta as unknown as {
			glob: (
				pattern: string,
				options: Record<string, unknown>,
			) => Record<string, string>;
		}
	).glob("../migrations/*.sql", {
		query: "?raw",
		import: "default",
		eager: true,
	});

	const effectiveFunctions = new Map<
		string,
		{ migration: string; body: string }
	>();

	const entries = journal.entries as Array<{
		idx: number;
		when: number;
		tag: string;
	}>;

	for (const entry of entries) {
		const key = `../migrations/${entry.tag}.sql`;
		const content = migrationFiles[key];
		if (!content) continue;
		const chunks = content.split(/-->\s*statement-breakpoint/);

		for (const chunk of chunks) {
			const match = chunk.match(
				/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-zA-Z0-9_]+)/i,
			);
			if (match?.[1]) {
				effectiveFunctions.set(match[1], {
					migration: entry.tag,
					body: chunk,
				});
			}
		}
	}

	it("audited all database functions and confirmed total count is 170", () => {
		// 147 through migration 0060; +3 in migration 0061 (PERSONAL_BUDGET_V2
		// foundation: two immutability guards + one revision insert guard);
		// +1 in migration 0062 (the V2 anchor BEFORE INSERT guard);
		// +4 in migration 0063 (two Budget V2 semantic classification domains,
		// each with an immutability guard + a BEFORE INSERT guard);
		// +2 in migration 0064 (basic-living config: one immutability guard +
		// one BEFORE INSERT chain guard);
		// +5 in migration 0065 (credit-card statement reconciliation: one shared
		// immutability guard + anchor / revision / component / seal insert guards).
		// 0066 CREATE OR REPLACEs an existing function (trg_fn_guard_ccsrc_insert)
		// -- no new function name, so the count is unchanged.
		// +2 in migration 0067 (spending food semantics: one immutability guard +
		// one BEFORE INSERT subject/chain guard).
		// +4 in migration 0068 (durable checkpoint persistence: one SHARED
		// immutability guard for all three tables + one BEFORE INSERT guard each
		// for the trigger-card / request / snapshot tables).
		// 0069 CREATE OR REPLACEs an existing function
		// (trg_fn_guard_bv2ckreq_insert) -- no new function name, so the count
		// is unchanged.
		// +2 in migration 0070 (surplus-use attribution: one immutability guard +
		// one BEFORE INSERT subject/period/chain guard).
		expect(effectiveFunctions.size).toBe(170);
	});

	it("migration 0070 contributes exactly the two surplus-use attribution guard functions", () => {
		for (const fnName of [
			"trg_fn_guard_bv2surplus_revisions_immutability",
			"trg_fn_guard_bv2surplus_revisions_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0070_add_budget_v2_surplus_use_attribution",
			);
		}
	});

	it("migration 0068 defines the durable-checkpoint guard functions (request guard later hardened by 0069)", () => {
		for (const fnName of [
			"trg_fn_guard_bv2ckpt_immutability",
			"trg_fn_guard_bv2ckcard_revisions_insert",
			"trg_fn_guard_bv2cksnap_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0068_add_budget_v2_checkpoint_persistence",
			);
		}
	});

	it("migration 0069 provides the effective version of trg_fn_guard_bv2ckreq_insert (request-provenance hardening)", () => {
		const fn = effectiveFunctions.get("trg_fn_guard_bv2ckreq_insert");
		expect(fn?.migration).toBe("0069_harden_budget_v2_checkpoint_persistence");
		expect(fn?.body).toContain("Europe/Istanbul");
		expect(fn?.body).toContain("checkpoint_at % does not match payment event");
		expect(fn?.body).toContain(
			"is not the config effective at the payment instant",
		);
	});

	it("migration 0064 contributes exactly the two basic-living config guard functions", () => {
		for (const fnName of [
			"trg_fn_guard_bv2bl_revisions_immutability",
			"trg_fn_guard_bv2bl_revisions_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0064_add_budget_basic_living_config",
			);
		}
	});

	it("migration 0065 defines the statement-reconciliation guard functions (component guard later hardened by 0066)", () => {
		for (const fnName of [
			"trg_fn_guard_ccsr_immutability",
			"trg_fn_guard_ccsr_anchor_insert",
			"trg_fn_guard_ccsrr_insert",
			"trg_fn_guard_ccsr_seal_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0065_add_credit_card_statement_reconciliation",
			);
		}
	});

	it("migration 0066 provides the effective version of trg_fn_guard_ccsrc_insert (split-consistency hardening)", () => {
		const fn = effectiveFunctions.get("trg_fn_guard_ccsrc_insert");
		expect(fn?.migration).toBe(
			"0066_harden_statement_reconciliation_split_consistency",
		);
		expect(fn?.body).toContain("has no active split");
		expect(fn?.body).toContain("is not a participant of split revision");
	});

	it("migration 0067 contributes exactly the two spending-food semantic guard functions", () => {
		for (const fnName of [
			"trg_fn_guard_bv2food_revisions_immutability",
			"trg_fn_guard_bv2food_revisions_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0067_add_budget_v2_spending_food_semantics",
			);
		}
	});

	it("migration 0063 contributes exactly the four Budget V2 semantic guard functions", () => {
		for (const fnName of [
			"trg_fn_guard_irbv2sem_revisions_immutability",
			"trg_fn_guard_irbv2sem_revisions_insert",
			"trg_fn_guard_stgbv2purpose_revisions_immutability",
			"trg_fn_guard_stgbv2purpose_revisions_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0063_add_budget_v2_semantic_classifications",
			);
		}
	});

	it("migration 0061 contributes exactly the three new V2 budget guard functions", () => {
		for (const fnName of [
			"trg_fn_guard_monthly_budget_v2_plans_immutability",
			"trg_fn_guard_monthly_budget_v2_plan_revisions_immutability",
			"trg_fn_guard_monthly_budget_v2_plan_revisions_insert",
		]) {
			expect(effectiveFunctions.get(fnName)?.migration).toBe(
				"0061_add_budget_policy_v2_foundation",
			);
		}
	});

	it("migration 0062 contributes exactly the V2 anchor insert guard function", () => {
		expect(
			effectiveFunctions.get("trg_fn_guard_monthly_budget_v2_plans_insert")
				?.migration,
		).toBe("0062_harden_budget_v2_anchor_insert");
	});

	it("confirms migration 0059 defines the latest active version of all 8 target functions", () => {
		const targetFunctions = [
			"trg_fn_guard_person_obligation_revision_insert",
			"trg_fn_guard_person_settlement_revision_insert",
			"trg_fn_guard_person_obligation_ledger_effect",
			"trg_fn_guard_cc_split_commit_check",
			"trg_fn_guard_reward_event_revision_insert",
			"trg_fn_long_term_validate_send_payload",
			"trg_fn_notification_validate_credit_card_due_payload",
			"trg_fn_guard_campaign_review_candidate_revision_insert",
		];

		for (const fnName of targetFunctions) {
			const fn = effectiveFunctions.get(fnName);
			expect(fn).toBeDefined();
			expect(fn?.migration).toBe(
				"0059_harden_remaining_database_null_semantics",
			);
		}
	});

	it("guarantees 0 fail-open NULL guards in all final effective functions across the entire schema", () => {
		const unsafeBareTypeofRegex =
			/(?<!COALESCE\()jsonb_typeof\((?:v_can_rev\.payload|payload|p_payload|NEW\.[a-zA-Z0-9_]+)(?:->'[^']+')+\)\s*!=\s*'(string|number|object|array)'/g;

		const violations: Array<{
			function: string;
			migration: string;
			match: string;
		}> = [];

		for (const [fnName, fnData] of effectiveFunctions.entries()) {
			// Strip SQL comments
			const codeWithoutComments = fnData.body
				.replace(/--.*$/gm, "")
				.replace(/\/\*[\s\S]*?\*\//g, "");

			const matches = codeWithoutComments.match(unsafeBareTypeofRegex);
			if (matches) {
				for (const m of matches) {
					// Check if this match is already guarded by an explicit "IS NOT NULL AND" on the same key
					const isGuardedByAnd = codeWithoutComments.includes(
						`IS NOT NULL AND ${m}`,
					);
					if (!isGuardedByAnd) {
						violations.push({
							function: fnName,
							migration: fnData.migration,
							match: m,
						});
					}
				}
			}
		}

		expect(violations).toEqual([]);
	});

	describe("Domain 1: People Obligation Revisions (trg_fn_guard_person_obligation_revision_insert)", () => {
		const fn = () =>
			effectiveFunctions.get("trg_fn_guard_person_obligation_revision_insert")
				?.body ?? "";

		it("enforces fail-closed string checks with COALESCE on all canonical payload required keys", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'obligationId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'personId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'direction'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'amount'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'fundingAssetAccountId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'expenseAccountId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'splitRevisionId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'splitId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'purchaseEventId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'splitParticipantId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'budgetCategory'), '') != 'string'",
			);
		});

		it("correctly handles optional nullable fields (dueDate, description) without fail-open paths", () => {
			const body = fn();
			expect(body).toContain(
				"IF v_can_rev.payload->'dueDate' IS NOT NULL AND COALESCE(jsonb_typeof(v_can_rev.payload->'dueDate'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'dueDate'), '') != 'string'",
			);
			expect(body).toContain(
				"IF v_can_rev.payload->'description' IS NOT NULL AND COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'string'",
			);
		});
	});

	describe("Domain 2: People Settlement Revisions (trg_fn_guard_person_settlement_revision_insert)", () => {
		const fn = () =>
			effectiveFunctions.get("trg_fn_guard_person_settlement_revision_insert")
				?.body ?? "";

		it("enforces fail-closed string checks with COALESCE on all canonical settlement payload keys", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'settlementId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'obligationId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'personId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'direction'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'appliedAmount'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'cashAmount'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'excessAmount'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'assetAccountId'), '') != 'string'",
			);
		});

		it("correctly handles optional nullable note field", () => {
			const body = fn();
			expect(body).toContain(
				"IF v_can_rev.payload->'note' IS NOT NULL AND COALESCE(jsonb_typeof(v_can_rev.payload->'note'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'note'), '') != 'string'",
			);
		});
	});

	describe("Domain 3: People Obligation Ledger Effect (trg_fn_guard_person_obligation_ledger_effect)", () => {
		const fn = () =>
			effectiveFunctions.get("trg_fn_guard_person_obligation_ledger_effect")
				?.body ?? "";

		it("uses null-safe relational matching IS DISTINCT FROM for split expense account check", () => {
			const body = fn();
			expect(body).toContain(
				"IF v_cr_account IS DISTINCT FROM (v_can_rev.payload->>'expenseAccountId')::uuid THEN",
			);
		});
	});

	describe("Domain 4: Credit Card Split Commit Check (trg_fn_guard_cc_split_commit_check)", () => {
		const fn = () =>
			effectiveFunctions.get("trg_fn_guard_cc_split_commit_check")?.body ?? "";

		it("uses COALESCE for payload text comparisons against split provenance keys", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(v_obl_payload->>'splitParticipantId', '') != v_any_participant.id::text",
			);
			expect(body).toContain(
				"COALESCE(v_obl_payload->>'splitId', '') != v_split.id::text",
			);
			expect(body).toContain(
				"COALESCE(v_obl_payload->>'purchaseEventId', '') != v_split.purchase_event_id::text",
			);
			expect(body).toContain(
				"IF v_can_kind IS DISTINCT FROM 'CREDIT_CARD_PURCHASE_SPLIT' THEN",
			);
		});
	});

	describe("Domain 5: Reward Events (trg_fn_guard_reward_event_revision_insert)", () => {
		const fn = () =>
			effectiveFunctions.get("trg_fn_guard_reward_event_revision_insert")
				?.body ?? "";

		it("enforces fail-closed object check and array key presence check on canonical payload", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload), '') != 'object'",
			);
			expect(body).toContain(
				"IF NOT (v_can_rev.payload ?& ARRAY['rewardEventId', 'rewardAccountId', 'points', 'conversionRate', 'economicAmount', 'purchaseCategory', 'shortTermGoalId', 'merchant', 'description'])",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'rewardEventId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'rewardAccountId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'points'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'conversionRate'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'economicAmount'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'purchaseCategory'), '') != 'string'",
			);
		});

		it("enforces explicit JSON null semantics for optional fields (shortTermGoalId, merchant, description)", () => {
			const body = fn();
			expect(body).toContain(
				"IF COALESCE(jsonb_typeof(v_can_rev.payload->'shortTermGoalId'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'shortTermGoalId'), '') != 'string'",
			);
			expect(body).toContain(
				"IF COALESCE(jsonb_typeof(v_can_rev.payload->'merchant'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'merchant'), '') != 'string'",
			);
			expect(body).toContain(
				"IF COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(v_can_rev.payload->'description'), '') != 'string'",
			);
		});
	});

	describe("Domain 6: Long-Term Send Tasks (trg_fn_long_term_validate_send_payload)", () => {
		const fn = () =>
			effectiveFunctions.get("trg_fn_long_term_validate_send_payload")?.body ??
			"";

		it("enforces key presence and fail-closed typing across all send payload parameters", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload), '') != 'object'",
			);
			expect(body).toContain(
				"p_payload ? 'taskId' AND p_payload ? 'midasAccountId' AND p_payload ? 'pendingBucketId'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'taskId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'midasAccountId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'pendingBucketId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'amount'), '') != 'string'",
			);
			expect(body).toContain(
				"IF COALESCE(jsonb_typeof(p_payload->'destinationLabel'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'destinationLabel'), '') != 'string'",
			);
			expect(body).toContain(
				"IF COALESCE(jsonb_typeof(p_payload->'note'), '') != 'null'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'note'), '') != 'string'",
			);
		});
	});

	describe("Domain 7: Notifications (trg_fn_notification_validate_credit_card_due_payload)", () => {
		const fn = () =>
			effectiveFunctions.get(
				"trg_fn_notification_validate_credit_card_due_payload",
			)?.body ?? "";

		it("enforces object typing, key presence, and fail-closed nested data key checks", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload), '') != 'object'",
			);
			expect(body).toContain(
				"p_payload ? 'title' AND p_payload ? 'body' AND p_payload ? 'data'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'title'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'body'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'data'), '') != 'object'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'data'->'type'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'data'->'statementId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'data'->'creditCardId'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'data'->'dueDate'), '') != 'string'",
			);
			expect(body).toContain(
				"COALESCE(jsonb_typeof(p_payload->'data'->'deepLink'), '') != 'string'",
			);
		});
	});

	describe("Domain 8: Campaign Review Candidates (trg_fn_guard_campaign_review_candidate_revision_insert)", () => {
		const fn = () =>
			effectiveFunctions.get(
				"trg_fn_guard_campaign_review_candidate_revision_insert",
			)?.body ?? "";

		it("enforces fail-closed array typing and null-safe copy-forward comparisons", () => {
			const body = fn();
			expect(body).toContain(
				"COALESCE(jsonb_typeof(NEW.proposed_card_ids), '') != 'array'",
			);
			expect(body).toContain(
				"NEW.proposed_card_ids IS NOT DISTINCT FROM v_latest.proposed_card_ids",
			);
		});
	});
});
