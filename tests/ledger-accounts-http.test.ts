import { beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerError } from "../src/ledger/errors";
import * as productAccountsModule from "../src/ledger/product-accounts";

const U1 = "11111111-1111-4111-8111-111111111111";
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

describe("POST /ledger/accounts HTTP Product Boundary (Checkpoint 7B.2-R1)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	// --- 1. Authentication & Origin Guard ---
	describe("Auth & Origin security", () => {
		it("rejects unauthenticated POST /ledger/accounts with 401", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("UNAUTHENTICATED");
		});

		it("rejects missing Origin header with 403 INVALID_ORIGIN", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});

		it("rejects mismatched Origin header with 403 INVALID_ORIGIN", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: "https://evil-site.com",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});
	});

	// --- 2. Closed Body & Field Rejection ---
	describe("Closed body validation", () => {
		it("rejects extra unknown properties", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
						extraKey: "evil",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
		});

		it("rejects client-supplied userId", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
						userId: "22222222-2222-2222-2222-222222222222",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
		});

		it("rejects client-supplied currency", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
						currency: "USD",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});

		it("rejects client-supplied normalBalance", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
						normalBalance: "DEBIT",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
		});

		it("rejects client-supplied balance / openingBalance / amount / debit / credit", async () => {
			for (const forbidden of [
				"balance",
				"openingBalance",
				"amount",
				"debit",
				"credit",
				"journal",
				"ledgerLines",
			]) {
				const res = await app.request(
					"/ledger/accounts",
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							code: "CASH",
							name: "Main Cash",
							accountType: "ASSET",
							[forbidden]: "100.00",
						}),
					},
					mockEnv,
				);
				expect(res.status).toBe(400);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
			}
		});
	});

	// --- 3. Account Type Whitelist ---
	describe("Account types validation", () => {
		it("rejects LIABILITY account type", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "MY_DEBT",
						name: "My Debt",
						accountType: "LIABILITY",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
		});

		it("rejects EQUITY account type", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "MY_EQUITY",
						name: "My Equity",
						accountType: "EQUITY",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
		});

		it("rejects EXPENSE account type in this checkpoint", async () => {
			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "GROCERIES",
						name: "Groceries",
						accountType: "EXPENSE",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_INVALID_INPUT");
		});

		it("accepts ASSET and returns derived DEBIT normalBalance", async () => {
			vi.spyOn(
				productAccountsModule,
				"createProductLedgerAccount",
			).mockResolvedValue({
				account: {
					id: ACC_ID1,
					userId: U1,
					code: "USR_CASH",
					name: "Main Cash",
					accountType: "ASSET",
					normalBalance: "DEBIT",
					currency: "TRY",
					createdAt: new Date("2026-09-11T12:00:00.000Z"),
					archivedAt: null,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				accountId: ACC_ID1,
				code: "USR_CASH",
				name: "Main Cash",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				idempotentReplay: false,
			});
		});

		it("accepts INCOME and returns derived CREDIT normalBalance", async () => {
			vi.spyOn(
				productAccountsModule,
				"createProductLedgerAccount",
			).mockResolvedValue({
				account: {
					id: ACC_ID1,
					userId: U1,
					code: "USR_SALARY",
					name: "Primary Salary",
					accountType: "INCOME",
					normalBalance: "CREDIT",
					currency: "TRY",
					createdAt: new Date("2026-09-11T12:00:00.000Z"),
					archivedAt: null,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "SALARY",
						name: "Primary Salary",
						accountType: "INCOME",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				accountId: ACC_ID1,
				code: "USR_SALARY",
				name: "Primary Salary",
				accountType: "INCOME",
				normalBalance: "CREDIT",
				currency: "TRY",
				archived: false,
				idempotentReplay: false,
			});
		});
	});

	// --- 4. Input Shape & Constraints ---
	describe("Input format validations", () => {
		it("rejects invalid code format (spaces, non-alphanumeric/underscore)", async () => {
			for (const badCode of [
				"",
				"   ",
				"bad-code",
				"bad code",
				"a".repeat(61),
			]) {
				const res = await app.request(
					"/ledger/accounts",
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							code: badCode,
							name: "Valid Name",
							accountType: "ASSET",
						}),
					},
					mockEnv,
				);
				expect(res.status).toBe(400);
			}
		});

		it("rejects invalid name length (empty or >100 characters)", async () => {
			for (const badName of ["", "   ", "a".repeat(101)]) {
				const res = await app.request(
					"/ledger/accounts",
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							code: "CHECKING",
							name: badName,
							accountType: "ASSET",
						}),
					},
					mockEnv,
				);
				expect(res.status).toBe(400);
			}
		});
	});

	// --- 5. Replay & Error Mapping ---
	describe("Replay and conflict mapping", () => {
		it("returns idempotentReplay: true on exact replay", async () => {
			vi.spyOn(
				productAccountsModule,
				"createProductLedgerAccount",
			).mockResolvedValue({
				account: {
					id: ACC_ID1,
					userId: U1,
					code: "USR_CASH",
					name: "Main Cash",
					accountType: "ASSET",
					normalBalance: "DEBIT",
					currency: "TRY",
					createdAt: new Date("2026-09-11T12:00:00.000Z"),
					archivedAt: null,
				},
				idempotentReplay: true,
			});

			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as { idempotentReplay: boolean };
			expect(body.idempotentReplay).toBe(true);
		});

		it("maps LEDGER_ACCOUNT_CODE_CONFLICT to 409", async () => {
			vi.spyOn(
				productAccountsModule,
				"createProductLedgerAccount",
			).mockRejectedValue(
				new LedgerError(
					"LEDGER_ACCOUNT_CODE_CONFLICT",
					"Account with code already exists with different definition",
				),
			);

			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Different Name",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_ACCOUNT_CODE_CONFLICT");
			expect(body.error.message).toBe("Ledger account code conflict");
		});

		it("maps LEDGER_ACCOUNT_ARCHIVED to 409", async () => {
			vi.spyOn(
				productAccountsModule,
				"createProductLedgerAccount",
			).mockRejectedValue(
				new LedgerError("LEDGER_ACCOUNT_ARCHIVED", "Account is archived"),
			);

			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("LEDGER_ACCOUNT_ARCHIVED");
			expect(body.error.message).toBe("Ledger account is archived");
		});
	});

	// --- 6. Security Headers ---
	describe("Security headers", () => {
		it("includes X-Request-Id header on POST response", async () => {
			vi.spyOn(
				productAccountsModule,
				"createProductLedgerAccount",
			).mockResolvedValue({
				account: {
					id: ACC_ID1,
					userId: U1,
					code: "USR_CASH",
					name: "Main Cash",
					accountType: "ASSET",
					normalBalance: "DEBIT",
					currency: "TRY",
					createdAt: new Date("2026-09-11T12:00:00.000Z"),
					archivedAt: null,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				"/ledger/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						code: "CASH",
						name: "Main Cash",
						accountType: "ASSET",
					}),
				},
				mockEnv,
			);

			expect(res.headers.get("x-request-id")).toBeDefined();
		});
	});
});
