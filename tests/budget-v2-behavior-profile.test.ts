import { describe, expect, it } from "vitest";
import {
	assembleBudgetV2BehaviorProfile,
	type BehaviorSnapshotInput,
	classifyBehaviorObservationCompatibility,
	deriveContextRegime,
	normalizeBehaviorFeatures,
} from "../src/budget/behavior-profile-v2";
import { canonicalJsonStringify } from "../src/budget/checkpoint-canonical-v2";
import {
	type BudgetV2CheckpointReport,
	extractBehaviorEngineCheckpointObservation,
} from "../src/budget/checkpoint-report-v2";
import { BudgetError } from "../src/budget/errors";

/**
 * Checkpoint 6A -- deterministic Behavior Engine foundation. These pure vitest
 * cases pin the normalized basis-point math, nearest-rank robust summaries,
 * calendar-day windows, cold-start confidence, deterministic context regime,
 * observation-contract compatibility (never coerced to zero) and profile
 * determinism. The persisted-snapshot end-to-end proofs (snapshots-only input,
 * live-mutation immunity, corrupt-fingerprint fail-closed) live in
 * `scripts/pg-runtime-verify.ts` Phase 6A.
 */

interface ReportKnobs {
	paymentEventId: string;
	checkpointAt: string;
	periodMonth: string;
	realizedIncome?: string;
	currentObligations?: string;
	basicLivingFunding?: string;
	actualPersonalMandatorySpendMTD?: string;
	deficit?: string;
	emergencyCatchUp?: string;
	trueSurplus?: string;
	emergencyCurrentBalance?: string;
	emergencyTarget?: string;
	emergencyGap?: string;
	mobilityCurrentTotal?: string;
	personalCardSpendMTD?: string;
	mandatorySpend?: string;
	discretionarySpend?: string;
	shortTermSpend?: string;
	food?: { total: string; outside: string; home: string } | null;
	atn?:
		| {
				available: true;
				amount: string;
				trueSurplus: string;
				oversubscribedBy: string;
				totalAttributed: string;
				lanes: {
					mobility: { planned: string; used: string };
					longTerm: { planned: string; used: string };
					discretionary: { planned: string; used: string };
				};
		  }
		| { available: false; reason: string };
}

function mkReport(k: ReportKnobs): BudgetV2CheckpointReport {
	const atn = k.atn ?? {
		available: true as const,
		amount: "1000.00",
		trueSurplus: "1000.00",
		oversubscribedBy: "0.00",
		totalAttributed: "0.00",
		lanes: {
			mobility: { planned: "0.00", used: "0.00" },
			longTerm: { planned: "0.00", used: "0.00" },
			discretionary: { planned: "1000.00", used: "0.00" },
		},
	};
	const availableToAllocateNow = atn.available
		? {
				available: true,
				amount: atn.amount,
				trueSurplus: atn.trueSurplus,
				totalAttributedCurrentSurplusUse: atn.totalAttributed,
				oversubscribedBy: atn.oversubscribedBy,
				lanes: {
					INTERNATIONAL_MOBILITY: {
						planned: atn.lanes.mobility.planned,
						used: atn.lanes.mobility.used,
						remaining: "0.00",
						overrun: "0.00",
					},
					LONG_TERM_INVESTMENT: {
						planned: atn.lanes.longTerm.planned,
						used: atn.lanes.longTerm.used,
						remaining: "0.00",
						overrun: "0.00",
					},
					DISCRETIONARY: {
						planned: atn.lanes.discretionary.planned,
						used: atn.lanes.discretionary.used,
						remaining: "0.00",
						overrun: "0.00",
					},
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
				reason: atn.reason,
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
					MANDATORY_EXPENSE: k.mandatorySpend ?? "0.00",
					DISCRETIONARY_SPEND: k.discretionarySpend ?? "0.00",
					SHORT_TERM_PURCHASE: k.shortTermSpend ?? "0.00",
					UNCLASSIFIED: "0.00",
				},
				grossCardPurchasesMTD: "0.00",
				personalCardSpendMTD: k.personalCardSpendMTD ?? "0.00",
				externalCardSpendMTD: "0.00",
				externalCardSpendByRelationship: {
					FAMILY: "0.00",
					FRIEND: "0.00",
					OTHER: "0.00",
				},
			},
			budget: {
				inputs: {
					realizedIncome: k.realizedIncome ?? "20000.00",
					currentObligations: k.currentObligations ?? "0.00",
					basicLivingFunding: k.basicLivingFunding ?? "0.00",
					dateBoundNecessaryPurchaseFunding: "0.00",
					coreEmergencyFundBalance: k.emergencyCurrentBalance ?? "0.00",
					mobilityBalance: k.mobilityCurrentTotal ?? "0.00",
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
					actualPersonalMandatorySpendMTD:
						k.actualPersonalMandatorySpendMTD ?? "0.00",
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
			mobility: { currentTotal: k.mobilityCurrentTotal ?? "0.00", perGoal: [] },
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
			k.food === null
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
						foodHomeMarket: k.food?.home ?? "0.00",
						foodOutside: k.food?.outside ?? "0.00",
						foodTotal: k.food?.total ?? "0.00",
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
function iso(base: string, minusDays: number): string {
	return new Date(Date.parse(base) - minusDays * DAY).toISOString();
}

// ---------------------------------------------------------------------------

describe("normalizeBehaviorFeatures -- exact integer basis points (section 6)", () => {
	it("F: computes ratios with integer math and preserves genuine zero", () => {
		const obs = extractBehaviorEngineCheckpointObservation(
			mkReport({
				paymentEventId: "pe-1",
				checkpointAt: "2026-09-15T00:00:00.000Z",
				periodMonth: "2026-09-01",
				realizedIncome: "20000.00",
				currentObligations: "5000.00",
				basicLivingFunding: "6000.00",
				trueSurplus: "9000.00",
				discretionarySpend: "0.00",
				emergencyCurrentBalance: "2500.00",
				emergencyTarget: "10000.00",
			}),
		);
		const f = normalizeBehaviorFeatures(obs);
		expect(f.obligationLoadBp).toEqual({ available: true, valueBp: 2500 });
		expect(f.basicLivingLoadBp).toEqual({ available: true, valueBp: 3000 });
		expect(f.trueSurplusRateBp).toEqual({ available: true, valueBp: 4500 });
		// genuine zero numerator over a positive denominator stays an available 0
		expect(f.discretionarySpendIncomeBp).toEqual({
			available: true,
			valueBp: 0,
		});
		expect(f.emergencyCoverageBp).toEqual({ available: true, valueBp: 2500 });
	});

	it("G: zero denominator is unavailable (never Infinity / NaN / inferred 0)", () => {
		const obs = extractBehaviorEngineCheckpointObservation(
			mkReport({
				paymentEventId: "pe-1",
				checkpointAt: "2026-09-15T00:00:00.000Z",
				periodMonth: "2026-09-01",
				realizedIncome: "0.00",
				currentObligations: "5000.00",
				emergencyTarget: "0.00",
				emergencyCurrentBalance: "1000.00",
			}),
		);
		const f = normalizeBehaviorFeatures(obs);
		expect(f.obligationLoadBp).toEqual({
			available: false,
			reason: "ZERO_DENOMINATOR",
		});
		expect(f.emergencyCoverageBp).toEqual({
			available: false,
			reason: "ZERO_DENOMINATOR",
		});
		for (const v of Object.values(f)) {
			if (v.available) {
				expect(Number.isFinite(v.valueBp)).toBe(true);
				expect(Number.isNaN(v.valueBp)).toBe(false);
			}
		}
	});

	it("availableSurplusRate / lane utilization are NOT_AUTHORITATIVE when availableToAllocateNow is unavailable", () => {
		const obs = extractBehaviorEngineCheckpointObservation(
			mkReport({
				paymentEventId: "pe-1",
				checkpointAt: "2026-09-15T00:00:00.000Z",
				periodMonth: "2026-09-01",
				atn: {
					available: false,
					reason: "SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED",
				},
			}),
		);
		const f = normalizeBehaviorFeatures(obs);
		expect(f.availableSurplusRateBp).toEqual({
			available: false,
			reason: "NOT_AUTHORITATIVE",
		});
		expect(f.laneUtilizationDiscretionaryBp).toEqual({
			available: false,
			reason: "NOT_AUTHORITATIVE",
		});
	});

	it("foodOutsideShare is unavailable when foodAnalytics is not authoritative, and exact when it is", () => {
		const unavailable = normalizeBehaviorFeatures(
			extractBehaviorEngineCheckpointObservation(
				mkReport({
					paymentEventId: "pe-1",
					checkpointAt: "2026-09-15T00:00:00.000Z",
					periodMonth: "2026-09-01",
					food: null,
				}),
			),
		);
		expect(unavailable.foodOutsideShareBp).toEqual({
			available: false,
			reason: "SOURCE_UNAVAILABLE",
		});
		const exact = normalizeBehaviorFeatures(
			extractBehaviorEngineCheckpointObservation(
				mkReport({
					paymentEventId: "pe-1",
					checkpointAt: "2026-09-15T00:00:00.000Z",
					periodMonth: "2026-09-01",
					food: { total: "800.00", outside: "600.00", home: "200.00" },
				}),
			),
		);
		expect(exact.foodOutsideShareBp).toEqual({
			available: true,
			valueBp: 7500,
		});
	});
});

describe("robust window summaries (sections 7-8)", () => {
	const base = "2026-12-01T00:00:00.000Z";
	// discretionarySpendIncomeBp is deterministic from realizedIncome + discretionarySpend
	function e(id: string, minusDays: number, discretionarySpend: string) {
		return snap({
			paymentEventId: id,
			checkpointAt: iso(base, minusDays),
			periodMonth: `2026-${String(12 - Math.floor(minusDays / 30)).padStart(2, "0")}-01`,
			realizedIncome: "10000.00",
			discretionarySpend,
		});
	}

	it("K/L: deterministic nearest-rank median and MAD over the 90-day window", () => {
		// discretionary spend 100,200,300,400,500 over 10000 income -> bp 100..500
		const snaps = [
			e("t", 0, "300.00"),
			e("a", 10, "100.00"),
			e("b", 20, "500.00"),
			e("c", 30, "200.00"),
			e("d", 40, "400.00"),
		];
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		const s = p.windows.DAYS_90.features.discretionarySpendIncomeBp;
		expect(s.validCount).toBe(5);
		expect(s.windowObservationCount).toBe(5);
		// sorted [100,200,300,400,500]; rank = ceil(0.5*5) = 3 -> 300
		expect(s.median).toBe(300);
		// p25 = ceil(0.25*5)=2 -> 200 ; p75 = ceil(0.75*5)=4 -> 400
		expect(s.p25).toBe(200);
		expect(s.p75).toBe(400);
		// deviations from 300: [200,100,200,100,0] sorted [0,100,100,200,200]; median rank 3 -> 100
		expect(s.mad).toBe(100);
		expect(s.current).toBe(300);
	});

	it("H/I/J: windows are calendar-day bounded relative to the target checkpointAt", () => {
		const snaps = [
			e("t", 0, "300.00"),
			e("in30", 30, "100.00"), // exactly 30 days -> inside DAYS_30
			e("in60", 45, "100.00"), // outside DAYS_30, inside DAYS_60
			e("in90", 75, "100.00"), // outside DAYS_60, inside DAYS_90
			e("old", 120, "100.00"), // outside every window
		];
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		expect(p.windows.DAYS_30.observationCount).toBe(2); // t + in30
		expect(p.windows.DAYS_60.observationCount).toBe(3); // + in60
		expect(p.windows.DAYS_90.observationCount).toBe(4); // + in90
		expect(
			p.windows.DAYS_30.features.discretionarySpendIncomeBp.validCount,
		).toBe(2);
	});

	it("M: an unavailable feature observation is excluded from that feature's stats and counted missing", () => {
		// 3 checkpoints; food authoritative in only 2
		const snaps = [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(base, 0),
				periodMonth: "2026-12-01",
				food: { total: "1000.00", outside: "400.00", home: "600.00" },
			}),
			snap({
				paymentEventId: "a",
				checkpointAt: iso(base, 10),
				periodMonth: "2026-11-01",
				food: { total: "1000.00", outside: "600.00", home: "400.00" },
			}),
			snap({
				paymentEventId: "b",
				checkpointAt: iso(base, 20),
				periodMonth: "2026-11-01",
				food: null,
			}),
		];
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		const s = p.windows.DAYS_30.features.foodOutsideShareBp;
		expect(s.windowObservationCount).toBe(3);
		expect(s.validCount).toBe(2);
		expect(s.missingCount).toBe(1);
		// values [4000, 6000]; nearest-rank median rank ceil(0.5*2)=1 -> 4000
		expect(s.median).toBe(4000);
		expect(s.coverageReasons).toContain("SOURCE_UNAVAILABLE");
		expect(p.dataQuality.featureCoverageAllHistory.foodOutsideShareBp).toEqual({
			validCount: 2,
			missingCount: 1,
		});
	});
});

describe("cold-start confidence (section 9)", () => {
	const base = "2026-12-01T00:00:00.000Z";
	function span(count: number, spanDays: number, monthsDistinct: number) {
		const snaps: BehaviorSnapshotInput[] = [];
		for (let i = 0; i < count; i++) {
			const minus = i === 0 ? 0 : Math.round((spanDays * i) / (count - 1));
			snaps.push(
				snap({
					paymentEventId: i === 0 ? "t" : `h${i}`,
					checkpointAt: iso(base, minus),
					periodMonth: `2026-${String(12 - (i % monthsDistinct)).padStart(2, "0")}-01`,
				}),
			);
		}
		return assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
	}

	it("N: history span < 60 days -> LOW", () => {
		expect(span(5, 40, 2).confidence.level).toBe("LOW");
	});

	it("O: >= 60 days and >= 4 checkpoints -> at least MEDIUM", () => {
		const c = span(4, 65, 2).confidence;
		expect(["MEDIUM", "HIGH"]).toContain(c.level);
		expect(c.level).toBe("MEDIUM");
	});

	it("P: >= 90 days + >= 6 checkpoints + >= 3 distinct periodMonths -> HIGH", () => {
		const c = span(6, 95, 3).confidence;
		expect(c.level).toBe("HIGH");
		expect(c.historySpanDays).toBeGreaterThanOrEqual(90);
		expect(c.compatibleCheckpointCount).toBeGreaterThanOrEqual(6);
		expect(c.distinctPeriodMonthCount).toBeGreaterThanOrEqual(3);
	});

	it("Q: many same-month checkpoints do NOT reach HIGH without 3 distinct months", () => {
		const c = span(8, 100, 2).confidence; // 8 checkpoints, 100d span, only 2 months
		expect(c.level).toBe("MEDIUM");
		expect(c.reasons.join(" ")).toContain("distinct periodMonths");
	});
});

describe("deterministic context regime (section 10)", () => {
	const at = "2026-09-15T00:00:00.000Z";
	const obsOf = (k: Partial<ReportKnobs>) =>
		extractBehaviorEngineCheckpointObservation(
			mkReport({
				paymentEventId: "pe-1",
				checkpointAt: at,
				periodMonth: "2026-09-01",
				...k,
			}),
		);

	it("R: availableToAllocateNow unavailable -> DATA_INCOMPLETE", () => {
		expect(
			deriveContextRegime(
				obsOf({
					atn: {
						available: false,
						reason: "SURPLUS_USE_ATTRIBUTION_INCOMPLETE",
					},
				}),
			),
		).toBe("DATA_INCOMPLETE");
	});

	it("S: deficit > 0 -> DEFICIT", () => {
		expect(
			deriveContextRegime(obsOf({ deficit: "500.00", trueSurplus: "0.00" })),
		).toBe("DEFICIT");
	});

	it("T: oversubscribedBy > 0 -> OVERSUBSCRIBED", () => {
		expect(
			deriveContextRegime(
				obsOf({
					atn: {
						available: true,
						amount: "0.00",
						trueSurplus: "1000.00",
						oversubscribedBy: "250.00",
						totalAttributed: "1250.00",
						lanes: {
							mobility: { planned: "0.00", used: "0.00" },
							longTerm: { planned: "0.00", used: "0.00" },
							discretionary: { planned: "1000.00", used: "1250.00" },
						},
					},
				}),
			),
		).toBe("OVERSUBSCRIBED");
	});

	it("U: emergency catch-up / gap active -> EMERGENCY_REBUILD", () => {
		expect(
			deriveContextRegime(
				obsOf({ emergencyCatchUp: "300.00", emergencyGap: "300.00" }),
			),
		).toBe("EMERGENCY_REBUILD");
	});

	it("V: authoritative available amount > 0 -> SURPLUS_AVAILABLE", () => {
		expect(
			deriveContextRegime(
				obsOf({
					atn: {
						available: true,
						amount: "900.00",
						trueSurplus: "1000.00",
						oversubscribedBy: "0.00",
						totalAttributed: "100.00",
						lanes: {
							mobility: { planned: "0.00", used: "0.00" },
							longTerm: { planned: "0.00", used: "0.00" },
							discretionary: { planned: "1000.00", used: "100.00" },
						},
					},
				}),
			),
		).toBe("SURPLUS_AVAILABLE");
	});

	it("W: authoritative available amount == 0 -> SURPLUS_FULLY_USED", () => {
		expect(
			deriveContextRegime(
				obsOf({
					atn: {
						available: true,
						amount: "0.00",
						trueSurplus: "1000.00",
						oversubscribedBy: "0.00",
						totalAttributed: "1000.00",
						lanes: {
							mobility: { planned: "0.00", used: "0.00" },
							longTerm: { planned: "0.00", used: "0.00" },
							discretionary: { planned: "1000.00", used: "1000.00" },
						},
					},
				}),
			),
		).toBe("SURPLUS_FULLY_USED");
	});
});

describe("regime-change / reset-review (section 11)", () => {
	const base = "2026-12-01T00:00:00.000Z";
	it("X/Y: a regime transition is detected and only SUGGESTS review -- history is untouched", () => {
		const previous = snap({
			paymentEventId: "prev",
			checkpointAt: iso(base, 20),
			periodMonth: "2026-11-01",
			deficit: "400.00",
			trueSurplus: "0.00",
		});
		const target = snap({
			paymentEventId: "t",
			checkpointAt: iso(base, 0),
			periodMonth: "2026-12-01",
			atn: {
				available: true,
				amount: "800.00",
				trueSurplus: "1000.00",
				oversubscribedBy: "0.00",
				totalAttributed: "200.00",
				lanes: {
					mobility: { planned: "0.00", used: "0.00" },
					longTerm: { planned: "0.00", used: "0.00" },
					discretionary: { planned: "1000.00", used: "200.00" },
				},
			},
		});
		const snaps = [previous, target];
		const before = JSON.parse(JSON.stringify(snaps));
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		expect(p.regime.previous).toBe("DEFICIT");
		expect(p.regime.current).toBe("SURPLUS_AVAILABLE");
		expect(p.regime.changed).toBe(true);
		expect(p.regime.baselineResetReviewSuggested).toBe(true);
		expect(p.regime.reason).toContain("review");
		// history is never reset / deleted
		expect(p.dataQuality.compatibleSnapshotCount).toBe(2);
		expect(snaps).toEqual(before);
	});

	it("no previous compatible checkpoint -> not changed, no reset review", () => {
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: [
				snap({
					paymentEventId: "t",
					checkpointAt: iso(base, 0),
					periodMonth: "2026-12-01",
				}),
			],
		});
		expect(p.regime.previous).toBeNull();
		expect(p.regime.changed).toBe(false);
		expect(p.regime.baselineResetReviewSuggested).toBe(false);
	});
});

describe("observation contract compatibility (section 4)", () => {
	it("a current full report is compatible", () => {
		expect(
			classifyBehaviorObservationCompatibility(
				mkReport({
					paymentEventId: "pe-1",
					checkpointAt: "2026-09-15T00:00:00.000Z",
					periodMonth: "2026-09-01",
				}),
			),
		).toEqual({ compatible: true });
	});

	it("E: an incompatible snapshot is classified with a reason and never coerced to zero", () => {
		const good = snap({
			paymentEventId: "t",
			checkpointAt: "2026-12-01T00:00:00.000Z",
			periodMonth: "2026-12-01",
			realizedIncome: "10000.00",
			currentObligations: "2000.00",
		});
		const goodB = snap({
			paymentEventId: "b",
			checkpointAt: "2026-11-25T00:00:00.000Z",
			periodMonth: "2026-11-01",
			realizedIncome: "10000.00",
			currentObligations: "4000.00",
		});
		// strip a required money field -> incompatible
		const bad = snap({
			paymentEventId: "c",
			checkpointAt: "2026-11-20T00:00:00.000Z",
			periodMonth: "2026-11-01",
		});
		// biome-ignore lint/suspicious/noExplicitAny: deliberate corruption
		delete (bad.report as any).mtd.budget.inputs.realizedIncome;

		const verdict = classifyBehaviorObservationCompatibility(bad.report);
		expect(verdict.compatible).toBe(false);
		if (!verdict.compatible) {
			expect(verdict.reason).toBe(
				"MISSING_OR_INVALID:mtd.budget.inputs.realizedIncome",
			);
		}

		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: [good, goodB, bad],
		});
		expect(p.dataQuality.compatibleSnapshotCount).toBe(2);
		expect(p.dataQuality.incompatibleSnapshotCount).toBe(1);
		expect(p.dataQuality.incompatibleSnapshots[0]?.paymentEventId).toBe("c");
		// the incompatible row does not contribute a phantom zero to obligationLoad
		const s = p.windows.DAYS_30.features.obligationLoadBp;
		expect(s.validCount).toBe(2);
		// window values [2000, 4000]; nearest-rank median rank ceil(0.5*2)=1 -> 2000
		expect(s.median).toBe(2000);
	});
});

describe("assembleBudgetV2BehaviorProfile -- guards & determinism", () => {
	const base = "2026-12-01T00:00:00.000Z";

	it("C: future snapshots are excluded from a target-anchored profile", () => {
		const snaps = [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(base, 0),
				periodMonth: "2026-12-01",
			}),
			snap({
				paymentEventId: "past",
				checkpointAt: iso(base, 15),
				periodMonth: "2026-11-01",
			}),
			snap({
				paymentEventId: "future",
				checkpointAt: new Date(Date.parse(base) + 5 * DAY).toISOString(),
				periodMonth: "2026-12-01",
			}),
		];
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		expect(p.dataQuality.compatibleSnapshotCount).toBe(2);
		expect(p.windows.DAYS_90.observationCount).toBe(2);
	});

	it("Z: same target + same snapshot set -> byte-identical profile", () => {
		const snaps = [
			snap({
				paymentEventId: "t",
				checkpointAt: iso(base, 0),
				periodMonth: "2026-12-01",
				currentObligations: "3000.00",
				realizedIncome: "10000.00",
			}),
			snap({
				paymentEventId: "a",
				checkpointAt: iso(base, 20),
				periodMonth: "2026-11-01",
				currentObligations: "5000.00",
				realizedIncome: "10000.00",
			}),
		];
		const a = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: snaps,
		});
		const b = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: [...snaps].reverse(),
		});
		expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
	});

	it("fails closed when the target payment event has no persisted snapshot", () => {
		expect(() =>
			assembleBudgetV2BehaviorProfile({
				throughPaymentEventId: "missing",
				snapshots: [
					snap({
						paymentEventId: "t",
						checkpointAt: iso(base, 0),
						periodMonth: "2026-12-01",
					}),
				],
			}),
		).toThrow(BudgetError);
	});

	it("fails closed on two distinct payment events sharing the exact checkpointAt", () => {
		const same = iso(base, 0);
		expect(() =>
			assembleBudgetV2BehaviorProfile({
				throughPaymentEventId: "t",
				snapshots: [
					snap({
						paymentEventId: "t",
						checkpointAt: same,
						periodMonth: "2026-12-01",
					}),
					snap({
						paymentEventId: "other",
						checkpointAt: same,
						periodMonth: "2026-12-01",
					}),
				],
			}),
		).toThrow(/exact checkpointAt/);
	});
});

describe("Checkpoint 6A.1 -- basis-point safe-integer exactness closure", () => {
	// currentObligations cents / realizedIncome cents; with realizedIncome
	// "100.00" (10_000 cents) the exact bp quotient == currentObligations cents.
	const MAX = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
	const centsToMoney = (cents: bigint) => {
		const s = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
		return `${cents < 0n ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
	};
	const obligationLoadOf = (
		currentObligations: string,
		realizedIncome = "100.00",
	) =>
		normalizeBehaviorFeatures(
			extractBehaviorEngineCheckpointObservation(
				mkReport({
					paymentEventId: "pe-1",
					checkpointAt: "2026-09-15T00:00:00.000Z",
					periodMonth: "2026-09-01",
					realizedIncome,
					currentObligations,
				}),
			),
		).obligationLoadBp;

	it("A: a normal ratio still produces the same exact bp result", () => {
		expect(obligationLoadOf("50.00", "100.00")).toEqual({
			available: true,
			valueBp: 5000,
		});
	});

	it("B: exact quotient == Number.MAX_SAFE_INTEGER -> available, exact safe integer", () => {
		const f = obligationLoadOf(centsToMoney(BigInt(MAX))); // 90071992547409.91
		expect(f).toEqual({ available: true, valueBp: MAX });
		if (f.available) expect(Number.isSafeInteger(f.valueBp)).toBe(true);
	});

	it("C: exact quotient == MAX_SAFE_INTEGER + 1 -> unavailable OUT_OF_SAFE_INTEGER_RANGE", () => {
		expect(obligationLoadOf(centsToMoney(BigInt(MAX) + 1n))).toEqual({
			available: false,
			reason: "OUT_OF_SAFE_INTEGER_RANGE",
		});
	});

	it("D: no Number conversion is published before the range decision (result carries no valueBp)", () => {
		// MAX+2 would silently round to MAX+1 under a premature Number() cast.
		const f = obligationLoadOf(centsToMoney(BigInt(MAX) + 2n));
		expect(f.available).toBe(false);
		expect("valueBp" in f).toBe(false);
		if (!f.available) expect(f.reason).toBe("OUT_OF_SAFE_INTEGER_RANGE");
	});

	it("G: genuine zero over a positive denominator remains available 0", () => {
		expect(obligationLoadOf("0.00", "100.00")).toEqual({
			available: true,
			valueBp: 0,
		});
	});

	it("H: zero denominator remains ZERO_DENOMINATOR", () => {
		expect(obligationLoadOf("50.00", "0.00")).toEqual({
			available: false,
			reason: "ZERO_DENOMINATOR",
		});
	});

	it("E/F: an out-of-range observation is excluded from median/MAD, counted missing, and named in coverageReasons", () => {
		const at0 = "2026-12-01T00:00:00.000Z";
		const mk = (id: string, minusDays: number, currentObligations: string) =>
			snap({
				paymentEventId: id,
				checkpointAt: iso(at0, minusDays),
				periodMonth: "2026-12-01",
				realizedIncome: "100.00",
				currentObligations,
			});
		const p = assembleBudgetV2BehaviorProfile({
			throughPaymentEventId: "t",
			snapshots: [
				mk("t", 0, "20.00"), // 2000 bp
				mk("a", 5, "40.00"), // 4000 bp
				mk("b", 10, centsToMoney(BigInt(MAX) + 1n)), // out of range
			],
		});
		const s = p.windows.DAYS_30.features.obligationLoadBp;
		expect(s.windowObservationCount).toBe(3);
		expect(s.validCount).toBe(2);
		expect(s.missingCount).toBe(1);
		// only [2000, 4000] contribute; nearest-rank median rank ceil(0.5*2)=1 -> 2000
		expect(s.median).toBe(2000);
		expect(s.mad).toBe(0); // |2000-2000|, |4000-2000| -> [0,2000] -> rank 1 -> 0
		expect(s.coverageReasons).toContain("OUT_OF_SAFE_INTEGER_RANGE");
		// the checkpoint itself stays compatible -- only the derived feature is unavailable
		expect(p.dataQuality.compatibleSnapshotCount).toBe(3);
		expect(p.dataQuality.incompatibleSnapshotCount).toBe(0);
		expect(p.dataQuality.featureCoverageAllHistory.obligationLoadBp).toEqual({
			validCount: 2,
			missingCount: 1,
		});
	});

	it("I: no available normalized feature is ever NaN / Infinity / a non-safe-integer", () => {
		const feats = normalizeBehaviorFeatures(
			extractBehaviorEngineCheckpointObservation(
				mkReport({
					paymentEventId: "pe-1",
					checkpointAt: "2026-09-15T00:00:00.000Z",
					periodMonth: "2026-09-01",
					realizedIncome: "100.00",
					currentObligations: centsToMoney(BigInt(MAX) + 5n),
					basicLivingFunding: "30.00",
					trueSurplus: "70.00",
					discretionarySpend: "10.00",
					emergencyCurrentBalance: "5.00",
					emergencyTarget: "20.00",
					food: { total: "800.00", outside: "600.00", home: "200.00" },
				}),
			),
		);
		for (const f of Object.values(feats)) {
			if (f.available) {
				expect(Number.isNaN(f.valueBp)).toBe(false);
				expect(Number.isFinite(f.valueBp)).toBe(true);
				expect(Number.isSafeInteger(f.valueBp)).toBe(true);
			}
		}
		// the deliberately huge ratio is the unavailable one
		expect(feats.obligationLoadBp).toEqual({
			available: false,
			reason: "OUT_OF_SAFE_INTEGER_RANGE",
		});
	});
});
