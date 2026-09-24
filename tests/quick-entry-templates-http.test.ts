import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { QuickEntryTemplateError } from "../src/quick-entry-templates/errors";
import * as serviceModule from "../src/quick-entry-templates/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const T1 = "33333333-3333-4333-8333-333333333333";

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

describe("Quick Entry Templates HTTP", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test db stub
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	it("rejects unauthenticated requests with 401", async () => {
		const res = await app.request(
			"/quick-entry/templates",
			{
				method: "GET",
			},
			mockEnv,
		);
		expect(res.status).toBe(401);
	});

	it("lists quick entry templates for user", async () => {
		const mockTemplates = [
			{
				id: T1,
				userId: U1,
				name: "Morning Coffee",
				templateType: "MANUAL_EXPENSE",
				sortOrder: 1,
				config: {
					amount: "75.00",
					description: "Daily espresso",
				},
				isArchived: false,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		];

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "listTemplates").mockResolvedValue(
			mockTemplates as any,
		);

		const res = await app.request(
			"/quick-entry/templates",
			{
				method: "GET",
				headers: { Cookie: COOKIE },
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual({ templates: mockTemplates });
	});

	it("creates a new template with valid config", async () => {
		const payload = {
			name: "Gym Monthly",
			templateType: "CREDIT_CARD_PURCHASE",
			sortOrder: 2,
			config: {
				amount: "1200.00",
				description: "Gym Club",
			},
		};

		const created = {
			id: T1,
			userId: U1,
			...payload,
			isArchived: false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "createTemplate").mockResolvedValue(created as any);

		const res = await app.request(
			"/quick-entry/templates",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
			mockEnv,
		);

		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json).toEqual({ template: created });
	});

	it("rejects invalid template payload (e.g. unknown templateType)", async () => {
		const res = await app.request(
			"/quick-entry/templates",
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: "Bad Template",
					templateType: 123,
					config: {},
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error.code).toBe("QUICK_ENTRY_TEMPLATE_INVALID_INPUT");
	});

	it("updates a quick entry template", async () => {
		const updated = {
			id: T1,
			userId: U1,
			name: "Gym Monthly (Updated)",
			templateType: "CREDIT_CARD_PURCHASE",
			config: { amount: "1500.00" },
			sortOrder: 5,
			isArchived: false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "updateTemplate").mockResolvedValue(updated as any);

		const res = await app.request(
			`/quick-entry/templates/${T1}`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: "Gym Monthly (Updated)",
					config: { amount: "1500.00" },
					sortOrder: 5,
				}),
			},
			mockEnv,
		);

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual({ template: updated });
	});

	it("archives a template", async () => {
		const archived = {
			id: T1,
			userId: U1,
			name: "To Archive",
			templateType: "MANUAL_EXPENSE",
			config: {},
			isArchived: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		vi.spyOn(serviceModule, "archiveTemplate").mockResolvedValue(
			archived as any,
		);

		const res = await app.request(
			`/quick-entry/templates/${T1}/archive`,
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
		const json = await res.json();
		expect(json).toEqual({ template: archived });
	});

	it("handles QuickEntryTemplateError properly", async () => {
		vi.spyOn(serviceModule, "archiveTemplate").mockRejectedValue(
			new QuickEntryTemplateError(
				"QUICK_ENTRY_TEMPLATE_NOT_FOUND",
				"Template not found",
			),
		);

		const res = await app.request(
			`/quick-entry/templates/${T1}/archive`,
			{
				method: "POST",
				headers: {
					Cookie: COOKIE,
					Origin: ORIGIN,
				},
			},
			mockEnv,
		);

		expect(res.status).toBe(404);
		const json = (await res.json()) as any;
		expect(json.error.code).toBe("QUICK_ENTRY_TEMPLATE_NOT_FOUND");
	});

	it("explicitly confirms that no execution endpoint exists (returns 404)", async () => {
		const res = await app.request(
			`/quick-entry/templates/${T1}/execute`,
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

		expect(res.status).toBe(404);
	});
});
