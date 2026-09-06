import { Hono } from "hono";
import type { AppEnv } from "./config/env";
import { getDatabaseUrl } from "./config/env";
import { createDatabase } from "./db/client";
import { authRouter } from "./http/auth-routes";
import { runNotificationScheduler } from "./notifications/scheduler";
import { WebPushTransport } from "./notifications/web-push";

export const app = new Hono<{ Bindings: AppEnv }>();

app.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "gelir-gider-api",
	});
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

export default {
	fetch: app.fetch,
	async scheduled(
		controller: ScheduledController,
		env: AppEnv,
		ctx: ExecutionContext,
	): Promise<void> {
		const scheduledAt = new Date(controller.scheduledTime);
		ctx.waitUntil(
			(async () => {
				try {
					const db = createDatabase(getDatabaseUrl(env));
					const transport = new WebPushTransport(env);
					await runNotificationScheduler({ db, scheduledAt, transport });
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
					throw new Error("Scheduled notification run failed");
				}
			})(),
		);
	},
};
