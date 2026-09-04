import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import {
	journalEntries,
	journalLines,
	ledgerAccounts,
} from "../db/schema/ledger";
import {
	MIDAS_BUCKET_TYPES,
	type MidasBucketType,
	midasAccounts,
	midasAllocationTransfers,
	midasBuckets,
	SINGLETON_BUCKET_TYPES,
} from "../db/schema/midas";
import {
	formatSignedCentsToMoney,
	parseMoneyString,
	parsePositiveMoneyString,
} from "../ledger/money";
import { MidasError } from "./errors";
import { calculateAllocationTransferFingerprint } from "./fingerprint";

const BUCKET_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const VALID_BUCKET_TYPES_SET = new Set<string>(MIDAS_BUCKET_TYPES);
const SINGLETON_BUCKET_TYPES_SET = new Set<string>(SINGLETON_BUCKET_TYPES);

export interface CreateMidasAccountParams {
	db: Database | DatabaseTransaction;
	userId: string;
	ledgerAccountId: string;
}

export interface MidasAccountRecord {
	id: string;
	userId: string;
	ledgerAccountId: string;
	createdAt: Date;
}

export interface CreateMidasBucketParams {
	db: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	code: string;
	name: string;
	bucketType: MidasBucketType;
}

export interface MidasBucketRecord {
	id: string;
	userId: string;
	midasAccountId: string;
	code: string;
	name: string;
	bucketType: MidasBucketType;
	createdAt: Date;
}

export interface CreateMidasAllocationTransferParams {
	db: Database;
	userId: string;
	midasAccountId: string;
	idempotencyKey: string;
	fromBucketId?: string | null | undefined;
	toBucketId?: string | null | undefined;
	amount: string;
	occurredAt: Date;
	memo?: string | null | undefined;
	reversalOfTransferId?: string | null | undefined;
}

export interface CreateMidasAllocationTransferInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	idempotencyKey: string;
	fromBucketId?: string | null | undefined;
	toBucketId?: string | null | undefined;
	amount: string;
	occurredAt: Date;
	memo?: string | null | undefined;
	reversalOfTransferId?: string | null | undefined;
}

export interface MidasAllocationTransferResult {
	transferId: string;
	idempotentReplay: boolean;
	midasAccountId: string;
	fromBucketId: string | null;
	toBucketId: string | null;
	amount: string;
	occurredAt: Date;
}

export interface ReverseMidasAllocationTransferParams {
	db: Database;
	userId: string;
	idempotencyKey: string;
	targetTransferId: string;
	occurredAt: Date;
	memo?: string | null | undefined;
}

export interface MidasLiquidityBucketState {
	bucketId: string;
	code: string;
	name: string;
	bucketType: MidasBucketType;
	balance: string;
}

export interface MidasLiquidityState {
	midasAccountId: string;
	ledgerAccountId: string;
	currency: string;
	physicalBalance: string;
	totalEarmarked: string;
	unallocatedBalance: string;
	buckets: MidasLiquidityBucketState[];
}

export interface ListMidasAllocationTransfersParams {
	db: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	bucketId?: string | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export interface MidasAllocationTransferRecord {
	id: string;
	userId: string;
	midasAccountId: string;
	idempotencyKey: string;
	transferFingerprint: string;
	fromBucketId: string | null;
	toBucketId: string | null;
	amount: string;
	occurredAt: Date;
	reversalOfTransferId: string | null;
	memo: string | null;
	createdAt: Date;
}

/**
 * Creates or retrieves the Midas liquidity account linked to an ASSET ledger account.
 * Follows exact replay on matching ledger account, or throws conflict on mismatch.
 */
export async function createMidasAccount({
	db,
	userId,
	ledgerAccountId,
}: CreateMidasAccountParams): Promise<MidasAccountRecord> {
	if (!userId || userId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "User ID is required");
	}
	if (!ledgerAccountId || ledgerAccountId.trim() === "") {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Ledger account ID is required",
		);
	}

	const trimmedUserId = userId.trim();
	const trimmedLedgerAccountId = ledgerAccountId.trim();

	// 1. Check user exists
	const [user] = await db
		.select({ id: users.id, currency: users.currency })
		.from(users)
		.where(eq(users.id, trimmedUserId))
		.limit(1);

	if (!user) {
		throw new MidasError("MIDAS_INVALID_INPUT", "User not found");
	}

	// 2. Validate linked ledger account
	const [ledgerAcc] = await db
		.select({
			id: ledgerAccounts.id,
			userId: ledgerAccounts.userId,
			accountType: ledgerAccounts.accountType,
			normalBalance: ledgerAccounts.normalBalance,
			currency: ledgerAccounts.currency,
			archivedAt: ledgerAccounts.archivedAt,
		})
		.from(ledgerAccounts)
		.where(eq(ledgerAccounts.id, trimmedLedgerAccountId))
		.limit(1);

	if (!ledgerAcc || ledgerAcc.userId !== trimmedUserId) {
		throw new MidasError(
			"MIDAS_LEDGER_ACCOUNT_INVALID",
			"Ledger account not found for this user",
		);
	}

	if (
		ledgerAcc.accountType !== "ASSET" ||
		ledgerAcc.normalBalance !== "DEBIT" ||
		ledgerAcc.currency !== user.currency ||
		ledgerAcc.archivedAt !== null
	) {
		throw new MidasError(
			"MIDAS_LEDGER_ACCOUNT_INVALID",
			"Midas linked ledger account must be an active ASSET account with DEBIT normal balance matching user currency",
		);
	}

	// 3. Check existing Midas account for user
	const [existingUserAccount] = await db
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
			createdAt: midasAccounts.createdAt,
		})
		.from(midasAccounts)
		.where(eq(midasAccounts.userId, trimmedUserId))
		.limit(1);

	if (existingUserAccount) {
		if (existingUserAccount.ledgerAccountId === trimmedLedgerAccountId) {
			return existingUserAccount;
		}
		throw new MidasError(
			"MIDAS_ACCOUNT_CONFLICT",
			"User already has a Midas account linked to a different ledger account",
		);
	}

	// 4. Check if ledger account is already linked to another user's Midas account
	const [existingLedgerLink] = await db
		.select({ id: midasAccounts.id })
		.from(midasAccounts)
		.where(eq(midasAccounts.ledgerAccountId, trimmedLedgerAccountId))
		.limit(1);

	if (existingLedgerLink) {
		throw new MidasError(
			"MIDAS_ACCOUNT_CONFLICT",
			"Ledger account is already linked to a Midas account",
		);
	}

	// 5. Insert Midas account
	const [created] = await db
		.insert(midasAccounts)
		.values({
			userId: trimmedUserId,
			ledgerAccountId: trimmedLedgerAccountId,
		})
		.returning();

	if (!created) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			"Failed to create Midas account",
		);
	}

	return created;
}

/**
 * Creates a virtual earmark bucket for a Midas liquidity account.
 */
export async function createMidasBucket({
	db,
	userId,
	midasAccountId,
	code,
	name,
	bucketType,
}: CreateMidasBucketParams): Promise<MidasBucketRecord> {
	if (!userId || userId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "User ID is required");
	}
	if (!midasAccountId || midasAccountId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "Midas account ID is required");
	}

	const trimmedCode = code?.trim();
	if (!trimmedCode || !BUCKET_CODE_PATTERN.test(trimmedCode)) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Bucket code must match ^[A-Z][A-Z0-9_]{1,63}$",
		);
	}

	const trimmedName = name?.trim();
	if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 120) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Bucket name must be between 1 and 120 characters",
		);
	}

	if (!VALID_BUCKET_TYPES_SET.has(bucketType)) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			`Invalid bucket type: "${bucketType}"`,
		);
	}

	const trimmedUserId = userId.trim();
	const trimmedMidasAccountId = midasAccountId.trim();

	// Check Midas account exists and belongs to user
	const [account] = await db
		.select({ id: midasAccounts.id, userId: midasAccounts.userId })
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, trimmedMidasAccountId),
				eq(midasAccounts.userId, trimmedUserId),
			),
		)
		.limit(1);

	if (!account) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	// Check code uniqueness within Midas account
	const [existingCode] = await db
		.select({ id: midasBuckets.id })
		.from(midasBuckets)
		.where(
			and(
				eq(midasBuckets.midasAccountId, trimmedMidasAccountId),
				eq(midasBuckets.code, trimmedCode),
			),
		)
		.limit(1);

	if (existingCode) {
		throw new MidasError(
			"MIDAS_BUCKET_CONFLICT",
			`Bucket with code "${trimmedCode}" already exists for this Midas account`,
		);
	}

	// Check singleton bucket type uniqueness
	if (SINGLETON_BUCKET_TYPES_SET.has(bucketType)) {
		const [existingSingleton] = await db
			.select({ id: midasBuckets.id })
			.from(midasBuckets)
			.where(
				and(
					eq(midasBuckets.midasAccountId, trimmedMidasAccountId),
					eq(midasBuckets.bucketType, bucketType),
				),
			)
			.limit(1);

		if (existingSingleton) {
			throw new MidasError(
				"MIDAS_BUCKET_CONFLICT",
				`Bucket of type "${bucketType}" already exists for this Midas account`,
			);
		}
	}

	// Insert bucket
	const [created] = await db
		.insert(midasBuckets)
		.values({
			userId: trimmedUserId,
			midasAccountId: trimmedMidasAccountId,
			code: trimmedCode,
			name: trimmedName,
			bucketType,
		})
		.returning();

	if (!created) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			"Failed to create Midas bucket",
		);
	}

	return {
		id: created.id,
		userId: created.userId,
		midasAccountId: created.midasAccountId,
		code: created.code,
		name: created.name,
		bucketType: created.bucketType as MidasBucketType,
		createdAt: created.createdAt,
	};
}

/**
 * Validates transfer input parameters and normalizes data.
 */
function validateTransferInput(params: {
	userId: string;
	midasAccountId: string;
	idempotencyKey: string;
	fromBucketId?: string | null | undefined;
	toBucketId?: string | null | undefined;
	amount: string;
	occurredAt: Date;
	memo?: string | null | undefined;
	reversalOfTransferId?: string | null | undefined;
}) {
	if (!params.userId || params.userId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "User ID is required");
	}
	if (!params.midasAccountId || params.midasAccountId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "Midas account ID is required");
	}

	const trimmedIdempotencyKey = params.idempotencyKey?.trim();
	if (
		!trimmedIdempotencyKey ||
		trimmedIdempotencyKey.length < 1 ||
		trimmedIdempotencyKey.length > 128
	) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Idempotency key must be between 1 and 128 characters",
		);
	}

	if (
		!(params.occurredAt instanceof Date) ||
		Number.isNaN(params.occurredAt.getTime())
	) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Valid occurredAt Date is required",
		);
	}

	const normalizedFromBucketId = params.fromBucketId?.trim() || null;
	const normalizedToBucketId = params.toBucketId?.trim() || null;

	if (normalizedFromBucketId === null && normalizedToBucketId === null) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Transfer must have at least one bucket endpoint (from or to)",
		);
	}

	if (
		normalizedFromBucketId !== null &&
		normalizedToBucketId !== null &&
		normalizedFromBucketId === normalizedToBucketId
	) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Source and destination buckets must be distinct",
		);
	}

	let parsedAmount: { normalized: string; cents: bigint };
	try {
		parsedAmount = parsePositiveMoneyString(params.amount);
	} catch (err) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			`Invalid transfer amount: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const normalizedMemo =
		params.memo !== undefined && params.memo !== null
			? params.memo.trim()
			: null;
	if (normalizedMemo !== null && normalizedMemo.length > 500) {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Memo must not exceed 500 characters",
		);
	}

	const normalizedReversalOfTransferId =
		params.reversalOfTransferId?.trim() || null;

	return {
		trimmedUserId: params.userId.trim(),
		trimmedMidasAccountId: params.midasAccountId.trim(),
		trimmedIdempotencyKey,
		normalizedFromBucketId,
		normalizedToBucketId,
		parsedAmount,
		normalizedMemo: normalizedMemo === "" ? null : normalizedMemo,
		normalizedReversalOfTransferId,
	};
}

/**
 * Internal transaction-scoped allocation transfer execution.
 * Locks the parent Midas account FOR UPDATE to serialize free-balance allocation.
 */
export async function createMidasAllocationTransferInTransaction({
	tx,
	userId,
	midasAccountId,
	idempotencyKey,
	fromBucketId,
	toBucketId,
	amount,
	occurredAt,
	memo,
	reversalOfTransferId,
}: CreateMidasAllocationTransferInTransactionParams): Promise<MidasAllocationTransferResult> {
	const {
		trimmedUserId,
		trimmedMidasAccountId,
		trimmedIdempotencyKey,
		normalizedFromBucketId,
		normalizedToBucketId,
		parsedAmount,
		normalizedMemo,
		normalizedReversalOfTransferId,
	} = validateTransferInput({
		userId,
		midasAccountId,
		idempotencyKey,
		fromBucketId,
		toBucketId,
		amount,
		occurredAt,
		memo,
		reversalOfTransferId,
	});

	// 1. Calculate candidate fingerprint
	const candidateFingerprint = await calculateAllocationTransferFingerprint({
		userId: trimmedUserId,
		midasAccountId: trimmedMidasAccountId,
		fromBucketId: normalizedFromBucketId,
		toBucketId: normalizedToBucketId,
		amount: parsedAmount.normalized,
		occurredAt,
		memo: normalizedMemo,
		reversalOfTransferId: normalizedReversalOfTransferId,
	});

	// 2. Historical Replay Fast Path (checked BEFORE current balance validation)
	const [existingEarly] = await tx
		.select({
			id: midasAllocationTransfers.id,
			midasAccountId: midasAllocationTransfers.midasAccountId,
			fromBucketId: midasAllocationTransfers.fromBucketId,
			toBucketId: midasAllocationTransfers.toBucketId,
			amount: midasAllocationTransfers.amount,
			occurredAt: midasAllocationTransfers.occurredAt,
			transferFingerprint: midasAllocationTransfers.transferFingerprint,
		})
		.from(midasAllocationTransfers)
		.where(
			and(
				eq(midasAllocationTransfers.userId, trimmedUserId),
				eq(midasAllocationTransfers.idempotencyKey, trimmedIdempotencyKey),
			),
		)
		.limit(1);

	if (existingEarly) {
		if (existingEarly.transferFingerprint !== candidateFingerprint) {
			throw new MidasError(
				"MIDAS_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different transfer parameters",
			);
		}

		return {
			transferId: existingEarly.id,
			idempotentReplay: true,
			midasAccountId: existingEarly.midasAccountId,
			fromBucketId: existingEarly.fromBucketId,
			toBucketId: existingEarly.toBucketId,
			amount: existingEarly.amount,
			occurredAt: existingEarly.occurredAt,
		};
	}

	// 3. Lock parent Midas account FOR UPDATE to serialize all allocation transfers
	const [midasAccount] = await tx
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
		})
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, trimmedMidasAccountId),
				eq(midasAccounts.userId, trimmedUserId),
			),
		)
		.for("update")
		.limit(1);

	if (!midasAccount) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	// 4. Validate referenced buckets
	if (normalizedFromBucketId !== null) {
		const [fromBucket] = await tx
			.select({ id: midasBuckets.id })
			.from(midasBuckets)
			.where(
				and(
					eq(midasBuckets.id, normalizedFromBucketId),
					eq(midasBuckets.midasAccountId, trimmedMidasAccountId),
					eq(midasBuckets.userId, trimmedUserId),
				),
			)
			.limit(1);

		if (!fromBucket) {
			throw new MidasError(
				"MIDAS_BUCKET_NOT_FOUND",
				`Source bucket "${normalizedFromBucketId}" not found for this Midas account`,
			);
		}
	}

	if (normalizedToBucketId !== null) {
		const [toBucket] = await tx
			.select({ id: midasBuckets.id })
			.from(midasBuckets)
			.where(
				and(
					eq(midasBuckets.id, normalizedToBucketId),
					eq(midasBuckets.midasAccountId, trimmedMidasAccountId),
					eq(midasBuckets.userId, trimmedUserId),
				),
			)
			.limit(1);

		if (!toBucket) {
			throw new MidasError(
				"MIDAS_BUCKET_NOT_FOUND",
				`Destination bucket "${normalizedToBucketId}" not found for this Midas account`,
			);
		}
	}

	// 5. Validate reversal semantics if specified
	if (normalizedReversalOfTransferId !== null) {
		const [targetTransfer] = await tx
			.select({
				id: midasAllocationTransfers.id,
				userId: midasAllocationTransfers.userId,
				midasAccountId: midasAllocationTransfers.midasAccountId,
				fromBucketId: midasAllocationTransfers.fromBucketId,
				toBucketId: midasAllocationTransfers.toBucketId,
				amount: midasAllocationTransfers.amount,
				reversalOfTransferId: midasAllocationTransfers.reversalOfTransferId,
			})
			.from(midasAllocationTransfers)
			.where(
				and(
					eq(midasAllocationTransfers.id, normalizedReversalOfTransferId),
					eq(midasAllocationTransfers.midasAccountId, trimmedMidasAccountId),
					eq(midasAllocationTransfers.userId, trimmedUserId),
				),
			)
			.limit(1);

		if (!targetTransfer) {
			throw new MidasError(
				"MIDAS_TRANSFER_NOT_FOUND",
				`Target transfer for reversal "${normalizedReversalOfTransferId}" not found`,
			);
		}

		if (targetTransfer.reversalOfTransferId !== null) {
			throw new MidasError(
				"MIDAS_INVALID_STATE",
				"Cannot reverse a reversal transfer",
			);
		}

		// Check if already reversed
		const [existingReversal] = await tx
			.select({ id: midasAllocationTransfers.id })
			.from(midasAllocationTransfers)
			.where(
				eq(
					midasAllocationTransfers.reversalOfTransferId,
					normalizedReversalOfTransferId,
				),
			)
			.limit(1);

		if (existingReversal) {
			throw new MidasError(
				"MIDAS_TRANSFER_ALREADY_REVERSED",
				"Transfer has already been reversed",
			);
		}

		// Enforce exact inverse
		const targetParsed = parseMoneyString(targetTransfer.amount);
		if (
			normalizedFromBucketId !== targetTransfer.toBucketId ||
			normalizedToBucketId !== targetTransfer.fromBucketId ||
			parsedAmount.cents !== targetParsed.cents
		) {
			throw new MidasError(
				"MIDAS_INVALID_INPUT",
				"Reversal transfer must be the exact inverse (swapped from/to and same amount) of the target transfer",
			);
		}
	}

	// 6. Source bucket balance check (if fromBucketId != null)
	if (normalizedFromBucketId !== null) {
		const [sourceBalanceRow] = await tx
			.select({
				netAmount: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${normalizedFromBucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${normalizedFromBucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
			})
			.from(midasAllocationTransfers)
			.where(
				eq(midasAllocationTransfers.midasAccountId, trimmedMidasAccountId),
			);

		const rawNet = sourceBalanceRow?.netAmount ?? "0.00";
		const parts = rawNet.split(".");
		const intPart = BigInt(parts[0] ?? "0");
		let fracPart = parts[1] ?? "00";
		if (fracPart.length === 1) fracPart = `${fracPart}0`;
		const accurateSourceCents =
			intPart >= 0n
				? intPart * 100n + BigInt(fracPart)
				: intPart * 100n - BigInt(fracPart);

		if (accurateSourceCents < parsedAmount.cents) {
			throw new MidasError(
				"MIDAS_INSUFFICIENT_BUCKET_BALANCE",
				`Source bucket has insufficient balance (${formatSignedCentsToMoney(accurateSourceCents)}) for transfer amount (${parsedAmount.normalized})`,
			);
		}
	}

	// 7. Physical ledger balance vs Total Earmarked check
	const [physicalBalanceRow] = await tx
		.select({
			netDebit: sql<string>`COALESCE(SUM(${journalLines.debit}) - SUM(${journalLines.credit}), 0)::text`,
		})
		.from(journalLines)
		.innerJoin(
			journalEntries,
			eq(journalEntries.id, journalLines.journalEntryId),
		)
		.where(
			and(
				eq(journalLines.accountId, midasAccount.ledgerAccountId),
				eq(journalEntries.status, "POSTED"),
			),
		);

	const rawPhysical = physicalBalanceRow?.netDebit ?? "0.00";
	const pParts = rawPhysical.split(".");
	const pInt = BigInt(pParts[0] ?? "0");
	let pFrac = pParts[1] ?? "00";
	if (pFrac.length === 1) pFrac = `${pFrac}0`;
	const physicalBalanceCents =
		pInt >= 0n ? pInt * 100n + BigInt(pFrac) : pInt * 100n - BigInt(pFrac);

	const [totalEarmarkedRow] = await tx
		.select({
			netAllocated: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.fromBucketId} IS NULL THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.toBucketId} IS NULL THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
		})
		.from(midasAllocationTransfers)
		.where(eq(midasAllocationTransfers.midasAccountId, trimmedMidasAccountId));

	const rawEarmarked = totalEarmarkedRow?.netAllocated ?? "0.00";
	const eParts = rawEarmarked.split(".");
	const eInt = BigInt(eParts[0] ?? "0");
	let eFrac = eParts[1] ?? "00";
	if (eFrac.length === 1) eFrac = `${eFrac}0`;
	const currentEarmarkedCents =
		eInt >= 0n ? eInt * 100n + BigInt(eFrac) : eInt * 100n - BigInt(eFrac);

	let deltaCents = 0n;
	if (normalizedFromBucketId === null) {
		deltaCents = parsedAmount.cents; // Allocating fresh money into a bucket
	} else if (normalizedToBucketId === null) {
		deltaCents = -parsedAmount.cents; // Releasing money back to unallocated
	}

	const resultingEarmarkedCents = currentEarmarkedCents + deltaCents;

	if (resultingEarmarkedCents > physicalBalanceCents) {
		const unallocatedCents = physicalBalanceCents - currentEarmarkedCents;
		throw new MidasError(
			"MIDAS_INSUFFICIENT_FREE_BALANCE",
			`Insufficient unallocated liquidity. Available unallocated: ${formatSignedCentsToMoney(unallocatedCents)}, requested: ${parsedAmount.normalized}`,
		);
	}

	// 8. Insert allocation transfer with race-safe ON CONFLICT DO NOTHING
	const [inserted] = await tx
		.insert(midasAllocationTransfers)
		.values({
			userId: trimmedUserId,
			midasAccountId: trimmedMidasAccountId,
			idempotencyKey: trimmedIdempotencyKey,
			transferFingerprint: candidateFingerprint,
			fromBucketId: normalizedFromBucketId,
			toBucketId: normalizedToBucketId,
			amount: parsedAmount.normalized,
			occurredAt,
			memo: normalizedMemo,
			reversalOfTransferId: normalizedReversalOfTransferId,
		})
		.onConflictDoNothing({
			target: [
				midasAllocationTransfers.userId,
				midasAllocationTransfers.idempotencyKey,
			],
		})
		.returning();

	if (!inserted) {
		// Race condition: another transaction inserted same idempotency key
		const [existingLate] = await tx
			.select({
				id: midasAllocationTransfers.id,
				midasAccountId: midasAllocationTransfers.midasAccountId,
				fromBucketId: midasAllocationTransfers.fromBucketId,
				toBucketId: midasAllocationTransfers.toBucketId,
				amount: midasAllocationTransfers.amount,
				occurredAt: midasAllocationTransfers.occurredAt,
				transferFingerprint: midasAllocationTransfers.transferFingerprint,
			})
			.from(midasAllocationTransfers)
			.where(
				and(
					eq(midasAllocationTransfers.userId, trimmedUserId),
					eq(midasAllocationTransfers.idempotencyKey, trimmedIdempotencyKey),
				),
			)
			.limit(1);

		if (!existingLate) {
			throw new MidasError(
				"MIDAS_INVALID_STATE",
				"Failed to retrieve transfer after concurrent conflict",
			);
		}

		if (existingLate.transferFingerprint !== candidateFingerprint) {
			throw new MidasError(
				"MIDAS_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different transfer parameters",
			);
		}

		return {
			transferId: existingLate.id,
			idempotentReplay: true,
			midasAccountId: existingLate.midasAccountId,
			fromBucketId: existingLate.fromBucketId,
			toBucketId: existingLate.toBucketId,
			amount: existingLate.amount,
			occurredAt: existingLate.occurredAt,
		};
	}

	return {
		transferId: inserted.id,
		idempotentReplay: false,
		midasAccountId: inserted.midasAccountId,
		fromBucketId: inserted.fromBucketId,
		toBucketId: inserted.toBucketId,
		amount: inserted.amount,
		occurredAt: inserted.occurredAt,
	};
}

/**
 * Creates an allocation transfer within a new database transaction.
 */
export async function createMidasAllocationTransfer(
	params: CreateMidasAllocationTransferParams,
): Promise<MidasAllocationTransferResult> {
	validateTransferInput(params);
	return await params.db.transaction(async (tx) => {
		return await createMidasAllocationTransferInTransaction({
			tx,
			userId: params.userId,
			midasAccountId: params.midasAccountId,
			idempotencyKey: params.idempotencyKey,
			fromBucketId: params.fromBucketId,
			toBucketId: params.toBucketId,
			amount: params.amount,
			occurredAt: params.occurredAt,
			memo: params.memo,
			reversalOfTransferId: params.reversalOfTransferId,
		});
	});
}

/**
 * Reverses an existing allocation transfer.
 */
export async function reverseMidasAllocationTransfer({
	db,
	userId,
	idempotencyKey,
	targetTransferId,
	occurredAt,
	memo,
}: ReverseMidasAllocationTransferParams): Promise<MidasAllocationTransferResult> {
	if (!userId || userId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "User ID is required");
	}
	if (!targetTransferId || targetTransferId.trim() === "") {
		throw new MidasError(
			"MIDAS_INVALID_INPUT",
			"Target transfer ID is required",
		);
	}

	return await db.transaction(async (tx) => {
		const trimmedUserId = userId.trim();
		const trimmedTargetId = targetTransferId.trim();

		const [target] = await tx
			.select({
				id: midasAllocationTransfers.id,
				userId: midasAllocationTransfers.userId,
				midasAccountId: midasAllocationTransfers.midasAccountId,
				fromBucketId: midasAllocationTransfers.fromBucketId,
				toBucketId: midasAllocationTransfers.toBucketId,
				amount: midasAllocationTransfers.amount,
				reversalOfTransferId: midasAllocationTransfers.reversalOfTransferId,
			})
			.from(midasAllocationTransfers)
			.where(
				and(
					eq(midasAllocationTransfers.id, trimmedTargetId),
					eq(midasAllocationTransfers.userId, trimmedUserId),
				),
			)
			.limit(1);

		if (!target) {
			throw new MidasError(
				"MIDAS_TRANSFER_NOT_FOUND",
				`Target transfer "${trimmedTargetId}" not found for this user`,
			);
		}

		if (target.reversalOfTransferId !== null) {
			throw new MidasError(
				"MIDAS_INVALID_STATE",
				"Cannot reverse a reversal transfer",
			);
		}

		return await createMidasAllocationTransferInTransaction({
			tx,
			userId: trimmedUserId,
			midasAccountId: target.midasAccountId,
			idempotencyKey,
			fromBucketId: target.toBucketId,
			toBucketId: target.fromBucketId,
			amount: target.amount,
			occurredAt,
			memo,
			reversalOfTransferId: target.id,
		});
	});
}

/**
 * Retrieves the complete Midas liquidity state including physical ledger balance,
 * total earmarked, unallocated balance, and individual bucket balances.
 */
export async function getMidasLiquidityState({
	db,
	userId,
	midasAccountId,
}: {
	db: Database | DatabaseTransaction;
	userId: string;
	midasAccountId?: string | undefined;
}): Promise<MidasLiquidityState> {
	if (!userId || userId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "User ID is required");
	}

	const trimmedUserId = userId.trim();
	const conditions = [eq(midasAccounts.userId, trimmedUserId)];
	if (midasAccountId && midasAccountId.trim() !== "") {
		conditions.push(eq(midasAccounts.id, midasAccountId.trim()));
	}

	const [account] = await db
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
		})
		.from(midasAccounts)
		.where(and(...conditions))
		.limit(1);

	if (!account) {
		throw new MidasError(
			"MIDAS_ACCOUNT_NOT_FOUND",
			"Midas liquidity account not found",
		);
	}

	// Fetch linked ledger account currency
	const [ledgerAcc] = await db
		.select({
			currency: ledgerAccounts.currency,
		})
		.from(ledgerAccounts)
		.where(eq(ledgerAccounts.id, account.ledgerAccountId))
		.limit(1);

	if (!ledgerAcc) {
		throw new MidasError(
			"MIDAS_LEDGER_ACCOUNT_INVALID",
			"Linked ledger account not found",
		);
	}

	// Calculate physical balance from POSTED journal lines
	const [physicalRow] = await db
		.select({
			netDebit: sql<string>`COALESCE(SUM(${journalLines.debit}) - SUM(${journalLines.credit}), 0)::text`,
		})
		.from(journalLines)
		.innerJoin(
			journalEntries,
			eq(journalEntries.id, journalLines.journalEntryId),
		)
		.where(
			and(
				eq(journalLines.accountId, account.ledgerAccountId),
				eq(journalEntries.status, "POSTED"),
			),
		);

	const rawPhysical = physicalRow?.netDebit ?? "0.00";
	const pParts = rawPhysical.split(".");
	const pInt = BigInt(pParts[0] ?? "0");
	let pFrac = pParts[1] ?? "00";
	if (pFrac.length === 1) pFrac = `${pFrac}0`;
	const physicalBalanceCents =
		pInt >= 0n ? pInt * 100n + BigInt(pFrac) : pInt * 100n - BigInt(pFrac);

	// Fetch all buckets for this Midas account
	const allBuckets = await db
		.select({
			id: midasBuckets.id,
			code: midasBuckets.code,
			name: midasBuckets.name,
			bucketType: midasBuckets.bucketType,
		})
		.from(midasBuckets)
		.where(eq(midasBuckets.midasAccountId, account.id))
		.orderBy(
			asc(midasBuckets.bucketType),
			asc(midasBuckets.code),
			asc(midasBuckets.id),
		);

	// Fetch all allocation transfers for this Midas account to compute per-bucket balances
	const transfers = await db
		.select({
			fromBucketId: midasAllocationTransfers.fromBucketId,
			toBucketId: midasAllocationTransfers.toBucketId,
			amount: midasAllocationTransfers.amount,
		})
		.from(midasAllocationTransfers)
		.where(eq(midasAllocationTransfers.midasAccountId, account.id));

	const bucketCentsMap = new Map<string, bigint>();
	for (const b of allBuckets) {
		bucketCentsMap.set(b.id, 0n);
	}

	let totalEarmarkedCents = 0n;

	for (const t of transfers) {
		const parsed = parseMoneyString(t.amount);
		if (t.fromBucketId && bucketCentsMap.has(t.fromBucketId)) {
			const current = bucketCentsMap.get(t.fromBucketId) ?? 0n;
			bucketCentsMap.set(t.fromBucketId, current - parsed.cents);
		}
		if (t.toBucketId && bucketCentsMap.has(t.toBucketId)) {
			const current = bucketCentsMap.get(t.toBucketId) ?? 0n;
			bucketCentsMap.set(t.toBucketId, current + parsed.cents);
		}

		if (t.fromBucketId === null && t.toBucketId !== null) {
			totalEarmarkedCents += parsed.cents;
		} else if (t.fromBucketId !== null && t.toBucketId === null) {
			totalEarmarkedCents -= parsed.cents;
		}
	}

	const bucketStates: MidasLiquidityBucketState[] = allBuckets.map((b) => {
		const cents = bucketCentsMap.get(b.id) ?? 0n;
		return {
			bucketId: b.id,
			code: b.code,
			name: b.name,
			bucketType: b.bucketType as MidasBucketType,
			balance: formatSignedCentsToMoney(cents),
		};
	});

	const unallocatedCents = physicalBalanceCents - totalEarmarkedCents;

	return {
		midasAccountId: account.id,
		ledgerAccountId: account.ledgerAccountId,
		currency: ledgerAcc.currency,
		physicalBalance: formatSignedCentsToMoney(physicalBalanceCents),
		totalEarmarked: formatSignedCentsToMoney(totalEarmarkedCents),
		unallocatedBalance: formatSignedCentsToMoney(unallocatedCents),
		buckets: bucketStates,
	};
}

/**
 * Lists allocation transfers for a Midas account.
 */
export async function listMidasAllocationTransfers({
	db,
	userId,
	midasAccountId,
	bucketId,
	limit = 50,
	offset = 0,
}: ListMidasAllocationTransfersParams): Promise<
	MidasAllocationTransferRecord[]
> {
	if (!userId || userId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "User ID is required");
	}
	if (!midasAccountId || midasAccountId.trim() === "") {
		throw new MidasError("MIDAS_INVALID_INPUT", "Midas account ID is required");
	}

	const trimmedUserId = userId.trim();
	const trimmedMidasAccountId = midasAccountId.trim();
	const sanitizedLimit = Math.max(1, Math.min(limit, 100));
	const sanitizedOffset = Math.max(0, offset);

	const conditions = [
		eq(midasAllocationTransfers.userId, trimmedUserId),
		eq(midasAllocationTransfers.midasAccountId, trimmedMidasAccountId),
	];

	if (bucketId && bucketId.trim() !== "") {
		const trimmedBucketId = bucketId.trim();
		const bucketFilter = or(
			eq(midasAllocationTransfers.fromBucketId, trimmedBucketId),
			eq(midasAllocationTransfers.toBucketId, trimmedBucketId),
		);
		if (bucketFilter) {
			conditions.push(bucketFilter);
		}
	}

	const rows = await db
		.select({
			id: midasAllocationTransfers.id,
			userId: midasAllocationTransfers.userId,
			midasAccountId: midasAllocationTransfers.midasAccountId,
			idempotencyKey: midasAllocationTransfers.idempotencyKey,
			transferFingerprint: midasAllocationTransfers.transferFingerprint,
			fromBucketId: midasAllocationTransfers.fromBucketId,
			toBucketId: midasAllocationTransfers.toBucketId,
			amount: midasAllocationTransfers.amount,
			occurredAt: midasAllocationTransfers.occurredAt,
			reversalOfTransferId: midasAllocationTransfers.reversalOfTransferId,
			memo: midasAllocationTransfers.memo,
			createdAt: midasAllocationTransfers.createdAt,
		})
		.from(midasAllocationTransfers)
		.where(and(...conditions))
		.orderBy(
			desc(midasAllocationTransfers.occurredAt),
			desc(midasAllocationTransfers.createdAt),
			desc(midasAllocationTransfers.id),
		)
		.limit(sanitizedLimit)
		.offset(sanitizedOffset);

	return rows;
}
