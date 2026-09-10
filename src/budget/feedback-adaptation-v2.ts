import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { budgetV2CheckpointSnapshots } from "../db/schema/budget-v2-checkpoint";
import {
	budgetV2RecommendationFeedbackRevisions,
	budgetV2RecommendationInstances,
} from "../db/schema/budget-v2-recommendation-feedback";
import {
	type BudgetV2RecommendationReviewItem,
	type BudgetV2RecommendationReviewView,
	buildBudgetV2RecommendationReviewView,
} from "./behavior-recommendations-review-v2";
import type { BudgetV2RecommendationKind } from "./behavior-recommendations-v2";
import { verifyStoredCheckpointSnapshot } from "./checkpoint-canonical-v2";
import { BudgetError } from "./errors";
import {
	verifyStoredBudgetV2RecommendationFeedbackRevision,
	verifyStoredBudgetV2RecommendationInstance,
} from "./recommendation-feedback-canonical-v2";

/**
 * PERSONAL_BUDGET_V2 -- VERIFIED FEEDBACK ADAPTATION (Checkpoint 6D).
 *
 * WHAT THIS IS:
 * Bounded, explainable presentation preference learning derived from verified,
 * tamper-checked historical feedback (ACCEPT / MODIFY / IGNORE).
 *
 * CRITICAL BOUNDARIES:
 * - 6B recommendation generation is immutable authority; feedback never alters
 *   recommendation eligibility, thresholds, evidence, or base priority.
 * - Safety & core regime recommendations are strictly PROTECTED and non-adaptive.
 * - Only 5 optional review kinds may learn presentation emphasis (EMPHASIZE / DEEMPHASIZE).
 * - Target checkpoint feedback does NOT adapt that same checkpoint (source < target).
 * - One vote per recommendation instance (latest verified effective feedback).
 * - Strict 90-day sliding window and minimum evidence requirements before learning.
 * - Read-only: zero financial executions, zero DB writes.
 */

export const BUDGET_V2_FEEDBACK_ADAPTATION_ENGINE_VERSION =
	"budget-v2-feedback-adaptation-v1";

export const BUDGET_V2_FEEDBACK_WINDOW_DAYS = 90;
export const BUDGET_V2_FEEDBACK_MIN_INSTANCES = 4;
export const BUDGET_V2_FEEDBACK_MIN_CHECKPOINTS = 4;
export const BUDGET_V2_FEEDBACK_MIN_PERIOD_MONTHS = 2;
export const BUDGET_V2_FEEDBACK_MIN_SPAN_DAYS = 30;
export const BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP = 7500; // 75.00%
export const BUDGET_V2_FEEDBACK_MIN_DECISION_COUNT = 3;

export const BUDGET_V2_SUPPORTED_RECOMMENDATION_ENGINE_VERSIONS = [
	"budget-v2-recommendation-engine-v1",
] as const;

export const BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS = [
	"DATA_COMPLETION_REQUIRED",
	"DEFICIT_STABILIZATION_REVIEW",
	"SURPLUS_OVERSUBSCRIPTION_REVIEW",
	"EMERGENCY_REBUILD_REVIEW",
	"BASELINE_RESET_REVIEW",
	"LANE_OVERRUN_REVIEW",
] as const;

export type BudgetV2ProtectedRecommendationKind =
	(typeof BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS)[number];

export const BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS = [
	"DISCRETIONARY_SPIKE_REVIEW",
	"OBLIGATION_LOAD_SPIKE_REVIEW",
	"TRUE_SURPLUS_RATE_DROP_REVIEW",
	"FOOD_OUTSIDE_SHARE_SPIKE_REVIEW",
	"UNUSED_DISCRETIONARY_SWEEP_REVIEW",
] as const;

export type BudgetV2AdaptiveRecommendationKind =
	(typeof BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS)[number];

export const ALL_BUDGET_V2_RECOMMENDATION_KINDS = [
	...BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS,
	...BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS,
] as const;

export type BudgetV2RecommendationAttention =
	| "PROTECTED"
	| "EMPHASIZE"
	| "STANDARD"
	| "DEEMPHASIZE";

export type BudgetV2FeedbackEvidenceStatus = "ESTABLISHED" | "INSUFFICIENT";

export interface BudgetV2FeedbackEvidence {
	windowDays: number;
	rangeStart: string;
	rangeEnd: string;
	validInstanceCount: number;
	acceptCount: number;
	modifyCount: number;
	ignoreCount: number;
	acceptRateBp: number;
	ignoreRateBp: number;
	distinctCheckpointCount: number;
	distinctPeriodMonthCount: number;
	historySpanDays: number;
	latestDecision: "ACCEPT" | "MODIFY" | "IGNORE" | null;
	latestDecisionAt: string | null;
}

export interface BudgetV2KindFeedbackPreference {
	kind: BudgetV2RecommendationKind;
	attention: BudgetV2RecommendationAttention;
	learned: boolean;
	evidenceStatus: BudgetV2FeedbackEvidenceStatus;
	reasonCodes: string[];
	evidence: BudgetV2FeedbackEvidence;
}

export interface BudgetV2FeedbackPreferenceProfile {
	engineVersion: string;
	through: {
		paymentEventId: string;
		checkpointAt: string;
		periodMonth: string;
	};
	history: {
		available: boolean;
		verifiedInstanceCount: number;
		incompatibleInstanceCount: number;
		excludedFutureCount: number;
		excludedTargetCount: number;
		/**
		 * Section 24: recommendation-engine versions that were seen on stored
		 * instances but are NOT in BUDGET_V2_SUPPORTED_RECOMMENDATION_ENGINE_VERSIONS.
		 * Such instances are excluded from preference counts and never coerced into
		 * an ACCEPT / IGNORE / zero -- this is compatibility exclusion, not corruption.
		 */
		unsupportedRecommendationEngineVersions: string[];
		corruptionReason?: string;
	};
	preferences: Record<
		BudgetV2AdaptiveRecommendationKind,
		BudgetV2KindFeedbackPreference
	>;
	protectedKinds: Record<
		BudgetV2ProtectedRecommendationKind,
		BudgetV2KindFeedbackPreference
	>;
}

export interface BudgetV2RecommendationFeedbackAdaptation {
	attention: BudgetV2RecommendationAttention;
	learned: boolean;
	reasonCodes: string[];
	evidence: BudgetV2FeedbackEvidence;
}

export interface BudgetV2FeedbackAdaptedRecommendationReviewItem
	extends BudgetV2RecommendationReviewItem {
	feedbackAdaptation: BudgetV2RecommendationFeedbackAdaptation;
}

export interface BudgetV2FeedbackAdaptedRecommendationReviewView
	extends Omit<BudgetV2RecommendationReviewView, "items"> {
	items: BudgetV2FeedbackAdaptedRecommendationReviewItem[];
	/**
	 * Section 23: top-level personalization availability. When verified feedback
	 * history is corrupt this is `{ available: false, reason: ... }` and every
	 * item's feedbackAdaptation falls back to PROTECTED (for protected kinds) or
	 * STANDARD -- base 6B recommendations remain fully usable regardless.
	 */
	feedbackAdaptation: {
		available: boolean;
		reason?: string;
	};
	feedbackPreferenceProfile: BudgetV2FeedbackPreferenceProfile;
}

interface HistoricalVote {
	instanceId: string;
	kind: BudgetV2RecommendationKind;
	decision: "ACCEPT" | "MODIFY" | "IGNORE";
	occurredAt: Date;
	checkpointSnapshotId: string;
	periodMonth: string;
}

export interface BudgetV2AdaptiveAttentionInput {
	validInstanceCount: number;
	acceptCount: number;
	modifyCount: number;
	ignoreCount: number;
	distinctCheckpointCount: number;
	distinctPeriodMonthCount: number;
	historySpanDays: number;
	latestDecision: "ACCEPT" | "MODIFY" | "IGNORE" | null;
}

export interface BudgetV2AdaptiveAttentionResult {
	attention: BudgetV2RecommendationAttention;
	learned: boolean;
	evidenceStatus: BudgetV2FeedbackEvidenceStatus;
	reasonCodes: string[];
	acceptRateBp: number;
	ignoreRateBp: number;
}

/**
 * Section 14: exact integer basis-point feedback rates. MODIFY stays in the
 * denominator (validInstanceCount) but contributes to neither numerator.
 * No floating-point probabilities; result is a bounded, safe integer in [0, 10000].
 */
export function computeFeedbackRateBp(
	numerator: number,
	validInstanceCount: number,
): number {
	if (
		!Number.isSafeInteger(numerator) ||
		!Number.isSafeInteger(validInstanceCount) ||
		validInstanceCount <= 0 ||
		numerator <= 0
	) {
		return 0;
	}
	const bp = Math.floor((numerator * 10000) / validInstanceCount);
	if (!Number.isFinite(bp) || bp < 0) return 0;
	return bp > 10000 ? 10000 : bp;
}

/**
 * Pure, deterministic presentation-attention decision for a single ADAPTIVE
 * OPTIONAL recommendation kind (Sections 13-17). This never depends on wall-clock
 * time, randomness, or live financial state -- only on the bounded window counts
 * handed to it. Protected kinds never reach this function.
 */
export function evaluateBudgetV2AdaptiveKindAttention(
	input: BudgetV2AdaptiveAttentionInput,
): BudgetV2AdaptiveAttentionResult {
	const {
		validInstanceCount,
		acceptCount,
		modifyCount,
		ignoreCount,
		distinctCheckpointCount,
		distinctPeriodMonthCount,
		historySpanDays,
		latestDecision,
	} = input;

	const acceptRateBp = computeFeedbackRateBp(acceptCount, validInstanceCount);
	const ignoreRateBp = computeFeedbackRateBp(ignoreCount, validInstanceCount);

	const isCountOk = validInstanceCount >= BUDGET_V2_FEEDBACK_MIN_INSTANCES;
	const isCheckpointsOk =
		distinctCheckpointCount >= BUDGET_V2_FEEDBACK_MIN_CHECKPOINTS;
	const isPeriodsOk =
		distinctPeriodMonthCount >= BUDGET_V2_FEEDBACK_MIN_PERIOD_MONTHS;
	const isSpanOk = historySpanDays >= BUDGET_V2_FEEDBACK_MIN_SPAN_DAYS;

	const evidenceEstablished =
		isCountOk && isCheckpointsOk && isPeriodsOk && isSpanOk;
	const evidenceStatus: BudgetV2FeedbackEvidenceStatus = evidenceEstablished
		? "ESTABLISHED"
		: "INSUFFICIENT";

	const reasonCodes: string[] = [];

	if (!evidenceEstablished) {
		if (validInstanceCount === 0) {
			reasonCodes.push("NO_HISTORICAL_FEEDBACK");
		} else {
			if (!isCountOk) reasonCodes.push("EVIDENCE_INSUFFICIENT_INSTANCE_COUNT");
			if (!isCheckpointsOk)
				reasonCodes.push("EVIDENCE_INSUFFICIENT_CHECKPOINTS");
			if (!isPeriodsOk) reasonCodes.push("EVIDENCE_INSUFFICIENT_PERIODS");
			if (!isSpanOk) reasonCodes.push("EVIDENCE_INSUFFICIENT_SPAN");
		}
		return {
			attention: "STANDARD",
			learned: false,
			evidenceStatus,
			reasonCodes,
			acceptRateBp,
			ignoreRateBp,
		};
	}

	const acceptMajority =
		acceptCount >= BUDGET_V2_FEEDBACK_MIN_DECISION_COUNT &&
		acceptRateBp >= BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP;
	const ignoreMajority =
		ignoreCount >= BUDGET_V2_FEEDBACK_MIN_DECISION_COUNT &&
		ignoreRateBp >= BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP;

	if (acceptMajority && latestDecision === "ACCEPT") {
		reasonCodes.push("EVIDENCE_ESTABLISHED", "ACCEPT_MAJORITY_ESTABLISHED");
		return {
			attention: "EMPHASIZE",
			learned: true,
			evidenceStatus,
			reasonCodes,
			acceptRateBp,
			ignoreRateBp,
		};
	}

	if (ignoreMajority && latestDecision === "IGNORE") {
		reasonCodes.push("EVIDENCE_ESTABLISHED", "IGNORE_MAJORITY_ESTABLISHED");
		return {
			attention: "DEEMPHASIZE",
			learned: true,
			evidenceStatus,
			reasonCodes,
			acceptRateBp,
			ignoreRateBp,
		};
	}

	reasonCodes.push("EVIDENCE_ESTABLISHED");
	if (acceptMajority && latestDecision !== "ACCEPT") {
		reasonCodes.push("LATEST_DECISION_CONTRADICTS_ACCEPT");
	} else if (ignoreMajority && latestDecision !== "IGNORE") {
		reasonCodes.push("LATEST_DECISION_CONTRADICTS_IGNORE");
	} else if (
		modifyCount > 0 &&
		acceptRateBp < BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP &&
		ignoreRateBp < BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP
	) {
		reasonCodes.push("MODIFY_ENGAGEMENT_ONLY");
	} else {
		reasonCodes.push("MIXED_FEEDBACK");
	}

	return {
		attention: "STANDARD",
		learned: false,
		evidenceStatus,
		reasonCodes,
		acceptRateBp,
		ignoreRateBp,
	};
}

function emptyEvidence(
	rangeStart: string,
	rangeEnd: string,
): BudgetV2FeedbackEvidence {
	return {
		windowDays: BUDGET_V2_FEEDBACK_WINDOW_DAYS,
		rangeStart,
		rangeEnd,
		validInstanceCount: 0,
		acceptCount: 0,
		modifyCount: 0,
		ignoreCount: 0,
		acceptRateBp: 0,
		ignoreRateBp: 0,
		distinctCheckpointCount: 0,
		distinctPeriodMonthCount: 0,
		historySpanDays: 0,
		latestDecision: null,
		latestDecisionAt: null,
	};
}

/**
 * Builds the bounded feedback preference profile for the target checkpoint.
 * Ensures historical verification, one vote per instance, and corrupt-history fail-safe.
 */
export async function buildBudgetV2FeedbackPreferenceProfile(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2FeedbackPreferenceProfile> {
	const userId = params.userId?.trim();
	const throughPaymentEventId = params.throughPaymentEventId?.trim();

	if (!userId || !throughPaymentEventId) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"missing userId or throughPaymentEventId for feedback preference profile",
		);
	}

	// 1. Load and verify target checkpoint snapshot
	const targetSnapshots = await params.db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(
			and(
				eq(budgetV2CheckpointSnapshots.userId, userId),
				eq(budgetV2CheckpointSnapshots.paymentEventId, throughPaymentEventId),
			),
		)
		.limit(1);

	const [targetSnapshot] = targetSnapshots;
	if (!targetSnapshot) {
		throw new BudgetError(
			"BUDGET_BEHAVIOR_PROFILE_FAIL_CLOSED",
			"checkpoint snapshot not found for target payment event",
		);
	}

	await verifyStoredCheckpointSnapshot(targetSnapshot);

	const targetCheckpointAt = new Date(targetSnapshot.checkpointAt);
	const windowMs = BUDGET_V2_FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
	const windowRangeStart = new Date(targetCheckpointAt.getTime() - windowMs);
	const windowRangeEnd = targetCheckpointAt;

	// 2. Query all recommendation instances for this user
	const rawInstances = await params.db
		.select()
		.from(budgetV2RecommendationInstances)
		.where(eq(budgetV2RecommendationInstances.userId, userId))
		.orderBy(
			budgetV2RecommendationInstances.capturedAt,
			budgetV2RecommendationInstances.id,
		);

	let verifiedInstanceCount = 0;
	let incompatibleInstanceCount = 0;
	let excludedFutureCount = 0;
	let excludedTargetCount = 0;
	let historyAvailable = true;
	let corruptionReason: string | undefined;
	const unsupportedEngineVersions = new Set<string>();

	const validHistoricalVotes: HistoricalVote[] = [];

	try {
		for (const inst of rawInstances) {
			const instCapturedAt = new Date(inst.capturedAt);

			// Section 4: the TARGET recommendation checkpoint's own instances never
			// influence that same checkpoint's adaptation.
			if (
				inst.checkpointSnapshotId === targetSnapshot.id ||
				inst.paymentEventId === targetSnapshot.paymentEventId
			) {
				excludedTargetCount++;
				continue;
			}

			// Load and verify source checkpoint snapshot
			const sourceSnapshots = await params.db
				.select()
				.from(budgetV2CheckpointSnapshots)
				.where(
					and(
						eq(budgetV2CheckpointSnapshots.id, inst.checkpointSnapshotId),
						eq(budgetV2CheckpointSnapshots.userId, userId),
					),
				)
				.limit(1);

			const [sourceSnapshot] = sourceSnapshots;
			if (!sourceSnapshot) {
				throw new BudgetError(
					"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
					"referenced source checkpoint snapshot missing",
				);
			}

			await verifyStoredCheckpointSnapshot(sourceSnapshot);

			if (
				inst.checkpointSnapshotId !== sourceSnapshot.id ||
				inst.paymentEventId !== sourceSnapshot.paymentEventId
			) {
				throw new BudgetError(
					"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
					"recommendation instance identity mismatch against source snapshot",
				);
			}

			// Section 4 + 26: require a strictly-historical source checkpoint. An
			// instance whose source checkpoint is at-or-after the target did not
			// exist as of the target, so it is silently skipped -- adding such a
			// checkpoint later must not perturb any count in this profile.
			const sourceCheckpointAt = new Date(sourceSnapshot.checkpointAt);
			if (sourceCheckpointAt.getTime() >= targetCheckpointAt.getTime()) {
				continue;
			}

			// Section 4: a historical checkpoint's recommendation that was only
			// responded to after the target is excluded from the as-of window.
			if (instCapturedAt.getTime() > targetCheckpointAt.getTime()) {
				excludedFutureCount++;
				continue;
			}

			// Verify recommendation instance integrity
			await verifyStoredBudgetV2RecommendationInstance(inst);

			// Version compatibility check (Section 24)
			const engineVersion =
				inst.recommendationEngineVersion as (typeof BUDGET_V2_SUPPORTED_RECOMMENDATION_ENGINE_VERSIONS)[number];
			if (
				!BUDGET_V2_SUPPORTED_RECOMMENDATION_ENGINE_VERSIONS.includes(
					engineVersion,
				)
			) {
				incompatibleInstanceCount++;
				unsupportedEngineVersions.add(String(inst.recommendationEngineVersion));
				continue;
			}

			// Load feedback revisions for this instance that occurred at or before targetCheckpointAt
			const revisions = await params.db
				.select()
				.from(budgetV2RecommendationFeedbackRevisions)
				.where(
					and(
						eq(
							budgetV2RecommendationFeedbackRevisions.recommendationInstanceId,
							inst.id,
						),
						eq(budgetV2RecommendationFeedbackRevisions.userId, userId),
						lte(
							budgetV2RecommendationFeedbackRevisions.occurredAt,
							targetCheckpointAt,
						),
					),
				)
				.orderBy(
					desc(budgetV2RecommendationFeedbackRevisions.occurredAt),
					desc(budgetV2RecommendationFeedbackRevisions.revisionNo),
					desc(budgetV2RecommendationFeedbackRevisions.id),
				)
				.limit(1);

			const [effectiveRev] = revisions;
			if (!effectiveRev) {
				// Unresponded as of target checkpoint
				continue;
			}

			await verifyStoredBudgetV2RecommendationFeedbackRevision(effectiveRev);

			const revOccurredAt = new Date(effectiveRev.occurredAt);

			// 90-day window check: [target - 90 days, target] (inclusive)
			if (
				revOccurredAt.getTime() < windowRangeStart.getTime() ||
				revOccurredAt.getTime() > windowRangeEnd.getTime()
			) {
				// Outside 90-day window -> excluded from window stats
				continue;
			}

			verifiedInstanceCount++;
			validHistoricalVotes.push({
				instanceId: inst.id,
				kind: inst.recommendationKind as BudgetV2RecommendationKind,
				decision: effectiveRev.decision as "ACCEPT" | "MODIFY" | "IGNORE",
				occurredAt: revOccurredAt,
				checkpointSnapshotId: sourceSnapshot.id,
				periodMonth: sourceSnapshot.periodMonth,
			});
		}
	} catch (_err: unknown) {
		// Section 23: Corrupt feedback fail-safe
		historyAvailable = false;
		corruptionReason = "VERIFIED_FEEDBACK_HISTORY_CORRUPT";
	}

	const preferences = {} as Record<
		BudgetV2AdaptiveRecommendationKind,
		BudgetV2KindFeedbackPreference
	>;
	const protectedKinds = {} as Record<
		BudgetV2ProtectedRecommendationKind,
		BudgetV2KindFeedbackPreference
	>;

	if (!historyAvailable) {
		// Fall-safe mode: all protected kinds return PROTECTED, all adaptive return STANDARD
		for (const kind of BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS) {
			protectedKinds[kind] = {
				kind,
				attention: "PROTECTED",
				learned: false,
				evidenceStatus: "INSUFFICIENT",
				reasonCodes: ["PROTECTED_KIND", "HISTORY_CORRUPT_FAILSAFE"],
				evidence: emptyEvidence(
					windowRangeStart.toISOString(),
					windowRangeEnd.toISOString(),
				),
			};
		}
		for (const kind of BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS) {
			preferences[kind] = {
				kind,
				attention: "STANDARD",
				learned: false,
				evidenceStatus: "INSUFFICIENT",
				reasonCodes: ["HISTORY_CORRUPT_FAILSAFE"],
				evidence: emptyEvidence(
					windowRangeStart.toISOString(),
					windowRangeEnd.toISOString(),
				),
			};
		}

		return {
			engineVersion: BUDGET_V2_FEEDBACK_ADAPTATION_ENGINE_VERSION,
			through: {
				paymentEventId: targetSnapshot.paymentEventId,
				checkpointAt: targetSnapshot.checkpointAt.toISOString(),
				periodMonth: targetSnapshot.periodMonth,
			},
			history: {
				available: false,
				verifiedInstanceCount,
				incompatibleInstanceCount,
				excludedFutureCount,
				excludedTargetCount,
				unsupportedRecommendationEngineVersions: [
					...unsupportedEngineVersions,
				].sort(),
				...(corruptionReason !== undefined ? { corruptionReason } : {}),
			},
			preferences,
			protectedKinds,
		};
	}

	// Calculate stats for all kinds
	for (const kind of ALL_BUDGET_V2_RECOMMENDATION_KINDS) {
		const votes = validHistoricalVotes.filter((v) => v.kind === kind);
		const validInstanceCount = votes.length;
		const acceptCount = votes.filter((v) => v.decision === "ACCEPT").length;
		const modifyCount = votes.filter((v) => v.decision === "MODIFY").length;
		const ignoreCount = votes.filter((v) => v.decision === "IGNORE").length;

		const distinctCheckpointCount = new Set(
			votes.map((v) => v.checkpointSnapshotId),
		).size;
		const distinctPeriodMonthCount = new Set(votes.map((v) => v.periodMonth))
			.size;

		let historySpanDays = 0;
		if (votes.length >= 2) {
			const timestamps = votes.map((v) => v.occurredAt.getTime());
			const minTs = Math.min(...timestamps);
			const maxTs = Math.max(...timestamps);
			historySpanDays = Math.floor((maxTs - minTs) / (24 * 60 * 60 * 1000));
		}

		// Deterministic latest decision: newest occurredAt wins; instanceId breaks
		// exact-instant ties so the result is byte-stable across DB orderings.
		votes.sort(
			(a, b) =>
				b.occurredAt.getTime() - a.occurredAt.getTime() ||
				(a.instanceId < b.instanceId
					? 1
					: a.instanceId > b.instanceId
						? -1
						: 0),
		);
		const latestVote = votes[0] ?? null;
		const latestDecision = latestVote?.decision ?? null;
		const latestDecisionAt = latestVote?.occurredAt.toISOString() ?? null;

		const acceptRateBp = computeFeedbackRateBp(acceptCount, validInstanceCount);
		const ignoreRateBp = computeFeedbackRateBp(ignoreCount, validInstanceCount);

		const evidence: BudgetV2FeedbackEvidence = {
			windowDays: BUDGET_V2_FEEDBACK_WINDOW_DAYS,
			rangeStart: windowRangeStart.toISOString(),
			rangeEnd: windowRangeEnd.toISOString(),
			validInstanceCount,
			acceptCount,
			modifyCount,
			ignoreCount,
			acceptRateBp,
			ignoreRateBp,
			distinctCheckpointCount,
			distinctPeriodMonthCount,
			historySpanDays,
			latestDecision,
			latestDecisionAt,
		};

		if (
			BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS.includes(
				kind as BudgetV2ProtectedRecommendationKind,
			)
		) {
			// Section 9: PROTECTED kinds never derive learned presentation state,
			// regardless of any ACCEPT / MODIFY / IGNORE audit counts above.
			protectedKinds[kind as BudgetV2ProtectedRecommendationKind] = {
				kind,
				attention: "PROTECTED",
				learned: false,
				evidenceStatus: "INSUFFICIENT",
				reasonCodes: ["PROTECTED_KIND"],
				evidence,
			};
		} else {
			const decision = evaluateBudgetV2AdaptiveKindAttention({
				validInstanceCount,
				acceptCount,
				modifyCount,
				ignoreCount,
				distinctCheckpointCount,
				distinctPeriodMonthCount,
				historySpanDays,
				latestDecision,
			});

			preferences[kind as BudgetV2AdaptiveRecommendationKind] = {
				kind,
				attention: decision.attention,
				learned: decision.learned,
				evidenceStatus: decision.evidenceStatus,
				reasonCodes: decision.reasonCodes,
				evidence,
			};
		}
	}

	return {
		engineVersion: BUDGET_V2_FEEDBACK_ADAPTATION_ENGINE_VERSION,
		through: {
			paymentEventId: targetSnapshot.paymentEventId,
			checkpointAt: targetSnapshot.checkpointAt.toISOString(),
			periodMonth: targetSnapshot.periodMonth,
		},
		history: {
			available: true,
			verifiedInstanceCount,
			incompatibleInstanceCount,
			excludedFutureCount,
			excludedTargetCount,
			unsupportedRecommendationEngineVersions: [
				...unsupportedEngineVersions,
			].sort(),
		},
		preferences,
		protectedKinds,
	};
}

/**
 * Builds the user-facing review view with attached feedback adaptation presentation metadata.
 * Does NOT alter underlying 6B recommendation eligibility, priority, order, or max-3 cap.
 */
export async function buildBudgetV2FeedbackAdaptedRecommendationView(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2FeedbackAdaptedRecommendationReviewView> {
	const reviewView = await buildBudgetV2RecommendationReviewView(params);
	const profile = await buildBudgetV2FeedbackPreferenceProfile(params);

	const adaptedItems: BudgetV2FeedbackAdaptedRecommendationReviewItem[] =
		reviewView.items.map((item) => {
			const kind = item.recommendation.kind;
			const pref =
				(profile.preferences as Record<string, BudgetV2KindFeedbackPreference>)[
					kind
				] ??
				(
					profile.protectedKinds as Record<
						string,
						BudgetV2KindFeedbackPreference
					>
				)[kind];

			const feedbackAdaptation: BudgetV2RecommendationFeedbackAdaptation = {
				attention: pref ? pref.attention : "STANDARD",
				learned: pref ? pref.learned : false,
				reasonCodes: pref ? pref.reasonCodes : ["STANDARD_DEFAULT"],
				evidence:
					pref?.evidence ??
					emptyEvidence(
						profile.through.checkpointAt,
						profile.through.checkpointAt,
					),
			};

			return {
				...item,
				feedbackAdaptation,
			};
		});

	return {
		...reviewView,
		items: adaptedItems,
		feedbackAdaptation: profile.history.available
			? { available: true }
			: {
					available: false,
					reason:
						profile.history.corruptionReason ??
						"VERIFIED_FEEDBACK_HISTORY_CORRUPT",
				},
		feedbackPreferenceProfile: profile,
	};
}
