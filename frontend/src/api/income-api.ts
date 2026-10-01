/**
 * Income Management API Client (F8)
 *
 * Implements strict backend contracts for:
 *   - Sources (GET /income/sources, POST /income/sources, POST /income/sources/:id/archive)
 *   - Ledger account provisioning (POST /ledger/accounts)
 *   - Entitlements (GET /income/entitlements, POST /income/entitlements, POST /income/entitlements/:id/revisions, POST /income/entitlements/:id/void)
 *   - Receipts (GET /income/receipts, POST /income/receipts, POST /income/receipts/:id/revisions, POST /income/receipts/:id/void)
 *   - Settlements (GET /income/receipts/:id/settlement, POST /income/receipts/:id/settlement, POST /income/receipts/:id/settlement/revisions)
 *   - Reference Income (GET /income/reference?asOf=YYYY-MM-DD)
 */

import { apiGet, apiPost } from "./client";
import { ApiError } from "./errors";
import type {
	CreateIncomeEntitlementPayload,
	CreateIncomeReceiptPayload,
	CreateIncomeSettlementPayload,
	CreateIncomeSourcePayload,
	CreateProductLedgerAccountPayload,
	IncomeEntitlementItem,
	IncomeEntitlementsResponse,
	IncomeReceiptItem,
	IncomeReceiptSettlementResponse,
	IncomeReceiptsResponse,
	IncomeSourcesResponse,
	MonthlyReferenceIncomeResponse,
	ProductIncomeSourceItem,
	ProductLedgerAccountItem,
	ReviseIncomeEntitlementPayload,
	ReviseIncomeReceiptPayload,
	ReviseIncomeSettlementPayload,
	VoidIncomeEntitlementPayload,
	VoidIncomeReceiptPayload,
} from "./income-types";

// ============================================================================
// 1. SOURCES
// ============================================================================

export async function fetchIncomeSources(params?: {
	limit?: number;
	includeArchived?: boolean;
	beforeCreatedAt?: string;
	beforeSourceId?: string;
}): Promise<IncomeSourcesResponse> {
	const query = new URLSearchParams();
	if (params?.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params?.includeArchived !== undefined) {
		query.set("includeArchived", String(params.includeArchived));
	}
	if (params?.beforeCreatedAt && params?.beforeSourceId) {
		query.set("beforeCreatedAt", params.beforeCreatedAt);
		query.set("beforeSourceId", params.beforeSourceId);
	}

	const qs = query.toString();
	const path = qs ? `/income/sources?${qs}` : "/income/sources";
	return apiGet<IncomeSourcesResponse>(path);
}

export async function fetchAllActiveIncomeSources(
	limit = 100,
): Promise<ProductIncomeSourceItem[]> {
	const allSources: ProductIncomeSourceItem[] = [];
	let beforeCreatedAt: string | undefined;
	let beforeSourceId: string | undefined;

	do {
		const page = await fetchIncomeSources({
			limit,
			includeArchived: false,
			...(beforeCreatedAt !== undefined ? { beforeCreatedAt } : {}),
			...(beforeSourceId !== undefined ? { beforeSourceId } : {}),
		});
		allSources.push(...page.sources);
		if (page.hasMore && page.nextCursor) {
			beforeCreatedAt = page.nextCursor.beforeCreatedAt;
			beforeSourceId = page.nextCursor.beforeSourceId;
		} else {
			break;
		}
	} while (beforeCreatedAt && beforeSourceId);

	return allSources;
}

export async function fetchIncomeSource(
	sourceId: string,
): Promise<ProductIncomeSourceItem> {
	return apiGet<ProductIncomeSourceItem>(
		`/income/sources/${encodeURIComponent(sourceId)}`,
	);
}

/**
 * Creates income source with natural replay (NO Idempotency-Key header).
 */
export async function createIncomeSource(
	payload: CreateIncomeSourcePayload,
): Promise<ProductIncomeSourceItem> {
	return apiPost<ProductIncomeSourceItem>("/income/sources", payload);
}

/**
 * Archives income source (NO Idempotency-Key header).
 */
export async function archiveIncomeSource(
	sourceId: string,
): Promise<ProductIncomeSourceItem> {
	return apiPost<ProductIncomeSourceItem>(
		`/income/sources/${encodeURIComponent(sourceId)}/archive`,
		{},
	);
}

// ============================================================================
// 2. LEDGER ACCOUNT PROVISIONING
// ============================================================================

/**
 * Safe product ledger account provisioning (NO Idempotency-Key header).
 * Can create INCOME or ASSET account for fresh-user onboarding.
 */
export async function createProductLedgerAccount(
	payload: CreateProductLedgerAccountPayload,
): Promise<ProductLedgerAccountItem> {
	return apiPost<ProductLedgerAccountItem>("/ledger/accounts", payload);
}

// ============================================================================
// 3. ENTITLEMENTS
// ============================================================================

export async function fetchIncomeEntitlements(params?: {
	limit?: number;
	sourceId?: string;
	periodMonthFrom?: string; // YYYY-MM-01
	periodMonthUntil?: string; // YYYY-MM-01
	overdueAsOf?: string; // YYYY-MM-DD
	beforePeriodMonth?: string;
	beforeEntitlementId?: string;
}): Promise<IncomeEntitlementsResponse> {
	const query = new URLSearchParams();
	if (params?.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params?.sourceId) {
		query.set("sourceId", params.sourceId);
	}
	if (params?.periodMonthFrom) {
		query.set("periodMonthFrom", params.periodMonthFrom);
	}
	if (params?.periodMonthUntil) {
		query.set("periodMonthUntil", params.periodMonthUntil);
	}
	if (params?.overdueAsOf) {
		query.set("overdueAsOf", params.overdueAsOf);
	}
	if (params?.beforePeriodMonth && params?.beforeEntitlementId) {
		query.set("beforePeriodMonth", params.beforePeriodMonth);
		query.set("beforeEntitlementId", params.beforeEntitlementId);
	}

	const qs = query.toString();
	const path = qs ? `/income/entitlements?${qs}` : "/income/entitlements";
	return apiGet<IncomeEntitlementsResponse>(path);
}

export async function fetchIncomeEntitlement(
	entitlementId: string,
): Promise<IncomeEntitlementItem> {
	return apiGet<IncomeEntitlementItem>(
		`/income/entitlements/${encodeURIComponent(entitlementId)}`,
	);
}

export async function createIncomeEntitlement(
	payload: CreateIncomeEntitlementPayload,
	idempotencyKey: string,
): Promise<IncomeEntitlementItem> {
	return apiPost<IncomeEntitlementItem>("/income/entitlements", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function reviseIncomeEntitlement(
	entitlementId: string,
	payload: ReviseIncomeEntitlementPayload,
	idempotencyKey: string,
): Promise<IncomeEntitlementItem> {
	return apiPost<IncomeEntitlementItem>(
		`/income/entitlements/${encodeURIComponent(entitlementId)}/revisions`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidIncomeEntitlement(
	entitlementId: string,
	payload: VoidIncomeEntitlementPayload,
	idempotencyKey: string,
): Promise<IncomeEntitlementItem> {
	return apiPost<IncomeEntitlementItem>(
		`/income/entitlements/${encodeURIComponent(entitlementId)}/void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ============================================================================
// 4. RECEIPTS
// ============================================================================

export async function fetchIncomeReceipts(params?: {
	limit?: number;
	sourceId?: string;
	from?: string; // YYYY-MM-DD
	to?: string; // YYYY-MM-DD
	includeVoided?: boolean;
	beforeReceivedAt?: string;
	beforeIncomeReceiptId?: string;
}): Promise<IncomeReceiptsResponse> {
	const query = new URLSearchParams();
	if (params?.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params?.sourceId) {
		query.set("sourceId", params.sourceId);
	}
	if (params?.from) {
		query.set("from", params.from);
	}
	if (params?.to) {
		query.set("to", params.to);
	}
	if (params?.includeVoided !== undefined) {
		query.set("includeVoided", String(params.includeVoided));
	}
	if (params?.beforeReceivedAt && params?.beforeIncomeReceiptId) {
		query.set("beforeReceivedAt", params.beforeReceivedAt);
		query.set("beforeIncomeReceiptId", params.beforeIncomeReceiptId);
	}

	const qs = query.toString();
	const path = qs ? `/income/receipts?${qs}` : "/income/receipts";
	return apiGet<IncomeReceiptsResponse>(path);
}

export async function fetchIncomeReceipt(
	incomeReceiptId: string,
): Promise<IncomeReceiptItem> {
	return apiGet<IncomeReceiptItem>(
		`/income/receipts/${encodeURIComponent(incomeReceiptId)}`,
	);
}

export async function createIncomeReceipt(
	payload: CreateIncomeReceiptPayload,
	idempotencyKey: string,
): Promise<IncomeReceiptItem> {
	return apiPost<IncomeReceiptItem>("/income/receipts", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function reviseIncomeReceipt(
	incomeReceiptId: string,
	payload: ReviseIncomeReceiptPayload,
	idempotencyKey: string,
): Promise<IncomeReceiptItem> {
	return apiPost<IncomeReceiptItem>(
		`/income/receipts/${encodeURIComponent(incomeReceiptId)}/revisions`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidIncomeReceipt(
	incomeReceiptId: string,
	payload: VoidIncomeReceiptPayload,
	idempotencyKey: string,
): Promise<IncomeReceiptItem> {
	return apiPost<IncomeReceiptItem>(
		`/income/receipts/${encodeURIComponent(incomeReceiptId)}/void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ============================================================================
// 5. SETTLEMENTS
// ============================================================================

export async function fetchIncomeReceiptSettlement(
	incomeReceiptId: string,
): Promise<IncomeReceiptSettlementResponse | null> {
	try {
		return await apiGet<IncomeReceiptSettlementResponse>(
			`/income/receipts/${encodeURIComponent(incomeReceiptId)}/settlement`,
		);
	} catch (err) {
		if (err instanceof ApiError && err.code === "INCOME_SETTLEMENT_NOT_FOUND") {
			return null;
		}
		throw err;
	}
}

export async function createIncomeSettlement(
	incomeReceiptId: string,
	payload: CreateIncomeSettlementPayload,
	idempotencyKey: string,
): Promise<IncomeReceiptSettlementResponse> {
	return apiPost<IncomeReceiptSettlementResponse>(
		`/income/receipts/${encodeURIComponent(incomeReceiptId)}/settlement`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function reviseIncomeSettlement(
	incomeReceiptId: string,
	payload: ReviseIncomeSettlementPayload,
	idempotencyKey: string,
): Promise<IncomeReceiptSettlementResponse> {
	return apiPost<IncomeReceiptSettlementResponse>(
		`/income/receipts/${encodeURIComponent(incomeReceiptId)}/settlement/revisions`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ============================================================================
// 6. REFERENCE INCOME
// ============================================================================

export async function fetchMonthlyReferenceIncome(
	asOf?: string, // YYYY-MM-DD
): Promise<MonthlyReferenceIncomeResponse> {
	const query = new URLSearchParams();
	if (asOf) {
		query.set("asOf", asOf);
	}
	const qs = query.toString();
	const path = qs ? `/income/reference?${qs}` : "/income/reference";
	return apiGet<MonthlyReferenceIncomeResponse>(path);
}
