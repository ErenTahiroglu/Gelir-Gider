import { formatCentsToMoney, parseMoneyString } from "../ledger/money";
import { BudgetError } from "./errors";

/**
 * PERSONAL_BUDGET_V2 -- pure, deterministic, kurus-exact allocator.
 *
 * This is ONLY the mathematical core: the deterministic waterfall, the
 * Mobility linear taper, the 60k Mobility target-gap saturation, and the
 * residual-kurus policy. It does NOT read live income / card / goal / Midas
 * data -- every input is an already-resolved non-negative monetary string.
 *
 * All arithmetic is BigInt integer (kurus). No JavaScript floating point is
 * used anywhere in the policy math. The DB guard
 * `trg_fn_guard_monthly_budget_v2_plan_revisions_insert` (migration 0061)
 * independently re-derives the exact same result in NUMERIC/integer SQL.
 */

export const PERSONAL_BUDGET_V2 = "PERSONAL_BUDGET_V2" as const;

/** Core emergency fund target: exactly 10,000.00 TRY. */
export const CORE_EMERGENCY_FUND_TARGET = "10000.00" as const;
const CORE_EMERGENCY_TARGET_CENTS = 1_000_000n;

/** Mobility linear-taper interval, in kurus: [30,000.00 , 60,000.00). */
const MOBILITY_LOWER_CENTS = 3_000_000n;
const MOBILITY_UPPER_CENTS = 6_000_000n;

/** Base weights (basis points). Long Term's 30% base is the deterministic residual. */
const MOBILITY_BASE_BP = 3_500n; // 35%
const DISCRETIONARY_BASE_BP = 3_500n; // 35%
const BP_DENOMINATOR = 10_000n;

export interface PersonalBudgetV2Inputs {
	realizedIncome: string;
	currentObligations: string;
	basicLivingFunding: string;
	dateBoundNecessaryPurchaseFunding: string;
	coreEmergencyFundBalance: string;
	mobilityBalance: string;
}

export interface PersonalBudgetV2MoneyField {
	amount: string;
	cents: bigint;
}

export interface PersonalBudgetV2Result {
	policyVersion: typeof PERSONAL_BUDGET_V2;
	inputs: {
		realizedIncome: PersonalBudgetV2MoneyField;
		currentObligations: PersonalBudgetV2MoneyField;
		basicLivingFunding: PersonalBudgetV2MoneyField;
		dateBoundNecessaryPurchaseFunding: PersonalBudgetV2MoneyField;
		coreEmergencyFundBalance: PersonalBudgetV2MoneyField;
		mobilityBalance: PersonalBudgetV2MoneyField;
	};
	outputs: {
		emergencyCatchUp: PersonalBudgetV2MoneyField;
		deficit: PersonalBudgetV2MoneyField;
		trueSurplus: PersonalBudgetV2MoneyField;
		mobilityAllocation: PersonalBudgetV2MoneyField;
		longTermInvestment: PersonalBudgetV2MoneyField;
		discretionaryAllocation: PersonalBudgetV2MoneyField;
	};
}

/**
 * Parses one already-resolved non-negative monetary input string into exact
 * kurus, rejecting malformed, negative, NaN-like, and invalid-scale values
 * before any policy math runs.
 */
function parseNonNegativeInput(label: string, value: string): bigint {
	let cents: bigint;
	try {
		cents = parseMoneyString(value).cents;
	} catch (e) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`Invalid ${label}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (cents < 0n) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`${label} cannot be negative`,
		);
	}
	return cents;
}

function field(cents: bigint): PersonalBudgetV2MoneyField {
	return { amount: formatCentsToMoney(cents), cents };
}

/**
 * Deterministic PERSONAL_BUDGET_V2 allocation.
 *
 * Waterfall (exact kurus):
 *   preEmergencyRemaining = R - O - B - N
 *
 *   CASE 1  preEmergencyRemaining < 0:
 *     deficit = |preEmergencyRemaining|; every catch-up / surplus allocation = 0.
 *
 *   CASE 2  preEmergencyRemaining >= 0:
 *     emergencyGap   = max(10,000.00 - E, 0)
 *     emergencyCatchUp = min(preEmergencyRemaining, emergencyGap)
 *     trueSurplus    = preEmergencyRemaining - emergencyCatchUp
 *
 * trueSurplus allocation:
 *   discretionary = floor(trueSurplus * 35%)                 -- always the 35% base
 *   mobilityCandidate:
 *     M < 30,000            -> floor(trueSurplus * 35%)
 *     30,000 <= M < 60,000  -> floor(trueSurplus * 3500 * (6,000,000 - Mcents)
 *                                     / (10000 * 3,000,000))
 *     M >= 60,000           -> 0
 *   mobilityRemainingGap = max(60,000.00 - M, 0)
 *   mobilityAllocation   = min(mobilityCandidate, mobilityRemainingGap)
 *   longTermInvestment   = trueSurplus - mobilityAllocation - discretionary
 *
 * Long Term deterministically absorbs its 30% base, all weight released by the
 * taper, any Mobility amount released by the 60k target-gap cap, and every
 * residual kurus from integer division. Invariant:
 *   mobilityAllocation + longTermInvestment + discretionaryAllocation = trueSurplus
 */
export function allocatePersonalBudgetV2(
	rawInputs: PersonalBudgetV2Inputs,
): PersonalBudgetV2Result {
	const r = parseNonNegativeInput("realizedIncome", rawInputs.realizedIncome);
	const o = parseNonNegativeInput(
		"currentObligations",
		rawInputs.currentObligations,
	);
	const b = parseNonNegativeInput(
		"basicLivingFunding",
		rawInputs.basicLivingFunding,
	);
	const n = parseNonNegativeInput(
		"dateBoundNecessaryPurchaseFunding",
		rawInputs.dateBoundNecessaryPurchaseFunding,
	);
	const e = parseNonNegativeInput(
		"coreEmergencyFundBalance",
		rawInputs.coreEmergencyFundBalance,
	);
	const m = parseNonNegativeInput("mobilityBalance", rawInputs.mobilityBalance);

	const preEmergencyRemaining = r - o - b - n;

	let deficit: bigint;
	let emergencyCatchUp: bigint;
	let trueSurplus: bigint;
	let mobilityAllocation: bigint;
	let discretionaryAllocation: bigint;
	let longTermInvestment: bigint;

	if (preEmergencyRemaining < 0n) {
		// CASE 1 -- affordability deficit. No implicit funding source is chosen;
		// no negative allocations are invented.
		deficit = -preEmergencyRemaining;
		emergencyCatchUp = 0n;
		trueSurplus = 0n;
		mobilityAllocation = 0n;
		discretionaryAllocation = 0n;
		longTermInvestment = 0n;
	} else {
		// CASE 2 -- no affordability deficit. An incompletely funded emergency
		// target is NOT itself a deficit.
		deficit = 0n;
		const emergencyGap =
			CORE_EMERGENCY_TARGET_CENTS - e > 0n
				? CORE_EMERGENCY_TARGET_CENTS - e
				: 0n;
		emergencyCatchUp =
			preEmergencyRemaining < emergencyGap
				? preEmergencyRemaining
				: emergencyGap;
		trueSurplus = preEmergencyRemaining - emergencyCatchUp;

		// Non-negative BigInt division truncates toward zero == floor.
		discretionaryAllocation =
			(trueSurplus * DISCRETIONARY_BASE_BP) / BP_DENOMINATOR;

		let mobilityCandidate: bigint;
		if (m < MOBILITY_LOWER_CENTS) {
			mobilityCandidate = (trueSurplus * MOBILITY_BASE_BP) / BP_DENOMINATOR;
		} else if (m < MOBILITY_UPPER_CENTS) {
			mobilityCandidate =
				(trueSurplus * MOBILITY_BASE_BP * (MOBILITY_UPPER_CENTS - m)) /
				(BP_DENOMINATOR * MOBILITY_LOWER_CENTS);
		} else {
			mobilityCandidate = 0n;
		}

		const mobilityRemainingGap =
			MOBILITY_UPPER_CENTS - m > 0n ? MOBILITY_UPPER_CENTS - m : 0n;
		mobilityAllocation =
			mobilityCandidate < mobilityRemainingGap
				? mobilityCandidate
				: mobilityRemainingGap;

		longTermInvestment =
			trueSurplus - mobilityAllocation - discretionaryAllocation;
	}

	return {
		policyVersion: PERSONAL_BUDGET_V2,
		inputs: {
			realizedIncome: field(r),
			currentObligations: field(o),
			basicLivingFunding: field(b),
			dateBoundNecessaryPurchaseFunding: field(n),
			coreEmergencyFundBalance: field(e),
			mobilityBalance: field(m),
		},
		outputs: {
			emergencyCatchUp: field(emergencyCatchUp),
			deficit: field(deficit),
			trueSurplus: field(trueSurplus),
			mobilityAllocation: field(mobilityAllocation),
			longTermInvestment: field(longTermInvestment),
			discretionaryAllocation: field(discretionaryAllocation),
		},
	};
}
