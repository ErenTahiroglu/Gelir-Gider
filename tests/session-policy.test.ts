import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSession,
	findActiveSessionByToken,
	hashSessionToken,
	revokeAllSessionsForUser,
	revokeSessionByToken,
	touchSessionActivity,
} from "../src/auth/sessions";
import type { Database } from "../src/db/client";

describe("Session Lifecycle & Policy Service", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("creates session: returns raw token to caller, stores only SHA-256 hash in DB", async () => {
		const capturedValues: {
			tokenHash?: string;
			expiresAt?: Date;
		} = {};

		const mockDb = {
			insert: vi.fn().mockReturnValue({
				values: vi.fn().mockImplementation((values) => {
					capturedValues.tokenHash = values.tokenHash;
					capturedValues.expiresAt = values.expiresAt;
					return {
						returning: vi.fn().mockResolvedValue([
							{
								id: "session-1",
								userId: "user-1",
								createdAt: new Date(),
								expiresAt: values.expiresAt,
								lastSeenAt: values.lastSeenAt,
								revokedAt: null,
							},
						]),
					};
				}),
			}),
		} as unknown as Database;

		const result = await createSession({
			db: mockDb,
			userId: "user-1",
		});

		expect(result.token).toBeDefined();
		expect(typeof result.token).toBe("string");
		expect(result.token.length).toBe(43);

		expect(result.session.id).toBe("session-1");
		expect(result.session.userId).toBe("user-1");

		// Stored in DB: must be SHA-256 hash, never raw token
		expect(capturedValues.tokenHash).toBeDefined();
		expect(capturedValues.tokenHash).not.toBe(result.token);
		expect(capturedValues.tokenHash).toBe(await hashSessionToken(result.token));

		// Expiry ≈ 30 days
		const now = Date.now();
		const expiryTime = capturedValues.expiresAt?.getTime() ?? 0;
		const diffDays = (expiryTime - now) / (1000 * 60 * 60 * 24);
		expect(diffDays).toBeGreaterThan(29.9);
		expect(diffDays).toBeLessThan(30.1);
	});

	it("findActiveSessionByToken returns session when valid, unexpired and not idle", async () => {
		const mockSessionRecord = {
			id: "session-1",
			userId: "user-1",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			lastSeenAt: new Date(),
		};

		const mockDb = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([mockSessionRecord]),
					}),
				}),
			}),
		} as unknown as Database;

		const session = await findActiveSessionByToken({
			db: mockDb,
			token: "valid-active-token",
		});

		expect(session).toEqual(mockSessionRecord);
	});

	it("findActiveSessionByToken returns null for empty or invalid token or when DB returns no match", async () => {
		const mockDb = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([]),
					}),
				}),
			}),
		} as unknown as Database;

		expect(
			await findActiveSessionByToken({ db: mockDb, token: "" }),
		).toBeNull();
		expect(
			await findActiveSessionByToken({ db: mockDb, token: "non-existent" }),
		).toBeNull();
	});

	it("throttles touchSessionActivity: does not write to DB if last_seen_at is less than 15 min old", async () => {
		const mockDb = {
			update: vi.fn(),
		} as unknown as Database;

		// 5 minutes ago
		const recentLastSeen = new Date(Date.now() - 5 * 60 * 1000);

		const updated = await touchSessionActivity({
			db: mockDb,
			sessionId: "session-1",
			lastSeenAt: recentLastSeen,
		});

		expect(updated).toBe(false);
		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("writes touchSessionActivity to DB if last_seen_at is older than 15 min or null without extending expires_at", async () => {
		const capturedUpdate: {
			lastSeenAt?: Date;
			expiresAt?: Date;
		} = {};

		const mockDb = {
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockImplementation((setVals) => {
					capturedUpdate.lastSeenAt = setVals.lastSeenAt;
					capturedUpdate.expiresAt = setVals.expiresAt;
					return {
						where: vi.fn().mockReturnValue({
							returning: vi.fn().mockResolvedValue([{ id: "session-1" }]),
						}),
					};
				}),
			}),
		} as unknown as Database;

		// 20 minutes ago
		const oldLastSeen = new Date(Date.now() - 20 * 60 * 1000);

		const updated = await touchSessionActivity({
			db: mockDb,
			sessionId: "session-1",
			lastSeenAt: oldLastSeen,
		});

		expect(updated).toBe(true);
		expect(capturedUpdate.lastSeenAt).toBeDefined();
		// Must not touch expires_at
		expect(capturedUpdate.expiresAt).toBeUndefined();
	});

	it("revokes session by raw token safely and idempotently", async () => {
		const mockDb = {
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([{ id: "session-1" }]),
					}),
				}),
			}),
		} as unknown as Database;

		const revoked = await revokeSessionByToken({
			db: mockDb,
			token: "active-token-to-revoke",
		});

		expect(revoked).toBe(true);
	});

	it("revoking already revoked or empty token returns false safely", async () => {
		const mockDb = {
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([]),
					}),
				}),
			}),
		} as unknown as Database;

		expect(await revokeSessionByToken({ db: mockDb, token: "" })).toBe(false);
		expect(
			await revokeSessionByToken({
				db: mockDb,
				token: "already-revoked-token",
			}),
		).toBe(false);
	});

	it("revokes all active sessions for a given user", async () => {
		const mockDb = {
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						returning: vi
							.fn()
							.mockResolvedValue([{ id: "session-1" }, { id: "session-2" }]),
					}),
				}),
			}),
		} as unknown as Database;

		const count = await revokeAllSessionsForUser({
			db: mockDb,
			userId: "user-1",
		});

		expect(count).toBe(2);
	});
});
