import { formatCentsToMoney, parseMoneyString } from "../ledger/money";
import { BudgetError } from "./errors";

export const PERSONAL_BUDGET_V1 = "PERSONAL_BUDGET_V1" as const;

export type BudgetComponentCode =
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE"
	| "MEDIUM_TERM_RESERVE"
	| "LONG_TERM_INVESTMENT";

export type BudgetComponentRole = "CEILING" | "TARGET";

export interface BudgetComponentAllocation {
	basisPoints: number;
	role: BudgetComponentRole;
	amount: string;
	cents: bigint;
}

export interface BudgetPolicyAllocations {
	MANDATORY_EXPENSE: BudgetComponentAllocation;
	DISCRETIONARY_SPEND: BudgetComponentAllocation;
	SHORT_TERM_PURCHASE: BudgetComponentAllocation;
	MEDIUM_TERM_RESERVE: BudgetComponentAllocation;
	LONG_TERM_INVESTMENT: BudgetComponentAllocation;
}

export interface PersonalBudgetV1Result {
	policyVersion: typeof PERSONAL_BUDGET_V1;
	referenceIncome: string;
	referenceIncomeCents: bigint;
	allocations: BudgetPolicyAllocations;
}

/**
 * Deterministic kuruş-exact policy allocator for PERSONAL_BUDGET_V1.
 *
 * Invariant:
 *   mandatory + discretionary + shortTerm + mediumTerm + longTerm = referenceIncomeCents
 *
 * Residual-cent policy:
 *   All residual kuruş from floor division are deterministically assigned to LONG_TERM_INVESTMENT.
 */
export function allocatePersonalBudgetV1(
	referenceIncome: string,
): PersonalBudgetV1Result {
	let totalCents: bigint;
	try {
		const parsed = parseMoneyString(referenceIncome);
		totalCents = parsed.cents;
	} catch (e) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`Invalid reference income amount: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	if (totalCents < 0n) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"Reference income cannot be negative",
		);
	}

	const mandatory = (totalCents * 6500n) / 10000n;
	const discretionary = (totalCents * 500n) / 10000n;
	const shortTerm = (totalCents * 1000n) / 10000n;
	const mediumTerm = (totalCents * 1000n) / 10000n;
	const longTerm =
		totalCents - mandatory - discretionary - shortTerm - mediumTerm;

	return {
		policyVersion: PERSONAL_BUDGET_V1,
		referenceIncome: formatCentsToMoney(totalCents),
		referenceIncomeCents: totalCents,
		allocations: {
			MANDATORY_EXPENSE: {
				basisPoints: 6500,
				role: "CEILING",
				amount: formatCentsToMoney(mandatory),
				cents: mandatory,
			},
			DISCRETIONARY_SPEND: {
				basisPoints: 500,
				role: "CEILING",
				amount: formatCentsToMoney(discretionary),
				cents: discretionary,
			},
			SHORT_TERM_PURCHASE: {
				basisPoints: 1000,
				role: "TARGET",
				amount: formatCentsToMoney(shortTerm),
				cents: shortTerm,
			},
			MEDIUM_TERM_RESERVE: {
				basisPoints: 1000,
				role: "TARGET",
				amount: formatCentsToMoney(mediumTerm),
				cents: mediumTerm,
			},
			LONG_TERM_INVESTMENT: {
				basisPoints: 1000,
				role: "TARGET",
				amount: formatCentsToMoney(longTerm),
				cents: longTerm,
			},
		},
	};
}
