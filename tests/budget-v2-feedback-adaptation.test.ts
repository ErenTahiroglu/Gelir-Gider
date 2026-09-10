import { describe, expect, it } from "vitest";
import {
	ALL_BUDGET_V2_RECOMMENDATION_KINDS,
	BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS,
	BUDGET_V2_FEEDBACK_ADAPTATION_ENGINE_VERSION,
	BUDGET_V2_FEEDBACK_MIN_CHECKPOINTS,
	BUDGET_V2_FEEDBACK_MIN_DECISION_COUNT,
	BUDGET_V2_FEEDBACK_MIN_INSTANCES,
	BUDGET_V2_FEEDBACK_MIN_PERIOD_MONTHS,
	BUDGET_V2_FEEDBACK_MIN_SPAN_DAYS,
	BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP,
	BUDGET_V2_FEEDBACK_WINDOW_DAYS,
	BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS,
	BUDGET_V2_SUPPORTED_RECOMMENDATION_ENGINE_VERSIONS,
	type BudgetV2AdaptiveAttentionInput,
	computeFeedbackRateBp,
	evaluateBudgetV2AdaptiveKindAttention,
} from "../src/budget/feedback-adaptation-v2";

// ---------------------------------------------------------------------------
// Section 2, 9, 10, 11, 24 -- closed catalogue & versioned constants
// ---------------------------------------------------------------------------

describe("Budget V2 feedback adaptation -- constants & closed catalogue", () => {
	it("pins the adaptation engine version and all learning thresholds", () => {
		expect(BUDGET_V2_FEEDBACK_ADAPTATION_ENGINE_VERSION).toBe(
			"budget-v2-feedback-adaptation-v1",
		);
		expect(BUDGET_V2_FEEDBACK_WINDOW_DAYS).toBe(90);
		expect(BUDGET_V2_FEEDBACK_MIN_INSTANCES).toBe(4);
		expect(BUDGET_V2_FEEDBACK_MIN_CHECKPOINTS).toBe(4);
		expect(BUDGET_V2_FEEDBACK_MIN_PERIOD_MONTHS).toBe(2);
		expect(BUDGET_V2_FEEDBACK_MIN_SPAN_DAYS).toBe(30);
		expect(BUDGET_V2_FEEDBACK_RATE_THRESHOLD_BP).toBe(7500);
		expect(BUDGET_V2_FEEDBACK_MIN_DECISION_COUNT).toBe(3);
	});

	it("splits the 11 kinds into exactly 6 protected + 5 adaptive, no overlap", () => {
		expect([...BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS]).toEqual([
			"DATA_COMPLETION_REQUIRED",
			"DEFICIT_STABILIZATION_REVIEW",
			"SURPLUS_OVERSUBSCRIPTION_REVIEW",
			"EMERGENCY_REBUILD_REVIEW",
			"BASELINE_RESET_REVIEW",
			"LANE_OVERRUN_REVIEW",
		]);
		expect([...BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS]).toEqual([
			"DISCRETIONARY_SPIKE_REVIEW",
			"OBLIGATION_LOAD_SPIKE_REVIEW",
			"TRUE_SURPLUS_RATE_DROP_REVIEW",
			"FOOD_OUTSIDE_SHARE_SPIKE_REVIEW",
			"UNUSED_DISCRETIONARY_SWEEP_REVIEW",
		]);
		const overlap = BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS.filter((k) =>
			(BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS as readonly string[]).includes(
				k,
			),
		);
		expect(overlap).toEqual([]);
		expect([...ALL_BUDGET_V2_RECOMMENDATION_KINDS].sort()).toEqual(
			[
				...BUDGET_V2_PROTECTED_RECOMMENDATION_KINDS,
				...BUDGET_V2_ADAPTIVE_RECOMMENDATION_KINDS,
			].sort(),
		);
		expect(ALL_BUDGET_V2_RECOMMENDATION_KINDS).toHaveLength(11);
	});

	it("only budget-v2-recommendation-engine-v1 is a supported feedback source (Section 24)", () => {
		expect([...BUDGET_V2_SUPPORTED_RECOMMENDATION_ENGINE_VERSIONS]).toEqual([
			"budget-v2-recommendation-engine-v1",
		]);
	});
});

// ---------------------------------------------------------------------------
// Section 14 / 30.AO / 30.AP -- exact integer basis-point rates
// ---------------------------------------------------------------------------

describe("computeFeedbackRateBp -- exact integer arithmetic (Sections 14, 30.AO, 30.AP)", () => {
	it("computes exact integer bp with floor semantics", () => {
		expect(computeFeedbackRateBp(3, 4)).toBe(7500);
		expect(computeFeedbackRateBp(1, 3)).toBe(3333); // floor(10000/3)
		expect(computeFeedbackRateBp(2, 3)).toBe(6666);
		expect(computeFeedbackRateBp(5, 5)).toBe(10000);
		expect(computeFeedbackRateBp(3, 8)).toBe(3750);
	});

	it("MODIFY stays in the denominator: it never lifts the ACCEPT/IGNORE numerator (Section 30.I)", () => {
		// 3 ACCEPT + 1 MODIFY over 4 total -> 75.00%
		expect(computeFeedbackRateBp(3, 4)).toBe(7500);
		// 3 ACCEPT + 2 MODIFY over 5 total -> 60.00% (MODIFY dilutes, never counts)
		expect(computeFeedbackRateBp(3, 5)).toBe(6000);
	});

	it("returns 0 for degenerate inputs and never NaN / Infinity (Section 30.AP)", () => {
		for (const [n, d] of [
			[0, 0],
			[0, 4],
			[3, 0],
			[-1, 4],
			[3, -4],
			[Number.NaN, 4],
			[3, Number.NaN],
			[Number.POSITIVE_INFINITY, 4],
			[Number.MAX_SAFE_INTEGER + 4, 4],
		] as const) {
			const bp = computeFeedbackRateBp(n, d);
			expect(Number.isFinite(bp)).toBe(true);
			expect(bp).toBe(0);
		}
	});

	it("clamps into [0, 10000]", () => {
		expect(computeFeedbackRateBp(9, 4)).toBe(10000); // clamped, cannot exceed 100%
	});
});

// ---------------------------------------------------------------------------
// Section 13-17 / 30.A-30.J -- pure attention decision
// ---------------------------------------------------------------------------

describe("evaluateBudgetV2AdaptiveKindAttention -- pure learning rules (Sections 13-17, 30.A-30.J)", () => {
	const base: BudgetV2AdaptiveAttentionInput = {
		validInstanceCount: 0,
		acceptCount: 0,
		modifyCount: 0,
		ignoreCount: 0,
		distinctCheckpointCount: 0,
		distinctPeriodMonthCount: 0,
		historySpanDays: 0,
		latestDecision: null,
		latestDecisionAmbiguous: false,
	};
	const ev = (o: Partial<BudgetV2AdaptiveAttentionInput>) =>
		evaluateBudgetV2AdaptiveKindAttention({ ...base, ...o });

	it("30.A: a single IGNORE never produces a learned DEEMPHASIZE", () => {
		const r = ev({
			validInstanceCount: 1,
			ignoreCount: 1,
			distinctCheckpointCount: 1,
			distinctPeriodMonthCount: 1,
			latestDecision: "IGNORE",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.learned).toBe(false);
		expect(r.evidenceStatus).toBe("INSUFFICIENT");
	});

	it("30.B: fewer than 4 valid instances -> STANDARD (insufficient instance count)", () => {
		const r = ev({
			validInstanceCount: 3,
			acceptCount: 3,
			distinctCheckpointCount: 3,
			distinctPeriodMonthCount: 2,
			historySpanDays: 40,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.evidenceStatus).toBe("INSUFFICIENT");
		expect(r.reasonCodes).toContain("EVIDENCE_INSUFFICIENT_INSTANCE_COUNT");
	});

	it("30.B (checkpoints): 4 instances but < 4 distinct checkpoints -> STANDARD", () => {
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 4,
			distinctCheckpointCount: 3,
			distinctPeriodMonthCount: 2,
			historySpanDays: 40,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.reasonCodes).toContain("EVIDENCE_INSUFFICIENT_CHECKPOINTS");
	});

	it("30.C: 4 responses inside a single periodMonth -> STANDARD", () => {
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 4,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 1,
			historySpanDays: 40,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.reasonCodes).toContain("EVIDENCE_INSUFFICIENT_PERIODS");
	});

	it("30.D: feedback history spanning < 30 days -> STANDARD", () => {
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 4,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 20,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.reasonCodes).toContain("EVIDENCE_INSUFFICIENT_SPAN");
	});

	it("30.E: 3 ACCEPT / 4 total (75%) + latest ACCEPT + established -> EMPHASIZE", () => {
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 3,
			ignoreCount: 1,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("EMPHASIZE");
		expect(r.learned).toBe(true);
		expect(r.evidenceStatus).toBe("ESTABLISHED");
		expect(r.acceptRateBp).toBe(7500);
		expect(r.reasonCodes).toEqual([
			"EVIDENCE_ESTABLISHED",
			"ACCEPT_MAJORITY_ESTABLISHED",
		]);
	});

	it("30.F: 3 IGNORE / 4 total (75%) + latest IGNORE + established -> DEEMPHASIZE", () => {
		const r = ev({
			validInstanceCount: 4,
			ignoreCount: 3,
			acceptCount: 1,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "IGNORE",
		});
		expect(r.attention).toBe("DEEMPHASIZE");
		expect(r.learned).toBe(true);
		expect(r.ignoreRateBp).toBe(7500);
		expect(r.reasonCodes).toEqual([
			"EVIDENCE_ESTABLISHED",
			"IGNORE_MAJORITY_ESTABLISHED",
		]);
	});

	it("30.G: mixed 2 ACCEPT / 2 IGNORE (50/50) -> STANDARD (MIXED_FEEDBACK)", () => {
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 2,
			ignoreCount: 2,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.learned).toBe(false);
		expect(r.acceptRateBp).toBe(5000);
		expect(r.ignoreRateBp).toBe(5000);
		expect(r.reasonCodes).toContain("MIXED_FEEDBACK");
	});

	it("30.H: repeated MODIFY alone -> STANDARD (MODIFY_ENGAGEMENT_ONLY)", () => {
		const r = ev({
			validInstanceCount: 4,
			modifyCount: 4,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "MODIFY",
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.learned).toBe(false);
		expect(r.acceptRateBp).toBe(0);
		expect(r.ignoreRateBp).toBe(0);
		expect(r.reasonCodes).toContain("MODIFY_ENGAGEMENT_ONLY");
	});

	it("30.I: MODIFY in the denominator dilutes the rate below threshold -> STANDARD", () => {
		// 3 ACCEPT + 1 MODIFY over 4 -> 7500 -> EMPHASIZE
		expect(
			ev({
				validInstanceCount: 4,
				acceptCount: 3,
				modifyCount: 1,
				distinctCheckpointCount: 4,
				distinctPeriodMonthCount: 2,
				historySpanDays: 35,
				latestDecision: "ACCEPT",
			}).attention,
		).toBe("EMPHASIZE");
		// 3 ACCEPT + 2 MODIFY over 5 -> 6000 -> STANDARD
		const r = ev({
			validInstanceCount: 5,
			acceptCount: 3,
			modifyCount: 2,
			distinctCheckpointCount: 5,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "ACCEPT",
		});
		expect(r.acceptRateBp).toBe(6000);
		expect(r.attention).toBe("STANDARD");
	});

	it("30.J: latest decision contradicting the old majority blocks stale EMPHASIZE / DEEMPHASIZE", () => {
		const contradictAccept = ev({
			validInstanceCount: 4,
			acceptCount: 3,
			ignoreCount: 1,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "IGNORE",
		});
		expect(contradictAccept.attention).toBe("STANDARD");
		expect(contradictAccept.learned).toBe(false);
		expect(contradictAccept.reasonCodes).toContain(
			"LATEST_DECISION_CONTRADICTS_ACCEPT",
		);

		const contradictIgnore = ev({
			validInstanceCount: 4,
			ignoreCount: 3,
			acceptCount: 1,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "ACCEPT",
		});
		expect(contradictIgnore.attention).toBe("STANDARD");
		expect(contradictIgnore.reasonCodes).toContain(
			"LATEST_DECISION_CONTRADICTS_IGNORE",
		);
	});

	it("EMPHASIZE needs at least 3 ACCEPT decisions, not just a high rate", () => {
		// 2 ACCEPT + 2 MODIFY over 4 -> rate 5000, established, latest ACCEPT
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 2,
			modifyCount: 2,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: "ACCEPT",
		});
		expect(r.attention).toBe("STANDARD");
	});

	it("is byte-deterministic for identical input (Section 25)", () => {
		const input: BudgetV2AdaptiveAttentionInput = {
			validInstanceCount: 6,
			acceptCount: 5,
			modifyCount: 1,
			ignoreCount: 0,
			distinctCheckpointCount: 5,
			distinctPeriodMonthCount: 3,
			historySpanDays: 61,
			latestDecision: "ACCEPT",
			latestDecisionAmbiguous: false,
		};
		expect(JSON.stringify(evaluateBudgetV2AdaptiveKindAttention(input))).toBe(
			JSON.stringify(evaluateBudgetV2AdaptiveKindAttention(input)),
		);
	});

	// 6D.1 Sections 7-9 / tests M-O, Q: latest-decision timestamp ambiguity
	it("6D.1/N: an ambiguous latest instant cannot trigger EMPHASIZE even at a 75% ACCEPT majority", () => {
		const r = ev({
			validInstanceCount: 4,
			acceptCount: 3,
			ignoreCount: 1,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: null,
			latestDecisionAmbiguous: true,
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.learned).toBe(false);
		expect(r.evidenceStatus).toBe("ESTABLISHED");
		expect(r.reasonCodes).toContain("LATEST_DECISION_TIMESTAMP_AMBIGUOUS");
		expect(r.reasonCodes).not.toContain("ACCEPT_MAJORITY_ESTABLISHED");
	});

	it("6D.1/O: an ambiguous latest instant cannot trigger DEEMPHASIZE even at a 75% IGNORE majority", () => {
		const r = ev({
			validInstanceCount: 4,
			ignoreCount: 3,
			acceptCount: 1,
			distinctCheckpointCount: 4,
			distinctPeriodMonthCount: 2,
			historySpanDays: 35,
			latestDecision: null,
			latestDecisionAmbiguous: true,
		});
		expect(r.attention).toBe("STANDARD");
		expect(r.reasonCodes).toContain("LATEST_DECISION_TIMESTAMP_AMBIGUOUS");
		expect(r.reasonCodes).not.toContain("IGNORE_MAJORITY_ESTABLISHED");
	});

	it("6D.1/K-L: an unambiguous latest decision still learns normally", () => {
		expect(
			ev({
				validInstanceCount: 4,
				acceptCount: 3,
				ignoreCount: 1,
				distinctCheckpointCount: 4,
				distinctPeriodMonthCount: 2,
				historySpanDays: 35,
				latestDecision: "ACCEPT",
				latestDecisionAmbiguous: false,
			}).attention,
		).toBe("EMPHASIZE");
	});

	it("30.AP: every branch returns a finite, in-catalogue result", () => {
		const attns = new Set(["EMPHASIZE", "STANDARD", "DEEMPHASIZE"]);
		for (let i = 0; i < 60; i++) {
			const r = ev({
				validInstanceCount: i,
				acceptCount: i % 5,
				modifyCount: i % 3,
				ignoreCount: i % 4,
				distinctCheckpointCount: i % 6,
				distinctPeriodMonthCount: i % 3,
				historySpanDays: (i * 7) % 120,
				latestDecision:
					(["ACCEPT", "MODIFY", "IGNORE", null] as const)[i % 4] ?? null,
				latestDecisionAmbiguous: i % 7 === 0,
			});
			expect(attns.has(r.attention)).toBe(true);
			expect(Number.isFinite(r.acceptRateBp)).toBe(true);
			expect(Number.isFinite(r.ignoreRateBp)).toBe(true);
			expect(r.acceptRateBp).toBeGreaterThanOrEqual(0);
			expect(r.acceptRateBp).toBeLessThanOrEqual(10000);
			if (r.attention !== "STANDARD") expect(r.learned).toBe(true);
		}
	});
});
