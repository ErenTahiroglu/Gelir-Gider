import { describe, expect, it } from "vitest";
import {
	assembleBudgetV2BehaviorProfile,
	type BehaviorSnapshotInput,
} from "../src/budget/behavior-profile-v2";
import {
	type BudgetV2Recommendation,
	type BudgetV2RecommendationKind,
	generateBudgetV2Recommendations,
} from "../src/budget/behavior-recommendations-v2";
import { canonicalJsonStringify } from "../src/budget/checkpoint-canonical-v2";
import type { BudgetV2CheckpointReport } from "../src/budget/checkpoint-report-v2";

/**
 * Checkpoint 6B -- deterministic recommendation engine core. These pure vitest
 * cases pin the closed catalogue, the hard regime safety gates, confidence
 * gating, the safe-integer robust behavioural signals, lane-overrun scoping, the
 * unused-discretionary sweep OPTION, deterministic priority + max-3 truncation,
 * the explanation-evidence contract, deterministic recommendation IDs and the
 * user-approval-only / non-executing / non-mutating safety contract.
 *
 * The persisted-snapshot end-to-end proofs (recommendation set from real
 * snapshots only, byte-identical after a large live mutation, no extra
 * live-domain reads) live in `scripts/pg-runtime-verify.ts` Phase 6B.
 */

// ---------------------------------------------------------------------------
// Report fixture (a full checkpoint-report skeleton with the knobs we need)
// ---------------------------------------------------------------------------

interface LaneKnob {
	planned: string;
	used: string;
	remaining: string;
	overrun: string;
}
const ZERO_LANE: LaneKnob = {
	planned: "0.00",
	used: "0.00",
	remaining: "0.00",
	overrun: "0.00",
};

interface ReportKnobs {
	paymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
	realizedIncome?: string;
	currentObligations?: string;
	basicLivingFunding?: string;
	deficit?: string;
	emergencyCatchUp?: string;
	trueSurplus?: string;
	emergencyCurrentBalance?: string;
	emergencyTarget?: string;
	emergencyGap?: string;
	discretionarySpend?: string;
	food?: { total: string; outside: string; home: string } | null;
	atn?:
		| {
				available: true;
				amount: string;
				trueSurplus?: string;
				oversubscribedBy?: string;
				totalAttributed?: string;
				lanes?: {
					INTERNATIONAL_MOBILITY?: Partial<LaneKnob>;
					LONG_TERM_INVESTMENT?: Partial<LaneKnob>;
					DISCRETIONARY?: Partial<LaneKnob>;
				};
		  }
		| { available: false; reason: string };
}

function lane(k?: Partial<LaneKnob>): LaneKnob {
	return { ...ZERO_LANE, ...(k ?? {}) };
}

function mkReport(k: ReportKnobs): BudgetV2CheckpointReport {
	const atnKnob = k.atn ?? { available: true as const, amount: "0.00" };
	const availableToAllocateNow = atnKnob.available
		? {
				available: true,
				amount: atnKnob.amount,
				trueSurplus: atnKnob.trueSurplus ?? k.trueSurplus ?? "1000.00",
				totalAttributedCurrentSurplusUse: atnKnob.totalAttributed ?? "0.00",
				oversubscribedBy: atnKnob.oversubscribedBy ?? "0.00",
				lanes: {
					INTERNATIONAL_MOBILITY: lane(atnKnob.lanes?.INTERNATIONAL_MOBILITY),
					LONG_TERM_INVESTMENT: lane(atnKnob.lanes?.LONG_TERM_INVESTMENT),
					DISCRETIONARY: lane(atnKnob.lanes?.DISCRETIONARY),
				},
				provenance: {
					method: "AUTHORITATIVE_USER_APPROVED_SURPLUS_USE_ATTRIBUTION",
					meaning: "policy capacity, not a bank balance",
					candidateCount: 0,
					attributedCount: 0,
				},
			}
		: {
				available: false,
				reason: atnKnob.reason,
				trueSurplus: k.trueSurplus ?? "1000.00",
				candidateCount: 1,
				attributedCount: 0,
				unattributedSubjectIds: [],
				staleSubjectIds: [],
				overlapUnresolvedSubjectIds: ["ev-x"],
				knownAttributedCurrentSurplusUse: "0.00",
				unresolvedPotentialUseAmount: null,
			};

	const report = {
		schemaVersion: "budget-v2-checkpoint-report-v1",
		checkpoint: {
			schemaVersion: "budget-v2-checkpoint-report-v1",
			periodMonth: k.periodMonth,
			paymentEventId: k.paymentEventId,
			payRevisionId: "pr-1",
			statementId: "st-1",
			checkpointAt: k.checkpointAt,
			previousCheckpointAt: null,
			isFirstCheckpoint: true,
			intervalStart: k.checkpointAt,
			intervalStartInclusive: false,
			intervalEnd: k.checkpointAt,
			mtdWindowStart: k.checkpointAt,
			mtdWindowEnd: k.checkpointAt,
		},
		triggerPayment: {},
		interval: {},
		mtd: {
			spending: {
				byCategoryPersonalShare: {
					MANDATORY_EXPENSE: "0.00",
					DISCRETIONARY_SPEND: k.discretionarySpend ?? "0.00",
					SHORT_TERM_PURCHASE: "0.00",
					UNCLASSIFIED: "0.00",
				},
				grossCardPurchasesMTD: "0.00",
				personalCardSpendMTD: "0.00",
				externalCardSpendMTD: "0.00",
				externalCardSpendByRelationship: {
					FAMILY: "0.00",
					FRIEND: "0.00",
					OTHER: "0.00",
				},
			},
			budget: {
				inputs: {
					realizedIncome: k.realizedIncome ?? "10000.00",
					currentObligations: k.currentObligations ?? "0.00",
					basicLivingFunding: k.basicLivingFunding ?? "0.00",
					dateBoundNecessaryPurchaseFunding: "0.00",
					coreEmergencyFundBalance: k.emergencyCurrentBalance ?? "0.00",
					mobilityBalance: "0.00",
				},
				policyOutput: {
					deficit: k.deficit ?? "0.00",
					emergencyCatchUp: k.emergencyCatchUp ?? "0.00",
					trueSurplus: k.trueSurplus ?? "1000.00",
					mobilityAllocation: "0.00",
					longTermInvestment: "0.00",
					discretionaryAllocation: "1000.00",
				},
				basicLiving: {
					approvedTarget: "0.00",
					actualPersonalMandatorySpendMTD: "0.00",
					grossBasicLivingNeed: "0.00",
					overlapWithCurrentObligations: "0.00",
					basicLivingFunding: k.basicLivingFunding ?? "0.00",
				},
			},
			emergencyFund: {
				currentBalance: k.emergencyCurrentBalance ?? "0.00",
				target: k.emergencyTarget ?? "0.00",
				gap: k.emergencyGap ?? "0.00",
			},
			mobility: { currentTotal: "0.00", perGoal: [] },
			necessaryPurchases: {
				totalMonthlyContribution: "0.00",
				perGoal: [],
				overdueGoalIds: [],
			},
			surplusUseAttribution: {
				candidates: [],
				candidateCount: 0,
				attributedCount: 0,
				coverageComplete: true,
				unattributedSubjectIds: [],
				staleSubjectIds: [],
				overlapUnresolvedSubjectIds: [],
				knownAttributedCurrentSurplusUse: "0.00",
			},
		},
		foodAnalytics:
			k.food === null || k.food === undefined
				? {
						available: false,
						reason: "FOOD_CLASSIFICATION_INCOMPLETE",
						merchantInferenceUsed: false,
						subjects: [],
						classifiedSubjectCount: 0,
						unclassifiedSubjectIds: [],
						staleSubjectIds: [],
						classifiedPersonalSpend: "0.00",
						unclassifiedOrStalePersonalSpend: "0.00",
						partialKnownFoodHomeMarket: "0.00",
						partialKnownFoodOutside: "0.00",
						partialKnownFoodTotal: "0.00",
					}
				: {
						available: true,
						merchantInferenceUsed: false,
						subjects: [],
						classifiedSubjectCount: 1,
						foodHomeMarket: k.food.home,
						foodOutside: k.food.outside,
						foodTotal: k.food.total,
						classifiedPersonalSpend: "0.00",
					},
		installmentAnalytics: {
			purchases: [],
			futureInstallmentProjection: {
				available: false,
				reason: "INSTALLMENT_SCHEDULE_NOT_STORED",
			},
		},
		availableToAllocateNow,
	};
	return report as unknown as BudgetV2CheckpointReport;
}

function snap(k: ReportKnobs): BehaviorSnapshotInput {
	return {
		paymentEventId: k.paymentEventId,
		periodMonth: k.periodMonth,
		checkpointAt: k.checkpointAt,
		report: mkReport(k),
	};
}

const DAY = 86_400_000;
const BASE = "2026-12-01T00:00:00.000Z";
function iso(minusDays: number): string {
	return new Date(Date.parse(BASE) - minusDays * DAY).toISOString();
}

function recsFor(
	throughPaymentEventId: string,
	snapshots: BehaviorSnapshotInput[],
) {
	return generateBudgetV2Recommendations(
		assembleBudgetV2BehaviorProfile({ throughPaymentEventId, snapshots }),
	);
}

function kinds(set: { recommendations: BudgetV2Recommendation[] }) {
	return set.recommendations.map((r) => r.kind);
}
function byKind(
	set: { recommendations: BudgetV2Recommendation[] },
	kind: BudgetV2RecommendationKind,
) {
	return set.recommendations.find((r) => r.kind === kind);
}

// A history whose in-DAYS_60-window personal-discretionary bp values form
// [100,200,300,400] plus the target's own `currentBp`. Deterministic:
// discretionarySpendIncomeBp == discretionarySpend cents / 100 at income 10000.
function spikeHistory(opts: {
	targetBp: number;
	monthsFor: (index: number) => string;
	minusDaysFor: (index: number) => number;
	extraOlder?: { minusDays: number; periodMonth: string } | null;
	field?: "discretionary" | "obligation" | "trueSurplus";
	baselineBps?: number[];
}): BehaviorSnapshotInput[] {
	const field = opts.field ?? "discretionary";
	const baseline = opts.baselineBps ?? [100, 200, 300, 400];
	const bpToKnob = (bp: number): Partial<ReportKnobs> => {
		const money = `${bp}.00`; // bp dollars over 10000 income -> bp basis points
		if (field === "discretionary") return { discretionarySpend: money };
		if (field === "obligation") return { currentObligations: money };
		return { trueSurplus: money };
	};
	const snaps: BehaviorSnapshotInput[] = [];
	snaps.push(
		snap({
			paymentEventId: "t",
			checkpointAt: iso(opts.minusDaysFor(0)),
			periodMonth: opts.monthsFor(0),
			realizedIncome: "10000.00",
			...bpToKnob(opts.targetBp),
		}),
	);
	baseline.forEach((bp, i) => {
		snaps.push(
			snap({
				paymentEventId: `h${i + 1}`,
				checkpointAt: iso(opts.minusDaysFor(i + 1)),
				periodMonth: opts.monthsFor(i + 1),
				realizedIncome: "10000.00",
				...bpToKnob(bp),
			}),
		);
	});
	if (opts.extraOlder) {
		snaps.push(
			snap({
				paymentEventId: "hOld",
				checkpointAt: iso(opts.extraOlder.minusDays),
				periodMonth: opts.extraOlder.periodMonth,
				realizedIncome: "10000.00",
				...bpToKnob(baseline[0] as number),
			}),
		);
	}
	return snaps;
}

// months / spacing presets
const MEDIUM_DAYS = [0, 10, 20, 30, 40];
const MEDIUM_MONTHS = [
	"2026-12-01",
	"2026-12-01",
	"2026-11-01",
	"2026-11-01",
	"2026-11-01",
];
const HIGH_DAYS = [0, 15, 30, 45, 60];
const HIGH_MONTHS = [
	"2026-12-01",
	"2026-12-01",
	"2026-11-01",
	"2026-11-01",
	"2026-10-01",
];

// ===========================================================================

describe("6B closed catalogue + hard regime safety gates (sections 4, 7-11)", () => {
	it("A: DATA_INCOMPLETE regime -> DATA_COMPLETION_REQUIRED", () => {
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				atn: { available: false, reason: "SURPLUS_USE_ATTRIBUTION_INCOMPLETE" },
			}),
		]);
		expect(kinds(set)).toEqual(["DATA_COMPLETION_REQUIRED"]);
		const rec = byKind(set, "DATA_COMPLETION_REQUIRED");
		expect(rec?.priority).toBe(100);
		expect(rec?.confidenceRequired).toBe("NONE");
		expect(rec?.evidence.availableToAllocateNowReason).toBe(
			"SURPLUS_USE_ATTRIBUTION_INCOMPLETE",
		);
		expect(rec?.proposedAction).toEqual({ action: "REVIEW_DATA_COMPLETION" });
	});

	it("B: DATA_INCOMPLETE suppresses every surplus / opportunity / pattern recommendation", () => {
		// a would-be obligation-load spike history, but the TARGET is data-incomplete
		const snaps = spikeHistory({
			targetBp: 500,
			field: "obligation",
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		// make the target data-incomplete
		snaps[0] = snap({
			paymentEventId: "t",
			checkpointAt: iso(0),
			periodMonth: "2026-12-01",
			realizedIncome: "10000.00",
			currentObligations: "500.00",
			atn: {
				available: false,
				reason: "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED",
			},
		});
		const set = recsFor("t", snaps);
		expect(kinds(set)).toContain("DATA_COMPLETION_REQUIRED");
		expect(kinds(set)).not.toContain("OBLIGATION_LOAD_SPIKE_REVIEW");
		expect(kinds(set)).not.toContain("UNUSED_DISCRETIONARY_SWEEP_REVIEW");
		expect(kinds(set)).not.toContain("LANE_OVERRUN_REVIEW");
		// only the data-completion safety rec and (because the regime moved into
		// DATA_INCOMPLETE) a meta baseline-reset review may appear -- nothing that
		// depends on exact current surplus availability.
		expect(
			kinds(set).every(
				(k) =>
					k === "DATA_COMPLETION_REQUIRED" || k === "BASELINE_RESET_REVIEW",
			),
		).toBe(true);
	});

	it("C: DEFICIT regime -> DEFICIT_STABILIZATION_REVIEW", () => {
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				deficit: "500.00",
				trueSurplus: "0.00",
				realizedIncome: "10000.00",
				currentObligations: "9500.00",
				atn: { available: true, amount: "0.00" },
			}),
		]);
		expect(kinds(set)).toContain("DEFICIT_STABILIZATION_REVIEW");
		const rec = byKind(set, "DEFICIT_STABILIZATION_REVIEW");
		expect(rec?.priority).toBe(95);
		expect(rec?.evidence).toMatchObject({
			deficit: "500.00",
			realizedIncome: "10000.00",
			currentObligations: "9500.00",
			trueSurplus: "0.00",
		});
	});

	it("D: DEFICIT suppresses the unused-discretionary sweep even with positive remaining/available", () => {
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				deficit: "500.00",
				trueSurplus: "0.00",
				atn: {
					available: true,
					amount: "500.00",
					lanes: { DISCRETIONARY: { remaining: "300.00" } },
				},
			}),
		]);
		expect(kinds(set)).toContain("DEFICIT_STABILIZATION_REVIEW");
		expect(kinds(set)).not.toContain("UNUSED_DISCRETIONARY_SWEEP_REVIEW");
	});

	it("E: OVERSUBSCRIBED regime -> SURPLUS_OVERSUBSCRIPTION_REVIEW", () => {
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				trueSurplus: "1000.00",
				atn: {
					available: true,
					amount: "0.00",
					oversubscribedBy: "250.00",
					totalAttributed: "1250.00",
					lanes: { DISCRETIONARY: { planned: "1000.00", used: "1250.00" } },
				},
			}),
		]);
		expect(kinds(set)).toContain("SURPLUS_OVERSUBSCRIPTION_REVIEW");
		const rec = byKind(set, "SURPLUS_OVERSUBSCRIPTION_REVIEW");
		expect(rec?.priority).toBe(90);
		expect(rec?.evidence.oversubscribedBy).toBe("250.00");
		expect(Array.isArray(rec?.evidence.lanes)).toBe(true);
	});

	it("F: EMERGENCY_REBUILD regime -> EMERGENCY_REBUILD_REVIEW", () => {
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				emergencyCatchUp: "300.00",
				emergencyGap: "300.00",
				emergencyCurrentBalance: "700.00",
				emergencyTarget: "1000.00",
				atn: { available: true, amount: "0.00" },
			}),
		]);
		expect(kinds(set)).toContain("EMERGENCY_REBUILD_REVIEW");
		const rec = byKind(set, "EMERGENCY_REBUILD_REVIEW");
		expect(rec?.priority).toBe(85);
		expect(rec?.evidence).toMatchObject({
			emergencyGap: "300.00",
			emergencyTarget: "1000.00",
			emergencyCatchUp: "300.00",
		});
	});
});

describe("6B regime change / baseline reset (section 12)", () => {
	const prev = snap({
		paymentEventId: "prev",
		checkpointAt: iso(20),
		periodMonth: "2026-11-01",
		deficit: "400.00",
		trueSurplus: "0.00",
		atn: { available: true, amount: "0.00" },
	});
	const target = snap({
		paymentEventId: "t",
		checkpointAt: iso(0),
		periodMonth: "2026-12-01",
		trueSurplus: "1000.00",
		atn: { available: true, amount: "800.00" },
	});

	it("G: a regime transition produces BASELINE_RESET_REVIEW", () => {
		const set = recsFor("t", [prev, target]);
		expect(kinds(set)).toContain("BASELINE_RESET_REVIEW");
		const rec = byKind(set, "BASELINE_RESET_REVIEW");
		expect(rec?.priority).toBe(80);
		expect(rec?.evidence).toMatchObject({
			previousRegime: "DEFICIT",
			currentRegime: "SURPLUS_AVAILABLE",
		});
	});

	it("H: BASELINE_RESET_REVIEW never resets or deletes history", () => {
		const snaps = [prev, target];
		const before = JSON.parse(JSON.stringify(snaps));
		const profile = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		const set = generateBudgetV2Recommendations(profile);
		const rec = byKind(set, "BASELINE_RESET_REVIEW");
		expect(rec?.proposedAction).toEqual({
			action: "REVIEW_HISTORICAL_BASELINE",
		});
		expect(rec?.mutatesPolicy).toBe(false);
		// history + derived stats are untouched by generation
		expect(snaps).toEqual(before);
		expect(profile.dataQuality.compatibleSnapshotCount).toBe(2);
		expect(profile.windows.DAYS_90.observationCount).toBe(2);
	});
});

describe("6B lane overrun scoping (section 13)", () => {
	const laneCase = (
		overLane:
			| "INTERNATIONAL_MOBILITY"
			| "LONG_TERM_INVESTMENT"
			| "DISCRETIONARY",
	) =>
		recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				atn: {
					available: true,
					amount: "0.00",
					lanes: {
						[overLane]: { planned: "100.00", used: "150.00", overrun: "50.00" },
					},
				},
			}),
		]);

	it("I: Mobility overrun -> LANE_OVERRUN_REVIEW scoped to INTERNATIONAL_MOBILITY", () => {
		const set = laneCase("INTERNATIONAL_MOBILITY");
		const rec = byKind(set, "LANE_OVERRUN_REVIEW");
		expect(rec?.scope).toBe("INTERNATIONAL_MOBILITY");
		expect(rec?.proposedAction).toEqual({
			action: "REVIEW_LANE_OVERRUN",
			lane: "INTERNATIONAL_MOBILITY",
		});
		expect(rec?.evidence).toMatchObject({
			lane: "INTERNATIONAL_MOBILITY",
			overrun: "50.00",
		});
	});

	it("J: Long-Term overrun -> LANE_OVERRUN_REVIEW scoped to LONG_TERM_INVESTMENT", () => {
		expect(
			byKind(laneCase("LONG_TERM_INVESTMENT"), "LANE_OVERRUN_REVIEW")?.scope,
		).toBe("LONG_TERM_INVESTMENT");
	});

	it("K: Discretionary overrun -> LANE_OVERRUN_REVIEW scoped to DISCRETIONARY", () => {
		expect(
			byKind(laneCase("DISCRETIONARY"), "LANE_OVERRUN_REVIEW")?.scope,
		).toBe("DISCRETIONARY");
	});
});

describe("6B confidence gating + robust behavioural signals (sections 14-18, 21)", () => {
	it("L: LOW confidence suppresses a would-be discretionary spike", () => {
		// 3 checkpoints in ~20 days -> span < 60d -> LOW
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				realizedIncome: "10000.00",
				discretionarySpend: "500.00",
			}),
			snap({
				paymentEventId: "h1",
				checkpointAt: iso(10),
				periodMonth: "2026-12-01",
				realizedIncome: "10000.00",
				discretionarySpend: "100.00",
			}),
			snap({
				paymentEventId: "h2",
				checkpointAt: iso(20),
				periodMonth: "2026-11-01",
				realizedIncome: "10000.00",
				discretionarySpend: "100.00",
			}),
		]);
		expect(set.confidence.level).toBe("LOW");
		expect(kinds(set)).not.toContain("DISCRETIONARY_SPIKE_REVIEW");
	});

	it("M: MEDIUM confidence permits the discretionary spike rule at validCount >= 4", () => {
		const snaps = spikeHistory({
			targetBp: 500,
			minusDaysFor: (i) => MEDIUM_DAYS[i] as number,
			monthsFor: (i) => MEDIUM_MONTHS[i] as string,
			extraOlder: { minusDays: 65, periodMonth: "2026-10-01" },
		});
		const set = recsFor("t", snaps);
		expect(set.confidence.level).toBe("MEDIUM");
		const rec = byKind(set, "DISCRETIONARY_SPIKE_REVIEW");
		expect(rec).toBeDefined();
		expect(rec?.confidenceRequired).toBe("MEDIUM_OR_HIGH");
		expect(rec?.evidence.validCount).toBe(5);
	});

	it("N: HIGH confidence permits the same deterministic spike rule", () => {
		const snaps = spikeHistory({
			targetBp: 500,
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		const set = recsFor("t", snaps);
		expect(set.confidence.level).toBe("HIGH");
		expect(kinds(set)).toContain("DISCRETIONARY_SPIKE_REVIEW");
	});

	it("O: discretionary spike robust rule -- current > p75 and current - median >= 2*MAD", () => {
		const snaps = spikeHistory({
			targetBp: 500,
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		const rec = byKind(recsFor("t", snaps), "DISCRETIONARY_SPIKE_REVIEW");
		// window bp [100,200,300,400,500]; median 300, p75 400, MAD 100
		expect(rec?.evidence).toMatchObject({
			currentBp: 500,
			medianBp: 300,
			p75Bp: 400,
			madBp: 100,
		});
		expect(rec?.reasonCodes).toEqual([
			"CURRENT_ABOVE_60D_P75",
			"DELTA_AT_LEAST_2_MAD",
		]);

		// a value just above p75 but within 2*MAD does NOT fire
		const noFire = spikeHistory({
			targetBp: 450,
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		expect(kinds(recsFor("t", noFire))).not.toContain(
			"DISCRETIONARY_SPIKE_REVIEW",
		);
	});

	it("P: obligation-load spike robust rule", () => {
		const snaps = spikeHistory({
			targetBp: 500,
			field: "obligation",
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		const rec = byKind(recsFor("t", snaps), "OBLIGATION_LOAD_SPIKE_REVIEW");
		expect(rec?.priority).toBe(50);
		expect(rec?.evidence).toMatchObject({
			currentBp: 500,
			medianBp: 300,
			currentObligations: "500.00",
			realizedIncome: "10000.00",
		});
	});

	it("Q: true-surplus-rate drop robust rule -- current < p25 and median - current >= 2*MAD", () => {
		const snaps = spikeHistory({
			targetBp: 50,
			field: "trueSurplus",
			baselineBps: [200, 300, 400, 500],
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		const rec = byKind(recsFor("t", snaps), "TRUE_SURPLUS_RATE_DROP_REVIEW");
		// window bp [50,200,300,400,500]; p25 200, median 300, MAD 100
		expect(rec?.evidence).toMatchObject({
			currentBp: 50,
			medianBp: 300,
			p25Bp: 200,
			madBp: 100,
		});
		expect(rec?.reasonCodes).toEqual([
			"CURRENT_BELOW_60D_P25",
			"DELTA_AT_LEAST_2_MAD",
		]);
	});

	it("T: MAD == 0 branch is deterministic and never divides by zero", () => {
		const snaps = spikeHistory({
			targetBp: 300,
			baselineBps: [100, 100, 100, 100],
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		const a = recsFor("t", snaps);
		const b = recsFor("t", [...snaps].reverse());
		expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
		const rec = byKind(a, "DISCRETIONARY_SPIKE_REVIEW");
		expect(rec?.evidence.madBp).toBe(0);
		expect(rec?.reasonCodes).toEqual([
			"CURRENT_ABOVE_60D_P75",
			"MAD_ZERO_CURRENT_ABOVE_MEDIAN",
		]);

		// equal to the flat baseline -> no spike (not strictly above median)
		const flat = spikeHistory({
			targetBp: 100,
			baselineBps: [100, 100, 100, 100],
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		expect(kinds(recsFor("t", flat))).not.toContain(
			"DISCRETIONARY_SPIKE_REVIEW",
		);
	});

	it("U: insufficient feature validCount suppresses the pattern recommendation", () => {
		// only target + 2 baseline within DAYS_60 -> validCount 3 < 4
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				realizedIncome: "10000.00",
				discretionarySpend: "500.00",
			}),
			snap({
				paymentEventId: "h1",
				checkpointAt: iso(30),
				periodMonth: "2026-11-01",
				realizedIncome: "10000.00",
				discretionarySpend: "100.00",
			}),
			snap({
				paymentEventId: "h2",
				checkpointAt: iso(50),
				periodMonth: "2026-10-01",
				realizedIncome: "10000.00",
				discretionarySpend: "100.00",
			}),
			snap({
				paymentEventId: "h3",
				checkpointAt: iso(95),
				periodMonth: "2026-09-01",
				realizedIncome: "10000.00",
				discretionarySpend: "100.00",
			}),
		]);
		expect(set.confidence.level).not.toBe("LOW");
		expect(
			set.regime.current === "SURPLUS_FULLY_USED" ||
				set.regime.current === "SURPLUS_AVAILABLE",
		).toBe(true);
		expect(kinds(set)).not.toContain("DISCRETIONARY_SPIKE_REVIEW");
	});

	it("AK: an OUT_OF_SAFE_INTEGER_RANGE target feature cannot trigger a pattern rule", () => {
		const centsToMoney = (cents: bigint) => {
			const s = cents.toString().padStart(3, "0");
			return `${s.slice(0, -2)}.${s.slice(-2)}`;
		};
		const huge = centsToMoney(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
		const snaps = spikeHistory({
			targetBp: 500,
			field: "obligation",
			minusDaysFor: (i) => HIGH_DAYS[i] as number,
			monthsFor: (i) => HIGH_MONTHS[i] as string,
			extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
		});
		snaps[0] = snap({
			paymentEventId: "t",
			checkpointAt: iso(0),
			periodMonth: "2026-12-01",
			realizedIncome: "100.00",
			currentObligations: huge,
		});
		const set = recsFor("t", snaps);
		expect(kinds(set)).not.toContain("OBLIGATION_LOAD_SPIKE_REVIEW");
		// the checkpoint itself is still compatible
		const profile = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		expect(profile.dataQuality.incompatibleSnapshotCount).toBe(0);
	});
});

describe("6B food-outside spike requires authoritative food (sections 19)", () => {
	const foodHistory = (
		targetFood: { total: string; outside: string; home: string } | null,
	) => {
		const outsides = ["10.00", "20.00", "30.00", "40.00"];
		const snaps: BehaviorSnapshotInput[] = [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(HIGH_DAYS[0] as number),
				periodMonth: HIGH_MONTHS[0] as string,
				food: targetFood,
			}),
		];
		outsides.forEach((outside, i) => {
			snaps.push(
				snap({
					paymentEventId: `h${i + 1}`,
					checkpointAt: iso(HIGH_DAYS[i + 1] as number),
					periodMonth: HIGH_MONTHS[i + 1] as string,
					food: { total: "1000.00", outside, home: "0.00" },
				}),
			);
		});
		snaps.push(
			snap({
				paymentEventId: "hOld",
				checkpointAt: iso(95),
				periodMonth: "2026-09-01",
				food: { total: "1000.00", outside: "10.00", home: "0.00" },
			}),
		);
		return snaps;
	};

	it("R: authoritative food at the target + valid baseline -> FOOD_OUTSIDE_SHARE_SPIKE_REVIEW", () => {
		const set = recsFor(
			"t",
			foodHistory({ total: "1000.00", outside: "50.00", home: "0.00" }),
		);
		const rec = byKind(set, "FOOD_OUTSIDE_SHARE_SPIKE_REVIEW");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe(35);
		expect(rec?.evidence).toMatchObject({
			currentBp: 500,
			medianBp: 300,
			foodOutside: "50.00",
			foodTotal: "1000.00",
		});
	});

	it("S: unavailable food at the target never produces a food recommendation", () => {
		const set = recsFor("t", foodHistory(null));
		expect(kinds(set)).not.toContain("FOOD_OUTSIDE_SHARE_SPIKE_REVIEW");
	});
});

describe("6B unused-discretionary sweep OPTION (section 20)", () => {
	const sweepCase = (remaining: string, amount: string, overrun?: string) =>
		recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				trueSurplus: "1000.00",
				atn: {
					available: true,
					amount,
					lanes: {
						DISCRETIONARY: { remaining },
						...(overrun ? { INTERNATIONAL_MOBILITY: { overrun } } : {}),
					},
				},
			}),
		]);

	it("V: eligible in a clean SURPLUS_AVAILABLE state", () => {
		const set = sweepCase("300.00", "500.00");
		expect(set.regime.current).toBe("SURPLUS_AVAILABLE");
		expect(kinds(set)).toContain("UNUSED_DISCRETIONARY_SWEEP_REVIEW");
	});

	it("W: suggested review amount = min(discretionary.remaining, available amount) in exact cents", () => {
		expect(
			byKind(sweepCase("300.00", "500.00"), "UNUSED_DISCRETIONARY_SWEEP_REVIEW")
				?.evidence.suggestedReviewAmount,
		).toBe("300.00");
		expect(
			byKind(sweepCase("800.00", "500.00"), "UNUSED_DISCRETIONARY_SWEEP_REVIEW")
				?.evidence.suggestedReviewAmount,
		).toBe("500.00");
	});

	it("X: the sweep never auto-selects a destination", () => {
		const rec = byKind(
			sweepCase("300.00", "500.00"),
			"UNUSED_DISCRETIONARY_SWEEP_REVIEW",
		);
		expect(rec?.proposedAction).toMatchObject({
			autoSelectedDestination: null,
		});
		expect(rec?.evidence.autoSelectedDestination).toBeNull();
	});

	it("Y: the sweep exposes Mobility / Long-Term only as review options", () => {
		const rec = byKind(
			sweepCase("300.00", "500.00"),
			"UNUSED_DISCRETIONARY_SWEEP_REVIEW",
		);
		expect(rec?.proposedAction).toMatchObject({
			action: "REVIEW_UNUSED_DISCRETIONARY_SWEEP",
			allowedReviewDestinations: [
				"INTERNATIONAL_MOBILITY",
				"LONG_TERM_INVESTMENT",
			],
		});
	});

	it("Z: any lane overrun suppresses the sweep", () => {
		const set = sweepCase("300.00", "500.00", "10.00");
		expect(kinds(set)).toContain("LANE_OVERRUN_REVIEW");
		expect(kinds(set)).not.toContain("UNUSED_DISCRETIONARY_SWEEP_REVIEW");
	});
});

describe("6B deterministic priority, max-3 truncation & tie ordering (sections 22-23)", () => {
	// OVERSUBSCRIBED (90) + BASELINE_RESET (80) + 3x LANE_OVERRUN (70) = 5 candidates
	const crowded = () => {
		const prev = snap({
			paymentEventId: "prev",
			checkpointAt: iso(20),
			periodMonth: "2026-11-01",
			atn: { available: true, amount: "0.00" },
		});
		const target = snap({
			paymentEventId: "t",
			checkpointAt: iso(0),
			periodMonth: "2026-12-01",
			trueSurplus: "1000.00",
			atn: {
				available: true,
				amount: "0.00",
				oversubscribedBy: "250.00",
				totalAttributed: "1250.00",
				lanes: {
					INTERNATIONAL_MOBILITY: { overrun: "10.00" },
					LONG_TERM_INVESTMENT: { overrun: "20.00" },
					DISCRETIONARY: { overrun: "30.00" },
				},
			},
		});
		return recsFor("t", [prev, target]);
	};

	it("AA: at most three recommendations are shown; the rest are counted suppressed", () => {
		const set = crowded();
		expect(set.eligibleCandidateCount).toBe(5);
		expect(set.recommendationCount).toBe(3);
		expect(set.recommendations).toHaveLength(3);
		expect(set.suppressedCount).toBe(2);
		expect(set.suppressed).toHaveLength(2);
		expect(
			set.suppressed.every(
				(s) => s.reason === "MAX_ACTIVE_RECOMMENDATIONS_EXCEEDED",
			),
		).toBe(true);
	});

	it("AB: shown recommendations are ordered by priority DESC", () => {
		const p = crowded().recommendations.map((r) => r.priority);
		expect(p).toEqual([...p].sort((a, b) => b - a));
		expect(p).toEqual([90, 80, 70]);
	});

	it("AC: tie ordering is deterministic -- lane order Mobility, Long-Term, Discretionary", () => {
		// isolate three tied lane-overrun candidates
		const set = recsFor("t", [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(0),
				periodMonth: "2026-12-01",
				atn: {
					available: true,
					amount: "0.00",
					lanes: {
						INTERNATIONAL_MOBILITY: { overrun: "10.00" },
						LONG_TERM_INVESTMENT: { overrun: "20.00" },
						DISCRETIONARY: { overrun: "30.00" },
					},
				},
			}),
		]);
		expect(set.recommendations.map((r) => r.scope)).toEqual([
			"INTERNATIONAL_MOBILITY",
			"LONG_TERM_INVESTMENT",
			"DISCRETIONARY",
		]);
		// and in the crowded case the cut lanes keep that order
		const cut = crowded().suppressed.map((s) => s.scope);
		expect(cut).toEqual(["LONG_TERM_INVESTMENT", "DISCRETIONARY"]);
	});
});

describe("6B determinism, IDs & the user-approval-only safety contract (sections 5-6, 24, 26)", () => {
	const snaps = spikeHistory({
		targetBp: 500,
		minusDaysFor: (i) => HIGH_DAYS[i] as number,
		monthsFor: (i) => HIGH_MONTHS[i] as string,
		extraOlder: { minusDays: 95, periodMonth: "2026-09-01" },
	});

	it("AD: the same target + same history -> byte-identical recommendation set", () => {
		const a = recsFor("t", snaps);
		const b = recsFor("t", [...snaps].reverse());
		expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
	});

	it("AE: mutating an unrelated later live figure cannot change the historical set", () => {
		// The generator only reads the (frozen) Behavior Profile: re-running it on
		// a profile assembled from the SAME snapshots is byte-identical regardless
		// of any later, unrelated report content that is not part of the history.
		const p1 = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		const withFuture = [
			...snaps,
			snap({
				paymentEventId: "future",
				checkpointAt: new Date(Date.parse(BASE) + 10 * DAY).toISOString(),
				periodMonth: "2026-12-01",
				discretionarySpend: "9999.00",
			}),
		];
		const p2 = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: withFuture,
		});
		expect(canonicalJsonStringify(generateBudgetV2Recommendations(p1))).toBe(
			canonicalJsonStringify(generateBudgetV2Recommendations(p2)),
		);
	});

	it("AF: recommendation IDs are deterministic composite keys (never random)", () => {
		const a = recsFor("t", snaps).recommendations;
		const b = recsFor("t", [...snaps].reverse()).recommendations;
		expect(a.map((r) => r.recommendationId)).toEqual(
			b.map((r) => r.recommendationId),
		);
		for (const r of a) {
			expect(r.recommendationId).toBe(
				`budget-v2-rec:v1:t:${r.kind}:${r.scope}`,
			);
		}
	});

	it("AG/AH/AI: every recommendation is user-approval-only, non-executing and non-mutating", () => {
		const sets = [
			recsFor("t", snaps),
			crowdedSet(),
			recsFor("t", [
				snap({
					paymentEventId: "t",
					checkpointAt: iso(0),
					periodMonth: "2026-12-01",
					trueSurplus: "1000.00",
					atn: {
						available: true,
						amount: "500.00",
						lanes: { DISCRETIONARY: { remaining: "300.00" } },
					},
				}),
			]),
		];
		for (const set of sets) {
			expect(set.recommendations.length).toBeGreaterThan(0);
			for (const r of set.recommendations) {
				expect(r.requiresUserApproval).toBe(true);
				expect(r.automaticExecution).toBe(false);
				expect(r.mutatesPolicy).toBe(false);
				expect(r.proposedAction.action.startsWith("REVIEW_")).toBe(true);
			}
		}
	});

	it("engineVersion + provenance are pinned to the recommendation engine v1", () => {
		const set = recsFor("t", snaps);
		expect(set.engineVersion).toBe("budget-v2-recommendation-engine-v1");
		expect(set.generatedFrom).toEqual({
			behaviorEngineVersion: "budget-v2-behavior-engine-v1",
			observationContractVersion: "budget-v2-behavior-observation-v1",
		});
	});
});

function crowdedSet() {
	const prev = snap({
		paymentEventId: "prev",
		checkpointAt: iso(20),
		periodMonth: "2026-11-01",
		atn: { available: true, amount: "0.00" },
	});
	const target = snap({
		paymentEventId: "t",
		checkpointAt: iso(0),
		periodMonth: "2026-12-01",
		trueSurplus: "1000.00",
		atn: {
			available: true,
			amount: "0.00",
			oversubscribedBy: "250.00",
			totalAttributed: "1250.00",
			lanes: {
				INTERNATIONAL_MOBILITY: { overrun: "10.00" },
				LONG_TERM_INVESTMENT: { overrun: "20.00" },
				DISCRETIONARY: { overrun: "30.00" },
			},
		},
	});
	return recsFor("t", [prev, target]);
}
