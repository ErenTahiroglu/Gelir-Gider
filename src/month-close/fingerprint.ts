async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface MonthCloseRecommendedGoalFingerprintInput {
	goalId: string;
	revisionNo: number;
	priority: number;
	bucketId: string;
	remainingToTarget: string;
}

export interface MonthCloseProposalFingerprintParams {
	userId: string;
	periodMonth: string;
	budgetPlanId: string;
	budgetPlanRevisionNo: number;
	referenceIncome: string;
	mandatoryCeiling: string;
	mandatoryExpense: string;
	mandatoryUnused: string;
	discretionaryCeiling: string;
	discretionaryExpense: string;
	discretionaryUnused: string;
	unclassifiedExpense: string;
	closeSurplus: string;
	route: "SHORT_TERM_GOAL" | "MEDIUM_TERM_RESERVE" | "NONE";
	recommendedGoal: MonthCloseRecommendedGoalFingerprintInput | null;
}

/**
 * Deterministic SHA-256 proposal fingerprint (Section 8). Binds economic
 * budget truth + goal truth only -- deliberately EXCLUDES current Midas
 * unallocated liquidity (Section 20), so a harmless liquidity change never
 * invalidates an otherwise-unchanged proposal.
 */
export async function calculateMonthCloseProposalFingerprint(
	params: MonthCloseProposalFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"month-close-proposal-v1",
		params.userId.trim().toLowerCase(),
		params.periodMonth,
		params.budgetPlanId.trim().toLowerCase(),
		params.budgetPlanRevisionNo,
		params.referenceIncome,
		params.mandatoryCeiling,
		params.mandatoryExpense,
		params.mandatoryUnused,
		params.discretionaryCeiling,
		params.discretionaryExpense,
		params.discretionaryUnused,
		params.unclassifiedExpense,
		params.closeSurplus,
		params.route,
		params.recommendedGoal
			? [
					params.recommendedGoal.goalId.trim().toLowerCase(),
					params.recommendedGoal.revisionNo,
					params.recommendedGoal.priority,
					params.recommendedGoal.bucketId.trim().toLowerCase(),
					params.recommendedGoal.remainingToTarget,
				]
			: null,
	]);
}

export interface MonthCloseApplyFingerprintParams {
	userId: string;
	periodMonth: string;
	expectedProposalFingerprint: string;
	effectiveRoute: "SHORT_TERM_GOAL" | "MEDIUM_TERM_RESERVE" | "NONE";
	decision: "FULL" | "PARTIAL" | "SKIP" | "AUTO_MEDIUM" | "NO_ACTION";
	partialAmount: string | null;
	occurredAt: Date;
}

/**
 * Deterministic SHA-256 apply/idempotency fingerprint (Section 34). Binds
 * user, period, expectedProposalFingerprint, effective route, decision,
 * partial amount (if any), and occurredAt. Doubles as the stored
 * `revision_fingerprint` for the immutable historical snapshot.
 */
export async function calculateMonthCloseApplyFingerprint(
	params: MonthCloseApplyFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"month-close-apply-v1",
		params.userId.trim().toLowerCase(),
		params.periodMonth,
		params.expectedProposalFingerprint,
		params.effectiveRoute,
		params.decision,
		params.partialAmount,
		params.occurredAt.toISOString(),
	]);
}

/**
 * Derives a bounded (64-char hex) child idempotency key from a parent
 * caller-supplied key plus identity/operation context. Never concatenates an
 * arbitrary 128-char caller key directly into another constrained column.
 */
export async function deriveMonthCloseChildIdempotencyKey(
	parentKey: string,
	parts: string[],
): Promise<string> {
	return sha256Hex(["month-close-child-idempotency-v1", parentKey, ...parts]);
}
