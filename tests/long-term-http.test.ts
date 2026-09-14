import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import * as productReadModule from "../src/long-term/product-read";
import * as serviceModule from "../src/long-term/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const MIDAS_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const _DESTINATION_LEDGER_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const TRANSACTION_ID = "55555555-5555-4555-8555-555555555555";

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

describe("Long-Term Investment Product HTTP Surface (Checkpoint 7B.7)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: mock DB
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	// --- 1. Authentication Gates on All 6 Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/long-term/tasks", method: "GET" },
			{ path: `/long-term/tasks/${TASK_ID}`, method: "GET" },
			{ path: "/long-term/tasks", method: "POST" },
			{ path: `/long-term/tasks/${TASK_ID}/mark-sent`, method: "POST" },
			{ path: `/long-term/tasks/${TASK_ID}/reopen`, method: "POST" },
			{ path: `/long-term/tasks/${TASK_ID}/cancel`, method: "POST" },
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

	// --- 2. GET /long-term/tasks Keyset Listing ---
	describe("GET /long-term/tasks", () => {
		it("lists tasks successfully with cursor pagination", async () => {
			const mockTask: productReadModule.LongTermTaskProductDto = {
				taskId: TASK_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				status: "PENDING",
				amount: "10000.00",
				destinationLabel: "Monthly ETF Purchase",
				note: "Notes",
				pendingBucketId: "99999999-9999-4999-8999-999999999999",
				revisionNo: 1,
				allocatedAt: OCCURRED_AT,
				sentAt: null,
				latestMidasAllocationTransferId: "88888888-8888-4888-8888-888888888888",
				currentSendCanonicalTransactionId: null,
				currentSendCanonicalRevisionId: null,
				createdAt: OCCURRED_AT,
			};

			vi.spyOn(productReadModule, "listBoundedLongTermTasks").mockResolvedValue(
				{
					tasks: [mockTask],
					hasMore: false,
					nextCursor: null,
				},
			);

			const res = await app.request(
				`/long-term/tasks?status=PENDING&limit=10`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.tasks).toHaveLength(1);
			expect(body.tasks[0].taskId).toBe(TASK_ID);
			expect(body.tasks[0].status).toBe("PENDING");
			expect(body.hasMore).toBe(false);
		});

		it("rejects invalid status filter with 400", async () => {
			const res = await app.request(
				"/long-term/tasks?status=INVALID_STATUS",
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LONG_TERM_INVALID_INPUT");
		});
	});

	// --- 3. GET /long-term/tasks/:id Detail ---
	describe("GET /long-term/tasks/:id", () => {
		it("returns task detail when found", async () => {
			vi.spyOn(serviceModule, "getLongTermInvestmentTask").mockResolvedValue({
				taskId: TASK_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				status: "PENDING",
				amount: "7500.00",
				destinationLabel: "Eurobond investment",
				note: null,
				pendingBucketId: "99999999-9999-4999-8999-999999999999",
				revisionNo: 1,
				allocatedAt: new Date(OCCURRED_AT),
				sentAt: null,
				latestMidasAllocationTransferId: "88888888-8888-4888-8888-888888888888",
				currentSendCanonicalTransactionId: null,
				currentSendCanonicalRevisionId: null,
				createdAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/long-term/tasks/${TASK_ID}`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.task.taskId).toBe(TASK_ID);
			expect(body.task.amount).toBe("7500.00");
		});

		it("returns 404 when task not found", async () => {
			vi.spyOn(serviceModule, "getLongTermInvestmentTask").mockResolvedValue(
				null,
			);

			const res = await app.request(
				`/long-term/tasks/${TASK_ID}`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LONG_TERM_TASK_NOT_FOUND");
		});
	});

	// --- 4. POST /long-term/tasks (Allocate & Create Task) ---
	describe("POST /long-term/tasks", () => {
		it("creates send task and returns 201", async () => {
			vi.spyOn(serviceModule, "allocateLongTermInvestment").mockResolvedValue({
				task: {
					taskId: TASK_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					status: "PENDING",
					amount: "15000.00",
					destinationLabel: "Global Equity",
					note: null,
					pendingBucketId: "99999999-9999-4999-8999-999999999999",
					revisionNo: 1,
					allocatedAt: new Date(OCCURRED_AT),
					sentAt: null,
					latestMidasAllocationTransferId:
						"88888888-8888-4888-8888-888888888888",
					currentSendCanonicalTransactionId: null,
					currentSendCanonicalRevisionId: null,
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				"/long-term/tasks",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "task-k1",
					},
					body: JSON.stringify({
						midasAccountId: MIDAS_ACCOUNT_ID,
						amount: "15000.00",
						destinationLabel: "Global Equity",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(201);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.task.taskId).toBe(TASK_ID);
			expect(body.task.amount).toBe("15000.00");
			expect(body.idempotentReplay).toBe(false);
		});
	});

	// --- 5. Lifecycle Operations: mark-sent, reopen, cancel ---
	describe("POST /long-term/tasks/:id lifecycle transitions", () => {
		it("marks task as sent and returns 200", async () => {
			vi.spyOn(serviceModule, "markLongTermInvestmentSent").mockResolvedValue({
				task: {
					taskId: TASK_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					status: "SENT",
					amount: "15000.00",
					destinationLabel: "Global Equity",
					note: null,
					pendingBucketId: "99999999-9999-4999-8999-999999999999",
					revisionNo: 2,
					allocatedAt: new Date(OCCURRED_AT),
					sentAt: new Date(OCCURRED_AT),
					latestMidasAllocationTransferId:
						"88888888-8888-4888-8888-888888888888",
					currentSendCanonicalTransactionId: TRANSACTION_ID,
					currentSendCanonicalRevisionId: "rev-1",
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/long-term/tasks/${TASK_ID}/mark-sent`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "sent-k1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.task.status).toBe("SENT");
			expect(body.task.currentSendCanonicalTransactionId).toBe(TRANSACTION_ID);
		});

		it("reopens sent task and returns 200", async () => {
			vi.spyOn(serviceModule, "reopenLongTermInvestmentSend").mockResolvedValue(
				{
					task: {
						taskId: TASK_ID,
						midasAccountId: MIDAS_ACCOUNT_ID,
						status: "PENDING",
						amount: "15000.00",
						destinationLabel: "Global Equity",
						note: null,
						pendingBucketId: "99999999-9999-4999-8999-999999999999",
						revisionNo: 3,
						allocatedAt: new Date(OCCURRED_AT),
						sentAt: null,
						latestMidasAllocationTransferId:
							"88888888-8888-4888-8888-888888888888",
						currentSendCanonicalTransactionId: null,
						currentSendCanonicalRevisionId: null,
						createdAt: new Date(OCCURRED_AT),
					},
					idempotentReplay: false,
				},
			);

			const res = await app.request(
				`/long-term/tasks/${TASK_ID}/reopen`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "reopen-k1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 2,
						reasonNote: "Sent in error",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.task.status).toBe("PENDING");
		});

		it("cancels pending task and returns 200", async () => {
			vi.spyOn(serviceModule, "cancelLongTermInvestmentTask").mockResolvedValue(
				{
					task: {
						taskId: TASK_ID,
						midasAccountId: MIDAS_ACCOUNT_ID,
						status: "CANCELLED",
						amount: "15000.00",
						destinationLabel: "Global Equity",
						note: null,
						pendingBucketId: "99999999-9999-4999-8999-999999999999",
						revisionNo: 2,
						allocatedAt: new Date(OCCURRED_AT),
						sentAt: null,
						latestMidasAllocationTransferId:
							"88888888-8888-4888-8888-888888888888",
						currentSendCanonicalTransactionId: null,
						currentSendCanonicalRevisionId: null,
						createdAt: new Date(OCCURRED_AT),
					},
					idempotentReplay: false,
				},
			);

			const res = await app.request(
				`/long-term/tasks/${TASK_ID}/cancel`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "cancel-k1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						reasonNote: "No longer needed",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.task.status).toBe("CANCELLED");
		});
	});
});
