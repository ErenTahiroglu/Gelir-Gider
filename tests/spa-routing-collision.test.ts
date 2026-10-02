import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config/env";
import worker, { app } from "../src/index";

/**
 * SPA / API SAME-ORIGIN ROUTING COLLISION REGRESSION TESTS
 *
 * Verifies that:
 * 1. Document navigations (GET/HEAD with Sec-Fetch-Mode: navigate and/or HTML Accept)
 *    to whitelisted SPA routes delegate to env.ASSETS and return the SPA HTML shell.
 * 2. API-style requests (fetch/XHR semantics, JSON accept) to the same routes or API subroutes
 *    continue through to Hono backend routers and enforce authentication/status codes.
 * 3. Exact reproduced production failure:
 *    GET /notifications with Sec-Fetch-Mode: navigate previously returned 404 JSON NOT_FOUND.
 * 4. PWA update regression:
 *    Operator on /notifications updates PWA -> page reload -> SPA shell returned, NEVER JSON NOT_FOUND.
 * 5. Full whitelist coverage of all 45 TanStack Router routes.
 */

const DUMMY_HTML_SHELL = `<!DOCTYPE html><html lang="tr"><head><title>Gelir-Gider</title></head><body><div id="root"></div></body></html>`;

function createMockAssets(): {
	fetch: (request: Request | string) => Promise<Response>;
	callCount: () => number;
	lastRequest: () => Request | string | null;
} {
	let count = 0;
	let lastReq: Request | string | null = null;
	return {
		fetch: async (req: Request | string) => {
			count++;
			lastReq = req;
			return new Response(DUMMY_HTML_SHELL, {
				status: 200,
				headers: {
					"content-type": "text/html; charset=utf-8",
				},
			});
		},
		callCount: () => count,
		lastRequest: () => lastReq,
	};
}

const dummyCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("SPA / API Same-Origin Routing Collision Regression", () => {
	it("proves the raw Hono router (unintercepted) fails document navigation with JSON NOT_FOUND or UNAUTHENTICATED", async () => {
		// When hitting Hono directly without worker boundary:
		// Unauthenticated GET /notifications returns 401 UNAUTHENTICATED JSON (never index.html)
		const notifRes = await app.request("/notifications", {
			method: "GET",
			headers: {
				"sec-fetch-mode": "navigate",
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});

		expect(notifRes.status).toBe(401);
		expect(notifRes.headers.get("content-type")).toContain("application/json");
		const notifJson = (await notifRes.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(notifJson.error?.code).toBe("UNAUTHENTICATED");
		expect(notifJson.error?.message).toBe("Authentication required");

		// GET /transactions returns 401 UNAUTHENTICATED
		const txRes = await app.request("/transactions", {
			method: "GET",
			headers: {
				"sec-fetch-mode": "navigate",
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});

		expect(txRes.status).toBe(401);
		expect(txRes.headers.get("content-type")).toContain("application/json");
		const txJson = (await txRes.json()) as { error?: { code?: string } };
		expect(txJson.error?.code).toBe("UNAUTHENTICATED");
	});

	it("reproduces production incident: document navigation to /notifications delegates to ASSETS", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const req = new Request(
			"https://gelir-gider-api.erentahiroglu.workers.dev/notifications",
			{
				method: "GET",
				headers: {
					"sec-fetch-mode": "navigate",
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
			},
		);

		const res = await worker.fetch(req, env, dummyCtx);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(mockAssets.callCount()).toBe(1);
	});

	it("PWA update regression: clicking 'Şimdi Yenile' on /notifications triggers document reload and returns SPA shell", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		// Simulating window.location.reload() or document navigation triggered by PWA update prompt
		const pwaReloadReq = new Request(
			"https://gelir-gider-api.erentahiroglu.workers.dev/notifications",
			{
				method: "GET",
				headers: {
					"sec-fetch-mode": "navigate",
					"sec-fetch-dest": "document",
					"sec-fetch-site": "none",
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
				},
			},
		);

		const res = await worker.fetch(pwaReloadReq, env, dummyCtx);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const bodyText = await res.text();
		expect(bodyText).toContain("<!DOCTYPE html>");
		expect(bodyText).not.toContain("Route not found");
		expect(bodyText).not.toContain("NOT_FOUND");
		expect(mockAssets.callCount()).toBe(1);
	});

	it("reproduces shared SPA roots: document navigation returns SPA shell for all critical roots", async () => {
		const criticalRoutes = [
			"/notifications",
			"/transactions",
			"/people",
			"/income",
			"/month-close",
			"/imports",
			"/manual-expenses/new",
		];

		for (const route of criticalRoutes) {
			const mockAssets = createMockAssets();
			const env: AppEnv = { ASSETS: mockAssets };

			const req = new Request(
				`https://gelir-gider-api.erentahiroglu.workers.dev${route}`,
				{
					method: "GET",
					headers: {
						"sec-fetch-mode": "navigate",
						accept:
							"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					},
				},
			);

			const res = await worker.fetch(req, env, dummyCtx);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const text = await res.text();
			expect(text).toContain("<!DOCTYPE html>");
			expect(mockAssets.callCount()).toBe(1);
		}
	});

	it("Section 7 critical dual-path tests: proves BOTH sides for each shared root", async () => {
		const sharedRoots = [
			{ path: "/transactions", apiExpectStatus: 401 },
			{ path: "/people", apiExpectStatus: 401 },
			{ path: "/income", apiExpectStatus: 401 },
			{ path: "/notifications", apiExpectStatus: 401 },
			{ path: "/month-close", apiExpectStatus: 401 },
			{ path: "/imports", apiExpectStatus: 401 },
		];

		for (const { path, apiExpectStatus } of sharedRoots) {
			// A. Browser hard navigation
			const navMockAssets = createMockAssets();
			const navEnv: AppEnv = { ASSETS: navMockAssets };
			const navReq = new Request(
				`https://gelir-gider-api.erentahiroglu.workers.dev${path}`,
				{
					method: "GET",
					headers: {
						"sec-fetch-mode": "navigate",
						accept:
							"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					},
				},
			);
			const navRes = await worker.fetch(navReq, navEnv, dummyCtx);
			expect(navRes.status).toBe(200);
			expect(navRes.headers.get("content-type")).toContain("text/html");
			expect(navMockAssets.callCount()).toBe(1);

			// B. Frontend API fetch
			const apiMockAssets = createMockAssets();
			const apiEnv: AppEnv = { ASSETS: apiMockAssets };
			const apiReq = new Request(
				`https://gelir-gider-api.erentahiroglu.workers.dev${path}`,
				{
					method: "GET",
					headers: {
						"sec-fetch-mode": "cors",
						accept: "application/json",
					},
				},
			);
			const apiRes = await worker.fetch(apiReq, apiEnv, dummyCtx);
			expect(apiRes.status).toBe(apiExpectStatus);
			expect(apiRes.headers.get("content-type")).toContain("application/json");
			expect(apiMockAssets.callCount()).toBe(0);
		}
	});

	it("Section 4 route whitelist: verifies all 45 frontend routes match and delegate to ASSETS", async () => {
		const all45FrontendRoutes = [
			// Static roots
			"/",
			"/unlock",
			"/transactions",
			"/transactions/t-uuid-1234",
			"/manual-expenses/new",
			"/manual-expenses/exp-uuid-1234/edit",
			"/settings/quick-templates",
			"/settings/devices",
			"/cards",
			"/cards/new",
			"/cards/card-uuid-1234",
			"/cards/card-uuid-1234/edit",
			"/cards/card-uuid-1234/statements/new",
			"/cards/card-uuid-1234/statements/stmt-uuid-1234",
			"/cards/card-uuid-1234/purchases/new",
			"/cards/card-uuid-1234/purchases/purch-uuid-1234",
			"/cards/card-uuid-1234/purchases/purch-uuid-1234/split",
			"/people",
			"/people/new",
			"/people/person-uuid-1234",
			"/people/person-uuid-1234/edit",
			"/people/person-uuid-1234/obligations/new",
			"/people/person-uuid-1234/obligations/ob-uuid-1234",
			"/people/person-uuid-1234/settle",
			"/goals",
			"/goals/new",
			"/goals/goal-uuid-1234",
			"/goals/goal-uuid-1234/edit",
			"/midas",
			"/long-term",
			"/long-term/new",
			"/long-term/task-uuid-1234",
			"/income",
			"/income/sources/new",
			"/income/entitlements/new",
			"/income/entitlements/ent-uuid-1234",
			"/income/receipts/new",
			"/income/receipts/rec-uuid-1234",
			"/month-close",
			"/month-close/wizard",
			"/month-close/2026-09",
			"/imports",
			"/imports/batch-uuid-1234",
			"/imports/batch-uuid-1234/review",
			"/notifications",
		];

		expect(all45FrontendRoutes).toHaveLength(45);

		for (const route of all45FrontendRoutes) {
			const mockAssets = createMockAssets();
			const env: AppEnv = { ASSETS: mockAssets };

			const req = new Request(
				`https://gelir-gider-api.erentahiroglu.workers.dev${route}`,
				{
					method: "GET",
					headers: {
						"sec-fetch-mode": "navigate",
						accept:
							"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					},
				},
			);

			const res = await worker.fetch(req, env, dummyCtx);
			expect(res.status, `Route ${route} should return 200`).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			expect(
				mockAssets.callCount(),
				`Route ${route} should call ASSETS.fetch once`,
			).toBe(1);
		}
	});

	it("API subroutes under shared prefixes are NEVER treated as SPA document routes", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const subroutes = [
			"/notifications/subscriptions",
			"/notifications/events",
			"/income/receipts",
			"/income/entitlements",
			"/credit-cards?status=ACTIVE&limit=100",
		];

		for (const path of subroutes) {
			const req = new Request(
				`https://gelir-gider-api.erentahiroglu.workers.dev${path}`,
				{
					method: "GET",
					headers: {
						"sec-fetch-mode": "cors",
						accept: "application/json",
					},
				},
			);
			const res = await worker.fetch(req, env, dummyCtx);
			expect(res.status).toBe(401);
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(mockAssets.callCount()).toBe(0);
		}
	});

	it("mutations (POST/PUT/PATCH/DELETE) are NEVER intercepted by ASSETS even with navigation headers", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const methods = ["POST", "PUT", "PATCH", "DELETE"];
		for (const method of methods) {
			const req = new Request(
				"https://gelir-gider-api.erentahiroglu.workers.dev/transactions",
				{
					method,
					headers: {
						"sec-fetch-mode": "navigate",
						accept: "text/html",
					},
				},
			);
			const res = await worker.fetch(req, env, dummyCtx);
			// Must reach Hono, not ASSETS!
			expect(mockAssets.callCount()).toBe(0);
			expect(res.headers.get("content-type")).toContain("application/json");
		}
	});

	it("health and ready endpoints always reach Hono and return JSON even if requested with document headers", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const healthReq = new Request(
			"https://gelir-gider-api.erentahiroglu.workers.dev/health",
			{
				method: "GET",
				headers: {
					"sec-fetch-mode": "navigate",
					accept: "text/html",
				},
			},
		);
		const healthRes = await worker.fetch(healthReq, env, dummyCtx);
		expect(healthRes.status).toBe(200);
		expect(healthRes.headers.get("content-type")).toContain("application/json");
		const healthJson = (await healthRes.json()) as { status?: string };
		expect(healthJson.status).toBe("ok");
		expect(mockAssets.callCount()).toBe(0);
	});

	it("handles fallback when Sec-Fetch-Mode is omitted but Accept: text/html is provided", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const req = new Request(
			"https://gelir-gider-api.erentahiroglu.workers.dev/notifications",
			{
				method: "GET",
				headers: {
					// No Sec-Fetch-Mode
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
			},
		);

		const res = await worker.fetch(req, env, dummyCtx);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(mockAssets.callCount()).toBe(1);
	});

	it("handles HEAD requests safely by delegating to ASSETS for document navigation", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const req = new Request(
			"https://gelir-gider-api.erentahiroglu.workers.dev/transactions",
			{
				method: "HEAD",
				headers: {
					"sec-fetch-mode": "navigate",
					accept: "text/html",
				},
			},
		);

		const res = await worker.fetch(req, env, dummyCtx);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(mockAssets.callCount()).toBe(1);
	});

	it("trailing slashes on SPA routes are normalized and delegate to ASSETS", async () => {
		const mockAssets = createMockAssets();
		const env: AppEnv = { ASSETS: mockAssets };

		const req = new Request(
			"https://gelir-gider-api.erentahiroglu.workers.dev/notifications/",
			{
				method: "GET",
				headers: {
					"sec-fetch-mode": "navigate",
					accept: "text/html",
				},
			},
		);

		const res = await worker.fetch(req, env, dummyCtx);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(mockAssets.callCount()).toBe(1);
	});
});
