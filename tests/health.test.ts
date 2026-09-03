import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("Worker Health & Routing Endpoints", () => {
	it("GET /health returns 200 with service information", async () => {
		const res = await app.request("/health");

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body.service).toBe("gelir-gider-api");
	});

	it("GET /does-not-exist returns 404 with structured error JSON", async () => {
		const res = await app.request("/does-not-exist");

		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as {
			error?: { code?: string; message?: string };
		};
		expect(body.error).toBeDefined();
		expect(body.error?.code).toBe("NOT_FOUND");
		expect(body.error?.message).toBe("Route not found");
	});

	it("GET /health does not leak environment, database credentials, or stack trace", async () => {
		const res = await app.request("/health");
		const body = (await res.json()) as Record<string, unknown>;

		expect(body).not.toHaveProperty("env");
		expect(body).not.toHaveProperty("databaseUrl");
		expect(body).not.toHaveProperty("DATABASE_URL");
		expect(body).not.toHaveProperty("stack");
		expect(body).not.toHaveProperty("secret");
	});
});
