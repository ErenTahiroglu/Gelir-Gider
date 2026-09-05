import { describe, expect, it } from "vitest";
import {
	clampNonNegativeCents,
	computeMonthCloseFullOffer,
	computeMonthCloseSurplusCents,
	computeMonthCloseUnusedCents,
	formatMonthCloseCents,
} from "../src/month-close/formula";

describe("Month Close Surplus Formula (Phase 14, Section 6) -- exact BigInt cents", () => {
	it("computes the worked example: mandatory 6500/6000 -> unused 500, discretionary 500/300 -> unused 200, surplus 700", () => {
		const mandatoryUnused = computeMonthCloseUnusedCents(650000n, 600000n);
		const discretionaryUnused = computeMonthCloseUnusedCents(50000n, 30000n);
		expect(mandatoryUnused).toBe(50000n);
		expect(discretionaryUnused).toBe(20000n);
		expect(
			computeMonthCloseSurplusCents(mandatoryUnused, discretionaryUnused),
		).toBe(70000n);
	});

	it("clamps overspend to zero unused with no negative carry into the other ceiling (mandatory 6500/6800 -> unused 0)", () => {
		const mandatoryUnused = computeMonthCloseUnusedCents(650000n, 680000n);
		expect(mandatoryUnused).toBe(0n);

		const discretionaryUnused = computeMonthCloseUnusedCents(50000n, 30000n);
		const surplus = computeMonthCloseSurplusCents(
			mandatoryUnused,
			discretionaryUnused,
		);
		// No negative carry: overspend in mandatory does NOT reduce
		// discretionary's own unused/surplus contribution.
		expect(surplus).toBe(discretionaryUnused);
		expect(surplus).toBeGreaterThanOrEqual(0n);
	});

	it("clamps a net refund/credit so unused never exceeds the original ceiling", () => {
		// A negative net expense (net refund) must not inflate unused beyond
		// the ceiling itself.
		const unused = computeMonthCloseUnusedCents(650000n, -50000n);
		expect(unused).toBe(650000n);
	});

	it("clampNonNegativeCents floors negative values at zero and passes through positives", () => {
		expect(clampNonNegativeCents(-1n)).toBe(0n);
		expect(clampNonNegativeCents(0n)).toBe(0n);
		expect(clampNonNegativeCents(123n)).toBe(123n);
	});

	it("unused is never negative and never exceeds the ceiling for any combination", () => {
		const ceilings = [0n, 1n, 100n, 650000n];
		const expenses = [-500000n, -1n, 0n, 1n, 650000n, 999999n];
		for (const ceiling of ceilings) {
			for (const expense of expenses) {
				const unused = computeMonthCloseUnusedCents(ceiling, expense);
				expect(unused).toBeGreaterThanOrEqual(0n);
				expect(unused).toBeLessThanOrEqual(ceiling);
			}
		}
	});

	describe("computeMonthCloseFullOffer (Section 10)", () => {
		it("surplus 700, goal remaining 1000 -> fullOffer 700, remainder 0", () => {
			const { fullOfferCents, unroutedRemainderIfFullCents } =
				computeMonthCloseFullOffer(70000n, 100000n);
			expect(fullOfferCents).toBe(70000n);
			expect(unroutedRemainderIfFullCents).toBe(0n);
		});

		it("surplus 700, goal remaining 300 -> fullOffer 300, remainder 400 (stays UNALLOCATED)", () => {
			const { fullOfferCents, unroutedRemainderIfFullCents } =
				computeMonthCloseFullOffer(70000n, 30000n);
			expect(fullOfferCents).toBe(30000n);
			expect(unroutedRemainderIfFullCents).toBe(40000n);
		});

		it("exact equality: fullOffer equals surplus, remainder 0", () => {
			const { fullOfferCents, unroutedRemainderIfFullCents } =
				computeMonthCloseFullOffer(50000n, 50000n);
			expect(fullOfferCents).toBe(50000n);
			expect(unroutedRemainderIfFullCents).toBe(0n);
		});
	});

	describe("formatMonthCloseCents", () => {
		it("formats zero, positive, and negative cents exactly", () => {
			expect(formatMonthCloseCents(0n)).toBe("0.00");
			expect(formatMonthCloseCents(70000n)).toBe("700.00");
			expect(formatMonthCloseCents(1n)).toBe("0.01");
			expect(formatMonthCloseCents(-150n)).toBe("-1.50");
		});
	});

	describe("zero-surplus month (Section 12/29-33 worked examples)", () => {
		it("mandatory and discretionary fully spent (or overspent) -> surplus 0", () => {
			const mandatoryUnused = computeMonthCloseUnusedCents(650000n, 650000n);
			const discretionaryUnused = computeMonthCloseUnusedCents(50000n, 90000n);
			expect(mandatoryUnused).toBe(0n);
			expect(discretionaryUnused).toBe(0n);
			expect(
				computeMonthCloseSurplusCents(mandatoryUnused, discretionaryUnused),
			).toBe(0n);
		});
	});
});
