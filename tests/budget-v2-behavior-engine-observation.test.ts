import { describe, expect, it } from "vitest";
import {
	type BudgetV2CheckpointReport,
	extractBehaviorEngineCheckpointObservation,
} from "../src/budget/checkpoint-report-v2";

/**
 * Checkpoint 5B.1 section 9 -- the Behavior Engine's observation source is the
 * PERSISTED checkpoint report (replay-before-live), never
 * `resolveBudgetV2LiveSnapshot(...).availableToAllocateNow`.
 * `extractBehaviorEngineCheckpointObservation` is a PURE projection of an
 * already-built report object; this pins its field contract. The end-to-end
 * "persisted checkpoint freezes the observation" proof lives in
 * `scripts/pg-runtime-verify.ts` Phase 5B.1 (AG).
 */

function baseReport(
	atn: BudgetV2CheckpointReport["availableToAllocateNow"],
	su?: Partial<BudgetV2CheckpointReport["mtd"]["surplusUseAttribution"]>,
): BudgetV2CheckpointReport {
	return {
		schemaVersion: "budget-v2-checkpoint-report-v1",
		checkpoint: {
			schemaVersion: "budget-v2-checkpoint-report-v1",
			periodMonth: "2026-09-01",
			paymentEventId: "pe-1",
			payRevisionId: "pr-1",
			statementId: "st-1",
			checkpointAt: "2026-09-15T00:00:00.000Z",
			previousCheckpointAt: "2026-09-05T00:00:00.000Z",
			isFirstCheckpoint: false,
			intervalStart: "2026-09-05T00:00:00.000Z",
			intervalStartInclusive: false,
			intervalEnd: "2026-09-15T00:00:00.000Z",
			mtdWindowStart: "2026-08-31T21:00:00.000Z",
			mtdWindowEnd: "2026-09-15T00:00:00.000Z",
		},
		// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
		triggerPayment: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
		interval: {} as any,
		mtd: {
			// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
			spending: {} as any,
			budget: {
				// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
				inputs: {} as any,
				policyOutput: {
					deficit: "0.00",
					emergencyCatchUp: "0.00",
					trueSurplus: "5000.00",
					mobilityAllocation: "1750.00",
					longTermInvestment: "1500.00",
					discretionaryAllocation: "1750.00",
				},
				basicLiving: {
					approvedTarget: "0.00",
					actualPersonalMandatorySpendMTD: "0.00",
					grossBasicLivingNeed: "0.00",
					overlapWithCurrentObligations: "0.00",
					basicLivingFunding: "0.00",
				},
			},
			emergencyFund: { currentBalance: "0.00", target: "0.00", gap: "0.00" },
			mobility: { currentTotal: "0.00", perGoal: [] },
			necessaryPurchases: {
				totalMonthlyContribution: "0.00",
				perGoal: [],
				overdueGoalIds: [],
			},
			surplusUseAttribution: {
				candidates: [],
				candidateCount: 2,
				attributedCount: 1,
				coverageComplete: true,
				unattributedSubjectIds: [],
				staleSubjectIds: [],
				overlapUnresolvedSubjectIds: [],
				knownAttributedCurrentSurplusUse: "300.00",
				...su,
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
		foodAnalytics: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
		installmentAnalytics: {} as any,
		availableToAllocateNow: atn,
	};
}

describe("extractBehaviorEngineCheckpointObservation", () => {
	it("projects the checkpoint identity + surplus-use coverage + authoritative availability", () => {
		const report = baseReport({
			available: true,
			amount: "4700.00",
			trueSurplus: "5000.00",
			totalAttributedCurrentSurplusUse: "300.00",
			oversubscribedBy: "0.00",
			lanes: {
				INTERNATIONAL_MOBILITY: {
					planned: "1750.00",
					used: "0.00",
					remaining: "1750.00",
					overrun: "0.00",
				},
				LONG_TERM_INVESTMENT: {
					planned: "1500.00",
					used: "0.00",
					remaining: "1500.00",
					overrun: "0.00",
				},
				DISCRETIONARY: {
					planned: "1750.00",
					used: "300.00",
					remaining: "1450.00",
					overrun: "0.00",
				},
			},
			provenance: {
				method: "AUTHORITATIVE_USER_APPROVED_SURPLUS_USE_ATTRIBUTION",
				meaning: "policy capacity, not a bank balance",
				candidateCount: 2,
				attributedCount: 1,
			},
		});
		const obs = extractBehaviorEngineCheckpointObservation(report);
		expect(obs.paymentEventId).toBe("pe-1");
		expect(obs.checkpointAt).toBe("2026-09-15T00:00:00.000Z");
		expect(obs.periodMonth).toBe("2026-09-01");
		expect(obs.previousCheckpointAt).toBe("2026-09-05T00:00:00.000Z");
		expect(obs.trueSurplus).toBe("5000.00");
		expect(obs.coverageComplete).toBe(true);
		expect(obs.candidateCount).toBe(2);
		expect(obs.attributedCount).toBe(1);
		expect(obs.availableAmount).toBe("4700.00");
		expect(obs.oversubscribedBy).toBe("0.00");
		expect(obs.lanes?.DISCRETIONARY.used).toBe("300.00");
		expect(obs.availableToAllocateNow).toBe(report.availableToAllocateNow);
	});

	it("carries the fail-closed reason + evidence and nulls the flat mirrors when availability is not authoritative", () => {
		const report = baseReport(
			{
				available: false,
				reason: "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED",
				trueSurplus: "5000.00",
				candidateCount: 1,
				attributedCount: 0,
				unattributedSubjectIds: [],
				staleSubjectIds: [],
				overlapUnresolvedSubjectIds: ["ev-x"],
				knownAttributedCurrentSurplusUse: "0.00",
				unresolvedPotentialUseAmount: null,
			},
			{
				coverageComplete: false,
				candidateCount: 1,
				attributedCount: 0,
				overlapUnresolvedSubjectIds: ["ev-x"],
			},
		);
		const obs = extractBehaviorEngineCheckpointObservation(report);
		expect(obs.coverageComplete).toBe(false);
		expect(obs.overlapUnresolvedSubjectIds).toEqual(["ev-x"]);
		expect(obs.availableAmount).toBeNull();
		expect(obs.oversubscribedBy).toBeNull();
		expect(obs.lanes).toBeNull();
		expect(
			obs.availableToAllocateNow.available === false &&
				obs.availableToAllocateNow.reason,
		).toBe("SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED");
	});
});
