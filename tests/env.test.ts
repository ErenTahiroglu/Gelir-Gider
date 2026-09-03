import { describe, expect, it } from "vitest";
import {
	type AppEnv,
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
