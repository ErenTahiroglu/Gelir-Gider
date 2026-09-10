import type { BudgetV2Recommendation } from "./behavior-recommendations-v2";
import { canonicalJsonStringify } from "./checkpoint-canonical-v2";
import { BudgetError } from "./errors";

/**
 * Deterministic lowercase SHA-256 hex digest of a UTF-8 string.
 */
export async function sha256HexOfString(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Builds the canonical payload covering all semantic fields of a recommendation.
 * Explicitly excludes any recursive fingerprint field.
 */
export function buildCanonicalRecommendationPayload(
	rec: BudgetV2Recommendation,
): Record<string, unknown> {
	return {
		recommendationId: rec.recommendationId,
		kind: rec.kind,
		priority: rec.priority,
		urgency: rec.urgency,
		scope: rec.scope,
		throughPaymentEventId: rec.throughPaymentEventId,
		checkpointAt: rec.checkpointAt,
		periodMonth: rec.periodMonth,
		confidenceRequired: rec.confidenceRequired,
		confidenceObserved: rec.confidenceObserved,
		reasonCodes: rec.reasonCodes,
		evidence: rec.evidence,
		proposedAction: rec.proposedAction,
		requiresUserApproval: rec.requiresUserApproval,
		automaticExecution: rec.automaticExecution,
		mutatesPolicy: rec.mutatesPolicy,
	};
}

/**
 * Computes the canonical SHA-256 fingerprint for a Budget V2 recommendation.
 */
export async function calculateRecommendationFingerprint(
	rec: BudgetV2Recommendation,
): Promise<string> {
	const payload = buildCanonicalRecommendationPayload(rec);
	return sha256HexOfString(canonicalJsonStringify(payload));
}

export interface FeedbackRevisionFingerprintParams {
	userId: string;
	recommendationInstanceId: string;
	operation: string;
	revisionNo: number;
	previousRevisionId: string | null;
	decision: string;
	modificationJson: unknown;
	sourceKind: string;
	occurredAt: Date;
}

/**
 * Computes the canonical SHA-256 fingerprint for a recommendation feedback revision.
 */
export async function calculateFeedbackRevisionFingerprint(
	params: FeedbackRevisionFingerprintParams,
): Promise<string> {
	const payload = {
		userId: params.userId,
		recommendationInstanceId: params.recommendationInstanceId,
		operation: params.operation,
		revisionNo: params.revisionNo,
		previousRevisionId: params.previousRevisionId,
		decision: params.decision,
		modificationJson: params.modificationJson ?? null,
		sourceKind: params.sourceKind,
		occurredAt: params.occurredAt.toISOString(),
	};
	return sha256HexOfString(canonicalJsonStringify(payload));
}

export interface StoredBudgetV2RecommendationInstanceRow {
	id: string;
	userId: string;
	checkpointSnapshotId: string;
	paymentEventId: string;
	recommendationId: string;
	recommendationKind: string;
	recommendationScope: string;
	recommendationEngineVersion: string;
	behaviorEngineVersion: string;
	observationContractVersion: string;
	priority: number;
	recommendationJson: unknown;
	recommendationFingerprint: string;
	capturedAt: Date;
	createdAt: Date;
}

/**
 * Re-derives and verifies the integrity of a stored recommendation instance
 * before handing it back or updating it. Any divergence between the frozen
 * recommendation_json and the stored identity columns or recomputed fingerprint
 * is a typed corruption error -- never a silently "repaired" read.
 */
export async function verifyStoredBudgetV2RecommendationInstance(
	row: StoredBudgetV2RecommendationInstanceRow,
): Promise<void> {
	const rec = row.recommendationJson as
		| BudgetV2Recommendation
		| null
		| undefined;
	if (!rec || typeof rec !== "object") {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} has invalid or non-object recommendation_json`,
		);
	}

	const recomputed = await calculateRecommendationFingerprint(rec);
	if (recomputed !== row.recommendationFingerprint) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} fingerprint mismatch: stored ${row.recommendationFingerprint}, recomputed ${recomputed}`,
		);
	}

	if (rec.recommendationId !== row.recommendationId) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} recommendationId mismatch: JSON ${rec.recommendationId} vs column ${row.recommendationId}`,
		);
	}

	if (rec.kind !== row.recommendationKind) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} kind mismatch: JSON ${rec.kind} vs column ${row.recommendationKind}`,
		);
	}

	if (rec.scope !== row.recommendationScope) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} scope mismatch: JSON ${rec.scope} vs column ${row.recommendationScope}`,
		);
	}

	if (rec.priority !== row.priority) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} priority mismatch: JSON ${rec.priority} vs column ${row.priority}`,
		);
	}

	if (rec.throughPaymentEventId !== row.paymentEventId) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} throughPaymentEventId mismatch: JSON ${rec.throughPaymentEventId} vs column ${row.paymentEventId}`,
		);
	}

	if (rec.requiresUserApproval !== true) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} requiresUserApproval must be true`,
		);
	}

	if (rec.automaticExecution !== false) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} automaticExecution must be false`,
		);
	}

	if (rec.mutatesPolicy !== false) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
			`recommendation instance ${row.id} mutatesPolicy must be false`,
		);
	}
}

export interface StoredBudgetV2RecommendationFeedbackRevisionRow {
	id: string;
	userId: string;
	recommendationInstanceId: string;
	revisionNo: number;
	previousRevisionId: string | null;
	operation: string;
	decision: string;
	modificationJson: unknown;
	sourceKind: string;
	idempotencyKey: string;
	revisionFingerprint: string;
	occurredAt: Date;
	createdAt: Date;
}

/**
 * Re-derives and verifies the integrity of a stored recommendation feedback revision.
 * Any mismatch between the stored row data and its recomputed revision fingerprint
 * is a typed corruption error -- fail closed, never silently ignored or repaired.
 */
export async function verifyStoredBudgetV2RecommendationFeedbackRevision(
	row: StoredBudgetV2RecommendationFeedbackRevisionRow,
): Promise<void> {
	if (!row || typeof row !== "object") {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_FEEDBACK_CORRUPT",
			"feedback revision row is invalid or null",
		);
	}

	const occurredAt =
		row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt);

	const recomputed = await calculateFeedbackRevisionFingerprint({
		userId: row.userId,
		recommendationInstanceId: row.recommendationInstanceId,
		operation: row.operation,
		revisionNo: row.revisionNo,
		previousRevisionId: row.previousRevisionId,
		decision: row.decision,
		modificationJson: row.modificationJson,
		sourceKind: row.sourceKind,
		occurredAt,
	});

	if (recomputed !== row.revisionFingerprint) {
		throw new BudgetError(
			"BUDGET_RECOMMENDATION_FEEDBACK_CORRUPT",
			`feedback revision ${row.id} fingerprint mismatch: stored ${row.revisionFingerprint}, recomputed ${recomputed}`,
		);
	}
}
