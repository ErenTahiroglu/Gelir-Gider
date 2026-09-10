import { describe, expect, it } from "vitest";
import type { BudgetV2Recommendation } from "../src/budget/behavior-recommendations-v2";
import { BudgetError } from "../src/budget/errors";
import {
	calculateFeedbackRevisionFingerprint,
	calculateRecommendationFingerprint,
	verifyStoredBudgetV2RecommendationInstance,
} from "../src/budget/recommendation-feedback-canonical-v2";
import {
	type BudgetV2RecommendationModification,
	validateAndNormalizeModification,
} from "../src/budget/recommendation-feedback-service-v2";

const BASE_REC: BudgetV2Recommendation = {
	recommendationId:
		"budget-v2-rec:v1:00000000-0000-0000-0000-000000000001:DATA_COMPLETION_REQUIRED:GLOBAL",
	kind: "DATA_COMPLETION_REQUIRED",
	priority: 100,
	urgency: "SAFETY",
	scope: "GLOBAL",
	throughPaymentEventId: "00000000-0000-0000-0000-000000000001",
	checkpointAt: "2026-09-15T12:00:00.000Z",
	periodMonth: "2026-09-01",
	confidenceRequired: "NONE",
	confidenceObserved: "HIGH",
	reasonCodes: ["REGIME_DATA_INCOMPLETE"],
	evidence: {
		regime: "DATA_INCOMPLETE",
		attributionComplete: false,
	},
	proposedAction: {
		action: "REVIEW_DATA_COMPLETION",
	},
	requiresUserApproval: true,
	automaticExecution: false,
	mutatesPolicy: false,
};

const SWEEP_REC: BudgetV2Recommendation = {
	recommendationId:
		"budget-v2-rec:v1:00000000-0000-0000-0000-000000000001:UNUSED_DISCRETIONARY_SWEEP_REVIEW:GLOBAL",
	kind: "UNUSED_DISCRETIONARY_SWEEP_REVIEW",
	priority: 20,
	urgency: "OPPORTUNITY",
	scope: "GLOBAL",
	throughPaymentEventId: "00000000-0000-0000-0000-000000000001",
	checkpointAt: "2026-09-15T12:00:00.000Z",
	periodMonth: "2026-09-01",
	confidenceRequired: "NONE",
	confidenceObserved: "HIGH",
	reasonCodes: ["CLEAN_SURPLUS_AVAILABLE"],
	evidence: {
		discretionaryRemaining: "500.00",
		availableToAllocateNow: "300.00",
	},
	proposedAction: {
		action: "REVIEW_UNUSED_DISCRETIONARY_SWEEP",
		suggestedReviewAmount: "300.00",
		allowedReviewDestinations: [
			"INTERNATIONAL_MOBILITY",
			"LONG_TERM_INVESTMENT",
		],
		autoSelectedDestination: null,
	},
	requiresUserApproval: true,
	automaticExecution: false,
	mutatesPolicy: false,
};

describe("Budget V2 Recommendation Fingerprint (Section 3)", () => {
	it("computes a deterministic 64-character lowercase SHA-256 hex fingerprint", async () => {
		const fp1 = await calculateRecommendationFingerprint(BASE_REC);
		const fp2 = await calculateRecommendationFingerprint(BASE_REC);

		expect(fp1).toMatch(/^[0-9a-f]{64}$/);
		expect(fp1).toBe(fp2);
	});

	it("produces a different fingerprint when evidence or proposedAction changes", async () => {
		const fp1 = await calculateRecommendationFingerprint(BASE_REC);

		const modifiedEvidence: BudgetV2Recommendation = {
			...BASE_REC,
			evidence: {
				...BASE_REC.evidence,
				attributionComplete: true,
			},
		};
		const fp2 = await calculateRecommendationFingerprint(modifiedEvidence);
		expect(fp2).not.toBe(fp1);

		const modifiedAction: BudgetV2Recommendation = {
			...SWEEP_REC,
			proposedAction: {
				action: "REVIEW_UNUSED_DISCRETIONARY_SWEEP",
				suggestedReviewAmount: "200.00",
				allowedReviewDestinations: [
					"INTERNATIONAL_MOBILITY",
					"LONG_TERM_INVESTMENT",
				],
				autoSelectedDestination: null,
			},
		};
		const fpSweep1 = await calculateRecommendationFingerprint(SWEEP_REC);
		const fpSweep2 = await calculateRecommendationFingerprint(modifiedAction);
		expect(fpSweep2).not.toBe(fpSweep1);
	});
});

describe("Feedback Revision Fingerprint (Section 16)", () => {
	it("computes deterministic SHA-256 for feedback revisions", async () => {
		const params = {
			userId: "00000000-0000-0000-0000-000000000002",
			recommendationInstanceId: "00000000-0000-0000-0000-000000000003",
			operation: "CREATE",
			revisionNo: 1,
			previousRevisionId: null,
			decision: "ACCEPT",
			modificationJson: null,
			sourceKind: "USER_APPROVED",
			occurredAt: new Date("2026-09-15T13:00:00.000Z"),
		};
		const fp1 = await calculateFeedbackRevisionFingerprint(params);
		const fp2 = await calculateFeedbackRevisionFingerprint(params);

		expect(fp1).toMatch(/^[0-9a-f]{64}$/);
		expect(fp1).toBe(fp2);

		const modifiedParams = {
			...params,
			decision: "IGNORE",
		};
		const fp3 = await calculateFeedbackRevisionFingerprint(modifiedParams);
		expect(fp3).not.toBe(fp1);
	});
});

describe("Stored Recommendation Instance Verification (Section 8 & 24)", () => {
	it("verifies a valid stored recommendation instance row", async () => {
		const fp = await calculateRecommendationFingerprint(BASE_REC);
		const row = {
			id: "00000000-0000-0000-0000-000000000010",
			userId: "00000000-0000-0000-0000-000000000002",
			checkpointSnapshotId: "00000000-0000-0000-0000-000000000020",
			paymentEventId: BASE_REC.throughPaymentEventId,
			recommendationId: BASE_REC.recommendationId,
			recommendationKind: BASE_REC.kind,
			recommendationScope: BASE_REC.scope,
			recommendationEngineVersion: "budget-v2-recommendation-engine-v1",
			behaviorEngineVersion: "budget-v2-behavior-engine-v1",
			observationContractVersion: "budget-v2-observation-contract-v1",
			priority: BASE_REC.priority,
			recommendationJson: BASE_REC,
			recommendationFingerprint: fp,
			capturedAt: new Date("2026-09-15T13:00:00.000Z"),
			createdAt: new Date("2026-09-15T13:00:00.000Z"),
		};

		await expect(
			verifyStoredBudgetV2RecommendationInstance(row),
		).resolves.toBeUndefined();
	});

	it("fails closed on tampered recommendation_json", async () => {
		const fp = await calculateRecommendationFingerprint(BASE_REC);
		const tamperedRec = {
			...BASE_REC,
			priority: 50, // tampered
		};
		const row = {
			id: "00000000-0000-0000-0000-000000000010",
			userId: "00000000-0000-0000-0000-000000000002",
			checkpointSnapshotId: "00000000-0000-0000-0000-000000000020",
			paymentEventId: BASE_REC.throughPaymentEventId,
			recommendationId: BASE_REC.recommendationId,
			recommendationKind: BASE_REC.kind,
			recommendationScope: BASE_REC.scope,
			recommendationEngineVersion: "budget-v2-recommendation-engine-v1",
			behaviorEngineVersion: "budget-v2-behavior-engine-v1",
			observationContractVersion: "budget-v2-observation-contract-v1",
			priority: BASE_REC.priority,
			recommendationJson: tamperedRec,
			recommendationFingerprint: fp,
			capturedAt: new Date("2026-09-15T13:00:00.000Z"),
			createdAt: new Date("2026-09-15T13:00:00.000Z"),
		};

		await expect(
			verifyStoredBudgetV2RecommendationInstance(row),
		).rejects.toThrow(BudgetError);
		await expect(
			verifyStoredBudgetV2RecommendationInstance(row),
		).rejects.toMatchObject({
			code: "BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
		});
	});

	it("fails closed on column mismatch against recommendation_json", async () => {
		const fp = await calculateRecommendationFingerprint(BASE_REC);
		const row = {
			id: "00000000-0000-0000-0000-000000000010",
			userId: "00000000-0000-0000-0000-000000000002",
			checkpointSnapshotId: "00000000-0000-0000-0000-000000000020",
			paymentEventId: BASE_REC.throughPaymentEventId,
			recommendationId: "different-id",
			recommendationKind: BASE_REC.kind,
			recommendationScope: BASE_REC.scope,
			recommendationEngineVersion: "budget-v2-recommendation-engine-v1",
			behaviorEngineVersion: "budget-v2-behavior-engine-v1",
			observationContractVersion: "budget-v2-observation-contract-v1",
			priority: BASE_REC.priority,
			recommendationJson: BASE_REC,
			recommendationFingerprint: fp,
			capturedAt: new Date("2026-09-15T13:00:00.000Z"),
			createdAt: new Date("2026-09-15T13:00:00.000Z"),
		};

		await expect(
			verifyStoredBudgetV2RecommendationInstance(row),
		).rejects.toMatchObject({
			code: "BUDGET_RECOMMENDATION_INSTANCE_CORRUPT",
		});
	});
});

describe("Modification Schema Validation (Sections 10 & 11)", () => {
	it("accepts null modification for ACCEPT and IGNORE", () => {
		expect(
			validateAndNormalizeModification("ACCEPT", null, BASE_REC),
		).toBeNull();
		expect(
			validateAndNormalizeModification("IGNORE", undefined, BASE_REC),
		).toBeNull();
	});

	it("rejects non-null modification for ACCEPT and IGNORE", () => {
		expect(() =>
			validateAndNormalizeModification(
				"ACCEPT",
				{ type: "NOTE_ONLY", note: "some note" },
				BASE_REC,
			),
		).toThrow(BudgetError);

		expect(() =>
			validateAndNormalizeModification(
				"IGNORE",
				{ type: "NOTE_ONLY", note: "some note" },
				BASE_REC,
			),
		).toThrow(BudgetError);
	});

	it("accepts valid NOTE_ONLY modification for any recommendation kind", () => {
		const mod = validateAndNormalizeModification(
			"MODIFY",
			{ type: "NOTE_ONLY", note: "  I want to review this next week  " },
			BASE_REC,
		);
		expect(mod).toEqual({
			type: "NOTE_ONLY",
			note: "I want to review this next week",
		});
	});

	it("rejects invalid NOTE_ONLY modifications (empty, whitespace, >500 chars, extra keys)", () => {
		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{ type: "NOTE_ONLY", note: "" },
				BASE_REC,
			),
		).toThrow(BudgetError);

		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{ type: "NOTE_ONLY", note: "   " },
				BASE_REC,
			),
		).toThrow(BudgetError);

		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{ type: "NOTE_ONLY", note: "a".repeat(501) },
				BASE_REC,
			),
		).toThrow(BudgetError);

		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "NOTE_ONLY",
					note: "valid",
					extraKey: 123,
				} as unknown as BudgetV2RecommendationModification,
				BASE_REC,
			),
		).toThrow(BudgetError);
	});

	it("accepts valid SWEEP_REVIEW modification within bounds", () => {
		const mod = validateAndNormalizeModification(
			"MODIFY",
			{
				type: "SWEEP_REVIEW",
				suggestedReviewAmount: "250.00",
				destination: "INTERNATIONAL_MOBILITY",
				note: "Split for travel",
			},
			SWEEP_REC,
		);
		expect(mod).toEqual({
			type: "SWEEP_REVIEW",
			suggestedReviewAmount: "250.00",
			destination: "INTERNATIONAL_MOBILITY",
			note: "Split for travel",
		});

		// null destination is also valid
		const modNullDest = validateAndNormalizeModification(
			"MODIFY",
			{
				type: "SWEEP_REVIEW",
				suggestedReviewAmount: "300.00",
				destination: null,
			},
			SWEEP_REC,
		);
		expect(modNullDest).toEqual({
			type: "SWEEP_REVIEW",
			suggestedReviewAmount: "300.00",
			destination: null,
		});
	});

	it("rejects SWEEP_REVIEW on non-sweep recommendation kinds", () => {
		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "SWEEP_REVIEW",
					suggestedReviewAmount: "100.00",
					destination: null,
				},
				BASE_REC,
			),
		).toThrow(BudgetError);
	});

	it("rejects SWEEP_REVIEW with modified amount > original suggestion", () => {
		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "SWEEP_REVIEW",
					suggestedReviewAmount: "350.00", // original was 300.00
					destination: "INTERNATIONAL_MOBILITY",
				},
				SWEEP_REC,
			),
		).toThrow(BudgetError);
	});

	it("rejects SWEEP_REVIEW with non-positive amount or invalid destination", () => {
		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "SWEEP_REVIEW",
					suggestedReviewAmount: "0.00",
					destination: "INTERNATIONAL_MOBILITY",
				},
				SWEEP_REC,
			),
		).toThrow(BudgetError);

		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "SWEEP_REVIEW",
					suggestedReviewAmount: "-50.00",
					destination: "INTERNATIONAL_MOBILITY",
				},
				SWEEP_REC,
			),
		).toThrow(BudgetError);

		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "SWEEP_REVIEW",
					suggestedReviewAmount: "100.00",
					destination:
						"INVALID_DESTINATION" as unknown as "INTERNATIONAL_MOBILITY",
				},
				SWEEP_REC,
			),
		).toThrow(BudgetError);
	});

	it("rejects arbitrary financial modifications or unknown types", () => {
		expect(() =>
			validateAndNormalizeModification(
				"MODIFY",
				{
					type: "CUSTOM_REALLOCATION",
					amount: "100.00",
					targetBucket: "123",
				} as unknown as BudgetV2RecommendationModification,
				BASE_REC,
			),
		).toThrow(BudgetError);
	});
});
