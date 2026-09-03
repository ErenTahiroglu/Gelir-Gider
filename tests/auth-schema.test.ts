import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, users, webauthnCredentials } from "../src/db/schema/auth";

describe("Single-User Identity Schema Contract", () => {
	it("exports the three required identity tables with exact names", () => {
		expect(getTableName(users)).toBe("users");
		expect(getTableName(webauthnCredentials)).toBe("webauthn_credentials");
		expect(getTableName(sessions)).toBe("sessions");
	});

	it("verifies users table structure and critical columns", () => {
		const cols = users;
		expect(cols.id).toBeDefined();
		expect(cols.singletonKey).toBeDefined();
		expect(cols.displayName).toBeDefined();
		expect(cols.timezone).toBeDefined();
		expect(cols.currency).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.updatedAt).toBeDefined();

		// Security: must not contain password columns
		expect("password" in cols).toBe(false);
		expect("password_hash" in cols).toBe(false);
		expect("passwordHash" in cols).toBe(false);
	});

	it("verifies webauthn_credentials table structure and critical columns", () => {
		const cols = webauthnCredentials;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.credentialId).toBeDefined();
		expect(cols.publicKey).toBeDefined();
		expect(cols.signCount).toBeDefined();
		expect(cols.deviceName).toBeDefined();
		expect(cols.deviceType).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.lastUsedAt).toBeDefined();
		expect(cols.revokedAt).toBeDefined();

		// Security: must not contain password fields
		expect("password" in cols).toBe(false);
		expect("secret" in cols).toBe(false);
	});

	it("verifies sessions table structure and critical columns", () => {
		const cols = sessions;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.tokenHash).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.expiresAt).toBeDefined();
		expect(cols.lastSeenAt).toBeDefined();
		expect(cols.revokedAt).toBeDefined();

		// Security: must store only tokenHash, never raw session token
		expect("token" in cols).toBe(false);
		expect("rawToken" in cols).toBe(false);
		expect("sessionToken" in cols).toBe(false);
	});
});
