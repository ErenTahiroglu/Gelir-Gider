import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import {
	REWARD_ACCOUNT_STATUSES,
	REWARD_EVENT_TYPES,
	REWARD_PURCHASE_CATEGORIES,
	type RewardAccountStatus,
	type RewardEventType,
	type RewardPurchaseCategory,
} from "../db/schema/rewards";
import {
	archiveRewardAccount,
	createRewardAccount,
	getRewardAccount,
	updateRewardAccount,
} from "../rewards/accounts";
import { RewardError } from "../rewards/errors";
import {
	getRewardEvent,
	recordRewardAdjustmentCredit,
	recordRewardAdjustmentDebit,
	recordRewardEarn,
	recordRewardExpiry,
	recordRewardOpeningBalance,
	recordRewardPurchase,
	voidManualRewardEvent,
} from "../rewards/events";
import {
	decodeRewardAccountCursor,
	decodeRewardEventCursor,
	encodeRewardAccountCursor,
	encodeRewardEventCursor,
	type RewardAccountCursor,
	type RewardEventCursor,
} from "../rewards/pagination";
import {
	listBoundedRewardAccounts,
	listBoundedRewardEvents,
	toRewardAccountProductDto,
	toRewardEventProductDto,
} from "../rewards/product-read";
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

type RewardsEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const rewardsRouter = new Hono<RewardsEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<RewardsEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapRewardsDomainError(c: Context<RewardsEnv>, err: unknown) {
	if (err instanceof RewardError) {
		switch (err.code) {
			case "REWARD_INVALID_INPUT":
				return fail(c, err.code, 400);
			case "REWARD_ACCOUNT_NOT_FOUND":
			case "REWARD_EVENT_NOT_FOUND":
				return fail(c, err.code, 404);
			case "REWARD_ACCOUNT_NOT_ACTIVE":
			case "REWARD_ACCOUNT_CONFLICT":
			case "REWARD_ACCOUNT_REVISION_CONFLICT":
			case "REWARD_EVENT_NOT_ACTIVE":
			case "REWARD_EVENT_CONFLICT":
			case "REWARD_EVENT_REVISION_CONFLICT":
			case "REWARD_IDEMPOTENCY_CONFLICT":
			case "REWARD_INSUFFICIENT_POINTS":
			case "REWARD_EVENT_EXTERNALLY_MANAGED":
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

rewardsRouter.use("*", requireAuthenticatedSession);
rewardsRouter.use("*", sameOriginMutationGuard());

// ---------------------------------------------------------------------------
// 1. Reward Accounts Surface
// ---------------------------------------------------------------------------

/**
 * GET /rewards/accounts
 * Keyset-paginated list of user's reward accounts.
 */
rewardsRouter.get("/accounts", async (c) => {
	if (!validateStrictQueryParams(c, ["status", "limit", "after"])) {
		return fail(c, "REWARD_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);

	const statusQuery = c.req.query("status");
	let statusFilter: RewardAccountStatus | undefined;
	if (statusQuery !== undefined) {
		if (!REWARD_ACCOUNT_STATUSES.includes(statusQuery as RewardAccountStatus)) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery as RewardAccountStatus;
	}

	const auth = c.get("auth");
	const afterQuery = c.req.query("after");
	let afterCursor: RewardAccountCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeRewardAccountCursor(afterQuery, {
				userId: auth.userId,
			});
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedRewardAccounts({
			db,
			userId: auth.userId,
			status: statusFilter,
			limit: limitRes.limit,
			afterCursor,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeRewardAccountCursor(result.nextCursor, {
						userId: auth.userId,
					})
				: null;

		return c.json(
			{
				accounts: result.accounts,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapRewardsDomainError(c, err);
	}
});

/**
 * GET /rewards/accounts/:id
 * Retrieve a single reward account by ID.
 */
rewardsRouter.get("/accounts/:id", async (c) => {
	const rewardAccountId = c.req.param("id");
	if (!isUuid(rewardAccountId)) return fail(c, "REWARD_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const account = await getRewardAccount({
			db,
			userId: auth.userId,
			rewardAccountId,
		});
		if (!account) return fail(c, "REWARD_ACCOUNT_NOT_FOUND", 404);

		return c.json({ account: toRewardAccountProductDto(account) }, 200);
	} catch (err) {
		return mapRewardsDomainError(c, err);
	}
});

/**
 * POST /rewards/accounts
 * Create a new reward account anchor and revision #1.
 */
rewardsRouter.post(
	"/accounts",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"code",
				"displayName",
				"provider",
				"unitName",
				"creditCardId",
				"defaultConversionRate",
				"note",
				"occurredAt",
			])
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			typeof body.code !== "string" ||
			typeof body.displayName !== "string" ||
			typeof body.provider !== "string" ||
			typeof body.unitName !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.creditCardId !== undefined &&
			body.creditCardId !== null &&
			(typeof body.creditCardId !== "string" || !isUuid(body.creditCardId))
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.defaultConversionRate !== undefined &&
			typeof body.defaultConversionRate !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.note !== undefined &&
			body.note !== null &&
			typeof body.note !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "REWARD_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const res = await createRewardAccount({
				db,
				userId: auth.userId,
				code: body.code,
				displayName: body.displayName,
				provider: body.provider,
				unitName: body.unitName,
				creditCardId: body.creditCardId,
				defaultConversionRate: body.defaultConversionRate,
				note: body.note,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					account: toRewardAccountProductDto(res.account),
					idempotentReplay: res.idempotentReplay,
				},
				res.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	},
);

/**
 * POST /rewards/accounts/:id
 * Update mutable configuration of a reward account with OCC.
 */
rewardsRouter.post(
	"/accounts/:id",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const rewardAccountId = c.req.param("id");
		if (!isUuid(rewardAccountId)) return fail(c, "REWARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"expectedRevisionNo",
				"displayName",
				"provider",
				"unitName",
				"defaultConversionRate",
				"note",
				"occurredAt",
			])
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo <= 0
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			typeof body.displayName !== "string" ||
			typeof body.provider !== "string" ||
			typeof body.unitName !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.defaultConversionRate !== undefined &&
			typeof body.defaultConversionRate !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.note !== undefined &&
			body.note !== null &&
			typeof body.note !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "REWARD_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const res = await updateRewardAccount({
				db,
				userId: auth.userId,
				rewardAccountId,
				expectedRevisionNo: body.expectedRevisionNo,
				displayName: body.displayName,
				provider: body.provider,
				unitName: body.unitName,
				defaultConversionRate: body.defaultConversionRate,
				note: body.note,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					account: toRewardAccountProductDto(res.account),
					idempotentReplay: res.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	},
);

/**
 * POST /rewards/accounts/:id/archive
 * Archive a reward account with OCC (requires exact 0.0000 point balance).
 */
rewardsRouter.post(
	"/accounts/:id/archive",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const rewardAccountId = c.req.param("id");
		if (!isUuid(rewardAccountId)) return fail(c, "REWARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["expectedRevisionNo", "occurredAt"])) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo <= 0
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "REWARD_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const res = await archiveRewardAccount({
				db,
				userId: auth.userId,
				rewardAccountId,
				expectedRevisionNo: body.expectedRevisionNo,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					account: toRewardAccountProductDto(res.account),
					idempotentReplay: res.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	},
);

// ---------------------------------------------------------------------------
// 2. Reward Events Surface
// ---------------------------------------------------------------------------

/**
 * GET /rewards/accounts/:accountId/events
 * Keyset-paginated list of events for a reward account.
 */
rewardsRouter.get("/accounts/:accountId/events", async (c) => {
	const rewardAccountId = c.req.param("accountId");
	if (!isUuid(rewardAccountId)) return fail(c, "REWARD_INVALID_INPUT", 400);

	if (
		!validateStrictQueryParams(c, ["eventType", "status", "limit", "after"])
	) {
		return fail(c, "REWARD_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);

	const eventTypeQuery = c.req.query("eventType");
	let eventTypeFilter: RewardEventType | undefined;
	if (eventTypeQuery !== undefined) {
		if (!REWARD_EVENT_TYPES.includes(eventTypeQuery as RewardEventType)) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}
		eventTypeFilter = eventTypeQuery as RewardEventType;
	}

	const statusQuery = c.req.query("status");
	let statusFilter: "ACTIVE" | "VOID" | undefined;
	if (statusQuery !== undefined) {
		if (statusQuery !== "ACTIVE" && statusQuery !== "VOID") {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery;
	}

	const auth = c.get("auth");
	const afterQuery = c.req.query("after");
	let afterCursor: RewardEventCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeRewardEventCursor(afterQuery, {
				userId: auth.userId,
				rewardAccountId,
			});
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		// Verify account exists for user
		const account = await getRewardAccount({
			db,
			userId: auth.userId,
			rewardAccountId,
		});
		if (!account) return fail(c, "REWARD_ACCOUNT_NOT_FOUND", 404);

		const result = await listBoundedRewardEvents({
			db,
			userId: auth.userId,
			rewardAccountId,
			eventType: eventTypeFilter,
			status: statusFilter,
			limit: limitRes.limit,
			afterCursor,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeRewardEventCursor(result.nextCursor, {
						userId: auth.userId,
						rewardAccountId,
					})
				: null;

		return c.json(
			{
				events: result.events,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapRewardsDomainError(c, err);
	}
});

/**
 * GET /rewards/accounts/:accountId/events/:eventId
 * Retrieve a single reward event by ID with path consistency check.
 */
rewardsRouter.get("/accounts/:accountId/events/:eventId", async (c) => {
	const rewardAccountId = c.req.param("accountId");
	const rewardEventId = c.req.param("eventId");
	if (!isUuid(rewardAccountId) || !isUuid(rewardEventId)) {
		return fail(c, "REWARD_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const account = await getRewardAccount({
			db,
			userId: auth.userId,
			rewardAccountId,
		});
		if (!account) return fail(c, "REWARD_ACCOUNT_NOT_FOUND", 404);

		const event = await getRewardEvent({
			db,
			userId: auth.userId,
			rewardEventId,
		});
		if (!event || event.rewardAccountId !== rewardAccountId) {
			return fail(c, "REWARD_EVENT_NOT_FOUND", 404);
		}

		return c.json({ event: toRewardEventProductDto(event) }, 200);
	} catch (err) {
		return mapRewardsDomainError(c, err);
	}
});

// Helper for simple event creation handlers
function makeSimpleEventHandler(
	recordFn: (params: {
		db: ReturnType<typeof createDatabase>;
		userId: string;
		rewardAccountId: string;
		pointAmount: string;
		conversionRateOverride?: string | undefined;
		reasonNote?: string | null | undefined;
		occurredAt: Date;
		idempotencyKey: string;
	}) => Promise<{
		event: import("../rewards/events").RewardEventReadModel;
		idempotentReplay: boolean;
	}>,
) {
	return async (c: Context<RewardsEnv>) => {
		const rewardAccountId = c.req.param("accountId");
		if (!isUuid(rewardAccountId)) return fail(c, "REWARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"pointAmount",
				"conversionRateOverride",
				"reasonNote",
				"occurredAt",
			])
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (typeof body.pointAmount !== "string") {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.conversionRateOverride !== undefined &&
			typeof body.conversionRateOverride !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.reasonNote !== undefined &&
			body.reasonNote !== null &&
			typeof body.reasonNote !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "REWARD_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const res = await recordFn({
				db,
				userId: auth.userId,
				rewardAccountId,
				pointAmount: body.pointAmount,
				conversionRateOverride: body.conversionRateOverride,
				reasonNote: body.reasonNote,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					event: toRewardEventProductDto(res.event),
					idempotentReplay: res.idempotentReplay,
				},
				res.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	};
}

/**
 * POST /rewards/accounts/:accountId/events/opening-balance
 */
rewardsRouter.post(
	"/accounts/:accountId/events/opening-balance",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeSimpleEventHandler((params) => recordRewardOpeningBalance(params)),
);

/**
 * POST /rewards/accounts/:accountId/events/earn
 */
rewardsRouter.post(
	"/accounts/:accountId/events/earn",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeSimpleEventHandler((params) => recordRewardEarn(params)),
);

/**
 * POST /rewards/accounts/:accountId/events/expire
 */
rewardsRouter.post(
	"/accounts/:accountId/events/expire",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeSimpleEventHandler((params) => recordRewardExpiry(params)),
);

/**
 * POST /rewards/accounts/:accountId/events/adjustment-credit
 */
rewardsRouter.post(
	"/accounts/:accountId/events/adjustment-credit",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeSimpleEventHandler((params) => recordRewardAdjustmentCredit(params)),
);

/**
 * POST /rewards/accounts/:accountId/events/adjustment-debit
 */
rewardsRouter.post(
	"/accounts/:accountId/events/adjustment-debit",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	makeSimpleEventHandler((params) => recordRewardAdjustmentDebit(params)),
);

/**
 * POST /rewards/accounts/:accountId/purchases
 * Economic redemption: record reward-funded purchase.
 */
rewardsRouter.post(
	"/accounts/:accountId/purchases",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const rewardAccountId = c.req.param("accountId");
		if (!isUuid(rewardAccountId)) return fail(c, "REWARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"pointAmount",
				"conversionRateOverride",
				"purchaseCategory",
				"shortTermGoalId",
				"merchant",
				"description",
				"occurredAt",
			])
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			typeof body.pointAmount !== "string" ||
			typeof body.purchaseCategory !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			!REWARD_PURCHASE_CATEGORIES.includes(
				body.purchaseCategory as RewardPurchaseCategory,
			)
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.conversionRateOverride !== undefined &&
			typeof body.conversionRateOverride !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.purchaseCategory === "SHORT_TERM_PURCHASE" &&
			(!body.shortTermGoalId ||
				typeof body.shortTermGoalId !== "string" ||
				!isUuid(body.shortTermGoalId))
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.purchaseCategory !== "SHORT_TERM_PURCHASE" &&
			body.shortTermGoalId !== undefined &&
			body.shortTermGoalId !== null
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.merchant !== undefined &&
			body.merchant !== null &&
			typeof body.merchant !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.description !== undefined &&
			body.description !== null &&
			typeof body.description !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "REWARD_INVALID_INPUT", 400);

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const res = await recordRewardPurchase({
				db,
				userId: auth.userId,
				rewardAccountId,
				pointAmount: body.pointAmount,
				conversionRateOverride: body.conversionRateOverride as
					| string
					| undefined,
				purchaseCategory: body.purchaseCategory,
				shortTermGoalId:
					typeof body.shortTermGoalId === "string"
						? body.shortTermGoalId
						: null,
				merchant: typeof body.merchant === "string" ? body.merchant : null,
				description:
					typeof body.description === "string" ? body.description : null,
				occurredAt,
				idempotencyKey,
			});

			return c.json(
				{
					event: toRewardEventProductDto(res.event),
					idempotentReplay: res.idempotentReplay,
				},
				res.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	},
);

/**
 * POST /rewards/accounts/:accountId/events/:eventId/void
 * Void a manual reward event with OCC and external-ownership check.
 */
rewardsRouter.post(
	"/accounts/:accountId/events/:eventId/void",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const rewardAccountId = c.req.param("accountId");
		const rewardEventId = c.req.param("eventId");
		if (!isUuid(rewardAccountId) || !isUuid(rewardEventId)) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const idempotencyKey = keyRes.key;

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "REWARD_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["expectedRevisionNo", "reasonNote"])) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo <= 0
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		if (
			body.reasonNote !== undefined &&
			body.reasonNote !== null &&
			typeof body.reasonNote !== "string"
		) {
			return fail(c, "REWARD_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			// Path consistency check
			const event = await getRewardEvent({
				db,
				userId: auth.userId,
				rewardEventId,
			});
			if (!event || event.rewardAccountId !== rewardAccountId) {
				return fail(c, "REWARD_EVENT_NOT_FOUND", 404);
			}

			const res = await voidManualRewardEvent({
				db,
				userId: auth.userId,
				rewardEventId,
				expectedRevisionNo: body.expectedRevisionNo,
				reasonNote: body.reasonNote,
				idempotencyKey,
			});

			return c.json(
				{
					event: toRewardEventProductDto(res.event),
					idempotentReplay: res.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapRewardsDomainError(c, err);
		}
	},
);
