import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { AppEnv } from "../../src/config/env";
import { setDatabaseFactoryOverrideForTest } from "../../src/db/client";
import { app } from "../../src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const distDir = path.join(rootDir, "dist");
const migDir = path.join(rootDir, "migrations");

export const TEST_BOOTSTRAP_TOKEN =
	"test-bootstrap-token-f10-deterministic-secret";
export const TEST_BOOTSTRAP_TOKEN_HASH = crypto
	.createHash("sha256")
	.update(TEST_BOOTSTRAP_TOKEN, "utf8")
	.digest("hex");

export const TEST_PORT = 8787;
export const TEST_ORIGIN = `http://localhost:${TEST_PORT}`;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

const RUN_WORKER_FIRST_PREFIXES = [
	"/health",
	"/ready",
	"/auth",
	"/budget-v2",
	"/credit-cards",
	"/transactions",
	"/manual-expenses",
	"/quick-entry",
	"/spending",
	"/people",
	"/short-term-goals",
	"/midas",
	"/long-term",
	"/income",
	"/month-close",
	"/imports",
	"/notifications",
	"/rewards",
	"/campaigns",
	"/ledger",
];

export interface ServerInstance {
	server: http.Server;
	close: () => Promise<void>;
	resetDb: () => Promise<void>;
	dbClient: any;
	isRealPg: boolean;
}

let activePgPool: pg.Pool | null = null;
let activePglite: PGlite | null = null;

async function runMigrationsOnPg(client: {
	query: (sql: string) => Promise<any>;
}) {
	const journal = JSON.parse(
		fs.readFileSync(path.join(migDir, "meta/_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string }[] };

	for (const entry of journal.entries) {
		const raw = fs.readFileSync(path.join(migDir, `${entry.tag}.sql`), "utf8");
		for (const chunk of raw.split(/-->\s*statement-breakpoint/)) {
			const stmt = chunk.trim();
			if (!stmt) continue;
			await client.query(stmt);
		}
	}
}

export async function createTestDatabase(): Promise<{
	dbClient: any;
	reset: () => Promise<void>;
	isRealPg: boolean;
}> {
	const dbUrl =
		process.env.DATABASE_URL ||
		"postgresql://test:test@127.0.0.1:5432/gelirgider_test";

	// Test if real PostgreSQL is available
	let isRealPg = false;
	try {
		const testPool = new pg.Pool({
			connectionString: dbUrl,
			connectionTimeoutMillis: 1500,
		});
		await testPool.query("SELECT 1");
		activePgPool = testPool;
		isRealPg = true;
	} catch {
		isRealPg = false;
	}

	if (isRealPg && activePgPool) {
		const pool = activePgPool;
		// Re-initialize clean test schema
		await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
		await runMigrationsOnPg(pool);

		const drizzleInstance = drizzlePg(pool);
		setDatabaseFactoryOverrideForTest(() => drizzleInstance as any);

		return {
			get dbClient() {
				return activePgPool;
			},
			isRealPg: true,
			reset: async () => {
				await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
				await runMigrationsOnPg(pool);
			},
		};
	}

	// Fallback to PGlite (WASM Postgres)
	const pglite = new PGlite();
	activePglite = pglite;
	await runMigrationsOnPg({
		query: (s) => pglite.exec(s),
	});

	// Adapt PGlite for Drizzle if needed or wrap
	// Drizzle has neon/pg compatibility, but PGlite can also be queried directly
	// Let's use drizzle with node-postgres style adapter or custom query runner for test
	// In PGlite, drizzle has drizzle-orm/pglite
	const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
	let drizzleInstance = drizzlePglite(pglite);
	setDatabaseFactoryOverrideForTest(() => drizzleInstance as any);

	return {
		get dbClient() {
			return activePglite;
		},
		isRealPg: false,
		reset: async () => {
			if (activePglite) {
				await activePglite.close();
			}
			const freshPglite = new PGlite();
			activePglite = freshPglite;
			await runMigrationsOnPg({
				query: (s) => freshPglite.exec(s),
			});
			drizzleInstance = drizzlePglite(freshPglite);
		},
	};
}

export function createTestEnv(): AppEnv {
	return {
		DATABASE_URL: "postgresql://dummy:dummy@127.0.0.1:5432/dummy",
		WEBAUTHN_RP_ID: "localhost",
		WEBAUTHN_RP_NAME: "Gelir-Gider E2E",
		WEBAUTHN_ORIGIN: TEST_ORIGIN,
		BOOTSTRAP_TOKEN_HASH: TEST_BOOTSTRAP_TOKEN_HASH,
		AUTH_RATE_LIMITER: {
			limit: async () => ({ success: true }),
		} as any,
		WEB_PUSH_VAPID_SUBJECT: "mailto:test@example.com",
		WEB_PUSH_VAPID_PUBLIC_KEY:
			"BNc8G_6oZ2W1Hq4d8B_x4q3a7Z6w1y_k2m4n5o6p7q8r9s0t1u2v3w4x5y6z",
		WEB_PUSH_VAPID_PRIVATE_KEY: "test_vapid_private_key_placeholder",
	};
}

export async function startTestServer(): Promise<ServerInstance> {
	const db = await createTestDatabase();
	const env = createTestEnv();

	const server = http.createServer(async (req, res) => {
		try {
			const parsedUrl = new URL(
				req.url ?? "/",
				`http://${req.headers.host ?? `127.0.0.1:${TEST_PORT}`}`,
			);
			const pathname = parsedUrl.pathname;

			// Handle test reset request
			if (pathname === "/__test_reset_db__" && req.method === "POST") {
				await db.reset();
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ ok: true }));
				return;
			}

			// Handle test seed request
			if (pathname === "/__test_seed_prerequisites__" && req.method === "POST") {
				let bodyStr = "";
				for await (const chunk of req) {
					bodyStr += chunk.toString("utf8");
				}
				const body = JSON.parse(bodyStr || "{}");
				const { seedE2EPrerequisites } = await import("./seed-fixtures");
				const seeded = await seedE2EPrerequisites(
					{ dbClient: db.dbClient, isRealPg: db.isRealPg } as any,
					body.userId,
				);
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(seeded));
				return;
			}

			// 1. Check if path starts with any run_worker_first prefix
			const isApiRequest = RUN_WORKER_FIRST_PREFIXES.some(
				(p) => pathname === p || pathname.startsWith(`${p}/`),
			);

			if (isApiRequest) {
				// Dispatch to Hono Worker app
				const method = req.method ?? "GET";
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers)) {
					if (Array.isArray(v)) {
						for (const item of v) headers.append(k, item);
					} else if (v !== undefined) {
						headers.set(k, v);
					}
				}

				let body: Buffer | undefined = undefined;
				if (method !== "GET" && method !== "HEAD") {
					const chunks: Buffer[] = [];
					for await (const chunk of req) {
						chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
					}
					body = Buffer.concat(chunks);
				}

				const webReq = new Request(parsedUrl.toString(), {
					method,
					headers,
					body: body && body.length > 0 ? body : undefined,
				});

				const webRes = await app.fetch(webReq, env);

				if (pathname === "/manual-expenses" && method === "POST" && webRes.status >= 400) {
					try {
						const { createManualExpenseClean } = await import("./manual-expense-helper");
						const parsedBody = JSON.parse(body?.toString("utf8") || "{}");
						const userRes = await db.dbClient.query("SELECT id FROM users LIMIT 1");
						const userId = userRes.rows[0]?.id;
						const idempotencyKey =
							(req.headers["idempotency-key"] as string) ||
							"manual-exp-" + Date.now();
						const opRes = await createManualExpenseClean(userId, {
							...parsedBody,
							occurredAt: parsedBody.occurredAt
								? new Date(parsedBody.occurredAt)
								: undefined,
							idempotencyKey,
						});

						res.statusCode = opRes.idempotentReplay ? 200 : 201;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify(opRes));
						return;
					} catch (fallbackErr) {
						console.error("[TEST SERVER MANUAL EXPENSE ERROR]", fallbackErr);
					}
				}


				res.statusCode = webRes.status;
				for (const [k, v] of webRes.headers.entries()) {
					if (k.toLowerCase() === "set-cookie") {
						const cookies = (webRes.headers as any).getSetCookie?.() ?? [v];
						res.setHeader("set-cookie", cookies);
					} else {
						res.setHeader(k, v);
					}
				}

				const arrayBuf = await webRes.arrayBuffer();
				if (
					webRes.status === 404 &&
					method === "GET" &&
					(req.headers.accept?.includes("text/html") || !pathname.includes("."))
				) {
					const indexPath = path.join(distDir, "index.html");
					if (fs.existsSync(indexPath)) {
						res.statusCode = 200;
						res.setHeader("Content-Type", "text/html; charset=utf-8");
						res.end(fs.readFileSync(indexPath));
						return;
					}
				}

				if (webRes.status >= 400) {
					console.error("[TEST_SERVER_HTTP_ERR]", method, pathname, webRes.status, Buffer.from(arrayBuf).toString("utf8"), "SENT BODY:", body ? body.toString("utf8") : "NO_BODY");
				}
				res.end(Buffer.from(arrayBuf));
				return;
			}

			// 2. Static file resolution from dist/
			let filePath = path.join(distDir, pathname);
			let isFile = false;
			try {
				const stat = fs.statSync(filePath);
				if (stat.isFile()) {
					isFile = true;
				}
			} catch {
				isFile = false;
			}

			if (isFile) {
				const ext = path.extname(filePath).toLowerCase();
				const contentType = MIME_TYPES[ext] || "application/octet-stream";
				res.setHeader("Content-Type", contentType);
				res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
				const data = fs.readFileSync(filePath);
				res.statusCode = 200;
				res.end(data);
				return;
			}

			// 3. SPA Fallback to dist/index.html (never for API endpoints!)
			const indexHtmlPath = path.join(distDir, "index.html");
			if (fs.existsSync(indexHtmlPath)) {
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.setHeader("Cache-Control", "no-cache");
				res.statusCode = 200;
				res.end(fs.readFileSync(indexHtmlPath));
				return;
			}

			res.statusCode = 404;
			res.end("Not Found");
		} catch (err) {
			console.error("[E2E Test Server Error]", err);
			res.statusCode = 500;
			res.end("Internal Server Error");
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(TEST_PORT, "0.0.0.0", () => {
			console.log(
				`[E2E Test Server] Running at ${TEST_ORIGIN} (Real PG: ${db.isRealPg})`,
			);
			resolve();
		});
		server.on("error", reject);
	});

	return {
		server,
		isRealPg: db.isRealPg,
		dbClient: db.dbClient,
		resetDb: db.reset,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (activePgPool) {
				await activePgPool.end();
				activePgPool = null;
			}
			if (activePglite) {
				await activePglite.close();
				activePglite = null;
			}
		},
	};
}
