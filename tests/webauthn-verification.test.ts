import * as SimpleWebAuthnServer from "@simplewebauthn/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginAuthorizedPasskeyEnrollment,
	completeAuthorizedPasskeyEnrollment,
	verifyAuthenticationForUser,
	type WebAuthnErrorCode,
} from "../src/auth/verification";
import type { WebAuthnConfig } from "../src/config/env";
import type { Database } from "../src/db/client";

const mockConfig: WebAuthnConfig = {
	rpID: "localhost",
	rpName: "Gelir Gider",
	origin: "http://localhost:8787",
};

describe("Authorized Passkey Enrollment & Authentication Service", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("beginAuthorizedPasskeyEnrollment", () => {
		it("rejects empty enrollment grant token", async () => {
			const mockDb = {} as unknown as Database;
			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});
		});

		it("rejects non-existent enrollment grant token on pre-lock lookup", async () => {
			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]), // Pre-lock grant not found
						}),
					}),
				}),
				transaction: vi.fn(),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "non-existent-grant-token-xyz-1234567890",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects when fresh post-lock read finds grant already consumed or revoked", async () => {
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock FOR UPDATE
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant query (already consumed/revoked, so empty result)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([]),
								}),
							}),
						}),
					}),
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-looking-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});
		});

		it("rejects expired enrollment grant token because post-lock query folds expiry predicate — returns ENROLLMENT_GRANT_INVALID", async () => {
			// Since expires_at > postLockNow is now baked into the fresh grant query,
			// an expired grant returns no row, which maps to ENROLLMENT_GRANT_INVALID.
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant — NOT FOUND because expires_at predicate filters it out
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([]),
								}),
							}),
						}),
					}),
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-looking-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				// Expiry is now folded into query: no row found -> ENROLLMENT_GRANT_INVALID
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});
		});

		it("rejects grant that expires while waiting for user lock (post-lock clock simulation)", async () => {
			// Simulates scenario: routing lookup succeeds, but user FOR UPDATE wait was long
			// enough that the grant is now expired by the time postLockNow is computed.
			// The fresh grant FOR UPDATE query includes expires_at > postLockNow so it
			// returns nothing, and begin fails without consuming the grant or inserting a challenge.
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const insertSpy = vi.fn();

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock (acquired after simulated delay)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant query with postLockNow — grant is now expired
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									// Empty because expires_at > postLockNow rejects it
									limit: vi.fn().mockResolvedValue([]),
								}),
							}),
						}),
					}),
				insert: insertSpy,
				update: vi.fn(),
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});

			// Grant must NOT be consumed and challenge must NOT be inserted
			expect(insertSpy).not.toHaveBeenCalled();
			expect(mockTx.update).not.toHaveBeenCalled();
		});

		it("rejects grant that expires during options generation — consumeNow conditional UPDATE returns empty, challenge not inserted", async () => {
			// Simulates: post-lock grant read passes, options generated, but between
			// options generation and the consume UPDATE the grant expired.
			// consumeNow > expiresAt so the conditional UPDATE RETURNING returns [].
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockFreshGrant = {
				id: "grant-1",
				userId: "user-1",
				purpose: "BOOTSTRAP",
				consumedAt: null,
				revokedAt: null,
				expiresAt: new Date(Date.now() + 600000), // Active at fresh-read time
			};

			const insertSpy = vi.fn();

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant — still active at this point
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockFreshGrant]),
								}),
							}),
						}),
					})
					// 3rd: active credentials
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([]),
						}),
					}),
				// Conditional consume with consumeNow: grant expired during options generation
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([]), // consumeNow > expiresAt → 0 rows
						}),
					}),
				}),
				insert: insertSpy,
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});

			// Challenge must NOT be inserted when grant expires during options generation
			expect(insertSpy).not.toHaveBeenCalled();
		});

		it("rejects BOOTSTRAP grant if user is already initialized", async () => {
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockFreshGrant = {
				id: "grant-1",
				userId: "user-1",
				purpose: "BOOTSTRAP",
				consumedAt: null,
				revokedAt: null,
				expiresAt: new Date(Date.now() + 600000),
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock (already initialized!)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockFreshGrant]),
								}),
							}),
						}),
					}),
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-looking-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				code: "BOOTSTRAP_ALREADY_COMPLETED" as WebAuthnErrorCode,
			});
		});

		it("rejects RECOVERY grant if linked recovery code was revoked", async () => {
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockFreshGrant = {
				id: "grant-1",
				userId: "user-1",
				purpose: "RECOVERY",
				recoveryCodeId: "rc-1",
				consumedAt: null,
				revokedAt: null,
				expiresAt: new Date(Date.now() + 600000),
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockFreshGrant]),
								}),
							}),
						}),
					})
					// 3rd: recovery code revalidation (revoked!)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-looking-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				code: "RECOVERY_SOURCE_INVALID" as WebAuthnErrorCode,
			});
		});

		it("fails closed when conditional atomic consume returns 0 rows (race loser) and does not insert challenge", async () => {
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockFreshGrant = {
				id: "grant-1",
				userId: "user-1",
				purpose: "BOOTSTRAP",
				consumedAt: null,
				revokedAt: null,
				expiresAt: new Date(Date.now() + 600000),
			};

			const insertSpy = vi.fn();

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockFreshGrant]),
								}),
							}),
						}),
					})
					// 3rd: active credentials
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([]),
						}),
					}),
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([]), // Conditional consume returned 0 rows!
						}),
					}),
				}),
				insert: insertSpy,
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			await expect(
				beginAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					enrollmentGrantToken: "valid-grant-token-1234567890",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});

			expect(insertSpy).not.toHaveBeenCalled();
		});

		it("successfully begins enrollment: consumes grant conditionally and inserts challenge with enrollment_grant_id atomically", async () => {
			const mockRoutingHint = {
				id: "grant-1",
				userId: "user-1",
			};

			const mockFreshGrant = {
				id: "grant-1",
				userId: "user-1",
				purpose: "BOOTSTRAP",
				consumedAt: null,
				revokedAt: null,
				expiresAt: new Date(Date.now() + 600000),
			};

			let capturedGrantUpdate: unknown;
			let capturedChallengeInsert: unknown;

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
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
					})
					// 2nd: fresh post-lock grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockFreshGrant]),
								}),
							}),
						}),
					})
					// 3rd: active credentials
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockResolvedValue([]),
						}),
					}),
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockImplementation((vals) => {
						capturedGrantUpdate = vals;
						return {
							where: vi.fn().mockReturnValue({
								returning: vi.fn().mockResolvedValue([{ id: "grant-1" }]),
							}),
						};
					}),
				}),
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockImplementation((vals) => {
						capturedChallengeInsert = vals;
						return Promise.resolve();
					}),
				}),
			};

			const mockDb = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockRoutingHint]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
				}),
			} as unknown as Database;

			const options = await beginAuthorizedPasskeyEnrollment({
				db: mockDb,
				config: mockConfig,
				enrollmentGrantToken: "valid-grant-token-1234567890",
			});

			expect(options.challenge).toBeDefined();
			expect(capturedGrantUpdate).toBeDefined();
			expect(
				(capturedGrantUpdate as { consumedAt?: Date }).consumedAt,
			).toBeInstanceOf(Date);
			expect(
				(capturedChallengeInsert as { enrollmentGrantId?: string })
					.enrollmentGrantId,
			).toBe("grant-1");
			expect((capturedChallengeInsert as { purpose?: string }).purpose).toBe(
				"REGISTRATION",
			);
		});
	});

	describe("completeAuthorizedPasskeyEnrollment", () => {
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
				completeAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					response: validRegistrationResponse,
					deviceName: "   ",
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
							returning: vi.fn().mockResolvedValue([]), // No challenge consumed
						}),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			);

			await expect(
				completeAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_CHALLENGE_INVALID" as WebAuthnErrorCode,
			});

			expect(verifierSpy).not.toHaveBeenCalled();
		});

		it("does not finalize and leaves challenge consumed if cryptographic verification fails", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				enrollmentGrantId: "grant-1",
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
				transaction: vi.fn(),
			} as unknown as Database;

			vi.spyOn(
				SimpleWebAuthnServer,
				"verifyRegistrationResponse",
			).mockRejectedValue(new Error("Signature validation failed"));

			await expect(
				completeAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_REGISTRATION_FAILED" as WebAuthnErrorCode,
			});

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects finalization if fresh challenge re-read from DB inside transaction fails or is unconsumed", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				enrollmentGrantId: "grant-1",
				consumedAt: new Date(),
			};

			const mockUser = {
				id: "user-1",
				displayName: "Eren",
				authInitializedAt: null,
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: lock user
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					// 2nd: fresh challenge re-read fails (not found or invalid)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
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
				completeAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "WEBAUTHN_CHALLENGE_INVALID" as WebAuthnErrorCode,
			});
		});

		it("rejects finalization if challenge <-> grant <-> user binding verification fails or grant revoked", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				enrollmentGrantId: "grant-1",
				consumedAt: new Date(),
			};

			const mockUser = {
				id: "user-1",
				displayName: "Eren",
				authInitializedAt: null,
			};

			const mockFreshChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				enrollmentGrantId: "grant-1",
				consumedAt: new Date(),
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: lock user
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					// 2nd: fresh challenge re-read
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockFreshChallenge]),
							}),
						}),
					})
					// 3rd: grant re-read fails binding (user mismatch or revoked)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
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
				completeAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					response: validRegistrationResponse,
					deviceName: "MacBook Pro",
				}),
			).rejects.toMatchObject({
				code: "ENROLLMENT_GRANT_INVALID" as WebAuthnErrorCode,
			});
		});

		it("completes BOOTSTRAP finalization atomically: creates credential, sets auth_initialized_at, inserts recovery code hash, returns one-time code", async () => {
			const mockConsumedChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				enrollmentGrantId: "grant-1",
				consumedAt: new Date(),
			};

			const mockFreshChallenge = {
				id: "chal-1",
				userId: "user-1",
				purpose: "REGISTRATION",
				enrollmentGrantId: "grant-1",
				consumedAt: new Date(),
			};

			const mockGrant = {
				id: "grant-1",
				userId: "user-1",
				purpose: "BOOTSTRAP",
				consumedAt: new Date(),
				revokedAt: null,
			};

			const mockUser = {
				id: "user-1",
				displayName: "Eren",
				authInitializedAt: null, // Uninitialized
			};

			let authInitUpdated = false;
			let recoveryCodeInserted = false;
			let credentialInserted = false;

			const mockTx = {
				select: vi
					.fn()
					// 1st: lock user
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					// 2nd: fresh challenge re-read
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockFreshChallenge]),
							}),
						}),
					})
					// 3rd: linked grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockGrant]),
							}),
						}),
					}),
				insert: vi.fn().mockImplementation((_table) => {
					return {
						values: vi.fn().mockImplementation((vals) => {
							if (vals.credentialId) {
								credentialInserted = true;
								return {
									returning: vi.fn().mockResolvedValue([
										{
											id: "cred-1",
											credentialId: vals.credentialId,
											deviceName: vals.deviceName,
										},
									]),
								};
							}
							if (vals.codeHash) {
								recoveryCodeInserted = true;
								return Promise.resolve();
							}
							return Promise.resolve();
						}),
					};
				}),
				update: vi.fn().mockImplementation(() => {
					authInitUpdated = true;
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
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
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

			const result = await completeAuthorizedPasskeyEnrollment({
				db: mockDb,
				config: mockConfig,
				response: validRegistrationResponse,
				deviceName: "MacBook Pro",
			});

			expect(result.verified).toBe(true);
			expect(result.purpose).toBe("BOOTSTRAP");
			expect(result.user.displayName).toBe("Eren");
			expect(result.credential.credentialId).toBe("cred-abc-123");
			expect(result.recoveryCode.canonical.length).toBe(32);
			expect(result.recoveryCode.display.split(".").length).toBe(8);

			expect(credentialInserted).toBe(true);
			expect(authInitUpdated).toBe(true);
			expect(recoveryCodeInserted).toBe(true);
		});

		it("completes RECOVERY finalization atomically: creates new credential, revokes old credentials, revokes sessions, consumes used code, inserts new recovery code", async () => {
			const mockConsumedChallenge = {
				id: "chal-rec",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				enrollmentGrantId: "grant-rec",
				consumedAt: new Date(),
			};

			const mockFreshChallenge = {
				id: "chal-rec",
				userId: "user-1",
				purpose: "REGISTRATION",
				enrollmentGrantId: "grant-rec",
				consumedAt: new Date(),
			};

			const mockGrant = {
				id: "grant-rec",
				userId: "user-1",
				purpose: "RECOVERY",
				recoveryCodeId: "rc-old",
				consumedAt: new Date(),
				revokedAt: null,
			};

			const mockUser = {
				id: "user-1",
				displayName: "Eren",
				authInitializedAt: new Date(),
			};

			const mockSourceRecoveryCode = {
				id: "rc-old",
				userId: "user-1",
				consumedAt: null,
				revokedAt: null,
			};

			let oldCredentialsRevoked = false;
			let sessionsRevoked = false;
			let oldCodeConsumed = false;
			let newCodeInserted = false;

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					// 2nd: fresh challenge re-read
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockFreshChallenge]),
							}),
						}),
					})
					// 3rd: linked grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockGrant]),
							}),
						}),
					})
					// 4th: source recovery code revalidation inside finalization tx
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockSourceRecoveryCode]),
							}),
						}),
					}),
				insert: vi.fn().mockImplementation(() => {
					return {
						values: vi.fn().mockImplementation((vals) => {
							if (vals.credentialId) {
								return {
									returning: vi.fn().mockResolvedValue([
										{
											id: "cred-new",
											credentialId: vals.credentialId,
											deviceName: vals.deviceName,
										},
									]),
								};
							}
							if (vals.codeHash) {
								newCodeInserted = true;
								return Promise.resolve();
							}
							return Promise.resolve();
						}),
					};
				}),
				update: vi.fn().mockImplementation(() => {
					return {
						set: vi.fn().mockImplementation((vals) => {
							if (vals.revokedAt && vals.stateVersion) {
								oldCredentialsRevoked = true;
							} else if (vals.revokedAt) {
								sessionsRevoked = true;
							} else if (vals.consumedAt) {
								oldCodeConsumed = true;
							}
							return {
								where: vi.fn().mockResolvedValue([]),
							};
						}),
					};
				}),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
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
						id: "cred-new-123",
						publicKey: new Uint8Array([4, 5, 6]),
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

			const result = await completeAuthorizedPasskeyEnrollment({
				db: mockDb,
				config: mockConfig,
				response: validRegistrationResponse,
				deviceName: "New MacBook",
			});

			expect(result.verified).toBe(true);
			expect(result.purpose).toBe("RECOVERY");
			expect(result.credential.credentialId).toBe("cred-new-123");
			expect(oldCredentialsRevoked).toBe(true);
			expect(sessionsRevoked).toBe(true);
			expect(oldCodeConsumed).toBe(true);
			expect(newCodeInserted).toBe(true);
		});

		it("rejects RECOVERY finalization if source recovery code was rotated after begin and does not mutate credentials", async () => {
			const mockConsumedChallenge = {
				id: "chal-rec",
				userId: "user-1",
				purpose: "REGISTRATION",
				challenge: "test-challenge-reg",
				enrollmentGrantId: "grant-rec",
				consumedAt: new Date(),
			};

			const mockFreshChallenge = {
				id: "chal-rec",
				userId: "user-1",
				purpose: "REGISTRATION",
				enrollmentGrantId: "grant-rec",
				consumedAt: new Date(),
			};

			const mockGrant = {
				id: "grant-rec",
				userId: "user-1",
				purpose: "RECOVERY",
				recoveryCodeId: "rc-old",
				consumedAt: new Date(),
				revokedAt: null,
			};

			const mockUser = {
				id: "user-1",
				displayName: "Eren",
				authInitializedAt: new Date(),
			};

			const mockTx = {
				select: vi
					.fn()
					// 1st: user lock
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								for: vi.fn().mockReturnValue({
									limit: vi.fn().mockResolvedValue([mockUser]),
								}),
							}),
						}),
					})
					// 2nd: fresh challenge re-read
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockFreshChallenge]),
							}),
						}),
					})
					// 3rd: linked grant
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([mockGrant]),
							}),
						}),
					})
					// 4th: source recovery code revalidation FAILS (code was rotated!)
					.mockReturnValueOnce({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]), // No active code!
							}),
						}),
					}),
				insert: vi.fn(),
				update: vi.fn(),
			};

			const mockDb = {
				update: vi.fn().mockReturnValue({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
						}),
					}),
				}),
				transaction: vi.fn().mockImplementation(async (cb) => {
					return await cb(mockTx);
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
						id: "cred-new-123",
						publicKey: new Uint8Array([4, 5, 6]),
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
				completeAuthorizedPasskeyEnrollment({
					db: mockDb,
					config: mockConfig,
					response: validRegistrationResponse,
					deviceName: "New MacBook",
				}),
			).rejects.toMatchObject({
				code: "RECOVERY_SOURCE_INVALID" as WebAuthnErrorCode,
			});

			expect(mockTx.insert).not.toHaveBeenCalled();
			expect(mockTx.update).not.toHaveBeenCalled();
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

		it("rejects when challenge is invalid, expired, or already consumed without calling verifier", async () => {
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

		it("rejects when active credential is not found for user", async () => {
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
							limit: vi.fn().mockResolvedValue([]), // No active credential
						}),
					}),
				}),
			} as unknown as Database;

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
		});

		it("updates signature counter, state_version and lastUsedAt race-safely on verified authentication", async () => {
			const mockConsumedChallenge = {
				id: "chal-auth-1",
				userId: "user-1",
				purpose: "AUTHENTICATION",
				challenge: "test-challenge-auth",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 300000),
				consumedAt: new Date(),
			};

			const mockCredentialRecord = {
				id: "cred-db-1",
				userId: "user-1",
				credentialId: "cred-abc-123",
				publicKey: new Uint8Array([1, 2, 3]),
				signCount: 5,
				deviceName: "MacBook",
				deviceType: "singleDevice",
				transports: ["internal"],
				backedUp: false,
				stateVersion: 2,
				createdAt: new Date(),
				lastUsedAt: null,
				revokedAt: null,
			};

			const mockUpdatedCredential = {
				...mockCredentialRecord,
				signCount: 6,
				stateVersion: 3,
				lastUsedAt: new Date(),
			};

			const mockDb = {
				update: vi
					.fn()
					// 1st update: consume challenge
					.mockReturnValueOnce({
						set: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								returning: vi.fn().mockResolvedValue([mockConsumedChallenge]),
							}),
						}),
					})
					// 2nd update: update credential counter & stateVersion
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
							limit: vi.fn().mockResolvedValue([mockCredentialRecord]),
						}),
					}),
				}),
			} as unknown as Database;

			const verifierSpy = vi
				.spyOn(SimpleWebAuthnServer, "verifyAuthenticationResponse")
				.mockResolvedValue({
					verified: true,
					authenticationInfo: {
						newCounter: 6,
						credentialID: "cred-abc-123",
						credentialDeviceType: "singleDevice",
						credentialBackedUp: false,
						origin: "http://localhost:8787",
						rpID: "localhost",
						userVerified: true,
					},
				});

			const result = await verifyAuthenticationForUser({
				db: mockDb,
				config: mockConfig,
				user: { id: "user-1" },
				response: validAuthResponse,
			});

			expect(result.verified).toBe(true);
			expect(result.authenticationInfo.newCounter).toBe(6);
			expect(result.credential).toEqual(mockUpdatedCredential);
			expect(verifierSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedChallenge: "test-challenge-auth",
					expectedOrigin: "http://localhost:8787",
					expectedRPID: "localhost",
					requireUserVerification: true,
				}),
			);
		});
	});
});
