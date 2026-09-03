import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { authEnrollmentGrants } from "../db/schema/auth";

export const AUTH_ENROLLMENT_GRANT_TTL_SECONDS = 10 * 60; // 10 minutes
export const ENROLLMENT_GRANT_TOKEN_BYTES = 32;

export type EnrollmentGrantPurpose = "BOOTSTRAP" | "RECOVERY";

/**
 * Generates an enrollment grant raw token.
 * 32 random bytes, 256 bits, unpadded base64url (43 chars).
 */
export function generateEnrollmentGrantToken(): string {
	const bytes = crypto.getRandomValues(
		new Uint8Array(ENROLLMENT_GRANT_TOKEN_BYTES),
	);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	const base64 = btoa(binary);

	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Computes the SHA-256 hash of a raw enrollment grant token.
 * Returns 64-character lowercase hexadecimal string.
 */
export async function hashEnrollmentGrantToken(token: string): Promise<string> {
	if (!token || token.trim() === "") {
		throw new Error("Enrollment grant token cannot be empty");
	}

	const encoded = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(digest));

	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IssueEnrollmentGrantParams {
	db: Database;
	userId: string;
	purpose: EnrollmentGrantPurpose;
	recoveryCodeId?: string | null | undefined;
}

/**
 * Issues a new short-lived enrollment grant.
 * Revokes any previously active enrollment grant for this user and purpose.
 * Returns the raw one-time grant token to the caller.
 */
export async function issueEnrollmentGrant({
	db,
	userId,
	purpose,
	recoveryCodeId,
}: IssueEnrollmentGrantParams) {
	const now = new Date();

	// 1. Revoke any existing active grant for the same user and purpose
	await db
		.update(authEnrollmentGrants)
		.set({ revokedAt: now })
		.where(
			and(
				eq(authEnrollmentGrants.userId, userId),
				eq(authEnrollmentGrants.purpose, purpose),
				isNull(authEnrollmentGrants.consumedAt),
				isNull(authEnrollmentGrants.revokedAt),
			),
		);

	// 2. Generate raw token and hash
	const rawToken = generateEnrollmentGrantToken();
	const tokenHash = await hashEnrollmentGrantToken(rawToken);

	const expiresAt = new Date(
		now.getTime() + AUTH_ENROLLMENT_GRANT_TTL_SECONDS * 1000,
	);

	const [created] = await db
		.insert(authEnrollmentGrants)
		.values({
			userId,
			purpose,
			tokenHash,
			recoveryCodeId: purpose === "RECOVERY" ? (recoveryCodeId ?? null) : null,
			createdAt: now,
			expiresAt,
		})
		.returning();

	if (!created) {
		throw new Error("Failed to create enrollment grant row");
	}

	return {
		token: rawToken,
		grant: created,
	};
}

export interface ConsumeActiveEnrollmentGrantParams {
	db: Database;
	userId: string;
	purpose: EnrollmentGrantPurpose;
	token: string;
}

/**
 * Atomically consumes an active enrollment grant.
 * Validates userId, purpose, tokenHash, unconsumed, unrevoked, and unexpired.
 * Sets consumedAt = now().
 * Returns the grant row if successful, or null if invalid/expired/already used.
 */
export async function consumeActiveEnrollmentGrant({
	db,
	userId,
	purpose,
	token,
}: ConsumeActiveEnrollmentGrantParams) {
	if (!token || token.trim() === "") {
		return null;
	}

	const tokenHash = await hashEnrollmentGrantToken(token);
	const now = new Date();

	const [consumed] = await db
		.update(authEnrollmentGrants)
		.set({ consumedAt: now })
		.where(
			and(
				eq(authEnrollmentGrants.userId, userId),
				eq(authEnrollmentGrants.purpose, purpose),
				eq(authEnrollmentGrants.tokenHash, tokenHash),
				isNull(authEnrollmentGrants.consumedAt),
				isNull(authEnrollmentGrants.revokedAt),
				gt(authEnrollmentGrants.expiresAt, now),
			),
		)
		.returning();

	return consumed ?? null;
}
