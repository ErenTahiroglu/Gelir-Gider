import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { resolveAuthoritativePurchaseSplitAsOf } from "../credit-cards/purchase-split-read";
import type { Database } from "../db/client";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	spendingCategories,
	spendingCategoryAssignments,
} from "../db/schema/spending-categories";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { formatCentsToMoney, parseAggregateMoneyString } from "../ledger/money";
import {
	getMonthCloseIstanbulPeriodBoundaries,
	validateMonthClosePeriodMonth,
} from "../month-close/calendar";

export interface SpendingCategorySummaryItem {
	categoryId: string;
	categoryName: string;
	amount: string;
	transactionCount: number;
}

export interface SpendingSummaryResult {
	periodMonth: string;
	totalPersonalSpending: string;
	categories: SpendingCategorySummaryItem[];
	unclassifiedAmount: string;
}

export async function getSpendingSummary(
	db: Database,
	userId: string,
	periodMonthInput: unknown,
): Promise<SpendingSummaryResult> {
	const periodMonth = validateMonthClosePeriodMonth(periodMonthInput);
	const { start, end } = getMonthCloseIstanbulPeriodBoundaries(periodMonth);

	// 1. Fetch user categories
	const userCategories = await db
		.select({
			id: spendingCategories.id,
			name: spendingCategories.name,
			sortOrder: spendingCategories.sortOrder,
		})
		.from(spendingCategories)
		.where(eq(spendingCategories.userId, userId))
		.orderBy(asc(spendingCategories.sortOrder), asc(spendingCategories.name));

	const categoryMap = new Map<string, { name: string; sortOrder: number }>();
	for (const cat of userCategories) {
		categoryMap.set(cat.id, { name: cat.name, sortOrder: cat.sortOrder });
	}

	// 2. Fetch assignments
	const assignments = await db
		.select({
			subjectType: spendingCategoryAssignments.subjectType,
			subjectId: spendingCategoryAssignments.subjectId,
			categoryId: spendingCategoryAssignments.categoryId,
		})
		.from(spendingCategoryAssignments)
		.where(eq(spendingCategoryAssignments.userId, userId));

	const assignmentLookup = new Map<string, string>();
	for (const a of assignments) {
		assignmentLookup.set(`${a.subjectType}:${a.subjectId}`, a.categoryId);
	}

	// Category tracking
	const categoryTotals = new Map<
		string,
		{ cents: bigint; count: number; name: string }
	>();
	for (const cat of userCategories) {
		categoryTotals.set(cat.id, {
			cents: 0n,
			count: 0,
			name: cat.name,
		});
	}

	let unclassifiedCents = 0n;
	let totalPersonalCents = 0n;

	// 3. Resolve Credit Card Purchases
	const latestLiabilityRevisions = db
		.select({
			eventId: creditCardLiabilityEventRevisions.eventId,
			maxRev:
				sql<number>`max(${creditCardLiabilityEventRevisions.revisionNo})`.as(
					"max_rev",
				),
		})
		.from(creditCardLiabilityEventRevisions)
		.groupBy(creditCardLiabilityEventRevisions.eventId)
		.as("latest_liability_rev");

	const purchaseRows = await db
		.select({
			eventId: creditCardLiabilityEvents.id,
			operation: creditCardLiabilityEventRevisions.operation,
			amount: creditCardLiabilityEventRevisions.amount,
			occurredAt: creditCardLiabilityEventRevisions.occurredAt,
		})
		.from(creditCardLiabilityEvents)
		.innerJoin(
			creditCardLiabilityEventRevisions,
			eq(
				creditCardLiabilityEvents.id,
				creditCardLiabilityEventRevisions.eventId,
			),
		)
		.innerJoin(
			latestLiabilityRevisions,
			and(
				eq(
					creditCardLiabilityEventRevisions.eventId,
					latestLiabilityRevisions.eventId,
				),
				eq(
					creditCardLiabilityEventRevisions.revisionNo,
					latestLiabilityRevisions.maxRev,
				),
			),
		)
		.where(
			and(
				eq(creditCardLiabilityEvents.userId, userId),
				eq(creditCardLiabilityEvents.eventType, "PURCHASE"),
				gte(creditCardLiabilityEventRevisions.occurredAt, start),
				lt(creditCardLiabilityEventRevisions.occurredAt, end),
			),
		);

	for (const p of purchaseRows) {
		if (p.operation === "VOID") continue;

		// Authoritative personal share
		let personalCents: bigint;
		try {
			const split = await resolveAuthoritativePurchaseSplitAsOf({
				db,
				userId,
				purchaseEventId: p.eventId,
				asOf: p.occurredAt,
			});
			if (split.kind === "ACTIVE") {
				personalCents = split.userShareCents;
			} else {
				personalCents = parseAggregateMoneyString(p.amount).cents;
			}
		} catch {
			personalCents = parseAggregateMoneyString(p.amount).cents;
		}

		if (personalCents <= 0n) continue;

		totalPersonalCents += personalCents;

		const categoryId = assignmentLookup.get(
			`CREDIT_CARD_PURCHASE:${p.eventId}`,
		);
		if (categoryId && categoryTotals.has(categoryId)) {
			const existing = categoryTotals.get(categoryId)!;
			existing.cents += personalCents;
			existing.count += 1;
		} else {
			unclassifiedCents += personalCents;
		}
	}

	// 4. Resolve Manual Expenses
	const latestTxRevisions = db
		.select({
			transactionId: transactionRevisions.transactionId,
			maxRev: sql<number>`max(${transactionRevisions.revisionNo})`.as(
				"max_rev",
			),
		})
		.from(transactionRevisions)
		.groupBy(transactionRevisions.transactionId)
		.as("latest_tx_rev");

	const manualExpenseRows = await db
		.select({
			transactionId: canonicalTransactions.id,
			operation: transactionRevisions.operation,
			payload: transactionRevisions.payload,
			occurredAt: transactionRevisions.occurredAt,
		})
		.from(canonicalTransactions)
		.innerJoin(
			transactionRevisions,
			eq(canonicalTransactions.id, transactionRevisions.transactionId),
		)
		.innerJoin(
			latestTxRevisions,
			and(
				eq(transactionRevisions.transactionId, latestTxRevisions.transactionId),
				eq(transactionRevisions.revisionNo, latestTxRevisions.maxRev),
			),
		)
		.where(
			and(
				eq(canonicalTransactions.userId, userId),
				eq(canonicalTransactions.kind, "MANUAL_EXPENSE"),
				gte(transactionRevisions.occurredAt, start),
				lt(transactionRevisions.occurredAt, end),
			),
		);

	for (const me of manualExpenseRows) {
		if (me.operation === "VOID") continue;

		const payload = me.payload as { amount?: string };
		if (!payload?.amount) continue;

		const personalCents = parseAggregateMoneyString(payload.amount).cents;
		if (personalCents <= 0n) continue;

		totalPersonalCents += personalCents;

		const categoryId = assignmentLookup.get(
			`MANUAL_EXPENSE:${me.transactionId}`,
		);
		if (categoryId && categoryTotals.has(categoryId)) {
			const existing = categoryTotals.get(categoryId)!;
			existing.cents += personalCents;
			existing.count += 1;
		} else {
			unclassifiedCents += personalCents;
		}
	}

	// Build sorted response
	const categoriesList: SpendingCategorySummaryItem[] = [];
	for (const [id, data] of categoryTotals.entries()) {
		if (data.count > 0 || data.cents > 0n) {
			categoriesList.push({
				categoryId: id,
				categoryName: data.name,
				amount: formatCentsToMoney(data.cents),
				transactionCount: data.count,
			});
		}
	}

	return {
		periodMonth,
		totalPersonalSpending: formatCentsToMoney(totalPersonalCents),
		categories: categoriesList,
		unclassifiedAmount: formatCentsToMoney(unclassifiedCents),
	};
}
