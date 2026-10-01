/**
 * Month Close API Client (F8)
 *
 * Implements:
 *   - GET /month-close/preview?periodMonth=YYYY-MM
 *   - GET /month-close (list with opaque cursor `after`)
 *   - GET /month-close/:periodMonth (detail)
 *   - POST /month-close (with Idempotency-Key)
 */

import { apiGet, apiPost } from "./client";
import { ApiError } from "./errors";
import type {
	MonthCloseCommitPayload,
	MonthCloseCommitResponse,
	MonthCloseProductDto,
	MonthCloseProposal,
	MonthClosesListResponse,
} from "./month-close-types";

/**
 * Read-only preview of Month-Close proposal (allowed before period ends).
 */
export async function fetchMonthClosePreview(
	periodMonth: string, // YYYY-MM
): Promise<MonthCloseProposal> {
	return apiGet<MonthCloseProposal>(
		`/month-close/preview?periodMonth=${encodeURIComponent(periodMonth)}`,
	);
}

/**
 * Bounded keyset listing of month closes for authenticated user.
 */
export async function fetchMonthCloses(params?: {
	limit?: number;
	after?: string;
	periodMonthFrom?: string; // YYYY-MM
	periodMonthUntil?: string; // YYYY-MM
}): Promise<MonthClosesListResponse> {
	const query = new URLSearchParams();
	if (params?.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params?.after) {
		query.set("after", params.after);
	}
	if (params?.periodMonthFrom) {
		query.set("periodMonthFrom", params.periodMonthFrom);
	}
	if (params?.periodMonthUntil) {
		query.set("periodMonthUntil", params.periodMonthUntil);
	}

	const qs = query.toString();
	const path = qs ? `/month-close?${qs}` : "/month-close";
	return apiGet<MonthClosesListResponse>(path);
}

/**
 * Fetch single month close detail by periodMonth (YYYY-MM).
 * Returns null if not found (404).
 */
export async function fetchMonthClose(
	periodMonth: string, // YYYY-MM
): Promise<MonthCloseProductDto | null> {
	try {
		const res = await apiGet<{ monthClose: MonthCloseProductDto }>(
			`/month-close/${encodeURIComponent(periodMonth)}`,
		);
		return res.monthClose;
	} catch (err) {
		if (err instanceof ApiError && err.code === "MONTH_CLOSE_NOT_FOUND") {
			return null;
		}
		throw err;
	}
}

/**
 * Authoritative month-end surplus close execution with exact idempotency.
 */
export async function commitMonthClose(
	payload: MonthCloseCommitPayload,
	idempotencyKey: string,
): Promise<MonthCloseCommitResponse> {
	return apiPost<MonthCloseCommitResponse>("/month-close", payload, {
		headers: {
			"Idempotency-Key": idempotencyKey,
		},
	});
}
