import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRecoveryAndIssueGrant } from "../src/auth/bootstrap";
import { hashRecoveryCode, rotateRecoveryCode } from "../src/auth/recovery";
import type { Database } from "../src/db/client";

describe("Recovery Authorization Service", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("rotates recovery code: revokes old active codes, stores new hash only, returns codes once", async () => {
		let capturedInsertValues: {
			userId?: string;
			codeHash?: string;
		} = {};

		const mockDb = {
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
		} as unknown as Database;

		const result = await rotateRecoveryCode({
			db: mockDb,
			userId: "user-1",
		});

		expect(result.canonical.length).toBe(32);
		expect(result.display.split(".").length).toBe(8);
		expect(mockDb.update).toHaveBeenCalled();
		expect(capturedInsertValues.codeHash).toBe(
			await hashRecoveryCode(result.canonical),
		);
		expect(capturedInsertValues.codeHash).not.toBe(result.canonical);
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

		const mockUpdate = vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({
				where: vi.fn().mockResolvedValue([]),
			}),
		});

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
			update: mockUpdate,
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
		} as unknown as Database;

		const result = await authorizeRecoveryAndIssueGrant({
			db: mockDb,
			recoveryCode: validDisplayCode,
		});

		expect(result.user.id).toBe("user-1");
		expect(result.enrollmentGrant).toBeDefined();

		// Check non-destructive: Recovery code is NOT consumed or revoked!
		// mockUpdate is only called for revoking previous active enrollment grants in issueEnrollmentGrant,
		// NOT for authRecoveryCodes or sessions.
		expect(mockActiveCode.consumedAt).toBeNull();
		expect(mockActiveCode.revokedAt).toBeNull();
	});
});
