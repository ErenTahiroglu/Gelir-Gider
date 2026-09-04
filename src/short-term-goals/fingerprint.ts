export interface CalculateShortTermGoalRevisionFingerprintV1Params {
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

export interface CalculateShortTermGoalCreateRevisionFingerprintParams {
	userId: string;
	goalId: string;
	name: string;
	fundingTarget: string; // normalized money string
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	priorityPosition: number; // 1-based integer
	occurredAt: Date;
}

export interface CalculateShortTermGoalUpdateRevisionFingerprintParams {
	userId: string;
	goalId: string;
	expectedRevisionNo: number;
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

export interface CalculateShortTermGoalTerminalRevisionFingerprintParams {
	userId: string;
	goalId: string;
	operation: "COMPLETE" | "CANCEL";
	expectedRevisionNo: number;
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
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for a short-term goal revision (v1 legacy format).
 */
export async function calculateShortTermGoalRevisionFingerprintV1(
	params: CalculateShortTermGoalRevisionFingerprintV1Params,
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
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for CREATE revision (v2 format).
 */
export async function calculateShortTermGoalCreateFingerprintV2(
	params: CalculateShortTermGoalCreateRevisionFingerprintParams,
): Promise<string> {
	const canonicalTuple = [
		"short-term-goal-revision-v2",
		params.userId.trim().toLowerCase(),
		params.goalId.trim().toLowerCase(),
		"CREATE",
		1,
		params.name,
		params.fundingTarget,
		params.targetDate ?? null,
		params.maxBudget ?? null,
		params.targetPrice ?? null,
		params.productUrl ?? null,
		params.note ?? null,
		params.priorityPosition,
		params.occurredAt.toISOString(),
	];

	const serialized = JSON.stringify(canonicalTuple);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for UPDATE revision (v2 format).
 */
export async function calculateShortTermGoalUpdateFingerprintV2(
	params: CalculateShortTermGoalUpdateRevisionFingerprintParams,
): Promise<string> {
	const canonicalTuple = [
		"short-term-goal-revision-v2",
		params.userId.trim().toLowerCase(),
		params.goalId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
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
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for COMPLETE / CANCEL revision (v2 format).
 */
export async function calculateShortTermGoalTerminalFingerprintV2(
	params: CalculateShortTermGoalTerminalRevisionFingerprintParams,
): Promise<string> {
	const canonicalTuple = [
		"short-term-goal-revision-v2",
		params.userId.trim().toLowerCase(),
		params.goalId.trim().toLowerCase(),
		params.operation,
		params.expectedRevisionNo,
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
 * Calculates a deterministic 64 lowercase hex SHA-256 fingerprint for a short-term goal priority revision.
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

/**
 * Generates a bounded deterministic SHA-256 namespaced internal priority idempotency key (<= 128 characters).
 * Format: STG_PRIORITY_<64hex>
 */
export async function generateHashedPriorityIdempotencyKey(
	callerKey: string,
	entityId: string,
	namespace: string,
): Promise<string> {
	const canonicalTuple = [
		"short-term-goal-priority-key",
		callerKey.trim(),
		entityId.trim().toLowerCase(),
		namespace.trim(),
	];

	const serialized = JSON.stringify(canonicalTuple);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `STG_PRIORITY_${hex}`;
}
