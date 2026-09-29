/**
 * Phase F7 Domain Types
 *
 * Midas Liquidity, Short-Term Goals, and Long-Term Investment Tasks.
 */

// ============================================================================
// Midas Liquidity Types
// ============================================================================

export type MidasBucketType =
	| "CREDIT_CARD_RESERVE"
	| "SHORT_TERM_GOAL"
	| "MEDIUM_TERM_RESERVE"
	| "INCOME_BUFFER"
	| "PENDING_LONG_TERM"
	| "CORE_EMERGENCY_FUND";

export interface MidasBucketProductDto {
	bucketId: string;
	code: string;
	name: string;
	bucketType: MidasBucketType;
	balance: string;
}

export interface MidasLiquidityProductDto {
	midasAccountId: string;
	ledgerAccountId: string;
	currency: string;
	physicalBalance: string;
	totalEarmarked: string;
	unallocatedBalance: string;
	buckets: MidasBucketProductDto[];
}

export interface MidasLiquidityResponse {
	liquidity: MidasLiquidityProductDto;
}

export interface MidasAccountDto {
	midasAccountId: string;
	ledgerAccountId: string;
	createdAt: string;
}

export interface MidasSetupResponse {
	midasAccount: MidasAccountDto;
}

export interface MidasAllocationTransferProductDto {
	transferId: string;
	midasAccountId: string;
	fromBucketId: string | null;
	toBucketId: string | null;
	amount: string;
	occurredAt: string;
	reversalOfTransferId: string | null;
	memo: string | null;
	createdAt: string;
}

export interface MidasTransfersResponse {
	transfers: MidasAllocationTransferProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface CreateMidasTransferPayload {
	midasAccountId: string;
	amount: string;
	fromBucketId?: string | null | undefined;
	toBucketId?: string | null | undefined;
	memo?: string | null | undefined;
	occurredAt: string;
}

export interface CreateMidasTransferResponse {
	transfer: {
		transferId: string;
		midasAccountId: string;
		fromBucketId: string | null;
		toBucketId: string | null;
		amount: string;
		occurredAt: string;
	};
	idempotentReplay?: boolean;
}

// ============================================================================
// Short-Term Goals Types
// ============================================================================

export type ShortTermGoalStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

export type ShortTermGoalFundingStatus = "EMPTY" | "PARTIAL" | "TARGET_REACHED";

export interface ShortTermGoalProductDto {
	goalId: string;
	midasAccountId: string;
	midasBucketId: string;
	status: ShortTermGoalStatus;
	name: string;
	fundingTarget: string;
	accumulatedAmount: string;
	remainingToTarget: string;
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	priority: number | null;
	latestRevisionNo: number;
	createdAt: string;
	updatedAt: string;
}

export interface ShortTermGoalsListResponse {
	goals: ShortTermGoalProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface ShortTermGoalResponse {
	goal: ShortTermGoalProductDto;
	idempotentReplay?: boolean;
}

export interface CreateShortTermGoalPayload {
	midasAccountId: string;
	name: string;
	fundingTarget: string;
	targetDate?: string | null | undefined;
	maxBudget?: string | null | undefined;
	targetPrice?: string | null | undefined;
	productUrl?: string | null | undefined;
	note?: string | null | undefined;
	priorityPosition?: number | null | undefined;
	occurredAt: string;
}

export interface UpdateShortTermGoalPayload {
	expectedRevisionNo: number;
	name?: string | undefined;
	fundingTarget?: string | undefined;
	targetDate?: string | null | undefined;
	maxBudget?: string | null | undefined;
	targetPrice?: string | null | undefined;
	productUrl?: string | null | undefined;
	note?: string | null | undefined;
	changeReason?: string | null | undefined;
	occurredAt: string;
}

export interface CompleteShortTermGoalPayload {
	expectedRevisionNo: number;
	changeReason?: string | null | undefined;
	occurredAt: string;
}

export interface CancelShortTermGoalPayload {
	expectedRevisionNo: number;
	changeReason?: string | null | undefined;
	occurredAt: string;
}

export interface ReorderShortTermGoalsPayload {
	midasAccountId: string;
	orderedGoalIds: string[];
	occurredAt: string;
}

export interface ReorderShortTermGoalsResponse {
	reorder: {
		midasAccountId: string;
		orderedGoalIds: string[];
		revisionNo: number;
		occurredAt: string;
	};
	idempotentReplay?: boolean;
}

export interface FundShortTermGoalPayload {
	amount: string;
	fromBucketId?: string | null | undefined;
	memo?: string | null | undefined;
	occurredAt: string;
}

export interface FundShortTermGoalResponse {
	funding: {
		goalId: string;
		midasAccountId: string;
		midasBucketId: string;
		transferId: string;
		amount: string;
		occurredAt: string;
	};
	idempotentReplay?: boolean;
}

export interface ReleaseShortTermGoalPayload {
	amount: string;
	toBucketId?: string | null | undefined;
	memo?: string | null | undefined;
	occurredAt: string;
}

export interface ReleaseShortTermGoalResponse {
	release: {
		goalId: string;
		midasAccountId: string;
		midasBucketId: string;
		transferId: string;
		amount: string;
		occurredAt: string;
	};
	idempotentReplay?: boolean;
}

// ============================================================================
// Long-Term Investment Tasks Types
// ============================================================================

export type LongTermTaskStatus = "PENDING" | "SENT" | "CANCELLED";

export interface LongTermTaskProductDto {
	taskId: string;
	status: LongTermTaskStatus;
	revisionNo: number;
	amount: string;
	destinationLabel: string | null;
	note: string | null;
	midasAccountId: string;
	pendingBucketId: string;
	allocatedAt: string;
	sentAt: string | null;
	latestMidasAllocationTransferId: string;
	currentSendCanonicalTransactionId: string | null;
	currentSendCanonicalRevisionId: string | null;
	createdAt: string;
}

export interface LongTermTasksListResponse {
	tasks: LongTermTaskProductDto[];
	limit: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface LongTermTaskResponse {
	task: LongTermTaskProductDto;
	idempotentReplay?: boolean;
}

export interface CreateLongTermTaskPayload {
	midasAccountId: string;
	amount: string;
	destinationLabel?: string | null | undefined;
	note?: string | null | undefined;
	occurredAt: string;
}

export interface MarkSentLongTermTaskPayload {
	expectedRevisionNo: number;
	occurredAt: string;
}

export interface ReopenLongTermTaskPayload {
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: string;
}

export interface CancelLongTermTaskPayload {
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: string;
}
