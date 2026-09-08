import { describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	allocatePersonalBudgetV2,
	CORE_EMERGENCY_FUND_TARGET,
	PERSONAL_BUDGET_V2,
	type PersonalBudgetV2Inputs,
} from "../src/budget/policy-v2";

const ZERO_INPUTS: PersonalBudgetV2Inputs = {
	realizedIncome: "0.00",
	currentObligations: "0.00",
	basicLivingFunding: "0.00",
	dateBoundNecessaryPurchaseFunding: "0.00",
	coreEmergencyFundBalance: "0.00",
	mobilityBalance: "0.00",
};

function run(overrides: Partial<PersonalBudgetV2Inputs>) {
	return allocatePersonalBudgetV2({ ...ZERO_INPUTS, ...overrides });
}

/** Assert the exact-kurus sum invariant on every result. */
function expectSumInvariant(
	res: ReturnType<typeof allocatePersonalBudgetV2>,
): void {
	const { mobilityAllocation, longTermInvestment, discretionaryAllocation } =
		res.outputs;
	expect(
		mobilityAllocation.cents +
			longTermInvestment.cents +
			discretionaryAllocation.cents,
	).toBe(res.outputs.trueSurplus.cents);
}

function outCents(res: ReturnType<typeof allocatePersonalBudgetV2>) {
	const o = res.outputs;
	return {
		emergencyCatchUp: o.emergencyCatchUp.cents,
		deficit: o.deficit.cents,
		trueSurplus: o.trueSurplus.cents,
		mobilityAllocation: o.mobilityAllocation.cents,
		longTermInvestment: o.longTermInvestment.cents,
		discretionaryAllocation: o.discretionaryAllocation.cents,
	};
}

describe("PERSONAL_BUDGET_V2 pure policy allocator", () => {
	it("exposes the policy version and the 10,000.00 core emergency target constant", () => {
		expect(PERSONAL_BUDGET_V2).toBe("PERSONAL_BUDGET_V2");
		expect(CORE_EMERGENCY_FUND_TARGET).toBe("10000.00");
		expect(run({}).policyVersion).toBe("PERSONAL_BUDGET_V2");
	});

	// --- A. ZERO -----------------------------------------------------------
	it("A: all-zero inputs -> no deficit, no catch-up, no surplus allocations", () => {
		const res = run({});
		expect(outCents(res)).toEqual({
			emergencyCatchUp: 0n,
			deficit: 0n,
			trueSurplus: 0n,
			mobilityAllocation: 0n,
			longTermInvestment: 0n,
			discretionaryAllocation: 0n,
		});
		expectSumInvariant(res);
	});

	// --- B. EXACT AFFORDABILITY -----------------------------------------
	it("B: R = O + B + N -> deficit 0, trueSurplus 0", () => {
		const res = run({
			realizedIncome: "3000.00",
			currentObligations: "1000.00",
			basicLivingFunding: "1500.00",
			dateBoundNecessaryPurchaseFunding: "500.00",
		});
		expect(res.outputs.deficit.cents).toBe(0n);
		expect(res.outputs.trueSurplus.cents).toBe(0n);
		expect(res.outputs.emergencyCatchUp.cents).toBe(0n);
		expectSumInvariant(res);
	});

	// --- C. DEFICIT -------------------------------------------------------
	it("C: R < O + B + N -> exact deficit, zero catch-up, zero surplus allocations", () => {
		const res = run({
			realizedIncome: "1000.00",
			currentObligations: "1000.00",
			basicLivingFunding: "1500.00",
			dateBoundNecessaryPurchaseFunding: "500.00",
		});
		expect(outCents(res)).toEqual({
			emergencyCatchUp: 0n,
			deficit: 200_000n, // |1000 - 3000| = 2000.00
			trueSurplus: 0n,
			mobilityAllocation: 0n,
			longTermInvestment: 0n,
			discretionaryAllocation: 0n,
		});
		expect(res.outputs.deficit.amount).toBe("2000.00");
		expectSumInvariant(res);
	});

	it("C2: a $0.01 shortfall is an exact 0.01 deficit, not rounded away", () => {
		const res = run({
			realizedIncome: "999.99",
			basicLivingFunding: "1000.00",
		});
		expect(res.outputs.deficit.cents).toBe(1n);
		expect(res.outputs.deficit.amount).toBe("0.01");
		expect(res.outputs.trueSurplus.cents).toBe(0n);
	});

	// --- D. EMERGENCY EMPTY --------------------------------------------
	it("D: available <= 10k with empty emergency -> everything to catch-up, no false deficit", () => {
		const res = run({ realizedIncome: "2000.00" });
		expect(res.outputs.deficit.cents).toBe(0n);
		expect(res.outputs.emergencyCatchUp.cents).toBe(200_000n);
		expect(res.outputs.trueSurplus.cents).toBe(0n);
		expectSumInvariant(res);
	});

	// --- E. EMERGENCY PARTIAL (spec example) ---------------------------
	it("E: E = 8,000, available = 10,000 -> catch-up 2,000, trueSurplus 8,000", () => {
		const res = run({
			realizedIncome: "10000.00",
			coreEmergencyFundBalance: "8000.00",
		});
		expect(res.outputs.emergencyCatchUp.cents).toBe(200_000n);
		expect(res.outputs.trueSurplus.cents).toBe(800_000n);
		expect(res.outputs.deficit.cents).toBe(0n);
		expectSumInvariant(res);
	});

	// --- F. EMERGENCY AT TARGET --------------------------------------
	it("F: E = 10,000 -> catch-up 0", () => {
		const res = run({
			realizedIncome: "5000.00",
			coreEmergencyFundBalance: "10000.00",
		});
		expect(res.outputs.emergencyCatchUp.cents).toBe(0n);
		expect(res.outputs.trueSurplus.cents).toBe(500_000n);
	});

	// --- G. EMERGENCY ABOVE TARGET ---------------------------------
	it("G: E > 10,000 -> catch-up 0, no negative gap", () => {
		const res = run({
			realizedIncome: "5000.00",
			coreEmergencyFundBalance: "25000.00",
		});
		expect(res.outputs.emergencyCatchUp.cents).toBe(0n);
		expect(res.outputs.trueSurplus.cents).toBe(500_000n);
		expectSumInvariant(res);
	});

	// --- H..N. MOBILITY TAPER REFERENCE POINTS ------------------------
	// trueSurplus fixed at 10,000.00 (R = 10,000, E already at target).
	const taperInputs = (mobilityBalance: string) => ({
		realizedIncome: "10000.00",
		coreEmergencyFundBalance: "10000.00",
		mobilityBalance,
	});

	it("H: M < 30k (M = 0) -> 35 / 30 / 35", () => {
		const res = run(taperInputs("0.00"));
		expect(outCents(res).mobilityAllocation).toBe(350_000n);
		expect(outCents(res).longTermInvestment).toBe(300_000n);
		expect(outCents(res).discretionaryAllocation).toBe(350_000n);
		expectSumInvariant(res);
	});

	it("I: M exactly 30,000 -> 35 / 30 / 35", () => {
		const res = run(taperInputs("30000.00"));
		expect([
			res.outputs.mobilityAllocation.amount,
			res.outputs.longTermInvestment.amount,
			res.outputs.discretionaryAllocation.amount,
		]).toEqual(["3500.00", "3000.00", "3500.00"]);
		expectSumInvariant(res);
	});

	it("J: M = 37,500 -> 26.25 / 38.75 / 35", () => {
		const res = run(taperInputs("37500.00"));
		expect([
			res.outputs.mobilityAllocation.amount,
			res.outputs.longTermInvestment.amount,
			res.outputs.discretionaryAllocation.amount,
		]).toEqual(["2625.00", "3875.00", "3500.00"]);
		expectSumInvariant(res);
	});

	it("K: M = 45,000 -> 17.5 / 47.5 / 35", () => {
		const res = run(taperInputs("45000.00"));
		expect([
			res.outputs.mobilityAllocation.amount,
			res.outputs.longTermInvestment.amount,
			res.outputs.discretionaryAllocation.amount,
		]).toEqual(["1750.00", "4750.00", "3500.00"]);
		expectSumInvariant(res);
	});

	it("L: M = 52,500 -> 8.75 / 56.25 / 35", () => {
		const res = run(taperInputs("52500.00"));
		expect([
			res.outputs.mobilityAllocation.amount,
			res.outputs.longTermInvestment.amount,
			res.outputs.discretionaryAllocation.amount,
		]).toEqual(["875.00", "5625.00", "3500.00"]);
		expectSumInvariant(res);
	});

	it("M: M exactly 60,000 -> 0 / 65 / 35", () => {
		const res = run(taperInputs("60000.00"));
		expect([
			res.outputs.mobilityAllocation.amount,
			res.outputs.longTermInvestment.amount,
			res.outputs.discretionaryAllocation.amount,
		]).toEqual(["0.00", "6500.00", "3500.00"]);
		expectSumInvariant(res);
	});

	it("N: M above 60,000 (70,000) -> 0 / 65 / 35", () => {
		const res = run(taperInputs("70000.00"));
		expect([
			res.outputs.mobilityAllocation.amount,
			res.outputs.longTermInvestment.amount,
			res.outputs.discretionaryAllocation.amount,
		]).toEqual(["0.00", "6500.00", "3500.00"]);
		expectSumInvariant(res);
	});

	it("H..N boundary: M = 29,999.99 tapers as < 30k, M = 59,999.99 tapers toward 0", () => {
		const justBelowLower = run(taperInputs("29999.99"));
		expect(justBelowLower.outputs.mobilityAllocation.amount).toBe("3500.00");
		expect(justBelowLower.outputs.longTermInvestment.amount).toBe("3000.00");

		const justBelowUpper = run(taperInputs("59999.99"));
		// weight = 3500 * (6,000,000 - 5,999,999) / 3,000,000 -> floor to 0 kurus
		expect(justBelowUpper.outputs.mobilityAllocation.amount).toBe("0.00");
		expect(justBelowUpper.outputs.longTermInvestment.amount).toBe("6500.00");
		expect(justBelowUpper.outputs.discretionaryAllocation.amount).toBe(
			"3500.00",
		);
		expectSumInvariant(justBelowUpper);
	});

	// --- O. MOBILITY GAP SATURATION ---------------------------------
	it("O: taper candidate that would overshoot 60k is capped at the remaining gap; excess to Long Term; Discretionary unchanged", () => {
		// M = 59,900 -> remaining gap = 100.00. trueSurplus = 200,000.00.
		// taper candidate = floor(20,000,000 * 3500 * 10,000 / (10000 * 3,000,000))
		//                 = 23,333 kurus -> capped to 10,000 kurus (100.00).
		const res = run({
			realizedIncome: "200000.00",
			coreEmergencyFundBalance: "10000.00",
			mobilityBalance: "59900.00",
		});
		expect(res.outputs.mobilityAllocation.amount).toBe("100.00");
		// Mobility stops exactly at 60,000.00.
		expect(res.outputs.mobilityAllocation.cents + 5_990_000n).toBe(6_000_000n);
		// Discretionary keeps its exact 35% base share.
		expect(res.outputs.discretionaryAllocation.amount).toBe("70000.00");
		// Excess (candidate - gap) plus the 30% base goes to Long Term.
		expect(res.outputs.longTermInvestment.amount).toBe("129900.00");
		expectSumInvariant(res);
	});

	it("O2: even at M = 0 an enormous trueSurplus never pushes Mobility past 60k", () => {
		const res = run({
			realizedIncome: "9999999999999999.99",
			coreEmergencyFundBalance: "10000.00",
			mobilityBalance: "0.00",
		});
		expect(res.outputs.mobilityAllocation.amount).toBe("60000.00");
		expectSumInvariant(res);
	});

	// --- P. ROUNDING / RESIDUAL -----------------------------------
	it("P: awkward kurus trueSurplus values lose no cent (residual to Long Term)", () => {
		const cases: Array<{ r: string; mob: string; long: string; disc: string }> =
			[
				{ r: "0.01", mob: "0.00", long: "0.01", disc: "0.00" },
				{ r: "0.03", mob: "0.01", long: "0.01", disc: "0.01" },
				{ r: "1234.57", mob: "432.09", long: "370.39", disc: "432.09" },
				{ r: "0.02", mob: "0.00", long: "0.02", disc: "0.00" },
				{ r: "7.77", mob: "2.71", long: "2.35", disc: "2.71" },
			];
		for (const c of cases) {
			const res = run({
				realizedIncome: c.r,
				coreEmergencyFundBalance: "10000.00",
				mobilityBalance: "0.00",
			});
			expect([
				res.outputs.mobilityAllocation.amount,
				res.outputs.longTermInvestment.amount,
				res.outputs.discretionaryAllocation.amount,
			]).toEqual([c.mob, c.long, c.disc]);
			expectSumInvariant(res);
		}
	});

	// --- Q. LARGE VALID VALUES -------------------------------------
	it("Q: NUMERIC(18,2) upper-range values stay exact (BigInt, no JS Number precision loss)", () => {
		const res = run({
			realizedIncome: "9999999999999999.99",
			coreEmergencyFundBalance: "10000.00",
			mobilityBalance: "1.00", // M < 30k -> full 35% mobility weight, then 60k cap
		});
		expect(res.outputs.trueSurplus.amount).toBe("9999999999999999.99");
		expect(res.outputs.discretionaryAllocation.cents).toBe(
			(999_999_999_999_999_999n * 3500n) / 10_000n,
		);
		expectSumInvariant(res);
		// The result is not representable as an exact JS number; prove we never
		// went through one.
		expect(Number.isSafeInteger(Number(res.outputs.trueSurplus.cents))).toBe(
			false,
		);
	});

	it("Q2: obligations near the NUMERIC ceiling produce an exact large deficit", () => {
		const res = run({
			realizedIncome: "0.00",
			currentObligations: "9999999999999999.99",
		});
		expect(res.outputs.deficit.amount).toBe("9999999999999999.99");
		expect(res.outputs.trueSurplus.cents).toBe(0n);
	});

	// --- R. INVALID INPUTS --------------------------------------
	it("R: rejects malformed / negative / NaN-like / bad-scale money strings before any math", () => {
		const bad: Array<[keyof PersonalBudgetV2Inputs, string]> = [
			["realizedIncome", "-1.00"],
			["currentObligations", "abc"],
			["basicLivingFunding", "NaN"],
			["dateBoundNecessaryPurchaseFunding", "1.234"],
			["coreEmergencyFundBalance", "1,000.00"],
			["mobilityBalance", "1e3"],
			["realizedIncome", "01.00"],
			["realizedIncome", ""],
			["mobilityBalance", " "],
			["currentObligations", "Infinity"],
		];
		for (const [key, value] of bad) {
			expect(() => run({ [key]: value })).toThrow(BudgetError);
			try {
				run({ [key]: value });
			} catch (e) {
				expect((e as BudgetError).code).toBe("BUDGET_INVALID_INPUT");
			}
		}
	});

	it("R2: rejects a non-string input value", () => {
		expect(() =>
			// deliberately violating the type to exercise the runtime guard
			run({ realizedIncome: 123 as unknown as string }),
		).toThrow(BudgetError);
	});

	it("R3: >16 integer digits (NUMERIC(18,2) overflow) is rejected", () => {
		expect(() => run({ realizedIncome: "10000000000000000.00" })).toThrow(
			BudgetError,
		);
	});
});
