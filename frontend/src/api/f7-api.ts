/**
 * Phase F7 API Client
 *
 * Implements:
 *   - Midas Liquidity & Transfers
 *   - Short-Term Goals Lifecycle & Priority
 *   - Long-Term Investment Tasks Lifecycle
 */

import { apiGet, apiPost } from "./client";
import type {
	CancelLongTermTaskPayload,
	CancelShortTermGoalPayload,
	CompleteShortTermGoalPayload,
	CreateLongTermTaskPayload,
	CreateMidasTransferPayload,
	CreateMidasTransferResponse,
	CreateShortTermGoalPayload,
	FundShortTermGoalPayload,
	FundShortTermGoalResponse,
	LongTermTaskResponse,
	LongTermTaskStatus,
	LongTermTasksListResponse,
	MarkSentLongTermTaskPayload,
	MidasLiquidityResponse,
	MidasSetupResponse,
	MidasTransfersResponse,
	ReleaseShortTermGoalPayload,
	ReleaseShortTermGoalResponse,
	ReopenLongTermTaskPayload,
	ReorderShortTermGoalsPayload,
	ReorderShortTermGoalsResponse,
	ShortTermGoalProductDto,
	ShortTermGoalResponse,
	ShortTermGoalStatus,
	ShortTermGoalsListResponse,
	UpdateShortTermGoalPayload,
} from "./f7-types";

// ============================================================================
// Midas Liquidity API
// ============================================================================

export async function fetchMidasLiquidity(
	midasAccountId?: string | undefined,
): Promise<MidasLiquidityResponse> {
	const query = midasAccountId
		? `?midasAccountId=${encodeURIComponent(midasAccountId)}`
		: "";
	return apiGet<MidasLiquidityResponse>(`/midas/liquidity${query}`);
}

/**
 * Setup/link Midas account with a physical ledger account.
 * NOTE (Section 6, 62): POST /midas/setup does NOT use an Idempotency-Key header.
 */
export async function setupMidasAccount(
	ledgerAccountId: string,
): Promise<MidasSetupResponse> {
	return apiPost<MidasSetupResponse>("/midas/setup", { ledgerAccountId });
}

export async function fetchMidasTransfers(params?: {
	midasAccountId?: string | undefined;
	bucketId?: string | undefined;
	limit?: number | undefined;
	after?: string | undefined;
}): Promise<MidasTransfersResponse> {
	const query = new URLSearchParams();
	if (params?.midasAccountId) {
		query.set("midasAccountId", params.midasAccountId);
	}
	if (params?.bucketId) {
		query.set("bucketId", params.bucketId);
	}
	if (params?.limit) {
		query.set("limit", String(params.limit));
	}
	if (params?.after) {
		query.set("after", params.after);
	}
	const qs = query.toString();
	return apiGet<MidasTransfersResponse>(
		`/midas/transfers${qs ? `?${qs}` : ""}`,
	);
}

export async function createMidasTransfer(
	payload: CreateMidasTransferPayload,
	idempotencyKey: string,
): Promise<CreateMidasTransferResponse> {
	return apiPost<CreateMidasTransferResponse>("/midas/transfers", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

// ============================================================================
// Short-Term Goals API
// ============================================================================

export async function fetchShortTermGoals(params?: {
	midasAccountId?: string | undefined;
	status?: ShortTermGoalStatus | undefined;
	limit?: number | undefined;
	after?: string | undefined;
}): Promise<ShortTermGoalsListResponse> {
	const query = new URLSearchParams();
	if (params?.midasAccountId) {
		query.set("midasAccountId", params.midasAccountId);
	}
	if (params?.status) {
		query.set("status", params.status);
	}
	if (params?.limit) {
		query.set("limit", String(params.limit));
	}
	if (params?.after) {
		query.set("after", params.after);
	}
	const qs = query.toString();
	return apiGet<ShortTermGoalsListResponse>(
		`/short-term-goals${qs ? `?${qs}` : ""}`,
	);
}

/**
 * Fetches the COMPLETE set of ACTIVE goals across all cursor pages (Section 44).
 * Backend requires the complete set for priority reordering.
 */
export async function fetchAllActiveShortTermGoals(
	midasAccountId: string,
): Promise<ShortTermGoalProductDto[]> {
	const allGoals: ShortTermGoalProductDto[] = [];
	let cursor: string | null = null;

	do {
		const page = await fetchShortTermGoals({
			midasAccountId,
			status: "ACTIVE",
			limit: 50,
			after: cursor ?? undefined,
		});
		allGoals.push(...page.goals);
		cursor = page.nextCursor;
	} while (cursor !== null);

	return allGoals;
}

export async function fetchShortTermGoal(
	goalId: string,
): Promise<ShortTermGoalResponse> {
	return apiGet<ShortTermGoalResponse>(
		`/short-term-goals/${encodeURIComponent(goalId)}`,
	);
}

export async function createShortTermGoal(
	payload: CreateShortTermGoalPayload,
	idempotencyKey: string,
): Promise<ShortTermGoalResponse> {
	return apiPost<ShortTermGoalResponse>("/short-term-goals", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function updateShortTermGoal(
	goalId: string,
	payload: UpdateShortTermGoalPayload,
	idempotencyKey: string,
): Promise<ShortTermGoalResponse> {
	return apiPost<ShortTermGoalResponse>(
		`/short-term-goals/${encodeURIComponent(goalId)}`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function completeShortTermGoal(
	goalId: string,
	payload: CompleteShortTermGoalPayload,
	idempotencyKey: string,
): Promise<ShortTermGoalResponse> {
	return apiPost<ShortTermGoalResponse>(
		`/short-term-goals/${encodeURIComponent(goalId)}/complete`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function cancelShortTermGoal(
	goalId: string,
	payload: CancelShortTermGoalPayload,
	idempotencyKey: string,
): Promise<ShortTermGoalResponse> {
	return apiPost<ShortTermGoalResponse>(
		`/short-term-goals/${encodeURIComponent(goalId)}/cancel`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function reorderShortTermGoals(
	payload: ReorderShortTermGoalsPayload,
	idempotencyKey: string,
): Promise<ReorderShortTermGoalsResponse> {
	return apiPost<ReorderShortTermGoalsResponse>(
		"/short-term-goals/reorder",
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function fundShortTermGoal(
	goalId: string,
	payload: FundShortTermGoalPayload,
	idempotencyKey: string,
): Promise<FundShortTermGoalResponse> {
	return apiPost<FundShortTermGoalResponse>(
		`/short-term-goals/${encodeURIComponent(goalId)}/fund`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function releaseShortTermGoal(
	goalId: string,
	payload: ReleaseShortTermGoalPayload,
	idempotencyKey: string,
): Promise<ReleaseShortTermGoalResponse> {
	return apiPost<ReleaseShortTermGoalResponse>(
		`/short-term-goals/${encodeURIComponent(goalId)}/release`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

// ============================================================================
// Long-Term Investment Tasks API
// ============================================================================

export async function fetchLongTermTasks(params?: {
	midasAccountId?: string | undefined;
	status?: LongTermTaskStatus | undefined;
	limit?: number | undefined;
	after?: string | undefined;
}): Promise<LongTermTasksListResponse> {
	const query = new URLSearchParams();
	if (params?.midasAccountId) {
		query.set("midasAccountId", params.midasAccountId);
	}
	if (params?.status) {
		query.set("status", params.status);
	}
	if (params?.limit) {
		query.set("limit", String(params.limit));
	}
	if (params?.after) {
		query.set("after", params.after);
	}
	const qs = query.toString();
	return apiGet<LongTermTasksListResponse>(
		`/long-term/tasks${qs ? `?${qs}` : ""}`,
	);
}

export async function fetchLongTermTask(
	taskId: string,
): Promise<LongTermTaskResponse> {
	return apiGet<LongTermTaskResponse>(
		`/long-term/tasks/${encodeURIComponent(taskId)}`,
	);
}

export async function createLongTermTask(
	payload: CreateLongTermTaskPayload,
	idempotencyKey: string,
): Promise<LongTermTaskResponse> {
	return apiPost<LongTermTaskResponse>("/long-term/tasks", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}

export async function markSentLongTermTask(
	taskId: string,
	payload: MarkSentLongTermTaskPayload,
	idempotencyKey: string,
): Promise<LongTermTaskResponse> {
	return apiPost<LongTermTaskResponse>(
		`/long-term/tasks/${encodeURIComponent(taskId)}/mark-sent`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function reopenLongTermTask(
	taskId: string,
	payload: ReopenLongTermTaskPayload,
	idempotencyKey: string,
): Promise<LongTermTaskResponse> {
	return apiPost<LongTermTaskResponse>(
		`/long-term/tasks/${encodeURIComponent(taskId)}/reopen`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function cancelLongTermTask(
	taskId: string,
	payload: CancelLongTermTaskPayload,
	idempotencyKey: string,
): Promise<LongTermTaskResponse> {
	return apiPost<LongTermTaskResponse>(
		`/long-term/tasks/${encodeURIComponent(taskId)}/cancel`,
		payload,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}
