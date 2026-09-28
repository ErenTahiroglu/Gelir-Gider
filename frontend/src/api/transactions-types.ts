/**
 * Canonical Transaction & Revision Types
 *
 * Adheres strictly to:
 *   - GET /transactions
 *   - GET /transactions/:transactionId
 *   - GET /transactions/:transactionId/revisions
 */

export interface TransactionSummaryItem {
	transactionId: string;
	kind: string;
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	occurredAt: string;
	payload: Record<string, unknown>;
	createdAt: string;
	latestRevisionCreatedAt: string;
}

export interface TransactionsCursor {
	beforeOccurredAt: string;
	beforeTransactionId: string;
}

export interface TransactionsListResponse {
	transactions: TransactionSummaryItem[];
	nextCursor: TransactionsCursor | null;
}

export interface TransactionDetailResponse {
	transactionId: string;
	kind: string;
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	occurredAt: string;
	payload: Record<string, unknown>;
	createdAt: string;
	latestRevisionCreatedAt: string;
}

export interface TransactionRevisionItem {
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	occurredAt: string;
	payload: Record<string, unknown>;
	reasonCode: string | null;
	reasonNote: string | null;
	createdAt: string;
}

export interface TransactionRevisionsResponse {
	transactionId: string;
	revisions: TransactionRevisionItem[];
	nextCursor: {
		beforeRevisionNo: number;
	} | null;
}
