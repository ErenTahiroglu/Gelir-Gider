import type { RateLimitBinding } from "../config/env";

/**
 * SECURITY MODEL & HARD ASSUMPTIONS:
 *
 * 1. AUTH_RATE_LIMITER is a BEST-EFFORT edge abuse/resource shield.
 * 2. It is NOT an authoritative authentication primitive.
 * 3. It is NOT an account-lockout state machine.
 * 4. Rate limiting counters in Cloudflare Workers are location-local and eventually consistent.
 * 5. Primary security guarantees (high-entropy tokens, WebAuthn cryptographic verification,
 *    transaction-safe single-use challenges and grants) remain fully intact regardless of
 *    rate-limiter state.
 * 6. IP address (CF-Connecting-IP) is used solely as an actor key for this single-user private application
 *    to provide edge abuse resistance, NOT as a proof of identity or authorization.
 */

export const AUTH_RATE_LIMIT_PERIOD_SECONDS = 60;
export const AUTH_RATE_LIMIT_REQUESTS = 20;
export const RATE_LIMIT_KEY_PREFIX = "gelir-gider:auth:v1:";

export const RATE_LIMITED_AUTH_PATHS = new Set([
	"/auth/bootstrap/authorize",
	"/auth/recovery/authorize",
	"/auth/passkey/enrollment/options",
	"/auth/passkey/enrollment/verify",
	"/auth/passkey/authentication/options",
	"/auth/passkey/authentication/verify",
]);

/**
 * Builds a deterministic, namespace-safe key for Cloudflare Rate Limiting.
 * Never includes secrets, tokens, hashes, or cookie data.
 */
export function buildRateLimitKey(path: string, clientIp: string): string {
	const sanitizedPath = path.trim().toLowerCase();
	const sanitizedIp = clientIp.trim().toLowerCase() || "unknown";
	return `${RATE_LIMIT_KEY_PREFIX}${sanitizedPath}:${sanitizedIp}`;
}

export type RateLimitCheckResult =
	| { allowed: true }
	| { allowed: false; unavailable: false }
	| { allowed: false; unavailable: true };

/**
 * Executes rate-limit check against the Cloudflare Workers Rate Limiting binding.
 * Fail-closed: If binding is missing or limit() throws, returns unavailable: true.
 */
export async function checkAuthRateLimit(
	limiter: RateLimitBinding | undefined,
	path: string,
	clientIp: string,
): Promise<RateLimitCheckResult> {
	if (!limiter || typeof limiter.limit !== "function") {
		return { allowed: false, unavailable: true };
	}

	const key = buildRateLimitKey(path, clientIp);

	try {
		const result = await limiter.limit({ key });
		if (result && result.success === true) {
			return { allowed: true };
		}
		return { allowed: false, unavailable: false };
	} catch {
		// Fail-closed on binding execution error
		return { allowed: false, unavailable: true };
	}
}
