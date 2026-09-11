import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	BUDGET_V2_PRODUCT_API_VERSION,
	BudgetV2DecisionCenterError,
	buildBudgetV2CheckpointTimeline,
	buildBudgetV2DecisionCenterView,
} from "../budget/decision-center-v2";
import { BudgetError } from "../budget/errors";
import type {
	BudgetV2RecommendationDecision,
	BudgetV2RecommendationModification,
} from "../budget/recommendation-feedback-service-v2";
import {
	createBudgetV2RecommendationFeedback,
	updateBudgetV2RecommendationFeedback,
} from "../budget/recommendation-feedback-service-v2";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	HEX64_RE,
	hasOnlyKeys,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
	UUID_RE,
} from "./transport";

/**
 * PERSONAL_BUDGET_V2 -- PRODUCT INTEGRATION BOUNDARY (Checkpoint 7A; shared
 * transport helpers + same-origin guard adopted in 7B.0).
 *
 * A thin authenticated HTTP adapter over the existing verified Budget V2
 * domain. Every route here:
 *
 *   - runs behind `sameOriginMutationGuard()` + `requireAuthenticatedSession`
 *   - derives the user ONLY from `c.get("auth").userId` -- never from the
 *     body, query string, path, or a header
 *   - validates the CLOSED transport schema, then delegates to an existing
 *     domain/service function
 *   - maps domain results/errors to a bounded, sanitized HTTP response
 *
 * It re-implements no financial logic (waterfall, trueSurplus,
 * availableToAllocateNow, behavior statistics, recommendation
 * eligibility/priority, feedback adaptation, modification validation,
 * idempotency, OCC, fingerprinting) and performs no financial execution.
 */

type BudgetV2Env = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const budgetV2Router = new Hono<BudgetV2Env>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB -- feedback bodies are tiny

const TIMELINE_DEFAULT_LIMIT = 50;
const TIMELINE_MAX_LIMIT = 100;

const DECISIONS: ReadonlySet<string> = new Set(["ACCEPT", "MODIFY", "IGNORE"]);

function fail(c: Context<BudgetV2Env>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

/**
 * The single centralized domain-error -> HTTP mapper for this router. Only a
 * closed allowlist of client-correctable codes is surfaced; integrity /
 * corruption / fail-closed / unexpected errors collapse to a sanitized 500 and
 * NEVER carry a raw `BudgetError` message or a PostgreSQL code.
 */
function mapDomainError(c: Context<BudgetV2Env>, err: unknown) {
	if (err instanceof BudgetV2DecisionCenterError) {
		if (err.code === "BUDGET_V2_PRODUCT_INVALID_INPUT") {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}
		return fail(c, "BUDGET_CHECKPOINT_NOT_FOUND", 404);
	}
	if (err instanceof BudgetError) {
		switch (err.code) {
			case "BUDGET_INVALID_INPUT":
				return fail(c, "BUDGET_INVALID_INPUT", 400);
			case "BUDGET_RECOMMENDATION_NOT_FOUND":
				return fail(c, "BUDGET_RECOMMENDATION_NOT_FOUND", 404);
			case "BUDGET_RECOMMENDATION_NOT_ACTIVE":
				return fail(c, "BUDGET_RECOMMENDATION_NOT_ACTIVE", 409);
			case "BUDGET_RECOMMENDATION_STALE":
				return fail(c, "BUDGET_RECOMMENDATION_STALE", 409);
			case "BUDGET_IDEMPOTENCY_CONFLICT":
				return fail(c, "BUDGET_IDEMPOTENCY_CONFLICT", 409);
			case "BUDGET_REVISION_CONFLICT":
				return fail(c, "BUDGET_REVISION_CONFLICT", 409);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

function parseModification(
	value: unknown,
):
	| { ok: true; modification: BudgetV2RecommendationModification | null }
	| { ok: false } {
	if (value === undefined || value === null) {
		return { ok: true, modification: null };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		return { ok: false };
	}
	// Shape is validated by the existing domain modification validator; the
	// route only guarantees it is a plain object.
	return {
		ok: true,
		modification: value as BudgetV2RecommendationModification,
	};
}

function feedbackResponseBody(
	recommendationId: string,
	revision: { decision: string; revisionNo: number; occurredAt: Date },
) {
	return {
		apiVersion: BUDGET_V2_PRODUCT_API_VERSION,
		recommendationId,
		decision: revision.decision,
		revisionNo: revision.revisionNo,
		occurredAt: revision.occurredAt.toISOString(),
		status: revision.decision,
	};
}

// --- middleware --------------------------------------------------------

budgetV2Router.use("*", sameOriginMutationGuard());
budgetV2Router.use("*", requireAuthenticatedSession);
budgetV2Router.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => c.json(errorEnvelope("BUDGET_INVALID_INPUT"), 400),
	}),
);

// --- GET /budget-v2/checkpoints --------------------------------------

budgetV2Router.get("/checkpoints", async (c) => {
	const rawLimit = c.req.query("limit");
	const limit = parseBoundedLimit(rawLimit, {
		defaultLimit: TIMELINE_DEFAULT_LIMIT,
		maxLimit: TIMELINE_MAX_LIMIT,
	});
	if (!limit.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const timeline = await buildBudgetV2CheckpointTimeline({
			db,
			userId: c.get("auth").userId,
			// Only pass `limit` when the client explicitly provided a value --
			// omitting it lets the domain use its own internal default, and
			// keeps the call-site faithful to the test contract.
			...(rawLimit !== undefined ? { limit: limit.limit } : {}),
		});
		return c.json(timeline, 200);
	} catch (err) {
		return mapDomainError(c, err);
	}
});

// --- GET /budget-v2/checkpoints/:paymentEventId/decision-center -------

budgetV2Router.get(
	"/checkpoints/:paymentEventId/decision-center",
	async (c) => {
		const paymentEventId = c.req.param("paymentEventId");
		if (!UUID_RE.test(paymentEventId)) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const view = await buildBudgetV2DecisionCenterView({
				db,
				userId: c.get("auth").userId,
				throughPaymentEventId: paymentEventId,
			});
			return c.json(view, 200);
		} catch (err) {
			return mapDomainError(c, err);
		}
	},
);

// --- POST .../:paymentEventId/recommendations/:recommendationId/feedback ---

budgetV2Router.post(
	"/checkpoints/:paymentEventId/recommendations/:recommendationId/feedback",
	async (c) => {
		const paymentEventId = c.req.param("paymentEventId");
		const recommendationId = c.req.param("recommendationId");
		if (!UUID_RE.test(paymentEventId)) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}
		if (typeof recommendationId !== "string" || recommendationId.length === 0) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}

		const idem = readIdempotencyKey(c);
		if (!idem.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);
		const body = parsed.value;
		if (
			!hasOnlyKeys(body, [
				"expectedRecommendationFingerprint",
				"decision",
				"modification",
				"occurredAt",
			])
		) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}

		const fingerprint = body.expectedRecommendationFingerprint;
		if (typeof fingerprint !== "string" || !HEX64_RE.test(fingerprint)) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}
		if (typeof body.decision !== "string" || !DECISIONS.has(body.decision)) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}
		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "BUDGET_INVALID_INPUT", 400);
		const mod = parseModification(body.modification);
		if (!mod.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const result = await createBudgetV2RecommendationFeedback(db, {
				userId: c.get("auth").userId,
				throughPaymentEventId: paymentEventId,
				recommendationId,
				expectedRecommendationFingerprint: fingerprint,
				decision: body.decision as BudgetV2RecommendationDecision,
				modification: mod.modification,
				idempotencyKey: idem.key,
				occurredAt,
			});
			return c.json(
				feedbackResponseBody(recommendationId, result.revision),
				200,
			);
		} catch (err) {
			return mapDomainError(c, err);
		}
	},
);

// --- POST /budget-v2/recommendations/:recommendationId/feedback/revisions ---

budgetV2Router.post(
	"/recommendations/:recommendationId/feedback/revisions",
	async (c) => {
		const recommendationId = c.req.param("recommendationId");
		if (typeof recommendationId !== "string" || recommendationId.length === 0) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}

		const idem = readIdempotencyKey(c);
		if (!idem.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);
		const body = parsed.value;
		if (
			!hasOnlyKeys(body, [
				"expectedRevisionNo",
				"decision",
				"modification",
				"occurredAt",
			])
		) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}

		const expectedRevisionNo = body.expectedRevisionNo;
		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}
		if (typeof body.decision !== "string" || !DECISIONS.has(body.decision)) {
			return fail(c, "BUDGET_INVALID_INPUT", 400);
		}
		const occurredAt = parseCanonicalInstant(body.occurredAt);
		if (!occurredAt) return fail(c, "BUDGET_INVALID_INPUT", 400);
		const mod = parseModification(body.modification);
		if (!mod.ok) return fail(c, "BUDGET_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const result = await updateBudgetV2RecommendationFeedback(db, {
				userId: c.get("auth").userId,
				recommendationId,
				expectedRevisionNo,
				decision: body.decision as BudgetV2RecommendationDecision,
				modification: mod.modification,
				idempotencyKey: idem.key,
				occurredAt,
			});
			return c.json(
				feedbackResponseBody(recommendationId, result.revision),
				200,
			);
		} catch (err) {
			return mapDomainError(c, err);
		}
	},
);
