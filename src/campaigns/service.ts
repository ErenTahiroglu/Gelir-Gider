import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	campaignFamilies,
	campaignPeriodRevisionCards,
	campaignPeriodRevisions,
	campaignPeriods,
	campaignPurchaseOverrideRevisions,
	campaignPurchaseOverrides,
	campaignRewardCreditRevisions,
	campaignRewardCredits,
} from "../db/schema/campaigns";
import {
	recordRewardEarnInTransaction,
	voidRewardEventInTransaction,
} from "../rewards/events";
import {
	runCampaignsReadTransaction,
	runCampaignsTransaction,
} from "./boundary";
import {
	validateCampaignCanonicalUuid,
	validateCampaignExpectedRevisionNo,
	validateCampaignGregorianDateString,
	validateCampaignIdempotencyKey,
	validateCampaignLifecycleStatusFilter,
	validateCampaignMerchantScopeMode,
	validateCampaignOccurredAt,
	validateCampaignOptionalText,
	validateCampaignOverrideOperation,
	validateCampaignPositiveIntegerRange,
	validateCampaignRequiredText,
	validateCampaignRewardKind,
	validateCampaignRuleMode,
	validateCampaignStringArray,
	validateCampaignVisibilityFilter,
} from "./calendar";
import {
	parseCampaignOptionalPositiveMoneyString,
	parseCampaignPointQuantity,
	parseCampaignPositiveMoneyString,
} from "./decimal";
import { CampaignError } from "./errors";
import {
	calculateCampaignOverrideFingerprint,
	calculateCampaignPeriodLifecycleFingerprint,
	calculateCampaignPeriodRevisionFingerprint,
	calculateCampaignRewardCreditFingerprint,
} from "./fingerprint";
import {
	validateCampaignRewardShape,
	validateCampaignRuleShape,
} from "./rules";

// ============================================================================
// Read models
// ============================================================================

export interface CampaignPeriodRevisionReadModel {
	campaignPeriodId: string;
	campaignFamilyId: string;
	provider: string;
	familyKey: string;
	periodKey: string;
	revisionId: string;
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
	occurredAt: Date;
	createdAt: Date;
}

async function buildCampaignPeriodReadModelInTransaction(
	tx: DatabaseTransaction,
	campaignPeriodId: string,
): Promise<CampaignPeriodRevisionReadModel | null> {
	const [row] = await tx
		.select({
			period: campaignPeriods,
			family: campaignFamilies,
			revision: campaignPeriodRevisions,
		})
		.from(campaignPeriods)
		.innerJoin(
			campaignFamilies,
			eq(campaignFamilies.id, campaignPeriods.campaignFamilyId),
		)
		.innerJoin(
			campaignPeriodRevisions,
			eq(campaignPeriodRevisions.campaignPeriodId, campaignPeriods.id),
		)
		.where(eq(campaignPeriods.id, campaignPeriodId))
		.orderBy(desc(campaignPeriodRevisions.revisionNo))
		.limit(1);

	if (!row) return null;

	const cardRows = await tx
		.select({ creditCardId: campaignPeriodRevisionCards.creditCardId })
		.from(campaignPeriodRevisionCards)
		.where(eq(campaignPeriodRevisionCards.revisionId, row.revision.id));

	return {
		campaignPeriodId: row.period.id,
		campaignFamilyId: row.family.id,
		provider: row.family.provider,
		familyKey: row.family.familyKey,
		periodKey: row.period.periodKey,
		revisionId: row.revision.id,
		revisionNo: row.revision.revisionNo,
		operation: row.revision.operation,
		lifecycleStatus: row.revision.lifecycleStatus as
			| "REVIEW_REQUIRED"
			| "ACTIVE"
			| "ENDED"
			| "CANCELLED",
		visibility: row.revision.visibility as "VISIBLE" | "HIDDEN",
		title: row.revision.title,
		startsOn: row.revision.startsOn,
		endsOn: row.revision.endsOn,
		ruleMode: row.revision.ruleMode as
			| "TOTAL_SPEND"
			| "TRANSACTION_COUNT"
			| "REPEATABLE_SPEND",
		targetSpendAmount: row.revision.targetSpendAmount,
		requiredTransactionCount: row.revision.requiredTransactionCount,
		minimumTransactionAmount: row.revision.minimumTransactionAmount,
		stepSpendAmount: row.revision.stepSpendAmount,
		rewardPointsPerStep: row.revision.rewardPointsPerStep,
		maxSteps: row.revision.maxSteps,
		rewardKind: row.revision.rewardKind as
			| "REWARD_POINTS"
			| "STATEMENT_CREDIT"
			| "INFORMATIONAL",
		rewardAccountId: row.revision.rewardAccountId,
		expectedRewardPoints: row.revision.expectedRewardPoints,
		merchantScopeMode: row.revision.merchantScopeMode as
			| "ALL_MERCHANTS"
			| "MERCHANT_ALIASES"
			| "MANUAL_REVIEW_REQUIRED",
		requiredCanonicalMerchantNames: row.revision
			.requiredCanonicalMerchantNames as string[] | null,
		allowedMccCodes: row.revision.allowedMccCodes as string[] | null,
		rewardExpiryDate: row.revision.rewardExpiryDate,
		sourceSnapshotId: row.revision.sourceSnapshotId,
		parserType: row.revision.parserType,
		parserVersion: row.revision.parserVersion,
		parserConfidence: row.revision.parserConfidence,
		note: row.revision.note,
		cardIds: cardRows.map((c) => c.creditCardId),
		occurredAt: row.revision.occurredAt,
		createdAt: row.revision.createdAt,
	};
}

async function tryReplayCampaignPeriodRevisionByKey(
	tx: DatabaseTransaction,
	userId: string,
	idempotencyKey: string,
	expectedFingerprint: string,
): Promise<CampaignPeriodRevisionReadModel | null> {
	const [existing] = await tx
		.select()
		.from(campaignPeriodRevisions)
		.where(
			and(
				eq(campaignPeriodRevisions.userId, userId),
				eq(campaignPeriodRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);

	if (!existing) return null;

	if (existing.revisionFingerprint !== expectedFingerprint) {
		throw new CampaignError(
			"CAMPAIGN_IDEMPOTENCY_CONFLICT",
			"Idempotency key reused with a different campaign period payload",
		);
	}

	return buildCampaignPeriodReadModelInTransaction(
		tx,
		existing.campaignPeriodId,
	);
}

// ============================================================================
// CREATE (family + period + revision #1, REVIEW_REQUIRED)
// ============================================================================

export interface CreateCampaignPeriodInput {
	db: Database;
	userId: string;
	provider: string;
	familyKey: string;
	periodKey: string;
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
	cardIds: string[];
	sourceSnapshotId?: string | null | undefined;
	parserType?: string | null | undefined;
	parserVersion?: string | null | undefined;
	parserConfidence?: number | null | undefined;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

function normalizeCreateFields(params: CreateCampaignPeriodInput) {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const provider = validateCampaignRequiredText(
		params.provider,
		"provider",
		120,
	);
	const familyKey = validateCampaignRequiredText(
		params.familyKey,
		"familyKey",
		160,
	);
	const periodKey = validateCampaignRequiredText(
		params.periodKey,
		"periodKey",
		160,
	);
	const title = validateCampaignRequiredText(params.title, "title", 200);
	const startsOn = validateCampaignGregorianDateString(
		params.startsOn,
		"startsOn",
	);
	const endsOn = validateCampaignGregorianDateString(params.endsOn, "endsOn");
	if (startsOn > endsOn) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"startsOn must not be after endsOn",
		);
	}
	const ruleMode = validateCampaignRuleMode(params.ruleMode);
	const targetSpendAmount =
		params.targetSpendAmount === undefined
			? null
			: parseCampaignPositiveMoneyString(
					params.targetSpendAmount,
					"targetSpendAmount",
				);
	const requiredTransactionCount =
		params.requiredTransactionCount === undefined
			? null
			: validateCampaignPositiveIntegerRange(
					params.requiredTransactionCount,
					"requiredTransactionCount",
					1,
					1_000_000,
				);
	const minimumTransactionAmount = parseCampaignOptionalPositiveMoneyString(
		params.minimumTransactionAmount,
		"minimumTransactionAmount",
	);
	const stepSpendAmount =
		params.stepSpendAmount === undefined
			? null
			: parseCampaignPositiveMoneyString(
					params.stepSpendAmount,
					"stepSpendAmount",
				);
	const rewardPointsPerStep =
		params.rewardPointsPerStep === undefined
			? null
			: parseCampaignPointQuantity(
					params.rewardPointsPerStep,
					"rewardPointsPerStep",
				);
	const maxSteps =
		params.maxSteps === undefined
			? null
			: validateCampaignPositiveIntegerRange(
					params.maxSteps,
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

	const rewardKind = validateCampaignRewardKind(params.rewardKind);
	const rewardAccountId =
		params.rewardAccountId === undefined
			? null
			: validateCampaignCanonicalUuid(
					params.rewardAccountId,
					"rewardAccountId",
				);
	const expectedRewardPoints =
		params.expectedRewardPoints === undefined
			? null
			: parseCampaignPointQuantity(
					params.expectedRewardPoints,
					"expectedRewardPoints",
				);

	validateCampaignRewardShape({
		rewardKind,
		ruleMode,
		rewardAccountId,
		expectedRewardPointsUnits: expectedRewardPoints?.units ?? null,
	});

	const merchantScopeMode = validateCampaignMerchantScopeMode(
		params.merchantScopeMode,
	);
	const requiredCanonicalMerchantNames =
		merchantScopeMode === "MERCHANT_ALIASES"
			? validateCampaignStringArray(
					params.requiredCanonicalMerchantNames,
					"requiredCanonicalMerchantNames",
					200,
					100,
				)
			: (() => {
					if (params.requiredCanonicalMerchantNames !== undefined) {
						throw new CampaignError(
							"CAMPAIGN_INVALID_INPUT",
							"requiredCanonicalMerchantNames is only allowed for MERCHANT_ALIASES scope",
						);
					}
					return null;
				})();
	const allowedMccCodes =
		params.allowedMccCodes === undefined
			? null
			: validateCampaignStringArray(
					params.allowedMccCodes,
					"allowedMccCodes",
					10,
					50,
				);
	const rewardExpiryDate =
		params.rewardExpiryDate === undefined
			? null
			: validateCampaignGregorianDateString(
					params.rewardExpiryDate,
					"rewardExpiryDate",
				);

	if (!Array.isArray(params.cardIds)) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"cardIds must be an array",
		);
	}
	const cardIds = params.cardIds.map((id, i) =>
		validateCampaignCanonicalUuid(id, `cardIds[${i}]`),
	);
	const uniqueCardIds = Array.from(new Set(cardIds));

	const sourceSnapshotId =
		params.sourceSnapshotId === undefined || params.sourceSnapshotId === null
			? null
			: validateCampaignCanonicalUuid(
					params.sourceSnapshotId,
					"sourceSnapshotId",
				);
	const parserType = validateCampaignOptionalText(
		params.parserType,
		"parserType",
		60,
	);
	const parserVersion = validateCampaignOptionalText(
		params.parserVersion,
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
		params.parserConfidence === undefined || params.parserConfidence === null
			? null
			: params.parserConfidence;
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
	const note = validateCampaignOptionalText(params.note, "note", 1000);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);

	return {
		userId,
		provider,
		familyKey,
		periodKey,
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
		cardIds: uniqueCardIds,
		sourceSnapshotId,
		parserType,
		parserVersion,
		parserConfidence,
		note,
		occurredAt,
		idempotencyKey,
	};
}

export async function createCampaignPeriod(
	params: CreateCampaignPeriodInput,
): Promise<CampaignPeriodRevisionReadModel> {
	const fields = normalizeCreateFields(params);

	return runCampaignsTransaction(params.db, async (tx) => {
		const fingerprint = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			{
				userId: fields.userId,
				campaignPeriodId: "PENDING",
				title: fields.title,
				startsOn: fields.startsOn,
				endsOn: fields.endsOn,
				ruleMode: fields.ruleMode,
				targetSpendAmount: fields.targetSpendAmount,
				requiredTransactionCount: fields.requiredTransactionCount,
				minimumTransactionAmount: fields.minimumTransactionAmount,
				stepSpendAmount: fields.stepSpendAmount,
				rewardPointsPerStep: fields.rewardPointsPerStep,
				maxSteps: fields.maxSteps,
				rewardKind: fields.rewardKind,
				rewardAccountId: fields.rewardAccountId,
				expectedRewardPoints: fields.expectedRewardPoints,
				merchantScopeMode: fields.merchantScopeMode,
				requiredCanonicalMerchantNames: fields.requiredCanonicalMerchantNames,
				allowedMccCodes: fields.allowedMccCodes,
				rewardExpiryDate: fields.rewardExpiryDate,
				cardIds: fields.cardIds,
				sourceSnapshotId: fields.sourceSnapshotId,
				note: fields.note,
				occurredAt: fields.occurredAt,
			},
		);

		const replay = await tryReplayCampaignPeriodRevisionByKey(
			tx,
			fields.userId,
			fields.idempotencyKey,
			fingerprint,
		);
		if (replay) return replay;

		// Ensure family exists (idempotent get-or-create).
		let [family] = await tx
			.select()
			.from(campaignFamilies)
			.where(
				and(
					eq(campaignFamilies.userId, fields.userId),
					eq(campaignFamilies.provider, fields.provider),
					eq(campaignFamilies.familyKey, fields.familyKey),
				),
			)
			.limit(1);

		if (!family) {
			const [inserted] = await tx
				.insert(campaignFamilies)
				.values({
					userId: fields.userId,
					provider: fields.provider,
					familyKey: fields.familyKey,
				})
				.returning();
			family = inserted;
		}
		if (!family) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to resolve campaign family",
			);
		}

		let [period] = await tx
			.select()
			.from(campaignPeriods)
			.where(
				and(
					eq(campaignPeriods.campaignFamilyId, family.id),
					eq(campaignPeriods.periodKey, fields.periodKey),
				),
			)
			.limit(1);

		if (period) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				`Campaign period with key "${fields.periodKey}" already exists for this family`,
			);
		}

		const [insertedPeriod] = await tx
			.insert(campaignPeriods)
			.values({
				userId: fields.userId,
				campaignFamilyId: family.id,
				periodKey: fields.periodKey,
			})
			.returning();
		period = insertedPeriod;
		if (!period) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to create campaign period",
			);
		}

		const exactFingerprint = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			{
				userId: fields.userId,
				campaignPeriodId: period.id,
				title: fields.title,
				startsOn: fields.startsOn,
				endsOn: fields.endsOn,
				ruleMode: fields.ruleMode,
				targetSpendAmount: fields.targetSpendAmount,
				requiredTransactionCount: fields.requiredTransactionCount,
				minimumTransactionAmount: fields.minimumTransactionAmount,
				stepSpendAmount: fields.stepSpendAmount,
				rewardPointsPerStep: fields.rewardPointsPerStep,
				maxSteps: fields.maxSteps,
				rewardKind: fields.rewardKind,
				rewardAccountId: fields.rewardAccountId,
				expectedRewardPoints: fields.expectedRewardPoints,
				merchantScopeMode: fields.merchantScopeMode,
				requiredCanonicalMerchantNames: fields.requiredCanonicalMerchantNames,
				allowedMccCodes: fields.allowedMccCodes,
				rewardExpiryDate: fields.rewardExpiryDate,
				cardIds: fields.cardIds,
				sourceSnapshotId: fields.sourceSnapshotId,
				note: fields.note,
				occurredAt: fields.occurredAt,
			},
		);

		const [revision] = await tx
			.insert(campaignPeriodRevisions)
			.values({
				userId: fields.userId,
				campaignPeriodId: period.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				lifecycleStatus: "REVIEW_REQUIRED",
				visibility: "VISIBLE",
				title: fields.title,
				startsOn: fields.startsOn,
				endsOn: fields.endsOn,
				ruleMode: fields.ruleMode,
				targetSpendAmount: fields.targetSpendAmount,
				requiredTransactionCount: fields.requiredTransactionCount,
				minimumTransactionAmount: fields.minimumTransactionAmount,
				stepSpendAmount: fields.stepSpendAmount,
				rewardPointsPerStep: fields.rewardPointsPerStep,
				maxSteps: fields.maxSteps,
				rewardKind: fields.rewardKind,
				rewardAccountId: fields.rewardAccountId,
				expectedRewardPoints: fields.expectedRewardPoints,
				merchantScopeMode: fields.merchantScopeMode,
				requiredCanonicalMerchantNames: fields.requiredCanonicalMerchantNames,
				allowedMccCodes: fields.allowedMccCodes,
				rewardExpiryDate: fields.rewardExpiryDate,
				sourceSnapshotId: fields.sourceSnapshotId,
				parserType: fields.parserType,
				parserVersion: fields.parserVersion,
				parserConfidence:
					fields.parserConfidence === null
						? null
						: fields.parserConfidence.toString(),
				note: fields.note,
				occurredAt: fields.occurredAt,
				idempotencyKey: fields.idempotencyKey,
				revisionFingerprint: exactFingerprint,
			})
			.returning();

		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to create campaign period revision",
			);
		}

		if (fields.cardIds.length > 0) {
			await tx.insert(campaignPeriodRevisionCards).values(
				fields.cardIds.map((creditCardId) => ({
					revisionId: revision.id,
					creditCardId,
				})),
			);
		}

		const readModel = await buildCampaignPeriodReadModelInTransaction(
			tx,
			period.id,
		);
		if (!readModel) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to build campaign period read model",
			);
		}
		return readModel;
	});
}

// ============================================================================
// Lifecycle mutations: CONFIRM, AMEND, HIDE, RESTORE, END, CANCEL
// ============================================================================

export async function getLatestRevisionInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	campaignPeriodId: string,
): Promise<{
	row: typeof campaignPeriodRevisions.$inferSelect;
	cardIds: string[];
} | null> {
	const [period] = await tx
		.select()
		.from(campaignPeriods)
		.where(
			and(
				eq(campaignPeriods.id, campaignPeriodId),
				eq(campaignPeriods.userId, userId),
			),
		)
		.limit(1);
	if (!period) return null;

	const [row] = await tx
		.select()
		.from(campaignPeriodRevisions)
		.where(eq(campaignPeriodRevisions.campaignPeriodId, campaignPeriodId))
		.orderBy(desc(campaignPeriodRevisions.revisionNo))
		.limit(1);
	if (!row) return null;

	const cardRows = await tx
		.select({ creditCardId: campaignPeriodRevisionCards.creditCardId })
		.from(campaignPeriodRevisionCards)
		.where(eq(campaignPeriodRevisionCards.revisionId, row.id));

	return { row, cardIds: cardRows.map((c) => c.creditCardId) };
}

interface SimpleLifecycleInput {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	expectedRevisionNo: number;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

function makeSimpleLifecycleOp(
	operation: "CONFIRM" | "HIDE" | "RESTORE" | "END" | "CANCEL",
) {
	return async function runLifecycleOp(
		params: SimpleLifecycleInput,
	): Promise<CampaignPeriodRevisionReadModel> {
		const userId = validateCampaignCanonicalUuid(params.userId, "userId");
		const campaignPeriodId = validateCampaignCanonicalUuid(
			params.campaignPeriodId,
			"campaignPeriodId",
		);
		const expectedRevisionNo = validateCampaignExpectedRevisionNo(
			params.expectedRevisionNo,
		);
		const note = validateCampaignOptionalText(params.note, "note", 1000);
		const occurredAt = validateCampaignOccurredAt(params.occurredAt);
		const idempotencyKey = validateCampaignIdempotencyKey(
			params.idempotencyKey,
		);

		return runCampaignsTransaction(params.db, async (tx) => {
			const lifecycleFingerprint =
				await calculateCampaignPeriodLifecycleFingerprint({
					userId,
					campaignPeriodId,
					expectedRevisionNo,
					operation,
					occurredAt,
					note,
				});

			const replay = await tryReplayCampaignPeriodRevisionByKey(
				tx,
				userId,
				idempotencyKey,
				lifecycleFingerprint,
			);
			if (replay) return replay;

			const latest = await getLatestRevisionInTransaction(
				tx,
				userId,
				campaignPeriodId,
			);
			if (!latest) {
				throw new CampaignError(
					"CAMPAIGN_NOT_FOUND",
					`Campaign period "${campaignPeriodId}" not found`,
				);
			}
			if (latest.row.revisionNo !== expectedRevisionNo) {
				throw new CampaignError(
					"CAMPAIGN_REVISION_CONFLICT",
					`Expected campaign period revision ${expectedRevisionNo} but found ${latest.row.revisionNo}`,
				);
			}

			let newLifecycleStatus = latest.row.lifecycleStatus;
			let newVisibility = latest.row.visibility;
			if (operation === "CONFIRM") newLifecycleStatus = "ACTIVE";
			else if (operation === "END") newLifecycleStatus = "ENDED";
			else if (operation === "CANCEL") newLifecycleStatus = "CANCELLED";
			else if (operation === "HIDE") newVisibility = "HIDDEN";
			else if (operation === "RESTORE") newVisibility = "VISIBLE";

			const [revision] = await tx
				.insert(campaignPeriodRevisions)
				.values({
					userId,
					campaignPeriodId,
					revisionNo: latest.row.revisionNo + 1,
					previousRevisionId: latest.row.id,
					operation,
					lifecycleStatus: newLifecycleStatus,
					visibility: newVisibility,
					title: latest.row.title,
					startsOn: latest.row.startsOn,
					endsOn: latest.row.endsOn,
					ruleMode: latest.row.ruleMode,
					targetSpendAmount: latest.row.targetSpendAmount,
					requiredTransactionCount: latest.row.requiredTransactionCount,
					minimumTransactionAmount: latest.row.minimumTransactionAmount,
					stepSpendAmount: latest.row.stepSpendAmount,
					rewardPointsPerStep: latest.row.rewardPointsPerStep,
					maxSteps: latest.row.maxSteps,
					rewardKind: latest.row.rewardKind,
					rewardAccountId: latest.row.rewardAccountId,
					expectedRewardPoints: latest.row.expectedRewardPoints,
					merchantScopeMode: latest.row.merchantScopeMode,
					requiredCanonicalMerchantNames:
						latest.row.requiredCanonicalMerchantNames,
					allowedMccCodes: latest.row.allowedMccCodes,
					rewardExpiryDate: latest.row.rewardExpiryDate,
					sourceSnapshotId: latest.row.sourceSnapshotId,
					parserType: latest.row.parserType,
					parserVersion: latest.row.parserVersion,
					parserConfidence: latest.row.parserConfidence,
					note,
					occurredAt,
					idempotencyKey,
					revisionFingerprint: lifecycleFingerprint,
				})
				.returning();

			if (!revision) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Failed to create campaign period lifecycle revision",
				);
			}

			if (latest.cardIds.length > 0) {
				await tx.insert(campaignPeriodRevisionCards).values(
					latest.cardIds.map((creditCardId) => ({
						revisionId: revision.id,
						creditCardId,
					})),
				);
			}

			const readModel = await buildCampaignPeriodReadModelInTransaction(
				tx,
				campaignPeriodId,
			);
			if (!readModel) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Failed to build campaign period read model",
				);
			}
			return readModel;
		});
	};
}

export const confirmCampaignPeriod = makeSimpleLifecycleOp("CONFIRM");
export const hideCampaignPeriod = makeSimpleLifecycleOp("HIDE");
export const restoreCampaignPeriod = makeSimpleLifecycleOp("RESTORE");
export const endCampaignPeriod = makeSimpleLifecycleOp("END");
export const cancelCampaignPeriod = makeSimpleLifecycleOp("CANCEL");

// ============================================================================
// AMEND (ACTIVE -> ACTIVE, terms may change; explicit user action only)
// ============================================================================

export interface AmendCampaignPeriodInput
	extends Omit<
		CreateCampaignPeriodInput,
		"provider" | "familyKey" | "periodKey"
	> {
	campaignPeriodId: string;
	expectedRevisionNo: number;
}

export async function amendCampaignPeriod(
	params: AmendCampaignPeriodInput,
): Promise<CampaignPeriodRevisionReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);
	const expectedRevisionNo = validateCampaignExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const fields = normalizeCreateFields({
		...params,
		provider: "AMEND",
		familyKey: "AMEND",
		periodKey: "AMEND",
	});

	return runCampaignsTransaction(params.db, async (tx) => {
		const fingerprint = await calculateCampaignPeriodRevisionFingerprint(
			"AMEND",
			{
				userId,
				campaignPeriodId,
				title: fields.title,
				startsOn: fields.startsOn,
				endsOn: fields.endsOn,
				ruleMode: fields.ruleMode,
				targetSpendAmount: fields.targetSpendAmount,
				requiredTransactionCount: fields.requiredTransactionCount,
				minimumTransactionAmount: fields.minimumTransactionAmount,
				stepSpendAmount: fields.stepSpendAmount,
				rewardPointsPerStep: fields.rewardPointsPerStep,
				maxSteps: fields.maxSteps,
				rewardKind: fields.rewardKind,
				rewardAccountId: fields.rewardAccountId,
				expectedRewardPoints: fields.expectedRewardPoints,
				merchantScopeMode: fields.merchantScopeMode,
				requiredCanonicalMerchantNames: fields.requiredCanonicalMerchantNames,
				allowedMccCodes: fields.allowedMccCodes,
				rewardExpiryDate: fields.rewardExpiryDate,
				cardIds: fields.cardIds,
				sourceSnapshotId: fields.sourceSnapshotId,
				note: fields.note,
				occurredAt: fields.occurredAt,
			},
		);

		const replay = await tryReplayCampaignPeriodRevisionByKey(
			tx,
			userId,
			fields.idempotencyKey,
			fingerprint,
		);
		if (replay) return replay;

		const latest = await getLatestRevisionInTransaction(
			tx,
			userId,
			campaignPeriodId,
		);
		if (!latest) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${campaignPeriodId}" not found`,
			);
		}
		if (latest.row.revisionNo !== expectedRevisionNo) {
			throw new CampaignError(
				"CAMPAIGN_REVISION_CONFLICT",
				`Expected campaign period revision ${expectedRevisionNo} but found ${latest.row.revisionNo}`,
			);
		}
		if (latest.row.lifecycleStatus !== "ACTIVE") {
			throw new CampaignError(
				"CAMPAIGN_NOT_ACTIVE",
				`Campaign period "${campaignPeriodId}" must be ACTIVE to AMEND`,
			);
		}

		const [revision] = await tx
			.insert(campaignPeriodRevisions)
			.values({
				userId,
				campaignPeriodId,
				revisionNo: latest.row.revisionNo + 1,
				previousRevisionId: latest.row.id,
				operation: "AMEND",
				lifecycleStatus: "ACTIVE",
				visibility: latest.row.visibility,
				title: fields.title,
				startsOn: fields.startsOn,
				endsOn: fields.endsOn,
				ruleMode: fields.ruleMode,
				targetSpendAmount: fields.targetSpendAmount,
				requiredTransactionCount: fields.requiredTransactionCount,
				minimumTransactionAmount: fields.minimumTransactionAmount,
				stepSpendAmount: fields.stepSpendAmount,
				rewardPointsPerStep: fields.rewardPointsPerStep,
				maxSteps: fields.maxSteps,
				rewardKind: fields.rewardKind,
				rewardAccountId: fields.rewardAccountId,
				expectedRewardPoints: fields.expectedRewardPoints,
				merchantScopeMode: fields.merchantScopeMode,
				requiredCanonicalMerchantNames: fields.requiredCanonicalMerchantNames,
				allowedMccCodes: fields.allowedMccCodes,
				rewardExpiryDate: fields.rewardExpiryDate,
				sourceSnapshotId: fields.sourceSnapshotId,
				parserType: fields.parserType,
				parserVersion: fields.parserVersion,
				parserConfidence:
					fields.parserConfidence === null
						? null
						: fields.parserConfidence.toString(),
				note: fields.note,
				occurredAt: fields.occurredAt,
				idempotencyKey: fields.idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to create campaign period AMEND revision",
			);
		}

		if (fields.cardIds.length > 0) {
			await tx.insert(campaignPeriodRevisionCards).values(
				fields.cardIds.map((creditCardId) => ({
					revisionId: revision.id,
					creditCardId,
				})),
			);
		}

		const readModel = await buildCampaignPeriodReadModelInTransaction(
			tx,
			campaignPeriodId,
		);
		if (!readModel) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to build campaign period read model",
			);
		}
		return readModel;
	});
}

// ============================================================================
// Reads: getCampaignPeriod / listCampaignPeriods
// ============================================================================

export interface GetCampaignPeriodParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
}

export async function getCampaignPeriod(
	params: GetCampaignPeriodParams,
): Promise<CampaignPeriodRevisionReadModel | null> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);

	return runCampaignsReadTransaction(params.db, async (tx) => {
		const [period] = await tx
			.select()
			.from(campaignPeriods)
			.where(
				and(
					eq(campaignPeriods.id, campaignPeriodId),
					eq(campaignPeriods.userId, userId),
				),
			)
			.limit(1);
		if (!period) return null;
		return buildCampaignPeriodReadModelInTransaction(tx, campaignPeriodId);
	});
}

export interface ListCampaignPeriodsParams {
	db: Database;
	userId: string;
	status?: unknown;
	visibility?: unknown;
	provider?: string | undefined;
	creditCardId?: string | undefined;
}

export async function listCampaignPeriods(
	params: ListCampaignPeriodsParams,
): Promise<CampaignPeriodRevisionReadModel[]> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const status = validateCampaignLifecycleStatusFilter(params.status);
	const visibility = validateCampaignVisibilityFilter(params.visibility);
	const provider =
		params.provider === undefined
			? undefined
			: validateCampaignRequiredText(params.provider, "provider", 120);
	const creditCardId =
		params.creditCardId === undefined
			? undefined
			: validateCampaignCanonicalUuid(params.creditCardId, "creditCardId");

	return runCampaignsReadTransaction(params.db, async (tx) => {
		const periods = await tx
			.select({ id: campaignPeriods.id })
			.from(campaignPeriods)
			.where(eq(campaignPeriods.userId, userId));

		const results: CampaignPeriodRevisionReadModel[] = [];
		for (const p of periods) {
			const readModel = await buildCampaignPeriodReadModelInTransaction(
				tx,
				p.id,
			);
			if (!readModel) continue;
			if (status !== undefined && readModel.lifecycleStatus !== status)
				continue;
			if (visibility !== undefined && readModel.visibility !== visibility)
				continue;
			if (provider !== undefined && readModel.provider !== provider) continue;
			if (
				creditCardId !== undefined &&
				!readModel.cardIds.includes(creditCardId)
			)
				continue;
			results.push(readModel);
		}

		results.sort((a, b) => {
			if (a.lifecycleStatus === "ACTIVE" && b.lifecycleStatus === "ACTIVE") {
				if (a.endsOn !== b.endsOn) return a.endsOn < b.endsOn ? -1 : 1;
				return a.campaignPeriodId < b.campaignPeriodId ? -1 : 1;
			}
			if (a.lifecycleStatus === "ACTIVE") return -1;
			if (b.lifecycleStatus === "ACTIVE") return 1;
			return a.campaignPeriodId < b.campaignPeriodId ? -1 : 1;
		});

		return results;
	});
}

// ============================================================================
// Purchase Overrides
// ============================================================================

export interface CampaignPurchaseOverrideReadModel {
	overrideId: string;
	campaignPeriodId: string;
	purchaseEventId: string;
	revisionNo: number;
	operation: "INCLUDE" | "EXCLUDE" | "CLEAR";
	reasonNote: string | null;
	occurredAt: Date;
}

export interface RecordCampaignPurchaseOverrideParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	purchaseEventId: string;
	operation: unknown;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export async function recordCampaignPurchaseOverride(
	params: RecordCampaignPurchaseOverrideParams,
): Promise<CampaignPurchaseOverrideReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);
	const purchaseEventId = validateCampaignCanonicalUuid(
		params.purchaseEventId,
		"purchaseEventId",
	);
	const operation = validateCampaignOverrideOperation(params.operation);
	const reasonNote = validateCampaignOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);

	return runCampaignsTransaction(params.db, async (tx) => {
		const fingerprint = await calculateCampaignOverrideFingerprint({
			userId,
			campaignPeriodId,
			purchaseEventId,
			operation,
			reasonNote,
			occurredAt,
		});

		const [existingRevByKey] = await tx
			.select()
			.from(campaignPurchaseOverrideRevisions)
			.where(
				and(
					eq(campaignPurchaseOverrideRevisions.userId, userId),
					eq(campaignPurchaseOverrideRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRevByKey) {
			if (existingRevByKey.revisionFingerprint !== fingerprint) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different override payload",
				);
			}
			return {
				overrideId: existingRevByKey.overrideId,
				campaignPeriodId,
				purchaseEventId,
				revisionNo: existingRevByKey.revisionNo,
				operation: existingRevByKey.operation as
					| "INCLUDE"
					| "EXCLUDE"
					| "CLEAR",
				reasonNote: existingRevByKey.reasonNote,
				occurredAt: existingRevByKey.occurredAt,
			};
		}

		let [override] = await tx
			.select()
			.from(campaignPurchaseOverrides)
			.where(
				and(
					eq(campaignPurchaseOverrides.campaignPeriodId, campaignPeriodId),
					eq(campaignPurchaseOverrides.purchaseEventId, purchaseEventId),
				),
			)
			.limit(1);

		if (!override) {
			const [inserted] = await tx
				.insert(campaignPurchaseOverrides)
				.values({ userId, campaignPeriodId, purchaseEventId })
				.returning();
			override = inserted;
		}
		if (!override) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to resolve campaign purchase override anchor",
			);
		}

		const [latestRev] = await tx
			.select({
				id: campaignPurchaseOverrideRevisions.id,
				revisionNo: campaignPurchaseOverrideRevisions.revisionNo,
			})
			.from(campaignPurchaseOverrideRevisions)
			.where(eq(campaignPurchaseOverrideRevisions.overrideId, override.id))
			.orderBy(desc(campaignPurchaseOverrideRevisions.revisionNo))
			.limit(1);

		const [revision] = await tx
			.insert(campaignPurchaseOverrideRevisions)
			.values({
				userId,
				overrideId: override.id,
				revisionNo: (latestRev?.revisionNo ?? 0) + 1,
				previousRevisionId: latestRev?.id ?? null,
				operation,
				reasonNote,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to record campaign purchase override revision",
			);
		}

		return {
			overrideId: override.id,
			campaignPeriodId,
			purchaseEventId,
			revisionNo: revision.revisionNo,
			operation,
			reasonNote,
			occurredAt,
		};
	});
}

/**
 * Returns the latest override operation per purchase event for a campaign
 * period (used by the progress computation to apply manual overrides).
 */
export async function listLatestCampaignPurchaseOverridesInTransaction(
	tx: DatabaseTransaction,
	campaignPeriodId: string,
): Promise<Map<string, "INCLUDE" | "EXCLUDE" | "CLEAR">> {
	const overrides = await tx
		.select({
			id: campaignPurchaseOverrides.id,
			purchaseEventId: campaignPurchaseOverrides.purchaseEventId,
		})
		.from(campaignPurchaseOverrides)
		.where(eq(campaignPurchaseOverrides.campaignPeriodId, campaignPeriodId));

	const result = new Map<string, "INCLUDE" | "EXCLUDE" | "CLEAR">();
	for (const o of overrides) {
		const [latestRev] = await tx
			.select({ operation: campaignPurchaseOverrideRevisions.operation })
			.from(campaignPurchaseOverrideRevisions)
			.where(eq(campaignPurchaseOverrideRevisions.overrideId, o.id))
			.orderBy(desc(campaignPurchaseOverrideRevisions.revisionNo))
			.limit(1);
		if (latestRev) {
			result.set(
				o.purchaseEventId,
				latestRev.operation as "INCLUDE" | "EXCLUDE" | "CLEAR",
			);
		}
	}
	return result;
}

// ============================================================================
// Reward Credit Confirm / Void
// ============================================================================

export interface CampaignRewardCreditReadModel {
	creditId: string;
	campaignPeriodId: string;
	rewardAccountId: string;
	revisionNo: number;
	operation: "CREATE" | "VOID";
	actualPointAmount: string;
	expectedPointAmount: string | null;
	rewardEventId: string;
	reasonNote: string | null;
	occurredAt: Date;
}

export interface ConfirmCampaignRewardCreditedParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	actualPointAmount: string;
	expectedPointAmount: string | null;
	occurredAt: Date;
	reasonNote?: string | null | undefined;
	idempotencyKey: string;
}

/**
 * Section 20: implements confirmCampaignRewardCredited. Only valid when the
 * campaign period is ACTIVE/ENDED, rewardKind = REWARD_POINTS, and the
 * caller-supplied expected/actual comparison is honest (a different amount
 * requires a reasonNote). Atomically records the campaign reward-credit
 * companion and calls the EXACT existing recordRewardEarnInTransaction with
 * sourceType "CAMPAIGN" and sourceRef = campaignPeriodId. Qualification is
 * NOT checked against live purchase progress here -- callers must first read
 * getCampaignProgress and confirm qualificationStatus is
 * QUALIFIED_AWAITING_CREDIT; this function enforces the DB-authoritative
 * single-active-identity + reward-kind/lifecycle invariants, and progress
 * requalification is intentionally the caller's read-before-write
 * responsibility (mirrors every other domain's OCC contract).
 */
export async function confirmCampaignRewardCredited(
	params: ConfirmCampaignRewardCreditedParams,
): Promise<CampaignRewardCreditReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);
	const actual = parseCampaignPointQuantity(
		params.actualPointAmount,
		"actualPointAmount",
	);
	const expected =
		params.expectedPointAmount === null ||
		params.expectedPointAmount === undefined
			? null
			: parseCampaignPointQuantity(
					params.expectedPointAmount,
					"expectedPointAmount",
				);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const reasonNote = validateCampaignOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);

	if (
		expected !== null &&
		expected.normalized !== actual.normalized &&
		reasonNote === null
	) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			"reasonNote is required when actualPointAmount differs from expectedPointAmount",
		);
	}

	return runCampaignsTransaction(params.db, async (tx) => {
		const [existingRevByKey] = await tx
			.select()
			.from(campaignRewardCreditRevisions)
			.where(
				and(
					eq(campaignRewardCreditRevisions.userId, userId),
					eq(campaignRewardCreditRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		const expectedFingerprint = await calculateCampaignRewardCreditFingerprint({
			userId,
			campaignPeriodId,
			operation: "CREATE",
			rewardAccountId: "PENDING",
			actualPointAmount: actual.normalized,
			expectedPointAmount: expected?.normalized ?? null,
			reasonNote,
			occurredAt,
		});

		if (existingRevByKey) {
			// Fingerprint binds rewardAccountId, so recompute using the
			// existing credit's account for the replay comparison.
			const [credit] = await tx
				.select()
				.from(campaignRewardCredits)
				.where(eq(campaignRewardCredits.id, existingRevByKey.creditId))
				.limit(1);
			if (!credit) {
				throw new CampaignError(
					"CAMPAIGN_INVALID_STATE",
					"Idempotency replay resolved to a missing reward credit anchor",
				);
			}
			const replayFingerprint = await calculateCampaignRewardCreditFingerprint({
				userId,
				campaignPeriodId,
				operation: "CREATE",
				rewardAccountId: credit.rewardAccountId,
				actualPointAmount: actual.normalized,
				expectedPointAmount: expected?.normalized ?? null,
				reasonNote,
				occurredAt,
			});
			if (existingRevByKey.revisionFingerprint !== replayFingerprint) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different reward credit payload",
				);
			}
			return {
				creditId: credit.id,
				campaignPeriodId: credit.campaignPeriodId,
				rewardAccountId: credit.rewardAccountId,
				revisionNo: existingRevByKey.revisionNo,
				operation: "CREATE",
				actualPointAmount: existingRevByKey.actualPointAmount,
				expectedPointAmount: existingRevByKey.expectedPointAmount,
				rewardEventId: existingRevByKey.rewardEventId,
				reasonNote: existingRevByKey.reasonNote,
				occurredAt: existingRevByKey.occurredAt,
			};
		}
		void expectedFingerprint;

		const latestPeriod = await getLatestRevisionInTransaction(
			tx,
			userId,
			campaignPeriodId,
		);
		if (!latestPeriod) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`Campaign period "${campaignPeriodId}" not found`,
			);
		}
		if (!["ACTIVE", "ENDED"].includes(latestPeriod.row.lifecycleStatus)) {
			throw new CampaignError(
				"CAMPAIGN_NOT_ACTIVE",
				`Campaign period "${campaignPeriodId}" is not ACTIVE/ENDED`,
			);
		}
		if (latestPeriod.row.rewardKind !== "REWARD_POINTS") {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				`Campaign period "${campaignPeriodId}" rewardKind is not REWARD_POINTS`,
			);
		}
		const rewardAccountId = latestPeriod.row.rewardAccountId;
		if (!rewardAccountId) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				`Campaign period "${campaignPeriodId}" has no bound reward account`,
			);
		}

		const [existingCredit] = await tx
			.select()
			.from(campaignRewardCredits)
			.where(eq(campaignRewardCredits.campaignPeriodId, campaignPeriodId))
			.limit(1);
		if (existingCredit) {
			const [latestExistingRev] = await tx
				.select({ operation: campaignRewardCreditRevisions.operation })
				.from(campaignRewardCreditRevisions)
				.where(eq(campaignRewardCreditRevisions.creditId, existingCredit.id))
				.orderBy(desc(campaignRewardCreditRevisions.revisionNo))
				.limit(1);
			if (latestExistingRev && latestExistingRev.operation !== "VOID") {
				throw new CampaignError(
					"CAMPAIGN_REWARD_ALREADY_CREDITED",
					`Campaign period "${campaignPeriodId}" already has an active reward credit`,
				);
			}
		}

		const finalFingerprint = await calculateCampaignRewardCreditFingerprint({
			userId,
			campaignPeriodId,
			operation: "CREATE",
			rewardAccountId,
			actualPointAmount: actual.normalized,
			expectedPointAmount: expected?.normalized ?? null,
			reasonNote,
			occurredAt,
		});

		const [credit] = await tx
			.insert(campaignRewardCredits)
			.values({ userId, campaignPeriodId, rewardAccountId })
			.returning();
		if (!credit) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to create campaign reward credit anchor",
			);
		}

		const rewardResult = await recordRewardEarnInTransaction(tx, {
			userId,
			rewardAccountId,
			pointAmount: actual.normalized,
			reasonNote:
				reasonNote ?? `Campaign reward credit for period ${campaignPeriodId}`,
			occurredAt,
			idempotencyKey: `campaign-reward-credit:${credit.id}`,
			sourceType: "CAMPAIGN",
			sourceRef: campaignPeriodId,
		});

		const [revision] = await tx
			.insert(campaignRewardCreditRevisions)
			.values({
				userId,
				creditId: credit.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				actualPointAmount: actual.normalized,
				expectedPointAmount: expected?.normalized ?? null,
				reasonNote,
				occurredAt,
				rewardEventId: rewardResult.event.rewardEventId,
				idempotencyKey,
				revisionFingerprint: finalFingerprint,
			})
			.returning();

		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to record campaign reward credit revision",
			);
		}

		return {
			creditId: credit.id,
			campaignPeriodId,
			rewardAccountId,
			revisionNo: 1,
			operation: "CREATE",
			actualPointAmount: actual.normalized,
			expectedPointAmount: expected?.normalized ?? null,
			rewardEventId: rewardResult.event.rewardEventId,
			reasonNote,
			occurredAt,
		};
	});
}

export interface VoidCampaignRewardCreditParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

/**
 * Section 22: VOID campaign reward credit -> exact VOID of the linked Phase
 * 12 reward EARN event, atomically. The campaign period returns to
 * QUALIFIED_AWAITING_CREDIT; a subsequent confirmCampaignRewardCredited call
 * creates a brand new reward event identity.
 */
export async function voidCampaignRewardCredit(
	params: VoidCampaignRewardCreditParams,
): Promise<CampaignRewardCreditReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);
	const expectedRevisionNo = validateCampaignExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const reasonNote = validateCampaignOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const occurredAt = validateCampaignOccurredAt(params.occurredAt);
	const idempotencyKey = validateCampaignIdempotencyKey(params.idempotencyKey);

	return runCampaignsTransaction(params.db, async (tx) => {
		const [credit] = await tx
			.select()
			.from(campaignRewardCredits)
			.where(eq(campaignRewardCredits.campaignPeriodId, campaignPeriodId))
			.limit(1);
		if (!credit || credit.userId !== userId) {
			throw new CampaignError(
				"CAMPAIGN_NOT_FOUND",
				`No reward credit found for campaign period "${campaignPeriodId}"`,
			);
		}

		const [latestRev] = await tx
			.select()
			.from(campaignRewardCreditRevisions)
			.where(eq(campaignRewardCreditRevisions.creditId, credit.id))
			.orderBy(desc(campaignRewardCreditRevisions.revisionNo))
			.limit(1);
		if (!latestRev) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Reward credit has no revisions",
			);
		}

		const fingerprint = await calculateCampaignRewardCreditFingerprint({
			userId,
			campaignPeriodId,
			operation: "VOID",
			rewardAccountId: credit.rewardAccountId,
			actualPointAmount: latestRev.actualPointAmount,
			expectedPointAmount: latestRev.expectedPointAmount,
			reasonNote,
			occurredAt,
		});

		const [existingRevByKey] = await tx
			.select()
			.from(campaignRewardCreditRevisions)
			.where(
				and(
					eq(campaignRewardCreditRevisions.userId, userId),
					eq(campaignRewardCreditRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		if (existingRevByKey) {
			if (existingRevByKey.revisionFingerprint !== fingerprint) {
				throw new CampaignError(
					"CAMPAIGN_IDEMPOTENCY_CONFLICT",
					"Idempotency key reused with a different VOID payload",
				);
			}
			return {
				creditId: credit.id,
				campaignPeriodId,
				rewardAccountId: credit.rewardAccountId,
				revisionNo: existingRevByKey.revisionNo,
				operation: "VOID",
				actualPointAmount: existingRevByKey.actualPointAmount,
				expectedPointAmount: existingRevByKey.expectedPointAmount,
				rewardEventId: existingRevByKey.rewardEventId,
				reasonNote: existingRevByKey.reasonNote,
				occurredAt: existingRevByKey.occurredAt,
			};
		}

		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new CampaignError(
				"CAMPAIGN_REVISION_CONFLICT",
				`Expected reward credit revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
			);
		}
		if (latestRev.operation === "VOID") {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Reward credit is already VOID",
			);
		}

		// VOID the linked Phase 12 EARN event first (same transaction), then
		// record the VOID revision on the campaign side referencing it.
		await voidRewardEventInTransaction(tx, {
			userId,
			rewardEventId: latestRev.rewardEventId,
			expectedRevisionNo: 1,
			reasonNote,
			idempotencyKey: `campaign-reward-credit-void:${credit.id}`,
		});

		const [revision] = await tx
			.insert(campaignRewardCreditRevisions)
			.values({
				userId,
				creditId: credit.id,
				revisionNo: latestRev.revisionNo + 1,
				previousRevisionId: latestRev.id,
				operation: "VOID",
				actualPointAmount: latestRev.actualPointAmount,
				expectedPointAmount: latestRev.expectedPointAmount,
				reasonNote,
				occurredAt,
				rewardEventId: latestRev.rewardEventId,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!revision) {
			throw new CampaignError(
				"CAMPAIGN_INVALID_STATE",
				"Failed to record campaign reward credit VOID revision",
			);
		}

		return {
			creditId: credit.id,
			campaignPeriodId,
			rewardAccountId: credit.rewardAccountId,
			revisionNo: revision.revisionNo,
			operation: "VOID",
			actualPointAmount: latestRev.actualPointAmount,
			expectedPointAmount: latestRev.expectedPointAmount,
			rewardEventId: latestRev.rewardEventId,
			reasonNote,
			occurredAt,
		};
	});
}

/**
 * Returns the currently active (non-VOID) reward credit for a campaign
 * period, if any.
 */
export async function getActiveCampaignRewardCreditInTransaction(
	tx: DatabaseTransaction,
	campaignPeriodId: string,
): Promise<{ actualPointAmount: string; creditId: string } | null> {
	const [credit] = await tx
		.select()
		.from(campaignRewardCredits)
		.where(eq(campaignRewardCredits.campaignPeriodId, campaignPeriodId))
		.limit(1);
	if (!credit) return null;

	const [latestRev] = await tx
		.select()
		.from(campaignRewardCreditRevisions)
		.where(eq(campaignRewardCreditRevisions.creditId, credit.id))
		.orderBy(desc(campaignRewardCreditRevisions.revisionNo))
		.limit(1);
	if (!latestRev || latestRev.operation === "VOID") return null;

	return {
		actualPointAmount: latestRev.actualPointAmount,
		creditId: credit.id,
	};
}
