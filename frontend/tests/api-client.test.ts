import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, onSessionLost } from "../src/api/client";
import { ApiError } from "../src/api/errors";

describe("F1 Same-Origin API Client", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("1. constructs relative same-origin requests cleanly", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await apiFetch<{ status: string }>("/health");

		expect(result).toEqual({ status: "ok" });
		expect(fetchMock).toHaveBeenCalledWith("/health", expect.any(Object));
	});

	it("2. enforces credentials: 'same-origin' on all requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await apiFetch("/auth/status");

		expect(fetchMock).toHaveBeenCalledWith(
			"/auth/status",
			expect.objectContaining({
				credentials: "same-origin",
			}),
		);
	});

	it("3. sends Content-Type: application/json ONLY when JSON body exists", async () => {
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		// With JSON body
		await apiFetch("/auth/bootstrap/authorize", {
			method: "POST",
			json: { bootstrapToken: "token123", displayName: "Eren" },
		});

		const firstCallInit = fetchMock.mock.calls[0]?.[1];
		expect(firstCallInit.headers.get("Content-Type")).toBe("application/json");
		expect(firstCallInit.body).toBe(
			JSON.stringify({ bootstrapToken: "token123", displayName: "Eren" }),
		);

		// Without JSON body
		await apiFetch("/auth/passkey/authentication/options", {
			method: "POST",
		});

		const secondCallInit = fetchMock.mock.calls[1]?.[1];
		expect(secondCallInit.headers.get("Content-Type")).toBeNull();
		expect(secondCallInit.body).toBeUndefined();
	});

	it("4. standardizes backend error envelopes into ApiError", async () => {
		const errorResponse = {
			error: {
				code: "BOOTSTRAP_INVALID",
				message: "Invalid bootstrap token",
			},
		};
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify(errorResponse), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			apiFetch("/auth/bootstrap/authorize", {
				method: "POST",
				json: { bootstrapToken: "bad", displayName: "Eren" },
			}),
		).rejects.toThrow(ApiError);

		try {
			await apiFetch("/auth/bootstrap/authorize", {
				method: "POST",
				json: { bootstrapToken: "bad", displayName: "Eren" },
			});
		} catch (err: any) {
			expect(err).toBeInstanceOf(ApiError);
			expect(err.code).toBe("BOOTSTRAP_INVALID");
			expect(err.status).toBe(403);
			expect(err.userMessage).toContain("kurulum anahtarı");
		}
	});

	it("5. preserves HTTP status codes on errors", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "AUTH_RATE_LIMITED", message: "Rate limit exceeded" },
				}),
				{
					status: 429,
					headers: { "Content-Type": "application/json", "Retry-After": "60" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			await apiFetch("/auth/passkey/authentication/options", {
				method: "POST",
			});
			expect.unreachable("Should have thrown");
		} catch (err: any) {
			expect(err.status).toBe(429);
			expect(err.code).toBe("AUTH_RATE_LIMITED");
			expect(err.retryAfter).toBe(60);
		}
	});

	it("6. captures X-Request-ID header from responses", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "INTERNAL_ERROR", message: "Something broke" },
				}),
				{
					status: 500,
					headers: {
						"Content-Type": "application/json",
						"X-Request-ID": "req-xyz-789",
					},
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			await apiFetch("/any-endpoint");
			expect.unreachable("Should have thrown");
		} catch (err: any) {
			expect(err.requestId).toBe("req-xyz-789");
		}
	});

	it("7. signals 401 UNAUTHENTICATED session loss to registered listeners", async () => {
		const sessionLossSpy = vi.fn();
		const unsubscribe = onSessionLost(sessionLossSpy);

		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "UNAUTHENTICATED", message: "Auth required" },
				}),
				{
					status: 401,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			await apiFetch("/auth/session");
		} catch {
			// Expected
		}

		expect(sessionLossSpy).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("8. handles network failures gracefully", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
		vi.stubGlobal("fetch", fetchMock);

		try {
			await apiFetch("/health");
			expect.unreachable("Should have thrown");
		} catch (err: any) {
			expect(err).toBeInstanceOf(ApiError);
			expect(err.code).toBe("NETWORK_ERROR");
			expect(err.status).toBe(0);
		}
	});

	it("9. handles unparseable / malformed responses cleanly", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("Not JSON at all", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			await apiFetch("/some-route");
			expect.unreachable("Should have thrown");
		} catch (err: any) {
			expect(err).toBeInstanceOf(ApiError);
			expect(err.code).toBe("UNPARSEABLE_RESPONSE");
		}
	});

	it("10. CRITICAL: NEVER manually injects Origin header (browser supplies it)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		// Even if caller inadvertently tries to pass an Origin header, client strips it
		await apiFetch("/auth/logout", {
			method: "POST",
			headers: {
				Origin: "http://attacker.com",
				origin: "http://malicious.com",
			},
		});

		const callHeaders = fetchMock.mock.calls[0]?.[1].headers as Headers;
		expect(callHeaders.get("Origin")).toBeNull();
		expect(callHeaders.get("origin")).toBeNull();
	});
});
