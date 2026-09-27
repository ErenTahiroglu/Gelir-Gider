import { describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import * as purchaseSplitRead from "../src/credit-cards/purchase-split-read";
import { getSpendingSummary } from "../src/spending-categories/analytics";

describe("Spending Summary Authoritative Personal-Share Fail-Closed", () => {
	const userId = "11111111-1111-4111-8111-111111111111";
	const eventId = "22222222-2222-4222-8222-222222222222";
	const catId = "33333333-3333-4333-8333-333333333333";
	const purchaseTime = new Date("2026-09-15T12:00:00.000Z");

	// Accurate mock DB that branches by query type
	function createBranchingMockDb(options: {
		purchaseAmount?: string;
		hasPurchase?: boolean;
		manualExpenseAmount?: string;
		hasManualExpense?: boolean;
		assignPurchaseToCategory?: boolean;
	}) {
		const {
			purchaseAmount = "1000.00",
			hasPurchase = true,
			manualExpenseAmount = "250.00",
			hasManualExpense = false,
			assignPurchaseToCategory = true,
		} = options;

		let queryCount = 0;

		return {
			select: () => ({
				from: () => ({
					where: () => {
						queryCount++;
						if (queryCount === 1) {
							// userCategories query
							return {
								orderBy: () => [
									{
										id: catId,
										name: "Market & Gıda",
										sortOrder: 1,
									},
								],
							};
						}
						if (queryCount === 2) {
							// assignments query
							const assignments = [];
							if (assignPurchaseToCategory && hasPurchase) {
								assignments.push({
									subjectType: "CREDIT_CARD_PURCHASE",
									subjectId: eventId,
									categoryId: catId,
								});
							}
							if (hasManualExpense) {
								assignments.push({
									subjectType: "MANUAL_EXPENSE",
									subjectId: "tx-me-1",
									categoryId: catId,
								});
							}
							return assignments;
						}
						// Should not reach here for where()
						return [];
					},
					groupBy: () => ({ as: () => "latest_rev" }),
					innerJoin: () => ({
						innerJoin: () => ({
							where: () => {
								queryCount++;
								if (queryCount === 3) {
									// purchases query
									if (hasPurchase) {
										return [
											{
												eventId,
												operation: "CREATE",
												amount: purchaseAmount,
												occurredAt: purchaseTime,
											},
										];
									}
									return [];
								}
								if (queryCount === 4) {
									// manualExpenses query
									if (hasManualExpense) {
										return [
											{
												transactionId: "tx-me-1",
												operation: "CREATE",
												payload: { amount: manualExpenseAmount },
												occurredAt: purchaseTime,
											},
										];
									}
									return [];
								}
								return [];
							},
						}),
					}),
				}),
			}),
		} as any;
	}

	it("A. ACTIVE split: uses exact userShareCents and supplies expectedPurchaseCents", async () => {
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

		const db = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
			assignPurchaseToCategory: true,
		});

		const summary = await getSpendingSummary(db, userId, "2026-09");

		// Verify expectedPurchaseCents was passed
		expect(splitSpy).toHaveBeenCalledTimes(1);
		expect(splitSpy).toHaveBeenCalledWith({
			db,
			userId,
			purchaseEventId: eventId,
			asOf: purchaseTime,
			expectedPurchaseCents: 100_000n,
		});

		// Verify total and category aggregation use exact personal share (400.00, not gross 1000.00)
		expect(summary.totalPersonalSpending).toBe("400.00");
		expect(summary.categories).toHaveLength(1);
		expect(summary.categories[0]?.categoryId).toBe(catId);
		expect(summary.categories[0]?.amount).toBe("400.00");
		expect(summary.categories[0]?.transactionCount).toBe(1);
		expect(summary.unclassifiedAmount).toBe("0.00");
	});

	it("B. NO_SPLIT: uses exact effective gross", async () => {
		vi.spyOn(
			purchaseSplitRead,
			"resolveAuthoritativePurchaseSplitAsOf",
		).mockResolvedValue({
			kind: "NO_SPLIT",
		});

		const db = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
			assignPurchaseToCategory: false,
		});

		const summary = await getSpendingSummary(db, userId, "2026-09");

		expect(summary.totalPersonalSpending).toBe("1000.00");
		expect(summary.unclassifiedAmount).toBe("1000.00");
		expect(summary.categories).toHaveLength(0);
	});

	it("C. VOID_SPLIT: uses exact effective gross", async () => {
		vi.spyOn(
			purchaseSplitRead,
			"resolveAuthoritativePurchaseSplitAsOf",
		).mockResolvedValue({
			kind: "VOID_SPLIT",
			splitId: "s-void",
			splitRevisionId: "sr-void",
			revisionNo: 2,
		});

		const db = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
			assignPurchaseToCategory: true,
		});

		const summary = await getSpendingSummary(db, userId, "2026-09");

		expect(summary.totalPersonalSpending).toBe("1000.00");
		expect(summary.categories).toHaveLength(1);
		expect(summary.categories[0]?.amount).toBe("1000.00");
	});

	it("D. UNRESOLVED: fails closed with CreditCardError CREDIT_CARD_SPLIT_CONFLICT", async () => {
		vi.spyOn(
			purchaseSplitRead,
			"resolveAuthoritativePurchaseSplitAsOf",
		).mockResolvedValue({
			kind: "UNRESOLVED",
			reason: "ACTIVE_REVISION_NOT_FOUND",
			inconsistent: false,
		});

		const db1 = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
		});

		await expect(getSpendingSummary(db1, userId, "2026-09")).rejects.toThrow(
			CreditCardError,
		);

		const db2 = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
		});

		await expect(
			getSpendingSummary(db2, userId, "2026-09"),
		).rejects.toMatchObject({
			code: "CREDIT_CARD_SPLIT_CONFLICT",
		});
	});

	it("E. Purchase-gross mismatch: resolver returns UNRESOLVED and getSpendingSummary fails closed", async () => {
		const splitSpy = vi
			.spyOn(purchaseSplitRead, "resolveAuthoritativePurchaseSplitAsOf")
			.mockResolvedValue({
				kind: "UNRESOLVED",
				reason: "PURCHASE_AMOUNT_MISMATCH",
				inconsistent: true,
			});

		const db = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
		});

		await expect(getSpendingSummary(db, userId, "2026-09")).rejects.toThrow(
			CreditCardError,
		);
		expect(splitSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedPurchaseCents: 100_000n,
			}),
		);
	});

	it("F. Unexpected resolver exception propagates and fails closed (no swallowing into gross)", async () => {
		vi.spyOn(
			purchaseSplitRead,
			"resolveAuthoritativePurchaseSplitAsOf",
		).mockRejectedValue(new Error("Database connection dropped"));

		const db = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
		});

		await expect(getSpendingSummary(db, userId, "2026-09")).rejects.toThrow(
			"Database connection dropped",
		);
	});

	it("G. Manual expenses continue to contribute normally to spending summary", async () => {
		vi.spyOn(
			purchaseSplitRead,
			"resolveAuthoritativePurchaseSplitAsOf",
		).mockResolvedValue({
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
			participants: [],
		});

		const db = createBranchingMockDb({
			purchaseAmount: "1000.00",
			hasPurchase: true,
			manualExpenseAmount: "300.00",
			hasManualExpense: true,
			assignPurchaseToCategory: true,
		});

		const summary = await getSpendingSummary(db, userId, "2026-09");

		// Total = 400.00 (purchase user share) + 300.00 (manual expense) = 700.00
		expect(summary.totalPersonalSpending).toBe("700.00");
		expect(summary.categories).toHaveLength(1);
		expect(summary.categories[0]?.amount).toBe("700.00");
		expect(summary.categories[0]?.transactionCount).toBe(2);
	});
});
