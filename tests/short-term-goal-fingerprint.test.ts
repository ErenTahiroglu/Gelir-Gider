import { describe, expect, it } from "vitest";
import {
	calculateShortTermGoalPriorityFingerprint,
	calculateShortTermGoalRevisionFingerprint,
} from "../src/short-term-goals/fingerprint";

describe("Short-Term Goal Fingerprinting (Phase 9)", () => {
	const fixedDate = new Date("2026-09-04T12:00:00.000Z");

	describe("Revision Fingerprint (short-term-goal-revision-v1)", () => {
		it("calculates deterministic 64 lowercase hex SHA-256 fingerprint", async () => {
			const fp1 = await calculateShortTermGoalRevisionFingerprint({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "ACTIVE",
				name: "New Laptop",
				fundingTarget: "35000.00",
				targetDate: "2026-12-31",
				maxBudget: "40000.00",
				targetPrice: "38000.00",
				productUrl: "https://example.com/laptop",
				note: "Work upgrade",
				changeReason: null,
				occurredAt: fixedDate,
			});

			const fp2 = await calculateShortTermGoalRevisionFingerprint({
				userId: "019543ef-1111-7000-8000-000000000001",
				goalId: "019543ef-2222-7000-8000-000000000002",
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "ACTIVE",
				name: "New Laptop",
				fundingTarget: "35000.00",
				targetDate: "2026-12-31",
				maxBudget: "40000.00",
				targetPrice: "38000.00",
				productUrl: "https://example.com/laptop",
				note: "Work upgrade",
				changeReason: null,
				occurredAt: fixedDate,
			});

			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
			expect(fp1).toBe(fp2);
		});

		it("normalizes case and whitespace in UUIDs", async () => {
			const fpUpper = await calculateShortTermGoalRevisionFingerprint({
				userId: " 019543EF-1111-7000-8000-000000000001 ",
				goalId: " 019543EF-2222-7000-8000-000000000002 ",
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

			const fpLower = await calculateShortTermGoalRevisionFingerprint({
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

			expect(fpUpper).toBe(fpLower);
		});

		it("detects changes in any configuration field", async () => {
			const baseParams = {
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
			};

			const baseFp =
				await calculateShortTermGoalRevisionFingerprint(baseParams);

			const changedTarget = await calculateShortTermGoalRevisionFingerprint({
				...baseParams,
				fundingTarget: "1500.00",
			});
			expect(changedTarget).not.toBe(baseFp);

			const changedStatus = await calculateShortTermGoalRevisionFingerprint({
				...baseParams,
				status: "COMPLETED",
			});
			expect(changedStatus).not.toBe(baseFp);

			const changedMaxBudget = await calculateShortTermGoalRevisionFingerprint({
				...baseParams,
				maxBudget: "2000.00",
			});
			expect(changedMaxBudget).not.toBe(baseFp);
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

		it("detects order changes in goal IDs", async () => {
			const fpOrder1 = await calculateShortTermGoalPriorityFingerprint({
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

			const fpOrder2 = await calculateShortTermGoalPriorityFingerprint({
				userId: "019543ef-1111-7000-8000-000000000001",
				midasAccountId: "019543ef-3333-7000-8000-000000000003",
				revisionNo: 1,
				previousRevisionId: null,
				orderedGoalIds: [
					"019543ef-bbbb-7000-8000-00000000000b",
					"019543ef-aaaa-7000-8000-00000000000a",
				],
				occurredAt: fixedDate,
			});

			expect(fpOrder1).not.toBe(fpOrder2);
		});
	});
});
