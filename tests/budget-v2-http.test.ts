import { beforeEach, describe, expect, it, vi } from "vitest";
import * as decisionCenterModule from "../src/budget/decision-center-v2";
import { BudgetV2DecisionCenterError } from "../src/budget/decision-center-v2";
import { BudgetError } from "../src/budget/errors";
import * as feedbackServiceModule from "../src/budget/recommendation-feedback-service-v2";
import * as dbClientModule from "../src/db/client";

const U1 = "11111111-1111-4111-8111-111111111111";

// The real `requireAuthenticatedSession` (covered by auth-middleware.test.ts /
// auth-http.test.ts) resolves the session via a DB round trip. Here the DB is
// mocked away, so this file substitutes a faithful-enough gate: a request with
// a non-empty `__Host-gg_session` cookie is authenticated as U1; without one it
// gets the same 401 UNAUTHENTICATED shape as production.
vi.mock("../src/http/auth-middleware", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/http/auth-middleware")>();
	return {
		...actual,
		// biome-ignore lint/suspicious/noExplicitAny: test middleware shim
		requireAuthenticatedSession: async (c: any, next: any) => {
			const cookie = c.req.header("Cookie") ?? "";
			const match = /(?:^|;\s*)__Host-gg_session=([^;]+)/.exec(cookie);
			if (!match || (match[1] ?? "").trim() === "") {
				return c.json(
					{
						error: {
							code: "UNAUTHENTICATED",
							message: "Authentication required",
						},
					},
					401,
				);
			}
			c.set("auth", {
				userId: U1,
				displayName: "U1",
				sessionId: "sess-1",
			});
			return next();
		},
	};
});

const { app } = await import("../src/index");

/**
 * Checkpoint 7A -- the authoritative DB-backed coverage for the Budget V2
 * product boundary lives in `scripts/pg-runtime-verify.ts` (Phase 7A). The
 * vitest gate runs on workerd and cannot open a PGlite database, so this file
 * pins the HTTP adapter contract: authentication, closed transport validation,
 * Idempotency-Key / occurredAt handling, the domain-error -> HTTP mapping, and
 * response-data minimization -- with the composed domain services mocked.
 */

const PE = "22222222-2222-4222-8222-222222222222";
const REC =
	"budget-v2-rec:v1:22222222-2222-4222-8222-222222222222:UNUSED_DISCRETIONARY_SWEEP_REVIEW:GLOBAL";
const FP = "a".repeat(64);
const OCCURRED_AT = "2026-09-10T12:34:56.789Z";
const COOKIE = "__Host-gg_session=valid-token";

const mockEnv = {
	DATABASE_URL: "postgresql://user:password@example.invalid/db",
	WEBAUTHN_RP_ID: "localhost",
	WEBAUTHN_RP_NAME: "Gelir Gider",
	WEBAUTHN_ORIGIN: "http://localhost:8787",
	BOOTSTRAP_TOKEN_HASH: "0".repeat(64),
	AUTH_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

interface ErrBody {
	error: { code: string; message: string };
}

const REVISION = {
	id: "rev-1",
	userId: U1,
	recommendationInstanceId: "inst-1",
	revisionNo: 1,
	previousRevisionId: null,
	operation: "CREATE" as const,
	decision: "ACCEPT" as const,
	modification: null,
	sourceKind: "USER_APPROVED" as const,
	idempotencyKey: "idem-1",
	revisionFingerprint: "b".repeat(64),
	occurredAt: new Date(OCCURRED_AT),
	createdAt: new Date(OCCURRED_AT),
};

function feedbackResult() {
	return {
		instance: {} as never,
		revision: { ...REVISION },
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as never);
	mockEnv.AUTH_RATE_LIMITER = {
		limit: vi.fn().mockResolvedValue({ success: true }),
	};
});

describe("Budget V2 product boundary -- authentication", () => {
	it("A: rejects every /budget-v2 route without a session cookie (401)", async () => {
		for (const path of [
			"/budget-v2/checkpoints",
			`/budget-v2/checkpoints/${PE}/decision-center`,
		]) {
			const res = await app.request(path, { method: "GET" }, mockEnv);
			expect(res.status).toBe(401);
			expect(((await res.json()) as ErrBody).error.code).toBe(
				"UNAUTHENTICATED",
			);
		}
	});

	it("A: rejects a feedback POST without a session cookie (401)", async () => {
		const res = await app.request(
			`/budget-v2/checkpoints/${PE}/recommendations/${REC}/feedback`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "idem-1",
				},
				body: JSON.stringify({
					expectedRecommendationFingerprint: FP,
					decision: "ACCEPT",
					occurredAt: OCCURRED_AT,
				}),
			},
			mockEnv,
		);
		expect(res.status).toBe(401);
	});
});

describe("Budget V2 product boundary -- checkpoint timeline", () => {
	// authenticated via the mocked requireAuthenticatedSession + COOKIE

	it("D: passes the default (no limit) through to the facade", async () => {
		const spy = vi
			.spyOn(decisionCenterModule, "buildBudgetV2CheckpointTimeline")
			.mockResolvedValue({
				apiVersion: "budget-v2-product-api-v1",
				limit: 50,
				sharedMaxCheckpointAt: false,
				checkpoints: [],
			});
		const res = await app.request(
			"/budget-v2/checkpoints",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ userId: U1 });
		expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("limit");
	});

	it("D: forwards a numeric limit and rejects a malformed one (400)", async () => {
		const spy = vi
			.spyOn(decisionCenterModule, "buildBudgetV2CheckpointTimeline")
			.mockResolvedValue({
				apiVersion: "budget-v2-product-api-v1",
				limit: 10,
				sharedMaxCheckpointAt: false,
				checkpoints: [],
			});
		const okRes = await app.request(
			"/budget-v2/checkpoints?limit=10",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(okRes.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ limit: 10 });

		for (const bad of ["abc", "-1", "1.5", "10 ", ""]) {
			const res = await app.request(
				`/budget-v2/checkpoints?limit=${encodeURIComponent(bad)}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(400);
		}
	});

	it("D: an out-of-range limit from the facade maps to 400", async () => {
		vi.spyOn(
			decisionCenterModule,
			"buildBudgetV2CheckpointTimeline",
		).mockRejectedValue(
			new BudgetV2DecisionCenterError(
				"BUDGET_V2_PRODUCT_INVALID_INPUT",
				"limit must be an integer between 1 and 100",
			),
		);
		const res = await app.request(
			"/budget-v2/checkpoints?limit=101",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("C: serializes exactly the bounded timeline the facade returns (no report JSON)", async () => {
		vi.spyOn(
			decisionCenterModule,
			"buildBudgetV2CheckpointTimeline",
		).mockResolvedValue({
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: true,
			checkpoints: [
				{
					paymentEventId: PE,
					checkpointAt: "2026-09-10T00:00:00.000Z",
					periodMonth: "2026-09-01",
				},
			],
		});
		const res = await app.request(
			"/budget-v2/checkpoints",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		const body = (await res.json()) as { checkpoints: unknown[] };
		expect(JSON.stringify(body)).not.toContain("report");
		expect(Object.keys(body.checkpoints[0] as object).sort()).toEqual([
			"checkpointAt",
			"paymentEventId",
			"periodMonth",
		]);
	});

	it("AH: request-id + security headers are present on a /budget-v2 response", async () => {
		vi.spyOn(
			decisionCenterModule,
			"buildBudgetV2CheckpointTimeline",
		).mockResolvedValue({
			apiVersion: "budget-v2-product-api-v1",
			limit: 50,
			sharedMaxCheckpointAt: false,
			checkpoints: [],
		});
		const res = await app.request(
			"/budget-v2/checkpoints",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.headers.get("X-Request-ID")).toBeTruthy();
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});
});

describe("Budget V2 product boundary -- decision center", () => {
	// authenticated via the mocked requireAuthenticatedSession + COOKIE

	it("E: forwards the authenticated userId + explicit paymentEventId", async () => {
		const spy = vi
			.spyOn(decisionCenterModule, "buildBudgetV2DecisionCenterView")
			.mockResolvedValue({
				apiVersion: "budget-v2-product-api-v1",
				target: {
					paymentEventId: PE,
					checkpointAt: "2026-09-10T00:00:00.000Z",
					periodMonth: "2026-09-01",
				},
				checkpoint: { temporalScope: "FROZEN_AT_CHECKPOINT", report: { x: 1 } },
				behavior: {
					temporalScope: "AS_OF_CHECKPOINT",
					profile: {} as never,
				},
				recommendations: {
					generationScope: "AS_OF_CHECKPOINT",
					adaptationScope: "AS_OF_CHECKPOINT",
					feedbackStatusScope: "CURRENT",
					view: {} as never,
				},
			});
		const res = await app.request(
			`/budget-v2/checkpoints/${PE}/decision-center`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({
			userId: U1,
			throughPaymentEventId: PE,
		});
		const body = (await res.json()) as {
			checkpoint: { temporalScope: string };
			behavior: { temporalScope: string };
			recommendations: {
				generationScope: string;
				adaptationScope: string;
				feedbackStatusScope: string;
			};
		};
		expect(body.checkpoint.temporalScope).toBe("FROZEN_AT_CHECKPOINT");
		expect(body.behavior.temporalScope).toBe("AS_OF_CHECKPOINT");
		expect(body.recommendations.generationScope).toBe("AS_OF_CHECKPOINT");
		expect(body.recommendations.adaptationScope).toBe("AS_OF_CHECKPOINT");
		expect(body.recommendations.feedbackStatusScope).toBe("CURRENT");
	});

	it("invalid paymentEventId in the path -> 400 (no coercion, no DB call)", async () => {
		const spy = vi.spyOn(
			decisionCenterModule,
			"buildBudgetV2DecisionCenterView",
		);
		const res = await app.request(
			"/budget-v2/checkpoints/not-a-uuid/decision-center",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
		expect(spy).not.toHaveBeenCalled();
	});

	it("F/G: a not-found / cross-user checkpoint -> 404 (indistinguishable)", async () => {
		vi.spyOn(
			decisionCenterModule,
			"buildBudgetV2DecisionCenterView",
		).mockRejectedValue(
			new BudgetV2DecisionCenterError(
				"BUDGET_V2_CHECKPOINT_NOT_FOUND",
				"no persisted Budget V2 checkpoint for this payment event",
			),
		);
		const res = await app.request(
			`/budget-v2/checkpoints/${PE}/decision-center`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as ErrBody).error.code).toBe(
			"BUDGET_CHECKPOINT_NOT_FOUND",
		);
	});

	it("H/AG: a corrupt persisted snapshot fails closed as a sanitized 500", async () => {
		vi.spyOn(
			decisionCenterModule,
			"buildBudgetV2DecisionCenterView",
		).mockRejectedValue(
			new BudgetError(
				"BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT",
				"recomputed canonical report fingerprint does not match the stored fingerprint",
			),
		);
		const res = await app.request(
			`/budget-v2/checkpoints/${PE}/decision-center`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(500);
		const body = (await res.json()) as ErrBody;
		expect(body.error.code).toBe("INTERNAL_ERROR");
		expect(body.error.message).toBe("Internal server error");
		expect(JSON.stringify(body)).not.toContain("fingerprint");
	});
});

describe("Budget V2 product boundary -- CREATE feedback", () => {
	// authenticated via the mocked requireAuthenticatedSession + COOKIE

	const url = `/budget-v2/checkpoints/${PE}/recommendations/${REC}/feedback`;
	const goodBody = {
		expectedRecommendationFingerprint: FP,
		decision: "ACCEPT",
		occurredAt: OCCURRED_AT,
	};
	const headers = {
		Cookie: COOKIE,
		"content-type": "application/json",
		"Idempotency-Key": "idem-1",
	};

	it("P: a well-formed request calls the service and returns a bounded 200", async () => {
		const spy = vi
			.spyOn(feedbackServiceModule, "createBudgetV2RecommendationFeedback")
			.mockResolvedValue(feedbackResult());
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			apiVersion: "budget-v2-product-api-v1",
			recommendationId: REC,
			decision: "ACCEPT",
			revisionNo: 1,
			occurredAt: OCCURRED_AT,
			status: "ACCEPT",
		});
		const arg = spy.mock.calls[0]?.[1];
		expect(arg).toMatchObject({
			userId: U1,
			throughPaymentEventId: PE,
			recommendationId: REC,
			expectedRecommendationFingerprint: FP,
			decision: "ACCEPT",
			idempotencyKey: "idem-1",
		});
	});

	it("Y: the service receives the client occurredAt instant verbatim (never a fresh clock)", async () => {
		const spy = vi
			.spyOn(feedbackServiceModule, "createBudgetV2RecommendationFeedback")
			.mockResolvedValue(feedbackResult());
		await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		const arg = spy.mock.calls[0]?.[1];
		expect(arg?.occurredAt).toBeInstanceOf(Date);
		expect(arg?.occurredAt.toISOString()).toBe(OCCURRED_AT);
	});

	it("Q: an exact replay returns the same bounded semantic response (200)", async () => {
		vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		).mockResolvedValue(feedbackResult());
		const first = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		const replay = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(first.status).toBe(200);
		expect(replay.status).toBe(200);
		expect(await first.json()).toEqual(await replay.json());
	});

	it("R: same Idempotency-Key + changed body -> 409 from the domain", async () => {
		vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		).mockRejectedValue(
			new BudgetError("BUDGET_IDEMPOTENCY_CONFLICT", "key reuse"),
		);
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as ErrBody).error.code).toBe(
			"BUDGET_IDEMPOTENCY_CONFLICT",
		);
	});

	it("S: a stale recommendation fingerprint -> 409", async () => {
		vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		).mockRejectedValue(
			new BudgetError("BUDGET_RECOMMENDATION_STALE", "fingerprint drift"),
		);
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(409);
	});

	it("T: a suppressed / not-active recommendation -> 409", async () => {
		vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		).mockRejectedValue(
			new BudgetError("BUDGET_RECOMMENDATION_NOT_ACTIVE", "suppressed"),
		);
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(409);
	});

	it("AF: a cross-user recommendation target surfaces as 404 (NOT_FOUND)", async () => {
		vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		).mockRejectedValue(
			new BudgetError("BUDGET_RECOMMENDATION_NOT_FOUND", "not found"),
		);
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(404);
	});

	it("W: missing / blank / >128 Idempotency-Key -> 400", async () => {
		const spy = vi
			.spyOn(feedbackServiceModule, "createBudgetV2RecommendationFeedback")
			.mockResolvedValue(feedbackResult());
		// Note: the transport layer already trims header whitespace, so a
		// surrounding-whitespace key never reaches the handler as such.
		const variants = [undefined, "", "   ", "x".repeat(129)];
		for (const key of variants) {
			const h: Record<string, string> = {
				Cookie: COOKIE,
				"content-type": "application/json",
			};
			if (key !== undefined) h["Idempotency-Key"] = key;
			const res = await app.request(
				url,
				{ method: "POST", headers: h, body: JSON.stringify(goodBody) },
				mockEnv,
			);
			expect(res.status).toBe(400);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("X: a non-canonical or invalid occurredAt -> 400", async () => {
		const spy = vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		);
		for (const occurredAt of [
			"2026-09-10T12:34:56Z",
			"2026-09-10T12:34:56.789+00:00",
			"2026-09-10 12:34:56.789Z",
			"2026-13-40T12:34:56.789Z",
			"not-a-date",
			1_726_000_000_000,
		]) {
			const res = await app.request(
				url,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ ...goodBody, occurredAt }),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("Z/AA: unknown top-level fields (including userId) -> 400", async () => {
		const spy = vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		);
		for (const extra of [
			{ userId: U1 },
			{ priority: 9 },
			{ automaticExecution: true },
			{ mutatesPolicy: true },
			{ amount: "10.00" },
			{ destination: "INTERNATIONAL_MOBILITY" },
			{ unexpected: 1 },
		]) {
			const res = await app.request(
				url,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ ...goodBody, ...extra }),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("AB: a malformed modification / fingerprint / decision / body -> 400", async () => {
		const spy = vi.spyOn(
			feedbackServiceModule,
			"createBudgetV2RecommendationFeedback",
		);
		const bads: unknown[] = [
			{ ...goodBody, modification: "NOTE_ONLY" },
			{ ...goodBody, modification: [] },
			{ ...goodBody, expectedRecommendationFingerprint: "short" },
			{ ...goodBody, decision: "MAYBE" },
			[goodBody],
			"a string body",
		];
		for (const body of bads) {
			const res = await app.request(
				url,
				{ method: "POST", headers, body: JSON.stringify(body) },
				mockEnv,
			);
			expect(res.status).toBe(400);
		}
		// invalid JSON
		const res = await app.request(
			url,
			{ method: "POST", headers, body: "{not json" },
			mockEnv,
		);
		expect(res.status).toBe(400);
		// missing content-type
		const res2 = await app.request(
			url,
			{
				method: "POST",
				headers: { Cookie: COOKIE, "Idempotency-Key": "idem-1" },
				body: JSON.stringify(goodBody),
			},
			mockEnv,
		);
		expect(res2.status).toBe(400);
		expect(spy).not.toHaveBeenCalled();
	});

	it("AB: a well-formed modification object is passed through to the domain validator", async () => {
		const spy = vi
			.spyOn(feedbackServiceModule, "createBudgetV2RecommendationFeedback")
			.mockResolvedValue(feedbackResult());
		const res = await app.request(
			url,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					...goodBody,
					decision: "MODIFY",
					modification: { type: "NOTE_ONLY", note: "later" },
				}),
			},
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[1].modification).toEqual({
			type: "NOTE_ONLY",
			note: "later",
		});
	});
});

describe("Budget V2 product boundary -- UPDATE feedback", () => {
	// authenticated via the mocked requireAuthenticatedSession + COOKIE

	const url = `/budget-v2/recommendations/${REC}/feedback/revisions`;
	const headers = {
		Cookie: COOKIE,
		"content-type": "application/json",
		"Idempotency-Key": "idem-2",
	};
	const goodBody = {
		expectedRevisionNo: 1,
		decision: "IGNORE",
		occurredAt: OCCURRED_AT,
	};

	it("U: a well-formed request appends a revision and returns a bounded 200", async () => {
		const spy = vi
			.spyOn(feedbackServiceModule, "updateBudgetV2RecommendationFeedback")
			.mockResolvedValue({
				instance: {} as never,
				revision: {
					...REVISION,
					revisionNo: 2,
					operation: "UPDATE",
					decision: "IGNORE",
				},
			});
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			apiVersion: "budget-v2-product-api-v1",
			recommendationId: REC,
			decision: "IGNORE",
			revisionNo: 2,
			occurredAt: OCCURRED_AT,
			status: "IGNORE",
		});
		expect(spy.mock.calls[0]?.[1]).toMatchObject({
			userId: U1,
			recommendationId: REC,
			expectedRevisionNo: 1,
			idempotencyKey: "idem-2",
		});
	});

	it("V: a stale expectedRevisionNo -> 409", async () => {
		vi.spyOn(
			feedbackServiceModule,
			"updateBudgetV2RecommendationFeedback",
		).mockRejectedValue(
			new BudgetError("BUDGET_REVISION_CONFLICT", "stale revision"),
		);
		const res = await app.request(
			url,
			{ method: "POST", headers, body: JSON.stringify(goodBody) },
			mockEnv,
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as ErrBody).error.code).toBe(
			"BUDGET_REVISION_CONFLICT",
		);
	});

	it("no coercion: a string expectedRevisionNo -> 400", async () => {
		const spy = vi.spyOn(
			feedbackServiceModule,
			"updateBudgetV2RecommendationFeedback",
		);
		for (const expectedRevisionNo of ["1", 0, -1, 1.5, null]) {
			const res = await app.request(
				url,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ ...goodBody, expectedRevisionNo }),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("Z: unknown fields on the revision body -> 400", async () => {
		const spy = vi.spyOn(
			feedbackServiceModule,
			"updateBudgetV2RecommendationFeedback",
		);
		const res = await app.request(
			url,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ ...goodBody, userId: U1 }),
			},
			mockEnv,
		);
		expect(res.status).toBe(400);
		expect(spy).not.toHaveBeenCalled();
	});
});
