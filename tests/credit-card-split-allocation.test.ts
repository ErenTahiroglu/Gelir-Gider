import { describe, expect, it } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import {
	calculateEqualSplit,
	calculateManualSplit,
	calculateRatioSplit,
} from "../src/credit-cards/split-allocation";

describe("Credit Card Split Allocation Engine", () => {
	describe("calculateEqualSplit", () => {
		it("splits evenly when gross amount divides exactly", () => {
			// 3000 cents with 2 external people = 3 parties (1000 each)
			const res = calculateEqualSplit({
				grossAmount: 3000n,
				participants: [{ personId: "p1" }, { personId: "p2" }],
			});

			expect(res.method).toBe("EQUAL");
			expect(res.grossAmount).toBe(3000n);
			expect(res.userShareAmount).toBe(1000n);
			expect(res.externalShareAmount).toBe(2000n);
			expect(res.participants).toHaveLength(2);
			expect(res.participants[0]?.shareAmount).toBe(1000n);
			expect(res.participants[1]?.shareAmount).toBe(1000n);
			expect(res.userShareAmount + res.externalShareAmount).toBe(3000n);
		});

		it("distributes remainder cents with USER first then personId ASC", () => {
			// 1000 cents with 2 external people (3 parties: 333 + 333 + 333 + 1 remainder cent)
			// 1000 % 3 = 1 cent remainder. USER gets the 1st extra cent.
			const res1 = calculateEqualSplit({
				grossAmount: 1000n,
				participants: [{ personId: "p1" }, { personId: "p2" }],
			});

			expect(res1.userShareAmount).toBe(334n);
			expect(res1.participants[0]?.shareAmount).toBe(333n);
			expect(res1.participants[1]?.shareAmount).toBe(333n);
			expect(res1.userShareAmount + res1.externalShareAmount).toBe(1000n);

			// 1001 cents with 2 external people (3 parties: 333 + 333 + 333 + 2 remainder cents)
			// Remainder = 2 cents. USER gets 1, 'p1' (lexical 1st) gets 1, 'p2' gets 0.
			const res2 = calculateEqualSplit({
				grossAmount: 1001n,
				participants: [{ personId: "p2" }, { personId: "p1" }], // input order scrambled
			});

			expect(res2.userShareAmount).toBe(334n);
			// Deterministically sorted by personId ASC:
			expect(res2.participants[0]?.personId).toBe("p1");
			expect(res2.participants[0]?.shareAmount).toBe(334n);
			expect(res2.participants[1]?.personId).toBe("p2");
			expect(res2.participants[1]?.shareAmount).toBe(333n);
			expect(res2.userShareAmount + res2.externalShareAmount).toBe(1001n);
		});

		it("rejects gross amount <= 0", () => {
			expect(() =>
				calculateEqualSplit({
					grossAmount: 0n,
					participants: [{ personId: "p1" }],
				}),
			).toThrow(CreditCardError);
		});

		it("rejects duplicate person IDs", () => {
			expect(() =>
				calculateEqualSplit({
					grossAmount: 1000n,
					participants: [{ personId: "p1" }, { personId: "P1" }],
				}),
			).toThrow(CreditCardError);
		});

		it("rejects < 1 or > 9 external participants", () => {
			expect(() =>
				calculateEqualSplit({
					grossAmount: 1000n,
					participants: [],
				}),
			).toThrow(CreditCardError);

			const ten = Array.from({ length: 10 }, (_, i) => ({
				personId: `person-${i}`,
			}));
			expect(() =>
				calculateEqualSplit({
					grossAmount: 10000n,
					participants: ten,
				}),
			).toThrow(CreditCardError);
		});
	});

	describe("calculateManualSplit", () => {
		it("allocates exact manual amounts and computes user share as residual", () => {
			const res = calculateManualSplit({
				grossAmount: 10000n,
				participants: [
					{ personId: "p1", shareAmount: 4000n },
					{ personId: "p2", shareAmount: 3500n },
				],
			});

			expect(res.method).toBe("MANUAL");
			expect(res.grossAmount).toBe(10000n);
			expect(res.userShareAmount).toBe(2500n);
			expect(res.externalShareAmount).toBe(7500n);
			expect(res.participants[0]?.shareAmount).toBe(4000n);
			expect(res.participants[1]?.shareAmount).toBe(3500n);
		});

		it("supports 100% external allocation (user share = 0)", () => {
			// Family purchase 2745.00 where friend/family pays 100%
			const res = calculateManualSplit({
				grossAmount: 274500n,
				participants: [{ personId: "family-member", shareAmount: 274500n }],
			});

			expect(res.userShareAmount).toBe(0n);
			expect(res.externalShareAmount).toBe(274500n);
			expect(res.participants[0]?.shareAmount).toBe(274500n);
		});

		it("rejects if external shares exceed gross amount", () => {
			expect(() =>
				calculateManualSplit({
					grossAmount: 5000n,
					participants: [
						{ personId: "p1", shareAmount: 3000n },
						{ personId: "p2", shareAmount: 2500n },
					],
				}),
			).toThrow(CreditCardError);
		});

		it("rejects participant share <= 0", () => {
			expect(() =>
				calculateManualSplit({
					grossAmount: 5000n,
					participants: [{ personId: "p1", shareAmount: 0n }],
				}),
			).toThrow(CreditCardError);
		});
	});

	describe("calculateRatioSplit", () => {
		it("allocates by integer weights (e.g. 50/50, 60/40, 1:2:1)", () => {
			// 10000 gross with user weight 1, p1 weight 2, p2 weight 1 (total weight = 4)
			const res = calculateRatioSplit({
				grossAmount: 10000n,
				userWeight: 1,
				participants: [
					{ personId: "p1", weight: 2 },
					{ personId: "p2", weight: 1 },
				],
			});

			expect(res.method).toBe("RATIO");
			expect(res.userShareAmount).toBe(2500n);
			expect(
				res.participants.find((p) => p.personId === "p1")?.shareAmount,
			).toBe(5000n);
			expect(
				res.participants.find((p) => p.personId === "p2")?.shareAmount,
			).toBe(2500n);
			expect(res.userShareAmount + res.externalShareAmount).toBe(10000n);
		});

		it("distributes residual cents using largest-remainder method and tie-breakers", () => {
			// 1000 gross with user weight 1, p1 weight 1, p2 weight 1 (3 equal weights)
			// 1000 % 3 = 1 cent remainder.
			const res = calculateRatioSplit({
				grossAmount: 1000n,
				userWeight: 1,
				participants: [
					{ personId: "p2", weight: 1 },
					{ personId: "p1", weight: 1 },
				],
			});

			expect(res.userShareAmount).toBe(334n);
			const p1 = res.participants.find((p) => p.personId === "p1");
			const p2 = res.participants.find((p) => p.personId === "p2");
			expect(p1?.shareAmount).toBe(333n);
			expect(p2?.shareAmount).toBe(333n);
			expect(res.userShareAmount + res.externalShareAmount).toBe(1000n);
		});

		it("supports user weight 0 (100% external allocation)", () => {
			const res = calculateRatioSplit({
				grossAmount: 10000n,
				userWeight: 0,
				participants: [
					{ personId: "p1", weight: 1 },
					{ personId: "p2", weight: 1 },
				],
			});

			expect(res.userShareAmount).toBe(0n);
			expect(res.externalShareAmount).toBe(10000n);
			expect(res.participants[0]?.shareAmount).toBe(5000n);
			expect(res.participants[1]?.shareAmount).toBe(5000n);
		});

		it("rejects total weight <= 0", () => {
			expect(() =>
				calculateRatioSplit({
					grossAmount: 10000n,
					userWeight: 0,
					participants: [{ personId: "p1", weight: 0 }],
				}),
			).toThrow(CreditCardError);
		});

		it("rejects negative user weight or participant weight", () => {
			expect(() =>
				calculateRatioSplit({
					grossAmount: 10000n,
					userWeight: -1,
					participants: [{ personId: "p1", weight: 1 }],
				}),
			).toThrow(CreditCardError);

			expect(() =>
				calculateRatioSplit({
					grossAmount: 10000n,
					userWeight: 1,
					participants: [{ personId: "p1", weight: -2 }],
				}),
			).toThrow(CreditCardError);
		});
	});
});
