import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { budgetV2CheckpointSnapshots } from "../db/schema/budget-v2-checkpoint";
import type { BudgetV2BehaviorProfile } from "./behavior-profile-v2";
import { buildBudgetV2BehaviorProfile } from "./behavior-profile-v2";
import { verifyStoredCheckpointSnapshot } from "./checkpoint-canonical-v2";
import type { BudgetV2FeedbackAdaptedRecommendationReviewView } from "./feedback-adaptation-v2";
import { buildBudgetV2FeedbackAdaptedRecommendationView } from "./feedback-adaptation-v2";
import { normalizeUuid } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- PRODUCT INTEGRATION BOUNDARY (Checkpoint 7A).
 *
 * A tiny product-facing read facade. It COMPOSES the existing authoritative
 * Budget V2 services -- it re-implements none of them:
 *
 *   - the frozen persisted checkpoint report          (integrity-verified)
 *   - `buildBudgetV2BehaviorProfile(...)`             (6A, as-of the target)
 *   - `buildBudgetV2FeedbackAdaptedRecommendationView` (6B + 6C + 6D)
 *
 * It performs NO database writes, NO financial execution, NO live checkpoint
 * recomputation, and NO "latest checkpoint" inference: every read is anchored
 * to one EXPLICIT persisted `throughPaymentEventId` owned by the caller.
 *
 * The HTTP adapter in `src/http/budget-v2-routes.ts` is the only caller. It
 * validates transport input, authenticates the user, invokes these functions
 * with the authenticated `userId`, and serializes the result.
 */

/**
 * In-memory response-contract version for the product boundary. NOT persisted
 * and independent of the checkpoint-report / behavior-engine /
 * recommendation-engine / feedback-adaptation versions.
 */
export const BUDGET_V2_PRODUCT_API_VERSION = "budget-v2-product-api-v1";

export const BUDGET_V2_TIMELINE_DEFAULT_LIMIT = 50;
export const BUDGET_V2_TIMELINE_MAX_LIMIT = 100;

export type BudgetV2DecisionCenterErrorCode =
	| "BUDGET_V2_PRODUCT_INVALID_INPUT"
	| "BUDGET_V2_CHECKPOINT_NOT_FOUND";

/**
 * Facade-level error. The route maps `BUDGET_V2_PRODUCT_INVALID_INPUT` -> 400
 * and `BUDGET_V2_CHECKPOINT_NOT_FOUND` -> 404. A `BUDGET_V2_CHECKPOINT_NOT_FOUND`
 * is raised for BOTH a payment event that does not exist and one owned by a
 * different user -- the two are indistinguishable to the caller by design.
 */
export class BudgetV2DecisionCenterError extends Error {
	readonly code: BudgetV2DecisionCenterErrorCode;

	constructor(code: BudgetV2DecisionCenterErrorCode, message: string) {
		super(message);
		this.name = "BudgetV2DecisionCenterError";
		this.code = code;
		Object.setPrototypeOf(this, BudgetV2DecisionCenterError.prototype);
	}
}

export interface BudgetV2CheckpointTimelineEntry {
	paymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
}

export interface BudgetV2CheckpointTimeline {
	apiVersion: string;
	limit: number;
	/**
	 * True when two or more of the authenticated user's persisted checkpoints
	 * share the maximum `checkpointAt` instant. Computed over the FULL persisted
	 * history, independent of the requested `limit` -- so a `?limit=1` request
	 * still reports `true` when the newest instant is shared. The product must
	 * not silently designate a single row as uniquely "latest" in that case
	 * (Section 5 / 19).
	 */
	sharedMaxCheckpointAt: boolean;
	checkpoints: BudgetV2CheckpointTimelineEntry[];
}

function normalizeTimelineLimit(limit: number | undefined): number {
	if (limit === undefined) return BUDGET_V2_TIMELINE_DEFAULT_LIMIT;
	if (
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > BUDGET_V2_TIMELINE_MAX_LIMIT
	) {
		throw new BudgetV2DecisionCenterError(
			"BUDGET_V2_PRODUCT_INVALID_INPUT",
			`limit must be an integer between 1 and ${BUDGET_V2_TIMELINE_MAX_LIMIT}`,
		);
	}
	return limit;
}

/**
 * Bounded checkpoint discovery for the authenticated user. Returns metadata
 * only -- never the full frozen report for a row. Ordered `checkpointAt` DESC,
 * with `paymentEventId` ASC as a STABLE PRESENTATION-ONLY tiebreak that carries
 * no temporal/financial meaning. Every returned row is still integrity-verified
 * against the persisted identity columns; a corrupt row fails the whole read
 * closed (never a silent drop / repaired read).
 */
export async function buildBudgetV2CheckpointTimeline(params: {
	db: Database;
	userId: string;
	limit?: number;
}): Promise<BudgetV2CheckpointTimeline> {
	const userId = normalizeUuid(params.userId, "userId");
	const limit = normalizeTimelineLimit(params.limit);

	const rows = await params.db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(eq(budgetV2CheckpointSnapshots.userId, userId))
		.orderBy(
			desc(budgetV2CheckpointSnapshots.checkpointAt),
			// Presentation-only stable secondary key -- NOT a "latest" designator.
			desc(budgetV2CheckpointSnapshots.paymentEventId),
		)
		.limit(limit);

	// `sharedMaxCheckpointAt` must reflect the TRUE maximum across the user's
	// entire persisted history, not merely the (possibly `limit`-truncated)
	// page above. The two newest `checkpointAt` values are enough to decide it
	// and the read stays bounded to two rows regardless of `limit`.
	const newestTwo = await params.db
		.select({ checkpointAt: budgetV2CheckpointSnapshots.checkpointAt })
		.from(budgetV2CheckpointSnapshots)
		.where(eq(budgetV2CheckpointSnapshots.userId, userId))
		.orderBy(desc(budgetV2CheckpointSnapshots.checkpointAt))
		.limit(2);
	const newest = newestTwo[0];
	const secondNewest = newestTwo[1];
	const sharedMaxCheckpointAt =
		newest !== undefined &&
		secondNewest !== undefined &&
		newest.checkpointAt.getTime() === secondNewest.checkpointAt.getTime();

	const checkpoints: BudgetV2CheckpointTimelineEntry[] = [];
	for (const row of rows) {
		await verifyStoredCheckpointSnapshot({
			reportSchemaVersion: row.reportSchemaVersion,
			reportJson: row.reportJson,
			reportFingerprint: row.reportFingerprint,
			paymentEventId: row.paymentEventId,
			periodMonth: row.periodMonth,
			checkpointAt: row.checkpointAt,
			previousCheckpointAt: row.previousCheckpointAt,
		});
		checkpoints.push({
			paymentEventId: row.paymentEventId,
			checkpointAt: row.checkpointAt.toISOString(),
			periodMonth: row.periodMonth,
		});
	}

	return {
		apiVersion: BUDGET_V2_PRODUCT_API_VERSION,
		limit,
		sharedMaxCheckpointAt,
		checkpoints,
	};
}

export interface BudgetV2DecisionCenterView {
	apiVersion: string;
	target: {
		paymentEventId: string;
		checkpointAt: string;
		periodMonth: string;
	};
	checkpoint: {
		temporalScope: "FROZEN_AT_CHECKPOINT";
		report: unknown;
	};
	behavior: {
		temporalScope: "AS_OF_CHECKPOINT";
		profile: BudgetV2BehaviorProfile;
	};
	recommendations: {
		generationScope: "AS_OF_CHECKPOINT";
		adaptationScope: "AS_OF_CHECKPOINT";
		/**
		 * ACCEPT / MODIFY / IGNORE review status is CURRENT, not as-of: an old
		 * checkpoint can legitimately show a historical recommendation/adaptation
		 * next to a response the user entered later (Section 8 / 21).
		 */
		feedbackStatusScope: "CURRENT";
		view: BudgetV2FeedbackAdaptedRecommendationReviewView;
	};
}

/**
 * Unified Decision Center read model for ONE explicit persisted checkpoint
 * owned by `userId`. Composes the verified frozen report, the as-of behavior
 * profile, and the as-of feedback-adapted recommendation view (whose review
 * status is CURRENT). Never rebuilds the checkpoint from live financial state.
 */
export async function buildBudgetV2DecisionCenterView(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2DecisionCenterView> {
	const userId = normalizeUuid(params.userId, "userId");
	let throughPaymentEventId: string;
	try {
		throughPaymentEventId = normalizeUuid(
			params.throughPaymentEventId,
			"throughPaymentEventId",
		);
	} catch {
		throw new BudgetV2DecisionCenterError(
			"BUDGET_V2_PRODUCT_INVALID_INPUT",
			"throughPaymentEventId must be a valid UUID",
		);
	}

	const [row] = await params.db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(
			and(
				eq(budgetV2CheckpointSnapshots.userId, userId),
				eq(budgetV2CheckpointSnapshots.paymentEventId, throughPaymentEventId),
			),
		)
		.limit(1);

	if (!row) {
		throw new BudgetV2DecisionCenterError(
			"BUDGET_V2_CHECKPOINT_NOT_FOUND",
			"no persisted Budget V2 checkpoint for this payment event",
		);
	}

	// Section 6: a full Decision Center read MUST verify the persisted snapshot.
	await verifyStoredCheckpointSnapshot({
		reportSchemaVersion: row.reportSchemaVersion,
		reportJson: row.reportJson,
		reportFingerprint: row.reportFingerprint,
		paymentEventId: row.paymentEventId,
		periodMonth: row.periodMonth,
		checkpointAt: row.checkpointAt,
		previousCheckpointAt: row.previousCheckpointAt,
	});

	const profile = await buildBudgetV2BehaviorProfile({
		db: params.db,
		userId,
		throughPaymentEventId,
	});

	const view = await buildBudgetV2FeedbackAdaptedRecommendationView({
		db: params.db,
		userId,
		throughPaymentEventId,
	});

	return {
		apiVersion: BUDGET_V2_PRODUCT_API_VERSION,
		target: {
			paymentEventId: row.paymentEventId,
			checkpointAt: row.checkpointAt.toISOString(),
			periodMonth: row.periodMonth,
		},
		checkpoint: {
			temporalScope: "FROZEN_AT_CHECKPOINT",
			report: row.reportJson,
		},
		behavior: {
			temporalScope: "AS_OF_CHECKPOINT",
			profile,
		},
		recommendations: {
			generationScope: "AS_OF_CHECKPOINT",
			adaptationScope: "AS_OF_CHECKPOINT",
			feedbackStatusScope: "CURRENT",
			view,
		},
	};
}
