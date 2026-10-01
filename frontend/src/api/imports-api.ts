import { apiGet, apiPost } from "./client";
import type {
	ApplyReadyRowsResponse,
	ImportBatchListResponse,
	ImportBatchPreviewResponse,
	ImportBatchSummary,
	ImportRowDetail,
	ImportRowStatus,
	ImportRowsListResponse,
	ResolveImportRowRequest,
	ResolveImportRowResponse,
	StageImportBatchRequest,
	StageImportBatchResponse,
} from "./imports-types";

export async function getImportBatches(params?: {
	limit?: number;
	after?: string;
}): Promise<ImportBatchListResponse> {
	const query = new URLSearchParams();
	if (params?.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params?.after !== undefined) {
		query.set("after", params.after);
	}
	const qs = query.toString();
	return apiGet<ImportBatchListResponse>(
		`/imports/batches${qs ? `?${qs}` : ""}`,
	);
}

export async function getImportBatch(id: string): Promise<ImportBatchSummary> {
	return apiGet<ImportBatchSummary>(
		`/imports/batches/${encodeURIComponent(id)}`,
	);
}

export async function getImportBatchPreview(
	id: string,
): Promise<ImportBatchPreviewResponse> {
	return apiGet<ImportBatchPreviewResponse>(
		`/imports/batches/${encodeURIComponent(id)}/preview`,
	);
}

/**
 * Stages a new CSV or normalized import batch.
 * Note: Staging endpoint does NOT require or use an Idempotency-Key header.
 */
export async function stageImportBatch(
	body: StageImportBatchRequest,
): Promise<StageImportBatchResponse> {
	return apiPost<StageImportBatchResponse>("/imports/batches", body);
}

export async function getImportRows(params: {
	batchId: string;
	status?: ImportRowStatus;
	limit?: number;
	after?: string;
}): Promise<ImportRowsListResponse> {
	const query = new URLSearchParams();
	query.set("batchId", params.batchId);
	if (params.status !== undefined) {
		query.set("status", params.status);
	}
	if (params.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params.after !== undefined) {
		query.set("after", params.after);
	}
	return apiGet<ImportRowsListResponse>(`/imports/rows?${query.toString()}`);
}

export async function getImportRow(id: string): Promise<ImportRowDetail> {
	return apiGet<ImportRowDetail>(`/imports/rows/${encodeURIComponent(id)}`);
}

export async function resolveImportRow(
	batchId: string,
	rowId: string,
	body: ResolveImportRowRequest,
	idempotencyKey: string,
): Promise<ResolveImportRowResponse> {
	return apiPost<ResolveImportRowResponse>(
		`/imports/batches/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(rowId)}/resolve`,
		body,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

/**
 * Applies READY import rows in chunks.
 * Note: Apply endpoint does NOT require an Idempotency-Key header.
 */
export async function applyReadyImportRows(
	batchId: string,
	limit = 50,
): Promise<ApplyReadyRowsResponse> {
	return apiPost<ApplyReadyRowsResponse>(
		`/imports/batches/${encodeURIComponent(batchId)}/apply?limit=${limit}`,
	);
}
