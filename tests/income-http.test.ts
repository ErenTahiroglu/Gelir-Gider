import { beforeEach, describe, expect, it, vi } from "vitest";
import * as entitlementsModule from "../src/income/entitlements";
import { IncomeError } from "../src/income/errors";
import * as productReadModule from "../src/income/product-read-v2";
import * as productSourceModule from "../src/income/product-source-v2";
import * as receiptsModule from "../src/income/receipts";
import * as referenceModule from "../src/income/reference";
import * as settlementsModule from "../src/income/settlements";
import * as sourcesModule from "../src/income/sources";

const U1 = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const ENTITLEMENT_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const ACC_ID1 = "55555555-5555-4555-8555-555555555555";
const ACC_ID2 = "66666666-6666-4666-8666-666666666666";

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

describe("Income Product HTTP Surface (Checkpoint 7B.2)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	// --- 1. Authentication Gates on All Routes ---
	describe("Authentication gates", () => {
		const routes = [
			{ path: "/income/sources", method: "GET" },
			{ path: `/income/sources/${SOURCE_ID}`, method: "GET" },
			{ path: "/income/sources", method: "POST" },
			{ path: `/income/sources/${SOURCE_ID}/archive`, method: "POST" },
			{ path: "/income/entitlements", method: "GET" },
			{ path: `/income/entitlements/${ENTITLEMENT_ID}`, method: "GET" },
			{ path: "/income/entitlements", method: "POST" },
			{
				path: `/income/entitlements/${ENTITLEMENT_ID}/revisions`,
				method: "POST",
			},
			{ path: `/income/entitlements/${ENTITLEMENT_ID}/void`, method: "POST" },
			{ path: "/income/receipts", method: "GET" },
			{ path: `/income/receipts/${RECEIPT_ID}`, method: "GET" },
			{ path: "/income/receipts", method: "POST" },
			{ path: `/income/receipts/${RECEIPT_ID}/revisions`, method: "POST" },
			{ path: `/income/receipts/${RECEIPT_ID}/void`, method: "POST" },
			{ path: `/income/receipts/${RECEIPT_ID}/settlement`, method: "GET" },
			{ path: `/income/receipts/${RECEIPT_ID}/settlement`, method: "POST" },
			{
				path: `/income/receipts/${RECEIPT_ID}/settlement/revisions`,
				method: "POST",
			},
			{ path: "/income/reference", method: "GET" },
		];

		for (const r of routes) {
			it(`rejects unauthenticated ${r.method} ${r.path}`, async () => {
				const res = await app.request(
					r.path,
					{
						method: r.method,
						headers: { Origin: ORIGIN },
					},
					mockEnv,
				);
				expect(res.status).toBe(401);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("UNAUTHENTICATED");
			});
		}
	});

	// --- 2. Same-Origin Mutation Guard on All POST Routes ---
	describe("Same-Origin mutation guard", () => {
		const mutationRoutes = [
			{ path: "/income/sources", method: "POST" },
			{ path: `/income/sources/${SOURCE_ID}/archive`, method: "POST" },
			{ path: "/income/entitlements", method: "POST" },
			{
				path: `/income/entitlements/${ENTITLEMENT_ID}/revisions`,
				method: "POST",
			},
			{ path: `/income/entitlements/${ENTITLEMENT_ID}/void`, method: "POST" },
			{ path: "/income/receipts", method: "POST" },
			{ path: `/income/receipts/${RECEIPT_ID}/revisions`, method: "POST" },
			{ path: `/income/receipts/${RECEIPT_ID}/void`, method: "POST" },
			{ path: `/income/receipts/${RECEIPT_ID}/settlement`, method: "POST" },
			{
				path: `/income/receipts/${RECEIPT_ID}/settlement/revisions`,
				method: "POST",
			},
		];

		for (const r of mutationRoutes) {
			it(`rejects missing origin on ${r.method} ${r.path}`, async () => {
				const res = await app.request(
					r.path,
					{
						method: r.method,
						headers: { Cookie: COOKIE },
					},
					mockEnv,
				);
				expect(res.status).toBe(403);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("INVALID_ORIGIN");
			});

			it(`rejects cross-origin on ${r.method} ${r.path}`, async () => {
				const res = await app.request(
					r.path,
					{
						method: r.method,
						headers: {
							Cookie: COOKIE,
							Origin: "http://attacker.example.com",
						},
					},
					mockEnv,
				);
				expect(res.status).toBe(403);
				const body = (await res.json()) as ErrBody;
				expect(body.error.code).toBe("INVALID_ORIGIN");
			});
		}
	});

	// --- 3. SOURCES Endpoints ---
	describe("Sources endpoints", () => {
		it("GET /income/sources returns bounded list and nextCursor", async () => {
			vi.spyOn(productReadModule, "listBoundedIncomeSources").mockResolvedValue(
				{
					sources: [
						{
							sourceId: SOURCE_ID,
							code: "SALARY",
							name: "Primary Salary",
							nature: "REGULAR",
							referenceMethod: "FIXED_MONTHLY",
							expectedMonthlyAmount: "50000.00",
							seasonalMonthsPerYear: null,
							rollingMedianMonths: null,
							incomeLedgerAccountId: ACC_ID1,
							activeFrom: "2026-01-01",
							activeUntil: null,
							createdAt: OCCURRED_AT,
							archivedAt: null,
						},
					],
					nextCursor: null,
				},
			);

			const res = await app.request(
				"/income/sources?limit=10&includeArchived=false",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body).toEqual({
				sources: [
					{
						sourceId: SOURCE_ID,
						code: "SALARY",
						name: "Primary Salary",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						expectedMonthlyAmount: "50000.00",
						seasonalMonthsPerYear: null,
						rollingMedianMonths: null,
						incomeLedgerAccountId: ACC_ID1,
						activeFrom: "2026-01-01",
						activeUntil: null,
						createdAt: OCCURRED_AT,
						archivedAt: null,
					},
				],
				nextCursor: null,
			});
		});

		it("GET /income/sources/:sourceId returns detail", async () => {
			vi.spyOn(sourcesModule, "getIncomeSource").mockResolvedValue({
				id: SOURCE_ID,
				userId: U1,
				code: "SALARY",
				name: "Primary Salary",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "50000.00",
				seasonalMonthsPerYear: null,
				rollingMedianMonths: null,
				incomeLedgerAccountId: ACC_ID1,
				activeFrom: "2026-01-01",
				activeUntil: null,
				createdAt: new Date(OCCURRED_AT),
				archivedAt: null,
			});

			const res = await app.request(
				`/income/sources/${SOURCE_ID}`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body).toEqual({
				sourceId: SOURCE_ID,
				code: "SALARY",
				name: "Primary Salary",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "50000.00",
				seasonalMonthsPerYear: null,
				rollingMedianMonths: null,
				incomeLedgerAccountId: ACC_ID1,
				activeFrom: "2026-01-01",
				activeUntil: null,
				createdAt: OCCURRED_AT,
				archivedAt: null,
			});
			expect(body).not.toHaveProperty("userId");
		});

		it("POST /income/sources creates source with natural replay", async () => {
			vi.spyOn(
				productSourceModule,
				"createIncomeSourceWithNaturalReplay",
			).mockResolvedValue({
				incomeSource: {
					id: SOURCE_ID,
					userId: U1,
					code: "SALARY",
					name: "Primary Salary",
					nature: "REGULAR",
					referenceMethod: "FIXED_MONTHLY",
					expectedMonthlyAmount: "50000.00",
					seasonalMonthsPerYear: null,
					rollingMedianMonths: null,
					incomeLedgerAccountId: ACC_ID1,
					activeFrom: "2026-01-01",
					activeUntil: null,
					createdAt: new Date(OCCURRED_AT),
					archivedAt: null,
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				"/income/sources",
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
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						expectedMonthlyAmount: "50000.00",
						incomeLedgerAccountId: ACC_ID1,
						activeFrom: "2026-01-01",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body).toEqual({
				sourceId: SOURCE_ID,
				code: "SALARY",
				name: "Primary Salary",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "50000.00",
				seasonalMonthsPerYear: null,
				rollingMedianMonths: null,
				incomeLedgerAccountId: ACC_ID1,
				activeFrom: "2026-01-01",
				activeUntil: null,
				createdAt: OCCURRED_AT,
				archivedAt: null,
				idempotentReplay: false,
			});
			expect(body).not.toHaveProperty("userId");
		});

		it("POST /income/sources rejects unknown body keys (closed body)", async () => {
			const res = await app.request(
				"/income/sources",
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
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						incomeLedgerAccountId: ACC_ID1,
						activeFrom: "2026-01-01",
						userId: U1, // Forbidden extra key
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INCOME_INVALID_INPUT");
		});

		it("POST /income/sources rejects numeric money amounts", async () => {
			const res = await app.request(
				"/income/sources",
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
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						expectedMonthlyAmount: 50000, // Number instead of string
						incomeLedgerAccountId: ACC_ID1,
						activeFrom: "2026-01-01",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INCOME_INVALID_INPUT");
		});

		it("POST /income/sources/:sourceId/archive archives source safely", async () => {
			vi.spyOn(sourcesModule, "archiveIncomeSource").mockResolvedValue({
				id: SOURCE_ID,
				userId: U1,
				code: "SALARY",
				name: "Primary Salary",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "50000.00",
				seasonalMonthsPerYear: null,
				rollingMedianMonths: null,
				incomeLedgerAccountId: ACC_ID1,
				activeFrom: "2026-01-01",
				activeUntil: null,
				createdAt: new Date(OCCURRED_AT),
				archivedAt: new Date(OCCURRED_AT),
			});

			const res = await app.request(
				`/income/sources/${SOURCE_ID}/archive`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
					},
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body).toEqual({
				sourceId: SOURCE_ID,
				code: "SALARY",
				name: "Primary Salary",
				nature: "REGULAR",
				referenceMethod: "FIXED_MONTHLY",
				expectedMonthlyAmount: "50000.00",
				seasonalMonthsPerYear: null,
				rollingMedianMonths: null,
				incomeLedgerAccountId: ACC_ID1,
				activeFrom: "2026-01-01",
				activeUntil: null,
				createdAt: OCCURRED_AT,
				archivedAt: OCCURRED_AT,
			});
		});
	});

	// --- 4. ENTITLEMENTS Endpoints ---
	describe("Entitlements endpoints", () => {
		it("GET /income/entitlements returns bounded list", async () => {
			vi.spyOn(
				productReadModule,
				"listBoundedIncomeEntitlements",
			).mockResolvedValue({
				entitlements: [
					{
						entitlementId: ENTITLEMENT_ID,
						sourceId: SOURCE_ID,
						sourceCode: "SALARY",
						sourceName: "Primary Salary",
						periodMonth: "2026-09-01",
						revisionNo: 1,
						status: "ACTIVE",
						amount: "50000.00",
						allocatedAmount: "0.00",
						outstandingAmount: "50000.00",
						settlementStatus: "OPEN",
						expectedReceiptOn: "2026-09-15",
						overdue: false,
						note: "September salary",
					},
				],
				nextCursor: null,
			});

			const res = await app.request(
				"/income/entitlements?limit=10&periodMonthFrom=2026-01-01&periodMonthUntil=2026-12-01",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.entitlements).toHaveLength(1);
			expect(body.entitlements[0].periodMonth).toBe("2026-09-01");
		});

		it("GET /income/entitlements rejects non-YYYY-MM-01 periodMonth", async () => {
			const res = await app.request(
				"/income/entitlements?periodMonthFrom=2026-09-15", // Not 01
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INCOME_INVALID_INPUT");
		});

		it("POST /income/entitlements requires Idempotency-Key and creates entitlement", async () => {
			vi.spyOn(entitlementsModule, "createIncomeEntitlement").mockResolvedValue(
				{
					incomeEntitlement: {
						entitlementId: ENTITLEMENT_ID,
						sourceId: SOURCE_ID,
						sourceCode: "SALARY",
						sourceName: "Primary Salary",
						periodMonth: "2026-09-01",
						revisionNo: 1,
						status: "ACTIVE",
						amount: "50000.00",
						allocatedAmount: "0.00",
						outstandingAmount: "50000.00",
						settlementStatus: "OPEN",
						expectedReceiptOn: "2026-09-15",
						overdue: false,
						note: null,
						canonicalTransactionId: "can-tx-1",
						canonicalRevisionId: "can-rev-1",
					},
					idempotentReplay: false,
				},
			);

			const res = await app.request(
				"/income/entitlements",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "ent-key-1",
					},
					body: JSON.stringify({
						sourceId: SOURCE_ID,
						periodMonth: "2026-09-01",
						amount: "50000.00",
						expectedReceiptOn: "2026-09-15",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.entitlement.entitlementId).toBe(ENTITLEMENT_ID);
			expect(body.entitlement).not.toHaveProperty("canonicalTransactionId");
			expect(body.entitlement).not.toHaveProperty("canonicalRevisionId");
			expect(body.idempotentReplay).toBe(false);
		});

		it("POST /income/entitlements/:entitlementId/revisions revises entitlement", async () => {
			vi.spyOn(entitlementsModule, "reviseIncomeEntitlement").mockResolvedValue(
				{
					incomeEntitlement: {
						entitlementId: ENTITLEMENT_ID,
						sourceId: SOURCE_ID,
						sourceCode: "SALARY",
						sourceName: "Primary Salary",
						periodMonth: "2026-09-01",
						revisionNo: 2,
						status: "ACTIVE",
						amount: "55000.00",
						allocatedAmount: "0.00",
						outstandingAmount: "55000.00",
						settlementStatus: "OPEN",
						expectedReceiptOn: "2026-09-15",
						overdue: false,
						note: "Raise",
						canonicalTransactionId: "can-tx-1",
						canonicalRevisionId: "can-rev-2",
					},
					idempotentReplay: false,
				},
			);

			const res = await app.request(
				`/income/entitlements/${ENTITLEMENT_ID}/revisions`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "ent-rev-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						amount: "55000.00",
						expectedReceiptOn: "2026-09-15",
						note: "Raise",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.entitlement.revisionNo).toBe(2);
			expect(body.entitlement.amount).toBe("55000.00");
		});

		it("POST /income/entitlements/:entitlementId/void voids entitlement", async () => {
			vi.spyOn(entitlementsModule, "voidIncomeEntitlement").mockResolvedValue({
				incomeEntitlement: {
					entitlementId: ENTITLEMENT_ID,
					sourceId: SOURCE_ID,
					sourceCode: "SALARY",
					sourceName: "Primary Salary",
					periodMonth: "2026-09-01",
					revisionNo: 2,
					status: "VOIDED",
					amount: "50000.00",
					allocatedAmount: "0.00",
					outstandingAmount: "0.00",
					settlementStatus: "VOIDED",
					expectedReceiptOn: "2026-09-15",
					overdue: false,
					note: null,
					canonicalTransactionId: "can-tx-1",
					canonicalRevisionId: "can-rev-2",
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/income/entitlements/${ENTITLEMENT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "ent-void-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						reasonNote: "Cancelled accrual",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.entitlement.status).toBe("VOIDED");
		});
	});

	// --- 5. RECEIPTS Endpoints ---
	describe("Receipts endpoints", () => {
		it("GET /income/receipts returns bounded receipts list", async () => {
			vi.spyOn(
				productReadModule,
				"listBoundedIncomeReceipts",
			).mockResolvedValue({
				receipts: [
					{
						incomeReceiptId: RECEIPT_ID,
						sourceId: SOURCE_ID,
						sourceCode: "SALARY",
						sourceName: "Primary Salary",
						status: "ACTIVE",
						revisionNo: 1,
						receivedAt: OCCURRED_AT,
						amount: "50000.00",
						destinationAccountId: ACC_ID2,
						note: "Bank transfer",
					},
				],
				nextCursor: null,
			});

			const res = await app.request(
				"/income/receipts?limit=10",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.receipts).toHaveLength(1);
			expect(body.receipts[0].amount).toBe("50000.00");
		});

		it("POST /income/receipts creates receipt with double entry", async () => {
			vi.spyOn(receiptsModule, "createIncomeReceipt").mockResolvedValue({
				incomeReceipt: {
					incomeReceiptId: RECEIPT_ID,
					sourceId: SOURCE_ID,
					sourceCode: "SALARY",
					sourceName: "Primary Salary",
					status: "ACTIVE",
					revisionNo: 1,
					receivedAt: new Date(OCCURRED_AT),
					amount: "50000.00",
					destinationAccountId: ACC_ID2,
					note: null,
					canonicalTransactionId: "can-tx-rec-1",
					canonicalRevisionId: "can-rev-rec-1",
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				"/income/receipts",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "rec-key-1",
					},
					body: JSON.stringify({
						sourceId: SOURCE_ID,
						receivedAt: OCCURRED_AT,
						amount: "50000.00",
						destinationAccountId: ACC_ID2,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.receipt.incomeReceiptId).toBe(RECEIPT_ID);
			expect(body.receipt.receivedAt).toBe(OCCURRED_AT);
			expect(body.receipt).not.toHaveProperty("canonicalTransactionId");
		});

		it("POST /income/receipts/:incomeReceiptId/revisions revises receipt", async () => {
			vi.spyOn(receiptsModule, "reviseIncomeReceipt").mockResolvedValue({
				incomeReceipt: {
					incomeReceiptId: RECEIPT_ID,
					sourceId: SOURCE_ID,
					sourceCode: "SALARY",
					sourceName: "Primary Salary",
					status: "ACTIVE",
					revisionNo: 2,
					receivedAt: new Date(OCCURRED_AT),
					amount: "52000.00",
					destinationAccountId: ACC_ID2,
					note: "Corrected amount",
					canonicalTransactionId: "can-tx-rec-1",
					canonicalRevisionId: "can-rev-rec-2",
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/income/receipts/${RECEIPT_ID}/revisions`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "rec-rev-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						receivedAt: OCCURRED_AT,
						amount: "52000.00",
						destinationAccountId: ACC_ID2,
						note: "Corrected amount",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.receipt.revisionNo).toBe(2);
			expect(body.receipt.amount).toBe("52000.00");
		});

		it("POST /income/receipts/:incomeReceiptId/void voids receipt", async () => {
			vi.spyOn(receiptsModule, "voidIncomeReceipt").mockResolvedValue({
				incomeReceipt: {
					incomeReceiptId: RECEIPT_ID,
					sourceId: SOURCE_ID,
					sourceCode: "SALARY",
					sourceName: "Primary Salary",
					status: "VOIDED",
					revisionNo: 2,
					receivedAt: new Date(OCCURRED_AT),
					amount: "50000.00",
					destinationAccountId: ACC_ID2,
					note: null,
					canonicalTransactionId: "can-tx-rec-1",
					canonicalRevisionId: "can-rev-rec-2",
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/income/receipts/${RECEIPT_ID}/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "rec-void-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.receipt.status).toBe("VOIDED");
		});
	});

	// --- 6. SETTLEMENTS Endpoints ---
	describe("Settlements endpoints", () => {
		it("GET /income/receipts/:incomeReceiptId/settlement returns allocations", async () => {
			vi.spyOn(
				settlementsModule,
				"getIncomeReceiptSettlement",
			).mockResolvedValue({
				incomeReceiptId: RECEIPT_ID,
				receiptAmount: "50000.00",
				allocatedAmount: "50000.00",
				unallocatedAmount: "0.00",
				settlementBatchId: "batch-1",
				revisionNo: 1,
				allocations: [
					{
						entitlementId: ENTITLEMENT_ID,
						periodMonth: "2026-09-01",
						entitlementAmount: "50000.00",
						allocatedAmount: "50000.00",
						entitlementOutstandingAfterAllReceipts: "0.00",
					},
				],
			});

			const res = await app.request(
				`/income/receipts/${RECEIPT_ID}/settlement`,
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body).toEqual({
				incomeReceiptId: RECEIPT_ID,
				receiptAmount: "50000.00",
				allocatedAmount: "50000.00",
				unallocatedAmount: "0.00",
				revisionNo: 1,
				allocations: [
					{
						entitlementId: ENTITLEMENT_ID,
						periodMonth: "2026-09-01",
						entitlementAmount: "50000.00",
						allocatedAmount: "50000.00",
						entitlementOutstandingAfterAllReceipts: "0.00",
					},
				],
			});
			expect(body).not.toHaveProperty("settlementBatchId");
		});

		it("POST /income/receipts/:incomeReceiptId/settlement creates settlement", async () => {
			vi.spyOn(settlementsModule, "createIncomeSettlement").mockResolvedValue({
				settlement: {
					incomeReceiptId: RECEIPT_ID,
					receiptAmount: "50000.00",
					allocatedAmount: "50000.00",
					unallocatedAmount: "0.00",
					settlementBatchId: "batch-1",
					revisionNo: 1,
					allocations: [
						{
							entitlementId: ENTITLEMENT_ID,
							periodMonth: "2026-09-01",
							entitlementAmount: "50000.00",
							allocatedAmount: "50000.00",
							entitlementOutstandingAfterAllReceipts: "0.00",
						},
					],
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/income/receipts/${RECEIPT_ID}/settlement`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "set-key-1",
					},
					body: JSON.stringify({
						allocations: [
							{ entitlementId: ENTITLEMENT_ID, amount: "50000.00" },
						],
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.settlement.allocatedAmount).toBe("50000.00");
			expect(body.settlement).not.toHaveProperty("settlementBatchId");
		});

		it("POST /income/receipts/:incomeReceiptId/settlement/revisions supports empty allocations to CLEAR", async () => {
			vi.spyOn(settlementsModule, "reviseIncomeSettlement").mockResolvedValue({
				settlement: {
					incomeReceiptId: RECEIPT_ID,
					receiptAmount: "50000.00",
					allocatedAmount: "0.00",
					unallocatedAmount: "50000.00",
					settlementBatchId: "batch-1",
					revisionNo: 2,
					allocations: [],
				},
				idempotentReplay: false,
			});

			const res = await app.request(
				`/income/receipts/${RECEIPT_ID}/settlement/revisions`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "set-rev-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						allocations: [], // Clear allocations
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body.settlement.allocatedAmount).toBe("0.00");
			expect(body.settlement.allocations).toEqual([]);
		});
	});

	// --- 7. MONTHLY REFERENCE INCOME ---
	describe("Monthly Reference Income endpoint", () => {
		it("GET /income/reference returns reference calculation", async () => {
			vi.spyOn(referenceModule, "getMonthlyReferenceIncome").mockResolvedValue({
				asOf: "2026-09-11",
				currency: "TRY",
				total: "50000.00",
				sources: [
					{
						sourceId: SOURCE_ID,
						code: "SALARY",
						name: "Primary Salary",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						referenceAmount: "50000.00",
					},
				],
			});

			const res = await app.request(
				"/income/reference?asOf=2026-09-11",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as JsonAny;
			expect(body).toEqual({
				asOf: "2026-09-11",
				currency: "TRY",
				total: "50000.00",
				sources: [
					{
						sourceId: SOURCE_ID,
						code: "SALARY",
						name: "Primary Salary",
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						referenceAmount: "50000.00",
					},
				],
			});
		});

		it("GET /income/reference rejects invalid calendar date", async () => {
			const res = await app.request(
				"/income/reference?asOf=2026-13-45",
				{
					method: "GET",
					headers: { Cookie: COOKIE },
				},
				mockEnv,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INCOME_INVALID_INPUT");
		});
	});

	// --- 8. Error Mapping & Sanitization ---
	describe("Error mapping and sanitization", () => {
		it("maps conflict error codes to 409", async () => {
			vi.spyOn(
				productSourceModule,
				"createIncomeSourceWithNaturalReplay",
			).mockRejectedValue(
				new IncomeError("INCOME_SOURCE_CODE_CONFLICT", "Source code conflict"),
			);

			const res = await app.request(
				"/income/sources",
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
						nature: "REGULAR",
						referenceMethod: "FIXED_MONTHLY",
						incomeLedgerAccountId: ACC_ID1,
						activeFrom: "2026-01-01",
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INCOME_SOURCE_CODE_CONFLICT");
		});

		it("sanitizes unexpected domain error to 500 without leaking details", async () => {
			vi.spyOn(sourcesModule, "getIncomeSource").mockRejectedValue(
				new Error("Sensitive internal database connection leak"),
			);

			const res = await app.request(
				`/income/sources/${SOURCE_ID}`,
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
