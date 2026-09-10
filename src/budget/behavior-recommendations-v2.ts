import type { Database } from "../db/client";
import { parseAggregateMoneyString } from "../ledger/money";
import {
	type BehaviorConfidence,
	type BehaviorConfidenceLevel,
	type BehaviorFeatureName,
	type BehaviorRegimeReview,
	type BudgetV2BehaviorProfile,
	buildBudgetV2BehaviorProfile,
	type RobustFeatureSummary,
} from "./behavior-profile-v2";
import type {
	BehaviorEngineCheckpointObservation,
	SurplusUseLaneName,
} from "./checkpoint-report-v2";

/**
 * PERSONAL_BUDGET_V2 -- DETERMINISTIC RECOMMENDATION ENGINE CORE (Checkpoint 6B).
 *
 * WHAT THIS IS. Given a verified persisted checkpoint and the user's historical
 * Behavior Profile (Checkpoint 6A / 6A.1), this layer answers "what is worth
 * bringing to the user's attention?" -- never "I changed your budget". Every
 * recommendation is deterministic, drawn from a CLOSED catalogue, explainable
 * from structured evidence, non-executing and user-approval-only.
 *
 * AUTHORITATIVE INPUT -- THE BEHAVIOR PROFILE. The only input is
 * `buildBudgetV2BehaviorProfile({ db, userId, throughPaymentEventId })`, which
 * itself derives exclusively from verified persisted checkpoints. This module
 * never calls the live resolver, never rebuilds a historical checkpoint report,
 * never reads current merchant / name data, never recomputes `trueSurplus` /
 * `availableToAllocateNow`, and never duplicates financial policy math.
 *
 * NO EXECUTION, NO POLICY MUTATION. Nothing here transfers money, changes a
 * Midas allocation, alters Budget V2 weights or any target (Basic Living /
 * emergency / Mobility), creates a Long-Term task, alters a purchase or an
 * attribution, or modifies a stored checkpoint. Every produced recommendation
 * carries `requiresUserApproval: true`, `automaticExecution: false`,
 * `mutatesPolicy: false`.
 *
 * SAFETY RULES ARE HARD. The regime-driven safety recommendations
 * (DATA_INCOMPLETE / DEFICIT / OVERSUBSCRIBED / EMERGENCY_REBUILD) are
 * deterministic rules that do NOT depend on feedback, learned preferences,
 * confidence level, historical medians or any future LLM. No later phase may
 * learn these guardrails away.
 *
 * NO PERSISTENCE YET. Checkpoint 6B is deterministic GENERATION only -- there is
 * no ACCEPT / MODIFY / IGNORE lifecycle, no feedback learning and no
 * recommendation-history table. Checkpoint 6C adds that lifecycle on top of this
 * proven core.
 *
 * NO LLM. The structured `reasonCodes` + `evidence` are the authoritative
 * explanation. A future LLM MAY verbalize them but may never change a
 * recommendation's kind, priority, amounts, evidence, allowed actions or safety
 * gates.
 */

export const BUDGET_V2_RECOMMENDATION_ENGINE_VERSION =
	"budget-v2-recommendation-engine-v1";

// ============================================================================
// Closed catalogue (section 4) -- an unknown kind is impossible by type.
// ============================================================================

export type BudgetV2RecommendationKind =
	| "DATA_COMPLETION_REQUIRED"
	| "DEFICIT_STABILIZATION_REVIEW"
	| "SURPLUS_OVERSUBSCRIPTION_REVIEW"
	| "EMERGENCY_REBUILD_REVIEW"
	| "BASELINE_RESET_REVIEW"
	| "LANE_OVERRUN_REVIEW"
	| "DISCRETIONARY_SPIKE_REVIEW"
	| "OBLIGATION_LOAD_SPIKE_REVIEW"
	| "TRUE_SURPLUS_RATE_DROP_REVIEW"
	| "FOOD_OUTSIDE_SHARE_SPIKE_REVIEW"
	| "UNUSED_DISCRETIONARY_SWEEP_REVIEW";

/**
 * Fixed deterministic priority table (section 22). Higher number = higher
 * priority. Safety always outranks optional behavioural observations. This table
 * is a constant and must never be modified from feedback.
 */
export const BUDGET_V2_RECOMMENDATION_PRIORITY: Record<
	BudgetV2RecommendationKind,
	number
> = {
	DATA_COMPLETION_REQUIRED: 100,
	DEFICIT_STABILIZATION_REVIEW: 95,
	SURPLUS_OVERSUBSCRIPTION_REVIEW: 90,
	EMERGENCY_REBUILD_REVIEW: 85,
	BASELINE_RESET_REVIEW: 80,
	LANE_OVERRUN_REVIEW: 70,
	OBLIGATION_LOAD_SPIKE_REVIEW: 50,
	TRUE_SURPLUS_RATE_DROP_REVIEW: 45,
	DISCRETIONARY_SPIKE_REVIEW: 40,
	FOOD_OUTSIDE_SHARE_SPIKE_REVIEW: 35,
	UNUSED_DISCRETIONARY_SWEEP_REVIEW: 20,
};

/** At most this many active recommendations are surfaced per checkpoint. */
export const BUDGET_V2_RECOMMENDATION_MAX_ACTIVE = 3;

export type BudgetV2RecommendationUrgency = "SAFETY" | "REVIEW" | "OPPORTUNITY";

/**
 * `NONE`   -- a deterministic state / safety rule, valid at any confidence.
 * `MEDIUM_OR_HIGH` -- a historical-pattern rule; suppressed while confidence is
 *                     LOW (section 21) and additionally gated on its own feature
 *                     baseline `validCount` (section 14).
 */
export type BudgetV2RecommendationConfidenceRequirement =
	| "NONE"
	| "MEDIUM_OR_HIGH";

const SWEEP_REVIEW_DESTINATIONS = [
	"INTERNATIONAL_MOBILITY",
	"LONG_TERM_INVESTMENT",
] as const satisfies readonly SurplusUseLaneName[];

export type BudgetV2RecommendationProposedAction =
	| { action: "REVIEW_DATA_COMPLETION" }
	| { action: "REVIEW_DEFICIT_STABILIZATION" }
	| { action: "REVIEW_SURPLUS_OVERSUBSCRIPTION" }
	| { action: "REVIEW_EMERGENCY_REBUILD" }
	| { action: "REVIEW_HISTORICAL_BASELINE" }
	| { action: "REVIEW_LANE_OVERRUN"; lane: SurplusUseLaneName }
	| { action: "REVIEW_BEHAVIOR_PATTERN"; feature: BehaviorFeatureName }
	| {
			action: "REVIEW_UNUSED_DISCRETIONARY_SWEEP";
			/** exact cents: min(DISCRETIONARY.remaining, availableToAllocateNow.amount) */
			suggestedReviewAmount: string;
			/** review options only -- NEVER auto-applied */
			allowedReviewDestinations: readonly SurplusUseLaneName[];
			/** always null: the engine never chooses a destination */
			autoSelectedDestination: null;
	  };

export interface BudgetV2Recommendation {
	/** deterministic key for (checkpoint, kind, scope) -- never a random UUID. */
	recommendationId: string;
	kind: BudgetV2RecommendationKind;
	priority: number;
	urgency: BudgetV2RecommendationUrgency;
	/** deterministic sub-scope key: `GLOBAL`, a lane name, or a feature name. */
	scope: string;
	throughPaymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
	confidenceRequired: BudgetV2RecommendationConfidenceRequirement;
	confidenceObserved: BehaviorConfidenceLevel;
	reasonCodes: string[];
	evidence: Record<string, unknown>;
	proposedAction: BudgetV2RecommendationProposedAction;
	requiresUserApproval: true;
	automaticExecution: false;
	mutatesPolicy: false;
}

export interface BudgetV2RecommendationSuppression {
	kind: BudgetV2RecommendationKind;
	scope: string;
	reason: string;
}

export interface BudgetV2RecommendationSet {
	engineVersion: string;
	generatedFrom: {
		behaviorEngineVersion: string;
		observationContractVersion: string;
	};
	through: {
		paymentEventId: string;
		checkpointAt: string;
		periodMonth: string;
	};
	confidence: BehaviorConfidence;
	regime: BehaviorRegimeReview;
	recommendationCount: number;
	eligibleCandidateCount: number;
	suppressedCount: number;
	recommendations: BudgetV2Recommendation[];
	/** audit trail for candidates cut by the max-active cap (section 23). */
	suppressed: BudgetV2RecommendationSuppression[];
}

// ============================================================================
// Money helpers -- exact integer cents, never floating point.
// ============================================================================

function centsOrNull(v: string | null | undefined): bigint | null {
	if (typeof v !== "string") return null;
	try {
		return parseAggregateMoneyString(v).cents;
	} catch {
		return null;
	}
}

function isPositiveMoney(v: string | null | undefined): boolean {
	const c = centsOrNull(v);
	return c !== null && c > 0n;
}

/** Exact min of two non-negative money strings; returns the smaller ORIGINAL. */
function minMoney(a: string, b: string): string {
	return parseAggregateMoneyString(a).cents <=
		parseAggregateMoneyString(b).cents
		? a
		: b;
}

// ============================================================================
// Robust behavioural signals (sections 15, 18) -- safe integer / BigInt math.
// ============================================================================

interface RobustSignal {
	fires: boolean;
	/** the MAD == 0 deterministic branch was taken. */
	madZero: boolean;
}

/**
 * Adverse HIGH-side signal for features where a larger value means more
 * burden / spend. Fires only when `current > p75` and `current - median >= 2 *
 * MAD`; when `MAD == 0` it instead requires `current > p75` AND
 * `current > median`. Every operand is a proven safe integer (Checkpoint 6A.1),
 * and the delta test is done in BigInt so it can never overflow the Number
 * safe-integer range.
 */
function highSideSignal(s: RobustFeatureSummary): RobustSignal {
	if (
		s.current === null ||
		s.median === null ||
		s.p75 === null ||
		s.mad === null
	) {
		return { fires: false, madZero: false };
	}
	const current = BigInt(s.current);
	const median = BigInt(s.median);
	const p75 = BigInt(s.p75);
	const mad = BigInt(s.mad);
	if (mad === 0n) {
		return { fires: current > p75 && current > median, madZero: true };
	}
	return {
		fires: current > p75 && current - median >= 2n * mad,
		madZero: false,
	};
}

/**
 * Adverse LOW-side signal for `trueSurplusRateBp`, which is adverse when it
 * DROPS below the baseline. Fires only when `current < p25` and
 * `median - current >= 2 * MAD`; when `MAD == 0` it requires `current < p25`
 * AND `current < median`.
 */
function lowSideSignal(s: RobustFeatureSummary): RobustSignal {
	if (
		s.current === null ||
		s.median === null ||
		s.p25 === null ||
		s.mad === null
	) {
		return { fires: false, madZero: false };
	}
	const current = BigInt(s.current);
	const median = BigInt(s.median);
	const p25 = BigInt(s.p25);
	const mad = BigInt(s.mad);
	if (mad === 0n) {
		return { fires: current < p25 && current < median, madZero: true };
	}
	return {
		fires: current < p25 && median - current >= 2n * mad,
		madZero: false,
	};
}

/**
 * Section 14 gate for a historical-pattern recommendation: confidence must not
 * be LOW, the target feature must be authoritative at the checkpoint, and the
 * 60-day robust baseline must carry at least 4 valid observations of that exact
 * feature. An `OUT_OF_SAFE_INTEGER_RANGE` target feature has `current === null`
 * and so can never satisfy this (section AK).
 */
function patternBaselineEligible(
	confidence: BehaviorConfidenceLevel,
	window60: RobustFeatureSummary,
): boolean {
	return (
		confidence !== "LOW" &&
		window60.current !== null &&
		window60.validCount >= 4
	);
}

// ============================================================================
// Candidate assembly
// ============================================================================

const LANE_ORDER = [
	"INTERNATIONAL_MOBILITY",
	"LONG_TERM_INVESTMENT",
	"DISCRETIONARY",
] as const satisfies readonly SurplusUseLaneName[];

interface Candidate {
	kind: BudgetV2RecommendationKind;
	scope: string;
	/**
	 * Deterministic secondary ordering key applied AFTER priority and kind, and
	 * BEFORE the lexical scope key. Lane-overrun candidates use it to pin the
	 * spec lane order (Mobility, Long-Term, Discretionary) instead of a lexical
	 * scope sort; every other candidate leaves it equal to its scope.
	 */
	tieKey: string;
	urgency: BudgetV2RecommendationUrgency;
	confidenceRequired: BudgetV2RecommendationConfidenceRequirement;
	reasonCodes: string[];
	evidence: Record<string, unknown>;
	proposedAction: BudgetV2RecommendationProposedAction;
}

function dataCompletionCandidate(profile: BudgetV2BehaviorProfile): Candidate {
	const obs = profile.currentObservation;
	const through = profile.through.paymentEventId;
	const incompatibleTarget = profile.dataQuality.incompatibleSnapshots.find(
		(s) => s.paymentEventId === through,
	);
	const atn = obs?.availableToAllocateNow ?? null;
	const atnAuthoritative = atn?.available === true;
	return {
		kind: "DATA_COMPLETION_REQUIRED",
		scope: "GLOBAL",
		tieKey: "GLOBAL",
		urgency: "SAFETY",
		confidenceRequired: "NONE",
		reasonCodes: ["BEHAVIOR_REGIME_DATA_INCOMPLETE"],
		evidence: {
			regime: "DATA_INCOMPLETE",
			availableToAllocateNowAuthoritative: atnAuthoritative,
			availableToAllocateNowReason:
				atn && atn.available === false ? atn.reason : null,
			unattributedSurplusUseSubjectCount: obs
				? obs.surplusUse.unattributedCount
				: null,
			staleSurplusUseSubjectCount: obs ? obs.surplusUse.staleCount : null,
			overlapUnresolvedSurplusUseSubjectCount: obs
				? obs.surplusUse.overlapUnresolvedCount
				: null,
			unattributedSubjectIds: obs ? obs.unattributedSubjectIds : [],
			staleSubjectIds: obs ? obs.staleSubjectIds : [],
			overlapUnresolvedSubjectIds: obs ? obs.overlapUnresolvedSubjectIds : [],
			targetObservationIncompatible: incompatibleTarget !== undefined,
			targetObservationIncompatibleReason: incompatibleTarget
				? incompatibleTarget.reason
				: null,
		},
		proposedAction: { action: "REVIEW_DATA_COMPLETION" },
	};
}

function deficitCandidate(obs: BehaviorEngineCheckpointObservation): Candidate {
	return {
		kind: "DEFICIT_STABILIZATION_REVIEW",
		scope: "GLOBAL",
		tieKey: "GLOBAL",
		urgency: "SAFETY",
		confidenceRequired: "NONE",
		reasonCodes: ["BEHAVIOR_REGIME_DEFICIT"],
		evidence: {
			deficit: obs.budget.deficit,
			realizedIncome: obs.budget.realizedIncome,
			currentObligations: obs.budget.currentObligations,
			basicLivingFunding: obs.budget.basicLivingFunding,
			trueSurplus: obs.budget.trueSurplus,
		},
		proposedAction: { action: "REVIEW_DEFICIT_STABILIZATION" },
	};
}

function oversubscriptionCandidate(
	obs: BehaviorEngineCheckpointObservation,
): Candidate {
	const atn = obs.availableToAllocateNow;
	const lanes = atn.available ? atn.lanes : null;
	return {
		kind: "SURPLUS_OVERSUBSCRIPTION_REVIEW",
		scope: "GLOBAL",
		tieKey: "GLOBAL",
		urgency: "SAFETY",
		confidenceRequired: "NONE",
		reasonCodes: ["BEHAVIOR_REGIME_OVERSUBSCRIBED"],
		evidence: {
			trueSurplus: obs.budget.trueSurplus,
			totalAttributedCurrentSurplusUse:
				obs.surplusUse.totalAttributedCurrentSurplusUse,
			oversubscribedBy: obs.surplusUse.oversubscribedBy,
			lanes: lanes
				? LANE_ORDER.map((lane) => ({
						lane,
						planned: lanes[lane].planned,
						used: lanes[lane].used,
						remaining: lanes[lane].remaining,
						overrun: lanes[lane].overrun,
					}))
				: null,
		},
		proposedAction: { action: "REVIEW_SURPLUS_OVERSUBSCRIPTION" },
	};
}

function emergencyRebuildCandidate(
	obs: BehaviorEngineCheckpointObservation,
): Candidate {
	return {
		kind: "EMERGENCY_REBUILD_REVIEW",
		scope: "GLOBAL",
		tieKey: "GLOBAL",
		urgency: "SAFETY",
		confidenceRequired: "NONE",
		reasonCodes: ["BEHAVIOR_REGIME_EMERGENCY_REBUILD"],
		evidence: {
			emergencyCurrentBalance: obs.emergency.currentBalance,
			emergencyTarget: obs.emergency.target,
			emergencyGap: obs.emergency.gap,
			emergencyCatchUp: obs.budget.emergencyCatchUp,
		},
		proposedAction: { action: "REVIEW_EMERGENCY_REBUILD" },
	};
}

function baselineResetCandidate(
	regime: BehaviorRegimeReview,
	confidence: BehaviorConfidence,
): Candidate {
	return {
		kind: "BASELINE_RESET_REVIEW",
		scope: "GLOBAL",
		tieKey: "GLOBAL",
		urgency: "REVIEW",
		confidenceRequired: "NONE",
		reasonCodes: ["BEHAVIOR_REGIME_CHANGED"],
		evidence: {
			previousRegime: regime.previous,
			currentRegime: regime.current,
			changeReason: regime.reason,
			confidenceLevel: confidence.level,
			historySpanDays: confidence.historySpanDays,
			compatibleCheckpointCount: confidence.compatibleCheckpointCount,
		},
		// Review only: it must never delete / truncate / reset history or the
		// baseline statistics -- the shape carries no such option.
		proposedAction: { action: "REVIEW_HISTORICAL_BASELINE" },
	};
}

function laneOverrunCandidate(
	lane: SurplusUseLaneName,
	acc: { planned: string; used: string; remaining: string; overrun: string },
): Candidate {
	return {
		kind: "LANE_OVERRUN_REVIEW",
		scope: lane,
		tieKey: String(LANE_ORDER.indexOf(lane)),
		urgency: "REVIEW",
		confidenceRequired: "NONE",
		reasonCodes: ["LANE_USED_EXCEEDS_PLANNED"],
		evidence: {
			lane,
			planned: acc.planned,
			used: acc.used,
			remaining: acc.remaining,
			overrun: acc.overrun,
		},
		proposedAction: { action: "REVIEW_LANE_OVERRUN", lane },
	};
}

function spikeCandidate(params: {
	kind: BudgetV2RecommendationKind;
	feature: BehaviorFeatureName;
	summary: RobustFeatureSummary;
	side: "HIGH" | "LOW";
	madZero: boolean;
	confidence: BehaviorConfidenceLevel;
	rawEvidence: Record<string, unknown>;
}): Candidate {
	const { kind, feature, summary, side, madZero, confidence, rawEvidence } =
		params;
	const reasonCodes =
		side === "HIGH"
			? madZero
				? ["CURRENT_ABOVE_60D_P75", "MAD_ZERO_CURRENT_ABOVE_MEDIAN"]
				: ["CURRENT_ABOVE_60D_P75", "DELTA_AT_LEAST_2_MAD"]
			: madZero
				? ["CURRENT_BELOW_60D_P25", "MAD_ZERO_CURRENT_BELOW_MEDIAN"]
				: ["CURRENT_BELOW_60D_P25", "DELTA_AT_LEAST_2_MAD"];
	return {
		kind,
		scope: feature,
		tieKey: feature,
		urgency: "REVIEW",
		confidenceRequired: "MEDIUM_OR_HIGH",
		reasonCodes,
		evidence: {
			feature,
			window: "DAYS_60",
			currentBp: summary.current,
			medianBp: summary.median,
			madBp: summary.mad,
			p25Bp: summary.p25,
			p75Bp: summary.p75,
			validCount: summary.validCount,
			confidenceLevel: confidence,
			...rawEvidence,
		},
		proposedAction: { action: "REVIEW_BEHAVIOR_PATTERN", feature },
	};
}

function sweepCandidate(
	discretionaryRemaining: string,
	availableAmount: string,
): Candidate {
	const suggestedReviewAmount = minMoney(
		discretionaryRemaining,
		availableAmount,
	);
	return {
		kind: "UNUSED_DISCRETIONARY_SWEEP_REVIEW",
		scope: "GLOBAL",
		tieKey: "GLOBAL",
		urgency: "OPPORTUNITY",
		confidenceRequired: "NONE",
		reasonCodes: [
			"REGIME_SURPLUS_AVAILABLE",
			"NO_LANE_OVERRUN",
			"DISCRETIONARY_REMAINING_POSITIVE",
			"AVAILABLE_TO_ALLOCATE_NOW_POSITIVE",
		],
		evidence: {
			regime: "SURPLUS_AVAILABLE",
			discretionaryRemaining,
			availableToAllocateNowAmount: availableAmount,
			suggestedReviewAmount,
			allowedReviewDestinations: [...SWEEP_REVIEW_DESTINATIONS],
			autoSelectedDestination: null,
		},
		proposedAction: {
			action: "REVIEW_UNUSED_DISCRETIONARY_SWEEP",
			suggestedReviewAmount,
			allowedReviewDestinations: [...SWEEP_REVIEW_DESTINATIONS],
			autoSelectedDestination: null,
		},
	};
}

// ============================================================================
// Public pure generator
// ============================================================================

function finalize(
	c: Candidate,
	profile: BudgetV2BehaviorProfile,
): BudgetV2Recommendation {
	return {
		recommendationId: `budget-v2-rec:v1:${profile.through.paymentEventId}:${c.kind}:${c.scope}`,
		kind: c.kind,
		priority: BUDGET_V2_RECOMMENDATION_PRIORITY[c.kind],
		urgency: c.urgency,
		scope: c.scope,
		throughPaymentEventId: profile.through.paymentEventId,
		checkpointAt: profile.through.checkpointAt,
		periodMonth: profile.through.periodMonth,
		confidenceRequired: c.confidenceRequired,
		confidenceObserved: profile.confidence.level,
		reasonCodes: c.reasonCodes,
		evidence: c.evidence,
		proposedAction: c.proposedAction,
		requiresUserApproval: true,
		automaticExecution: false,
		mutatesPolicy: false,
	};
}

/**
 * Total deterministic order over candidates (section 22-23): priority DESC, then
 * the stable kind key, then the stable tie key (lane order for lane overruns,
 * scope otherwise), then the lexical scope key. `(kind, scope)` is unique per
 * candidate, so this never leaves two candidates equal.
 */
function candidateRank(a: Candidate, b: Candidate): number {
	const pa = BUDGET_V2_RECOMMENDATION_PRIORITY[a.kind];
	const pb = BUDGET_V2_RECOMMENDATION_PRIORITY[b.kind];
	if (pa !== pb) return pb - pa;
	if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
	if (a.tieKey !== b.tieKey) return a.tieKey < b.tieKey ? -1 : 1;
	if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
	return 0;
}

/**
 * Deterministic recommendation set for one Behavior Profile. Pure: the same
 * persisted target checkpoint + the same immutable checkpoint history always
 * yield a byte-identical set. No wall-clock, no randomness, no unordered
 * iteration effects, no live-data dependency.
 */
export function generateBudgetV2Recommendations(
	profile: BudgetV2BehaviorProfile,
): BudgetV2RecommendationSet {
	const confidence = profile.confidence;
	const regime = profile.regime;
	const obs = profile.currentObservation;
	const candidates: Candidate[] = [];

	// -- hard deterministic safety states (sections 7-11) --------------------
	// Regime precedence (Checkpoint 6A) makes at most one of these current.
	if (regime.current === "DATA_INCOMPLETE") {
		candidates.push(dataCompletionCandidate(profile));
	} else if (obs) {
		if (regime.current === "DEFICIT") {
			candidates.push(deficitCandidate(obs));
		} else if (regime.current === "OVERSUBSCRIBED") {
			candidates.push(oversubscriptionCandidate(obs));
		} else if (regime.current === "EMERGENCY_REBUILD") {
			candidates.push(emergencyRebuildCandidate(obs));
		}
	}

	// -- regime-change baseline review (section 12) -------------------------
	if (regime.baselineResetReviewSuggested) {
		candidates.push(baselineResetCandidate(regime, confidence));
	}

	// While financial truth is incomplete, suppress EVERYTHING that depends on
	// exact current surplus availability -- no savings / investment /
	// reallocation / pattern recommendation from an incomplete checkpoint
	// (section 8).
	if (regime.current !== "DATA_INCOMPLETE" && obs) {
		const atn = obs.availableToAllocateNow;

		// -- lane overrun (section 13): one per lane with overrun > 0 --------
		if (atn.available) {
			for (const lane of LANE_ORDER) {
				if (isPositiveMoney(atn.lanes[lane].overrun)) {
					candidates.push(laneOverrunCandidate(lane, atn.lanes[lane]));
				}
			}
		}

		// -- behavioural pattern recommendations (sections 14-19) -----------
		const w60 = profile.windows.DAYS_60.features;

		if (
			patternBaselineEligible(confidence.level, w60.discretionarySpendIncomeBp)
		) {
			const sig = highSideSignal(w60.discretionarySpendIncomeBp);
			if (sig.fires) {
				candidates.push(
					spikeCandidate({
						kind: "DISCRETIONARY_SPIKE_REVIEW",
						feature: "discretionarySpendIncomeBp",
						summary: w60.discretionarySpendIncomeBp,
						side: "HIGH",
						madZero: sig.madZero,
						confidence: confidence.level,
						rawEvidence: {
							currentPersonalDiscretionarySpend:
								obs.spending.discretionarySpendPersonalSpend,
							realizedIncome: obs.budget.realizedIncome,
						},
					}),
				);
			}
		}

		if (patternBaselineEligible(confidence.level, w60.obligationLoadBp)) {
			const sig = highSideSignal(w60.obligationLoadBp);
			if (sig.fires) {
				candidates.push(
					spikeCandidate({
						kind: "OBLIGATION_LOAD_SPIKE_REVIEW",
						feature: "obligationLoadBp",
						summary: w60.obligationLoadBp,
						side: "HIGH",
						madZero: sig.madZero,
						confidence: confidence.level,
						rawEvidence: {
							currentObligations: obs.budget.currentObligations,
							realizedIncome: obs.budget.realizedIncome,
						},
					}),
				);
			}
		}

		if (patternBaselineEligible(confidence.level, w60.trueSurplusRateBp)) {
			const sig = lowSideSignal(w60.trueSurplusRateBp);
			if (sig.fires) {
				candidates.push(
					spikeCandidate({
						kind: "TRUE_SURPLUS_RATE_DROP_REVIEW",
						feature: "trueSurplusRateBp",
						summary: w60.trueSurplusRateBp,
						side: "LOW",
						madZero: sig.madZero,
						confidence: confidence.level,
						rawEvidence: {
							trueSurplus: obs.budget.trueSurplus,
							realizedIncome: obs.budget.realizedIncome,
						},
					}),
				);
			}
		}

		// Food only from explicit stored food semantics -- never inferred, never
		// zero-filled (section 19). Requires authoritative food at the target AND
		// a valid 60-day baseline.
		if (
			obs.food.available &&
			patternBaselineEligible(confidence.level, w60.foodOutsideShareBp)
		) {
			const sig = highSideSignal(w60.foodOutsideShareBp);
			if (sig.fires) {
				candidates.push(
					spikeCandidate({
						kind: "FOOD_OUTSIDE_SHARE_SPIKE_REVIEW",
						feature: "foodOutsideShareBp",
						summary: w60.foodOutsideShareBp,
						side: "HIGH",
						madZero: sig.madZero,
						confidence: confidence.level,
						rawEvidence: {
							foodOutside: obs.food.foodOutside,
							foodTotal: obs.food.foodTotal,
						},
					}),
				);
			}
		}

		// -- unused discretionary sweep OPTION (section 20) -----------------
		if (atn.available && regime.current === "SURPLUS_AVAILABLE") {
			const noLaneOverrun = LANE_ORDER.every(
				(lane) => !isPositiveMoney(atn.lanes[lane].overrun),
			);
			const discretionaryRemaining = atn.lanes.DISCRETIONARY.remaining;
			if (
				noLaneOverrun &&
				isPositiveMoney(discretionaryRemaining) &&
				isPositiveMoney(atn.amount)
			) {
				candidates.push(sweepCandidate(discretionaryRemaining, atn.amount));
			}
		}
	}

	// -- deterministic priority + max-active cap (sections 22-23) ----------
	const ranked = [...candidates]
		.sort(candidateRank)
		.map((c) => finalize(c, profile));
	const shown = ranked.slice(0, BUDGET_V2_RECOMMENDATION_MAX_ACTIVE);
	const suppressed: BudgetV2RecommendationSuppression[] = ranked
		.slice(BUDGET_V2_RECOMMENDATION_MAX_ACTIVE)
		.map((r) => ({
			kind: r.kind,
			scope: r.scope,
			reason: "MAX_ACTIVE_RECOMMENDATIONS_EXCEEDED",
		}));

	return {
		engineVersion: BUDGET_V2_RECOMMENDATION_ENGINE_VERSION,
		generatedFrom: {
			behaviorEngineVersion: profile.engineVersion,
			observationContractVersion: profile.observationContractVersion,
		},
		through: {
			paymentEventId: profile.through.paymentEventId,
			checkpointAt: profile.through.checkpointAt,
			periodMonth: profile.through.periodMonth,
		},
		confidence,
		regime,
		recommendationCount: shown.length,
		eligibleCandidateCount: ranked.length,
		suppressedCount: suppressed.length,
		recommendations: shown,
		suppressed,
	};
}

// ============================================================================
// DB entry point -- build the Behavior Profile, then generate. Nothing else.
// ============================================================================

/**
 * Target-anchored deterministic recommendation set for `throughPaymentEventId`.
 * Builds the Checkpoint 6A Behavior Profile (which verifies every persisted
 * snapshot it touches) and runs the pure generator over it. Performs NO
 * additional live-domain DB reads.
 */
export async function buildBudgetV2RecommendationSet(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2RecommendationSet> {
	const profile = await buildBudgetV2BehaviorProfile(params);
	return generateBudgetV2Recommendations(profile);
}
