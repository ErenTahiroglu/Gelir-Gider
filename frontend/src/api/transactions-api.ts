/**
 * Transactions API Client Functions
 *
 * Calls:
 *   - GET /transactions (with limit, status, kind, beforeOccurredAt, beforeTransactionId)
 *   - GET /transactions/:transactionId
 *   - GET /transactions/:transactionId/revisions
 */

import { apiGet } from "./client";
import type {
	TransactionDetailResponse,
	TransactionRevisionsResponse,
	TransactionsListResponse,
} from "./transactions-types";

export interface ListTransactionsParams {
	limit?: number | undefined;
	status?: "ACTIVE" | "VOIDED" | undefined;
	kind?: string | undefined;
	beforeOccurredAt?: string | undefined;
	beforeTransactionId?: string | undefined;
}

export async function fetchTransactions(
	params: ListTransactionsParams = {},
): Promise<TransactionsListResponse> {
	const query = new URLSearchParams();
	query.set("limit", String(params.limit ?? 50));

	if (params.status) {
		query.set("status", params.status);
	}
	if (params.kind) {
		query.set("kind", params.kind);
	}
	if (params.beforeOccurredAt && params.beforeTransactionId) {
		query.set("beforeOccurredAt", params.beforeOccurredAt);
		query.set("beforeTransactionId", params.beforeTransactionId);
	}

	return apiGet<TransactionsListResponse>(`/transactions?${query.toString()}`);
}

export async function fetchTransactionDetail(
	transactionId: string,
): Promise<TransactionDetailResponse> {
	return apiGet<TransactionDetailResponse>(
		`/transactions/${encodeURIComponent(transactionId)}`,
	);
}

export interface ListTransactionRevisionsParams {
	limit?: number | undefined;
	beforeRevisionNo?: number | undefined;
}

export async function fetchTransactionRevisions(
	transactionId: string,
	params: ListTransactionRevisionsParams = {},
): Promise<TransactionRevisionsResponse> {
	const query = new URLSearchParams();
	query.set("limit", String(params.limit ?? 50));

	if (params.beforeRevisionNo !== undefined) {
		query.set("beforeRevisionNo", String(params.beforeRevisionNo));
	}

	return apiGet<TransactionRevisionsResponse>(
		`/transactions/${encodeURIComponent(transactionId)}/revisions?${query.toString()}`,
	);
}
