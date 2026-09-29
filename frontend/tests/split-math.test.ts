import { describe, expect, it } from "vitest";
import {
	calculateEqualSplitPreview,
	calculateManualSplitPreview,
	calculateRatioSplitPreview,
} from "../src/lib/split-math";

describe("F5 Split Math — Zero Float BigInt Cent Allocation", () => {
	it("distributes equal split with remainder cent to user first, then participants ordered by personId ASC", () => {
		// 100.00 TL among user + 2 participants (total 3 people)
		// 10000 cents / 3 = 3333 cents with remainder 1 cent.
		// User gets remainder 1 -> 3334 cents (33.34 TL)
		// p1, p2 get 3333 cents (33.33 TL)
		const res1 = calculateEqualSplitPreview("100.00", [
			{ personId: "person-b", displayName: "Banu" },
			{ personId: "person-a", displayName: "Ahmet" },
		]);
		expect(res1.userShareAmount).toBe("33.34");
		expect(res1.participants).toEqual([
			{
				personId: "person-a",
				displayName: "Ahmet",
				shareAmount: "33.33",
				weight: 1,
			},
			{
				personId: "person-b",
				displayName: "Banu",
				shareAmount: "33.33",
				weight: 1,
			},
		]);

		// 100.01 TL among user + 2 participants (total 3 people)
		// 10001 cents / 3 = 3333 cents with remainder 2 cents.
		// User gets 1 remainder -> 3334 cents
		// Next in personId ASC order is person-a -> gets 1 remainder -> 3334 cents
		// person-b gets 3333 cents
		const res2 = calculateEqualSplitPreview("100.01", [
			{ personId: "person-b", displayName: "Banu" },
			{ personId: "person-a", displayName: "Ahmet" },
		]);
		expect(res2.userShareAmount).toBe("33.34");
		expect(res2.participants).toEqual([
			{
				personId: "person-a",
				displayName: "Ahmet",
				shareAmount: "33.34",
				weight: 1,
			},
			{
				personId: "person-b",
				displayName: "Banu",
				shareAmount: "33.33",
				weight: 1,
			},
		]);
	});

	it("validates manual split correctly using exact cents without float drift", () => {
		const valid = calculateManualSplitPreview("150.50", [
			{ personId: "p1", shareAmountStr: "50.25" },
			{ personId: "p2", shareAmountStr: "50.25" },
		]);
		expect(valid.isValid).toBe(true);
		expect(valid.userShareAmount).toBe("50.00");
		expect(valid.externalShareAmount).toBe("100.50");

		// Exceeds total
		const invalid = calculateManualSplitPreview("150.50", [
			{ personId: "p1", shareAmountStr: "100.00" },
			{ personId: "p2", shareAmountStr: "60.00" },
		]);
		expect(invalid.isValid).toBe(false);
		expect(invalid.errorMessage).toContain("toplam harcamayı");
	});

	it("calculates ratio split using largest-remainder distribution", () => {
		// 100.00 TL with weights: user=1, p1=1, p2=1 -> each 33.33 with 1 remainder to largest fraction / order
		const res = calculateRatioSplitPreview("100.00", 1, [
			{ personId: "p1", weight: 1 },
			{ personId: "p2", weight: 1 },
		]);
		expect(res.isValid).toBe(true);
		// Sum of userShare + externalShares must exactly equal 100.00
		const userCents = BigInt(res.userShareAmount.replace(".", ""));
		const p1Cents = BigInt(res.participants[0]!.shareAmount.replace(".", ""));
		const p2Cents = BigInt(res.participants[1]!.shareAmount.replace(".", ""));
		expect(userCents + p1Cents + p2Cents).toBe(10000n);
	});
});
