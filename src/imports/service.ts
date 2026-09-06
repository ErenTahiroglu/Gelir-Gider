import { and, desc, eq, inArray } from "drizzle-orm";
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
	type ImportRowOperation,
	type ImportRowStatus,
	type ImportSourceKind,
	importBatches,
	importDuplicateCandidates,
	importExternalIdentityClaims,
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
	computeChildIdempotencyKey,
	computeRevisionFingerprint,
	computeSourceContentHash,
} from "./fingerprint";
import {
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
		  }
		| null
		| undefined;
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

	return await withImportTransaction(db, async (tx) => {
		// 1. Check for historical batch with same identity
		const [existingBatch] = await tx
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

		if (existingBatch) {
			const batchDetails = await getImportBatchWithDetails(
				tx,
				meta.validUserId,
				existingBatch.id,
			);
			return {
				batch: batchDetails.batch,
				rows: batchDetails.rows,
				idempotentReplay: true,
			};
		}

		// 2. Normalize all rows asynchronously
		const normalizedRows = await Promise.all(
			params.rows.map((r, i) => normalizeImportRow(meta.validUserId, i, r)),
		);

		// 3. Analyze duplicate candidates against DB and intra-batch
		const dedupResult = await analyzeDuplicatesAgainstDb(
			tx,
			meta.validUserId,
			meta.validProvider,
			normalizedRows,
		);

		// 4. Insert batch anchor
		const [newBatch] = await tx
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
			.returning();

		if (!newBatch) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				"Failed to create import batch",
			);
		}

		const stagedRows: ImportRowDetail[] = [];

		// 5. Insert rows, initial revision #1 (STAGE), duplicate candidates
		for (const item of dedupResult.rowsWithStatus) {
			const { row, finalStatus, candidates } = item;

			const [insertedRow] = await tx
				.insert(importRows)
				.values({
					userId: meta.validUserId,
					batchId: newBatch.id,
					rowOrdinal: row.rowOrdinal,
					recordType: row.recordType,
					rawRowHash: row.rawRowHash,
					semanticFingerprint: row.semanticFingerprint,
					externalTransactionIdHash: row.externalTransactionIdHash,
				})
				.returning();

			if (!insertedRow) {
				throw new ImportError(
					"IMPORT_INVALID_STATE",
					`Failed to insert import row at ordinal ${row.rowOrdinal}`,
				);
			}

			const revFingerprint = await computeRevisionFingerprint({
				importRowId: insertedRow.id,
				revisionNo: 1,
				operation: "STAGE",
				status: finalStatus,
				payload: row.payload,
			});

			const [insertedRev] = await tx
				.insert(importRowRevisions)
				.values({
					userId: meta.validUserId,
					importRowId: insertedRow.id,
					revisionNo: 1,
					previousRevisionId: null,
					operation: "STAGE",
					status: finalStatus,
					payload: row.payload,
					occurredAt: row.occurredAt,
					revisionFingerprint: revFingerprint,
				})
				.returning();

			if (!insertedRev) {
				throw new ImportError(
					"IMPORT_INVALID_STATE",
					`Failed to insert initial revision for row ${insertedRow.id}`,
				);
			}

			// Insert duplicate candidates
			for (const c of candidates) {
				await tx.insert(importDuplicateCandidates).values({
					userId: meta.validUserId,
					importRowId: insertedRow.id,
					candidateType: c.candidateType,
					candidateId: c.candidateId,
					reasonCode: c.reasonCode,
				});
			}

			stagedRows.push({
				id: insertedRow.id,
				userId: insertedRow.userId,
				batchId: newBatch.id,
				rowOrdinal: insertedRow.rowOrdinal,
				recordType: insertedRow.recordType as ImportRecordType,
				latestRevisionNo: 1,
				status: finalStatus as ImportRowStatus,
				payload: row.payload,
				occurredAt: row.occurredAt,
				externalIdentityPresent: insertedRow.externalTransactionIdHash !== null,
				duplicateCandidates: candidates.map((c) => ({
					candidateType: c.candidateType,
					candidateId: c.candidateId,
					reasonCode: c.reasonCode,
				})),
				result: null,
			});
		}

		const summary: ImportBatchSummary = {
			id: newBatch.id,
			userId: newBatch.userId,
			provider: newBatch.provider,
			sourceKind: newBatch.sourceKind as ImportSourceKind,
			sourceContentHash: newBatch.sourceContentHash,
			sourceFileName: newBatch.sourceFileName,
			parserType: newBatch.parserType,
			parserVersion: newBatch.parserVersion,
			observedAt: newBatch.observedAt,
			createdAt: newBatch.createdAt,
			totalRows: stagedRows.length,
			readyCount: stagedRows.filter((r) => r.status === "READY").length,
			needsReviewCount: stagedRows.filter((r) => r.status === "NEEDS_REVIEW")
				.length,
			possibleDuplicateCount: stagedRows.filter(
				(r) => r.status === "POSSIBLE_DUPLICATE",
			).length,
			exactDuplicateCount: stagedRows.filter(
				(r) => r.status === "EXACT_DUPLICATE",
			).length,
			appliedCount: 0,
			linkedCount: 0,
			skippedCount: 0,
			unsupportedCount: stagedRows.filter((r) => r.status === "UNSUPPORTED")
				.length,
		};

		return {
			batch: summary,
			rows: stagedRows,
			idempotentReplay: false,
		};
	});
}

export interface ResolveImportRowParams {
	userId: string;
	importRowId: string;
	expectedRevisionNo: number;
	action: "RESOLVE_MAPPINGS" | "CONFIRM_IMPORT" | "LINK_EXISTING" | "SKIP";
	reasonNote?: string | null | undefined;
	idempotencyKey?: string | null | undefined;
	resolvedMappings?:
		| {
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
		  }
		| undefined;
	linkTarget?:
		| {
				targetType: "CREDIT_CARD_PURCHASE" | "INCOME_RECEIPT";
				targetId: string;
		  }
		| undefined;
}

/**
 * Resolves an import row (updates mappings, confirms duplicate, links existing, or skips).
 */
export async function resolveImportRow(
	db: Database | DatabaseTransaction,
	params: ResolveImportRowParams,
): Promise<ImportRowDetail> {
	if (!params.userId || typeof params.userId !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "userId is required");
	}
	if (!params.importRowId || typeof params.importRowId !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "importRowId is required");
	}
	if (
		params.expectedRevisionNo == null ||
		!Number.isInteger(params.expectedRevisionNo) ||
		params.expectedRevisionNo < 1
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"Valid expectedRevisionNo >= 1 is required",
		);
	}

	return await withImportTransaction(db, async (tx) => {
		// 1. Lock import_rows row
		const [row] = await tx
			.select()
			.from(importRows)
			.where(
				and(
					eq(importRows.id, params.importRowId),
					eq(importRows.userId, params.userId),
				),
			)
			.for("update");

		if (!row) {
			throw new ImportError(
				"IMPORT_ROW_NOT_FOUND",
				`Import row ${params.importRowId} not found`,
			);
		}

		// 2. Fetch latest revision
		const [latestRev] = await tx
			.select()
			.from(importRowRevisions)
			.where(eq(importRowRevisions.importRowId, row.id))
			.orderBy(desc(importRowRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				`No revisions found for row ${row.id}`,
			);
		}

		// 3. Check OCC
		if (latestRev.revisionNo !== params.expectedRevisionNo) {
			throw new ImportError(
				"IMPORT_REVISION_CONFLICT",
				`Revision conflict: expected ${params.expectedRevisionNo}, found ${latestRev.revisionNo}`,
			);
		}

		// 4. Check terminal states
		if (
			latestRev.status === "APPLIED" ||
			latestRev.status === "LINKED_EXISTING" ||
			latestRev.status === "SKIPPED" ||
			latestRev.status === "EXACT_DUPLICATE"
		) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				`Cannot resolve row in terminal status ${latestRev.status}`,
			);
		}

		let nextOperation: ImportRowOperation = "RESOLVE";
		let nextStatus: ImportRowStatus = latestRev.status as ImportRowStatus;
		let nextPayload: NormalizedImportPayload =
			latestRev.payload as NormalizedImportPayload;

		if (params.action === "SKIP") {
			nextOperation = "SKIP";
			nextStatus = "SKIPPED";
		} else if (params.action === "CONFIRM_IMPORT") {
			if (latestRev.status !== "POSSIBLE_DUPLICATE") {
				throw new ImportError(
					"IMPORT_INVALID_STATE",
					`CONFIRM_IMPORT is only valid from POSSIBLE_DUPLICATE status (current: ${latestRev.status})`,
				);
			}
			nextOperation = "RESOLVE";
			nextStatus = "READY";
		} else if (params.action === "RESOLVE_MAPPINGS") {
			if (row.recordType === "UNSUPPORTED") {
				throw new ImportError(
					"IMPORT_UNSUPPORTED_RECORD",
					"Cannot resolve mappings for UNSUPPORTED record",
				);
			}

			nextOperation = "RESOLVE";
			const mappings = params.resolvedMappings ?? {};

			if (row.recordType === "CREDIT_CARD_PURCHASE") {
				const current = latestRev.payload as NormalizedCardPurchasePayload;
				const cardId =
					mappings.cardId !== undefined ? mappings.cardId : current.cardId;
				const purchaseCategory =
					mappings.purchaseCategory !== undefined
						? mappings.purchaseCategory
						: current.purchaseCategory;
				const shortTermGoalId =
					mappings.shortTermGoalId !== undefined
						? mappings.shortTermGoalId
						: current.shortTermGoalId;

				if (purchaseCategory === "SHORT_TERM_PURCHASE" && !shortTermGoalId) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"shortTermGoalId is required when purchaseCategory is SHORT_TERM_PURCHASE",
					);
				}
				if (purchaseCategory !== "SHORT_TERM_PURCHASE" && shortTermGoalId) {
					throw new ImportError(
						"IMPORT_INVALID_INPUT",
						"shortTermGoalId is forbidden when purchaseCategory is not SHORT_TERM_PURCHASE",
					);
				}

				nextPayload = {
					...current,
					cardId,
					purchaseCategory,
					shortTermGoalId,
				};

				const isReady = cardId !== null && purchaseCategory !== null;
				nextStatus = isReady ? "READY" : "NEEDS_REVIEW";
			} else if (row.recordType === "INCOME_RECEIPT") {
				const current = latestRev.payload as NormalizedIncomeReceiptPayload;
				const incomeSourceId =
					mappings.incomeSourceId !== undefined
						? mappings.incomeSourceId
						: current.incomeSourceId;
				const destinationAccountId =
					mappings.destinationAccountId !== undefined
						? mappings.destinationAccountId
						: current.destinationAccountId;

				nextPayload = {
					...current,
					incomeSourceId,
					destinationAccountId,
				};

				const isReady =
					incomeSourceId !== null && destinationAccountId !== null;
				nextStatus = isReady ? "READY" : "NEEDS_REVIEW";
			}
		} else if (params.action === "LINK_EXISTING") {
			if (row.recordType === "UNSUPPORTED") {
				throw new ImportError(
					"IMPORT_UNSUPPORTED_RECORD",
					"Cannot link UNSUPPORTED record",
				);
			}
			if (!params.linkTarget?.targetId) {
				throw new ImportError(
					"IMPORT_INVALID_INPUT",
					"linkTarget with targetId and targetType is required for LINK_EXISTING",
				);
			}

			const targetId = params.linkTarget.targetId.trim();
			const targetType = params.linkTarget.targetType;

			if (row.recordType === "CREDIT_CARD_PURCHASE") {
				if (targetType !== "CREDIT_CARD_PURCHASE") {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Target type ${targetType} does not match row recordType ${row.recordType}`,
					);
				}

				const cardPayload = latestRev.payload as NormalizedCardPurchasePayload;
				const [eventRow] = await tx
					.select({
						id: creditCardLiabilityEvents.id,
						creditCardId: creditCardLiabilityEvents.creditCardId,
						eventType: creditCardLiabilityEvents.eventType,
						canonicalTransactionId:
							creditCardLiabilityEvents.canonicalTransactionId,
						amount: creditCardLiabilityEventRevisions.amount,
					})
					.from(creditCardLiabilityEvents)
					.innerJoin(
						creditCardLiabilityEventRevisions,
						eq(
							creditCardLiabilityEvents.id,
							creditCardLiabilityEventRevisions.eventId,
						),
					)
					.where(
						and(
							eq(creditCardLiabilityEvents.id, targetId),
							eq(creditCardLiabilityEvents.userId, params.userId),
						),
					)
					.orderBy(desc(creditCardLiabilityEventRevisions.revisionNo))
					.limit(1);

				if (!eventRow) {
					throw new ImportError(
						"IMPORT_TARGET_NOT_FOUND",
						`Credit card liability event ${targetId} not found`,
					);
				}
				if (eventRow.eventType !== "PURCHASE") {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Target event must have eventType PURCHASE, got ${eventRow.eventType}`,
					);
				}

				if (
					cardPayload.cardId &&
					eventRow.creditCardId !== cardPayload.cardId
				) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Card ID mismatch: event has ${eventRow.creditCardId}, row has ${cardPayload.cardId}`,
					);
				}
				if (eventRow.amount !== cardPayload.amount) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Amount mismatch: event has ${eventRow.amount}, row has ${cardPayload.amount}`,
					);
				}

				// Insert row result
				await tx.insert(importRowResults).values({
					userId: params.userId,
					importRowId: row.id,
					resultKind: "LINKED_EXISTING",
					targetType: "CREDIT_CARD_PURCHASE",
					targetId: eventRow.id,
					canonicalTransactionId: eventRow.canonicalTransactionId,
				});

				// Insert external claim if external ID hash is present
				if (row.externalTransactionIdHash) {
					const [batch] = await tx
						.select({ provider: importBatches.provider })
						.from(importBatches)
						.where(eq(importBatches.id, row.batchId))
						.limit(1);

					if (batch) {
						await tx.insert(importExternalIdentityClaims).values({
							userId: params.userId,
							provider: batch.provider,
							recordType: "CREDIT_CARD_PURCHASE",
							scopeId: eventRow.creditCardId,
							externalTransactionIdHash: row.externalTransactionIdHash,
							importRowId: row.id,
						});
					}
				}
			} else if (row.recordType === "INCOME_RECEIPT") {
				if (targetType !== "INCOME_RECEIPT") {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Target type ${targetType} does not match row recordType ${row.recordType}`,
					);
				}

				const incPayload = latestRev.payload as NormalizedIncomeReceiptPayload;
				const [receiptRow] = await tx
					.select({
						id: incomeReceipts.id,
						sourceId: incomeReceipts.sourceId,
						canonicalTransactionId: incomeReceipts.canonicalTransactionId,
						destinationAccountId: incomeReceiptRevisions.destinationAccountId,
						amount: incomeReceiptRevisions.amount,
					})
					.from(incomeReceipts)
					.innerJoin(
						incomeReceiptRevisions,
						eq(incomeReceipts.id, incomeReceiptRevisions.incomeReceiptId),
					)
					.where(
						and(
							eq(incomeReceipts.id, targetId),
							eq(incomeReceipts.userId, params.userId),
						),
					)
					.orderBy(desc(incomeReceiptRevisions.revisionNo))
					.limit(1);

				if (!receiptRow) {
					throw new ImportError(
						"IMPORT_TARGET_NOT_FOUND",
						`Income receipt ${targetId} not found`,
					);
				}

				if (
					incPayload.incomeSourceId &&
					receiptRow.sourceId !== incPayload.incomeSourceId
				) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Income source mismatch: receipt has ${receiptRow.sourceId}, row has ${incPayload.incomeSourceId}`,
					);
				}
				if (
					incPayload.destinationAccountId &&
					receiptRow.destinationAccountId !== incPayload.destinationAccountId
				) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Destination account mismatch: receipt has ${receiptRow.destinationAccountId}, row has ${incPayload.destinationAccountId}`,
					);
				}
				if (receiptRow.amount !== incPayload.amount) {
					throw new ImportError(
						"IMPORT_TARGET_MISMATCH",
						`Amount mismatch: receipt has ${receiptRow.amount}, row has ${incPayload.amount}`,
					);
				}

				await tx.insert(importRowResults).values({
					userId: params.userId,
					importRowId: row.id,
					resultKind: "LINKED_EXISTING",
					targetType: "INCOME_RECEIPT",
					targetId: receiptRow.id,
					canonicalTransactionId: receiptRow.canonicalTransactionId,
				});

				if (row.externalTransactionIdHash) {
					const [batch] = await tx
						.select({ provider: importBatches.provider })
						.from(importBatches)
						.where(eq(importBatches.id, row.batchId))
						.limit(1);

					if (batch) {
						await tx.insert(importExternalIdentityClaims).values({
							userId: params.userId,
							provider: batch.provider,
							recordType: "INCOME_RECEIPT",
							scopeId: receiptRow.destinationAccountId,
							externalTransactionIdHash: row.externalTransactionIdHash,
							importRowId: row.id,
						});
					}
				}
			}

			nextOperation = "LINK";
			nextStatus = "LINKED_EXISTING";
		}

		const nextRevNo = latestRev.revisionNo + 1;
		const revFingerprint = await computeRevisionFingerprint({
			importRowId: row.id,
			revisionNo: nextRevNo,
			operation: nextOperation,
			status: nextStatus,
			payload: nextPayload,
			reasonNote: params.reasonNote,
			idempotencyKey: params.idempotencyKey,
		});

		const [newRev] = await tx
			.insert(importRowRevisions)
			.values({
				userId: params.userId,
				importRowId: row.id,
				revisionNo: nextRevNo,
				previousRevisionId: latestRev.id,
				operation: nextOperation,
				status: nextStatus,
				payload: nextPayload,
				reasonNote: params.reasonNote ?? null,
				occurredAt: latestRev.occurredAt,
				idempotencyKey: params.idempotencyKey ?? null,
				revisionFingerprint: revFingerprint,
			})
			.returning();

		if (!newRev) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				"Failed to insert resolution revision",
			);
		}

		// Fetch candidates and result
		const candidates = await tx
			.select()
			.from(importDuplicateCandidates)
			.where(eq(importDuplicateCandidates.importRowId, row.id));

		const [result] = await tx
			.select()
			.from(importRowResults)
			.where(eq(importRowResults.importRowId, row.id))
			.limit(1);

		return {
			id: row.id,
			userId: row.userId,
			batchId: row.batchId,
			rowOrdinal: row.rowOrdinal,
			recordType: row.recordType as ImportRecordType,
			latestRevisionNo: newRev.revisionNo,
			status: newRev.status as ImportRowStatus,
			payload: newRev.payload as NormalizedImportPayload,
			occurredAt: newRev.occurredAt,
			externalIdentityPresent: row.externalTransactionIdHash !== null,
			duplicateCandidates: candidates.map((c) => ({
				candidateType: c.candidateType as ImportDuplicateCandidateType,
				candidateId: c.candidateId,
				reasonCode: c.reasonCode as ImportDuplicateReasonCode,
			})),
			result: result
				? {
						resultKind: result.resultKind as ImportResultKind,
						targetType: result.targetType as ImportResultTargetType,
						targetId: result.targetId,
						canonicalTransactionId: result.canonicalTransactionId,
					}
				: null,
		};
	});
}

export interface ApplyImportRowParams {
	userId: string;
	importRowId: string;
	expectedRevisionNo: number;
	idempotencyKey?: string | null | undefined;
}

export interface ApplyImportRowResult {
	row: ImportRowDetail;
	idempotentReplay: boolean;
	resultKind: ImportResultKind;
	targetType: ImportResultTargetType;
	targetId: string;
	canonicalTransactionId: string | null;
}

/**
 * Applies a single READY import row to authoritative financial domains.
 */
export async function applyImportRow(
	db: Database | DatabaseTransaction,
	params: ApplyImportRowParams,
): Promise<ApplyImportRowResult> {
	if (!params.userId || typeof params.userId !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "userId is required");
	}
	if (!params.importRowId || typeof params.importRowId !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "importRowId is required");
	}
	if (
		params.expectedRevisionNo == null ||
		!Number.isInteger(params.expectedRevisionNo) ||
		params.expectedRevisionNo < 1
	) {
		throw new ImportError(
			"IMPORT_INVALID_INPUT",
			"Valid expectedRevisionNo >= 1 is required",
		);
	}

	return await withImportTransaction(db, async (tx) => {
		// 1. Lock import_rows row FOR UPDATE
		const [row] = await tx
			.select()
			.from(importRows)
			.where(
				and(
					eq(importRows.id, params.importRowId),
					eq(importRows.userId, params.userId),
				),
			)
			.for("update");

		if (!row) {
			throw new ImportError(
				"IMPORT_ROW_NOT_FOUND",
				`Import row ${params.importRowId} not found`,
			);
		}

		// 2. Fetch latest revision
		const [latestRev] = await tx
			.select()
			.from(importRowRevisions)
			.where(eq(importRowRevisions.importRowId, row.id))
			.orderBy(desc(importRowRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				`No revisions found for row ${row.id}`,
			);
		}

		// 3. Idempotent replay check if already terminal APPLIED
		if (latestRev.status === "APPLIED") {
			const [existingResult] = await tx
				.select()
				.from(importRowResults)
				.where(eq(importRowResults.importRowId, row.id))
				.limit(1);

			if (existingResult) {
				const candidates = await tx
					.select()
					.from(importDuplicateCandidates)
					.where(eq(importDuplicateCandidates.importRowId, row.id));

				return {
					row: {
						id: row.id,
						userId: row.userId,
						batchId: row.batchId,
						rowOrdinal: row.rowOrdinal,
						recordType: row.recordType as ImportRecordType,
						latestRevisionNo: latestRev.revisionNo,
						status: "APPLIED",
						payload: latestRev.payload as NormalizedImportPayload,
						occurredAt: latestRev.occurredAt,
						externalIdentityPresent: row.externalTransactionIdHash !== null,
						duplicateCandidates: candidates.map((c) => ({
							candidateType: c.candidateType as ImportDuplicateCandidateType,
							candidateId: c.candidateId,
							reasonCode: c.reasonCode as ImportDuplicateReasonCode,
						})),
						result: {
							resultKind: existingResult.resultKind as ImportResultKind,
							targetType: existingResult.targetType as ImportResultTargetType,
							targetId: existingResult.targetId,
							canonicalTransactionId: existingResult.canonicalTransactionId,
						},
					},
					idempotentReplay: true,
					resultKind: existingResult.resultKind as ImportResultKind,
					targetType: existingResult.targetType as ImportResultTargetType,
					targetId: existingResult.targetId,
					canonicalTransactionId: existingResult.canonicalTransactionId,
				};
			}
		}

		// 4. Check OCC
		if (latestRev.revisionNo !== params.expectedRevisionNo) {
			throw new ImportError(
				"IMPORT_REVISION_CONFLICT",
				`Revision conflict: expected ${params.expectedRevisionNo}, found ${latestRev.revisionNo}`,
			);
		}

		// 5. Verify status is READY
		if (latestRev.status === "NEEDS_REVIEW") {
			throw new ImportError(
				"IMPORT_NEEDS_REVIEW",
				"Cannot APPLY row in NEEDS_REVIEW status. Resolve missing mappings first.",
			);
		}
		if (latestRev.status === "POSSIBLE_DUPLICATE") {
			throw new ImportError(
				"IMPORT_POSSIBLE_DUPLICATE",
				"Cannot APPLY row in POSSIBLE_DUPLICATE status. Explicitly confirm or link first.",
			);
		}
		if (latestRev.status === "UNSUPPORTED") {
			throw new ImportError(
				"IMPORT_UNSUPPORTED_RECORD",
				"Cannot APPLY UNSUPPORTED record",
			);
		}
		if (latestRev.status === "EXACT_DUPLICATE") {
			throw new ImportError(
				"IMPORT_EXACT_DUPLICATE",
				"Cannot APPLY EXACT_DUPLICATE row",
			);
		}
		if (latestRev.status !== "READY") {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				`Cannot APPLY row with status ${latestRev.status}`,
			);
		}

		// Fetch batch info for provider and observedAt
		const [batch] = await tx
			.select()
			.from(importBatches)
			.where(eq(importBatches.id, row.batchId))
			.limit(1);

		if (!batch) {
			throw new ImportError("IMPORT_BATCH_NOT_FOUND", "Import batch not found");
		}

		const nextRevNo = latestRev.revisionNo + 1;
		let targetId: string;
		let targetType: ImportResultTargetType;
		let canonicalTxId: string | null = null;

		if (row.recordType === "CREDIT_CARD_PURCHASE") {
			targetType = "CREDIT_CARD_PURCHASE";
			const cardPayload = latestRev.payload as NormalizedCardPurchasePayload;

			if (!cardPayload.cardId) {
				throw new ImportError(
					"IMPORT_NEEDS_REVIEW",
					"cardId is required to apply credit card purchase",
				);
			}
			if (!cardPayload.purchaseCategory) {
				throw new ImportError(
					"IMPORT_NEEDS_REVIEW",
					"purchaseCategory is required to apply credit card purchase",
				);
			}

			const childIdempotencyKey = await computeChildIdempotencyKey(
				"IMPORT_CARD",
				row.id,
				nextRevNo,
			);

			const purchaseRes = await recordCreditCardPurchaseInTransaction({
				tx,
				userId: params.userId,
				cardId: cardPayload.cardId,
				amount: cardPayload.amount,
				purchaseCategory: cardPayload.purchaseCategory,
				shortTermGoalId: cardPayload.shortTermGoalId ?? undefined,
				merchant: cardPayload.merchant ?? undefined,
				description: cardPayload.description ?? undefined,
				installmentCount: cardPayload.installmentCount ?? undefined,
				occurredAt: new Date(cardPayload.occurredAt),
				idempotencyKey: childIdempotencyKey,
			});

			targetId = purchaseRes.eventId;

			const [event] = await tx
				.select({
					canonicalTransactionId:
						creditCardLiabilityEvents.canonicalTransactionId,
				})
				.from(creditCardLiabilityEvents)
				.where(eq(creditCardLiabilityEvents.id, targetId))
				.limit(1);

			canonicalTxId = event?.canonicalTransactionId ?? null;

			// Insert external identity claim if hash present
			if (row.externalTransactionIdHash) {
				await tx.insert(importExternalIdentityClaims).values({
					userId: params.userId,
					provider: batch.provider,
					recordType: "CREDIT_CARD_PURCHASE",
					scopeId: cardPayload.cardId,
					externalTransactionIdHash: row.externalTransactionIdHash,
					importRowId: row.id,
				});
			}
		} else if (row.recordType === "INCOME_RECEIPT") {
			targetType = "INCOME_RECEIPT";
			const incPayload = latestRev.payload as NormalizedIncomeReceiptPayload;

			if (!incPayload.incomeSourceId) {
				throw new ImportError(
					"IMPORT_NEEDS_REVIEW",
					"incomeSourceId is required to apply income receipt",
				);
			}
			if (!incPayload.destinationAccountId) {
				throw new ImportError(
					"IMPORT_NEEDS_REVIEW",
					"destinationAccountId is required to apply income receipt",
				);
			}

			const childIdempotencyKey = await computeChildIdempotencyKey(
				"IMPORT_INCOME",
				row.id,
				nextRevNo,
			);

			const incomeRes = await createIncomeReceiptInTransaction({
				tx,
				userId: params.userId,
				sourceId: incPayload.incomeSourceId,
				destinationAccountId: incPayload.destinationAccountId,
				receivedAt: new Date(incPayload.receivedAt),
				amount: incPayload.amount,
				note: incPayload.note ?? undefined,
				idempotencyKey: childIdempotencyKey,
				provenance: {
					type: "IMPORT",
					ref: row.id,
					payloadHash: row.semanticFingerprint,
					observedAt: batch.observedAt,
				},
			});

			targetId = incomeRes.incomeReceipt.incomeReceiptId;
			canonicalTxId = incomeRes.incomeReceipt.canonicalTransactionId;

			// Insert external identity claim if hash present
			if (row.externalTransactionIdHash) {
				await tx.insert(importExternalIdentityClaims).values({
					userId: params.userId,
					provider: batch.provider,
					recordType: "INCOME_RECEIPT",
					scopeId: incPayload.destinationAccountId,
					externalTransactionIdHash: row.externalTransactionIdHash,
					importRowId: row.id,
				});
			}
		} else {
			throw new ImportError(
				"IMPORT_UNSUPPORTED_RECORD",
				`Cannot apply record of type ${row.recordType}`,
			);
		}

		// Insert row result
		const [rowResult] = await tx
			.insert(importRowResults)
			.values({
				userId: params.userId,
				importRowId: row.id,
				resultKind: "CREATED",
				targetType,
				targetId,
				canonicalTransactionId: canonicalTxId,
			})
			.returning();

		if (!rowResult) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				"Failed to insert import row result",
			);
		}

		// Insert terminal revision #N (APPLIED)
		const revFingerprint = await computeRevisionFingerprint({
			importRowId: row.id,
			revisionNo: nextRevNo,
			operation: "APPLY",
			status: "APPLIED",
			payload: latestRev.payload,
			idempotencyKey: params.idempotencyKey ?? null,
		});

		const [appliedRev] = await tx
			.insert(importRowRevisions)
			.values({
				userId: params.userId,
				importRowId: row.id,
				revisionNo: nextRevNo,
				previousRevisionId: latestRev.id,
				operation: "APPLY",
				status: "APPLIED",
				payload: latestRev.payload as NormalizedImportPayload,
				occurredAt: latestRev.occurredAt,
				idempotencyKey: params.idempotencyKey ?? null,
				revisionFingerprint: revFingerprint,
			})
			.returning();

		if (!appliedRev) {
			throw new ImportError(
				"IMPORT_INVALID_STATE",
				"Failed to append terminal APPLIED revision",
			);
		}

		const candidates = await tx
			.select()
			.from(importDuplicateCandidates)
			.where(eq(importDuplicateCandidates.importRowId, row.id));

		return {
			row: {
				id: row.id,
				userId: row.userId,
				batchId: row.batchId,
				rowOrdinal: row.rowOrdinal,
				recordType: row.recordType as ImportRecordType,
				latestRevisionNo: appliedRev.revisionNo,
				status: "APPLIED",
				payload: appliedRev.payload as NormalizedImportPayload,
				occurredAt: appliedRev.occurredAt,
				externalIdentityPresent: row.externalTransactionIdHash !== null,
				duplicateCandidates: candidates.map((c) => ({
					candidateType: c.candidateType as ImportDuplicateCandidateType,
					candidateId: c.candidateId,
					reasonCode: c.reasonCode as ImportDuplicateReasonCode,
				})),
				result: {
					resultKind: "CREATED",
					targetType,
					targetId,
					canonicalTransactionId: canonicalTxId,
				},
			},
			idempotentReplay: false,
			resultKind: "CREATED",
			targetType,
			targetId,
			canonicalTransactionId: canonicalTxId,
		};
	});
}

export interface ApplyReadyImportRowsResult {
	batchId: string;
	totalRows: number;
	appliedCount: number;
	alreadyAppliedCount: number;
	skippedOrPendingCount: number;
	failedCount: number;
	errors: Array<{
		rowId: string;
		rowOrdinal: number;
		error: string;
	}>;
}

/**
 * Resumable batch apply orchestration.
 * Processes rows in stable rowOrdinal ASC order where each row is an independent atomic transaction.
 */
export async function applyReadyImportRows(
	db: Database,
	params: { userId: string; batchId: string },
): Promise<ApplyReadyImportRowsResult> {
	if (!params.userId || typeof params.userId !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "userId is required");
	}
	if (!params.batchId || typeof params.batchId !== "string") {
		throw new ImportError("IMPORT_INVALID_INPUT", "batchId is required");
	}

	const batchRows = await db
		.select({
			id: importRows.id,
			rowOrdinal: importRows.rowOrdinal,
		})
		.from(importRows)
		.where(
			and(
				eq(importRows.userId, params.userId),
				eq(importRows.batchId, params.batchId),
			),
		)
		.orderBy(importRows.rowOrdinal);

	let appliedCount = 0;
	let alreadyAppliedCount = 0;
	let skippedOrPendingCount = 0;
	let failedCount = 0;
	const errors: Array<{ rowId: string; rowOrdinal: number; error: string }> =
		[];

	for (const r of batchRows) {
		// Fetch latest revision for this row
		const [latestRev] = await db
			.select({
				revisionNo: importRowRevisions.revisionNo,
				status: importRowRevisions.status,
			})
			.from(importRowRevisions)
			.where(eq(importRowRevisions.importRowId, r.id))
			.orderBy(desc(importRowRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			skippedOrPendingCount++;
			continue;
		}

		if (latestRev.status === "APPLIED") {
			alreadyAppliedCount++;
			continue;
		}

		if (latestRev.status !== "READY") {
			skippedOrPendingCount++;
			continue;
		}

		try {
			await applyImportRow(db, {
				userId: params.userId,
				importRowId: r.id,
				expectedRevisionNo: latestRev.revisionNo,
			});
			appliedCount++;
		} catch (err) {
			failedCount++;
			errors.push({
				rowId: r.id,
				rowOrdinal: r.rowOrdinal,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		batchId: params.batchId,
		totalRows: batchRows.length,
		appliedCount,
		alreadyAppliedCount,
		skippedOrPendingCount,
		failedCount,
		errors,
	};
}

/**
 * Previews an import batch without mutating state.
 */
export async function previewImportBatch(
	db: Database | DatabaseTransaction,
	userId: string,
	batchId: string,
): Promise<{
	batch: ImportBatchSummary;
	rows: ImportRowDetail[];
}> {
	return await getImportBatchWithDetails(db, userId, batchId);
}

/**
 * Gets a single batch with full details and summary.
 */
export async function getImportBatchWithDetails(
	db: Database | DatabaseTransaction,
	userId: string,
	batchId: string,
): Promise<{
	batch: ImportBatchSummary;
	rows: ImportRowDetail[];
}> {
	const [batch] = await db
		.select()
		.from(importBatches)
		.where(and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)))
		.limit(1);

	if (!batch) {
		throw new ImportError(
			"IMPORT_BATCH_NOT_FOUND",
			`Import batch ${batchId} not found`,
		);
	}

	const rows = await db
		.select()
		.from(importRows)
		.where(and(eq(importRows.batchId, batchId), eq(importRows.userId, userId)))
		.orderBy(importRows.rowOrdinal);

	const rowIds = rows.map((r) => r.id);

	let allRevisions: Array<{
		id: string;
		importRowId: string;
		revisionNo: number;
		status: string;
		payload: unknown;
		occurredAt: Date | null;
	}> = [];

	let allCandidates: Array<{
		importRowId: string;
		candidateType: string;
		candidateId: string;
		reasonCode: string;
	}> = [];

	let allResults: Array<{
		importRowId: string;
		resultKind: string;
		targetType: string;
		targetId: string;
		canonicalTransactionId: string | null;
	}> = [];

	if (rowIds.length > 0) {
		allRevisions = await db
			.select({
				id: importRowRevisions.id,
				importRowId: importRowRevisions.importRowId,
				revisionNo: importRowRevisions.revisionNo,
				status: importRowRevisions.status,
				payload: importRowRevisions.payload,
				occurredAt: importRowRevisions.occurredAt,
			})
			.from(importRowRevisions)
			.where(inArray(importRowRevisions.importRowId, rowIds))
			.orderBy(
				importRowRevisions.importRowId,
				desc(importRowRevisions.revisionNo),
			);

		allCandidates = await db
			.select({
				importRowId: importDuplicateCandidates.importRowId,
				candidateType: importDuplicateCandidates.candidateType,
				candidateId: importDuplicateCandidates.candidateId,
				reasonCode: importDuplicateCandidates.reasonCode,
			})
			.from(importDuplicateCandidates)
			.where(inArray(importDuplicateCandidates.importRowId, rowIds));

		allResults = await db
			.select({
				importRowId: importRowResults.importRowId,
				resultKind: importRowResults.resultKind,
				targetType: importRowResults.targetType,
				targetId: importRowResults.targetId,
				canonicalTransactionId: importRowResults.canonicalTransactionId,
			})
			.from(importRowResults)
			.where(inArray(importRowResults.importRowId, rowIds));
	}

	// Map latest revision per row
	const latestRevByRowId = new Map<string, (typeof allRevisions)[0]>();
	for (const rev of allRevisions) {
		if (!latestRevByRowId.has(rev.importRowId)) {
			latestRevByRowId.set(rev.importRowId, rev);
		}
	}

	const candidatesByRowId = new Map<string, typeof allCandidates>();
	for (const c of allCandidates) {
		const list = candidatesByRowId.get(c.importRowId) ?? [];
		list.push(c);
		candidatesByRowId.set(c.importRowId, list);
	}

	const resultByRowId = new Map<string, (typeof allResults)[0]>();
	for (const res of allResults) {
		resultByRowId.set(res.importRowId, res);
	}

	const rowDetails: ImportRowDetail[] = rows.map((r) => {
		const latest = latestRevByRowId.get(r.id);
		const candList = candidatesByRowId.get(r.id) ?? [];
		const res = resultByRowId.get(r.id);

		return {
			id: r.id,
			userId: r.userId,
			batchId: r.batchId,
			rowOrdinal: r.rowOrdinal,
			recordType: r.recordType as ImportRecordType,
			latestRevisionNo: latest?.revisionNo ?? 1,
			status: (latest?.status ?? "NEEDS_REVIEW") as ImportRowStatus,
			payload: (latest?.payload ?? {}) as NormalizedImportPayload,
			occurredAt: latest?.occurredAt ?? null,
			externalIdentityPresent: r.externalTransactionIdHash !== null,
			duplicateCandidates: candList.map((c) => ({
				candidateType: c.candidateType as ImportDuplicateCandidateType,
				candidateId: c.candidateId,
				reasonCode: c.reasonCode as ImportDuplicateReasonCode,
			})),
			result: res
				? {
						resultKind: res.resultKind as ImportResultKind,
						targetType: res.targetType as ImportResultTargetType,
						targetId: res.targetId,
						canonicalTransactionId: res.canonicalTransactionId,
					}
				: null,
		};
	});

	const summary: ImportBatchSummary = {
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
		totalRows: rowDetails.length,
		readyCount: rowDetails.filter((r) => r.status === "READY").length,
		needsReviewCount: rowDetails.filter((r) => r.status === "NEEDS_REVIEW")
			.length,
		possibleDuplicateCount: rowDetails.filter(
			(r) => r.status === "POSSIBLE_DUPLICATE",
		).length,
		exactDuplicateCount: rowDetails.filter(
			(r) => r.status === "EXACT_DUPLICATE",
		).length,
		appliedCount: rowDetails.filter((r) => r.status === "APPLIED").length,
		linkedCount: rowDetails.filter((r) => r.status === "LINKED_EXISTING")
			.length,
		skippedCount: rowDetails.filter((r) => r.status === "SKIPPED").length,
		unsupportedCount: rowDetails.filter((r) => r.status === "UNSUPPORTED")
			.length,
	};

	return {
		batch: summary,
		rows: rowDetails,
	};
}

export async function getImportBatch(
	db: Database | DatabaseTransaction,
	userId: string,
	batchId: string,
): Promise<ImportBatchSummary> {
	const res = await getImportBatchWithDetails(db, userId, batchId);
	return res.batch;
}

export async function listImportBatches(
	db: Database | DatabaseTransaction,
	userId: string,
): Promise<ImportBatchSummary[]> {
	const batches = await db
		.select()
		.from(importBatches)
		.where(eq(importBatches.userId, userId))
		.orderBy(desc(importBatches.createdAt));

	const summaries: ImportBatchSummary[] = [];
	for (const b of batches) {
		const res = await getImportBatchWithDetails(db, userId, b.id);
		summaries.push(res.batch);
	}
	return summaries;
}

export async function getImportRow(
	db: Database | DatabaseTransaction,
	userId: string,
	rowId: string,
): Promise<ImportRowDetail> {
	const [row] = await db
		.select()
		.from(importRows)
		.where(and(eq(importRows.id, rowId), eq(importRows.userId, userId)))
		.limit(1);

	if (!row) {
		throw new ImportError(
			"IMPORT_ROW_NOT_FOUND",
			`Import row ${rowId} not found`,
		);
	}

	const batchDetails = await getImportBatchWithDetails(db, userId, row.batchId);
	const found = batchDetails.rows.find((r) => r.id === rowId);
	if (!found) {
		throw new ImportError(
			"IMPORT_ROW_NOT_FOUND",
			`Import row ${rowId} not found in batch`,
		);
	}
	return found;
}

export async function listImportRows(
	db: Database | DatabaseTransaction,
	userId: string,
	batchId: string,
): Promise<ImportRowDetail[]> {
	const res = await getImportBatchWithDetails(db, userId, batchId);
	return res.rows;
}
