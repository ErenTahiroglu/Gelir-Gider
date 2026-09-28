/**
 * Dashboard Read Model Types & DTOs
 *
 * Adheres strictly to backend contracts in:
 *   src/http/budget-v2-routes.ts
 *   src/http/spending-category-routes.ts
 *   src/http/credit-card-routes.ts
 *   src/http/quick-entry-template-routes.ts
 */

// --- Budget V2 Checkpoint Timeline ---

export interface BudgetV2CheckpointTimelineEntry {
	paymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
}

export interface BudgetV2CheckpointTimeline {
	apiVersion: string;
	limit: number;
	sharedMaxCheckpointAt: boolean;
	checkpoints: BudgetV2CheckpointTimelineEntry[];
}

// --- Budget V2 Decision Center ---

export interface BudgetV2DecisionCenterTarget {
	paymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
}

export interface BudgetV2DecisionCenterView {
	apiVersion: string;
	target: BudgetV2DecisionCenterTarget;
	checkpoint: {
		temporalScope: "FROZEN_AT_CHECKPOINT";
		report: unknown;
	};
	behavior?: unknown;
	recommendations?: unknown;
}

export interface AvailableToAllocateNowAvailable {
	available: true;
	amount: string;
	trueSurplus: string;
	totalAttributedCurrentSurplusUse?: string;
	oversubscribedBy?: string;
	[key: string]: unknown;
}

export interface AvailableToAllocateNowUnavailable {
	available: false;
	reason:
		| "SURPLUS_USE_ATTRIBUTION_INCOMPLETE"
		| "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED";
	trueSurplus: string;
	candidateCount: number;
	attributedCount: number;
	unattributedSubjectIds: string[];
	staleSubjectIds: string[];
	overlapUnresolvedSubjectIds: string[];
	knownAttributedCurrentSurplusUse: string;
	unresolvedPotentialUseAmount: string | null;
	[key: string]: unknown;
}

export type AvailableToAllocateNowSection =
	| AvailableToAllocateNowAvailable
	| AvailableToAllocateNowUnavailable;

// --- Spending Summary ---

export interface SpendingCategorySummaryItem {
	categoryId: string;
	categoryName: string;
	amount: string;
	transactionCount: number;
}

export interface SpendingSummaryResponse {
	periodMonth: string;
	totalPersonalSpending: string;
	categories: SpendingCategorySummaryItem[];
	unclassifiedAmount: string;
}

// --- Credit Cards ---

export interface CreditCardItem {
	cardId: string;
	userId: string;
	code: string;
	status: "ACTIVE" | "ARCHIVED";
	revisionNo: number;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string | null;
	lastFour: string | null;
	note: string | null;
	createdAt: string;
	liabilityAccountId?: string;
	liveLiabilityBalance: string;
}

export interface CreditCardsListResponse {
	cards: CreditCardItem[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

// --- Credit Card Statements ---

export interface CreditCardStatementItem {
	statementId: string;
	cardId: string;
	userId: string;
	cycleYear: number;
	cycleMonth: number;
	status: "OPEN" | "PAID" | "VOID";
	revisionNo: number;
	statementAmount: string;
	statementDate: string;
	dueDate: string;
	note: string | null;
}

export interface CreditCardStatementsListResponse {
	statements: CreditCardStatementItem[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

// --- Quick Entry Templates ---

export interface QuickEntryTemplateItem {
	id: string;
	userId: string;
	name: string;
	type: string;
	config: unknown;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface QuickEntryTemplatesResponse {
	templates: QuickEntryTemplateItem[];
}
