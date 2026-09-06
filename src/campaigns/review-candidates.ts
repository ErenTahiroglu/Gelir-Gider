import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	campaignFamilies,
	campaignPeriods,
	campaignReviewCandidateRevisions,
	campaignReviewCandidates,
	campaignSourceSnapshots,
} from "../db/schema/campaigns";
import {
	runCampaignsReadTransaction,
	runCampaignsTransaction,
} from "./boundary";
import {
	validateCampaignCanonicalUuid,
	validateCampaignExpectedRevisionNo,
	validateCampaignGregorianDateString,
	validateCampaignIdempotencyKey,
	validateCampaignMerchantScopeMode,
	validateCampaignOccurredAt,
	validateCampaignOptionalText,
	validateCampaignPositiveIntegerRange,
	validateCampaignRequiredText,
	validateCampaignRewardKind,
	validateCampaignRuleMode,
	validateCampaignStringArray,
} from "./calendar";
import {
	parseCampaignOptionalPositiveMoneyString,
	parseCampaignPointQuantity,
	parseCampaignPositiveMoneyString,
} from "./decimal";
import { CampaignError } from "./errors";
import {
	calculateCampaignReviewCandidateHash,
	calculateCampaignReviewCandidateLifecycleFingerprint,
} from "./fingerprint";
import {
	validateCampaignRewardShape,
	validateCampaignRuleShape,
} from "./rules";
import {
	amendCampaignPeriod,
	buildCampaignPeriodReadModelInTransaction,
	getLatestRevisionInTransaction,
} from "./service";
import { computeCampaignSemanticDiff } from "./sources";

// ============================================================================
// Read models
// ============================================================================

export interface CampaignReviewCandidateReadModel {
	candidateId: string;
	campaignPeriodId: string;
	sourceSnapshotId: string;
	candidateHash: string;
	revisionId: string;
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
	occurredAt: Date;
	createdAt: Date;
}

function buildReadModel(
	candidate: typeof campaignReviewCandidates.$inferSelect,
	revision: typeof campaignReviewCandidateRevisions.$inferSelect,
): CampaignReviewCandidateReadModel {
	return {
		candidateId: candidate.id,
		campaignPeriodId: candidate.campaignPeriodId,
		sourceSnapshotId: candidate.sourceSnapshotId,
		candidateHash: candidate.candidateHash,
		revisionId: revision.id,
		revisionNo: revision.revisionNo,
		operation: revision.operation as "CREATE" | "APPLY" | "DISMISS",
		status: revision.status as "PENDING" | "APPLIED" | "DISMISSED",
		title: revision.title,
		startsOn: revision.startsOn,
		endsOn: revision.endsOn,
		ruleMode: revision.ruleMode as
			| "TOTAL_SPEND"
			| "TRANSACTION_COUNT"
			| "REPEATABLE_SPEND",
		targetSpendAmount: revision.targetSpendAmount,
		requiredTransactionCount: revision.requiredTransactionCount,
		minimumTransactionAmount: revision.minimumTransactionAmount,
		stepSpendAmount: revision.stepSpendAmount,
		rewardPointsPerStep: revision.rewardPointsPerStep,
		maxSteps: revision.maxSteps,
		rewardKind: revision.rewardKind as
			| "REWARD_POINTS"
			| "STATEMENT_CREDIT"
			| "INFORMATIONAL",
		rewardAccountId: revision.rewardAccountId,
		expectedRewardPoints: revision.expectedRewardPoints,
		merchantScopeMode: revision.merchantScopeMode as
			| "ALL_MERCHANTS"
			| "MERCHANT_ALIASES"
			| "MANUAL_REVIEW_REQUIRED",
		requiredCanonicalMerchantNames: revision.requiredCanonicalMerchantNames as
			| string[]
			| null,
		allowedMccCodes: revision.allowedMccCodes as string[] | null,
		rewardExpiryDate: revision.rewardExpiryDate,
		parserType: revision.parserType,
		parserVersion: revision.parserVersion,
		parserConfidence: revision.parserConfidence,
		proposedCardIds: revision.proposedCardIds as string[],
		occurredAt: revision.occurredAt,
		createdAt: revision.createdAt,
	};
}

async function buildLatestReadModelInTransaction(
	tx: DatabaseTransaction,
	candidateId: string,
): Promise<CampaignReviewCandidateReadModel | null> {
	const [candidate] = await tx
		.select()
		.from(campaignReviewCandidates)
		.where(eq(campaignReviewCandidates.id, candidateId))
		.limit(1);
	if (!candidate) return null;

	const [revision] = await tx
		.select()
		.from(campaignReviewCandidateRevisions)
		.where(eq(campaignReviewCandidateRevisions.candidateId, candidateId))
		.orderBy(desc(campaignReviewCandidateRevisions.revisionNo))
		.limit(1);
	if (!revision) return null;

	return buildReadModel(candidate, revision);
}

// ============================================================================
// Shared proposed-term normalization (mirrors normalizeCreateFields in
// service.ts, minus provider/familyKey/periodKey/cardIds-anchor concerns)
// ============================================================================

export interface ProposedCampaignTermsInput {
	title: string;
	startsOn: string;
	endsOn: string;
	ruleMode: unknown;
	targetSpendAmount?: string | undefined;
	requiredTransactionCount?: number | undefined;
	minimumTransactionAmount?: string | undefined;
	stepSpendAmount?: string | undefined;
	rewardPointsPerStep?: string | undefined;
	maxSteps?: number | undefined;
	rewardKind: unknown;
	rewardAccountId?: string | undefined;
	expectedRewardPoints?: string | undefined;
	merchantScopeMode: unknown;
	requiredCanonicalMerchantNames?: string[] | undefined;
	allowedMccCodes?: string[] | undefined;
	rewardExpiryDate?: string | undefined;
	proposedCardIds: string[];
	parserType?: string | null | undefined;
	parserVersion?: string | null | undefined;
	parserConfidence?: number | null | undefined;
}

function normalizeProposedTerms(input: ProposedCampaignTermsInput) {
	const title = validateCampaignRequiredText(input.title, "title", 200);
	const startsOn = validateCampaignGregorianDateString(
		input.startsOn,
		"startsOn",
	);
	const endsOn = validateCampaignGregorianDateString(input.endsOn, "endsOn");
	if (startsOn > endsOn) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"startsOn must not be after endsOn",
		);
	}
	const ruleMode = validateCampaignRuleMode(input.ruleMode);
	const targetSpendAmount =
		input.targetSpendAmount === undefined
			? null
			: parseCampaignPositiveMoneyString(
					input.targetSpendAmount,
					"targetSpendAmount",
				);
	const requiredTransactionCount =
		input.requiredTransactionCount === undefined
			? null
			: validateCampaignPositiveIntegerRange(
					input.requiredTransactionCount,
					"requiredTransactionCount",
					1,
					1_000_000,
				);
	const minimumTransactionAmount = parseCampaignOptionalPositiveMoneyString(
		input.minimumTransactionAmount,
		"minimumTransactionAmount",
	);
	const stepSpendAmount =
		input.stepSpendAmount === undefined
			? null
			: parseCampaignPositiveMoneyString(
					input.stepSpendAmount,
					"stepSpendAmount",
				);
	const rewardPointsPerStep =
		input.rewardPointsPerStep === undefined
			? null
			: parseCampaignPointQuantity(
					input.rewardPointsPerStep,
					"rewardPointsPerStep",
				);
	const maxSteps =
		input.maxSteps === undefined
			? null
			: validateCampaignPositiveIntegerRange(
					input.maxSteps,
					"maxSteps",
					1,
					1_000_000,
				);

	validateCampaignRuleShape({
		ruleMode,
		targetSpendAmountCents: targetSpendAmount?.cents ?? null,
		requiredTransactionCount,
		minimumTransactionAmountCents: minimumTransactionAmount?.cents ?? null,
		stepSpendAmountCents: stepSpendAmount?.cents ?? null,
		rewardPointsPerStepUnits: rewardPointsPerStep?.units ?? null,
		maxSteps,
	});

	const rewardKind = validateCampaignRewardKind(input.rewardKind);
	const rewardAccountId =
		input.rewardAccountId === undefined
			? null
			: validateCampaignCanonicalUuid(input.rewardAccountId, "rewardAccountId");
	const expectedRewardPoints =
		input.expectedRewardPoints === undefined
			? null
			: parseCampaignPointQuantity(
					input.expectedRewardPoints,
					"expectedRewardPoints",
				);

	validateCampaignRewardShape({
		rewardKind,
		ruleMode,
		rewardAccountId,
		expectedRewardPointsUnits: expectedRewardPoints?.units ?? null,
	});

	const merchantScopeMode = validateCampaignMerchantScopeMode(
		input.merchantScopeMode,
	);
	const requiredCanonicalMerchantNames =
		merchantScopeMode === "MERCHANT_ALIASES"
			? validateCampaignStringArray(
					input.requiredCanonicalMerchantNames,
					"requiredCanonicalMerchantNames",
					200,
					100,
				)
			: (() => {
					if (input.requiredCanonicalMerchantNames !== undefined) {
						throw new CampaignError(
							"CAMPAIGN_INVALID_INPUT",
							"requiredCanonicalMerchantNames is only allowed for MERCHANT_ALIASES scope",
						);
					}
					return null;
				})();
	const allowedMccCodes =
		input.allowedMccCodes === undefined
			? null
			: validateCampaignStringArray(
					input.allowedMccCodes,
					"allowedMccCodes",
					10,
					50,
				);
	const rewardExpiryDate =
		input.rewardExpiryDate === undefined
			? null
			: validateCampaignGregorianDateString(
					input.rewardExpiryDate,
					"rewardExpiryDate",
				);

	if (!Array.isArray(input.proposedCardIds)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"proposedCardIds must be an array",
		);
	}
	const proposedCardIds = Array.from(
		new Set(
			input.proposedCardIds.map((id, i) =>
				validateCampaignCanonicalUuid(id, `proposedCardIds[${i}]`),
			),
		),
	);

	const parserType = validateCampaignOptionalText(
		input.parserType,
		"parserType",
		60,
	);
	const parserVersion = validateCampaignOptionalText(
		input.parserVersion,
		"parserVersion",
		40,
	);
	if ((parserType === null) !== (parserVersion === null)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"parserType and parserVersion must both be supplied or both omitted",
		);
	}
	const parserConfidence =
		input.parserConfidence === undefined || input.parserConfidence === null
			? null
			: input.parserConfidence;
	if (
		parserConfidence !== null &&
		(typeof parserConfidence !== "number" ||
			Number.isNaN(parserConfidence) ||
			parserConfidence < 0 ||
			parserConfidence > 1)
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"parserConfidence must be a number between 0 and 1",
		);
	}

	return {
		title,
		startsOn,
		endsOn,
		ruleMode,
		targetSpendAmount: targetSpendAmount?.normalized ?? null,
		requiredTransactionCount,
		minimumTransactionAmount: minimumTransactionAmount?.normalized ?? null,
		stepSpendAmount: stepSpendAmount?.normalized ?? null,
		rewardPointsPerStep: rewardPointsPerStep?.normalized ?? null,
		maxSteps,
		rewardKind,
		rewardAccountId,
		expectedRewardPoints: expectedRewardPoints?.normalized ?? null,
		merchantScopeMode,
		requiredCanonicalMerchantNames,
		allowedMccCodes,
		rewardExpiryDate,
		proposedCardIds,
		parserType,
		parserVersion,
		parserConfidence,
	};
}

// ============================================================================
// CREATE (get-or-create by semantic hash)
// ============================================================================

export interface CreateCampaignReviewCandidateParams
	extends ProposedCampaignTermsInput {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	sourceSnapshotId: string;
	occurredAt: Date;
	idempotencyKey: string;
}

/**
 * Section K (Phase 16-R1): a changed source (different content_hash on
 * campaign_source_snapshots from the one behind the currently-confirmed
 * campaign revision) creates a PENDING review candidate for an ACTIVE
 * campaign -- the current confirmed campaign revision is NEVER touched by
 * this call. Get-or-create by semantic candidate hash: an existing PENDING
 * candidate with an identical hash for this campaign period is returned
 * as-is rather than duplicated (no automatic APPLY).
 */
export async function createCampaignReviewCandidate(
	params: CreateCampaignReviewCandidateParams,
): Promise<CampaignReviewCandidateReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);
	const sourceSnapshotId = validateCampaignCanonicalUuid(
		params.sourceSnapshotId,
		"sourceSnapshotId",
	);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);
	const terms = normalizeProposedTerms(params);

	return runCampaignsTransaction(params.db, async (tx) => {
		const [period] = await tx
			.select({
				id: campaignPeriods.id,
				provider: campaignFamilies.provider,
			})
			.from(campaignPeriods)
			.innerJoin(
				campaignFamilies,
				eq(campaignFamilies.id, campaignPeriods.campaignFamilyId),
			)
			.where(
				and(
					eq(campaignPeriods.id, campaignPeriodId),
					eq(campaignPeriods.userId, userId),
				),
			)
			.limit(1);
		if (!period) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${campaignPeriodId}" not found`,
			);
		}

		const [snapshot] = await tx
			.select()
			.from(campaignSourceSnapshots)
			.where(
				and(
					eq(campaignSourceSnapshots.id, sourceSnapshotId),
					eq(campaignSourceSnapshots.userId, userId),
				),
			)
			.limit(1);
		if (!snapshot) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				`Campaign source snapshot "${sourceSnapshotId}" not found`,
			);
		}
		if (
			snapshot.sourceType !== "MANUAL" &&
			snapshot.provider !== period.provider
		) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				`Source snapshot provider "${snapshot.provider}" does not match campaign family provider "${period.provider}"`,
			);
		}

		const candidateHash = await calculateCampaignReviewCandidateHash({
			campaignPeriodId,
			sourceSnapshotId,
			title: terms.title,
			startsOn: terms.startsOn,
			endsOn: terms.endsOn,
			ruleMode: terms.ruleMode,
			targetSpendAmount: terms.targetSpendAmount,
			requiredTransactionCount: terms.requiredTransactionCount,
			minimumTransactionAmount: terms.minimumTransactionAmount,
			stepSpendAmount: terms.stepSpendAmount,
			rewardPointsPerStep: terms.rewardPointsPerStep,
			maxSteps: terms.maxSteps,
			rewardKind: terms.rewardKind,
			rewardAccountId: terms.rewardAccountId,
			expectedRewardPoints: terms.expectedRewardPoints,
			merchantScopeMode: terms.merchantScopeMode,
			requiredCanonicalMerchantNames: terms.requiredCanonicalMerchantNames,
			allowedMccCodes: terms.allowedMccCodes,
			rewardExpiryDate: terms.rewardExpiryDate,
			parserType: terms.parserType,
			parserVersion: terms.parserVersion,
			parserConfidence: terms.parserConfidence,
			proposedCardIds: terms.proposedCardIds,
		});

		// Early idempotency replay (by userId + idempotencyKey), scoped
		// globally across every candidate revision.
		const [existingRevByKey] = await tx
			.select()
			.from(campaignReviewCandidateRevisions)
			.where(
				and(
					eq(campaignReviewCandidateRevisions.userId, userId),
					eq(campaignReviewCandidateRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (existingRevByKey) {
			if (existingRevByKey.revisionFingerprint !== candidateHash) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different review candidate payload",
				);
			}
			const readModel = await buildLatestReadModelInTransaction(
				tx,
				existingRevByKey.candidateId,
			);
			if (!readModel) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Idempotency replay resolved to a missing review candidate",
				);
			}
			return readModel;
		}

		// Get-or-create by semantic hash: an existing PENDING candidate for
		// this period with an identical hash is returned as-is.
		const existingCandidates = await tx
			.select()
			.from(campaignReviewCandidates)
			.where(
				and(
					eq(campaignReviewCandidates.campaignPeriodId, campaignPeriodId),
					eq(campaignReviewCandidates.candidateHash, candidateHash),
				),
			);
		for (const existing of existingCandidates) {
			const readModel = await buildLatestReadModelInTransaction(
				tx,
				existing.id,
			);
			if (readModel && readModel.status === "PENDING") {
				return readModel;
			}
		}

		const [candidate] = await tx
			.insert(campaignReviewCandidates)
			.values({ userId, campaignPeriodId, sourceSnapshotId, candidateHash })
			.returning();
		if (!candidate) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to create campaign review candidate anchor",
			);
		}

		const [revision] = await tx
			.insert(campaignReviewCandidateRevisions)
			.values({
				userId,
				candidateId: candidate.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "PENDING",
				title: terms.title,
				startsOn: terms.startsOn,
				endsOn: terms.endsOn,
				ruleMode: terms.ruleMode,
				targetSpendAmount: terms.targetSpendAmount,
				requiredTransactionCount: terms.requiredTransactionCount,
				minimumTransactionAmount: terms.minimumTransactionAmount,
				stepSpendAmount: terms.stepSpendAmount,
				rewardPointsPerStep: terms.rewardPointsPerStep,
				maxSteps: terms.maxSteps,
				rewardKind: terms.rewardKind,
				rewardAccountId: terms.rewardAccountId,
				expectedRewardPoints: terms.expectedRewardPoints,
				merchantScopeMode: terms.merchantScopeMode,
				requiredCanonicalMerchantNames: terms.requiredCanonicalMerchantNames,
				allowedMccCodes: terms.allowedMccCodes,
				rewardExpiryDate: terms.rewardExpiryDate,
				parserType: terms.parserType,
				parserVersion: terms.parserVersion,
				parserConfidence:
					terms.parserConfidence === null
						? null
						: terms.parserConfidence.toString(),
				proposedCardIds: terms.proposedCardIds,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: candidateHash,
			})
			.returning();
		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to record campaign review candidate revision",
			);
		}

		return buildReadModel(candidate, revision);
	});
}

// ============================================================================
// Reads
// ============================================================================

export interface ListCampaignReviewCandidatesParams {
	db: Database;
	userId: string;
	campaignPeriodId?: string | undefined;
	status?: "PENDING" | "APPLIED" | "DISMISSED" | undefined;
}

export async function listCampaignReviewCandidates(
	params: ListCampaignReviewCandidatesParams,
): Promise<CampaignReviewCandidateReadModel[]> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId =
		params.campaignPeriodId === undefined
			? undefined
			: validateCampaignCanonicalUuid(
					params.campaignPeriodId,
					"campaignPeriodId",
				);
	if (
		params.status !== undefined &&
		!["PENDING", "APPLIED", "DISMISSED"].includes(params.status)
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`Invalid status filter: "${String(params.status)}"`,
		);
	}

	return runCampaignsReadTransaction(params.db, async (tx) => {
		const conditions = [eq(campaignReviewCandidates.userId, userId)];
		if (campaignPeriodId !== undefined) {
			conditions.push(
				eq(campaignReviewCandidates.campaignPeriodId, campaignPeriodId),
			);
		}
		const candidates = await tx
			.select()
			.from(campaignReviewCandidates)
			.where(and(...conditions));

		const results: CampaignReviewCandidateReadModel[] = [];
		for (const candidate of candidates) {
			const readModel = await buildLatestReadModelInTransaction(
				tx,
				candidate.id,
			);
			if (!readModel) continue;
			if (params.status !== undefined && readModel.status !== params.status)
				continue;
			results.push(readModel);
		}
		results.sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1));
		return results;
	});
}

export interface GetCampaignReviewCandidateParams {
	db: Database;
	userId: string;
	candidateId: string;
}

export async function getCampaignReviewCandidate(
	params: GetCampaignReviewCandidateParams,
): Promise<CampaignReviewCandidateReadModel | null> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const candidateId = validateCampaignCanonicalUuid(
		params.candidateId,
		"candidateId",
	);
	return runCampaignsReadTransaction(params.db, async (tx) => {
		const [candidate] = await tx
			.select()
			.from(campaignReviewCandidates)
			.where(
				and(
					eq(campaignReviewCandidates.id, candidateId),
					eq(campaignReviewCandidates.userId, userId),
				),
			)
			.limit(1);
		if (!candidate) return null;
		return buildLatestReadModelInTransaction(tx, candidateId);
	});
}

export interface GetCampaignSemanticDiffParams {
	db: Database;
	userId: string;
	candidateId: string;
}

const DIFF_FIELDS = [
	"title",
	"startsOn",
	"endsOn",
	"ruleMode",
	"targetSpendAmount",
	"requiredTransactionCount",
	"minimumTransactionAmount",
	"stepSpendAmount",
	"rewardPointsPerStep",
	"maxSteps",
	"rewardKind",
	"rewardAccountId",
	"expectedRewardPoints",
	"merchantScopeMode",
	"requiredCanonicalMerchantNames",
	"allowedMccCodes",
	"rewardExpiryDate",
	"parserType",
	"parserVersion",
	"parserConfidence",
	"cardIds",
] as const;

function pickCurrentFields(
	current: Record<string, unknown>,
): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const field of DIFF_FIELDS) picked[field] = current[field] ?? null;
	return picked;
}

/**
 * Section K: reuses the exact diff algorithm from src/campaigns/sources.ts
 * (computeCampaignSemanticDiff) against a candidate's proposed terms vs the
 * campaign's current confirmed terms -- no duplicated diff logic.
 */
export async function getCampaignSemanticDiff(
	params: GetCampaignSemanticDiffParams,
) {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const candidateId = validateCampaignCanonicalUuid(
		params.candidateId,
		"candidateId",
	);

	return runCampaignsReadTransaction(params.db, async (tx) => {
		const [candidate] = await tx
			.select()
			.from(campaignReviewCandidates)
			.where(
				and(
					eq(campaignReviewCandidates.id, candidateId),
					eq(campaignReviewCandidates.userId, userId),
				),
			)
			.limit(1);
		if (!candidate) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign review candidate "${candidateId}" not found`,
			);
		}
		const readModel = await buildLatestReadModelInTransaction(tx, candidateId);
		if (!readModel) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Campaign review candidate has no revisions",
			);
		}
		const current = await getLatestRevisionInTransaction(
			tx,
			userId,
			candidate.campaignPeriodId,
		);
		if (!current) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${candidate.campaignPeriodId}" not found`,
			);
		}

		const currentFields = pickCurrentFields({
			...current.row,
			cardIds: current.cardIds,
		});
		const proposedFields = pickCurrentFields({
			...readModel,
			cardIds: readModel.proposedCardIds,
		});

		return computeCampaignSemanticDiff(currentFields, proposedFields);
	});
}

// ============================================================================
// APPLY / DISMISS
// ============================================================================

export interface ApplyCampaignReviewCandidateParams {
	db: Database;
	userId: string;
	candidateId: string;
	/** OCC against the CAMPAIGN (not just the candidate). */
	expectedCampaignRevisionNo: number;
	occurredAt: Date;
	idempotencyKey: string;
	note?: string | null | undefined;
}

/**
 * Section K: applies a PENDING review candidate as a normal AMEND revision
 * on the campaign (reusing amendCampaignPeriod internally -- no duplicated
 * lifecycle logic), and marks the candidate APPLIED in the SAME transaction.
 * Revalidates the candidate's stored term snapshot through the same
 * validators again as defense against a stale candidate.
 */
export async function applyCampaignReviewCandidate(
	params: ApplyCampaignReviewCandidateParams,
): Promise<{
	candidate: CampaignReviewCandidateReadModel;
	campaign: Awaited<ReturnType<typeof amendCampaignPeriod>>;
}> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const candidateId = validateCampaignCanonicalUuid(
		params.candidateId,
		"candidateId",
	);
	const expectedCampaignRevisionNo = validateCampaignExpectedRevisionNo(
		params.expectedCampaignRevisionNo,
	);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);
	const note = validateCampaignOptionalText(params.note, "note", 1000);

	return runCampaignsTransaction(params.db, async (tx) => {
		const [candidate] = await tx
			.select()
			.from(campaignReviewCandidates)
			.where(
				and(
					eq(campaignReviewCandidates.id, candidateId),
					eq(campaignReviewCandidates.userId, userId),
				),
			)
			.for("update");
		if (!candidate) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign review candidate "${candidateId}" not found`,
			);
		}

		const latestCandidateRev = await buildLatestReadModelInTransaction(
			tx,
			candidateId,
		);
		if (!latestCandidateRev) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Campaign review candidate has no revisions",
			);
		}

		const fingerprint =
			await calculateCampaignReviewCandidateLifecycleFingerprint({
				userId,
				candidateId,
				operation: "APPLY",
				expectedCampaignRevisionNo,
				occurredAt,
				note,
			});

		const [existingRevByKey] = await tx
			.select()
			.from(campaignReviewCandidateRevisions)
			.where(
				and(
					eq(campaignReviewCandidateRevisions.userId, userId),
					eq(campaignReviewCandidateRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (existingRevByKey) {
			if (existingRevByKey.revisionFingerprint !== fingerprint) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different APPLY payload",
				);
			}
			const readModel = await buildLatestReadModelInTransaction(
				tx,
				candidateId,
			);
			const campaign = await buildCampaignPeriodReadModelInTransaction(
				tx,
				candidate.campaignPeriodId,
			);
			if (!readModel || !campaign) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Idempotency replay resolved to missing state",
				);
			}
			return { candidate: readModel, campaign };
		}

		if (latestCandidateRev.status !== "PENDING") {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				`Campaign review candidate "${candidateId}" is not PENDING (found ${latestCandidateRev.status})`,
			);
		}

		// Revalidate the stored term snapshot through the same validators
		// again -- defense against a stale candidate.
		const revalidated = normalizeProposedTerms({
			title: latestCandidateRev.title,
			startsOn: latestCandidateRev.startsOn,
			endsOn: latestCandidateRev.endsOn,
			ruleMode: latestCandidateRev.ruleMode,
			targetSpendAmount: latestCandidateRev.targetSpendAmount ?? undefined,
			requiredTransactionCount:
				latestCandidateRev.requiredTransactionCount ?? undefined,
			minimumTransactionAmount:
				latestCandidateRev.minimumTransactionAmount ?? undefined,
			stepSpendAmount: latestCandidateRev.stepSpendAmount ?? undefined,
			rewardPointsPerStep: latestCandidateRev.rewardPointsPerStep ?? undefined,
			maxSteps: latestCandidateRev.maxSteps ?? undefined,
			rewardKind: latestCandidateRev.rewardKind,
			rewardAccountId: latestCandidateRev.rewardAccountId ?? undefined,
			expectedRewardPoints:
				latestCandidateRev.expectedRewardPoints ?? undefined,
			merchantScopeMode: latestCandidateRev.merchantScopeMode,
			requiredCanonicalMerchantNames:
				latestCandidateRev.requiredCanonicalMerchantNames ?? undefined,
			allowedMccCodes: latestCandidateRev.allowedMccCodes ?? undefined,
			rewardExpiryDate: latestCandidateRev.rewardExpiryDate ?? undefined,
			proposedCardIds: latestCandidateRev.proposedCardIds,
			parserType: latestCandidateRev.parserType,
			parserVersion: latestCandidateRev.parserVersion,
			parserConfidence:
				latestCandidateRev.parserConfidence === null
					? null
					: Number(latestCandidateRev.parserConfidence),
		});

		// Create a normal AMEND revision on the campaign (reuses
		// amendCampaignPeriod internally -- no duplicated lifecycle logic).
		const campaignReadModel = await amendCampaignPeriod({
			db: params.db,
			userId,
			campaignPeriodId: candidate.campaignPeriodId,
			expectedRevisionNo: expectedCampaignRevisionNo,
			title: revalidated.title,
			startsOn: revalidated.startsOn,
			endsOn: revalidated.endsOn,
			ruleMode: revalidated.ruleMode,
			targetSpendAmount: revalidated.targetSpendAmount ?? undefined,
			requiredTransactionCount:
				revalidated.requiredTransactionCount ?? undefined,
			minimumTransactionAmount:
				revalidated.minimumTransactionAmount ?? undefined,
			stepSpendAmount: revalidated.stepSpendAmount ?? undefined,
			rewardPointsPerStep: revalidated.rewardPointsPerStep ?? undefined,
			maxSteps: revalidated.maxSteps ?? undefined,
			rewardKind: revalidated.rewardKind,
			rewardAccountId: revalidated.rewardAccountId ?? undefined,
			expectedRewardPoints: revalidated.expectedRewardPoints ?? undefined,
			merchantScopeMode: revalidated.merchantScopeMode,
			requiredCanonicalMerchantNames:
				revalidated.requiredCanonicalMerchantNames ?? undefined,
			allowedMccCodes: revalidated.allowedMccCodes ?? undefined,
			rewardExpiryDate: revalidated.rewardExpiryDate ?? undefined,
			cardIds: revalidated.proposedCardIds,
			sourceSnapshotId: candidate.sourceSnapshotId,
			parserType: revalidated.parserType,
			parserVersion: revalidated.parserVersion,
			parserConfidence: revalidated.parserConfidence,
			note,
			occurredAt,
			idempotencyKey: `${idempotencyKey}:campaign-amend`,
		});

		const [revision] = await tx
			.insert(campaignReviewCandidateRevisions)
			.values({
				userId,
				candidateId: candidate.id,
				revisionNo: latestCandidateRev.revisionNo + 1,
				previousRevisionId: latestCandidateRev.revisionId,
				operation: "APPLY",
				status: "APPLIED",
				title: latestCandidateRev.title,
				startsOn: latestCandidateRev.startsOn,
				endsOn: latestCandidateRev.endsOn,
				ruleMode: latestCandidateRev.ruleMode,
				targetSpendAmount: latestCandidateRev.targetSpendAmount,
				requiredTransactionCount: latestCandidateRev.requiredTransactionCount,
				minimumTransactionAmount: latestCandidateRev.minimumTransactionAmount,
				stepSpendAmount: latestCandidateRev.stepSpendAmount,
				rewardPointsPerStep: latestCandidateRev.rewardPointsPerStep,
				maxSteps: latestCandidateRev.maxSteps,
				rewardKind: latestCandidateRev.rewardKind,
				rewardAccountId: latestCandidateRev.rewardAccountId,
				expectedRewardPoints: latestCandidateRev.expectedRewardPoints,
				merchantScopeMode: latestCandidateRev.merchantScopeMode,
				requiredCanonicalMerchantNames:
					latestCandidateRev.requiredCanonicalMerchantNames,
				allowedMccCodes: latestCandidateRev.allowedMccCodes,
				rewardExpiryDate: latestCandidateRev.rewardExpiryDate,
				parserType: latestCandidateRev.parserType,
				parserVersion: latestCandidateRev.parserVersion,
				parserConfidence: latestCandidateRev.parserConfidence,
				proposedCardIds: latestCandidateRev.proposedCardIds,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();
		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to record campaign review candidate APPLY revision",
			);
		}

		return {
			candidate: buildReadModel(candidate, revision),
			campaign: campaignReadModel,
		};
	});
}

export interface DismissCampaignReviewCandidateParams {
	db: Database;
	userId: string;
	candidateId: string;
	occurredAt: Date;
	idempotencyKey: string;
	note?: string | null | undefined;
}

/**
 * Section K: appends a DISMISS revision. Never alters the active campaign.
 */
export async function dismissCampaignReviewCandidate(
	params: DismissCampaignReviewCandidateParams,
): Promise<CampaignReviewCandidateReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const candidateId = validateCampaignCanonicalUuid(
		params.candidateId,
		"candidateId",
	);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);
	const note = validateCampaignOptionalText(params.note, "note", 1000);

	return runCampaignsTransaction(params.db, async (tx) => {
		const [candidate] = await tx
			.select()
			.from(campaignReviewCandidates)
			.where(
				and(
					eq(campaignReviewCandidates.id, candidateId),
					eq(campaignReviewCandidates.userId, userId),
				),
			)
			.for("update");
		if (!candidate) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign review candidate "${candidateId}" not found`,
			);
		}

		const latestCandidateRev = await buildLatestReadModelInTransaction(
			tx,
			candidateId,
		);
		if (!latestCandidateRev) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Campaign review candidate has no revisions",
			);
		}

		const fingerprint =
			await calculateCampaignReviewCandidateLifecycleFingerprint({
				userId,
				candidateId,
				operation: "DISMISS",
				expectedCampaignRevisionNo: null,
				occurredAt,
				note,
			});

		const [existingRevByKey] = await tx
			.select()
			.from(campaignReviewCandidateRevisions)
			.where(
				and(
					eq(campaignReviewCandidateRevisions.userId, userId),
					eq(campaignReviewCandidateRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (existingRevByKey) {
			if (existingRevByKey.revisionFingerprint !== fingerprint) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different DISMISS payload",
				);
			}
			const readModel = await buildLatestReadModelInTransaction(
				tx,
				candidateId,
			);
			if (!readModel) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Idempotency replay resolved to missing state",
				);
			}
			return readModel;
		}

		if (latestCandidateRev.status !== "PENDING") {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				`Campaign review candidate "${candidateId}" is not PENDING (found ${latestCandidateRev.status})`,
			);
		}

		const [revision] = await tx
			.insert(campaignReviewCandidateRevisions)
			.values({
				userId,
				candidateId: candidate.id,
				revisionNo: latestCandidateRev.revisionNo + 1,
				previousRevisionId: latestCandidateRev.revisionId,
				operation: "DISMISS",
				status: "DISMISSED",
				title: latestCandidateRev.title,
				startsOn: latestCandidateRev.startsOn,
				endsOn: latestCandidateRev.endsOn,
				ruleMode: latestCandidateRev.ruleMode,
				targetSpendAmount: latestCandidateRev.targetSpendAmount,
				requiredTransactionCount: latestCandidateRev.requiredTransactionCount,
				minimumTransactionAmount: latestCandidateRev.minimumTransactionAmount,
				stepSpendAmount: latestCandidateRev.stepSpendAmount,
				rewardPointsPerStep: latestCandidateRev.rewardPointsPerStep,
				maxSteps: latestCandidateRev.maxSteps,
				rewardKind: latestCandidateRev.rewardKind,
				rewardAccountId: latestCandidateRev.rewardAccountId,
				expectedRewardPoints: latestCandidateRev.expectedRewardPoints,
				merchantScopeMode: latestCandidateRev.merchantScopeMode,
				requiredCanonicalMerchantNames:
					latestCandidateRev.requiredCanonicalMerchantNames,
				allowedMccCodes: latestCandidateRev.allowedMccCodes,
				rewardExpiryDate: latestCandidateRev.rewardExpiryDate,
				parserType: latestCandidateRev.parserType,
				parserVersion: latestCandidateRev.parserVersion,
				parserConfidence: latestCandidateRev.parserConfidence,
				proposedCardIds: latestCandidateRev.proposedCardIds,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();
		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to record campaign review candidate DISMISS revision",
			);
		}

		return buildReadModel(candidate, revision);
	});
}
