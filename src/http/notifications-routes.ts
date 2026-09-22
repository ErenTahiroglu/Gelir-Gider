import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import {
	notificationEvents,
	pushSubscriptionRevisions,
	pushSubscriptions,
} from "../db/schema/notifications";
import {
	disablePushSubscription,
	getNotificationEvent,
	getPushSubscription,
	NotificationError,
	type NotificationEventReadModel,
	type PushSubscriptionReadModel,
	registerPushSubscription,
} from "../notifications";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
	UUID_RE,
	validateStrictQueryParams,
} from "./transport";

/**
 * NOTIFICATIONS — PRODUCT HTTP ADAPTER (Checkpoint 7B.9).
 *
 * Thin authenticated adapter over the existing Notifications domain.
 * Every route:
 *   - Runs behind `sameOriginMutationGuard()` + `requireAuthenticatedSession`
 *   - Derives userId ONLY from `c.get("auth").userId`
 *   - Validates the closed transport schema, then delegates to domain
 *   - Maps domain results/errors to bounded, sanitized HTTP responses
 *
 * NOT exposed: delivery attempts, dispatch reservations, scheduler internals,
 * manual push sends, raw VAPID payloads, or endpoint-gone auto-disable routes.
 */

type NotifEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const notificationsRouter = new Hono<NotifEnv>();

const MUTATION_BODY_LIMIT = 64 * 1024; // 64 KiB

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

const VALID_SUBSCRIPTION_STATUSES = new Set(["ACTIVE", "DISABLED"]);

function fail(c: Context<NotifEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapNotificationError(c: Context<NotifEnv>, err: unknown) {
	if (err instanceof NotificationError) {
		switch (err.code) {
			case "NOTIFICATION_INVALID_INPUT":
				return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
			case "NOTIFICATION_SUBSCRIPTION_NOT_FOUND":
				return fail(c, "NOTIFICATION_SUBSCRIPTION_NOT_FOUND", 404);
			case "NOTIFICATION_SUBSCRIPTION_DISABLED":
				return fail(c, "NOTIFICATION_SUBSCRIPTION_DISABLED", 409);
			case "NOTIFICATION_REVISION_CONFLICT":
				return fail(c, "NOTIFICATION_REVISION_CONFLICT", 409);
			case "NOTIFICATION_IDEMPOTENCY_CONFLICT":
				return fail(c, "NOTIFICATION_IDEMPOTENCY_CONFLICT", 409);
			case "NOTIFICATION_EVENT_NOT_FOUND":
				return fail(c, "NOTIFICATION_EVENT_NOT_FOUND", 404);
			case "NOTIFICATION_INVALID_STATE":
				return fail(c, "NOTIFICATION_INVALID_STATE", 500);
			case "NOTIFICATION_PUSH_CONFIG_INVALID":
			case "NOTIFICATION_PUSH_DELIVERY_FAILED":
				return fail(c, "INTERNAL_ERROR", 500);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

function subscriptionResponseBody(sub: PushSubscriptionReadModel) {
	return {
		subscriptionId: sub.subscriptionId,
		userId: sub.userId,
		status: sub.status,
		revisionNo: sub.revisionNo,
		endpoint: sub.endpoint,
		p256dh: sub.p256dh,
		auth: sub.auth,
		expirationTime: sub.expirationTime?.toISOString() ?? null,
		userAgent: sub.userAgent,
		createdAt: sub.createdAt.toISOString(),
	};
}

function eventResponseBody(ev: NotificationEventReadModel) {
	// Payload privacy invariant: return only the safe fields declared on the
	// read model. Never include statement amounts, card balances, credit limits,
	// or any sensitive financial figure.
	return {
		id: ev.id,
		userId: ev.userId,
		notificationType: ev.notificationType,
		subjectId: ev.subjectId,
		scheduledLocalDate: ev.scheduledLocalDate,
		scheduledFor: ev.scheduledFor.toISOString(),
		// payload intentionally excluded: contains push-level fields (title/body/deepLink)
		// but never financial amounts -- still omitted at the HTTP layer to keep
		// the contract minimal and avoid accidental future leakage.
		createdAt: ev.createdAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

notificationsRouter.use("*", sameOriginMutationGuard());
notificationsRouter.use("*", requireAuthenticatedSession);
notificationsRouter.post(
	"*",
	bodyLimit({
		maxSize: MUTATION_BODY_LIMIT,
		onError: (c) => c.json(errorEnvelope("NOTIFICATION_INVALID_INPUT"), 400),
	}),
);

// ---------------------------------------------------------------------------
// GET /notifications/subscriptions/:id
// ---------------------------------------------------------------------------

notificationsRouter.get("/subscriptions/:id", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const id = c.req.param("id");
	if (!UUID_RE.test(id)) {
		return fail(c, "NOTIFICATION_SUBSCRIPTION_NOT_FOUND", 404);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const sub = await getPushSubscription({
			db,
			userId: c.get("auth").userId,
			subscriptionId: id,
		});
		if (!sub) {
			return fail(c, "NOTIFICATION_SUBSCRIPTION_NOT_FOUND", 404);
		}
		return c.json(subscriptionResponseBody(sub), 200);
	} catch (err) {
		return mapNotificationError(c, err);
	}
});

// ---------------------------------------------------------------------------
// GET /notifications/subscriptions
// ---------------------------------------------------------------------------

notificationsRouter.get("/subscriptions", async (c) => {
	if (!validateStrictQueryParams(c, ["status", "limit", "after"])) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const rawStatus = c.req.query("status");
	if (rawStatus !== undefined && !VALID_SUBSCRIPTION_STATUSES.has(rawStatus)) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}
	const status = rawStatus as "ACTIVE" | "DISABLED" | undefined;

	const rawLimit = c.req.query("limit");
	const limitResult = parseBoundedLimit(rawLimit, {
		defaultLimit: LIST_DEFAULT_LIMIT,
		maxLimit: LIST_MAX_LIMIT,
	});
	if (!limitResult.ok) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}
	const limit = limitResult.limit;

	const after = c.req.query("after");
	if (after !== undefined && !UUID_RE.test(after)) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		// Bounded keyset read: DISTINCT ON latest revision per anchor, with
		// optional status filter and deterministic subscription_id > after cursor.
		// Simple direct SQL; no new projection table or generic pagination framework.
		const fetchLimit = limit + 1;
		const rawResult = await db.execute(sql`
			WITH latest_revisions AS (
				SELECT DISTINCT ON (${pushSubscriptions.id})
					${pushSubscriptions.id}      AS subscription_id,
					${pushSubscriptions.userId}   AS user_id,
					${pushSubscriptions.createdAt} AS created_at,
					${pushSubscriptionRevisions.revisionNo}         AS revision_no,
					${pushSubscriptionRevisions.status}             AS status,
					${pushSubscriptionRevisions.endpoint}           AS endpoint,
					${pushSubscriptionRevisions.p256dh}             AS p256dh,
					${pushSubscriptionRevisions.auth}               AS auth,
					${pushSubscriptionRevisions.expirationTime}     AS expiration_time,
					${pushSubscriptionRevisions.userAgent}          AS user_agent
				FROM ${pushSubscriptions}
				INNER JOIN ${pushSubscriptionRevisions}
					ON ${pushSubscriptions.id} = ${pushSubscriptionRevisions.subscriptionId}
				WHERE ${pushSubscriptions.userId} = ${userId}
				ORDER BY ${pushSubscriptions.id}, ${pushSubscriptionRevisions.revisionNo} DESC
			)
			SELECT * FROM latest_revisions lr
			WHERE 1=1
			${status !== undefined ? sql`AND lr.status = ${status}` : sql``}
			${after !== undefined ? sql`AND lr.subscription_id > ${after}` : sql``}
			ORDER BY lr.subscription_id ASC
			LIMIT ${fetchLimit}
		`);

		const rows = (
			Array.isArray(rawResult)
				? rawResult
				: ((rawResult as { rows?: unknown[] }).rows ?? [])
		) as Array<{
			subscription_id: string;
			user_id: string;
			created_at: string | Date;
			revision_no: number;
			status: string;
			endpoint: string;
			p256dh: string;
			auth: string;
			expiration_time: string | Date | null;
			user_agent: string | null;
		}>;

		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;

		const items = page.map((r) => ({
			subscriptionId: r.subscription_id,
			userId: r.user_id,
			status: r.status,
			revisionNo: Number(r.revision_no),
			endpoint: r.endpoint,
			p256dh: r.p256dh,
			auth: r.auth,
			expirationTime: r.expiration_time
				? r.expiration_time instanceof Date
					? r.expiration_time.toISOString()
					: new Date(r.expiration_time).toISOString()
				: null,
			userAgent: r.user_agent,
			createdAt:
				r.created_at instanceof Date
					? r.created_at.toISOString()
					: new Date(r.created_at).toISOString(),
		}));

		const nextCursor =
			hasMore && page.length > 0
				? (page[page.length - 1]?.subscription_id ?? null)
				: null;

		return c.json({ items, nextCursor }, 200);
	} catch (err) {
		return mapNotificationError(c, err);
	}
});

// ---------------------------------------------------------------------------
// POST /notifications/subscriptions
// ---------------------------------------------------------------------------

notificationsRouter.post("/subscriptions", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const idempotencyKeyResult = readIdempotencyKey(c);
	if (!idempotencyKeyResult.ok) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const bodyResult = await readJsonObject(c);
	if (!bodyResult.ok) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const ALLOWED_BODY_KEYS = [
		"endpoint",
		"p256dh",
		"auth",
		"expirationTime",
		"userAgent",
		"occurredAt",
	] as const;
	if (!hasOnlyKeys(bodyResult.value, ALLOWED_BODY_KEYS)) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const body = bodyResult.value;

	// occurredAt is required and must be a canonical UTC instant
	const occurredAtDate = parseCanonicalInstant(body.occurredAt);
	if (!occurredAtDate) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const result = await registerPushSubscription({
			db,
			userId: c.get("auth").userId,
			endpoint: body.endpoint,
			p256dh: body.p256dh,
			auth: body.auth,
			expirationTime: body.expirationTime,
			userAgent: body.userAgent,
			occurredAt: occurredAtDate,
			idempotencyKey: idempotencyKeyResult.key,
		});

		const status = result.idempotentReplay ? 200 : 201;
		return c.json(
			{
				...subscriptionResponseBody(result.subscription),
				idempotentReplay: result.idempotentReplay,
			},
			status as 200,
		);
	} catch (err) {
		return mapNotificationError(c, err);
	}
});

// ---------------------------------------------------------------------------
// POST /notifications/subscriptions/:id/disable
// ---------------------------------------------------------------------------

notificationsRouter.post("/subscriptions/:id/disable", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const id = c.req.param("id");
	if (!UUID_RE.test(id)) {
		return fail(c, "NOTIFICATION_SUBSCRIPTION_NOT_FOUND", 404);
	}

	const idempotencyKeyResult = readIdempotencyKey(c);
	if (!idempotencyKeyResult.ok) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const bodyResult = await readJsonObject(c);
	if (!bodyResult.ok) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const ALLOWED_BODY_KEYS = ["disableReason", "occurredAt"] as const;
	if (!hasOnlyKeys(bodyResult.value, ALLOWED_BODY_KEYS)) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const body = bodyResult.value;

	const occurredAtDate = parseCanonicalInstant(body.occurredAt);
	if (!occurredAtDate) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const result = await disablePushSubscription({
			db,
			userId: c.get("auth").userId,
			subscriptionId: id,
			disableReason: body.disableReason,
			occurredAt: occurredAtDate,
			idempotencyKey: idempotencyKeyResult.key,
		});

		return c.json(
			{
				...subscriptionResponseBody(result.subscription),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapNotificationError(c, err);
	}
});

// ---------------------------------------------------------------------------
// GET /notifications/events/:id
// ---------------------------------------------------------------------------

notificationsRouter.get("/events/:id", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const id = c.req.param("id");
	if (!UUID_RE.test(id)) {
		return fail(c, "NOTIFICATION_EVENT_NOT_FOUND", 404);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const ev = await getNotificationEvent({
			db,
			userId: c.get("auth").userId,
			eventId: id,
		});
		return c.json(eventResponseBody(ev), 200);
	} catch (err) {
		return mapNotificationError(c, err);
	}
});

// ---------------------------------------------------------------------------
// GET /notifications/events
// ---------------------------------------------------------------------------

notificationsRouter.get("/events", async (c) => {
	if (!validateStrictQueryParams(c, ["date", "limit", "after"])) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	// date= is required for the user-facing notification history use case.
	// Exposing an unbounded all-dates list would leak scheduler internals.
	const rawDate = c.req.query("date");
	if (typeof rawDate !== "string") {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}
	// Validate YYYY-MM-DD
	const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
	if (!LOCAL_DATE_RE.test(rawDate)) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}
	// Calendar validity check via round-trip
	const [year, month, day] = rawDate.split("-").map(Number) as [
		number,
		number,
		number,
	];
	const probe = new Date(Date.UTC(year, month - 1, day));
	if (
		probe.getUTCFullYear() !== year ||
		probe.getUTCMonth() !== month - 1 ||
		probe.getUTCDate() !== day
	) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const rawLimit = c.req.query("limit");
	const limitResult = parseBoundedLimit(rawLimit, {
		defaultLimit: LIST_DEFAULT_LIMIT,
		maxLimit: LIST_MAX_LIMIT,
	});
	if (!limitResult.ok) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}
	const limit = limitResult.limit;

	const after = c.req.query("after");
	if (after !== undefined && !UUID_RE.test(after)) {
		return fail(c, "NOTIFICATION_INVALID_INPUT", 400);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		// Bounded keyset read: user-scoped events for the given scheduledLocalDate,
		// ordered by id ASC. The scheduler's internal all-users / onlyPendingDeliveries
		// parameters are not exposed.
		const fetchLimit = limit + 1;
		const conditions = [
			eq(notificationEvents.userId, userId),
			eq(notificationEvents.scheduledLocalDate, rawDate),
		];
		if (after !== undefined) {
			conditions.push(gt(notificationEvents.id, after));
		}

		const rows = await db
			.select()
			.from(notificationEvents)
			.where(and(...conditions))
			.orderBy(asc(notificationEvents.id))
			.limit(fetchLimit);

		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;

		const items = page.map((row) => ({
			id: row.id,
			userId: row.userId,
			notificationType: row.notificationType,
			subjectId: row.subjectId,
			scheduledLocalDate: row.scheduledLocalDate,
			scheduledFor: row.scheduledFor.toISOString(),
			createdAt: row.createdAt.toISOString(),
		}));

		const nextCursor =
			hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;

		return c.json({ items, nextCursor }, 200);
	} catch (err) {
		return mapNotificationError(c, err);
	}
});
