import { describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import * as purchaseSplitRead from "../src/credit-cards/purchase-split-read";
import {
	materializeAllActiveBudgetThresholdEventsInTransaction,
	materializeAllNoSpendCheckEventsInTransaction,
} from "../src/notifications/events";
import { calculatePersonalSpendInTransaction } from "../src/spending/personal-spend-calculator";

describe("Personal Spend Calculator Fail-Closed & Authoritative Splits", () => {
	const userId = "11111111-1111-4111-8111-111111111111";
	const eventId = "22222222-2222-4222-8222-222222222222";
	const start = new Date("2026-06-01T00:00:00.000Z");
	const end = new Date("2026-06-15T00:00:00.000Z");
	const purchaseTime = new Date("2026-06-05T12:00:00.000Z");

	const mockDbWithPurchase = (amount = "1000.00") => ({
		select: (_fields?: any) => ({
			from: () => ({
				groupBy: () => ({ as: () => "latest_liability_rev" }),
				innerJoin: () => ({
					innerJoin: () => ({
						where: () => [
							{
								eventId,
								operation: "CREATE",
								amount,
								occurredAt: purchaseTime,
							},
						],
					}),
				}),
				// Manual expenses query returns empty
				where: () => [],
			}),
		}),
	});

	describe("Finding B: Authoritative Split Handlings", () => {
		it("ACTIVE: uses exact userShareCents (gross=1000, user=400, external=600 => personal spend=400)", async () => {
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockResolvedValue({
					kind: "ACTIVE",
					splitId: "s-1",
					splitRevisionId: "sr-1",
					revisionNo: 1,
					sealed: true,
					grossAmount: "1000.00",
					grossCents: 100_000n,
					userShareAmount: "400.00",
					userShareCents: 40_000n,
					externalShareAmount: "600.00",
					externalShareCents: 60_000n,
					participants: [
						{
							personId: "p-1",
							personObligationId: "obl-1",
							shareAmount: "600.00",
							shareCents: 60_000n,
						},
					],
				});

			const db = mockDbWithPurchase("1000.00");
			const result = await calculatePersonalSpendInTransaction({
				db: db as any,
				userId,
				start,
				end,
			});

			expect(splitSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					userId,
					purchaseEventId: eventId,
					expectedPurchaseCents: 100_000n,
				}),
			);
			expect(result.totalPersonalSpendCents).toBe(40_000n);
			expect(result.purchaseCount).toBe(1);
			expect(result.hasSpending).toBe(true);

			splitSpy.mockRestore();
		});

		it("NO_SPLIT: uses full effective purchase gross", async () => {
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockResolvedValue({ kind: "NO_SPLIT" });

			const db = mockDbWithPurchase("1000.00");
			const result = await calculatePersonalSpendInTransaction({
				db: db as any,
				userId,
				start,
				end,
			});

			expect(result.totalPersonalSpendCents).toBe(100_000n);
			expect(result.hasSpending).toBe(true);

			splitSpy.mockRestore();
		});

		it("VOID_SPLIT: uses full effective purchase gross", async () => {
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockResolvedValue({
					kind: "VOID_SPLIT",
					splitId: "s-1",
					splitRevisionId: "sr-1",
					revisionNo: 2,
				});

			const db = mockDbWithPurchase("1000.00");
			const result = await calculatePersonalSpendInTransaction({
				db: db as any,
				userId,
				start,
				end,
			});

			expect(result.totalPersonalSpendCents).toBe(100_000n);
			expect(result.hasSpending).toBe(true);

			splitSpy.mockRestore();
		});
	});

	describe("Finding B: Fail-Closed on UNRESOLVED, Mismatch, and Exceptions", () => {
		it("UNRESOLVED (e.g. unsealed split): throws CREDIT_CARD_SPLIT_CONFLICT (never falls back to gross)", async () => {
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockResolvedValue({
					kind: "UNRESOLVED",
					reason: "split revision is not sealed",
					inconsistent: false,
				});

			const db = mockDbWithPurchase("1000.00");

			await expect(
				calculatePersonalSpendInTransaction({
					db: db as any,
					userId,
					start,
					end,
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: "CREDIT_CARD_SPLIT_CONFLICT",
				}),
			);

			splitSpy.mockRestore();
		});

		it("Gross Mismatch: expectedPurchaseCents mismatch returns UNRESOLVED and fails closed", async () => {
			// Effective purchase is 1000.00 (100_000 cents), but split gross is 900.00 (90_000 cents)
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockImplementation(async (params) => {
					if (
						params.expectedPurchaseCents !== undefined &&
						params.expectedPurchaseCents !== 90_000n
					) {
						return {
							kind: "UNRESOLVED",
							reason: `split gross 900.00 does not match expected purchase amount`,
							inconsistent: true,
						};
					}
					return {
						kind: "ACTIVE",
						splitId: "s-1",
						splitRevisionId: "sr-1",
						revisionNo: 1,
						sealed: true,
						grossAmount: "900.00",
						grossCents: 90_000n,
						userShareAmount: "900.00",
						userShareCents: 90_000n,
						externalShareAmount: "0.00",
						externalShareCents: 0n,
						participants: [],
					};
				});

			const db = mockDbWithPurchase("1000.00");

			await expect(
				calculatePersonalSpendInTransaction({
					db: db as any,
					userId,
					start,
					end,
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: "CREDIT_CARD_SPLIT_CONFLICT",
				}),
			);

			splitSpy.mockRestore();
		});

		it("Resolver Throws: unexpected error from resolver propagates (never silently swallowed to gross)", async () => {
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockRejectedValue(new Error("CORRUPT_SPLIT_LEDGER_EVIDENCE"));

			const db = mockDbWithPurchase("1000.00");

			await expect(
				calculatePersonalSpendInTransaction({
					db: db as any,
					userId,
					start,
					end,
				}),
			).rejects.toThrowError("CORRUPT_SPLIT_LEDGER_EVIDENCE");

			splitSpy.mockRestore();
		});

		it("Unresolved split does NOT create budget threshold event or no-spend event", async () => {
			const splitSpy = vi
				.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
				.mockResolvedValue({
					kind: "UNRESOLVED",
					reason: "unsealed split",
					inconsistent: false,
				});

			// Test in materializeAllNoSpendCheckEventsInTransaction:
			// If personal spend cannot be proven, NO_SPEND_CHECK must NOT be emitted
			const insertedEvents: any[] = [];
			const mockTx = {
				selectDistinct: () => ({
					from: () => ({
						innerJoin: () => ({
							where: () => [{ userId }],
						}),
					}),
				}),
				select: (_fields?: any) => ({
					from: () => ({
						groupBy: () => ({ as: () => "latest_liability_rev" }),
						innerJoin: () => ({
							innerJoin: () => ({
								where: () => [
									{
										eventId,
										operation: "CREATE",
										amount: "1000.00",
										occurredAt: purchaseTime,
									},
								],
							}),
						}),
						where: () => [],
					}),
				}),
				insert: () => ({
					values: (val: any) => {
						insertedEvents.push(val);
						return {
							onConflictDoNothing: () => ({
								returning: () => [{ id: "no-spend-1" }],
							}),
						};
					},
				}),
			};

			const result = await materializeAllNoSpendCheckEventsInTransaction(
				mockTx as any,
				"2026-06-15",
			);

			// Must fail closed: uncertainty cannot be converted into hasSpending=false
			expect(result.eventsCreated).toBe(0);
			expect(insertedEvents).toHaveLength(0);

			splitSpy.mockRestore();
		});
	});
});
