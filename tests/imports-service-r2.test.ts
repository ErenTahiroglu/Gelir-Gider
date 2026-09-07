import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { ImportError } from "../src/imports/errors";
import {
	getImportBatch,
	getImportRow,
	listImportBatches,
	listImportRows,
	type ResolveImportRowParams,
	resolveImportRow,
} from "../src/imports/service";

describe("Phase 17-R2 — Service and Read Model Tests", () => {
	const dummyUserId = "11111111-1111-4111-8111-111111111111";
	const dummyRowId = "33333333-3333-4333-8333-333333333333";

	describe("Public Boundary Parameter Validations", () => {
		const mockDb = {
			transaction: vi.fn(),
			select: vi.fn(),
		} as unknown as Database;

		it("rejects getImportBatch with invalid batchId UUID before DB", async () => {
			await expect(getImportBatch(mockDb, "invalid-uuid")).rejects.toThrow(
				ImportError,
			);

			expect(mockDb.select).not.toHaveBeenCalled();
		});

		it("rejects getImportRow with invalid importRowId UUID before DB", async () => {
			await expect(getImportRow(mockDb, "not-a-uuid")).rejects.toThrow(
				ImportError,
			);

			expect(mockDb.select).not.toHaveBeenCalled();
		});

		it("rejects listImportBatches with invalid userId UUID before DB", async () => {
			await expect(listImportBatches(mockDb, "invalid-uuid")).rejects.toThrow(
				ImportError,
			);

			expect(mockDb.select).not.toHaveBeenCalled();
		});

		it("rejects listImportRows with invalid batchId UUID before DB", async () => {
			await expect(listImportRows(mockDb, "invalid-uuid")).rejects.toThrow(
				ImportError,
			);

			expect(mockDb.select).not.toHaveBeenCalled();
		});

		it("rejects resolveImportRow with invalid action or missing link target before DB", async () => {
			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "LINK_EXISTING",
					idempotencyKey: "key-1",
				} as unknown as ResolveImportRowParams),
			).rejects.toThrow(ImportError);

			await expect(
				resolveImportRow(mockDb, {
					userId: dummyUserId,
					importRowId: dummyRowId,
					expectedRevisionNo: 1,
					action: "INVALID_ACTION",
					idempotencyKey: "key-1",
				} as unknown as ResolveImportRowParams),
			).rejects.toThrow(ImportError);

			expect(mockDb.transaction).not.toHaveBeenCalled();
		});
	});
});
