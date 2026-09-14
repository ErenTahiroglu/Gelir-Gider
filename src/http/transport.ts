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
	LEDGER_ACCOUNT_CODE_CONFLICT: "Ledger account code conflict",
	LEDGER_UNBALANCED: "Ledger entry is not balanced",
	LEDGER_IDEMPOTENCY_CONFLICT: "Ledger command idempotency conflict",
	LEDGER_CURRENCY_MISMATCH: "Ledger currency mismatch",
	LEDGER_ENTRY_NOT_FOUND: "Ledger entry not found",
	LEDGER_ALREADY_REVERSED: "Ledger entry has already been reversed",
	INCOME_INVALID_INPUT: "Invalid income request",
	INCOME_SOURCE_NOT_FOUND: "Income source not found",
	INCOME_SOURCE_ARCHIVED: "Income source is archived",
	INCOME_SOURCE_CODE_CONFLICT: "Income source code conflict",
	INCOME_LEDGER_ACCOUNT_INVALID: "Invalid ledger account for income source",
	INCOME_DESTINATION_ACCOUNT_INVALID:
		"Invalid destination account for income receipt",
	INCOME_RECEIPT_NOT_FOUND: "Income receipt not found",
	INCOME_RECEIPT_REVISION_CONFLICT: "Income receipt revision is stale",
	INCOME_RECEIPT_ALREADY_VOIDED: "Income receipt is already voided",
	INCOME_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different income request",
	INCOME_ENTITLEMENT_NOT_FOUND: "Income entitlement not found",
	INCOME_ENTITLEMENT_PERIOD_CONFLICT:
		"Income entitlement period already exists for source",
	INCOME_ENTITLEMENT_REVISION_CONFLICT: "Income entitlement revision is stale",
	INCOME_ENTITLEMENT_ALREADY_VOIDED: "Income entitlement is already voided",
	INCOME_SETTLEMENT_NOT_FOUND: "Income settlement not found",
	INCOME_SETTLEMENT_ALREADY_EXISTS:
		"Income settlement already exists for receipt",
	INCOME_SETTLEMENT_REVISION_CONFLICT: "Income settlement revision is stale",
	INCOME_SETTLEMENT_CONFLICT: "Income settlement allocation conflict",
	CREDIT_CARD_INVALID_INPUT: "Invalid credit card request",
	CREDIT_CARD_NOT_FOUND: "Credit card not found",
	CREDIT_CARD_NOT_ACTIVE: "Credit card is not active",
	CREDIT_CARD_CONFLICT: "Credit card code conflict",
	CREDIT_CARD_REVISION_CONFLICT: "Credit card revision is stale",
	CREDIT_CARD_STATEMENT_NOT_FOUND: "Credit card statement not found",
	CREDIT_CARD_STATEMENT_PERIOD_CONFLICT:
		"Credit card statement period conflict",
	CREDIT_CARD_STATEMENT_NOT_OPEN: "Credit card statement is not open",
	CREDIT_CARD_STATEMENT_REVISION_CONFLICT:
		"Credit card statement revision is stale",
	CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY:
		"Insufficient Midas liquidity for reserve",
	CREDIT_CARD_RESERVE_CONFLICT: "Credit card reserve conflict",
	CREDIT_CARD_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different request",
	CREDIT_CARD_INVALID_STATE: "Credit card invalid state transition",
	CREDIT_CARD_PURCHASE_NOT_FOUND: "Credit card purchase not found",
	CREDIT_CARD_PURCHASE_NOT_ACTIVE: "Credit card purchase is not active",
	CREDIT_CARD_OPENING_BALANCE_CONFLICT: "Credit card opening balance conflict",
	CREDIT_CARD_LEDGER_ACCOUNT_INVALID: "Invalid ledger account for credit card",
	CREDIT_CARD_LIABILITY_SHORTFALL: "Credit card liability shortfall",
	CREDIT_CARD_PAYMENT_NOT_FOUND: "Credit card statement payment not found",
	CREDIT_CARD_PAYMENT_CONFLICT: "Credit card statement payment conflict",
	CREDIT_CARD_STATEMENT_ALREADY_PAID: "Credit card statement is already paid",
	CREDIT_CARD_STATEMENT_NOT_PAID: "Credit card statement is not paid",
	CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY:
		"Cannot archive credit card with outstanding liability",
	CREDIT_CARD_LEDGER_LINK_NOT_FOUND: "Credit card ledger link not found",
	CREDIT_CARD_SYSTEM_ACCOUNT_NOT_FOUND: "Credit card system account not found",
	CREDIT_CARD_SPLIT_NOT_FOUND: "Credit card split not found",
	CREDIT_CARD_SPLIT_NOT_ACTIVE: "Credit card split is not active",
	CREDIT_CARD_SPLIT_REVISION_CONFLICT: "Credit card split revision is stale",
	CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT:
		"Credit card split idempotency conflict",
	CREDIT_CARD_SPLIT_CONFLICT: "Credit card split conflict",
	CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_FOUND:
		"Statement reconciliation not found",
	CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT:
		"Statement reconciliation conflict",
	CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_BALANCED:
		"Statement reconciliation is not balanced",
	CREDIT_CARD_STATEMENT_RECONCILIATION_IDEMPOTENCY_CONFLICT:
		"Statement reconciliation idempotency conflict",
	PEOPLE_INVALID_INPUT: "Invalid people request",
	PEOPLE_NOT_FOUND: "Person not found",
	PEOPLE_NOT_ACTIVE: "Person is not active",
	PEOPLE_REVISION_CONFLICT: "Person revision is stale",
	PEOPLE_OBLIGATION_NOT_FOUND: "Person obligation not found",
	PEOPLE_OBLIGATION_NOT_ACTIVE: "Person obligation is not active",
	PEOPLE_OBLIGATION_REVISION_CONFLICT: "Person obligation revision is stale",
	PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT:
		"Person obligation settlement conflict",
	PEOPLE_OBLIGATION_OVERSETTLEMENT: "Person obligation oversettlement error",
	PEOPLE_SETTLEMENT_NOT_FOUND: "Person settlement not found",
	PEOPLE_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different request",
	PEOPLE_LEDGER_ACCOUNT_INVALID: "Invalid ledger account for person",
	PEOPLE_INVALID_STATE: "Person invalid state transition",
	PEOPLE_OBLIGATION_SPLIT_MANAGED:
		"Obligation is managed by a credit card split and cannot be modified standalone",
	PEOPLE_PERSON_HAS_OUTSTANDING_BALANCE:
		"Cannot archive person with outstanding balance",
	PEOPLE_SETTLEMENT_NOT_ACTIVE: "Person settlement is not active",
	REWARD_INVALID_INPUT: "Invalid reward request",
	REWARD_ACCOUNT_NOT_FOUND: "Reward account not found",
	REWARD_ACCOUNT_NOT_ACTIVE: "Reward account is not active",
	REWARD_ACCOUNT_CONFLICT: "Reward account conflict",
	REWARD_ACCOUNT_REVISION_CONFLICT: "Reward account revision is stale",
	REWARD_EVENT_NOT_FOUND: "Reward event not found",
	REWARD_EVENT_NOT_ACTIVE: "Reward event is not active",
	REWARD_EVENT_CONFLICT: "Reward event conflict",
	REWARD_EVENT_REVISION_CONFLICT: "Reward event revision is stale",
	REWARD_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different request",
	REWARD_INSUFFICIENT_POINTS: "Insufficient reward point balance",
	REWARD_EVENT_EXTERNALLY_MANAGED:
		"Cannot manually void an externally managed reward event",
	REWARD_INVALID_STATE: "Reward state transition failed",
	CAMPAIGN_INVALID_INPUT: "Invalid campaign request",
	CAMPAIGN_INVALID_RULE: "Invalid campaign rule configuration",
	CAMPAIGN_NOT_FOUND: "Campaign not found",
	CAMPAIGN_PURCHASE_NOT_FOUND: "Campaign purchase not found",
	CAMPAIGN_NOT_ACTIVE: "Campaign is not active",
	CAMPAIGN_REVIEW_REQUIRED: "Campaign requires review before activation",
	CAMPAIGN_REVISION_CONFLICT: "Campaign revision is stale",
	CAMPAIGN_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different request",
	CAMPAIGN_PURCHASE_NEEDS_REVIEW: "Purchase needs review",
	CAMPAIGN_NOT_QUALIFIED: "Campaign is not qualified for reward credit",
	CAMPAIGN_REWARD_ALREADY_CREDITED: "Campaign reward has already been credited",
	CAMPAIGN_INVALID_STATE: "Campaign state transition failed",
	SHORT_TERM_GOAL_INVALID_INPUT: "Invalid short-term goal request",
	SHORT_TERM_GOAL_NOT_FOUND: "Short-term goal not found",
	SHORT_TERM_GOAL_NOT_ACTIVE: "Short-term goal is not active",
	SHORT_TERM_GOAL_NON_ZERO_BALANCE:
		"Cannot complete or cancel short-term goal with non-zero bucket balance",
	SHORT_TERM_GOAL_BALANCE_NOT_ZERO:
		"Cannot complete or cancel short-term goal with non-zero bucket balance",
	SHORT_TERM_GOAL_BUCKET_NOT_FOUND: "Goal Midas bucket not found",
	SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND: "Midas account not found for goal",
	SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED:
		"Funding would exceed short-term goal maximum budget",
	SHORT_TERM_GOAL_PRIORITY_COLLISION: "Goal priority collision",
	SHORT_TERM_GOAL_PRIORITY_MISMATCH: "Goal priority list mismatch",
	SHORT_TERM_GOAL_PRIORITY_CONFLICT: "Goal priority conflict",
	SHORT_TERM_GOAL_REVISION_CONFLICT: "Short-term goal revision is stale",
	SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE:
		"Insufficient unallocated Midas balance to fund goal",
	SHORT_TERM_GOAL_INSUFFICIENT_BALANCE:
		"Insufficient short-term goal bucket balance to release",
	SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different goal request",
	SHORT_TERM_GOAL_INVALID_STATE: "Short-term goal invalid state transition",
	MIDAS_INVALID_INPUT: "Invalid Midas request",
	MIDAS_ACCOUNT_NOT_FOUND: "Midas account not found",
	MIDAS_ACCOUNT_CONFLICT: "Midas account conflict",
	MIDAS_LEDGER_ACCOUNT_INVALID: "Invalid ledger account for Midas",
	MIDAS_BUCKET_NOT_FOUND: "Midas bucket not found",
	MIDAS_BUCKET_CONFLICT: "Midas bucket conflict",
	MIDAS_INSUFFICIENT_FREE_BALANCE: "Insufficient unallocated Midas balance",
	MIDAS_INSUFFICIENT_BUCKET_BALANCE: "Insufficient Midas bucket balance",
	MIDAS_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different Midas request",
	MIDAS_TRANSFER_NOT_FOUND: "Midas allocation transfer not found",
	MIDAS_TRANSFER_ALREADY_REVERSED:
		"Midas allocation transfer has already been reversed",
	MIDAS_BUCKET_INACTIVE: "Target Midas bucket is inactive",
	MIDAS_BUCKET_CAP_EXCEEDED: "Midas bucket maximum budget cap exceeded",
	MIDAS_LONG_TERM_BUCKET_RESTRICTED:
		"Generic Midas transfers cannot directly touch pending long-term bucket",
	MIDAS_INVALID_STATE: "Midas state transition failed",
	LONG_TERM_INVALID_INPUT: "Invalid long-term investment request",
	LONG_TERM_TASK_NOT_FOUND: "Long-term investment task not found",
	LONG_TERM_TASK_NOT_PENDING: "Long-term investment task is not pending",
	LONG_TERM_TASK_NOT_SENT: "Long-term investment task is not in sent status",
	LONG_TERM_TASK_CANCELLED: "Long-term investment task is cancelled",
	LONG_TERM_REVISION_CONFLICT: "Long-term investment task revision is stale",
	LONG_TERM_IDEMPOTENCY_CONFLICT:
		"Idempotency-Key was already used with a different long-term request",
	LONG_TERM_INSUFFICIENT_UNALLOCATED:
		"Insufficient unallocated Midas liquidity for long-term investment",
	LONG_TERM_INVALID_STATE: "Long-term investment state transition failed",
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
