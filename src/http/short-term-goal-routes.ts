import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../config/env";
import { getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import type { ShortTermGoalStatus } from "../db/schema/short-term-goals";
import { MidasError } from "../midas/errors";
import { ShortTermGoalError } from "../short-term-goals/errors";
import { encodeShortTermGoalCursor } from "../short-term-goals/pagination";
import {
	listBoundedShortTermGoals,
	toShortTermGoalProductDto,
} from "../short-term-goals/product-read";
import {
	cancelShortTermGoal,
	completeShortTermGoal,
	createShortTermGoal,
	fundShortTermGoal,
	getShortTermGoal,
	releaseShortTermGoalFunding,
	reorderShortTermGoals,
	updateShortTermGoal,
} from "../short-term-goals/service";
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

type ShortTermGoalsEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const shortTermGoalsRouter = new Hono<ShortTermGoalsEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<ShortTermGoalsEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapShortTermGoalsDomainError(
	c: Context<ShortTermGoalsEnv>,
	err: unknown,
) {
	if (err instanceof ShortTermGoalError) {
		switch (err.code) {
			case "SHORT_TERM_GOAL_INVALID_INPUT":
				return fail(c, err.code, 400);
			case "SHORT_TERM_GOAL_NOT_FOUND":
			case "SHORT_TERM_GOAL_BUCKET_NOT_FOUND":
			case "SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND":
				return fail(c, err.code, 404);
			case "SHORT_TERM_GOAL_NOT_ACTIVE":
			case "SHORT_TERM_GOAL_NON_ZERO_BALANCE":
			case "SHORT_TERM_GOAL_BALANCE_NOT_ZERO":
			case "SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED":
			case "SHORT_TERM_GOAL_PRIORITY_COLLISION":
			case "SHORT_TERM_GOAL_PRIORITY_MISMATCH":
			case "SHORT_TERM_GOAL_PRIORITY_CONFLICT":
			case "SHORT_TERM_GOAL_REVISION_CONFLICT":
			case "SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE":
			case "SHORT_TERM_GOAL_INSUFFICIENT_BALANCE":
			case "SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT":
				return fail(c, err.code, 409);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	if (err instanceof MidasError) {
		switch (err.code) {
			case "MIDAS_INVALID_INPUT":
				return fail(c, err.code, 400);
			case "MIDAS_ACCOUNT_NOT_FOUND":
			case "MIDAS_BUCKET_NOT_FOUND":
			case "MIDAS_TRANSFER_NOT_FOUND":
				return fail(c, err.code, 404);
			case "MIDAS_ACCOUNT_CONFLICT":
			case "MIDAS_LEDGER_ACCOUNT_INVALID":
			case "MIDAS_BUCKET_CONFLICT":
			case "MIDAS_INSUFFICIENT_FREE_BALANCE":
			case "MIDAS_INSUFFICIENT_BUCKET_BALANCE":
			case "MIDAS_IDEMPOTENCY_CONFLICT":
			case "MIDAS_TRANSFER_ALREADY_REVERSED":
			case "MIDAS_BUCKET_INACTIVE":
			case "MIDAS_BUCKET_CAP_EXCEEDED":
			case "MIDAS_LONG_TERM_BUCKET_RESTRICTED":
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

shortTermGoalsRouter.use("*", requireAuthenticatedSession);
shortTermGoalsRouter.use("*", sameOriginMutationGuard());

// ===========================================================================
// STATIC SUBTREES FIRST (before `/:id` routes)
// ===========================================================================

/**
 * 7. POST /short-term-goals/reorder
 * Reorder active goals priority sequence.
 */
shortTermGoalsRouter.post(
	"/reorder",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["midasAccountId", "orderedGoalIds", "occurredAt"])
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.midasAccountId !== "string" ||
			!isUuid(body.midasAccountId) ||
			!Array.isArray(body.orderedGoalIds) ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		for (const id of body.orderedGoalIds) {
			if (typeof id !== "string" || !isUuid(id)) {
				return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
			}
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await reorderShortTermGoals({
				db,
				userId: auth.userId,
				midasAccountId: body.midasAccountId,
				orderedGoalIds: body.orderedGoalIds as string[],
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					reorder: result,
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);

/**
 * 2. GET /short-term-goals
 * Bounded keyset listing of short-term goals.
 */
shortTermGoalsRouter.get("/", async (c) => {
	if (
		!validateStrictQueryParams(c, [
			"midasAccountId",
			"status",
			"limit",
			"after",
		])
	) {
		return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

	const midasAccountIdQuery = c.req.query("midasAccountId");
	if (midasAccountIdQuery !== undefined && !isUuid(midasAccountIdQuery)) {
		return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
	}

	const statusQuery = c.req.query("status");
	let statusFilter: ShortTermGoalStatus | undefined;
	if (statusQuery !== undefined) {
		if (!["ACTIVE", "COMPLETED", "CANCELLED"].includes(statusQuery)) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery as ShortTermGoalStatus;
	}

	const afterQuery = c.req.query("after");

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedShortTermGoals({
			db,
			userId: auth.userId,
			midasAccountId: midasAccountIdQuery,
			status: statusFilter,
			limit: limitRes.limit,
			rawCursor: afterQuery,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeShortTermGoalCursor(result.nextCursor)
				: null;

		return c.json(
			{
				goals: result.goals,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapShortTermGoalsDomainError(c, err);
	}
});

/**
 * 3. POST /short-term-goals
 * Create a new short-term goal.
 */
shortTermGoalsRouter.post(
	"/",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"midasAccountId",
				"name",
				"fundingTarget",
				"targetDate",
				"maxBudget",
				"targetPrice",
				"productUrl",
				"note",
				"priorityPosition",
				"occurredAt",
			])
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.midasAccountId !== "string" ||
			!isUuid(body.midasAccountId) ||
			typeof body.name !== "string" ||
			typeof body.fundingTarget !== "string" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const targetDate =
			body.targetDate !== undefined
				? body.targetDate === null
					? null
					: typeof body.targetDate === "string"
						? body.targetDate
						: undefined
				: undefined;
		if (targetDate === undefined && body.targetDate !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const maxBudget =
			body.maxBudget !== undefined
				? body.maxBudget === null
					? null
					: typeof body.maxBudget === "string"
						? body.maxBudget
						: undefined
				: undefined;
		if (maxBudget === undefined && body.maxBudget !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const targetPrice =
			body.targetPrice !== undefined
				? body.targetPrice === null
					? null
					: typeof body.targetPrice === "string"
						? body.targetPrice
						: undefined
				: undefined;
		if (targetPrice === undefined && body.targetPrice !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const productUrl =
			body.productUrl !== undefined
				? body.productUrl === null
					? null
					: typeof body.productUrl === "string"
						? body.productUrl
						: undefined
				: undefined;
		if (productUrl === undefined && body.productUrl !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const note =
			body.note !== undefined
				? body.note === null
					? null
					: typeof body.note === "string"
						? body.note
						: undefined
				: undefined;
		if (note === undefined && body.note !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const priorityPosition =
			body.priorityPosition !== undefined
				? body.priorityPosition === null
					? null
					: typeof body.priorityPosition === "number"
						? body.priorityPosition
						: undefined
				: undefined;
		if (priorityPosition === undefined && body.priorityPosition !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const lifecycleResult = await createShortTermGoal({
				db,
				userId: auth.userId,
				midasAccountId: body.midasAccountId,
				name: body.name,
				fundingTarget: body.fundingTarget,
				targetDate: targetDate ?? null,
				maxBudget: maxBudget ?? null,
				targetPrice: targetPrice ?? null,
				productUrl: productUrl ?? null,
				note: note ?? null,
				priorityPosition: priorityPosition ?? null,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			const goalRecord = await getShortTermGoal({
				db,
				userId: auth.userId,
				goalId: lifecycleResult.goalId,
			});

			return c.json(
				{
					goal: toShortTermGoalProductDto(goalRecord),
					idempotentReplay: lifecycleResult.idempotentReplay,
				},
				lifecycleResult.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);

// ===========================================================================
// PARAMETRIC ROUTES (/:id)
// ===========================================================================

/**
 * 1. GET /short-term-goals/:id
 * Detail view of a short-term goal.
 */
shortTermGoalsRouter.get("/:id", async (c) => {
	const goalId = c.req.param("id");
	if (!isUuid(goalId)) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const record = await getShortTermGoal({
			db,
			userId: auth.userId,
			goalId,
		});

		return c.json({ goal: toShortTermGoalProductDto(record) }, 200);
	} catch (err) {
		return mapShortTermGoalsDomainError(c, err);
	}
});

/**
 * 4. POST /short-term-goals/:id
 * Update short-term goal metadata and funding target.
 */
shortTermGoalsRouter.post(
	"/:id",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const goalId = c.req.param("id");
		if (!isUuid(goalId)) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"expectedRevisionNo",
				"name",
				"fundingTarget",
				"targetDate",
				"maxBudget",
				"targetPrice",
				"productUrl",
				"note",
				"changeReason",
				"occurredAt",
			])
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const updateParams: {
				db: typeof db;
				userId: string;
				goalId: string;
				expectedRevisionNo: number;
				name?: string;
				fundingTarget?: string;
				targetDate?: string | null;
				maxBudget?: string | null;
				targetPrice?: string | null;
				productUrl?: string | null;
				note?: string | null;
				changeReason?: string | null;
				occurredAt: Date;
				idempotencyKey: string;
			} = {
				db,
				userId: auth.userId,
				goalId,
				expectedRevisionNo: body.expectedRevisionNo,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			};
			if (typeof body.name === "string") updateParams.name = body.name;
			if (typeof body.fundingTarget === "string")
				updateParams.fundingTarget = body.fundingTarget;
			if (body.targetDate !== undefined)
				updateParams.targetDate =
					body.targetDate === null ? null : String(body.targetDate);
			if (body.maxBudget !== undefined)
				updateParams.maxBudget =
					body.maxBudget === null ? null : String(body.maxBudget);
			if (body.targetPrice !== undefined)
				updateParams.targetPrice =
					body.targetPrice === null ? null : String(body.targetPrice);
			if (body.productUrl !== undefined)
				updateParams.productUrl =
					body.productUrl === null ? null : String(body.productUrl);
			if (body.note !== undefined)
				updateParams.note = body.note === null ? null : String(body.note);
			if (body.changeReason !== undefined)
				updateParams.changeReason =
					body.changeReason === null ? null : String(body.changeReason);

			const lifecycleResult = await updateShortTermGoal(updateParams);

			const goalRecord = await getShortTermGoal({
				db,
				userId: auth.userId,
				goalId,
			});

			return c.json(
				{
					goal: toShortTermGoalProductDto(goalRecord),
					idempotentReplay: lifecycleResult.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);

/**
 * 5. POST /short-term-goals/:id/complete
 * Mark active goal as COMPLETED (requires zero bucket balance).
 */
shortTermGoalsRouter.post(
	"/:id/complete",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const goalId = c.req.param("id");
		if (!isUuid(goalId)) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["expectedRevisionNo", "changeReason", "occurredAt"])
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const lifecycleResult = await completeShortTermGoal({
				db,
				userId: auth.userId,
				goalId,
				expectedRevisionNo: body.expectedRevisionNo,
				changeReason:
					body.changeReason !== undefined
						? body.changeReason === null
							? null
							: String(body.changeReason)
						: null,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			const goalRecord = await getShortTermGoal({
				db,
				userId: auth.userId,
				goalId,
			});

			return c.json(
				{
					goal: toShortTermGoalProductDto(goalRecord),
					idempotentReplay: lifecycleResult.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);

/**
 * 6. POST /short-term-goals/:id/cancel
 * Cancel active goal (requires zero bucket balance).
 */
shortTermGoalsRouter.post(
	"/:id/cancel",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const goalId = c.req.param("id");
		if (!isUuid(goalId)) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["expectedRevisionNo", "changeReason", "occurredAt"])
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const lifecycleResult = await cancelShortTermGoal({
				db,
				userId: auth.userId,
				goalId,
				expectedRevisionNo: body.expectedRevisionNo,
				changeReason:
					body.changeReason !== undefined
						? body.changeReason === null
							? null
							: String(body.changeReason)
						: null,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			const goalRecord = await getShortTermGoal({
				db,
				userId: auth.userId,
				goalId,
			});

			return c.json(
				{
					goal: toShortTermGoalProductDto(goalRecord),
					idempotentReplay: lifecycleResult.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);

/**
 * 8. POST /short-term-goals/:id/fund
 * Allocate funds into dedicated goal bucket.
 */
shortTermGoalsRouter.post(
	"/:id/fund",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const goalId = c.req.param("id");
		if (!isUuid(goalId)) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["amount", "fromBucketId", "memo", "occurredAt"])) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.amount !== "string" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const fromBucketId =
			body.fromBucketId !== undefined
				? body.fromBucketId === null
					? null
					: typeof body.fromBucketId === "string" && isUuid(body.fromBucketId)
						? body.fromBucketId
						: undefined
				: null;
		if (fromBucketId === undefined && body.fromBucketId !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const memo =
			body.memo !== undefined
				? body.memo === null
					? null
					: typeof body.memo === "string"
						? body.memo
						: undefined
				: null;
		if (memo === undefined && body.memo !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await fundShortTermGoal({
				db,
				userId: auth.userId,
				goalId,
				amount: body.amount,
				fromBucketId: fromBucketId ?? null,
				memo: memo ?? null,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					funding: result,
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);

/**
 * 9. POST /short-term-goals/:id/release
 * Release funds from goal bucket back to unallocated or destination bucket.
 */
shortTermGoalsRouter.post(
	"/:id/release",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const goalId = c.req.param("id");
		if (!isUuid(goalId)) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["amount", "toBucketId", "memo", "occurredAt"])) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		if (
			typeof body.amount !== "string" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const toBucketId =
			body.toBucketId !== undefined
				? body.toBucketId === null
					? null
					: typeof body.toBucketId === "string" && isUuid(body.toBucketId)
						? body.toBucketId
						: undefined
				: null;
		if (toBucketId === undefined && body.toBucketId !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const memo =
			body.memo !== undefined
				? body.memo === null
					? null
					: typeof body.memo === "string"
						? body.memo
						: undefined
				: null;
		if (memo === undefined && body.memo !== undefined) {
			return fail(c, "SHORT_TERM_GOAL_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await releaseShortTermGoalFunding({
				db,
				userId: auth.userId,
				goalId,
				amount: body.amount,
				toBucketId: toBucketId ?? null,
				memo: memo ?? null,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					release: result,
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapShortTermGoalsDomainError(c, err);
		}
	},
);
