import { and, eq, gte, lt, sql } from "drizzle-orm";
import { resolveAuthoritativePurchaseSplitAsOf } from "../credit-cards/purchase-split-read";
import type { DatabaseOrTransaction } from "../db/client";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { parseAggregateMoneyString } from "../ledger/money";

export interface CalculatePersonalSpendParams {
	db: DatabaseOrTransaction;
	userId: string;
	start: Date;
	end: Date;
}

export interface PersonalSpendSummary {
	totalPersonalSpendCents: bigint;
	purchaseCount: number;
	manualExpenseCount: number;
	hasSpending: boolean;
}

/**
 * Authoritatively computes personal spending for a user within a [start, end) interval:
 * 1. Credit card purchases: uses the user's authoritative personal share after obligation splits
 *    via `resolveAuthoritativePurchaseSplitAsOf`.
 * 2. Manual expenses: `canonicalTransactions.kind === "MANUAL_EXPENSE"`.
 * Explicitly excludes: transfers, card payments, Midas allocations, and investment movements.
 */
export async function calculatePersonalSpendInTransaction(
	params: CalculatePersonalSpendParams,
): Promise<PersonalSpendSummary> {
	const { db, userId, start, end } = params;

	let totalPersonalSpendCents = 0n;
	let purchaseCount = 0;
	let manualExpenseCount = 0;

	// 1. Credit Card Purchases
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

		if (personalCents > 0n) {
			totalPersonalSpendCents += personalCents;
			purchaseCount++;
		}
	}

	// 2. Manual Expenses
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

		const payload = me.payload as { amount?: string } | null;
		if (!payload?.amount) continue;

		const personalCents = parseAggregateMoneyString(payload.amount).cents;
		if (personalCents > 0n) {
			totalPersonalSpendCents += personalCents;
			manualExpenseCount++;
		}
	}

	return {
		totalPersonalSpendCents,
		purchaseCount,
		manualExpenseCount,
		hasSpending: totalPersonalSpendCents > 0n,
	};
}
