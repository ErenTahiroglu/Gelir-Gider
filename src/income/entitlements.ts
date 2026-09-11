import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import { incomeSources } from "../db/schema/income";
import {
	incomeEntitlementRevisions,
	incomeEntitlements,
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
	voidCanonicalTransactionInTransaction,
} from "../transactions/service";
import {
	doesMonthOverlapWindow,
	getIstanbulCalendarDate,
	getIstanbulDateAtMidnightUtc,
	validateIsoCalendarDate,
	validatePeriodMonth,
} from "./calendar";
import { IncomeError } from "./errors";
import { getActiveEntitlementAllocatedCentsInTransaction } from "./settlement-state";
import { isEntitlementPeriodUniqueViolation, normalizeUuid } from "./utils";

export type EntitlementStatus = "ACTIVE" | "VOIDED";
export type EntitlementSettlementStatus =
	| "OPEN"
	| "PARTIAL"
	| "SETTLED"
	| "VOIDED";

export interface IncomeEntitlementItem {
	entitlementId: string;
	sourceId: string;
	sourceCode: string;
	sourceName: string;
	periodMonth: string; // YYYY-MM-01
	revisionNo: number;
	status: EntitlementStatus;
	amount: string;
	allocatedAmount: string;
	outstandingAmount: string;
	settlementStatus: EntitlementSettlementStatus;
	expectedReceiptOn: string | null;
	overdue: boolean;
	note: string | null;
	canonicalTransactionId: string;
	canonicalRevisionId: string;
}

export interface CreateIncomeEntitlementParams {
	db: Database;
	userId: string;
	sourceId: string;
	periodMonth: string;
	amount: string;
	expectedReceiptOn?: string | null | undefined;
	note?: string | null | undefined;
	idempotencyKey: string;
	provenance: TransactionSourceInput;
}

export interface CreateIncomeEntitlementResult {
	incomeEntitlement: IncomeEntitlementItem;
	idempotentReplay: boolean;
}

export interface ReviseIncomeEntitlementParams {
	db: Database;
	userId: string;
	entitlementId: string;
	expectedRevisionNo: number;
	amount: string;
	expectedReceiptOn?: string | null | undefined;
	note?: string | null | undefined;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface ReviseIncomeEntitlementResult {
	incomeEntitlement: IncomeEntitlementItem;
	idempotentReplay: boolean;
}

export interface VoidIncomeEntitlementParams {
	db: Database;
	userId: string;
	entitlementId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface VoidIncomeEntitlementResult {
	incomeEntitlement: IncomeEntitlementItem;
	idempotentReplay: boolean;
}

export interface GetIncomeEntitlementParams {
	db: Database;
	userId: string;
	entitlementId: string;
	asOf?: string | Date | undefined;
}

export interface ListIncomeEntitlementsParams {
	db: Database;
	userId: string;
	sourceId?: string | undefined;
	periodMonthFrom?: string | undefined;
	periodMonthUntil?: string | undefined;
	asOf?: string | Date | undefined;
}

/**
 * Creates a monthly income entitlement record (accrual / expectation).
 * Creates NO journal entries or ledger movements.
 */
export async function createIncomeEntitlement(
	params: CreateIncomeEntitlementParams,
): Promise<CreateIncomeEntitlementResult> {
	const {
		db,
		userId,
		sourceId,
		periodMonth,
		amount,
		expectedReceiptOn,
		note,
		idempotencyKey,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalSourceId = normalizeUuid(sourceId, "sourceId");
	const validPeriod = validatePeriodMonth(periodMonth);

	let parsedAmount: ParsedMoney;
	try {
		parsedAmount = parseMoneyString(amount);
	} catch (e) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid income entitlement amount: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (parsedAmount.cents <= 0n) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income entitlement amount must be strictly positive",
		);
	}

	let normalizedExpectedReceiptOn: string | null = null;
	if (expectedReceiptOn != null && expectedReceiptOn.trim() !== "") {
		normalizedExpectedReceiptOn = validateIsoCalendarDate(expectedReceiptOn);
	}

	let normalizedNote: string | null = null;
	if (note != null) {
		const trimmedNote = note.trim();
		if (trimmedNote.length > 500) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Entitlement note must not exceed 500 characters",
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

	const occurredAt = getIstanbulDateAtMidnightUtc(validPeriod);

	return await db.transaction(async (tx) => {
		// 1. Fetch user for currency
		const [user] = await tx
			.select({ currency: users.currency })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		if (!user) {
			throw new IncomeError("INCOME_INVALID_INPUT", "User not found");
		}

		// 2. Fetch income source
		const [source] = await tx
			.select()
			.from(incomeSources)
			.where(
				and(
					eq(incomeSources.id, canonicalSourceId),
					eq(incomeSources.userId, userId),
				),
			)
			.limit(1);

		if (!source) {
			throw new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				`Income source "${canonicalSourceId}" not found`,
			);
		}

		if (source.nature !== "REGULAR") {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				`Entitlements are only permitted for REGULAR income sources, found nature "${source.nature}"`,
			);
		}

		// Check active window overlap
		if (
			!doesMonthOverlapWindow(
				validPeriod,
				source.activeFrom,
				source.activeUntil,
			)
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				`Period month ${validPeriod} does not overlap income source active window (${source.activeFrom} to ${source.activeUntil ?? "unbounded"})`,
			);
		}

		// 3. Check existing entitlement by source & period
		const [existingEntitlement] = await tx
			.select()
			.from(incomeEntitlements)
			.where(
				and(
					eq(incomeEntitlements.userId, userId),
					eq(incomeEntitlements.sourceId, canonicalSourceId),
					eq(incomeEntitlements.periodMonth, validPeriod),
				),
			)
			.limit(1);

		const canonicalPayload: Record<string, unknown> = {
			incomeSourceId: source.id,
			periodMonth: validPeriod,
			amount: parsedAmount.normalized,
			expectedReceiptOn: normalizedExpectedReceiptOn,
			note: normalizedNote,
		};

		let canonRes: CanonicalTransactionOperationResult;
		try {
			canonRes = await createCanonicalTransactionInTransaction({
				tx,
				userId,
				kind: "INCOME_ENTITLEMENT",
				idempotencyKey: trimmedIdempotencyKey,
				occurredAt,
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
					"Income entitlement replayed with changed parameters",
				);
			}
			throw err;
		}

		if (canonRes.idempotentReplay) {
			// Ensure projection matches
			if (!existingEntitlement) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_INVALID_STATE",
					"Entitlement missing on canonical replay",
				);
			}

			const [latestRev] = await tx
				.select()
				.from(incomeEntitlementRevisions)
				.where(
					eq(
						incomeEntitlementRevisions.canonicalRevisionId,
						canonRes.revisionId,
					),
				)
				.limit(1);

			if (!latestRev) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_INVALID_STATE",
					"Entitlement revision missing on canonical replay",
				);
			}

			const allocatedCents =
				await getActiveEntitlementAllocatedCentsInTransaction(
					tx,
					userId,
					existingEntitlement.id,
				);

			const allocatedAmountStr = formatCentsToMoney(allocatedCents);
			const entCents = parseMoneyString(latestRev.amount).cents;
			const outstandingCents =
				entCents > allocatedCents ? entCents - allocatedCents : 0n;
			const outstandingAmountStr = formatCentsToMoney(outstandingCents);

			const status: EntitlementStatus =
				latestRev.operation === "VOID" ? "VOIDED" : "ACTIVE";
			let settlementStatus: EntitlementSettlementStatus;
			if (status === "VOIDED") {
				settlementStatus = "VOIDED";
			} else if (allocatedCents === 0n) {
				settlementStatus = "OPEN";
			} else if (allocatedCents >= entCents) {
				settlementStatus = "SETTLED";
			} else {
				settlementStatus = "PARTIAL";
			}

			const todayDateStr = getIstanbulCalendarDate(new Date());
			const isOverdue =
				status === "ACTIVE" &&
				outstandingCents > 0n &&
				latestRev.expectedReceiptOn !== null &&
				latestRev.expectedReceiptOn < todayDateStr;

			return {
				idempotentReplay: true,
				incomeEntitlement: {
					entitlementId: existingEntitlement.id,
					sourceId: source.id,
					sourceCode: source.code,
					sourceName: source.name,
					periodMonth: existingEntitlement.periodMonth,
					revisionNo: latestRev.revisionNo,
					status,
					amount: latestRev.amount,
					allocatedAmount: allocatedAmountStr,
					outstandingAmount: outstandingAmountStr,
					settlementStatus,
					expectedReceiptOn: latestRev.expectedReceiptOn,
					overdue: isOverdue,
					note: latestRev.note,
					canonicalTransactionId: existingEntitlement.canonicalTransactionId,
					canonicalRevisionId: latestRev.canonicalRevisionId,
				},
			};
		}

		// Fresh creation: if source is already archived, reject
		if (source.archivedAt !== null) {
			throw new IncomeError(
				"INCOME_SOURCE_ARCHIVED",
				`Cannot create entitlement for archived income source "${source.code}"`,
			);
		}

		// If another entitlement identity already exists for this source & period, reject conflict
		if (existingEntitlement) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_PERIOD_CONFLICT",
				`Entitlement already exists for source "${source.code}" and period "${validPeriod}"`,
			);
		}

		// Insert entitlement identity
		let entitlement: typeof incomeEntitlements.$inferSelect | undefined;
		try {
			const [created] = await tx
				.insert(incomeEntitlements)
				.values({
					userId,
					sourceId: source.id,
					periodMonth: validPeriod,
					canonicalTransactionId: canonRes.transactionId,
				})
				.returning();
			entitlement = created;
		} catch (err: unknown) {
			if (isEntitlementPeriodUniqueViolation(err)) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_PERIOD_CONFLICT",
					`Entitlement already exists for source "${source.code}" and period "${validPeriod}"`,
				);
			}
			throw err;
		}

		if (!entitlement) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_INVALID_STATE",
				"Failed to create income entitlement identity",
			);
		}

		// Insert revision #1
		const [rev] = await tx
			.insert(incomeEntitlementRevisions)
			.values({
				userId,
				entitlementId: entitlement.id,
				canonicalRevisionId: canonRes.revisionId,
				revisionNo: 1,
				previousEntitlementRevisionId: null,
				operation: "CREATE",
				amount: parsedAmount.normalized,
				expectedReceiptOn: normalizedExpectedReceiptOn,
				note: normalizedNote,
			})
			.returning();

		if (!rev) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_INVALID_STATE",
				"Failed to create income entitlement revision",
			);
		}

		const todayDateStr = getIstanbulCalendarDate(new Date());
		const isOverdue =
			rev.expectedReceiptOn !== null && rev.expectedReceiptOn < todayDateStr;

		return {
			idempotentReplay: false,
			incomeEntitlement: {
				entitlementId: entitlement.id,
				sourceId: source.id,
				sourceCode: source.code,
				sourceName: source.name,
				periodMonth: entitlement.periodMonth,
				revisionNo: rev.revisionNo,
				status: "ACTIVE",
				amount: rev.amount,
				allocatedAmount: "0.00",
				outstandingAmount: rev.amount,
				settlementStatus: "OPEN",
				expectedReceiptOn: rev.expectedReceiptOn,
				overdue: isOverdue,
				note: rev.note,
				canonicalTransactionId: entitlement.canonicalTransactionId,
				canonicalRevisionId: rev.canonicalRevisionId,
			},
		};
	});
}

/**
 * Revises an active income entitlement record.
 */
export async function reviseIncomeEntitlement(
	params: ReviseIncomeEntitlementParams,
): Promise<ReviseIncomeEntitlementResult> {
	const {
		db,
		userId,
		entitlementId,
		expectedRevisionNo,
		amount,
		expectedReceiptOn,
		note,
		idempotencyKey,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalEntitlementId = normalizeUuid(entitlementId, "entitlementId");

	let parsedAmount: ParsedMoney;
	try {
		parsedAmount = parseMoneyString(amount);
	} catch (e) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid income entitlement amount: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (parsedAmount.cents <= 0n) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income entitlement amount must be strictly positive",
		);
	}

	let normalizedExpectedReceiptOn: string | null = null;
	if (expectedReceiptOn != null && expectedReceiptOn.trim() !== "") {
		normalizedExpectedReceiptOn = validateIsoCalendarDate(expectedReceiptOn);
	}

	let normalizedNote: string | null = null;
	if (note != null) {
		const trimmedNote = note.trim();
		if (trimmedNote.length > 500) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Entitlement note must not exceed 500 characters",
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
		// 1. Fetch & lock entitlement identity
		const [entitlement] = await tx
			.select()
			.from(incomeEntitlements)
			.where(
				and(
					eq(incomeEntitlements.id, canonicalEntitlementId),
					eq(incomeEntitlements.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!entitlement) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_NOT_FOUND",
				`Income entitlement "${canonicalEntitlementId}" not found`,
			);
		}

		// 2. Fetch source
		const [source] = await tx
			.select()
			.from(incomeSources)
			.where(
				and(
					eq(incomeSources.id, entitlement.sourceId),
					eq(incomeSources.userId, userId),
				),
			)
			.limit(1);

		if (!source) {
			throw new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				"Source associated with entitlement not found",
			);
		}

		// 3. Fetch previous revision
		const [prevRev] = await tx
			.select()
			.from(incomeEntitlementRevisions)
			.where(
				and(
					eq(incomeEntitlementRevisions.entitlementId, entitlement.id),
					eq(incomeEntitlementRevisions.revisionNo, expectedRevisionNo),
				),
			)
			.limit(1);

		if (!prevRev) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} not found for entitlement`,
			);
		}

		if (prevRev.operation === "VOID") {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_ALREADY_VOIDED",
				"Cannot revise an already VOIDED income entitlement",
			);
		}

		// 4. Check active settlement allocations
		const currentAllocatedCents =
			await getActiveEntitlementAllocatedCentsInTransaction(
				tx,
				userId,
				entitlement.id,
			);
		if (parsedAmount.cents < currentAllocatedCents) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_CONFLICT",
				`Cannot decrease entitlement amount to ${parsedAmount.normalized}: current allocated amount is ${formatCentsToMoney(currentAllocatedCents)}`,
			);
		}

		const occurredAt = getIstanbulDateAtMidnightUtc(entitlement.periodMonth);

		const canonicalPayload: Record<string, unknown> = {
			incomeSourceId: source.id,
			periodMonth: entitlement.periodMonth,
			amount: parsedAmount.normalized,
			expectedReceiptOn: normalizedExpectedReceiptOn,
			note: normalizedNote,
		};

		let canonRes: CanonicalTransactionOperationResult;
		try {
			canonRes = await reviseCanonicalTransactionInTransaction({
				tx,
				userId,
				transactionId: entitlement.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey: trimmedIdempotencyKey,
				occurredAt,
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
					"Income entitlement revision replayed with changed parameters",
				);
			}
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_REVISION_CONFLICT"
			) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_REVISION_CONFLICT",
					err.message,
				);
			}
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_ALREADY_VOIDED"
			) {
				throw new IncomeError("INCOME_ENTITLEMENT_ALREADY_VOIDED", err.message);
			}
			throw err;
		}

		if (canonRes.idempotentReplay) {
			const [existingRev] = await tx
				.select()
				.from(incomeEntitlementRevisions)
				.where(
					eq(
						incomeEntitlementRevisions.canonicalRevisionId,
						canonRes.revisionId,
					),
				)
				.limit(1);

			if (!existingRev) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_INVALID_STATE",
					"Entitlement revision missing on replay",
				);
			}

			const allocatedAmountStr = formatCentsToMoney(currentAllocatedCents);
			const entCents = parseMoneyString(existingRev.amount).cents;
			const outstandingCents =
				entCents > currentAllocatedCents
					? entCents - currentAllocatedCents
					: 0n;
			const outstandingAmountStr = formatCentsToMoney(outstandingCents);

			let settlementStatus: EntitlementSettlementStatus;
			if (existingRev.operation === "VOID") {
				settlementStatus = "VOIDED";
			} else if (currentAllocatedCents === 0n) {
				settlementStatus = "OPEN";
			} else if (currentAllocatedCents >= entCents) {
				settlementStatus = "SETTLED";
			} else {
				settlementStatus = "PARTIAL";
			}

			const todayDateStr = getIstanbulCalendarDate(new Date());
			const isOverdue =
				existingRev.operation !== "VOID" &&
				outstandingCents > 0n &&
				existingRev.expectedReceiptOn !== null &&
				existingRev.expectedReceiptOn < todayDateStr;

			return {
				idempotentReplay: true,
				incomeEntitlement: {
					entitlementId: entitlement.id,
					sourceId: source.id,
					sourceCode: source.code,
					sourceName: source.name,
					periodMonth: entitlement.periodMonth,
					revisionNo: existingRev.revisionNo,
					status: existingRev.operation === "VOID" ? "VOIDED" : "ACTIVE",
					amount: existingRev.amount,
					allocatedAmount: allocatedAmountStr,
					outstandingAmount: outstandingAmountStr,
					settlementStatus,
					expectedReceiptOn: existingRev.expectedReceiptOn,
					overdue: isOverdue,
					note: existingRev.note,
					canonicalTransactionId: entitlement.canonicalTransactionId,
					canonicalRevisionId: existingRev.canonicalRevisionId,
				},
			};
		}

		// Append new revision snapshot
		const [newRev] = await tx
			.insert(incomeEntitlementRevisions)
			.values({
				userId,
				entitlementId: entitlement.id,
				canonicalRevisionId: canonRes.revisionId,
				revisionNo: canonRes.revisionNo,
				previousEntitlementRevisionId: prevRev.id,
				operation: "UPDATE",
				amount: parsedAmount.normalized,
				expectedReceiptOn: normalizedExpectedReceiptOn,
				note: normalizedNote,
			})
			.returning();

		if (!newRev) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_INVALID_STATE",
				"Failed to insert revised income entitlement revision",
			);
		}

		const allocatedAmountStr = formatCentsToMoney(currentAllocatedCents);
		const entCents = parsedAmount.cents;
		const outstandingCents =
			entCents > currentAllocatedCents ? entCents - currentAllocatedCents : 0n;
		const outstandingAmountStr = formatCentsToMoney(outstandingCents);

		let settlementStatus: EntitlementSettlementStatus;
		if (currentAllocatedCents === 0n) {
			settlementStatus = "OPEN";
		} else if (currentAllocatedCents >= entCents) {
			settlementStatus = "SETTLED";
		} else {
			settlementStatus = "PARTIAL";
		}

		const todayDateStr = getIstanbulCalendarDate(new Date());
		const isOverdue =
			outstandingCents > 0n &&
			newRev.expectedReceiptOn !== null &&
			newRev.expectedReceiptOn < todayDateStr;

		return {
			idempotentReplay: false,
			incomeEntitlement: {
				entitlementId: entitlement.id,
				sourceId: source.id,
				sourceCode: source.code,
				sourceName: source.name,
				periodMonth: entitlement.periodMonth,
				revisionNo: newRev.revisionNo,
				status: "ACTIVE",
				amount: newRev.amount,
				allocatedAmount: allocatedAmountStr,
				outstandingAmount: outstandingAmountStr,
				settlementStatus,
				expectedReceiptOn: newRev.expectedReceiptOn,
				overdue: isOverdue,
				note: newRev.note,
				canonicalTransactionId: entitlement.canonicalTransactionId,
				canonicalRevisionId: newRev.canonicalRevisionId,
			},
		};
	});
}

/**
 * Voids an income entitlement record.
 */
export async function voidIncomeEntitlement(
	params: VoidIncomeEntitlementParams,
): Promise<VoidIncomeEntitlementResult> {
	const {
		db,
		userId,
		entitlementId,
		expectedRevisionNo,
		idempotencyKey,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalEntitlementId = normalizeUuid(entitlementId, "entitlementId");

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	return await db.transaction(async (tx) => {
		// 1. Fetch & lock entitlement identity
		const [entitlement] = await tx
			.select()
			.from(incomeEntitlements)
			.where(
				and(
					eq(incomeEntitlements.id, canonicalEntitlementId),
					eq(incomeEntitlements.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!entitlement) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_NOT_FOUND",
				`Income entitlement "${canonicalEntitlementId}" not found`,
			);
		}

		// 2. Fetch source
		const [source] = await tx
			.select()
			.from(incomeSources)
			.where(
				and(
					eq(incomeSources.id, entitlement.sourceId),
					eq(incomeSources.userId, userId),
				),
			)
			.limit(1);

		if (!source) {
			throw new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				"Source associated with entitlement not found",
			);
		}

		// 3. Fetch previous revision
		const [prevRev] = await tx
			.select()
			.from(incomeEntitlementRevisions)
			.where(
				and(
					eq(incomeEntitlementRevisions.entitlementId, entitlement.id),
					eq(incomeEntitlementRevisions.revisionNo, expectedRevisionNo),
				),
			)
			.limit(1);

		if (!prevRev) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} not found for entitlement`,
			);
		}

		if (prevRev.operation === "VOID") {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_ALREADY_VOIDED",
				"Cannot void an already VOIDED income entitlement",
			);
		}

		// 4. Check active settlement allocations (must be 0)
		const currentAllocatedCents =
			await getActiveEntitlementAllocatedCentsInTransaction(
				tx,
				userId,
				entitlement.id,
			);
		if (currentAllocatedCents > 0n) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_CONFLICT",
				`Cannot void income entitlement with active settlement allocations (${formatCentsToMoney(currentAllocatedCents)} allocated). Clear allocations first.`,
			);
		}

		let canonRes: CanonicalTransactionOperationResult;
		try {
			canonRes = await voidCanonicalTransactionInTransaction({
				tx,
				userId,
				transactionId: entitlement.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey: trimmedIdempotencyKey,
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
					"Income entitlement void replayed with changed parameters",
				);
			}
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_REVISION_CONFLICT"
			) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_REVISION_CONFLICT",
					err.message,
				);
			}
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_ALREADY_VOIDED"
			) {
				throw new IncomeError("INCOME_ENTITLEMENT_ALREADY_VOIDED", err.message);
			}
			throw err;
		}

		if (canonRes.idempotentReplay) {
			const [existingRev] = await tx
				.select()
				.from(incomeEntitlementRevisions)
				.where(
					eq(
						incomeEntitlementRevisions.canonicalRevisionId,
						canonRes.revisionId,
					),
				)
				.limit(1);

			if (!existingRev) {
				throw new IncomeError(
					"INCOME_ENTITLEMENT_INVALID_STATE",
					"Entitlement VOID revision missing on replay",
				);
			}

			return {
				idempotentReplay: true,
				incomeEntitlement: {
					entitlementId: entitlement.id,
					sourceId: source.id,
					sourceCode: source.code,
					sourceName: source.name,
					periodMonth: entitlement.periodMonth,
					revisionNo: existingRev.revisionNo,
					status: "VOIDED",
					amount: existingRev.amount,
					allocatedAmount: "0.00",
					outstandingAmount: "0.00",
					settlementStatus: "VOIDED",
					expectedReceiptOn: existingRev.expectedReceiptOn,
					overdue: false,
					note: existingRev.note,
					canonicalTransactionId: entitlement.canonicalTransactionId,
					canonicalRevisionId: existingRev.canonicalRevisionId,
				},
			};
		}

		// Insert VOID revision (retaining previous snapshot fields)
		const [voidRev] = await tx
			.insert(incomeEntitlementRevisions)
			.values({
				userId,
				entitlementId: entitlement.id,
				canonicalRevisionId: canonRes.revisionId,
				revisionNo: canonRes.revisionNo,
				previousEntitlementRevisionId: prevRev.id,
				operation: "VOID",
				amount: prevRev.amount,
				expectedReceiptOn: prevRev.expectedReceiptOn,
				note: prevRev.note,
			})
			.returning();

		if (!voidRev) {
			throw new IncomeError(
				"INCOME_ENTITLEMENT_INVALID_STATE",
				"Failed to insert VOID income entitlement revision",
			);
		}

		return {
			idempotentReplay: false,
			incomeEntitlement: {
				entitlementId: entitlement.id,
				sourceId: source.id,
				sourceCode: source.code,
				sourceName: source.name,
				periodMonth: entitlement.periodMonth,
				revisionNo: voidRev.revisionNo,
				status: "VOIDED",
				amount: voidRev.amount,
				allocatedAmount: "0.00",
				outstandingAmount: "0.00",
				settlementStatus: "VOIDED",
				expectedReceiptOn: voidRev.expectedReceiptOn,
				overdue: false,
				note: voidRev.note,
				canonicalTransactionId: entitlement.canonicalTransactionId,
				canonicalRevisionId: voidRev.canonicalRevisionId,
			},
		};
	});
}

/**
 * Retrieves a single income entitlement with current allocation calculations.
 */
export async function getIncomeEntitlement(
	params: GetIncomeEntitlementParams,
): Promise<IncomeEntitlementItem> {
	const { db, userId, entitlementId, asOf } = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const canonicalEntitlementId = normalizeUuid(entitlementId, "entitlementId");

	const [entitlement] = await db
		.select({
			id: incomeEntitlements.id,
			sourceId: incomeEntitlements.sourceId,
			sourceCode: incomeSources.code,
			sourceName: incomeSources.name,
			periodMonth: incomeEntitlements.periodMonth,
			canonicalTransactionId: incomeEntitlements.canonicalTransactionId,
		})
		.from(incomeEntitlements)
		.innerJoin(incomeSources, eq(incomeEntitlements.sourceId, incomeSources.id))
		.where(
			and(
				eq(incomeEntitlements.id, canonicalEntitlementId),
				eq(incomeEntitlements.userId, userId),
			),
		)
		.limit(1);

	if (!entitlement) {
		throw new IncomeError(
			"INCOME_ENTITLEMENT_NOT_FOUND",
			`Income entitlement "${canonicalEntitlementId}" not found`,
		);
	}

	const [latestRev] = await db
		.select()
		.from(incomeEntitlementRevisions)
		.where(
			and(
				eq(incomeEntitlementRevisions.entitlementId, entitlement.id),
				eq(incomeEntitlementRevisions.userId, userId),
			),
		)
		.orderBy(desc(incomeEntitlementRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new IncomeError(
			"INCOME_ENTITLEMENT_INVALID_STATE",
			"Entitlement revision missing",
		);
	}

	// Fetch current allocation across all active settlement batches
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

	let allocatedCents = 0n;
	for (const allocs of latestBatches.values()) {
		for (const alloc of allocs) {
			if (alloc?.entitlementId === entitlement.id && alloc?.amount) {
				allocatedCents += parseMoneyString(alloc.amount).cents;
			}
		}
	}

	const isVoid = latestRev.operation === "VOID";
	const allocatedAmountStr = isVoid
		? "0.00"
		: formatCentsToMoney(allocatedCents);
	const entCents = parseMoneyString(latestRev.amount).cents;
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

	let asOfStr: string;
	if (typeof asOf === "string") {
		asOfStr = validateIsoCalendarDate(asOf);
	} else if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) {
		asOfStr = getIstanbulCalendarDate(asOf);
	} else {
		asOfStr = getIstanbulCalendarDate(new Date());
	}

	const isOverdue =
		!isVoid &&
		outstandingCents > 0n &&
		latestRev.expectedReceiptOn !== null &&
		latestRev.expectedReceiptOn < asOfStr;

	return {
		entitlementId: entitlement.id,
		sourceId: entitlement.sourceId,
		sourceCode: entitlement.sourceCode,
		sourceName: entitlement.sourceName,
		periodMonth: entitlement.periodMonth,
		revisionNo: latestRev.revisionNo,
		status: isVoid ? "VOIDED" : "ACTIVE",
		amount: latestRev.amount,
		allocatedAmount: allocatedAmountStr,
		outstandingAmount: outstandingAmountStr,
		settlementStatus,
		expectedReceiptOn: latestRev.expectedReceiptOn,
		overdue: isOverdue,
		note: latestRev.note,
		canonicalTransactionId: entitlement.canonicalTransactionId,
		canonicalRevisionId: latestRev.canonicalRevisionId,
	};
}

/**
 * Lists income entitlements with bounded queries (no N+1).
 */
export async function listIncomeEntitlements(
	params: ListIncomeEntitlementsParams,
): Promise<IncomeEntitlementItem[]> {
	const { db, userId, sourceId, periodMonthFrom, periodMonthUntil, asOf } =
		params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

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

	// 1. Fetch entitlements
	const allEntitlements = await db
		.select({
			id: incomeEntitlements.id,
			sourceId: incomeEntitlements.sourceId,
			sourceCode: incomeSources.code,
			sourceName: incomeSources.name,
			periodMonth: incomeEntitlements.periodMonth,
			canonicalTransactionId: incomeEntitlements.canonicalTransactionId,
		})
		.from(incomeEntitlements)
		.innerJoin(incomeSources, eq(incomeEntitlements.sourceId, incomeSources.id))
		.where(and(...conditions))
		.orderBy(desc(incomeEntitlements.periodMonth), incomeSources.code);

	if (allEntitlements.length === 0) {
		return [];
	}

	const entitlementIds = allEntitlements.map((e) => e.id);

	// 2. Fetch latest revision per entitlement in single query
	const allRevs = await db
		.select({
			id: incomeEntitlementRevisions.id,
			entitlementId: incomeEntitlementRevisions.entitlementId,
			canonicalRevisionId: incomeEntitlementRevisions.canonicalRevisionId,
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

	// 3. Fetch latest settlement revisions across all batches for user in single query
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
	if (typeof asOf === "string") {
		asOfStr = validateIsoCalendarDate(asOf);
	} else if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) {
		asOfStr = getIstanbulCalendarDate(asOf);
	} else {
		asOfStr = getIstanbulCalendarDate(new Date());
	}

	const result: IncomeEntitlementItem[] = [];

	for (const ent of allEntitlements) {
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

		result.push({
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
			canonicalTransactionId: ent.canonicalTransactionId,
			canonicalRevisionId: rev.canonicalRevisionId,
		});
	}

	return result;
}
