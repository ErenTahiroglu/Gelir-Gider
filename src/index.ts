import { Hono } from "hono";
import type { AppEnv } from "./config/env";
import { authRouter } from "./http/auth-routes";

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

export default app;
