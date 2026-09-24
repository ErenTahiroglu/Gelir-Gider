import { beforeEach, describe, expect, it, vi } from "vitest";
import * as reauthModule from "../src/auth/reauth";
import { WebAuthnServiceError } from "../src/auth/verification";
import * as dbClientModule from "../src/db/client";

const U1 = "11111111-1111-4111-8111-111111111111";
const SESS_TOKEN = "valid-session-token";

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
				displayName: "Eren",
				sessionId: "sess-1",
			});
			return next();
		},
	};
});

const { app } = await import("../src/index");

const ORIGIN = "http://localhost:8787";

const createMockLimiter = (allowed = true) => ({
	limit: vi.fn().mockResolvedValue({ success: allowed }),
});

const mockEnv = {
	DATABASE_URL: "postgresql://user:password@example.invalid/db",
	WEBAUTHN_RP_ID: "localhost",
	WEBAUTHN_RP_NAME: "Gelir Gider",
	WEBAUTHN_ORIGIN: ORIGIN,
	BOOTSTRAP_TOKEN_HASH: "0".repeat(64),
	AUTH_RATE_LIMITER: createMockLimiter(true),
};

describe("Passkey Reauthentication HTTP", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test db stub
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
		mockEnv.AUTH_RATE_LIMITER = createMockLimiter(true);
	});

	describe("POST /auth/passkey/reauth/options", () => {
		it("rejects unauthenticated request with 401 UNAUTHENTICATED", async () => {
			const res = await app.request(
				"/auth/passkey/reauth/options",
				{
					method: "POST",
					headers: { Origin: ORIGIN },
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("UNAUTHENTICATED");
		});

		it("generates reauth options for authenticated user", async () => {
			const mockOptions = {
				challenge: "reauth-challenge-123",
				timeout: 60000,
				rpId: "localhost",
				allowCredentials: [
					{
						id: "cred-1",
						type: "public-key" as const,
					},
				],
				userVerification: "required" as const,
			};

			const mockDb = {
				select: () => ({
					from: () => ({
						where: () =>
							Promise.resolve([
								{
									credentialId: "cred-1",
									transports: ["internal"],
									revokedAt: null,
								},
							]),
					}),
				}),
			};
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb as any);

			vi.spyOn(reauthModule, "generateReauthOptionsForUser").mockResolvedValue(
				mockOptions as any,
			);

			const res = await app.request(
				"/auth/passkey/reauth/options",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			const json = await res.json();
			expect(json).toEqual(mockOptions);
		});
	});

	describe("POST /auth/passkey/reauth/verify", () => {
		it("rejects unauthenticated request with 401 UNAUTHENTICATED", async () => {
			const res = await app.request(
				"/auth/passkey/reauth/verify",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ response: {} }),
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
		});

		it("verifies passkey and returns { verified: true } WITHOUT Set-Cookie header", async () => {
			vi.spyOn(reauthModule, "verifyReauthForUser").mockResolvedValue({
				verified: true,
				credential: {
					id: "cred-1",
					publicKey: new Uint8Array(),
					counter: 1,
				} as any,
			});

			const res = await app.request(
				"/auth/passkey/reauth/verify",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: {
							id: "cred-1",
							rawId: "cred-1",
							response: {
								clientDataJSON: "abc",
								authenticatorData: "def",
								signature: "ghi",
							},
							type: "public-key",
						},
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// CRITICAL: Isolated reauth must NOT set a session cookie or overwrite it
			expect(res.headers.get("Set-Cookie")).toBeNull();
			const json = (await res.json()) as any;
			expect(json.verified).toBe(true);
		});

		it("returns 400 when reauth verification fails (e.g. invalid signature)", async () => {
			vi.spyOn(reauthModule, "verifyReauthForUser").mockRejectedValue(
				new WebAuthnServiceError(
					"WEBAUTHN_AUTHENTICATION_FAILED",
					"WebAuthn authentication failed",
				),
			);

			const res = await app.request(
				"/auth/passkey/reauth/verify",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: { id: "cred-1" },
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("WEBAUTHN_AUTHENTICATION_FAILED");
		});
	});
});
