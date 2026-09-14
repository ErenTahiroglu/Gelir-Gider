import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	campaignFamilies,
	campaignPeriodRevisionCards,
	campaignPeriodRevisions,
	campaignPeriods,
	campaignPurchaseOverrideRevisions,
	campaignPurchaseOverrides,
	campaignReviewCandidateRevisions,
	campaignReviewCandidates,
	campaignRewardCreditRevisions,
	campaignRewardCredits,
} from "../db/schema/campaigns";
import { runCampaignsReadTransaction } from "./boundary";
import { validateCampaignCanonicalUuid } from "./calendar";
import { CampaignError } from "./errors";
import type {
	CampaignPeriodCursor,
	CampaignProgressPurchaseCursor,
	CampaignReviewCandidateCursor,
} from "./pagination";
import type {
	CampaignProgressReadModel,
	CampaignQualificationStatus,
	CampaignQualifyingPurchase,
} from "./progress";
import { getCampaignProgressInTransaction } from "./progress";
import type { CampaignReviewCandidateReadModel } from "./review-candidates";
import type { CampaignPurchaseEligibilityStatus } from "./rules";
import type {
	CampaignPeriodRevisionReadModel,
	CampaignRewardCreditReadModel,
} from "./service";
import { getLatestRevisionInTransaction } from "./service";
import type { CampaignSourceSnapshotReadModel } from "./sources";

// ============================================================================
// Product DTO Interfaces (Sanitized Public Surface)
// ============================================================================

export interface CampaignPeriodProductDto {
	campaignPeriodId: string;
	provider: string;
	familyKey: string;
	periodKey: string;
	revisionNo: number;
	operation: string;
	lifecycleStatus: "REVIEW_REQUIRED" | "ACTIVE" | "ENDED" | "CANCELLED";
	visibility: "VISIBLE" | "HIDDEN";
	title: string;
	startsOn: string;
	endsOn: string;
	ruleMode: "TOTAL_SPEND" | "TRANSACTION_COUNT" | "REPEATABLE_SPEND";
	targetSpendAmount: string | null;
	requiredTransactionCount: number | null;
	minimumTransactionAmount: string | null;
	stepSpendAmount: string | null;
	rewardPointsPerStep: string | null;
	maxSteps: number | null;
	rewardKind: "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL";
	rewardAccountId: string | null;
	expectedRewardPoints: string | null;
	merchantScopeMode:
		| "ALL_MERCHANTS"
		| "MERCHANT_ALIASES"
		| "MANUAL_REVIEW_REQUIRED";
	requiredCanonicalMerchantNames: string[] | null;
	allowedMccCodes: string[] | null;
	rewardExpiryDate: string | null;
	sourceSnapshotId: string | null;
	parserType: string | null;
	parserVersion: string | null;
	parserConfidence: string | null;
	note: string | null;
	cardIds: string[];
	occurredAt: string;
	createdAt: string;
}

export interface CampaignProgressProductDto {
	campaignPeriodId: string;
	lifecycleStatus: "REVIEW_REQUIRED" | "ACTIVE" | "ENDED" | "CANCELLED";
	visibility: "VISIBLE" | "HIDDEN";
	startsOn: string;
	endsOn: string;
	ruleMode: "TOTAL_SPEND" | "TRANSACTION_COUNT" | "REPEATABLE_SPEND";
	eligibleSpend: string;
	eligibleTransactionCount: number;
	requiredSpend: string | null;
	requiredTransactionCount: number | null;
	stepsEarned: number | null;
	maxSteps: number | null;
	progressNumerator: string;
	progressDenominator: string | null;
	progressPercentage: number | null;
	qualificationStatus: CampaignQualificationStatus;
	expectedRewardKind: "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL";
	expectedRewardPoints: string | null;
	actualRewardPointsCredited: string | null;
	needsReviewCount: number;
	needsReviewAmount: string;
}

export interface CampaignProgressPurchaseProductDto {
	purchaseEventId: string;
	amount: string;
	purchaseDate: string | null;
	merchant: string | null;
	status: CampaignPurchaseEligibilityStatus;
	override: {
		revisionNo: number;
		operation: "INCLUDE" | "EXCLUDE" | "CLEAR";
		reasonNote: string | null;
		occurredAt: string;
	} | null;
}

export interface CampaignOverrideProductDto {
	purchaseEventId: string;
	revisionNo: number;
	operation: "INCLUDE" | "EXCLUDE" | "CLEAR";
	reasonNote: string | null;
	occurredAt: string;
}

export interface CampaignRewardCreditProductDto {
	creditId: string;
	campaignPeriodId: string;
	rewardAccountId: string;
	revisionNo: number;
	actualPointAmount: string;
	expectedPointAmount: string;
	rewardEventId: string;
	reasonNote: string | null;
	occurredAt: string;
}

export interface CampaignReviewCandidateProductDto {
	candidateId: string;
	campaignPeriodId: string;
	sourceSnapshotId: string;
	revisionNo: number;
	operation: "CREATE" | "APPLY" | "DISMISS";
	status: "PENDING" | "APPLIED" | "DISMISSED";
	title: string;
	startsOn: string;
	endsOn: string;
	ruleMode: "TOTAL_SPEND" | "TRANSACTION_COUNT" | "REPEATABLE_SPEND";
	targetSpendAmount: string | null;
	requiredTransactionCount: number | null;
	minimumTransactionAmount: string | null;
	stepSpendAmount: string | null;
	rewardPointsPerStep: string | null;
	maxSteps: number | null;
	rewardKind: "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL";
	rewardAccountId: string | null;
	expectedRewardPoints: string | null;
	merchantScopeMode:
		| "ALL_MERCHANTS"
		| "MERCHANT_ALIASES"
		| "MANUAL_REVIEW_REQUIRED";
	requiredCanonicalMerchantNames: string[] | null;
	allowedMccCodes: string[] | null;
	rewardExpiryDate: string | null;
	parserType: string | null;
	parserVersion: string | null;
	parserConfidence: string | null;
	proposedCardIds: string[];
	occurredAt: string;
	createdAt: string;
}

export interface CampaignSourceSnapshotProductDto {
	sourceSnapshotId: string;
	provider: string;
	sourceType: "MANUAL" | "OFFICIAL_PUBLIC_PAGE" | "IMPORT";
	sourceUrl: string | null;
	externalSourceId: string | null;
	sourceTitle: string | null;
	sourceText: string | null;
	capturedAt: string;
	createdAt: string;
}

export interface CampaignSemanticDiffItemDto {
	field: string;
	currentValue: unknown;
	candidateValue: unknown;
}

// ============================================================================
// Public DTO Mappers
// ============================================================================

export function toCampaignPeriodProductDto(
	model: CampaignPeriodRevisionReadModel,
): CampaignPeriodProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		campaignPeriodId: model.campaignPeriodId,
		provider: model.provider,
		familyKey: model.familyKey,
		periodKey: model.periodKey,
		revisionNo: model.revisionNo,
		operation: model.operation,
		lifecycleStatus: model.lifecycleStatus,
		visibility: model.visibility,
		title: model.title,
		startsOn: model.startsOn,
		endsOn: model.endsOn,
		ruleMode: model.ruleMode,
		targetSpendAmount: model.targetSpendAmount,
		requiredTransactionCount: model.requiredTransactionCount,
		minimumTransactionAmount: model.minimumTransactionAmount,
		stepSpendAmount: model.stepSpendAmount,
		rewardPointsPerStep: model.rewardPointsPerStep,
		maxSteps: model.maxSteps,
		rewardKind: model.rewardKind,
		rewardAccountId: model.rewardAccountId,
		expectedRewardPoints: model.expectedRewardPoints,
		merchantScopeMode: model.merchantScopeMode,
		requiredCanonicalMerchantNames: model.requiredCanonicalMerchantNames,
		allowedMccCodes: model.allowedMccCodes,
		rewardExpiryDate: model.rewardExpiryDate,
		sourceSnapshotId: model.sourceSnapshotId,
		parserType: model.parserType,
		parserVersion: model.parserVersion,
		parserConfidence: model.parserConfidence,
		note: model.note,
		cardIds: model.cardIds,
		occurredAt: occurredAtStr,
		createdAt: createdAtStr,
	};
}

export function toCampaignProgressProductDto(
	model: CampaignProgressReadModel,
): CampaignProgressProductDto {
	return {
		campaignPeriodId: model.campaignPeriodId,
		lifecycleStatus: model.lifecycleStatus,
		visibility: model.visibility,
		startsOn: model.startsOn,
		endsOn: model.endsOn,
		ruleMode: model.ruleMode,
		eligibleSpend: model.eligibleSpend,
		eligibleTransactionCount: model.eligibleTransactionCount,
		requiredSpend: model.requiredSpend,
		requiredTransactionCount: model.requiredTransactionCount,
		stepsEarned: model.stepsEarned,
		maxSteps: model.maxSteps,
		progressNumerator: model.progressNumerator,
		progressDenominator: model.progressDenominator,
		progressPercentage: model.progressPercentage,
		qualificationStatus: model.qualificationStatus,
		expectedRewardKind: model.expectedRewardKind,
		expectedRewardPoints: model.expectedRewardPoints,
		actualRewardPointsCredited: model.actualRewardPointsCredited,
		needsReviewCount: model.needsReviewCount,
		needsReviewAmount: model.needsReviewAmount,
	};
}

export function toCampaignReviewCandidateProductDto(
	model: CampaignReviewCandidateReadModel,
): CampaignReviewCandidateProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		candidateId: model.candidateId,
		campaignPeriodId: model.campaignPeriodId,
		sourceSnapshotId: model.sourceSnapshotId,
		revisionNo: model.revisionNo,
		operation: model.operation,
		status: model.status,
		title: model.title,
		startsOn: model.startsOn,
		endsOn: model.endsOn,
		ruleMode: model.ruleMode,
		targetSpendAmount: model.targetSpendAmount,
		requiredTransactionCount: model.requiredTransactionCount,
		minimumTransactionAmount: model.minimumTransactionAmount,
		stepSpendAmount: model.stepSpendAmount,
		rewardPointsPerStep: model.rewardPointsPerStep,
		maxSteps: model.maxSteps,
		rewardKind: model.rewardKind,
		rewardAccountId: model.rewardAccountId,
		expectedRewardPoints: model.expectedRewardPoints,
		merchantScopeMode: model.merchantScopeMode,
		requiredCanonicalMerchantNames: model.requiredCanonicalMerchantNames,
		allowedMccCodes: model.allowedMccCodes,
		rewardExpiryDate: model.rewardExpiryDate,
		parserType: model.parserType,
		parserVersion: model.parserVersion,
		parserConfidence: model.parserConfidence,
		proposedCardIds: model.proposedCardIds,
		occurredAt: occurredAtStr,
		createdAt: createdAtStr,
	};
}

export function toCampaignSourceSnapshotProductDto(
	model: CampaignSourceSnapshotReadModel,
): CampaignSourceSnapshotProductDto {
	const capturedAtStr =
		model.capturedAt instanceof Date
			? model.capturedAt.toISOString()
			: String(model.capturedAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		sourceSnapshotId: model.id,
		provider: model.provider,
		sourceType: model.sourceType,
		sourceUrl: model.sourceUrl,
		externalSourceId: model.externalSourceId,
		sourceTitle: model.sourceTitle,
		sourceText: model.sourceText,
		capturedAt: capturedAtStr,
		createdAt: createdAtStr,
	};
}

export function toCampaignRewardCreditProductDto(
	model: CampaignRewardCreditReadModel,
): CampaignRewardCreditProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);

	return {
		creditId: model.creditId,
		campaignPeriodId: model.campaignPeriodId,
		rewardAccountId: model.rewardAccountId,
		revisionNo: model.revisionNo,
		actualPointAmount: model.actualPointAmount,
		expectedPointAmount: model.expectedPointAmount ?? "0.0000",
		rewardEventId: model.rewardEventId,
		reasonNote: model.reasonNote,
		occurredAt: occurredAtStr,
	};
}

// ============================================================================
// 1. Bounded Campaign Periods Query
// ============================================================================

export interface ListBoundedCampaignPeriodsParams {
	db: Database;
	userId: string;
	status?: "REVIEW_REQUIRED" | "ACTIVE" | "ENDED" | "CANCELLED" | undefined;
	visibility?: "VISIBLE" | "HIDDEN" | undefined;
	provider?: string | undefined;
	creditCardId?: string | undefined;
	limit: number;
	afterCursor?: CampaignPeriodCursor | undefined;
}

export interface ListBoundedCampaignPeriodsResult {
	campaigns: CampaignPeriodProductDto[];
	hasMore: boolean;
	nextCursor: CampaignPeriodCursor | null;
}

export async function listBoundedCampaignPeriods({
	db,
	userId,
	status,
	visibility,
	provider,
	creditCardId,
	limit,
	afterCursor,
}: ListBoundedCampaignPeriodsParams): Promise<ListBoundedCampaignPeriodsResult> {
	const validUserId = validateCampaignCanonicalUuid(userId, "userId");

	return runCampaignsReadTransaction(db, async (tx) => {
		const latestPeriodRevsSq = tx
			.selectDistinctOn([campaignPeriodRevisions.campaignPeriodId], {
				campaignPeriodId: campaignPeriodRevisions.campaignPeriodId,
				revisionId: campaignPeriodRevisions.id,
				userId: campaignPeriodRevisions.userId,
				revisionNo: campaignPeriodRevisions.revisionNo,
				operation: campaignPeriodRevisions.operation,
				lifecycleStatus: campaignPeriodRevisions.lifecycleStatus,
				visibility: campaignPeriodRevisions.visibility,
				title: campaignPeriodRevisions.title,
				startsOn: campaignPeriodRevisions.startsOn,
				endsOn: campaignPeriodRevisions.endsOn,
				ruleMode: campaignPeriodRevisions.ruleMode,
				targetSpendAmount: campaignPeriodRevisions.targetSpendAmount,
				requiredTransactionCount:
					campaignPeriodRevisions.requiredTransactionCount,
				minimumTransactionAmount:
					campaignPeriodRevisions.minimumTransactionAmount,
				stepSpendAmount: campaignPeriodRevisions.stepSpendAmount,
				rewardPointsPerStep: campaignPeriodRevisions.rewardPointsPerStep,
				maxSteps: campaignPeriodRevisions.maxSteps,
				rewardKind: campaignPeriodRevisions.rewardKind,
				rewardAccountId: campaignPeriodRevisions.rewardAccountId,
				expectedRewardPoints: campaignPeriodRevisions.expectedRewardPoints,
				merchantScopeMode: campaignPeriodRevisions.merchantScopeMode,
				requiredCanonicalMerchantNames:
					campaignPeriodRevisions.requiredCanonicalMerchantNames,
				allowedMccCodes: campaignPeriodRevisions.allowedMccCodes,
				rewardExpiryDate: campaignPeriodRevisions.rewardExpiryDate,
				sourceSnapshotId: campaignPeriodRevisions.sourceSnapshotId,
				parserType: campaignPeriodRevisions.parserType,
				parserVersion: campaignPeriodRevisions.parserVersion,
				parserConfidence: campaignPeriodRevisions.parserConfidence,
				note: campaignPeriodRevisions.note,
				occurredAt: campaignPeriodRevisions.occurredAt,
				createdAt: campaignPeriods.createdAt,
				campaignFamilyId: campaignPeriods.campaignFamilyId,
				periodKey: campaignPeriods.periodKey,
				familyProvider: campaignFamilies.provider,
				familyKey: campaignFamilies.familyKey,
			})
			.from(campaignPeriodRevisions)
			.innerJoin(
				campaignPeriods,
				eq(campaignPeriods.id, campaignPeriodRevisions.campaignPeriodId),
			)
			.innerJoin(
				campaignFamilies,
				eq(campaignFamilies.id, campaignPeriods.campaignFamilyId),
			)
			.where(eq(campaignPeriodRevisions.userId, validUserId))
			.orderBy(
				campaignPeriodRevisions.campaignPeriodId,
				desc(campaignPeriodRevisions.revisionNo),
			)
			.as("latest_period_revs");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [
			eq(latestPeriodRevsSq.userId, validUserId),
		];

		if (status !== undefined) {
			conditions.push(eq(latestPeriodRevsSq.lifecycleStatus, status));
		}
		if (visibility !== undefined) {
			conditions.push(eq(latestPeriodRevsSq.visibility, visibility));
		}
		if (provider !== undefined) {
			conditions.push(eq(latestPeriodRevsSq.familyProvider, provider));
		}
		if (creditCardId !== undefined) {
			const validCardId = validateCampaignCanonicalUuid(
				creditCardId,
				"creditCardId",
			);
			conditions.push(
				sql`EXISTS (
					SELECT 1 FROM ${campaignPeriodRevisionCards}
					WHERE ${campaignPeriodRevisionCards.revisionId} = ${latestPeriodRevsSq.revisionId}
					  AND ${campaignPeriodRevisionCards.creditCardId} = ${validCardId}
				)`,
			);
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(latestPeriodRevsSq.createdAt, cursorDate),
					and(
						eq(latestPeriodRevsSq.createdAt, cursorDate),
						lt(latestPeriodRevsSq.campaignPeriodId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(latestPeriodRevsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(latestPeriodRevsSq.createdAt),
				desc(latestPeriodRevsSq.campaignPeriodId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		if (pageRows.length === 0) {
			return {
				campaigns: [],
				hasMore: false,
				nextCursor: null,
			};
		}

		const revisionIds = pageRows.map((r) => r.revisionId);
		const allCards = await tx
			.select({
				revisionId: campaignPeriodRevisionCards.revisionId,
				creditCardId: campaignPeriodRevisionCards.creditCardId,
			})
			.from(campaignPeriodRevisionCards)
			.where(inArray(campaignPeriodRevisionCards.revisionId, revisionIds));

		const cardIdsByRev = new Map<string, string[]>();
		for (const c of allCards) {
			const existing = cardIdsByRev.get(c.revisionId) ?? [];
			existing.push(c.creditCardId);
			cardIdsByRev.set(c.revisionId, existing);
		}

		const dtos: CampaignPeriodProductDto[] = pageRows.map((r) => {
			return {
				campaignPeriodId: r.campaignPeriodId,
				provider: r.familyProvider,
				familyKey: r.familyKey,
				periodKey: r.periodKey,
				revisionNo: r.revisionNo,
				operation: r.operation,
				lifecycleStatus: r.lifecycleStatus as
					| "REVIEW_REQUIRED"
					| "ACTIVE"
					| "ENDED"
					| "CANCELLED",
				visibility: r.visibility as "VISIBLE" | "HIDDEN",
				title: r.title,
				startsOn: r.startsOn,
				endsOn: r.endsOn,
				ruleMode: r.ruleMode as
					| "TOTAL_SPEND"
					| "TRANSACTION_COUNT"
					| "REPEATABLE_SPEND",
				targetSpendAmount: r.targetSpendAmount,
				requiredTransactionCount: r.requiredTransactionCount,
				minimumTransactionAmount: r.minimumTransactionAmount,
				stepSpendAmount: r.stepSpendAmount,
				rewardPointsPerStep: r.rewardPointsPerStep,
				maxSteps: r.maxSteps,
				rewardKind: r.rewardKind as
					| "REWARD_POINTS"
					| "STATEMENT_CREDIT"
					| "INFORMATIONAL",
				rewardAccountId: r.rewardAccountId,
				expectedRewardPoints: r.expectedRewardPoints,
				merchantScopeMode: r.merchantScopeMode as
					| "ALL_MERCHANTS"
					| "MERCHANT_ALIASES"
					| "MANUAL_REVIEW_REQUIRED",
				requiredCanonicalMerchantNames: r.requiredCanonicalMerchantNames as
					| string[]
					| null,
				allowedMccCodes: r.allowedMccCodes as string[] | null,
				rewardExpiryDate: r.rewardExpiryDate,
				sourceSnapshotId: r.sourceSnapshotId,
				parserType: r.parserType,
				parserVersion: r.parserVersion,
				parserConfidence: r.parserConfidence,
				note: r.note,
				cardIds: cardIdsByRev.get(r.revisionId) ?? [],
				occurredAt:
					r.occurredAt instanceof Date
						? r.occurredAt.toISOString()
						: new Date(String(r.occurredAt)).toISOString(),
				createdAt:
					r.createdAt instanceof Date
						? r.createdAt.toISOString()
						: new Date(String(r.createdAt)).toISOString(),
			};
		});

		let nextCursor: CampaignPeriodCursor | null = null;
		const lastRow = pageRows[pageRows.length - 1];
		if (hasMore && lastRow) {
			const createdAtIso =
				lastRow.createdAt instanceof Date
					? lastRow.createdAt.toISOString()
					: new Date(String(lastRow.createdAt)).toISOString();
			nextCursor = {
				createdAt: createdAtIso,
				id: lastRow.campaignPeriodId,
			};
		}

		return {
			campaigns: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 2. Bounded Review Candidates Query
// ============================================================================

export interface ListBoundedCampaignReviewCandidatesParams {
	db: Database;
	userId: string;
	campaignPeriodId?: string | undefined;
	status?: "PENDING" | "APPLIED" | "DISMISSED" | undefined;
	limit: number;
	afterCursor?: CampaignReviewCandidateCursor | undefined;
}

export interface ListBoundedCampaignReviewCandidatesResult {
	candidates: CampaignReviewCandidateProductDto[];
	hasMore: boolean;
	nextCursor: CampaignReviewCandidateCursor | null;
}

export async function listBoundedCampaignReviewCandidates({
	db,
	userId,
	campaignPeriodId,
	status,
	limit,
	afterCursor,
}: ListBoundedCampaignReviewCandidatesParams): Promise<ListBoundedCampaignReviewCandidatesResult> {
	const validUserId = validateCampaignCanonicalUuid(userId, "userId");

	return runCampaignsReadTransaction(db, async (tx) => {
		const latestCandidateRevsSq = tx
			.selectDistinctOn([campaignReviewCandidateRevisions.candidateId], {
				candidateId: campaignReviewCandidateRevisions.candidateId,
				revisionId: campaignReviewCandidateRevisions.id,
				userId: campaignReviewCandidateRevisions.userId,
				campaignPeriodId: campaignReviewCandidates.campaignPeriodId,
				sourceSnapshotId: campaignReviewCandidates.sourceSnapshotId,
				revisionNo: campaignReviewCandidateRevisions.revisionNo,
				operation: campaignReviewCandidateRevisions.operation,
				status: campaignReviewCandidateRevisions.status,
				title: campaignReviewCandidateRevisions.title,
				startsOn: campaignReviewCandidateRevisions.startsOn,
				endsOn: campaignReviewCandidateRevisions.endsOn,
				ruleMode: campaignReviewCandidateRevisions.ruleMode,
				targetSpendAmount: campaignReviewCandidateRevisions.targetSpendAmount,
				requiredTransactionCount:
					campaignReviewCandidateRevisions.requiredTransactionCount,
				minimumTransactionAmount:
					campaignReviewCandidateRevisions.minimumTransactionAmount,
				stepSpendAmount: campaignReviewCandidateRevisions.stepSpendAmount,
				rewardPointsPerStep:
					campaignReviewCandidateRevisions.rewardPointsPerStep,
				maxSteps: campaignReviewCandidateRevisions.maxSteps,
				rewardKind: campaignReviewCandidateRevisions.rewardKind,
				rewardAccountId: campaignReviewCandidateRevisions.rewardAccountId,
				expectedRewardPoints:
					campaignReviewCandidateRevisions.expectedRewardPoints,
				merchantScopeMode: campaignReviewCandidateRevisions.merchantScopeMode,
				requiredCanonicalMerchantNames:
					campaignReviewCandidateRevisions.requiredCanonicalMerchantNames,
				allowedMccCodes: campaignReviewCandidateRevisions.allowedMccCodes,
				rewardExpiryDate: campaignReviewCandidateRevisions.rewardExpiryDate,
				parserType: campaignReviewCandidateRevisions.parserType,
				parserVersion: campaignReviewCandidateRevisions.parserVersion,
				parserConfidence: campaignReviewCandidateRevisions.parserConfidence,
				proposedCardIds: campaignReviewCandidateRevisions.proposedCardIds,
				occurredAt: campaignReviewCandidateRevisions.occurredAt,
				createdAt: campaignReviewCandidates.createdAt,
			})
			.from(campaignReviewCandidateRevisions)
			.innerJoin(
				campaignReviewCandidates,
				eq(
					campaignReviewCandidates.id,
					campaignReviewCandidateRevisions.candidateId,
				),
			)
			.where(eq(campaignReviewCandidateRevisions.userId, validUserId))
			.orderBy(
				campaignReviewCandidateRevisions.candidateId,
				desc(campaignReviewCandidateRevisions.revisionNo),
			)
			.as("latest_candidate_revs");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [
			eq(latestCandidateRevsSq.userId, validUserId),
		];

		if (campaignPeriodId !== undefined) {
			const validPeriodId = validateCampaignCanonicalUuid(
				campaignPeriodId,
				"campaignPeriodId",
			);
			conditions.push(
				eq(latestCandidateRevsSq.campaignPeriodId, validPeriodId),
			);
		}
		if (status !== undefined) {
			conditions.push(eq(latestCandidateRevsSq.status, status));
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(latestCandidateRevsSq.createdAt, cursorDate),
					and(
						eq(latestCandidateRevsSq.createdAt, cursorDate),
						lt(latestCandidateRevsSq.candidateId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(latestCandidateRevsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(latestCandidateRevsSq.createdAt),
				desc(latestCandidateRevsSq.candidateId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		const dtos: CampaignReviewCandidateProductDto[] = pageRows.map((r) => {
			return {
				candidateId: r.candidateId,
				campaignPeriodId: r.campaignPeriodId,
				sourceSnapshotId: r.sourceSnapshotId,
				revisionNo: r.revisionNo,
				operation: r.operation as "CREATE" | "APPLY" | "DISMISS",
				status: r.status as "PENDING" | "APPLIED" | "DISMISSED",
				title: r.title,
				startsOn: r.startsOn,
				endsOn: r.endsOn,
				ruleMode: r.ruleMode as
					| "TOTAL_SPEND"
					| "TRANSACTION_COUNT"
					| "REPEATABLE_SPEND",
				targetSpendAmount: r.targetSpendAmount,
				requiredTransactionCount: r.requiredTransactionCount,
				minimumTransactionAmount: r.minimumTransactionAmount,
				stepSpendAmount: r.stepSpendAmount,
				rewardPointsPerStep: r.rewardPointsPerStep,
				maxSteps: r.maxSteps,
				rewardKind: r.rewardKind as
					| "REWARD_POINTS"
					| "STATEMENT_CREDIT"
					| "INFORMATIONAL",
				rewardAccountId: r.rewardAccountId,
				expectedRewardPoints: r.expectedRewardPoints,
				merchantScopeMode: r.merchantScopeMode as
					| "ALL_MERCHANTS"
					| "MERCHANT_ALIASES"
					| "MANUAL_REVIEW_REQUIRED",
				requiredCanonicalMerchantNames: r.requiredCanonicalMerchantNames as
					| string[]
					| null,
				allowedMccCodes: r.allowedMccCodes as string[] | null,
				rewardExpiryDate: r.rewardExpiryDate,
				parserType: r.parserType,
				parserVersion: r.parserVersion,
				parserConfidence: r.parserConfidence,
				proposedCardIds: (r.proposedCardIds as string[]) ?? [],
				occurredAt:
					r.occurredAt instanceof Date
						? r.occurredAt.toISOString()
						: new Date(String(r.occurredAt)).toISOString(),
				createdAt:
					r.createdAt instanceof Date
						? r.createdAt.toISOString()
						: new Date(String(r.createdAt)).toISOString(),
			};
		});

		let nextCursor: CampaignReviewCandidateCursor | null = null;
		const lastRow = pageRows[pageRows.length - 1];
		if (hasMore && lastRow) {
			const createdAtIso =
				lastRow.createdAt instanceof Date
					? lastRow.createdAt.toISOString()
					: new Date(String(lastRow.createdAt)).toISOString();
			nextCursor = {
				createdAt: createdAtIso,
				id: lastRow.candidateId,
			};
		}

		return {
			candidates: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 3. Bounded Campaign Progress Purchases Query
// ============================================================================

export interface ListBoundedCampaignProgressPurchasesParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	bucket: "QUALIFYING" | "NEEDS_REVIEW";
	limit: number;
	afterCursor?: CampaignProgressPurchaseCursor | undefined;
}

export interface ListBoundedCampaignProgressPurchasesResult {
	purchases: CampaignProgressPurchaseProductDto[];
	hasMore: boolean;
	nextCursor: CampaignProgressPurchaseCursor | null;
}

export async function listBoundedCampaignProgressPurchases({
	db,
	userId,
	campaignPeriodId,
	bucket,
	limit,
	afterCursor,
}: ListBoundedCampaignProgressPurchasesParams): Promise<ListBoundedCampaignProgressPurchasesResult> {
	const validUserId = validateCampaignCanonicalUuid(userId, "userId");
	const validCampaignPeriodId = validateCampaignCanonicalUuid(
		campaignPeriodId,
		"campaignPeriodId",
	);

	return runCampaignsReadTransaction(db, async (tx) => {
		const progress = await getCampaignProgressInTransaction(
			tx,
			validUserId,
			validCampaignPeriodId,
		);

		const rawList: CampaignQualifyingPurchase[] =
			bucket === "QUALIFYING"
				? progress.qualifyingPurchases
				: progress.needsReviewPurchases;

		// Deterministic sort: purchaseDate DESC NULLS LAST, purchaseEventId DESC
		const sorted = [...rawList].sort((a, b) => {
			if (a.purchaseDate !== null && b.purchaseDate !== null) {
				if (a.purchaseDate !== b.purchaseDate) {
					return b.purchaseDate.localeCompare(a.purchaseDate);
				}
			} else if (a.purchaseDate !== null && b.purchaseDate === null) {
				return -1; // non-null before null
			} else if (a.purchaseDate === null && b.purchaseDate !== null) {
				return 1; // null after non-null
			}
			return b.purchaseEventId.localeCompare(a.purchaseEventId);
		});

		// Apply keyset cursor
		let filtered = sorted;
		if (afterCursor) {
			filtered = sorted.filter((p) => {
				if (afterCursor.purchaseDate !== null) {
					if (p.purchaseDate === null) return true; // nulls come after non-null cursor
					if (p.purchaseDate < afterCursor.purchaseDate) return true;
					if (p.purchaseDate === afterCursor.purchaseDate) {
						return p.purchaseEventId < afterCursor.id;
					}
					return false;
				}
				// cursor purchaseDate is null
				if (p.purchaseDate !== null) return false;
				return p.purchaseEventId < afterCursor.id;
			});
		}

		const hasMore = filtered.length > limit;
		const pageItems = hasMore ? filtered.slice(0, limit) : filtered;

		// Load overrides for the returned page items in the same read transaction
		const overrideRows = await tx
			.select({
				purchaseEventId: campaignPurchaseOverrides.purchaseEventId,
				revisionNo: campaignPurchaseOverrideRevisions.revisionNo,
				operation: campaignPurchaseOverrideRevisions.operation,
				reasonNote: campaignPurchaseOverrideRevisions.reasonNote,
				occurredAt: campaignPurchaseOverrideRevisions.occurredAt,
			})
			.from(campaignPurchaseOverrides)
			.innerJoin(
				campaignPurchaseOverrideRevisions,
				eq(
					campaignPurchaseOverrideRevisions.overrideId,
					campaignPurchaseOverrides.id,
				),
			)
			.where(
				and(
					eq(campaignPurchaseOverrides.campaignPeriodId, validCampaignPeriodId),
					eq(campaignPurchaseOverrides.userId, validUserId),
				),
			)
			.orderBy(
				campaignPurchaseOverrides.purchaseEventId,
				desc(campaignPurchaseOverrideRevisions.revisionNo),
			);

		const overrideMap = new Map<string, (typeof overrideRows)[0]>();
		for (const ov of overrideRows) {
			if (!overrideMap.has(ov.purchaseEventId)) {
				overrideMap.set(ov.purchaseEventId, ov);
			}
		}

		const dtos: CampaignProgressPurchaseProductDto[] = pageItems.map((p) => {
			const ov = overrideMap.get(p.purchaseEventId);
			return {
				purchaseEventId: p.purchaseEventId,
				amount: p.amount,
				purchaseDate: p.purchaseDate,
				merchant: p.merchant,
				status: p.status,
				override: ov
					? {
							revisionNo: ov.revisionNo,
							operation: ov.operation as "INCLUDE" | "EXCLUDE" | "CLEAR",
							reasonNote: ov.reasonNote,
							occurredAt:
								ov.occurredAt instanceof Date
									? ov.occurredAt.toISOString()
									: String(ov.occurredAt),
						}
					: null,
			};
		});

		let nextCursor: CampaignProgressPurchaseCursor | null = null;
		const lastItem = pageItems[pageItems.length - 1];
		if (hasMore && lastItem) {
			nextCursor = {
				purchaseDate: lastItem.purchaseDate,
				id: lastItem.purchaseEventId,
			};
		}

		return {
			purchases: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 4. Bounded Campaign Overrides Query
// ============================================================================

export interface ListBoundedCampaignOverridesParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	limit: number;
	afterCursor?: { id: string } | undefined;
}

export interface ListBoundedCampaignOverridesResult {
	overrides: CampaignOverrideProductDto[];
	hasMore: boolean;
	nextCursor: { id: string } | null;
}

export async function listBoundedCampaignOverrides({
	db,
	userId,
	campaignPeriodId,
	limit,
	afterCursor,
}: ListBoundedCampaignOverridesParams): Promise<ListBoundedCampaignOverridesResult> {
	const validUserId = validateCampaignCanonicalUuid(userId, "userId");
	const validCampaignPeriodId = validateCampaignCanonicalUuid(
		campaignPeriodId,
		"campaignPeriodId",
	);

	return runCampaignsReadTransaction(db, async (tx) => {
		// Verify campaign exists for user
		const [periodRow] = await tx
			.select({ id: campaignPeriods.id })
			.from(campaignPeriods)
			.where(
				and(
					eq(campaignPeriods.id, validCampaignPeriodId),
					eq(campaignPeriods.userId, validUserId),
				),
			)
			.limit(1);

		if (!periodRow) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				"Campaign period not found",
			);
		}

		const overrideRows = await tx
			.select({
				purchaseEventId: campaignPurchaseOverrides.purchaseEventId,
				revisionNo: campaignPurchaseOverrideRevisions.revisionNo,
				operation: campaignPurchaseOverrideRevisions.operation,
				reasonNote: campaignPurchaseOverrideRevisions.reasonNote,
				occurredAt: campaignPurchaseOverrideRevisions.occurredAt,
			})
			.from(campaignPurchaseOverrides)
			.innerJoin(
				campaignPurchaseOverrideRevisions,
				eq(
					campaignPurchaseOverrideRevisions.overrideId,
					campaignPurchaseOverrides.id,
				),
			)
			.where(
				and(
					eq(campaignPurchaseOverrides.campaignPeriodId, validCampaignPeriodId),
					eq(campaignPurchaseOverrides.userId, validUserId),
				),
			)
			.orderBy(
				campaignPurchaseOverrides.purchaseEventId,
				desc(campaignPurchaseOverrideRevisions.revisionNo),
			);

		const latestOverridesMap = new Map<string, (typeof overrideRows)[0]>();
		for (const ov of overrideRows) {
			if (!latestOverridesMap.has(ov.purchaseEventId)) {
				latestOverridesMap.set(ov.purchaseEventId, ov);
			}
		}
		const latestOverrides = Array.from(latestOverridesMap.values());

		// Sort deterministically by purchaseEventId ASC
		const sorted = [...latestOverrides].sort((a, b) =>
			a.purchaseEventId.localeCompare(b.purchaseEventId),
		);

		let filtered = sorted;
		if (afterCursor) {
			filtered = sorted.filter((o) => o.purchaseEventId > afterCursor.id);
		}

		const hasMore = filtered.length > limit;
		const pageItems = hasMore ? filtered.slice(0, limit) : filtered;

		const dtos: CampaignOverrideProductDto[] = pageItems.map((o) => ({
			purchaseEventId: o.purchaseEventId,
			revisionNo: o.revisionNo,
			operation: o.operation as "INCLUDE" | "EXCLUDE" | "CLEAR",
			reasonNote: o.reasonNote,
			occurredAt:
				o.occurredAt instanceof Date
					? o.occurredAt.toISOString()
					: String(o.occurredAt),
		}));

		let nextCursor: { id: string } | null = null;
		const lastItem = pageItems[pageItems.length - 1];
		if (hasMore && lastItem) {
			nextCursor = {
				id: lastItem.purchaseEventId,
			};
		}

		return {
			overrides: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 5. Active Campaign Reward Credit Query
// ============================================================================

export async function getActiveCampaignRewardCredit({
	db,
	userId,
	campaignPeriodId,
}: {
	db: Database;
	userId: string;
	campaignPeriodId: string;
}): Promise<CampaignRewardCreditProductDto | null> {
	const validUserId = validateCampaignCanonicalUuid(userId, "userId");
	const validCampaignPeriodId = validateCampaignCanonicalUuid(
		campaignPeriodId,
		"campaignPeriodId",
	);

	return runCampaignsReadTransaction(db, async (tx) => {
		const latest = await getLatestRevisionInTransaction(
			tx,
			validUserId,
			validCampaignPeriodId,
		);
		if (!latest) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${validCampaignPeriodId}" not found`,
			);
		}

		const credits = await tx
			.select({
				id: campaignRewardCredits.id,
				rewardAccountId: campaignRewardCredits.rewardAccountId,
			})
			.from(campaignRewardCredits)
			.where(
				and(
					eq(campaignRewardCredits.campaignPeriodId, validCampaignPeriodId),
					eq(campaignRewardCredits.userId, validUserId),
				),
			);

		const active: CampaignRewardCreditProductDto[] = [];

		for (const credit of credits) {
			const [latestRev] = await tx
				.select()
				.from(campaignRewardCreditRevisions)
				.where(eq(campaignRewardCreditRevisions.creditId, credit.id))
				.orderBy(desc(campaignRewardCreditRevisions.revisionNo))
				.limit(1);
			if (!latestRev || latestRev.operation === "VOID") continue;
			active.push({
				creditId: credit.id,
				campaignPeriodId: validCampaignPeriodId,
				rewardAccountId: credit.rewardAccountId,
				revisionNo: latestRev.revisionNo,
				actualPointAmount: latestRev.actualPointAmount,
				expectedPointAmount: latestRev.expectedPointAmount ?? "0.0000",
				rewardEventId: latestRev.rewardEventId,
				reasonNote: latestRev.reasonNote,
				occurredAt:
					latestRev.occurredAt instanceof Date
						? latestRev.occurredAt.toISOString()
						: String(latestRev.occurredAt),
			});
		}

		if (active.length > 1) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				`Campaign period "${validCampaignPeriodId}" has more than one ACTIVE reward credit identity`,
			);
		}

		return active[0] ?? null;
	});
}
