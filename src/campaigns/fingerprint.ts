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

/**
 * Section A/C (Phase 16-R1): the CREATE-specific request fingerprint. Unlike
 * `calculateCampaignPeriodRevisionFingerprint`, this binds NO generated id
 * (no campaignPeriodId/campaignFamilyId/revisionId) so a legitimate exact
 * CREATE retry (before or after the family/period rows exist) always
 * produces the identical value -- computed once, before any DB mutation, and
 * used for both the early replay lookup and permanent storage. Additionally
 * binds provider/familyKey/periodKey (the identity a CREATE establishes) and
 * parser provenance (parserType/parserVersion/parserConfidence), which the
 * legacy fingerprint omitted entirely.
 */
export interface CampaignPeriodCreateRequestFingerprintParams {
	userId: string;
	provider: string;
	familyKey: string;
	periodKey: string;
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
	parserType: string | null;
	parserVersion: string | null;
	parserConfidence: number | null;
	note: string | null;
	occurredAt: Date;
}

export async function calculateCampaignPeriodCreateRequestFingerprint(
	params: CampaignPeriodCreateRequestFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-period-create-request-v1",
		params.userId.trim().toLowerCase(),
		params.provider,
		params.familyKey,
		params.periodKey,
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
		params.parserType,
		params.parserVersion,
		params.parserConfidence,
		params.note,
		params.occurredAt.toISOString(),
	]);
}

/**
 * Section C (Phase 16-R1): the AMEND-specific fingerprint. Binds
 * expectedRevisionNo (true OCC semantics -- the same idempotency key retried
 * against a different expectedRevisionNo must CONFLICT even when every other
 * term is byte-identical) and parser provenance, neither of which the legacy
 * generic fingerprint bound.
 */
export interface CampaignPeriodAmendFingerprintParams
	extends Omit<
		CampaignPeriodCreateRequestFingerprintParams,
		"provider" | "familyKey" | "periodKey"
	> {
	campaignPeriodId: string;
	expectedRevisionNo: number;
}

export async function calculateCampaignPeriodAmendFingerprint(
	params: CampaignPeriodAmendFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-period-amend-v1",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		params.expectedRevisionNo,
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
		params.parserType,
		params.parserVersion,
		params.parserConfidence,
		params.note,
		params.occurredAt.toISOString(),
	]);
}

/**
 * Section B (Phase 16-R2): bounded, deterministic, collision-resistant
 * child-idempotency-key derivation for a review-candidate-driven child
 * mutation (e.g. the campaign AMEND that `applyCampaignReviewCandidate`
 * drives). `campaign_period_revisions.idempotency_key` is `varchar(128)` and
 * the parent (candidate) idempotency key can itself be up to 128 chars, so
 * raw string concatenation (e.g. `${parentKey}:campaign-amend`) can overflow
 * the column. Mirrors the existing
 * `deriveNotificationChildIdempotencyKey` pattern (src/notifications/
 * fingerprint.ts): output is always exactly 64 lowercase hex chars
 * regardless of parentKey length.
 */
export interface CampaignReviewChildIdempotencyKeyParams {
	parentKey: string;
	candidateId: string;
	operation: "APPLY";
	child: "CAMPAIGN_AMEND";
}

export async function deriveCampaignReviewChildIdempotencyKey(
	params: CampaignReviewChildIdempotencyKeyParams,
): Promise<string> {
	return sha256Hex([
		"campaign-review-child-idempotency-v1",
		params.parentKey,
		params.candidateId,
		params.operation,
		params.child,
	]);
}

/**
 * Section C (Phase 16-R2): the CREATE-specific exact-replay request
 * fingerprint for a review candidate. Unlike `candidateHash` (a
 * content-addressed semantic identity deliberately excluding occurredAt,
 * used only for cross-request PENDING dedup -- see
 * `calculateCampaignReviewCandidateHash` below), this fingerprint binds
 * every field that determines exact request intent so that a byte-identical
 * retry of the same idempotency key replays cleanly, while any change (to
 * occurredAt, sourceSnapshotId, campaignPeriodId, or any term/card/parser
 * field, all of which are subsumed by candidateHash) produces
 * CAMPAIGN_IDEMPOTENCY_CONFLICT.
 */
export interface CampaignReviewCandidateCreateRequestFingerprintParams {
	userId: string;
	campaignPeriodId: string;
	sourceSnapshotId: string;
	candidateHash: string;
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
	parserType: string | null;
	parserVersion: string | null;
	parserConfidence: number | null;
	proposedCardIds: string[];
	occurredAt: Date;
}

export async function calculateCampaignReviewCandidateCreateRequestFingerprint(
	params: CampaignReviewCandidateCreateRequestFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-review-candidate-create-request-v1",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		params.sourceSnapshotId.trim().toLowerCase(),
		params.candidateHash,
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
		params.parserType,
		params.parserVersion,
		params.parserConfidence,
		[...params.proposedCardIds].map((id) => id.trim().toLowerCase()).sort(),
		params.occurredAt.toISOString(),
	]);
}

/**
 * Section K (Phase 16-R1): the semantic hash used to dedup review candidates.
 * Computed over the SAME normalized-term fields as the CREATE request
 * fingerprint (minus identity fields that are not part of the "proposed
 * terms" surface), plus the proposed card scope. Two proposals with
 * byte-identical semantic content hash identically regardless of
 * idempotency key or occurredAt -- this is a content-addressed dedup key,
 * not a request-replay fingerprint.
 */
export interface CampaignReviewCandidateHashParams {
	campaignPeriodId: string;
	sourceSnapshotId: string;
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
	parserType: string | null;
	parserVersion: string | null;
	parserConfidence: number | null;
	proposedCardIds: string[];
}

export async function calculateCampaignReviewCandidateHash(
	params: CampaignReviewCandidateHashParams,
): Promise<string> {
	return sha256Hex([
		"campaign-review-candidate-hash-v1",
		params.campaignPeriodId.trim().toLowerCase(),
		params.sourceSnapshotId.trim().toLowerCase(),
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
		params.parserType,
		params.parserVersion,
		params.parserConfidence,
		[...params.proposedCardIds].map((id) => id.trim().toLowerCase()).sort(),
	]);
}

/**
 * Section K (Phase 16-R1): fingerprint for a review candidate's terminal
 * lifecycle revision (APPLY | DISMISS). Binds the candidate identity,
 * operation, the campaign's expectedRevisionNo the caller applied against
 * (APPLY-only OCC; null for DISMISS), occurredAt, and an optional note.
 */
export interface CampaignReviewCandidateLifecycleFingerprintParams {
	userId: string;
	candidateId: string;
	operation: string;
	expectedCampaignRevisionNo: number | null;
	occurredAt: Date;
	note: string | null;
}

export async function calculateCampaignReviewCandidateLifecycleFingerprint(
	params: CampaignReviewCandidateLifecycleFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-review-candidate-lifecycle-v1",
		params.userId.trim().toLowerCase(),
		params.candidateId.trim().toLowerCase(),
		params.operation,
		params.expectedCampaignRevisionNo,
		params.occurredAt.toISOString(),
		params.note,
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
	/**
	 * Section M (Phase 16-R1): the OCC expectedRevisionNo the caller bound
	 * this request to. Binding it means the same idempotency key retried
	 * against a different expectedRevisionNo (even with byte-identical other
	 * fields) produces a different fingerprint -- CAMPAIGN_IDEMPOTENCY_CONFLICT
	 * rather than a silent replay of a stale intent.
	 */
	expectedRevisionNo: number;
}

export async function calculateCampaignOverrideFingerprint(
	params: CampaignOverrideFingerprintParams,
): Promise<string> {
	return sha256Hex([
		"campaign-purchase-override-v2",
		params.userId.trim().toLowerCase(),
		params.campaignPeriodId.trim().toLowerCase(),
		params.purchaseEventId.trim().toLowerCase(),
		params.operation,
		params.reasonNote,
		params.occurredAt.toISOString(),
		params.expectedRevisionNo,
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
