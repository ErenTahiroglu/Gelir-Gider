import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import * as paymentsModule from "../src/credit-cards/payments";
import * as purchasesModule from "../src/credit-cards/purchases";
import * as serviceModule from "../src/credit-cards/service";
import * as reconModule from "../src/credit-cards/statement-reconciliation";

const U1 = "11111111-1111-4111-8111-111111111111";
const CARD_ID = "22222222-2222-4222-8222-222222222222";
const STMT_ID = "33333333-3333-4333-8333-333333333333";
const MIDAS_ACC_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "66666666-6666-4666-8666-666666666666";

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

// biome-ignore lint/suspicious/noExplicitAny: test payload assertion helper
type JsonAny = any;

interface ErrBody {
	error: { code: string; message: string };
}

describe("Credit Cards Product HTTP Surface (Checkpoint 7B.3)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	// --- 1. Authentication Gates on All Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/credit-cards", method: "GET" },
			{ path: `/credit-cards/${CARD_ID}`, method: "GET" },
			{ path: "/credit-cards", method: "POST" },
			{ path: `/credit-cards/${CARD_ID}`, method: "POST" },
			{ path: `/credit-cards/${CARD_ID}/archive`, method: "POST" },
			{ path: `/credit-cards/${CARD_ID}/statements`, method: "GET" },
			{ path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}`, method: "GET" },
			{ path: `/credit-cards/${CARD_ID}/statements`, method: "POST" },
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/void`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/pay`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/reopen`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/readiness`,
				method: "GET",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/reconciliation`,
				method: "GET",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/reconcile`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/statements/${STMT_ID}/reconcile/void`,
				method: "POST",
			},
			{ path: `/credit-cards/${CARD_ID}/purchases`, method: "GET" },
			{ path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}`, method: "GET" },
			{ path: `/credit-cards/${CARD_ID}/purchases`, method: "POST" },
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/revisions`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/void`,
				method: "POST",
			},
		];

		for (const { path, method } of routes) {
			it(`rejects unauthenticated ${method} ${path} with 401 UNAUTHENTICATED`, async () => {
				const res = await app.request(
					path,
					{
						method,
						headers: {
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						...(method === "POST" ? { body: "{}" } : {}),
					},
					mockEnv,
				);
				expect(res.status).toBe(401);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("UNAUTHENTICATED");
			});
		}
	});

	// --- 2. Same-Origin Mutation Guard ---
	describe("Same-Origin mutation guard", () => {
		it("rejects POST /credit-cards with missing Origin header (403 INVALID_ORIGIN)", async () => {
			const res = await app.request(
				"/credit-cards",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						code: "BONUS_CARD",
						displayName: "Bonus Card",
						issuer: "Garanti BBVA",
						statementDay: 15,
						dueDay: 25,
						creditLimit: "50000.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});

		it("rejects POST with mismatched Origin header (403 INVALID_ORIGIN)", async () => {
			const res = await app.request(
				"/credit-cards",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: "http://malicious-site.example.com",
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						code: "BONUS_CARD",
						displayName: "Bonus Card",
						issuer: "Garanti BBVA",
						statementDay: 15,
						dueDay: 25,
						creditLimit: "50000.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});
	});

	// --- 3. Intentionally Absent Raw Ledger Endpoints ---
	describe("Raw ledger write protection", () => {
		const absentPaths = [
			"/ledger/post",
			"/ledger/entries",
			"/ledger/journal",
			"/ledger/reverse",
		];
		for (const path of absentPaths) {
			it(`confirms ${path} is absent (404 NOT_FOUND)`, async () => {
				const res = await app.request(
					path,
					{
						method: "POST",
						headers: {
							Cookie: COOKIE,
							Origin: ORIGIN,
							"Content-Type": "application/json",
						},
						body: "{}",
					},
					mockEnv,
				);
				expect(res.status).toBe(404);
			});
		}
	});

	// --- 4. Cards Lifecycle ---
	describe("Credit Cards endpoints", () => {
		it("GET /credit-cards returns paginated cards list", async () => {
			vi.spyOn(serviceModule, "listCreditCards").mockResolvedValueOnce([
				{
					cardId: CARD_ID,
					userId: U1,
					code: "BONUS_CARD",
					displayName: "Bonus Card",
					issuer: "Garanti BBVA",
					statementDay: 15,
					dueDay: 25,
					status: "ACTIVE",
					revisionNo: 1,
					creditLimit: "50000.00",
					lastFour: "1234",
					note: null,
					createdAt: new Date(),
				},
			]);

			const res = await app.request(
				"/credit-cards",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.cards).toHaveLength(1);
			expect(body.cards[0].code).toBe("BONUS_CARD");
			expect(body.limit).toBe(50);
		});

		it("GET /credit-cards/:id returns single card", async () => {
			vi.spyOn(serviceModule, "getCreditCard").mockResolvedValueOnce({
				cardId: CARD_ID,
				userId: U1,
				code: "BONUS_CARD",
				displayName: "Bonus Card",
				issuer: "Garanti BBVA",
				statementDay: 15,
				dueDay: 25,
				status: "ACTIVE",
				revisionNo: 1,
				creditLimit: "50000.00",
				lastFour: "1234",
				note: null,
				createdAt: new Date(),
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.card.cardId).toBe(CARD_ID);
		});

		it("POST /credit-cards creates a new card", async () => {
			vi.spyOn(serviceModule, "createCreditCard").mockResolvedValueOnce({
				cardId: CARD_ID,
				revisionId: "rev-1",
				revisionNo: 1,
				operation: "CREATE",
				status: "ACTIVE",
				idempotentReplay: false,
				snapshot: {
					displayName: "Bonus Card",
					issuer: "Garanti BBVA",
					statementDay: 15,
					dueDay: 25,
					creditLimit: "50000.00",
					lastFour: "1234",
					note: null,
					changeReason: null,
				},
			});

			const res = await app.request(
				"/credit-cards",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "card-create-1",
					},
					body: JSON.stringify({
						code: "BONUS_CARD",
						displayName: "Bonus Card",
						issuer: "Garanti BBVA",
						statementDay: 15,
						dueDay: 25,
						creditLimit: "50000.00",
						lastFour: "1234",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.cardId).toBe(CARD_ID);
			expect(body.revisionNo).toBe(1);
		});

		it("POST /credit-cards rejects unknown body fields", async () => {
			const res = await app.request(
				"/credit-cards",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "card-create-1",
					},
					body: JSON.stringify({
						code: "BONUS_CARD",
						displayName: "Bonus Card",
						issuer: "Garanti BBVA",
						statementDay: 15,
						dueDay: 25,
						creditLimit: "50000.00",
						occurredAt: OCCURRED_AT,
						unknownProperty: "malicious",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_INVALID_INPUT");
		});

		it("POST /credit-cards/:id updates card with OCC expectedRevisionNo", async () => {
			vi.spyOn(serviceModule, "updateCreditCard").mockResolvedValueOnce({
				cardId: CARD_ID,
				revisionId: "rev-2",
				revisionNo: 2,
				operation: "UPDATE",
				status: "ACTIVE",
				idempotentReplay: false,
				snapshot: {
					displayName: "Bonus Card Updated",
					issuer: "Garanti BBVA",
					statementDay: 15,
					dueDay: 25,
					creditLimit: "60000.00",
					lastFour: "1234",
					note: null,
					changeReason: "Limit increase",
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "card-update-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						displayName: "Bonus Card Updated",
						issuer: "Garanti BBVA",
						statementDay: 15,
						dueDay: 25,
						creditLimit: "60000.00",
						changeReason: "Limit increase",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.revisionNo).toBe(2);
		});

		it("POST /credit-cards/:id maps revision conflict to 409 CREDIT_CARD_REVISION_CONFLICT", async () => {
			vi.spyOn(serviceModule, "updateCreditCard").mockRejectedValueOnce(
				new CreditCardError("CREDIT_CARD_REVISION_CONFLICT", "Stale revision"),
			);

			const res = await app.request(
				`/credit-cards/${CARD_ID}`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "card-update-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						displayName: "Bonus Card Updated",
						issuer: "Garanti BBVA",
						statementDay: 15,
						dueDay: 25,
						creditLimit: "60000.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_REVISION_CONFLICT");
		});

		it("POST /credit-cards/:id/archive archives card", async () => {
			vi.spyOn(serviceModule, "archiveCreditCard").mockResolvedValueOnce({
				cardId: CARD_ID,
				revisionId: "rev-3",
				revisionNo: 3,
				operation: "ARCHIVE",
				status: "ARCHIVED",
				idempotentReplay: false,
				snapshot: {
					displayName: "Bonus Card",
					issuer: "Garanti BBVA",
					statementDay: 15,
					dueDay: 25,
					creditLimit: "60000.00",
					lastFour: "1234",
					note: null,
					changeReason: "Cancelled card",
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/archive`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "card-archive-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 2,
						changeReason: "Cancelled card",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.status).toBe("ARCHIVED");
		});
	});

	// --- 5. Statements Lifecycle ---
	describe("Statement endpoints", () => {
		it("GET /credit-cards/:cardId/statements returns statements", async () => {
			vi.spyOn(serviceModule, "getCreditCard").mockResolvedValueOnce({
				cardId: CARD_ID,
				userId: U1,
				code: "BONUS_CARD",
				displayName: "Bonus Card",
				issuer: "Garanti BBVA",
				statementDay: 15,
				dueDay: 25,
				status: "ACTIVE",
				revisionNo: 1,
				creditLimit: "50000.00",
				lastFour: "1234",
				note: null,
				createdAt: new Date(),
			});

			vi.spyOn(serviceModule, "listCreditCardStatements").mockResolvedValueOnce(
				[
					{
						statementId: STMT_ID,
						cardId: CARD_ID,
						userId: U1,
						cycleYear: 2026,
						cycleMonth: 9,
						status: "OPEN",
						revisionNo: 1,
						statementAmount: "1250.00",
						statementDate: "2026-09-15",
						dueDate: "2026-09-25",
						reservePlacement: "MIDAS_FUND",
						reserveAmount: "1250.00",
						reserveSatisfied: true,
						note: null,
					},
				],
			);

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.statements).toHaveLength(1);
			expect(body.statements[0].statementAmount).toBe("1250.00");
		});

		it("POST /credit-cards/:cardId/statements creates statement", async () => {
			vi.spyOn(
				serviceModule,
				"createCreditCardStatement",
			).mockResolvedValueOnce({
				statementId: STMT_ID,
				revisionId: "stmt-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				status: "OPEN",
				idempotentReplay: false,
				snapshot: {
					statementAmount: "1250.00",
					statementDate: "2026-09-15",
					dueDate: "2026-09-25",
					reservePlacement: "MIDAS_FUND",
					note: null,
					reasonNote: null,
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "stmt-create-1",
					},
					body: JSON.stringify({
						midasAccountId: MIDAS_ACC_ID,
						cycleMonth: "2026-09",
						statementAmount: "1250.00",
						reservePlacement: "MIDAS_FUND",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.statementId).toBe(STMT_ID);
		});

		it("POST /credit-cards/:cardId/statements/:id/void voids statement", async () => {
			vi.spyOn(serviceModule, "getCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				cardId: CARD_ID,
				userId: U1,
				cycleYear: 2026,
				cycleMonth: 9,
				status: "OPEN",
				revisionNo: 2,
				statementAmount: "1250.00",
				statementDate: "2026-09-15",
				dueDate: "2026-09-25",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "1250.00",
				reserveSatisfied: true,
				note: null,
			});

			vi.spyOn(serviceModule, "voidCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				revisionId: "stmt-rev-3",
				revisionNo: 3,
				operation: "VOID",
				status: "VOID",
				idempotentReplay: false,
				snapshot: {
					statementAmount: "1250.00",
					statementDate: "2026-09-15",
					dueDate: "2026-09-25",
					reservePlacement: "MIDAS_FUND",
					note: null,
					reasonNote: "Duplicate entry",
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements/${STMT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "stmt-void-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 2,
						reasonNote: "Duplicate entry",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.status).toBe("VOID");
		});
	});

	// --- 6. Payment & Reopen ---
	describe("Payment and Reopen operations", () => {
		it("POST /credit-cards/:cardId/statements/:id/pay pays statement", async () => {
			vi.spyOn(serviceModule, "getCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				cardId: CARD_ID,
				userId: U1,
				cycleYear: 2026,
				cycleMonth: 9,
				status: "OPEN",
				revisionNo: 1,
				statementAmount: "1250.00",
				statementDate: "2026-09-15",
				dueDate: "2026-09-25",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "1250.00",
				reserveSatisfied: true,
				note: null,
			});

			vi.spyOn(paymentsModule, "payCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				revisionId: "stmt-rev-4",
				revisionNo: 4,
				operation: "UPDATE",
				status: "PAID",
				idempotentReplay: false,
				snapshot: {
					statementAmount: "1250.00",
					statementDate: "2026-09-15",
					dueDate: "2026-09-25",
					reservePlacement: "MIDAS_FUND",
					note: null,
					reasonNote: null,
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements/${STMT_ID}/pay`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "pay-stmt-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						paymentAmount: "1250.00",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.status).toBe("PAID");
			expect(body.statementId).toBe(STMT_ID);
		});

		it("POST /credit-cards/:cardId/statements/:id/reopen reopens paid statement", async () => {
			vi.spyOn(serviceModule, "getCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				cardId: CARD_ID,
				userId: U1,
				cycleYear: 2026,
				cycleMonth: 9,
				status: "PAID",
				revisionNo: 4,
				statementAmount: "1250.00",
				statementDate: "2026-09-15",
				dueDate: "2026-09-25",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "1250.00",
				reserveSatisfied: true,
				note: null,
			});

			vi.spyOn(
				paymentsModule,
				"reopenCreditCardStatementPayment",
			).mockResolvedValueOnce({
				statementId: STMT_ID,
				revisionId: "stmt-rev-5",
				revisionNo: 5,
				operation: "UPDATE",
				status: "OPEN",
				idempotentReplay: false,
				snapshot: {
					statementAmount: "1250.00",
					statementDate: "2026-09-15",
					dueDate: "2026-09-25",
					reservePlacement: "MIDAS_FUND",
					note: null,
					reasonNote: "Bank bounced payment",
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements/${STMT_ID}/reopen`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "reopen-stmt-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 4,
						reasonNote: "Bank bounced payment",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.status).toBe("OPEN");
			expect(body.statementId).toBe(STMT_ID);
		});
	});

	// --- 7. Payment-Readiness & Reconciliation ---
	describe("Payment-Readiness & Reconciliation", () => {
		it("GET /credit-cards/:cardId/statements/:id/readiness returns payment readiness calculation", async () => {
			vi.spyOn(serviceModule, "getCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				cardId: CARD_ID,
				userId: U1,
				cycleYear: 2026,
				cycleMonth: 9,
				status: "OPEN",
				revisionNo: 1,
				statementAmount: "1250.00",
				statementDate: "2026-09-15",
				dueDate: "2026-09-25",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "1250.00",
				reserveSatisfied: true,
				note: null,
			});

			vi.spyOn(
				paymentsModule,
				"reconcileCreditCardStatement",
			).mockResolvedValueOnce({
				cardId: CARD_ID,
				statementId: STMT_ID,
				statementAmount: "1250.00",
				cardLiabilityBalance: "1250.00",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "1250.00",
				liabilityCoverage: "READY",
				liabilityAfterPayment: "0.00",
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements/${STMT_ID}/readiness`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.readiness.liabilityCoverage).toBe("READY");
			expect(body.readiness.statementAmount).toBe("1250.00");
		});

		it("POST /credit-cards/:cardId/statements/:id/reconcile stores explicit decomposition", async () => {
			vi.spyOn(serviceModule, "getCreditCardStatement").mockResolvedValueOnce({
				statementId: STMT_ID,
				cardId: CARD_ID,
				userId: U1,
				cycleYear: 2026,
				cycleMonth: 9,
				status: "OPEN",
				revisionNo: 1,
				statementAmount: "1250.00",
				statementDate: "2026-09-15",
				dueDate: "2026-09-25",
				reservePlacement: "MIDAS_FUND",
				reserveAmount: "1250.00",
				reserveSatisfied: true,
				note: null,
			});

			vi.spyOn(reconModule, "reconcileStatement").mockResolvedValueOnce({
				revision: {
					reconciliationId: "recon-1",
					revisionId: "recon-rev-1",
					revisionNo: 1,
					operation: "CREATE",
					statementRevisionId: "stmt-rev-1",
					reconciledStatementAmount: "1250.00",
					componentCount: 1,
					sealed: true,
					occurredAt: OCCURRED_AT,
				},
				components: [
					{
						componentNo: 1,
						componentType: "PURCHASE",
						amount: "1250.00",
						ownership: "PERSONAL",
						personId: null,
						purchaseEventId: EVENT_ID,
						purchaseSplitRevisionId: null,
						adjustmentKind: null,
						note: null,
					},
				],
				idempotentReplay: false,
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/statements/${STMT_ID}/reconcile`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "recon-1-key",
					},
					body: JSON.stringify({
						statementRevisionId: "44444444-4444-4444-8444-444444444444",
						components: [
							{
								componentNo: 1,
								componentType: "PURCHASE",
								amount: "1250.00",
								ownership: "PERSONAL",
								purchaseEventId: EVENT_ID,
							},
						],
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.revision.reconciledStatementAmount).toBe("1250.00");
			expect(body.components).toHaveLength(1);
		});
	});

	// --- 8. Unshared Purchases Lifecycle ---
	describe("Purchases endpoints", () => {
		it("POST /credit-cards/:cardId/purchases records an unshared purchase", async () => {
			vi.spyOn(
				purchasesModule,
				"recordCreditCardPurchase",
			).mockResolvedValueOnce({
				eventId: EVENT_ID,
				revisionId: "ev-rev-1",
				revisionNo: 1,
				operation: "CREATE",
				status: "POSTED",
				idempotentReplay: false,
				snapshot: {
					amount: "150.00",
					purchaseDate: "2026-09-10",
					purchaseCategory: "MANDATORY_EXPENSE",
					shortTermGoalId: null,
					merchant: "Supermarket",
					description: "Groceries",
					installmentCount: null,
					reasonNote: null,
				},
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "purch-create-1",
					},
					body: JSON.stringify({
						amount: "150.00",
						purchaseCategory: "MANDATORY_EXPENSE",
						merchant: "Supermarket",
						description: "Groceries",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.eventId).toBe(EVENT_ID);
			expect(body.status).toBe("POSTED");
		});

		it("POST /credit-cards/:cardId/purchases/:id/void voids an unshared purchase", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce({
				eventId: EVENT_ID,
				cardId: CARD_ID,
				userId: U1,
				eventType: "PURCHASE",
				status: "POSTED",
				revisionNo: 1,
				amount: "150.00",
				personalExpenseAmount: "150.00",
				externalReceivableAmount: "0.00",
				split: null,
				purchaseDate: "2026-09-10",
				purchaseCategory: "MANDATORY_EXPENSE",
				shortTermGoalId: null,
				merchant: "Supermarket",
				description: "Groceries",
				installmentCount: null,
				canonicalTransactionId: "tx-p1",
				canonicalRevisionId: "tx-p1-rev1",
				journalEntryId: "je-p1",
				createdAt: new Date(),
			});

			vi.spyOn(purchasesModule, "voidCreditCardPurchase").mockResolvedValueOnce(
				{
					eventId: EVENT_ID,
					revisionId: "ev-rev-2",
					revisionNo: 2,
					operation: "VOID",
					status: "VOID",
					idempotentReplay: false,
					snapshot: {
						amount: "150.00",
						purchaseDate: "2026-09-10",
						purchaseCategory: "MANDATORY_EXPENSE",
						shortTermGoalId: null,
						merchant: "Supermarket",
						description: "Groceries",
						installmentCount: null,
						reasonNote: "Wrong transaction",
					},
				},
			);

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "purch-void-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						reasonNote: "Wrong transaction",
						occurredAt: OCCURRED_AT,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.status).toBe("VOID");
		});
	});
});
