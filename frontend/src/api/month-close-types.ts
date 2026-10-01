/**
 * Month Close API Types & Contracts (F8)
 *
 * Adheres strictly to backend contracts in:
 *   src/http/month-close-routes.ts
 *   src/month-close/product-read.ts
 *   src/month-close/service.ts
 *   src/month-close/calendar.ts
 *   src/month-close/errors.ts
 */

export interface MonthCloseProductDto {
	monthCloseId: string;
	userId: string;
	periodMonth: string; // YYYY-MM
	budgetPlanId: string;
	budgetPlanRevisionNo: number;
	policyVersion: string;
	currency: string;
	referenceIncome: string;
	mandatory: {
		ceiling: string;
		actualExpense: string;
		unused: string;
	};
	discretionary: {
		ceiling: string;
		actualExpense: string;
		unused: string;
	};
	unclassifiedExpense: string;
	closeSurplus: string;
	unappliedPriorAdjustments: string;
	adjustedRoutableSurplus: string;
	route: "SHORT_TERM_GOAL" | "MEDIUM_TERM_RESERVE" | "NONE";
	decision: "FULL" | "PARTIAL" | "SKIP" | "AUTO_MEDIUM" | "NO_ACTION";
	midasAccountId: string | null;
	targetGoalId: string | null;
	targetGoalRevisionNo: number | null;
	targetBucketId: string | null;
	fullOfferAmount: string;
	appliedAmount: string;
	unroutedAmount: string;
	midasAllocationTransferId: string | null;
	proposalFingerprint: string;
	occurredAt: string;
	createdAt: string;
}

export interface MonthClosesListResponse {
	monthCloses: MonthCloseProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface MonthCloseProposal {
	periodMonth: string; // YYYY-MM
	budgetPlanId: string | null;
	budgetPlanRevisionNo: number | null;
	policyVersion: string | null;
	currency: string | null;
	referenceIncome: string | null;
	mandatory: {
		ceiling: string;
		actualExpense: string;
		unused: string;
	} | null;
	discretionary: {
		ceiling: string;
		actualExpense: string;
		unused: string;
	} | null;
	unclassifiedExpense: string | null;
	closeSurplus: string | null;
	unappliedPriorAdjustments?: string | null;
	adjustedRoutableSurplus?: string | null;
	midasAccountId: string | null;
	midasUnallocatedBalance: string | null;
	route: "SHORT_TERM_GOAL" | "MEDIUM_TERM_RESERVE" | "NONE" | "BLOCKED";
	recommendedGoal: {
		goalId: string;
		revisionNo: number;
		priority: number;
		bucketId: string;
		name: string;
		remainingToTarget: string;
	} | null;
	fullOfferAmount: string | null;
	unroutedRemainderIfFull: string | null;
	proposalFingerprint: string;
	blockedReason: string | null;
}

export interface MonthCloseCommitPayload {
	periodMonth: string; // YYYY-MM
	expectedProposalFingerprint: string;
	decision?: "FULL" | "PARTIAL" | "SKIP";
	partialAmount?: string;
	occurredAt: string; // Canonical UTC ISO
}

export interface MonthCloseCommitResponse {
	monthClose: MonthCloseProductDto;
	idempotentReplay?: boolean;
}
