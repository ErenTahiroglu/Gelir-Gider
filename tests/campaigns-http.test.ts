import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignError } from "../src/campaigns/errors";
import * as productReadModule from "../src/campaigns/product-read";
import * as serviceModule from "../src/campaigns/service";
import * as sourcesModule from "../src/campaigns/sources";
import * as dbClientModule from "../src/db/client";

const U1 = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";
const PURCHASE_EVENT_ID = "55555555-5555-4555-8555-555555555555";

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

describe("Campaigns Product HTTP Surface (Checkpoint 7B.6)", () => {
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

	// --- 1. Authentication Gates on All 22 Routes ---
	describe("Authentication gates", () => {
		const routes = [
			// Campaign period routes
			{ path: "/campaigns", method: "GET" },
			{ path: `/campaigns/${CAMPAIGN_ID}`, method: "GET" },
			{ path: "/campaigns", method: "POST" },
			{ path: `/campaigns/${CAMPAIGN_ID}/confirm`, method: "POST" },
			{ path: `/campaigns/${CAMPAIGN_ID}/amend`, method: "POST" },
			{ path: `/campaigns/${CAMPAIGN_ID}/hide`, method: "POST" },
			{ path: `/campaigns/${CAMPAIGN_ID}/restore`, method: "POST" },
			{ path: `/campaigns/${CAMPAIGN_ID}/end`, method: "POST" },
			{ path: `/campaigns/${CAMPAIGN_ID}/cancel`, method: "POST" },
			// Progress / Overrides
			{ path: `/campaigns/${CAMPAIGN_ID}/progress`, method: "GET" },
			{ path: `/campaigns/${CAMPAIGN_ID}/progress/purchases`, method: "GET" },
			{ path: `/campaigns/${CAMPAIGN_ID}/overrides`, method: "GET" },
			{
				path: `/campaigns/${CAMPAIGN_ID}/purchases/${PURCHASE_EVENT_ID}/override`,
				method: "POST",
			},
			// Reward Credit
			{ path: `/campaigns/${CAMPAIGN_ID}/reward-credit`, method: "GET" },
			{
				path: `/campaigns/${CAMPAIGN_ID}/reward-credit/confirm`,
				method: "POST",
			},
			{ path: `/campaigns/${CAMPAIGN_ID}/reward-credit/void`, method: "POST" },
			// Review candidates
			{ path: "/campaigns/review-candidates", method: "GET" },
			{ path: `/campaigns/review-candidates/${CANDIDATE_ID}`, method: "GET" },
			{
				path: `/campaigns/review-candidates/${CANDIDATE_ID}/diff`,
				method: "GET",
			},
			{
				path: `/campaigns/review-candidates/${CANDIDATE_ID}/apply`,
				method: "POST",
			},
			{
				path: `/campaigns/review-candidates/${CANDIDATE_ID}/dismiss`,
				method: "POST",
			},
			// Source snapshots
			{ path: `/campaigns/source-snapshots/${SNAPSHOT_ID}`, method: "GET" },
		];

		expect(routes).toHaveLength(22);

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

	// --- 2. Same-Origin Mutation Guard on All 13 Mutation Routes ---
	describe("Same-Origin mutation guard", () => {
		const mutationRoutes = [
			{ path: "/campaigns" },
			{ path: `/campaigns/${CAMPAIGN_ID}/confirm` },
			{ path: `/campaigns/${CAMPAIGN_ID}/amend` },
			{ path: `/campaigns/${CAMPAIGN_ID}/hide` },
			{ path: `/campaigns/${CAMPAIGN_ID}/restore` },
			{ path: `/campaigns/${CAMPAIGN_ID}/end` },
			{ path: `/campaigns/${CAMPAIGN_ID}/cancel` },
			{
				path: `/campaigns/${CAMPAIGN_ID}/purchases/${PURCHASE_EVENT_ID}/override`,
			},
			{ path: `/campaigns/${CAMPAIGN_ID}/reward-credit/confirm` },
			{ path: `/campaigns/${CAMPAIGN_ID}/reward-credit/void` },
			{ path: `/campaigns/review-candidates/${CANDIDATE_ID}/apply` },
			{ path: `/campaigns/review-candidates/${CANDIDATE_ID}/dismiss` },
		];

		for (const route of mutationRoutes) {
			it(`blocks cross-origin POST to ${route.path}`, async () => {
				const res = await app.request(
					route.path,
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							Origin: "http://evil.attacker.invalid",
							"Content-Type": "application/json",
							"Idempotency-Key": "test-key-1",
						},
						body: JSON.stringify({}),
					},
					mockEnv,
				);
				expect(res.status).toBe(403);
			});
		}
	});

	// --- 3. Idempotency-Key Requirement on Mutations ---
	describe("Idempotency-Key header requirement", () => {
		const mutationRoutes = [
			{ path: "/campaigns" },
			{ path: `/campaigns/${CAMPAIGN_ID}/confirm` },
			{ path: `/campaigns/${CAMPAIGN_ID}/amend` },
			{ path: `/campaigns/${CAMPAIGN_ID}/hide` },
			{ path: `/campaigns/${CAMPAIGN_ID}/restore` },
			{ path: `/campaigns/${CAMPAIGN_ID}/end` },
			{ path: `/campaigns/${CAMPAIGN_ID}/cancel` },
			{
				path: `/campaigns/${CAMPAIGN_ID}/purchases/${PURCHASE_EVENT_ID}/override`,
			},
			{ path: `/campaigns/${CAMPAIGN_ID}/reward-credit/confirm` },
			{ path: `/campaigns/${CAMPAIGN_ID}/reward-credit/void` },
			{ path: `/campaigns/review-candidates/${CANDIDATE_ID}/apply` },
			{ path: `/campaigns/review-candidates/${CANDIDATE_ID}/dismiss` },
		];

		for (const route of mutationRoutes) {
			it(`rejects missing Idempotency-Key for POST ${route.path}`, async () => {
				const res = await app.request(
					route.path,
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({}),
					},
					mockEnv,
				);
				expect(res.status).toBe(400);
				const data = (await res.json()) as ErrBody;
				expect(data.error.code).toBe("CAMPAIGN_INVALID_INPUT");
			});
		}
	});

	// --- 4. Closed-Body Schema Rejection (Unknown Keys) ---
	describe("Closed-body rejection", () => {
		it("rejects unknown field in POST /campaigns", async () => {
			const res = await app.request(
				"/campaigns",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-123",
					},
					body: JSON.stringify({
						provider: "Bank Alpha",
						familyKey: "F1",
						periodKey: "2026-09",
						title: "Title",
						startsOn: "2026-09-01",
						endsOn: "2026-09-30",
						ruleMode: "TOTAL_SPEND",
						rewardKind: "INFORMATIONAL",
						merchantScopeMode: "ALL_MERCHANTS",
						cardIds: [],
						occurredAt: OCCURRED_AT,
						unknownSecretField: "malicious",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("CAMPAIGN_INVALID_INPUT");
		});

		it("rejects unknown field in POST /campaigns/:id/confirm", async () => {
			const res = await app.request(
				`/campaigns/${CAMPAIGN_ID}/confirm`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-123",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						occurredAt: OCCURRED_AT,
						extra: "not_allowed",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("CAMPAIGN_INVALID_INPUT");
		});
	});

	// --- 5. Static Route Precedence Proof ---
	describe("Static route precedence", () => {
		it("routes /campaigns/review-candidates correctly without being swallowed by /campaigns/:id", async () => {
			const spy = vi
				.spyOn(productReadModule, "listBoundedCampaignReviewCandidates")
				.mockResolvedValue({
					candidates: [],
					hasMore: false,
					nextCursor: null,
				});

			const res = await app.request(
				"/campaigns/review-candidates",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			expect(spy).toHaveBeenCalled();
		});

		it("routes /campaigns/source-snapshots/:id correctly without being swallowed by /campaigns/:id", async () => {
			const spy = vi
				.spyOn(sourcesModule, "getCampaignSourceSnapshot")
				.mockResolvedValue({
					id: SNAPSHOT_ID,
					userId: U1,
					provider: "Bank Alpha",
					sourceType: "MANUAL",
					sourceUrl: null,
					externalSourceId: null,
					sourceTitle: "Test Snapshot",
					sourceText: "Snapshot details",
					contentHash: "a".repeat(64),
					isDuplicateOfLatest: false,
					capturedAt: new Date(),
					createdAt: new Date(),
				});

			const res = await app.request(
				`/campaigns/source-snapshots/${SNAPSHOT_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			expect(spy).toHaveBeenCalled();
			const data = (await res.json()) as {
				sourceSnapshot: { sourceSnapshotId: string };
			};
			expect(data.sourceSnapshot.sourceSnapshotId).toBe(SNAPSHOT_ID);
		});
	});

	// --- 6. Error Transport Mappings ---
	describe("Error transport mapping", () => {
		it("maps CAMPAIGN_NOT_FOUND to 404", async () => {
			vi.spyOn(serviceModule, "getCampaignPeriod").mockRejectedValue(
				new CampaignError("CAMPAIGN_NOT_FOUND", "Campaign not found"),
			);

			const res = await app.request(
				`/campaigns/${CAMPAIGN_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(404);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("CAMPAIGN_NOT_FOUND");
		});

		it("maps CAMPAIGN_REVISION_CONFLICT to 409", async () => {
			vi.spyOn(serviceModule, "confirmCampaignPeriod").mockRejectedValue(
				new CampaignError("CAMPAIGN_REVISION_CONFLICT", "Revision mismatch"),
			);

			const res = await app.request(
				`/campaigns/${CAMPAIGN_ID}/confirm`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-conf-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("CAMPAIGN_REVISION_CONFLICT");
		});

		it("maps CAMPAIGN_NOT_QUALIFIED to 409", async () => {
			vi.spyOn(
				serviceModule,
				"confirmCampaignRewardCredited",
			).mockRejectedValue(
				new CampaignError("CAMPAIGN_NOT_QUALIFIED", "Not qualified"),
			);

			const res = await app.request(
				`/campaigns/${CAMPAIGN_ID}/reward-credit/confirm`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-rew-1",
					},
					body: JSON.stringify({
						actualPointAmount: "500.0000",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("CAMPAIGN_NOT_QUALIFIED");
		});

		it("maps CAMPAIGN_INVALID_STATE to 500 INTERNAL_ERROR", async () => {
			vi.spyOn(serviceModule, "getCampaignPeriod").mockRejectedValue(
				new CampaignError("CAMPAIGN_INVALID_STATE", "Invariant broken"),
			);

			const res = await app.request(
				`/campaigns/${CAMPAIGN_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(500);
			const data = (await res.json()) as ErrBody;
			expect(data.error.code).toBe("INTERNAL_ERROR");
		});
	});

	// --- 7. DTO Sanitization ---
	describe("Product DTO sanitization", () => {
		it("sanitizes CampaignPeriodProductDto without internal IDs", async () => {
			vi.spyOn(serviceModule, "getCampaignPeriod").mockResolvedValue({
				campaignPeriodId: CAMPAIGN_ID,
				campaignFamilyId: "internal-fam-id",
				provider: "Bank Alpha",
				familyKey: "BONUS_100",
				periodKey: "2026-09",
				revisionId: "internal-rev-id",
				revisionNo: 1,
				operation: "CREATE",
				lifecycleStatus: "ACTIVE",
				visibility: "VISIBLE",
				title: "Bonus Campaign",
				startsOn: "2026-09-01",
				endsOn: "2026-09-30",
				ruleMode: "TOTAL_SPEND",
				targetSpendAmount: "500.00",
				requiredTransactionCount: null,
				minimumTransactionAmount: null,
				stepSpendAmount: null,
				rewardPointsPerStep: null,
				maxSteps: null,
				rewardKind: "REWARD_POINTS",
				rewardAccountId: null,
				expectedRewardPoints: "100.0000",
				merchantScopeMode: "ALL_MERCHANTS",
				requiredCanonicalMerchantNames: null,
				allowedMccCodes: null,
				rewardExpiryDate: null,
				sourceSnapshotId: null,
				parserType: null,
				parserVersion: null,
				parserConfidence: null,
				note: null,
				cardIds: [],
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/campaigns/${CAMPAIGN_ID}`,
				{ method: "GET", headers: { Cookie: COOKIE } },
				mockEnv,
			);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { campaign: Record<string, unknown> };
			expect(data.campaign.campaignPeriodId).toBe(CAMPAIGN_ID);
			expect(data.campaign.campaignFamilyId).toBeUndefined();
			expect(data.campaign.revisionId).toBeUndefined();
		});
	});
});
