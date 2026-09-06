async function sha256Hex(data: unknown[]): Promise<string> {
	const serialized = JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
	const encoded = new TextEncoder().encode(serialized);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes the deterministic content hash of a source snapshot's semantic
 * content (title/text/url/external id). Used to detect a repeated identical
 * source capture so no duplicate review candidate work is created for
 * unchanged content (Section 8).
 */
export async function calculateCampaignSourceContentHash(params: {
	sourceType: string;
	sourceUrl: string | null;
	externalSourceId: string | null;
	sourceTitle: string | null;
	sourceText: string | null;
}): Promise<string> {
	return sha256Hex([
		"campaign-source-content-v1",
		params.sourceType,
		params.sourceUrl,
		params.externalSourceId,
		params.sourceTitle,
		params.sourceText,
	]);
}

export interface CampaignPeriodRevisionCreateFingerprintParams {
	userId: string;
	campaignPeriodId: string;
	title: string;
	startsOn: string;
	endsOn: string;
	ruleMode: string;
	targetSpendAmount: string | null;
	requiredTransactionCount: number | null;
	minimumTransactionAmount: string | null;
	stepSpendAmount: string | null;
	rewardPointsPerStep: string | null;
	maxSteps: number | null;
	rewardKind: string;
	rewardAccountId: string | null;
	expectedRewardPoints: string | null;
	merchantScopeMode: string;
	requiredCanonicalMerchantNames: string[] | null;
	allowedMccCodes: string[] | null;
	rewardExpiryDate: string | null;
	cardIds: string[];
	sourceSnapshotId: string | null;
	note: string | null;
	occurredAt: Date;
}

export async function calculateCampaignPeriodRevisionFingerprint(
	operation: string,
	params: CampaignPeriodRevisionCreateFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-period-revision-v1",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		operation,
		params.title,
		params.startsOn,
		params.endsOn,
		params.ruleMode,
		params.targetSpendAmount,
		params.requiredTransactionCount,
		params.minimumTransactionAmount,
		params.stepSpendAmount,
		params.rewardPointsPerStep,
		params.maxSteps,
		params.rewardKind,
		params.rewardAccountId?.trim().toLowerCase() ?? null,
		params.expectedRewardPoints,
		params.merchantScopeMode,
		params.requiredCanonicalMerchantNames
			? [...params.requiredCanonicalMerchantNames].sort()
			: null,
		params.allowedMccCodes ? [...params.allowedMccCodes].sort() : null,
		params.rewardExpiryDate,
		[...params.cardIds].map((id) => id.trim().toLowerCase()).sort(),
		params.sourceSnapshotId?.trim().toLowerCase() ?? null,
		params.note,
		params.occurredAt.toISOString(),
	]);
}

export interface CampaignPeriodLifecycleFingerprintParams {
	userId: string;
	campaignPeriodId: string;
	expectedRevisionNo: number;
	operation: string;
	occurredAt: Date;
	note: string | null;
}

export async function calculateCampaignPeriodLifecycleFingerprint(
	params: CampaignPeriodLifecycleFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-period-lifecycle-v1",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		params.expectedRevisionNo,
		params.operation,
		params.occurredAt.toISOString(),
		params.note,
	]);
}

export interface CampaignOverrideFingerprintParams {
	userId: string;
	campaignPeriodId: string;
	purchaseEventId: string;
	operation: string;
	reasonNote: string | null;
	occurredAt: Date;
}

export async function calculateCampaignOverrideFingerprint(
	params: CampaignOverrideFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-purchase-override-v1",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		params.purchaseEventId.trim().toLowerCase(),
		params.operation,
		params.reasonNote,
		params.occurredAt.toISOString(),
	]);
}

export interface CampaignRewardCreditFingerprintParams {
	userId: string;
	campaignPeriodId: string;
	operation: string;
	rewardAccountId: string;
	actualPointAmount: string;
	expectedPointAmount: string | null;
	reasonNote: string | null;
	occurredAt: Date;
}

export async function calculateCampaignRewardCreditFingerprint(
	params: CampaignRewardCreditFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-reward-credit-v1",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		params.operation,
		params.rewardAccountId.trim().toLowerCase(),
		params.actualPointAmount,
		params.expectedPointAmount,
		params.reasonNote,
		params.occurredAt.toISOString(),
	]);
}
