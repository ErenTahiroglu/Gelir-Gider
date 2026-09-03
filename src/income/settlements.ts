import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { incomeReceiptRevisions, incomeReceipts } from "../db/schema/income";
import {
	incomeEntitlementRevisions,
	incomeEntitlements,
	incomeSettlementBatches,
	incomeSettlementBatchRevisions,
	type SettlementAllocationItem,
} from "../db/schema/income-entitlements";
import {
	formatCentsToMoney,
	type ParsedMoney,
	parseMoneyString,
} from "../ledger/money";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	type CanonicalTransactionOperationResult,
	createCanonicalTransactionInTransaction,
	reviseCanonicalTransactionInTransaction,
	type TransactionSourceInput,
} from "../transactions/service";
import { IncomeError } from "./errors";
import {
	getActiveEntitlementAllocatedCentsInTransaction,
	lockReceiptAndEntitlementsForSettlement,
} from "./settlement-state";
import { normalizeUuid } from "./utils";

export interface IncomeReceiptSettlementAllocationItem {
	entitlementId: string;
	periodMonth: string;
	entitlementAmount: string;
	allocatedAmount: string;
	entitlementOutstandingAfterAllReceipts: string;
}

export interface IncomeReceiptSettlementResult {
	incomeReceiptId: string;
	receiptAmount: string;
	allocatedAmount: string;
	unallocatedAmount: string;
	settlementBatchId: string | null;
	revisionNo: number | null;
	allocations: IncomeReceiptSettlementAllocationItem[];
}

export interface AllocationInput {
	entitlementId: string;
	amount: string;
}

export interface CreateIncomeSettlementParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
	allocations: AllocationInput[];
	note?: string | null | undefined;
	idempotencyKey: string;
	provenance: TransactionSourceInput;
}

export interface CreateIncomeSettlementResult {
	settlement: IncomeReceiptSettlementResult;
	idempotentReplay: boolean;
}

export interface ReviseIncomeSettlementParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
	expectedRevisionNo: number;
	allocations: AllocationInput[];
	note?: string | null | undefined;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface ReviseIncomeSettlementResult {
	settlement: IncomeReceiptSettlementResult;
	idempotentReplay: boolean;
}

export interface GetIncomeReceiptSettlementParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
}

/**
 * Normalizes, validates, and sorts allocation inputs by entitlementId ASC.
 */
function normalizeAndSortAllocations(
	allocations: AllocationInput[],
): SettlementAllocationItem[] {
	const seenEntitlementIds = new Set<string>();
	const normalizedList: SettlementAllocationItem[] = [];

	for (const alloc of allocations) {
		const canonicalId = normalizeUuid(
			alloc?.entitlementId,
			"allocation entitlementId",
		);

		if (seenEntitlementIds.has(canonicalId)) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				`Duplicate entitlementId "${canonicalId}" in allocations`,
			);
		}
		seenEntitlementIds.add(canonicalId);

		let parsed: ParsedMoney;
		try {
			parsed = parseMoneyString(alloc.amount);
		} catch (e) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				`Invalid allocation amount: ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		if (parsed.cents <= 0n) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Allocation amount must be strictly positive",
			);
		}

		normalizedList.push({
			entitlementId: canonicalId,
			amount: parsed.normalized,
		});
	}

	// Deterministic sorting by entitlementId ASC
	normalizedList.sort((a, b) => a.entitlementId.localeCompare(b.entitlementId));
	return normalizedList;
}

/**
 * Creates a settlement batch attributing an income receipt to one or more entitlements.
 * Creates NO journal entries or ledger movements.
 */
export async function createIncomeSettlement(
	params: CreateIncomeSettlementParams,
): Promise<CreateIncomeSettlementResult> {
	const {
		db,
		userId,
		incomeReceiptId,
		allocations,
		note,
		idempotencyKey,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalReceiptId = normalizeUuid(incomeReceiptId, "incomeReceiptId");

	if (!allocations || allocations.length === 0) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"CREATE settlement requires at least 1 allocation",
		);
	}

	const normalizedAllocations = normalizeAndSortAllocations(allocations);

	let normalizedNote: string | null = null;
	if (note != null) {
		const trimmedNote = note.trim();
		if (trimmedNote.length > 500) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Settlement note must not exceed 500 characters",
			);
		}
		normalizedNote = trimmedNote.length > 0 ? trimmedNote : null;
	}

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	return await db.transaction(async (tx) => {
		// 1. Acquire row locks on receipt and all target entitlements FIRST
		const targetEntitlementIds = normalizedAllocations.map(
			(a) => a.entitlementId,
		);
		const receipt = await lockReceiptAndEntitlementsForSettlement(
			tx,
			userId,
			canonicalReceiptId,
			targetEntitlementIds,
		);

		// 2. AFTER lock: Fetch authoritative latest receipt revision
		const [latestReceiptRev] = await tx
			.select()
			.from(incomeReceiptRevisions)
			.where(
				and(
					eq(incomeReceiptRevisions.incomeReceiptId, receipt.id),
					eq(incomeReceiptRevisions.userId, userId),
				),
			)
			.orderBy(desc(incomeReceiptRevisions.revisionNo))
			.limit(1);

		if (!latestReceiptRev || latestReceiptRev.operation === "VOID") {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				"Cannot settle against a non-existent or VOIDED income receipt",
			);
		}

		// 3. Validate receipt cap
		let totalAllocatedCents = 0n;
		for (const a of normalizedAllocations) {
			totalAllocatedCents += parseMoneyString(a.amount).cents;
		}

		const receiptCents = parseMoneyString(latestReceiptRev.amount).cents;
		if (totalAllocatedCents > receiptCents) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_CONFLICT",
				`Total allocation (${formatCentsToMoney(totalAllocatedCents)}) exceeds active income receipt amount (${latestReceiptRev.amount})`,
			);
		}

		// 4. Validate each target entitlement (ownership, same source, not void, entitlement cap)
		const entBreakdown: IncomeReceiptSettlementAllocationItem[] = [];

		for (const alloc of normalizedAllocations) {
			const [ent] = await tx
				.select()
				.from(incomeEntitlements)
				.where(
					and(
						eq(incomeEntitlements.id, alloc.entitlementId),
						eq(incomeEntitlements.userId, userId),
					),
				)
				.limit(1);

			if (!ent) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_NOT_FOUND",
					`Allocated entitlement "${alloc.entitlementId}" not found`,
				);
			}

			if (ent.sourceId !== receipt.sourceId) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_CONFLICT",
					`Allocated entitlement "${alloc.entitlementId}" source does not match income receipt source`,
				);
			}

			const [latestEntRev] = await tx
				.select()
				.from(incomeEntitlementRevisions)
				.where(
					and(
						eq(incomeEntitlementRevisions.entitlementId, ent.id),
						eq(incomeEntitlementRevisions.userId, userId),
					),
				)
				.orderBy(desc(incomeEntitlementRevisions.revisionNo))
				.limit(1);

			if (!latestEntRev || latestEntRev.operation === "VOID") {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_INVALID_STATE",
					`Cannot allocate to non-existent or VOIDED entitlement "${alloc.entitlementId}"`,
				);
			}

			const otherAllocCents =
				await getActiveEntitlementAllocatedCentsInTransaction(
					tx,
					userId,
					ent.id,
				);

			const thisAllocCents = parseMoneyString(alloc.amount).cents;
			const entTotalCents = parseMoneyString(latestEntRev.amount).cents;

			if (otherAllocCents + thisAllocCents > entTotalCents) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_CONFLICT",
					`Total allocation (${formatCentsToMoney(otherAllocCents + thisAllocCents)}) exceeds active entitlement amount (${latestEntRev.amount}) for entitlement "${ent.id}"`,
				);
			}

			const outstandingAfterCents =
				entTotalCents > otherAllocCents + thisAllocCents
					? entTotalCents - (otherAllocCents + thisAllocCents)
					: 0n;

			entBreakdown.push({
				entitlementId: ent.id,
				periodMonth: ent.periodMonth,
				entitlementAmount: latestEntRev.amount,
				allocatedAmount: alloc.amount,
				entitlementOutstandingAfterAllReceipts: formatCentsToMoney(
					outstandingAfterCents,
				),
			});
		}

		// 5. Check existing batch for this receipt
		const [existingBatch] = await tx
			.select()
			.from(incomeSettlementBatches)
			.where(
				and(
					eq(incomeSettlementBatches.incomeReceiptId, receipt.id),
					eq(incomeSettlementBatches.userId, userId),
				),
			)
			.limit(1);

		const canonicalPayload: Record<string, unknown> = {
			incomeReceiptId: receipt.id,
			allocations: normalizedAllocations,
			note: normalizedNote,
		};

		let canonRes: CanonicalTransactionOperationResult;
		try {
			canonRes = await createCanonicalTransactionInTransaction({
				tx,
				userId,
				kind: "INCOME_SETTLEMENT",
				idempotencyKey: trimmedIdempotencyKey,
				occurredAt: latestReceiptRev.occurredAt,
				payload: canonicalPayload,
				source: provenance,
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_IDEMPOTENCY_CONFLICT"
			) {
				throw new IncomeError(
					"INCOME_IDEMPOTENCY_CONFLICT",
					"Settlement creation replayed with changed parameters",
				);
			}
			throw err;
		}

		if (canonRes.idempotentReplay) {
			if (!existingBatch) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_NOT_FOUND",
					"Settlement batch missing on canonical replay",
				);
			}

			const [latestBatchRev] = await tx
				.select()
				.from(incomeSettlementBatchRevisions)
				.where(
					eq(
						incomeSettlementBatchRevisions.canonicalRevisionId,
						canonRes.revisionId,
					),
				)
				.limit(1);

			if (!latestBatchRev) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_NOT_FOUND",
					"Settlement batch revision missing on canonical replay",
				);
			}

			const unallocatedCents =
				receiptCents > totalAllocatedCents
					? receiptCents - totalAllocatedCents
					: 0n;

			return {
				idempotentReplay: true,
				settlement: {
					incomeReceiptId: receipt.id,
					receiptAmount: latestReceiptRev.amount,
					allocatedAmount: formatCentsToMoney(totalAllocatedCents),
					unallocatedAmount: formatCentsToMoney(unallocatedCents),
					settlementBatchId: existingBatch.id,
					revisionNo: latestBatchRev.revisionNo,
					allocations: entBreakdown,
				},
			};
		}

		if (existingBatch) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_ALREADY_EXISTS",
				`Settlement batch already exists for income receipt "${receipt.id}". Use reviseIncomeSettlement to modify allocations.`,
			);
		}

		// Insert batch identity
		const [batch] = await tx
			.insert(incomeSettlementBatches)
			.values({
				userId,
				incomeReceiptId: receipt.id,
				canonicalTransactionId: canonRes.transactionId,
			})
			.returning();

		if (!batch) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_NOT_FOUND",
				"Failed to create income settlement batch",
			);
		}

		// Insert revision #1
		const [batchRev] = await tx
			.insert(incomeSettlementBatchRevisions)
			.values({
				userId,
				settlementBatchId: batch.id,
				canonicalRevisionId: canonRes.revisionId,
				revisionNo: 1,
				previousSettlementRevisionId: null,
				operation: "CREATE",
				allocations: normalizedAllocations,
				note: normalizedNote,
			})
			.returning();

		if (!batchRev) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_NOT_FOUND",
				"Failed to create income settlement batch revision",
			);
		}

		const unallocatedCents =
			receiptCents > totalAllocatedCents
				? receiptCents - totalAllocatedCents
				: 0n;

		return {
			idempotentReplay: false,
			settlement: {
				incomeReceiptId: receipt.id,
				receiptAmount: latestReceiptRev.amount,
				allocatedAmount: formatCentsToMoney(totalAllocatedCents),
				unallocatedAmount: formatCentsToMoney(unallocatedCents),
				settlementBatchId: batch.id,
				revisionNo: batchRev.revisionNo,
				allocations: entBreakdown,
			},
		};
	});
}

/**
 * Revises a settlement batch, replacing its allocation array snapshot or clearing it ([]).
 */
export async function reviseIncomeSettlement(
	params: ReviseIncomeSettlementParams,
): Promise<ReviseIncomeSettlementResult> {
	const {
		db,
		userId,
		incomeReceiptId,
		expectedRevisionNo,
		allocations,
		note,
		idempotencyKey,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalReceiptId = normalizeUuid(incomeReceiptId, "incomeReceiptId");

	const normalizedAllocations =
		allocations && allocations.length > 0
			? normalizeAndSortAllocations(allocations)
			: [];

	let normalizedNote: string | null = null;
	if (note != null) {
		const trimmedNote = note.trim();
		if (trimmedNote.length > 500) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Settlement note must not exceed 500 characters",
			);
		}
		normalizedNote = trimmedNote.length > 0 ? trimmedNote : null;
	}

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	return await db.transaction(async (tx) => {
		// 1. Fetch settlement batch identity
		const [batch] = await tx
			.select()
			.from(incomeSettlementBatches)
			.where(
				and(
					eq(incomeSettlementBatches.incomeReceiptId, canonicalReceiptId),
					eq(incomeSettlementBatches.userId, userId),
				),
			)
			.limit(1);

		if (!batch) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_NOT_FOUND",
				`Settlement batch not found for income receipt "${canonicalReceiptId}"`,
			);
		}

		// 2. Fetch previous batch revision
		const [prevBatchRev] = await tx
			.select()
			.from(incomeSettlementBatchRevisions)
			.where(
				and(
					eq(incomeSettlementBatchRevisions.settlementBatchId, batch.id),
					eq(incomeSettlementBatchRevisions.revisionNo, expectedRevisionNo),
				),
			)
			.limit(1);

		if (!prevBatchRev) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_NOT_FOUND",
				`Expected settlement revision ${expectedRevisionNo} not found`,
			);
		}

		// 3. Collect all involved entitlement IDs (both from prev revision and new revision)
		const allInvolvedEntitlementIds = new Set<string>();
		if (Array.isArray(prevBatchRev.allocations)) {
			for (const a of prevBatchRev.allocations as SettlementAllocationItem[]) {
				if (a?.entitlementId) allInvolvedEntitlementIds.add(a.entitlementId);
			}
		}
		for (const a of normalizedAllocations) {
			allInvolvedEntitlementIds.add(a.entitlementId);
		}

		// 4. Acquire row locks on receipt and all involved entitlements FIRST
		const receipt = await lockReceiptAndEntitlementsForSettlement(
			tx,
			userId,
			canonicalReceiptId,
			Array.from(allInvolvedEntitlementIds),
		);

		// 5. AFTER lock: Fetch authoritative latest receipt revision
		const [latestReceiptRev] = await tx
			.select()
			.from(incomeReceiptRevisions)
			.where(
				and(
					eq(incomeReceiptRevisions.incomeReceiptId, receipt.id),
					eq(incomeReceiptRevisions.userId, userId),
				),
			)
			.orderBy(desc(incomeReceiptRevisions.revisionNo))
			.limit(1);

		if (!latestReceiptRev || latestReceiptRev.operation === "VOID") {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				"Cannot revise settlement for a non-existent or VOIDED income receipt",
			);
		}

		// 6. Validate receipt cap
		let totalAllocatedCents = 0n;
		for (const a of normalizedAllocations) {
			totalAllocatedCents += parseMoneyString(a.amount).cents;
		}

		const receiptCents = parseMoneyString(latestReceiptRev.amount).cents;
		if (totalAllocatedCents > receiptCents) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_CONFLICT",
				`Total allocation (${formatCentsToMoney(totalAllocatedCents)}) exceeds active income receipt amount (${latestReceiptRev.amount})`,
			);
		}

		// 7. Validate each target entitlement cap
		const entBreakdown: IncomeReceiptSettlementAllocationItem[] = [];

		for (const alloc of normalizedAllocations) {
			const [ent] = await tx
				.select()
				.from(incomeEntitlements)
				.where(
					and(
						eq(incomeEntitlements.id, alloc.entitlementId),
						eq(incomeEntitlements.userId, userId),
					),
				)
				.limit(1);

			if (!ent) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_NOT_FOUND",
					`Allocated entitlement "${alloc.entitlementId}" not found`,
				);
			}

			if (ent.sourceId !== receipt.sourceId) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_CONFLICT",
					`Allocated entitlement "${alloc.entitlementId}" source does not match income receipt source`,
				);
			}

			const [latestEntRev] = await tx
				.select()
				.from(incomeEntitlementRevisions)
				.where(
					and(
						eq(incomeEntitlementRevisions.entitlementId, ent.id),
						eq(incomeEntitlementRevisions.userId, userId),
					),
				)
				.orderBy(desc(incomeEntitlementRevisions.revisionNo))
				.limit(1);

			if (!latestEntRev || latestEntRev.operation === "VOID") {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_INVALID_STATE",
					`Cannot allocate to non-existent or VOIDED entitlement "${alloc.entitlementId}"`,
				);
			}

			// Exclude this batch when calculating other allocations
			const otherAllocCents =
				await getActiveEntitlementAllocatedCentsInTransaction(
					tx,
					userId,
					ent.id,
					batch.id,
				);

			const thisAllocCents = parseMoneyString(alloc.amount).cents;
			const entTotalCents = parseMoneyString(latestEntRev.amount).cents;

			if (otherAllocCents + thisAllocCents > entTotalCents) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_CONFLICT",
					`Total allocation (${formatCentsToMoney(otherAllocCents + thisAllocCents)}) exceeds active entitlement amount (${latestEntRev.amount}) for entitlement "${ent.id}"`,
				);
			}

			const outstandingAfterCents =
				entTotalCents > otherAllocCents + thisAllocCents
					? entTotalCents - (otherAllocCents + thisAllocCents)
					: 0n;

			entBreakdown.push({
				entitlementId: ent.id,
				periodMonth: ent.periodMonth,
				entitlementAmount: latestEntRev.amount,
				allocatedAmount: alloc.amount,
				entitlementOutstandingAfterAllReceipts: formatCentsToMoney(
					outstandingAfterCents,
				),
			});
		}

		const canonicalPayload: Record<string, unknown> = {
			incomeReceiptId: receipt.id,
			allocations: normalizedAllocations,
			note: normalizedNote,
		};

		let canonRes: CanonicalTransactionOperationResult;
		try {
			canonRes = await reviseCanonicalTransactionInTransaction({
				tx,
				userId,
				transactionId: batch.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey: trimmedIdempotencyKey,
				occurredAt: latestReceiptRev.occurredAt,
				payload: canonicalPayload,
				reasonCode,
				reasonNote,
				source: provenance,
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_IDEMPOTENCY_CONFLICT"
			) {
				throw new IncomeError(
					"INCOME_IDEMPOTENCY_CONFLICT",
					"Settlement revision replayed with changed parameters",
				);
			}
			throw err;
		}

		if (canonRes.idempotentReplay) {
			const [existingBatchRev] = await tx
				.select()
				.from(incomeSettlementBatchRevisions)
				.where(
					eq(
						incomeSettlementBatchRevisions.canonicalRevisionId,
						canonRes.revisionId,
					),
				)
				.limit(1);

			if (!existingBatchRev) {
				throw new IncomeError(
					"INCOME_SETTLEMENT_NOT_FOUND",
					"Settlement revision missing on replay",
				);
			}

			const unallocatedCents =
				receiptCents > totalAllocatedCents
					? receiptCents - totalAllocatedCents
					: 0n;

			return {
				idempotentReplay: true,
				settlement: {
					incomeReceiptId: receipt.id,
					receiptAmount: latestReceiptRev.amount,
					allocatedAmount: formatCentsToMoney(totalAllocatedCents),
					unallocatedAmount: formatCentsToMoney(unallocatedCents),
					settlementBatchId: batch.id,
					revisionNo: existingBatchRev.revisionNo,
					allocations: entBreakdown,
				},
			};
		}

		// Insert revision snapshot
		const [newBatchRev] = await tx
			.insert(incomeSettlementBatchRevisions)
			.values({
				userId,
				settlementBatchId: batch.id,
				canonicalRevisionId: canonRes.revisionId,
				revisionNo: canonRes.revisionNo,
				previousSettlementRevisionId: prevBatchRev.id,
				operation: "UPDATE",
				allocations: normalizedAllocations,
				note: normalizedNote,
			})
			.returning();

		if (!newBatchRev) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_NOT_FOUND",
				"Failed to insert revised settlement batch revision",
			);
		}

		const unallocatedCents =
			receiptCents > totalAllocatedCents
				? receiptCents - totalAllocatedCents
				: 0n;

		return {
			idempotentReplay: false,
			settlement: {
				incomeReceiptId: receipt.id,
				receiptAmount: latestReceiptRev.amount,
				allocatedAmount: formatCentsToMoney(totalAllocatedCents),
				unallocatedAmount: formatCentsToMoney(unallocatedCents),
				settlementBatchId: batch.id,
				revisionNo: newBatchRev.revisionNo,
				allocations: entBreakdown,
			},
		};
	});
}

/**
 * Retrieves the current settlement snapshot and allocations for an income receipt.
 */
export async function getIncomeReceiptSettlement(
	params: GetIncomeReceiptSettlementParams,
): Promise<IncomeReceiptSettlementResult> {
	const { db, userId, incomeReceiptId } = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalReceiptId = normalizeUuid(incomeReceiptId, "incomeReceiptId");

	const [receipt] = await db
		.select()
		.from(incomeReceipts)
		.where(
			and(
				eq(incomeReceipts.id, canonicalReceiptId),
				eq(incomeReceipts.userId, userId),
			),
		)
		.limit(1);

	if (!receipt) {
		throw new IncomeError(
			"INCOME_RECEIPT_NOT_FOUND",
			`Income receipt "${canonicalReceiptId}" not found`,
		);
	}

	const [latestReceiptRev] = await db
		.select()
		.from(incomeReceiptRevisions)
		.where(
			and(
				eq(incomeReceiptRevisions.incomeReceiptId, receipt.id),
				eq(incomeReceiptRevisions.userId, userId),
			),
		)
		.orderBy(desc(incomeReceiptRevisions.revisionNo))
		.limit(1);

	if (!latestReceiptRev) {
		throw new IncomeError(
			"INCOME_RECEIPT_INVALID_STATE",
			"Receipt revision missing",
		);
	}

	const receiptCents = parseMoneyString(latestReceiptRev.amount).cents;

	const [batch] = await db
		.select()
		.from(incomeSettlementBatches)
		.where(
			and(
				eq(incomeSettlementBatches.incomeReceiptId, receipt.id),
				eq(incomeSettlementBatches.userId, userId),
			),
		)
		.limit(1);

	if (!batch) {
		return {
			incomeReceiptId: receipt.id,
			receiptAmount: latestReceiptRev.amount,
			allocatedAmount: "0.00",
			unallocatedAmount: latestReceiptRev.amount,
			settlementBatchId: null,
			revisionNo: null,
			allocations: [],
		};
	}

	const [latestBatchRev] = await db
		.select()
		.from(incomeSettlementBatchRevisions)
		.where(
			and(
				eq(incomeSettlementBatchRevisions.settlementBatchId, batch.id),
				eq(incomeSettlementBatchRevisions.userId, userId),
			),
		)
		.orderBy(desc(incomeSettlementBatchRevisions.revisionNo))
		.limit(1);

	if (!latestBatchRev || !Array.isArray(latestBatchRev.allocations)) {
		return {
			incomeReceiptId: receipt.id,
			receiptAmount: latestReceiptRev.amount,
			allocatedAmount: "0.00",
			unallocatedAmount: latestReceiptRev.amount,
			settlementBatchId: batch.id,
			revisionNo: null,
			allocations: [],
		};
	}

	const allocItems = latestBatchRev.allocations as SettlementAllocationItem[];
	if (allocItems.length === 0) {
		return {
			incomeReceiptId: receipt.id,
			receiptAmount: latestReceiptRev.amount,
			allocatedAmount: "0.00",
			unallocatedAmount: latestReceiptRev.amount,
			settlementBatchId: batch.id,
			revisionNo: latestBatchRev.revisionNo,
			allocations: [],
		};
	}

	const entIds = allocItems.map((a) => a.entitlementId);

	const ents = await db
		.select({
			id: incomeEntitlements.id,
			periodMonth: incomeEntitlements.periodMonth,
		})
		.from(incomeEntitlements)
		.where(
			and(
				eq(incomeEntitlements.userId, userId),
				inArray(incomeEntitlements.id, entIds),
			),
		);

	const entMap = new Map(ents.map((e) => [e.id, e]));

	const allEntRevs = await db
		.select({
			entitlementId: incomeEntitlementRevisions.entitlementId,
			revisionNo: incomeEntitlementRevisions.revisionNo,
			amount: incomeEntitlementRevisions.amount,
		})
		.from(incomeEntitlementRevisions)
		.where(
			and(
				eq(incomeEntitlementRevisions.userId, userId),
				inArray(incomeEntitlementRevisions.entitlementId, entIds),
			),
		)
		.orderBy(
			incomeEntitlementRevisions.entitlementId,
			desc(incomeEntitlementRevisions.revisionNo),
		);

	const entRevMap = new Map<string, (typeof allEntRevs)[0]>();
	for (const r of allEntRevs) {
		if (!entRevMap.has(r.entitlementId)) {
			entRevMap.set(r.entitlementId, r);
		}
	}

	// Calculate total allocations across all batches for outstanding calculation
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

	const globalAllocMap = new Map<string, bigint>();
	for (const allocs of latestBatches.values()) {
		for (const a of allocs) {
			if (a?.entitlementId && a?.amount) {
				const cents = parseMoneyString(a.amount).cents;
				const cur = globalAllocMap.get(a.entitlementId) ?? 0n;
				globalAllocMap.set(a.entitlementId, cur + cents);
			}
		}
	}

	let totalAllocatedCents = 0n;
	const resultAllocations: IncomeReceiptSettlementAllocationItem[] = [];

	for (const a of allocItems) {
		const ent = entMap.get(a.entitlementId);
		const entRev = entRevMap.get(a.entitlementId);
		const thisCents = parseMoneyString(a.amount).cents;
		totalAllocatedCents += thisCents;

		const entTotalCents = entRev ? parseMoneyString(entRev.amount).cents : 0n;
		const totalAllBatchesCents = globalAllocMap.get(a.entitlementId) ?? 0n;
		const outstandingCents =
			entTotalCents > totalAllBatchesCents
				? entTotalCents - totalAllBatchesCents
				: 0n;

		resultAllocations.push({
			entitlementId: a.entitlementId,
			periodMonth: ent?.periodMonth ?? "",
			entitlementAmount: entRev?.amount ?? "0.00",
			allocatedAmount: a.amount,
			entitlementOutstandingAfterAllReceipts:
				formatCentsToMoney(outstandingCents),
		});
	}

	const unallocatedCents =
		receiptCents > totalAllocatedCents
			? receiptCents - totalAllocatedCents
			: 0n;

	return {
		incomeReceiptId: receipt.id,
		receiptAmount: latestReceiptRev.amount,
		allocatedAmount: formatCentsToMoney(totalAllocatedCents),
		unallocatedAmount: formatCentsToMoney(unallocatedCents),
		settlementBatchId: batch.id,
		revisionNo: latestBatchRev.revisionNo,
		allocations: resultAllocations,
	};
}
