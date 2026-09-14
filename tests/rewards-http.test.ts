import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import * as accountsModule from "../src/rewards/accounts";
import { RewardError } from "../src/rewards/errors";
import * as eventsModule from "../src/rewards/events";
import * as productReadModule from "../src/rewards/product-read";

const U1 = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const CARD_ID = "44444444-4444-4444-8444-444444444444";
const GOAL_ID = "55555555-5555-4555-8555-555555555555";

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

describe("Rewards Product HTTP Surface (Checkpoint 7B.5)", () => {
	let mockDbSelect: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.restoreAllMocks();

		mockDbSelect = vi.fn().mockImplementation(() => {
			const whereObj = {
				limit: vi.fn().mockResolvedValue([]),
				// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable mock
				then: (resolve: (v: unknown[]) => void) =>
					Promise.resolve([]).then(resolve),
			};
			return {
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue(whereObj),
					// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable mock
					then: (resolve: (v: unknown[]) => void) =>
						Promise.resolve([]).then(resolve),
				}),
			};
		});

		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({
			select: mockDbSelect,
			// biome-ignore lint/suspicious/noExplicitAny: mock DB
		} as any);
	});

	// --- 1. Authentication Gates on All 14 Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/rewards/accounts", method: "GET" },
			{ path: `/rewards/accounts/${ACCOUNT_ID}`, method: "GET" },
			{ path: "/rewards/accounts", method: "POST" },
			{ path: `/rewards/accounts/${ACCOUNT_ID}`, method: "POST" },
			{ path: `/rewards/accounts/${ACCOUNT_ID}/archive`, method: "POST" },
			{ path: `/rewards/accounts/${ACCOUNT_ID}/events`, method: "GET" },
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}`,
				method: "GET",
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/opening-balance`,
				method: "POST",
			},
			{ path: `/rewards/accounts/${ACCOUNT_ID}/events/earn`, method: "POST" },
			{ path: `/rewards/accounts/${ACCOUNT_ID}/events/expire`, method: "POST" },
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/adjustment-credit`,
				method: "POST",
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/adjustment-debit`,
				method: "POST",
			},
			{ path: `/rewards/accounts/${ACCOUNT_ID}/purchases`, method: "POST" },
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}/void`,
				method: "POST",
			},
		];

		for (const route of routes) {
			it(`requires authentication for ${route.method} ${route.path}`, async () => {
				const reqInit: RequestInit = {
					method: route.method,
					headers:
						route.method === "POST"
							? { "Content-Type": "application/json", Origin: ORIGIN }
							: {},
				};
				if (route.method === "POST") {
					reqInit.body = JSON.stringify({});
				}
				const res = await app.request(route.path, reqInit, mockEnv);
				expect(res.status).toBe(401);
				const data = (await res.json()) as ErrBody;
				expect(data.error.code).toBe("UNAUTHENTICATED");
			});
		}
	});

	// --- 2. Same-Origin Mutation Guard on All 10 Mutation Routes ---
	describe("Same-Origin mutation guard", () => {
		const mutationRoutes = [
			{ path: "/rewards/accounts", body: { code: "TEST_WALLET" } },
			{
				path: `/rewards/accounts/${ACCOUNT_ID}`,
				body: { displayName: "Wallet" },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/archive`,
				body: { expectedRevisionNo: 1 },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/opening-balance`,
				body: { pointAmount: "100.0000" },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/earn`,
				body: { pointAmount: "50.0000" },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/expire`,
				body: { pointAmount: "20.0000" },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/adjustment-credit`,
				body: { pointAmount: "10.0000" },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/adjustment-debit`,
				body: { pointAmount: "10.0000" },
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/purchases`,
				body: {
					pointAmount: "100.0000",
					purchaseCategory: "DISCRETIONARY_SPEND",
				},
			},
			{
				path: `/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}/void`,
				body: { expectedRevisionNo: 1 },
			},
		];

		for (const route of mutationRoutes) {
			it(`rejects cross-origin POST ${route.path} without matching Origin`, async () => {
				const res = await app.request(
					route.path,
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							"Content-Type": "application/json",
							"Idempotency-Key": "test-idem-key",
							Origin: "http://evil-site.invalid",
						},
						body: JSON.stringify(route.body),
					},
					mockEnv,
				);
				expect(res.status).toBe(403);
				const data = (await res.json()) as ErrBody;
				expect(data.error.code).toBe("INVALID_ORIGIN");
			});
		}
	});

	// --- 3. Transport Validations & Closed Bodies ---
	describe("Transport validations", () => {
		it("rejects unknown query parameters on GET /rewards/accounts", async () => {
			const res = await app.request(
				"/rewards/accounts?unknownKey=123",
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_INVALID_INPUT");
		});

		it("rejects duplicate query parameters on GET /rewards/accounts", async () => {
			const res = await app.request(
				"/rewards/accounts?status=ACTIVE&status=ARCHIVED",
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_INVALID_INPUT");
		});

		it("rejects invalid status filter on GET /rewards/accounts", async () => {
			const res = await app.request(
				"/rewards/accounts?status=INVALID_STATUS",
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_INVALID_INPUT");
		});

		it("rejects missing Idempotency-Key on POST /rewards/accounts", async () => {
			const res = await app.request(
				"/rewards/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "TEST_WALLET",
						displayName: "Test Wallet",
						provider: "Bank",
						unitName: "Points",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_INVALID_INPUT");
		});

		it("rejects extra unknown fields in closed request body", async () => {
			const res = await app.request(
				"/rewards/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-extra",
					},
					body: JSON.stringify({
						code: "TEST_WALLET",
						displayName: "Test Wallet",
						provider: "Bank",
						unitName: "Points",
						occurredAt: OCCURRED_AT,
						unknownField: "malicious_payload",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_INVALID_INPUT");
		});
	});

	// --- 4. Reward Accounts Surface ---
	describe("Reward accounts surface", () => {
		const mockAccountDto = {
			rewardAccountId: ACCOUNT_ID,
			code: "MAXIPUAN",
			status: "ACTIVE" as const,
			displayName: "MaxiPuan Cüzdanı",
			provider: "İş Bankası",
			unitName: "Puan",
			creditCardId: CARD_ID,
			defaultConversionRate: "1.000000",
			balancePoints: "1000.0000",
			estimatedCurrentValue: "1000.00",
			revisionNo: 1,
			occurredAt: OCCURRED_AT,
			createdAt: OCCURRED_AT,
		};

		it("GET /rewards/accounts lists bounded accounts", async () => {
			vi.spyOn(
				productReadModule,
				"listBoundedRewardAccounts",
			).mockResolvedValue({
				accounts: [mockAccountDto],
				hasMore: false,
				nextCursor: null,
			});

			const res = await app.request(
				"/rewards/accounts",
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.accounts).toHaveLength(1);
			expect(data.accounts[0].code).toBe("MAXIPUAN");
		});

		it("GET /rewards/accounts/:id returns single account", async () => {
			vi.spyOn(accountsModule, "getRewardAccount").mockResolvedValue({
				...mockAccountDto,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.account.rewardAccountId).toBe(ACCOUNT_ID);
		});

		it("GET /rewards/accounts/:id returns 404 when not found", async () => {
			vi.spyOn(accountsModule, "getRewardAccount").mockResolvedValue(null);

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(404);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_ACCOUNT_NOT_FOUND");
		});

		it("POST /rewards/accounts creates new account (201) and handles replay (200)", async () => {
			vi.spyOn(accountsModule, "createRewardAccount").mockResolvedValue({
				account: {
					...mockAccountDto,
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const resFresh = await app.request(
				"/rewards/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-create-wallet",
					},
					body: JSON.stringify({
						code: "MAXIPUAN",
						displayName: "MaxiPuan Cüzdanı",
						provider: "İş Bankası",
						unitName: "Puan",
						creditCardId: CARD_ID,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(resFresh.status).toBe(201);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const dataFresh = (await resFresh.json()) as any;
			expect(dataFresh.account.code).toBe("MAXIPUAN");
			expect(dataFresh.idempotentReplay).toBe(false);

			// Replay returns 200
			vi.spyOn(accountsModule, "createRewardAccount").mockResolvedValue({
				account: {
					...mockAccountDto,
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: true,
			});

			const resReplay = await app.request(
				"/rewards/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-create-wallet",
					},
					body: JSON.stringify({
						code: "MAXIPUAN",
						displayName: "MaxiPuan Cüzdanı",
						provider: "İş Bankası",
						unitName: "Puan",
						creditCardId: CARD_ID,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(resReplay.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const dataReplay = (await resReplay.json()) as any;
			expect(dataReplay.idempotentReplay).toBe(true);
		});

		it("POST /rewards/accounts/:id updates account mutable configuration", async () => {
			vi.spyOn(accountsModule, "updateRewardAccount").mockResolvedValue({
				account: {
					...mockAccountDto,
					displayName: "Updated MaxiPuan",
					revisionNo: 2,
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-update-wallet",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						displayName: "Updated MaxiPuan",
						provider: "İş Bankası",
						unitName: "Puan",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.account.displayName).toBe("Updated MaxiPuan");
			expect(data.account.revisionNo).toBe(2);
		});

		it("POST /rewards/accounts/:id/archive archives account with zero balance", async () => {
			vi.spyOn(accountsModule, "archiveRewardAccount").mockResolvedValue({
				account: {
					...mockAccountDto,
					status: "ARCHIVED",
					revisionNo: 2,
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/archive`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-archive-wallet",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.account.status).toBe("ARCHIVED");
		});
	});

	// --- 5. Reward Events Surface ---
	describe("Reward events surface", () => {
		const mockEventDto = {
			rewardEventId: EVENT_ID,
			rewardAccountId: ACCOUNT_ID,
			eventType: "EARN" as const,
			status: "ACTIVE" as const,
			revisionNo: 1,
			pointAmount: "500.0000",
			signedPointEffect: "500.0000",
			conversionRate: "1.000000",
			economicAmount: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: null,
			reasonNote: "Monthly salary bonus",
			sourceType: "MANUAL" as const,
			occurredAt: OCCURRED_AT,
			createdAt: OCCURRED_AT,
		};

		it("GET /rewards/accounts/:accountId/events lists events", async () => {
			vi.spyOn(accountsModule, "getRewardAccount").mockResolvedValue({
				rewardAccountId: ACCOUNT_ID,
				code: "MAXIPUAN",
				status: "ACTIVE",
				displayName: "MaxiPuan",
				provider: "İş Bankası",
				unitName: "Puan",
				creditCardId: null,
				defaultConversionRate: "1.000000",
				balancePoints: "500.0000",
				estimatedCurrentValue: "500.00",
				revisionNo: 1,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});
			vi.spyOn(productReadModule, "listBoundedRewardEvents").mockResolvedValue({
				events: [mockEventDto],
				hasMore: false,
				nextCursor: null,
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.events).toHaveLength(1);
			expect(data.events[0].rewardEventId).toBe(EVENT_ID);
		});

		it("GET /rewards/accounts/:accountId/events/:eventId returns single event", async () => {
			vi.spyOn(accountsModule, "getRewardAccount").mockResolvedValue({
				rewardAccountId: ACCOUNT_ID,
				code: "MAXIPUAN",
				status: "ACTIVE",
				displayName: "MaxiPuan",
				provider: "İş Bankası",
				unitName: "Puan",
				creditCardId: null,
				defaultConversionRate: "1.000000",
				balancePoints: "500.0000",
				estimatedCurrentValue: "500.00",
				revisionNo: 1,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});
			vi.spyOn(eventsModule, "getRewardEvent").mockResolvedValue({
				...mockEventDto,
				canonicalTransactionId: null,
				canonicalRevisionId: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.event.rewardEventId).toBe(EVENT_ID);
		});

		it("GET /rewards/accounts/:accountId/events/:eventId returns 404 on path accountId mismatch", async () => {
			vi.spyOn(accountsModule, "getRewardAccount").mockResolvedValue({
				rewardAccountId: ACCOUNT_ID,
				code: "MAXIPUAN",
				status: "ACTIVE",
				displayName: "MaxiPuan",
				provider: "İş Bankası",
				unitName: "Puan",
				creditCardId: null,
				defaultConversionRate: "1.000000",
				balancePoints: "500.0000",
				estimatedCurrentValue: "500.00",
				revisionNo: 1,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});
			// Event belongs to ANOTHER account
			vi.spyOn(eventsModule, "getRewardEvent").mockResolvedValue({
				...mockEventDto,
				rewardAccountId: "99999999-9999-4999-8999-999999999999",
				canonicalTransactionId: null,
				canonicalRevisionId: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(404);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_EVENT_NOT_FOUND");
		});

		it("POST /rewards/accounts/:accountId/events/opening-balance records opening balance", async () => {
			vi.spyOn(eventsModule, "recordRewardOpeningBalance").mockResolvedValue({
				event: {
					...mockEventDto,
					eventType: "OPENING_BALANCE",
					signedPointEffect: "1000.0000",
					pointAmount: "1000.0000",
					canonicalTransactionId: null,
					canonicalRevisionId: null,
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events/opening-balance`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-opening",
					},
					body: JSON.stringify({
						pointAmount: "1000.0000",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(201);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.event.eventType).toBe("OPENING_BALANCE");
		});

		it("POST /rewards/accounts/:accountId/purchases records reward-funded purchase", async () => {
			vi.spyOn(eventsModule, "recordRewardPurchase").mockResolvedValue({
				event: {
					...mockEventDto,
					eventType: "REDEEM_PURCHASE",
					pointAmount: "200.0000",
					signedPointEffect: "-200.0000",
					conversionRate: "0.100000",
					economicAmount: "20.00",
					purchaseCategory: "SHORT_TERM_PURCHASE",
					shortTermGoalId: GOAL_ID,
					merchant: "Coffee Shop",
					description: "Espresso",
					canonicalTransactionId: "77777777-7777-4777-8777-777777777777",
					canonicalRevisionId: "88888888-8888-4888-8888-888888888888",
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/purchases`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-purchase-coffee",
					},
					body: JSON.stringify({
						pointAmount: "200.0000",
						conversionRateOverride: "0.100000",
						purchaseCategory: "SHORT_TERM_PURCHASE",
						shortTermGoalId: GOAL_ID,
						merchant: "Coffee Shop",
						description: "Espresso",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(201);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.event.eventType).toBe("REDEEM_PURCHASE");
			expect(data.event.economicAmount).toBe("20.00");
			expect(data.event.canonicalTransactionId).toBeUndefined(); // internal ID stripped!
		});

		it("POST /rewards/accounts/:accountId/purchases enforces shortTermGoalId constraints", async () => {
			// SHORT_TERM_PURCHASE without shortTermGoalId -> 400
			const resMissingGoal = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/purchases`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-purchase-missing-goal",
					},
					body: JSON.stringify({
						pointAmount: "200.0000",
						purchaseCategory: "SHORT_TERM_PURCHASE",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(resMissingGoal.status).toBe(400);

			// Other category WITH shortTermGoalId -> 400
			const resForbiddenGoal = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/purchases`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-purchase-forbidden-goal",
					},
					body: JSON.stringify({
						pointAmount: "200.0000",
						purchaseCategory: "DISCRETIONARY_SPEND",
						shortTermGoalId: GOAL_ID,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(resForbiddenGoal.status).toBe(400);
		});

		it("POST /rewards/accounts/:accountId/events/:eventId/void voids manual event", async () => {
			vi.spyOn(eventsModule, "getRewardEvent").mockResolvedValue({
				...mockEventDto,
				canonicalTransactionId: null,
				canonicalRevisionId: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});
			vi.spyOn(eventsModule, "voidManualRewardEvent").mockResolvedValue({
				event: {
					...mockEventDto,
					status: "VOID",
					revisionNo: 2,
					signedPointEffect: "0.0000",
					canonicalTransactionId: null,
					canonicalRevisionId: null,
					occurredAt: new Date(OCCURRED_AT),
					createdAt: new Date(OCCURRED_AT),
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-void-earn",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						reasonNote: "Created in error",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.event.status).toBe("VOID");
		});

		it("POST /rewards/accounts/:accountId/events/:eventId/void rejects CAMPAIGN-owned event with 409", async () => {
			vi.spyOn(eventsModule, "getRewardEvent").mockResolvedValue({
				...mockEventDto,
				canonicalTransactionId: null,
				canonicalRevisionId: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});
			vi.spyOn(eventsModule, "voidManualRewardEvent").mockRejectedValue(
				new RewardError(
					"REWARD_EVENT_EXTERNALLY_MANAGED",
					"Cannot manually void reward event managed by CAMPAIGN",
				),
			);

			const res = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-void-campaign-event",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("REWARD_EVENT_EXTERNALLY_MANAGED");
		});

		it("GET event detail and list return authoritative CAMPAIGN sourceType without fabrication", async () => {
			vi.spyOn(accountsModule, "getRewardAccount").mockResolvedValue({
				rewardAccountId: ACCOUNT_ID,
				code: "MAXIPUAN",
				status: "ACTIVE",
				displayName: "MaxiPuan",
				provider: "İş Bankası",
				unitName: "Puan",
				creditCardId: null,
				defaultConversionRate: "1.000000",
				balancePoints: "500.0000",
				estimatedCurrentValue: "500.00",
				revisionNo: 1,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});

			const campaignEventDto = {
				...mockEventDto,
				sourceType: "CAMPAIGN" as const,
			};

			vi.spyOn(eventsModule, "getRewardEvent").mockResolvedValue({
				rewardEventId: EVENT_ID,
				rewardAccountId: ACCOUNT_ID,
				eventType: "EARN",
				status: "ACTIVE",
				revisionNo: 1,
				pointAmount: "500.0000",
				signedPointEffect: "500.0000",
				conversionRate: "1.000000",
				economicAmount: null,
				purchaseCategory: null,
				shortTermGoalId: null,
				merchant: null,
				description: null,
				reasonNote: "Campaign bonus",
				sourceType: "CAMPAIGN",
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
				canonicalTransactionId: null,
				canonicalRevisionId: null,
			});

			const resDetail = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events/${EVENT_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(resDetail.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const dataDetail = (await resDetail.json()) as any;
			expect(dataDetail.event.sourceType).toBe("CAMPAIGN");
			expect(dataDetail.event.signedPointEffect).toBe("500.0000");
			expect(dataDetail.event.economicAmount).toBeNull();

			vi.spyOn(productReadModule, "listBoundedRewardEvents").mockResolvedValue({
				events: [campaignEventDto],
				hasMore: false,
				nextCursor: null,
			});

			const resList = await app.request(
				`/rewards/accounts/${ACCOUNT_ID}/events`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(resList.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const dataList = (await resList.json()) as any;
			expect(dataList.events[0].sourceType).toBe("CAMPAIGN");
			expect(dataList.events[0].signedPointEffect).toBe("500.0000");
		});

		it("Generic REWARD_INVALID_STATE maps strictly to 500 INTERNAL_ERROR", async () => {
			vi.spyOn(accountsModule, "createRewardAccount").mockRejectedValue(
				new RewardError(
					"REWARD_INVALID_STATE",
					"Unexpected database integrity failure",
				),
			);

			const res = await app.request(
				"/rewards/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-create-crash",
					},
					body: JSON.stringify({
						code: "MAXIPUAN",
						displayName: "MaxiPuan",
						provider: "İş Bankası",
						unitName: "Puan",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(500);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("INTERNAL_ERROR");
		});
	});
});
