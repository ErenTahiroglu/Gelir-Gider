import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { webauthnChallenges } from "../db/schema/auth";

export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

export type WebAuthnPurpose = "REGISTRATION" | "AUTHENTICATION";

export interface CreateChallengeParams {
	db: Database;
	userId: string;
	purpose: WebAuthnPurpose;
	challenge: string;
}

export async function createChallenge({
	db,
	userId,
	purpose,
	challenge,
}: CreateChallengeParams) {
	const expiresAt = new Date(
		Date.now() + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
	);

	const [created] = await db
		.insert(webauthnChallenges)
		.values({
			userId,
			purpose,
			challenge,
			expiresAt,
		})
		.returning();

	return created;
}

export interface ConsumeActiveChallengeParams {
	db: Database;
	userId: string;
	purpose: WebAuthnPurpose;
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
