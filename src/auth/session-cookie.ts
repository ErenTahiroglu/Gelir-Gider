import { SESSION_ABSOLUTE_TTL_SECONDS, SESSION_COOKIE_NAME } from "./sessions";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Builds the Set-Cookie header string for establishing a session.
 * Enforces:
 * - __Host- prefix
 * - Path=/
 * - Secure
 * - HttpOnly
 * - SameSite=Strict
 * - Max-Age=2592000 (30 days)
 * - NO Domain attribute
 *
 * Validates token to be valid base64url without unsafe characters.
 */
export function buildSessionCookie(token: string): string {
	if (!token || token.trim() === "") {
		throw new Error("Session token cannot be empty");
	}

	if (!BASE64URL_PATTERN.test(token)) {
		throw new Error(
			"Invalid characters in session token for cookie serialization",
		);
	}

	return `${SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_ABSOLUTE_TTL_SECONDS}`;
}

/**
 * Builds the Set-Cookie header string for clearing a session on logout.
 * Retains identical security flags (__Host-, Path=/, Secure, HttpOnly, SameSite=Strict, NO Domain)
 * and sets Max-Age=0.
 */
export function buildClearSessionCookie(): string {
	return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
