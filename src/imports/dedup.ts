import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { formatIstanbulPurchaseDate } from "../credit-cards/calendar";
import type { DatabaseTransaction } from "../db/client";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "../db/schema/credit-card-ledger";
import {
	type ImportDuplicateCandidateType,
	type ImportDuplicateReasonCode,
	importExternalIdentityClaims,
} from "../db/schema/imports";
import { incomeReceiptRevisions, incomeReceipts } from "../db/schema/income";
import type {
	NormalizedCardPurchasePayload,
	NormalizedImportRow,
	NormalizedIncomeReceiptPayload,
} from "./normalize";

export interface DuplicateCandidateMatch {
	rowOrdinal: number;
	candidateType: ImportDuplicateCandidateType;
	candidateId: string; // Target UUID for CREDIT_CARD_PURCHASE / INCOME_RECEIPT / IMPORT_ROW
	candidateRowOrdinal?: number | undefined; // For intra-batch rows before UUID resolution
	reasonCode: ImportDuplicateReasonCode;
}

export interface DedupAnalysisResult {
	rowsWithStatus: Array<{
		row: NormalizedImportRow;
		finalStatus:
			| "READY"
			| "NEEDS_REVIEW"
			| "POSSIBLE_DUPLICATE"
			| "EXACT_DUPLICATE"
			| "UNSUPPORTED";
		candidates: DuplicateCandidateMatch[];
	}>;
}

/**
 * Performs intra-batch duplicate detection (identifying identical semantic fingerprints within the same batch).
 */
export function analyzeIntraBatchDuplicates(
	rows: NormalizedImportRow[],
): Map<number, DuplicateCandidateMatch[]> {
	const candidatesByOrdinal = new Map<number, DuplicateCandidateMatch[]>();
	const ordinalByFingerprint = new Map<string, number[]>();

	for (const r of rows) {
		if (r.recordType === "UNSUPPORTED") continue;
		const existing = ordinalByFingerprint.get(r.semanticFingerprint);
		if (existing) {
			existing.push(r.rowOrdinal);
		} else {
			ordinalByFingerprint.set(r.semanticFingerprint, [r.rowOrdinal]);
		}
	}

	for (const [, ordinals] of ordinalByFingerprint) {
		if (ordinals.length > 1) {
			for (const ord of ordinals) {
				for (const otherOrd of ordinals) {
					if (ord !== otherOrd) {
						const list = candidatesByOrdinal.get(ord) ?? [];
						list.push({
							rowOrdinal: ord,
							candidateType: "IMPORT_ROW",
							candidateId: "", // Will be populated with target row UUID during batch insertion
							candidateRowOrdinal: otherOrd,
							reasonCode: "SAME_BATCH_SEMANTICS",
						});
						candidatesByOrdinal.set(ord, list);
					}
				}
			}
		}
	}

	return candidatesByOrdinal;
}

/**
 * Checks strong external identity claims and existing domain entities for candidate duplicates against latest authoritative truth.
 */
export async function analyzeDuplicatesAgainstDb(
	tx: DatabaseTransaction,
	userId: string,
	provider: string,
	rows: NormalizedImportRow[],
): Promise<DedupAnalysisResult> {
	const intraBatchCandidates = analyzeIntraBatchDuplicates(rows);

	// 1. Gather all externalTransactionIdHashes for strong duplicate query
	const extHashes = rows
		.map((r) => r.externalTransactionIdHash)
		.filter((h): h is string => h !== null);

	const existingClaimsMap = new Map<
		string,
		{ scopeId: string; recordType: string }
	>();

	if (extHashes.length > 0) {
		const claims = await tx
			.select({
				recordType: importExternalIdentityClaims.recordType,
				scopeId: importExternalIdentityClaims.scopeId,
				externalTransactionIdHash:
					importExternalIdentityClaims.externalTransactionIdHash,
			})
			.from(importExternalIdentityClaims)
			.where(
				and(
					eq(importExternalIdentityClaims.userId, userId),
					eq(importExternalIdentityClaims.provider, provider),
					inArray(
						importExternalIdentityClaims.externalTransactionIdHash,
						extHashes,
					),
				),
			);

		for (const c of claims) {
			const key = `${c.recordType}:${c.scopeId}:${c.externalTransactionIdHash}`;
			existingClaimsMap.set(key, {
				scopeId: c.scopeId,
				recordType: c.recordType,
			});
		}
	}

	const result: DedupAnalysisResult = { rowsWithStatus: [] };

	for (const r of rows) {
		const candidates: DuplicateCandidateMatch[] = [
			...(intraBatchCandidates.get(r.rowOrdinal) ?? []),
		];

		let finalStatus = r.initialStatus;

		// 2. Strong external identity check
		if (r.externalTransactionIdHash && r.recordType !== "UNSUPPORTED") {
			let scopeId: string | null = null;
			if (r.recordType === "CREDIT_CARD_PURCHASE") {
				scopeId = (r.payload as NormalizedCardPurchasePayload).cardId;
			} else if (r.recordType === "INCOME_RECEIPT") {
				scopeId = (r.payload as NormalizedIncomeReceiptPayload)
					.destinationAccountId;
			}

			if (scopeId) {
				const claimKey = `${r.recordType}:${scopeId}:${r.externalTransactionIdHash}`;
				if (existingClaimsMap.has(claimKey)) {
					finalStatus = "EXACT_DUPLICATE";
				}
			}
		}

		// 3. Conservative Candidate duplicate check against DB if not EXACT_DUPLICATE
		// MUST join ONLY the latest revision of each liability event / income receipt
		if (finalStatus !== "EXACT_DUPLICATE" && r.occurredAt) {
			if (r.recordType === "CREDIT_CARD_PURCHASE") {
				const cardPayload = r.payload as NormalizedCardPurchasePayload;
				if (cardPayload.cardId) {
					const purchaseDate = formatIstanbulPurchaseDate(r.occurredAt);

					const latestCcRevSubquery = tx
						.select({
							eventId: creditCardLiabilityEventRevisions.eventId,
							maxRevNo:
								sql<number>`max(${creditCardLiabilityEventRevisions.revisionNo})`.as(
									"max_rev_no",
								),
						})
						.from(creditCardLiabilityEventRevisions)
						.groupBy(creditCardLiabilityEventRevisions.eventId)
						.as("latest_cc_rev");

					const matchingEvents = await tx
						.select({
							id: creditCardLiabilityEvents.id,
							merchant: creditCardLiabilityEventRevisions.merchant,
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
							latestCcRevSubquery,
							and(
								eq(
									creditCardLiabilityEventRevisions.eventId,
									latestCcRevSubquery.eventId,
								),
								eq(
									creditCardLiabilityEventRevisions.revisionNo,
									latestCcRevSubquery.maxRevNo,
								),
							),
						)
						.where(
							and(
								eq(creditCardLiabilityEvents.userId, userId),
								eq(creditCardLiabilityEvents.creditCardId, cardPayload.cardId),
								eq(creditCardLiabilityEvents.eventType, "PURCHASE"),
								eq(
									creditCardLiabilityEventRevisions.purchaseDate,
									purchaseDate,
								),
								eq(
									creditCardLiabilityEventRevisions.amount,
									cardPayload.amount,
								),
								ne(creditCardLiabilityEventRevisions.operation, "VOID"),
							),
						);

					if (matchingEvents.length > 0) {
						for (const ev of matchingEvents) {
							const merchantMatches =
								cardPayload.merchant &&
								ev.merchant &&
								cardPayload.merchant.trim().toLowerCase() ===
									ev.merchant.trim().toLowerCase();

							candidates.push({
								rowOrdinal: r.rowOrdinal,
								candidateType: "CREDIT_CARD_PURCHASE",
								candidateId: ev.id,
								reasonCode: merchantMatches
									? "SAME_CARD_DATE_AMOUNT_MERCHANT"
									: "SAME_CARD_DATE_AMOUNT",
							});
						}
					}
				}
			} else if (r.recordType === "INCOME_RECEIPT") {
				const incPayload = r.payload as NormalizedIncomeReceiptPayload;
				if (incPayload.incomeSourceId && incPayload.destinationAccountId) {
					const latestIncRevSubquery = tx
						.select({
							receiptId: incomeReceiptRevisions.incomeReceiptId,
							maxRevNo:
								sql<number>`max(${incomeReceiptRevisions.revisionNo})`.as(
									"max_rev_no",
								),
						})
						.from(incomeReceiptRevisions)
						.groupBy(incomeReceiptRevisions.incomeReceiptId)
						.as("latest_inc_rev");

					const matchingReceipts = await tx
						.select({
							id: incomeReceipts.id,
							occurredAt: incomeReceiptRevisions.occurredAt,
						})
						.from(incomeReceipts)
						.innerJoin(
							incomeReceiptRevisions,
							eq(incomeReceipts.id, incomeReceiptRevisions.incomeReceiptId),
						)
						.innerJoin(
							latestIncRevSubquery,
							and(
								eq(
									incomeReceiptRevisions.incomeReceiptId,
									latestIncRevSubquery.receiptId,
								),
								eq(
									incomeReceiptRevisions.revisionNo,
									latestIncRevSubquery.maxRevNo,
								),
							),
						)
						.where(
							and(
								eq(incomeReceipts.userId, userId),
								eq(incomeReceipts.sourceId, incPayload.incomeSourceId),
								eq(
									incomeReceiptRevisions.destinationAccountId,
									incPayload.destinationAccountId,
								),
								eq(incomeReceiptRevisions.amount, incPayload.amount),
								ne(incomeReceiptRevisions.operation, "VOID"),
							),
						);

					const targetDateStr = formatIstanbulPurchaseDate(r.occurredAt);
					for (const rec of matchingReceipts) {
						const recDateStr = formatIstanbulPurchaseDate(rec.occurredAt);
						if (recDateStr === targetDateStr) {
							candidates.push({
								rowOrdinal: r.rowOrdinal,
								candidateType: "INCOME_RECEIPT",
								candidateId: rec.id,
								reasonCode: "SAME_INCOME_SOURCE_DATE_AMOUNT",
							});
						}
					}
				}
			}

			// If candidates found and row was READY, transition to POSSIBLE_DUPLICATE
			if (candidates.length > 0 && finalStatus === "READY") {
				finalStatus = "POSSIBLE_DUPLICATE";
			}
		}

		result.rowsWithStatus.push({
			row: r,
			finalStatus,
			candidates,
		});
	}

	return result;
}
