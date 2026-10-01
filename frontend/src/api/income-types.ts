/**
 * Income Management API Types & Contracts (F8)
 *
 * Adheres strictly to backend contracts in:
 *   src/http/income-routes.ts
 *   src/income/product-read-v2.ts
 *   src/income/sources.ts
 *   src/income/entitlements.ts
 *   src/income/receipts.ts
 *   src/income/settlements.ts
 *   src/income/reference.ts
 *   src/income/calendar.ts
 *   src/income/errors.ts
 *   src/http/ledger-routes.ts
 */

export type IncomeSourceNature = "REGULAR" | "EXTRA" | "SUPPORT";

export type IncomeReferenceMethod =
	| "FIXED_MONTHLY"
	| "SEASONAL_ANNUALIZED"
	| "ROLLING_MEDIAN"
	| "EXCLUDED";

export interface ProductIncomeSourceItem {
	sourceId: string;
	code: string;
	name: string;
	nature: IncomeSourceNature;
	referenceMethod: IncomeReferenceMethod;
	expectedMonthlyAmount: string | null;
	seasonalMonthsPerYear: number | null;
	rollingMedianMonths: number | null;
	incomeLedgerAccountId: string;
	activeFrom: string; // YYYY-MM-DD
	activeUntil: string | null; // YYYY-MM-DD | null
	createdAt: string;
	archivedAt: string | null;
	idempotentReplay?: boolean;
}

export interface IncomeSourcesResponse {
	sources: ProductIncomeSourceItem[];
	limit: number;
	hasMore: boolean;
	nextCursor: {
		beforeCreatedAt: string;
		beforeSourceId: string;
	} | null;
}

export interface CreateIncomeSourcePayload {
	code: string;
	name: string;
	nature: IncomeSourceNature;
	referenceMethod: IncomeReferenceMethod;
	expectedMonthlyAmount?: string;
	seasonalMonthsPerYear?: number;
	rollingMedianMonths?: number;
	incomeLedgerAccountId: string;
	activeFrom: string; // YYYY-MM-DD
	activeUntil?: string | null; // YYYY-MM-DD | null
}

export interface CreateProductLedgerAccountPayload {
	code: string;
	name: string;
	accountType: "ASSET" | "INCOME";
}

export interface ProductLedgerAccountItem {
	accountId: string;
	code: string;
	name: string;
	accountType: "ASSET" | "INCOME" | "LIABILITY" | "EQUITY" | "EXPENSE";
	normalBalance: "DEBIT" | "CREDIT";
	currency: string;
	archived: boolean;
	idempotentReplay?: boolean;
}

export type IncomeEntitlementStatus = "ACTIVE" | "VOIDED";
export type IncomeEntitlementSettlementStatus =
	| "OPEN"
	| "PARTIAL"
	| "SETTLED"
	| "VOIDED";

export interface IncomeEntitlementItem {
	entitlementId: string;
	sourceId: string;
	sourceCode: string;
	sourceName: string;
	periodMonth: string; // YYYY-MM-01 (critical: always YYYY-MM-01 for backend)
	revisionNo: number;
	status: IncomeEntitlementStatus;
	amount: string;
	allocatedAmount: string;
	outstandingAmount: string;
	settlementStatus: IncomeEntitlementSettlementStatus;
	expectedReceiptOn: string | null; // YYYY-MM-DD | null
	overdue: boolean;
	note: string | null;
}

export interface IncomeEntitlementsResponse {
	entitlements: IncomeEntitlementItem[];
	limit: number;
	hasMore: boolean;
	nextCursor: {
		beforePeriodMonth: string;
		beforeEntitlementId: string;
	} | null;
}

export interface CreateIncomeEntitlementPayload {
	sourceId: string;
	periodMonth: string; // Must be "YYYY-MM-01"
	amount: string;
	expectedReceiptOn?: string | null;
	note?: string | null;
}

export interface ReviseIncomeEntitlementPayload {
	expectedRevisionNo: number;
	amount: string;
	expectedReceiptOn?: string | null;
	note?: string | null;
	reasonNote?: string | null;
}

export interface VoidIncomeEntitlementPayload {
	expectedRevisionNo: number;
	reasonNote?: string | null;
}

export type IncomeReceiptStatus = "ACTIVE" | "VOIDED";

export interface IncomeReceiptItem {
	incomeReceiptId: string;
	sourceId: string;
	sourceCode: string;
	sourceName: string;
	status: IncomeReceiptStatus;
	revisionNo: number;
	receivedAt: string; // UTC ISO string
	amount: string;
	destinationAccountId: string;
	note: string | null;
}

export interface IncomeReceiptsResponse {
	receipts: IncomeReceiptItem[];
	limit: number;
	hasMore: boolean;
	nextCursor: {
		beforeReceivedAt: string;
		beforeIncomeReceiptId: string;
	} | null;
}

export interface CreateIncomeReceiptPayload {
	sourceId: string;
	receivedAt: string; // Canonical UTC ISO
	amount: string;
	destinationAccountId: string;
	note?: string | null;
}

export interface ReviseIncomeReceiptPayload {
	expectedRevisionNo: number;
	receivedAt: string; // Canonical UTC ISO
	amount: string;
	destinationAccountId: string;
	note?: string | null;
	reasonNote?: string | null;
}

export interface VoidIncomeReceiptPayload {
	expectedRevisionNo: number;
	reasonNote?: string | null;
}

export interface IncomeReceiptSettlementAllocation {
	entitlementId: string;
	periodMonth: string; // YYYY-MM-01
	entitlementAmount: string;
	allocatedAmount: string;
	entitlementOutstandingAfterAllReceipts: string;
}

export interface IncomeReceiptSettlementResponse {
	incomeReceiptId: string;
	receiptAmount: string;
	allocatedAmount: string;
	unallocatedAmount: string;
	revisionNo: number;
	allocations: IncomeReceiptSettlementAllocation[];
}

export interface CreateIncomeSettlementPayload {
	allocations: Array<{
		entitlementId: string;
		amount: string;
	}>;
	note?: string | null;
}

export interface ReviseIncomeSettlementPayload {
	expectedRevisionNo: number;
	allocations: Array<{
		entitlementId: string;
		amount: string;
	}>;
	note?: string | null;
	reasonNote?: string | null;
}

export interface MonthlyReferenceIncomeSourceItem {
	sourceId: string;
	code: string;
	name: string;
	nature: string;
	referenceMethod: string;
	referenceAmount: string;
}

export interface MonthlyReferenceIncomeResponse {
	asOf: string; // YYYY-MM-DD
	currency: string;
	total: string;
	sources: MonthlyReferenceIncomeSourceItem[];
}
