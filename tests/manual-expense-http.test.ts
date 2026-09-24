import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { ManualExpenseError } from "../src/manual-expenses/errors";
import * as serviceModule from "../src/manual-expenses/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const E1 = "44444444-4444-4444-8444-444444444444";
const ACC1 = "55555555-5555-4555-8555-555555555555";
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

describe("Manual Expense HTTP", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test db stub
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	it("rejects unauthenticated requests with 401", async () => {
		const res = await app.request(
			"/manual-expenses",
			{
				method: "GET",
			},
			mockEnv,
		);
		expect(res.status).toBe(401);
	});

	it("creates a manual expense with double-entry balance and optional category", async () => {
		const payload = {
			sourceAssetAccountId: ACC1,
			amount: "150.00",
			budgetCategory: "FOOD",
			description: "Office Lunch",
			occurredAt: "2026-09-24T12:00:00.000Z",
			spendingCategoryId: CAT1,
		};

		const mockResult = {
			expense: {
				id: E1,
				userId: U1,
				sourceAssetAccountId: ACC1,
				budgetCategory: "FOOD",
				spendingCategoryId: CAT1,
			},
			revision: {
				revisionNo: 1,
				amount: "150.00",
			},
			idempotentReplay: false,
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "createManualExpense").mockResolvedValue(
			mockResult as any,
		);

		const res = await app.request(
			"/manual-expenses",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
					"Idempotency-Key": "idem-exp-1",
				},
				body: JSON.stringify(payload),
			},
			mockEnv,
		);

		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json).toEqual(mockResult);
	});

	it("rejects invalid manual expense payload (missing sourceAssetAccountId or negative amount)", async () => {
		const res = await app.request(
			"/manual-expenses",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
					"Idempotency-Key": "idem-exp-2",
				},
				body: JSON.stringify({
					amount: "-50.00",
					description: "Invalid",
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error.code).toBe("MANUAL_EXPENSE_INVALID_INPUT");
	});

	it("lists manual expenses for user", async () => {
		const mockList = [
			{
				id: E1,
				sourceAssetAccountId: ACC1,
				amount: "150.00",
				description: "Office Lunch",
				occurredAt: "2026-09-24T12:00:00.000Z",
				spendingCategoryId: CAT1,
				status: "ACTIVE",
			},
		];

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "listManualExpenses").mockResolvedValue(
			mockList as any,
		);

		const res = await app.request(
			"/manual-expenses",
			{
				method: "GET",
				headers: { Cookie: COOKIE },
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual(mockList);
	});

	it("fetches a single manual expense by ID", async () => {
		const mockItem = {
			id: E1,
			sourceAssetAccountId: ACC1,
			amount: "150.00",
			description: "Office Lunch",
			occurredAt: "2026-09-24T12:00:00.000Z",
			spendingCategoryId: CAT1,
			status: "ACTIVE",
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "getManualExpense").mockResolvedValue(
			mockItem as any,
		);

		const res = await app.request(
			`/manual-expenses/${E1}`,
			{
				method: "GET",
				headers: { Cookie: COOKIE },
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual({ expense: mockItem });
	});

	it("updates a manual expense", async () => {
		const updated = {
			expense: {
				id: E1,
				sourceAssetAccountId: ACC1,
			},
			revision: {
				revisionNo: 2,
				amount: "175.00",
			},
			idempotentReplay: false,
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "updateManualExpense").mockResolvedValue(
			updated as any,
		);

		const res = await app.request(
			`/manual-expenses/${E1}`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
					"Idempotency-Key": "idem-up-1",
				},
				body: JSON.stringify({
					expectedRevisionNo: 1,
					amount: "175.00",
					description: "Office Lunch + Coffee",
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual(updated);
	});

	it("voids a manual expense (reversing ledger)", async () => {
		const voided = {
			expense: {
				id: E1,
				status: "VOIDED",
			},
			revision: {
				revisionNo: 2,
				operation: "VOID",
			},
			idempotentReplay: false,
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "voidManualExpense").mockResolvedValue(
			voided as any,
		);

		const res = await app.request(
			`/manual-expenses/${E1}/void`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
					"Idempotency-Key": "idem-void-1",
				},
				body: JSON.stringify({
					expectedRevisionNo: 1,
					reason: "Duplicate entry",
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual(voided);
	});

	it("handles ManualExpenseError domain errors correctly", async () => {
		vi.spyOn(serviceModule, "getManualExpense").mockRejectedValue(
			new ManualExpenseError(
				"MANUAL_EXPENSE_NOT_FOUND",
				"Manual expense not found",
			),
		);

		const res = await app.request(
			`/manual-expenses/${E1}`,
			{
				method: "GET",
				headers: { Cookie: COOKIE },
			},
			mockEnv,
		);

		expect(res.status).toBe(404);
		const json = (await res.json()) as any;
		expect(json.error.code).toBe("MANUAL_EXPENSE_NOT_FOUND");
	});
});
