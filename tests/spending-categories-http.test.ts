import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import * as analyticsModule from "../src/spending-categories/analytics";
import * as assignmentsModule from "../src/spending-categories/assignments";
import * as serviceModule from "../src/spending-categories/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const CAT1 = "22222222-2222-4222-8222-222222222222";

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

describe("Spending Categories HTTP", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	it("GET /spending/categories lists categories and seeds defaults if empty", async () => {
		vi.spyOn(serviceModule, "listSpendingCategories").mockResolvedValue([
			{
				id: CAT1,
				userId: U1,
				name: "Market & Gıda",
				defaultBudgetCategory: "MANDATORY_EXPENSE",
				status: "ACTIVE",
				sortOrder: 1,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const res = await app.request(
			"http://localhost/spending/categories",
			{
				method: "GET",
				headers: {
					Cookie: COOKIE,
				},
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.categories).toHaveLength(1);
		expect(data.categories[0].name).toBe("Market & Gıda");
	});

	it("POST /spending/categories creates a custom spending category", async () => {
		vi.spyOn(serviceModule, "createSpendingCategory").mockResolvedValue({
			id: CAT1,
			userId: U1,
			name: "Kahve",
			defaultBudgetCategory: "DISCRETIONARY_SPEND",
			status: "ACTIVE",
			sortOrder: 5,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const res = await app.request(
			"http://localhost/spending/categories",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: "Kahve",
					defaultBudgetCategory: "DISCRETIONARY_SPEND",
					sortOrder: 5,
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(201);
		const data = (await res.json()) as any;
		expect(data.category.name).toBe("Kahve");
	});

	it("POST /spending/categories/:id archives category", async () => {
		vi.spyOn(serviceModule, "archiveSpendingCategory").mockResolvedValue({
			id: CAT1,
			userId: U1,
			name: "Kahve",
			defaultBudgetCategory: "DISCRETIONARY_SPEND",
			status: "ARCHIVED",
			sortOrder: 5,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const res = await app.request(
			`http://localhost/spending/categories/${CAT1}/archive`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
				},
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.category.status).toBe("ARCHIVED");
	});

	it("POST /spending/assignments upserts assignment and GET retrieves it", async () => {
		vi.spyOn(assignmentsModule, "upsertAssignment").mockResolvedValue({
			id: "assign-1",
			userId: U1,
			subjectType: "CREDIT_CARD_PURCHASE",
			subjectId: "purchase-1",
			categoryId: CAT1,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const res = await app.request(
			"http://localhost/spending/category-assignments",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					subjectType: "CREDIT_CARD_PURCHASE",
					subjectId: "purchase-1",
					categoryId: CAT1,
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.assignment.categoryId).toBe(CAT1);
	});

	it("GET /spending/category-assignments resolves mapping", async () => {
		vi.spyOn(assignmentsModule, "bulkResolveAssignments").mockResolvedValue({
			"purchase-1": CAT1,
		});

		const res = await app.request(
			"http://localhost/spending/category-assignments?subjectType=CREDIT_CARD_PURCHASE&subjectIds=purchase-1",
			{
				method: "GET",
				headers: {
					Cookie: COOKIE,
				},
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.assignments["purchase-1"]).toBe(CAT1);
	});

	it("GET /spending/summary returns spending summary with percentages", async () => {
		vi.spyOn(analyticsModule, "getSpendingSummary").mockResolvedValue({
			periodMonth: "2026-09",
			totalPersonalSpending: "1000.00",
			unclassifiedAmount: "200.00",
			categories: [
				{
					categoryId: CAT1,
					categoryName: "Market & Gıda",
					amount: "800.00",
					transactionCount: 4,
				},
			],
		});

		const res = await app.request(
			"http://localhost/spending/summary?periodMonth=2026-09",
			{
				method: "GET",
				headers: {
					Cookie: COOKIE,
				},
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.totalPersonalSpending).toBe("1000.00");
		expect(data.categories[0].amount).toBe("800.00");
	});
});
