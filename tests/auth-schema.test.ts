import { describe, expect, it } from "vitest";
import { WEBAUTHN_CHALLENGE_TTL_SECONDS } from "../src/auth/challenges";
import { AUTH_ENROLLMENT_GRANT_TTL_SECONDS } from "../src/auth/enrollment-grants";
import {
	SESSION_ABSOLUTE_TTL_SECONDS,
	SESSION_IDLE_TTL_SECONDS,
} from "../src/auth/sessions";
import {
	authEnrollmentGrants,
	authRecoveryCodes,
	sessions,
	users,
	webauthnChallenges,
	webauthnCredentials,
} from "../src/db/schema/auth";

describe("Database Auth Schema Contracts", () => {
	it("verifies users table structure and constraints", () => {
		const cols = users;
		expect(cols.id).toBeDefined();
		expect(cols.singletonKey).toBeDefined();
		expect(cols.displayName).toBeDefined();
		expect(cols.timezone).toBeDefined();
		expect(cols.currency).toBeDefined();
		expect(cols.authInitializedAt).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.updatedAt).toBeDefined();
	});

	it("verifies webauthn_credentials table structure and stateVersion column", () => {
		const cols = webauthnCredentials;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.credentialId).toBeDefined();
		expect(cols.publicKey).toBeDefined();
		expect(cols.signCount).toBeDefined();
		expect(cols.deviceName).toBeDefined();
		expect(cols.deviceType).toBeDefined();
		expect(cols.transports).toBeDefined();
		expect(cols.backedUp).toBeDefined();
		expect(cols.stateVersion).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.lastUsedAt).toBeDefined();
		expect(cols.revokedAt).toBeDefined();

		// Security: credential table does not store private key
		expect("privateKey" in cols).toBe(false);
	});

	it("verifies sessions table structure and TTL invariants", () => {
		const cols = sessions;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.tokenHash).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.expiresAt).toBeDefined();
		expect(cols.lastSeenAt).toBeDefined();
		expect(cols.revokedAt).toBeDefined();

		// Security: sessions table does not store plaintext session tokens
		expect("token" in cols).toBe(false);
		expect("rawToken" in cols).toBe(false);

		// Policy TTL contracts: 30 days absolute, 7 days idle
		expect(SESSION_ABSOLUTE_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
		expect(SESSION_IDLE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
	});

	it("verifies webauthn_challenges table structure and binding to enrollment_grant_id", () => {
		const cols = webauthnChallenges;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.purpose).toBeDefined();
		expect(cols.challenge).toBeDefined();
		expect(cols.enrollmentGrantId).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.expiresAt).toBeDefined();
		expect(cols.consumedAt).toBeDefined();

		// TTL is 300 seconds (5 minutes)
		expect(WEBAUTHN_CHALLENGE_TTL_SECONDS).toBe(300);

		// Security: challenge table does not store password or credential secrets
		expect("secret" in cols).toBe(false);
		expect("password" in cols).toBe(false);
	});

	it("verifies auth_recovery_codes table structure and security constraints", () => {
		const cols = authRecoveryCodes;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.codeHash).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.consumedAt).toBeDefined();
		expect(cols.revokedAt).toBeDefined();

		// Security: no raw code or plaintext secrets
		expect("code" in cols).toBe(false);
		expect("rawCode" in cols).toBe(false);
		expect("password" in cols).toBe(false);
	});

	it("verifies auth_enrollment_grants table structure and security constraints", () => {
		const cols = authEnrollmentGrants;
		expect(cols.id).toBeDefined();
		expect(cols.userId).toBeDefined();
		expect(cols.purpose).toBeDefined();
		expect(cols.tokenHash).toBeDefined();
		expect(cols.recoveryCodeId).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.expiresAt).toBeDefined();
		expect(cols.consumedAt).toBeDefined();
		expect(cols.revokedAt).toBeDefined();

		// TTL is 600 seconds (10 minutes)
		expect(AUTH_ENROLLMENT_GRANT_TTL_SECONDS).toBe(600);

		// Security: no raw token stored
		expect("token" in cols).toBe(false);
		expect("rawToken" in cols).toBe(false);
		expect("password" in cols).toBe(false);
	});
});
