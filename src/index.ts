import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { toBackupBucket } from "./backups/bucket";
import { BackupError } from "./backups/errors";
import { runBackupRetention } from "./backups/retention";
import { runDatabaseBackup } from "./backups/service";
import type { AppEnv } from "./config/env";
import {
	getBackupBucket,
	getBackupEncryptionKey,
	getBackupKeyId,
	getDatabaseUrl,
} from "./config/env";
import { createDatabase } from "./db/client";
import { authRouter } from "./http/auth-routes";
import type { RequestIdVariables } from "./http/security-middleware";
import {
	requestIdMiddleware,
	securityHeadersMiddleware,
} from "./http/security-middleware";
import { runNotificationScheduler } from "./notifications/scheduler";
import { WebPushTransport } from "./notifications/web-push";
import { logOperationalEvent } from "./observability/logger";

export const app = new Hono<{
	Bindings: AppEnv;
	Variables: RequestIdVariables;
}>();

// Request ID generation runs first so it's available to every downstream
// handler/middleware and is always present on the response, even for an
// error response. Security headers are applied globally on top of it.
app.use("*", requestIdMiddleware);
app.use("*", securityHeadersMiddleware);

// Request-completion observability: wraps the ENTIRE downstream chain so
// every response (success, 4xx, or an exception caught by `onError`) emits
// exactly one HTTP_REQUEST_COMPLETED/HTTP_REQUEST_FAILED event. Never logs
// the query string, request body, cookies, or Authorization header --
// only method, path, status, requestId, and duration.
// Failure-path logging is centralized entirely in `app.onError` below (which
// has the real status code being returned) -- this middleware never logs on
// the failure path itself, only rethrows, so a downstream exception never
// produces two HTTP_REQUEST_FAILED events for the same request.
app.use("*", async (c, next) => {
	const startedAt = Date.now();
	await next();
	logOperationalEvent({
		level: "info",
		eventCode: "HTTP_REQUEST_COMPLETED",
		component: "http",
		requestId: c.get("requestId") ?? null,
		durationMs: Date.now() - startedAt,
		statusCode: c.res.status,
	});
});

app.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "gelir-gider-api",
	});
});

// GET /ready: verifies config resolution + a live trivial DB round trip.
// Never leaks DB hostname/credentials/latency/version in the response body
// -- catches EVERYTHING and returns a flat 503 on any failure, logging a
// sanitized READINESS_FAILED event internally instead.
app.get("/ready", async (c) => {
	try {
		const databaseUrl = getDatabaseUrl(c.env);
		const db = createDatabase(databaseUrl);
		await db.execute(sql`SELECT 1`);
		return c.json({ status: "ready" });
	} catch {
		logOperationalEvent({
			level: "error",
			eventCode: "READINESS_FAILED",
			component: "readiness",
			requestId: c.get("requestId") ?? null,
		});
		return c.json({ status: "not_ready" }, 503);
	}
});

app.route("/auth", authRouter);

app.notFound((c) => {
	return c.json(
		{
			error: {
				code: "NOT_FOUND",
				message: "Route not found",
			},
		},
		404,
	);
});

app.onError((_err, c) => {
	logOperationalEvent({
		level: "error",
		eventCode: "HTTP_REQUEST_FAILED",
		component: "http",
		requestId: c.get("requestId") ?? null,
		statusCode: 500,
	});
	return c.json(
		{
			error: {
				code: "INTERNAL_ERROR",
				message: "Internal server error",
			},
		},
		500,
	);
});

const NOTIFICATION_CRON = "0 * * * *";
const BACKUP_CRON = "17 2 * * *";

export default {
	fetch: app.fetch,
	async scheduled(
		controller: ScheduledController,
		env: AppEnv,
		ctx: ExecutionContext,
	): Promise<void> {
		const scheduledAt = new Date(controller.scheduledTime);

		if (controller.cron === NOTIFICATION_CRON) {
			ctx.waitUntil(
				(async () => {
					try {
						const db = createDatabase(getDatabaseUrl(env));
						const transport = new WebPushTransport(env);
						await runNotificationScheduler({ db, scheduledAt, transport });
						logOperationalEvent({
							level: "info",
							eventCode: "SCHEDULED_NOTIFICATION_COMPLETED",
							component: "scheduled",
						});
					} catch {
						// Never log/echo secrets or raw errors from the scheduled
						// handler -- the sanitized notification error boundary already
						// stripped anything sensitive before this point, and anything
						// that escapes it (e.g. a missing DATABASE_URL) must not be
						// surfaced with its raw message either. But the failure must
						// still be visible to Cloudflare: rethrow a sanitized generic
						// error so the promise passed to `ctx.waitUntil` actually
						// rejects and the invocation is recorded as failed, rather
						// than silently resolving as if nothing went wrong (Phase
						// 15-R1 Section G).
						logOperationalEvent({
							level: "error",
							eventCode: "SCHEDULED_NOTIFICATION_FAILED",
							component: "scheduled",
						});
						throw new Error("Scheduled notification run failed");
					}
				})(),
			);
			return;
		}

		if (controller.cron === BACKUP_CRON) {
			ctx.waitUntil(
				(async () => {
					// Tracks whether a specific, already-sanitized BACKUP_FAILED event
					// has already been logged for this invocation, so the catch-all
					// below never logs a second generic BACKUP_FAILED for the same
					// outcome (Phase 18-R1 Section G.1/G.2).
					let loggedFailure = false;
					try {
						logOperationalEvent({
							level: "info",
							eventCode: "BACKUP_STARTED",
							component: "scheduled",
						});
						const db = createDatabase(getDatabaseUrl(env));
						const bucket = toBackupBucket(getBackupBucket(env));
						const encryptionKey = getBackupEncryptionKey(env);
						const keyId = getBackupKeyId(env);

						const result = await runDatabaseBackup({
							db,
							bucket,
							encryptionKey,
							keyId,
							scheduledAt,
						});

						if (result.status === "COMPLETED") {
							logOperationalEvent({
								level: "info",
								eventCode: "BACKUP_COMPLETED",
								component: "scheduled",
							});
						} else if (result.status === "IN_PROGRESS") {
							// Benign, expected outcome for a legitimate concurrent/retried
							// invocation -- never an error, never rethrown.
							logOperationalEvent({
								level: "info",
								eventCode: "BACKUP_IN_PROGRESS",
								component: "scheduled",
							});
						} else {
							logOperationalEvent({
								level: "error",
								eventCode: "BACKUP_FAILED",
								component: "scheduled",
								safeCode: result.safeErrorCode,
							});
							loggedFailure = true;
						}

						// Retention is fully independent of backup success/failure --
						// its own failure must never mark a completed backup failed.
						const retention = await runBackupRetention({
							bucket,
							currentObjectKey: result.objectKey,
						});
						if (retention.status === "FAILED") {
							logOperationalEvent({
								level: "warn",
								eventCode: "BACKUP_RETENTION_FAILED",
								component: "scheduled",
							});
						}

						if (result.status === "FAILED") {
							throw new Error("Scheduled backup run failed");
						}
					} catch (err) {
						// Only log here when nothing more specific was already logged
						// above -- covers config-resolution failures (before
						// runDatabaseBackup is even called) and any unexpected exception
						// thrown by runDatabaseBackup itself.
						if (!loggedFailure) {
							const safeCode =
								err instanceof BackupError ? err.code : "BACKUP_CONFIG_INVALID";
							logOperationalEvent({
								level: "error",
								eventCode: "BACKUP_FAILED",
								component: "scheduled",
								safeCode,
							});
						}
						throw new Error("Scheduled backup run failed");
					}
				})(),
			);
			return;
		}
	},
};
