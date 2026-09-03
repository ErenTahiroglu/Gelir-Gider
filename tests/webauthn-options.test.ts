import { describe, expect, it, vi } from "vitest";
import {
	generateAuthenticationOptionsForUser,
	generateRegistrationOptionsForUser,
	type UserCredentialSummary,
} from "../src/auth/webauthn";
import type { WebAuthnConfig } from "../src/config/env";
import type { Database } from "../src/db/client";

const mockConfig: WebAuthnConfig = {
	rpID: "localhost",
	rpName: "Gelir Gider",
	origin: "http://localhost:8787",
};

describe("WebAuthn Options Generator (Public API)", () => {
	const createMockDb = () =>
		({
			insert: vi.fn().mockReturnValue({
				values: vi.fn().mockReturnValue({
					returning: vi.fn().mockResolvedValue([
						{
							id: "mock-chal-id",
							challenge: "persisted-challenge",
						},
					]),
				}),
			}),
		}) as unknown as Database;

	describe("Registration Options Issuer", () => {
		it("generates and persists registration options with correct RP config and required userVerification", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
				displayName: "Eren",
			};
			const mockDb = createMockDb();

			const options = await generateRegistrationOptionsForUser({
				db: mockDb,
				config: mockConfig,
				user,
			});

			expect(options.rp.id).toBe("localhost");
			expect(options.rp.name).toBe("Gelir Gider");
			expect(options.user.name).toBe("Eren");
			expect(options.challenge).toBeDefined();
			expect(typeof options.challenge).toBe("string");
			expect(options.authenticatorSelection?.userVerification).toBe("required");
			expect(options.authenticatorSelection?.residentKey).toBe("preferred");
			expect(options.attestation).toBe("none");

			// Verify challenge persistence was called
			expect(mockDb.insert).toHaveBeenCalled();
		});

		it("excludes active credentials while excluding revoked credentials from excludeCredentials list, mapping transports", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
				displayName: "Eren",
			};

			const existingCredentials: UserCredentialSummary[] = [
				{
					credentialId: "active-cred-1",
					transports: ["internal"],
					revokedAt: null,
				},
				{
					credentialId: "revoked-cred-2",
					transports: ["usb"],
					revokedAt: new Date(),
				},
				{
					credentialId: "active-cred-3",
					transports: ["hybrid", "nfc"],
					revokedAt: null,
				},
			];
			const mockDb = createMockDb();

			const options = await generateRegistrationOptionsForUser({
				db: mockDb,
				config: mockConfig,
				user,
				existingCredentials,
			});

			const excludedIds = options.excludeCredentials?.map((c) => c.id) ?? [];
			expect(excludedIds).toContain("active-cred-1");
			expect(excludedIds).toContain("active-cred-3");
			expect(excludedIds).not.toContain("revoked-cred-2");
			expect(excludedIds.length).toBe(2);

			const cred1 = options.excludeCredentials?.find(
				(c) => c.id === "active-cred-1",
			);
			expect(cred1?.transports).toEqual(["internal"]);
		});

		it("fails closed when persistence fails during generateRegistrationOptionsForUser", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
				displayName: "Eren",
			};

			const mockDb = {
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi
							.fn()
							.mockRejectedValue(new Error("DB insert failure")),
					}),
				}),
			} as unknown as Database;

			await expect(
				generateRegistrationOptionsForUser({
					db: mockDb,
					config: mockConfig,
					user,
				}),
			).rejects.toThrow("DB insert failure");
		});
	});

	describe("Authentication Options Issuer", () => {
		it("generates and persists authentication options with correct RP ID and required userVerification", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
			};
			const mockDb = createMockDb();

			const options = await generateAuthenticationOptionsForUser({
				db: mockDb,
				config: mockConfig,
				user,
			});

			expect(options.rpId).toBe("localhost");
			expect(options.userVerification).toBe("required");
			expect(options.challenge).toBeDefined();
			expect(typeof options.challenge).toBe("string");

			// Verify challenge persistence was called
			expect(mockDb.insert).toHaveBeenCalled();
		});

		it("includes only active credentials in allowCredentials while omitting revoked ones, with transports", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
			};
			const existingCredentials: UserCredentialSummary[] = [
				{
					credentialId: "active-cred-1",
					transports: ["internal"],
					revokedAt: null,
				},
				{
					credentialId: "revoked-cred-2",
					transports: ["usb"],
					revokedAt: new Date(),
				},
			];
			const mockDb = createMockDb();

			const options = await generateAuthenticationOptionsForUser({
				db: mockDb,
				config: mockConfig,
				user,
				existingCredentials,
			});

			const allowedIds = options.allowCredentials?.map((c) => c.id) ?? [];
			expect(allowedIds).toContain("active-cred-1");
			expect(allowedIds).not.toContain("revoked-cred-2");
			expect(allowedIds.length).toBe(1);

			const cred1 = options.allowCredentials?.find(
				(c) => c.id === "active-cred-1",
			);
			expect(cred1?.transports).toEqual(["internal"]);
		});

		it("fails closed when persistence fails during generateAuthenticationOptionsForUser", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
			};

			const mockDb = {
				insert: vi.fn().mockReturnValue({
					values: vi.fn().mockReturnValue({
						returning: vi
							.fn()
							.mockRejectedValue(new Error("DB insert failure")),
					}),
				}),
			} as unknown as Database;

			await expect(
				generateAuthenticationOptionsForUser({
					db: mockDb,
					config: mockConfig,
					user,
				}),
			).rejects.toThrow("DB insert failure");
		});
	});
});
