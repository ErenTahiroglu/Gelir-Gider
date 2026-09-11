import type { MiddlewareHandler } from "hono";
import { type AppEnv, getWebAuthnConfig } from "../config/env";

/**
 * PRODUCT HTTP TRANSPORT HELPERS (Checkpoint 7B.0).
 *
 * Transport-only utilities shared by the authenticated product route families.
 * NOTHING here contains financial or business logic: it validates the shape of
 * an HTTP request, parses transport primitives, builds the sanitized error
 * envelope, and enforces the locked same-origin mutation policy. Domain
 * decisions (money maths, idempotency semantics, OCC, eligibility, ordering)
 * stay entirely in the existing domain services.
 */

// --- structural request view (works with any Hono context) --------------

export interface TransportRequest {
	header(name: string): string | undefined;
	json(): Promise<unknown>;
	method: string;
}

export interface TransportContext {
	req: TransportRequest;
}

// --- primitive validators ---------------------------------------------

export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict canonical UTC instant: `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export const CANONICAL_INSTANT_RE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const HEX64_RE = /^[0-9a-f]{64}$/;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Parses a canonical UTC instant string. Rejects a non-string, a non-canonical
 * representation (missing millis, an offset other than `Z`, a space separator),
 * and an impossible date that does not round-trip. Never substitutes the
 * current clock -- a retry-sensitive `occurredAt` must be supplied by the
 * client verbatim.
 */
export function parseCanonicalInstant(value: unknown): Date | null {
	if (typeof value !== "string" || !CANONICAL_INSTANT_RE.test(value)) {
		return null;
	}
	const d = new Date(value);
	if (Number.isNaN(d.getTime()) || d.toISOString() !== value) return null;
	return d;
}

// --- JSON body handling ---------------------------------------------

export function isJsonContentType(value: string | undefined): boolean {
	if (!value) return false;
	return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export type JsonObjectResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false };

/**
 * Requires `Content-Type: application/json` and a top-level JSON object (never
 * an array, primitive, or null). The parsed object is returned untouched; key
 * allow-listing is the caller's responsibility via {@link hasOnlyKeys}.
 */
export async function readJsonObject(
	c: TransportContext,
): Promise<JsonObjectResult> {
	if (!isJsonContentType(c.req.header("content-type"))) return { ok: false };
	let parsed: unknown;
	try {
		parsed = await c.req.json();
	} catch {
		return { ok: false };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

/** True when `obj` has no key outside `allowed` (closed-body enforcement). */
export function hasOnlyKeys(
	obj: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(obj).every((k) => allowed.includes(k));
}

// --- Idempotency-Key ------------------------------------------------

export type IdempotencyKeyResult = { ok: true; key: string } | { ok: false };

/**
 * Reads the `Idempotency-Key` request header verbatim (never a body field, a
 * query param, or a server-generated value). Enforces the canonical domain
 * constraint shared by every Budget V2 idempotency column
 * (`btrim(key) = key AND length BETWEEN 1 AND 128`). The transport layer trims
 * surrounding whitespace from header values before this runs, so a padded key
 * is impossible here in practice; the explicit check keeps the contract
 * self-evident.
 */
export function readIdempotencyKey(c: TransportContext): IdempotencyKeyResult {
	const raw = c.req.header("Idempotency-Key");
	if (typeof raw !== "string") return { ok: false };
	if (raw !== raw.trim()) return { ok: false };
	if (raw.length < 1 || raw.length > 128) return { ok: false };
	return { ok: true, key: raw };
}

// --- bounded pagination limit -------------------------------------

export interface BoundedLimitOptions {
	defaultLimit: number;
	maxLimit: number;
}

export type BoundedLimitResult = { ok: true; limit: number } | { ok: false };

/**
 * Parses an optional `?limit=` query value. Absent -> `defaultLimit`. Present
 * must be a bare non-negative integer literal in `[1, maxLimit]` -- no `"1"`
 * coercion leniency beyond digit parsing, no float, no whitespace.
 */
export function parseBoundedLimit(
	raw: string | undefined,
	opts: BoundedLimitOptions,
): BoundedLimitResult {
	if (raw === undefined) return { ok: true, limit: opts.defaultLimit };
	if (!/^[0-9]+$/.test(raw)) return { ok: false };
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < 1 || n > opts.maxLimit) return { ok: false };
	return { ok: true, limit: n };
}

// --- sanitized error envelope ------------------------------------

export interface ErrorEnvelope {
	error: { code: string; message: string };
}

/**
 * Safe, stable, client-facing messages. Only codes present here may be
 * returned to a client; anything else collapses to `INTERNAL_ERROR`. Raw
 * domain messages, SQL, constraint names, PostgreSQL codes, stack traces,
 * secrets, and integrity internals are never surfaced.
 */
export const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
	BUDGET_INVALID_INPUT: "Invalid request",
	BUDGET_CHECKPOINT_NOT_FOUND: "Checkpoint not found",
	BUDGET_RECOMMENDATION_NOT_FOUND: "Recommendation not found",
	BUDGET_RECOMMENDATION_NOT_ACTIVE: "Recommendation is not active",
	BUDGET_RECOMMENDATION_STALE: "Recommendation has changed since it was shown",
	BUDGET_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different request",
	BUDGET_REVISION_CONFLICT: "Feedback revision is stale",
	TRANSACTION_INVALID_INPUT: "Invalid transaction request",
	TRANSACTION_NOT_FOUND: "Transaction not found",
	TRANSACTION_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different transaction command",
	TRANSACTION_REVISION_CONFLICT: "Transaction revision is stale",
	TRANSACTION_ALREADY_VOIDED: "Transaction has already been voided",
	TRANSACTION_SOURCE_CONFLICT: "Transaction source conflict",
	LEDGER_INVALID_INPUT: "Invalid ledger request",
	LEDGER_ACCOUNT_NOT_FOUND: "Ledger account not found",
	LEDGER_ACCOUNT_ARCHIVED: "Ledger account is archived",
	LEDGER_UNBALANCED: "Ledger entry is not balanced",
	LEDGER_IDEMPOTENCY_CONFLICT: "Ledger command idempotency conflict",
	LEDGER_CURRENCY_MISMATCH: "Ledger currency mismatch",
	LEDGER_ENTRY_NOT_FOUND: "Ledger entry not found",
	LEDGER_ALREADY_REVERSED: "Ledger entry has already been reversed",
	INVALID_ORIGIN: "Invalid request origin",
	UNAUTHENTICATED: "Authentication required",
	NOT_FOUND: "Route not found",
	INTERNAL_ERROR: "Internal server error",
};

export function errorEnvelope(code: string): ErrorEnvelope {
	return {
		error: {
			code,
			message: PUBLIC_ERROR_MESSAGES[code] ?? "Internal server error",
		},
	};
}

// --- same-origin mutation guard --------------------------------

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Locked same-origin architecture: the frontend and the API are served from
 * ONE Cloudflare Worker on ONE origin. This middleware requires every
 * cookie-authenticated unsafe-method request (`POST`/`PUT`/`PATCH`/`DELETE`)
 * to carry an `Origin` header exactly equal to the configured application
 * origin (`WEBAUTHN_ORIGIN`) -- the same authoritative value the auth router
 * already enforces for its own POST routes. Safe methods are untouched.
 *
 * This is a defence-in-depth companion to the session cookie's
 * `SameSite=Strict` (which already stops cross-site sends in modern browsers);
 * it is NOT a CORS mechanism and adds no `Access-Control-*` headers. The app
 * origin is read from config, never hard-coded, so local development against
 * `http://localhost:8787` stays testable.
 */
export function sameOriginMutationGuard(): MiddlewareHandler<{
	Bindings: AppEnv;
}> {
	return async (c, next) => {
		if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();

		let expectedOrigin: string;
		try {
			expectedOrigin = getWebAuthnConfig(c.env).origin;
		} catch {
			return c.json(errorEnvelope("INTERNAL_ERROR"), 500);
		}

		const origin = c.req.header("origin");
		if (!origin || origin.trim() !== expectedOrigin) {
			return c.json(errorEnvelope("INVALID_ORIGIN"), 403);
		}
		return next();
	};
}
