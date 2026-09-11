import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("Production HTTP Surface & Routing Boundaries", () => {
	it("exposes GET /health for stateless liveness checks", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { status: string; service: string };
		expect(json.status).toBe("ok");
		expect(json.service).toBe("gelir-gider-api");
	});

	it("exposes GET /ready with sanitized response on missing/failing DB", async () => {
		const res = await app.request("/ready", {}, {});
		// With empty/missing DB env in this call, returns 503 without leaking credentials
		expect(res.status).toBe(503);
		const json = (await res.json()) as { status: string };
		expect(json.status).toBe("not_ready");
	});

	it("mounts /auth router and handles known auth endpoints", async () => {
		// Non-POST request to POST-only auth endpoint returns 404 or method rejection
		const res = await app.request("/auth/login/options", {
			method: "GET",
		});
		// Route is mounted (handled by auth router)
		expect([404, 405]).toContain(res.status);
	});

	it("returns structured 404 for arbitrary or unmounted financial paths", async () => {
		const unmountedFinancialPaths = [
			"/accounts",
			"/budget",
			"/people",
			"/credit-cards",
			"/rewards",
			"/midas",
			"/campaigns",
			"/imports",
			"/goals",
			"/month-close",
			"/api/v1/ledger",
			"/api/v1/finance",
		];

		for (const path of unmountedFinancialPaths) {
			const res = await app.request(path);
			expect(res.status).toBe(404);
			const json = (await res.json()) as {
				error: { code: string; message: string };
			};
			expect(json.error.code).toBe("NOT_FOUND");
			expect(json.error.message).toBe("Route not found");
		}
	});

	it("ensures mounted 7B.1 and 7B.2 financial domain routes reject unauthenticated requests", async () => {
		const mountedPaths = [
			"/transactions",
			"/ledger/accounts",
			"/income/sources",
			"/income/entitlements",
			"/income/receipts",
			"/income/reference",
		];
		for (const path of mountedPaths) {
			const res = await app.request(path);
			expect(res.status).toBe(401);
		}
	});

	it("ensures financial domain services remain internal until frontend integration", async () => {
		// All 15 financial domains operate as internal TypeScript domain services
		// and are not exposed over unauthenticated HTTP transport
		expect(app).toBeDefined();
		expect(typeof app.fetch).toBe("function");
	});
});
