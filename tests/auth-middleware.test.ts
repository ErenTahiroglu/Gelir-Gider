import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionsModule from "../src/auth/sessions";
import type { AppEnv } from "../src/config/env";
import type { Database } from "../src/db/client";
import * as dbClientModule from "../src/db/client";
import {
	type AuthVariables,
	requireAuthenticatedSession,
	resolveAuthenticatedSession,
} from "../src/http/auth-middleware";

const mockEnv: AppEnv = {
	DATABASE_URL: "postgresql://user:password@example.invalid/db",
	WEBAUTHN_RP_ID: "localhost",
	WEBAUTHN_RP_NAME: "Gelir Gider",
	WEBAUTHN_ORIGIN: "http://localhost:8787",
	BOOTSTRAP_TOKEN_HASH:
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("Authenticated Request Boundary & Session Resolver (Phase 3H)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("resolveAuthenticatedSession", () => {
		it("returns INVALID_SESSION when token is empty or whitespace", async () => {
			const mockDb = {} as Database;
			const res1 = await resolveAuthenticatedSession({ db: mockDb, token: "" });
			const res2 = await resolveAuthenticatedSession({
				db: mockDb,
				token: "   ",
			});

			expect(res1).toEqual({
				authenticated: false,
				reason: "INVALID_SESSION",
			});
			expect(res2).toEqual({
				authenticated: false,
				reason: "INVALID_SESSION",
			});
		});

		it("returns INVALID_SESSION when session token is not found or inactive", async () => {
			const mockDb = {} as Database;
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockResolvedValueOnce(null);

			const result = await resolveAuthenticatedSession({
				db: mockDb,
				token: "unknown-token",
			});

			expect(result).toEqual({
				authenticated: false,
				reason: "INVALID_SESSION",
			});
		});

		it("handles touch returning false (throttled) and successfully resolves when second lookup confirms active session", async () => {
			const activeSession = {
				id: "sess-1",
				userId: "user-1",
				createdAt: new Date(),
				expiresAt: new Date(),
				lastSeenAt: new Date(),
			};

			vi.spyOn(sessionsModule, "findActiveSessionByToken")
				.mockResolvedValueOnce(activeSession)
				.mockResolvedValueOnce(activeSession);

			vi.spyOn(sessionsModule, "touchSessionActivity").mockResolvedValueOnce(
				false,
			);

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: "user-1",
									displayName: "Eren",
									authInitializedAt: new Date(),
								},
							]),
						}),
					}),
				}),
			} as unknown as Database;

			const result = await resolveAuthenticatedSession({
				db: mockDb,
				token: "throttled-token",
			});

			expect(result.authenticated).toBe(true);
			if (result.authenticated) {
				expect(result.context).toEqual({
					userId: "user-1",
					displayName: "Eren",
					sessionId: "sess-1",
				});
				// Ensure no token or secret leak in returned context
				expect(
					(result.context as unknown as Record<string, unknown>).token,
				).toBeUndefined();
				expect(
					(result.context as unknown as Record<string, unknown>).tokenHash,
				).toBeUndefined();
			}
		});

		it("returns INVALID_SESSION when touch returns false and second lookup returns null (concurrent revocation)", async () => {
			vi.spyOn(sessionsModule, "findActiveSessionByToken")
				.mockResolvedValueOnce({
					id: "sess-1",
					userId: "user-1",
					createdAt: new Date(),
					expiresAt: new Date(),
					lastSeenAt: new Date(),
				})
				.mockResolvedValueOnce(null);

			vi.spyOn(sessionsModule, "touchSessionActivity").mockResolvedValueOnce(
				false,
			);

			const mockDb = {} as Database;
			const result = await resolveAuthenticatedSession({
				db: mockDb,
				token: "revoked-token",
			});

			expect(result).toEqual({
				authenticated: false,
				reason: "INVALID_SESSION",
			});
		});

		it("returns INVALID_SESSION when resolved user is missing or authInitializedAt is null", async () => {
			const activeSession = {
				id: "sess-1",
				userId: "user-1",
				createdAt: new Date(),
				expiresAt: new Date(),
				lastSeenAt: new Date(),
			};

			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockResolvedValueOnce(activeSession);
			vi.spyOn(sessionsModule, "touchSessionActivity").mockResolvedValueOnce(
				true,
			);

			// User with authInitializedAt === null
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: "user-1",
									displayName: "Eren",
									authInitializedAt: null,
								},
							]),
						}),
					}),
				}),
			} as unknown as Database;

			const result = await resolveAuthenticatedSession({
				db: mockDb,
				token: "valid-token-uninit-user",
			});

			expect(result).toEqual({
				authenticated: false,
				reason: "INVALID_SESSION",
			});
		});

		it("throws when database query throws", async () => {
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockRejectedValueOnce(new Error("DB connection failure"));

			const mockDb = {} as Database;
			await expect(
				resolveAuthenticatedSession({ db: mockDb, token: "any-token" }),
			).rejects.toThrow("DB connection failure");
		});
	});

	describe("requireAuthenticatedSession middleware", () => {
		function createTestApp() {
			const testApp = new Hono<{
				Bindings: AppEnv;
				Variables: AuthVariables;
			}>();

			testApp.use("/protected", requireAuthenticatedSession);
			testApp.get("/protected", (c) => {
				const auth = c.get("auth");
				return c.json({
					ok: true,
					user: {
						userId: auth.userId,
						displayName: auth.displayName,
					},
					sessionId: auth.sessionId,
				});
			});

			return testApp;
		}

		it("returns 401 UNAUTHENTICATED without Set-Cookie clear when session cookie is missing", async () => {
			const testApp = createTestApp();
			const res = await testApp.request(
				"/protected",
				{ method: "GET" },
				mockEnv,
			);

			expect(res.status).toBe(401);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json).toEqual({
				error: {
					code: "UNAUTHENTICATED",
					message: "Authentication required",
				},
			});
			expect(res.headers.get("Set-Cookie")).toBeNull();
		});

		it("returns 401 UNAUTHENTICATED and clears cookie when token is invalid/unknown", async () => {
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockResolvedValueOnce(null);
			const mockDb = {} as Database;
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const testApp = createTestApp();
			const res = await testApp.request(
				"/protected",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=invalid-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json).toEqual({
				error: {
					code: "UNAUTHENTICATED",
					message: "Authentication required",
				},
			});
			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
		});

		it("returns 401 UNAUTHENTICATED and clears cookie when user is uninitialized", async () => {
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockResolvedValueOnce({
				id: "sess-1",
				userId: "user-1",
				createdAt: new Date(),
				expiresAt: new Date(),
				lastSeenAt: new Date(),
			});
			vi.spyOn(sessionsModule, "touchSessionActivity").mockResolvedValueOnce(
				true,
			);

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: "user-1",
									displayName: "Eren",
									authInitializedAt: null,
								},
							]),
						}),
					}),
				}),
			} as unknown as Database;
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const testApp = createTestApp();
			const res = await testApp.request(
				"/protected",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=stale-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
		});

		it("allows request to proceed to handler and populates c.get('auth') on valid active session", async () => {
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockResolvedValueOnce({
				id: "sess-123",
				userId: "user-456",
				createdAt: new Date(),
				expiresAt: new Date(),
				lastSeenAt: new Date(),
			});
			vi.spyOn(sessionsModule, "touchSessionActivity").mockResolvedValueOnce(
				true,
			);

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: "user-456",
									displayName: "Eren Tahiroglu",
									authInitializedAt: new Date(),
								},
							]),
						}),
					}),
				}),
			} as unknown as Database;
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const testApp = createTestApp();
			const res = await testApp.request(
				"/protected",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=valid-active-session-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json).toEqual({
				ok: true,
				user: {
					userId: "user-456",
					displayName: "Eren Tahiroglu",
				},
				sessionId: "sess-123",
			});
		});

		it("fails closed with 500 INTERNAL_ERROR and does NOT clear cookie when database throws", async () => {
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockRejectedValueOnce(new Error("Neon connection timed out"));
			const mockDb = {} as Database;
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const testApp = createTestApp();
			const res = await testApp.request(
				"/protected",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=valid-active-session-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(500);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json).toEqual({
				error: {
					code: "INTERNAL_ERROR",
					message: "Internal server error",
				},
			});
			// Crucial: Set-Cookie MUST NOT be sent on operational failure
			expect(res.headers.get("Set-Cookie")).toBeNull();
		});
	});
});
