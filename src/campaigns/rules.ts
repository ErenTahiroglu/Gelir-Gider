import { computeRepeatableStepsEarned } from "./decimal";
import { CampaignError } from "./errors";

export type CampaignRuleMode =
	| "TOTAL_SPEND"
	| "TRANSACTION_COUNT"
	| "REPEATABLE_SPEND";

export type CampaignMerchantScopeMode =
	| "ALL_MERCHANTS"
	| "MERCHANT_ALIASES"
	| "MANUAL_REVIEW_REQUIRED";

export type CampaignAutomaticEligibility =
	| "AUTO_ELIGIBLE"
	| "AUTO_INELIGIBLE"
	| "NEEDS_REVIEW";

export type CampaignPurchaseEligibilityStatus =
	| CampaignAutomaticEligibility
	| "MANUAL_INCLUDED"
	| "MANUAL_EXCLUDED";

export type CampaignOverrideOperation = "INCLUDE" | "EXCLUDE" | "CLEAR";

/**
 * Section 12: rule mode must be exactly one of these three. Validates
 * required/forbidden field shape for a candidate rule definition. Pure and
 * DB-independent -- safe to call before any transaction is opened.
 */
export interface CampaignRuleFields {
	ruleMode: CampaignRuleMode;
	targetSpendAmountCents: bigint | null;
	requiredTransactionCount: number | null;
	minimumTransactionAmountCents: bigint | null;
	stepSpendAmountCents: bigint | null;
	rewardPointsPerStepUnits: bigint | null;
	maxSteps: number | null;
}

export function validateCampaignRuleShape(fields: CampaignRuleFields): void {
	const {
		ruleMode,
		targetSpendAmountCents,
		requiredTransactionCount,
		minimumTransactionAmountCents,
		stepSpendAmountCents,
		rewardPointsPerStepUnits,
		maxSteps,
	} = fields;

	if (ruleMode === "TOTAL_SPEND") {
		if (targetSpendAmountCents === null || targetSpendAmountCents <= 0n) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_RULE",
				"TOTAL_SPEND requires targetSpendAmount > 0",
			);
		}
		if (
			requiredTransactionCount !== null ||
			minimumTransactionAmountCents !== null ||
			stepSpendAmountCents !== null ||
			rewardPointsPerStepUnits !== null ||
			maxSteps !== null
		) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_RULE",
				"TOTAL_SPEND must not set transaction-count or repeatable-spend fields",
			);
		}
		return;
	}

	if (ruleMode === "TRANSACTION_COUNT") {
		if (requiredTransactionCount === null || requiredTransactionCount < 1) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_RULE",
				"TRANSACTION_COUNT requires requiredTransactionCount >= 1",
			);
		}
		if (
			minimumTransactionAmountCents !== null &&
			minimumTransactionAmountCents <= 0n
		) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_RULE",
				"minimumTransactionAmount, when supplied, must be > 0",
			);
		}
		if (
			targetSpendAmountCents !== null ||
			stepSpendAmountCents !== null ||
			rewardPointsPerStepUnits !== null ||
			maxSteps !== null
		) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_RULE",
				"TRANSACTION_COUNT must not set total-spend or repeatable-spend fields",
			);
		}
		return;
	}

	// REPEATABLE_SPEND
	if (stepSpendAmountCents === null || stepSpendAmountCents <= 0n) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			"REPEATABLE_SPEND requires stepSpendAmount > 0",
		);
	}
	if (rewardPointsPerStepUnits === null || rewardPointsPerStepUnits <= 0n) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			"REPEATABLE_SPEND requires rewardPointsPerStep > 0",
		);
	}
	if (maxSteps === null || maxSteps < 1) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			"REPEATABLE_SPEND requires maxSteps >= 1",
		);
	}
	if (
		minimumTransactionAmountCents !== null &&
		minimumTransactionAmountCents <= 0n
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			"minimumTransactionAmount, when supplied, must be > 0",
		);
	}
	if (targetSpendAmountCents !== null || requiredTransactionCount !== null) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			"REPEATABLE_SPEND must not set total-spend or transaction-count fields",
		);
	}
}

/**
 * Section 17/18: validates reward definition shape given rule mode + reward
 * kind. Pure and DB-independent.
 */
export function validateCampaignRewardShape(params: {
	rewardKind: "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL";
	ruleMode: CampaignRuleMode;
	rewardAccountId: string | null;
	expectedRewardPointsUnits: bigint | null;
}): void {
	const { rewardKind, ruleMode, rewardAccountId, expectedRewardPointsUnits } =
		params;
	if (rewardKind === "REWARD_POINTS") {
		if (rewardAccountId === null) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				"REWARD_POINTS requires a rewardAccountId",
			);
		}
		if (ruleMode === "REPEATABLE_SPEND") {
			if (expectedRewardPointsUnits !== null) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_INPUT",
					"REPEATABLE_SPEND must not set a fixed expectedRewardPoints; it is derived from rewardPointsPerStep",
				);
			}
		} else if (
			expectedRewardPointsUnits === null ||
			expectedRewardPointsUnits <= 0n
		) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				"REWARD_POINTS requires expectedRewardPoints > 0 for TOTAL_SPEND/TRANSACTION_COUNT",
			);
		}
	} else {
		if (rewardAccountId !== null || expectedRewardPointsUnits !== null) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				"STATEMENT_CREDIT/INFORMATIONAL must not bind a reward account or expected points",
			);
		}
	}
}

/**
 * Derives the automatic (non-manual) eligibility of a single candidate
 * purchase. Manual overrides are applied separately by
 * `applyPurchaseOverride`. Never guesses -- MCC-required campaigns with no
 * authoritative MCC classification always return NEEDS_REVIEW (Section 25).
 */
export function deriveAutomaticEligibility(params: {
	merchantScopeMode: CampaignMerchantScopeMode;
	merchantResolvedMatch: boolean | null;
	mccRequired: boolean;
	amountCents: bigint;
	minimumTransactionAmountCents: bigint | null;
}): CampaignAutomaticEligibility {
	const {
		merchantScopeMode,
		merchantResolvedMatch,
		mccRequired,
		amountCents,
		minimumTransactionAmountCents,
	} = params;

	if (merchantScopeMode === "MANUAL_REVIEW_REQUIRED") {
		return "NEEDS_REVIEW";
	}

	if (merchantScopeMode === "MERCHANT_ALIASES") {
		if (merchantResolvedMatch !== true) {
			return "AUTO_INELIGIBLE";
		}
	}

	if (
		minimumTransactionAmountCents !== null &&
		amountCents < minimumTransactionAmountCents
	) {
		return "AUTO_INELIGIBLE";
	}

	if (mccRequired) {
		// V1 purchase truth has no authoritative MCC classification -- never
		// auto-qualify, never guess from merchant name.
		return "NEEDS_REVIEW";
	}

	return "AUTO_ELIGIBLE";
}

/**
 * Applies the latest manual override (if any) on top of the automatic
 * eligibility derivation. CLEAR (or no override) returns to the automatic
 * state.
 */
export function applyPurchaseOverride(
	automatic: CampaignAutomaticEligibility,
	overrideOp: CampaignOverrideOperation | null,
): CampaignPurchaseEligibilityStatus {
	if (overrideOp === "INCLUDE") return "MANUAL_INCLUDED";
	if (overrideOp === "EXCLUDE") return "MANUAL_EXCLUDED";
	return automatic;
}

/**
 * Section 27: only AUTO_ELIGIBLE and MANUAL_INCLUDED count toward confirmed
 * progress.
 */
export function purchaseCountsTowardProgress(
	status: CampaignPurchaseEligibilityStatus,
): boolean {
	return status === "AUTO_ELIGIBLE" || status === "MANUAL_INCLUDED";
}

export interface CampaignRuleProgress {
	eligibleSpendCents: bigint;
	eligibleTransactionCount: number;
	stepsEarnedUnits: bigint | null;
	qualified: boolean;
}

/**
 * Computes deterministic rule-mode progress from the set of counted eligible
 * purchases (already filtered by purchaseCountsTowardProgress). Never uses
 * JS float.
 */
export function computeRuleProgress(params: {
	ruleMode: CampaignRuleMode;
	countedAmountsCents: bigint[];
	targetSpendAmountCents: bigint | null;
	requiredTransactionCount: number | null;
	stepSpendAmountCents: bigint | null;
	maxSteps: number | null;
}): CampaignRuleProgress {
	const eligibleSpendCents = params.countedAmountsCents.reduce(
		(sum, c) => sum + c,
		0n,
	);
	const eligibleTransactionCount = params.countedAmountsCents.length;

	if (params.ruleMode === "TOTAL_SPEND") {
		const target = params.targetSpendAmountCents ?? 0n;
		return {
			eligibleSpendCents,
			eligibleTransactionCount,
			stepsEarnedUnits: null,
			qualified: eligibleSpendCents >= target,
		};
	}

	if (params.ruleMode === "TRANSACTION_COUNT") {
		const required = params.requiredTransactionCount ?? 0;
		return {
			eligibleSpendCents,
			eligibleTransactionCount,
			stepsEarnedUnits: null,
			qualified: eligibleTransactionCount >= required,
		};
	}

	// REPEATABLE_SPEND
	const stepSpend = params.stepSpendAmountCents ?? 1n;
	const maxSteps = params.maxSteps ?? 0;
	const stepsEarned = computeRepeatableStepsEarned(
		eligibleSpendCents,
		stepSpend,
		maxSteps,
	);
	return {
		eligibleSpendCents,
		eligibleTransactionCount,
		stepsEarnedUnits: stepsEarned,
		qualified: stepsEarned >= 1n,
	};
}

/**
 * Section 36: deterministic helper detecting whether a candidate campaign
 * period identity/date window represents a genuine NEW recurring cycle (a
 * "reset") relative to the current period, rather than a correction of the
 * same period. No ML/heuristics -- purely deterministic identity + date
 * comparison. A reset is detected when either:
 *   1. The candidate period_key differs from the current period_key, or
 *   2. The candidate date window starts strictly after the current window
 *      ends (a genuinely later, non-overlapping cycle).
 * Historical progress is never overwritten by a reset -- the caller must
 * create a brand new campaign_period identity rather than mutating the
 * existing one.
 */
export function detectCampaignPeriodReset(params: {
	currentPeriodKey: string;
	currentEndsOn: string;
	candidatePeriodKey: string;
	candidateStartsOn: string;
}): boolean {
	if (params.candidatePeriodKey !== params.currentPeriodKey) return true;
	return params.candidateStartsOn > params.currentEndsOn;
}
