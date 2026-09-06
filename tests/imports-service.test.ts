import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { mapToImportError } from "../src/imports/boundary";
import { ImportError } from "../src/imports/errors";
import {
	computeApplyRequestFingerprint,
	computeResolveRequestFingerprint,
} from "../src/imports/fingerprint";
import { parseGenericCsvV1 } from "../src/imports/generic-csv";
import { normalizeImportRow } from "../src/imports/normalize";
import {
	applyImportRow,
	resolveImportRow,
	stageImportBatch,
} from "../src/imports/service";

describe("Phase 17-R1 - Imports Service and Boundary Tests", () => {
	const dummyUserId = "11111111-1111-4111-8111-111111111111";
	const dummyRowId = "33333333-3333-4333-8333-333333333333";
	const dummyCardId = "44444444-4444-4444-8444-444444444444";

	describe("Public boundary input validation (zero DB calls on malformed input)", () => {
		const mockDb = {
			transaction: vi.fn(),
			select: vi.fn(),
		} as unknown as Database;

		it("rejects stageImportBatch with empty provider before DB", async () => {
			await expect(
				stageImportBatch(mockDb, {
					userId: dummyUserId,
					provider: "   ",
					sourceKind: "GENERIC_CSV_V1",
					sourceFileName: "test.csv",
					sourceContent: "a,b,c",
					parserType: "GENERIC_CSV_V1",
					parserVersion: "1.0.0",
					observedAt: new Date(),
					rows: [],
				}),
			).rejects.toThrow(ImportError);
			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects stageImportBatch with invalid userId before DB", async () => {
			await expect(
				stageImportBatch(mockDb, {
					userId: "invalid-uuid",
					provider: "GENERIC_CSV_V1",
					sourceKind: "GENERIC_CSV_V1",
					sourceFileName: "test.csv",
					sourceContent: "a,b,c",
					parserType: "GENERIC_CSV_V1",
					parserVersion: "1.0.0",
					observedAt: new Date(),
					rows: [],
				}),
			).rejects.toThrow(ImportError);
			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects stageImportBatch with sourceContentHash mismatch before DB", async () => {
			await expect(
				stageImportBatch(mockDb, {
					userId: dummyUserId,
					provider: "GENERIC_CSV_V1",
					sourceKind: "GENERIC_CSV_V1",
					sourceFileName: "test.csv",
					sourceContent: "a,b,c",
					sourceContentHash:
						"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
					parserType: "GENERIC_CSV_V1",
					parserVersion: "1.0.0",
					observedAt: new Date(),
					rows: [],
				}),
			).rejects.toThrow(ImportError);
			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects resolveImportRow with missing idempotency key before DB", async () => {
			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "CONFIRM_IMPORT",
					idempotencyKey: "   ",
				}),
			).rejects.toThrow(ImportError);
			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects applyImportRow with invalid expectedRevisionNo before DB", async () => {
			await expect(
				applyImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 0,
					idempotencyKey: "valid-key-123",
				}),
			).rejects.toThrow(ImportError);
			expect(mockDb.transaction).not.toHaveBeenCalled();
		});
	});

	describe("Request Fingerprints & Idempotency", () => {
		it("generates deterministic fingerprints for resolve requests", async () => {
			const fp1 = await computeResolveRequestFingerprint({
				userId: dummyUserId,
				importRowId: dummyRowId,
				expectedRevisionNo: 1,
				action: "RESOLVE_MAPPINGS",
				resolvedMappings: {
					cardId: dummyCardId,
					purchaseCategory: "GROCERY",
				},
				linkTarget: null,
				reasonNote: "Resolved category",
			});

			const fp2 = await computeResolveRequestFingerprint({
				userId: dummyUserId,
				importRowId: dummyRowId,
				expectedRevisionNo: 1,
				action: "RESOLVE_MAPPINGS",
				resolvedMappings: {
					cardId: dummyCardId,
					purchaseCategory: "GROCERY",
				},
				linkTarget: null,
				reasonNote: "Resolved category",
			});

			const fpDifferent = await computeResolveRequestFingerprint({
				userId: dummyUserId,
				importRowId: dummyRowId,
				expectedRevisionNo: 2, // Changed expectedRevisionNo
				action: "RESOLVE_MAPPINGS",
				resolvedMappings: {
					cardId: dummyCardId,
					purchaseCategory: "GROCERY",
				},
				linkTarget: null,
				reasonNote: "Resolved category",
			});

			expect(fp1).toHaveLength(64);
			expect(fp1).toBe(fp2);
			expect(fp1).not.toBe(fpDifferent);
		});

		it("generates deterministic fingerprints for apply requests", async () => {
			const fp1 = await computeApplyRequestFingerprint({
				userId: dummyUserId,
				importRowId: dummyRowId,
				expectedRevisionNo: 2,
			});

			const fp2 = await computeApplyRequestFingerprint({
				userId: dummyUserId,
				importRowId: dummyRowId,
				expectedRevisionNo: 2,
			});

			const fpDiffRev = await computeApplyRequestFingerprint({
				userId: dummyUserId,
				importRowId: dummyRowId,
				expectedRevisionNo: 3,
			});

			expect(fp1).toHaveLength(64);
			expect(fp1).toBe(fp2);
			expect(fp1).not.toBe(fpDiffRev);
		});
	});

	describe("Error sanitization (no raw SQL / driver leaks)", () => {
		it("sanitizes raw Postgres / driver errors to safe stable IMPORT_DATABASE_ERROR", () => {
			const rawDbError = new Error(
				'select * from "secret_table" where id = 1; connection pool error',
			);
			const err = mapToImportError(rawDbError);
			expect(err).toBeInstanceOf(ImportError);
			expect(err.code).toBe("IMPORT_DATABASE_ERROR");
			expect(err.message).not.toContain("secret_table");
			expect(err.message).not.toContain("connection pool");
			expect(err.message).toBe(
				"An unexpected database error occurred during import processing",
			);
		});

		it("preserves known domain ImportErrors without alteration", () => {
			const domainErr = new ImportError(
				"IMPORT_IDEMPOTENCY_CONFLICT",
				"Idempotency key reuse conflict",
			);
			const mapped = mapToImportError(domainErr);
			expect(mapped).toBe(domainErr);
			expect(mapped.code).toBe("IMPORT_IDEMPOTENCY_CONFLICT");
		});
	});

	describe("Privacy: UNSUPPORTED normalized payload omits rawRecord", () => {
		it("creates a minimal safe payload without full raw row data", async () => {
			const row = await normalizeImportRow(dummyUserId, 0, {
				recordType: "UNSUPPORTED",
				reason: "Foreign currency transactions not supported",
				rawRecord: {
					pan: "4543-XXXX-XXXX-1234",
					name: "SECRET PERSON",
					amount: "100.00",
				},
			});

			expect(row.payload).toEqual({
				recordType: "UNSUPPORTED",
				reason: "Foreign currency transactions not supported",
			});
			expect(
				(row.payload as unknown as Record<string, unknown>).rawRecord,
			).toBeUndefined();
		});
	});

	describe("GENERIC_CSV_V1 RFC 4180 parsing compliance", () => {
		it("handles commas in quoted fields correctly", () => {
			const csv =
				'Type,Date,Amount,Description\nPURCHASE,2026-03-01,-120.50,"Market, Grocery & Bakery"';
			const records = parseGenericCsvV1(csv);
			expect(records).toHaveLength(1);
			expect((records[0] as { description?: string }).description).toBe(
				"Market, Grocery & Bakery",
			);
			expect((records[0] as { amount?: string }).amount).toBe("-120.50");
		});

		it('handles escaped double quotes ("") correctly', () => {
			const csv =
				'Type,Date,Amount,Description\nPURCHASE,2026-03-01,-50.00,"Book ""Advanced TS"" Purchase"';
			const records = parseGenericCsvV1(csv);
			expect(records).toHaveLength(1);
			expect((records[0] as { description?: string }).description).toBe(
				'Book "Advanced TS" Purchase',
			);
		});

		it("handles multiline quoted fields with CRLF", () => {
			const csv =
				'Type,Date,Amount,Description\r\nPURCHASE,2026-03-01,-200.00,"Line 1\r\nLine 2\r\nLine 3"';
			const records = parseGenericCsvV1(csv);
			expect(records).toHaveLength(1);
			expect((records[0] as { description?: string }).description).toBe(
				"Line 1\r\nLine 2\r\nLine 3",
			);
		});
	});
});
