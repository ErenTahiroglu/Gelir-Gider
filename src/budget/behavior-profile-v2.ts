import { and, asc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { budgetV2CheckpointSnapshots } from "../db/schema/budget-v2-checkpoint";
import { parseAggregateMoneyString } from "../ledger/money";
import { verifyStoredCheckpointSnapshot } from "./checkpoint-canonical-v2";
import {
	type BehaviorEngineCheckpointObservation,
	BUDGET_V2_BEHAVIOR_OBSERVATION_CONTRACT_VERSION,
	type BudgetV2CheckpointReport,
	extractBehaviorEngineCheckpointObservation,
	type SurplusUseLaneName,
} from "./checkpoint-report-v2";
import { BudgetError } from "./errors";
import { normalizeUuid } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- BEHAVIOR ENGINE FOUNDATION (Checkpoint 6A).
 *
 * WHAT THIS IS NOT. The Behavior Engine does NOT watch a bank account and guess
 * a personality, and it produces NO recommendations. It turns the IMMUTABLE
 * persisted Budget V2 checkpoint history into a deterministic, descriptive
 * behavior profile: normalized ratios, robust trailing-window summaries, a
 * transparent cold-start confidence label, and a bounded deterministic
 * financial-context regime label. Every future recommendation stays
 * deterministic, bounded and user-approved; this layer is descriptive evidence
 * only and never modifies financial policy.
 *
 * AUTHORITATIVE INPUT -- PERSISTED CHECKPOINTS ONLY. Historical truth is
 * `budget_v2_checkpoint_snapshots.report_json` AFTER
 * `verifyStoredCheckpointSnapshot(...)`, projected through the ONE pure
 * boundary `extractBehaviorEngineCheckpointObservation(report)`. This module
 * never calls `resolveBudgetV2LiveSnapshot(...)`, never reads current database
 * state / classifications / Midas balances / relationships, and never rebuilds
 * an old checkpoint report. A historical checkpoint is frozen truth.
 *
 * TARGET-ANCHORED. `buildBudgetV2BehaviorProfile({ db, userId,
 * throughPaymentEventId })` requires that the target payment event has a
 * SUCCESSFULLY PERSISTED checkpoint and then loads only that user's successful
 * snapshots with `checkpointAt <= target.checkpointAt` (never a future
 * checkpoint). The result is deterministic for a given target.
 *
 * VERIFY EVERY SNAPSHOT. `buildBudgetV2BehaviorProfile` runs
 * `verifyStoredCheckpointSnapshot` on every row it touches; a corrupt row fails
 * the whole profile closed (`BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT`) -- it is
 * never silently dropped so history "looks" complete.
 *
 * OBSERVATION CONTRACT VERSION. `BUDGET_V2_BEHAVIOR_OBSERVATION_CONTRACT_VERSION`
 * is SEPARATE from the checkpoint report schemaVersion. A snapshot whose frozen
 * report predates a later additive report phase can share the report
 * schemaVersion yet lack a field this contract needs. Such a snapshot is
 * classified INCOMPATIBLE (with a reason) and excluded from feature statistics
 * -- a missing field is NEVER filled with `0`, and the stored report is NEVER
 * rewritten.
 *
 * NO DUPLICATE FINANCIAL MATH. trueSurplus, availableToAllocateNow, food
 * totals, currentObligations overlap, Mobility / Long-Term / discretionary
 * allocation all come verbatim from the persisted report. This module only
 * normalizes, compares, summarizes history and labels deterministic context.
 *
 * NO NEW PERSISTENCE. Derived behavior profiles recompute deterministically
 * from the immutable snapshots; there is no Behavior Engine table.
 */

export const BUDGET_V2_BEHAVIOR_ENGINE_VERSION = "budget-v2-behavior-engine-v1";

// ============================================================================
// Exact integer basis-point normalization (section 6)
// ============================================================================

export const BEHAVIOR_FEATURE_NAMES = [
	"obligationLoadBp",
	"basicLivingLoadBp",
	"trueSurplusRateBp",
	"discretionarySpendIncomeBp",
	"availableSurplusRateBp",
	"emergencyCoverageBp",
	"laneUtilizationMobilityBp",
	"laneUtilizationLongTermBp",
	"laneUtilizationDiscretionaryBp",
	"foodOutsideShareBp",
] as const;

export type BehaviorFeatureName = (typeof BEHAVIOR_FEATURE_NAMES)[number];

export type NormalizedFeatureUnavailableReason =
	| "ZERO_DENOMINATOR"
	| "SOURCE_UNAVAILABLE"
	| "NOT_AUTHORITATIVE"
	/**
	 * The authoritative ratio exists mathematically, but its exact integer
	 * basis-point quotient falls outside JavaScript's safe-integer range and so
	 * cannot be represented exactly by this Behavior Engine numeric output
	 * contract. It is NEVER clamped, rounded, approximated, turned into
	 * Infinity, or silently zeroed -- the derived feature is simply unavailable
	 * for this observation (feature-level, like ZERO_DENOMINATOR; the checkpoint
	 * stays compatible and every raw authoritative field is unchanged).
	 */
	| "OUT_OF_SAFE_INTEGER_RANGE";

export type NormalizedFeature =
	| { available: true; valueBp: number }
	| { available: false; reason: NormalizedFeatureUnavailableReason };

const BP_SCALE = 10_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function centsOrNull(v: string | null | undefined): bigint | null {
	if (typeof v !== "string") return null;
	try {
		return parseAggregateMoneyString(v).cents;
	} catch {
		return null;
	}
}

/**
 * Exact basis-point ratio using integer (BigInt) math only -- never
 * floating-point. Truncates toward zero (BigInt `/`). A missing source is
 * `SOURCE_UNAVAILABLE`; a non-positive denominator is `ZERO_DENOMINATOR`
 * (never `Infinity` / `NaN` / an inferred `0`). A genuine `0` numerator over a
 * positive denominator is a real available `0`.
 *
 * The exact quotient is computed AND range-checked as a BigInt BEFORE any
 * `Number(...)` conversion: if it exceeds JavaScript's safe-integer range the
 * feature is `OUT_OF_SAFE_INTEGER_RANGE` -- the contract is "exact integer
 * basis points" over the full accepted money domain, so an inexact float is
 * never published. Every `available: true` result is therefore a
 * `Number.isSafeInteger` value.
 */
function divBp(num: bigint | null, den: bigint | null): NormalizedFeature {
	if (num === null || den === null) {
		return { available: false, reason: "SOURCE_UNAVAILABLE" };
	}
	if (den <= 0n) return { available: false, reason: "ZERO_DENOMINATOR" };
	const exactBp = (num * BP_SCALE) / den;
	if (exactBp > MAX_SAFE || exactBp < MIN_SAFE) {
		return { available: false, reason: "OUT_OF_SAFE_INTEGER_RANGE" };
	}
	const valueBp = Number(exactBp);
	if (!Number.isSafeInteger(valueBp)) {
		return { available: false, reason: "OUT_OF_SAFE_INTEGER_RANGE" };
	}
	return { available: true, valueBp };
}

/**
 * The deterministic normalized feature vector for ONE compatible observation.
 * Every ratio is exact integer basis points; availability / reason is exposed
 * separately from the value.
 */
export function normalizeBehaviorFeatures(
	obs: BehaviorEngineCheckpointObservation,
): Record<BehaviorFeatureName, NormalizedFeature> {
	const income = centsOrNull(obs.budget.realizedIncome);
	const atn = obs.availableToAllocateNow;
	const notAuthoritative: NormalizedFeature = {
		available: false,
		reason: "NOT_AUTHORITATIVE",
	};

	const laneUtil = (lane: SurplusUseLaneName): NormalizedFeature => {
		if (!atn.available) return notAuthoritative;
		const l = atn.lanes[lane];
		return divBp(centsOrNull(l.used), centsOrNull(l.planned));
	};

	return {
		obligationLoadBp: divBp(centsOrNull(obs.budget.currentObligations), income),
		basicLivingLoadBp: divBp(
			centsOrNull(obs.budget.basicLivingFunding),
			income,
		),
		trueSurplusRateBp: divBp(centsOrNull(obs.budget.trueSurplus), income),
		discretionarySpendIncomeBp: divBp(
			centsOrNull(obs.spending.discretionarySpendPersonalSpend),
			income,
		),
		availableSurplusRateBp: atn.available
			? divBp(centsOrNull(atn.amount), centsOrNull(atn.trueSurplus))
			: notAuthoritative,
		emergencyCoverageBp: divBp(
			centsOrNull(obs.emergency.currentBalance),
			centsOrNull(obs.emergency.target),
		),
		laneUtilizationMobilityBp: laneUtil("INTERNATIONAL_MOBILITY"),
		laneUtilizationLongTermBp: laneUtil("LONG_TERM_INVESTMENT"),
		laneUtilizationDiscretionaryBp: laneUtil("DISCRETIONARY"),
		foodOutsideShareBp: obs.food.available
			? divBp(
					centsOrNull(obs.food.foodOutside),
					centsOrNull(obs.food.foodTotal),
				)
			: { available: false, reason: "SOURCE_UNAVAILABLE" },
	};
}

// ============================================================================
// Deterministic robust summaries (section 7) -- nearest-rank, integer math
// ============================================================================

/**
 * Nearest-rank percentile: `rank = ceil(p * n)` clamped to `[1, n]`, returning
 * the rank-th smallest value (1-indexed). No interpolation. `values` is sorted
 * ascending by the caller.
 */
function nearestRank(sortedAsc: number[], p: number): number {
	const n = sortedAsc.length;
	let rank = Math.ceil(p * n);
	if (rank < 1) rank = 1;
	if (rank > n) rank = n;
	return sortedAsc[rank - 1] as number;
}

export interface RobustFeatureSummary {
	/** true when at least one valid observation contributed. */
	available: boolean;
	/** valid observations in the window for THIS feature. */
	validCount: number;
	/** window observations where THIS feature was unavailable. */
	missingCount: number;
	/** compatible observations present in the window (all features share this). */
	windowObservationCount: number;
	/** the target checkpoint's own feature value (null when unavailable). */
	current: number | null;
	currentReason: NormalizedFeatureUnavailableReason | null;
	median: number | null;
	/** median absolute deviation from the window median (same nearest-rank rule). */
	mad: number | null;
	p25: number | null;
	p75: number | null;
	/** distinct unavailability reasons observed for this feature in the window. */
	coverageReasons: NormalizedFeatureUnavailableReason[];
}

function summarizeFeature(
	windowValues: NormalizedFeature[],
	current: NormalizedFeature,
	windowObservationCount: number,
): RobustFeatureSummary {
	const valid: number[] = [];
	const reasons = new Set<NormalizedFeatureUnavailableReason>();
	for (const f of windowValues) {
		if (f.available) valid.push(f.valueBp);
		else reasons.add(f.reason);
	}
	valid.sort((a, b) => a - b);

	let median: number | null = null;
	let mad: number | null = null;
	let p25: number | null = null;
	let p75: number | null = null;
	if (valid.length > 0) {
		median = nearestRank(valid, 0.5);
		p25 = nearestRank(valid, 0.25);
		p75 = nearestRank(valid, 0.75);
		const deviations = valid.map((v) => Math.abs(v - (median as number)));
		deviations.sort((a, b) => a - b);
		mad = nearestRank(deviations, 0.5);
	}

	return {
		available: valid.length > 0,
		validCount: valid.length,
		missingCount: windowObservationCount - valid.length,
		windowObservationCount,
		current: current.available ? current.valueBp : null,
		currentReason: current.available ? null : current.reason,
		median,
		mad,
		p25,
		p75,
		coverageReasons: [...reasons].sort(),
	};
}

// ============================================================================
// Observation contract compatibility (section 4)
// ============================================================================

export type BehaviorObservationCompatibility =
	| { compatible: true }
	| { compatible: false; reason: string };

function isMoney(v: unknown): boolean {
	if (typeof v !== "string") return false;
	try {
		parseAggregateMoneyString(v);
		return true;
	} catch {
		return false;
	}
}

function get(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const seg of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/**
 * Structural gate for `BUDGET_V2_BEHAVIOR_OBSERVATION_CONTRACT_VERSION`. A
 * frozen report that cannot supply every field the current normalized-feature /
 * regime / confidence contract needs is INCOMPATIBLE (with a reason) -- callers
 * exclude it from statistics and never coerce its missing values to `0`. Food
 * fields are intentionally NOT required here: an absent food classification
 * makes only the food feature unavailable, not the whole observation.
 */
export function classifyBehaviorObservationCompatibility(
	report: unknown,
): BehaviorObservationCompatibility {
	const stringPaths = [
		"checkpoint.paymentEventId",
		"checkpoint.checkpointAt",
		"checkpoint.periodMonth",
	];
	for (const p of stringPaths) {
		if (typeof get(report, p) !== "string") {
			return { compatible: false, reason: `MISSING_OR_INVALID:${p}` };
		}
	}

	const moneyPaths = [
		"mtd.budget.inputs.realizedIncome",
		"mtd.budget.inputs.currentObligations",
		"mtd.budget.basicLiving.basicLivingFunding",
		"mtd.budget.basicLiving.actualPersonalMandatorySpendMTD",
		"mtd.budget.policyOutput.deficit",
		"mtd.budget.policyOutput.emergencyCatchUp",
		"mtd.budget.policyOutput.trueSurplus",
		"mtd.emergencyFund.currentBalance",
		"mtd.emergencyFund.target",
		"mtd.emergencyFund.gap",
		"mtd.mobility.currentTotal",
		"mtd.spending.personalCardSpendMTD",
		"mtd.spending.byCategoryPersonalShare.MANDATORY_EXPENSE",
		"mtd.spending.byCategoryPersonalShare.DISCRETIONARY_SPEND",
		"mtd.spending.byCategoryPersonalShare.SHORT_TERM_PURCHASE",
	];
	for (const p of moneyPaths) {
		if (!isMoney(get(report, p))) {
			return { compatible: false, reason: `MISSING_OR_INVALID:${p}` };
		}
	}

	const su = get(report, "mtd.surplusUseAttribution");
	if (
		su === null ||
		typeof su !== "object" ||
		typeof (su as Record<string, unknown>).coverageComplete !== "boolean" ||
		typeof (su as Record<string, unknown>).candidateCount !== "number" ||
		typeof (su as Record<string, unknown>).attributedCount !== "number" ||
		!Array.isArray((su as Record<string, unknown>).unattributedSubjectIds) ||
		!Array.isArray((su as Record<string, unknown>).staleSubjectIds) ||
		!Array.isArray((su as Record<string, unknown>).overlapUnresolvedSubjectIds)
	) {
		return {
			compatible: false,
			reason: "MISSING_OR_INVALID:mtd.surplusUseAttribution",
		};
	}

	const atn = get(report, "availableToAllocateNow");
	if (atn === null || typeof atn !== "object") {
		return {
			compatible: false,
			reason: "MISSING_OR_INVALID:availableToAllocateNow",
		};
	}
	const atnRec = atn as Record<string, unknown>;
	if (typeof atnRec.available !== "boolean") {
		return {
			compatible: false,
			reason: "MISSING_OR_INVALID:availableToAllocateNow.available",
		};
	}
	if (atnRec.available === true) {
		const authPaths = [
			"availableToAllocateNow.amount",
			"availableToAllocateNow.trueSurplus",
			"availableToAllocateNow.oversubscribedBy",
			"availableToAllocateNow.totalAttributedCurrentSurplusUse",
		];
		for (const p of authPaths) {
			if (!isMoney(get(report, p))) {
				return { compatible: false, reason: `MISSING_OR_INVALID:${p}` };
			}
		}
		for (const lane of [
			"INTERNATIONAL_MOBILITY",
			"LONG_TERM_INVESTMENT",
			"DISCRETIONARY",
		]) {
			if (
				!isMoney(get(report, `availableToAllocateNow.lanes.${lane}.planned`)) ||
				!isMoney(get(report, `availableToAllocateNow.lanes.${lane}.used`))
			) {
				return {
					compatible: false,
					reason: `MISSING_OR_INVALID:availableToAllocateNow.lanes.${lane}`,
				};
			}
		}
	}

	return { compatible: true };
}

// ============================================================================
// Deterministic financial-context regime (section 10)
// ============================================================================

export type BehaviorContextRegime =
	| "DATA_INCOMPLETE"
	| "DEFICIT"
	| "OVERSUBSCRIBED"
	| "EMERGENCY_REBUILD"
	| "SURPLUS_AVAILABLE"
	| "SURPLUS_FULLY_USED";

/**
 * Bounded deterministic regime derived ONLY from the persisted checkpoint
 * observation -- never from merchant / name data and never from live state.
 * Precedence:
 *   1. the authoritative availability picture is not known -> DATA_INCOMPLETE
 *   2. deficit > 0                                         -> DEFICIT
 *   3. oversubscribedBy > 0                                -> OVERSUBSCRIBED
 *   4. emergency catch-up active OR emergency gap > 0      -> EMERGENCY_REBUILD
 *   5. authoritative available amount > 0                  -> SURPLUS_AVAILABLE
 *   6. authoritative available amount == 0                 -> SURPLUS_FULLY_USED
 */
export function deriveContextRegime(
	obs: BehaviorEngineCheckpointObservation,
): BehaviorContextRegime {
	const atn = obs.availableToAllocateNow;
	if (!atn || typeof atn.available !== "boolean" || atn.available === false) {
		return "DATA_INCOMPLETE";
	}
	const deficit = centsOrNull(obs.budget.deficit);
	const emergencyCatchUp = centsOrNull(obs.budget.emergencyCatchUp);
	const emergencyGap = centsOrNull(obs.emergency.gap);
	if (deficit === null) return "DATA_INCOMPLETE";
	if (deficit > 0n) return "DEFICIT";
	if ((centsOrNull(atn.oversubscribedBy) ?? 0n) > 0n) return "OVERSUBSCRIBED";
	if ((emergencyCatchUp ?? 0n) > 0n || (emergencyGap ?? 0n) > 0n) {
		return "EMERGENCY_REBUILD";
	}
	if ((centsOrNull(atn.amount) ?? 0n) > 0n) return "SURPLUS_AVAILABLE";
	return "SURPLUS_FULLY_USED";
}

// ============================================================================
// Profile shape
// ============================================================================

export type BehaviorConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface BehaviorConfidence {
	level: BehaviorConfidenceLevel;
	historySpanDays: number;
	compatibleCheckpointCount: number;
	distinctPeriodMonthCount: number;
	reasons: string[];
}

export interface BehaviorRegimeReview {
	current: BehaviorContextRegime;
	previous: BehaviorContextRegime | null;
	changed: boolean;
	/**
	 * A regime change only asks the FUTURE recommendation layer to review
	 * whether the historical baseline is still representative. The engine never
	 * deletes or resets history.
	 */
	baselineResetReviewSuggested: boolean;
	reason: string;
}

export type BehaviorWindowName = "DAYS_30" | "DAYS_60" | "DAYS_90";

export interface BehaviorWindowSummary {
	windowDays: number;
	rangeStart: string;
	rangeEndInclusive: string;
	observationCount: number;
	features: Record<BehaviorFeatureName, RobustFeatureSummary>;
}

export interface BehaviorFeatureCoverage {
	validCount: number;
	missingCount: number;
}

export interface BudgetV2BehaviorProfile {
	engineVersion: string;
	observationContractVersion: string;
	through: {
		paymentEventId: string;
		checkpointAt: string;
		periodMonth: string;
	};
	confidence: BehaviorConfidence;
	regime: BehaviorRegimeReview;
	currentObservation: BehaviorEngineCheckpointObservation | null;
	currentNormalizedFeatures: Record<
		BehaviorFeatureName,
		NormalizedFeature
	> | null;
	windows: Record<BehaviorWindowName, BehaviorWindowSummary>;
	dataQuality: {
		compatibleSnapshotCount: number;
		incompatibleSnapshotCount: number;
		incompatibleSnapshots: Array<{
			paymentEventId: string;
			checkpointAt: string;
			reason: string;
		}>;
		featureCoverageAllHistory: Record<
			BehaviorFeatureName,
			BehaviorFeatureCoverage
		>;
	};
}

// ============================================================================
// Pure assembler
// ============================================================================

export interface BehaviorSnapshotInput {
	paymentEventId: string;
	periodMonth: string;
	/** ISO-8601 UTC instant. */
	checkpointAt: string;
	/** the frozen `report_json` (fingerprint already verified by the caller). */
	report: unknown;
}

interface CompatibleEntry {
	paymentEventId: string;
	periodMonth: string;
	checkpointAtMs: number;
	checkpointAt: string;
	obs: BehaviorEngineCheckpointObservation;
	features: Record<BehaviorFeatureName, NormalizedFeature>;
}

const DAY_MS = 86_400_000;
const UNAVAILABLE_SOURCE: NormalizedFeature = {
	available: false,
	reason: "SOURCE_UNAVAILABLE",
};

function failClosed(reason: string): never {
	throw new BudgetError("BUDGET_BEHAVIOR_PROFILE_FAIL_CLOSED", reason);
}

/**
 * Deterministic target-anchored behavior profile from already-verified
 * persisted checkpoint snapshots. Pure: same target + same snapshot set ->
 * identical profile. The DB entry point `buildBudgetV2BehaviorProfile` verifies
 * every snapshot's integrity before calling this.
 */
export function assembleBudgetV2BehaviorProfile(params: {
	throughPaymentEventId: string;
	snapshots: BehaviorSnapshotInput[];
}): BudgetV2BehaviorProfile {
	const { throughPaymentEventId, snapshots } = params;

	const target = snapshots.find(
		(s) => s.paymentEventId === throughPaymentEventId,
	);
	if (!target) {
		failClosed(
			`payment event ${throughPaymentEventId} has no successfully persisted Budget V2 checkpoint snapshot`,
		);
	}
	const targetMs = Date.parse(target.checkpointAt);
	if (!Number.isFinite(targetMs)) {
		failClosed(
			`target checkpoint ${throughPaymentEventId} has a non-parseable checkpointAt`,
		);
	}

	// History = every snapshot at or before the target instant, never a future
	// one. Deterministic order.
	const history = snapshots
		.filter((s) => {
			const ms = Date.parse(s.checkpointAt);
			if (!Number.isFinite(ms)) {
				failClosed(
					`persisted snapshot ${s.paymentEventId} has a non-parseable checkpointAt`,
				);
			}
			return ms <= targetMs;
		})
		.slice()
		.sort(
			(a, b) =>
				Date.parse(a.checkpointAt) - Date.parse(b.checkpointAt) ||
				(a.paymentEventId < b.paymentEventId ? -1 : 1),
		);

	// Checkpoint 5 forbids two DISTINCT payment events at the exact same
	// checkpointAt in one user+period; if persisted history violates that, fail
	// closed rather than pick an order by inference.
	const byInstant = new Map<number, Set<string>>();
	const seenEvents = new Set<string>();
	for (const s of history) {
		if (seenEvents.has(s.paymentEventId)) {
			failClosed(
				`duplicate persisted checkpoint snapshot for payment event ${s.paymentEventId}`,
			);
		}
		seenEvents.add(s.paymentEventId);
		const ms = Date.parse(s.checkpointAt);
		const set = byInstant.get(ms) ?? new Set<string>();
		set.add(s.paymentEventId);
		byInstant.set(ms, set);
	}
	for (const set of byInstant.values()) {
		if (set.size > 1) {
			failClosed(
				"persisted checkpoint history has two distinct payment events sharing the exact checkpointAt",
			);
		}
	}

	const compatible: CompatibleEntry[] = [];
	const incompatible: Array<{
		paymentEventId: string;
		checkpointAt: string;
		reason: string;
	}> = [];
	for (const s of history) {
		const verdict = classifyBehaviorObservationCompatibility(s.report);
		if (!verdict.compatible) {
			incompatible.push({
				paymentEventId: s.paymentEventId,
				checkpointAt: s.checkpointAt,
				reason: verdict.reason,
			});
			continue;
		}
		const obs = extractBehaviorEngineCheckpointObservation(
			s.report as BudgetV2CheckpointReport,
		);
		compatible.push({
			paymentEventId: s.paymentEventId,
			periodMonth: s.periodMonth,
			checkpointAtMs: Date.parse(s.checkpointAt),
			checkpointAt: s.checkpointAt,
			obs,
			features: normalizeBehaviorFeatures(obs),
		});
	}

	const targetEntry = compatible.find(
		(e) => e.paymentEventId === throughPaymentEventId,
	);

	// -- confidence (section 9) ------------------------------------------------
	const confidence = computeConfidence(compatible, targetMs);

	// -- regime + reset review (sections 10-11) ------------------------------
	const currentRegime: BehaviorContextRegime = targetEntry
		? deriveContextRegime(targetEntry.obs)
		: "DATA_INCOMPLETE";
	const prevEntry = [...compatible]
		.filter((e) => e.checkpointAtMs < targetMs)
		.pop();
	const previousRegime = prevEntry ? deriveContextRegime(prevEntry.obs) : null;
	const regimeChanged =
		previousRegime !== null && previousRegime !== currentRegime;
	const regime: BehaviorRegimeReview = {
		current: currentRegime,
		previous: previousRegime,
		changed: regimeChanged,
		baselineResetReviewSuggested: regimeChanged,
		reason: !targetEntry
			? "target checkpoint is not compatible with the current behavior observation contract"
			: previousRegime === null
				? "no earlier compatible persisted checkpoint to compare against"
				: regimeChanged
					? `regime moved ${previousRegime} -> ${currentRegime}; the future recommendation layer should review whether the historical baseline is still representative (history is never auto-reset)`
					: `regime unchanged (${currentRegime})`,
	};

	// -- windows (sections 7-8) ---------------------------------------------
	const windows = {
		DAYS_30: buildWindow(
			30,
			compatible,
			targetEntry,
			targetMs,
			target.checkpointAt,
		),
		DAYS_60: buildWindow(
			60,
			compatible,
			targetEntry,
			targetMs,
			target.checkpointAt,
		),
		DAYS_90: buildWindow(
			90,
			compatible,
			targetEntry,
			targetMs,
			target.checkpointAt,
		),
	} satisfies Record<BehaviorWindowName, BehaviorWindowSummary>;

	// -- data quality ------------------------------------------------------
	const featureCoverageAllHistory = {} as Record<
		BehaviorFeatureName,
		BehaviorFeatureCoverage
	>;
	for (const name of BEHAVIOR_FEATURE_NAMES) {
		let valid = 0;
		for (const e of compatible) if (e.features[name].available) valid += 1;
		featureCoverageAllHistory[name] = {
			validCount: valid,
			missingCount: compatible.length - valid,
		};
	}

	return {
		engineVersion: BUDGET_V2_BEHAVIOR_ENGINE_VERSION,
		observationContractVersion: BUDGET_V2_BEHAVIOR_OBSERVATION_CONTRACT_VERSION,
		through: {
			paymentEventId: throughPaymentEventId,
			checkpointAt: target.checkpointAt,
			periodMonth: target.periodMonth,
		},
		confidence,
		regime,
		currentObservation: targetEntry ? targetEntry.obs : null,
		currentNormalizedFeatures: targetEntry ? targetEntry.features : null,
		windows,
		dataQuality: {
			compatibleSnapshotCount: compatible.length,
			incompatibleSnapshotCount: incompatible.length,
			incompatibleSnapshots: incompatible,
			featureCoverageAllHistory,
		},
	};
}

function computeConfidence(
	compatible: CompatibleEntry[],
	targetMs: number,
): BehaviorConfidence {
	const reasons: string[] = [];
	if (compatible.length === 0) {
		return {
			level: "LOW",
			historySpanDays: 0,
			compatibleCheckpointCount: 0,
			distinctPeriodMonthCount: 0,
			reasons: ["NO_COMPATIBLE_CHECKPOINTS"],
		};
	}
	const earliestMs = compatible[0]?.checkpointAtMs as number;
	const historySpanDays = Math.floor((targetMs - earliestMs) / DAY_MS);
	const count = compatible.length;
	const distinctPeriodMonthCount = new Set(compatible.map((e) => e.periodMonth))
		.size;

	let level: BehaviorConfidenceLevel;
	if (historySpanDays < 60 || count < 4) {
		level = "LOW";
		if (historySpanDays < 60) {
			reasons.push(`history span ${historySpanDays}d < 60d`);
		}
		if (count < 4) reasons.push(`${count} compatible checkpoints < 4`);
	} else if (
		historySpanDays >= 90 &&
		count >= 6 &&
		distinctPeriodMonthCount >= 3
	) {
		level = "HIGH";
		reasons.push(
			`history span ${historySpanDays}d >= 90d, ${count} checkpoints >= 6, ${distinctPeriodMonthCount} distinct months >= 3`,
		);
	} else {
		level = "MEDIUM";
		reasons.push(
			`history span ${historySpanDays}d and ${count} checkpoints clear MEDIUM`,
		);
		if (historySpanDays < 90)
			reasons.push(`history span ${historySpanDays}d < 90d`);
		if (count < 6) reasons.push(`${count} compatible checkpoints < 6`);
		if (distinctPeriodMonthCount < 3) {
			reasons.push(`${distinctPeriodMonthCount} distinct periodMonths < 3`);
		}
	}

	return {
		level,
		historySpanDays,
		compatibleCheckpointCount: count,
		distinctPeriodMonthCount,
		reasons,
	};
}

function buildWindow(
	windowDays: number,
	compatible: CompatibleEntry[],
	targetEntry: CompatibleEntry | undefined,
	targetMs: number,
	targetCheckpointAt: string,
): BehaviorWindowSummary {
	const lowMs = targetMs - windowDays * DAY_MS;
	const inWindow = compatible.filter(
		(e) => e.checkpointAtMs >= lowMs && e.checkpointAtMs <= targetMs,
	);
	const features = {} as Record<BehaviorFeatureName, RobustFeatureSummary>;
	for (const name of BEHAVIOR_FEATURE_NAMES) {
		features[name] = summarizeFeature(
			inWindow.map((e) => e.features[name]),
			targetEntry ? targetEntry.features[name] : UNAVAILABLE_SOURCE,
			inWindow.length,
		);
	}
	return {
		windowDays,
		rangeStart: new Date(lowMs).toISOString(),
		rangeEndInclusive: targetCheckpointAt,
		observationCount: inWindow.length,
		features,
	};
}

// ============================================================================
// DB entry point -- verify every snapshot, then assemble
// ============================================================================

/**
 * Target-anchored historical behavior profile for `throughPaymentEventId`.
 * Loads ONLY this user's successfully persisted checkpoint snapshots with
 * `checkpointAt <= target.checkpointAt`, verifies each one's stored integrity
 * (a corrupt row fails the whole profile closed -- never a silent drop), then
 * assembles the deterministic profile. No live resolver, no report rebuild, no
 * current-state reads.
 */
export async function buildBudgetV2BehaviorProfile(params: {
	db: Database;
	userId: string;
	throughPaymentEventId: string;
}): Promise<BudgetV2BehaviorProfile> {
	const userId = normalizeUuid(params.userId, "userId");
	const throughPaymentEventId = normalizeUuid(
		params.throughPaymentEventId,
		"throughPaymentEventId",
	);

	const [target] = await params.db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(
			and(
				eq(budgetV2CheckpointSnapshots.userId, userId),
				eq(budgetV2CheckpointSnapshots.paymentEventId, throughPaymentEventId),
			),
		)
		.limit(1);
	if (!target) {
		throw new BudgetError(
			"BUDGET_BEHAVIOR_PROFILE_FAIL_CLOSED",
			`payment event ${throughPaymentEventId} has no successfully persisted Budget V2 checkpoint snapshot`,
		);
	}

	const rows = await params.db
		.select()
		.from(budgetV2CheckpointSnapshots)
		.where(
			and(
				eq(budgetV2CheckpointSnapshots.userId, userId),
				lte(budgetV2CheckpointSnapshots.checkpointAt, target.checkpointAt),
			),
		)
		.orderBy(
			asc(budgetV2CheckpointSnapshots.checkpointAt),
			asc(budgetV2CheckpointSnapshots.id),
		);

	const snapshots: BehaviorSnapshotInput[] = [];
	for (const row of rows) {
		await verifyStoredCheckpointSnapshot({
			reportSchemaVersion: row.reportSchemaVersion,
			reportJson: row.reportJson,
			reportFingerprint: row.reportFingerprint,
			paymentEventId: row.paymentEventId,
			periodMonth: row.periodMonth,
			checkpointAt: row.checkpointAt,
			previousCheckpointAt: row.previousCheckpointAt,
		});
		snapshots.push({
			paymentEventId: row.paymentEventId,
			periodMonth: row.periodMonth,
			checkpointAt: row.checkpointAt.toISOString(),
			report: row.reportJson,
		});
	}

	return assembleBudgetV2BehaviorProfile({ throughPaymentEventId, snapshots });
}
