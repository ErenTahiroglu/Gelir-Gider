import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions } from "../db/schema/auth";

export const SESSION_TOKEN_BYTES = 32;
export const SESSION_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SESSION_IDLE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_TOUCH_INTERVAL_SECONDS = 15 * 60; // 15 minutes
export const SESSION_COOKIE_NAME = "__Host-gg_session";

/**
 * Generates a cryptographically secure opaque session token.
 * Uses Web Crypto getRandomValues to generate 32 random bytes,
 * encoded as unpadded base64url (43 characters, alphabet [A-Za-z0-9_-]).
 */
export function generateSessionToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES));

	// Standard base64url encoding without padding
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	const base64 = btoa(binary);

	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Computes the SHA-256 hash of a raw session token.
 * Returns a 64-character lowercase hexadecimal string.
 * Validates that token is not empty or whitespace.
 */
export async function hashSessionToken(token: string): Promise<string> {
	if (!token || token.trim() === "") {
		throw new Error("Session token cannot be empty");
	}

	const encoded = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(digest));

	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ActiveSessionRecord {
	id: string;
	userId: string;
	createdAt: Date;
	expiresAt: Date;
	lastSeenAt: Date | null;
}

export interface CreateSessionParams {
	db: Database;
	userId: string;
}

export async function createSession({ db, userId }: CreateSessionParams) {
	const rawToken = generateSessionToken();
	const tokenHash = await hashSessionToken(rawToken);

	const now = new Date();
	const expiresAt = new Date(
		now.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1000,
	);

	const [created] = await db
		.insert(sessions)
		.values({
			userId,
			tokenHash,
			expiresAt,
			lastSeenAt: now,
		})
		.returning({
			id: sessions.id,
			userId: sessions.userId,
			createdAt: sessions.createdAt,
			expiresAt: sessions.expiresAt,
			lastSeenAt: sessions.lastSeenAt,
			revokedAt: sessions.revokedAt,
		});

	if (!created) {
		throw new Error("Failed to create session row");
	}

	return {
		token: rawToken,
		session: created,
	};
}

export interface FindActiveSessionParams {
	db: Database;
	token: string;
}

export async function findActiveSessionByToken({
	db,
	token,
}: FindActiveSessionParams): Promise<ActiveSessionRecord | null> {
	if (!token || token.trim() === "") {
		return null;
	}

	const tokenHash = await hashSessionToken(token);
	const now = new Date();
	const idleThreshold = new Date(
		now.getTime() - SESSION_IDLE_TTL_SECONDS * 1000,
	);

	// Condition: revoked_at IS NULL AND expires_at > now AND COALESCE(last_seen_at, created_at) > idleThreshold
	const [record] = await db
		.select({
			id: sessions.id,
			userId: sessions.userId,
			createdAt: sessions.createdAt,
			expiresAt: sessions.expiresAt,
			lastSeenAt: sessions.lastSeenAt,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.tokenHash, tokenHash),
				isNull(sessions.revokedAt),
				gt(sessions.expiresAt, now),
				gt(
					sql`COALESCE(${sessions.lastSeenAt}, ${sessions.createdAt})`,
					idleThreshold,
				),
			),
		)
		.limit(1);

	return record ?? null;
}

export interface TouchSessionActivityParams {
	db: Database;
	sessionId: string;
}

/**
 * Throttled activity update: executes a single atomic UPDATE statement.
 * Does NOT accept caller-provided lastSeenAt; throttling and validity decisions
 * are made entirely within the database transaction/statement.
 *
 * Requirements enforced atomically in WHERE clause:
 * - id = :sessionId
 * - revoked_at IS NULL
 * - expires_at > now
 * - COALESCE(last_seen_at, created_at) > idleThreshold (prevents idle revival!)
 * - (last_seen_at IS NULL OR last_seen_at <= touchThreshold)
 *
 * Does NOT extend expires_at (absolute TTL remains strict).
 */
export async function touchSessionActivity({
	db,
	sessionId,
}: TouchSessionActivityParams): Promise<boolean> {
	const now = new Date();
	const touchThreshold = new Date(
		now.getTime() - SESSION_TOUCH_INTERVAL_SECONDS * 1000,
	);
	const idleThreshold = new Date(
		now.getTime() - SESSION_IDLE_TTL_SECONDS * 1000,
	);

	const [updated] = await db
		.update(sessions)
		.set({
			lastSeenAt: now,
		})
		.where(
			and(
				eq(sessions.id, sessionId),
				isNull(sessions.revokedAt),
				gt(sessions.expiresAt, now),
				gt(
					sql`COALESCE(${sessions.lastSeenAt}, ${sessions.createdAt})`,
					idleThreshold,
				),
				or(
					isNull(sessions.lastSeenAt),
					lte(sessions.lastSeenAt, touchThreshold),
				),
			),
		)
		.returning({ id: sessions.id });

	return !!updated;
}

export interface RevokeSessionByTokenParams {
	db: Database;
	token: string;
}

/**
 * Revokes a session given its raw token.
 * Hash is matched, and revoked_at is set to now().
 * Idempotent: already revoked or unknown returns null safely without error.
 */
export async function revokeSessionByToken({
	db,
	token,
}: RevokeSessionByTokenParams): Promise<boolean> {
	if (!token || token.trim() === "") {
		return false;
	}

	const tokenHash = await hashSessionToken(token);
	const now = new Date();

	const [revoked] = await db
		.update(sessions)
		.set({
			revokedAt: now,
		})
		.where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });

	return !!revoked;
}

export interface RevokeAllSessionsForUserParams {
	db: Database;
	userId: string;
}

/**
 * Revokes all active sessions for a specific user.
 * Sets revoked_at to now() for all sessions where user_id = :userId and revoked_at IS NULL.
 */
export async function revokeAllSessionsForUser({
	db,
	userId,
}: RevokeAllSessionsForUserParams): Promise<number> {
	const now = new Date();

	const revokedList = await db
		.update(sessions)
		.set({
			revokedAt: now,
		})
		.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });

	return revokedList.length;
}
