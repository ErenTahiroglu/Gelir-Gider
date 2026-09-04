import { describe, expect, it } from "vitest";
import {
	calculateShortTermGoalCreateFingerprintV2,
	calculateShortTermGoalPriorityFingerprint,
	calculateShortTermGoalRevisionFingerprintV1,
	calculateShortTermGoalTerminalFingerprintV2,
	calculateShortTermGoalUpdateFingerprintV2,
	generateHashedPriorityIdempotencyKey,
} from "../src/short-term-goals/fingerprint";

describe("Short-Term Goal Fingerprinting & Hashed Keys (Phase 9-R1)", () => {
	const fixedDate = new Date("2026-09-04T12:00:00.000Z");

	describe("Fingerprint v2 — CREATE", () => {
		it("calculates deterministic 64 lowercase hex SHA-256 fingerprint including priorityPosition", async () => {
			const fp1 = await calculateShortTermGoalCreateFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				name: "New Laptop",
				fundingTarget: "35000.00",
				targetDate: "2026-12-31",
				maxBudget: "40000.00",
				targetPrice: "38000.00",
				productUrl: "https://example.com/laptop",
				note: "Work upgrade",
				priorityPosition: 1,
				occurredAt: fixedDate,
			});

			const fp2 = await calculateShortTermGoalCreateFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				name: "New Laptop",
				fundingTarget: "35000.00",
				targetDate: "2026-12-31",
				maxBudget: "40000.00",
				targetPrice: "38000.00",
				productUrl: "https://example.com/laptop",
				note: "Work upgrade",
				priorityPosition: 1,
				occurredAt: fixedDate,
			});

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).toBe(fp2);
		});

		it("produces different fingerprint for different priorityPosition on CREATE", async () => {
			const fpPos1 = await calculateShortTermGoalCreateFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				name: "New Laptop",
				fundingTarget: "35000.00",
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				priorityPosition: 1,
				occurredAt: fixedDate,
			});

			const fpPos2 = await calculateShortTermGoalCreateFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				name: "New Laptop",
				fundingTarget: "35000.00",
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				priorityPosition: 2,
				occurredAt: fixedDate,
			});

			expect(fpPos1).not.toBe(fpPos2);
		});
	});

	describe("Fingerprint v2 — UPDATE", () => {
		it("calculates deterministic fingerprint including expectedRevisionNo", async () => {
			const fp1 = await calculateShortTermGoalUpdateFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				expectedRevisionNo: 1,
				name: "Updated Laptop",
				fundingTarget: "38000.00",
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				changeReason: "Price update",
				occurredAt: fixedDate,
			});

			const fpRev2 = await calculateShortTermGoalUpdateFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				expectedRevisionNo: 2,
				name: "Updated Laptop",
				fundingTarget: "38000.00",
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				changeReason: "Price update",
				occurredAt: fixedDate,
			});

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).not.toBe(fpRev2);
		});
	});

	describe("Fingerprint v2 — COMPLETE / CANCEL", () => {
		it("calculates terminal fingerprint including operation and expectedRevisionNo", async () => {
			const fpComplete = await calculateShortTermGoalTerminalFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				operation: "COMPLETE",
				expectedRevisionNo: 3,
				changeReason: "Fully funded and purchased",
				occurredAt: fixedDate,
			});

			const fpCancel = await calculateShortTermGoalTerminalFingerprintV2({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				operation: "CANCEL",
				expectedRevisionNo: 3,
				changeReason: "Fully funded and purchased",
				occurredAt: fixedDate,
			});

			expect(fpComplete).toMatch(/^[0-9a-f]{64}$/);
			expect(fpCancel).toMatch(/^[0-9a-f]{64}$/);
			expect(fpComplete).not.toBe(fpCancel);
		});
	});

	describe("Legacy v1 Fingerprint Compatibility", () => {
		it("retains deterministic v1 calculation for historical rows", async () => {
			const fpV1 = await calculateShortTermGoalRevisionFingerprintV1({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "ACTIVE",
				name: "Laptop",
				fundingTarget: "1000.00",
				targetDate: null,
				maxBudget: null,
				targetPrice: null,
				productUrl: null,
				note: null,
				changeReason: null,
				occurredAt: fixedDate,
			});

			expect(fpV1).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	describe("Priority Revision Fingerprint (short-term-goal-priority-v1)", () => {
		it("calculates deterministic 64 lowercase hex SHA-256 fingerprint", async () => {
			const fp1 = await calculateShortTermGoalPriorityFingerprint({
				userId: "019543ef-1111-7000-8000-000000000001",
				midasAccountId: "019543ef-3333-7000-8000-000000000003",
				revisionNo: 1,
				previousRevisionId: null,
				orderedGoalIds: [
					"019543ef-aaaa-7000-8000-00000000000a",
					"019543ef-bbbb-7000-8000-00000000000b",
				],
				occurredAt: fixedDate,
			});

			const fp2 = await calculateShortTermGoalPriorityFingerprint({
				userId: "019543ef-1111-7000-8000-000000000001",
				midasAccountId: "019543ef-3333-7000-8000-000000000003",
				revisionNo: 1,
				previousRevisionId: null,
				orderedGoalIds: [
					"019543ef-aaaa-7000-8000-00000000000a",
					"019543ef-bbbb-7000-8000-00000000000b",
				],
				occurredAt: fixedDate,
			});

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).toBe(fp2);
		});
	});

	describe("Bounded Internal Priority Idempotency Key (Section 15, 16)", () => {
		it("generates deterministic SHA-256 namespaced key <= 128 characters even with 128-char caller key", async () => {
			const callerKey128 = "k".repeat(128);
			const goalId = "019543ef-2222-7000-8000-000000000002";

			const internalKey = await generateHashedPriorityIdempotencyKey(
				callerKey128,
				goalId,
				"CREATE",
			);

			expect(internalKey.startsWith("STG_PRIORITY_")).toBe(true);
			expect(internalKey.length).toBe(13 + 64); // 77 characters <= 128
			expect(internalKey.length).toBeLessThanOrEqual(128);

			// Deterministic
			const internalKey2 = await generateHashedPriorityIdempotencyKey(
				callerKey128,
				goalId,
				"CREATE",
			);
			expect(internalKey).toBe(internalKey2);

			// Different namespace produces different key
			const internalKeyCancel = await generateHashedPriorityIdempotencyKey(
				callerKey128,
				goalId,
				"CANCEL",
			);
			expect(internalKey).not.toBe(internalKeyCancel);
		});
	});
});
