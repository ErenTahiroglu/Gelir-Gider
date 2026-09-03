import { and, desc, eq, inArray } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import { incomeReceipts } from "../db/schema/income";
import {
	incomeEntitlements,
	incomeSettlementBatches,
	incomeSettlementBatchRevisions,
	type SettlementAllocationItem,
} from "../db/schema/income-entitlements";
import { parseMoneyString } from "../ledger/money";

/**
 * Computes the total allocated amount in cents for an active income receipt in a transaction.
 * Considers only the latest revision of the receipt's settlement batch.
 */
export async function getActiveReceiptAllocatedCentsInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	incomeReceiptId: string,
): Promise<bigint> {
	// Find the settlement batch for this receipt
	const [batch] = await tx
		.select({ id: incomeSettlementBatches.id })
		.from(incomeSettlementBatches)
		.where(
			and(
				eq(incomeSettlementBatches.userId, userId),
				eq(incomeSettlementBatches.incomeReceiptId, incomeReceiptId),
			),
		)
		.limit(1);

	if (!batch) {
		return 0n;
	}

	// Fetch latest settlement batch revision
	const [latestRev] = await tx
		.select({
			allocations: incomeSettlementBatchRevisions.allocations,
		})
		.from(incomeSettlementBatchRevisions)
		.where(
			and(
				eq(incomeSettlementBatchRevisions.userId, userId),
				eq(incomeSettlementBatchRevisions.settlementBatchId, batch.id),
			),
		)
		.orderBy(desc(incomeSettlementBatchRevisions.revisionNo))
		.limit(1);

	if (!latestRev || !Array.isArray(latestRev.allocations)) {
		return 0n;
	}

	let totalCents = 0n;
	for (const item of latestRev.allocations as SettlementAllocationItem[]) {
		if (item?.amount) {
			totalCents += parseMoneyString(item.amount).cents;
		}
	}
	return totalCents;
}

/**
 * Computes the total allocated amount in cents across all other active settlement batches
 * for a specific entitlement in a transaction.
 */
export async function getActiveEntitlementAllocatedCentsInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	entitlementId: string,
	excludeBatchId?: string,
): Promise<bigint> {
	// Fetch all revisions for the user ordered by batch and revisionNo DESC
	const allRevs = await tx
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

	// Group by settlementBatchId and pick only the latest revision
	const latestByBatch = new Map<string, SettlementAllocationItem[]>();
	for (const r of allRevs) {
		if (!latestByBatch.has(r.settlementBatchId)) {
			latestByBatch.set(
				r.settlementBatchId,
				Array.isArray(r.allocations)
					? (r.allocations as SettlementAllocationItem[])
					: [],
			);
		}
	}

	let totalCents = 0n;
	for (const [batchId, allocs] of latestByBatch) {
		if (excludeBatchId && batchId === excludeBatchId) {
			continue;
		}
		for (const item of allocs) {
			if (item?.entitlementId === entitlementId && item?.amount) {
				totalCents += parseMoneyString(item.amount).cents;
			}
		}
	}
	return totalCents;
}

/**
 * Concurrency row-locking helper:
 * Acquires row locks on receipt and sorted entitlement rows.
 */
export async function lockReceiptAndEntitlementsForSettlement(
	tx: DatabaseTransaction,
	userId: string,
	incomeReceiptId: string,
	entitlementIds: string[],
): Promise<void> {
	// 1. Lock receipt row
	await tx
		.select({ id: incomeReceipts.id })
		.from(incomeReceipts)
		.where(
			and(
				eq(incomeReceipts.id, incomeReceiptId),
				eq(incomeReceipts.userId, userId),
			),
		)
		.for("update");

	// 2. Lock entitlement rows in deterministic sorted order
	if (entitlementIds.length > 0) {
		const uniqueSortedIds = Array.from(new Set(entitlementIds)).sort();
		await tx
			.select({ id: incomeEntitlements.id })
			.from(incomeEntitlements)
			.where(
				and(
					eq(incomeEntitlements.userId, userId),
					inArray(incomeEntitlements.id, uniqueSortedIds),
				),
			)
			.for("update");
	}
}
