import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { NotificationError } from "../src/notifications/errors";
import * as eventsModule from "../src/notifications/events";
import * as subscriptionsModule from "../src/notifications/subscriptions";

// -----------------------------------------------------------------------
// Test constants
// -----------------------------------------------------------------------

const U1 = "11111111-1111-4111-8111-111111111111";
const SUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENDPOINT = "https://push.example.com/token-abc123";
const P256DH = "a".repeat(88);
const AUTH_KEY = "b".repeat(24);
const OCCURRED_AT = "2026-09-22T09:00:00.000Z";
const DATE = "2026-09-22";
const COOKIE = "__Host-gg_session=valid-token";
const ORIGIN = "http://localhost:8787";

const mockEnv = {
	DATABASE_URL: "postgresql://user:password@example.invalid/db",
	WEBAUTHN_RP_ID: "localhost",
	WEBAUTHN_RP_NAME: "Gelir Gider",
	WEBAUTHN_ORIGIN: ORIGIN,
	BOOTSTRAP_TOKEN_HASH: "0".repeat(64),
	AUTH_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

// -----------------------------------------------------------------------
// Auth middleware shim (same pattern as budget-v2-http.test.ts)
// -----------------------------------------------------------------------

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
			c.set("auth", { userId: U1, displayName: "U1", sessionId: "sess-1" });
			return next();
		},
	};
});

const { app } = await import("../src/index");

interface ErrBody {
	error: { code: string; message: string };
}

const MOCK_SUBSCRIPTION = {
	subscriptionId: SUB_ID,
	userId: U1,
	status: "ACTIVE" as const,
	revisionNo: 1,
	endpoint: ENDPOINT,
	p256dh: P256DH,
	auth: AUTH_KEY,
	expirationTime: null,
	userAgent: null,
	createdAt: new Date(OCCURRED_AT),
};

const MOCK_EVENT = {
	id: EVT_ID,
	userId: U1,
	notificationType: "CREDIT_CARD_DUE" as const,
	subjectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	scheduledLocalDate: DATE,
	scheduledFor: new Date("2026-09-22T09:00:00.000Z"),
	payload: {
		title: "Test",
		body: "Test body",
		data: {
			type: "CREDIT_CARD_DUE",
			statementId: "x",
			creditCardId: "y",
			dueDate: DATE,
			deepLink: "/credit-cards/statements/x",
		},
	},
	createdAt: new Date(OCCURRED_AT),
};

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as never);
	mockEnv.AUTH_RATE_LIMITER = {
		limit: vi.fn().mockResolvedValue({ success: true }),
	};
});

// -----------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------

describe("Notifications HTTP — authentication", () => {
	it("A: rejects GET /subscriptions/:id without session (401)", async () => {
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}`,
			{ method: "GET" },
			mockEnv,
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as ErrBody).error.code).toBe("UNAUTHENTICATED");
	});

	it("A: rejects GET /subscriptions without session (401)", async () => {
		const res = await app.request(
			"/notifications/subscriptions",
			{ method: "GET" },
			mockEnv,
		);
		expect(res.status).toBe(401);
	});

	it("A: rejects GET /events without session (401)", async () => {
		const res = await app.request(
			"/notifications/events",
			{ method: "GET" },
			mockEnv,
		);
		expect(res.status).toBe(401);
	});
});

// -----------------------------------------------------------------------
// Same-origin mutation guard
// -----------------------------------------------------------------------

describe("Notifications HTTP — same-origin guard", () => {
	it("B: POST /subscriptions without Origin → 403 INVALID_ORIGIN", async () => {
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					"content-type": "application/json",
					"Idempotency-Key": "idem-1",
				},
				body: JSON.stringify({
					endpoint: ENDPOINT,
					p256dh: P256DH,
					auth: AUTH_KEY,
					occurredAt: OCCURRED_AT,
				}),
			},
			mockEnv,
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as ErrBody).error.code).toBe("INVALID_ORIGIN");
	});

	it("B: POST /subscriptions/:id/disable without Origin → 403", async () => {
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}/disable`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					"content-type": "application/json",
					"Idempotency-Key": "idem-2",
				},
				body: JSON.stringify({ occurredAt: OCCURRED_AT }),
			},
			mockEnv,
		);
		expect(res.status).toBe(403);
	});
});

// -----------------------------------------------------------------------
// GET /notifications/subscriptions/:id
// -----------------------------------------------------------------------

describe("Notifications HTTP — GET /subscriptions/:id", () => {
	it("C: owner → 200 with subscription body", async () => {
		vi.spyOn(subscriptionsModule, "getPushSubscription").mockResolvedValue(
			MOCK_SUBSCRIPTION,
		);
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.subscriptionId).toBe(SUB_ID);
		expect(body.status).toBe("ACTIVE");
		expect(body.p256dh).toBeUndefined();
		expect(body.auth).toBeUndefined();
		expect(body.endpoint).toBeUndefined();
	});

	it("C: other user's subscription → 404", async () => {
		vi.spyOn(subscriptionsModule, "getPushSubscription").mockResolvedValue(
			null,
		);
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as ErrBody).error.code).toBe(
			"NOTIFICATION_SUBSCRIPTION_NOT_FOUND",
		);
	});

	it("C: non-UUID id → 404", async () => {
		const res = await app.request(
			"/notifications/subscriptions/not-a-uuid",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(404);
	});
});

// -----------------------------------------------------------------------
// GET /notifications/subscriptions (list)
// -----------------------------------------------------------------------

describe("Notifications HTTP — GET /subscriptions (list)", () => {
	it("D: returns bounded list with nextCursor and strips credentials", async () => {
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({
			execute: vi.fn().mockResolvedValue([
				{
					subscription_id: SUB_ID,
					user_id: U1,
					created_at: new Date(),
					revision_no: 1,
					status: "ACTIVE",
					endpoint: ENDPOINT,
					p256dh: P256DH,
					auth: AUTH_KEY,
					expiration_time: null,
					user_agent: null,
				},
			]),
		} as never);
		const res = await app.request(
			"/notifications/subscriptions?limit=10",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Array<Record<string, unknown>>;
			nextCursor: unknown;
		};
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items[0]?.subscriptionId).toBe(SUB_ID);
		expect(body.items[0]?.p256dh).toBeUndefined();
		expect(body.items[0]?.auth).toBeUndefined();
		expect(body.items[0]?.endpoint).toBeUndefined();
		expect("nextCursor" in body).toBe(true);
	});

	it("D: invalid status → 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions?status=INVALID",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("D: valid status filter ACTIVE passes", async () => {
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({
			execute: vi.fn().mockResolvedValue([]),
		} as never);
		const res = await app.request(
			"/notifications/subscriptions?status=ACTIVE",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
	});

	it("D: limit > 100 → 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions?limit=101",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("D: unknown query param → 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions?unknown=x",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("D: invalid after cursor → 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions?after=not-a-uuid",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});
});

// -----------------------------------------------------------------------
// POST /notifications/subscriptions
// -----------------------------------------------------------------------

describe("Notifications HTTP — POST /subscriptions (register)", () => {
	const registerBody = {
		endpoint: ENDPOINT,
		p256dh: P256DH,
		auth: AUTH_KEY,
		occurredAt: OCCURRED_AT,
	};

	it("E: fresh registration → 201", async () => {
		vi.spyOn(subscriptionsModule, "registerPushSubscription").mockResolvedValue(
			{
				subscription: MOCK_SUBSCRIPTION,
				idempotentReplay: false,
			},
		);
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-fresh-1",
				},
				body: JSON.stringify(registerBody),
			},
			mockEnv,
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.subscriptionId).toBe(SUB_ID);
		expect(body.idempotentReplay).toBe(false);
	});

	it("E: exact replay → 200", async () => {
		vi.spyOn(subscriptionsModule, "registerPushSubscription").mockResolvedValue(
			{
				subscription: MOCK_SUBSCRIPTION,
				idempotentReplay: true,
			},
		);
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-replay-1",
				},
				body: JSON.stringify(registerBody),
			},
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as Record<string, unknown>).idempotentReplay,
		).toBe(true);
	});

	it("E: same key different payload → 409 IDEMPOTENCY_CONFLICT", async () => {
		vi.spyOn(subscriptionsModule, "registerPushSubscription").mockRejectedValue(
			new NotificationError("NOTIFICATION_IDEMPOTENCY_CONFLICT", "Conflict"),
		);
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-conflict-1",
				},
				body: JSON.stringify(registerBody),
			},
			mockEnv,
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as ErrBody).error.code).toBe(
			"NOTIFICATION_IDEMPOTENCY_CONFLICT",
		);
	});

	it("E: unknown body field → 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-x",
				},
				body: JSON.stringify({ ...registerBody, unknownField: "bad" }),
			},
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("E: missing Idempotency-Key → 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
				},
				body: JSON.stringify(registerBody),
			},
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("E: missing occurredAt → domain error 400", async () => {
		const res = await app.request(
			"/notifications/subscriptions",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-no-oat",
				},
				body: JSON.stringify({
					endpoint: ENDPOINT,
					p256dh: P256DH,
					auth: AUTH_KEY,
				}),
			},
			mockEnv,
		);
		expect(res.status).toBe(400);
	});
});

// -----------------------------------------------------------------------
// POST /notifications/subscriptions/:id/disable
// -----------------------------------------------------------------------

describe("Notifications HTTP — POST /subscriptions/:id/disable", () => {
	it("F: success → 200", async () => {
		vi.spyOn(subscriptionsModule, "disablePushSubscription").mockResolvedValue({
			subscription: { ...MOCK_SUBSCRIPTION, status: "DISABLED" },
			idempotentReplay: false,
		});
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}/disable`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-disable-1",
				},
				body: JSON.stringify({ occurredAt: OCCURRED_AT }),
			},
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as Record<string, unknown>).status).toBe(
			"DISABLED",
		);
	});

	it("F: exact replay → 200 idempotentReplay=true", async () => {
		vi.spyOn(subscriptionsModule, "disablePushSubscription").mockResolvedValue({
			subscription: { ...MOCK_SUBSCRIPTION, status: "DISABLED" },
			idempotentReplay: true,
		});
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}/disable`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-disable-replay",
				},
				body: JSON.stringify({ occurredAt: OCCURRED_AT }),
			},
			mockEnv,
		);
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as Record<string, unknown>).idempotentReplay,
		).toBe(true);
	});

	it("F: unknown subscription → 404", async () => {
		vi.spyOn(subscriptionsModule, "disablePushSubscription").mockRejectedValue(
			new NotificationError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "Not found"),
		);
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}/disable`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-disable-missing",
				},
				body: JSON.stringify({ occurredAt: OCCURRED_AT }),
			},
			mockEnv,
		);
		expect(res.status).toBe(404);
	});

	it("F: unknown body field → 400", async () => {
		const res = await app.request(
			`/notifications/subscriptions/${SUB_ID}/disable`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"content-type": "application/json",
					"Idempotency-Key": "idem-disable-bad",
				},
				body: JSON.stringify({ occurredAt: OCCURRED_AT, badField: "x" }),
			},
			mockEnv,
		);
		expect(res.status).toBe(400);
	});
});

// -----------------------------------------------------------------------
// GET /notifications/events/:id
// -----------------------------------------------------------------------

describe("Notifications HTTP — GET /events/:id", () => {
	it("G: owner → 200, privacy-safe payload (no financial amounts)", async () => {
		vi.spyOn(eventsModule, "getNotificationEvent").mockResolvedValue(
			MOCK_EVENT,
		);
		const res = await app.request(
			`/notifications/events/${EVT_ID}`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe(EVT_ID);
		expect(body.notificationType).toBe("CREDIT_CARD_DUE");
		// Payload intentionally not exposed at HTTP layer
		expect(body.payload).toBeUndefined();
		// No financial fields
		expect(body.amount).toBeUndefined();
		expect(body.balance).toBeUndefined();
	});

	it("G: other user's event → 404", async () => {
		vi.spyOn(eventsModule, "getNotificationEvent").mockRejectedValue(
			new NotificationError("NOTIFICATION_EVENT_NOT_FOUND", "Not found"),
		);
		const res = await app.request(
			`/notifications/events/${EVT_ID}`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(404);
		expect(((await res.json()) as ErrBody).error.code).toBe(
			"NOTIFICATION_EVENT_NOT_FOUND",
		);
	});

	it("G: non-UUID id → 404", async () => {
		const res = await app.request(
			"/notifications/events/not-a-uuid",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(404);
	});
});

// -----------------------------------------------------------------------
// GET /notifications/events (list)
// -----------------------------------------------------------------------

describe("Notifications HTTP — GET /events (list)", () => {
	it("H: date filter → 200 bounded list", async () => {
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						orderBy: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			}),
		} as never);
		const res = await app.request(
			`/notifications/events?date=${DATE}`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: unknown[];
			nextCursor: unknown;
		};
		expect(Array.isArray(body.items)).toBe(true);
		expect("nextCursor" in body).toBe(true);
	});

	it("H: missing date → 400", async () => {
		const res = await app.request(
			"/notifications/events",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("H: invalid date format → 400", async () => {
		const res = await app.request(
			"/notifications/events?date=2026-13-01",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("H: impossible date → 400", async () => {
		const res = await app.request(
			"/notifications/events?date=2026-02-30",
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("H: limit > 100 → 400", async () => {
		const res = await app.request(
			`/notifications/events?date=${DATE}&limit=101`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("H: unknown query param → 400", async () => {
		const res = await app.request(
			`/notifications/events?date=${DATE}&extra=x`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(400);
	});

	it("H: valid after cursor passes validation", async () => {
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						orderBy: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			}),
		} as never);
		const res = await app.request(
			`/notifications/events?date=${DATE}&after=${EVT_ID}`,
			{ method: "GET", headers: { Cookie: COOKIE } },
			mockEnv,
		);
		expect(res.status).toBe(200);
	});
});
