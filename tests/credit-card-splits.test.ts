import { describe, expect, it } from "vitest";
import { CREDIT_CARD_ERROR_CODES } from "../src/credit-cards/errors";
import {
	calculateSplitCreateFingerprint,
	calculateSplitUpdateFingerprint,
	calculateSplitVoidFingerprint,
} from "../src/credit-cards/fingerprint";

describe("Credit Card Splits Domain & Fingerprint Unit Tests", () => {
	const userId = "00000000-0000-0000-0000-000000000001";
	const purchaseEventId = "00000000-0000-0000-0000-000000000002";
	const splitId = "00000000-0000-0000-0000-000000000003";
	const occurredAt = new Date("2026-06-15T12:00:00.000Z");

	describe("Split Error Codes", () => {
		it("includes all Phase 11B required error codes", () => {
			expect(CREDIT_CARD_ERROR_CODES).toContain("CREDIT_CARD_SPLIT_NOT_FOUND");
			expect(CREDIT_CARD_ERROR_CODES).toContain("CREDIT_CARD_SPLIT_NOT_ACTIVE");
			expect(CREDIT_CARD_ERROR_CODES).toContain(
				"CREDIT_CARD_SPLIT_REVISION_CONFLICT",
			);
			expect(CREDIT_CARD_ERROR_CODES).toContain(
				"CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT",
			);
			expect(CREDIT_CARD_ERROR_CODES).toContain("CREDIT_CARD_SPLIT_CONFLICT");
		});
	});

	describe("Fingerprint Calculation", () => {
		it("produces deterministic SHA-256 create fingerprint regardless of item ordering", async () => {
			const itemsA = [
				{
					personId: "00000000-0000-0000-0000-000000000010",
					shareAmount: "300.00",
					weight: 1,
					dueDate: "2026-07-01",
					description: "Share 1",
				},
				{
					personId: "00000000-0000-0000-0000-000000000020",
					shareAmount: "300.00",
					weight: 1,
					dueDate: null,
					description: null,
				},
			];

			const itemsB = [...itemsA].reverse();

			const fpA = await calculateSplitCreateFingerprint({
				userId,
				purchaseEventId,
				method: "EQUAL",
				grossAmount: "1000.00",
				userShareAmount: "400.00",
				externalShareAmount: "600.00",
				userWeight: 1,
				items: itemsA,
				occurredAt,
			});

			const fpB = await calculateSplitCreateFingerprint({
				userId,
				purchaseEventId,
				method: "EQUAL",
				grossAmount: "1000.00",
				userShareAmount: "400.00",
				externalShareAmount: "600.00",
				userWeight: 1,
				items: itemsB,
				occurredAt,
			});

			expect(fpA).toBe(fpB);
			expect(fpA).toMatch(/^[0-9a-f]{64}$/);
		});

		it("produces deterministic update fingerprint and changes on data modification", async () => {
			const fp1 = await calculateSplitUpdateFingerprint({
				userId,
				splitId,
				expectedRevisionNo: 1,
				method: "MANUAL",
				grossAmount: "1000.00",
				userShareAmount: "500.00",
				externalShareAmount: "500.00",
				userWeight: null,
				items: [
					{
						personId: "00000000-0000-0000-0000-000000000010",
						shareAmount: "500.00",
						weight: null,
						dueDate: null,
						description: "Updated note",
					},
				],
				occurredAt,
			});

			const fp2 = await calculateSplitUpdateFingerprint({
				userId,
				splitId,
				expectedRevisionNo: 1,
				method: "MANUAL",
				grossAmount: "1000.00",
				userShareAmount: "400.00",
				externalShareAmount: "600.00",
				userWeight: null,
				items: [
					{
						personId: "00000000-0000-0000-0000-000000000010",
						shareAmount: "600.00",
						weight: null,
						dueDate: null,
						description: "Updated note",
					},
				],
				occurredAt,
			});

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp2).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).not.toBe(fp2);
		});

		it("produces valid void fingerprint", async () => {
			const fpVoid = await calculateSplitVoidFingerprint({
				userId,
				splitId,
				expectedRevisionNo: 2,
				occurredAt,
			});

			expect(fpVoid).toMatch(/^[0-9a-f]{64}$/);
		});
	});
});
