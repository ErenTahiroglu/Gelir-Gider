import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { CanonicalTransactionError } from "./errors";

/**
 * Explicit allowlist of transaction kinds permitted for direct / manual product transaction entry.
 * Domain-owned kinds (e.g. INCOME_*, CREDIT_CARD_*, PERSON_*, REWARD_*, LONG_TERM_*, MONTHLY_BUDGET_*, IMPORT_*)
 * are strictly reserved and rejected at the product HTTP boundary.
 */
export const ALLOWED_MANUAL_TRANSACTION_KINDS = [
	"EXPENSE",
	"INCOME",
	"TRANSFER",
	"MANUAL_EXPENSE",
	"MANUAL_INCOME",
	"MANUAL_TRANSFER",
] as const;

export type AllowedManualTransactionKind =
	(typeof ALLOWED_MANUAL_TRANSACTION_KINDS)[number];

const ALLOWED_MANUAL_KINDS_SET: ReadonlySet<string> = new Set(
	ALLOWED_MANUAL_TRANSACTION_KINDS,
);

export function isAllowedManualTransactionKind(
	kind: string,
): kind is AllowedManualTransactionKind {
	return ALLOWED_MANUAL_KINDS_SET.has(kind.trim().toUpperCase());
}

/** Stable source audit descriptor type for product HTTP operations */
export const PRODUCT_HTTP_SOURCE_TYPE = "PRODUCT_HTTP" as const;

/** Stable reason code for user-initiated transaction edits */
export const USER_EDIT_REASON_CODE = "USER_EDIT" as const;

/** Stable reason code for user-initiated transaction voids */
export const USER_VOID_REASON_CODE = "USER_VOID" as const;

export interface ListCanonicalTransactionsParams {
	db: Database;
	userId: string;
	limit?: number | undefined;
	status?: "ACTIVE" | "VOIDED" | undefined;
	kind?: string | undefined;
	beforeOccurredAt?: Date | undefined;
	beforeTransactionId?: string | undefined;
}

export interface ProductTransactionSummaryItem {
	transactionId: string;
	kind: string;
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	occurredAt: string;
	payload: Record<string, unknown>;
	createdAt: string;
	latestRevisionCreatedAt: string;
}

export interface ListCanonicalTransactionsResult {
	transactions: ProductTransactionSummaryItem[];
	nextCursor: {
		beforeOccurredAt: string;
		beforeTransactionId: string;
	} | null;
}

export interface ListBoundedRevisionsParams {
	db: Database;
	userId: string;
	transactionId: string;
	limit?: number | undefined;
	beforeRevisionNo?: number | undefined;
}

export interface ProductRevisionItem {
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	occurredAt: string;
	payload: Record<string, unknown>;
	reasonCode: string | null;
	reasonNote: string | null;
	createdAt: string;
}

export interface ListBoundedRevisionsResult {
	transactionId: string;
	revisions: ProductRevisionItem[];
	nextCursor: {
		beforeRevisionNo: number;
	} | null;
}

/**
 * Keyset-paginated product read model for browsing canonical transactions.
 * Returns CURRENT effective state only, ordered by occurredAt DESC, transactionId DESC.
 */
export async function listCanonicalTransactions({
	db,
	userId,
	limit = 50,
	status,
	kind,
	beforeOccurredAt,
	beforeTransactionId,
}: ListCanonicalTransactionsParams): Promise<ListCanonicalTransactionsResult> {
	if (!userId || userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}

	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const fetchCount = boundedLimit + 1;

	// Build raw parameterized query with CTE to find the latest revision per transaction
	const query = sql`
		WITH latest_tx AS (
			SELECT DISTINCT ON (tr.transaction_id)
				ct.id AS transaction_id,
				ct.kind,
				ct.created_at AS tx_created_at,
				tr.revision_no,
				tr.operation,
				tr.occurred_at,
				tr.payload,
				tr.created_at AS latest_revision_created_at
			FROM ${canonicalTransactions} ct
			INNER JOIN ${transactionRevisions} tr
				ON ct.id = tr.transaction_id AND ct.user_id = tr.user_id
			WHERE ct.user_id = ${userId}
			ORDER BY tr.transaction_id, tr.revision_no DESC
		)
		SELECT *
		FROM latest_tx
		WHERE
			(${status ? (status === "VOIDED" ? sql`operation = 'VOID'` : sql`operation != 'VOID'`) : sql`TRUE`})
			AND (${kind ? sql`kind = ${kind.trim().toUpperCase()}` : sql`TRUE`})
			AND (${
				beforeOccurredAt && beforeTransactionId
					? sql`(occurred_at < ${beforeOccurredAt} OR (occurred_at = ${beforeOccurredAt} AND transaction_id < ${beforeTransactionId}))`
					: beforeOccurredAt
						? sql`occurred_at < ${beforeOccurredAt}`
						: sql`TRUE`
			})
		ORDER BY occurred_at DESC, transaction_id DESC
		LIMIT ${fetchCount}
	`;

	const rawResult = await db.execute(query);
	const rawRows = (Array.isArray(rawResult)
		? rawResult
		: ((rawResult as { rows?: unknown[] }).rows ?? [])) as unknown as Array<{
		transaction_id: string;
		kind: string;
		tx_created_at: string | Date;
		revision_no: number;
		operation: string;
		occurred_at: string | Date;
		payload: Record<string, unknown> | string;
		latest_revision_created_at: string | Date;
	}>;
	const rows = rawRows;

	const hasNextPage = rows.length > boundedLimit;
	const pageRows = hasNextPage ? rows.slice(0, boundedLimit) : rows;

	const items: ProductTransactionSummaryItem[] = pageRows.map((r) => {
		const occDate =
			r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at);
		const txCreated =
			r.tx_created_at instanceof Date
				? r.tx_created_at
				: new Date(r.tx_created_at);
		const revCreated =
			r.latest_revision_created_at instanceof Date
				? r.latest_revision_created_at
				: new Date(r.latest_revision_created_at);
		const payload =
			typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;

		return {
			transactionId: r.transaction_id,
			kind: r.kind,
			status: r.operation === "VOID" ? "VOIDED" : "ACTIVE",
			revisionNo: Number(r.revision_no),
			occurredAt: occDate.toISOString(),
			payload: (payload as Record<string, unknown>) ?? {},
			createdAt: txCreated.toISOString(),
			latestRevisionCreatedAt: revCreated.toISOString(),
		};
	});

	let nextCursor: {
		beforeOccurredAt: string;
		beforeTransactionId: string;
	} | null = null;
	const lastItem = items[items.length - 1];
	if (hasNextPage && lastItem) {
		nextCursor = {
			beforeOccurredAt: lastItem.occurredAt,
			beforeTransactionId: lastItem.transactionId,
		};
	}

	return {
		transactions: items,
		nextCursor,
	};
}

/**
 * Keyset-paginated product read model for transaction audit revision history.
 * Returns revisions in reverse-chronological order (revisionNo DESC), bounded by limit.
 */
export async function listBoundedCanonicalTransactionRevisions({
	db,
	userId,
	transactionId,
	limit = 50,
	beforeRevisionNo,
}: ListBoundedRevisionsParams): Promise<ListBoundedRevisionsResult> {
	if (!userId || userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}

	const trimmedTxId = transactionId?.trim();
	if (!trimmedTxId) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Transaction ID is required",
		);
	}

	// Verify transaction ownership
	const [txRow] = await db
		.select({ id: canonicalTransactions.id })
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.id, trimmedTxId),
				eq(canonicalTransactions.userId, userId),
			),
		)
		.limit(1);

	if (!txRow) {
		throw new CanonicalTransactionError(
			"TRANSACTION_NOT_FOUND",
			`Canonical transaction "${trimmedTxId}" not found for this user`,
		);
	}

	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const fetchCount = boundedLimit + 1;

	const conditions = [
		eq(transactionRevisions.transactionId, trimmedTxId),
		eq(transactionRevisions.userId, userId),
	];

	if (
		beforeRevisionNo !== undefined &&
		Number.isSafeInteger(beforeRevisionNo)
	) {
		conditions.push(
			sql`${transactionRevisions.revisionNo} < ${beforeRevisionNo}`,
		);
	}

	const rows = await db
		.select({
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
			occurredAt: transactionRevisions.occurredAt,
			payload: transactionRevisions.payload,
			reasonCode: transactionRevisions.reasonCode,
			reasonNote: transactionRevisions.reasonNote,
			createdAt: transactionRevisions.createdAt,
		})
		.from(transactionRevisions)
		.where(and(...conditions))
		.orderBy(desc(transactionRevisions.revisionNo))
		.limit(fetchCount);

	const hasNextPage = rows.length > boundedLimit;
	const pageRows = hasNextPage ? rows.slice(0, boundedLimit) : rows;

	const items: ProductRevisionItem[] = pageRows.map((r) => ({
		revisionNo: r.revisionNo,
		operation: r.operation as "CREATE" | "UPDATE" | "VOID",
		occurredAt: r.occurredAt.toISOString(),
		payload: (r.payload as Record<string, unknown>) ?? {},
		reasonCode: r.reasonCode,
		reasonNote: r.reasonNote,
		createdAt: r.createdAt.toISOString(),
	}));

	let nextCursor: { beforeRevisionNo: number } | null = null;
	const lastItem = items[items.length - 1];
	if (hasNextPage && lastItem) {
		nextCursor = {
			beforeRevisionNo: lastItem.revisionNo,
		};
	}

	return {
		transactionId: trimmedTxId,
		revisions: items,
		nextCursor,
	};
}
