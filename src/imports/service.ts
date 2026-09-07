import { and, desc, eq, sql } from "drizzle-orm";
import { recordCreditCardPurchaseInTransaction } from "../credit-cards/purchases";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	type ImportDuplicateCandidateType,
	type ImportDuplicateReasonCode,
	type ImportRecordType,
	type ImportResultKind,
	type ImportResultTargetType,
	type ImportRowStatus,
	type ImportSourceKind,
	importBatches,
	importDuplicateCandidates,
	importExternalIdentityClaims,
	importMutationIdempotencyReceipts,
	importRowResults,
	importRowRevisions,
	importRows,
} from "../db/schema/imports";
import { incomeReceiptRevisions, incomeReceipts } from "../db/schema/income";
import { createIncomeReceiptInTransaction } from "../income/receipts";
import { withImportTransaction } from "./boundary";
import { analyzeDuplicatesAgainstDb } from "./dedup";
import { ImportError } from "./errors";
import {
	computeApplyRequestFingerprint,
	computeChildIdempotencyKey,
	computeResolveRequestFingerprint,
	computeRevisionFingerprint,
	computeSourceContentHash,
} from "./fingerprint";
import {
	isValidUuid,
	MAX_IMPORT_BATCH_ROWS,
	type NormalizedCardPurchasePayload,
	type NormalizedImportPayload,
	type NormalizedIncomeReceiptPayload,
	normalizeImportRow,
	type RawImportRowInput,
	validateAndNormalizeBatchMeta,
} from "./normalize";

export interface StageImportBatchParams {
	userId: string;
	provider: string;
	sourceKind: ImportSourceKind;
	sourceContent?: string | Uint8Array | undefined;
	sourceContentHash?: string | undefined;
	sourceFileName?: string | null | undefined;
	parserType: string;
	parserVersion: string;
	observedAt: Date;
	rows: RawImportRowInput[];
}

export interface ImportBatchSummary {
	id: string;
	userId: string;
	provider: string;
	sourceKind: ImportSourceKind;
	sourceContentHash: string;
	sourceFileName: string | null;
	parserType: string;
	parserVersion: string;
	observedAt: Date;
	createdAt: Date;
	totalRows: number;
	readyCount: number;
	needsReviewCount: number;
	possibleDuplicateCount: number;
	exactDuplicateCount: number;
	appliedCount: number;
	linkedCount: number;
	skippedCount: number;
	unsupportedCount: number;
}

export interface ImportRowDetail {
	id: string;
	userId: string;
	batchId: string;
	rowOrdinal: number;
	recordType: ImportRecordType;
	latestRevisionNo: number;
	status: ImportRowStatus;
	payload: NormalizedImportPayload;
	occurredAt: Date | null;
	externalIdentityPresent: boolean;
	duplicateCandidates: Array<{
		candidateType: ImportDuplicateCandidateType;
		candidateId: string;
		reasonCode: ImportDuplicateReasonCode;
	}>;
	result?:
		| {
				resultKind: ImportResultKind;
				targetType: ImportResultTargetType;
				targetId: string;
				canonicalTransactionId: string | null;
				externalIdentityClaimId?: string | null | undefined;
		  }
		| null
		| undefined;
}

export interface ResolveImportRowParams {
	userId: string;
	importRowId: string;
	expectedRevisionNo: number;
	action: "CONFIRM_IMPORT" | "LINK_EXISTING" | "RESOLVE_MAPPINGS" | "SKIP";
	resolvedMappings?: {
		cardId?: string | null | undefined;
		purchaseCategory?:
			| "MANDATORY"
			| "DISCRETIONARY"
			| "SHORT_TERM_PURCHASE"
			| "UNCLASSIFIED"
			| null
			| undefined;
		shortTermGoalId?: string | null | undefined;
		incomeSourceId?: string | null | undefined;
		destinationAccountId?: string | null | undefined;
	};
	linkTarget?: {
		targetType: ImportResultTargetType;
		targetId: string;
	};
	reasonNote?: string | null | undefined;
	idempotencyKey: string;
}

export interface ApplyImportRowParams {
	userId: string;
	importRowId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
}

/**
 * Builds the read model for a specific historical revision and its associated result.
 */
export async function buildImportRowReadModelForRevisionInTransaction(
	tx: DatabaseTransaction,
	importRowId: string,
	revisionId: string,
): Promise<ImportRowDetail> {
	const [row] = await tx
		.select()
		.from(importRows)
		.where(eq(importRows.id, importRowId))
		.limit(1);

	if (!row) {
		throw new ImportError("IMPORT_ROW_NOT_FOUND", "Import row not found");
	}

	const [rev] = await tx
		.select()
		.from(importRowRevisions)
		.where(eq(importRowRevisions.id, revisionId))
		.limit(1);

	if (!rev) {
		throw new ImportError(
			"IMPORT_REVISION_CONFLICT",
			"Historical revision not found",
		);
	}

	if (rev.importRowId !== importRowId) {
		throw new ImportError(
			"IMPORT_INVALID_STATE",
			"Revision does not belong to the requested import row",
		);
	}

	const candidates = await tx
		.select({
			candidateType: importDuplicateCandidates.candidateType,
			candidateId: importDuplicateCandidates.candidateId,
			reasonCode: importDuplicateCandidates.reasonCode,
		})
		.from(importDuplicateCandidates)
		.where(eq(importDuplicateCandidates.importRowId, importRowId));

	const isTerminalWithResult =
		rev.status === "APPLIED" ||
		rev.status === "LINKED_EXISTING" ||
		rev.status === "EXACT_DUPLICATE";

	let result: ImportRowDetail["result"] = null;
	if (isTerminalWithResult) {
		const [res] = await tx
			.select()
			.from(importRowResults)
			.where(eq(importRowResults.importRowId, importRowId))
			.limit(1);

		if (res) {
			result = {
				resultKind: res.resultKind as ImportResultKind,
				targetType: res.targetType as ImportResultTargetType,
				targetId: res.targetId,
				canonicalTransactionId: res.canonicalTransactionId,
				externalIdentityClaimId: res.externalIdentityClaimId,
			};
		}
	}

	return {
		id: row.id,
		userId: row.userId,
		batchId: row.batchId,
		rowOrdinal: row.rowOrdinal,
		recordType: row.recordType as ImportRecordType,
		latestRevisionNo: rev.revisionNo,
		status: rev.status as ImportRowStatus,
		payload: rev.payload as NormalizedImportPayload,
		occurredAt: rev.occurredAt,
		externalIdentityPresent: row.externalTransactionIdHash !== null,
		duplicateCandidates: candidates.map((c) => ({
			candidateType: c.candidateType as ImportDuplicateCandidateType,
			candidateId: c.candidateId,
			reasonCode: c.reasonCode as ImportDuplicateReasonCode,
		})),
		result,
	};
}

/**
 * Builds the latest read model for an import row.
 */
export async function buildImportRowReadModelInTransaction(
	tx: DatabaseTransaction,
	importRowId: string,
): Promise<ImportRowDetail> {
	const [row] = await tx
		.select()
		.from(importRows)
		.where(eq(importRows.id, importRowId))
		.limit(1);

	if (!row) {
		throw new ImportError("IMPORT_ROW_NOT_FOUND", "Import row not found");
	}

	const [latestRev] = await tx
		.select()
		.from(importRowRevisions)
		.where(eq(importRowRevisions.importRowId, importRowId))
		.orderBy(desc(importRowRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new ImportError(
			"IMPORT_INVALID_STATE",
			"Import row has no revisions",
		);
	}

	return await buildImportRowReadModelForRevisionInTransaction(
		tx,
		importRowId,
		latestRev.id,
	);
}

/**
 * Builds summary metrics for an import batch.
 */
export async function buildImportBatchSummaryInTransaction(
	tx: DatabaseTransaction,
	batchId: string,
): Promise<ImportBatchSummary> {
	const [batch] = await tx
		.select()
		.from(importBatches)
		.where(eq(importBatches.id, batchId))
		.limit(1);

	if (!batch) {
		throw new ImportError("IMPORT_BATCH_NOT_FOUND", "Import batch not found");
	}

	const latestRevsSubquery = tx
		.select({
			importRowId: importRowRevisions.importRowId,
			maxRevNo: sql<number>`max(${importRowRevisions.revisionNo})`.as(
				"max_rev_no",
			),
		})
		.from(importRowRevisions)
		.innerJoin(importRows, eq(importRowRevisions.importRowId, importRows.id))
		.where(eq(importRows.batchId, batchId))
		.groupBy(importRowRevisions.importRowId)
		.as("latest_row_revs");

	const statusRows = await tx
		.select({
			status: importRowRevisions.status,
		})
		.from(importRowRevisions)
		.innerJoin(
			latestRevsSubquery,
			and(
				eq(importRowRevisions.importRowId, latestRevsSubquery.importRowId),
				eq(importRowRevisions.revisionNo, latestRevsSubquery.maxRevNo),
			),
		);

	let readyCount = 0;
	let needsReviewCount = 0;
	let possibleDuplicateCount = 0;
	let exactDuplicateCount = 0;
	let appliedCount = 0;
	let linkedCount = 0;
	let skippedCount = 0;
	let unsupportedCount = 0;

	for (const r of statusRows) {
		switch (r.status) {
			case "READY":
				readyCount++;
				break;
			case "NEEDS_REVIEW":
				needsReviewCount++;
				break;
			case "POSSIBLE_DUPLICATE":
				possibleDuplicateCount++;
				break;
			case "EXACT_DUPLICATE":
				exactDuplicateCount++;
				break;
			case "APPLIED":
				appliedCount++;
				break;
			case "LINKED_EXISTING":
				linkedCount++;
				break;
			case "SKIPPED":
				skippedCount++;
				break;
			case "UNSUPPORTED":
				unsupportedCount++;
				break;
		}
	}

	return {
		id: batch.id,
		userId: batch.userId,
		provider: batch.provider,
		sourceKind: batch.sourceKind as ImportSourceKind,
		sourceContentHash: batch.sourceContentHash,
		sourceFileName: batch.sourceFileName,
		parserType: batch.parserType,
		parserVersion: batch.parserVersion,
		observedAt: batch.observedAt,
		createdAt: batch.createdAt,
		totalRows: statusRows.length,
		readyCount,
		needsReviewCount,
		possibleDuplicateCount,
		exactDuplicateCount,
		appliedCount,
		linkedCount,
		skippedCount,
		unsupportedCount,
	};
}

/**
 * Stages a new batch or returns an existing batch idempotently if already staged.
 */
export async function stageImportBatch(
	db: Database | DatabaseTransaction,
	params: StageImportBatchParams,
): Promise<{
	batch: ImportBatchSummary;
	rows: ImportRowDetail[];
	idempotentReplay: boolean;
}> {
	// Strict DB-independent validation BEFORE transaction
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new ImportError("IMPORT_INVALID_INPUT", "params must be an object");
	}
	if (
		params.sourceContent !== undefined &&
		params.sourceContent !== null &&
		typeof params.sourceContent !== "string"
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"sourceContent must be a string",
		);
	}
	if (
		params.sourceContentHash !== undefined &&
		params.sourceContentHash !== null &&
		typeof params.sourceContentHash !== "string"
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"sourceContentHash must be a string",
		);
	}
	if (params.sourceContent && params.sourceContentHash) {
		const computed = await computeSourceContentHash(params.sourceContent);
		if (computed !== params.sourceContentHash.trim().toLowerCase()) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"sourceContentHash does not match computed SHA-256 of sourceContent",
			);
		}
	}

	let contentHash = params.sourceContentHash;
	if (!contentHash && params.sourceContent) {
		contentHash = await computeSourceContentHash(params.sourceContent);
	}

	if (!contentHash) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"Either sourceContent or sourceContentHash is required",
		);
	}

	const meta = validateAndNormalizeBatchMeta({
		...params,
		sourceContentHash: contentHash,
	});

	if (!Array.isArray(params.rows)) {
		throw new ImportError("IMPORT_INVALID_INPUT", "rows must be an array");
	}

	if (params.rows.length > MAX_IMPORT_BATCH_ROWS) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Import batch exceeds maximum limit of ${MAX_IMPORT_BATCH_ROWS} rows (received ${params.rows.length})`,
		);
	}

	// Normalize all rows before DB
	const normalizedRows: ReturnType<typeof normalizeImportRow> extends Promise<
		infer R
	>
		? R[]
		: never = [];

	for (let i = 0; i < params.rows.length; i++) {
		const r = params.rows[i];
		if (!r) continue;
		normalizedRows.push(await normalizeImportRow(meta.validUserId, i, r));
	}

	return await withImportTransaction(db, async (tx) => {
		// 1. Conflict-safe batch insert
		await tx
			.insert(importBatches)
			.values({
				userId: meta.validUserId,
				provider: meta.validProvider,
				sourceKind: meta.validSourceKind,
				sourceContentHash: meta.validContentHash,
				sourceFileName: meta.validFileName,
				parserType: meta.validParserType,
				parserVersion: meta.validParserVersion,
				observedAt: meta.validObservedAt,
			})
			.onConflictDoNothing({
				target: [
					importBatches.userId,
					importBatches.provider,
					importBatches.sourceContentHash,
					importBatches.parserType,
					importBatches.parserVersion,
				],
			});

		// 2. Re-read batch identity
		const [batch] = await tx
			.select()
			.from(importBatches)
			.where(
				and(
					eq(importBatches.userId, meta.validUserId),
					eq(importBatches.provider, meta.validProvider),
					eq(importBatches.sourceContentHash, meta.validContentHash),
					eq(importBatches.parserType, meta.validParserType),
					eq(importBatches.parserVersion, meta.validParserVersion),
				),
			)
			.limit(1);

		if (!batch) {
			throw new ImportError(
				"IMPORT_DATABASE_ERROR",
				"Failed to retrieve import batch record",
			);
		}

		// Check if rows already exist for this batch
		const existingRows = await tx
			.select({ id: importRows.id })
			.from(importRows)
			.where(eq(importRows.batchId, batch.id))
			.limit(1);

		if (existingRows.length > 0) {
			const summary = await buildImportBatchSummaryInTransaction(tx, batch.id);
			const rowDetails = await listImportRowsInTransaction(tx, batch.id);
			return {
				batch: summary,
				rows: rowDetails,
				idempotentReplay: true,
			};
		}

		// 3. Fresh Staging: Run duplicate analysis against latest DB truth
		const dedupResult = await analyzeDuplicatesAgainstDb(
			tx,
			meta.validUserId,
			meta.validProvider,
			normalizedRows,
		);

		// Assign UUIDs for all rows upfront so intra-batch candidate IDs reference actual row UUIDs
		const rowIdByOrdinal = new Map<number, string>();
		for (const item of dedupResult.rowsWithStatus) {
			rowIdByOrdinal.set(item.row.rowOrdinal, crypto.randomUUID());
		}

		const stagedRowDetails: ImportRowDetail[] = [];

		for (const item of dedupResult.rowsWithStatus) {
			const rowId =
				rowIdByOrdinal.get(item.row.rowOrdinal) ?? crypto.randomUUID();
			const r = item.row;
			const finalStatus = item.finalStatus;

			// Insert row anchor
			await tx.insert(importRows).values({
				id: rowId,
				userId: meta.validUserId,
				batchId: batch.id,
				rowOrdinal: r.rowOrdinal,
				recordType: r.recordType,
				rawRowHash: r.rawRowHash,
				semanticFingerprint: r.semanticFingerprint,
				externalTransactionIdHash: r.externalTransactionIdHash,
			});

			let stagedResult:
				| {
						resultKind: ImportResultKind;
						targetType: ImportResultTargetType;
						targetId: string;
						canonicalTransactionId: string | null;
						externalIdentityClaimId?: string | null | undefined;
				  }
				| undefined;

			// If staged directly as EXACT_DUPLICATE, bind exact authoritative result & claim
			if (
				finalStatus === "EXACT_DUPLICATE" &&
				r.externalTransactionIdHash &&
				r.recordType !== "UNSUPPORTED"
			) {
				let scopeId: string | null = null;
				if (r.recordType === "CREDIT_CARD_PURCHASE") {
					scopeId = (r.payload as NormalizedCardPurchasePayload).cardId;
				} else if (r.recordType === "INCOME_RECEIPT") {
					scopeId = (r.payload as NormalizedIncomeReceiptPayload)
						.destinationAccountId;
				}

				if (scopeId) {
					const [existingClaim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, meta.validUserId),
								eq(importExternalIdentityClaims.provider, meta.validProvider),
								eq(importExternalIdentityClaims.recordType, r.recordType),
								eq(importExternalIdentityClaims.scopeId, scopeId),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									r.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (existingClaim) {
						const [ownerResult] = await tx
							.select()
							.from(importRowResults)
							.where(
								eq(importRowResults.importRowId, existingClaim.importRowId),
							)
							.limit(1);

						if (ownerResult) {
							await tx.insert(importRowResults).values({
								userId: meta.validUserId,
								importRowId: rowId,
								resultKind: "EXACT_DUPLICATE",
								targetType: ownerResult.targetType,
								targetId: ownerResult.targetId,
								canonicalTransactionId: ownerResult.canonicalTransactionId,
								externalIdentityClaimId: existingClaim.id,
							});

							stagedResult = {
								resultKind: "EXACT_DUPLICATE",
								targetType: ownerResult.targetType as ImportResultTargetType,
								targetId: ownerResult.targetId,
								canonicalTransactionId: ownerResult.canonicalTransactionId,
								externalIdentityClaimId: existingClaim.id,
							};
						}
					}
				}
			}

			// Insert initial revision (revision_no = 1, operation = STAGE)
			const revisionFingerprint = await computeRevisionFingerprint({
				importRowId: rowId,
				revisionNo: 1,
				operation: "STAGE",
				status: finalStatus,
				payload: r.payload,
			});

			await tx.insert(importRowRevisions).values({
				userId: meta.validUserId,
				importRowId: rowId,
				revisionNo: 1,
				operation: "STAGE",
				status: finalStatus,
				payload: r.payload,
				occurredAt: r.occurredAt,
				revisionFingerprint,
			});

			// Insert duplicate candidates
			const resolvedCandidates: ImportRowDetail["duplicateCandidates"] = [];
			for (const c of item.candidates) {
				const candidateTargetId =
					c.candidateType === "IMPORT_ROW" &&
					c.candidateRowOrdinal !== undefined
						? (rowIdByOrdinal.get(c.candidateRowOrdinal) ?? c.candidateId)
						: c.candidateId;

				await tx.insert(importDuplicateCandidates).values({
					userId: meta.validUserId,
					importRowId: rowId,
					candidateType: c.candidateType,
					candidateId: candidateTargetId,
					reasonCode: c.reasonCode,
				});

				resolvedCandidates.push({
					candidateType: c.candidateType,
					candidateId: candidateTargetId,
					reasonCode: c.reasonCode,
				});
			}

			stagedRowDetails.push({
				id: rowId,
				userId: meta.validUserId,
				batchId: batch.id,
				rowOrdinal: r.rowOrdinal,
				recordType: r.recordType,
				latestRevisionNo: 1,
				status: finalStatus,
				payload: r.payload,
				occurredAt: r.occurredAt,
				externalIdentityPresent: r.externalTransactionIdHash !== null,
				duplicateCandidates: resolvedCandidates,
				result: stagedResult,
			});
		}

		const summary = await buildImportBatchSummaryInTransaction(tx, batch.id);

		return {
			batch: summary,
			rows: stagedRowDetails,
			idempotentReplay: false,
		};
	});
}

/**
 * Resolves an import row through user review actions (CONFIRM_IMPORT, LINK_EXISTING, RESOLVE_MAPPINGS, SKIP).
 */
export async function resolveImportRow(
	db: Database | DatabaseTransaction,
	params: ResolveImportRowParams,
): Promise<{ row: ImportRowDetail; idempotentReplay: boolean }> {
	// 1. Strict validation before DB
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new ImportError("IMPORT_INVALID_INPUT", "params must be an object");
	}
	if (!isValidUuid(params.userId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid userId UUID is required",
		);
	}
	if (!isValidUuid(params.importRowId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid importRowId UUID is required",
		);
	}
	if (
		!params.idempotencyKey ||
		typeof params.idempotencyKey !== "string" ||
		params.idempotencyKey.trim().length === 0 ||
		params.idempotencyKey.trim().length > 128
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"idempotencyKey is required and must be between 1 and 128 characters",
		);
	}
	const validKey = params.idempotencyKey.trim();

	if (
		typeof params.expectedRevisionNo !== "number" ||
		!Number.isInteger(params.expectedRevisionNo) ||
		params.expectedRevisionNo < 1
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"expectedRevisionNo must be an integer >= 1",
		);
	}

	const allowedActions = [
		"CONFIRM_IMPORT",
		"LINK_EXISTING",
		"RESOLVE_MAPPINGS",
		"SKIP",
	];
	if (
		typeof params.action !== "string" ||
		!allowedActions.includes(params.action)
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			`Invalid action "${String(params.action)}". Must be CONFIRM_IMPORT, LINK_EXISTING, RESOLVE_MAPPINGS, or SKIP`,
		);
	}

	if (params.reasonNote !== undefined && params.reasonNote !== null) {
		if (typeof params.reasonNote !== "string") {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"reasonNote must be a string",
			);
		}
		if (params.reasonNote.trim().length > 500) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"reasonNote must not exceed 500 characters",
			);
		}
	}

	if (
		params.resolvedMappings !== undefined &&
		params.resolvedMappings !== null
	) {
		if (
			typeof params.resolvedMappings !== "object" ||
			Array.isArray(params.resolvedMappings)
		) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"resolvedMappings must be an object",
			);
		}
	}

	if (params.action === "LINK_EXISTING") {
		if (
			!params.linkTarget ||
			typeof params.linkTarget !== "object" ||
			Array.isArray(params.linkTarget)
		) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"linkTarget is required for LINK_EXISTING action",
			);
		}
		if (!isValidUuid(params.linkTarget.targetId)) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"linkTarget.targetId must be a valid UUID",
			);
		}
		const allowedTargetTypes = [
			"CREDIT_CARD_TRANSACTION",
			"CREDIT_CARD_SPLIT",
			"INCOME",
		];
		if (!allowedTargetTypes.includes(params.linkTarget.targetType)) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				`linkTarget.targetType must be one of: ${allowedTargetTypes.join(", ")}`,
			);
		}
	} else if (params.linkTarget !== undefined && params.linkTarget !== null) {
		if (
			typeof params.linkTarget !== "object" ||
			Array.isArray(params.linkTarget)
		) {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"linkTarget must be an object",
			);
		}
	}

	const requestFingerprint = await computeResolveRequestFingerprint({
		userId: params.userId.toLowerCase(),
		importRowId: params.importRowId.toLowerCase(),
		expectedRevisionNo: params.expectedRevisionNo,
		action: params.action,
		resolvedMappings: params.resolvedMappings,
		linkTarget: params.linkTarget,
		reasonNote: params.reasonNote,
	});

	return await withImportTransaction(db, async (tx) => {
		// 2. Historical Replay First: Check mutation idempotency receipts
		const [receipt] = await tx
			.select()
			.from(importMutationIdempotencyReceipts)
			.where(
				and(
					eq(importMutationIdempotencyReceipts.userId, params.userId),
					eq(importMutationIdempotencyReceipts.idempotencyKey, validKey),
				),
			)
			.limit(1);

		if (receipt) {
			if (
				receipt.operation !== params.action ||
				receipt.requestFingerprint !== requestFingerprint ||
				receipt.importRowId !== params.importRowId
			) {
				throw new ImportError(
					"IMPORT_IDEMPOTENCY_CONFLICT",
					"Idempotency key has already been used for a different request",
				);
			}

			const historicalDetail =
				await buildImportRowReadModelForRevisionInTransaction(
					tx,
					receipt.importRowId,
					receipt.importRowRevisionId,
				);

			return {
				row: historicalDetail,
				idempotentReplay: true,
			};
		}

		// 3. Lock row for update
		const [row] = await tx
			.select()
			.from(importRows)
			.where(
				and(
					eq(importRows.id, params.importRowId),
					eq(importRows.userId, params.userId),
				),
			)
			.for("update")
			.limit(1);

		if (!row) {
			throw new ImportError("IMPORT_ROW_NOT_FOUND", "Import row not found");
		}

		// 3b. SECOND REPLAY CHECK: Check mutation idempotency receipts again after acquiring row lock
		const [receiptAfterLock] = await tx
			.select()
			.from(importMutationIdempotencyReceipts)
			.where(
				and(
					eq(importMutationIdempotencyReceipts.userId, params.userId),
					eq(importMutationIdempotencyReceipts.idempotencyKey, validKey),
				),
			)
			.limit(1);

		if (receiptAfterLock) {
			if (
				receiptAfterLock.operation !== params.action ||
				receiptAfterLock.requestFingerprint !== requestFingerprint ||
				receiptAfterLock.importRowId !== params.importRowId
			) {
				throw new ImportError(
					"IMPORT_IDEMPOTENCY_CONFLICT",
					"Idempotency key has already been used for a different request",
				);
			}

			const historicalDetail =
				await buildImportRowReadModelForRevisionInTransaction(
					tx,
					receiptAfterLock.importRowId,
					receiptAfterLock.importRowRevisionId,
				);

			return {
				row: historicalDetail,
				idempotentReplay: true,
			};
		}

		const [currentRev] = await tx
			.select()
			.from(importRowRevisions)
			.where(eq(importRowRevisions.importRowId, row.id))
			.orderBy(desc(importRowRevisions.revisionNo))
			.limit(1);

		if (!currentRev) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				"Import row has no revisions",
			);
		}

		if (currentRev.revisionNo !== params.expectedRevisionNo) {
			throw new ImportError(
				"IMPORT_REVISION_CONFLICT",
				`Expected revision ${params.expectedRevisionNo} but row is at revision ${currentRev.revisionNo}`,
			);
		}

		if (
			["APPLIED", "LINKED_EXISTING", "SKIPPED", "EXACT_DUPLICATE"].includes(
				currentRev.status,
			)
		) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				`Cannot resolve import row in terminal status ${currentRev.status}`,
			);
		}

		const [batch] = await tx
			.select()
			.from(importBatches)
			.where(eq(importBatches.id, row.batchId))
			.limit(1);

		if (!batch) {
			throw new ImportError("IMPORT_BATCH_NOT_FOUND", "Parent batch not found");
		}

		let nextStatus: ImportRowStatus;
		let nextPayload: NormalizedImportPayload;
		let operation: "RESOLVE" | "LINK" | "SKIP";
		let createdResultId: string | null = null;

		if (params.action === "CONFIRM_IMPORT") {
			if (currentRev.status !== "POSSIBLE_DUPLICATE") {
				throw new ImportError(
					"IMPORT_INVALID_STATE",
					`CONFIRM_IMPORT is only valid from POSSIBLE_DUPLICATE, current is ${currentRev.status}`,
				);
			}

			// Strong external identity check must not be bypassed by CONFIRM_IMPORT
			if (row.externalTransactionIdHash && row.recordType !== "UNSUPPORTED") {
				let scopeId: string | null = null;
				if (row.recordType === "CREDIT_CARD_PURCHASE") {
					scopeId = (currentRev.payload as NormalizedCardPurchasePayload)
						.cardId;
				} else if (row.recordType === "INCOME_RECEIPT") {
					scopeId = (currentRev.payload as NormalizedIncomeReceiptPayload)
						.destinationAccountId;
				}

				if (scopeId) {
					const [existingClaim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, params.userId),
								eq(importExternalIdentityClaims.provider, batch.provider),
								eq(importExternalIdentityClaims.recordType, row.recordType),
								eq(importExternalIdentityClaims.scopeId, scopeId),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									row.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (existingClaim) {
						throw new ImportError(
							"IMPORT_EXACT_DUPLICATE",
							"Cannot CONFIRM_IMPORT: strong external identity claim already exists",
						);
					}
				}
			}

			nextStatus = "READY";
			nextPayload = currentRev.payload as NormalizedImportPayload; // exact copy-forward
			operation = "RESOLVE";
		} else if (params.action === "RESOLVE_MAPPINGS") {
			if (!params.resolvedMappings) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					"resolvedMappings is required for RESOLVE_MAPPINGS action",
				);
			}

			if (row.recordType === "CREDIT_CARD_PURCHASE") {
				const cur = currentRev.payload as NormalizedCardPurchasePayload;
				const newCardId =
					params.resolvedMappings.cardId !== undefined
						? params.resolvedMappings.cardId
						: cur.cardId;

				if (newCardId && !isValidUuid(newCardId)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"resolved cardId must be a valid UUID",
					);
				}

				const newCat =
					params.resolvedMappings.purchaseCategory !== undefined
						? params.resolvedMappings.purchaseCategory
						: cur.purchaseCategory;

				const newGoalId =
					params.resolvedMappings.shortTermGoalId !== undefined
						? params.resolvedMappings.shortTermGoalId
						: cur.shortTermGoalId;

				if (newGoalId && !isValidUuid(newGoalId)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"resolved shortTermGoalId must be a valid UUID",
					);
				}

				if (newCat === "SHORT_TERM_PURCHASE" && !newGoalId) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"shortTermGoalId is required when purchaseCategory is SHORT_TERM_PURCHASE",
					);
				}

				const updatedPayload: NormalizedCardPurchasePayload = {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: newCardId ? newCardId.toLowerCase() : null,
					occurredAt: cur.occurredAt,
					amount: cur.amount,
					purchaseCategory: newCat ?? null,
					shortTermGoalId:
						newCat === "SHORT_TERM_PURCHASE" && newGoalId
							? newGoalId.toLowerCase()
							: null,
					merchant: cur.merchant,
					description: cur.description,
					installmentCount: cur.installmentCount,
				};

				nextPayload = updatedPayload;

				// Check if newly resolved cardId reveals an existing strong claim
				if (updatedPayload.cardId && row.externalTransactionIdHash) {
					const [existingClaim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, params.userId),
								eq(importExternalIdentityClaims.provider, batch.provider),
								eq(
									importExternalIdentityClaims.recordType,
									"CREDIT_CARD_PURCHASE",
								),
								eq(importExternalIdentityClaims.scopeId, updatedPayload.cardId),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									row.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (existingClaim) {
						const [ownerResult] = await tx
							.select()
							.from(importRowResults)
							.where(
								eq(importRowResults.importRowId, existingClaim.importRowId),
							)
							.limit(1);

						if (ownerResult) {
							nextStatus = "EXACT_DUPLICATE";
							operation = "RESOLVE";

							const [res] = await tx
								.insert(importRowResults)
								.values({
									userId: params.userId,
									importRowId: row.id,
									resultKind: "EXACT_DUPLICATE",
									targetType: ownerResult.targetType,
									targetId: ownerResult.targetId,
									canonicalTransactionId: ownerResult.canonicalTransactionId,
									externalIdentityClaimId: existingClaim.id,
								})
								.returning({ id: importRowResults.id });

							createdResultId = res?.id ?? null;
						} else {
							nextStatus = "READY";
							operation = "RESOLVE";
						}
					} else {
						nextStatus =
							updatedPayload.cardId && updatedPayload.purchaseCategory
								? "READY"
								: "NEEDS_REVIEW";
						operation = "RESOLVE";
					}
				} else {
					nextStatus =
						updatedPayload.cardId && updatedPayload.purchaseCategory
							? "READY"
							: "NEEDS_REVIEW";
					operation = "RESOLVE";
				}
			} else if (row.recordType === "INCOME_RECEIPT") {
				const cur = currentRev.payload as NormalizedIncomeReceiptPayload;
				const newSourceId =
					params.resolvedMappings.incomeSourceId !== undefined
						? params.resolvedMappings.incomeSourceId
						: cur.incomeSourceId;

				if (newSourceId && !isValidUuid(newSourceId)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"resolved incomeSourceId must be a valid UUID",
					);
				}

				const newDestId =
					params.resolvedMappings.destinationAccountId !== undefined
						? params.resolvedMappings.destinationAccountId
						: cur.destinationAccountId;

				if (newDestId && !isValidUuid(newDestId)) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"resolved destinationAccountId must be a valid UUID",
					);
				}

				const updatedPayload: NormalizedIncomeReceiptPayload = {
					recordType: "INCOME_RECEIPT",
					incomeSourceId: newSourceId ? newSourceId.toLowerCase() : null,
					destinationAccountId: newDestId ? newDestId.toLowerCase() : null,
					receivedAt: cur.receivedAt,
					amount: cur.amount,
					note: cur.note,
				};

				nextPayload = updatedPayload;

				// Check if newly resolved destination reveals a strong claim
				if (
					updatedPayload.destinationAccountId &&
					row.externalTransactionIdHash
				) {
					const [existingClaim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, params.userId),
								eq(importExternalIdentityClaims.provider, batch.provider),
								eq(importExternalIdentityClaims.recordType, "INCOME_RECEIPT"),
								eq(
									importExternalIdentityClaims.scopeId,
									updatedPayload.destinationAccountId,
								),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									row.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (existingClaim) {
						const [ownerResult] = await tx
							.select()
							.from(importRowResults)
							.where(
								eq(importRowResults.importRowId, existingClaim.importRowId),
							)
							.limit(1);

						if (ownerResult) {
							nextStatus = "EXACT_DUPLICATE";
							operation = "RESOLVE";

							const [res] = await tx
								.insert(importRowResults)
								.values({
									userId: params.userId,
									importRowId: row.id,
									resultKind: "EXACT_DUPLICATE",
									targetType: ownerResult.targetType,
									targetId: ownerResult.targetId,
									canonicalTransactionId: ownerResult.canonicalTransactionId,
									externalIdentityClaimId: existingClaim.id,
								})
								.returning({ id: importRowResults.id });

							createdResultId = res?.id ?? null;
						} else {
							nextStatus = "READY";
							operation = "RESOLVE";
						}
					} else {
						nextStatus =
							updatedPayload.incomeSourceId &&
							updatedPayload.destinationAccountId
								? "READY"
								: "NEEDS_REVIEW";
						operation = "RESOLVE";
					}
				} else {
					nextStatus =
						updatedPayload.incomeSourceId && updatedPayload.destinationAccountId
							? "READY"
							: "NEEDS_REVIEW";
					operation = "RESOLVE";
				}
			} else {
				throw new ImportError(
					"IMPORT_UNSUPPORTED_RECORD",
					"Cannot resolve mappings on UNSUPPORTED record type",
				);
			}
		} else if (params.action === "LINK_EXISTING") {
			if (
				currentRev.status !== "READY" &&
				currentRev.status !== "POSSIBLE_DUPLICATE"
			) {
				throw new ImportError(
					"IMPORT_INVALID_STATE",
					`Cannot perform LINK_EXISTING from status ${currentRev.status} (expected READY or POSSIBLE_DUPLICATE)`,
				);
			}

			if (!params.linkTarget?.targetId) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					"linkTarget is required for LINK_EXISTING action",
				);
			}

			if (!isValidUuid(params.linkTarget.targetId)) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					"linkTarget.targetId must be a valid UUID",
				);
			}

			operation = "LINK";
			nextPayload = currentRev.payload as NormalizedImportPayload; // exact copy-forward

			let targetCanonicalTxId: string | null = null;
			let claimIdToBind: string | null = null;
			let finalResultKind: ImportResultKind = "LINKED_EXISTING";
			let finalTargetType: ImportResultTargetType =
				params.linkTarget.targetType;
			let finalTargetId: string = params.linkTarget.targetId;
			nextStatus = "LINKED_EXISTING";

			if (params.linkTarget.targetType === "CREDIT_CARD_PURCHASE") {
				if (row.recordType !== "CREDIT_CARD_PURCHASE") {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target type does not match row recordType",
					);
				}

				const [cardEvent] = await tx
					.select()
					.from(creditCardLiabilityEvents)
					.where(
						and(
							eq(creditCardLiabilityEvents.id, params.linkTarget.targetId),
							eq(creditCardLiabilityEvents.userId, params.userId),
						),
					)
					.limit(1);

				if (!cardEvent) {
					throw new ImportError(
						"IMPORT_TARGET_NOT_FOUND",
						"Target credit card liability event not found",
					);
				}

				if (cardEvent.eventType !== "PURCHASE") {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target event must be a PURCHASE",
					);
				}

				const [latestRev] = await tx
					.select()
					.from(creditCardLiabilityEventRevisions)
					.where(eq(creditCardLiabilityEventRevisions.eventId, cardEvent.id))
					.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
					.limit(1);

				if (!latestRev || latestRev.operation === "VOID") {
					throw new ImportError(
						"IMPORT_TARGET_NOT_FOUND",
						"Target credit card liability event is VOID or missing revisions",
					);
				}

				const cardPayload = currentRev.payload as NormalizedCardPurchasePayload;
				if (!cardPayload.cardId) {
					throw new ImportError(
						"IMPORT_MISSING_CARD_MAPPING",
						"Row must have a resolved cardId before linking",
					);
				}

				if (cardEvent.creditCardId !== cardPayload.cardId) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target card event belongs to a different card",
					);
				}

				if (latestRev.amount !== cardPayload.amount) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target amount does not match row payload amount",
					);
				}

				targetCanonicalTxId = cardEvent.canonicalTransactionId;

				// If row has external ID hash, insert/check claim before linking
				if (row.externalTransactionIdHash) {
					await tx
						.insert(importExternalIdentityClaims)
						.values({
							userId: params.userId,
							provider: batch.provider,
							recordType: "CREDIT_CARD_PURCHASE",
							scopeId: cardPayload.cardId,
							externalTransactionIdHash: row.externalTransactionIdHash,
							importRowId: row.id,
						})
						.onConflictDoNothing();

					const [claim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, params.userId),
								eq(importExternalIdentityClaims.provider, batch.provider),
								eq(
									importExternalIdentityClaims.recordType,
									"CREDIT_CARD_PURCHASE",
								),
								eq(importExternalIdentityClaims.scopeId, cardPayload.cardId),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									row.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (!claim) {
						throw new ImportError(
							"IMPORT_DATABASE_ERROR",
							"Failed to resolve external identity claim",
						);
					}

					claimIdToBind = claim.id;

					if (claim.importRowId === row.id) {
						nextStatus = "LINKED_EXISTING";
						finalResultKind = "LINKED_EXISTING";
					} else {
						// Strong ID belongs to another row: transition to EXACT_DUPLICATE
						const [ownerResult] = await tx
							.select()
							.from(importRowResults)
							.where(eq(importRowResults.importRowId, claim.importRowId))
							.limit(1);

						if (!ownerResult) {
							throw new ImportError(
								"IMPORT_INVALID_STATE",
								"Claim owner has no authoritative result for exact duplicate",
							);
						}

						nextStatus = "EXACT_DUPLICATE";
						finalResultKind = "EXACT_DUPLICATE";
						finalTargetType = ownerResult.targetType as ImportResultTargetType;
						finalTargetId = ownerResult.targetId;
						targetCanonicalTxId = ownerResult.canonicalTransactionId ?? null;
					}
				}
			} else if (params.linkTarget.targetType === "INCOME_RECEIPT") {
				if (row.recordType !== "INCOME_RECEIPT") {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target type does not match row recordType",
					);
				}

				const [receiptRecord] = await tx
					.select()
					.from(incomeReceipts)
					.where(
						and(
							eq(incomeReceipts.id, params.linkTarget.targetId),
							eq(incomeReceipts.userId, params.userId),
						),
					)
					.limit(1);

				if (!receiptRecord) {
					throw new ImportError(
						"IMPORT_TARGET_NOT_FOUND",
						"Target income receipt not found",
					);
				}

				const [latestRev] = await tx
					.select()
					.from(incomeReceiptRevisions)
					.where(eq(incomeReceiptRevisions.incomeReceiptId, receiptRecord.id))
					.orderBy(desc(incomeReceiptRevisions.revisionNo))
					.limit(1);

				if (!latestRev || latestRev.operation === "VOID") {
					throw new ImportError(
						"IMPORT_TARGET_NOT_FOUND",
						"Target income receipt is VOID or missing revisions",
					);
				}

				const incPayload = currentRev.payload as NormalizedIncomeReceiptPayload;
				if (!incPayload.incomeSourceId || !incPayload.destinationAccountId) {
					throw new ImportError(
						"IMPORT_MISSING_INCOME_MAPPING",
						"Row must have resolved incomeSourceId and destinationAccountId before linking",
					);
				}

				if (receiptRecord.sourceId !== incPayload.incomeSourceId) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target income receipt belongs to a different income source",
					);
				}

				if (
					latestRev.destinationAccountId !== incPayload.destinationAccountId
				) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target income receipt destination account mismatch",
					);
				}

				if (latestRev.amount !== incPayload.amount) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						"Target income receipt amount mismatch",
					);
				}

				targetCanonicalTxId = receiptRecord.canonicalTransactionId;

				// If row has external ID hash, insert/check claim
				if (row.externalTransactionIdHash) {
					await tx
						.insert(importExternalIdentityClaims)
						.values({
							userId: params.userId,
							provider: batch.provider,
							recordType: "INCOME_RECEIPT",
							scopeId: incPayload.destinationAccountId,
							externalTransactionIdHash: row.externalTransactionIdHash,
							importRowId: row.id,
						})
						.onConflictDoNothing();

					const [claim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, params.userId),
								eq(importExternalIdentityClaims.provider, batch.provider),
								eq(importExternalIdentityClaims.recordType, "INCOME_RECEIPT"),
								eq(
									importExternalIdentityClaims.scopeId,
									incPayload.destinationAccountId,
								),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									row.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (!claim) {
						throw new ImportError(
							"IMPORT_DATABASE_ERROR",
							"Failed to resolve external identity claim",
						);
					}

					claimIdToBind = claim.id;

					if (claim.importRowId === row.id) {
						nextStatus = "LINKED_EXISTING";
						finalResultKind = "LINKED_EXISTING";
					} else {
						// Strong ID belongs to another row: transition to EXACT_DUPLICATE
						const [ownerResult] = await tx
							.select()
							.from(importRowResults)
							.where(eq(importRowResults.importRowId, claim.importRowId))
							.limit(1);

						if (!ownerResult) {
							throw new ImportError(
								"IMPORT_INVALID_STATE",
								"Claim owner has no authoritative result for exact duplicate",
							);
						}

						nextStatus = "EXACT_DUPLICATE";
						finalResultKind = "EXACT_DUPLICATE";
						finalTargetType = ownerResult.targetType as ImportResultTargetType;
						finalTargetId = ownerResult.targetId;
						targetCanonicalTxId = ownerResult.canonicalTransactionId ?? null;
					}
				}
			} else {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					"Unsupported link target type",
				);
			}

			const [resultRec] = await tx
				.insert(importRowResults)
				.values({
					userId: params.userId,
					importRowId: row.id,
					resultKind: finalResultKind,
					targetType: finalTargetType,
					targetId: finalTargetId,
					canonicalTransactionId: targetCanonicalTxId,
					externalIdentityClaimId: claimIdToBind,
				})
				.returning({ id: importRowResults.id });

			createdResultId = resultRec?.id ?? null;
		} else if (params.action === "SKIP") {
			operation = "SKIP";
			nextStatus = "SKIPPED";
			nextPayload = currentRev.payload as NormalizedImportPayload; // exact copy-forward
		} else {
			throw new ImportError(
				"IMPORT_INVALID_INPUT",
				"Unsupported resolve action",
			);
		}

		const nextRevisionNo = currentRev.revisionNo + 1;
		const revisionFingerprint = await computeRevisionFingerprint({
			importRowId: row.id,
			revisionNo: nextRevisionNo,
			operation,
			status: nextStatus,
			payload: nextPayload,
			reasonNote: params.reasonNote,
			idempotencyKey: validKey,
		});

		const [newRev] = await tx
			.insert(importRowRevisions)
			.values({
				userId: params.userId,
				importRowId: row.id,
				revisionNo: nextRevisionNo,
				previousRevisionId: currentRev.id,
				operation,
				status: nextStatus,
				payload: nextPayload,
				reasonNote: params.reasonNote ?? null,
				occurredAt: currentRev.occurredAt,
				idempotencyKey: validKey,
				revisionFingerprint,
			})
			.returning();

		if (!newRev) {
			throw new ImportError(
				"IMPORT_DATABASE_ERROR",
				"Failed to insert new revision",
			);
		}

		// Insert mutation receipt
		await tx.insert(importMutationIdempotencyReceipts).values({
			userId: params.userId,
			idempotencyKey: validKey,
			operation: params.action,
			requestFingerprint,
			importRowId: row.id,
			importRowRevisionId: newRev.id,
			importRowResultId: createdResultId,
		});

		const detail = await buildImportRowReadModelForRevisionInTransaction(
			tx,
			row.id,
			newRev.id,
		);

		return {
			row: detail,
			idempotentReplay: false,
		};
	});
}

/**
 * Applies a ready import row, delegating safely to authoritative financial domain primitives.
 */
export async function applyImportRow(
	db: Database | DatabaseTransaction,
	params: ApplyImportRowParams,
): Promise<{ row: ImportRowDetail; idempotentReplay: boolean }> {
	// Strict validation before DB
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new ImportError("IMPORT_INVALID_INPUT", "params must be an object");
	}
	if (!isValidUuid(params.userId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid userId UUID is required",
		);
	}
	if (!isValidUuid(params.importRowId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid importRowId UUID is required",
		);
	}
	if (
		!params.idempotencyKey ||
		typeof params.idempotencyKey !== "string" ||
		params.idempotencyKey.trim().length === 0 ||
		params.idempotencyKey.trim().length > 128
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"idempotencyKey is required and must be between 1 and 128 characters",
		);
	}
	const validKey = params.idempotencyKey.trim();

	if (
		typeof params.expectedRevisionNo !== "number" ||
		!Number.isInteger(params.expectedRevisionNo) ||
		params.expectedRevisionNo < 1
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"expectedRevisionNo must be an integer >= 1",
		);
	}

	const requestFingerprint = await computeApplyRequestFingerprint({
		userId: params.userId.toLowerCase(),
		importRowId: params.importRowId.toLowerCase(),
		expectedRevisionNo: params.expectedRevisionNo,
	});

	return await withImportTransaction(db, async (tx) => {
		// 1. Historical Replay First
		const [receipt] = await tx
			.select()
			.from(importMutationIdempotencyReceipts)
			.where(
				and(
					eq(importMutationIdempotencyReceipts.userId, params.userId),
					eq(importMutationIdempotencyReceipts.idempotencyKey, validKey),
				),
			)
			.limit(1);

		if (receipt) {
			if (
				receipt.operation !== "APPLY" ||
				receipt.requestFingerprint !== requestFingerprint ||
				receipt.importRowId !== params.importRowId
			) {
				throw new ImportError(
					"IMPORT_IDEMPOTENCY_CONFLICT",
					"Idempotency key has already been used for a different apply request",
				);
			}

			const historicalDetail =
				await buildImportRowReadModelForRevisionInTransaction(
					tx,
					receipt.importRowId,
					receipt.importRowRevisionId,
				);

			return {
				row: historicalDetail,
				idempotentReplay: true,
			};
		}

		// 2. Lock row FOR UPDATE
		const [row] = await tx
			.select()
			.from(importRows)
			.where(
				and(
					eq(importRows.id, params.importRowId),
					eq(importRows.userId, params.userId),
				),
			)
			.for("update")
			.limit(1);

		if (!row) {
			throw new ImportError("IMPORT_ROW_NOT_FOUND", "Import row not found");
		}

		// 2b. SECOND REPLAY CHECK: Check mutation idempotency receipts again after acquiring row lock
		const [receiptAfterLock] = await tx
			.select()
			.from(importMutationIdempotencyReceipts)
			.where(
				and(
					eq(importMutationIdempotencyReceipts.userId, params.userId),
					eq(importMutationIdempotencyReceipts.idempotencyKey, validKey),
				),
			)
			.limit(1);

		if (receiptAfterLock) {
			if (
				receiptAfterLock.operation !== "APPLY" ||
				receiptAfterLock.requestFingerprint !== requestFingerprint ||
				receiptAfterLock.importRowId !== params.importRowId
			) {
				throw new ImportError(
					"IMPORT_IDEMPOTENCY_CONFLICT",
					"Idempotency key has already been used for a different apply request",
				);
			}

			const historicalDetail =
				await buildImportRowReadModelForRevisionInTransaction(
					tx,
					receiptAfterLock.importRowId,
					receiptAfterLock.importRowRevisionId,
				);

			return {
				row: historicalDetail,
				idempotentReplay: true,
			};
		}

		const [currentRev] = await tx
			.select()
			.from(importRowRevisions)
			.where(eq(importRowRevisions.importRowId, row.id))
			.orderBy(desc(importRowRevisions.revisionNo))
			.limit(1);

		if (!currentRev) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				"Import row has no revisions",
			);
		}

		if (currentRev.revisionNo !== params.expectedRevisionNo) {
			throw new ImportError(
				"IMPORT_REVISION_CONFLICT",
				`Expected revision ${params.expectedRevisionNo} but row is at revision ${currentRev.revisionNo}`,
			);
		}

		if (currentRev.status !== "READY") {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				`Cannot apply import row in status ${currentRev.status} (must be READY)`,
			);
		}

		const [batch] = await tx
			.select()
			.from(importBatches)
			.where(eq(importBatches.id, row.batchId))
			.limit(1);

		if (!batch) {
			throw new ImportError("IMPORT_BATCH_NOT_FOUND", "Parent batch not found");
		}

		const nextRevisionNo = currentRev.revisionNo + 1;
		let resultRecordId: string | null = null;
		let nextStatus: ImportRowStatus = "APPLIED";
		const payload = currentRev.payload as NormalizedImportPayload; // exact copy-forward

		// 3. Strong External ID Claim & Delegation
		if (row.externalTransactionIdHash && row.recordType !== "UNSUPPORTED") {
			let scopeId: string;
			if (row.recordType === "CREDIT_CARD_PURCHASE") {
				const cp = payload as NormalizedCardPurchasePayload;
				if (!cp.cardId) {
					throw new ImportError(
						"IMPORT_MISSING_CARD_MAPPING",
						"cardId required for credit card purchase apply",
					);
				}
				scopeId = cp.cardId;
			} else {
				const ip = payload as NormalizedIncomeReceiptPayload;
				if (!ip.destinationAccountId) {
					throw new ImportError(
						"IMPORT_MISSING_INCOME_MAPPING",
						"destinationAccountId required for income receipt apply",
					);
				}
				scopeId = ip.destinationAccountId;
			}

			// Try to insert claim
			await tx
				.insert(importExternalIdentityClaims)
				.values({
					userId: params.userId,
					provider: batch.provider,
					recordType: row.recordType,
					scopeId,
					externalTransactionIdHash: row.externalTransactionIdHash,
					importRowId: row.id,
				})
				.onConflictDoNothing();

			// Re-read confirmed claim
			const [confirmedClaim] = await tx
				.select()
				.from(importExternalIdentityClaims)
				.where(
					and(
						eq(importExternalIdentityClaims.userId, params.userId),
						eq(importExternalIdentityClaims.provider, batch.provider),
						eq(importExternalIdentityClaims.recordType, row.recordType),
						eq(importExternalIdentityClaims.scopeId, scopeId),
						eq(
							importExternalIdentityClaims.externalTransactionIdHash,
							row.externalTransactionIdHash,
						),
					),
				)
				.limit(1);

			if (!confirmedClaim) {
				throw new ImportError(
					"IMPORT_DATABASE_ERROR",
					"Failed to resolve confirmed external identity claim",
				);
			}

			if (confirmedClaim.importRowId === row.id) {
				// Current row owns the claim! Proceed with financial mutation.
				const childIdempotencyKey = await computeChildIdempotencyKey(
					"IMPORT_ROW_APPLY",
					params.userId,
					row.id,
					nextRevisionNo.toString(),
				);

				let targetType: ImportResultTargetType;
				let targetId: string;
				let canonicalTxId: string;

				if (row.recordType === "CREDIT_CARD_PURCHASE") {
					const cardPayload = payload as NormalizedCardPurchasePayload;
					if (!cardPayload.cardId) {
						throw new ImportError(
							"IMPORT_MISSING_CARD_MAPPING",
							"cardId mapping is required for credit card purchase apply",
						);
					}
					const purchaseResult = await recordCreditCardPurchaseInTransaction({
						tx,
						userId: params.userId,
						cardId: cardPayload.cardId,
						amount: cardPayload.amount,
						occurredAt: new Date(cardPayload.occurredAt),
						purchaseCategory:
							cardPayload.purchaseCategory === "SHORT_TERM_PURCHASE"
								? "SHORT_TERM_PURCHASE"
								: cardPayload.purchaseCategory === "MANDATORY"
									? "MANDATORY"
									: cardPayload.purchaseCategory === "DISCRETIONARY"
										? "DISCRETIONARY"
										: "UNCLASSIFIED",
						shortTermGoalId:
							cardPayload.purchaseCategory === "SHORT_TERM_PURCHASE"
								? (cardPayload.shortTermGoalId ?? undefined)
								: undefined,
						merchant: cardPayload.merchant ?? undefined,
						description: cardPayload.description ?? undefined,
						installmentCount: cardPayload.installmentCount ?? undefined,
						idempotencyKey: childIdempotencyKey,
					});

					targetType = "CREDIT_CARD_PURCHASE";
					targetId = purchaseResult.eventId;

					const [ccEv] = await tx
						.select({
							canonicalTransactionId:
								creditCardLiabilityEvents.canonicalTransactionId,
						})
						.from(creditCardLiabilityEvents)
						.where(eq(creditCardLiabilityEvents.id, purchaseResult.eventId))
						.limit(1);

					canonicalTxId = ccEv?.canonicalTransactionId ?? "";
				} else if (row.recordType === "INCOME_RECEIPT") {
					const incomePayload = payload as NormalizedIncomeReceiptPayload;
					if (
						!incomePayload.incomeSourceId ||
						!incomePayload.destinationAccountId
					) {
						throw new ImportError(
							"IMPORT_MISSING_INCOME_MAPPING",
							"incomeSourceId and destinationAccountId mappings are required for income receipt apply",
						);
					}
					const receiptResult = await createIncomeReceiptInTransaction({
						tx,
						userId: params.userId,
						sourceId: incomePayload.incomeSourceId,
						destinationAccountId: incomePayload.destinationAccountId,
						amount: incomePayload.amount,
						receivedAt: new Date(incomePayload.receivedAt),
						note: incomePayload.note ?? undefined,
						idempotencyKey: childIdempotencyKey,
						provenance: {
							type: "IMPORT",
							ref: row.id,
							payloadHash: row.rawRowHash,
							observedAt: batch.observedAt,
						},
					});

					targetType = "INCOME_RECEIPT";
					targetId = receiptResult.incomeReceipt.incomeReceiptId;
					canonicalTxId = receiptResult.incomeReceipt.canonicalTransactionId;
				} else {
					throw new ImportError(
						"IMPORT_UNSUPPORTED_RECORD",
						"Cannot apply UNSUPPORTED record type",
					);
				}

				const [resultRecord] = await tx
					.insert(importRowResults)
					.values({
						userId: params.userId,
						importRowId: row.id,
						resultKind: "CREATED",
						targetType,
						targetId,
						canonicalTransactionId: canonicalTxId,
						externalIdentityClaimId: confirmedClaim.id,
					})
					.returning({ id: importRowResults.id });

				resultRecordId = resultRecord?.id ?? null;
				nextStatus = "APPLIED";
			} else {
				// Another row already owns this claim! DO NOT call financial domain (0 financial delta).
				const [winnerResult] = await tx
					.select()
					.from(importRowResults)
					.where(eq(importRowResults.importRowId, confirmedClaim.importRowId))
					.limit(1);

				if (!winnerResult) {
					throw new ImportError(
						"IMPORT_DATABASE_ERROR",
						"Claim winner row has no authoritative result",
					);
				}

				const [resultRecord] = await tx
					.insert(importRowResults)
					.values({
						userId: params.userId,
						importRowId: row.id,
						resultKind: "EXACT_DUPLICATE",
						targetType: winnerResult.targetType,
						targetId: winnerResult.targetId,
						canonicalTransactionId: winnerResult.canonicalTransactionId,
						externalIdentityClaimId: confirmedClaim.id,
					})
					.returning({ id: importRowResults.id });

				resultRecordId = resultRecord?.id ?? null;
				nextStatus = "EXACT_DUPLICATE";
			}
		} else {
			// Row without external identity
			const childIdempotencyKey = await computeChildIdempotencyKey(
				"IMPORT_ROW_APPLY",
				params.userId,
				row.id,
				nextRevisionNo.toString(),
			);

			let targetType: ImportResultTargetType;
			let targetId: string;
			let canonicalTxId: string;

			if (row.recordType === "CREDIT_CARD_PURCHASE") {
				const cardPayload = payload as NormalizedCardPurchasePayload;
				if (!cardPayload.cardId) {
					throw new ImportError(
						"IMPORT_MISSING_CARD_MAPPING",
						"cardId mapping is required for credit card purchase apply",
					);
				}
				const purchaseResult = await recordCreditCardPurchaseInTransaction({
					tx,
					userId: params.userId,
					cardId: cardPayload.cardId,
					amount: cardPayload.amount,
					occurredAt: new Date(cardPayload.occurredAt),
					purchaseCategory:
						cardPayload.purchaseCategory === "SHORT_TERM_PURCHASE"
							? "SHORT_TERM_PURCHASE"
							: cardPayload.purchaseCategory === "MANDATORY"
								? "MANDATORY"
								: cardPayload.purchaseCategory === "DISCRETIONARY"
									? "DISCRETIONARY"
									: "UNCLASSIFIED",
					shortTermGoalId:
						cardPayload.purchaseCategory === "SHORT_TERM_PURCHASE"
							? (cardPayload.shortTermGoalId ?? undefined)
							: undefined,
					merchant: cardPayload.merchant ?? undefined,
					description: cardPayload.description ?? undefined,
					installmentCount: cardPayload.installmentCount ?? undefined,
					idempotencyKey: childIdempotencyKey,
				});

				targetType = "CREDIT_CARD_PURCHASE";
				targetId = purchaseResult.eventId;

				const [ccEv] = await tx
					.select({
						canonicalTransactionId:
							creditCardLiabilityEvents.canonicalTransactionId,
					})
					.from(creditCardLiabilityEvents)
					.where(eq(creditCardLiabilityEvents.id, purchaseResult.eventId))
					.limit(1);

				canonicalTxId = ccEv?.canonicalTransactionId ?? "";
			} else if (row.recordType === "INCOME_RECEIPT") {
				const incomePayload = payload as NormalizedIncomeReceiptPayload;
				if (
					!incomePayload.incomeSourceId ||
					!incomePayload.destinationAccountId
				) {
					throw new ImportError(
						"IMPORT_MISSING_INCOME_MAPPING",
						"incomeSourceId and destinationAccountId mappings are required for income receipt apply",
					);
				}
				const receiptResult = await createIncomeReceiptInTransaction({
					tx,
					userId: params.userId,
					sourceId: incomePayload.incomeSourceId,
					destinationAccountId: incomePayload.destinationAccountId,
					amount: incomePayload.amount,
					receivedAt: new Date(incomePayload.receivedAt),
					note: incomePayload.note ?? undefined,
					idempotencyKey: childIdempotencyKey,
					provenance: {
						type: "IMPORT",
						ref: row.id,
						payloadHash: row.rawRowHash,
						observedAt: batch.observedAt,
					},
				});

				targetType = "INCOME_RECEIPT";
				targetId = receiptResult.incomeReceipt.incomeReceiptId;
				canonicalTxId = receiptResult.incomeReceipt.canonicalTransactionId;
			} else {
				throw new ImportError(
					"IMPORT_UNSUPPORTED_RECORD",
					"Cannot apply UNSUPPORTED record type",
				);
			}

			const [resultRecord] = await tx
				.insert(importRowResults)
				.values({
					userId: params.userId,
					importRowId: row.id,
					resultKind: "CREATED",
					targetType,
					targetId,
					canonicalTransactionId: canonicalTxId,
					externalIdentityClaimId: null,
				})
				.returning({ id: importRowResults.id });

			resultRecordId = resultRecord?.id ?? null;
			nextStatus = "APPLIED";
		}

		// Insert new revision
		const revisionFingerprint = await computeRevisionFingerprint({
			importRowId: row.id,
			revisionNo: nextRevisionNo,
			operation: "APPLY",
			status: nextStatus,
			payload,
			idempotencyKey: validKey,
		});

		const [newRev] = await tx
			.insert(importRowRevisions)
			.values({
				userId: params.userId,
				importRowId: row.id,
				revisionNo: nextRevisionNo,
				previousRevisionId: currentRev.id,
				operation: "APPLY",
				status: nextStatus,
				payload,
				occurredAt: currentRev.occurredAt,
				idempotencyKey: validKey,
				revisionFingerprint,
			})
			.returning();

		if (!newRev) {
			throw new ImportError(
				"IMPORT_DATABASE_ERROR",
				"Failed to insert applied revision",
			);
		}

		// Insert mutation receipt
		await tx.insert(importMutationIdempotencyReceipts).values({
			userId: params.userId,
			idempotencyKey: validKey,
			operation: "APPLY",
			requestFingerprint,
			importRowId: row.id,
			importRowRevisionId: newRev.id,
			importRowResultId: resultRecordId,
		});

		const detail = await buildImportRowReadModelForRevisionInTransaction(
			tx,
			row.id,
			newRev.id,
		);

		return {
			row: detail,
			idempotentReplay: false,
		};
	});
}

/**
 * Applies all READY import rows for a given batch.
 */
export async function applyReadyImportRows(
	db: Database | DatabaseTransaction,
	params: { userId: string; batchId: string },
): Promise<{
	appliedCount: number;
	failedCount: number;
	results: Array<{
		importRowId: string;
		status: "APPLIED" | "EXACT_DUPLICATE" | "FAILED";
		errorCode?: string | undefined;
		errorMessage?: string | undefined;
		result?: ImportRowDetail["result"];
	}>;
}> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new ImportError("IMPORT_INVALID_INPUT", "params must be an object");
	}
	if (!isValidUuid(params.userId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid userId UUID is required",
		);
	}
	if (!isValidUuid(params.batchId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid batchId UUID is required",
		);
	}

	const rows = await listImportRows(db, params.batchId);
	const readyRows = rows.filter((r) => r.status === "READY");

	let appliedCount = 0;
	let failedCount = 0;
	const results: Array<{
		importRowId: string;
		status: "APPLIED" | "EXACT_DUPLICATE" | "FAILED";
		errorCode?: string | undefined;
		errorMessage?: string | undefined;
		result?: ImportRowDetail["result"];
	}> = [];

	for (const r of readyRows) {
		const deterministicKey = await computeChildIdempotencyKey(
			"IMPORT_APPLY_READY_ROW",
			params.userId,
			r.id,
			r.latestRevisionNo.toString(),
		);

		try {
			const res = await applyImportRow(db, {
				userId: params.userId,
				importRowId: r.id,
				expectedRevisionNo: r.latestRevisionNo,
				idempotencyKey: deterministicKey,
			});

			if (
				res.row.status === "APPLIED" ||
				res.row.status === "EXACT_DUPLICATE"
			) {
				appliedCount++;
				results.push({
					importRowId: r.id,
					status: res.row.status,
					result: res.row.result,
				});
			} else {
				failedCount++;
				results.push({
					importRowId: r.id,
					status: "FAILED",
					errorCode: "IMPORT_INVALID_STATE",
					errorMessage: "Row did not transition to APPLIED or EXACT_DUPLICATE",
				});
			}
		} catch (err) {
			failedCount++;
			const code =
				err instanceof ImportError ? err.code : "IMPORT_DATABASE_ERROR";
			const msg =
				err instanceof ImportError ? err.message : "Failed to apply import row";
			results.push({
				importRowId: r.id,
				status: "FAILED",
				errorCode: code,
				errorMessage: msg,
			});
		}
	}

	return {
		appliedCount,
		failedCount,
		results,
	};
}

/**
 * Previews import staging results in dry-run mode (without persisting).
 */
export async function previewImportBatch(
	db: Database | DatabaseTransaction,
	params: StageImportBatchParams,
): Promise<{
	batchMeta: ImportBatchSummary;
	rows: ImportRowDetail[];
}> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new ImportError("IMPORT_INVALID_INPUT", "params must be an object");
	}
	if (
		params.sourceContent !== undefined &&
		params.sourceContent !== null &&
		typeof params.sourceContent !== "string"
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"sourceContent must be a string",
		);
	}
	if (
		params.sourceContentHash !== undefined &&
		params.sourceContentHash !== null &&
		typeof params.sourceContentHash !== "string"
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"sourceContentHash must be a string",
		);
	}
	let contentHash = params.sourceContentHash;
	if (!contentHash && params.sourceContent) {
		contentHash = await computeSourceContentHash(params.sourceContent);
	}
	if (!contentHash) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"Either sourceContent or sourceContentHash is required",
		);
	}

	const meta = validateAndNormalizeBatchMeta({
		...params,
		sourceContentHash: contentHash,
	});

	const normalizedRows: ReturnType<typeof normalizeImportRow> extends Promise<
		infer R
	>
		? R[]
		: never = [];

	for (let i = 0; i < params.rows.length; i++) {
		const r = params.rows[i];
		if (!r) continue;
		normalizedRows.push(await normalizeImportRow(meta.validUserId, i, r));
	}

	return await withImportTransaction(db, async (tx) => {
		const dedupResult = await analyzeDuplicatesAgainstDb(
			tx,
			meta.validUserId,
			meta.validProvider,
			normalizedRows,
		);

		let readyCount = 0;
		let needsReviewCount = 0;
		let possibleDuplicateCount = 0;
		let exactDuplicateCount = 0;
		let unsupportedCount = 0;

		const rowDetails: ImportRowDetail[] = [];
		const previewBatchId = "00000000-0000-0000-0000-000000000000";

		for (const item of dedupResult.rowsWithStatus) {
			const r = item.row;
			const finalStatus = item.finalStatus;

			switch (finalStatus) {
				case "READY":
					readyCount++;
					break;
				case "NEEDS_REVIEW":
					needsReviewCount++;
					break;
				case "POSSIBLE_DUPLICATE":
					possibleDuplicateCount++;
					break;
				case "EXACT_DUPLICATE":
					exactDuplicateCount++;
					break;
				case "UNSUPPORTED":
					unsupportedCount++;
					break;
			}

			let targetResult: ImportRowDetail["result"] = null;

			// If EXACT_DUPLICATE, resolve existing target evidence for preview
			if (
				finalStatus === "EXACT_DUPLICATE" &&
				r.externalTransactionIdHash &&
				r.recordType !== "UNSUPPORTED"
			) {
				let scopeId: string | null = null;
				if (r.recordType === "CREDIT_CARD_PURCHASE") {
					scopeId = (r.payload as NormalizedCardPurchasePayload).cardId;
				} else if (r.recordType === "INCOME_RECEIPT") {
					scopeId = (r.payload as NormalizedIncomeReceiptPayload)
						.destinationAccountId;
				}

				if (scopeId) {
					const [claim] = await tx
						.select()
						.from(importExternalIdentityClaims)
						.where(
							and(
								eq(importExternalIdentityClaims.userId, meta.validUserId),
								eq(importExternalIdentityClaims.provider, meta.validProvider),
								eq(importExternalIdentityClaims.recordType, r.recordType),
								eq(importExternalIdentityClaims.scopeId, scopeId),
								eq(
									importExternalIdentityClaims.externalTransactionIdHash,
									r.externalTransactionIdHash,
								),
							),
						)
						.limit(1);

					if (claim) {
						const [ownerResult] = await tx
							.select()
							.from(importRowResults)
							.where(eq(importRowResults.importRowId, claim.importRowId))
							.limit(1);

						if (ownerResult) {
							targetResult = {
								resultKind: "EXACT_DUPLICATE",
								targetType: ownerResult.targetType as ImportResultTargetType,
								targetId: ownerResult.targetId,
								canonicalTransactionId: ownerResult.canonicalTransactionId,
								externalIdentityClaimId: claim.id,
							};
						}
					}
				}
			}

			rowDetails.push({
				id: `preview-row-${r.rowOrdinal}`,
				userId: meta.validUserId,
				batchId: previewBatchId,
				rowOrdinal: r.rowOrdinal,
				recordType: r.recordType,
				latestRevisionNo: 1,
				status: finalStatus,
				payload: r.payload,
				occurredAt: r.occurredAt,
				externalIdentityPresent: r.externalTransactionIdHash !== null,
				duplicateCandidates: item.candidates.map((c) => ({
					candidateType: c.candidateType,
					candidateId: c.candidateId,
					reasonCode: c.reasonCode,
				})),
				result: targetResult,
			});
		}

		const batchSummary: ImportBatchSummary = {
			id: previewBatchId,
			userId: meta.validUserId,
			provider: meta.validProvider,
			sourceKind: meta.validSourceKind,
			sourceContentHash: meta.validContentHash,
			sourceFileName: meta.validFileName,
			parserType: meta.validParserType,
			parserVersion: meta.validParserVersion,
			observedAt: meta.validObservedAt,
			createdAt: new Date(),
			totalRows: normalizedRows.length,
			readyCount,
			needsReviewCount,
			possibleDuplicateCount,
			exactDuplicateCount,
			appliedCount: 0,
			linkedCount: 0,
			skippedCount: 0,
			unsupportedCount,
		};

		return {
			batchMeta: batchSummary,
			rows: rowDetails,
		};
	});
}

/**
 * Retrieves a single batch by ID.
 */
export async function getImportBatch(
	db: Database | DatabaseTransaction,
	batchId: string,
): Promise<ImportBatchSummary> {
	if (!isValidUuid(batchId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid batchId UUID is required",
		);
	}
	return await withImportTransaction(db, async (tx) => {
		return await buildImportBatchSummaryInTransaction(tx, batchId);
	});
}

/**
 * Lists import batches for a user.
 */
export async function listImportBatches(
	db: Database | DatabaseTransaction,
	userId: string,
): Promise<ImportBatchSummary[]> {
	if (!isValidUuid(userId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid userId UUID is required",
		);
	}
	return await withImportTransaction(db, async (tx) => {
		const batches = await tx
			.select({ id: importBatches.id })
			.from(importBatches)
			.where(eq(importBatches.userId, userId))
			.orderBy(desc(importBatches.createdAt));

		const summaries: ImportBatchSummary[] = [];
		for (const b of batches) {
			summaries.push(await buildImportBatchSummaryInTransaction(tx, b.id));
		}
		return summaries;
	});
}

/**
 * Helper to list all rows for a batch inside a transaction.
 */
async function listImportRowsInTransaction(
	tx: DatabaseTransaction,
	batchId: string,
): Promise<ImportRowDetail[]> {
	const rows = await tx
		.select({ id: importRows.id })
		.from(importRows)
		.where(eq(importRows.batchId, batchId))
		.orderBy(importRows.rowOrdinal);

	const rowDetails: ImportRowDetail[] = [];
	for (const r of rows) {
		rowDetails.push(await buildImportRowReadModelInTransaction(tx, r.id));
	}
	return rowDetails;
}

/**
 * Retrieves a single import row detail.
 */
export async function getImportRow(
	db: Database | DatabaseTransaction,
	importRowId: string,
): Promise<ImportRowDetail> {
	if (!isValidUuid(importRowId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid importRowId UUID is required",
		);
	}
	return await withImportTransaction(db, async (tx) => {
		return await buildImportRowReadModelInTransaction(tx, importRowId);
	});
}

/**
 * Lists all import rows for a batch.
 */
export async function listImportRows(
	db: Database | DatabaseTransaction,
	batchId: string,
): Promise<ImportRowDetail[]> {
	if (!isValidUuid(batchId)) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"valid batchId UUID is required",
		);
	}
	return await withImportTransaction(db, async (tx) => {
		return await listImportRowsInTransaction(tx, batchId);
	});
}
