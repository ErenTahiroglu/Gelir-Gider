import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "gelir-gider-api",
	});
});

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

export default app;
