/**
 * People & Obligations API Client
 *
 * Implements authoritative endpoints from Phase F6:
 *   - /people
 *   - /people/:id
 *   - /people/:personId/balance-summary
 *   - /people/:personId/obligations
 *   - /people/:personId/obligations/:id
 *   - /people/:personId/obligations/receivable
 *   - /people/:personId/obligations/payable
 *   - /people/:personId/obligations/:id/void
 *   - /people/:personId/obligations/:obligationId/settlements
 *   - /people/:personId/settle-receivables
 *   - /people/:personId/obligations/:obligationId/settlements/payable
 */

import { apiGet, apiPost } from "./client";
import { fetchMidasLiquidity } from "./credit-cards-api";
import type {
	ArchivePersonPayload,
	CreatePayablePayload,
	CreatePersonPayload,
	CreateReceivablePayload,
	ObligationResponse,
	ObligationsListResponse,
	PeopleListResponse,
	PersonBalanceSummaryDto,
	PersonObligationDirection,
	PersonObligationStatus,
	PersonProductDto,
	PersonRelationship,
	PersonResponse,
	PersonStatus,
	SettlementResponse,
	SettlementsListResponse,
	SettlePayablePayload,
	SettlePersonReceivablesPayload,
	SettlePersonReceivablesResult,
	UpdateObligationPayload,
	UpdatePersonPayload,
	VoidObligationPayload,
} from "./people-types";

export type * from "./people-types";
export { fetchMidasLiquidity };

// ============================================================================
// 1. People Identity
// ============================================================================

export async function fetchPeople(params?: {
	status?: PersonStatus | undefined;
	relationship?: PersonRelationship | undefined;
	limit?: number | undefined;
	after?: string | null | undefined;
}): Promise<PeopleListResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.relationship) query.set("relationship", params.relationship);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<PeopleListResponse>(`/people${qs ? `?${qs}` : ""}`);
}

export async function fetchAllActivePeople(
	limit = 100,
): Promise<PersonProductDto[]> {
	const allPeople: PersonProductDto[] = [];
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

export async function fetchPerson(personId: string): Promise<PersonResponse> {
	return apiGet<PersonResponse>(`/people/${personId}`);
}

export async function createPerson(
	payload: CreatePersonPayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<PersonResponse> {
	return apiPost<PersonResponse>("/people", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function updatePerson(
	personId: string,
	payload: UpdatePersonPayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<PersonResponse> {
	return apiPost<PersonResponse>(`/people/${personId}`, payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function archivePerson(
	personId: string,
	payload: ArchivePersonPayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<PersonResponse> {
	return apiPost<PersonResponse>(`/people/${personId}/archive`, payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

// ============================================================================
// 2. Balance Summary
// ============================================================================

export async function fetchPersonBalanceSummary(
	personId: string,
): Promise<PersonBalanceSummaryDto> {
	return apiGet<PersonBalanceSummaryDto>(`/people/${personId}/balance-summary`);
}

// ============================================================================
// 3. Obligations
// ============================================================================

export async function fetchPersonObligations(
	personId: string,
	params?: {
		direction?: PersonObligationDirection | undefined;
		status?: PersonObligationStatus | undefined;
		dueDateFrom?: string | undefined;
		dueDateUntil?: string | undefined;
		limit?: number | undefined;
		after?: string | null | undefined;
	},
): Promise<ObligationsListResponse> {
	const query = new URLSearchParams();
	if (params?.direction) query.set("direction", params.direction);
	if (params?.status) query.set("status", params.status);
	if (params?.dueDateFrom) query.set("dueDateFrom", params.dueDateFrom);
	if (params?.dueDateUntil) query.set("dueDateUntil", params.dueDateUntil);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<ObligationsListResponse>(
		`/people/${personId}/obligations${qs ? `?${qs}` : ""}`,
	);
}

export async function fetchPersonObligation(
	personId: string,
	obligationId: string,
): Promise<ObligationResponse> {
	return apiGet<ObligationResponse>(
		`/people/${personId}/obligations/${obligationId}`,
	);
}

export async function createPersonReceivable(
	personId: string,
	payload: CreateReceivablePayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<ObligationResponse> {
	return apiPost<ObligationResponse>(
		`/people/${personId}/obligations/receivable`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function createPersonPayable(
	personId: string,
	payload: CreatePayablePayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<ObligationResponse> {
	return apiPost<ObligationResponse>(
		`/people/${personId}/obligations/payable`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function updatePersonObligation(
	personId: string,
	obligationId: string,
	payload: UpdateObligationPayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<ObligationResponse> {
	return apiPost<ObligationResponse>(
		`/people/${personId}/obligations/${obligationId}`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function voidPersonObligation(
	personId: string,
	obligationId: string,
	payload: VoidObligationPayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<ObligationResponse> {
	return apiPost<ObligationResponse>(
		`/people/${personId}/obligations/${obligationId}/void`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ============================================================================
// 4. Settlements
// ============================================================================

export async function fetchObligationSettlements(
	personId: string,
	obligationId: string,
	params?: {
		status?: "ACTIVE" | "VOIDED" | undefined;
		limit?: number | undefined;
		after?: string | null | undefined;
	},
): Promise<SettlementsListResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.after) query.set("after", params.after);

	const qs = query.toString();
	return apiGet<SettlementsListResponse>(
		`/people/${personId}/obligations/${obligationId}/settlements${qs ? `?${qs}` : ""}`,
	);
}

export async function settlePersonReceivables(
	personId: string,
	payload: SettlePersonReceivablesPayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<SettlePersonReceivablesResult> {
	return apiPost<SettlePersonReceivablesResult>(
		`/people/${personId}/settle-receivables`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function settlePersonPayable(
	personId: string,
	obligationId: string,
	payload: SettlePayablePayload,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<SettlementResponse> {
	return apiPost<SettlementResponse>(
		`/people/${personId}/obligations/${obligationId}/settlements/payable`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}
