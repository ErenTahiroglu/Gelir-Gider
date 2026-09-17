import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../config/env";
import { getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { unwrapDomainError } from "../month-close/boundary";
import { validateMonthClosePeriodMonth } from "../month-close/calendar";
import { MonthCloseError } from "../month-close/errors";
import {
	listBoundedMonthCloses,
	toMonthCloseProductDto,
} from "../month-close/product-read";
import {
	closeMonth,
	getMonthClose,
	previewMonthClose,
} from "../month-close/service";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
} from "./transport";

type MonthCloseEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const monthCloseRouter = new Hono<MonthCloseEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<MonthCloseEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapMonthCloseDomainError(c: Context<MonthCloseEnv>, err: unknown) {
	const unwrapped = unwrapDomainError(err);
	if (unwrapped instanceof MonthCloseError) {
		switch (unwrapped.code) {
			case "MONTH_CLOSE_INVALID_INPUT":
				return fail(c, unwrapped.code, 400);
			case "MONTH_CLOSE_PERIOD_NOT_ENDED":
			case "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND":
			case "MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE":
			case "MONTH_CLOSE_UNCLASSIFIED_EXPENSES":
			case "MONTH_CLOSE_MIDAS_NOT_FOUND":
			case "MONTH_CLOSE_INSUFFICIENT_LIQUIDITY":
			case "MONTH_CLOSE_STALE_PROPOSAL":
			case "MONTH_CLOSE_ALREADY_CLOSED":
			case "MONTH_CLOSE_IDEMPOTENCY_CONFLICT":
				return fail(c, unwrapped.code, 409);
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

monthCloseRouter.use("*", requireAuthenticatedSession);
monthCloseRouter.use("*", sameOriginMutationGuard());

// ===========================================================================
// STATIC ROUTES FIRST (Prevent Shadowing)
// ===========================================================================

/**
 * 1. GET /month-close/preview?periodMonth=YYYY-MM
 * Read-only preview of Month-Close proposal (allowed before period ends).
 */
monthCloseRouter.get("/preview", async (c) => {
	if (!validateStrictQueryParams(c, ["periodMonth"])) {
		return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
	}

	const rawPeriodMonth = c.req.query("periodMonth");
	if (typeof rawPeriodMonth !== "string") {
		return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
	}

	try {
		validateMonthClosePeriodMonth(rawPeriodMonth);
	} catch {
		return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const proposal = await previewMonthClose({
			db,
			userId: auth.userId,
			periodMonth: rawPeriodMonth,
		});

		return c.json(proposal, 200);
	} catch (err) {
		return mapMonthCloseDomainError(c, err);
	}
});

/**
 * 2. GET /month-close
 * Bounded keyset listing of month closes for authenticated user.
 */
monthCloseRouter.get("/", async (c) => {
	if (
		!validateStrictQueryParams(c, [
			"limit",
			"after",
			"periodMonthFrom",
			"periodMonthUntil",
		])
	) {
		return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);

	const periodMonthFromQuery = c.req.query("periodMonthFrom");
	if (periodMonthFromQuery !== undefined) {
		try {
			validateMonthClosePeriodMonth(periodMonthFromQuery);
		} catch {
			return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		}
	}

	const periodMonthUntilQuery = c.req.query("periodMonthUntil");
	if (periodMonthUntilQuery !== undefined) {
		try {
			validateMonthClosePeriodMonth(periodMonthUntilQuery);
		} catch {
			return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		}
	}

	const afterQuery = c.req.query("after");

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedMonthCloses({
			db,
			userId: auth.userId,
			limit: limitRes.limit,
			periodMonthFrom: periodMonthFromQuery,
			periodMonthUntil: periodMonthUntilQuery,
			rawCursor: afterQuery,
		});

		return c.json(
			{
				monthCloses: result.monthCloses,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor: result.nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapMonthCloseDomainError(c, err);
	}
});

/**
 * 3. POST /month-close
 * Authoritative month-end surplus close execution with exact idempotency.
 */
monthCloseRouter.post(
	"/",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"periodMonth",
				"expectedProposalFingerprint",
				"decision",
				"partialAmount",
				"occurredAt",
			])
		) {
			return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		}

		if (
			typeof body.periodMonth !== "string" ||
			typeof body.expectedProposalFingerprint !== "string" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		}

		try {
			validateMonthClosePeriodMonth(body.periodMonth);
		} catch {
			return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		}

		let decision: "FULL" | "PARTIAL" | "SKIP" | undefined;
		if (body.decision !== undefined) {
			if (
				typeof body.decision !== "string" ||
				!["FULL", "PARTIAL", "SKIP"].includes(body.decision)
			) {
				return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
			}
			decision = body.decision as "FULL" | "PARTIAL" | "SKIP";
		}

		let partialAmount: string | undefined;
		if (body.partialAmount !== undefined) {
			if (typeof body.partialAmount !== "string") {
				return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
			}
			partialAmount = body.partialAmount;
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await closeMonth({
				db,
				userId: auth.userId,
				periodMonth: body.periodMonth,
				expectedProposalFingerprint: body.expectedProposalFingerprint,
				decision,
				partialAmount,
				occurredAt: occurredAtDate,
				idempotencyKey: keyRes.key,
			});

			return c.json(
				{
					monthClose: toMonthCloseProductDto(result.monthClose),
					idempotentReplay: result.idempotentReplay,
				},
				result.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapMonthCloseDomainError(c, err);
		}
	},
);

// ===========================================================================
// PARAMETRIC ROUTE (/:periodMonth)
// ===========================================================================

/**
 * 4. GET /month-close/:periodMonth
 * Fetch single month close detail by periodMonth (YYYY-MM).
 */
monthCloseRouter.get("/:periodMonth", async (c) => {
	const rawPeriodMonth = c.req.param("periodMonth");
	try {
		validateMonthClosePeriodMonth(rawPeriodMonth);
	} catch {
		return fail(c, "MONTH_CLOSE_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const monthClose = await getMonthClose({
			db,
			userId: auth.userId,
			periodMonth: rawPeriodMonth,
		});

		if (!monthClose) {
			return fail(c, "MONTH_CLOSE_NOT_FOUND", 404);
		}

		return c.json(
			{
				monthClose: toMonthCloseProductDto(monthClose),
			},
			200,
		);
	} catch (err) {
		return mapMonthCloseDomainError(c, err);
	}
});
