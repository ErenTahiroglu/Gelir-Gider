import type { Context, MiddlewareHandler, Next } from "hono";
import type { AppEnv } from "../config/env";

export const REQUEST_ID_CONTEXT_KEY = "requestId";

export interface RequestIdVariables {
	requestId: string;
}

/**
 * Generates a FRESH request ID for every request via `crypto.randomUUID()`
 * and stores it on the Hono context. Deliberately never reads/trusts any
 * inbound `X-Request-ID`-style header from the client -- a client-supplied
 * value must never be treated as an authoritative trace identifier.
 */
export const requestIdMiddleware: MiddlewareHandler<{
	Bindings: AppEnv;
	Variables: RequestIdVariables;
}> = async (
	c: Context<{ Bindings: AppEnv; Variables: RequestIdVariables }>,
	next: Next,
) => {
	const requestId = crypto.randomUUID();
	c.set(REQUEST_ID_CONTEXT_KEY, requestId);
	await next();
	c.header("X-Request-ID", requestId);
};

/**
 * Global HTTP security headers. Deliberately does NOT set
 * `Strict-Transport-Security` in this phase -- unconditionally forcing HSTS
 * could break local dev over plain HTTP, and there is not yet a
 * production-HTTPS-only deployment flag to gate it on. TODO: add HSTS once
 * such a flag exists.
 *
 * Must not interfere with `/auth/*`'s own `Set-Cookie`/`Cache-Control`
 * handling -- this middleware never touches `Set-Cookie`, and setting
 * `Cache-Control: no-store` here is consistent with (not overriding) the
 * stricter `no-store` + `Pragma: no-cache` the auth router already sets on
 * its own routes.
 */
export const securityHeadersMiddleware: MiddlewareHandler<{
	Bindings: AppEnv;
}> = async (c: Context<{ Bindings: AppEnv }>, next: Next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Frame-Options", "DENY");
	c.header(
		"Permissions-Policy",
		"geolocation=(), camera=(), microphone=(), payment=()",
	);
	c.header("Cache-Control", "no-store");
	c.header(
		"Content-Security-Policy",
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	);
};
