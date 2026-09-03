import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { webauthnChallenges } from "../db/schema/auth";

export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

export interface CreateAuthenticationChallengeParams {
	db: Database;
	userId: string;
	challenge: string;
}

/**
 * Persists an AUTHENTICATION WebAuthn challenge row.
 * Enrollment grant is strictly null for authentication.
 * Generic registration challenge creation is prohibited here.
 */
export async function createAuthenticationChallenge({
	db,
	userId,
	challenge,
}: CreateAuthenticationChallengeParams) {
	const expiresAt = new Date(
		Date.now() + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
	);

	const [created] = await db
		.insert(webauthnChallenges)
		.values({
			userId,
			purpose: "AUTHENTICATION",
			challenge,
			enrollmentGrantId: null,
			expiresAt,
		})
		.returning();

	return created;
}

export interface ConsumeActiveChallengeParams {
	db: Database;
	userId: string;
	purpose: "REGISTRATION" | "AUTHENTICATION";
	challenge: string;
}

export async function consumeActiveChallenge({
	db,
	userId,
	purpose,
	challenge,
}: ConsumeActiveChallengeParams) {
	const now = new Date();

	const [consumed] = await db
		.update(webauthnChallenges)
		.set({ consumedAt: now })
		.where(
			and(
				eq(webauthnChallenges.userId, userId),
				eq(webauthnChallenges.purpose, purpose),
				eq(webauthnChallenges.challenge, challenge),
				isNull(webauthnChallenges.consumedAt),
				gt(webauthnChallenges.expiresAt, now),
			),
		)
		.returning();

	return consumed ?? null;
}

export interface ConsumeActiveRegistrationChallengeParams {
	db: Database;
	challenge: string;
}

/**
 * Atomically consumes an active REGISTRATION challenge by challenge string alone.
 * Requires purpose = 'REGISTRATION' and enrollment_grant_id IS NOT NULL.
 * Returns the consumed challenge record (which includes userId and enrollmentGrantId)
 * or null if invalid, expired, or already consumed.
 */
export async function consumeActiveRegistrationChallenge({
	db,
	challenge,
}: ConsumeActiveRegistrationChallengeParams) {
	if (!challenge || challenge.trim() === "") {
		return null;
	}

	const now = new Date();

	const [consumed] = await db
		.update(webauthnChallenges)
		.set({ consumedAt: now })
		.where(
			and(
				eq(webauthnChallenges.purpose, "REGISTRATION"),
				eq(webauthnChallenges.challenge, challenge),
				isNull(webauthnChallenges.consumedAt),
				gt(webauthnChallenges.expiresAt, now),
			),
		)
		.returning();

	return consumed ?? null;
}
