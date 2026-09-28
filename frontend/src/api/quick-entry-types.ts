/**
 * Quick Entry & Synced Templates Types & Contracts
 *
 * Adheres strictly to backend contracts in:
 *   src/db/schema/quick-entry-templates.ts
 *   src/quick-entry-templates/validation.ts
 *   src/http/quick-entry-template-routes.ts
 *   src/http/credit-card-routes.ts
 *   src/http/spending-category-routes.ts
 */

export type QuickEntryTemplateType =
	| "CREDIT_CARD_EXPENSE"
	| "MANUAL_EXPENSE"
	| "INCOME"
	| "RECEIVABLE"
	| "PAYABLE";

export type QuickEntryTemplateStatus = "ACTIVE" | "ARCHIVED";

export type BudgetCategorySelection =
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE";

export interface ManualExpenseTemplateConfig {
	sourceAssetAccountId?: string | undefined;
	spendingCategoryId?: string | undefined;
	budgetCategoryOverride?: BudgetCategorySelection | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	defaultAmount?: string | undefined;
}

export interface CreditCardExpenseTemplateConfig {
	cardId?: string | undefined;
	spendingCategoryId?: string | undefined;
	budgetCategoryOverride?: BudgetCategorySelection | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	shortTermGoalId?: string | undefined;
	defaultAmount?: string | undefined;
}

export interface IncomeTemplateConfig {
	incomeSourceId?: string | undefined;
	description?: string | undefined;
	defaultAmount?: string | undefined;
}

export interface ReceivablePayableTemplateConfig {
	personId?: string | undefined;
	description?: string | undefined;
	defaultAmount?: string | undefined;
	dueDate?: string | undefined;
}

export interface QuickEntryTemplateItem {
	id: string;
	userId: string;
	name: string;
	templateType: QuickEntryTemplateType;
	config: Record<string, unknown>;
	sortOrder: number;
	status: QuickEntryTemplateStatus;
	createdAt: string;
	updatedAt: string;
}

export interface QuickEntryTemplatesResponse {
	templates: QuickEntryTemplateItem[];
}

export interface QuickEntryTemplateResponse {
	template: QuickEntryTemplateItem;
}

export interface CreateTemplatePayload {
	name: string;
	templateType: "MANUAL_EXPENSE" | "CREDIT_CARD_EXPENSE";
	config: Record<string, unknown>;
	sortOrder?: number | undefined;
}

export interface UpdateTemplatePayload {
	name?: string | undefined;
	config?: Record<string, unknown> | undefined;
	sortOrder?: number | undefined;
}

export interface CreditCardPurchasePayload {
	amount: string;
	purchaseCategory: BudgetCategorySelection;
	shortTermGoalId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	occurredAt: string;
}

export interface CreditCardPurchaseResponse {
	eventId: string;
	revisionId: string;
	revisionNo: number;
	operation: string;
	status: "POSTED" | "VOID";
	idempotentReplay: boolean;
	snapshot: unknown;
}

export interface AssignCategoryPayload {
	subjectType: "CREDIT_CARD_PURCHASE" | "MANUAL_EXPENSE";
	subjectId: string;
	categoryId: string;
}

export interface AssignCategoryResponse {
	assignment: {
		userId: string;
		subjectType: string;
		subjectId: string;
		categoryId: string;
		createdAt: string;
	};
}
