import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	authorizeBootstrapAndIssueGrant,
	hashBootstrapToken,
	timingSafeHashEqual,
} from "../src/auth/bootstrap";
import type { Database } from "../src/db/client";

describe("Bootstrap Authorization Service", () => {
	const rawSecret = "super-secret-bootstrap-token-123456789";
	let expectedHash: string;

	beforeEach(async () => {
		vi.restoreAllMocks();
		expectedHash = await hashBootstrapToken(rawSecret);
	});

	it("constant-time hash comparison works accurately and rejects unequal or malformed inputs", () => {
		expect(timingSafeHashEqual(expectedHash, expectedHash)).toBe(true);
		expect(
			timingSafeHashEqual(
				expectedHash,
				"0".repeat(64), // different valid hex
			),
		).toBe(false);
		expect(timingSafeHashEqual(expectedHash, "short")).toBe(false);
		expect(timingSafeHashEqual(expectedHash, expectedHash.slice(0, 63))).toBe(
			false,
		);
	});

	it("rejects wrong bootstrap token without DB mutations", async () => {
		const mockDb = {
			select: vi.fn(),
			insert: vi.fn(),
		} as unknown as Database;

		await expect(
			authorizeBootstrapAndIssueGrant({
				db: mockDb,
				bootstrapToken: "wrong-token",
				expectedBootstrapTokenHash: expectedHash,
				displayName: "Eren",
			}),
		).rejects.toMatchObject({
			code: "BOOTSTRAP_INVALID",
		});

		expect(mockDb.select).not.toHaveBeenCalled();
		expect(mockDb.insert).not.toHaveBeenCalled();
	});

	it("rejects invalid display name", async () => {
		const mockDb = {} as unknown as Database;

		await expect(
			authorizeBootstrapAndIssueGrant({
				db: mockDb,
				bootstrapToken: rawSecret,
				expectedBootstrapTokenHash: expectedHash,
				displayName: "   ",
			}),
		).rejects.toMatchObject({
			code: "INVALID_DISPLAY_NAME",
		});

		await expect(
			authorizeBootstrapAndIssueGrant({
				db: mockDb,
				bootstrapToken: rawSecret,
				expectedBootstrapTokenHash: expectedHash,
				displayName: "x".repeat(101),
			}),
		).rejects.toMatchObject({
			code: "INVALID_DISPLAY_NAME",
		});
	});

	it("creates singleton user when none exists and issues BOOTSTRAP enrollment grant with uninitialized status", async () => {
		const mockCreatedUser = {
			id: "user-1",
			displayName: "Eren",
			authInitializedAt: null,
		};

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
				values: vi.fn().mockReturnValue({
					returning: vi.fn().mockResolvedValue([
						{
							id: "grant-1",
							userId: "user-1",
							purpose: "BOOTSTRAP",
						},
					]),
				}),
			}),
		};

		const mockDb = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([]), // No user initially
				}),
			}),
			insert: vi.fn().mockReturnValue({
				values: vi.fn().mockReturnValue({
					onConflictDoNothing: vi.fn().mockReturnValue({
						returning: vi.fn().mockResolvedValue([mockCreatedUser]),
					}),
				}),
			}),
			transaction: vi.fn().mockImplementation(async (callback) => {
				return await callback(mockTx);
			}),
		} as unknown as Database;

		const result = await authorizeBootstrapAndIssueGrant({
			db: mockDb,
			bootstrapToken: rawSecret,
			expectedBootstrapTokenHash: expectedHash,
			displayName: "Eren",
		});

		expect(result.user.id).toBe("user-1");
		expect(result.user.displayName).toBe("Eren");
		expect(result.enrollmentGrant).toBeDefined();
		expect(result.enrollmentGrant.length).toBe(43);
		expect(mockDb.transaction).toHaveBeenCalled();
	});

	it("issues grant for existing uninitialized user", async () => {
		const mockExistingUser = {
			id: "user-existing",
			displayName: "Eren",
			authInitializedAt: null,
		};

		const mockTx = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						for: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([{ id: "user-existing" }]),
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
				values: vi.fn().mockReturnValue({
					returning: vi.fn().mockResolvedValue([
						{
							id: "grant-2",
							userId: "user-existing",
							purpose: "BOOTSTRAP",
						},
					]),
				}),
			}),
		};

		const mockDb = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([mockExistingUser]),
				}),
			}),
			transaction: vi.fn().mockImplementation(async (callback) => {
				return await callback(mockTx);
			}),
		} as unknown as Database;

		const result = await authorizeBootstrapAndIssueGrant({
			db: mockDb,
			bootstrapToken: rawSecret,
			expectedBootstrapTokenHash: expectedHash,
			displayName: "Eren",
		});

		expect(result.user.id).toBe("user-existing");
		expect(result.enrollmentGrant).toBeDefined();
		expect(mockDb.transaction).toHaveBeenCalled();
	});

	it("rejects with BOOTSTRAP_ALREADY_COMPLETED when instance is already initialized", async () => {
		const mockInitializedUser = {
			id: "user-init",
			displayName: "Eren",
			authInitializedAt: new Date(),
		};

		const mockDb = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([mockInitializedUser]),
				}),
			}),
			insert: vi.fn(),
		} as unknown as Database;

		await expect(
			authorizeBootstrapAndIssueGrant({
				db: mockDb,
				bootstrapToken: rawSecret,
				expectedBootstrapTokenHash: expectedHash,
				displayName: "Eren",
			}),
		).rejects.toMatchObject({
			code: "BOOTSTRAP_ALREADY_COMPLETED",
		});

		expect(mockDb.insert).not.toHaveBeenCalled();
	});
});
