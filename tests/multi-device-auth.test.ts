import * as SimpleWebAuthnServer from "@simplewebauthn/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as enrollmentModule from "../src/auth/enrollment-grants";
import * as reauthModule from "../src/auth/reauth";
import {
	beginAuthorizedPasskeyEnrollment,
	completeAuthorizedPasskeyEnrollment,
	WebAuthnServiceError,
} from "../src/auth/verification";
import type { WebAuthnConfig } from "../src/config/env";
import type { Database } from "../src/db/client";
import * as dbClientModule from "../src/db/client";

const U1 = "11111111-1111-4111-8111-111111111111";
const SESS_TOKEN = "valid-session-token";
const ORIGIN = "http://localhost:8787";

const mockConfig: WebAuthnConfig = {
	rpID: "localhost",
	rpName: "Gelir Gider",
	origin: ORIGIN,
};

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

describe("Multi-Device Passkey Enrollment (ADD_CREDENTIAL) - Comprehensive Verification", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test db stub
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
		mockEnv.AUTH_RATE_LIMITER = createMockLimiter(true);
	});

	describe("Destructive Recovery vs Non-Destructive Pairing Invariant", () => {
		it("PROVE: recovery is destructive (revokes old credentials and sessions, consumes code) and unsuitable for device pairing", async () => {
			const mockUser = {
				id: U1,
				displayName: "Eren",
				authInitializedAt: new Date("2026-09-01"),
			};

			const updatedTables: string[] = [];
			const mockTx = {
				select: vi
					.fn()
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "chal-1",
										userId: U1,
										purpose: "REGISTRATION",
										enrollmentGrantId: "grant-rec",
										consumedAt: new Date(),
									},
								]),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "grant-rec",
										userId: U1,
										purpose: "RECOVERY",
										recoveryCodeId: "rec-code-1",
										consumedAt: new Date(),
										revokedAt: null,
									},
								]),
							}),
						}),
					})
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "rec-code-1",
										userId: U1,
										consumedAt: null,
										revokedAt: null,
									},
								]),
							}),
						}),
					}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([
							{
								id: "new-phone-cred-uuid",
								credentialId: "phone-cred-id",
								deviceName: "Honor 90",
							},
						]),
					}),
				}),
				update: vi.fn().mockImplementation((table: any) => {
					updatedTables.push(table?.[Symbol.for("drizzle:Name")] || "unknown");
					return {
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([]),
						}),
					};
				}),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "chal-1",
									challenge: "rec-challenge-xyz",
									enrollmentGrantId: "grant-rec",
								},
							]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockTx)),
			} as unknown as Database;

			vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			).mockResolvedValue({
				verified: true,
				registrationInfo: {
					credential: {
						id: "phone-cred-id",
						publicKey: new Uint8Array([1, 2, 3]),
						counter: 0,
					},
					credentialDeviceType: "multiDevice",
					credentialBackedUp: true,
				},
			} as any);

			const result = await completeAuthorizedPasskeyEnrollment({
				db: mockDb,
				config: mockConfig,
				response: {
					id: "phone-cred-id",
					rawId: "phone-cred-id",
					response: {
						clientDataJSON: Buffer.from(
							JSON.stringify({ challenge: "rec-challenge-xyz" }),
						).toString("base64url"),
						attestationObject: "attest",
					},
					type: "public-key",
				} as any,
				deviceName: "Honor 90",
			});

			expect(result.purpose).toBe("RECOVERY");
			expect(updatedTables).toContain("webauthn_credentials");
			expect(updatedTables).toContain("sessions");
			expect(updatedTables).toContain("auth_recovery_codes");
			expect(result.recoveryCode).not.toBeNull();
		});

		it("PROVE: ADD_CREDENTIAL enrollment is completely NON-DESTRUCTIVE", async () => {
			const mockUser = {
				id: U1,
				displayName: "Eren",
				authInitializedAt: new Date("2026-09-01"),
			};

			const updatedTables: string[] = [];
			const insertedTables: string[] = [];
			const mockTx = {
				select: vi
					.fn()
					// 1. user lock FOR UPDATE
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					// 2. re-read challenge
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "chal-2",
										userId: U1,
										purpose: "REGISTRATION",
										enrollmentGrantId: "grant-add-cred",
										consumedAt: new Date(),
									},
								]),
							}),
						}),
					})
					// 3. re-read grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([
									{
										id: "grant-add-cred",
										userId: U1,
										purpose: "ADD_CREDENTIAL",
										recoveryCodeId: null,
										consumedAt: new Date(),
										revokedAt: null,
									},
								]),
							}),
						}),
					}),
				insert: vi.fn().mockImplementation((table: any) => {
					insertedTables.push(table?.[Symbol.for("drizzle:Name")] || "unknown");
					return {
						values: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "new-phone-cred-uuid",
									credentialId: "phone-cred-id-2",
									deviceName: "Honor 90",
								},
							]),
						}),
					};
				}),
				update: vi.fn().mockImplementation((table: any) => {
					updatedTables.push(table?.[Symbol.for("drizzle:Name")] || "unknown");
					return {
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([]),
						}),
					};
				}),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([
								{
									id: "chal-2",
									challenge: "add-cred-challenge-xyz",
									enrollmentGrantId: "grant-add-cred",
								},
							]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockTx)),
			} as unknown as Database;

			vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			).mockResolvedValue({
				verified: true,
				registrationInfo: {
					credential: {
						id: "phone-cred-id-2",
						publicKey: new Uint8Array([4, 5, 6]),
						counter: 0,
					},
					credentialDeviceType: "multiDevice",
					credentialBackedUp: true,
				},
			} as any);

			const result = await completeAuthorizedPasskeyEnrollment({
				db: mockDb,
				config: mockConfig,
				response: {
					id: "phone-cred-id-2",
					rawId: "phone-cred-id-2",
					response: {
						clientDataJSON: Buffer.from(
							JSON.stringify({ challenge: "add-cred-challenge-xyz" }),
						).toString("base64url"),
						attestationObject: "attest",
					},
					type: "public-key",
				} as any,
				deviceName: "Honor 90",
			});

			expect(result.purpose).toBe("ADD_CREDENTIAL");
			// Invariant 10: MUST NOT revoke existing credentials
			expect(updatedTables).not.toContain("webauthn_credentials");
			// Invariant 10: MUST NOT revoke existing sessions
			expect(updatedTables).not.toContain("sessions");
			// Invariant 10: MUST NOT consume or rotate recovery codes
			expect(updatedTables).not.toContain("auth_recovery_codes");
			expect(insertedTables).not.toContain("auth_recovery_codes");
			// Invariant 14: recovery code is not rotated or exposed
			expect(result.recoveryCode).toBeNull();
			// Only newly registered credential was inserted
			expect(insertedTables).toContain("webauthn_credentials");
		});
	});

	describe("POST /auth/devices/pairing-grant (Security Invariants)", () => {
		it("rejects unauthenticated request with 401 UNAUTHENTICATED", async () => {
			const res = await app.request(
				"/auth/devices/pairing-grant",
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
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("UNAUTHENTICATED");
		});

		it("rejects request from cookie alone without fresh WebAuthn re-auth response", async () => {
			const res = await app.request(
				"/auth/devices/pairing-grant",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("INVALID_REQUEST");
		});

		it("rejects request if WebAuthn re-auth fails", async () => {
			vi.spyOn(reauthModule, "verifyReauthForUser").mockRejectedValue(
				new WebAuthnServiceError(
					"WEBAUTHN_AUTHENTICATION_FAILED",
					"WebAuthn authentication failed",
				),
			);

			const res = await app.request(
				"/auth/devices/pairing-grant",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: { id: "cred-fail" },
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const json = (await res.json()) as any;
			expect(json.error.code).toBe("WEBAUTHN_AUTHENTICATION_FAILED");
		});

		it("issues short-lived ADD_CREDENTIAL pairing grant ONLY after successful fresh re-auth", async () => {
			vi.spyOn(reauthModule, "verifyReauthForUser").mockResolvedValue({
				verified: true,
				credential: {
					id: "mac-cred-id",
					deviceName: "macOS Brave",
				} as any,
			});

			vi.spyOn(enrollmentModule, "issueEnrollmentGrant").mockResolvedValue({
				token: "pairing-grant-token-12345",
				grant: {
					id: "grant-1",
					userId: U1,
					purpose: "ADD_CREDENTIAL",
					expiresAt: new Date(Date.now() + 600000),
				} as any,
			});

			const res = await app.request(
				"/auth/devices/pairing-grant",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						response: {
							id: "mac-cred-id",
							rawId: "mac-cred-id",
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
			const json = (await res.json()) as any;
			expect(json.enrollmentGrantToken).toBe("pairing-grant-token-12345");
			expect(json.expiresAt).toBeDefined();

			// Invariant: issueEnrollmentGrant was called specifically with purpose 'ADD_CREDENTIAL'
			expect(enrollmentModule.issueEnrollmentGrant).toHaveBeenCalledWith({
				db: expect.anything(),
				userId: U1,
				purpose: "ADD_CREDENTIAL",
			});
		});
	});

	describe("GET /auth/devices (Security Invariants)", () => {
		it("rejects unauthenticated request with 401 UNAUTHENTICATED", async () => {
			const res = await app.request(
				"/auth/devices",
				{
					method: "GET",
					headers: { Origin: ORIGIN },
				},
				mockEnv,
			);

			expect(res.status).toBe(401);
		});

		it("returns list of registered devices without exposing credential IDs or public keys", async () => {
			const mockDevices = [
				{
					id: "db-uuid-1",
					deviceName: "macOS Brave",
					deviceType: "platform",
					createdAt: new Date("2026-09-01"),
					lastUsedAt: new Date("2026-10-01"),
				},
				{
					id: "db-uuid-2",
					deviceName: "Honor 90",
					deviceType: "platform",
					createdAt: new Date("2026-10-02"),
					lastUsedAt: new Date("2026-10-02"),
				},
			];

			const mockDb = {
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => Promise.resolve(mockDevices),
						}),
					}),
				}),
			};
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb as any);

			const res = await app.request(
				"/auth/devices",
				{
					method: "GET",
					headers: {
						Origin: ORIGIN,
						Cookie: `__Host-gg_session=${SESS_TOKEN}`,
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const json = (await res.json()) as any;
			expect(json.devices).toHaveLength(2);
			expect(json.devices[0].deviceName).toBe("macOS Brave");
			expect(json.devices[1].deviceName).toBe("Honor 90");

			// Invariant 15: Do NOT expose credential IDs/raw public keys to normal UI
			for (const dev of json.devices) {
				expect(dev.credentialId).toBeUndefined();
				expect(dev.publicKey).toBeUndefined();
			}
		});
	});
});
