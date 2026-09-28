/**
 * Quick Entry & Synced Templates API Client
 *
 * Implements:
 *   - GET  /quick-entry/templates
 *   - GET  /quick-entry/templates/:id
 *   - POST /quick-entry/templates
 *   - POST /quick-entry/templates/:id
 *   - POST /quick-entry/templates/:id/archive
 *   - GET  /credit-cards?status=ACTIVE&limit=100 (cursor loop)
 *   - POST /credit-cards/:cardId/purchases (with Idempotency-Key)
 *   - POST /spending/category-assignments
 */

import { apiGet, apiPost } from "./client";
import type {
	CreditCardItem,
	CreditCardsListResponse,
} from "./dashboard-types";
import type {
	AssignCategoryPayload,
	AssignCategoryResponse,
	CreateTemplatePayload,
	CreditCardPurchasePayload,
	CreditCardPurchaseResponse,
	QuickEntryTemplateResponse,
	QuickEntryTemplatesResponse,
	UpdateTemplatePayload,
} from "./quick-entry-types";

export async function fetchQuickEntryTemplates(): Promise<QuickEntryTemplatesResponse> {
	return apiGet<QuickEntryTemplatesResponse>("/quick-entry/templates");
}

export async function fetchQuickEntryTemplate(
	id: string,
): Promise<QuickEntryTemplateResponse> {
	return apiGet<QuickEntryTemplateResponse>(
		`/quick-entry/templates/${encodeURIComponent(id)}`,
	);
}

export async function createQuickEntryTemplate(
	payload: CreateTemplatePayload,
): Promise<QuickEntryTemplateResponse> {
	return apiPost<QuickEntryTemplateResponse>("/quick-entry/templates", payload);
}

export async function updateQuickEntryTemplate(
	id: string,
	payload: UpdateTemplatePayload,
): Promise<QuickEntryTemplateResponse> {
	return apiPost<QuickEntryTemplateResponse>(
		`/quick-entry/templates/${encodeURIComponent(id)}`,
		payload,
	);
}

export async function archiveQuickEntryTemplate(
	id: string,
): Promise<QuickEntryTemplateResponse> {
	return apiPost<QuickEntryTemplateResponse>(
		`/quick-entry/templates/${encodeURIComponent(id)}/archive`,
		{},
	);
}

/**
 * Fetches ALL active credit cards by following keyset cursor `after` until `nextCursor === null`.
 */
export async function fetchAllActiveCreditCards(
	limit = 100,
): Promise<CreditCardItem[]> {
	const allCards: CreditCardItem[] = [];
	let cursor: string | null = null;

	do {
		const query = new URLSearchParams();
		query.set("status", "ACTIVE");
		query.set("limit", String(limit));
		if (cursor) {
			query.set("after", cursor);
		}

		const page = await apiGet<CreditCardsListResponse>(
			`/credit-cards?${query.toString()}`,
		);
		allCards.push(...page.cards);
		cursor = page.nextCursor;
	} while (cursor !== null);

	return allCards;
}

/**
 * Records a canonical credit card purchase.
 */
export async function createCreditCardPurchase(
	cardId: string,
	payload: CreditCardPurchasePayload,
	idempotencyKey: string,
): Promise<CreditCardPurchaseResponse> {
	return apiPost<CreditCardPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

/**
 * Assigns a spending category to a subject (e.g. CREDIT_CARD_PURCHASE).
 */
export async function assignSpendingCategory(
	payload: AssignCategoryPayload,
): Promise<AssignCategoryResponse> {
	return apiPost<AssignCategoryResponse>(
		"/spending/category-assignments",
		payload,
	);
}
