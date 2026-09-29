/**
 * Credit Cards OS API Types
 *
 * Authority:
 *   - src/http/credit-card-routes.ts
 *   - src/credit-cards/*
 *   - src/http/midas-routes.ts
 *   - src/http/people-routes.ts
 *   - docs/FRONTEND_BACKEND_CONTRACT.md
 */

import type { BudgetCategorySelection } from "./quick-entry-types";

export type CreditCardStatus = "ACTIVE" | "ARCHIVED";
export type StatementStatus = "OPEN" | "PAID" | "VOID";
export type PurchaseStatus = "POSTED" | "VOID";
export type ReservePlacement = "MIDAS_FUND" | "OUTSIDE_MIDAS";
export type LiabilityCoverage = "READY" | "SHORTFALL";
export type SplitMethod = "EQUAL" | "MANUAL" | "RATIO";
export type ParticipantSettlementStatus =
	| "PENDING"
	| "PARTIALLY_SETTLED"
	| "SETTLED";

// ---------------------------------------------------------------------------
// Credit Card DTOs
// ---------------------------------------------------------------------------

export interface CreditCardItem {
	cardId: string;
	code: string;
	status: CreditCardStatus;
	revisionNo: number;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour: string | null;
	note: string | null;
	createdAt: string;
	updatedAt?: string;
	liabilityAccountId?: string;
	liveLiabilityBalance?: string;
}

export interface CreditCardsListResponse {
	cards: CreditCardItem[];
	nextCursor: string | null;
}

export interface CreditCardResponse {
	card: CreditCardItem;
}

export interface CreateCreditCardPayload {
	code: string;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour?: string | undefined;
	note?: string | undefined;
	occurredAt: string;
}

export interface UpdateCreditCardPayload {
	expectedRevisionNo: number;
	displayName: string;
	issuer: string;
	statementDay: number;
	dueDay: number;
	creditLimit: string;
	lastFour?: string | undefined;
	note?: string | undefined;
	changeReason?: string | undefined;
	occurredAt: string;
}

export interface ArchiveCreditCardPayload {
	expectedRevisionNo: number;
	changeReason?: string | undefined;
	occurredAt: string;
}

// ---------------------------------------------------------------------------
// Statement DTOs
// ---------------------------------------------------------------------------

export interface CreditCardStatementItem {
	statementId: string;
	cardId: string;
	cycleYear: number;
	cycleMonth: number; // 1..12
	status: StatementStatus;
	revisionNo: number;
	statementAmount: string;
	statementDate: string; // ISO date YYYY-MM-DD
	dueDate: string; // ISO date YYYY-MM-DD
	reservePlacement: ReservePlacement;
	reserveAmount: string;
	reserveSatisfied: boolean;
	note: string | null;
	createdAt?: string;
	updatedAt?: string;
	paidAt?: string | null;
	reopenedAt?: string | null;
	voidedAt?: string | null;
}

export interface CreditCardStatementsResponse {
	statements: CreditCardStatementItem[];
	nextCursor: string | null;
}

export interface CreditCardStatementResponse {
	statement: CreditCardStatementItem;
}

export interface CreateStatementPayload {
	midasAccountId: string;
	cycleMonth: string; // "YYYY-MM"
	statementAmount: string;
	reservePlacement: ReservePlacement;
	note?: string | undefined;
	occurredAt: string;
}

export interface UpdateStatementPayload {
	expectedRevisionNo: number;
	statementAmount: string;
	reservePlacement: ReservePlacement;
	note?: string | undefined;
	reasonNote?: string | undefined;
	occurredAt: string;
}

export interface VoidStatementPayload {
	expectedRevisionNo: number;
	reasonNote?: string | undefined;
	occurredAt: string;
}

export interface StatementReadinessDto {
	statementId: string;
	cardId: string;
	statementAmount: string;
	cardLiabilityBalance: string;
	reservePlacement: ReservePlacement;
	reserveAmount: string;
	liabilityCoverage: LiabilityCoverage;
	liabilityAfterPayment: string;
}

export interface StatementReadinessResponse {
	readiness: StatementReadinessDto;
}

export interface PayStatementPayload {
	expectedRevisionNo: number;
	paymentAmount?: string | undefined;
	paymentMethod?: "MIDAS_FUND" | "OUTSIDE_MIDAS" | undefined;
	outsidePaymentAssetAccountId?: string | undefined;
	occurredAt: string;
}

export interface ReopenStatementPayload {
	expectedRevisionNo: number;
	reasonNote?: string | undefined;
	occurredAt: string;
}

// ---------------------------------------------------------------------------
// Purchase DTOs
// ---------------------------------------------------------------------------

export interface CreditCardPurchaseItem {
	eventId?: string;
	purchaseId?: string;
	cardId: string;
	revisionNo: number;
	status: PurchaseStatus;
	amount: string; // Gross card purchase
	personalExpenseAmount: string;
	externalReceivableAmount: string;
	purchaseCategory: BudgetCategorySelection | string;
	merchant: string | null;
	description: string | null;
	installmentCount: number | null;
	purchaseDate?: string; // ISO date
	occurredAt?: string;
	split: {
		splitId: string;
		status: "ACTIVE" | "VOID";
		splitMethod: SplitMethod;
		userShareAmount: string;
		externalShareAmount: string;
		participantCount: number;
	} | null;
	shortTermGoalId?: string | null;
}

export interface CreditCardPurchasesResponse {
	purchases: CreditCardPurchaseItem[];
	nextCursor: string | null;
}

export interface CreditCardPurchaseResponse {
	purchase: CreditCardPurchaseItem;
}

export interface UpdatePurchasePayload {
	expectedRevisionNo: number;
	amount: string;
	purchaseCategory: BudgetCategorySelection;
	shortTermGoalId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	installmentCount?: number | undefined;
	occurredAt: string;
}

export interface VoidPurchasePayload {
	expectedRevisionNo: number;
	reasonNote?: string | undefined;
	occurredAt: string;
}

// ---------------------------------------------------------------------------
// Shared Purchase & Splits
// ---------------------------------------------------------------------------

export interface SplitParticipantInput {
	personId: string;
	shareAmount?: string | undefined; // only MANUAL
	weight?: number | undefined; // only RATIO
	dueDate?: string | undefined; // "YYYY-MM-DD"
	description?: string | undefined;
}

export interface CreateSharedPurchasePayload {
	amount: string;
	purchaseCategory: BudgetCategorySelection;
	shortTermGoalId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	installmentCount?: number | undefined;
	occurredAt: string;
	splitMethod: SplitMethod;
	userWeight?: number | undefined; // only RATIO
	participants: SplitParticipantInput[];
}

export interface SplitParticipantProductDto {
	participantId?: string;
	personId: string;
	displayName: string;
	shareAmount: string;
	settledAmount?: string;
	remainingAmount: string;
	settlementStatus?: ParticipantSettlementStatus;
	weight?: number | null;
	dueDate?: string | null;
	description?: string | null;
	obligationId?: string | null;
}

export interface CreditCardPurchaseSplitProductDto {
	splitId: string;
	purchaseEventId?: string;
	purchaseId?: string;
	cardId: string;
	revisionNo: number;
	status: "ACTIVE" | "VOID";
	splitMethod: SplitMethod;
	grossAmount: string;
	userShareAmount: string;
	externalShareAmount: string;
	userWeight: number | null;
	participants: SplitParticipantProductDto[];
	createdAt?: string;
	updatedAt?: string;
}

export type PurchaseSplitItem = CreditCardPurchaseSplitProductDto;

export interface SharedPurchaseResponse {
	purchase: CreditCardPurchaseItem;
	split: CreditCardPurchaseSplitProductDto;
	idempotentReplay?: boolean;
}

export interface CreditCardPurchaseSplitResponse {
	split: CreditCardPurchaseSplitProductDto;
}

export interface AttachSplitPayload {
	splitMethod: SplitMethod;
	userWeight?: number | undefined;
	participants: SplitParticipantInput[];
	occurredAt: string;
}

export interface ReviseSplitPayload {
	expectedRevisionNo: number;
	splitMethod: SplitMethod;
	userWeight?: number | undefined;
	participants: SplitParticipantInput[];
	occurredAt: string;
}

export interface ReviseSharedPurchasePayload {
	expectedPurchaseRevisionNo: number;
	expectedSplitRevisionNo: number;
	amount: string;
	purchaseCategory: BudgetCategorySelection;
	shortTermGoalId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	installmentCount?: number | undefined;
	occurredAt: string;
	splitMethod: SplitMethod;
	userWeight?: number | undefined;
	participants: SplitParticipantInput[];
}

export interface VoidSharedPurchasePayload {
	expectedPurchaseRevisionNo: number;
	expectedSplitRevisionNo: number;
	reasonNote?: string | undefined;
	occurredAt: string;
}

// ---------------------------------------------------------------------------
// External Dependencies (Read-Only)
// ---------------------------------------------------------------------------

export interface MidasBucketDto {
	bucketId: string;
	name: string;
	bucketType: string;
	allocatedAmount: string;
}

export interface MidasLiquidityDto {
	midasAccountId: string;
	ledgerAccountId: string;
	currency: string;
	physicalBalance: string;
	totalEarmarked: string;
	unallocatedBalance: string;
	buckets: MidasBucketDto[];
}

export interface MidasLiquidityResponse {
	liquidity: MidasLiquidityDto | null;
}

export interface PersonItem {
	personId: string;
	displayName: string;
	relationship?: string;
	status?: "ACTIVE" | "ARCHIVED";
	revisionNo?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface PeopleListResponse {
	people: PersonItem[];
	nextCursor: string | null;
}
