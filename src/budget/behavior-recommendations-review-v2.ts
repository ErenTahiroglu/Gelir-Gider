import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	budgetV2RecommendationFeedbackRevisions,
	budgetV2RecommendationInstances,
} from "../db/schema/budget-v2-recommendation-feedback";
import type {
	BehaviorConfidence,
	BehaviorRegimeReview,
} from "./behavior-profile-v2";
import {
	type BudgetV2Recommendation,
	type BudgetV2RecommendationSet,
	type BudgetV2RecommendationSuppression,
	buildBudgetV2RecommendationSet,
} from "./behavior-recommendations-v2";
import {
	calculateRecommendationFingerprint,
	verifyStoredBudgetV2RecommendationFeedbackRevision,
	verifyStoredBudgetV2RecommendationInstance,
} from "./recommendation-feedback-canonical-v2";

export interface BudgetV2ReviewableRecommendation
	extends BudgetV2Recommendation {
	recommendationFingerprint: string;
}

export interface BudgetV2RecommendationReviewSet
	extends Omit<BudgetV2RecommendationSet, "recommendations"> {
	recommendations: BudgetV2ReviewableRecommendation[];
}

/**
 * Builds the reviewable recommendation set for a given payment event checkpoint.
 * Computes canonical SHA-256 fingerprints for each SHOWN recommendation.
 * Does NOT perform any DB writes. Suppressed recommendations remain audit trail only.
 */
export async function buildBudgetV2RecommendationReviewSet(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2RecommendationReviewSet> {
	const rawSet = await buildBudgetV2RecommendationSet(params);
	const reviewableRecommendations = await Promise.all(
		rawSet.recommendations.map(async (rec) => {
			const fingerprint = await calculateRecommendationFingerprint(rec);
			return {
				...rec,
				recommendationFingerprint: fingerprint,
			};
		}),
	);

	return {
		...rawSet,
		recommendations: reviewableRecommendations,
	};
}

export interface BudgetV2RecommendationDrift {
	currentRecommendationFingerprint: string;
	capturedRecommendationFingerprint: string;
	capturedRecommendation: BudgetV2Recommendation;
	historicalDecision: "ACCEPT" | "MODIFY" | "IGNORE";
	historicalFeedbackRevisionNo: number;
}

export interface BudgetV2RecommendationReviewItem {
	recommendation: BudgetV2ReviewableRecommendation;
	status:
		| "UNRESPONDED"
		| "ACCEPT"
		| "MODIFY"
		| "IGNORE"
		| "CHANGED_SINCE_RESPONSE";
	effectiveFeedback: {
		revisionNo: number;
		decision: "ACCEPT" | "MODIFY" | "IGNORE";
		modification: unknown | null;
		sourceKind: string;
		idempotencyKey: string;
		revisionFingerprint: string;
		occurredAt: string;
	} | null;
	drift?: BudgetV2RecommendationDrift;
}

export interface BudgetV2RecommendationReviewView {
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
	items: BudgetV2RecommendationReviewItem[];
	suppressed: BudgetV2RecommendationSuppression[];
}

/**
 * Builds a user-facing review view combining the current reviewable 6B recommendations
 * with their latest persisted feedback state if one exists.
 * Does NOT mutate recommendations or change recommendation generation.
 */
export async function buildBudgetV2RecommendationReviewView(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2RecommendationReviewView> {
	const reviewSet = await buildBudgetV2RecommendationReviewSet(params);

	const items: BudgetV2RecommendationReviewItem[] = await Promise.all(
		reviewSet.recommendations.map(async (rec) => {
			// Check if recommendation instance exists for this recommendation
			const instances = await params.db
				.select()
				.from(budgetV2RecommendationInstances)
				.where(
					and(
						eq(budgetV2RecommendationInstances.userId, params.userId),
						eq(
							budgetV2RecommendationInstances.recommendationId,
							rec.recommendationId,
						),
					),
				)
				.limit(1);

			const [instance] = instances;
			if (!instance) {
				return {
					recommendation: rec,
					status: "UNRESPONDED",
					effectiveFeedback: null,
				};
			}

			await verifyStoredBudgetV2RecommendationInstance(instance);

			// Load latest feedback revision
			const revisions = await params.db
				.select()
				.from(budgetV2RecommendationFeedbackRevisions)
				.where(
					eq(
						budgetV2RecommendationFeedbackRevisions.recommendationInstanceId,
						instance.id,
					),
				)
				.orderBy(desc(budgetV2RecommendationFeedbackRevisions.revisionNo))
				.limit(1);

			const [rev] = revisions;
			if (!rev) {
				return {
					recommendation: rec,
					status: "UNRESPONDED",
					effectiveFeedback: null,
				};
			}

			await verifyStoredBudgetV2RecommendationFeedbackRevision(rev);

			const decision = rev.decision as "ACCEPT" | "MODIFY" | "IGNORE";

			// Section 8: Compare current recommendation fingerprint vs stored instance fingerprint
			if (
				rec.recommendationFingerprint !== instance.recommendationFingerprint
			) {
				return {
					recommendation: rec,
					status: "CHANGED_SINCE_RESPONSE",
					effectiveFeedback: null,
					drift: {
						currentRecommendationFingerprint: rec.recommendationFingerprint,
						capturedRecommendationFingerprint:
							instance.recommendationFingerprint,
						capturedRecommendation:
							instance.recommendationJson as BudgetV2Recommendation,
						historicalDecision: decision,
						historicalFeedbackRevisionNo: rev.revisionNo,
					},
				};
			}

			return {
				recommendation: rec,
				status: decision,
				effectiveFeedback: {
					revisionNo: rev.revisionNo,
					decision,
					modification: rev.modificationJson,
					sourceKind: rev.sourceKind,
					idempotencyKey: rev.idempotencyKey,
					revisionFingerprint: rev.revisionFingerprint,
					occurredAt: rev.occurredAt.toISOString(),
				},
			};
		}),
	);

	return {
		engineVersion: reviewSet.engineVersion,
		generatedFrom: reviewSet.generatedFrom,
		through: reviewSet.through,
		confidence: reviewSet.confidence,
		regime: reviewSet.regime,
		recommendationCount: reviewSet.recommendationCount,
		eligibleCandidateCount: reviewSet.eligibleCandidateCount,
		suppressedCount: reviewSet.suppressedCount,
		items,
		suppressed: reviewSet.suppressed,
	};
}
