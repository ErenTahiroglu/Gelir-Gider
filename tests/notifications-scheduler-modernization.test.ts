import { describe, expect, it, vi } from "vitest";
import { istanbulLocalHourToUtcInstant } from "../src/notifications/calendar";
import {
	buildBudgetThresholdPayload,
	listEventsForLocalDateInTransaction,
	materializeBudgetThresholdEventInTransaction,
} from "../src/notifications/events";

describe("Notification Scheduler Modernization & Precision Hours", () => {
	const localDate = "2026-09-24";
	const userId = "11111111-1111-4111-8111-111111111111";

	describe("Target Delivery Hours & Query Filtering", () => {
		it("calculates exact UTC timestamps for 10:00 due-day and 22:00 due-soon", () => {
			const dueDayTime = istanbulLocalHourToUtcInstant(localDate, 10);
			const dueSoonTime = istanbulLocalHourToUtcInstant(localDate, 22);

			// Istanbul is permanently UTC+3
			expect(dueDayTime.toISOString()).toBe("2026-09-24T07:00:00.000Z");
			expect(dueSoonTime.toISOString()).toBe("2026-09-24T19:00:00.000Z");
		});

		it("filters out events scheduled for later in the day when scheduler runs early", async () => {
			const runAt09 = istanbulLocalHourToUtcInstant(localDate, 9);
			const eventAt10 = {
				id: "ev-due-10",
				userId,
				notificationType: "CREDIT_CARD_DUE",
				scheduledLocalDate: localDate,
				scheduledFor: istanbulLocalHourToUtcInstant(localDate, 10),
			};
			const eventAt22 = {
				id: "ev-soon-22",
				userId,
				notificationType: "CREDIT_CARD_DUE_SOON",
				scheduledLocalDate: localDate,
				scheduledFor: istanbulLocalHourToUtcInstant(localDate, 22),
			};

			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => ({
								limit: () => {
									// Simulate DB query applying lte(scheduledFor, scheduledAt)
									const allEvents = [eventAt10, eventAt22];
									return Promise.resolve(
										allEvents.filter((e) => e.scheduledFor <= runAt09),
									);
								},
							}),
						}),
					}),
				}),
			};

			const events = await listEventsForLocalDateInTransaction(
				mockTx as any,
				localDate,
				50,
				undefined,
				false,
				runAt09,
			);

			expect(events.length).toBe(0);
		});

		it("returns 10:00 event at 10:00 but excludes 22:00 event", async () => {
			const runAt10 = istanbulLocalHourToUtcInstant(localDate, 10);
			const eventAt10 = {
				id: "ev-due-10",
				userId,
				notificationType: "CREDIT_CARD_DUE",
				scheduledLocalDate: localDate,
				scheduledFor: istanbulLocalHourToUtcInstant(localDate, 10),
			};
			const eventAt22 = {
				id: "ev-soon-22",
				userId,
				notificationType: "CREDIT_CARD_DUE_SOON",
				scheduledLocalDate: localDate,
				scheduledFor: istanbulLocalHourToUtcInstant(localDate, 22),
			};

			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => ({
								limit: () => {
									const allEvents = [eventAt10, eventAt22];
									return Promise.resolve(
										allEvents.filter((e) => e.scheduledFor <= runAt10),
									);
								},
							}),
						}),
					}),
				}),
			};

			const events = await listEventsForLocalDateInTransaction(
				mockTx as any,
				localDate,
				50,
				undefined,
				false,
				runAt10,
			);

			expect(events.length).toBe(1);
			expect(events[0]?.id).toBe("ev-due-10");
		});

		it("returns both 10:00 and 22:00 events when scheduler runs at 22:00", async () => {
			const runAt22 = istanbulLocalHourToUtcInstant(localDate, 22);
			const eventAt10 = {
				id: "ev-due-10",
				userId,
				notificationType: "CREDIT_CARD_DUE",
				scheduledLocalDate: localDate,
				scheduledFor: istanbulLocalHourToUtcInstant(localDate, 10),
			};
			const eventAt22 = {
				id: "ev-soon-22",
				userId,
				notificationType: "CREDIT_CARD_DUE_SOON",
				scheduledLocalDate: localDate,
				scheduledFor: istanbulLocalHourToUtcInstant(localDate, 22),
			};

			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => ({
								limit: () => {
									const allEvents = [eventAt10, eventAt22];
									return Promise.resolve(
										allEvents.filter((e) => e.scheduledFor <= runAt22),
									);
								},
							}),
						}),
					}),
				}),
			};

			const events = await listEventsForLocalDateInTransaction(
				mockTx as any,
				localDate,
				50,
				undefined,
				false,
				runAt22,
			);

			expect(events.length).toBe(2);
		});
	});

	describe("Budget Threshold Emitted Privacy & Collapse without Fake Rows", () => {
		it("ensures budget threshold payload excludes exact spending or threshold amounts", () => {
			const payload = buildBudgetThresholdPayload({
				periodMonth: "2026-09",
			});

			expect(payload.data.type).toBe("BUDGET_THRESHOLD");
			expect(payload.data.periodMonth).toBe("2026-09");
			expect((payload.data as any).thresholdCents).toBeUndefined();
			expect((payload.data as any).currentSpendCents).toBeUndefined();
			expect(payload.body).toBe("Aylık bütçeni aştın.");
		});

		it("emits single highest-tier event when spending jumps across multiple 5,000 TL tiers (0 fake rows)", async () => {
			const inserted: any[] = [];
			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => Promise.resolve([]), // no previous events
					}),
				}),
				insert: () => ({
					values: (val: any) => {
						inserted.push(val);
						return {
							onConflictDoNothing: () => ({
								returning: () => Promise.resolve([{ id: "ev-budget-high" }]),
							}),
						};
					},
				}),
			};

			// Budget: 10,000 TRY (1,000,000 cents). Spend: 26,000 TRY (2,600,000 cents).
			// Delta: 16,000 TRY = 3 full 5,000 TRY steps (15k, 20k, 25k)
			// Highest threshold = 25,000 TRY (2,500,000 cents)
			const res = await materializeBudgetThresholdEventInTransaction(
				mockTx as any,
				{
					userId,
					periodMonth: "2026-09",
					currentSpendCents: 2600000n,
					budgetCents: 1000000n,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted.length).toBe(1); // EXACTLY 1 event inserted, zero fake epoch/catch-up rows
			expect(inserted[0].dedupeKey).toBe("BUDGET:2026-09:2500000");
			expect(inserted[0].scheduledLocalDate).toBe(localDate);
		});

		it("emits 0 events if spending increases but does not cross next 5,000 TL tier", async () => {
			const existingEvents = [{ dedupeKey: "BUDGET:2026-09:2500000" }];
			const inserted: any[] = [];
			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => Promise.resolve(existingEvents),
					}),
				}),
				insert: () => ({
					values: (val: any) => {
						inserted.push(val);
						return {
							onConflictDoNothing: () => ({
								returning: () => Promise.resolve([{ id: "ev-never" }]),
							}),
						};
					},
				}),
			};

			// Spend increases from 26,000 to 28,000 TRY.
			// Still under 30,000 TRY tier (25k + 5k). Highest crossed remains 25,000 TRY.
			const res = await materializeBudgetThresholdEventInTransaction(
				mockTx as any,
				{
					userId,
					periodMonth: "2026-09",
					currentSpendCents: 2800000n,
					budgetCents: 1000000n,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(0);
			expect(inserted.length).toBe(0);
		});

		it("emits new event when spending subsequently crosses next 5,000 TL tier", async () => {
			const existingEvents = [{ dedupeKey: "BUDGET:2026-09:2500000" }];
			const inserted: any[] = [];
			const mockTx = {
				select: () => ({
					from: () => ({
						where: () => Promise.resolve(existingEvents),
					}),
				}),
				insert: () => ({
					values: (val: any) => {
						inserted.push(val);
						return {
							onConflictDoNothing: () => ({
								returning: () => Promise.resolve([{ id: "ev-30k" }]),
							}),
						};
					},
				}),
			};

			// Spend reaches 31,000 TRY.
			// Crosses 30,000 TRY tier (3,000,000 cents) > previous highest (2,500,000 cents).
			const res = await materializeBudgetThresholdEventInTransaction(
				mockTx as any,
				{
					userId,
					periodMonth: "2026-09",
					currentSpendCents: 3100000n,
					budgetCents: 1000000n,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted.length).toBe(1);
			expect(inserted[0].dedupeKey).toBe("BUDGET:2026-09:3000000");
		});
	});
});
