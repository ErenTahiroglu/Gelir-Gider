import { describe, expect, it } from "vitest";
import { ImportError } from "../src/imports/errors";
import { parseCsvRecords, parseGenericCsvV1 } from "../src/imports/generic-csv";
import {
	normalizeImportRow,
	validateAndNormalizeBatchMeta,
} from "../src/imports/normalize";

describe("Phase 17-R2 — Unit Tests", () => {
	const validUserId = "00000000-0000-4000-a000-000000000001";
	const validCardId = "00000000-0000-4000-a000-000000000002";
	const validSourceId = "00000000-0000-4000-a000-000000000003";
	const validDestId = "00000000-0000-4000-a000-000000000004";

	describe("1..60 Installment Contract", () => {
		it("accepts installment count 1, 36, and 60", async () => {
			for (const count of [1, 36, 60]) {
				const row = await normalizeImportRow(validUserId, 0, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "12000.00",
					purchaseCategory: "MANDATORY",
					installmentCount: count,
				});
				expect(
					(row.payload as { installmentCount?: number | null })
						.installmentCount,
				).toBe(count);
			}
		});

		it("rejects installment count 0, negative, fractional, or > 60", async () => {
			for (const invalidCount of [0, -1, 61, 100, 1.5, NaN]) {
				await expect(
					normalizeImportRow(validUserId, 0, {
						recordType: "CREDIT_CARD_PURCHASE",
						cardId: validCardId,
						occurredAt: new Date("2026-09-02T10:30:00Z"),
						amount: "1000.00",
						purchaseCategory: "MANDATORY",
						installmentCount: invalidCount,
					}),
				).rejects.toThrow(ImportError);
			}
		});
	});

	describe("Fail-Closed String Limits (No Silent Truncation)", () => {
		it("rejects merchant longer than 200 characters with IMPORT_INVALID_INPUT", async () => {
			await expect(
				normalizeImportRow(validUserId, 0, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					merchant: "M".repeat(201),
				}),
			).rejects.toThrow(ImportError);
		});

		it("accepts merchant up to 200 characters exactly", async () => {
			const row = await normalizeImportRow(validUserId, 0, {
				recordType: "CREDIT_CARD_PURCHASE",
				cardId: validCardId,
				occurredAt: new Date("2026-09-02T10:30:00Z"),
				amount: "100.00",
				purchaseCategory: "MANDATORY",
				merchant: "M".repeat(200),
			});
			expect((row.payload as { merchant?: string | null }).merchant).toBe(
				"M".repeat(200),
			);
		});

		it("rejects description longer than 500 characters", async () => {
			await expect(
				normalizeImportRow(validUserId, 0, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					description: "D".repeat(501),
				}),
			).rejects.toThrow(ImportError);
		});

		it("rejects note longer than 500 characters", async () => {
			await expect(
				normalizeImportRow(validUserId, 0, {
					recordType: "INCOME_RECEIPT",
					incomeSourceId: validSourceId,
					destinationAccountId: validDestId,
					receivedAt: new Date("2026-09-02T10:30:00Z"),
					amount: "5000.00",
					note: "N".repeat(501),
				}),
			).rejects.toThrow(ImportError);
		});

		it("rejects reason longer than 500 characters", async () => {
			await expect(
				normalizeImportRow(validUserId, 0, {
					recordType: "UNSUPPORTED",
					reason: "R".repeat(501),
				}),
			).rejects.toThrow(ImportError);
		});
	});

	describe("Strict RFC-4180 Generic CSV Parser", () => {
		it("rejects unquoted quotes in the middle of a field", () => {
			expect(() =>
				parseCsvRecords('date,amount,merchant\n2026-09-01,100,foo"bar'),
			).toThrow(ImportError);
		});

		it("rejects characters after closing quote before delimiter", () => {
			expect(() =>
				parseCsvRecords('date,amount,merchant\n2026-09-01,100,"foo"bar,extra'),
			).toThrow(ImportError);
		});

		it("rejects duplicate normalized headers in CSV", () => {
			const csv = "date,amount,merchant,Merchant\n2026-09-01,100,M1,M2";
			expect(() => parseGenericCsvV1(csv)).toThrow(ImportError);
		});

		it("rejects row field count mismatch against header row count", () => {
			const csv = "date,amount,merchant\n2026-09-01,100,M1,ExtraField";
			expect(() => parseGenericCsvV1(csv)).toThrow(ImportError);
		});
	});

	describe("Strict Parameter & Unknown Input Validations", () => {
		it("rejects batch metadata that contains unknown properties", () => {
			expect(() =>
				validateAndNormalizeBatchMeta({
					userId: validUserId,
					provider: "TEST",
					sourceKind: "NORMALIZED_ROWS",
					sourceContentHash: "a".repeat(64),
					sourceFileName: "file.csv",
					parserType: "GENERIC_CSV_V1",
					parserVersion: "1.0.0",
					observedAt: new Date(),
					unexpectedProperty: "attack",
				} as unknown as Parameters<typeof validateAndNormalizeBatchMeta>[0]),
			).toThrow(ImportError);
		});

		it("rejects row inputs that contain unknown properties", async () => {
			await expect(
				normalizeImportRow(validUserId, 0, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: validCardId,
					occurredAt: new Date("2026-09-02T10:30:00Z"),
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					maliciousField: 12345,
				} as unknown as Parameters<typeof normalizeImportRow>[2]),
			).rejects.toThrow(ImportError);
		});
	});
});
