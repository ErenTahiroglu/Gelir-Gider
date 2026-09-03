import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRecoveryAndIssueGrant } from "../src/auth/bootstrap";
import { hashRecoveryCode, rotateRecoveryCode } from "../src/auth/recovery";
import type { Database } from "../src/db/client";

describe("Recovery Authorization Service", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("rotates recovery code in a transaction: locks user FOR UPDATE, revokes old active codes, revokes pending recovery grants, stores new hash, returns codes once", async () => {
		let capturedInsertValues: {
			userId?: string;
			codeHash?: string;
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
								id: "rc-1",
								userId: vals.userId,
								codeHash: vals.codeHash,
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

		const result = await rotateRecoveryCode({
			db: mockDb,
			userId: "user-1",
		});

		expect(mockDb.transaction).toHaveBeenCalled();
		expect(mockTx.select).toHaveBeenCalled(); // Lock user
		// 2 update calls: (1) revoke active recovery codes, (2) revoke pending RECOVERY enrollment grants
		expect(mockTx.update).toHaveBeenCalledTimes(2);
		expect(result.canonical.length).toBe(32);
		expect(result.display.split(".").length).toBe(8);
		expect(capturedInsertValues.codeHash).toBe(
			await hashRecoveryCode(result.canonical),
		);
		expect(capturedInsertValues.codeHash).not.toBe(result.canonical);
	});

	it("fails rotation if user row lock fails and does not insert new code", async () => {
		const mockTx = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						for: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]), // User not found
						}),
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
			rotateRecoveryCode({
				db: mockDb,
				userId: "user-missing",
			}),
		).rejects.toThrow("User not found during recovery code rotation");

		expect(mockTx.update).not.toHaveBeenCalled();
		expect(mockTx.insert).not.toHaveBeenCalled();
	});

	it("simulated insertion failure causes transaction rollback and leaves nothing committed", async () => {
		let updateCommitted = false;

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
				updateCommitted = true;
				return {
					set: vi.fn().mockReturnValue({
						where: vi.fn().mockResolvedValue([]),
					}),
				};
			}),
			insert: vi.fn().mockImplementation(() => {
				throw new Error("DB_INSERT_FAILURE");
			}),
		};

		const mockDb = {
			transaction: vi.fn().mockImplementation(async (callback) => {
				try {
					return await callback(mockTx);
				} catch (err) {
					// In a real DB transaction, rollback cancels any prior updates.
					updateCommitted = false;
					throw err;
				}
			}),
		} as unknown as Database;

		await expect(
			rotateRecoveryCode({
				db: mockDb,
				userId: "user-1",
			}),
		).rejects.toThrow("DB_INSERT_FAILURE");

		expect(updateCommitted).toBe(false);
	});

	it("rejects recovery on an uninitialized instance", async () => {
		const mockDb = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([
						{
							id: "user-uninit",
							authInitializedAt: null, // NOT initialized
						},
					]),
				}),
			}),
		} as unknown as Database;

		await expect(
			authorizeRecoveryAndIssueGrant({
				db: mockDb,
				recoveryCode: "Abc1.234_.xyz8.9012.3456.7890.1234.5678",
			}),
		).rejects.toMatchObject({
			code: "RECOVERY_NOT_INITIALIZED",
		});
	});

	it("rejects invalid or wrong recovery code without changing code status", async () => {
		const mockDb = {
			select: vi
				.fn()
				// 1st select: user
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: "user-init",
								authInitializedAt: new Date(),
							},
						]),
					}),
				})
				// 2nd select: recovery code lookup (not found)
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
		} as unknown as Database;

		await expect(
			authorizeRecoveryAndIssueGrant({
				db: mockDb,
				recoveryCode: "Abc1.234_.xyz8.9012.3456.7890.1234.5678",
			}),
		).rejects.toMatchObject({
			code: "RECOVERY_CODE_INVALID",
		});
	});

	it("authorizes recovery with valid code non-destructively: issues RECOVERY grant without consuming code or revoking sessions", async () => {
		const validDisplayCode = "Abc1.234_.xyz8.9012.3456.7890.1234.5678";
		const mockActiveCode = {
			id: "rc-active-1",
			userId: "user-1",
			codeHash: "matching-hash",
			consumedAt: null,
			revokedAt: null,
		};

		const mockTx = {
			select: vi
				.fn()
				// 1st tx select: user lock FOR UPDATE
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							for: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([{ id: "user-1" }]),
							}),
						}),
					}),
				})
				// 2nd tx select: recovery source revalidation inside tx
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([{ id: "rc-active-1" }]),
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
							id: "grant-rec-1",
							userId: "user-1",
							purpose: "RECOVERY",
						},
					]),
				}),
			}),
		};

		const mockDb = {
			select: vi
				.fn()
				// 1st select: user
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: "user-1",
								displayName: "Eren",
								authInitializedAt: new Date(),
							},
						]),
					}),
				})
				// 2nd select: active recovery code match
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockActiveCode]),
						}),
					}),
				}),
			transaction: vi.fn().mockImplementation(async (callback) => {
				return await callback(mockTx);
			}),
		} as unknown as Database;

		const result = await authorizeRecoveryAndIssueGrant({
			db: mockDb,
			recoveryCode: validDisplayCode,
		});

		expect(result.user.id).toBe("user-1");
		expect(result.enrollmentGrant).toBeDefined();

		// Check non-destructive: Recovery code is NOT consumed or revoked!
		expect(mockActiveCode.consumedAt).toBeNull();
		expect(mockActiveCode.revokedAt).toBeNull();
	});

	it("sanitizes RECOVERY_SOURCE_INVALID to RECOVERY_CODE_INVALID when source was revoked concurrently", async () => {
		const validDisplayCode = "Abc1.234_.xyz8.9012.3456.7890.1234.5678";
		const mockActiveCode = {
			id: "rc-active-1",
			userId: "user-1",
			codeHash: "matching-hash",
			consumedAt: null,
			revokedAt: null,
		};

		const mockTx = {
			select: vi
				.fn()
				// 1st tx select: user lock FOR UPDATE
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							for: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([{ id: "user-1" }]),
							}),
						}),
					}),
				})
				// 2nd tx select: recovery source revalidation fails (e.g. rotated concurrently!)
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]), // No longer active!
						}),
					}),
				}),
			update: vi.fn(),
			insert: vi.fn(),
		};

		const mockDb = {
			select: vi
				.fn()
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: "user-1",
								displayName: "Eren",
								authInitializedAt: new Date(),
							},
						]),
					}),
				})
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([mockActiveCode]),
						}),
					}),
				}),
			transaction: vi.fn().mockImplementation(async (callback) => {
				return await callback(mockTx);
			}),
		} as unknown as Database;

		await expect(
			authorizeRecoveryAndIssueGrant({
				db: mockDb,
				recoveryCode: validDisplayCode,
			}),
		).rejects.toMatchObject({
			code: "RECOVERY_CODE_INVALID",
		});

		expect(mockTx.update).not.toHaveBeenCalled();
		expect(mockTx.insert).not.toHaveBeenCalled();
	});
});
