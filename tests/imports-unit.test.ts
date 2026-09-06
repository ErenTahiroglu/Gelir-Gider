import { describe, expect, it } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import { mapToImportError } from "../src/imports/boundary";
import { analyzeIntraBatchDuplicates } from "../src/imports/dedup";
import { ImportError } from "../src/imports/errors";
import {
	computeCardSemanticFingerprint,
	computeChildIdempotencyKey,
	computeExternalTransactionIdHash,
	computeRawRowHash,
	computeSourceContentHash,
} from "../src/imports/fingerprint";
import { parseGenericCsvV1 } from "../src/imports/generic-csv";
import {
	normalizeImportRow,
	validateAndNormalizeBatchMeta,
} from "../src/imports/normalize";
import { IncomeError } from "../src/income/errors";
import { CanonicalTransactionError } from "../src/transactions/errors";

describe("Phase 17 - Import Unit Tests", () => {
	const validUserId = "00000000-0000-4000-a000-000000000001";
	const validCardId = "00000000-0000-4000-a000-000000000002";
	const validSourceId = "00000000-0000-4000-a000-000000000003";
	const validDestId = "00000000-0000-4000-a000-000000000004";
	const validGoalId = "00000000-0000-4000-a000-000000000005";

	describe("Batch Metadata Validation", () => {
		const validMeta = {
			userId: validUserId,
			provider: "GARANTI_BBVA",
			sourceKind: "NORMALIZED_ROWS",
			sourceContentHash: "a".repeat(64),
			sourceFileName: "statement_2026_09.csv",
			parserType: "GARANTI_CREDIT_CARD_V1",
			parserVersion: "1.0.0",
			observedAt: new Date("2026-09-01T12:00:00Z"),
		};

		it("accepts valid batch metadata", () => {
			const res = validateAndNormalizeBatchMeta(validMeta);
			expect(res.validUserId).toBe(validUserId);
			expect(res.validProvider).toBe("GARANTI_BBVA");
			expect(res.validSourceKind).toBe("NORMALIZED_ROWS");
			expect(res.validContentHash).toBe("a".repeat(64));
			expect(res.validFileName).toBe("statement_2026_09.csv");
		});

		it("rejects empty userId", () => {
			expect(() =>
				validateAndNormalizeBatchMeta({ ...validMeta, userId: "   " }),
			).toThrowError(ImportError);
		});

		it("rejects invalid content hash", () => {
			expect(() =>
				validateAndNormalizeBatchMeta({
					...validMeta,
					sourceContentHash: "invalid_hash",
				}),
			).toThrowError(ImportError);
		});

		it("rejects invalid sourceKind", () => {
			expect(() =>
				validateAndNormalizeBatchMeta({
					...validMeta,
					sourceKind: "UNSUPPORTED_KIND",
				}),
			).toThrowError(ImportError);
		});

		it("rejects oversized provider", () => {
			expect(() =>
				validateAndNormalizeBatchMeta({
					...validMeta,
					provider: "p".repeat(65),
				}),
			).toThrowError(ImportError);
		});
	});

	describe("Row Normalization & Validation", () => {
		it("normalizes a complete credit card purchase to READY status", async () => {
			const row = await normalizeImportRow(validUserId, 0, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:30:00Z"),
				amount: "1500.50",
				purchaseCategory: "MANDATORY",
				merchant: "Migros Supermarket",
				description: "Weekly groceries",
				installmentCount: 1,
				externalTransactionId: "EXT_TX_987654",
			});

			expect(row.rowOrdinal).toBe(0);
			expect(row.recordType).toBe("CREDIT_CARD_PURCHASE");
			expect(row.initialStatus).toBe("READY");
			expect(row.externalTransactionIdHash).toBe(
				await computeExternalTransactionIdHash("EXT_TX_987654"),
			);
			expect(row.payload.recordType).toBe("CREDIT_CARD_PURCHASE");
			if (row.payload.recordType === "CREDIT_CARD_PURCHASE") {
				expect(row.payload.amount).toBe("1500.50");
				expect(row.payload.cardId).toBe(validCardId);
				expect(row.payload.purchaseCategory).toBe("MANDATORY");
				expect(row.payload.merchant).toBe("Migros Supermarket");
			}
		});

		it("marks credit card purchase without category as NEEDS_REVIEW", async () => {
			const row = await normalizeImportRow(validUserId, 1, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:30:00Z"),
				amount: "250.00",
				merchant: "Unknown Store",
			});

			expect(row.initialStatus).toBe("NEEDS_REVIEW");
			if (row.payload.recordType === "CREDIT_CARD_PURCHASE") {
				expect(row.payload.purchaseCategory).toBeNull();
			}
		});

		it("marks credit card purchase without cardId as NEEDS_REVIEW", async () => {
			const row = await normalizeImportRow(validUserId, 2, {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: new Date("2026-09-02T10:30:00Z"),
				amount: "300.00",
				purchaseCategory: "DISCRETIONARY",
			});

			expect(row.initialStatus).toBe("NEEDS_REVIEW");
			if (row.payload.recordType === "CREDIT_CARD_PURCHASE") {
				expect(row.payload.cardId).toBeNull();
			}
		});

		it("enforces SHORT_TERM_PURCHASE requires shortTermGoalId", async () => {
			await expect(
				normalizeImportRow(validUserId, 3, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "500.00",
					purchaseCategory: "SHORT_TERM_PURCHASE",
				}),
			).rejects.toThrowError(ImportError);

			const validGoalRow = await normalizeImportRow(validUserId, 4, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:30:00Z"),
				amount: "500.00",
				purchaseCategory: "SHORT_TERM_PURCHASE",
				shortTermGoalId: validGoalId,
			});
			expect(validGoalRow.initialStatus).toBe("READY");
		});

		it("rejects non-positive amounts", async () => {
			await expect(
				normalizeImportRow(validUserId, 5, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "0.00",
					purchaseCategory: "MANDATORY",
				}),
			).rejects.toThrowError(ImportError);

			await expect(
				normalizeImportRow(validUserId, 6, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "-150.00",
					purchaseCategory: "MANDATORY",
				}),
			).rejects.toThrowError(ImportError);
		});

		it("normalizes a complete income receipt to READY status", async () => {
			const row = await normalizeImportRow(validUserId, 0, {
				recordType: "INCOME_RECEIPT",
				incomeSourceId: validSourceId,
				destinationAccountId: validDestId,
				receivedAt: new Date("2026-09-01T08:00:00Z"),
				amount: "45000.00",
				note: "Monthly salary",
				externalTransactionId: "EXT_INC_112233",
			});

			expect(row.initialStatus).toBe("READY");
			expect(row.recordType).toBe("INCOME_RECEIPT");
			if (row.payload.recordType === "INCOME_RECEIPT") {
				expect(row.payload.amount).toBe("45000.00");
				expect(row.payload.incomeSourceId).toBe(validSourceId);
				expect(row.payload.destinationAccountId).toBe(validDestId);
				expect(row.payload.note).toBe("Monthly salary");
			}
		});

		it("marks income receipt missing destination as NEEDS_REVIEW", async () => {
			const row = await normalizeImportRow(validUserId, 1, {
				recordType: "INCOME_RECEIPT",
				incomeSourceId: validSourceId,
				receivedAt: new Date("2026-09-01T08:00:00Z"),
				amount: "10000.00",
			});

			expect(row.initialStatus).toBe("NEEDS_REVIEW");
		});

		it("marks unsupported record type as UNSUPPORTED", async () => {
			const row = await normalizeImportRow(validUserId, 2, {
				recordType: "UNSUPPORTED",
				rawRecord: { type: "TRANSFER", from: "acc1", to: "acc2" },
				reason: "Transfer not supported in Phase 17",
			});

			expect(row.initialStatus).toBe("UNSUPPORTED");
			expect(row.recordType).toBe("UNSUPPORTED");
		});
	});

	describe("Fingerprinting & Determinism", () => {
		it("computes reproducible source content hash", async () => {
			const hash1 = await computeSourceContentHash("col1,col2\nval1,val2");
			const hash2 = await computeSourceContentHash("col1,col2\nval1,val2");
			expect(hash1).toHaveLength(64);
			expect(hash1).toBe(hash2);
		});

		it("computes deterministic raw row hash regardless of object key order", async () => {
			const obj1 = { b: 2, a: 1, c: { y: 20, x: 10 } };
			const obj2 = { c: { x: 10, y: 20 }, a: 1, b: 2 };
			const hash1 = await computeRawRowHash(obj1);
			const hash2 = await computeRawRowHash(obj2);
			expect(hash1).toBe(hash2);
		});

		it("computes deterministic card semantic fingerprint with Istanbul date", async () => {
			const date = new Date("2026-09-02T22:30:00Z"); // In Istanbul (+03:00) this is 2026-09-03
			const fp1 = await computeCardSemanticFingerprint({
				userId: validUserId,
				cardId: validCardId,
				occurredAt: date,
				amount: "100.00",
				merchant: "  Starbucks Coffee  ",
			});

			const fp2 = await computeCardSemanticFingerprint({
				userId: validUserId,
				cardId: validCardId,
				occurredAt: date,
				amount: "100.00",
				merchant: "starbucks coffee",
			});

			expect(fp1).toBe(fp2);
		});

		it("computes deterministic child idempotency key bounded to 64 chars", async () => {
			const key = await computeChildIdempotencyKey(
				"IMPORT_CARD",
				"row-12345",
				2,
			);
			expect(key).toHaveLength(64);
			expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
		});
	});

	describe("Intra-Batch Duplicate Detection", async () => {
		it("detects identical semantic fingerprints within a single batch", async () => {
			const row1 = await normalizeImportRow(validUserId, 0, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:00:00Z"),
				amount: "500.00",
				purchaseCategory: "MANDATORY",
				merchant: "Market A",
			});

			const row2 = await normalizeImportRow(validUserId, 1, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:00:00Z"),
				amount: "500.00",
				purchaseCategory: "MANDATORY",
				merchant: "Market A",
			});

			const row3 = await normalizeImportRow(validUserId, 2, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:00:00Z"),
				amount: "750.00",
				purchaseCategory: "MANDATORY",
				merchant: "Market A",
			});

			const intraMap = analyzeIntraBatchDuplicates([row1, row2, row3]);
			expect(intraMap.has(0)).toBe(true);
			expect(intraMap.has(1)).toBe(true);
			expect(intraMap.has(2)).toBe(false);

			const c0 = intraMap.get(0);
			expect(c0).toBeDefined();
			expect(c0).toHaveLength(1);
			expect(c0?.[0]?.reasonCode).toBe("SAME_BATCH_SEMANTICS");
			expect(c0?.[0]?.candidateId).toBe("ROW_ORDINAL_1");
		});
	});

	describe("Generic CSV V1 Parser", () => {
		it("parses valid CSV text into purchase, income and unsupported rows", () => {
			const csv = [
				"type,date,amount,card_id,category,merchant,note,source_id,destination_account_id,external_id",
				`CREDIT_CARD_PURCHASE,2026-09-02,1200.50,${validCardId},MANDATORY,IKEA,New desk,,,TX_CC_1`,
				`INCOME_RECEIPT,2026-09-01,35000.00,,,Monthly Bonus,Bonus Sept,${validSourceId},${validDestId},TX_INC_1`,
				"TRANSFER,2026-09-03,500.00,,,,Transfer to savings,,,TX_TR_1",
			].join("\n");

			const rows = parseGenericCsvV1(csv);
			expect(rows).toHaveLength(3);

			const r0 = rows[0];
			expect(r0?.recordType).toBe("CREDIT_CARD_PURCHASE");
			if (r0?.recordType === "CREDIT_CARD_PURCHASE") {
				expect(r0.cardId).toBe(validCardId);
				expect(r0.amount).toBe("1200.50");
				expect(r0.purchaseCategory).toBe("MANDATORY");
				expect(r0.merchant).toBe("IKEA");
				expect(r0.externalTransactionId).toBe("TX_CC_1");
			}

			const r1 = rows[1];
			expect(r1?.recordType).toBe("INCOME_RECEIPT");
			if (r1?.recordType === "INCOME_RECEIPT") {
				expect(r1.incomeSourceId).toBe(validSourceId);
				expect(r1.destinationAccountId).toBe(validDestId);
				expect(r1.amount).toBe("35000.00");
				expect(r1.externalTransactionId).toBe("TX_INC_1");
			}

			const r2 = rows[2];
			expect(r2?.recordType).toBe("UNSUPPORTED");
			if (r2?.recordType === "UNSUPPORTED") {
				expect(r2.reason).toContain("TRANSFER");
			}
		});

		it("rejects empty or single line CSV", () => {
			expect(() => parseGenericCsvV1("header1,header2")).toThrowError(
				ImportError,
			);
			expect(() => parseGenericCsvV1("")).toThrowError(ImportError);
		});
	});

	describe("Boundary Error Translation", () => {
		it("maps CreditCardError to sanitized ImportError", () => {
			const notFound = new CreditCardError(
				"CREDIT_CARD_NOT_FOUND",
				"Credit card not found",
			);
			const mapped1 = mapToImportError(notFound);
			expect(mapped1.code).toBe("IMPORT_TARGET_NOT_FOUND");

			const conflict = new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Replay mismatch",
			);
			const mapped2 = mapToImportError(conflict);
			expect(mapped2.code).toBe("IMPORT_IDEMPOTENCY_CONFLICT");
		});

		it("maps IncomeError to sanitized ImportError", () => {
			const sourceNotFound = new IncomeError(
				"INCOME_SOURCE_NOT_FOUND",
				"Source missing",
			);
			const mapped = mapToImportError(sourceNotFound);
			expect(mapped.code).toBe("IMPORT_TARGET_NOT_FOUND");
		});

		it("maps CanonicalTransactionError to sanitized ImportError", () => {
			const txConflict = new CanonicalTransactionError(
				"TRANSACTION_IDEMPOTENCY_CONFLICT",
				"Tx conflict",
			);
			const mapped = mapToImportError(txConflict);
			expect(mapped.code).toBe("IMPORT_IDEMPOTENCY_CONFLICT");
		});

		it("maps Postgres immutability and sequence errors", () => {
			const immErr = new Error(
				"table import_batches is immutable: UPDATE and DELETE operations are forbidden",
			);
			const mappedImm = mapToImportError(immErr);
			expect(mappedImm.code).toBe("IMPORT_INVALID_STATE");

			const seqErr = new Error(
				"cannot append new revision to terminal row status APPLIED",
			);
			const mappedSeq = mapToImportError(seqErr);
			expect(mappedSeq.code).toBe("IMPORT_REVISION_CONFLICT");
		});
	});
});
