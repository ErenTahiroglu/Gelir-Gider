import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import * as purchasesModule from "../src/credit-cards/purchases";
import * as splitsModule from "../src/credit-cards/splits";
import * as dbClientModule from "../src/db/client";

const U1 = "11111111-1111-4111-8111-111111111111";
const CARD_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const PERSON_ID_1 = "44444444-4444-4444-8444-444444444444";
const PERSON_ID_2 = "55555555-5555-4555-8555-555555555555";
const SPLIT_ID = "66666666-6666-4666-8666-666666666666";
const OBLIGATION_ID = "77777777-7777-4777-8777-777777777777";
const OCCURRED_AT = "2026-09-10T12:34:56.789Z";
const COOKIE = "__Host-gg_session=valid-token";
const ORIGIN = "http://localhost:8787";

const mockPurchase = {
	eventId: EVENT_ID,
	cardId: CARD_ID,
	userId: U1,
	eventType: "PURCHASE" as const,
	status: "POSTED" as const,
	revisionNo: 1,
	amount: "1000.00",
	personalExpenseAmount: "500.00",
	externalReceivableAmount: "500.00",
	split: null,
	purchaseDate: "2026-09-10",
	purchaseCategory: "DISCRETIONARY_SPEND" as const,
	shortTermGoalId: null,
	merchant: "Restaurant",
	description: "Dinner",
	installmentCount: null,
	canonicalTransactionId: "tx-1",
	canonicalRevisionId: "rev-1",
	journalEntryId: "je-1",
	occurredAt: new Date(OCCURRED_AT),
	createdAt: new Date(OCCURRED_AT),
};

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

describe("Credit Card Shared Purchase & Split HTTP Surface (Checkpoint 7B.4-R1)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: mock DB
	let mockDb: any;

	beforeEach(() => {
		vi.restoreAllMocks();

		mockDb = {
			transaction: vi
				.fn()
				// biome-ignore lint/suspicious/noExplicitAny: mock DB tx
				.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
					cb(mockDb),
				),
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([]),
						// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable mock
						then: (resolve: (v: unknown[]) => void) =>
							Promise.resolve([]).then(resolve),
					}),
					// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable mock
					then: (resolve: (v: unknown[]) => void) =>
						Promise.resolve([]).then(resolve),
				}),
			}),
		};

		// biome-ignore lint/suspicious/noExplicitAny: mock DB client
		vi.spyOn(dbClientModule, "createDatabase").mockReturnValue(mockDb as any);
	});

	// --- 1. Authentication Gates ---
	describe("Authentication gates", () => {
		const routes = [
			{
				path: `/credit-cards/${CARD_ID}/purchases/shared`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split`,
				method: "GET",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split/revisions`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split/void`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/shared-revisions`,
				method: "POST",
			},
			{
				path: `/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/shared-void`,
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
		it("rejects POST /credit-cards/:cardId/purchases/shared with missing Origin header", async () => {
			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/shared`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						amount: "100.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [{ personId: PERSON_ID_1 }],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});

		it("rejects POST with mismatched Origin header", async () => {
			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/shared`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: "http://malicious.example.com",
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						amount: "100.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [{ personId: PERSON_ID_1 }],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("INVALID_ORIGIN");
		});
	});

	// --- 3. Missing Idempotency-Key ---
	describe("Idempotency key enforcement", () => {
		it("rejects POST /credit-cards/:cardId/purchases/shared without Idempotency-Key", async () => {
			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/shared`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						amount: "100.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [{ personId: PERSON_ID_1 }],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_INVALID_INPUT");
		});
	});

	// --- 4. Invalid UUIDs ---
	describe("UUID validation", () => {
		it("rejects non-UUID cardId with 400 CREDIT_CARD_INVALID_INPUT", async () => {
			const res = await app.request(
				"/credit-cards/not-a-uuid/purchases/shared",
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "test-key-1",
					},
					body: JSON.stringify({
						amount: "100.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [{ personId: PERSON_ID_1 }],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_INVALID_INPUT");
		});

		it("rejects non-UUID purchaseEventId with 400 CREDIT_CARD_INVALID_INPUT", async () => {
			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/not-a-uuid/split`,
				{
					method: "GET",
					headers: {
						Cookie: COOKIE,
					},
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_INVALID_INPUT");
		});
	});

	// --- 5. POST /credit-cards/:cardId/purchases/shared ---
	describe("POST /credit-cards/:cardId/purchases/shared", () => {
		it("successfully creates a shared purchase and returns sanitized DTOs", async () => {
			const mockRecordShared = vi
				.spyOn(purchasesModule, "recordSharedCreditCardPurchase")
				.mockResolvedValueOnce({
					purchase: {
						eventId: EVENT_ID,
						revisionId: "rev-1",
						revisionNo: 1,
						operation: "CREATE",
						status: "POSTED",
						idempotentReplay: false,
						// biome-ignore lint/suspicious/noExplicitAny: mock snapshot
						snapshot: {} as any,
					},
					split: {
						splitId: SPLIT_ID,
						userId: U1,
						purchaseEventId: EVENT_ID,
						revisionNo: 1,
						status: "ACTIVE",
						method: "EQUAL",
						grossAmount: "1000.00",
						userShareAmount: "500.00",
						externalShareAmount: "500.00",
						userWeight: null,
						occurredAt: new Date(OCCURRED_AT),
						createdAt: new Date(OCCURRED_AT),
						participants: [
							{
								participantId: "part-1",
								personId: PERSON_ID_1,
								displayName: "Bob",
								relationship: "FAMILY",
								shareAmount: "500.00",
								settledAmount: "0.00",
								remainingAmount: "500.00",
								weight: null,
								dueDate: null,
								description: null,
								personObligationId: OBLIGATION_ID,
							},
						],
					},
					idempotentReplay: false,
				});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/shared`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "shared-purch-key-1",
					},
					body: JSON.stringify({
						amount: "1000.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						description: "Dinner",
						merchant: "Restaurant",
						installmentCount: 1,
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [
							{
								personId: PERSON_ID_1,
							},
						],
					}),
				},
				mockEnv,
			);

			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: response body inspect
			const body = (await res.json()) as any;
			expect(body.idempotentReplay).toBe(false);
			expect(body.purchase.eventId).toBe(EVENT_ID);
			expect(body.split.splitId).toBe(SPLIT_ID);
			expect(body.split.grossAmount).toBe("1000.00");
			expect(body.split.userShareAmount).toBe("500.00");
			expect(body.split.externalShareAmount).toBe("500.00");
			expect(body.split.participants).toHaveLength(1);
			expect(body.split.participants[0].obligationId).toBe(OBLIGATION_ID);
			expect(body.split.participants[0].personObligationId).toBeUndefined();
			// Ensure internal fields are stripped
			expect(body.split.userId).toBeUndefined();
			expect(body.split.canonicalTransactionId).toBeUndefined();
			expect(body.split.canonicalRevisionId).toBeUndefined();
			expect(mockRecordShared).toHaveBeenCalledTimes(1);
		});

		it("rejects unknown extra fields in body (closed body enforcement)", async () => {
			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/shared`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "shared-purch-key-2",
					},
					body: JSON.stringify({
						amount: "1000.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [{ personId: PERSON_ID_1 }],
						forbiddenExtraField: "hack",
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_INVALID_INPUT");
		});

		it("maps domain CreditCardError correctly", async () => {
			vi.spyOn(
				purchasesModule,
				"recordSharedCreditCardPurchase",
			).mockRejectedValueOnce(
				new CreditCardError(
					"CREDIT_CARD_SPLIT_CONFLICT",
					"Split shares do not sum to total",
				),
			);

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/shared`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "shared-purch-key-3",
					},
					body: JSON.stringify({
						amount: "1000.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						occurredAt: OCCURRED_AT,
						splitMethod: "MANUAL",
						participants: [{ personId: PERSON_ID_1, shareAmount: "400.00" }],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_SPLIT_CONFLICT");
		});
	});

	// --- 6. GET /credit-cards/:cardId/purchases/:purchaseEventId/split ---
	describe("GET /credit-cards/:cardId/purchases/:purchaseEventId/split", () => {
		it("returns 404 when split is not found", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce(
				mockPurchase,
			);
			vi.spyOn(
				splitsModule,
				"getCreditCardPurchaseSplit",
			).mockResolvedValueOnce(null);

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split`,
				{
					method: "GET",
					headers: {
						Cookie: COOKIE,
					},
				},
				mockEnv,
			);
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrBody;
			expect(body.error.code).toBe("CREDIT_CARD_SPLIT_NOT_FOUND");
		});

		it("returns sanitized split product DTO when split exists", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce(
				mockPurchase,
			);
			vi.spyOn(
				splitsModule,
				"getCreditCardPurchaseSplit",
			).mockResolvedValueOnce({
				splitId: SPLIT_ID,
				userId: U1,
				purchaseEventId: EVENT_ID,
				revisionNo: 1,
				status: "ACTIVE",
				method: "EQUAL",
				grossAmount: "1000.00",
				userShareAmount: "500.00",
				externalShareAmount: "500.00",
				userWeight: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
				participants: [
					{
						participantId: "part-1",
						personId: PERSON_ID_1,
						displayName: "Bob",
						relationship: "FAMILY",
						shareAmount: "500.00",
						settledAmount: "0.00",
						remainingAmount: "500.00",
						weight: null,
						dueDate: null,
						description: null,
						personObligationId: OBLIGATION_ID,
					},
				],
			});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split`,
				{
					method: "GET",
					headers: {
						Cookie: COOKIE,
					},
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: response body inspect
			const body = (await res.json()) as any;
			expect(body.split.splitId).toBe(SPLIT_ID);
			expect(body.split.grossAmount).toBe("1000.00");
			expect(body.split.participants[0].obligationId).toBe(OBLIGATION_ID);
			expect(body.split.participants[0].personObligationId).toBeUndefined();
			expect(body.split.userId).toBeUndefined();
			expect(body.split.canonicalTransactionId).toBeUndefined();
		});
	});

	// --- 7. Split Mutations (Revisions, Void, Coordinated) ---
	describe("Split mutations", () => {
		it("POST /split/revisions invokes updateCreditCardPurchaseSplit", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce(
				mockPurchase,
			);
			vi.spyOn(
				splitsModule,
				"getCreditCardPurchaseSplit",
			).mockResolvedValueOnce({
				splitId: SPLIT_ID,
				userId: U1,
				purchaseEventId: EVENT_ID,
				revisionNo: 1,
				status: "ACTIVE",
				method: "EQUAL",
				grossAmount: "1000.00",
				userShareAmount: "500.00",
				externalShareAmount: "500.00",
				userWeight: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
				participants: [],
			});
			const mockUpd = vi
				.spyOn(splitsModule, "updateCreditCardPurchaseSplit")
				.mockResolvedValueOnce({
					split: {
						splitId: SPLIT_ID,
						userId: U1,
						purchaseEventId: EVENT_ID,
						revisionNo: 2,
						status: "ACTIVE",
						method: "EQUAL",
						grossAmount: "1000.00",
						userShareAmount: "333.34",
						externalShareAmount: "666.66",
						userWeight: null,
						occurredAt: new Date(OCCURRED_AT),
						createdAt: new Date(OCCURRED_AT),
						participants: [
							{
								participantId: "part-1",
								personId: PERSON_ID_1,
								displayName: "Bob",
								relationship: "FAMILY",
								shareAmount: "333.33",
								settledAmount: "0.00",
								remainingAmount: "333.33",
								weight: null,
								dueDate: null,
								description: null,
								personObligationId: OBLIGATION_ID,
							},
							{
								participantId: "part-2",
								personId: PERSON_ID_2,
								displayName: "Charlie",
								relationship: "OTHER",
								shareAmount: "333.33",
								settledAmount: "0.00",
								remainingAmount: "333.33",
								weight: null,
								dueDate: null,
								description: null,
								personObligationId: "88888888-8888-4888-8888-888888888888",
							},
						],
					},
					idempotentReplay: false,
				});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split/revisions`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "split-rev-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
						splitMethod: "EQUAL",
						participants: [
							{ personId: PERSON_ID_1 },
							{ personId: PERSON_ID_2 },
						],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: response body inspect
			const body = (await res.json()) as any;
			expect(body.split.revisionNo).toBe(2);
			expect(body.split.participants).toHaveLength(2);
			expect(mockUpd).toHaveBeenCalledTimes(1);
		});

		it("POST /split/void invokes voidCreditCardPurchaseSplit", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce(
				mockPurchase,
			);
			vi.spyOn(
				splitsModule,
				"getCreditCardPurchaseSplit",
			).mockResolvedValueOnce({
				splitId: SPLIT_ID,
				userId: U1,
				purchaseEventId: EVENT_ID,
				revisionNo: 1,
				status: "ACTIVE",
				method: "EQUAL",
				grossAmount: "1000.00",
				userShareAmount: "500.00",
				externalShareAmount: "500.00",
				userWeight: null,
				occurredAt: new Date(OCCURRED_AT),
				createdAt: new Date(OCCURRED_AT),
				participants: [],
			});
			const mockVoid = vi
				.spyOn(splitsModule, "voidCreditCardPurchaseSplit")
				.mockResolvedValueOnce({
					split: {
						splitId: SPLIT_ID,
						userId: U1,
						purchaseEventId: EVENT_ID,
						revisionNo: 2,
						status: "VOID",
						method: "EQUAL",
						grossAmount: "1000.00",
						userShareAmount: "1000.00",
						externalShareAmount: "0.00",
						userWeight: null,
						occurredAt: new Date(OCCURRED_AT),
						createdAt: new Date(OCCURRED_AT),
						participants: [],
					},
					idempotentReplay: false,
				});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/split/void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "split-void-key-1",
					},
					body: JSON.stringify({
						expectedRevisionNo: 1,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: response body inspect
			const body = (await res.json()) as any;
			expect(body.split.status).toBe("VOID");
			expect(mockVoid).toHaveBeenCalledTimes(1);
		});

		it("POST /shared-revisions invokes updateCreditCardPurchaseWithSplit", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce(
				mockPurchase,
			);
			const mockSharedRev = vi
				.spyOn(purchasesModule, "updateCreditCardPurchaseWithSplit")
				.mockResolvedValueOnce({
					purchase: {
						eventId: EVENT_ID,
						revisionId: "rev-2",
						revisionNo: 2,
						operation: "UPDATE",
						status: "POSTED",
						idempotentReplay: false,
						// biome-ignore lint/suspicious/noExplicitAny: mock snapshot
						snapshot: {} as any,
					},
					split: {
						splitId: SPLIT_ID,
						userId: U1,
						purchaseEventId: EVENT_ID,
						revisionNo: 2,
						status: "ACTIVE",
						method: "EQUAL",
						grossAmount: "1200.00",
						userShareAmount: "600.00",
						externalShareAmount: "600.00",
						userWeight: null,
						occurredAt: new Date(OCCURRED_AT),
						createdAt: new Date(OCCURRED_AT),
						participants: [
							{
								participantId: "part-1",
								personId: PERSON_ID_1,
								displayName: "Bob",
								relationship: "FAMILY",
								shareAmount: "600.00",
								settledAmount: "0.00",
								remainingAmount: "600.00",
								weight: null,
								dueDate: null,
								description: null,
								personObligationId: OBLIGATION_ID,
							},
						],
					},
					idempotentReplay: false,
				});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/shared-revisions`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "shared-rev-key-1",
					},
					body: JSON.stringify({
						expectedPurchaseRevisionNo: 1,
						expectedSplitRevisionNo: 1,
						amount: "1200.00",
						purchaseCategory: "DISCRETIONARY_SPEND",
						description: "Dinner updated",
						merchant: "Restaurant",
						installmentCount: 1,
						occurredAt: OCCURRED_AT,
						splitMethod: "EQUAL",
						participants: [{ personId: PERSON_ID_1 }],
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: response body inspect
			const body = (await res.json()) as any;
			expect(body.purchase.eventId).toBe(EVENT_ID);
			expect(body.split.grossAmount).toBe("1200.00");
			expect(mockSharedRev).toHaveBeenCalledTimes(1);
		});

		it("POST /shared-void invokes voidCreditCardPurchaseWithSplit", async () => {
			vi.spyOn(purchasesModule, "getCreditCardPurchase").mockResolvedValueOnce(
				mockPurchase,
			);
			const mockSharedVoid = vi
				.spyOn(purchasesModule, "voidCreditCardPurchaseWithSplit")
				.mockResolvedValueOnce({
					purchase: {
						eventId: EVENT_ID,
						revisionId: "rev-2",
						revisionNo: 2,
						operation: "VOID",
						status: "VOID",
						idempotentReplay: false,
						// biome-ignore lint/suspicious/noExplicitAny: mock snapshot
						snapshot: {} as any,
					},
					split: {
						splitId: SPLIT_ID,
						userId: U1,
						purchaseEventId: EVENT_ID,
						revisionNo: 2,
						status: "VOID",
						method: "EQUAL",
						grossAmount: "1000.00",
						userShareAmount: "1000.00",
						externalShareAmount: "0.00",
						userWeight: null,
						occurredAt: new Date(OCCURRED_AT),
						createdAt: new Date(OCCURRED_AT),
						participants: [],
					},
					idempotentReplay: false,
				});

			const res = await app.request(
				`/credit-cards/${CARD_ID}/purchases/${EVENT_ID}/shared-void`,
				{
					method: "POST",
					headers: {
						Cookie: COOKIE,
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"Idempotency-Key": "shared-void-key-1",
					},
					body: JSON.stringify({
						expectedPurchaseRevisionNo: 1,
						expectedSplitRevisionNo: 1,
					}),
				},
				mockEnv,
			);
			expect(res.status).toBe(200);
			// biome-ignore lint/suspicious/noExplicitAny: response body inspect
			const body = (await res.json()) as any;
			expect(body.purchase.status).toBe("VOID");
			expect(body.split.status).toBe("VOID");
			expect(mockSharedVoid).toHaveBeenCalledTimes(1);
		});
	});
});
