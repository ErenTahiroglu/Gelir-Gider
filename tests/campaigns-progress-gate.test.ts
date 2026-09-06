import { describe, expect, it, vi } from "vitest";
import {
	CAMPAIGN_PURCHASE_PROGRESS_PAGE_SIZE,
	collectAllPagesInTransaction,
	shouldComputeLiveProgress,
} from "../src/campaigns/progress";

describe("shouldComputeLiveProgress (Section D)", () => {
	it("returns true for ACTIVE and ENDED", () => {
		expect(shouldComputeLiveProgress("ACTIVE")).toBe(true);
		expect(shouldComputeLiveProgress("ENDED")).toBe(true);
	});

	it("returns false for REVIEW_REQUIRED and CANCELLED", () => {
		expect(shouldComputeLiveProgress("REVIEW_REQUIRED")).toBe(false);
		expect(shouldComputeLiveProgress("CANCELLED")).toBe(false);
	});
});

describe("collectAllPagesInTransaction (Section L pagination loop)", () => {
	it("calls fetchPage repeatedly until a short page signals exhaustion, accumulating all results", async () => {
		const allItems = Array.from({ length: 12 }, (_, i) => i);
		const pageSize = 5;
		const fetchPage = vi.fn(async (offset: number, limit: number) =>
			allItems.slice(offset, offset + limit),
		);

		const result = await collectAllPagesInTransaction(fetchPage, pageSize);

		expect(result).toEqual(allItems);
		// 12 items / 5 per page => pages of 5, 5, 2 -- three calls.
		expect(fetchPage).toHaveBeenCalledTimes(3);
		expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 5);
		expect(fetchPage).toHaveBeenNthCalledWith(2, 5, 5);
		expect(fetchPage).toHaveBeenNthCalledWith(3, 10, 5);
	});

	it("stops after a single call when the first page is already short", async () => {
		const fetchPage = vi.fn(async () => [1, 2, 3]);
		const result = await collectAllPagesInTransaction(fetchPage, 10);
		expect(result).toEqual([1, 2, 3]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("returns an empty array with a single call when the source is empty", async () => {
		const fetchPage = vi.fn(async () => []);
		const result = await collectAllPagesInTransaction(fetchPage, 10);
		expect(result).toEqual([]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("never duplicates or skips items across an exact-multiple boundary (full page followed by a full page then a short page)", async () => {
		const allItems = Array.from({ length: 20 }, (_, i) => `item-${i}`);
		const pageSize = 10;
		const fetchPage = vi.fn(async (offset: number, limit: number) =>
			allItems.slice(offset, offset + limit),
		);
		const result = await collectAllPagesInTransaction(fetchPage, pageSize);
		expect(result).toEqual(allItems);
		expect(new Set(result).size).toBe(allItems.length);
		// Exactly 20/10 = 2 full pages, then one more call returning an empty
		// (short) page to confirm exhaustion.
		expect(fetchPage).toHaveBeenCalledTimes(3);
	});

	it("rejects a non-positive pageSize", async () => {
		await expect(
			collectAllPagesInTransaction(async () => [], 0),
		).rejects.toThrow();
	});
});

describe("CAMPAIGN_PURCHASE_PROGRESS_PAGE_SIZE", () => {
	it("is a positive integer well under the underlying 1000-row query cap", () => {
		expect(Number.isInteger(CAMPAIGN_PURCHASE_PROGRESS_PAGE_SIZE)).toBe(true);
		expect(CAMPAIGN_PURCHASE_PROGRESS_PAGE_SIZE).toBeGreaterThan(0);
		expect(CAMPAIGN_PURCHASE_PROGRESS_PAGE_SIZE).toBeLessThan(1000);
	});
});
