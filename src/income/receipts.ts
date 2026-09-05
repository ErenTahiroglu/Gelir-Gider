import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../db/schema/income";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	formatCentsToMoney,
	type ParsedMoney,
	parseMoneyString,
} from "../ledger/money";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	type BoundCanonicalTransactionResult,
	createCanonicalTransactionWithLedgerInTransaction,
	reviseCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import type { TransactionSourceInput } from "../transactions/service";
import { getIstanbulCalendarDate } from "./calendar";
import { IncomeError } from "./errors";
import {
	getActiveReceiptAllocatedCentsInTransaction,
	lockIncomeReceiptForSettlementStateInTransaction,
} from "./settlement-state";

export interface IncomeReceiptItem {
	incomeReceiptId: string;
	sourceId: string;
	sourceCode: string;
	sourceName: string;
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	receivedAt: Date;
	amount: string;
	destinationAccountId: string;
	note: string | null;
	canonicalTransactionId: string;
	canonicalRevisionId: string;
}

export interface CreateIncomeReceiptParams {
	db: Database;
	userId: string;
	sourceId: string;
	idempotencyKey: string;
	receivedAt: Date;
	amount: string;
	destinationAccountId: string;
	note?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface CreateIncomeReceiptInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	sourceId: string;
	idempotencyKey: string;
	receivedAt: Date;
	amount: string;
	destinationAccountId: string;
	note?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface ReviseIncomeReceiptParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	receivedAt: Date;
	amount: string;
	destinationAccountId: string;
	note?: string | null | undefined;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface VoidIncomeReceiptParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface VoidIncomeReceiptInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	incomeReceiptId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	provenance: TransactionSourceInput;
}

export interface GetIncomeReceiptParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
}

export interface ListIncomeReceiptsParams {
	db: Database;
	userId: string;
	sourceId?: string | undefined;
	fromDate?: Date | undefined;
	toDate?: Date | undefined;
	includeVoided?: boolean | undefined;
}

/**
 * Internal transaction-scoped helper for creating an actual cash income receipt with canonical
 * revision, double-entry ledger posting, and domain projection. DOES NOT call db.transaction().
 * Callers that need the receipt created atomically alongside other domain effects (e.g. Phase 11
 * People overpayment income) should use this within their own outer transaction.
 */
export async function createIncomeReceiptInTransaction(
	params: CreateIncomeReceiptInTransactionParams,
): Promise<{
	incomeReceipt: IncomeReceiptItem;
	idempotentReplay: boolean;
}> {
	const {
		tx,
		userId,
		sourceId,
		idempotencyKey,
		receivedAt,
		amount,
		destinationAccountId,
		note,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const trimmedSourceId = sourceId?.trim();
	if (!trimmedSourceId) {
		throw new IncomeError("INCOME_INVALID_INPUT", "Source ID is required");
	}

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Valid receivedAt date is required",
		);
	}

	let parsedAmount: ParsedMoney;
	try {
		parsedAmount = parseMoneyString(amount);
	} catch (e) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid income receipt amount: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (parsedAmount.cents <= 0n) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income receipt amount must be strictly positive",
		);
	}

	const trimmedDestinationId = destinationAccountId?.trim();
	if (!trimmedDestinationId) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"destinationAccountId is required",
		);
	}

	let normalizedNote: string | null = null;
	if (note != null) {
		const trimmedNote = note.trim();
		if (trimmedNote.length > 500) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Receipt note must not exceed 500 characters",
			);
		}
		normalizedNote = trimmedNote.length > 0 ? trimmedNote : null;
	}

	{
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
					eq(incomeSources.id, trimmedSourceId),
					eq(incomeSources.userId, userId),
				),
			)
			.limit(1);

		if (!source) {
			throw new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				`Income source "${trimmedSourceId}" not found for this user`,
			);
		}

		// Check active window in Europe/Istanbul
		const receivedDay = getIstanbulCalendarDate(receivedAt);
		if (
			receivedDay < source.activeFrom ||
			(source.activeUntil !== null && receivedDay > source.activeUntil)
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				`Received date ${receivedDay} is outside income source active window (${source.activeFrom} to ${source.activeUntil ?? "unbounded"})`,
			);
		}

		// 3. Fetch and validate destination ledger account (immutable attributes)
		const [destAccount] = await tx
			.select()
			.from(ledgerAccounts)
			.where(
				and(
					eq(ledgerAccounts.id, trimmedDestinationId),
					eq(ledgerAccounts.userId, userId),
				),
			)
			.limit(1);

		if (!destAccount) {
			throw new IncomeError(
				"INCOME_DESTINATION_ACCOUNT_INVALID",
				`Destination account "${trimmedDestinationId}" not found for this user`,
			);
		}

		if (
			destAccount.accountType !== "ASSET" ||
			destAccount.normalBalance !== "DEBIT"
		) {
			throw new IncomeError(
				"INCOME_DESTINATION_ACCOUNT_INVALID",
				`Destination account must have accountType='ASSET' and normalBalance='DEBIT', found accountType='${destAccount.accountType}', normalBalance='${destAccount.normalBalance}'`,
			);
		}

		if (destAccount.currency !== user.currency) {
			throw new IncomeError(
				"INCOME_DESTINATION_ACCOUNT_INVALID",
				`Destination account currency '${destAccount.currency}' does not match user currency '${user.currency}'`,
			);
		}

		// Note: We do NOT reject destAccount.archivedAt !== null here so historical replays succeed.
		// Fresh postings to an archived destination will be rejected by postJournalEntryInTransaction.

		// 4. Construct canonical payload and bound ledger lines
		const canonicalPayload: Record<string, unknown> = {
			incomeSourceId: source.id,
			amount: parsedAmount.normalized,
			destinationAccountId: destAccount.id,
			note: normalizedNote,
		};

		const ledgerLines = [
			{
				accountId: destAccount.id,
				side: "DEBIT" as const,
				amount: parsedAmount.normalized,
			},
			{
				accountId: source.incomeLedgerAccountId,
				side: "CREDIT" as const,
				amount: parsedAmount.normalized,
			},
		];

		let boundRes: BoundCanonicalTransactionResult;
		try {
			boundRes = await createCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				kind: "INCOME_RECEIPT",
				idempotencyKey: trimmedIdempotencyKey,
				occurredAt: receivedAt,
				payload: canonicalPayload,
				source: provenance,
				ledger: {
					memo: source.name,
					lines: ledgerLines,
				},
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				(err.code === "TRANSACTION_IDEMPOTENCY_CONFLICT" ||
					err.code === "TRANSACTION_LEDGER_EFFECT_CONFLICT")
			) {
				throw new IncomeError(
					"INCOME_IDEMPOTENCY_CONFLICT",
					"Income receipt replayed with changed parameters",
				);
			}
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_LEDGER_EFFECT_INVALID"
			) {
				throw new IncomeError(
					"INCOME_DESTINATION_ACCOUNT_INVALID",
					err.message,
				);
			}
			throw err;
		}

		// 5. Handle Idempotent Replay
		if (boundRes.idempotentReplay) {
			const [existingReceipt] = await tx
				.select()
				.from(incomeReceipts)
				.where(
					eq(incomeReceipts.canonicalTransactionId, boundRes.transactionId),
				)
				.limit(1);

			if (!existingReceipt) {
				throw new IncomeError(
					"INCOME_RECEIPT_INVALID_STATE",
					"Canonical transaction exists but income receipt identity is missing",
				);
			}

			const [existingRev] = await tx
				.select()
				.from(incomeReceiptRevisions)
				.where(
					eq(incomeReceiptRevisions.canonicalRevisionId, boundRes.revisionId),
				)
				.limit(1);

			if (!existingRev) {
				throw new IncomeError(
					"INCOME_RECEIPT_INVALID_STATE",
					"Income receipt revision #1 missing on replay",
				);
			}

			// Validate exact properties
			if (
				existingReceipt.sourceId !== source.id ||
				existingRev.amount !== parsedAmount.normalized ||
				existingRev.destinationAccountId !== destAccount.id ||
				(existingRev.note ?? null) !== normalizedNote
			) {
				throw new IncomeError(
					"INCOME_IDEMPOTENCY_CONFLICT",
					"Income receipt replayed with conflicting domain payload",
				);
			}

			return {
				incomeReceipt: {
					incomeReceiptId: existingReceipt.id,
					sourceId: source.id,
					sourceCode: source.code,
					sourceName: source.name,
					status: existingRev.operation === "VOID" ? "VOIDED" : "ACTIVE",
					revisionNo: existingRev.revisionNo,
					receivedAt: existingRev.occurredAt,
					amount: existingRev.amount,
					destinationAccountId: existingRev.destinationAccountId,
					note: existingRev.note,
					canonicalTransactionId: boundRes.transactionId,
					canonicalRevisionId: boundRes.revisionId,
				},
				idempotentReplay: true,
			};
		}

		// Check archived source on fresh creation
		if (source.archivedAt !== null) {
			throw new IncomeError(
				"INCOME_SOURCE_ARCHIVED",
				`Cannot create income receipt on archived source "${source.code}"`,
			);
		}

		// 6. Fresh Creation: Insert identity and revision #1 projection
		const [insertedReceipt] = await tx
			.insert(incomeReceipts)
			.values({
				userId,
				sourceId: source.id,
				canonicalTransactionId: boundRes.transactionId,
			})
			.returning();

		if (!insertedReceipt) {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				"Failed to insert income receipt record",
			);
		}

		const [insertedRev] = await tx
			.insert(incomeReceiptRevisions)
			.values({
				userId,
				incomeReceiptId: insertedReceipt.id,
				canonicalRevisionId: boundRes.revisionId,
				revisionNo: 1,
				previousReceiptRevisionId: null,
				operation: "CREATE",
				occurredAt: receivedAt,
				amount: parsedAmount.normalized,
				destinationAccountId: destAccount.id,
				note: normalizedNote,
			})
			.returning();

		if (!insertedRev) {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				"Failed to insert income receipt revision record",
			);
		}

		return {
			incomeReceipt: {
				incomeReceiptId: insertedReceipt.id,
				sourceId: source.id,
				sourceCode: source.code,
				sourceName: source.name,
				status: "ACTIVE",
				revisionNo: insertedRev.revisionNo,
				receivedAt: insertedRev.occurredAt,
				amount: insertedRev.amount,
				destinationAccountId: insertedRev.destinationAccountId,
				note: insertedRev.note,
				canonicalTransactionId: boundRes.transactionId,
				canonicalRevisionId: boundRes.revisionId,
			},
			idempotentReplay: false,
		};
	}
}

/**
 * Creates an actual cash income receipt with canonical revision, double-entry ledger posting, and domain projection in ONE transaction.
 */
export async function createIncomeReceipt(
	params: CreateIncomeReceiptParams,
): Promise<{
	incomeReceipt: IncomeReceiptItem;
	idempotentReplay: boolean;
}> {
	const { db, ...rest } = params;
	return await db.transaction(async (tx) => {
		return await createIncomeReceiptInTransaction({ tx, ...rest });
	});
}

/**
 * Revises an existing income receipt: reverses previous ledger entry, posts new corrected entry, and records domain revision.
 */
export async function reviseIncomeReceipt(
	params: ReviseIncomeReceiptParams,
): Promise<{
	incomeReceipt: IncomeReceiptItem;
	idempotentReplay: boolean;
}> {
	const {
		db,
		userId,
		incomeReceiptId,
		expectedRevisionNo,
		idempotencyKey,
		receivedAt,
		amount,
		destinationAccountId,
		note,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const trimmedReceiptId = incomeReceiptId?.trim();
	if (!trimmedReceiptId) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income receipt ID is required",
		);
	}

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Valid receivedAt date is required",
		);
	}

	let parsedAmount: ParsedMoney;
	try {
		parsedAmount = parseMoneyString(amount);
	} catch (e) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			`Invalid income receipt amount: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (parsedAmount.cents <= 0n) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income receipt amount must be strictly positive",
		);
	}

	const trimmedDestinationId = destinationAccountId?.trim();
	if (!trimmedDestinationId) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"destinationAccountId is required",
		);
	}

	let normalizedNote: string | null = null;
	if (note != null) {
		const trimmedNote = note.trim();
		if (trimmedNote.length > 500) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				"Receipt note must not exceed 500 characters",
			);
		}
		normalizedNote = trimmedNote.length > 0 ? trimmedNote : null;
	}

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

		// 2. Fetch and lock income receipt
		const receipt = await lockIncomeReceiptForSettlementStateInTransaction(
			tx,
			userId,
			trimmedReceiptId,
		);

		// 3. Fetch income source
		const [source] = await tx
			.select()
			.from(incomeSources)
			.where(
				and(
					eq(incomeSources.id, receipt.sourceId),
					eq(incomeSources.userId, userId),
				),
			)
			.limit(1);

		if (!source) {
			throw new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				"Income source associated with receipt not found",
			);
		}

		// Check active window in Europe/Istanbul
		const receivedDay = getIstanbulCalendarDate(receivedAt);
		if (
			receivedDay < source.activeFrom ||
			(source.activeUntil !== null && receivedDay > source.activeUntil)
		) {
			throw new IncomeError(
				"INCOME_INVALID_INPUT",
				`Received date ${receivedDay} is outside income source active window (${source.activeFrom} to ${source.activeUntil ?? "unbounded"})`,
			);
		}

		// 4. Fetch destination account (immutable attributes)
		const [destAccount] = await tx
			.select()
			.from(ledgerAccounts)
			.where(
				and(
					eq(ledgerAccounts.id, trimmedDestinationId),
					eq(ledgerAccounts.userId, userId),
				),
			)
			.limit(1);

		if (!destAccount) {
			throw new IncomeError(
				"INCOME_DESTINATION_ACCOUNT_INVALID",
				`Destination account "${trimmedDestinationId}" not found for this user`,
			);
		}

		if (
			destAccount.accountType !== "ASSET" ||
			destAccount.normalBalance !== "DEBIT"
		) {
			throw new IncomeError(
				"INCOME_DESTINATION_ACCOUNT_INVALID",
				`Destination account must have accountType='ASSET' and normalBalance='DEBIT'`,
			);
		}

		if (destAccount.currency !== user.currency) {
			throw new IncomeError(
				"INCOME_DESTINATION_ACCOUNT_INVALID",
				`Destination account currency '${destAccount.currency}' does not match user currency '${user.currency}'`,
			);
		}

		// Note: We do NOT reject destAccount.archivedAt !== null here so historical replays succeed.
		// Fresh postings to an archived destination will be rejected by postJournalEntryInTransaction.

		// 5. Fetch previous projection revision
		const [prevRev] = await tx
			.select()
			.from(incomeReceiptRevisions)
			.where(
				and(
					eq(incomeReceiptRevisions.incomeReceiptId, receipt.id),
					eq(incomeReceiptRevisions.revisionNo, expectedRevisionNo),
				),
			)
			.limit(1);

		if (!prevRev) {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				`Expected revision ${expectedRevisionNo} not found for income receipt`,
			);
		}

		// Phase 6B: Check that new receipt amount is not less than active settlement allocations
		const currentAllocatedCents =
			await getActiveReceiptAllocatedCentsInTransaction(tx, userId, receipt.id);
		if (parsedAmount.cents < currentAllocatedCents) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_CONFLICT",
				`Cannot revise income receipt amount to ${parsedAmount.normalized}: current allocated amount is ${formatCentsToMoney(currentAllocatedCents)}`,
			);
		}

		const canonicalPayload: Record<string, unknown> = {
			incomeSourceId: source.id,
			amount: parsedAmount.normalized,
			destinationAccountId: destAccount.id,
			note: normalizedNote,
		};

		const ledgerLines = [
			{
				accountId: destAccount.id,
				side: "DEBIT" as const,
				amount: parsedAmount.normalized,
			},
			{
				accountId: source.incomeLedgerAccountId,
				side: "CREDIT" as const,
				amount: parsedAmount.normalized,
			},
		];

		let boundRes: BoundCanonicalTransactionResult;
		try {
			boundRes = await reviseCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				transactionId: receipt.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey: trimmedIdempotencyKey,
				occurredAt: receivedAt,
				payload: canonicalPayload,
				reasonCode,
				reasonNote,
				source: provenance,
				ledger: {
					memo: source.name,
					lines: ledgerLines,
				},
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				(err.code === "TRANSACTION_IDEMPOTENCY_CONFLICT" ||
					err.code === "TRANSACTION_LEDGER_EFFECT_CONFLICT")
			) {
				throw new IncomeError(
					"INCOME_IDEMPOTENCY_CONFLICT",
					"Income receipt revision replayed with changed parameters",
				);
			}
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_LEDGER_EFFECT_INVALID"
			) {
				throw new IncomeError(
					"INCOME_DESTINATION_ACCOUNT_INVALID",
					err.message,
				);
			}
			throw err;
		}

		if (boundRes.idempotentReplay) {
			const [existingRev] = await tx
				.select()
				.from(incomeReceiptRevisions)
				.where(
					eq(incomeReceiptRevisions.canonicalRevisionId, boundRes.revisionId),
				)
				.limit(1);

			if (!existingRev) {
				throw new IncomeError(
					"INCOME_RECEIPT_INVALID_STATE",
					"Income receipt revision missing on replay",
				);
			}

			return {
				incomeReceipt: {
					incomeReceiptId: receipt.id,
					sourceId: source.id,
					sourceCode: source.code,
					sourceName: source.name,
					status: existingRev.operation === "VOID" ? "VOIDED" : "ACTIVE",
					revisionNo: existingRev.revisionNo,
					receivedAt: existingRev.occurredAt,
					amount: existingRev.amount,
					destinationAccountId: existingRev.destinationAccountId,
					note: existingRev.note,
					canonicalTransactionId: boundRes.transactionId,
					canonicalRevisionId: boundRes.revisionId,
				},
				idempotentReplay: true,
			};
		}

		// Insert domain projection revision
		const [insertedRev] = await tx
			.insert(incomeReceiptRevisions)
			.values({
				userId,
				incomeReceiptId: receipt.id,
				canonicalRevisionId: boundRes.revisionId,
				revisionNo: boundRes.revisionNo,
				previousReceiptRevisionId: prevRev.id,
				operation: "UPDATE",
				occurredAt: receivedAt,
				amount: parsedAmount.normalized,
				destinationAccountId: destAccount.id,
				note: normalizedNote,
			})
			.returning();

		if (!insertedRev) {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				"Failed to insert income receipt revision record on revise",
			);
		}

		return {
			incomeReceipt: {
				incomeReceiptId: receipt.id,
				sourceId: source.id,
				sourceCode: source.code,
				sourceName: source.name,
				status: "ACTIVE",
				revisionNo: insertedRev.revisionNo,
				receivedAt: insertedRev.occurredAt,
				amount: insertedRev.amount,
				destinationAccountId: insertedRev.destinationAccountId,
				note: insertedRev.note,
				canonicalTransactionId: boundRes.transactionId,
				canonicalRevisionId: boundRes.revisionId,
			},
			idempotentReplay: false,
		};
	});
}

/**
 * Internal transaction-scoped helper for voiding an income receipt: reverses active ledger entry
 * and marks voided. DOES NOT call db.transaction(). Callers that need the void to happen atomically
 * alongside other domain effects (e.g. Phase 11 People overpayment settlement void) should use this
 * within their own outer transaction.
 */
export async function voidIncomeReceiptInTransaction(
	params: VoidIncomeReceiptInTransactionParams,
): Promise<{
	incomeReceipt: IncomeReceiptItem;
	idempotentReplay: boolean;
}> {
	const {
		tx,
		userId,
		incomeReceiptId,
		expectedRevisionNo,
		idempotencyKey,
		reasonCode,
		reasonNote,
		provenance,
	} = params;

	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const trimmedReceiptId = incomeReceiptId?.trim();
	if (!trimmedReceiptId) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income receipt ID is required",
		);
	}

	const trimmedIdempotencyKey = idempotencyKey?.trim();
	if (!trimmedIdempotencyKey) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Idempotency key is required",
		);
	}

	{
		// 1. Fetch and lock receipt
		const receipt = await lockIncomeReceiptForSettlementStateInTransaction(
			tx,
			userId,
			trimmedReceiptId,
		);

		// 2. Fetch source
		const [source] = await tx
			.select()
			.from(incomeSources)
			.where(
				and(
					eq(incomeSources.id, receipt.sourceId),
					eq(incomeSources.userId, userId),
				),
			)
			.limit(1);

		if (!source) {
			throw new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				"Income source associated with receipt not found",
			);
		}

		// 3. Fetch previous revision
		const [prevRev] = await tx
			.select()
			.from(incomeReceiptRevisions)
			.where(
				and(
					eq(incomeReceiptRevisions.incomeReceiptId, receipt.id),
					eq(incomeReceiptRevisions.revisionNo, expectedRevisionNo),
				),
			)
			.limit(1);

		if (!prevRev) {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				`Expected revision ${expectedRevisionNo} not found for income receipt`,
			);
		}

		// Phase 6B: Check that receipt does not have active settlement allocations
		const currentAllocatedCents =
			await getActiveReceiptAllocatedCentsInTransaction(tx, userId, receipt.id);
		if (currentAllocatedCents > 0n) {
			throw new IncomeError(
				"INCOME_SETTLEMENT_CONFLICT",
				`Cannot void income receipt with active settlement allocations (${formatCentsToMoney(currentAllocatedCents)} allocated). Clear allocations first.`,
			);
		}

		let boundRes: BoundCanonicalTransactionResult;
		try {
			boundRes = await voidCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				transactionId: receipt.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey: trimmedIdempotencyKey,
				reasonCode,
				reasonNote,
				source: provenance,
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				(err.code === "TRANSACTION_IDEMPOTENCY_CONFLICT" ||
					err.code === "TRANSACTION_LEDGER_EFFECT_CONFLICT")
			) {
				throw new IncomeError(
					"INCOME_IDEMPOTENCY_CONFLICT",
					"Income receipt void replayed with conflict",
				);
			}
			throw err;
		}

		if (boundRes.idempotentReplay) {
			const [existingRev] = await tx
				.select()
				.from(incomeReceiptRevisions)
				.where(
					eq(incomeReceiptRevisions.canonicalRevisionId, boundRes.revisionId),
				)
				.limit(1);

			if (!existingRev) {
				throw new IncomeError(
					"INCOME_RECEIPT_INVALID_STATE",
					"Income receipt VOID revision missing on replay",
				);
			}

			return {
				incomeReceipt: {
					incomeReceiptId: receipt.id,
					sourceId: source.id,
					sourceCode: source.code,
					sourceName: source.name,
					status: "VOIDED",
					revisionNo: existingRev.revisionNo,
					receivedAt: existingRev.occurredAt,
					amount: existingRev.amount,
					destinationAccountId: existingRev.destinationAccountId,
					note: existingRev.note,
					canonicalTransactionId: boundRes.transactionId,
					canonicalRevisionId: boundRes.revisionId,
				},
				idempotentReplay: true,
			};
		}

		// Insert VOID domain revision copying previous snapshot
		const [insertedRev] = await tx
			.insert(incomeReceiptRevisions)
			.values({
				userId,
				incomeReceiptId: receipt.id,
				canonicalRevisionId: boundRes.revisionId,
				revisionNo: boundRes.revisionNo,
				previousReceiptRevisionId: prevRev.id,
				operation: "VOID",
				occurredAt: prevRev.occurredAt,
				amount: prevRev.amount,
				destinationAccountId: prevRev.destinationAccountId,
				note: prevRev.note,
			})
			.returning();

		if (!insertedRev) {
			throw new IncomeError(
				"INCOME_RECEIPT_INVALID_STATE",
				"Failed to insert income receipt revision record on void",
			);
		}

		return {
			incomeReceipt: {
				incomeReceiptId: receipt.id,
				sourceId: source.id,
				sourceCode: source.code,
				sourceName: source.name,
				status: "VOIDED",
				revisionNo: insertedRev.revisionNo,
				receivedAt: insertedRev.occurredAt,
				amount: insertedRev.amount,
				destinationAccountId: insertedRev.destinationAccountId,
				note: insertedRev.note,
				canonicalTransactionId: boundRes.transactionId,
				canonicalRevisionId: boundRes.revisionId,
			},
			idempotentReplay: false,
		};
	}
}

/**
 * Voids an income receipt: reverses active ledger entry and marks voided in ONE transaction.
 */
export async function voidIncomeReceipt(
	params: VoidIncomeReceiptParams,
): Promise<{
	incomeReceipt: IncomeReceiptItem;
	idempotentReplay: boolean;
}> {
	const { db, ...rest } = params;
	return await db.transaction(async (tx) => {
		return await voidIncomeReceiptInTransaction({ tx, ...rest });
	});
}

/**
 * Gets a single income receipt with its latest revision snapshot.
 */
export async function getIncomeReceipt({
	db,
	userId,
	incomeReceiptId,
}: GetIncomeReceiptParams): Promise<IncomeReceiptItem> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const trimmedReceiptId = incomeReceiptId?.trim();
	if (!trimmedReceiptId) {
		throw new IncomeError(
			"INCOME_INVALID_INPUT",
			"Income receipt ID is required",
		);
	}

	const [receipt] = await db
		.select()
		.from(incomeReceipts)
		.where(
			and(
				eq(incomeReceipts.id, trimmedReceiptId),
				eq(incomeReceipts.userId, userId),
			),
		)
		.limit(1);

	if (!receipt) {
		throw new IncomeError(
			"INCOME_RECEIPT_NOT_FOUND",
			`Income receipt "${trimmedReceiptId}" not found`,
		);
	}

	const [source] = await db
		.select({
			code: incomeSources.code,
			name: incomeSources.name,
		})
		.from(incomeSources)
		.where(eq(incomeSources.id, receipt.sourceId))
		.limit(1);

	const [latestRev] = await db
		.select()
		.from(incomeReceiptRevisions)
		.where(eq(incomeReceiptRevisions.incomeReceiptId, receipt.id))
		.orderBy(desc(incomeReceiptRevisions.revisionNo))
		.limit(1);

	if (!latestRev || !source) {
		throw new IncomeError(
			"INCOME_RECEIPT_INVALID_STATE",
			"Income receipt has no revision or source",
		);
	}

	return {
		incomeReceiptId: receipt.id,
		sourceId: receipt.sourceId,
		sourceCode: source.code,
		sourceName: source.name,
		status: latestRev.operation === "VOID" ? "VOIDED" : "ACTIVE",
		revisionNo: latestRev.revisionNo,
		receivedAt: latestRev.occurredAt,
		amount: latestRev.amount,
		destinationAccountId: latestRev.destinationAccountId,
		note: latestRev.note,
		canonicalTransactionId: receipt.canonicalTransactionId,
		canonicalRevisionId: latestRev.canonicalRevisionId,
	};
}

/**
 * Lists income receipts for a user with optional filtering.
 */
export async function listIncomeReceipts({
	db,
	userId,
	sourceId,
	fromDate,
	toDate,
	includeVoided = false,
}: ListIncomeReceiptsParams): Promise<IncomeReceiptItem[]> {
	if (!userId || userId.trim() === "") {
		throw new IncomeError("INCOME_INVALID_INPUT", "User ID is required");
	}

	const conditions = [eq(incomeReceipts.userId, userId)];
	if (sourceId) {
		conditions.push(eq(incomeReceipts.sourceId, sourceId));
	}

	// Fetch all matching receipts and join with source
	const rows = await db
		.select({
			receipt: incomeReceipts,
			source: {
				code: incomeSources.code,
				name: incomeSources.name,
			},
		})
		.from(incomeReceipts)
		.innerJoin(incomeSources, eq(incomeReceipts.sourceId, incomeSources.id))
		.where(and(...conditions));

	if (rows.length === 0) return [];

	const receiptIds = rows.map((r) => r.receipt.id);

	// Fetch all revisions for matching receipts
	const revRows = await db
		.select()
		.from(incomeReceiptRevisions)
		.where(
			and(
				eq(incomeReceiptRevisions.userId, userId),
				// inArray handled
			),
		)
		.orderBy(desc(incomeReceiptRevisions.revisionNo));

	// Group latest revision per receipt
	const latestRevMap = new Map<
		string,
		typeof incomeReceiptRevisions.$inferSelect
	>();
	for (const rev of revRows) {
		if (receiptIds.includes(rev.incomeReceiptId)) {
			if (!latestRevMap.has(rev.incomeReceiptId)) {
				latestRevMap.set(rev.incomeReceiptId, rev);
			}
		}
	}

	const items: IncomeReceiptItem[] = [];
	for (const row of rows) {
		const latestRev = latestRevMap.get(row.receipt.id);
		if (!latestRev) continue;

		if (!includeVoided && latestRev.operation === "VOID") {
			continue;
		}

		if (fromDate && latestRev.occurredAt < fromDate) {
			continue;
		}

		if (toDate && latestRev.occurredAt > toDate) {
			continue;
		}

		items.push({
			incomeReceiptId: row.receipt.id,
			sourceId: row.receipt.sourceId,
			sourceCode: row.source.code,
			sourceName: row.source.name,
			status: latestRev.operation === "VOID" ? "VOIDED" : "ACTIVE",
			revisionNo: latestRev.revisionNo,
			receivedAt: latestRev.occurredAt,
			amount: latestRev.amount,
			destinationAccountId: latestRev.destinationAccountId,
			note: latestRev.note,
			canonicalTransactionId: row.receipt.canonicalTransactionId,
			canonicalRevisionId: latestRev.canonicalRevisionId,
		});
	}

	items.sort((a, b) => {
		const dateDiff = b.receivedAt.getTime() - a.receivedAt.getTime();
		if (dateDiff !== 0) return dateDiff;
		return b.revisionNo - a.revisionNo;
	});

	return items;
}
