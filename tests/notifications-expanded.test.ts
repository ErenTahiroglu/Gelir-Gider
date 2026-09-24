import { describe, expect, it, vi } from "vitest";
import {
	getNextDayIstanbul,
	getPreviousDayIstanbul,
	istanbulLocalHourToUtcInstant,
} from "../src/notifications/calendar";
import {
	buildBudgetThresholdPayload,
	buildCreditCardDuePayload,
	buildCreditCardDueSoonPayload,
	buildNoSpendCheckPayload,
	materializeBudgetThresholdEventInTransaction,
	materializeNoSpendCheckEventInTransaction,
} from "../src/notifications/events";

describe("Notifications V1 Expansion & Privacy", () => {
	describe("Privacy-Safe Payloads", () => {
		it("CREDIT_CARD_DUE payload never exposes financial balance or limit", () => {
			const payload = buildCreditCardDuePayload({
				statementId: "stmt-123",
				creditCardId: "card-456",
				dueDate: "2026-09-24",
			});

			expect(payload.data.type).toBe("CREDIT_CARD_DUE");
			expect(payload.data.statementId).toBe("stmt-123");
			expect(payload.data.dueDate).toBe("2026-09-24");
			// Check privacy: title and body do not reveal card amounts
			expect(payload.title).not.toMatch(/\d+(\.\d{2})?\s*TL/);
			expect(payload.body).not.toMatch(/\d+(\.\d{2})?\s*TL/);
			expect(payload.data.deepLink).toBe("/credit-cards/statements/stmt-123");
		});

		it("CREDIT_CARD_DUE_SOON payload warns 1 day prior without financial amounts", () => {
			const payload = buildCreditCardDueSoonPayload({
				statementId: "stmt-123",
				creditCardId: "card-456",
				dueDate: "2026-09-25",
			});

			expect(payload.data.type).toBe("CREDIT_CARD_DUE_SOON");
			expect(payload.data.statementId).toBe("stmt-123");
			expect(payload.body).toContain("Yarın");
			expect(payload.title).not.toMatch(/\d+(\.\d{2})?\s*TL/);
		});

		it("BUDGET_THRESHOLD payload contains sanitized message", () => {
			const payload = buildBudgetThresholdPayload({
				periodMonth: "2026-09",
				thresholdCents: "500000",
			});

			expect(payload.data.type).toBe("BUDGET_THRESHOLD");
			expect(payload.data.periodMonth).toBe("2026-09");
			expect(payload.data.thresholdCents).toBe("500000");
			expect(payload.data.deepLink).toBe("/budget");
		});

		it("NO_SPEND_CHECK payload contains neutral inquiry", () => {
			const payload = buildNoSpendCheckPayload({
				localDate: "2026-09-24",
			});

			expect(payload.data.type).toBe("NO_SPEND_CHECK");
			expect(payload.data.localDate).toBe("2026-09-24");
			expect(payload.body).toContain("Bugün hiç harcama yaptın mı?");
			expect(payload.data.deepLink).toBe("/");
		});
	});

	describe("Calendar Helpers for Scheduling", () => {
		it("computes accurate UTC instant from Istanbul local hour", () => {
			// Istanbul is UTC+3 permanently (no DST)
			// 10:00 Istanbul is 07:00 UTC
			const utc10 = istanbulLocalHourToUtcInstant("2026-09-24", 10);
			expect(utc10.toISOString()).toBe("2026-09-24T07:00:00.000Z");

			// 22:00 Istanbul is 19:00 UTC
			const utc22 = istanbulLocalHourToUtcInstant("2026-09-24", 22);
			expect(utc22.toISOString()).toBe("2026-09-24T19:00:00.000Z");
		});

		it("computes previous and next days accurately in Istanbul timezone", () => {
			expect(getNextDayIstanbul("2026-09-24")).toBe("2026-09-25");
			expect(getPreviousDayIstanbul("2026-09-24")).toBe("2026-09-23");
			// Month transition
			expect(getNextDayIstanbul("2026-09-30")).toBe("2026-10-01");
			expect(getPreviousDayIstanbul("2026-10-01")).toBe("2026-09-30");
		});
	});

	describe("Catch-up Collapse & Materialization", () => {
		it("skips budget threshold if current spend is within budget", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: mock tx
			const mockTx = {} as any;
			const res = await materializeBudgetThresholdEventInTransaction(mockTx, {
				userId: "u-1",
				periodMonth: "2026-09",
				currentSpendCents: 100000n,
				budgetCents: 200000n,
				localDate: "2026-09-24",
			});

			expect(res.eventsCreated).toBe(0);
		});

		it("materializes collapsed budget threshold when limit exceeded", async () => {
			const insertedRows: any[] = [];
			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => ({
							limit: () => Promise.resolve([]), // no existing
						}),
					}),
				}),
				insert: () => ({
					values: (val: any) => {
						insertedRows.push(val);
						return {
							onConflictDoNothing: () => ({
								returning: () => Promise.resolve([{ id: "ev-1" }]),
							}),
						};
					},
				}),
			};

			// Budget = 10,000 TRY (1,000,000 cents), Spend = 22,000 TRY (2,200,000 cents)
			// Delta = 1,200,000 cents, step = 500,000 cents (5000 TRY)
			// Steps crossed = 2 (10k -> 15k, 20k)
			// Highest threshold = 20,000 TRY (2,000,000 cents)
			const res = await materializeBudgetThresholdEventInTransaction(
				mockTx as any,
				{
					userId: "u-1",
					periodMonth: "2026-09",
					currentSpendCents: 2200000n,
					budgetCents: 1000000n,
					localDate: "2026-09-24",
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(insertedRows.length).toBeGreaterThanOrEqual(1);
			const activeEvent = insertedRows[0];
			expect(activeEvent.dedupeKey).toBe("BUDGET:2026-09:2000000");
			expect(activeEvent.notificationType).toBe("BUDGET_THRESHOLD");
		});

		it("skips NO_SPEND_CHECK if user had spending today", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: mock tx
			const mockTx = {} as any;
			const res = await materializeNoSpendCheckEventInTransaction(mockTx, {
				userId: "u-1",
				localDate: "2026-09-24",
				hasSpending: true,
			});

			expect(res.eventsCreated).toBe(0);
		});

		it("materializes NO_SPEND_CHECK if user had zero spending today", async () => {
			let inserted: any = null;
			const mockTx = {
				insert: () => ({
					values: (val: any) => {
						inserted = val;
						return {
							onConflictDoNothing: () => ({
								returning: () => Promise.resolve([{ id: "ev-no-spend" }]),
							}),
						};
					},
				}),
			};

			const res = await materializeNoSpendCheckEventInTransaction(
				mockTx as any,
				{
					userId: "u-1",
					localDate: "2026-09-24",
					hasSpending: false,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted.dedupeKey).toBe("NO_SPEND:2026-09-24");
			expect(inserted.notificationType).toBe("NO_SPEND_CHECK");
		});
	});
});
