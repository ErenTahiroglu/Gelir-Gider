/**
 * Credit Cards OS API Client
 *
 * Implements authoritative endpoints from Section 8-54.
 */

import { apiGet, apiPost } from "./client";
import type {
	ArchiveCreditCardPayload,
	AttachSplitPayload,
	CreateCreditCardPayload,
	CreateSharedPurchasePayload,
	CreateStatementPayload,
	CreditCardItem,
	CreditCardPurchaseResponse,
	CreditCardPurchaseSplitResponse,
	CreditCardPurchasesResponse,
	CreditCardResponse,
	CreditCardStatementItem,
	CreditCardStatementResponse,
	CreditCardStatementsResponse,
	CreditCardsListResponse,
	MidasLiquidityResponse,
	PayStatementPayload,
	PeopleListResponse,
	PersonItem,
	ReopenStatementPayload,
	ReviseSharedPurchasePayload,
	ReviseSplitPayload,
	SharedPurchaseResponse,
	StatementReadinessResponse,
	UpdateCreditCardPayload,
	UpdatePurchasePayload,
	UpdateStatementPayload,
	VoidPurchasePayload,
	VoidSharedPurchasePayload,
	VoidStatementPayload,
} from "./credit-cards-types";
import type { CreditCardPurchasePayload } from "./quick-entry-types";

export type * from "./credit-cards-types";

// ---------------------------------------------------------------------------
// 1. Cards
// ---------------------------------------------------------------------------

export async function fetchCreditCards(params?: {
	status?: "ACTIVE" | "ARCHIVED" | undefined;
	limit?: number | undefined;
	after?: string | null | undefined;
}): Promise<CreditCardsListResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<CreditCardsListResponse>(`/credit-cards${qs ? `?${qs}` : ""}`);
}

export async function fetchAllActiveCreditCards(
	limit = 100,
): Promise<CreditCardItem[]> {
	const allCards: CreditCardItem[] = [];
	let cursor: string | null = null;

	do {
		const page = await fetchCreditCards({
			status: "ACTIVE",
			limit,
			after: cursor,
		});
		allCards.push(...page.cards);
		cursor = page.nextCursor;
	} while (cursor !== null);

	return allCards;
}

export async function fetchCreditCard(
	cardId: string,
): Promise<CreditCardResponse> {
	return apiGet<CreditCardResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}`,
	);
}

export async function createCreditCard(
	payload: CreateCreditCardPayload,
	idempotencyKey: string,
): Promise<CreditCardResponse> {
	return apiPost<CreditCardResponse>("/credit-cards", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function updateCreditCard(
	cardId: string,
	payload: UpdateCreditCardPayload,
	idempotencyKey: string,
): Promise<CreditCardResponse> {
	return apiPost<CreditCardResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function archiveCreditCard(
	cardId: string,
	payload: ArchiveCreditCardPayload,
	idempotencyKey: string,
): Promise<CreditCardResponse> {
	return apiPost<CreditCardResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/archive`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ---------------------------------------------------------------------------
// 2. Statements
// ---------------------------------------------------------------------------

export async function fetchCreditCardStatements(
	cardId: string,
	params?: {
		status?: "OPEN" | "PAID" | "VOID" | undefined;
		limit?: number | undefined;
		after?: string | null | undefined;
	},
): Promise<CreditCardStatementsResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<CreditCardStatementsResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements${qs ? `?${qs}` : ""}`,
	);
}

export async function fetchCreditCardStatement(
	cardId: string,
	statementId: string,
): Promise<CreditCardStatementResponse> {
	return apiGet<CreditCardStatementResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}`,
	);
}

export async function fetchStatementReadiness(
	cardId: string,
	statementId: string,
): Promise<StatementReadinessResponse> {
	return apiGet<StatementReadinessResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}/readiness`,
	);
}

export async function createCreditCardStatement(
	cardId: string,
	payload: CreateStatementPayload,
	idempotencyKey: string,
): Promise<CreditCardStatementResponse> {
	return apiPost<CreditCardStatementResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function updateCreditCardStatement(
	cardId: string,
	statementId: string,
	payload: UpdateStatementPayload,
	idempotencyKey: string,
): Promise<CreditCardStatementResponse> {
	return apiPost<CreditCardStatementResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidCreditCardStatement(
	cardId: string,
	statementId: string,
	payload: VoidStatementPayload,
	idempotencyKey: string,
): Promise<CreditCardStatementResponse> {
	return apiPost<CreditCardStatementResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}/void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function payCreditCardStatement(
	cardId: string,
	statementId: string,
	payload: PayStatementPayload,
	idempotencyKey: string,
): Promise<{ statement: CreditCardStatementItem; [key: string]: unknown }> {
	return apiPost<{ statement: CreditCardStatementItem }>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}/pay`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function reopenCreditCardStatement(
	cardId: string,
	statementId: string,
	payload: ReopenStatementPayload,
	idempotencyKey: string,
): Promise<{ statement: CreditCardStatementItem }> {
	return apiPost<{ statement: CreditCardStatementItem }>(
		`/credit-cards/${encodeURIComponent(cardId)}/statements/${encodeURIComponent(statementId)}/reopen`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ---------------------------------------------------------------------------
// 3. Purchases
// ---------------------------------------------------------------------------

export async function fetchCreditCardPurchases(
	cardId: string,
	params?: {
		status?: "POSTED" | "VOID" | undefined;
		limit?: number | undefined;
		after?: string | null | undefined;
	},
): Promise<CreditCardPurchasesResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<CreditCardPurchasesResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases${qs ? `?${qs}` : ""}`,
	);
}

export async function fetchCreditCardPurchase(
	cardId: string,
	purchaseId: string,
): Promise<CreditCardPurchaseResponse> {
	return apiGet<CreditCardPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}`,
	);
}

export async function createCreditCardPurchase(
	cardId: string,
	payload: CreditCardPurchasePayload,
	idempotencyKey: string,
): Promise<{ eventId: string; [key: string]: unknown }> {
	return apiPost<{ eventId: string }>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function updateCreditCardPurchase(
	cardId: string,
	purchaseId: string,
	payload: UpdatePurchasePayload,
	idempotencyKey: string,
): Promise<CreditCardPurchaseResponse> {
	return apiPost<CreditCardPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidCreditCardPurchase(
	cardId: string,
	purchaseId: string,
	payload: VoidPurchasePayload,
	idempotencyKey: string,
): Promise<CreditCardPurchaseResponse> {
	return apiPost<CreditCardPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ---------------------------------------------------------------------------
// 4. Shared Purchases & Splits
// ---------------------------------------------------------------------------

export async function createSharedCreditCardPurchase(
	cardId: string,
	payload: CreateSharedPurchasePayload,
	idempotencyKey: string,
): Promise<SharedPurchaseResponse> {
	return apiPost<SharedPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/shared`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function fetchPurchaseSplit(
	cardId: string,
	purchaseId: string,
): Promise<CreditCardPurchaseSplitResponse> {
	return apiGet<CreditCardPurchaseSplitResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/split`,
	);
}

export async function attachPurchaseSplit(
	cardId: string,
	purchaseId: string,
	payload: AttachSplitPayload,
	idempotencyKey: string,
): Promise<CreditCardPurchaseSplitResponse> {
	return apiPost<CreditCardPurchaseSplitResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/split`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function revisePurchaseSplit(
	cardId: string,
	purchaseId: string,
	payload: ReviseSplitPayload,
	idempotencyKey: string,
): Promise<CreditCardPurchaseSplitResponse> {
	return apiPost<CreditCardPurchaseSplitResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/split/revisions`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function reviseSharedCreditCardPurchase(
	cardId: string,
	purchaseId: string,
	payload: ReviseSharedPurchasePayload,
	idempotencyKey: string,
): Promise<SharedPurchaseResponse> {
	return apiPost<SharedPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/shared-revisions`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidSharedCreditCardPurchase(
	cardId: string,
	purchaseId: string,
	payload: VoidSharedPurchasePayload,
	idempotencyKey: string,
): Promise<SharedPurchaseResponse> {
	return apiPost<SharedPurchaseResponse>(
		`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/shared-void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ---------------------------------------------------------------------------
// 5. External Read-Only Dependencies: Midas & People
// ---------------------------------------------------------------------------

export async function fetchMidasLiquidity(): Promise<MidasLiquidityResponse> {
	return apiGet<MidasLiquidityResponse>("/midas/liquidity");
}

export async function fetchPeople(params?: {
	status?: "ACTIVE" | "ARCHIVED";
	limit?: number;
	after?: string | null;
}): Promise<PeopleListResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<PeopleListResponse>(`/people${qs ? `?${qs}` : ""}`);
}

export async function fetchAllActivePeople(limit = 100): Promise<PersonItem[]> {
	const allPeople: PersonItem[] = [];
	let cursor: string | null = null;

	do {
		const page = await fetchPeople({
			status: "ACTIVE",
			limit,
			after: cursor,
		});
		allPeople.push(...page.people);
		cursor = page.nextCursor;
	} while (cursor !== null);

	return allPeople;
}
