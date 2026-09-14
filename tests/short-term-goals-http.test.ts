import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { ShortTermGoalError } from "../src/short-term-goals/errors";
import * as productReadModule from "../src/short-term-goals/product-read";
import * as serviceModule from "../src/short-term-goals/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const MIDAS_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_ID = "33333333-3333-4333-8333-333333333333";
const BUCKET_ID = "44444444-4444-4444-8444-444444444444";

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

const OCCURRED_AT = "2026-09-10T12:34:56.789Z";
const COOKIE = "__Host-gg_session=valid-token";
const ORIGIN = "http://localhost:8787";

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

describe("Short-Term Goals Product HTTP Surface (Checkpoint 7B.7)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: mock DB
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	// --- 1. Authentication Gates on All 9 Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/short-term-goals", method: "GET" },
			{ path: `/short-term-goals/${GOAL_ID}`, method: "GET" },
			{ path: "/short-term-goals", method: "POST" },
			{ path: `/short-term-goals/${GOAL_ID}`, method: "POST" },
			{ path: `/short-term-goals/${GOAL_ID}/complete`, method: "POST" },
			{ path: `/short-term-goals/${GOAL_ID}/cancel`, method: "POST" },
			{ path: "/short-term-goals/reorder", method: "POST" },
			{ path: `/short-term-goals/${GOAL_ID}/fund`, method: "POST" },
			{ path: `/short-term-goals/${GOAL_ID}/release`, method: "POST" },
		];

		for (const { path, method } of routes) {
			it(`rejects unauthenticated ${method} ${path} with 401`, async () => {
				const reqInit: RequestInit = { method };
				if (method === "POST") {
					reqInit.headers = {
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "k-1",
					};
					reqInit.body = "{}";
				}
				const res = await app.request(path, reqInit);
				expect(res.status).toBe(401);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("UNAUTHENTICATED");
			});
		}
	});

	// --- 2. GET /short-term-goals Listing with Keyset Pagination ---
	describe("GET /short-term-goals", () => {
		it("lists goals successfully with cursor pagination", async () => {
			const mockGoal: productReadModule.ShortTermGoalProductDto = {
				goalId: GOAL_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				midasBucketId: BUCKET_ID,
				status: "ACTIVE",
				name: "Emergency MacBook",
				fundingTarget: "50000.00",
				accumulatedAmount: "10000.00",
				remainingToTarget: "40000.00",
				fundingStatus: "PARTIAL",
				progressPercentage: 20.0,
				targetDate: "2026-12-31",
				maxBudget: "60000.00",
				targetPrice: "50000.00",
				productUrl: "https://example.com/macbook",
				note: "For work",
				priority: 1,
				latestRevisionNo: 1,
				createdAt: OCCURRED_AT,
				updatedAt: OCCURRED_AT,
			};

			vi.spyOn(
				productReadModule,
				"listBoundedShortTermGoals",
			).mockResolvedValue({
				goals: [mockGoal],
				hasMore: false,
				nextCursor: null,
			});

			const res = await app.request(
				`/short-term-goals?midasAccountId=${MIDAS_ACCOUNT_ID}&status=ACTIVE&limit=10`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.goals).toHaveLength(1);
			expect(body.goals[0].goalId).toBe(GOAL_ID);
			expect(body.hasMore).toBe(false);
			expect(body.nextCursor).toBeNull();
		});

		it("rejects invalid status filter with 400", async () => {
			const res = await app.request(
				"/short-term-goals?status=UNKNOWN_STATUS",
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("SHORT_TERM_GOAL_INVALID_INPUT");
		});

		it("rejects malformed cursor with 400", async () => {
			const res = await app.request(
				"/short-term-goals?cursor=invalid-cursor-value",
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("SHORT_TERM_GOAL_INVALID_INPUT");
		});
	});

	// --- 3. GET /short-term-goals/:id Detail ---
	describe("GET /short-term-goals/:id", () => {
		it("returns goal detail when found", async () => {
			vi.spyOn(serviceModule, "getShortTermGoal").mockResolvedValue({
				id: GOAL_ID,
				userId: U1,
				midasAccountId: MIDAS_ACCOUNT_ID,
				midasBucketId: BUCKET_ID,
				status: "ACTIVE",
				name: "Vacation",
				fundingTarget: "20000.00",
				accumulatedAmount: "20000.00",
				remainingToTarget: "0.00",
				fundingStatus: "TARGET_REACHED",
				progressPercentage: 100.0,
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				priority: 2,
				latestRevisionNo: 3,
				createdAt: new Date(OCCURRED_AT),
				updatedAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/short-term-goals/${GOAL_ID}`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.goal.goalId).toBe(GOAL_ID);
			expect(body.goal.name).toBe("Vacation");
			expect(body.goal.fundingStatus).toBe("TARGET_REACHED");
		});

		it("returns 404 when goal not found", async () => {
			vi.spyOn(serviceModule, "getShortTermGoal").mockRejectedValue(
				new ShortTermGoalError("SHORT_TERM_GOAL_NOT_FOUND", "Goal not found"),
			);

			const res = await app.request(
				`/short-term-goals/${GOAL_ID}`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("SHORT_TERM_GOAL_NOT_FOUND");
		});
	});

	// --- 4. POST /short-term-goals Create ---
	describe("POST /short-term-goals", () => {
		it("creates goal successfully and returns 201", async () => {
			vi.spyOn(serviceModule, "createShortTermGoal").mockResolvedValue({
				goalId: GOAL_ID,
				revisionId: "rev-1",
				revisionNo: 1,
				operation: "CREATE",
				status: "ACTIVE",
				idempotentReplay: false,
				snapshot: {
					name: "New Phone",
					fundingTarget: "30000.00",
					targetDate: null,
					maxBudget: null,
					targetPrice: null,
					productUrl: null,
					note: null,
				},
			});

			vi.spyOn(serviceModule, "getShortTermGoal").mockResolvedValue({
				id: GOAL_ID,
				userId: U1,
				midasAccountId: MIDAS_ACCOUNT_ID,
				midasBucketId: BUCKET_ID,
				status: "ACTIVE",
				name: "New Phone",
				fundingTarget: "30000.00",
				accumulatedAmount: "0.00",
				remainingToTarget: "30000.00",
				fundingStatus: "EMPTY",
				progressPercentage: 0,
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				priority: 1,
				latestRevisionNo: 1,
				createdAt: new Date(OCCURRED_AT),
				updatedAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				"/short-term-goals",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "create-k1",
					},
					body: JSON.stringify({
						midasAccountId: MIDAS_ACCOUNT_ID,
						name: "New Phone",
						fundingTarget: "30000.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(201);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.goal.goalId).toBe(GOAL_ID);
			expect(body.idempotentReplay).toBe(false);
		});

		it("rejects unknown field in payload with 400", async () => {
			const res = await app.request(
				"/short-term-goals",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "create-k2",
					},
					body: JSON.stringify({
						midasAccountId: MIDAS_ACCOUNT_ID,
						name: "New Phone",
						fundingTarget: "30000.00",
						occurredAt: OCCURRED_AT,
						unknownField: "malicious",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("SHORT_TERM_GOAL_INVALID_INPUT");
		});
	});

	// --- 5. POST /short-term-goals/reorder ---
	describe("POST /short-term-goals/reorder", () => {
		it("reorders goals and returns 200", async () => {
			vi.spyOn(serviceModule, "reorderShortTermGoals").mockResolvedValue({
				priorityRevisionId: "rev-1",
				revisionNo: 2,
				orderedGoalIds: [GOAL_ID],
				idempotentReplay: false,
			});

			const res = await app.request(
				"/short-term-goals/reorder",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "reorder-k1",
					},
					body: JSON.stringify({
						midasAccountId: MIDAS_ACCOUNT_ID,
						orderedGoalIds: [GOAL_ID],
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.reorder.orderedGoalIds).toEqual([GOAL_ID]);
		});
	});

	// --- 6. POST /short-term-goals/:id/fund & /release ---
	describe("POST /short-term-goals/:id/fund and /release", () => {
		it("funds goal and returns 200", async () => {
			vi.spyOn(serviceModule, "fundShortTermGoal").mockResolvedValue({
				goalId: GOAL_ID,
				transferId: "66666666-6666-4666-8666-666666666666",
				amount: "5000.00",
				idempotentReplay: false,
			});

			const res = await app.request(
				`/short-term-goals/${GOAL_ID}/fund`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "fund-k1",
					},
					body: JSON.stringify({
						amount: "5000.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.funding.amount).toBe("5000.00");
		});

		it("releases goal funding and returns 200", async () => {
			vi.spyOn(serviceModule, "releaseShortTermGoalFunding").mockResolvedValue({
				goalId: GOAL_ID,
				transferId: "77777777-7777-4777-8777-777777777777",
				amount: "2000.00",
				idempotentReplay: false,
			});

			const res = await app.request(
				`/short-term-goals/${GOAL_ID}/release`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "release-k1",
					},
					body: JSON.stringify({
						amount: "2000.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.release.amount).toBe("2000.00");
		});
	});
});
