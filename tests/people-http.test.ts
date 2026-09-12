import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { PeopleError } from "../src/people/errors";
import * as obligationsModule from "../src/people/obligations";
import * as peopleModule from "../src/people/people";
import * as settlementsModule from "../src/people/settlements";

const U1 = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const OBLIGATION_ID = "33333333-3333-4333-8333-333333333333";
const SETTLEMENT_ID = "44444444-4444-4444-8444-444444444444";
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

describe("People + Family Product HTTP Surface (Checkpoint 7B.4)", () => {
	let mockDbSelect: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.restoreAllMocks();

		// Set up mock DB client with fluent query builder
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

	// --- 1. Authentication Gates on All 17 Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/people", method: "GET" },
			{ path: `/people/${PERSON_ID}`, method: "GET" },
			{ path: "/people", method: "POST" },
			{ path: `/people/${PERSON_ID}`, method: "POST" },
			{ path: `/people/${PERSON_ID}/archive`, method: "POST" },
			{ path: `/people/${PERSON_ID}/obligations`, method: "GET" },
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}`,
				method: "GET",
			},
			{ path: `/people/${PERSON_ID}/obligations/receivable`, method: "POST" },
			{ path: `/people/${PERSON_ID}/obligations/payable`, method: "POST" },
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}`,
				method: "POST",
			},
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/void`,
				method: "POST",
			},
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements`,
				method: "GET",
			},
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/${SETTLEMENT_ID}`,
				method: "GET",
			},
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/receivable`,
				method: "POST",
			},
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/payable`,
				method: "POST",
			},
			{
				path: `/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/${SETTLEMENT_ID}/void`,
				method: "POST",
			},
		];

		for (const { path, method } of routes) {
			it(`rejects unauthenticated ${method} ${path} with 401 UNAUTHENTICATED`, async () => {
				const res = await app.request(
					path,
					{
						method,
						headers: {
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						...(method === "POST" ? { body: "{}" } : {}),
					},
					mockEnv,
				);
				expect(res.status).toBe(401);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("UNAUTHENTICATED");
			});
		}
	});

	// --- 2. Same-Origin Mutation Guard ---
	describe("Same-Origin mutation guard", () => {
		it("rejects POST /people with missing Origin header (403 INVALID_ORIGIN)", async () => {
			const res = await app.request(
				"/people",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						displayName: "Alice",
						relationship: "FRIEND",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});

		it("rejects POST with mismatched Origin header (403 INVALID_ORIGIN)", async () => {
			const res = await app.request(
				"/people",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: "http://malicious-site.example.com",
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						displayName: "Alice",
						relationship: "FRIEND",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});
	});

	// --- 3. Idempotency Key Validation ---
	describe("Idempotency-Key header requirements", () => {
		it("rejects POST /people without Idempotency-Key header (400 PEOPLE_INVALID_INPUT)", async () => {
			const res = await app.request(
				"/people",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						displayName: "Alice",
						relationship: "FRIEND",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_INVALID_INPUT");
		});

		it("rejects POST /people with empty Idempotency-Key (400 PEOPLE_INVALID_INPUT)", async () => {
			const res = await app.request(
				"/people",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "",
					},
					body: JSON.stringify({
						displayName: "Alice",
						relationship: "FRIEND",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});
	});

	// --- 4. Closed Body Key Validation ---
	describe("Closed body validation", () => {
		it("rejects POST /people with unknown extra property (400 PEOPLE_INVALID_INPUT)", async () => {
			const res = await app.request(
				"/people",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-extra-prop",
					},
					body: JSON.stringify({
						displayName: "Alice",
						relationship: "FRIEND",
						occurredAt: OCCURRED_AT,
						unknownField: "malicious_injection",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_INVALID_INPUT");
		});
	});

	// --- 5. Strict Query Params ---
	describe("Strict query parameter validation", () => {
		it("rejects GET /people with unexpected query param (400 PEOPLE_INVALID_INPUT)", async () => {
			const res = await app.request(
				"/people?limit=10&unexpected=1",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_INVALID_INPUT");
		});

		it("rejects GET /people/:id with any query params (400 PEOPLE_INVALID_INPUT)", async () => {
			const res = await app.request(
				`/people/${PERSON_ID}?foo=bar`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});
	});

	// --- 6. UUID Path Params Validation ---
	describe("UUID path param validation", () => {
		it("rejects non-UUID in GET /people/:id (400 PEOPLE_INVALID_INPUT)", async () => {
			const res = await app.request(
				"/people/not-a-uuid",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_INVALID_INPUT");
		});
	});

	// --- 7. Person Surface Happy Paths & Service Invocations ---
	describe("People CRUD Endpoints", () => {
		it("GET /people returns list of people", async () => {
			const mockPeople = [
				{
					personId: PERSON_ID,
					status: "ACTIVE" as const,
					displayName: "Alice",
					relationship: "FRIEND" as const,
					note: null,
					revisionNo: 1,
					receivableAccountId: ASSET_ACC_ID,
					receivableBalance: "0.00",
					payableAccountId: ASSET_ACC_ID,
					payableBalance: "0.00",
				},
			];
			vi.spyOn(peopleModule, "listPeople").mockResolvedValue(mockPeople);

			const res = await app.request(
				"/people?limit=20&status=ACTIVE&relationship=FRIEND",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.people).toHaveLength(1);
			expect(data.people[0].displayName).toBe("Alice");
			expect(data.limit).toBe(20);
		});

		it("GET /people/:id returns 404 when not found", async () => {
			vi.spyOn(peopleModule, "getPerson").mockResolvedValue(
				null as unknown as import("../src/people/people").PersonReadModel,
			);

			const res = await app.request(
				`/people/${PERSON_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_NOT_FOUND");
		});

		it("POST /people creates a person successfully", async () => {
			const createdPerson = {
				personId: PERSON_ID,
				status: "ACTIVE" as const,
				displayName: "Bob",
				relationship: "FAMILY" as const,
				note: "Brother",
				revisionNo: 1,
				receivableAccountId: null,
				receivableBalance: "0.00",
				payableAccountId: null,
				payableBalance: "0.00",
			};
			vi.spyOn(peopleModule, "createPerson").mockResolvedValue({
				person: createdPerson,
				idempotentReplay: false,
			});

			const res = await app.request(
				"/people",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-create-bob",
					},
					body: JSON.stringify({
						displayName: "Bob",
						relationship: "FAMILY",
						note: "Brother",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.person.displayName).toBe("Bob");
			expect(data.idempotentReplay).toBe(false);
		});

		it("POST /people/:id updates a person", async () => {
			const updatedPerson = {
				personId: PERSON_ID,
				status: "ACTIVE" as const,
				displayName: "Bob Smith",
				relationship: "FAMILY" as const,
				note: "Brother updated",
				revisionNo: 2,
				receivableAccountId: null,
				receivableBalance: "0.00",
				payableAccountId: null,
				payableBalance: "0.00",
			};
			vi.spyOn(peopleModule, "updatePerson").mockResolvedValue({
				person: updatedPerson,
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-update-bob",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						displayName: "Bob Smith",
						relationship: "FAMILY",
						note: "Brother updated",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.person.displayName).toBe("Bob Smith");
			expect(data.person.revisionNo).toBe(2);
		});

		it("POST /people/:id/archive archives a person", async () => {
			const archivedPerson = {
				personId: PERSON_ID,
				status: "ARCHIVED" as const,
				displayName: "Bob Smith",
				relationship: "FAMILY" as const,
				note: null,
				revisionNo: 3,
				receivableAccountId: null,
				receivableBalance: "0.00",
				payableAccountId: null,
				payableBalance: "0.00",
			};
			vi.spyOn(peopleModule, "archivePerson").mockResolvedValue({
				person: archivedPerson,
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/archive`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-archive-bob",
					},
					body: JSON.stringify({
						expectedRevisionNo: 2,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.person.status).toBe("ARCHIVED");
		});
	});

	// --- 8. Obligations Surface & Split-Managed Guard ---
	describe("Obligations surface", () => {
		const mockReceivableObligation = {
			obligationId: OBLIGATION_ID,
			personId: PERSON_ID,
			direction: "RECEIVABLE" as const,
			status: "OPEN" as const,
			principalAmount: "500.00",
			settledAmount: "0.00",
			remainingAmount: "500.00",
			dueDate: "2026-10-01",
			description: "Lunch advance",
			fundingAssetAccountId: ASSET_ACC_ID,
			budgetCategory: null,
			revisionNo: 1,
			canonicalTransactionId: "77777777-7777-4777-8777-777777777777",
			canonicalRevisionId: "88888888-8888-4888-8888-888888888888",
		};

		it("GET /people/:personId/obligations returns obligations with isSplitManaged", async () => {
			vi.spyOn(peopleModule, "getPerson").mockResolvedValue({
				personId: PERSON_ID,
				status: "ACTIVE",
				displayName: "Alice",
				relationship: "FRIEND",
				note: null,
				revisionNo: 1,
				receivableAccountId: null,
				receivableBalance: "0.00",
				payableAccountId: null,
				payableBalance: "0.00",
			});
			vi.spyOn(obligationsModule, "listPersonObligations").mockResolvedValue([
				mockReceivableObligation,
			]);

			const res = await app.request(
				`/people/${PERSON_ID}/obligations`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.obligations).toHaveLength(1);
			expect(data.obligations[0].isSplitManaged).toBe(false);
		});

		it("GET /people/:personId/obligations/:id returns obligation with isSplitManaged", async () => {
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue(
				mockReceivableObligation,
			);

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.obligation.obligationId).toBe(OBLIGATION_ID);
			expect(data.obligation.isSplitManaged).toBe(false);
		});

		it("POST /people/:personId/obligations/receivable records a receivable", async () => {
			vi.spyOn(obligationsModule, "recordPersonReceivable").mockResolvedValue({
				obligation: mockReceivableObligation,
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/receivable`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-rec-1",
					},
					body: JSON.stringify({
						amount: "500.00",
						fundingAssetAccountId: ASSET_ACC_ID,
						occurredAt: OCCURRED_AT,
						dueDate: "2026-10-01",
						description: "Lunch advance",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.obligation.principalAmount).toBe("500.00");
		});

		it("POST /people/:personId/obligations/payable records a payable expense", async () => {
			const mockPayableObligation = {
				...mockReceivableObligation,
				direction: "PAYABLE" as const,
				budgetCategory: "MANDATORY_EXPENSE",
				fundingAssetAccountId: null,
			};
			vi.spyOn(
				obligationsModule,
				"recordPersonPayableExpense",
			).mockResolvedValue({
				obligation: mockPayableObligation,
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/payable`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-pay-1",
					},
					body: JSON.stringify({
						amount: "350.00",
						budgetCategory: "MANDATORY_EXPENSE",
						occurredAt: OCCURRED_AT,
						dueDate: "2026-10-15",
						description: "Shared groceries",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.obligation.direction).toBe("PAYABLE");
		});

		it("blocks update on split-managed obligation with 409 PEOPLE_OBLIGATION_SPLIT_MANAGED", async () => {
			// Mock DB query finding a split participant for this obligation
			mockDbSelect.mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([{ id: "split-part-1" }]),
					}),
				}),
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-upd-split",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						amount: "600.00",
						fundingAssetAccountId: ASSET_ACC_ID,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_OBLIGATION_SPLIT_MANAGED");
		});

		it("blocks void on split-managed obligation with 409 PEOPLE_OBLIGATION_SPLIT_MANAGED", async () => {
			mockDbSelect.mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([{ id: "split-part-1" }]),
					}),
				}),
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-void-split",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_OBLIGATION_SPLIT_MANAGED");
		});

		it("updates standalone receivable obligation", async () => {
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue(
				mockReceivableObligation,
			);
			vi.spyOn(obligationsModule, "updatePersonReceivable").mockResolvedValue({
				obligation: {
					...mockReceivableObligation,
					principalAmount: "550.00",
					revisionNo: 2,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-upd-rec",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						amount: "550.00",
						fundingAssetAccountId: ASSET_ACC_ID,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.obligation.principalAmount).toBe("550.00");
			expect(data.obligation.revisionNo).toBe(2);
		});

		it("voids standalone obligation", async () => {
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue(
				mockReceivableObligation,
			);
			vi.spyOn(obligationsModule, "voidPersonObligation").mockResolvedValue({
				obligation: {
					...mockReceivableObligation,
					status: "VOID",
					revisionNo: 2,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-void-rec",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.obligation.status).toBe("VOID");
		});
	});

	// --- 9. Settlements Surface ---
	describe("Settlements surface", () => {
		const mockReceivableObligation = {
			obligationId: OBLIGATION_ID,
			personId: PERSON_ID,
			direction: "RECEIVABLE" as const,
			status: "OPEN" as const,
			principalAmount: "500.00",
			settledAmount: "0.00",
			remainingAmount: "500.00",
			dueDate: null,
			description: null,
			fundingAssetAccountId: ASSET_ACC_ID,
			budgetCategory: null,
			revisionNo: 1,
			canonicalTransactionId: "77777777-7777-4777-8777-777777777777",
			canonicalRevisionId: "88888888-8888-4888-8888-888888888888",
		};

		const mockSettlement = {
			settlementId: SETTLEMENT_ID,
			obligationId: OBLIGATION_ID,
			personId: PERSON_ID,
			direction: "RECEIVABLE" as const,
			status: "ACTIVE" as const,
			assetAccountId: ASSET_ACC_ID,
			cashAmount: "200.00",
			appliedAmount: "200.00",
			excessAmount: "0.00",
			overpaymentIncomeReceiptId: null,
			note: "First partial settlement",
			occurredAt: new Date(OCCURRED_AT),
			revisionNo: 1,
			canonicalTransactionId: "99999999-9999-4999-8999-999999999999",
			canonicalRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		};

		it("GET /settlements lists settlements for obligation", async () => {
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue(
				mockReceivableObligation,
			);
			vi.spyOn(settlementsModule, "listPersonSettlements").mockResolvedValue([
				mockSettlement,
			]);

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.settlements).toHaveLength(1);
			expect(data.settlements[0].settlementId).toBe(SETTLEMENT_ID);
		});

		it("GET /settlements/:id returns single settlement", async () => {
			vi.spyOn(settlementsModule, "getPersonSettlement").mockResolvedValue(
				mockSettlement,
			);

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/${SETTLEMENT_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.settlement.settlementId).toBe(SETTLEMENT_ID);
		});

		it("POST /settlements/receivable records receivable settlement", async () => {
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue(
				mockReceivableObligation,
			);
			vi.spyOn(
				settlementsModule,
				"recordPersonReceivableSettlement",
			).mockResolvedValue({
				settlement: mockSettlement,
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/receivable`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-rec-settle",
					},
					body: JSON.stringify({
						cashAmount: "200.00",
						destinationAssetAccountId: ASSET_ACC_ID,
						occurredAt: OCCURRED_AT,
						note: "First partial settlement",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.settlement.cashAmount).toBe("200.00");
		});

		it("POST /settlements/payable records payable settlement", async () => {
			const mockPayableObligation = {
				...mockReceivableObligation,
				direction: "PAYABLE" as const,
			};
			const mockPayableSettlement = {
				...mockSettlement,
				direction: "PAYABLE" as const,
			};
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue(
				mockPayableObligation,
			);
			vi.spyOn(
				settlementsModule,
				"recordPersonPayableSettlement",
			).mockResolvedValue({
				settlement: mockPayableSettlement,
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/payable`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-pay-settle",
					},
					body: JSON.stringify({
						amount: "200.00",
						sourceAssetAccountId: ASSET_ACC_ID,
						occurredAt: OCCURRED_AT,
						note: "Payable settlement",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.settlement.direction).toBe("PAYABLE");
		});

		it("POST /settlements/:id/void voids settlement", async () => {
			vi.spyOn(settlementsModule, "getPersonSettlement").mockResolvedValue(
				mockSettlement,
			);
			vi.spyOn(settlementsModule, "voidPersonSettlement").mockResolvedValue({
				settlement: {
					...mockSettlement,
					status: "VOIDED",
					revisionNo: 2,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/${SETTLEMENT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-void-settle",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						reason: "Entered wrong bank account",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test payload
			const data = (await res.json()) as any;
			expect(data.settlement.status).toBe("VOIDED");
		});
	});

	// --- 10. Domain Error Mapping ---
	describe("Domain error mapping", () => {
		it("maps PEOPLE_REVISION_CONFLICT to 409", async () => {
			vi.spyOn(peopleModule, "updatePerson").mockRejectedValue(
				new PeopleError("PEOPLE_REVISION_CONFLICT", "Stale revision"),
			);

			const res = await app.request(
				`/people/${PERSON_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-rev-conflict",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						displayName: "Bob",
						relationship: "FAMILY",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_REVISION_CONFLICT");
		});

		it("maps PEOPLE_OBLIGATION_OVERSETTLEMENT to 409", async () => {
			vi.spyOn(obligationsModule, "getPersonObligation").mockResolvedValue({
				obligationId: OBLIGATION_ID,
				personId: PERSON_ID,
				direction: "RECEIVABLE",
				status: "OPEN",
				principalAmount: "500.00",
				settledAmount: "0.00",
				remainingAmount: "500.00",
				dueDate: null,
				description: null,
				fundingAssetAccountId: ASSET_ACC_ID,
				budgetCategory: null,
				revisionNo: 1,
				canonicalTransactionId: "77777777-7777-4777-8777-777777777777",
				canonicalRevisionId: "88888888-8888-4888-8888-888888888888",
			});
			vi.spyOn(
				settlementsModule,
				"recordPersonReceivableSettlement",
			).mockRejectedValue(
				new PeopleError("PEOPLE_OBLIGATION_OVERSETTLEMENT", "Oversettled"),
			);

			const res = await app.request(
				`/people/${PERSON_ID}/obligations/${OBLIGATION_ID}/settlements/receivable`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "key-oversettle",
					},
					body: JSON.stringify({
						cashAmount: "1000.00",
						destinationAssetAccountId: ASSET_ACC_ID,
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("PEOPLE_OBLIGATION_OVERSETTLEMENT");
		});
	});
});
