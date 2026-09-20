import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { runCampaignsReadTransaction } from "../campaigns/boundary";
import { CampaignError as CampaignDomainError } from "../campaigns/errors";
import {
	type CampaignPeriodCursor,
	type CampaignProgressPurchaseCursor,
	type CampaignReviewCandidateCursor,
	decodeCampaignOverrideCursor,
	decodeCampaignPeriodCursor,
	decodeCampaignProgressPurchaseCursor,
	decodeCampaignReviewCandidateCursor,
	encodeCampaignOverrideCursor,
	encodeCampaignPeriodCursor,
	encodeCampaignProgressPurchaseCursor,
	encodeCampaignReviewCandidateCursor,
} from "../campaigns/pagination";
import {
	getActiveCampaignRewardCredit,
	listBoundedCampaignOverrides,
	listBoundedCampaignPeriods,
	listBoundedCampaignProgressPurchases,
	listBoundedCampaignReviewCandidates,
	toCampaignPeriodProductDto,
	toCampaignProgressProductDto,
	toCampaignReviewCandidateProductDto,
	toCampaignRewardCreditProductDto,
	toCampaignSourceSnapshotProductDto,
} from "../campaigns/product-read";
import { getCampaignProgressInTransaction } from "../campaigns/progress";
import {
	applyCampaignReviewCandidate,
	dismissCampaignReviewCandidate,
	getCampaignReviewCandidate,
	getCampaignSemanticDiff,
} from "../campaigns/review-candidates";
import {
	amendCampaignPeriod,
	cancelCampaignPeriod,
	confirmCampaignPeriod,
	confirmCampaignRewardCredited,
	createCampaignPeriod,
	endCampaignPeriod,
	getCampaignPeriod,
	hideCampaignPeriod,
	recordCampaignPurchaseOverride,
	restoreCampaignPeriod,
	voidCampaignRewardCredit,
} from "../campaigns/service";
import { getCampaignSourceSnapshot } from "../campaigns/sources";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	isUuid,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
} from "./transport";

type CampaignsEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const campaignsRouter = new Hono<CampaignsEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<CampaignsEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapCampaignsDomainError(c: Context<CampaignsEnv>, err: unknown) {
	if (err instanceof CampaignDomainError) {
		switch (err.code) {
			case "CAMPAIGN_INVALID_INPUT":
			case "CAMPAIGN_INVALID_RULE":
				return fail(c, err.code, 400);
			case "CAMPAIGN_NOT_FOUND":
			case "CAMPAIGN_PURCHASE_NOT_FOUND":
				return fail(c, err.code, 404);
			case "CAMPAIGN_NOT_ACTIVE":
			case "CAMPAIGN_REVIEW_REQUIRED":
			case "CAMPAIGN_REVISION_CONFLICT":
			case "CAMPAIGN_IDEMPOTENCY_CONFLICT":
			case "CAMPAIGN_PURCHASE_NEEDS_REVIEW":
			case "CAMPAIGN_NOT_QUALIFIED":
			case "CAMPAIGN_REWARD_ALREADY_CREDITED":
				return fail(c, err.code, 409);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

function validateStrictQueryParams(
	c: Context,
	allowedKeys: readonly string[],
): boolean {
	const url = new URL(c.req.url);
	const seen = new Set<string>();
	for (const key of url.searchParams.keys()) {
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		if (!allowedKeys.includes(key)) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Global Router Middleware
// ---------------------------------------------------------------------------

campaignsRouter.use("*", requireAuthenticatedSession);
campaignsRouter.use("*", sameOriginMutationGuard());

// ===========================================================================
// STATIC SUBTREES FIRST (Registered before /:id to prevent route hijacking)
// ===========================================================================

// ---------------------------------------------------------------------------
// A. REVIEW CANDIDATES SURFACE
// ---------------------------------------------------------------------------

/**
 * 17. GET /campaigns/review-candidates
 * Bounded list of review candidates.
 */
campaignsRouter.get("/review-candidates", async (c) => {
	if (
		!validateStrictQueryParams(c, [
			"campaignPeriodId",
			"status",
			"limit",
			"after",
		])
	) {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const campaignPeriodIdQuery = c.req.query("campaignPeriodId");
	if (campaignPeriodIdQuery !== undefined && !isUuid(campaignPeriodIdQuery)) {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const statusQuery = c.req.query("status");
	let statusFilter: "PENDING" | "APPLIED" | "DISMISSED" | undefined;
	if (statusQuery !== undefined) {
		if (!["PENDING", "APPLIED", "DISMISSED"].includes(statusQuery)) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery as "PENDING" | "APPLIED" | "DISMISSED";
	}

	const auth = c.get("auth");
	const afterQuery = c.req.query("after");
	let afterCursor: CampaignReviewCandidateCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeCampaignReviewCandidateCursor(afterQuery, {
				userId: auth.userId,
				campaignPeriodId: campaignPeriodIdQuery,
			});
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedCampaignReviewCandidates({
			db,
			userId: auth.userId,
			campaignPeriodId: campaignPeriodIdQuery,
			status: statusFilter,
			limit: limitRes.limit,
			afterCursor,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeCampaignReviewCandidateCursor(result.nextCursor, {
						userId: auth.userId,
						campaignPeriodId: campaignPeriodIdQuery,
					})
				: null;

		return c.json(
			{
				candidates: result.candidates,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 18. GET /campaigns/review-candidates/:id
 * Retrieve a single review candidate.
 */
campaignsRouter.get("/review-candidates/:id", async (c) => {
	const candidateId = c.req.param("id");
	if (!isUuid(candidateId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const candidate = await getCampaignReviewCandidate({
			db,
			userId: auth.userId,
			candidateId,
		});
		if (!candidate) return fail(c, "CAMPAIGN_NOT_FOUND", 404);

		return c.json(
			{ candidate: toCampaignReviewCandidateProductDto(candidate) },
			200,
		);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 19. GET /campaigns/review-candidates/:id/diff
 * Semantic diff between campaign current state and candidate proposed terms.
 */
campaignsRouter.get("/review-candidates/:id/diff", async (c) => {
	const candidateId = c.req.param("id");
	if (!isUuid(candidateId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const diff = await getCampaignSemanticDiff({
			db,
			userId: auth.userId,
			candidateId,
		});

		return c.json({ diff }, 200);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 20. POST /campaigns/review-candidates/:id/apply
 * Apply candidate terms to campaign in a single atomic transaction.
 */
campaignsRouter.post(
	"/review-candidates/:id/apply",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const candidateId = c.req.param("id");
		if (!isUuid(candidateId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["expectedCampaignRevisionNo", "note", "occurredAt"])
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedCampaignRevisionNo !== "number" ||
			!Number.isInteger(body.expectedCampaignRevisionNo) ||
			body.expectedCampaignRevisionNo < 1
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			body.note !== undefined &&
			body.note !== null &&
			typeof body.note !== "string"
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await applyCampaignReviewCandidate({
				db,
				userId: auth.userId,
				candidateId,
				expectedCampaignRevisionNo: body.expectedCampaignRevisionNo,
				note: body.note as string | null | undefined,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					candidate: toCampaignReviewCandidateProductDto(result.candidate),
					campaign: toCampaignPeriodProductDto(result.campaign),
				},
				200,
			);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);

/**
 * 21. POST /campaigns/review-candidates/:id/dismiss
 * Dismiss a candidate proposal without mutating the campaign.
 */
campaignsRouter.post(
	"/review-candidates/:id/dismiss",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const candidateId = c.req.param("id");
		if (!isUuid(candidateId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["note", "occurredAt"])) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			body.note !== undefined &&
			body.note !== null &&
			typeof body.note !== "string"
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await dismissCampaignReviewCandidate({
				db,
				userId: auth.userId,
				candidateId,
				note: body.note as string | null | undefined,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{ candidate: toCampaignReviewCandidateProductDto(result) },
				200,
			);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);

// ---------------------------------------------------------------------------
// B. SOURCE SNAPSHOTS SURFACE
// ---------------------------------------------------------------------------

/**
 * 22. GET /campaigns/source-snapshots/:id
 * Retrieve a single source snapshot by ID.
 */
campaignsRouter.get("/source-snapshots/:id", async (c) => {
	const sourceSnapshotId = c.req.param("id");
	if (!isUuid(sourceSnapshotId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const snapshot = await getCampaignSourceSnapshot({
			db,
			userId: auth.userId,
			sourceSnapshotId,
		});
		if (!snapshot) return fail(c, "CAMPAIGN_NOT_FOUND", 404);

		return c.json(
			{
				sourceSnapshot: toCampaignSourceSnapshotProductDto(snapshot),
			},
			200,
		);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

// ===========================================================================
// CAMPAIGN PERIODS & SUB-RESOURCES (Mounted at /campaigns)
// ===========================================================================

/**
 * 1. GET /campaigns
 * Bounded campaign list with filters and deterministic cursor pagination.
 */
campaignsRouter.get("/", async (c) => {
	if (
		!validateStrictQueryParams(c, [
			"status",
			"visibility",
			"provider",
			"creditCardId",
			"limit",
			"after",
		])
	) {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const statusQuery = c.req.query("status");
	let statusFilter:
		| "REVIEW_REQUIRED"
		| "ACTIVE"
		| "ENDED"
		| "CANCELLED"
		| undefined;
	if (statusQuery !== undefined) {
		if (
			!["REVIEW_REQUIRED", "ACTIVE", "ENDED", "CANCELLED"].includes(statusQuery)
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery as
			| "REVIEW_REQUIRED"
			| "ACTIVE"
			| "ENDED"
			| "CANCELLED";
	}

	const visibilityQuery = c.req.query("visibility");
	let visibilityFilter: "VISIBLE" | "HIDDEN" | undefined;
	if (visibilityQuery !== undefined) {
		if (!["VISIBLE", "HIDDEN"].includes(visibilityQuery)) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}
		visibilityFilter = visibilityQuery as "VISIBLE" | "HIDDEN";
	}

	const providerQuery = c.req.query("provider");
	const creditCardIdQuery = c.req.query("creditCardId");
	if (creditCardIdQuery !== undefined && !isUuid(creditCardIdQuery)) {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const afterQuery = c.req.query("after");
	let afterCursor: CampaignPeriodCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeCampaignPeriodCursor(afterQuery, {
				userId: auth.userId,
			});
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedCampaignPeriods({
			db,
			userId: auth.userId,
			status: statusFilter,
			visibility: visibilityFilter,
			provider: providerQuery,
			creditCardId: creditCardIdQuery,
			limit: limitRes.limit,
			afterCursor,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeCampaignPeriodCursor(result.nextCursor, {
						userId: auth.userId,
					})
				: null;

		return c.json(
			{
				campaigns: result.campaigns,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 3. POST /campaigns
 * Direct manual campaign creation.
 */
campaignsRouter.post(
	"/",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"provider",
				"familyKey",
				"periodKey",
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
				"sourceSnapshotId",
				"parserType",
				"parserVersion",
				"parserConfidence",
				"note",
				"cardIds",
				"occurredAt",
			])
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.provider !== "string" ||
			typeof body.familyKey !== "string" ||
			typeof body.periodKey !== "string" ||
			typeof body.title !== "string" ||
			typeof body.startsOn !== "string" ||
			typeof body.endsOn !== "string" ||
			typeof body.ruleMode !== "string" ||
			typeof body.rewardKind !== "string" ||
			typeof body.merchantScopeMode !== "string" ||
			!Array.isArray(body.cardIds)
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const created = await createCampaignPeriod({
				db,
				userId: auth.userId,
				provider: body.provider,
				familyKey: body.familyKey,
				periodKey: body.periodKey,
				title: body.title,
				startsOn: body.startsOn,
				endsOn: body.endsOn,
				ruleMode: body.ruleMode as
					| "TOTAL_SPEND"
					| "TRANSACTION_COUNT"
					| "REPEATABLE_SPEND",
				targetSpendAmount:
					body.targetSpendAmount !== undefined &&
					body.targetSpendAmount !== null
						? String(body.targetSpendAmount)
						: undefined,
				requiredTransactionCount:
					body.requiredTransactionCount !== undefined &&
					body.requiredTransactionCount !== null
						? Number(body.requiredTransactionCount)
						: undefined,
				minimumTransactionAmount:
					body.minimumTransactionAmount !== undefined &&
					body.minimumTransactionAmount !== null
						? String(body.minimumTransactionAmount)
						: undefined,
				stepSpendAmount:
					body.stepSpendAmount !== undefined && body.stepSpendAmount !== null
						? String(body.stepSpendAmount)
						: undefined,
				rewardPointsPerStep:
					body.rewardPointsPerStep !== undefined &&
					body.rewardPointsPerStep !== null
						? String(body.rewardPointsPerStep)
						: undefined,
				maxSteps:
					body.maxSteps !== undefined && body.maxSteps !== null
						? Number(body.maxSteps)
						: undefined,
				rewardKind: body.rewardKind as
					| "REWARD_POINTS"
					| "STATEMENT_CREDIT"
					| "INFORMATIONAL",
				rewardAccountId:
					body.rewardAccountId !== undefined && body.rewardAccountId !== null
						? String(body.rewardAccountId)
						: undefined,
				expectedRewardPoints:
					body.expectedRewardPoints !== undefined &&
					body.expectedRewardPoints !== null
						? String(body.expectedRewardPoints)
						: undefined,
				merchantScopeMode: body.merchantScopeMode as
					| "ALL_MERCHANTS"
					| "MERCHANT_ALIASES"
					| "MANUAL_REVIEW_REQUIRED",
				requiredCanonicalMerchantNames:
					body.requiredCanonicalMerchantNames !== undefined &&
					body.requiredCanonicalMerchantNames !== null
						? (body.requiredCanonicalMerchantNames as string[])
						: undefined,
				allowedMccCodes:
					body.allowedMccCodes !== undefined && body.allowedMccCodes !== null
						? (body.allowedMccCodes as string[])
						: undefined,
				rewardExpiryDate:
					body.rewardExpiryDate !== undefined && body.rewardExpiryDate !== null
						? String(body.rewardExpiryDate)
						: undefined,
				sourceSnapshotId:
					body.sourceSnapshotId !== undefined && body.sourceSnapshotId !== null
						? String(body.sourceSnapshotId)
						: undefined,
				parserType:
					body.parserType !== undefined && body.parserType !== null
						? String(body.parserType)
						: undefined,
				parserVersion:
					body.parserVersion !== undefined && body.parserVersion !== null
						? String(body.parserVersion)
						: undefined,
				parserConfidence:
					body.parserConfidence !== undefined && body.parserConfidence !== null
						? Number(body.parserConfidence)
						: undefined,
				note:
					body.note !== undefined && body.note !== null
						? String(body.note)
						: undefined,
				cardIds: body.cardIds.map(String),
				occurredAt,
				idempotencyKey,
			});

			return c.json({ campaign: toCampaignPeriodProductDto(created) }, 201);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);

/**
 * 2. GET /campaigns/:id
 * Retrieve a single campaign period by ID.
 */
campaignsRouter.get("/:id", async (c) => {
	const campaignPeriodId = c.req.param("id");
	if (!isUuid(campaignPeriodId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const period = await getCampaignPeriod({
			db,
			userId: auth.userId,
			campaignPeriodId,
		});
		if (!period) return fail(c, "CAMPAIGN_NOT_FOUND", 404);

		return c.json({ campaign: toCampaignPeriodProductDto(period) }, 200);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

// ---------------------------------------------------------------------------
// Lifecycle Operations (CONFIRM, AMEND, HIDE, RESTORE, END, CANCEL)
// ---------------------------------------------------------------------------

function makeLifecycleHandler(
	runner: (params: {
		db: ReturnType<typeof createDatabase>;
		userId: string;
		campaignPeriodId: string;
		expectedRevisionNo: number;
		note?: string | null | undefined;
		occurredAt: Date;
		idempotencyKey: string;
	}) => Promise<import("../campaigns/service").CampaignPeriodRevisionReadModel>,
) {
	return async (c: Context<CampaignsEnv>) => {
		const campaignPeriodId = c.req.param("id");
		if (!isUuid(campaignPeriodId))
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["expectedRevisionNo", "note", "occurredAt"])) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo < 1
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			body.note !== undefined &&
			body.note !== null &&
			typeof body.note !== "string"
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const updated = await runner({
				db,
				userId: auth.userId,
				campaignPeriodId,
				expectedRevisionNo: body.expectedRevisionNo,
				note: body.note as string | null | undefined,
				occurredAt,
				idempotencyKey,
			});

			return c.json({ campaign: toCampaignPeriodProductDto(updated) }, 200);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	};
}

/**
 * 4. POST /campaigns/:id/confirm
 */
campaignsRouter.post(
	"/:id/confirm",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeLifecycleHandler((p) => confirmCampaignPeriod(p)),
);

/**
 * 5. POST /campaigns/:id/amend
 * Complete replacement snapshot with OCC.
 */
campaignsRouter.post(
	"/:id/amend",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const campaignPeriodId = c.req.param("id");
		if (!isUuid(campaignPeriodId))
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"expectedRevisionNo",
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
				"sourceSnapshotId",
				"parserType",
				"parserVersion",
				"parserConfidence",
				"note",
				"cardIds",
				"occurredAt",
			])
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo < 1 ||
			typeof body.title !== "string" ||
			typeof body.startsOn !== "string" ||
			typeof body.endsOn !== "string" ||
			typeof body.ruleMode !== "string" ||
			typeof body.rewardKind !== "string" ||
			typeof body.merchantScopeMode !== "string" ||
			!Array.isArray(body.cardIds)
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const amended = await amendCampaignPeriod({
				db,
				userId: auth.userId,
				campaignPeriodId,
				expectedRevisionNo: body.expectedRevisionNo,
				title: body.title,
				startsOn: body.startsOn,
				endsOn: body.endsOn,
				ruleMode: body.ruleMode as
					| "TOTAL_SPEND"
					| "TRANSACTION_COUNT"
					| "REPEATABLE_SPEND",
				targetSpendAmount:
					body.targetSpendAmount !== undefined &&
					body.targetSpendAmount !== null
						? String(body.targetSpendAmount)
						: undefined,
				requiredTransactionCount:
					body.requiredTransactionCount !== undefined &&
					body.requiredTransactionCount !== null
						? Number(body.requiredTransactionCount)
						: undefined,
				minimumTransactionAmount:
					body.minimumTransactionAmount !== undefined &&
					body.minimumTransactionAmount !== null
						? String(body.minimumTransactionAmount)
						: undefined,
				stepSpendAmount:
					body.stepSpendAmount !== undefined && body.stepSpendAmount !== null
						? String(body.stepSpendAmount)
						: undefined,
				rewardPointsPerStep:
					body.rewardPointsPerStep !== undefined &&
					body.rewardPointsPerStep !== null
						? String(body.rewardPointsPerStep)
						: undefined,
				maxSteps:
					body.maxSteps !== undefined && body.maxSteps !== null
						? Number(body.maxSteps)
						: undefined,
				rewardKind: body.rewardKind as
					| "REWARD_POINTS"
					| "STATEMENT_CREDIT"
					| "INFORMATIONAL",
				rewardAccountId:
					body.rewardAccountId !== undefined && body.rewardAccountId !== null
						? String(body.rewardAccountId)
						: undefined,
				expectedRewardPoints:
					body.expectedRewardPoints !== undefined &&
					body.expectedRewardPoints !== null
						? String(body.expectedRewardPoints)
						: undefined,
				merchantScopeMode: body.merchantScopeMode as
					| "ALL_MERCHANTS"
					| "MERCHANT_ALIASES"
					| "MANUAL_REVIEW_REQUIRED",
				requiredCanonicalMerchantNames:
					body.requiredCanonicalMerchantNames !== undefined &&
					body.requiredCanonicalMerchantNames !== null
						? (body.requiredCanonicalMerchantNames as string[])
						: undefined,
				allowedMccCodes:
					body.allowedMccCodes !== undefined && body.allowedMccCodes !== null
						? (body.allowedMccCodes as string[])
						: undefined,
				rewardExpiryDate:
					body.rewardExpiryDate !== undefined && body.rewardExpiryDate !== null
						? String(body.rewardExpiryDate)
						: undefined,
				sourceSnapshotId:
					body.sourceSnapshotId !== undefined && body.sourceSnapshotId !== null
						? String(body.sourceSnapshotId)
						: undefined,
				parserType:
					body.parserType !== undefined && body.parserType !== null
						? String(body.parserType)
						: undefined,
				parserVersion:
					body.parserVersion !== undefined && body.parserVersion !== null
						? String(body.parserVersion)
						: undefined,
				parserConfidence:
					body.parserConfidence !== undefined && body.parserConfidence !== null
						? Number(body.parserConfidence)
						: undefined,
				note:
					body.note !== undefined && body.note !== null
						? String(body.note)
						: undefined,
				cardIds: body.cardIds.map(String),
				occurredAt,
				idempotencyKey,
			});

			return c.json({ campaign: toCampaignPeriodProductDto(amended) }, 200);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);

/**
 * 6. POST /campaigns/:id/hide
 */
campaignsRouter.post(
	"/:id/hide",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeLifecycleHandler((p) => hideCampaignPeriod(p)),
);

/**
 * 7. POST /campaigns/:id/restore
 */
campaignsRouter.post(
	"/:id/restore",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeLifecycleHandler((p) => restoreCampaignPeriod(p)),
);

/**
 * 8. POST /campaigns/:id/end
 */
campaignsRouter.post(
	"/:id/end",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeLifecycleHandler((p) => endCampaignPeriod(p)),
);

/**
 * 9. POST /campaigns/:id/cancel
 */
campaignsRouter.post(
	"/:id/cancel",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeLifecycleHandler((p) => cancelCampaignPeriod(p)),
);

// ---------------------------------------------------------------------------
// PROGRESS & PURCHASE REVIEW
// ---------------------------------------------------------------------------

/**
 * 10. GET /campaigns/:id/progress
 * Aggregate progress only (no unbounded purchase arrays).
 */
campaignsRouter.get("/:id/progress", async (c) => {
	const campaignPeriodId = c.req.param("id");
	if (!isUuid(campaignPeriodId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const progress = await runCampaignsReadTransaction(db, async (tx) => {
			return getCampaignProgressInTransaction(
				tx,
				auth.userId,
				campaignPeriodId,
			);
		});

		return c.json({ progress: toCampaignProgressProductDto(progress) }, 200);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 11. GET /campaigns/:id/progress/purchases
 * Bounded detail over authoritative progress purchases with latest override state.
 */
campaignsRouter.get("/:id/progress/purchases", async (c) => {
	const campaignPeriodId = c.req.param("id");
	if (!isUuid(campaignPeriodId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	if (!validateStrictQueryParams(c, ["bucket", "limit", "after"])) {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const bucketQuery = c.req.query("bucket");
	if (bucketQuery !== "QUALIFYING" && bucketQuery !== "NEEDS_REVIEW") {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const afterQuery = c.req.query("after");
	let afterCursor: CampaignProgressPurchaseCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeCampaignProgressPurchaseCursor(afterQuery, {
				userId: auth.userId,
			});
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedCampaignProgressPurchases({
			db,
			userId: auth.userId,
			campaignPeriodId,
			bucket: bucketQuery,
			limit: limitRes.limit,
			afterCursor,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeCampaignProgressPurchaseCursor(result.nextCursor, {
						userId: auth.userId,
					})
				: null;

		return c.json(
			{
				purchases: result.purchases,
				bucket: bucketQuery,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 12. GET /campaigns/:id/overrides
 * Bounded latest manual override view.
 */
campaignsRouter.get("/:id/overrides", async (c) => {
	const campaignPeriodId = c.req.param("id");
	if (!isUuid(campaignPeriodId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	if (!validateStrictQueryParams(c, ["limit", "after"])) {
		return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const afterQuery = c.req.query("after");
	let afterCursor: { id: string } | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeCampaignOverrideCursor(afterQuery, {
				userId: auth.userId,
				campaignPeriodId,
			});
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedCampaignOverrides({
			db,
			userId: auth.userId,
			campaignPeriodId,
			limit: limitRes.limit,
			afterCursor,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeCampaignOverrideCursor(result.nextCursor, {
						userId: auth.userId,
						campaignPeriodId,
					})
				: null;

		return c.json(
			{
				overrides: result.overrides,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 13. POST /campaigns/:id/purchases/:purchaseEventId/override
 * Manual purchase override (INCLUDE, EXCLUDE, CLEAR).
 */
campaignsRouter.post(
	"/:id/purchases/:purchaseEventId/override",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const campaignPeriodId = c.req.param("id");
		const purchaseEventId = c.req.param("purchaseEventId");
		if (!isUuid(campaignPeriodId) || !isUuid(purchaseEventId)) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"expectedRevisionNo",
				"operation",
				"reasonNote",
				"occurredAt",
			])
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo < 0 ||
			typeof body.operation !== "string" ||
			!["INCLUDE", "EXCLUDE", "CLEAR"].includes(body.operation)
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			body.reasonNote !== undefined &&
			body.reasonNote !== null &&
			typeof body.reasonNote !== "string"
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const recorded = await recordCampaignPurchaseOverride({
				db,
				userId: auth.userId,
				campaignPeriodId,
				purchaseEventId,
				expectedRevisionNo: body.expectedRevisionNo,
				operation: body.operation as "INCLUDE" | "EXCLUDE" | "CLEAR",
				reasonNote: body.reasonNote as string | null | undefined,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					override: {
						purchaseEventId: recorded.purchaseEventId,
						revisionNo: recorded.revisionNo,
						operation: recorded.operation,
						reasonNote: recorded.reasonNote,
						occurredAt:
							recorded.occurredAt instanceof Date
								? recorded.occurredAt.toISOString()
								: String(recorded.occurredAt),
					},
				},
				200,
			);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);

// ---------------------------------------------------------------------------
// REWARD CREDIT SURFACE
// ---------------------------------------------------------------------------

/**
 * 14. GET /campaigns/:id/reward-credit
 * Retrieve the currently active reward credit for a campaign period, or null.
 */
campaignsRouter.get("/:id/reward-credit", async (c) => {
	const campaignPeriodId = c.req.param("id");
	if (!isUuid(campaignPeriodId)) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const credit = await getActiveCampaignRewardCredit({
			db,
			userId: auth.userId,
			campaignPeriodId,
		});

		return c.json({ credit }, 200);
	} catch (err) {
		return mapCampaignsDomainError(c, err);
	}
});

/**
 * 15. POST /campaigns/:id/reward-credit/confirm
 * Authoritatively confirm campaign reward credit.
 */
campaignsRouter.post(
	"/:id/reward-credit/confirm",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const campaignPeriodId = c.req.param("id");
		if (!isUuid(campaignPeriodId))
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["actualPointAmount", "reasonNote", "occurredAt"])) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.actualPointAmount !== "string" ||
			(body.reasonNote !== undefined &&
				body.reasonNote !== null &&
				typeof body.reasonNote !== "string")
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await confirmCampaignRewardCredited({
				db,
				userId: auth.userId,
				campaignPeriodId,
				actualPointAmount: body.actualPointAmount,
				reasonNote: body.reasonNote as string | null | undefined,
				occurredAt,
				idempotencyKey,
			});

			return c.json({ credit: toCampaignRewardCreditProductDto(result) }, 200);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);

/**
 * 16. POST /campaigns/:id/reward-credit/void
 * Atomically void active campaign reward credit and linked reward event.
 */
campaignsRouter.post(
	"/:id/reward-credit/void",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const campaignPeriodId = c.req.param("id");
		if (!isUuid(campaignPeriodId))
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["expectedRevisionNo", "reasonNote", "occurredAt"])
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo < 1
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		if (
			body.reasonNote !== undefined &&
			body.reasonNote !== null &&
			typeof body.reasonNote !== "string"
		) {
			return fail(c, "CAMPAIGN_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "CAMPAIGN_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await voidCampaignRewardCredit({
				db,
				userId: auth.userId,
				campaignPeriodId,
				expectedRevisionNo: body.expectedRevisionNo,
				reasonNote: body.reasonNote as string | null | undefined,
				occurredAt,
				idempotencyKey,
			});

			return c.json({ credit: toCampaignRewardCreditProductDto(result) }, 200);
		} catch (err) {
			return mapCampaignsDomainError(c, err);
		}
	},
);
