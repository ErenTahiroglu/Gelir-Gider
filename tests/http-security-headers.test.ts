import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("Global HTTP security headers", () => {
	it("sets every required security header on a normal route response", async () => {
		const res = await app.request("/health");

		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Permissions-Policy")).toBe(
			"geolocation=(), camera=(), microphone=(), payment=()",
		);
		expect(res.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		);
	});

	it("sets security headers on a 404 response too (global middleware)", async () => {
		const res = await app.request("/does-not-exist");
		expect(res.status).toBe(404);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		);
	});

	it("does not set Strict-Transport-Security in this phase", async () => {
		const res = await app.request("/health");
		expect(res.headers.get("Strict-Transport-Security")).toBeNull();
	});
});

describe("Request ID generation", () => {
	it("generates a fresh UUID-shaped X-Request-ID on every response", async () => {
		const res = await app.request("/health");
		const requestId = res.headers.get("X-Request-ID");
		expect(requestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("never trusts a spoofed inbound X-Request-ID header", async () => {
		const spoofed = "00000000-0000-0000-0000-000000000000";
		const res = await app.request("/health", {
			headers: { "X-Request-ID": spoofed },
		});
		const requestId = res.headers.get("X-Request-ID");
		expect(requestId).not.toBe(spoofed);
		expect(requestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("generates a DIFFERENT request ID for two separate requests", async () => {
		const res1 = await app.request("/health");
		const res2 = await app.request("/health");
		expect(res1.headers.get("X-Request-ID")).not.toBe(
			res2.headers.get("X-Request-ID"),
		);
	});
});

describe("/health vs /ready DB dependency", () => {
	it("/health returns 200 with no DATABASE_URL configured", async () => {
		const res = await app.request("/health", {}, {});
		expect(res.status).toBe(200);
	});

	it("/ready returns 503 with no DATABASE_URL configured", async () => {
		const res = await app.request("/ready", {}, {});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("not_ready");
	});

	it("/ready response body never leaks DB details on failure", async () => {
		const res = await app.request("/ready", {}, {});
		const text = await res.text();
		expect(text).not.toContain("postgresql://");
		expect(text).not.toContain("DATABASE_URL");
		expect(text).not.toContain("stack");
	});
});
