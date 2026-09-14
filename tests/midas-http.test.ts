import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClientModule from "../src/db/client";
import { MidasError } from "../src/midas/errors";
import * as productReadModule from "../src/midas/product-read";
import * as serviceModule from "../src/midas/service";

const U1 = "11111111-1111-4111-8111-111111111111";
const MIDAS_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const LEDGER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const TRANSFER_ID = "44444444-4444-4444-8444-444444444444";
const BUCKET_ID = "55555555-5555-4555-8555-555555555555";

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

describe("Midas Product HTTP Surface (Checkpoint 7B.7)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: mock DB
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue({} as any);
	});

	// --- 1. Authentication Gates on All 4 Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/midas/liquidity", method: "GET" },
			{ path: "/midas/transfers", method: "GET" },
			{ path: "/midas/accounts", method: "POST" },
			{ path: "/midas/setup", method: "POST" },
			{ path: "/midas/transfers", method: "POST" },
			{ path: `/midas/transfers/${TRANSFER_ID}/reverse`, method: "POST" },
		];

		for (const { path, method } of routes) {
			it(`rejects unauthenticated ${method} ${path} with 401`, async () => {
				const reqInit: RequestInit = { method };
				if (method === "POST") {
					reqInit.headers = {
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "k-1",
					};
					reqInit.body = "{}";
				}
				const res = await app.request(path, reqInit);
				expect(res.status).toBe(401);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("UNAUTHENTICATED");
			});
		}
	});

	// --- 2. GET /midas/liquidity ---
	describe("GET /midas/liquidity", () => {
		it("returns liquidity state with buckets", async () => {
			vi.spyOn(serviceModule, "getMidasLiquidityState").mockResolvedValue({
				midasAccountId: MIDAS_ACCOUNT_ID,
				ledgerAccountId: LEDGER_ACCOUNT_ID,
				currency: "TRY",
				physicalBalance: "10000.00",
				totalEarmarked: "4000.00",
				unallocatedBalance: "6000.00",
				buckets: [
					{
						bucketId: BUCKET_ID,
						code: "PENDING_LONG_TERM",
						name: "Pending Long Term",
						bucketType: "PENDING_LONG_TERM",
						balance: "4000.00",
					},
				],
			});

			const res = await app.request(
				`/midas/liquidity?midasAccountId=${MIDAS_ACCOUNT_ID}`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.liquidity.midasAccountId).toBe(MIDAS_ACCOUNT_ID);
			expect(body.liquidity.physicalBalance).toBe("10000.00");
			expect(body.liquidity.unallocatedBalance).toBe("6000.00");
			expect(body.liquidity.buckets).toHaveLength(1);
		});

		it("returns 404 when Midas account not found", async () => {
			vi.spyOn(serviceModule, "getMidasLiquidityState").mockRejectedValue(
				new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found"),
			);

			const res = await app.request(
				"/midas/liquidity",
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("MIDAS_ACCOUNT_NOT_FOUND");
		});
	});

	// --- 3. GET /midas/transfers Keyset Listing ---
	describe("GET /midas/transfers", () => {
		it("returns paginated transfers with keyset cursor", async () => {
			const mockTransfer: productReadModule.MidasAllocationTransferProductDto =
				{
					transferId: TRANSFER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					fromBucketId: null,
					toBucketId: BUCKET_ID,
					amount: "1500.00",
					occurredAt: OCCURRED_AT,
					reversalOfTransferId: null,
					memo: "Initial allocation",
					createdAt: OCCURRED_AT,
				};

			vi.spyOn(
				productReadModule,
				"listBoundedMidasAllocationTransfers",
			).mockResolvedValue({
				transfers: [mockTransfer],
				hasMore: false,
				nextCursor: null,
			});

			const res = await app.request(
				`/midas/transfers?midasAccountId=${MIDAS_ACCOUNT_ID}&limit=20`,
				{
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.transfers).toHaveLength(1);
			expect(body.transfers[0].transferId).toBe(TRANSFER_ID);
			expect(body.hasMore).toBe(false);
		});
	});

	// --- 4. POST /midas/accounts Bootstrap & Setup ---
	describe("POST /midas/accounts (and /midas/setup alias)", () => {
		it("sets up Midas account with PENDING_LONG_TERM singleton bucket", async () => {
			const mockTx = {
				select: vi.fn().mockReturnValue({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([{ id: MIDAS_ACCOUNT_ID }]),
						}),
					}),
				}),
			};
			const mockDb = {
				transaction: vi.fn().mockImplementation(async (cb) => cb(mockTx)),
			};
			// biome-ignore lint/suspicious/noExplicitAny: mock DB
			vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb as any);
			vi.spyOn(serviceModule, "createMidasAccount").mockResolvedValue({
				id: MIDAS_ACCOUNT_ID,
				userId: U1,
				ledgerAccountId: LEDGER_ACCOUNT_ID,
				createdAt: new Date(OCCURRED_AT),
			});
			vi.spyOn(
				serviceModule,
				"ensureMidasSingletonBucketInTransaction",
			).mockResolvedValue({
				id: BUCKET_ID,
				userId: U1,
				midasAccountId: MIDAS_ACCOUNT_ID,
				code: "PENDING_LONG_TERM",
				name: "Pending Long Term",
				bucketType: "PENDING_LONG_TERM",
				createdAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				"/midas/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "setup-k1",
					},
					body: JSON.stringify({
						ledgerAccountId: LEDGER_ACCOUNT_ID,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.midasAccount.midasAccountId).toBe(MIDAS_ACCOUNT_ID);
			expect(body.midasAccount.ledgerAccountId).toBe(LEDGER_ACCOUNT_ID);
		});

		it("rejects invalid payload with unknown fields", async () => {
			const res = await app.request(
				"/midas/accounts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "setup-k2",
					},
					body: JSON.stringify({
						ledgerAccountId: LEDGER_ACCOUNT_ID,
						genericBucket: "ATTACK",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("MIDAS_INVALID_INPUT");
		});
	});

	// --- 5. POST /midas/transfers and Reversal ---
	describe("POST /midas/transfers and Reversal", () => {
		it("creates allocation transfer and returns 201", async () => {
			vi.spyOn(
				serviceModule,
				"createMidasAllocationTransfer",
			).mockResolvedValue({
				transferId: TRANSFER_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				fromBucketId: null,
				toBucketId: BUCKET_ID,
				amount: "2500.00",
				occurredAt: new Date(OCCURRED_AT),
				idempotentReplay: false,
			});

			const res = await app.request(
				"/midas/transfers",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "xfer-k1",
					},
					body: JSON.stringify({
						midasAccountId: MIDAS_ACCOUNT_ID,
						toBucketId: BUCKET_ID,
						amount: "2500.00",
						occurredAt: OCCURRED_AT,
						memo: "Reserve",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(201);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.transfer.transferId).toBe(TRANSFER_ID);
			expect(body.transfer.amount).toBe("2500.00");
			expect(body.idempotentReplay).toBe(false);
		});

		it("reverses allocation transfer and returns 200", async () => {
			vi.spyOn(
				serviceModule,
				"reverseMidasAllocationTransfer",
			).mockResolvedValue({
				transferId: "99999999-9999-4999-8999-999999999999",
				midasAccountId: MIDAS_ACCOUNT_ID,
				fromBucketId: BUCKET_ID,
				toBucketId: null,
				amount: "2500.00",
				occurredAt: new Date(OCCURRED_AT),
				idempotentReplay: false,
			});

			const res = await app.request(
				`/midas/transfers/${TRANSFER_ID}/reverse`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "rev-k1",
					},
					body: JSON.stringify({
						occurredAt: OCCURRED_AT,
						memo: "Reversal",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: test assert
			const body = (await res.json()) as any;
			expect(body.transfer.transferId).toBe(
				"99999999-9999-4999-8999-999999999999",
			);
		});
	});
});
