import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ledgerBalancesModule from "../src/ledger/balances";
import { LedgerError } from "../src/ledger/errors";
import { CanonicalTransactionError } from "../src/transactions/errors";
import * as productReadModule from "../src/transactions/product-read-v2";
import * as txServiceModule from "../src/transactions/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const TX_ID = "22222222-2222-4222-8222-222222222222";
const ACC_ID1 = "44444444-4444-4444-8444-444444444444";

vi.mock("../src/http/auth-middleware", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/http/auth-middleware")>();
	return {
		...actual,
		// biome-ignore lint/suspicious/noExplicitAny: test middleware shim
		requireAuthenticatedSession: async (c: any, next: any) => {
			const cookie = c.req.header("Cookie") ?? "";
			const match = /(?:^|;\s*)__Host-gg_session=([^;]+)/.exec(cookie);
			if (!match || (match[1] ?? "").trim() === "") {
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
			c.set("auth", {
				userId: U1,
				displayName: "U1",
				sessionId: "sess-1",
			});
			return next();
		},
	};
});

const { app } = await import("../src/index");

const OCCURRED_AT = "2026-09-10T12:34:56.789Z";
const COOKIE = "__Host-gg_session=valid-token";
const ORIGIN = "http://localhost:8787";

const mockEnv = {
	DATABASE_URL: "postgresql://user:password@example.invalid/db",
	WEBAUTHN_RP_ID: "localhost",
	WEBAUTHN_RP_NAME: "Gelir Gider",
	WEBAUTHN_ORIGIN: "http://localhost:8787",
	BOOTSTRAP_TOKEN_HASH: "0".repeat(64),
	AUTH_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

interface ErrBody {
	error: { code: string; message: string };
}

describe("Transactions & Ledger HTTP Product Boundary (Checkpoint 7B.1-R1 Read-Only)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	// --- A. Authentication Enforcements ---
	describe("Authentication gates", () => {
		it("rejects unauthenticated GET /transactions", async () => {
			const res = await app.request(
				"/transactions",
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("UNAUTHENTICATED");
		});

		it("rejects unauthenticated GET /transactions/:id", async () => {
			const res = await app.request(
				`/transactions/${TX_ID}`,
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("UNAUTHENTICATED");
		});

		it("rejects unauthenticated GET /transactions/:id/revisions", async () => {
			const res = await app.request(
				`/transactions/${TX_ID}/revisions`,
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("UNAUTHENTICATED");
		});

		it("rejects unauthenticated GET /ledger/accounts", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("UNAUTHENTICATED");
		});

		it("rejects unauthenticated GET /ledger/accounts/:id/balance", async () => {
			const res = await app.request(
				`/ledger/accounts/${ACC_ID1}/balance`,
				{ method: "GET" },
				mockEnv,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("UNAUTHENTICATED");
		});
	});

	// --- B. Generic Financial Mutation Routes Not Exposed (No Domain Bypass) ---
	describe("Generic Financial Mutation Routes Are Not Exposed", () => {
		it("returns 404 for POST /transactions (no generic manual create endpoint)", async () => {
			const res = await app.request(
				"/transactions",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key",
					},
					body: JSON.stringify({
						kind: "EXPENSE",
						occurredAt: OCCURRED_AT,
						payload: {},
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("NOT_FOUND");
		});

		it("returns 404 for POST /transactions/:id/revisions (no generic revise endpoint)", async () => {
			const res = await app.request(
				`/transactions/${TX_ID}/revisions`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						occurredAt: OCCURRED_AT,
						payload: {},
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("NOT_FOUND");
		});

		it("returns 404 for POST /transactions/:id/void (no generic void endpoint)", async () => {
			const res = await app.request(
				`/transactions/${TX_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("NOT_FOUND");
		});

		it("returns 404 for any POST /ledger routes (no raw journal write API)", async () => {
			const res = await app.request(
				"/ledger/entries",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({}),
				},
				mockEnv,
			);
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("NOT_FOUND");
		});
	});

	// --- C. GET /transactions (List & Keyset Pagination) ---
	describe("GET /transactions", () => {
		it("returns 200 with bounded list and nextCursor", async () => {
			vi.spyOn(
				productReadModule,
				"listCanonicalTransactions",
			).mockResolvedValue({
				transactions: [
					{
						transactionId: TX_ID,
						kind: "EXPENSE",
						status: "ACTIVE",
						revisionNo: 1,
						occurredAt: OCCURRED_AT,
						payload: { merchant: "Market" },
						createdAt: OCCURRED_AT,
						latestRevisionCreatedAt: OCCURRED_AT,
					},
				],
				nextCursor: null,
			});

			const res = await app.request(
				"/transactions?limit=10",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				transactions: [
					{
						transactionId: TX_ID,
						kind: "EXPENSE",
						status: "ACTIVE",
						revisionNo: 1,
						occurredAt: OCCURRED_AT,
						payload: { merchant: "Market" },
						createdAt: OCCURRED_AT,
						latestRevisionCreatedAt: OCCURRED_AT,
					},
				],
				nextCursor: null,
			});
		});

		it("rejects malformed limit parameter", async () => {
			const res = await app.request(
				"/transactions?limit=abc",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("TRANSACTION_INVALID_INPUT");
		});

		it("rejects malformed status parameter", async () => {
			const res = await app.request(
				"/transactions?status=UNKNOWN",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});

		it("rejects cursor with only beforeOccurredAt missing beforeTransactionId", async () => {
			const res = await app.request(
				`/transactions?beforeOccurredAt=${OCCURRED_AT}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});
	});

	// --- D. GET /transactions/:transactionId (Detail) ---
	describe("GET /transactions/:transactionId", () => {
		it("returns 200 with effective transaction state", async () => {
			vi.spyOn(txServiceModule, "getCanonicalTransaction").mockResolvedValue({
				transactionId: TX_ID,
				kind: "EXPENSE",
				status: "ACTIVE",
				revisionNo: 2,
				occurredAt: new Date(OCCURRED_AT),
				payload: { amount: "100.00" },
				createdAt: new Date(OCCURRED_AT),
				latestRevisionCreatedAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/transactions/${TX_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				transactionId: TX_ID,
				kind: "EXPENSE",
				status: "ACTIVE",
				revisionNo: 2,
				occurredAt: OCCURRED_AT,
				payload: { amount: "100.00" },
				createdAt: OCCURRED_AT,
				latestRevisionCreatedAt: OCCURRED_AT,
			});
		});

		it("rejects malformed transactionId UUID", async () => {
			const res = await app.request(
				"/transactions/not-a-uuid",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});

		it("maps TRANSACTION_NOT_FOUND to 404", async () => {
			vi.spyOn(txServiceModule, "getCanonicalTransaction").mockRejectedValue(
				new CanonicalTransactionError("TRANSACTION_NOT_FOUND", "not found"),
			);

			const res = await app.request(
				`/transactions/${TX_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("TRANSACTION_NOT_FOUND");
		});
	});

	// --- E. GET /transactions/:transactionId/revisions ---
	describe("GET /transactions/:transactionId/revisions", () => {
		it("returns 200 with bounded revision list", async () => {
			vi.spyOn(
				productReadModule,
				"listBoundedCanonicalTransactionRevisions",
			).mockResolvedValue({
				transactionId: TX_ID,
				revisions: [
					{
						revisionNo: 1,
						operation: "CREATE",
						occurredAt: OCCURRED_AT,
						payload: { desc: "first" },
						reasonCode: null,
						reasonNote: null,
						createdAt: OCCURRED_AT,
					},
				],
				nextCursor: null,
			});

			const res = await app.request(
				`/transactions/${TX_ID}/revisions?limit=50`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				revisions: Array<{ revisionNo: number }>;
			};
			expect(body.revisions).toHaveLength(1);
			expect(body.revisions[0]?.revisionNo).toBe(1);
		});

		it("rejects invalid beforeRevisionNo", async () => {
			const res = await app.request(
				`/transactions/${TX_ID}/revisions?beforeRevisionNo=0`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});
	});

	// --- F. GET /ledger/accounts ---
	describe("GET /ledger/accounts", () => {
		it("returns 200 with list of account balances", async () => {
			vi.spyOn(
				ledgerBalancesModule,
				"listLedgerAccountBalances",
			).mockResolvedValue([
				{
					accountId: ACC_ID1,
					code: "1000",
					name: "Cash",
					accountType: "ASSET",
					normalBalance: "DEBIT",
					currency: "TRY",
					archived: false,
					balance: "1500.50",
				},
			]);

			const res = await app.request(
				"/ledger/accounts?includeArchived=true",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				accounts: Array<{ balance: string }>;
			};
			expect(body.accounts).toHaveLength(1);
			expect(body.accounts[0]?.balance).toBe("1500.50");
		});

		it("rejects non-boolean includeArchived value", async () => {
			const res = await app.request(
				"/ledger/accounts?includeArchived=yes",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
		});

		it("rejects malformed asOf timestamp", async () => {
			const res = await app.request(
				"/ledger/accounts?asOf=invalid-date",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
		});
	});

	// --- G. GET /ledger/accounts/:accountId/balance ---
	describe("GET /ledger/accounts/:accountId/balance", () => {
		it("returns 200 with exact single account balance", async () => {
			vi.spyOn(
				ledgerBalancesModule,
				"getLedgerAccountBalance",
			).mockResolvedValue({
				accountId: ACC_ID1,
				currency: "TRY",
				normalBalance: "DEBIT",
				balance: "250.75",
				asOf: OCCURRED_AT,
			});

			const res = await app.request(
				`/ledger/accounts/${ACC_ID1}/balance?asOf=${OCCURRED_AT}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				accountId: ACC_ID1,
				currency: "TRY",
				normalBalance: "DEBIT",
				balance: "250.75",
				asOf: OCCURRED_AT,
			});
		});

		it("maps LEDGER_ACCOUNT_NOT_FOUND to 404", async () => {
			vi.spyOn(
				ledgerBalancesModule,
				"getLedgerAccountBalance",
			).mockRejectedValue(
				new LedgerError("LEDGER_ACCOUNT_NOT_FOUND", "not found"),
			);

			const res = await app.request(
				`/ledger/accounts/${ACC_ID1}/balance`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_ACCOUNT_NOT_FOUND");
		});

		it("rejects malformed accountId UUID", async () => {
			const res = await app.request(
				"/ledger/accounts/not-uuid/balance",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
		});
	});

	// --- H. Security & Error Sanitization ---
	describe("Security headers and error sanitization", () => {
		it("preserves X-Request-Id on responses", async () => {
			const res = await app.request(
				"/transactions",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.headers.get("x-request-id")).toBeDefined();
		});

		it("sanitizes unexpected internal errors to 500 without leaking details", async () => {
			vi.spyOn(txServiceModule, "getCanonicalTransaction").mockRejectedValue(
				new Error("Sensitive PostgreSQL connection string / stack trace"),
			);

			const res = await app.request(
				`/transactions/${TX_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(500);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INTERNAL_ERROR");
			expect(body.error.message).toBe("Internal server error");
			expect(JSON.stringify(body)).not.toContain("Sensitive");
		});
	});
});
