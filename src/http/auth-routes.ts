import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import {
	AuthError,
	authorizeBootstrapAndIssueGrant,
	authorizeRecoveryAndIssueGrant,
} from "../auth/bootstrap";
import {
	buildClearSessionCookie,
	buildSessionCookie,
} from "../auth/session-cookie";
import {
	createSession,
	findActiveSessionByToken,
	revokeSessionByToken,
	SESSION_COOKIE_NAME,
	touchSessionActivity,
} from "../auth/sessions";
import {
	beginAuthorizedPasskeyEnrollment,
	completeAuthorizedPasskeyEnrollment,
	verifyAuthenticationForUser,
	WebAuthnServiceError,
} from "../auth/verification";
import { generateAuthenticationOptionsForUser } from "../auth/webauthn";
import {
	type AppEnv,
	getBootstrapTokenHash,
	getDatabaseUrl,
	getWebAuthnConfig,
} from "../config/env";
import { createDatabase } from "../db/client";
import {
	authRecoveryCodes,
	users,
	webauthnCredentials,
} from "../db/schema/auth";

export const authRouter = new Hono<{ Bindings: AppEnv }>();

const BODY_LIMIT_BYTES = 256 * 1024; // 256 KiB

// Strict JSON Media Type Parser
function isJsonContentType(value: string | undefined): boolean {
	if (!value) return false;

	const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();

	return mediaType === "application/json";
}

// Endpoints that explicitly require a JSON request body
const JSON_BODY_PATHS = new Set([
	"/auth/bootstrap/authorize",
	"/auth/recovery/authorize",
	"/auth/passkey/enrollment/options",
	"/auth/passkey/enrollment/verify",
	"/auth/passkey/authentication/verify",
]);

// Helper to create sanitized error response
function errorResponse(code: string, message: string, status: number) {
	return {
		body: {
			error: {
				code,
				message,
			},
		},
		status,
	};
}

// 1. Global Cache-Control header for all /auth/* routes (set before downstream execution)
authRouter.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Pragma", "no-cache");
	await next();
});

// 2. Same-Origin, Content-Type, and Body Limit enforcement for all POST routes
authRouter.post("*", async (c, next) => {
	// Origin check: must run first before content-type, body parsing, auth logic
	const origin = c.req.header("origin");
	let expectedOrigin: string;
	try {
		expectedOrigin = getWebAuthnConfig(c.env).origin;
	} catch {
		const err = errorResponse("INTERNAL_ERROR", "Internal server error", 500);
		return c.json(err.body, err.status as 500);
	}

	if (!origin || origin.trim() !== expectedOrigin) {
		const err = errorResponse("INVALID_ORIGIN", "Invalid request origin", 403);
		return c.json(err.body, err.status as 403);
	}

	// Content-Type check: strictly enforced only on endpoints expecting JSON body
	if (JSON_BODY_PATHS.has(c.req.path)) {
		const contentType = c.req.header("content-type");
		if (!isJsonContentType(contentType)) {
			const err = errorResponse(
				"UNSUPPORTED_MEDIA_TYPE",
				"Content-Type must be application/json",
				415,
			);
			return c.json(err.body, err.status as 415);
		}
	}

	return next();
});

// Apply Hono bodyLimit to all POST routes (256 KiB)
authRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => {
			const err = errorResponse(
				"REQUEST_TOO_LARGE",
				"Request body is too large",
				413,
			);
			return c.json(err.body, err.status as 413);
		},
	}),
);

// Centralized error handler helper for auth routes
function handleAuthError(c: Context<{ Bindings: AppEnv }>, err: unknown) {
	if (err instanceof AuthError) {
		switch (err.code) {
			case "BOOTSTRAP_INVALID":
			case "RECOVERY_CODE_INVALID":
			case "ENROLLMENT_GRANT_INVALID":
				return c.json({ error: { code: err.code, message: err.message } }, 403);
			case "BOOTSTRAP_ALREADY_COMPLETED":
			case "RECOVERY_NOT_INITIALIZED":
				return c.json({ error: { code: err.code, message: err.message } }, 409);
			case "INVALID_DISPLAY_NAME":
				return c.json({ error: { code: err.code, message: err.message } }, 400);
			default:
				return c.json({ error: { code: err.code, message: err.message } }, 400);
		}
	}

	if (err instanceof WebAuthnServiceError) {
		switch (err.code) {
			case "INVALID_DEVICE_NAME":
				return c.json({ error: { code: err.code, message: err.message } }, 400);
			case "ENROLLMENT_GRANT_INVALID":
			case "RECOVERY_SOURCE_INVALID":
			case "WEBAUTHN_CHALLENGE_INVALID":
			case "WEBAUTHN_CREDENTIAL_NOT_FOUND":
			case "WEBAUTHN_CREDENTIAL_STATE_CHANGED":
				return c.json({ error: { code: err.code, message: err.message } }, 403);
			case "ENROLLMENT_GRANT_EXPIRED":
				return c.json({ error: { code: err.code, message: err.message } }, 400);
			case "BOOTSTRAP_ALREADY_COMPLETED":
			case "RECOVERY_NOT_INITIALIZED":
			case "CREDENTIAL_ALREADY_REGISTERED":
				return c.json({ error: { code: err.code, message: err.message } }, 409);
			case "WEBAUTHN_REGISTRATION_FAILED":
			case "WEBAUTHN_AUTHENTICATION_FAILED":
				return c.json({ error: { code: err.code, message: err.message } }, 400);
			default:
				return c.json({ error: { code: err.code, message: err.message } }, 400);
		}
	}

	// Unexpected errors -> generic 500
	return c.json(
		{ error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
		500,
	);
}

// Helper to safely parse JSON body
async function parseJsonBody<T>(
	c: Context<{ Bindings: AppEnv }>,
): Promise<T | null> {
	try {
		return await c.req.json();
	} catch {
		return null;
	}
}

// --- ROUTES ---

// GET /auth/status
authRouter.get("/status", async (c) => {
	try {
		const dbUrl = getDatabaseUrl(c.env);
		const db = createDatabase(dbUrl);

		const [user] = await db.select().from(users).limit(1);

		if (!user) {
			return c.json({ state: "UNINITIALIZED" });
		}

		if (user.authInitializedAt === null) {
			// Check invariants: active credentials must be 0, active recovery code must be 0
			const [activeCreds] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(webauthnCredentials)
				.where(
					and(
						eq(webauthnCredentials.userId, user.id),
						isNull(webauthnCredentials.revokedAt),
					),
				);

			const [activeRec] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(authRecoveryCodes)
				.where(
					and(
						eq(authRecoveryCodes.userId, user.id),
						isNull(authRecoveryCodes.consumedAt),
						isNull(authRecoveryCodes.revokedAt),
					),
				);

			if ((activeCreds?.count ?? 0) !== 0 || (activeRec?.count ?? 0) !== 0) {
				return c.json(
					{
						error: {
							code: "AUTH_STATE_INCONSISTENT",
							message: "Authentication state is inconsistent",
						},
					},
					503,
				);
			}

			return c.json({ state: "UNINITIALIZED" });
		}

		// Initialized state invariants: active credentials >= 1, active recovery code === 1
		const [activeCreds] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(webauthnCredentials)
			.where(
				and(
					eq(webauthnCredentials.userId, user.id),
					isNull(webauthnCredentials.revokedAt),
				),
			);

		const [activeRec] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(authRecoveryCodes)
			.where(
				and(
					eq(authRecoveryCodes.userId, user.id),
					isNull(authRecoveryCodes.consumedAt),
					isNull(authRecoveryCodes.revokedAt),
				),
			);

		if ((activeCreds?.count ?? 0) < 1 || (activeRec?.count ?? 0) !== 1) {
			return c.json(
				{
					error: {
						code: "AUTH_STATE_INCONSISTENT",
						message: "Authentication state is inconsistent",
					},
				},
				503,
			);
		}

		return c.json({ state: "INITIALIZED" });
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/bootstrap/authorize
authRouter.post("/bootstrap/authorize", async (c) => {
	const body = await parseJsonBody<{
		bootstrapToken?: string;
		displayName?: string;
	}>(c);
	if (
		!body ||
		typeof body.bootstrapToken !== "string" ||
		typeof body.displayName !== "string"
	) {
		return c.json(
			{ error: { code: "INVALID_REQUEST", message: "Invalid request body" } },
			400,
		);
	}

	if (body.bootstrapToken.trim() === "" || body.displayName.trim() === "") {
		return c.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message: "Fields cannot be whitespace only",
				},
			},
			400,
		);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const expectedHash = getBootstrapTokenHash(c.env);

		const result = await authorizeBootstrapAndIssueGrant({
			db,
			bootstrapToken: body.bootstrapToken,
			expectedBootstrapTokenHash: expectedHash,
			displayName: body.displayName,
		});

		return c.json({ enrollmentGrantToken: result.enrollmentGrant });
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/recovery/authorize
authRouter.post("/recovery/authorize", async (c) => {
	const body = await parseJsonBody<{ recoveryCode?: string }>(c);
	if (!body || typeof body.recoveryCode !== "string") {
		return c.json(
			{ error: { code: "INVALID_REQUEST", message: "Invalid request body" } },
			400,
		);
	}

	if (body.recoveryCode.trim() === "") {
		return c.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message: "Recovery code cannot be whitespace only",
				},
			},
			400,
		);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));

		const result = await authorizeRecoveryAndIssueGrant({
			db,
			recoveryCode: body.recoveryCode,
		});

		return c.json({ enrollmentGrantToken: result.enrollmentGrant });
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/passkey/enrollment/options
authRouter.post("/passkey/enrollment/options", async (c) => {
	const body = await parseJsonBody<{ enrollmentGrantToken?: string }>(c);
	if (
		!body ||
		typeof body.enrollmentGrantToken !== "string" ||
		body.enrollmentGrantToken.trim() === ""
	) {
		return c.json(
			{ error: { code: "INVALID_REQUEST", message: "Invalid request body" } },
			400,
		);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const config = getWebAuthnConfig(c.env);

		const options = await beginAuthorizedPasskeyEnrollment({
			db,
			config,
			enrollmentGrantToken: body.enrollmentGrantToken,
		});

		return c.json(options);
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/passkey/enrollment/verify
authRouter.post("/passkey/enrollment/verify", async (c) => {
	const body = await parseJsonBody<{
		response?: RegistrationResponseJSON;
		deviceName?: string;
	}>(c);
	if (
		!body?.response ||
		typeof body.deviceName !== "string" ||
		body.deviceName.trim() === ""
	) {
		return c.json(
			{ error: { code: "INVALID_REQUEST", message: "Invalid request body" } },
			400,
		);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const config = getWebAuthnConfig(c.env);

		const result = await completeAuthorizedPasskeyEnrollment({
			db,
			config,
			response: body.response,
			deviceName: body.deviceName,
		});

		// Enrollment succeeded! Now attempt to establish a session.
		try {
			const { token: sessionToken } = await createSession({
				db,
				userId: result.user.id,
			});

			c.header("Set-Cookie", buildSessionCookie(sessionToken));

			return c.json({
				verified: true,
				purpose: result.purpose,
				credential: {
					deviceName: result.credential.deviceName,
				},
				recoveryCode: result.recoveryCode,
				authenticated: true,
			});
		} catch {
			// CRITICAL REQUIREMENT 22: If createSession throws AFTER enrollment finalization,
			// DO NOT throw generic 500! Return the recovery code with authenticated: false and a warning.
			return c.json({
				verified: true,
				purpose: result.purpose,
				credential: {
					deviceName: result.credential.deviceName,
				},
				recoveryCode: result.recoveryCode,
				authenticated: false,
				warning: {
					code: "SESSION_ESTABLISHMENT_FAILED",
					message:
						"Enrollment succeeded, but a session could not be established",
				},
			});
		}
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/passkey/authentication/options
authRouter.post("/passkey/authentication/options", async (c) => {
	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const config = getWebAuthnConfig(c.env);

		const [user] = await db.select().from(users).limit(1);

		if (!user || user.authInitializedAt === null) {
			return c.json(
				{
					error: {
						code: "AUTH_NOT_INITIALIZED",
						message: "Instance is not initialized",
					},
				},
				409,
			);
		}

		// Fetch active credentials
		const activeCredentials = await db
			.select({
				credentialId: webauthnCredentials.credentialId,
				transports: webauthnCredentials.transports,
				revokedAt: webauthnCredentials.revokedAt,
			})
			.from(webauthnCredentials)
			.where(
				and(
					eq(webauthnCredentials.userId, user.id),
					isNull(webauthnCredentials.revokedAt),
				),
			);

		if (activeCredentials.length === 0) {
			return c.json(
				{
					error: {
						code: "AUTH_STATE_INCONSISTENT",
						message: "No active credentials found for initialized user",
					},
				},
				503,
			);
		}

		const options = await generateAuthenticationOptionsForUser({
			db,
			config,
			user: { id: user.id },
			existingCredentials: activeCredentials.map((cred) => ({
				credentialId: cred.credentialId,
				transports: cred.transports as AuthenticatorTransportFuture[] | null,
				revokedAt: cred.revokedAt,
			})),
		});

		return c.json(options);
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/passkey/authentication/verify
authRouter.post("/passkey/authentication/verify", async (c) => {
	const body = await parseJsonBody<{
		response?: AuthenticationResponseJSON;
	}>(c);
	if (!body?.response) {
		return c.json(
			{ error: { code: "INVALID_REQUEST", message: "Invalid request body" } },
			400,
		);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const config = getWebAuthnConfig(c.env);

		const [user] = await db.select().from(users).limit(1);

		if (!user || user.authInitializedAt === null) {
			return c.json(
				{
					error: {
						code: "AUTH_NOT_INITIALIZED",
						message: "Instance is not initialized",
					},
				},
				409,
			);
		}

		await verifyAuthenticationForUser({
			db,
			config,
			user: { id: user.id },
			response: body.response,
		});

		// Create session
		try {
			const { token: sessionToken } = await createSession({
				db,
				userId: user.id,
			});

			c.header("Set-Cookie", buildSessionCookie(sessionToken));

			return c.json({
				authenticated: true,
				user: {
					displayName: user.displayName,
				},
			});
		} catch {
			return c.json(
				{
					error: {
						code: "SESSION_ESTABLISHMENT_FAILED",
						message: "Failed to establish session after authentication",
					},
				},
				503,
			);
		}
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// GET /auth/session
authRouter.get("/session", async (c) => {
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

	try {
		const db = createDatabase(getDatabaseUrl(c.env));

		const session = await findActiveSessionByToken({
			db,
			token: cookieToken,
		});

		if (!session) {
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

		// Touch activity
		const touched = await touchSessionActivity({
			db,
			sessionId: session.id,
		});

		if (!touched) {
			// Re-verify if session is still active (might have been throttled or invalidated)
			const recheck = await findActiveSessionByToken({
				db,
				token: cookieToken,
			});
			if (!recheck) {
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
		}

		// Resolve user
		const [user] = await db
			.select()
			.from(users)
			.where(eq(users.id, session.userId))
			.limit(1);

		if (!user || user.authInitializedAt === null) {
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

		return c.json({
			authenticated: true,
			user: {
				displayName: user.displayName,
			},
		});
	} catch (err) {
		return handleAuthError(c, err);
	}
});

// POST /auth/logout
authRouter.post("/logout", async (c) => {
	const cookieToken = getCookie(c, SESSION_COOKIE_NAME);

	if (cookieToken && cookieToken.trim() !== "") {
		try {
			const db = createDatabase(getDatabaseUrl(c.env));
			await revokeSessionByToken({
				db,
				token: cookieToken,
			});
		} catch {
			// Operational / DB failure -> FAIL-CLOSED: 503 and DO NOT clear cookie!
			return c.json(
				{
					error: {
						code: "SESSION_REVOCATION_FAILED",
						message: "Session could not be revoked",
					},
				},
				503,
			);
		}
	}

	c.header("Set-Cookie", buildClearSessionCookie());
	return c.body(null, 204);
});
