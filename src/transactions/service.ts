import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	canonicalTransactions,
	transactionRevisions,
	transactionSources,
} from "../db/schema/transactions";
import { canonicalizePayload } from "./canonical-json";
import { CanonicalTransactionError } from "./errors";
import {
	calculateRevisionFingerprint,
	type NormalizedSourceDescriptor,
} from "./fingerprint";

export interface TransactionSourceInput {
	type: string;
	ref?: string | null;
	payloadHash?: string | null;
	observedAt?: Date | null;
}

export interface CreateCanonicalTransactionParams {
	db: Database;
	userId: string;
	kind: string;
	idempotencyKey: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	source: TransactionSourceInput;
}

export interface CreateCanonicalTransactionInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	kind: string;
	idempotencyKey: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	source: TransactionSourceInput;
}

export interface ReviseCanonicalTransactionParams {
	db: Database;
	userId: string;
	transactionId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	source: TransactionSourceInput;
}

export interface ReviseCanonicalTransactionInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	transactionId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	occurredAt: Date;
	payload: Record<string, unknown>;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	source: TransactionSourceInput;
}

export interface VoidCanonicalTransactionParams {
	db: Database;
	userId: string;
	transactionId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	source: TransactionSourceInput;
}

export interface VoidCanonicalTransactionInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	transactionId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
	reasonCode: string;
	reasonNote?: string | null | undefined;
	source: TransactionSourceInput;
}

export interface CanonicalTransactionOperationResult {
	transactionId: string;
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	idempotentReplay: boolean;
}

export interface CanonicalTransactionReadModel {
	transactionId: string;
	kind: string;
	status: "ACTIVE" | "VOIDED";
	revisionNo: number;
	occurredAt: Date;
	payload: Record<string, unknown>;
	createdAt: Date;
	latestRevisionCreatedAt: Date;
}

export interface CanonicalTransactionRevisionItem {
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE" | "VOID";
	occurredAt: Date;
	payload: Record<string, unknown>;
	reasonCode: string | null;
	reasonNote: string | null;
	createdAt: Date;
}

export interface CanonicalTransactionSourceItem {
	sourceId: string;
	revisionId: string;
	sourceType: string;
	sourceRef: string | null;
	sourcePayloadHash: string | null;
	observedAt: Date | null;
	createdAt: Date;
}

const KIND_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SOURCE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isSourceConflictError(err: unknown): boolean {
	if (!err) return false;
	const msg = `${String(err)} ${(err as { cause?: Error })?.cause?.message ?? ""}`;
	return msg.includes("transaction_sources_user_type_ref_idx");
}

function normalizeKind(kind: string): string {
	const trimmed = kind?.trim().toUpperCase();
	if (!trimmed || !KIND_PATTERN.test(trimmed)) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			`Invalid transaction kind: "${kind}". Must match /^[A-Z][A-Z0-9_]{0,63}$/`,
		);
	}
	return trimmed;
}

function normalizeIdempotencyKey(key: string): string {
	const trimmed = key?.trim();
	if (!trimmed || trimmed.length < 1 || trimmed.length > 128) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Idempotency key must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

function normalizeReasonCode(code: string): string {
	const trimmed = code?.trim().toUpperCase();
	if (!trimmed || !REASON_PATTERN.test(trimmed)) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			`Invalid reason code: "${code}". Must match /^[A-Z][A-Z0-9_]{0,63}$/`,
		);
	}
	return trimmed;
}

function normalizeReasonNote(note?: string | null): string | null {
	if (note === undefined || note === null) {
		return null;
	}
	const trimmed = note.trim();
	if (trimmed.length > 500) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Reason note must not exceed 500 characters",
		);
	}
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSource(source: TransactionSourceInput): {
	descriptor: NormalizedSourceDescriptor;
	dbValues: {
		sourceType: string;
		sourceRef: string | null;
		sourcePayloadHash: string | null;
		observedAt: Date | null;
	};
} {
	if (!source) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Source descriptor is required for transaction auditing",
		);
	}

	const sourceType = source.type?.trim().toUpperCase();
	if (!sourceType || !SOURCE_TYPE_PATTERN.test(sourceType)) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			`Invalid source type: "${source.type}". Must match /^[A-Z][A-Z0-9_]{0,63}$/`,
		);
	}

	let sourceRef: string | null = null;
	if (source.ref !== undefined && source.ref !== null) {
		const trimmedRef = source.ref.trim();
		if (trimmedRef.length < 1 || trimmedRef.length > 256) {
			throw new CanonicalTransactionError(
				"TRANSACTION_INVALID_INPUT",
				"source.ref must be between 1 and 256 characters if provided",
			);
		}
		sourceRef = trimmedRef;
	}

	let sourcePayloadHash: string | null = null;
	if (source.payloadHash !== undefined && source.payloadHash !== null) {
		const trimmedHash = source.payloadHash.trim().toLowerCase();
		if (!HASH_PATTERN.test(trimmedHash)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_INVALID_INPUT",
				"source.payloadHash must be a 64 lowercase hex string",
			);
		}
		sourcePayloadHash = trimmedHash;
	}

	let observedAt: Date | null = null;
	if (source.observedAt !== undefined && source.observedAt !== null) {
		if (
			!(source.observedAt instanceof Date) ||
			Number.isNaN(source.observedAt.getTime())
		) {
			throw new CanonicalTransactionError(
				"TRANSACTION_INVALID_INPUT",
				"source.observedAt must be a valid Date object if provided",
			);
		}
		observedAt = source.observedAt;
	}

	return {
		descriptor: {
			type: sourceType,
			ref: sourceRef,
			payloadHash: sourcePayloadHash,
			observedAt: observedAt ? observedAt.toISOString() : null,
		},
		dbValues: {
			sourceType,
			sourceRef,
			sourcePayloadHash,
			observedAt,
		},
	};
}

function validateInitialRevisionReplay({
	rev1,
	expectedNormalizedKey,
	expectedFingerprint,
}: {
	rev1:
		| {
				id: string;
				revisionNo: number;
				operation: string;
				idempotencyKey: string;
				revisionFingerprint: string;
		  }
		| undefined;
	expectedNormalizedKey: string;
	expectedFingerprint: string;
}): { id: string; revisionNo: number } {
	if (!rev1) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"Canonical transaction exists but revision #1 is missing",
		);
	}

	if (
		rev1.revisionNo !== 1 ||
		rev1.operation !== "CREATE" ||
		rev1.idempotencyKey !== expectedNormalizedKey ||
		rev1.revisionFingerprint !== expectedFingerprint
	) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"Canonical transaction revision #1 state or cryptographic fingerprint is inconsistent with canonical creation identity",
		);
	}

	return { id: rev1.id, revisionNo: rev1.revisionNo };
}

/**
 * Internal transaction-scoped helper for creating a canonical transaction within an existing PostgreSQL transaction.
 * Does NOT initiate a new db.transaction().
 */
export async function createCanonicalTransactionInTransaction({
	tx,
	userId,
	kind,
	idempotencyKey,
	occurredAt,
	payload,
	source,
}: CreateCanonicalTransactionInTransactionParams): Promise<CanonicalTransactionOperationResult> {
	if (!userId || userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}

	const normalizedKind = normalizeKind(kind);
	const normalizedKey = normalizeIdempotencyKey(idempotencyKey);

	if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Valid occurredAt Date is required",
		);
	}

	const { canonicalObject } = canonicalizePayload(payload);
	const { descriptor: sourceDescriptor, dbValues: sourceDbValues } =
		normalizeSource(source);

	const fingerprint = await calculateRevisionFingerprint({
		operation: "CREATE",
		userId,
		kind: normalizedKind,
		occurredAt,
		payload: canonicalObject,
		source: sourceDescriptor,
	});

	// 1. Early idempotency check on canonical_transactions
	const [existingTx] = await tx
		.select({
			id: canonicalTransactions.id,
			creationFingerprint: canonicalTransactions.creationFingerprint,
		})
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.userId, userId),
				eq(canonicalTransactions.creationIdempotencyKey, normalizedKey),
			),
		)
		.limit(1);

	if (existingTx) {
		if (existingTx.creationFingerprint !== fingerprint) {
			throw new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Creation idempotency key was already used with a different transaction payload or source",
			);
		}

		const [rev1] = await tx
			.select({
				id: transactionRevisions.id,
				revisionNo: transactionRevisions.revisionNo,
				operation: transactionRevisions.operation,
				idempotencyKey: transactionRevisions.idempotencyKey,
				revisionFingerprint: transactionRevisions.revisionFingerprint,
			})
			.from(transactionRevisions)
			.where(
				and(
					eq(transactionRevisions.transactionId, existingTx.id),
					eq(transactionRevisions.revisionNo, 1),
				),
			)
			.limit(1);

		const validatedRev1 = validateInitialRevisionReplay({
			rev1,
			expectedNormalizedKey: normalizedKey,
			expectedFingerprint: existingTx.creationFingerprint,
		});

		return {
			transactionId: existingTx.id,
			revisionId: validatedRev1.id,
			revisionNo: 1,
			operation: "CREATE",
			idempotentReplay: true,
		};
	}

	// 2. Insert canonical identity row with race-safe ON CONFLICT DO NOTHING
	const [insertedTx] = await tx
		.insert(canonicalTransactions)
		.values({
			userId,
			kind: normalizedKind,
			creationIdempotencyKey: normalizedKey,
			creationFingerprint: fingerprint,
		})
		.onConflictDoNothing({
			target: [
				canonicalTransactions.userId,
				canonicalTransactions.creationIdempotencyKey,
			],
		})
		.returning();

	if (!insertedTx) {
		// Concurrent race inserted canonical identity
		const [existingLateTx] = await tx
			.select({
				id: canonicalTransactions.id,
				creationFingerprint: canonicalTransactions.creationFingerprint,
			})
			.from(canonicalTransactions)
			.where(
				and(
					eq(canonicalTransactions.userId, userId),
					eq(canonicalTransactions.creationIdempotencyKey, normalizedKey),
				),
			)
			.limit(1);

		if (!existingLateTx) {
			throw new CanonicalTransactionError(
				"TRANSACTION_INVALID_STATE",
				"Failed to retrieve canonical transaction identity after conflict",
			);
		}

		if (existingLateTx.creationFingerprint !== fingerprint) {
			throw new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Creation idempotency key was already used with a different transaction payload or source",
			);
		}

		const [rev1] = await tx
			.select({
				id: transactionRevisions.id,
				revisionNo: transactionRevisions.revisionNo,
				operation: transactionRevisions.operation,
				idempotencyKey: transactionRevisions.idempotencyKey,
				revisionFingerprint: transactionRevisions.revisionFingerprint,
			})
			.from(transactionRevisions)
			.where(
				and(
					eq(transactionRevisions.transactionId, existingLateTx.id),
					eq(transactionRevisions.revisionNo, 1),
				),
			)
			.limit(1);

		const validatedRev1 = validateInitialRevisionReplay({
			rev1,
			expectedNormalizedKey: normalizedKey,
			expectedFingerprint: existingLateTx.creationFingerprint,
		});

		return {
			transactionId: existingLateTx.id,
			revisionId: validatedRev1.id,
			revisionNo: 1,
			operation: "CREATE",
			idempotentReplay: true,
		};
	}

	// 3. Insert initial revision #1 (CREATE)
	const [insertedRev] = await tx
		.insert(transactionRevisions)
		.values({
			userId,
			transactionId: insertedTx.id,
			revisionNo: 1,
			previousRevisionId: null,
			operation: "CREATE",
			occurredAt,
			payload: canonicalObject,
			revisionFingerprint: fingerprint,
			idempotencyKey: normalizedKey,
			reasonCode: null,
			reasonNote: null,
		})
		.returning();

	if (!insertedRev) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"Failed to insert initial transaction revision #1",
		);
	}

	// 4. Insert initial provenance record
	try {
		await tx.insert(transactionSources).values({
			userId,
			transactionId: insertedTx.id,
			revisionId: insertedRev.id,
			sourceType: sourceDbValues.sourceType,
			sourceRef: sourceDbValues.sourceRef,
			sourcePayloadHash: sourceDbValues.sourcePayloadHash,
			observedAt: sourceDbValues.observedAt,
		});
	} catch (sourceErr) {
		if (isSourceConflictError(sourceErr)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_SOURCE_CONFLICT",
				`External source reference "${sourceDbValues.sourceRef}" is already associated with another transaction for this user`,
			);
		}
		throw sourceErr;
	}

	return {
		transactionId: insertedTx.id,
		revisionId: insertedRev.id,
		revisionNo: 1,
		operation: "CREATE",
		idempotentReplay: false,
	};
}

/**
 * Creates a new canonical transaction with initial revision #1 (CREATE) and source provenance record.
 * Future financial domain modules must use bound ledger lifecycle orchestration.
 * Raw canonical services do not create accounting effects.
 */
export async function createCanonicalTransaction(
	params: CreateCanonicalTransactionParams,
): Promise<CanonicalTransactionOperationResult> {
	if (!params.userId || params.userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}
	normalizeKind(params.kind);
	normalizeIdempotencyKey(params.idempotencyKey);
	if (
		!(params.occurredAt instanceof Date) ||
		Number.isNaN(params.occurredAt.getTime())
	) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Valid occurredAt Date is required",
		);
	}
	canonicalizePayload(params.payload);
	normalizeSource(params.source);

	return await params.db.transaction(async (tx) => {
		return await createCanonicalTransactionInTransaction({
			tx,
			userId: params.userId,
			kind: params.kind,
			idempotencyKey: params.idempotencyKey,
			occurredAt: params.occurredAt,
			payload: params.payload,
			source: params.source,
		});
	});
}

/**
 * Internal transaction-scoped helper for appending an UPDATE revision within an existing PostgreSQL transaction.
 * Does NOT initiate a new db.transaction().
 */
export async function reviseCanonicalTransactionInTransaction({
	tx,
	userId,
	transactionId,
	expectedRevisionNo,
	idempotencyKey,
	occurredAt,
	payload,
	reasonCode,
	reasonNote,
	source,
}: ReviseCanonicalTransactionInTransactionParams): Promise<CanonicalTransactionOperationResult> {
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

	if (!Number.isSafeInteger(expectedRevisionNo) || expectedRevisionNo < 1) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer >= 1",
		);
	}

	const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
	const normalizedReasonCode = normalizeReasonCode(reasonCode);
	const normalizedReasonNote = normalizeReasonNote(reasonNote);

	if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Valid occurredAt Date is required",
		);
	}

	const { canonicalObject } = canonicalizePayload(payload);
	const { descriptor: sourceDescriptor, dbValues: sourceDbValues } =
		normalizeSource(source);

	// 1. Early idempotency replay check
	const [existingRev] = await tx
		.select({
			id: transactionRevisions.id,
			transactionId: transactionRevisions.transactionId,
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
			revisionFingerprint: transactionRevisions.revisionFingerprint,
		})
		.from(transactionRevisions)
		.where(
			and(
				eq(transactionRevisions.userId, userId),
				eq(transactionRevisions.idempotencyKey, normalizedKey),
			),
		)
		.limit(1);

	if (existingRev) {
		if (
			existingRev.transactionId !== trimmedTxId ||
			existingRev.operation !== "UPDATE"
		) {
			throw new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Idempotency key was used for a different transaction or operation",
			);
		}

		// Fetch parent kind to compute candidate fingerprint
		const [parentTx] = await tx
			.select({ kind: canonicalTransactions.kind })
			.from(canonicalTransactions)
			.where(eq(canonicalTransactions.id, trimmedTxId))
			.limit(1);

		const candidateFingerprint = await calculateRevisionFingerprint({
			operation: "UPDATE",
			userId,
			transactionId: trimmedTxId,
			kind: parentTx?.kind ?? "",
			occurredAt,
			payload: canonicalObject,
			reasonCode: normalizedReasonCode,
			reasonNote: normalizedReasonNote,
			source: sourceDescriptor,
		});

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with a different update payload or reason",
			);
		}

		return {
			transactionId: trimmedTxId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: "UPDATE",
			idempotentReplay: true,
		};
	}

	// 2. Lock parent canonical transaction FOR UPDATE
	const [parentTx] = await tx
		.select({
			id: canonicalTransactions.id,
			userId: canonicalTransactions.userId,
			kind: canonicalTransactions.kind,
		})
		.from(canonicalTransactions)
		.where(eq(canonicalTransactions.id, trimmedTxId))
		.for("update")
		.limit(1);

	if (!parentTx || parentTx.userId !== userId) {
		throw new CanonicalTransactionError(
			"TRANSACTION_NOT_FOUND",
			`Canonical transaction "${trimmedTxId}" not found for this user`,
		);
	}

	// 3. Inspect current latest revision
	const [trueLatest] = await tx
		.select({
			id: transactionRevisions.id,
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
		})
		.from(transactionRevisions)
		.where(eq(transactionRevisions.transactionId, trimmedTxId))
		.orderBy(desc(transactionRevisions.revisionNo))
		.limit(1);

	if (!trueLatest) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"No existing revisions found for transaction",
		);
	}

	if (trueLatest.operation === "VOID") {
		throw new CanonicalTransactionError(
			"TRANSACTION_ALREADY_VOIDED",
			`Cannot update transaction "${trimmedTxId}" because it has been permanently voided`,
		);
	}

	if (trueLatest.revisionNo !== expectedRevisionNo) {
		throw new CanonicalTransactionError(
			"TRANSACTION_REVISION_CONFLICT",
			`Optimistic concurrency conflict: expected revision ${expectedRevisionNo}, but current revision is ${trueLatest.revisionNo}`,
		);
	}

	// 4. Calculate fingerprint
	const fingerprint = await calculateRevisionFingerprint({
		operation: "UPDATE",
		userId,
		transactionId: trimmedTxId,
		kind: parentTx.kind,
		occurredAt,
		payload: canonicalObject,
		reasonCode: normalizedReasonCode,
		reasonNote: normalizedReasonNote,
		source: sourceDescriptor,
	});

	// 5. Insert revision
	const [newRev] = await tx
		.insert(transactionRevisions)
		.values({
			userId,
			transactionId: trimmedTxId,
			revisionNo: trueLatest.revisionNo + 1,
			previousRevisionId: trueLatest.id,
			operation: "UPDATE",
			occurredAt,
			payload: canonicalObject,
			revisionFingerprint: fingerprint,
			idempotencyKey: normalizedKey,
			reasonCode: normalizedReasonCode,
			reasonNote: normalizedReasonNote,
		})
		.returning();

	if (!newRev) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"Failed to insert update revision",
		);
	}

	// 6. Insert source record
	try {
		await tx.insert(transactionSources).values({
			userId,
			transactionId: trimmedTxId,
			revisionId: newRev.id,
			sourceType: sourceDbValues.sourceType,
			sourceRef: sourceDbValues.sourceRef,
			sourcePayloadHash: sourceDbValues.sourcePayloadHash,
			observedAt: sourceDbValues.observedAt,
		});
	} catch (sourceErr) {
		if (isSourceConflictError(sourceErr)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_SOURCE_CONFLICT",
				`External source reference "${sourceDbValues.sourceRef}" is already associated with another transaction for this user`,
			);
		}
		throw sourceErr;
	}

	return {
		transactionId: trimmedTxId,
		revisionId: newRev.id,
		revisionNo: newRev.revisionNo,
		operation: "UPDATE",
		idempotentReplay: false,
	};
}

/**
 * Appends an UPDATE revision to an existing canonical transaction with optimistic concurrency check.
 * Future financial domain modules must use bound ledger lifecycle orchestration.
 * Raw canonical services do not create accounting effects.
 */
export async function reviseCanonicalTransaction(
	params: ReviseCanonicalTransactionParams,
): Promise<CanonicalTransactionOperationResult> {
	if (!params.userId || params.userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}
	const trimmedTxId = params.transactionId?.trim();
	if (!trimmedTxId) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Transaction ID is required",
		);
	}
	if (
		!Number.isSafeInteger(params.expectedRevisionNo) ||
		params.expectedRevisionNo < 1
	) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer >= 1",
		);
	}
	normalizeIdempotencyKey(params.idempotencyKey);
	normalizeReasonCode(params.reasonCode);
	normalizeReasonNote(params.reasonNote);
	if (
		!(params.occurredAt instanceof Date) ||
		Number.isNaN(params.occurredAt.getTime())
	) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Valid occurredAt Date is required",
		);
	}
	canonicalizePayload(params.payload);
	normalizeSource(params.source);

	return await params.db.transaction(async (tx) => {
		return await reviseCanonicalTransactionInTransaction({
			tx,
			userId: params.userId,
			transactionId: params.transactionId,
			expectedRevisionNo: params.expectedRevisionNo,
			idempotencyKey: params.idempotencyKey,
			occurredAt: params.occurredAt,
			payload: params.payload,
			reasonCode: params.reasonCode,
			reasonNote: params.reasonNote,
			source: params.source,
		});
	});
}

/**
 * Internal transaction-scoped helper for appending a VOID revision within an existing PostgreSQL transaction.
 * Does NOT initiate a new db.transaction().
 */
export async function voidCanonicalTransactionInTransaction({
	tx,
	userId,
	transactionId,
	expectedRevisionNo,
	idempotencyKey,
	reasonCode,
	reasonNote,
	source,
}: VoidCanonicalTransactionInTransactionParams): Promise<CanonicalTransactionOperationResult> {
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

	if (!Number.isSafeInteger(expectedRevisionNo) || expectedRevisionNo < 1) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer >= 1",
		);
	}

	const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
	const normalizedReasonCode = normalizeReasonCode(reasonCode);
	const normalizedReasonNote = normalizeReasonNote(reasonNote);
	const { descriptor: sourceDescriptor, dbValues: sourceDbValues } =
		normalizeSource(source);

	// 1. Early idempotency replay check
	const [existingRev] = await tx
		.select({
			id: transactionRevisions.id,
			transactionId: transactionRevisions.transactionId,
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
			revisionFingerprint: transactionRevisions.revisionFingerprint,
		})
		.from(transactionRevisions)
		.where(
			and(
				eq(transactionRevisions.userId, userId),
				eq(transactionRevisions.idempotencyKey, normalizedKey),
			),
		)
		.limit(1);

	if (existingRev) {
		if (
			existingRev.transactionId !== trimmedTxId ||
			existingRev.operation !== "VOID"
		) {
			throw new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Idempotency key was used for a different transaction or operation",
			);
		}

		const [parentTx] = await tx
			.select({ kind: canonicalTransactions.kind })
			.from(canonicalTransactions)
			.where(eq(canonicalTransactions.id, trimmedTxId))
			.limit(1);

		// Load the previous revision to compute candidate fingerprint
		const [prevRev] = await tx
			.select({
				occurredAt: transactionRevisions.occurredAt,
				payload: transactionRevisions.payload,
			})
			.from(transactionRevisions)
			.where(
				and(
					eq(transactionRevisions.transactionId, trimmedTxId),
					eq(transactionRevisions.revisionNo, existingRev.revisionNo - 1),
				),
			)
			.limit(1);

		const candidateFingerprint = await calculateRevisionFingerprint({
			operation: "VOID",
			userId,
			transactionId: trimmedTxId,
			kind: parentTx?.kind ?? "",
			occurredAt: prevRev?.occurredAt ?? new Date(),
			payload: (prevRev?.payload as Record<string, unknown>) ?? {},
			reasonCode: normalizedReasonCode,
			reasonNote: normalizedReasonNote,
			source: sourceDescriptor,
		});

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with a different void reason or source",
			);
		}

		return {
			transactionId: trimmedTxId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: "VOID",
			idempotentReplay: true,
		};
	}

	// 2. Lock parent canonical transaction FOR UPDATE
	const [parentTx] = await tx
		.select({
			id: canonicalTransactions.id,
			userId: canonicalTransactions.userId,
			kind: canonicalTransactions.kind,
		})
		.from(canonicalTransactions)
		.where(eq(canonicalTransactions.id, trimmedTxId))
		.for("update")
		.limit(1);

	if (!parentTx || parentTx.userId !== userId) {
		throw new CanonicalTransactionError(
			"TRANSACTION_NOT_FOUND",
			`Canonical transaction "${trimmedTxId}" not found for this user`,
		);
	}

	// 3. Inspect current latest revision
	const [trueLatest] = await tx
		.select({
			id: transactionRevisions.id,
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
			occurredAt: transactionRevisions.occurredAt,
			payload: transactionRevisions.payload,
		})
		.from(transactionRevisions)
		.where(eq(transactionRevisions.transactionId, trimmedTxId))
		.orderBy(desc(transactionRevisions.revisionNo))
		.limit(1);

	if (!trueLatest) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"No existing revisions found for transaction",
		);
	}

	if (trueLatest.operation === "VOID") {
		throw new CanonicalTransactionError(
			"TRANSACTION_ALREADY_VOIDED",
			`Transaction "${trimmedTxId}" has already been voided`,
		);
	}

	if (trueLatest.revisionNo !== expectedRevisionNo) {
		throw new CanonicalTransactionError(
			"TRANSACTION_REVISION_CONFLICT",
			`Optimistic concurrency conflict: expected revision ${expectedRevisionNo}, but current revision is ${trueLatest.revisionNo}`,
		);
	}

	// 4. Calculate VOID fingerprint using exact previous snapshot
	const fingerprint = await calculateRevisionFingerprint({
		operation: "VOID",
		userId,
		transactionId: trimmedTxId,
		kind: parentTx.kind,
		occurredAt: trueLatest.occurredAt,
		payload: trueLatest.payload as Record<string, unknown>,
		reasonCode: normalizedReasonCode,
		reasonNote: normalizedReasonNote,
		source: sourceDescriptor,
	});

	// 5. Insert VOID revision
	const [newRev] = await tx
		.insert(transactionRevisions)
		.values({
			userId,
			transactionId: trimmedTxId,
			revisionNo: trueLatest.revisionNo + 1,
			previousRevisionId: trueLatest.id,
			operation: "VOID",
			occurredAt: trueLatest.occurredAt,
			payload: trueLatest.payload,
			revisionFingerprint: fingerprint,
			idempotencyKey: normalizedKey,
			reasonCode: normalizedReasonCode,
			reasonNote: normalizedReasonNote,
		})
		.returning();

	if (!newRev) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"Failed to insert void revision",
		);
	}

	// 6. Insert provenance
	try {
		await tx.insert(transactionSources).values({
			userId,
			transactionId: trimmedTxId,
			revisionId: newRev.id,
			sourceType: sourceDbValues.sourceType,
			sourceRef: sourceDbValues.sourceRef,
			sourcePayloadHash: sourceDbValues.sourcePayloadHash,
			observedAt: sourceDbValues.observedAt,
		});
	} catch (sourceErr) {
		if (isSourceConflictError(sourceErr)) {
			throw new CanonicalTransactionError(
				"TRANSACTION_SOURCE_CONFLICT",
				`External source reference "${sourceDbValues.sourceRef}" is already associated with another transaction for this user`,
			);
		}
		throw sourceErr;
	}

	return {
		transactionId: trimmedTxId,
		revisionId: newRev.id,
		revisionNo: newRev.revisionNo,
		operation: "VOID",
		idempotentReplay: false,
	};
}

/**
 * Appends a terminal VOID revision to an existing canonical transaction.
 * Copies the last known domain payload and occurrence timestamp exactly.
 * Future financial domain modules must use bound ledger lifecycle orchestration.
 * Raw canonical services do not create accounting effects.
 */
export async function voidCanonicalTransaction(
	params: VoidCanonicalTransactionParams,
): Promise<CanonicalTransactionOperationResult> {
	if (!params.userId || params.userId.trim() === "") {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"User ID is required",
		);
	}
	const trimmedTxId = params.transactionId?.trim();
	if (!trimmedTxId) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"Transaction ID is required",
		);
	}
	if (
		!Number.isSafeInteger(params.expectedRevisionNo) ||
		params.expectedRevisionNo < 1
	) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer >= 1",
		);
	}
	normalizeIdempotencyKey(params.idempotencyKey);
	normalizeReasonCode(params.reasonCode);
	normalizeReasonNote(params.reasonNote);
	normalizeSource(params.source);

	return await params.db.transaction(async (tx) => {
		return await voidCanonicalTransactionInTransaction({
			tx,
			userId: params.userId,
			transactionId: params.transactionId,
			expectedRevisionNo: params.expectedRevisionNo,
			idempotencyKey: params.idempotencyKey,
			reasonCode: params.reasonCode,
			reasonNote: params.reasonNote,
			source: params.source,
		});
	});
}

/**
 * Retrieves the current state of a canonical transaction.
 */
export async function getCanonicalTransaction({
	db,
	userId,
	transactionId,
}: {
	db: Database;
	userId: string;
	transactionId: string;
}): Promise<CanonicalTransactionReadModel> {
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

	const [txRow] = await db
		.select({
			id: canonicalTransactions.id,
			kind: canonicalTransactions.kind,
			createdAt: canonicalTransactions.createdAt,
		})
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

	const [latest] = await db
		.select({
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
			occurredAt: transactionRevisions.occurredAt,
			payload: transactionRevisions.payload,
			createdAt: transactionRevisions.createdAt,
		})
		.from(transactionRevisions)
		.where(eq(transactionRevisions.transactionId, trimmedTxId))
		.orderBy(desc(transactionRevisions.revisionNo))
		.limit(1);

	if (!latest) {
		throw new CanonicalTransactionError(
			"TRANSACTION_INVALID_STATE",
			"Transaction has no revisions",
		);
	}

	return {
		transactionId: txRow.id,
		kind: txRow.kind,
		status: latest.operation === "VOID" ? "VOIDED" : "ACTIVE",
		revisionNo: latest.revisionNo,
		occurredAt: latest.occurredAt,
		payload: latest.payload as Record<string, unknown>,
		createdAt: txRow.createdAt,
		latestRevisionCreatedAt: latest.createdAt,
	};
}

/**
 * Lists all audit revisions for a canonical transaction in chronological order (revision_no ASC).
 */
export async function listCanonicalTransactionRevisions({
	db,
	userId,
	transactionId,
}: {
	db: Database;
	userId: string;
	transactionId: string;
}): Promise<CanonicalTransactionRevisionItem[]> {
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

	const rows = await db
		.select({
			revisionId: transactionRevisions.id,
			revisionNo: transactionRevisions.revisionNo,
			operation: transactionRevisions.operation,
			occurredAt: transactionRevisions.occurredAt,
			payload: transactionRevisions.payload,
			reasonCode: transactionRevisions.reasonCode,
			reasonNote: transactionRevisions.reasonNote,
			createdAt: transactionRevisions.createdAt,
		})
		.from(transactionRevisions)
		.where(eq(transactionRevisions.transactionId, trimmedTxId))
		.orderBy(transactionRevisions.revisionNo);

	return rows.map((r) => ({
		revisionId: r.revisionId,
		revisionNo: r.revisionNo,
		operation: r.operation as "CREATE" | "UPDATE" | "VOID",
		occurredAt: r.occurredAt,
		payload: r.payload as Record<string, unknown>,
		reasonCode: r.reasonCode,
		reasonNote: r.reasonNote,
		createdAt: r.createdAt,
	}));
}

/**
 * Lists all provenance records for a canonical transaction in chronological creation order.
 */
export async function listCanonicalTransactionSources({
	db,
	userId,
	transactionId,
}: {
	db: Database;
	userId: string;
	transactionId: string;
}): Promise<CanonicalTransactionSourceItem[]> {
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

	const rows = await db
		.select({
			sourceId: transactionSources.id,
			revisionId: transactionSources.revisionId,
			sourceType: transactionSources.sourceType,
			sourceRef: transactionSources.sourceRef,
			sourcePayloadHash: transactionSources.sourcePayloadHash,
			observedAt: transactionSources.observedAt,
			createdAt: transactionSources.createdAt,
		})
		.from(transactionSources)
		.where(eq(transactionSources.transactionId, trimmedTxId))
		.orderBy(transactionSources.createdAt, transactionSources.id);

	return rows.map((s) => ({
		sourceId: s.sourceId,
		revisionId: s.revisionId,
		sourceType: s.sourceType,
		sourceRef: s.sourceRef,
		sourcePayloadHash: s.sourcePayloadHash,
		observedAt: s.observedAt,
		createdAt: s.createdAt,
	}));
}
