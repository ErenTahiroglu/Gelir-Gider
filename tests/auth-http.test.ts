import { beforeEach, describe, expect, it, vi } from "vitest";
import * as bootstrapModule from "../src/auth/bootstrap";
import * as sessionsModule from "../src/auth/sessions";
import * as verificationModule from "../src/auth/verification";
import * as webauthnModule from "../src/auth/webauthn";
import type { Database } from "../src/db/client";
import * as dbClientModule from "../src/db/client";
import { app } from "../src/index";

interface ErrorResponseBody {
	error: {
		code: string;
		message: string;
	};
	bootstrapToken?: string;
	recoveryCode?: string;
}

interface UserResponseBody {
	state?: string;
	enrollmentGrantToken?: string;
	bootstrapToken?: string;
	recoveryCode?: {
		canonical: string;
		display: string;
	};
	authenticated?: boolean;
	user?: {
		displayName?: string;
		id?: string;
	};
	warning?: {
		code: string;
		message: string;
	};
	error?: {
		code: string;
		message: string;
	};
	challenge?: string;
}

const createMockLimiter = (allowed = true) => ({
	limit: vi.fn().mockResolvedValue({ success: allowed }),
});

const mockEnv = {
	DATABASE_URL: "postgresql://user:password@example.invalid/db",
	WEBAUTHN_RP_ID: "localhost",
	WEBAUTHN_RP_NAME: "Gelir Gider",
	WEBAUTHN_ORIGIN: "http://localhost:8787",
	BOOTSTRAP_TOKEN_HASH:
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	AUTH_RATE_LIMITER: createMockLimiter(true),
};

describe("HTTP Auth Surface & Secure Session Cookie Integration", () => {
	const validOrigin = "http://localhost:8787";

	beforeEach(() => {
		vi.restoreAllMocks();
		mockEnv.AUTH_RATE_LIMITER = createMockLimiter(true);
	});

	describe("Global Auth Policies (Origin, Body Limit, Content-Type, Cache-Control, No CORS)", () => {
		it("enforces Cache-Control: no-store and Pragma: no-cache on all /auth/* routes including error responses", async () => {
			const res = await app.request("/auth/status", { method: "GET" }, mockEnv);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Pragma")).toBe("no-cache");
			expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();

			// Also verify error responses receive Cache-Control: no-store
			const errRes = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: { Origin: "http://attacker.com" },
				},
				mockEnv,
			);
			expect(errRes.status).toBe(403);
			expect(errRes.headers.get("Cache-Control")).toBe("no-store");
			expect(errRes.headers.get("Pragma")).toBe("no-cache");
		});

		it("evaluates Origin BEFORE Content-Type and rejects with 403 INVALID_ORIGIN even if Content-Type is invalid/absent", async () => {
			const bootstrapSpy = vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			);

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: "http://attacker.com",
						"Content-Type": "text/plain", // Even with bad content-type, Origin check must fire first
					},
					body: "bootstrapToken=abc",
				},
				mockEnv,
			);

			expect(res.status).toBe(403);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("INVALID_ORIGIN");
			expect(bootstrapSpy).not.toHaveBeenCalled();
		});

		it("strictly validates application/json media type — accepts application/json, application/json; charset=utf-8, and APPLICATION/JSON", async () => {
			vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			).mockResolvedValue({
				user: { id: "user-1", displayName: "Eren" },
				enrollmentGrant: "grant-token-123",
			});

			const validTypes = [
				"application/json",
				"application/json; charset=utf-8",
				"APPLICATION/JSON",
			];

			for (const ct of validTypes) {
				const res = await app.request(
					"/auth/bootstrap/authorize",
					{
						method: "POST",
						headers: {
							Origin: validOrigin,
							"Content-Type": ct,
						},
						body: JSON.stringify({
							bootstrapToken: "secret-token",
							displayName: "Eren",
						}),
					},
					mockEnv,
				);

				expect(res.status).toBe(200);
			}
		});

		it("strictly rejects non-exact media types: application/jsonp, text/plain, text/plain; foo=application/json, x-application/json, application/problem+json (415 UNSUPPORTED_MEDIA_TYPE)", async () => {
			const bootstrapSpy = vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			);

			const invalidTypes = [
				"application/jsonp",
				"text/plain",
				"text/plain; foo=application/json",
				"x-application/json",
				"application/problem+json",
			];

			for (const ct of invalidTypes) {
				const res = await app.request(
					"/auth/bootstrap/authorize",
					{
						method: "POST",
						headers: {
							Origin: validOrigin,
							"Content-Type": ct,
						},
						body: JSON.stringify({
							bootstrapToken: "secret-token",
							displayName: "Eren",
						}),
					},
					mockEnv,
				);

				expect(res.status).toBe(415);
				const json = (await res.json()) as ErrorResponseBody;
				expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
			}

			expect(bootstrapSpy).not.toHaveBeenCalled();
		});

		it("rejects POST /auth/* with malformed JSON body (400 INVALID_REQUEST)", async () => {
			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: "{ malformed json",
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json.error.code).toBe("INVALID_REQUEST");
		});

		it("rejects oversized request body > 256 KiB (413 REQUEST_TOO_LARGE)", async () => {
			const largeString = "a".repeat(260 * 1024);
			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						bootstrapToken: largeString,
						displayName: "Eren",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(413);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json.error.code).toBe("REQUEST_TOO_LARGE");
		});
	});

	describe("GET /auth/status", () => {
		it("returns UNINITIALIZED state when no user exists", async () => {
			vi.spyOn(bootstrapModule, "authorizeBootstrapAndIssueGrant");
			// Mock DB select returning empty
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([]),
					}),
				}),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const res = await app.request("/auth/status", { method: "GET" }, mockEnv);
			expect(res.status).toBe(200);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json).toEqual({ state: "UNINITIALIZED" });
		});

		it("returns INITIALIZED state when user exists with authInitializedAt and invariants pass", async () => {
			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation(() => ({
						limit: vi
							.fn()
							.mockResolvedValue([
								{ id: "user-1", authInitializedAt: new Date() },
							]),
						where: vi.fn().mockImplementation(() => {
							// Return active cred count >= 1 and active rec count === 1
							return Promise.resolve([{ count: 1 }]);
						}),
					})),
				})),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const res = await app.request("/auth/status", { method: "GET" }, mockEnv);
			expect(res.status).toBe(200);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json).toEqual({ state: "INITIALIZED" });
		});

		it("returns 503 AUTH_STATE_INCONSISTENT when initialized user has zero credentials", async () => {
			let selectCallCount = 0;
			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation(() => ({
						limit: vi
							.fn()
							.mockResolvedValue([
								{ id: "user-1", authInitializedAt: new Date() },
							]),
						where: vi.fn().mockImplementation(() => {
							selectCallCount++;
							if (selectCallCount === 1) return Promise.resolve([{ count: 0 }]); // 0 creds!
							return Promise.resolve([{ count: 1 }]); // 1 rec
						}),
					})),
				})),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const res = await app.request("/auth/status", { method: "GET" }, mockEnv);
			expect(res.status).toBe(503);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json.error.code).toBe("AUTH_STATE_INCONSISTENT");
		});
	});

	describe("POST /auth/bootstrap/authorize & POST /auth/recovery/authorize", () => {
		it("authorizes bootstrap successfully and returns enrollment grant token without echoing bootstrap token", async () => {
			const spy = vi
				.spyOn(bootstrapModule, "authorizeBootstrapAndIssueGrant")
				.mockResolvedValueOnce({
					user: { id: "user-1", displayName: "Eren" },
					enrollmentGrant: "grant-token-12345",
				});

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						bootstrapToken: "secret-bootstrap-token",
						displayName: "Eren",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json).toEqual({ enrollmentGrantToken: "grant-token-12345" });
			expect(json.bootstrapToken).toBeUndefined();
			expect(spy).toHaveBeenCalled();
		});

		it("maps BOOTSTRAP_INVALID to 403 sanitized response", async () => {
			vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			).mockRejectedValueOnce(
				new bootstrapModule.AuthError(
					"BOOTSTRAP_INVALID",
					"Invalid bootstrap credentials",
				),
			);

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						bootstrapToken: "wrong-token",
						displayName: "Eren",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(403);
			const json = (await res.json()) as ErrorResponseBody;

			expect(json.error.code).toBe("BOOTSTRAP_INVALID");
		});

		it("authorizes recovery successfully and returns enrollment grant token without echoing recovery code", async () => {
			const spy = vi
				.spyOn(bootstrapModule, "authorizeRecoveryAndIssueGrant")
				.mockResolvedValueOnce({
					user: { id: "user-1", displayName: "Eren" },
					enrollmentGrant: "rec-grant-token-67890",
				});

			const res = await app.request(
				"/auth/recovery/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						recoveryCode: "A1B2-C3D4-E5F6-G7H8",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json).toEqual({ enrollmentGrantToken: "rec-grant-token-67890" });
			expect(json.recoveryCode).toBeUndefined();
			expect(spy).toHaveBeenCalled();
		});
	});

	describe("POST /auth/passkey/enrollment/options & POST /auth/passkey/enrollment/verify", () => {
		it("calls beginAuthorizedPasskeyEnrollment and returns options JSON", async () => {
			const mockOptions = {
				challenge: "test-enroll-challenge",
				rp: { name: "Gelir Gider", id: "localhost" },
				user: { id: "user-1", name: "Eren", displayName: "Eren" },
				pubKeyCredParams: [],
			} as unknown as Awaited<
				ReturnType<typeof verificationModule.beginAuthorizedPasskeyEnrollment>
			>;

			vi.spyOn(
				verificationModule,
				"beginAuthorizedPasskeyEnrollment",
			).mockResolvedValueOnce(mockOptions);

			const res = await app.request(
				"/auth/passkey/enrollment/options",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						enrollmentGrantToken: "valid-grant-token",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.challenge).toBe("test-enroll-challenge");
		});

		it("completes passkey enrollment and establishes session with secure cookie", async () => {
			vi.spyOn(
				verificationModule,
				"completeAuthorizedPasskeyEnrollment",
			).mockResolvedValueOnce({
				verified: true,
				purpose: "BOOTSTRAP",
				user: { id: "user-1", displayName: "Eren" },
				credential: {
					id: "cred-db-id",
					credentialId: "cred-webauthn-id",
					deviceName: "MacBook Pro",
				},
				recoveryCode: {
					canonical: "A1B2C3D4E5F6G7H8",
					display: "A1B2-C3D4-E5F6-G7H8",
				},
			});

			vi.spyOn(sessionsModule, "createSession").mockResolvedValueOnce({
				token: "test-raw-session-token-12345678901234567890",
				session: {
					id: "sess-1",
					userId: "user-1",
					createdAt: new Date(),
					expiresAt: new Date(),
					lastSeenAt: new Date(),
					revokedAt: null,
				},
			});

			const res = await app.request(
				"/auth/passkey/enrollment/verify",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: {
							id: "cred-webauthn-id",
							rawId: "cred-webauthn-id",
							response: { clientDataJSON: "abc", attestationObject: "def" },
							type: "public-key",
						},
						deviceName: "MacBook Pro",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.verified).toBe(true);
			expect(json.authenticated).toBe(true);
			expect(json.recoveryCode).toEqual({
				canonical: "A1B2C3D4E5F6G7H8",
				display: "A1B2-C3D4-E5F6-G7H8",
			});
			expect(json.sessionToken).toBeUndefined();

			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain(
				"__Host-gg_session=test-raw-session-token-12345678901234567890",
			);
			expect(cookie).toContain("Path=/");
			expect(cookie).toContain("Secure");
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("SameSite=Strict");
			expect(cookie).toContain("Max-Age=2592000");
			expect(cookie).not.toContain("Domain=");
		});

		it("CRITICAL: handles post-finalization session failure without swallowing recovery code (authenticated=false & warning)", async () => {
			vi.spyOn(
				verificationModule,
				"completeAuthorizedPasskeyEnrollment",
			).mockResolvedValueOnce({
				verified: true,
				purpose: "BOOTSTRAP",
				user: { id: "user-1", displayName: "Eren" },
				credential: {
					id: "cred-db-id",
					credentialId: "cred-webauthn-id",
					deviceName: "MacBook Pro",
				},
				recoveryCode: {
					canonical: "A1B2C3D4E5F6G7H8",
					display: "A1B2-C3D4-E5F6-G7H8",
				},
			});

			// Simulate session creation DB failure AFTER enrollment finalization
			vi.spyOn(sessionsModule, "createSession").mockRejectedValueOnce(
				new Error("DB connection dropped"),
			);

			const res = await app.request(
				"/auth/passkey/enrollment/verify",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: {
							id: "cred-webauthn-id",
							rawId: "cred-webauthn-id",
							response: { clientDataJSON: "abc", attestationObject: "def" },
							type: "public-key",
						},
						deviceName: "MacBook Pro",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200); // NOT generic 500!
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.verified).toBe(true);
			expect(json.authenticated).toBe(false);
			expect(json.recoveryCode).toEqual({
				canonical: "A1B2C3D4E5F6G7H8",
				display: "A1B2-C3D4-E5F6-G7H8",
			});
			expect(json.warning).toEqual({
				code: "SESSION_ESTABLISHMENT_FAILED",
				message: "Enrollment succeeded, but a session could not be established",
			});
			expect(res.headers.get("Set-Cookie")).toBeNull();
		});
	});

	describe("POST /auth/passkey/authentication/options & verify", () => {
		it("rejects authentication options if instance is uninitialized (409 AUTH_NOT_INITIALIZED)", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([]),
					}),
				}),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const res = await app.request(
				"/auth/passkey/authentication/options",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({}),
				},
				mockEnv,
			);

			expect(res.status).toBe(409);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("AUTH_NOT_INITIALIZED");
		});

		it("generates authentication options server-side resolving singleton user without client userId, body or Content-Type", async () => {
			const mockDb = {
				select: vi.fn().mockImplementation(() => ({
					from: vi.fn().mockImplementation(() => ({
						limit: vi
							.fn()
							.mockResolvedValue([
								{ id: "user-1", authInitializedAt: new Date() },
							]),
						where: vi.fn().mockResolvedValue([
							{
								credentialId: "cred-1",
								transports: ["internal"],
								revokedAt: null,
							},
						]),
					})),
				})),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);
			vi.spyOn(
				webauthnModule,
				"generateAuthenticationOptionsForUser",
			).mockResolvedValueOnce({
				challenge: "auth-challenge-xyz",
			} as unknown as Awaited<
				ReturnType<typeof webauthnModule.generateAuthenticationOptionsForUser>
			>);

			// Bodyless request without Content-Type header
			const res = await app.request(
				"/auth/passkey/authentication/options",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.challenge).toBe("auth-challenge-xyz");
		});

		it("verifies authentication and creates session with secure cookie", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: "user-1",
								displayName: "Eren",
								authInitializedAt: new Date(),
							},
						]),
					}),
				}),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			vi.spyOn(
				verificationModule,
				"verifyAuthenticationForUser",
			).mockResolvedValueOnce({
				verified: true,
				authenticationInfo: {
					newCounter: 1,
					credentialID: "cred-1",
					userVerified: true,
					credentialDeviceType: "singleDevice",
					credentialBackedUp: false,
					origin: validOrigin,
					rpID: "localhost",
				},
				credential: {
					id: "cred-db-id",
					userId: "user-1",
					credentialId: "cred-1",
					publicKey: new Uint8Array(),
					signCount: 1,
					deviceName: "MacBook",
					deviceType: "singleDevice",
					transports: null,
					backedUp: false,
					stateVersion: 1,
					createdAt: new Date(),
					lastUsedAt: new Date(),
					revokedAt: null,
				},
			});
			vi.spyOn(sessionsModule, "createSession").mockResolvedValueOnce({
				token: "auth-session-token-99999999999999999999",
				session: {
					id: "sess-1",
					userId: "user-1",
					createdAt: new Date(),
					expiresAt: new Date(),
					lastSeenAt: new Date(),
					revokedAt: null,
				},
			});

			const res = await app.request(
				"/auth/passkey/authentication/verify",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: {
							id: "cred-1",
							rawId: "cred-1",
							response: { clientDataJSON: "abc" },
							type: "public-key",
						},
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as UserResponseBody;

			expect(json.authenticated).toBe(true);
			expect(json.user?.displayName).toBe("Eren");
			expect(res.headers.get("Set-Cookie")).toContain(
				"__Host-gg_session=auth-session-token-99999999999999999999",
			);
		});
	});

	describe("GET /auth/session & POST /auth/logout", () => {
		it("returns 401 UNAUTHENTICATED when no session cookie is sent", async () => {
			const res = await app.request(
				"/auth/session",
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
			const json = (await res.json()) as UserResponseBody;

			expect(json.error?.code).toBe("UNAUTHENTICATED");
		});

		it("returns 401 UNAUTHENTICATED and clear cookie header when session token is invalid/revoked", async () => {
			vi.spyOn(
				sessionsModule,
				"findActiveSessionByToken",
			).mockResolvedValueOnce(null);

			const res = await app.request(
				"/auth/session",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=stale-invalid-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
		});

		it("returns authenticated user info for valid session cookie", async () => {
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
									authInitializedAt: new Date(),
								},
							]),
						}),
					}),
				}),
			} as unknown as Database;

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const res = await app.request(
				"/auth/session",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=valid-active-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as UserResponseBody;

			expect(json.authenticated).toBe(true);
			expect(json.user?.displayName).toBe("Eren");
			expect(json.user?.id).toBeUndefined();
		});

		it("returns 401 and clear cookie when touch returns false and second lookup returns null (concurrent revocation)", async () => {
			vi.spyOn(sessionsModule, "findActiveSessionByToken")
				.mockResolvedValueOnce({
					id: "sess-1",
					userId: "user-1",
					createdAt: new Date(),
					expiresAt: new Date(),
					lastSeenAt: new Date(),
				})
				.mockResolvedValueOnce(null); // Second lookup after touch false returns null

			vi.spyOn(sessionsModule, "touchSessionActivity").mockResolvedValueOnce(
				false,
			);

			const res = await app.request(
				"/auth/session",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=concurrently-revoked-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
		});

		it("returns 200 authenticated when touch returns false due to throttling but second lookup confirms active session", async () => {
			const activeSession = {
				id: "sess-1",
				userId: "user-1",
				createdAt: new Date(),
				expiresAt: new Date(),
				lastSeenAt: new Date(),
			};

			vi.spyOn(sessionsModule, "findActiveSessionByToken")
				.mockResolvedValueOnce(activeSession)
				.mockResolvedValueOnce(activeSession); // Second lookup succeeds (was just throttled)

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

			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const res = await app.request(
				"/auth/session",
				{
					method: "GET",
					headers: {
						Cookie: "__Host-gg_session=throttled-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as UserResponseBody;

			expect(json.authenticated).toBe(true);
			expect(json.user?.displayName).toBe("Eren");
		});

		it("performs idempotent logout without body or Content-Type header, revokes session, and returns clear cookie (204 No Content)", async () => {
			const revokeSpy = vi
				.spyOn(sessionsModule, "revokeSessionByToken")
				.mockResolvedValueOnce(true);

			const res = await app.request(
				"/auth/logout",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						Cookie: "__Host-gg_session=token-to-logout",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(204);
			expect(revokeSpy).toHaveBeenCalled();

			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
			expect(cookie).toContain("Secure");
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("SameSite=Strict");
			expect(cookie).toContain("Path=/");
		});

		it("handles logout when no session cookie is present (idempotent 204 + clear cookie)", async () => {
			const revokeSpy = vi.spyOn(sessionsModule, "revokeSessionByToken");

			const res = await app.request(
				"/auth/logout",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(204);
			expect(revokeSpy).not.toHaveBeenCalled();

			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
		});

		it("handles logout when token is unknown or already revoked (revokeSessionByToken returns false -> 204 + clear cookie)", async () => {
			const revokeSpy = vi
				.spyOn(sessionsModule, "revokeSessionByToken")
				.mockResolvedValueOnce(false);

			const res = await app.request(
				"/auth/logout",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						Cookie: "__Host-gg_session=already-revoked-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(204);
			expect(revokeSpy).toHaveBeenCalled();

			const cookie = res.headers.get("Set-Cookie");
			expect(cookie).toContain("__Host-gg_session=");
			expect(cookie).toContain("Max-Age=0");
		});

		it("fails closed on logout database/operational error — returns 503 SESSION_REVOCATION_FAILED and does NOT clear cookie", async () => {
			vi.spyOn(sessionsModule, "revokeSessionByToken").mockRejectedValueOnce(
				new Error("Database connection timeout"),
			);

			const res = await app.request(
				"/auth/logout",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						Cookie: "__Host-gg_session=active-session-token",
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(503);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("SESSION_REVOCATION_FAILED");
			expect(json.error.message).toBe("Session could not be revoked");

			// Crucial: Set-Cookie MUST NOT be sent on failure so browser does not delete the token
			expect(res.headers.get("Set-Cookie")).toBeNull();
		});
	});

	describe("Cloudflare Workers Rate Limiting Shield (Phase 3H)", () => {
		it("passes through allowed requests and constructs deterministic key with app prefix, static path, and client IP without secrets", async () => {
			const mockLimiter = {
				limit: vi.fn().mockResolvedValue({ success: true }),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			).mockResolvedValueOnce({
				user: { id: "user-1", displayName: "Eren" },
				enrollmentGrant: "grant-token-xyz",
			});

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
						"CF-Connecting-IP": "203.0.113.195",
					},
					body: JSON.stringify({
						bootstrapToken: "secret-bootstrap-token",
						displayName: "Eren",
					}),
				},
				envWithLimiter,
			);

			expect(res.status).toBe(200);
			expect(mockLimiter.limit).toHaveBeenCalledTimes(1);
			const limitArg = mockLimiter.limit.mock.calls[0]?.[0];
			expect(limitArg).toBeDefined();
			expect(limitArg?.key).toBe(
				"gelir-gider:auth:v1:/auth/bootstrap/authorize:203.0.113.195",
			);
			// Verify key contains no secret tokens or display name
			expect(limitArg?.key).not.toContain("secret-bootstrap-token");
			expect(limitArg?.key).not.toContain("Eren");
		});

		it("falls back to client IP 'unknown' when CF-Connecting-IP header is absent", async () => {
			const mockLimiter = {
				limit: vi.fn().mockResolvedValue({ success: true }),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			).mockResolvedValueOnce({
				user: { id: "user-1", displayName: "Eren" },
				enrollmentGrant: "grant-token-xyz",
			});

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						bootstrapToken: "secret-token",
						displayName: "Eren",
					}),
				},
				envWithLimiter,
			);

			expect(res.status).toBe(200);
			expect(mockLimiter.limit).toHaveBeenCalledWith({
				key: "gelir-gider:auth:v1:/auth/bootstrap/authorize:unknown",
			});
		});

		it("returns 429 AUTH_RATE_LIMITED with Retry-After 60 and aborts downstream execution when rate limit is exceeded", async () => {
			const mockLimiter = {
				limit: vi.fn().mockResolvedValue({ success: false }),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			const bootstrapSpy = vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			);

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
						"CF-Connecting-IP": "203.0.113.195",
					},
					body: JSON.stringify({
						bootstrapToken: "token-123",
						displayName: "Eren",
					}),
				},
				envWithLimiter,
			);

			expect(res.status).toBe(429);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("AUTH_RATE_LIMITED");
			expect(json.error.message).toBe("Too many authentication requests");
			expect(res.headers.get("Retry-After")).toBe("60");
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Pragma")).toBe("no-cache");

			// Downstream auth service MUST NOT be reached
			expect(bootstrapSpy).not.toHaveBeenCalled();
		});

		it("fails closed with 503 AUTH_RATE_LIMIT_UNAVAILABLE when limiter binding throws, without leaking raw exception", async () => {
			const mockLimiter = {
				limit: vi.fn().mockRejectedValue(new Error("Cloudflare RPC error")),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			const bootstrapSpy = vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			);

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						bootstrapToken: "token-123",
						displayName: "Eren",
					}),
				},
				envWithLimiter,
			);

			expect(res.status).toBe(503);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("AUTH_RATE_LIMIT_UNAVAILABLE");
			expect(json.error.message).toBe(
				"Authentication protection is temporarily unavailable",
			);
			expect(res.headers.get("Cache-Control")).toBe("no-store");

			// No exception leakage and no downstream call
			expect(bootstrapSpy).not.toHaveBeenCalled();
		});

		it("fails closed with 503 AUTH_RATE_LIMIT_UNAVAILABLE on rate-limited endpoints when AUTH_RATE_LIMITER binding is missing", async () => {
			const envWithoutLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: undefined,
			};

			const bootstrapSpy = vi.spyOn(
				bootstrapModule,
				"authorizeBootstrapAndIssueGrant",
			);

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: validOrigin,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						bootstrapToken: "token-123",
						displayName: "Eren",
					}),
				},
				envWithoutLimiter,
			);

			expect(res.status).toBe(503);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("AUTH_RATE_LIMIT_UNAVAILABLE");
			expect(bootstrapSpy).not.toHaveBeenCalled();
		});

		it("enforces rate-limiting on all 6 public pre-auth POST routes", async () => {
			const mockLimiter = {
				limit: vi.fn().mockResolvedValue({ success: false }),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			const routes = [
				{
					path: "/auth/bootstrap/authorize",
					body: JSON.stringify({ bootstrapToken: "tok", displayName: "Eren" }),
					contentType: "application/json",
				},
				{
					path: "/auth/recovery/authorize",
					body: JSON.stringify({ recoveryCode: "rec" }),
					contentType: "application/json",
				},
				{
					path: "/auth/passkey/enrollment/options",
					body: JSON.stringify({ enrollmentGrantToken: "grant" }),
					contentType: "application/json",
				},
				{
					path: "/auth/passkey/enrollment/verify",
					body: JSON.stringify({
						response: { id: "1", rawId: "1", type: "public-key" },
						deviceName: "Dev",
					}),
					contentType: "application/json",
				},
				{
					path: "/auth/passkey/authentication/options",
					body: undefined,
					contentType: undefined,
				},
				{
					path: "/auth/passkey/authentication/verify",
					body: JSON.stringify({
						response: { id: "1", rawId: "1", type: "public-key" },
					}),
					contentType: "application/json",
				},
			];

			for (const r of routes) {
				const headers: Record<string, string> = { Origin: validOrigin };
				if (r.contentType) headers["Content-Type"] = r.contentType;

				const res = await app.request(
					r.path,
					{
						method: "POST",
						headers,
						body: r.body ?? null,
					},
					envWithLimiter,
				);

				expect(res.status).toBe(429);
				const json = (await res.json()) as ErrorResponseBody;
				expect(json.error.code).toBe("AUTH_RATE_LIMITED");
			}
		});

		it("exempts status, session, and logout endpoints from rate limiting", async () => {
			const mockLimiter = {
				limit: vi.fn(),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			// 1. GET /auth/status
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([]),
					}),
				}),
			} as unknown as Database;
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb);

			const statusRes = await app.request(
				"/auth/status",
				{ method: "GET" },
				envWithLimiter,
			);
			expect(statusRes.status).toBe(200);

			// 2. GET /auth/session (missing cookie -> 401 without limiter)
			const sessionRes = await app.request(
				"/auth/session",
				{ method: "GET" },
				envWithLimiter,
			);
			expect(sessionRes.status).toBe(401);

			// 3. POST /auth/logout (even without limiter in env, works)
			const logoutRes = await app.request(
				"/auth/logout",
				{
					method: "POST",
					headers: { Origin: validOrigin },
				},
				{ ...mockEnv, AUTH_RATE_LIMITER: undefined },
			);
			expect(logoutRes.status).toBe(204);

			// Limiter was never called
			expect(mockLimiter.limit).not.toHaveBeenCalled();
		});

		it("evaluates Origin BEFORE rate limiting — invalid Origin does not consume rate limiter counters", async () => {
			const mockLimiter = {
				limit: vi.fn().mockResolvedValue({ success: true }),
			};
			const envWithLimiter = {
				...mockEnv,
				AUTH_RATE_LIMITER: mockLimiter,
			};

			const res = await app.request(
				"/auth/bootstrap/authorize",
				{
					method: "POST",
					headers: {
						Origin: "http://attacker.com",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ bootstrapToken: "tok", displayName: "Eren" }),
				},
				envWithLimiter,
			);

			expect(res.status).toBe(403);
			const json = (await res.json()) as ErrorResponseBody;
			expect(json.error.code).toBe("INVALID_ORIGIN");
			expect(mockLimiter.limit).not.toHaveBeenCalled();
		});
	});
});
