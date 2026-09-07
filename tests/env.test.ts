import { describe, expect, it } from "vitest";
import {
	type AppEnv,
	getBackupKeyId,
	getBootstrapTokenHash,
	getDatabaseUrl,
	getWebAuthnConfig,
} from "../src/config/env";

describe("Database Environment Contract", () => {
	it("throws DATABASE_URL is required when DATABASE_URL is empty", () => {
		const env: AppEnv = { DATABASE_URL: "" };
		expect(() => getDatabaseUrl(env)).toThrow("DATABASE_URL is required");
	});

	it("throws DATABASE_URL is required when DATABASE_URL is whitespace-only", () => {
		const env: AppEnv = { DATABASE_URL: "   " };
		expect(() => getDatabaseUrl(env)).toThrow("DATABASE_URL is required");
	});

	it("returns valid database url string as is", () => {
		const testUrl = "postgresql://user:password@example.invalid/db";
		const env: AppEnv = { DATABASE_URL: testUrl };
		expect(getDatabaseUrl(env)).toBe(testUrl);
	});

	it("returns trimmed database url when leading or trailing whitespace exists", () => {
		const testUrl = "postgresql://user:password@example.invalid/db";
		const env: AppEnv = { DATABASE_URL: `  ${testUrl}  \n` };
		expect(getDatabaseUrl(env)).toBe(testUrl);
	});

	it("ensures thrown error does not leak connection string or sensitive values", () => {
		const env: AppEnv = { DATABASE_URL: "" };
		try {
			getDatabaseUrl(env);
			expect.unreachable("should have thrown");
		} catch (err: unknown) {
			const error = err as Error;
			expect(error.message).toBe("DATABASE_URL is required");
			expect(error.message).not.toContain("postgresql://");
			expect(error.message).not.toContain("example.invalid");
		}
	});
});

describe("WebAuthn Environment Contract", () => {
	it("throws WEBAUTHN_RP_ID is required when rpID is missing, empty or whitespace", () => {
		expect(() =>
			getWebAuthnConfig({
				WEBAUTHN_RP_NAME: "Gelir Gider",
				WEBAUTHN_ORIGIN: "http://localhost:8787",
			}),
		).toThrow("WEBAUTHN_RP_ID is required");

		expect(() =>
			getWebAuthnConfig({
				WEBAUTHN_RP_ID: "   ",
				WEBAUTHN_RP_NAME: "Gelir Gider",
				WEBAUTHN_ORIGIN: "http://localhost:8787",
			}),
		).toThrow("WEBAUTHN_RP_ID is required");
	});

	it("throws WEBAUTHN_RP_NAME is required when rpName is missing, empty or whitespace", () => {
		expect(() =>
			getWebAuthnConfig({
				WEBAUTHN_RP_ID: "localhost",
				WEBAUTHN_ORIGIN: "http://localhost:8787",
			}),
		).toThrow("WEBAUTHN_RP_NAME is required");

		expect(() =>
			getWebAuthnConfig({
				WEBAUTHN_RP_ID: "localhost",
				WEBAUTHN_RP_NAME: "",
				WEBAUTHN_ORIGIN: "http://localhost:8787",
			}),
		).toThrow("WEBAUTHN_RP_NAME is required");
	});

	it("throws WEBAUTHN_ORIGIN is required when origin is missing, empty or whitespace", () => {
		expect(() =>
			getWebAuthnConfig({
				WEBAUTHN_RP_ID: "localhost",
				WEBAUTHN_RP_NAME: "Gelir Gider",
			}),
		).toThrow("WEBAUTHN_ORIGIN is required");

		expect(() =>
			getWebAuthnConfig({
				WEBAUTHN_RP_ID: "localhost",
				WEBAUTHN_RP_NAME: "Gelir Gider",
				WEBAUTHN_ORIGIN: "  ",
			}),
		).toThrow("WEBAUTHN_ORIGIN is required");
	});

	it("returns valid trimmed WebAuthnConfig when valid env provided", () => {
		const config = getWebAuthnConfig({
			WEBAUTHN_RP_ID: "  localhost  ",
			WEBAUTHN_RP_NAME: " Gelir Gider ",
			WEBAUTHN_ORIGIN: " http://localhost:8787 \n",
		});

		expect(config).toEqual({
			rpID: "localhost",
			rpName: "Gelir Gider",
			origin: "http://localhost:8787",
		});
	});
});

describe("Bootstrap Environment Contract", () => {
	it("throws BOOTSTRAP_TOKEN_HASH is required when missing, empty or whitespace", () => {
		expect(() => getBootstrapTokenHash({})).toThrow(
			"BOOTSTRAP_TOKEN_HASH is required",
		);
		expect(() => getBootstrapTokenHash({ BOOTSTRAP_TOKEN_HASH: "" })).toThrow(
			"BOOTSTRAP_TOKEN_HASH is required",
		);
		expect(() =>
			getBootstrapTokenHash({ BOOTSTRAP_TOKEN_HASH: "   " }),
		).toThrow("BOOTSTRAP_TOKEN_HASH is required");
	});

	it("throws validation error when hash is not 64 lowercase hex characters", () => {
		expect(() =>
			getBootstrapTokenHash({
				BOOTSTRAP_TOKEN_HASH: "0123456789abcdef", // too short
			}),
		).toThrow(
			"BOOTSTRAP_TOKEN_HASH must be exactly 64 lowercase hexadecimal characters",
		);

		expect(() =>
			getBootstrapTokenHash({
				BOOTSTRAP_TOKEN_HASH: "G".repeat(64), // invalid hex
			}),
		).toThrow(
			"BOOTSTRAP_TOKEN_HASH must be exactly 64 lowercase hexadecimal characters",
		);

		expect(() =>
			getBootstrapTokenHash({
				BOOTSTRAP_TOKEN_HASH: "A".repeat(64), // uppercase
			}),
		).toThrow(
			"BOOTSTRAP_TOKEN_HASH must be exactly 64 lowercase hexadecimal characters",
		);
	});

	it("returns trimmed valid 64-char lowercase hex hash", () => {
		const validHash =
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		expect(
			getBootstrapTokenHash({
				BOOTSTRAP_TOKEN_HASH: `  ${validHash}  \n`,
			}),
		).toBe(validHash);
	});
});

describe("Backup Key ID Environment Contract (Phase 18-R2 Section E)", () => {
	it("defaults to 'v1' when unset", () => {
		expect(getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: undefined })).toBe("v1");
	});

	it("defaults to 'v1' when empty or whitespace-only", () => {
		expect(getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "" })).toBe("v1");
		expect(getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "   " })).toBe("v1");
	});

	it("returns a trimmed valid custom keyId", () => {
		expect(getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "  v2-prod  " })).toBe(
			"v2-prod",
		);
	});

	it("throws for an oversized keyId (>64 chars)", () => {
		expect(() =>
			getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "a".repeat(65) }),
		).toThrow("BACKUP_ENCRYPTION_KEY_ID must be at most 64 characters");
	});

	it("accepts a keyId at exactly the 64-char boundary", () => {
		const exact = "a".repeat(64);
		expect(getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: exact })).toBe(exact);
	});

	it("throws for a keyId containing unsafe characters", () => {
		expect(() =>
			getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "v1/../etc" }),
		).toThrow(
			"BACKUP_ENCRYPTION_KEY_ID must contain only letters, digits, underscores, or hyphens",
		);
		expect(() =>
			getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "v1 prod" }),
		).toThrow(
			"BACKUP_ENCRYPTION_KEY_ID must contain only letters, digits, underscores, or hyphens",
		);
		expect(() =>
			getBackupKeyId({ BACKUP_ENCRYPTION_KEY_ID: "v1;drop" }),
		).toThrow(
			"BACKUP_ENCRYPTION_KEY_ID must contain only letters, digits, underscores, or hyphens",
		);
	});
});
