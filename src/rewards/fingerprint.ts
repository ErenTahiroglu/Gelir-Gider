async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Reward Account Fingerprints ----

export interface RewardAccountCreateFingerprintParams {
	userId: string;
	code: string;
	creditCardId: string | null;
	displayName: string;
	provider: string;
	unitName: string;
	defaultConversionRate: string;
	note: string | null;
	occurredAt: Date;
}

export async function calculateRewardAccountCreateFingerprint(
	params: RewardAccountCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"reward-account-revision-v1",
		params.userId.trim().toLowerCase(),
		params.code.trim().toUpperCase(),
		params.creditCardId?.trim().toLowerCase() ?? null,
		"CREATE",
		params.displayName,
		params.provider,
		params.unitName,
		params.defaultConversionRate,
		params.note,
		params.occurredAt.toISOString(),
	]);
}

export interface RewardAccountUpdateFingerprintParams {
	userId: string;
	rewardAccountId: string;
	expectedRevisionNo: number;
	displayName: string;
	provider: string;
	unitName: string;
	defaultConversionRate: string;
	note: string | null;
	occurredAt: Date;
}

export async function calculateRewardAccountUpdateFingerprint(
	params: RewardAccountUpdateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"reward-account-revision-v1",
		params.userId.trim().toLowerCase(),
		params.rewardAccountId.trim().toLowerCase(),
		"UPDATE",
		params.expectedRevisionNo,
		params.displayName,
		params.provider,
		params.unitName,
		params.defaultConversionRate,
		params.note,
		params.occurredAt.toISOString(),
	]);
}

export interface RewardAccountArchiveFingerprintParams {
	userId: string;
	rewardAccountId: string;
	expectedRevisionNo: number;
	occurredAt: Date;
}

export async function calculateRewardAccountArchiveFingerprint(
	params: RewardAccountArchiveFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"reward-account-revision-v1",
		params.userId.trim().toLowerCase(),
		params.rewardAccountId.trim().toLowerCase(),
		"ARCHIVE",
		params.expectedRevisionNo,
		params.occurredAt.toISOString(),
	]);
}

// ---- Reward Event Fingerprints ----

export interface RewardEventCreateFingerprintParams {
	userId: string;
	rewardAccountId: string;
	eventType: string;
	pointAmount: string;
	conversionRate: string;
	economicAmount: string | null;
	purchaseCategory: string | null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	occurredAt: Date;
}

export async function calculateRewardEventCreateFingerprint(
	params: RewardEventCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"reward-event-revision-v1",
		params.userId.trim().toLowerCase(),
		params.rewardAccountId.trim().toLowerCase(),
		params.eventType,
		"CREATE",
		params.pointAmount,
		params.conversionRate,
		params.economicAmount,
		params.purchaseCategory,
		params.shortTermGoalId?.trim().toLowerCase() ?? null,
		params.merchant,
		params.description,
		params.occurredAt.toISOString(),
	]);
}

export interface RewardEventVoidFingerprintParams {
	userId: string;
	rewardEventId: string;
	expectedRevisionNo: number;
	occurredAt: Date;
	reasonNote: string | null;
}

export async function calculateRewardEventVoidFingerprint(
	params: RewardEventVoidFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"reward-event-revision-v1",
		params.userId.trim().toLowerCase(),
		params.rewardEventId.trim().toLowerCase(),
		"VOID",
		params.expectedRevisionNo,
		params.occurredAt.toISOString(),
		params.reasonNote,
	]);
}
