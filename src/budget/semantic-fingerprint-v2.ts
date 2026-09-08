import type {
	StgBudgetV2Purpose,
	SupportReceiptRole,
} from "../db/schema/budget-v2-semantics";

async function sha256Hex(tuple: unknown[]): Promise<string> {
	const encoded = new TextEncoder().encode(JSON.stringify(tuple));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export interface SupportSemanticFingerprintParams {
	userId: string;
	incomeReceiptId: string;
	operation: "CREATE" | "UPDATE";
	revisionNo: number;
	previousRevisionId: string | null;
	supportRole: SupportReceiptRole;
	occurredAt: Date;
}

/** Deterministic 64 lowercase-hex fingerprint for a SUPPORT-receipt role revision. */
export function calculateSupportSemanticRevisionFingerprint(
	params: SupportSemanticFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"income-receipt-budget-v2-semantic-v1",
		params.userId.trim().toLowerCase(),
		params.incomeReceiptId.trim().toLowerCase(),
		params.operation,
		params.revisionNo,
		params.previousRevisionId
			? params.previousRevisionId.trim().toLowerCase()
			: null,
		params.supportRole,
		params.occurredAt.toISOString(),
	]);
}

export interface GoalPurposeFingerprintParams {
	userId: string;
	goalId: string;
	operation: "CREATE" | "UPDATE";
	revisionNo: number;
	previousRevisionId: string | null;
	purpose: StgBudgetV2Purpose;
	occurredAt: Date;
}

/** Deterministic 64 lowercase-hex fingerprint for a goal Budget V2 purpose revision. */
export function calculateGoalPurposeRevisionFingerprint(
	params: GoalPurposeFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"short-term-goal-budget-v2-purpose-v1",
		params.userId.trim().toLowerCase(),
		params.goalId.trim().toLowerCase(),
		params.operation,
		params.revisionNo,
		params.previousRevisionId
			? params.previousRevisionId.trim().toLowerCase()
			: null,
		params.purpose,
		params.occurredAt.toISOString(),
	]);
}

export interface BasicLivingConfigFingerprintParams {
	userId: string;
	operation: "CREATE" | "UPDATE";
	revisionNo: number;
	previousRevisionId: string | null;
	effectivePeriodMonth: string;
	monthlyTargetAmount: string;
	currency: string;
	sourceKind: string;
	occurredAt: Date;
}

/** Deterministic 64 lowercase-hex fingerprint for a basic-living config revision. */
export function calculateBasicLivingConfigRevisionFingerprint(
	params: BasicLivingConfigFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"budget-v2-basic-living-config-v1",
		params.userId.trim().toLowerCase(),
		params.operation,
		params.revisionNo,
		params.previousRevisionId
			? params.previousRevisionId.trim().toLowerCase()
			: null,
		params.effectivePeriodMonth,
		params.monthlyTargetAmount,
		params.currency,
		params.sourceKind,
		params.occurredAt.toISOString(),
	]);
}
