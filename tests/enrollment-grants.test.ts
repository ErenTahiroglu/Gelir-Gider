import { describe, expect, it, vi } from "vitest";
import {
	AUTH_ENROLLMENT_GRANT_TTL_SECONDS,
	consumeActiveEnrollmentGrant,
	generateEnrollmentGrantToken,
	hashEnrollmentGrantToken,
	issueEnrollmentGrant,
} from "../src/auth/enrollment-grants";
import type { Database } from "../src/db/client";

describe("Enrollment Grants Service", () => {
	it("generates 43 characters base64url grant token with 256 bits of entropy", () => {
		const token = generateEnrollmentGrantToken();
		expect(token.length).toBe(43);
		expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
	});

	it("hashes enrollment grant token to 64 lowercase hex characters", async () => {
		const token = generateEnrollmentGrantToken();
		const hash1 = await hashEnrollmentGrantToken(token);
		const hash2 = await hashEnrollmentGrantToken(token);

		expect(hash1).toBe(hash2);
		expect(hash1.length).toBe(64);
		expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
		expect(hash1).not.toBe(token);
	});

	it("issues grant inside transaction: locks user FOR UPDATE, revokes existing active grant for same user & purpose, stores hash only, sets 10m TTL", async () => {
		let capturedInsertValues: {
			userId?: string;
			purpose?: string;
			tokenHash?: string;
			expiresAt?: Date;
		} = {};

		const mockTx = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						for: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([{ id: "user-1" }]),
						}),
					}),
				}),
			}),
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([]),
				}),
			}),
			insert: vi.fn().mockReturnValue({
				values: vi.fn().mockImplementation((vals) => {
					capturedInsertValues = vals;
					return {
						returning: vi.fn().mockResolvedValue([
							{
								id: "grant-1",
								userId: vals.userId,
								purpose: vals.purpose,
								tokenHash: vals.tokenHash,
								expiresAt: vals.expiresAt,
							},
						]),
					};
				}),
			}),
		};

		const mockDb = {
			transaction: vi.fn().mockImplementation(async (callback) => {
				return await callback(mockTx);
			}),
		} as unknown as Database;

		const result = await issueEnrollmentGrant({
			db: mockDb,
			userId: "user-1",
			purpose: "BOOTSTRAP",
		});

		expect(mockDb.transaction).toHaveBeenCalled();
		expect(mockTx.select).toHaveBeenCalled(); // Lock user
		expect(result.token).toBeDefined();
		expect(result.token.length).toBe(43);
		expect(result.grant.id).toBe("grant-1");

		// Prior active grant was revoked
		expect(mockTx.update).toHaveBeenCalled();

		// Hash stored in DB, not raw token
		expect(capturedInsertValues.tokenHash).not.toBe(result.token);
		expect(capturedInsertValues.tokenHash).toBe(
			await hashEnrollmentGrantToken(result.token),
		);

		// Expiry ≈ 10 minutes
		const now = Date.now();
		const expiryTime = capturedInsertValues.expiresAt?.getTime() ?? 0;
		const diffSeconds = (expiryTime - now) / 1000;
		expect(diffSeconds).toBeGreaterThan(AUTH_ENROLLMENT_GRANT_TTL_SECONDS - 5);
		expect(diffSeconds).toBeLessThanOrEqual(
			AUTH_ENROLLMENT_GRANT_TTL_SECONDS + 5,
		);
	});

	it("revalidates source recovery code inside transaction for RECOVERY grant: fails closed if invalid or revoked without mutating state", async () => {
		const mockTx = {
			select: vi
				.fn()
				// 1st select: lock user
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							for: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([{ id: "user-1" }]),
							}),
						}),
					}),
				})
				// 2nd select: revalidate source recovery code (not found or revoked!)
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			update: vi.fn(),
			insert: vi.fn(),
		};

		const mockDb = {
			transaction: vi.fn().mockImplementation(async (callback) => {
				return await callback(mockTx);
			}),
		} as unknown as Database;

		await expect(
			issueEnrollmentGrant({
				db: mockDb,
				userId: "user-1",
				purpose: "RECOVERY",
				recoveryCodeId: "revoked-rc-id",
			}),
		).rejects.toThrow("RECOVERY_SOURCE_INVALID");

		expect(mockTx.update).not.toHaveBeenCalled();
		expect(mockTx.insert).not.toHaveBeenCalled();
	});

	it("simulated insert failure rolls back and does not leave prior active grant revoked", async () => {
		let priorGrantRevoked = false;

		const mockTx = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						for: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([{ id: "user-1" }]),
						}),
					}),
				}),
			}),
			update: vi.fn().mockImplementation(() => {
				priorGrantRevoked = true;
				return {
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockResolvedValue([]),
					}),
				};
			}),
			insert: vi.fn().mockImplementation(() => {
				throw new Error("INSERT_GRANT_FAILED");
			}),
		};

		const mockDb = {
			transaction: vi.fn().mockImplementation(async (callback) => {
				try {
					return await callback(mockTx);
				} catch (err) {
					priorGrantRevoked = false;
					throw err;
				}
			}),
		} as unknown as Database;

		await expect(
			issueEnrollmentGrant({
				db: mockDb,
				userId: "user-1",
				purpose: "BOOTSTRAP",
			}),
		).rejects.toThrow("INSERT_GRANT_FAILED");

		expect(priorGrantRevoked).toBe(false);
	});

	it("consumes active grant atomically and returns row once, second consume fails", async () => {
		const mockConsumedGrant = {
			id: "grant-1",
			userId: "user-1",
			purpose: "BOOTSTRAP",
			tokenHash: "test-hash",
			consumedAt: new Date(),
		};

		const mockDb = {
			update: vi
				.fn()
				.mockReturnValueOnce({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([mockConsumedGrant]),
						}),
					}),
				})
				.mockReturnValueOnce({
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([]), // already consumed!
						}),
					}),
				}),
		} as unknown as Database;

		const firstTry = await consumeActiveEnrollmentGrant({
			db: mockDb,
			userId: "user-1",
			purpose: "BOOTSTRAP",
			token: "valid-grant-token",
		});
		expect(firstTry).toEqual(mockConsumedGrant);

		const secondTry = await consumeActiveEnrollmentGrant({
			db: mockDb,
			userId: "user-1",
			purpose: "BOOTSTRAP",
			token: "valid-grant-token",
		});
		expect(secondTry).toBeNull();
	});

	it("returns null for empty token or mismatched criteria", async () => {
		const mockDb = {
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([]),
					}),
				}),
			}),
		} as unknown as Database;

		expect(
			await consumeActiveEnrollmentGrant({
				db: mockDb,
				userId: "user-1",
				purpose: "BOOTSTRAP",
				token: "",
			}),
		).toBeNull();
	});
});
