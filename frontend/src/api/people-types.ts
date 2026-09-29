/**
 * People & Obligations Domain Types
 *
 * Implements authoritative types from Phase F6:
 *   - src/db/schema/people.ts
 *   - src/people/product-read-v2.ts
 *   - src/people/person-settlement-orchestrator.ts
 *   - src/http/people-routes.ts
 */

export type PersonRelationship = "FAMILY" | "FRIEND" | "OTHER";

export type PersonStatus = "ACTIVE" | "ARCHIVED";

export type PersonObligationDirection = "RECEIVABLE" | "PAYABLE";

export type PersonObligationStatus = "OPEN" | "SETTLED" | "VOID";

export type PersonSettlementStatus = "ACTIVE" | "VOIDED";

export type ObligationBudgetCategory =
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE";

export interface PersonProductDto {
	personId: string;
	status: PersonStatus;
	displayName: string;
	relationship: PersonRelationship;
	note: string | null;
	revisionNo: number;
	receivableBalance: string;
	payableBalance: string;
}

export interface PersonBalanceSummaryDto {
	personId: string;
	displayName: string;
	relationship: PersonRelationship;
	exactReceivableBalance: string;
	exactPayableBalance: string;
	collectionTarget?: string | undefined;
}

export interface ObligationProductDto {
	obligationId: string;
	personId: string;
	direction: PersonObligationDirection;
	status: PersonObligationStatus;
	principalAmount: string;
	settledAmount: string;
	remainingAmount: string;
	dueDate: string | null;
	description: string | null;
	budgetCategory: ObligationBudgetCategory | string | null;
	revisionNo: number;
	isSplitManaged: boolean;
	fundingAssetAccountId?: string | null | undefined;
}

export interface SettlementProductDto {
	settlementId: string;
	obligationId: string;
	personId: string;
	direction: PersonObligationDirection;
	status: PersonSettlementStatus;
	cashAmount: string;
	appliedAmount: string;
	excessAmount: string;
	note: string | null;
	occurredAt: string;
	revisionNo: number;
	assetAccountId?: string | undefined;
	overpaymentIncomeReceiptId?: string | null | undefined;
}

export interface SettlementRoutingItem {
	destination: "CREDIT_CARD_RESERVE" | "SHORT_TERM_GOAL" | "LONG_TERM";
	amount: string;
}

export interface SettlePersonReceivablesResult {
	cashReceived: string;
	receivableApplied: string;
	excess: string;
	remainingReceivable: string;
	routing: SettlementRoutingItem[];
}

// ----------------------------------------------------------------------------
// Request Payloads
// ----------------------------------------------------------------------------

export interface CreatePersonPayload {
	displayName: string;
	relationship: PersonRelationship;
	note?: string | null | undefined;
	occurredAt: string;
}

export interface UpdatePersonPayload {
	expectedRevisionNo: number;
	displayName: string;
	relationship: PersonRelationship;
	note?: string | null | undefined;
	occurredAt: string;
}

export interface ArchivePersonPayload {
	expectedRevisionNo: number;
	occurredAt: string;
}

export interface CreateReceivablePayload {
	amount: string;
	fundingAssetAccountId: string;
	occurredAt: string;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
}

export interface CreatePayablePayload {
	amount: string;
	budgetCategory: ObligationBudgetCategory;
	occurredAt: string;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
}

export interface UpdateObligationPayload {
	expectedRevisionNo: number;
	amount: string;
	fundingAssetAccountId?: string | undefined;
	budgetCategory?: ObligationBudgetCategory | undefined;
	occurredAt: string;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
}

export interface VoidObligationPayload {
	expectedRevisionNo: number;
}

export interface SettlePersonReceivablesPayload {
	cashAmount: string;
	destinationAssetAccountId: string;
	isCash: boolean;
	occurredAt?: string | undefined;
}

export interface SettlePayablePayload {
	amount: string;
	sourceAssetAccountId: string;
	note?: string | null | undefined;
	occurredAt: string;
}

// ----------------------------------------------------------------------------
// Response Envelopes
// ----------------------------------------------------------------------------

export interface PeopleListResponse {
	people: PersonProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface PersonResponse {
	person: PersonProductDto;
	idempotentReplay?: boolean;
}

export interface ObligationsListResponse {
	obligations: ObligationProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface ObligationResponse {
	obligation: ObligationProductDto;
	idempotentReplay?: boolean;
}

export interface SettlementsListResponse {
	settlements: SettlementProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface SettlementResponse {
	settlement: SettlementProductDto;
	idempotentReplay?: boolean;
}
