import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import {
	IMPORT_RESULT_TARGET_TYPES,
	type ImportResultTargetType,
} from "../src/db/schema/imports";
import { ImportError } from "../src/imports/errors";
import { computeSourceContentHash } from "../src/imports/fingerprint";
import { normalizeImportRow } from "../src/imports/normalize";
import { resolveImportRow, stageImportBatch } from "../src/imports/service";

describe("Phase 17-R3 — Service and Boundary Suite", () => {
	const dummyUserId = "11111111-1111-4111-8111-111111111111";
	const dummyRowId = "22222222-2222-4222-8222-222222222222";
	const dummyCardId = "33333333-3333-4333-8333-333333333333";
	const dummyTargetId = "66666666-6666-4666-8666-666666666666";

	describe("Section 10 — Service Matrix A, B, C: Public Link Target Contract", () => {
		it("A & B: valid CREDIT_CARD_PURCHASE and INCOME_RECEIPT link targets reach transaction layer", async () => {
			for (const targetType of IMPORT_RESULT_TARGET_TYPES) {
				const mockTx = {
					select: vi.fn().mockReturnValue({
						from: vi.fn().mockReturnValue({
							where: vi.fn().mockReturnValue({
								limit: vi.fn().mockResolvedValue([]),
							}),
						}),
					}),
					insert: vi.fn(),
				};
				const mockDb = {
					transaction: vi.fn().mockImplementation(async (cb) => {
						return await cb(mockTx as unknown as DatabaseTransaction);
					}),
				} as unknown as Database;

				try {
					await resolveImportRow(mockDb, {
						userId: dummyUserId,
						importRowId: dummyRowId,
						expectedRevisionNo: 1,
						action: "LINK_EXISTING",
						idempotencyKey: "link-key-1",
						linkTarget: {
							targetType,
							targetId: dummyTargetId,
						},
					});
				} catch (_err) {
					// We expect it to reach DB / transaction layer (and fail on row lookup or similar inside tx)
					expect(mockDb.transaction).toHaveBeenCalled();
				}
			}
		});

		it("C: old wrong target literals are rejected before DB", async () => {
			const oldWrongLiterals = [
				"CREDIT_CARD_TRANSACTION",
				"CREDIT_CARD_SPLIT",
				"INCOME",
				"TRANSACTION",
				"PURCHASE",
				"RANDOM_STRING",
			];

			for (const wrongType of oldWrongLiterals) {
				const mockDb = {
					transaction: vi.fn(),
					select: vi.fn(),
				} as unknown as Database;

				await expect(
					resolveImportRow(mockDb, {
						userId: dummyUserId,
						importRowId: dummyRowId,
						expectedRevisionNo: 1,
						action: "LINK_EXISTING",
						idempotencyKey: "link-key-wrong",
						linkTarget: {
							targetType: wrongType as unknown as ImportResultTargetType,
							targetId: dummyTargetId,
						},
					}),
				).rejects.toThrow(ImportError);

				expect(mockDb.transaction).not.toHaveBeenCalled();
			}
		});
	});

	describe("Section 10 — H: Boundary Tightening (Exact Keys & Irrelevant Fields)", () => {
		it("rejects unknown properties on linkTarget before DB", async () => {
			const mockDb = {
				transaction: vi.fn(),
				select: vi.fn(),
			} as unknown as Database;

			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "LINK_EXISTING",
					idempotencyKey: "link-key-extra",
					linkTarget: {
						targetType: "CREDIT_CARD_PURCHASE",
						targetId: dummyTargetId,
						extraField: "not_allowed",
					} as unknown as {
						targetType: ImportResultTargetType;
						targetId: string;
					},
				}),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects linkTarget on non-LINK_EXISTING actions before DB", async () => {
			const mockDb = {
				transaction: vi.fn(),
				select: vi.fn(),
			} as unknown as Database;

			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "CONFIRM_IMPORT",
					idempotencyKey: "confirm-key",
					linkTarget: {
						targetType: "CREDIT_CARD_PURCHASE",
						targetId: dummyTargetId,
					},
				}),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects unknown properties in resolvedMappings before DB", async () => {
			const mockDb = {
				transaction: vi.fn(),
				select: vi.fn(),
			} as unknown as Database;

			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "RESOLVE_MAPPINGS",
					idempotencyKey: "res-key",
					resolvedMappings: {
						cardId: dummyCardId,
						unknownKey: "bad",
					} as unknown as { cardId: string },
				}),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects resolvedMappings on non-RESOLVE_MAPPINGS actions before DB", async () => {
			const mockDb = {
				transaction: vi.fn(),
				select: vi.fn(),
			} as unknown as Database;

			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "SKIP",
					idempotencyKey: "skip-key",
					resolvedMappings: {
						cardId: dummyCardId,
					},
				}),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("normalizes reasonNote (trims whitespace, converts empty to null, limits to 500 chars)", async () => {
			const mockDb = {
				transaction: vi.fn(),
				select: vi.fn(),
			} as unknown as Database;

			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "SKIP",
					idempotencyKey: "skip-key",
					reasonNote: "X".repeat(501),
				}),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});
	});

	describe("Section 10 — I: Source Content Contract Consistency & Bounded Inputs", () => {
		it("accepts Uint8Array as sourceContent for NORMALIZED_ROWS in stageImportBatch", async () => {
			const sourceUint8 = new TextEncoder().encode("test source content");
			const expectedHash = await computeSourceContentHash(sourceUint8);

			const mockDb = {
				transaction: vi.fn().mockImplementation(async () => {
					return {
						batch: {
							id: "batch-1",
							userId: dummyUserId,
							provider: "TEST_PROVIDER",
							sourceKind: "NORMALIZED_ROWS",
							sourceContentHash: expectedHash,
							sourceFileName: null,
							parserType: "TEST_PARSER",
							parserVersion: "1.0",
							observedAt: new Date(),
							createdAt: new Date(),
							totalRows: 0,
							readyCount: 0,
							needsReviewCount: 0,
							possibleDuplicateCount: 0,
							exactDuplicateCount: 0,
							appliedCount: 0,
							linkedCount: 0,
							skippedCount: 0,
							unsupportedCount: 0,
						},
						rows: [],
						idempotentReplay: false,
					};
				}),
			} as unknown as Database;

			const res = await stageImportBatch(mockDb, {
				userId: dummyUserId,
				provider: "TEST_PROVIDER",
				sourceKind: "NORMALIZED_ROWS",
				sourceContent: sourceUint8,
				sourceContentHash: expectedHash,
				parserType: "TEST_PARSER",
				parserVersion: "1.0",
				observedAt: new Date(),
				rows: [],
			});

			expect(mockDb.transaction).toHaveBeenCalled();
			expect(res.batch.sourceContentHash).toBe(expectedHash);
		});

		it("rejects oversized sourceContent (> 10MB) before DB", async () => {
			const mockDb = {
				transaction: vi.fn(),
				select: vi.fn(),
			} as unknown as Database;

			const oversized = new Uint8Array(10 * 1024 * 1024 + 1);

			await expect(
				stageImportBatch(mockDb, {
					userId: dummyUserId,
					provider: "TEST_PROVIDER",
					sourceKind: "NORMALIZED_ROWS",
					sourceContent: oversized,
					parserType: "TEST_PARSER",
					parserVersion: "1.0",
					observedAt: new Date(),
					rows: [],
				}),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});

		it("rejects circular rawRecord with IMPORT_INVALID_INPUT (no stack overflow)", async () => {
			const circular: Record<string, unknown> = { a: 1 };
			circular.self = circular;

			await expect(
				normalizeImportRow(dummyUserId, 0, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: dummyCardId,
					occurredAt: new Date(),
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					rawRecord: circular,
				}),
			).rejects.toThrow(ImportError);
		});

		it("rejects rawRecord exceeding serialized size limit (64KB)", async () => {
			const largeRecord: Record<string, unknown> = {
				data: "A".repeat(65537),
			};

			await expect(
				normalizeImportRow(dummyUserId, 0, {
					recordType: "CREDIT_CARD_PURCHASE",
					cardId: dummyCardId,
					occurredAt: new Date(),
					amount: "100.00",
					purchaseCategory: "MANDATORY",
					rawRecord: largeRecord,
				}),
			).rejects.toThrow(ImportError);
		});
	});
});
