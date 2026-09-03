import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { buildClearSessionCookie } from "../auth/session-cookie";
import {
	findActiveSessionByToken,
	SESSION_COOKIE_NAME,
	touchSessionActivity,
} from "../auth/sessions";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase, type Database } from "../db/client";
import { users } from "../db/schema/auth";

export interface AuthenticatedRequestContext {
	userId: string;
	displayName: string;
	sessionId: string;
}

export interface AuthVariables {
	auth: AuthenticatedRequestContext;
}

export interface ResolveAuthenticatedSessionParams {
	db: Database;
	token: string;
}

export type ResolveSessionResult =
	| { authenticated: true; context: AuthenticatedRequestContext }
	| { authenticated: false; reason: "INVALID_SESSION" };

/**
 * Validates and resolves an active session token.
 * Performs race-safe activity touching and user state invariant validation.
 * Never exposes raw tokens or hashes in the returned context.
 */
export async function resolveAuthenticatedSession({
	db,
	token,
}: ResolveAuthenticatedSessionParams): Promise<ResolveSessionResult> {
	if (!token || token.trim() === "") {
		return { authenticated: false, reason: "INVALID_SESSION" };
	}

	const session = await findActiveSessionByToken({
		db,
		token,
	});

	if (!session) {
		return { authenticated: false, reason: "INVALID_SESSION" };
	}

	// Touch session activity atomically
	const touched = await touchSessionActivity({
		db,
		sessionId: session.id,
	});

	if (!touched) {
		// Re-verify if session is still active (handles recent activity throttle vs concurrent revocation/expiry)
		const recheck = await findActiveSessionByToken({
			db,
			token,
		});
		if (!recheck) {
			return { authenticated: false, reason: "INVALID_SESSION" };
		}
	}

	// Resolve user row and verify user is initialized
	const [user] = await db
		.select({
			id: users.id,
			displayName: users.displayName,
			authInitializedAt: users.authInitializedAt,
		})
		.from(users)
		.where(eq(users.id, session.userId))
		.limit(1);

	if (!user || user.authInitializedAt === null) {
		return { authenticated: false, reason: "INVALID_SESSION" };
	}

	return {
		authenticated: true,
		context: {
			userId: user.id,
			displayName: user.displayName,
			sessionId: session.id,
		},
	};
}

/**
 * Reusable fail-closed middleware for protecting authenticated routes.
 * Sets c.get("auth") on success.
 * If cookie is missing -> 401 UNAUTHENTICATED (no cookie clear).
 * If cookie is invalid -> 401 UNAUTHENTICATED + clear cookie.
 * If database/operational error -> 500 INTERNAL_ERROR (does NOT clear cookie).
 */
export const requireAuthenticatedSession: MiddlewareHandler<{
	Bindings: AppEnv;
	Variables: AuthVariables;
}> = async (c, next) => {
	const cookieToken = getCookie(c, SESSION_COOKIE_NAME);

	if (!cookieToken || cookieToken.trim() === "") {
		return c.json(
			{
				error: {
					code: "UNAUTHENTICATED",
					message: "Authentication required",
				},
			},
			401,
		);
	}

	let result: ResolveSessionResult;
	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		result = await resolveAuthenticatedSession({
			db,
			token: cookieToken,
		});
	} catch {
		// Operational / DB error: Fail-closed with 500 without clearing browser cookie
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Internal server error",
				},
			},
			500,
		);
	}

	if (!result.authenticated) {
		c.header("Set-Cookie", buildClearSessionCookie());
		return c.json(
			{
				error: {
					code: "UNAUTHENTICATED",
					message: "Authentication required",
				},
			},
			401,
		);
	}

	c.set("auth", result.context);
	return next();
};
