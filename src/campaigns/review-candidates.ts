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
	calculateCampaignReviewCandidateCreateRequestFingerprint,
	calculateCampaignReviewCandidateHash,
	calculateCampaignReviewCandidateLifecycleFingerprint,
	deriveCampaignReviewChildIdempotencyKey,
} from "./fingerprint";
import {
	validateCampaignRewardShape,
	validateCampaignRuleShape,
} from "./rules";
import {
	amendCampaignPeriodInTransaction,
	buildCampaignPeriodReadModelForRevisionInTransaction,
	type CampaignPeriodRevisionReadModel,
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
	/**
	 * Section D/J (Phase 16-R2): the exact campaign_period_revisions.id the
	 * AMEND driven by this candidate's APPLY revision produced. NULL for
	 * CREATE and DISMISS; always set for APPLY. Used to replay an APPLY
	 * idempotency key against the EXACT historical AMEND snapshot rather than
	 * the campaign's current latest state.
	 */
	appliedCampaignRevisionId: string | null;
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
		appliedCampaignRevisionId: revision.appliedCampaignRevisionId,
		occurredAt: revision.occurredAt,
		createdAt: revision.createdAt,
	};
}

/**
 * Section D (Phase 16-R2): reads the EXACT historical
 * campaign_review_candidate_revisions row identified by `revisionId` (not
 * necessarily the latest one for `candidateId`), mirroring the exact pattern
 * used for campaigns themselves
 * (`buildCampaignPeriodReadModelForRevisionInTransaction` in service.ts).
 * `buildLatestReadModelInTransaction` delegates here so the row-shaping
 * logic exists exactly once.
 */
export async function buildCampaignReviewCandidateReadModelForRevisionInTransaction(
	tx: DatabaseTransaction,
	candidateId: string,
	revisionId: string,
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
		.where(
			and(
				eq(campaignReviewCandidateRevisions.candidateId, candidateId),
				eq(campaignReviewCandidateRevisions.id, revisionId),
			),
		)
		.limit(1);
	if (!revision) return null;

	return buildReadModel(candidate, revision);
}

/**
 * Latest-state read model builder: resolves the latest revision id for
 * `candidateId` then delegates to the revision-scoped builder above -- no
 * duplicated row-shaping logic (Section D).
 */
async function buildLatestReadModelInTransaction(
	tx: DatabaseTransaction,
	candidateId: string,
): Promise<CampaignReviewCandidateReadModel | null> {
	const [latest] = await tx
		.select({ id: campaignReviewCandidateRevisions.id })
		.from(campaignReviewCandidateRevisions)
		.where(eq(campaignReviewCandidateRevisions.candidateId, candidateId))
		.orderBy(desc(campaignReviewCandidateRevisions.revisionNo))
		.limit(1);
	if (!latest) return null;
	return buildCampaignReviewCandidateReadModelForRevisionInTransaction(
		tx,
		candidateId,
		latest.id,
	);
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
	// Section I (Phase 16-R2): stored in a canonical (sorted) order so a
	// straightforward `IS NOT DISTINCT FROM` JSONB array comparison in the
	// terminal copy-forward trigger works without needing order-insensitive
	// SQL on every insert.
	const proposedCardIds = Array.from(
		new Set(
			input.proposedCardIds.map((id, i) =>
				validateCampaignCanonicalUuid(id, `proposedCardIds[${i}]`),
			),
		),
	).sort();

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
		// Section E/G (Phase 16-R2): lock the owning campaign_periods row
		// FOR UPDATE as the VERY FIRST statement. This is BOTH the ACTIVE
		// lifecycle gate's read point AND the serialization point for the
		// concurrent-PENDING-dedup fix below -- two concurrent identical
		// candidate-creation calls both acquire this SAME row lock before
		// doing anything else, so they serialize correctly (the loser sees
		// the winner's already-created PENDING candidate).
		const [period] = await tx
			.select()
			.from(campaignPeriods)
			.where(
				and(
					eq(campaignPeriods.id, campaignPeriodId),
					eq(campaignPeriods.userId, userId),
				),
			)
			.for("update");
		if (!period) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${campaignPeriodId}" not found`,
			);
		}

		const [family] = await tx
			.select({ provider: campaignFamilies.provider })
			.from(campaignFamilies)
			.where(eq(campaignFamilies.id, period.campaignFamilyId))
			.limit(1);
		if (!family) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Campaign family for this period could not be resolved",
			);
		}

		// Section E: a candidate can only be created against an ACTIVE
		// campaign lifecycle. HIDDEN visibility with ACTIVE lifecycle is
		// explicitly allowed (visibility is orthogonal); REVIEW_REQUIRED,
		// ENDED, and CANCELLED lifecycle are all rejected -- there is
		// nothing to amend/re-review for those states.
		const latestPeriodRev = await getLatestRevisionInTransaction(
			tx,
			userId,
			campaignPeriodId,
		);
		if (!latestPeriodRev) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${campaignPeriodId}" not found`,
			);
		}
		if (latestPeriodRev.row.lifecycleStatus !== "ACTIVE") {
			throw new CampaignError(
				"CAMPAIGN_NOT_ACTIVE",
				`Campaign period "${campaignPeriodId}" must be ACTIVE to create a review candidate (found ${latestPeriodRev.row.lifecycleStatus})`,
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
			snapshot.provider !== family.provider
		) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_INPUT",
				`Source snapshot provider "${snapshot.provider}" does not match campaign family provider "${family.provider}"`,
			);
		}

		// Section K (Phase 16-R1): content-addressed semantic identity used
		// ONLY for cross-request PENDING dedup (Section G) and the anchor's
		// candidate_hash column -- deliberately excludes occurredAt and
		// other request-specific fields.
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

		// Section C (Phase 16-R2): the EXACT-replay request fingerprint --
		// unlike candidateHash, this binds occurredAt/userId/campaignPeriodId/
		// sourceSnapshotId (plus candidateHash itself, so any term/card/
		// parser change also changes this). Stored as this CREATE revision's
		// revisionFingerprint and used for the early idempotency-key replay
		// check below.
		const createRequestFingerprint =
			await calculateCampaignReviewCandidateCreateRequestFingerprint({
				userId,
				campaignPeriodId,
				sourceSnapshotId,
				candidateHash,
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
				occurredAt,
			});

		// Early idempotency replay (by userId + idempotencyKey), scoped
		// globally across every candidate revision. Section D: replays the
		// EXACT historical revision that owns this key (not whatever is
		// currently latest for the candidate).
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
			if (existingRevByKey.revisionFingerprint !== createRequestFingerprint) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different review candidate payload",
				);
			}
			const readModel =
				await buildCampaignReviewCandidateReadModelForRevisionInTransaction(
					tx,
					existingRevByKey.candidateId,
					existingRevByKey.id,
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
		// this period with an identical hash is returned as-is. Section G:
		// safe from concurrent duplication because the campaign_periods row
		// lock acquired above is held for the duration of this check AND the
		// insert below.
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
				appliedCampaignRevisionId: null,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: createRequestFingerprint,
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
 * Section A/D/J (Phase 16-R2): applies a PENDING review candidate as a
 * normal AMEND revision on the campaign, driven on the SAME already-open
 * transaction as the candidate APPLY revision insert (reuses
 * `amendCampaignPeriodInTransaction` -- no duplicated lifecycle logic, and
 * no second independent transaction/connection). The single atomic unit is:
 * candidate lock -> campaign-period lock/OCC (now on the same tx) -> AMEND
 * revision insert -> AMEND card companions insert -> candidate APPLY
 * revision insert (storing the exact AMEND revision id it produced). If any
 * step fails, everything rolls back together. Revalidates the candidate's
 * stored term snapshot through the same validators again as defense against
 * a stale candidate.
 */
export async function applyCampaignReviewCandidate(
	params: ApplyCampaignReviewCandidateParams,
): Promise<{
	candidate: CampaignReviewCandidateReadModel;
	campaign: CampaignPeriodRevisionReadModel;
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
			// Section D: replay the EXACT historical candidate APPLY
			// revision AND the exact historical campaign AMEND revision it
			// produced -- NOT the campaign's current latest state, which may
			// have since been amended again, hidden, or ended.
			if (!existingRevByKey.appliedCampaignRevisionId) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Historical APPLY revision is missing its applied campaign revision binding",
				);
			}
			const readModel =
				await buildCampaignReviewCandidateReadModelForRevisionInTransaction(
					tx,
					candidateId,
					existingRevByKey.id,
				);
			const campaign =
				await buildCampaignPeriodReadModelForRevisionInTransaction(
					tx,
					candidate.campaignPeriodId,
					existingRevByKey.appliedCampaignRevisionId,
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

		// Section B: bounded, deterministic, collision-resistant child
		// idempotency key -- NOT raw string concatenation, which could
		// overflow campaign_period_revisions.idempotency_key (varchar(128))
		// when the parent key is itself near the 128-char limit.
		const childIdempotencyKey = await deriveCampaignReviewChildIdempotencyKey({
			parentKey: idempotencyKey,
			candidateId,
			operation: "APPLY",
			child: "CAMPAIGN_AMEND",
		});

		// Section A: drives the campaign AMEND on this SAME already-open
		// transaction (`tx`) -- NOT a fresh runCampaignsTransaction(params.db,
		// ...) call, which would open a second, independent transaction
		// disconnected from this one.
		const campaignReadModel = await amendCampaignPeriodInTransaction(tx, {
			userId,
			campaignPeriodId: candidate.campaignPeriodId,
			expectedRevisionNo: expectedCampaignRevisionNo,
			title: revalidated.title,
			startsOn: revalidated.startsOn,
			endsOn: revalidated.endsOn,
			ruleMode: revalidated.ruleMode,
			targetSpendAmount: revalidated.targetSpendAmount,
			requiredTransactionCount: revalidated.requiredTransactionCount,
			minimumTransactionAmount: revalidated.minimumTransactionAmount,
			stepSpendAmount: revalidated.stepSpendAmount,
			rewardPointsPerStep: revalidated.rewardPointsPerStep,
			maxSteps: revalidated.maxSteps,
			rewardKind: revalidated.rewardKind,
			rewardAccountId: revalidated.rewardAccountId,
			expectedRewardPoints: revalidated.expectedRewardPoints,
			merchantScopeMode: revalidated.merchantScopeMode,
			requiredCanonicalMerchantNames:
				revalidated.requiredCanonicalMerchantNames,
			allowedMccCodes: revalidated.allowedMccCodes,
			rewardExpiryDate: revalidated.rewardExpiryDate,
			cardIds: revalidated.proposedCardIds,
			sourceSnapshotId: candidate.sourceSnapshotId,
			parserType: revalidated.parserType,
			parserVersion: revalidated.parserVersion,
			parserConfidence: revalidated.parserConfidence,
			note,
			occurredAt,
			idempotencyKey: childIdempotencyKey,
		});

		// Section D/J: store the EXACT AMEND revision id this APPLY produced
		// so a future idempotency-key replay (or the sealing trigger) can
		// resolve the exact historical campaign snapshot rather than the
		// campaign's current latest state.
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
				appliedCampaignRevisionId: campaignReadModel.revisionId,
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
			// Section D: replay the EXACT historical DISMISS revision that
			// owns this key, not whatever is currently latest.
			const readModel =
				await buildCampaignReviewCandidateReadModelForRevisionInTransaction(
					tx,
					candidateId,
					existingRevByKey.id,
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
				appliedCampaignRevisionId: null,
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
