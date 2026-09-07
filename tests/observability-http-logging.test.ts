import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";

/**
 * Phase 18-R1 Section G.3 regression test: previously, when a downstream
 * handler threw, the request-logging middleware's `catch` block logged one
 * HTTP_REQUEST_FAILED event (no status code, since the response hadn't been
 * built yet) and then Hono's own `app.onError` handler ALSO logged a SECOND
 * HTTP_REQUEST_FAILED event (this time with statusCode: 500) before
 * returning the generic 500 body -- two events for one failed request.
 * Failure-path logging is now centralized entirely in `app.onError`.
 */
describe("HTTP failure-path logging (Phase 18-R1 Section G.3)", () => {
	it("logs exactly ONE HTTP_REQUEST_FAILED event when a downstream handler throws, and still returns the unchanged generic 500 body", async () => {
		app.get("/__test-throws-for-logging-regression", () => {
			throw new Error("boom");
		});

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await app.request("/__test-throws-for-logging-regression");
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body).toEqual({
				error: { code: "INTERNAL_ERROR", message: "Internal server error" },
			});

			const failedEventLines = errorSpy.mock.calls
				.map(([line]) => line)
				.filter(
					(line): line is string =>
						typeof line === "string" && line.includes('"HTTP_REQUEST_FAILED"'),
				);
			expect(failedEventLines).toHaveLength(1);

			// The single logged event has the real status code (500), which only
			// `app.onError` has access to.
			const parsed = JSON.parse(failedEventLines[0] as string);
			expect(parsed.statusCode).toBe(500);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("logs exactly ONE HTTP_REQUEST_COMPLETED event (info) for a normal successful request", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const res = await app.request("/health");
			expect(res.status).toBe(200);
			const completedLines = logSpy.mock.calls
				.map(([line]) => line)
				.filter(
					(line): line is string =>
						typeof line === "string" &&
						line.includes('"HTTP_REQUEST_COMPLETED"'),
				);
			expect(completedLines).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});
});
