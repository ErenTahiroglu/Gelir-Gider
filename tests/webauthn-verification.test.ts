import * as SimpleWebAuthnServer from "@simplewebauthn/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateCredentialAfterAuthentication } from "../src/auth/credentials";
import {
	verifyAuthenticationForUser,
	verifyRegistrationForUser,
	type WebAuthnErrorCode,
} from "../src/auth/verification";
import type { WebAuthnConfig } from "../src/config/env";
import type { Database } from "../src/db/client";

const mockConfig: WebAuthnConfig = {
	rpID: "localhost",
	rpName: "Gelir Gider",
	origin: "http://localhost:8787",
};

describe("WebAuthn Verification Service", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("Registration Verification", () => {
		const validRegistrationResponse: SimpleWebAuthnServer.RegistrationResponseJSON =
			{
				id: "cred-abc-123",
				rawId: "cred-abc-123",
				response: {
					clientDataJSON:
						"eyJjaGFsbGVuZ2UiOiJ0ZXN0LWNoYWxsZW5nZS1yZWciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0Ojg3ODciLCJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
					attestationObject: "dummyAttestation",
				},
				clientExtensionResults: {},
				type: "public-key",
			};

		it("rejects blank or invalid deviceName", async () => {
			const mockDb = {} as unknown as Database;
			await expect(
				verifyRegistrationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validRegistrationResponse,
					deviceName: "   ",
				}),
			).rejects.toMatchObject({
				code: "INVALID_DEVICE_NAME" as WebAuthnErrorCode,
			});

			await expect(
				verifyRegistrationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validRegistrationResponse,
					deviceName: "a".repeat(101),
				}),
			).rejects.toMatchObject({
				code: "INVALID_DEVICE_NAME" as WebAuthnErrorCode,
			});
		});

		it("rejects when challenge is invalid, expired or already consumed without calling verifier", async () => {
			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([]), // Nothing consumed
						}),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			);

			await expect(
				verifyRegistrationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_CHALLENGE_INVALID" as WebAuthnErrorCode,
			});

			expect(verifierSpy).not.toHaveBeenCalled();
		});

		it("does not save credential and keeps challenge consumed if verifier fails", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const insertSpy = vi.fn();
			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				insert: insertSpy,
			} as unknown as Database;

			vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			).mockRejectedValue(new Error("Signature validation failed"));

			await expect(
				verifyRegistrationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_REGISTRATION_FAILED" as WebAuthnErrorCode,
			});

			expect(insertSpy).not.toHaveBeenCalled();
		});

		it("saves credential on verified registration with trimmed deviceName and returns credential", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const mockSavedCredential = {
				id: "cred-db-1",
				userId: "user-1",
				credentialId: "cred-abc-123",
				publicKey: new Uint8Array([1, 2, 3]),
				signCount: 0,
				deviceName: "MacBook Pro",
				deviceType: "singleDevice",
				transports: ["internal"],
				backedUp: false,
				stateVersion: 0,
				createdAt: new Date(),
				lastUsedAt: null,
				revokedAt: null,
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([mockSavedCredential]),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi
				.spyOn(SimpleWebAuthnServer, "verifyRegistrationResponse")
				.mockResolvedValue({
					verified: true,
					registrationInfo: {
						fmt: "none",
						aaguid: "00000000-0000-0000-0000-000000000000",
						credential: {
							id: "cred-abc-123",
							publicKey: new Uint8Array([1, 2, 3]),
							counter: 0,
							transports: ["internal"],
						},
						credentialType: "public-key",
						attestationObject: new Uint8Array(),
						userVerified: true,
						credentialDeviceType: "singleDevice",
						credentialBackedUp: false,
						origin: "http://localhost:8787",
					},
				});

			const result = await verifyRegistrationForUser({
				db: mockDb,
				config: mockConfig,
				user: { id: "user-1" },
				response: validRegistrationResponse,
				deviceName: "  MacBook Pro  ",
			});

			expect(result.verified).toBe(true);
			expect(result.credential).toEqual(mockSavedCredential);
			expect(verifierSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedChallenge: "test-challenge-reg",
					expectedOrigin: "http://localhost:8787",
					expectedRPID: "localhost",
					requireUserVerification: true,
				}),
			);
		});

		it("throws CREDENTIAL_ALREADY_REGISTERED when duplicate credential is saved", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockImplementation(() => {
						const err = new Error(
							"duplicate key value violates unique constraint",
						);
						(err as unknown as { code: string }).code = "23505";
						throw err;
					}),
				}),
			} as unknown as Database;

			vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			).mockResolvedValue({
				verified: true,
				registrationInfo: {
					fmt: "none",
					aaguid: "00000000-0000-0000-0000-000000000000",
					credential: {
						id: "cred-abc-123",
						publicKey: new Uint8Array([1, 2, 3]),
						counter: 0,
						transports: ["internal"],
					},
					credentialType: "public-key",
					attestationObject: new Uint8Array(),
					userVerified: true,
					credentialDeviceType: "singleDevice",
					credentialBackedUp: false,
					origin: "http://localhost:8787",
				},
			});

			await expect(
				verifyRegistrationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "CREDENTIAL_ALREADY_REGISTERED" as WebAuthnErrorCode,
			});
		});
	});

	describe("Authentication Verification", () => {
		const validAuthResponse: SimpleWebAuthnServer.AuthenticationResponseJSON = {
			id: "cred-abc-123",
			rawId: "cred-abc-123",
			response: {
				clientDataJSON:
					"eyJjaGFsbGVuZ2UiOiJ0ZXN0LWNoYWxsZW5nZS1hdXRoIiwib3JpZ2luIjoiaHR0cDovL2xvY2FsaG9zdDo4Nzg3IiwidHlwZSI6IndlYmF1dGhuLmdldCJ9",
				authenticatorData: "dummyAuthData",
				signature: "dummySignature",
			},
			clientExtensionResults: {},
			type: "public-key",
		};

		it("rejects when challenge is invalid, expired or already consumed without calling verifier", async () => {
			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi.spyOn(
				SimpleWebAuthnServer,
				"verifyAuthenticationResponse",
			);

			await expect(
				verifyAuthenticationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validAuthResponse,
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_CHALLENGE_INVALID" as WebAuthnErrorCode,
			});

			expect(verifierSpy).not.toHaveBeenCalled();
		});

		it("rejects when credential is not found or revoked without calling verifier", async () => {
			const mockConsumedChallenge = {
				id: "chal-auth-1",
				userId: "user-1",
				purpose: "AUTHENTICATION",
				challenge: "test-challenge-auth",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]), // Not found
						}),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi.spyOn(
				SimpleWebAuthnServer,
				"verifyAuthenticationResponse",
			);

			await expect(
				verifyAuthenticationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validAuthResponse,
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_CREDENTIAL_NOT_FOUND" as WebAuthnErrorCode,
			});

			expect(verifierSpy).not.toHaveBeenCalled();
		});

		it("updates counter and state_version race-safely on successful authentication", async () => {
			const mockConsumedChallenge = {
				id: "chal-auth-1",
				userId: "user-1",
				purpose: "AUTHENTICATION",
				challenge: "test-challenge-auth",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const mockStoredCredential = {
				id: "cred-db-1",
				userId: "user-1",
				credentialId: "cred-abc-123",
				publicKey: new Uint8Array([4, 5, 6]),
				signCount: 1,
				deviceName: "MacBook Pro",
				deviceType: "singleDevice",
				transports: ["internal"],
				backedUp: false,
				stateVersion: 5,
				createdAt: new Date(),
				lastUsedAt: null,
				revokedAt: null,
			};

			const mockUpdatedCredential = {
				...mockStoredCredential,
				signCount: 2,
				stateVersion: 6,
				lastUsedAt: new Date(),
			};

			const mockDb = {
				update: vi
					.fn()
					// 1st update: challenge consume
					.mockReturnValueOnce({
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
							}),
						}),
					})
					// 2nd update: counter & state_version update
					.mockReturnValueOnce({
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								returning: vi.fn().mockResolvedValue([mockUpdatedCredential]),
							}),
						}),
					}),
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockStoredCredential]),
						}),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi
				.spyOn(SimpleWebAuthnServer, "verifyAuthenticationResponse")
				.mockResolvedValue({
					verified: true,
					authenticationInfo: {
						credentialID: "cred-abc-123",
						newCounter: 2,
						userVerified: true,
						credentialDeviceType: "singleDevice",
						credentialBackedUp: false,
						origin: "http://localhost:8787",
						rpID: "localhost",
					},
				});

			const result = await verifyAuthenticationForUser({
				db: mockDb,
				config: mockConfig,
				user: { id: "user-1" },
				response: validAuthResponse,
			});

			expect(result.verified).toBe(true);
			expect(result.credential.signCount).toBe(2);
			expect(result.credential.stateVersion).toBe(6);
			expect(verifierSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedChallenge: "test-challenge-auth",
					expectedOrigin: "http://localhost:8787",
					expectedRPID: "localhost",
					requireUserVerification: true,
				}),
			);
		});

		it("fails when counter update encounters concurrent race or stale state_version", async () => {
			const mockConsumedChallenge = {
				id: "chal-auth-1",
				userId: "user-1",
				purpose: "AUTHENTICATION",
				challenge: "test-challenge-auth",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const mockStoredCredential = {
				id: "cred-db-1",
				userId: "user-1",
				credentialId: "cred-abc-123",
				publicKey: new Uint8Array([4, 5, 6]),
				signCount: 1,
				deviceName: "MacBook Pro",
				deviceType: "singleDevice",
				transports: ["internal"],
				backedUp: false,
				stateVersion: 5,
				createdAt: new Date(),
				lastUsedAt: null,
				revokedAt: null,
			};

			const mockDb = {
				update: vi
					.fn()
					// 1st update: challenge consume
					.mockReturnValueOnce({
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
							}),
						}),
					})
					// 2nd update: counter update returns 0 rows due to race on state_version
					.mockReturnValueOnce({
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								returning: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockStoredCredential]),
						}),
					}),
				}),
			} as unknown as Database;

			vi.spyOn(
				SimpleWebAuthnServer,
				"verifyAuthenticationResponse",
			).mockResolvedValue({
				verified: true,
				authenticationInfo: {
					credentialID: "cred-abc-123",
					newCounter: 2,
					userVerified: true,
					credentialDeviceType: "singleDevice",
					credentialBackedUp: false,
					origin: "http://localhost:8787",
					rpID: "localhost",
				},
			});

			await expect(
				verifyAuthenticationForUser({
					db: mockDb,
					config: mockConfig,
					user: { id: "user-1" },
					response: validAuthResponse,
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_CREDENTIAL_STATE_CHANGED" as WebAuthnErrorCode,
			});
		});

		it("fails when zero-to-zero counter update encounters stale state_version in updateCredentialAfterAuthentication", async () => {
			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([]), // stale stateVersion returns 0 rows
						}),
					}),
				}),
			} as unknown as Database;

			const result = await updateCredentialAfterAuthentication({
				db: mockDb,
				credentialDbId: "cred-1",
				userId: "user-1",
				previouslyReadCounter: 0,
				previousStateVersion: 3,
				newCounter: 0,
			});

			expect(result).toBeNull();
		});
	});
});
