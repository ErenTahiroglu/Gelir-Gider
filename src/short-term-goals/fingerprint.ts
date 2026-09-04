export interface CalculateShortTermGoalRevisionFingerprintParams {
	userId: string;
	goalId: string;
	revisionNo: number;
	previousRevisionId: string | null;
	operation: string;
	status: string;
	name: string;
	fundingTarget: string; // normalized money string
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	changeReason: string | null;
	occurredAt: Date;
}

export interface CalculateShortTermGoalPriorityFingerprintParams {
	userId: string;
	midasAccountId: string;
	revisionNo: number;
	previousRevisionId: string | null;
	orderedGoalIds: string[];
	occurredAt: Date;
}

/**
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for a short-term goal revision
 * using structured canonical array serialization and standard Web Crypto API.
 */
export async function calculateShortTermGoalRevisionFingerprint(
	params: CalculateShortTermGoalRevisionFingerprintParams,
): Promise<string> {
	const canonicalTuple = [
		"short-term-goal-revision-v1",
		params.userId.trim().toLowerCase(),
		params.goalId.trim().toLowerCase(),
		params.revisionNo,
		params.previousRevisionId
			? params.previousRevisionId.trim().toLowerCase()
			: null,
		params.operation,
		params.status,
		params.name,
		params.fundingTarget,
		params.targetDate ?? null,
		params.maxBudget ?? null,
		params.targetPrice ?? null,
		params.productUrl ?? null,
		params.note ?? null,
		params.changeReason ?? null,
		params.occurredAt.toISOString(),
	];

	const serialized = JSON.stringify(canonicalTuple);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for a short-term goal priority revision
 * using structured canonical array serialization and standard Web Crypto API.
 */
export async function calculateShortTermGoalPriorityFingerprint(
	params: CalculateShortTermGoalPriorityFingerprintParams,
): Promise<string> {
	const canonicalTuple = [
		"short-term-goal-priority-v1",
		params.userId.trim().toLowerCase(),
		params.midasAccountId.trim().toLowerCase(),
		params.revisionNo,
		params.previousRevisionId
			? params.previousRevisionId.trim().toLowerCase()
			: null,
		params.orderedGoalIds.map((id) => id.trim().toLowerCase()),
		params.occurredAt.toISOString(),
	];

	const serialized = JSON.stringify(canonicalTuple);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
