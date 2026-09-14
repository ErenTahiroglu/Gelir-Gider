import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../config/env";
import { getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { LongTermError } from "../long-term/errors";
import { encodeLongTermTaskCursor } from "../long-term/pagination";
import {
	listBoundedLongTermTasks,
	toLongTermTaskProductDto,
} from "../long-term/product-read";
import {
	allocateLongTermInvestment,
	cancelLongTermInvestmentTask,
	getLongTermInvestmentTask,
	type LongTermTaskStatus,
	markLongTermInvestmentSent,
	reopenLongTermInvestmentSend,
} from "../long-term/service";
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

type LongTermEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const longTermRouter = new Hono<LongTermEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<LongTermEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapLongTermDomainError(c: Context<LongTermEnv>, err: unknown) {
	if (err instanceof LongTermError) {
		switch (err.code) {
			case "LONG_TERM_INVALID_INPUT":
				return fail(c, err.code, 400);
			case "LONG_TERM_TASK_NOT_FOUND":
				return fail(c, err.code, 404);
			case "LONG_TERM_TASK_NOT_PENDING":
			case "LONG_TERM_TASK_NOT_SENT":
			case "LONG_TERM_TASK_CANCELLED":
			case "LONG_TERM_REVISION_CONFLICT":
			case "LONG_TERM_IDEMPOTENCY_CONFLICT":
			case "LONG_TERM_INSUFFICIENT_UNALLOCATED":
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

longTermRouter.use("*", requireAuthenticatedSession);
longTermRouter.use("*", sameOriginMutationGuard());

// ===========================================================================
// STATIC SUBTREES FIRST
// ===========================================================================

/**
 * 16. GET /long-term/tasks
 * Bounded keyset listing of long-term investment tasks.
 */
longTermRouter.get("/tasks", async (c) => {
	if (
		!validateStrictQueryParams(c, [
			"status",
			"midasAccountId",
			"limit",
			"after",
		])
	) {
		return fail(c, "LONG_TERM_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

	const midasAccountIdQuery = c.req.query("midasAccountId");
	if (midasAccountIdQuery !== undefined && !isUuid(midasAccountIdQuery)) {
		return fail(c, "LONG_TERM_INVALID_INPUT", 400);
	}

	const statusQuery = c.req.query("status");
	let statusFilter: LongTermTaskStatus | undefined;
	if (statusQuery !== undefined) {
		if (!["PENDING", "SENT", "CANCELLED"].includes(statusQuery)) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery as LongTermTaskStatus;
	}

	const afterQuery = c.req.query("after");

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedLongTermTasks({
			db,
			userId: auth.userId,
			status: statusFilter,
			midasAccountId: midasAccountIdQuery,
			limit: limitRes.limit,
			rawCursor: afterQuery,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeLongTermTaskCursor(result.nextCursor)
				: null;

		return c.json(
			{
				tasks: result.tasks,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapLongTermDomainError(c, err);
	}
});

/**
 * 17. POST /long-term/tasks
 * Allocate investment into PENDING_LONG_TERM (virtual allocation only).
 */
longTermRouter.post(
	"/tasks",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"midasAccountId",
				"amount",
				"destinationLabel",
				"note",
				"occurredAt",
			])
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		if (
			typeof body.midasAccountId !== "string" ||
			!isUuid(body.midasAccountId) ||
			typeof body.amount !== "string" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const destinationLabel =
			body.destinationLabel !== undefined
				? body.destinationLabel === null
					? null
					: typeof body.destinationLabel === "string"
						? body.destinationLabel
						: undefined
				: undefined;
		if (destinationLabel === undefined && body.destinationLabel !== undefined) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
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
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await allocateLongTermInvestment({
				db,
				userId: auth.userId,
				midasAccountId: body.midasAccountId,
				amount: body.amount,
				destinationLabel,
				note,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					task: toLongTermTaskProductDto(result.task),
					idempotentReplay: result.idempotentReplay,
				},
				result.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapLongTermDomainError(c, err);
		}
	},
);

// ===========================================================================
// PARAMETRIC ROUTES (/:id)
// ===========================================================================

/**
 * 15. GET /long-term/tasks/:id
 * Fetch long-term investment task detail by ID.
 */
longTermRouter.get("/tasks/:id", async (c) => {
	const taskId = c.req.param("id");
	if (!isUuid(taskId)) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const task = await getLongTermInvestmentTask({
			db,
			userId: auth.userId,
			taskId,
		});

		if (!task) {
			return fail(c, "LONG_TERM_TASK_NOT_FOUND", 404);
		}

		return c.json({ task: toLongTermTaskProductDto(task) }, 200);
	} catch (err) {
		return mapLongTermDomainError(c, err);
	}
});

/**
 * 18. POST /long-term/tasks/:id/mark-sent
 * Transition pending task to SENT and post canonical send transaction.
 */
longTermRouter.post(
	"/tasks/:id/mark-sent",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const taskId = c.req.param("id");
		if (!isUuid(taskId)) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["expectedRevisionNo", "occurredAt"])) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await markLongTermInvestmentSent({
				db,
				userId: auth.userId,
				taskId,
				expectedRevisionNo: body.expectedRevisionNo,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					task: toLongTermTaskProductDto(result.task),
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapLongTermDomainError(c, err);
		}
	},
);

/**
 * 19. POST /long-term/tasks/:id/reopen
 * Reopen sent task to PENDING and void canonical send transaction.
 */
longTermRouter.post(
	"/tasks/:id/reopen",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const taskId = c.req.param("id");
		if (!isUuid(taskId)) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["expectedRevisionNo", "reasonNote", "occurredAt"])
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const reasonNote =
			body.reasonNote !== undefined
				? body.reasonNote === null
					? null
					: typeof body.reasonNote === "string"
						? body.reasonNote
						: undefined
				: undefined;
		if (reasonNote === undefined && body.reasonNote !== undefined) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await reopenLongTermInvestmentSend({
				db,
				userId: auth.userId,
				taskId,
				expectedRevisionNo: body.expectedRevisionNo,
				reasonNote,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					task: toLongTermTaskProductDto(result.task),
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapLongTermDomainError(c, err);
		}
	},
);

/**
 * 20. POST /long-term/tasks/:id/cancel
 * Cancel pending task and release virtual allocation back to unallocated.
 */
longTermRouter.post(
	"/tasks/:id/cancel",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const taskId = c.req.param("id");
		if (!isUuid(taskId)) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, ["expectedRevisionNo", "reasonNote", "occurredAt"])
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		if (
			typeof body.expectedRevisionNo !== "number" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const reasonNote =
			body.reasonNote !== undefined
				? body.reasonNote === null
					? null
					: typeof body.reasonNote === "string"
						? body.reasonNote
						: undefined
				: undefined;
		if (reasonNote === undefined && body.reasonNote !== undefined) {
			return fail(c, "LONG_TERM_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await cancelLongTermInvestmentTask({
				db,
				userId: auth.userId,
				taskId,
				expectedRevisionNo: body.expectedRevisionNo,
				reasonNote,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					task: toLongTermTaskProductDto(result.task),
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapLongTermDomainError(c, err);
		}
	},
);
