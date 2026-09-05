import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
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
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { MidasError } from "./errors";
import { calculateAllocationTransferFingerprint } from "./fingerprint";
import {
	isMidasBucketCapExceededDbError,
	isMidasBucketInactiveDbError,
	isMidasLedgerAccountInvalidDbError,
	normalizeCanonicalUuid,
} from "./utils";

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

export interface LockMidasAllocationStateInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	midasAccountId: string;
}

export interface LockedMidasAllocationIdentity {
	midasAccountId: string;
	userId: string;
	ledgerAccountId: string;
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

export interface GetMidasLiquidityStateInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	midasAccountId?: string | undefined;
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
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");
	const canonicalLedgerAccountId = normalizeCanonicalUuid(
		ledgerAccountId,
		"ledgerAccountId",
	);

	// 1. Check user exists
	const [user] = await db
		.select({ id: users.id, currency: users.currency })
		.from(users)
		.where(eq(users.id, canonicalUserId))
		.limit(1);

	if (!user) {
		throw new MidasError("MIDAS_INVALID_INPUT", "User not found");
	}

	// 2. Exact Account Replay FIRST: check existing Midas account for user before mutable revalidation
	const [existingUserAccount] = await db
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
			createdAt: midasAccounts.createdAt,
		})
		.from(midasAccounts)
		.where(eq(midasAccounts.userId, canonicalUserId))
		.limit(1);

	if (existingUserAccount) {
		if (existingUserAccount.ledgerAccountId === canonicalLedgerAccountId) {
			return existingUserAccount;
		}
		throw new MidasError(
			"MIDAS_ACCOUNT_CONFLICT",
			"User already has a Midas account linked to a different ledger account",
		);
	}

	// 3. Validate linked candidate ledger account (for fresh creation only)
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
		.where(eq(ledgerAccounts.id, canonicalLedgerAccountId))
		.limit(1);

	if (!ledgerAcc || ledgerAcc.userId !== canonicalUserId) {
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

	// 4. Check physical balance of ledger account is non-negative
	const [physicalBalanceRow] = await db
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
				eq(journalLines.accountId, canonicalLedgerAccountId),
				eq(journalEntries.status, "POSTED"),
			),
		);

	const physicalParsed = parseSignedAggregateMoneyString(
		physicalBalanceRow?.netDebit ?? "0.00",
	);
	if (physicalParsed.cents < 0n) {
		throw new MidasError(
			"MIDAS_LEDGER_ACCOUNT_INVALID",
			`Cannot link Midas account to a ledger account with negative physical balance (${physicalParsed.normalized})`,
		);
	}

	// 5. Check if ledger account is already linked to another user's Midas account
	const [existingLedgerLink] = await db
		.select({ id: midasAccounts.id })
		.from(midasAccounts)
		.where(eq(midasAccounts.ledgerAccountId, canonicalLedgerAccountId))
		.limit(1);

	if (existingLedgerLink) {
		throw new MidasError(
			"MIDAS_ACCOUNT_CONFLICT",
			"Ledger account is already linked to a Midas account",
		);
	}

	// 6. Insert Midas account with race safety
	try {
		const [created] = await db
			.insert(midasAccounts)
			.values({
				userId: canonicalUserId,
				ledgerAccountId: canonicalLedgerAccountId,
			})
			.onConflictDoNothing({ target: [midasAccounts.userId] })
			.returning();

		if (created) {
			return created;
		}

		// Re-check after conflict
		const [existingLate] = await db
			.select({
				id: midasAccounts.id,
				userId: midasAccounts.userId,
				ledgerAccountId: midasAccounts.ledgerAccountId,
				createdAt: midasAccounts.createdAt,
			})
			.from(midasAccounts)
			.where(eq(midasAccounts.userId, canonicalUserId))
			.limit(1);

		if (existingLate) {
			if (existingLate.ledgerAccountId === canonicalLedgerAccountId) {
				return existingLate;
			}
			throw new MidasError(
				"MIDAS_ACCOUNT_CONFLICT",
				"User already has a Midas account linked to a different ledger account",
			);
		}

		throw new MidasError(
			"MIDAS_ACCOUNT_CONFLICT",
			"Ledger account is already linked to a Midas account",
		);
	} catch (err) {
		if (err instanceof MidasError) {
			throw err;
		}
		if (isMidasLedgerAccountInvalidDbError(err)) {
			throw new MidasError(
				"MIDAS_LEDGER_ACCOUNT_INVALID",
				"Cannot link Midas account: linked ledger account is invalid or has negative physical balance",
			);
		}
		const errStr = `${err instanceof Error ? err.message : String(err)} ${(err as { cause?: Error })?.cause?.message ?? ""} ${String((err as { cause?: { code?: string } })?.cause?.code ?? "")}`;
		if (
			errStr.includes("23505") ||
			errStr.includes("unique") ||
			errStr.includes("duplicate key")
		) {
			const [existingAfterErr] = await db
				.select({
					id: midasAccounts.id,
					userId: midasAccounts.userId,
					ledgerAccountId: midasAccounts.ledgerAccountId,
					createdAt: midasAccounts.createdAt,
				})
				.from(midasAccounts)
				.where(eq(midasAccounts.userId, canonicalUserId))
				.limit(1);

			if (
				existingAfterErr &&
				existingAfterErr.ledgerAccountId === canonicalLedgerAccountId
			) {
				return existingAfterErr;
			}
			throw new MidasError(
				"MIDAS_ACCOUNT_CONFLICT",
				"Midas account or linked ledger account already exists",
			);
		}
		throw err;
	}
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
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");
	const canonicalMidasAccountId = normalizeCanonicalUuid(
		midasAccountId,
		"midasAccountId",
	);

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

	// Check Midas account exists and belongs to user
	const [account] = await db
		.select({ id: midasAccounts.id, userId: midasAccounts.userId })
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, canonicalMidasAccountId),
				eq(midasAccounts.userId, canonicalUserId),
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
				eq(midasBuckets.midasAccountId, canonicalMidasAccountId),
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
					eq(midasBuckets.midasAccountId, canonicalMidasAccountId),
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

	// Insert bucket with race safety mapping
	try {
		const [created] = await db
			.insert(midasBuckets)
			.values({
				userId: canonicalUserId,
				midasAccountId: canonicalMidasAccountId,
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
	} catch (err) {
		if (err instanceof MidasError) throw err;
		const errStr = `${err instanceof Error ? err.message : String(err)} ${(err as { cause?: Error })?.cause?.message ?? ""} ${String((err as { cause?: { code?: string } })?.cause?.code ?? "")}`;
		if (
			errStr.includes("23505") ||
			errStr.includes("unique") ||
			errStr.includes("duplicate key")
		) {
			throw new MidasError(
				"MIDAS_BUCKET_CONFLICT",
				`Bucket conflict for code "${trimmedCode}" or type "${bucketType}"`,
			);
		}
		throw err;
	}
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
	const canonicalUserId = normalizeCanonicalUuid(params.userId, "userId");
	const canonicalMidasAccountId = normalizeCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);

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

	const normalizedFromBucketId =
		params.fromBucketId !== undefined && params.fromBucketId !== null
			? normalizeCanonicalUuid(params.fromBucketId, "fromBucketId")
			: null;
	const normalizedToBucketId =
		params.toBucketId !== undefined && params.toBucketId !== null
			? normalizeCanonicalUuid(params.toBucketId, "toBucketId")
			: null;

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
		params.reversalOfTransferId !== undefined &&
		params.reversalOfTransferId !== null
			? normalizeCanonicalUuid(
					params.reversalOfTransferId,
					"reversalOfTransferId",
				)
			: null;

	return {
		trimmedUserId: canonicalUserId,
		trimmedMidasAccountId: canonicalMidasAccountId,
		trimmedIdempotencyKey,
		normalizedFromBucketId,
		normalizedToBucketId,
		parsedAmount,
		normalizedMemo: normalizedMemo === "" ? null : normalizedMemo,
		normalizedReversalOfTransferId,
	};
}

/**
 * Locks the linked ledger account FOR UPDATE then parent Midas account FOR UPDATE
 * in the strict global lock order to serialize Midas allocation state changes.
 */
export async function lockMidasAllocationStateInTransaction({
	tx,
	userId,
	midasAccountId,
}: LockMidasAllocationStateInTransactionParams): Promise<LockedMidasAllocationIdentity> {
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");
	const canonicalMidasAccountId = normalizeCanonicalUuid(
		midasAccountId,
		"midasAccountId",
	);

	// 1. Resolve Midas identity without locking only to obtain linked ledgerAccountId
	const [midasIdentity] = await tx
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
		})
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, canonicalMidasAccountId),
				eq(midasAccounts.userId, canonicalUserId),
			),
		)
		.limit(1);

	if (!midasIdentity) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	// 2. Lock linked ledger account FOR UPDATE first (matching global lock order)
	const [ledgerAccount] = await tx
		.select({
			id: ledgerAccounts.id,
			userId: ledgerAccounts.userId,
		})
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.id, midasIdentity.ledgerAccountId),
				eq(ledgerAccounts.userId, canonicalUserId),
			),
		)
		.for("update")
		.limit(1);

	if (!ledgerAccount) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	// 3. Lock parent Midas account FOR UPDATE
	const [midasAccount] = await tx
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
		})
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, canonicalMidasAccountId),
				eq(midasAccounts.userId, canonicalUserId),
			),
		)
		.for("update")
		.limit(1);

	if (!midasAccount) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	// 4. Revalidate after Midas lock
	if (
		midasAccount.userId !== canonicalUserId ||
		midasAccount.id !== canonicalMidasAccountId ||
		midasAccount.ledgerAccountId !== midasIdentity.ledgerAccountId
	) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	return {
		midasAccountId: midasAccount.id,
		userId: midasAccount.userId,
		ledgerAccountId: midasAccount.ledgerAccountId,
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

	// 3. Acquire global Midas allocation lock (ledger_accounts -> midas_accounts)
	const lockedMidasIdentity = await lockMidasAllocationStateInTransaction({
		tx,
		userId: trimmedUserId,
		midasAccountId: trimmedMidasAccountId,
	});

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

		const parsedSource = parseSignedAggregateMoneyString(
			sourceBalanceRow?.netAmount ?? "0.00",
		);

		if (parsedSource.cents < parsedAmount.cents) {
			throw new MidasError(
				"MIDAS_INSUFFICIENT_BUCKET_BALANCE",
				`Source bucket has insufficient balance (${parsedSource.normalized}) for transfer amount (${parsedAmount.normalized})`,
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
				eq(journalLines.accountId, lockedMidasIdentity.ledgerAccountId),
				eq(journalEntries.status, "POSTED"),
			),
		);

	const physicalParsed = parseSignedAggregateMoneyString(
		physicalBalanceRow?.netDebit ?? "0.00",
	);
	const physicalBalanceCents = physicalParsed.cents;

	const [totalEarmarkedRow] = await tx
		.select({
			netAllocated: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.fromBucketId} IS NULL THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.toBucketId} IS NULL THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
		})
		.from(midasAllocationTransfers)
		.where(eq(midasAllocationTransfers.midasAccountId, trimmedMidasAccountId));

	const earmarkedParsed = parseSignedAggregateMoneyString(
		totalEarmarkedRow?.netAllocated ?? "0.00",
	);
	const currentEarmarkedCents = earmarkedParsed.cents;

	if (
		currentEarmarkedCents < 0n ||
		physicalBalanceCents < 0n ||
		currentEarmarkedCents > physicalBalanceCents
	) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Inconsistent liquidity state detected: physical=${physicalParsed.normalized}, earmarked=${earmarkedParsed.normalized}`,
		);
	}

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
	let inserted: typeof midasAllocationTransfers.$inferSelect | undefined;
	try {
		const [res] = await tx
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
		inserted = res;
	} catch (err: unknown) {
		if (isMidasBucketInactiveDbError(err)) {
			throw new MidasError(
				"MIDAS_BUCKET_INACTIVE",
				"Cannot transfer funds into bucket because linked goal is not active",
			);
		}
		if (isMidasBucketCapExceededDbError(err)) {
			throw new MidasError(
				"MIDAS_BUCKET_CAP_EXCEEDED",
				"Transfer would exceed maximum budget cap for linked goal",
			);
		}
		throw err;
	}

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
 * Rejects an attempt to use a PENDING_LONG_TERM bucket as a transfer
 * endpoint through the generic public Midas allocation API. PENDING_LONG_TERM
 * is exclusively managed by the Long-Term Investment Send Task domain, whose
 * internal service reuses the transaction-scoped
 * `createMidasAllocationTransferInTransaction` primitive directly (bypassing
 * this public-only guard) so its task-companion invariants remain the sole
 * authority over that bucket. Every other bucket type (CREDIT_CARD_RESERVE,
 * SHORT_TERM_GOAL, MEDIUM_TERM_RESERVE, INCOME_BUFFER) is unaffected.
 */
async function assertNoLongTermBucketEndpointInTransaction(
	tx: DatabaseTransaction,
	bucketIds: (string | null)[],
): Promise<void> {
	const ids = bucketIds.filter((id): id is string => id !== null);
	if (ids.length === 0) return;

	const rows = await tx
		.select({ id: midasBuckets.id, bucketType: midasBuckets.bucketType })
		.from(midasBuckets)
		.where(inArray(midasBuckets.id, ids));

	for (const row of rows) {
		if (row.bucketType === "PENDING_LONG_TERM") {
			throw new MidasError(
				"MIDAS_LONG_TERM_BUCKET_RESTRICTED",
				"PENDING_LONG_TERM cannot be used as a transfer endpoint through the generic Midas allocation API; use the Long-Term Investment Send Task workflow instead",
			);
		}
	}
}

/**
 * Creates an allocation transfer within a new database transaction.
 */
export async function createMidasAllocationTransfer(
	params: CreateMidasAllocationTransferParams,
): Promise<MidasAllocationTransferResult> {
	validateTransferInput(params);
	return await params.db.transaction(async (tx) => {
		await assertNoLongTermBucketEndpointInTransaction(tx, [
			params.fromBucketId ?? null,
			params.toBucketId ?? null,
		]);
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
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");
	const canonicalTargetId = normalizeCanonicalUuid(
		targetTransferId,
		"targetTransferId",
	);

	return await db.transaction(async (tx) => {
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
					eq(midasAllocationTransfers.id, canonicalTargetId),
					eq(midasAllocationTransfers.userId, canonicalUserId),
				),
			)
			.limit(1);

		if (!target) {
			throw new MidasError(
				"MIDAS_TRANSFER_NOT_FOUND",
				`Target transfer "${canonicalTargetId}" not found for this user`,
			);
		}

		if (target.reversalOfTransferId !== null) {
			throw new MidasError(
				"MIDAS_INVALID_STATE",
				"Cannot reverse a reversal transfer",
			);
		}

		await assertNoLongTermBucketEndpointInTransaction(tx, [
			target.fromBucketId,
			target.toBucketId,
		]);

		return await createMidasAllocationTransferInTransaction({
			tx,
			userId: canonicalUserId,
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
 * Retrieves the complete Midas liquidity state within an active transaction.
 * Defaults to locking the Midas account FOR UPDATE to guarantee snapshot isolation.
 */
export async function getMidasLiquidityStateInTransaction({
	tx,
	userId,
	midasAccountId,
}: GetMidasLiquidityStateInTransactionParams): Promise<MidasLiquidityState> {
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");
	const conditions = [eq(midasAccounts.userId, canonicalUserId)];

	if (midasAccountId && midasAccountId.trim() !== "") {
		const canonicalMidasAccountId = normalizeCanonicalUuid(
			midasAccountId,
			"midasAccountId",
		);
		conditions.push(eq(midasAccounts.id, canonicalMidasAccountId));
	}

	const [account] = await tx
		.select({
			id: midasAccounts.id,
			userId: midasAccounts.userId,
			ledgerAccountId: midasAccounts.ledgerAccountId,
		})
		.from(midasAccounts)
		.where(and(...conditions))
		.for("update")
		.limit(1);

	if (!account) {
		throw new MidasError(
			"MIDAS_ACCOUNT_NOT_FOUND",
			"Midas liquidity account not found",
		);
	}

	// Fetch linked ledger account currency
	const [ledgerAcc] = await tx
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
	const [physicalRow] = await tx
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

	const physicalParsed = parseSignedAggregateMoneyString(
		physicalRow?.netDebit ?? "0.00",
	);
	const physicalBalanceCents = physicalParsed.cents;

	if (physicalBalanceCents < 0n) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: negative physical balance on linked ledger account (${physicalParsed.normalized})`,
		);
	}

	// Fetch all buckets for this Midas account
	const allBuckets = await tx
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
	const transfers = await tx
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

	let sumBucketBalancesCents = 0n;
	const bucketStates: MidasLiquidityBucketState[] = allBuckets.map((b) => {
		const cents = bucketCentsMap.get(b.id) ?? 0n;
		if (cents < 0n) {
			throw new MidasError(
				"MIDAS_INVALID_STATE",
				`Impossible state: bucket "${b.code}" has negative balance (${formatSignedCentsToMoney(cents)})`,
			);
		}
		sumBucketBalancesCents += cents;
		return {
			bucketId: b.id,
			code: b.code,
			name: b.name,
			bucketType: b.bucketType as MidasBucketType,
			balance: formatSignedCentsToMoney(cents),
		};
	});

	if (sumBucketBalancesCents !== totalEarmarkedCents) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: sum of bucket balances (${formatSignedCentsToMoney(sumBucketBalancesCents)}) does not match total earmarked (${formatSignedCentsToMoney(totalEarmarkedCents)})`,
		);
	}

	if (totalEarmarkedCents < 0n) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: total earmarked is negative (${formatSignedCentsToMoney(totalEarmarkedCents)})`,
		);
	}

	if (totalEarmarkedCents > physicalBalanceCents) {
		throw new MidasError(
			"MIDAS_INVALID_STATE",
			`Impossible state: total earmarked (${formatSignedCentsToMoney(totalEarmarkedCents)}) exceeds physical balance (${formatSignedCentsToMoney(physicalBalanceCents)})`,
		);
	}

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
 * Retrieves the complete Midas liquidity state including physical ledger balance,
 * total earmarked, unallocated balance, and individual bucket balances.
 */
export async function getMidasLiquidityState({
	db,
	userId,
	midasAccountId,
}: {
	db: Database;
	userId: string;
	midasAccountId?: string | undefined;
}): Promise<MidasLiquidityState> {
	return await db.transaction(async (tx) => {
		return await getMidasLiquidityStateInTransaction({
			tx,
			userId,
			midasAccountId,
		});
	});
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
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");
	const canonicalMidasAccountId = normalizeCanonicalUuid(
		midasAccountId,
		"midasAccountId",
	);

	const sanitizedLimit = Math.max(1, Math.min(limit, 100));
	const sanitizedOffset = Math.max(0, offset);

	const conditions = [
		eq(midasAllocationTransfers.userId, canonicalUserId),
		eq(midasAllocationTransfers.midasAccountId, canonicalMidasAccountId),
	];

	if (bucketId && bucketId.trim() !== "") {
		const canonicalBucketId = normalizeCanonicalUuid(bucketId, "bucketId");
		const bucketFilter = or(
			eq(midasAllocationTransfers.fromBucketId, canonicalBucketId),
			eq(midasAllocationTransfers.toBucketId, canonicalBucketId),
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
