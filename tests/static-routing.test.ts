import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("Static Routing & Backend Precedence", () => {
	it("GET /health reaches Hono and returns 200 JSON", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as { status: string; service: string };
		expect(body.status).toBe("ok");
		expect(body.service).toBe("gelir-gider-api");
	});

	it("backend API route misses under /auth/* return structured JSON 404 (NEVER index.html)", async () => {
		const res = await app.request("/auth/does-not-exist");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(body.error?.code).toBe("NOT_FOUND");
		expect(body.error?.message).toBe("Route not found");

		const rawText = JSON.stringify(body);
		expect(rawText).not.toContain("<!DOCTYPE html>");
		expect(rawText).not.toContain("<html");
	});

	it("backend API route misses under /budget-v2/* return backend JSON (NEVER index.html)", async () => {
		const budgetRes = await app.request("/budget-v2/unknown-endpoint");
		expect(budgetRes.status).toBe(401);
		expect(budgetRes.headers.get("content-type")).toContain("application/json");

		const body = (await budgetRes.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(body.error?.code).toBe("UNAUTHENTICATED");
		expect(body.error?.message).toBe("Authentication required");
	});
});
