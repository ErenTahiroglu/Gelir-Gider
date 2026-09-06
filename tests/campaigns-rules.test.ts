import { describe, expect, it } from "vitest";
import { CampaignError } from "../src/campaigns/errors";
import {
	applyPurchaseOverride,
	computeRuleProgress,
	deriveAutomaticEligibility,
	detectCampaignPeriodReset,
	purchaseCountsTowardProgress,
	validateCampaignRewardShape,
	validateCampaignRuleShape,
} from "../src/campaigns/rules";

describe("validateCampaignRuleShape", () => {
	it("accepts a valid TOTAL_SPEND shape", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "TOTAL_SPEND",
				targetSpendAmountCents: 500_000n,
				requiredTransactionCount: null,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: null,
				rewardPointsPerStepUnits: null,
				maxSteps: null,
			}),
		).not.toThrow();
	});

	it("rejects TOTAL_SPEND missing target", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "TOTAL_SPEND",
				targetSpendAmountCents: null,
				requiredTransactionCount: null,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: null,
				rewardPointsPerStepUnits: null,
				maxSteps: null,
			}),
		).toThrow(CampaignError);
	});

	it("rejects TOTAL_SPEND with a stray transaction-count field", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "TOTAL_SPEND",
				targetSpendAmountCents: 500_000n,
				requiredTransactionCount: 3,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: null,
				rewardPointsPerStepUnits: null,
				maxSteps: null,
			}),
		).toThrow(CampaignError);
	});

	it("accepts a valid TRANSACTION_COUNT shape with optional minimum", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "TRANSACTION_COUNT",
				targetSpendAmountCents: null,
				requiredTransactionCount: 3,
				minimumTransactionAmountCents: 10_000n,
				stepSpendAmountCents: null,
				rewardPointsPerStepUnits: null,
				maxSteps: null,
			}),
		).not.toThrow();
	});

	it("rejects TRANSACTION_COUNT with invalid count", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "TRANSACTION_COUNT",
				targetSpendAmountCents: null,
				requiredTransactionCount: 0,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: null,
				rewardPointsPerStepUnits: null,
				maxSteps: null,
			}),
		).toThrow(CampaignError);
	});

	it("accepts a valid REPEATABLE_SPEND shape", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "REPEATABLE_SPEND",
				targetSpendAmountCents: null,
				requiredTransactionCount: null,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: 100_000n,
				rewardPointsPerStepUnits: 1_000_000n,
				maxSteps: 5,
			}),
		).not.toThrow();
	});

	it("rejects REPEATABLE_SPEND with invalid step/reward/maxSteps", () => {
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "REPEATABLE_SPEND",
				targetSpendAmountCents: null,
				requiredTransactionCount: null,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: 0n,
				rewardPointsPerStepUnits: 1_000_000n,
				maxSteps: 5,
			}),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "REPEATABLE_SPEND",
				targetSpendAmountCents: null,
				requiredTransactionCount: null,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: 100_000n,
				rewardPointsPerStepUnits: 0n,
				maxSteps: 5,
			}),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignRuleShape({
				ruleMode: "REPEATABLE_SPEND",
				targetSpendAmountCents: null,
				requiredTransactionCount: null,
				minimumTransactionAmountCents: null,
				stepSpendAmountCents: 100_000n,
				rewardPointsPerStepUnits: 1_000_000n,
				maxSteps: 0,
			}),
		).toThrow(CampaignError);
	});
});

describe("validateCampaignRewardShape", () => {
	it("REWARD_POINTS + TOTAL_SPEND requires fixed expectedRewardPoints", () => {
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "REWARD_POINTS",
				ruleMode: "TOTAL_SPEND",
				rewardAccountId: "acct-1",
				expectedRewardPointsUnits: null,
			}),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "REWARD_POINTS",
				ruleMode: "TOTAL_SPEND",
				rewardAccountId: "acct-1",
				expectedRewardPointsUnits: 5_000_000n,
			}),
		).not.toThrow();
	});

	it("REWARD_POINTS + REPEATABLE_SPEND must NOT set a fixed expectedRewardPoints", () => {
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "REWARD_POINTS",
				ruleMode: "REPEATABLE_SPEND",
				rewardAccountId: "acct-1",
				expectedRewardPointsUnits: 5_000_000n,
			}),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "REWARD_POINTS",
				ruleMode: "REPEATABLE_SPEND",
				rewardAccountId: "acct-1",
				expectedRewardPointsUnits: null,
			}),
		).not.toThrow();
	});

	it("REWARD_POINTS requires a reward account", () => {
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "REWARD_POINTS",
				ruleMode: "TOTAL_SPEND",
				rewardAccountId: null,
				expectedRewardPointsUnits: 5_000_000n,
			}),
		).toThrow(CampaignError);
	});

	it("STATEMENT_CREDIT/INFORMATIONAL must not bind a reward account", () => {
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "STATEMENT_CREDIT",
				ruleMode: "TOTAL_SPEND",
				rewardAccountId: "acct-1",
				expectedRewardPointsUnits: null,
			}),
		).toThrow(CampaignError);
		expect(() =>
			validateCampaignRewardShape({
				rewardKind: "INFORMATIONAL",
				ruleMode: "TOTAL_SPEND",
				rewardAccountId: null,
				expectedRewardPointsUnits: null,
			}),
		).not.toThrow();
	});
});

// Section 53: merchant / MCC review matrix.
describe("deriveAutomaticEligibility (Section 53 matrix)", () => {
	it("ALL_MERCHANTS with no MCC requirement is AUTO_ELIGIBLE", () => {
		expect(
			deriveAutomaticEligibility({
				merchantScopeMode: "ALL_MERCHANTS",
				merchantResolvedMatch: null,
				mccRequired: false,
				amountCents: 10_000n,
				minimumTransactionAmountCents: null,
			}),
		).toBe("AUTO_ELIGIBLE");
	});

	it("MANUAL_REVIEW_REQUIRED is always NEEDS_REVIEW", () => {
		expect(
			deriveAutomaticEligibility({
				merchantScopeMode: "MANUAL_REVIEW_REQUIRED",
				merchantResolvedMatch: null,
				mccRequired: false,
				amountCents: 10_000n,
				minimumTransactionAmountCents: null,
			}),
		).toBe("NEEDS_REVIEW");
	});

	it("MERCHANT_ALIASES matching alias is AUTO_ELIGIBLE", () => {
		expect(
			deriveAutomaticEligibility({
				merchantScopeMode: "MERCHANT_ALIASES",
				merchantResolvedMatch: true,
				mccRequired: false,
				amountCents: 10_000n,
				minimumTransactionAmountCents: null,
			}),
		).toBe("AUTO_ELIGIBLE");
	});

	it("MERCHANT_ALIASES non-matching alias is AUTO_INELIGIBLE", () => {
		expect(
			deriveAutomaticEligibility({
				merchantScopeMode: "MERCHANT_ALIASES",
				merchantResolvedMatch: false,
				mccRequired: false,
				amountCents: 10_000n,
				minimumTransactionAmountCents: null,
			}),
		).toBe("AUTO_INELIGIBLE");
	});

	it("MCC-required purchase with no authoritative MCC is NEEDS_REVIEW (never guessed)", () => {
		expect(
			deriveAutomaticEligibility({
				merchantScopeMode: "ALL_MERCHANTS",
				merchantResolvedMatch: null,
				mccRequired: true,
				amountCents: 10_000n,
				minimumTransactionAmountCents: null,
			}),
		).toBe("NEEDS_REVIEW");
	});

	it("below minimumTransactionAmount is AUTO_INELIGIBLE", () => {
		expect(
			deriveAutomaticEligibility({
				merchantScopeMode: "ALL_MERCHANTS",
				merchantResolvedMatch: null,
				mccRequired: false,
				amountCents: 500n,
				minimumTransactionAmountCents: 1_000n,
			}),
		).toBe("AUTO_INELIGIBLE");
	});
});

describe("applyPurchaseOverride / purchaseCountsTowardProgress", () => {
	it("manual INCLUDE counts even if automatic was ineligible", () => {
		const status = applyPurchaseOverride("AUTO_INELIGIBLE", "INCLUDE");
		expect(status).toBe("MANUAL_INCLUDED");
		expect(purchaseCountsTowardProgress(status)).toBe(true);
	});

	it("manual EXCLUDE never counts even if automatic was eligible", () => {
		const status = applyPurchaseOverride("AUTO_ELIGIBLE", "EXCLUDE");
		expect(status).toBe("MANUAL_EXCLUDED");
		expect(purchaseCountsTowardProgress(status)).toBe(false);
	});

	it("CLEAR (or no override) returns to the automatic derived state", () => {
		expect(applyPurchaseOverride("AUTO_ELIGIBLE", null)).toBe("AUTO_ELIGIBLE");
		expect(applyPurchaseOverride("NEEDS_REVIEW", null)).toBe("NEEDS_REVIEW");
	});

	it("NEEDS_REVIEW does not count until resolved", () => {
		expect(purchaseCountsTowardProgress("NEEDS_REVIEW")).toBe(false);
	});
});

// Section 13/14/15/50/51/52: rule progress + gross-vs-split regression.
describe("computeRuleProgress", () => {
	it("TOTAL_SPEND: target 5000, purchases 2000+1500+1500 -> qualified", () => {
		const progress = computeRuleProgress({
			ruleMode: "TOTAL_SPEND",
			countedAmountsCents: [200_000n, 150_000n, 150_000n],
			targetSpendAmountCents: 500_000n,
			requiredTransactionCount: null,
			stepSpendAmountCents: null,
			maxSteps: null,
		});
		expect(progress.eligibleSpendCents).toBe(500_000n);
		expect(progress.qualified).toBe(true);
	});

	it("TOTAL_SPEND: below target is not qualified", () => {
		const progress = computeRuleProgress({
			ruleMode: "TOTAL_SPEND",
			countedAmountsCents: [200_000n],
			targetSpendAmountCents: 500_000n,
			requiredTransactionCount: null,
			stepSpendAmountCents: null,
			maxSteps: null,
		});
		expect(progress.qualified).toBe(false);
	});

	it("TRANSACTION_COUNT: required 3, three counted purchases -> qualified", () => {
		const progress = computeRuleProgress({
			ruleMode: "TRANSACTION_COUNT",
			countedAmountsCents: [10_000n, 20_000n, 30_000n],
			targetSpendAmountCents: null,
			requiredTransactionCount: 3,
			stepSpendAmountCents: null,
			maxSteps: null,
		});
		expect(progress.eligibleTransactionCount).toBe(3);
		expect(progress.qualified).toBe(true);
	});

	it("REPEATABLE_SPEND: 3450 total, step 1000, max 5 -> 3 steps, not overshooting", () => {
		const progress = computeRuleProgress({
			ruleMode: "REPEATABLE_SPEND",
			countedAmountsCents: [345_000n],
			targetSpendAmountCents: null,
			requiredTransactionCount: null,
			stepSpendAmountCents: 100_000n,
			maxSteps: 5,
		});
		expect(progress.stepsEarnedUnits).toBe(3n);
		expect(progress.qualified).toBe(true);
	});

	// Section 51: split purchase regression -- gross card amount, not the
	// post-split personal expense share, is what's summed here. This test
	// documents the CONTRACT the caller (progress.ts) must uphold: it must
	// pass CreditCardPurchaseRecord.amount (gross), never
	// personalExpenseAmount, into countedAmountsCents.
	it("gross card purchase amount counts in full regardless of a family/People split", () => {
		const grossCardPurchase = 300_000n; // 3000.00 TL gross
		// personalExpenseAmount (1000.00 TL) must NEVER be summed here.
		const progress = computeRuleProgress({
			ruleMode: "TOTAL_SPEND",
			countedAmountsCents: [grossCardPurchase],
			targetSpendAmountCents: 300_000n,
			requiredTransactionCount: null,
			stepSpendAmountCents: null,
			maxSteps: null,
		});
		expect(progress.eligibleSpendCents).toBe(300_000n);
		expect(progress.qualified).toBe(true);
	});

	// Section 52: UPDATE/VOID matrix -- progress must reflect only the
	// currently-counted set (caller re-derives from latest purchase revisions
	// on every read; this test documents that an empty counted set, as would
	// result from a VOID, yields zero progress).
	it("an empty counted set (as after a VOID) yields zero progress", () => {
		const progress = computeRuleProgress({
			ruleMode: "TOTAL_SPEND",
			countedAmountsCents: [],
			targetSpendAmountCents: 500_000n,
			requiredTransactionCount: null,
			stepSpendAmountCents: null,
			maxSteps: null,
		});
		expect(progress.eligibleSpendCents).toBe(0n);
		expect(progress.qualified).toBe(false);
	});

	it("an updated (reduced) purchase amount changes counted total exactly", () => {
		// Purchase originally 2000, updated to 1200: the caller re-reads the
		// LATEST revision amount only -- only 1200 ever appears here.
		const progress = computeRuleProgress({
			ruleMode: "TOTAL_SPEND",
			countedAmountsCents: [120_000n],
			targetSpendAmountCents: 500_000n,
			requiredTransactionCount: null,
			stepSpendAmountCents: null,
			maxSteps: null,
		});
		expect(progress.eligibleSpendCents).toBe(120_000n);
	});
});

// Section 36/55: reset detection matrix.
describe("detectCampaignPeriodReset", () => {
	it("detects a reset when the period key changes (Sep -> Oct)", () => {
		expect(
			detectCampaignPeriodReset({
				currentPeriodKey: "2024-09",
				currentEndsOn: "2024-09-30",
				candidatePeriodKey: "2024-10",
				candidateStartsOn: "2024-10-01",
			}),
		).toBe(true);
	});

	it("detects a reset when a later non-overlapping window appears under the same key", () => {
		expect(
			detectCampaignPeriodReset({
				currentPeriodKey: "recurring",
				currentEndsOn: "2024-09-30",
				candidatePeriodKey: "recurring",
				candidateStartsOn: "2024-10-01",
			}),
		).toBe(true);
	});

	it("does not detect a reset for the same period key and overlapping/prior window", () => {
		expect(
			detectCampaignPeriodReset({
				currentPeriodKey: "2024-09",
				currentEndsOn: "2024-09-30",
				candidatePeriodKey: "2024-09",
				candidateStartsOn: "2024-09-01",
			}),
		).toBe(false);
	});
});
