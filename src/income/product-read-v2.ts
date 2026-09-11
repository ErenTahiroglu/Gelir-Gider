import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../db/schema/income";
import {
	incomeEntitlementRevisions,
	incomeEntitlements,
	incomeSettlementBatchRevisions,
	type SettlementAllocationItem,
} from "../db/schema/income-entitlements";
import { formatCentsToMoney, parseMoneyString } from "../ledger/money";
import {
	getIstanbulCalendarDate,
	validateIsoCalendarDate,
	validatePeriodMonth,
} from "./calendar";
import type {
	EntitlementSettlementStatus,
	EntitlementStatus,
} from "./entitlements";
import { IncomeError } from "./errors";
import type { IncomeNature, IncomeReferenceMethod } from "./sources";
import { normalizeUuid } from "./utils";

// --- Product HTTP Source/Audit Constants ---
export const PRODUCT_HTTP_SOURCE_TYPE = "PRODUCT_HTTP" as const;
export const USER_EDIT_REASON_CODE = "USER_EDIT" as const;
export const USER_VOID_REASON_CODE = "USER_VOID" as const;

export const PRODUCT_INCOME_HTTP_SOURCE_TYPE = PRODUCT_HTTP_SOURCE_TYPE;
export const INCOME_USER_EDIT_REASON_CODE = USER_EDIT_REASON_CODE;
export const INCOME_USER_VOID_REASON_CODE = USER_VOID_REASON_CODE;

// --- 1. Product Income Source Types & Bounded List ---

export interface ProductIncomeSourceItem {
	sourceId: string;
	code: string;
	name: string;
	nature: IncomeNature;
	referenceMethod: IncomeReferenceMethod;
	expectedMonthlyAmount: string | null;
	seasonalMonthsPerYear: number | null;
	rollingMedianMonths: number | null;
	incomeLedgerAccountId: string;
	activeFrom: string;
	activeUntil: string | null;
	createdAt: string;
	archivedAt: string | null;
}

export interface ListBoundedIncomeSourcesParams {
	db: Database;
	userId: string;
	limit?: number | undefined;
	includeArchived?: boolean | undefined;
	beforeCreatedAt?: Date | undefined;
	beforeSourceId?: string | undefined;
}

export interface ListBoundedIncomeSourcesResult {
	sources: ProductIncomeSourceItem[];
	nextCursor: {
		beforeCreatedAt: string;
		beforeSourceId: string;
	} | null;
}

export async function listBoundedIncomeSources({
	db,
	userId,
	limit = 50,
	includeArchived = false,
	beforeCreatedAt,
	beforeSourceId,
}: ListBoundedIncomeSourcesParams): Promise<ListBoundedIncomeSourcesResult> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const fetchCount = boundedLimit + 1;

	const conditions = [eq(incomeSources.userId, userId)];

	if (!includeArchived) {
		conditions.push(isNull(incomeSources.archivedAt));
	}

	if (beforeCreatedAt && beforeSourceId) {
		conditions.push(
			sql`(${incomeSources.createdAt} < ${beforeCreatedAt} OR (${incomeSources.createdAt} = ${beforeCreatedAt} AND ${incomeSources.id} < ${beforeSourceId}))`,
		);
	}

	const rows = await db
		.select()
		.from(incomeSources)
		.where(and(...conditions))
		.orderBy(desc(incomeSources.createdAt), desc(incomeSources.id))
		.limit(fetchCount);

	const hasNextPage = rows.length > boundedLimit;
	const pageRows = hasNextPage ? rows.slice(0, boundedLimit) : rows;

	const items: ProductIncomeSourceItem[] = pageRows.map((s) => ({
		sourceId: s.id,
		code: s.code,
		name: s.name,
		nature: s.nature as IncomeNature,
		referenceMethod: s.referenceMethod as IncomeReferenceMethod,
		expectedMonthlyAmount: s.expectedMonthlyAmount,
		seasonalMonthsPerYear: s.seasonalMonthsPerYear,
		rollingMedianMonths: s.rollingMedianMonths,
		incomeLedgerAccountId: s.incomeLedgerAccountId,
		activeFrom: s.activeFrom,
		activeUntil: s.activeUntil,
		createdAt: s.createdAt.toISOString(),
		archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
	}));

	let nextCursor: {
		beforeCreatedAt: string;
		beforeSourceId: string;
	} | null = null;

	const lastItem = items[items.length - 1];
	if (hasNextPage && lastItem) {
		nextCursor = {
			beforeCreatedAt: lastItem.createdAt,
			beforeSourceId: lastItem.sourceId,
		};
	}

	return {
		sources: items,
		nextCursor,
	};
}

// --- 2. Product Income Entitlement Types & Bounded List ---

export interface ProductIncomeEntitlementItem {
	entitlementId: string;
	sourceId: string;
	sourceCode: string;
	sourceName: string;
	periodMonth: string;
	revisionNo: number;
	status: EntitlementStatus;
	amount: string;
	allocatedAmount: string;
	outstandingAmount: string;
	settlementStatus: EntitlementSettlementStatus;
	expectedReceiptOn: string | null;
	overdue: boolean;
	note: string | null;
}

export interface ListBoundedIncomeEntitlementsParams {
	db: Database;
	userId: string;
	limit?: number | undefined;
	sourceId?: string | undefined;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
	overdueAsOf?: string | Date | undefined;
	beforePeriodMonth?: string | undefined;
	beforeEntitlementId?: string | undefined;
}

export interface ListBoundedIncomeEntitlementsResult {
	entitlements: ProductIncomeEntitlementItem[];
	nextCursor: {
		beforePeriodMonth: string;
		beforeEntitlementId: string;
	} | null;
}

export async function listBoundedIncomeEntitlements({
	db,
	userId,
	limit = 50,
	sourceId,
	periodMonthFrom,
	periodMonthUntil,
	overdueAsOf,
	beforePeriodMonth,
	beforeEntitlementId,
}: ListBoundedIncomeEntitlementsParams): Promise<ListBoundedIncomeEntitlementsResult> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const fetchCount = boundedLimit + 1;

	const conditions = [eq(incomeEntitlements.userId, userId)];

	if (sourceId != null && sourceId.trim() !== "") {
		const canonicalSourceId = normalizeUuid(sourceId, "sourceId");
		conditions.push(eq(incomeEntitlements.sourceId, canonicalSourceId));
	}

	if (periodMonthFrom && periodMonthFrom.trim() !== "") {
		const validFrom = validatePeriodMonth(periodMonthFrom);
		conditions.push(sql`${incomeEntitlements.periodMonth} >= ${validFrom}`);
	}

	if (periodMonthUntil && periodMonthUntil.trim() !== "") {
		const validUntil = validatePeriodMonth(periodMonthUntil);
		conditions.push(sql`${incomeEntitlements.periodMonth} <= ${validUntil}`);
	}

	if (beforePeriodMonth && beforeEntitlementId) {
		const validBeforePeriod = validatePeriodMonth(beforePeriodMonth);
		const canonicalBeforeEntId = normalizeUuid(
			beforeEntitlementId,
			"beforeEntitlementId",
		);
		conditions.push(
			sql`(${incomeEntitlements.periodMonth} < ${validBeforePeriod} OR (${incomeEntitlements.periodMonth} = ${validBeforePeriod} AND ${incomeEntitlements.id} < ${canonicalBeforeEntId}))`,
		);
	}

	// 1. Fetch entitlements ordered by periodMonth DESC, id DESC
	const allEntitlements = await db
		.select({
			id: incomeEntitlements.id,
			sourceId: incomeEntitlements.sourceId,
			sourceCode: incomeSources.code,
			sourceName: incomeSources.name,
			periodMonth: incomeEntitlements.periodMonth,
		})
		.from(incomeEntitlements)
		.innerJoin(incomeSources, eq(incomeEntitlements.sourceId, incomeSources.id))
		.where(and(...conditions))
		.orderBy(desc(incomeEntitlements.periodMonth), desc(incomeEntitlements.id))
		.limit(fetchCount);

	if (allEntitlements.length === 0) {
		return { entitlements: [], nextCursor: null };
	}

	const hasNextPage = allEntitlements.length > boundedLimit;
	const pageEntitlements = hasNextPage
		? allEntitlements.slice(0, boundedLimit)
		: allEntitlements;

	const entitlementIds = pageEntitlements.map((e) => e.id);

	// 2. Fetch latest revision per entitlement in page
	const allRevs = await db
		.select({
			id: incomeEntitlementRevisions.id,
			entitlementId: incomeEntitlementRevisions.entitlementId,
			revisionNo: incomeEntitlementRevisions.revisionNo,
			operation: incomeEntitlementRevisions.operation,
			amount: incomeEntitlementRevisions.amount,
			expectedReceiptOn: incomeEntitlementRevisions.expectedReceiptOn,
			note: incomeEntitlementRevisions.note,
		})
		.from(incomeEntitlementRevisions)
		.where(
			and(
				eq(incomeEntitlementRevisions.userId, userId),
				inArray(incomeEntitlementRevisions.entitlementId, entitlementIds),
			),
		)
		.orderBy(
			incomeEntitlementRevisions.entitlementId,
			desc(incomeEntitlementRevisions.revisionNo),
		);

	const revMap = new Map<string, (typeof allRevs)[0]>();
	for (const r of allRevs) {
		if (!revMap.has(r.entitlementId)) {
			revMap.set(r.entitlementId, r);
		}
	}

	// 3. Fetch latest settlement allocations for user across active batches
	const allBatchRevs = await db
		.select({
			settlementBatchId: incomeSettlementBatchRevisions.settlementBatchId,
			revisionNo: incomeSettlementBatchRevisions.revisionNo,
			allocations: incomeSettlementBatchRevisions.allocations,
		})
		.from(incomeSettlementBatchRevisions)
		.where(eq(incomeSettlementBatchRevisions.userId, userId))
		.orderBy(
			incomeSettlementBatchRevisions.settlementBatchId,
			desc(incomeSettlementBatchRevisions.revisionNo),
		);

	const latestBatches = new Map<string, SettlementAllocationItem[]>();
	for (const r of allBatchRevs) {
		if (!latestBatches.has(r.settlementBatchId)) {
			latestBatches.set(
				r.settlementBatchId,
				Array.isArray(r.allocations)
					? (r.allocations as SettlementAllocationItem[])
					: [],
			);
		}
	}

	const allocMap = new Map<string, bigint>();
	for (const allocs of latestBatches.values()) {
		for (const alloc of allocs) {
			if (alloc?.entitlementId && alloc?.amount) {
				const cents = parseMoneyString(alloc.amount).cents;
				const current = allocMap.get(alloc.entitlementId) ?? 0n;
				allocMap.set(alloc.entitlementId, current + cents);
			}
		}
	}

	let asOfStr: string;
	if (typeof overdueAsOf === "string") {
		asOfStr = validateIsoCalendarDate(overdueAsOf);
	} else if (
		overdueAsOf instanceof Date &&
		!Number.isNaN(overdueAsOf.getTime())
	) {
		asOfStr = getIstanbulCalendarDate(overdueAsOf);
	} else {
		asOfStr = getIstanbulCalendarDate(new Date());
	}

	const items: ProductIncomeEntitlementItem[] = [];

	for (const ent of pageEntitlements) {
		const rev = revMap.get(ent.id);
		if (!rev) continue;

		const isVoid = rev.operation === "VOID";
		const allocatedCents = allocMap.get(ent.id) ?? 0n;
		const allocatedAmountStr = isVoid
			? "0.00"
			: formatCentsToMoney(allocatedCents);
		const entCents = parseMoneyString(rev.amount).cents;
		const outstandingCents =
			isVoid || allocatedCents >= entCents ? 0n : entCents - allocatedCents;
		const outstandingAmountStr = formatCentsToMoney(outstandingCents);

		let settlementStatus: EntitlementSettlementStatus;
		if (isVoid) {
			settlementStatus = "VOIDED";
		} else if (allocatedCents === 0n) {
			settlementStatus = "OPEN";
		} else if (allocatedCents >= entCents) {
			settlementStatus = "SETTLED";
		} else {
			settlementStatus = "PARTIAL";
		}

		const isOverdue =
			!isVoid &&
			outstandingCents > 0n &&
			rev.expectedReceiptOn !== null &&
			rev.expectedReceiptOn < asOfStr;

		items.push({
			entitlementId: ent.id,
			sourceId: ent.sourceId,
			sourceCode: ent.sourceCode,
			sourceName: ent.sourceName,
			periodMonth: ent.periodMonth,
			revisionNo: rev.revisionNo,
			status: isVoid ? "VOIDED" : "ACTIVE",
			amount: rev.amount,
			allocatedAmount: allocatedAmountStr,
			outstandingAmount: outstandingAmountStr,
			settlementStatus,
			expectedReceiptOn: rev.expectedReceiptOn,
			overdue: isOverdue,
			note: rev.note,
		});
	}

	let nextCursor: {
		beforePeriodMonth: string;
		beforeEntitlementId: string;
	} | null = null;

	const lastItem = items[items.length - 1];
	if (hasNextPage && lastItem) {
		nextCursor = {
			beforePeriodMonth: lastItem.periodMonth,
			beforeEntitlementId: lastItem.entitlementId,
		};
	}

	return {
		entitlements: items,
		nextCursor,
	};
}

// --- 3. Product Income Receipt Types & Bounded List ---

export interface ProductIncomeReceiptItem {
	incomeReceiptId: string;
	sourceId: string;
	sourceCode: string;
	sourceName: string;
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	receivedAt: string;
	amount: string;
	destinationAccountId: string;
	note: string | null;
}

export interface ListBoundedIncomeReceiptsParams {
	db: Database;
	userId: string;
	limit?: number | undefined;
	sourceId?: string | undefined;
	fromDate?: Date | undefined;
	toDate?: Date | undefined;
	includeVoided?: boolean | undefined;
	beforeReceivedAt?: Date | undefined;
	beforeIncomeReceiptId?: string | undefined;
}

export interface ListBoundedIncomeReceiptsResult {
	receipts: ProductIncomeReceiptItem[];
	nextCursor: {
		beforeReceivedAt: string;
		beforeIncomeReceiptId: string;
	} | null;
}

export async function listBoundedIncomeReceipts({
	db,
	userId,
	limit = 50,
	sourceId,
	fromDate,
	toDate,
	includeVoided = false,
	beforeReceivedAt,
	beforeIncomeReceiptId,
}: ListBoundedIncomeReceiptsParams): Promise<ListBoundedIncomeReceiptsResult> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const fetchCount = boundedLimit + 1;

	const canonicalSourceId =
		sourceId != null && sourceId.trim() !== ""
			? normalizeUuid(sourceId, "sourceId")
			: undefined;

	const canonicalBeforeReceiptId =
		beforeIncomeReceiptId != null && beforeIncomeReceiptId.trim() !== ""
			? normalizeUuid(beforeIncomeReceiptId, "beforeIncomeReceiptId")
			: undefined;

	// Use CTE to get latest revision per receipt and page by (occurred_at DESC, receipt_id DESC)
	const query = sql`
		WITH latest_receipts AS (
			SELECT DISTINCT ON (r.id)
				r.id AS receipt_id,
				r.source_id,
				s.code AS source_code,
				s.name AS source_name,
				rev.revision_no,
				rev.operation,
				rev.occurred_at,
				rev.amount,
				rev.destination_account_id,
				rev.note
			FROM ${incomeReceipts} r
			INNER JOIN ${incomeSources} s ON r.source_id = s.id
			INNER JOIN ${incomeReceiptRevisions} rev ON r.id = rev.income_receipt_id AND r.user_id = rev.user_id
			WHERE r.user_id = ${userId}
			ORDER BY r.id, rev.revision_no DESC
		)
		SELECT *
		FROM latest_receipts
		WHERE
			(${includeVoided ? sql`TRUE` : sql`operation != 'VOID'`})
			AND (${canonicalSourceId ? sql`source_id = ${canonicalSourceId}` : sql`TRUE`})
			AND (${fromDate ? sql`occurred_at >= ${fromDate}` : sql`TRUE`})
			AND (${toDate ? sql`occurred_at <= ${toDate}` : sql`TRUE`})
			AND (${
				beforeReceivedAt && canonicalBeforeReceiptId
					? sql`(occurred_at < ${beforeReceivedAt} OR (occurred_at = ${beforeReceivedAt} AND receipt_id < ${canonicalBeforeReceiptId}))`
					: beforeReceivedAt
						? sql`occurred_at < ${beforeReceivedAt}`
						: sql`TRUE`
			})
		ORDER BY occurred_at DESC, receipt_id DESC
		LIMIT ${fetchCount}
	`;

	const rawResult = await db.execute(query);
	const rawRows = (Array.isArray(rawResult)
		? rawResult
		: ((rawResult as { rows?: unknown[] }).rows ?? [])) as unknown as Array<{
		receipt_id: string;
		source_id: string;
		source_code: string;
		source_name: string;
		revision_no: number;
		operation: string;
		occurred_at: string | Date;
		amount: string;
		destination_account_id: string;
		note: string | null;
	}>;

	const hasNextPage = rawRows.length > boundedLimit;
	const pageRows = hasNextPage ? rawRows.slice(0, boundedLimit) : rawRows;

	const items: ProductIncomeReceiptItem[] = pageRows.map((r) => {
		const occDate =
			r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at);

		return {
			incomeReceiptId: r.receipt_id,
			sourceId: r.source_id,
			sourceCode: r.source_code,
			sourceName: r.source_name,
			status: r.operation === "VOID" ? "VOIDED" : "ACTIVE",
			revisionNo: Number(r.revision_no),
			receivedAt: occDate.toISOString(),
			amount: r.amount,
			destinationAccountId: r.destination_account_id,
			note: r.note,
		};
	});

	let nextCursor: {
		beforeReceivedAt: string;
		beforeIncomeReceiptId: string;
	} | null = null;

	const lastItem = items[items.length - 1];
	if (hasNextPage && lastItem) {
		nextCursor = {
			beforeReceivedAt: lastItem.receivedAt,
			beforeIncomeReceiptId: lastItem.incomeReceiptId,
		};
	}

	return {
		receipts: items,
		nextCursor,
	};
}
