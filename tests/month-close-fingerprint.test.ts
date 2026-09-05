import { describe, expect, it } from "vitest";
import {
	calculateMonthCloseApplyFingerprint,
	calculateMonthCloseProposalFingerprint,
	deriveMonthCloseChildIdempotencyKey,
} from "../src/month-close/fingerprint";

const fixedDate = new Date("2026-04-01T00:00:00.000Z");
const USER_ID = "019543ef-1111-7000-8000-000000000001";
const PLAN_ID = "019543ef-2222-7000-8000-000000000002";
const GOAL_ID = "019543ef-3333-7000-8000-000000000003";
const BUCKET_ID = "019543ef-4444-7000-8000-000000000004";

function baseProposalParams() {
	return {
		userId: USER_ID,
		periodMonth: "2026-03",
		budgetPlanId: PLAN_ID,
		budgetPlanRevisionNo: 1,
		referenceIncome: "10000.00",
		mandatoryCeiling: "6500.00",
		mandatoryExpense: "6000.00",
		mandatoryUnused: "500.00",
		discretionaryCeiling: "500.00",
		discretionaryExpense: "300.00",
		discretionaryUnused: "200.00",
		unclassifiedExpense: "0.00",
		closeSurplus: "700.00",
		route: "SHORT_TERM_GOAL" as const,
		recommendedGoal: {
			goalId: GOAL_ID,
			revisionNo: 3,
			priority: 1,
			bucketId: BUCKET_ID,
			remainingToTarget: "1000.00",
		},
	};
}

describe("Month Close Proposal Fingerprint (Phase 14, Section 8)", () => {
	it("is deterministic for identical input", async () => {
		const fp1 = await calculateMonthCloseProposalFingerprint(
			baseProposalParams(),
		);
		const fp2 = await calculateMonthCloseProposalFingerprint(
			baseProposalParams(),
		);
		expect(fp1).toBe(fp2);
		expect(fp1).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is sensitive to closeSurplus changes", async () => {
		const fp1 = await calculateMonthCloseProposalFingerprint(
			baseProposalParams(),
		);
		const fp2 = await calculateMonthCloseProposalFingerprint({
			...baseProposalParams(),
			closeSurplus: "701.00",
		});
		expect(fp1).not.toBe(fp2);
	});

	it("is sensitive to route changes", async () => {
		const fp1 = await calculateMonthCloseProposalFingerprint(
			baseProposalParams(),
		);
		const fp2 = await calculateMonthCloseProposalFingerprint({
			...baseProposalParams(),
			route: "MEDIUM_TERM_RESERVE",
			recommendedGoal: null,
		});
		expect(fp1).not.toBe(fp2);
	});

	it("is sensitive to recommended goal revision changes", async () => {
		const params = baseProposalParams();
		const fp1 = await calculateMonthCloseProposalFingerprint(params);
		const fp2 = await calculateMonthCloseProposalFingerprint({
			...params,
			recommendedGoal: { ...params.recommendedGoal, revisionNo: 4 },
		});
		expect(fp1).not.toBe(fp2);
	});

	it("is sensitive to recommended goal priority changes", async () => {
		const params = baseProposalParams();
		const fp1 = await calculateMonthCloseProposalFingerprint(params);
		const fp2 = await calculateMonthCloseProposalFingerprint({
			...params,
			recommendedGoal: { ...params.recommendedGoal, priority: 2 },
		});
		expect(fp1).not.toBe(fp2);
	});

	it("is sensitive to recommended goal remainingToTarget changes", async () => {
		const params = baseProposalParams();
		const fp1 = await calculateMonthCloseProposalFingerprint(params);
		const fp2 = await calculateMonthCloseProposalFingerprint({
			...params,
			recommendedGoal: {
				...params.recommendedGoal,
				remainingToTarget: "999.00",
			},
		});
		expect(fp1).not.toBe(fp2);
	});

	it("is sensitive to budget plan revision changes", async () => {
		const params = baseProposalParams();
		const fp1 = await calculateMonthCloseProposalFingerprint(params);
		const fp2 = await calculateMonthCloseProposalFingerprint({
			...params,
			budgetPlanRevisionNo: 2,
		});
		expect(fp1).not.toBe(fp2);
	});

	it("does NOT bind to Midas unallocated liquidity (Section 20) -- not part of the input shape at all", async () => {
		// The fingerprint function signature has no liquidity field; this test
		// documents the deliberate exclusion by proving two calls with
		// otherwise-identical economic inputs match regardless of any
		// out-of-band liquidity state (nothing to pass in the first place).
		const fp1 = await calculateMonthCloseProposalFingerprint(
			baseProposalParams(),
		);
		const fp2 = await calculateMonthCloseProposalFingerprint(
			baseProposalParams(),
		);
		expect(fp1).toBe(fp2);
	});
});

describe("Month Close Apply/Idempotency Fingerprint (Phase 14, Section 34)", () => {
	function baseApplyParams() {
		return {
			userId: USER_ID,
			periodMonth: "2026-03",
			expectedProposalFingerprint: "a".repeat(64),
			effectiveRoute: "SHORT_TERM_GOAL" as const,
			decision: "FULL" as const,
			partialAmount: null,
			occurredAt: fixedDate,
		};
	}

	it("is deterministic and sensitive to decision/partialAmount/occurredAt/period", async () => {
		const base = await calculateMonthCloseApplyFingerprint(baseApplyParams());
		expect(base).toMatch(/^[0-9a-f]{64}$/);

		const diffDecision = await calculateMonthCloseApplyFingerprint({
			...baseApplyParams(),
			decision: "SKIP",
		});
		expect(diffDecision).not.toBe(base);

		const diffPartial = await calculateMonthCloseApplyFingerprint({
			...baseApplyParams(),
			decision: "PARTIAL",
			partialAmount: "250.00",
		});
		expect(diffPartial).not.toBe(base);

		const diffOccurredAt = await calculateMonthCloseApplyFingerprint({
			...baseApplyParams(),
			occurredAt: new Date("2026-04-02T00:00:00.000Z"),
		});
		expect(diffOccurredAt).not.toBe(base);

		const diffPeriod = await calculateMonthCloseApplyFingerprint({
			...baseApplyParams(),
			periodMonth: "2026-04",
		});
		expect(diffPeriod).not.toBe(base);

		const diffProposal = await calculateMonthCloseApplyFingerprint({
			...baseApplyParams(),
			expectedProposalFingerprint: "b".repeat(64),
		});
		expect(diffProposal).not.toBe(base);

		const diffRoute = await calculateMonthCloseApplyFingerprint({
			...baseApplyParams(),
			effectiveRoute: "MEDIUM_TERM_RESERVE",
			decision: "AUTO_MEDIUM",
		});
		expect(diffRoute).not.toBe(base);
	});
});

describe("Month Close Child Idempotency Key Derivation (Phase 14, Section 35)", () => {
	it("derives a bounded 64-char hex key, distinct per parts", async () => {
		const parentKey = "x".repeat(128);
		const k1 = await deriveMonthCloseChildIdempotencyKey(parentKey, [
			"2026-03",
			"SHORT_TERM_GOAL",
			"transfer",
		]);
		const k2 = await deriveMonthCloseChildIdempotencyKey(parentKey, [
			"2026-03",
			"MEDIUM_TERM_RESERVE",
			"transfer",
		]);
		expect(k1).toMatch(/^[0-9a-f]{64}$/);
		expect(k2).toMatch(/^[0-9a-f]{64}$/);
		expect(k1).not.toBe(k2);
	});

	it("is deterministic for identical parent key and parts", async () => {
		const parentKey = "parent-key-123";
		const k1 = await deriveMonthCloseChildIdempotencyKey(parentKey, ["a", "b"]);
		const k2 = await deriveMonthCloseChildIdempotencyKey(parentKey, ["a", "b"]);
		expect(k1).toBe(k2);
	});
});
