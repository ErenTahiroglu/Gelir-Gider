/**
 * Manual Expenses, Ledger Accounts & Spending Categories API
 *
 * Implements:
 *   - GET /manual-expenses/:id
 *   - POST /manual-expenses (with Idempotency-Key header)
 *   - POST /manual-expenses/:id (with Idempotency-Key header)
 *   - POST /manual-expenses/:id/void (with Idempotency-Key header)
 *   - GET /ledger/accounts (paginated helper)
 *   - GET /spending/categories
 *   - GET /spending/category-assignments
 */

import { apiGet, apiPost } from "./client";
import type {
	CreateManualExpensePayload,
	LedgerAccountItem,
	LedgerAccountsResponse,
	ManualExpenseGetResponse,
	ManualExpenseMutationResult,
	SpendingCategoriesResponse,
	SpendingCategoryAssignmentsResponse,
	UpdateManualExpensePayload,
	VoidManualExpensePayload,
} from "./manual-expenses-types";

export async function fetchManualExpense(
	expenseId: string,
): Promise<ManualExpenseGetResponse> {
	return apiGet<ManualExpenseGetResponse>(
		`/manual-expenses/${encodeURIComponent(expenseId)}`,
	);
}

export async function createManualExpense(
	payload: CreateManualExpensePayload,
	idempotencyKey: string,
): Promise<ManualExpenseMutationResult> {
	return apiPost<ManualExpenseMutationResult>("/manual-expenses", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function updateManualExpense(
	expenseId: string,
	payload: UpdateManualExpensePayload,
	idempotencyKey: string,
): Promise<ManualExpenseMutationResult> {
	return apiPost<ManualExpenseMutationResult>(
		`/manual-expenses/${encodeURIComponent(expenseId)}`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidManualExpense(
	expenseId: string,
	payload: VoidManualExpensePayload,
	idempotencyKey: string,
): Promise<ManualExpenseMutationResult> {
	return apiPost<ManualExpenseMutationResult>(
		`/manual-expenses/${encodeURIComponent(expenseId)}/void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

/**
 * Fetches ALL active ledger accounts by following keyset cursor `after` until `nextCursor === null`.
 */
export async function fetchAllLedgerAccounts(
	limit = 100,
): Promise<LedgerAccountItem[]> {
	const allAccounts: LedgerAccountItem[] = [];
	let cursor: string | null = null;

	do {
		const query = new URLSearchParams();
		query.set("limit", String(limit));
		query.set("includeArchived", "false");
		if (cursor) {
			query.set("after", cursor);
		}

		const page = await apiGet<LedgerAccountsResponse>(
			`/ledger/accounts?${query.toString()}`,
		);
		allAccounts.push(...page.accounts);
		cursor = page.nextCursor;
	} while (cursor !== null);

	return allAccounts;
}

export async function fetchSpendingCategories(): Promise<SpendingCategoriesResponse> {
	return apiGet<SpendingCategoriesResponse>("/spending/categories");
}

export async function fetchCategoryAssignment(
	transactionId: string,
): Promise<SpendingCategoryAssignmentsResponse> {
	return apiGet<SpendingCategoryAssignmentsResponse>(
		`/spending/category-assignments?subjectType=MANUAL_EXPENSE&subjectId=${encodeURIComponent(transactionId)}`,
	);
}
