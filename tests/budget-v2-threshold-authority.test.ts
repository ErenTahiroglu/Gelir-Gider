import { describe, expect, it, vi } from "vitest";
import * as liveResolverV2 from "../src/budget/live-resolver-v2";
import {
	buildBudgetThresholdPayload,
	materializeAllActiveBudgetThresholdEventsInTransaction,
	materializeBudgetThresholdEventInTransaction,
} from "../src/notifications/events";
import * as personalSpendCalc from "../src/spending/personal-spend-calculator";

describe("Budget V2 Threshold Authority & Exact B Boundary", () => {
	const localDate = "2026-06-15";
	const periodMonth = "2026-06";
	const userId = "11111111-1111-4111-8111-111111111111";
	const scheduledAt = new Date("2026-06-15T07:00:00.000Z"); // 10:00 Istanbul

	describe("Finding A: Budget V2 Authority (V1 is NOT used)", () => {
		it("calculates B solely from Budget V2 inputs and outputs, ignoring V1 ceilings completely", async () => {
			// Budget V2 resolution mock values
			// currentObligations = 2,000.00 TRY (200,000 cents)
			// basicLivingFunding = 5,000.00 TRY (500,000 cents)
			// dateBoundNecessary = 1,000.00 TRY (100,000 cents)
			// discretionaryAllocation = 2,000.00 TRY (200,000 cents)
			// Authoritative B = 200k + 500k + 100k + 200k = 1,000,000 cents = 10,000.00 TRY
			const v2ResolutionMock = {
				policyResult: {
					inputs: {
						currentObligations: { cents: 200_000n, amount: "2000.00" },
						basicLivingFunding: { cents: 500_000n, amount: "5000.00" },
						dateBoundNecessaryPurchaseFunding: {
							cents: 100_000n,
							amount: "1000.00",
						},
					},
					outputs: {
						discretionaryAllocation: { cents: 200_000n, amount: "2000.00" },
					},
				},
			};

			const resolveSpy = vi
				.spyOn(liveResolverV2, "resolveBudgetV2LiveSnapshot")
				// biome-ignore lint/suspicious/noExplicitAny: mock resolution
				.mockResolvedValue(v2ResolutionMock as any);

			// Spend = 10,000.01 TRY (1,000,001 cents) -> strictly over B (10,000.00 TRY)
			const spendSpy = vi
				.spyOn(personalSpendCalc, "calculatePersonalSpendInTransaction")
				.mockResolvedValue({
					totalPersonalSpendCents: 1_000_001n,
					purchaseCount: 1,
					manualExpenseCount: 0,
					hasSpending: true,
				});

			const insertedEvents: any[] = [];
			const mockTx = {
				select: (_fields?: any) => ({
					from: (table?: any) => ({
						groupBy: () => ({ as: () => "latest_v2_plan_rev" }),
						innerJoin: () => ({
							innerJoin: () => ({
								where: () => [
									{
										userId,
										budgetPlanId: "plan-v2-1",
									},
								],
							}),
						}),
						where: () => [], // for existing events query
					}),
				}),
				insert: (table: any) => ({
					values: (val: any) => {
						insertedEvents.push(val);
						return {
							onConflictDoNothing: () => ({
								returning: () => [{ id: "event-b-1" }],
							}),
						};
					},
				}),
			};

			const result =
				await materializeAllActiveBudgetThresholdEventsInTransaction(
					mockTx as any,
					localDate,
					scheduledAt,
				);

			expect(resolveSpy).toHaveBeenCalledWith({
				db: mockTx,
				userId,
				periodMonth,
				asOf: scheduledAt,
			});
			expect(spendSpy).toHaveBeenCalled();
			expect(result.eventsCreated).toBe(1);
			expect(insertedEvents).toHaveLength(1);
			// Dedupe key must be BUDGET:2026-06:1000000 (cents of B = 1,000,000)
			expect(insertedEvents[0].dedupeKey).toBe("BUDGET:2026-06:1000000");

			resolveSpy.mockRestore();
			spendSpy.mockRestore();
		});

		it("fails closed when Budget V2 resolver fails, creating 0 threshold events", async () => {
			const resolveSpy = vi
				.spyOn(liveResolverV2, "resolveBudgetV2LiveSnapshot")
				.mockRejectedValue(new Error("BUDGET_RESOLVER_FAIL_CLOSED"));

			const mockTx = {
				select: (_fields?: any) => ({
					from: () => ({
						groupBy: () => ({ as: () => "latest_v2_plan_rev" }),
						innerJoin: () => ({
							innerJoin: () => ({
								where: () => [{ userId, budgetPlanId: "plan-v2-1" }],
							}),
						}),
					}),
				}),
			};

			const result =
				await materializeAllActiveBudgetThresholdEventsInTransaction(
					mockTx as any,
					localDate,
					scheduledAt,
				);

			expect(result.eventsCreated).toBe(0);
			resolveSpy.mockRestore();
		});
	});

	describe("Finding A: Exact B Boundaries", () => {
		const B = 1_000_000n; // 10,000.00 TRY

		const createMockTxWithExisting = (existingDedupeKeys: string[] = []) => {
			const inserted: any[] = [];
			return {
				inserted,
				tx: {
					select: () => ({
						from: () => ({
							where: () => existingDedupeKeys.map((k) => ({ dedupeKey: k })),
						}),
					}),
					insert: () => ({
						values: (val: any) => {
							inserted.push(val);
							return {
								onConflictDoNothing: () => ({
									returning: () => [{ id: "ev-1" }],
								}),
							};
						},
					}),
				},
			};
		};

		it("S == B: emits NO event", async () => {
			const { tx, inserted } = createMockTxWithExisting();
			const res = await materializeBudgetThresholdEventInTransaction(
				tx as any,
				{
					userId,
					periodMonth,
					currentSpendCents: B,
					budgetCents: B,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(0);
			expect(inserted).toHaveLength(0);
		});

		it("S == B + 0.01: emits first threshold event at B", async () => {
			const { tx, inserted } = createMockTxWithExisting();
			const res = await materializeBudgetThresholdEventInTransaction(
				tx as any,
				{
					userId,
					periodMonth,
					currentSpendCents: B + 1n,
					budgetCents: B,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted).toHaveLength(1);
			expect(inserted[0].dedupeKey).toBe(
				`BUDGET:${periodMonth}:${B.toString()}`,
			);
		});

		it("S == B + 4,999.99: still emits only first threshold at B (if not previously emitted)", async () => {
			const { tx, inserted } = createMockTxWithExisting();
			const res = await materializeBudgetThresholdEventInTransaction(
				tx as any,
				{
					userId,
					periodMonth,
					currentSpendCents: B + 499_999n,
					budgetCents: B,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted[0].dedupeKey).toBe(
				`BUDGET:${periodMonth}:${B.toString()}`,
			);
		});

		it("S == B + 4,999.99: emits NO new event if B was already emitted", async () => {
			const { tx, inserted } = createMockTxWithExisting([
				`BUDGET:${periodMonth}:${B.toString()}`,
			]);
			const res = await materializeBudgetThresholdEventInTransaction(
				tx as any,
				{
					userId,
					periodMonth,
					currentSpendCents: B + 499_999n,
					budgetCents: B,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(0);
			expect(inserted).toHaveLength(0);
		});

		it("S == B + 5,000.00: emits B + 5,000 highest threshold", async () => {
			const expectedThreshold = B + 500_000n; // 15,000.00 TRY
			const { tx, inserted } = createMockTxWithExisting([
				`BUDGET:${periodMonth}:${B.toString()}`,
			]);
			const res = await materializeBudgetThresholdEventInTransaction(
				tx as any,
				{
					userId,
					periodMonth,
					currentSpendCents: expectedThreshold,
					budgetCents: B,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted[0].dedupeKey).toBe(
				`BUDGET:${periodMonth}:${expectedThreshold.toString()}`,
			);
		});

		it("single jump from below B to B + 15,000: emits ONLY highest newly crossed threshold (B + 15,000)", async () => {
			const jumpSpend = B + 1_500_000n; // 25,000.00 TRY (crossed B, B+5k, B+10k, B+15k)
			const expectedHighest = B + 1_500_000n;
			const { tx, inserted } = createMockTxWithExisting();
			const res = await materializeBudgetThresholdEventInTransaction(
				tx as any,
				{
					userId,
					periodMonth,
					currentSpendCents: jumpSpend,
					budgetCents: B,
					localDate,
				},
			);

			expect(res.eventsCreated).toBe(1);
			expect(inserted).toHaveLength(1);
			// Exactly the single highest newly crossed threshold event is created
			expect(inserted[0].dedupeKey).toBe(
				`BUDGET:${periodMonth}:${expectedHighest.toString()}`,
			);
		});
	});

	describe("Finding A: Payload Privacy", () => {
		it("contains NO financial amounts in title, body, or data payload", () => {
			const payload = buildBudgetThresholdPayload({ periodMonth: "2026-06" });

			expect(payload.title).not.toMatch(/[0-9]+[.,][0-9]+/);
			expect(payload.title).not.toMatch(/TL|TRY|cents|kuruş/i);

			expect(payload.body).not.toMatch(/[0-9]+[.,][0-9]+/);
			expect(payload.body).not.toMatch(/TL|TRY|cents|kuruş/i);

			expect(payload.data).toEqual({
				type: "BUDGET_THRESHOLD",
				periodMonth: "2026-06",
				deepLink: "/budget",
			});
			// Ensure no financial amounts leak in data
			expect(payload.data).not.toHaveProperty("budgetCents");
			expect(payload.data).not.toHaveProperty("thresholdCents");
			expect(payload.data).not.toHaveProperty("currentSpendCents");
		});
	});
});
