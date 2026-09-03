import { describe, expect, it } from "vitest";
import {
	generateAuthenticationOptionsForUser,
	generateRegistrationOptionsForUser,
} from "../src/auth/webauthn";
import type { WebAuthnConfig } from "../src/config/env";

const mockConfig: WebAuthnConfig = {
	rpID: "localhost",
	rpName: "Gelir Gider",
	origin: "http://localhost:8787",
};

describe("WebAuthn Options Generator", () => {
	describe("Registration Options", () => {
		it("generates registration options with correct RP config, required userVerification, and challenge", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
				displayName: "Eren",
			};

			const options = await generateRegistrationOptionsForUser({
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
		});

		it("excludes active credentials while excluding revoked credentials from excludeCredentials list", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
				displayName: "Eren",
			};

			const existingCredentials = [
				{
					credentialId: "active-cred-1",
					revokedAt: null,
				},
				{
					credentialId: "revoked-cred-2",
					revokedAt: new Date(),
				},
				{
					credentialId: "active-cred-3",
					revokedAt: null,
				},
			];

			const options = await generateRegistrationOptionsForUser({
				config: mockConfig,
				user,
				existingCredentials,
			});

			const excludedIds = options.excludeCredentials?.map((c) => c.id) ?? [];
			expect(excludedIds).toContain("active-cred-1");
			expect(excludedIds).toContain("active-cred-3");
			expect(excludedIds).not.toContain("revoked-cred-2");
			expect(excludedIds.length).toBe(2);
		});
	});

	describe("Authentication Options", () => {
		it("generates authentication options with correct RP ID and required userVerification", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
			};

			const options = await generateAuthenticationOptionsForUser({
				config: mockConfig,
				user,
			});

			expect(options.rpId).toBe("localhost");
			expect(options.userVerification).toBe("required");
			expect(options.challenge).toBeDefined();
			expect(typeof options.challenge).toBe("string");
		});

		it("includes only active credentials in allowCredentials while omitting revoked ones", async () => {
			const user = {
				id: "6ef82b90-3339-49da-ade7-aacf59369328",
			};

			const existingCredentials = [
				{
					credentialId: "active-cred-1",
					revokedAt: null,
				},
				{
					credentialId: "revoked-cred-2",
					revokedAt: new Date(),
				},
			];

			const options = await generateAuthenticationOptionsForUser({
				config: mockConfig,
				user,
				existingCredentials,
			});

			const allowedIds = options.allowCredentials?.map((c) => c.id) ?? [];
			expect(allowedIds).toContain("active-cred-1");
			expect(allowedIds).not.toContain("revoked-cred-2");
			expect(allowedIds.length).toBe(1);
		});
	});
});
