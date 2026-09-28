/**
 * Manual Expenses, Ledger Accounts & Spending Categories Types
 */

export interface ManualExpenseDetailItem {
	id: string;
	userId: string;
	kind: "MANUAL_EXPENSE";
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	amount: string;
	occurredAt: string;
	payload: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface ManualExpenseGetResponse {
	expense: ManualExpenseDetailItem;
}

export type BudgetCategorySelection =
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE";

export interface CreateManualExpensePayload {
	amount: string;
	sourceAssetAccountId: string;
	budgetCategory: BudgetCategorySelection;
	spendingCategoryId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	occurredAt?: string | undefined;
	shortTermGoalId?: string | undefined;
}

export interface UpdateManualExpensePayload {
	expectedRevisionNo: number;
	amount?: string | undefined;
	sourceAssetAccountId?: string | undefined;
	budgetCategory?: BudgetCategorySelection | undefined;
	spendingCategoryId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	occurredAt?: string | undefined;
	reasonNote?: string | undefined;
}

export interface VoidManualExpensePayload {
	expectedRevisionNo: number;
	reason?: string | undefined;
}

export interface ManualExpenseMutationResult {
	transactionId: string;
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	idempotentReplay?: boolean;
	ledger?: {
		appliedJournalEntryId?: string;
		reversalJournalEntryId?: string;
	};
}

export interface LedgerAccountItem {
	accountId: string;
	code: string;
	name: string;
	accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
	normalBalance: "DEBIT" | "CREDIT";
	currency: string;
	archived: boolean;
	balance: {
		balance: string;
		normalBalanceSide: "DEBIT" | "CREDIT";
		asOfJournalEntryId?: string;
	};
}

export interface LedgerAccountsResponse {
	accounts: LedgerAccountItem[];
	nextCursor: string | null;
}

export interface SpendingCategoryItem {
	id: string;
	name: string;
	defaultBudgetCategory:
		| "MANDATORY_EXPENSE"
		| "DISCRETIONARY_SPEND"
		| "SHORT_TERM_PURCHASE"
		| "ASK";
	status: "ACTIVE" | "ARCHIVED";
	sortOrder: number;
	systemDefined: boolean;
}

export interface SpendingCategoriesResponse {
	categories: SpendingCategoryItem[];
}

export interface SpendingCategoryAssignmentsResponse {
	assignments?: Record<string, string>;
	assignment?: {
		categoryId: string;
	};
}
