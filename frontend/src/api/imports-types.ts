/**
 * Import Domain Types (Phase F9).
 * Exact match with backend imports schema and HTTP contract.
 */

export type ImportSourceKind = "NORMALIZED_ROWS" | "GENERIC_CSV_V1";

export type ImportRecordType =
	| "CREDIT_CARD_PURCHASE"
	| "INCOME_RECEIPT"
	| "UNSUPPORTED";

export type ImportRowStatus =
	| "READY"
	| "NEEDS_REVIEW"
	| "POSSIBLE_DUPLICATE"
	| "EXACT_DUPLICATE"
	| "APPLIED"
	| "LINKED_EXISTING"
	| "SKIPPED"
	| "UNSUPPORTED";

export type ImportDuplicateCandidateType =
	| "IMPORT_ROW"
	| "CREDIT_CARD_PURCHASE"
	| "INCOME_RECEIPT";

export type ImportDuplicateReasonCode =
	| "SAME_CARD_DATE_AMOUNT"
	| "SAME_CARD_DATE_AMOUNT_MERCHANT"
	| "SAME_INCOME_SOURCE_DATE_AMOUNT"
	| "SAME_BATCH_SEMANTICS";

export type ImportResultKind =
	| "CREATED"
	| "LINKED_EXISTING"
	| "EXACT_DUPLICATE";

export type ImportResultTargetType = "CREDIT_CARD_PURCHASE" | "INCOME_RECEIPT";

export interface NormalizedCardPurchasePayload {
	recordType: "CREDIT_CARD_PURCHASE";
	cardId: string | null;
	occurredAt: string; // ISO string
	amount: string; // exact normalized decimal "12.34"
	purchaseCategory:
		| "MANDATORY"
		| "DISCRETIONARY"
		| "SHORT_TERM_PURCHASE"
		| "UNCLASSIFIED"
		| null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	installmentCount: number | null;
}

export interface NormalizedIncomeReceiptPayload {
	recordType: "INCOME_RECEIPT";
	incomeSourceId: string | null;
	destinationAccountId: string | null;
	receivedAt: string; // ISO string
	amount: string; // exact normalized decimal
	note: string | null;
}

export interface NormalizedUnsupportedPayload {
	recordType: "UNSUPPORTED";
	reason: string;
}

export type NormalizedImportPayload =
	| NormalizedCardPurchasePayload
	| NormalizedIncomeReceiptPayload
	| NormalizedUnsupportedPayload;

export interface ImportBatchSummary {
	id: string;
	userId: string;
	provider: string;
	sourceKind: ImportSourceKind;
	sourceContentHash: string;
	sourceFileName: string | null;
	parserType: string;
	parserVersion: string;
	observedAt: string;
	createdAt: string;
	totalRows: number;
	readyCount: number;
	needsReviewCount: number;
	possibleDuplicateCount: number;
	exactDuplicateCount: number;
	appliedCount: number;
	linkedCount: number;
	skippedCount: number;
	unsupportedCount: number;
}

export interface ImportRowDetail {
	id: string;
	userId: string;
	batchId: string;
	rowOrdinal: number;
	recordType: ImportRecordType;
	latestRevisionNo: number;
	status: ImportRowStatus;
	payload: NormalizedImportPayload;
	occurredAt: string | null;
	externalIdentityPresent: boolean;
	duplicateCandidates: Array<{
		candidateType: ImportDuplicateCandidateType;
		candidateId: string;
		reasonCode: ImportDuplicateReasonCode;
	}>;
	result: {
		resultKind: ImportResultKind;
		targetType: ImportResultTargetType;
		targetId: string;
		canonicalTransactionId: string | null;
		externalIdentityClaimId?: string | null;
	} | null;
}

export interface ImportBatchListResponse {
	items: ImportBatchSummary[];
	nextCursor: string | null;
}

export interface ImportBatchPreviewResponse {
	batch: ImportBatchSummary;
	rowSample: ImportRowDetail[];
	rowSampleLimit: number;
}

export interface ImportRowsListResponse {
	items: ImportRowDetail[];
	nextCursor: string | null;
}

export interface StageImportBatchRequest {
	sourceKind: "GENERIC_CSV_V1" | "NORMALIZED_ROWS";
	sourceContent?: string;
	sourceFileName?: string | null;
	observedAt: string;
	provider?: string;
	parserType?: string;
	parserVersion?: string;
	sourceContentHash?: string;
}

export interface StageImportBatchResponse {
	batch: ImportBatchSummary;
	rows: ImportRowDetail[];
	idempotentReplay: boolean;
}

export interface ResolveImportRowRequest {
	expectedRevisionNo: number;
	action: "CONFIRM_IMPORT" | "LINK_EXISTING" | "RESOLVE_MAPPINGS" | "SKIP";
	resolvedMappings?: {
		cardId?: string | null;
		purchaseCategory?:
			| "MANDATORY"
			| "DISCRETIONARY"
			| "SHORT_TERM_PURCHASE"
			| "UNCLASSIFIED"
			| null;
		shortTermGoalId?: string | null;
		incomeSourceId?: string | null;
		destinationAccountId?: string | null;
	};
	linkTarget?: {
		targetType: ImportResultTargetType;
		targetId: string;
	};
	reasonNote?: string | null;
}

export interface ResolveImportRowResponse {
	row: ImportRowDetail;
	idempotentReplay: boolean;
}

export interface ApplyReadyRowsResponse {
	appliedCount: number;
	failedCount: number;
	remainingReadyCount: number;
	hasMore: boolean;
	results: Array<{
		importRowId: string;
		status: "APPLIED" | "EXACT_DUPLICATE" | "FAILED";
		errorCode?: string;
		errorMessage?: string;
		result?: ImportRowDetail["result"];
	}>;
}
