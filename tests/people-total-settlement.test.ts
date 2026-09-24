import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { PeopleError } from "../src/people/errors";
import * as orchestratorModule from "../src/people/person-settlement-orchestrator";
import * as productReadV2Module from "../src/people/product-read-v2";

const U1 = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ACC_ID = "55555555-5555-4555-8555-555555555555";

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

describe("People Balance Summary & Multi-Obligation Settlement HTTP", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test db stub
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	describe("GET /people/:personId/balance-summary", () => {
		it("rejects unauthenticated requests with 401", async () => {
			const res = await app.request(
				`/people/${PERSON_ID}/balance-summary`,
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
		});

		it("returns balance summary with FRIEND 5-TL ceiling rounding", async () => {
			const mockSummary = {
				personId: PERSON_ID,
				relationship: "FRIEND",
				rawReceivableTotal: "142.30",
				rawPayableTotal: "0.00",
				netAmount: "142.30",
				netDirection: "RECEIVABLE",
				friendCeilingRoundedAmount: "145.00",
				currency: "TRY",
				openReceivableCount: 2,
				openPayableCount: 0,
			};

			vi.spyOn(
				productReadV2Module,
				"getPersonBalanceSummary",
			).mockResolvedValue(mockSummary as any);

			const res = await app.request(
				`/people/${PERSON_ID}/balance-summary`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json).toEqual(mockSummary);
		});

		it("returns 404 if person not found", async () => {
			vi.spyOn(
				productReadV2Module,
				"getPersonBalanceSummary",
			).mockRejectedValue(
				new PeopleError("PEOPLE_NOT_FOUND", "Person not found"),
			);

			const res = await app.request(
				`/people/${PERSON_ID}/balance-summary`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(404);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("PEOPLE_NOT_FOUND");
		});
	});

	describe("POST /people/:personId/settle-receivables", () => {
		it("rejects invalid settle-receivables payload", async () => {
			const res = await app.request(
				`/people/${PERSON_ID}/settle-receivables`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "idem-bad",
					},
					body: JSON.stringify({
						cashAmount: 123, // invalid type, must be string
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("PEOPLE_INVALID_INPUT");
		});

		it("orchestrates multi-obligation settlement with overpayment waterfall", async () => {
			const payload = {
				destinationAssetAccountId: ASSET_ACC_ID,
				cashAmount: "500.00",
				isCash: true,
			};

			const mockResult = {
				settledObligations: [
					{
						obligationId: "ob-1",
						settledAmount: "200.00",
						remainingAmount: "0.00",
						settlementId: "set-1",
					},
					{
						obligationId: "ob-2",
						settledAmount: "150.00",
						remainingAmount: "0.00",
						settlementId: "set-2",
					},
				],
				totalSettledAgainstObligations: "350.00",
				overpaymentAmount: "150.00",
				waterfallAllocations: [
					{
						target: "CREDIT_CARD_RESERVE",
						allocatedAmount: "100.00",
						referenceId: "cc-acc-1",
					},
					{
						target: "SHORT_TERM_GOAL",
						allocatedAmount: "50.00",
						referenceId: "goal-1",
					},
				],
				unallocatedOverpayment: "0.00",
			};

			vi.spyOn(orchestratorModule, "settlePersonReceivables").mockResolvedValue(
				mockResult as any,
			);

			const res = await app.request(
				`/people/${PERSON_ID}/settle-receivables`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "idem-settle-1",
					},
					body: JSON.stringify(payload),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json).toEqual(mockResult);
		});

		it("handles domain errors gracefully", async () => {
			vi.spyOn(orchestratorModule, "settlePersonReceivables").mockRejectedValue(
				new PeopleError("PEOPLE_INVALID_INPUT", "Invalid input for settlement"),
			);

			const res = await app.request(
				`/people/${PERSON_ID}/settle-receivables`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "idem-settle-2",
					},
					body: JSON.stringify({
						destinationAssetAccountId: ASSET_ACC_ID,
						cashAmount: "100.00",
						isCash: true,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("PEOPLE_INVALID_INPUT");
		});
	});
});
