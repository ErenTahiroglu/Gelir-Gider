import { describe, expect, it } from "vitest";
import {
	calculateCampaignOverrideFingerprint,
	calculateCampaignPeriodAmendFingerprint,
	calculateCampaignPeriodCreateRequestFingerprint,
	calculateCampaignPeriodLifecycleFingerprint,
	calculateCampaignPeriodRevisionFingerprint,
	calculateCampaignReviewCandidateHash,
	calculateCampaignRewardCreditFingerprint,
	calculateCampaignSourceContentHash,
} from "../src/campaigns/fingerprint";

const baseRevisionParams = {
	userId: "11111111-1111-1111-1111-111111111111",
	campaignPeriodId: "22222222-2222-2222-2222-222222222222",
	title: "Back to School",
	startsOn: "2024-09-01",
	endsOn: "2024-09-30",
	ruleMode: "TOTAL_SPEND",
	targetSpendAmount: "5000.00",
	requiredTransactionCount: null,
	minimumTransactionAmount: null,
	stepSpendAmount: null,
	rewardPointsPerStep: null,
	maxSteps: null,
	rewardKind: "REWARD_POINTS",
	rewardAccountId: "33333333-3333-3333-3333-333333333333",
	expectedRewardPoints: "500.0000",
	merchantScopeMode: "ALL_MERCHANTS",
	requiredCanonicalMerchantNames: null,
	allowedMccCodes: null,
	rewardExpiryDate: null,
	cardIds: ["44444444-4444-4444-4444-444444444444"] as string[],
	sourceSnapshotId: null,
	note: null,
	occurredAt: new Date("2024-09-01T00:00:00Z"),
};

describe("calculateCampaignPeriodRevisionFingerprint", () => {
	it("is deterministic for identical input", async () => {
		const a = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			baseRevisionParams,
		);
		const b = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			baseRevisionParams,
		);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when the reward amount changes", async () => {
		const a = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			baseRevisionParams,
		);
		const b = await calculateCampaignPeriodRevisionFingerprint("CREATE", {
			...baseRevisionParams,
			expectedRewardPoints: "600.0000",
		});
		expect(a).not.toBe(b);
	});

	it("changes when the card scope changes", async () => {
		const a = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			baseRevisionParams,
		);
		const b = await calculateCampaignPeriodRevisionFingerprint("CREATE", {
			...baseRevisionParams,
			cardIds: ["55555555-5555-5555-5555-555555555555"],
		});
		expect(a).not.toBe(b);
	});

	it("card scope order does not affect the fingerprint (set semantics)", async () => {
		const a = await calculateCampaignPeriodRevisionFingerprint("CREATE", {
			...baseRevisionParams,
			cardIds: [
				"44444444-4444-4444-4444-444444444444",
				"55555555-5555-5555-5555-555555555555",
			],
		});
		const b = await calculateCampaignPeriodRevisionFingerprint("CREATE", {
			...baseRevisionParams,
			cardIds: [
				"55555555-5555-5555-5555-555555555555",
				"44444444-4444-4444-4444-444444444444",
			],
		});
		expect(a).toBe(b);
	});

	it("changes when the operation changes (CREATE vs AMEND)", async () => {
		const a = await calculateCampaignPeriodRevisionFingerprint(
			"CREATE",
			baseRevisionParams,
		);
		const b = await calculateCampaignPeriodRevisionFingerprint(
			"AMEND",
			baseRevisionParams,
		);
		expect(a).not.toBe(b);
	});
});

describe("calculateCampaignPeriodLifecycleFingerprint", () => {
	it("changes when the operation changes even with identical other fields", async () => {
		const params = {
			userId: baseRevisionParams.userId,
			campaignPeriodId: baseRevisionParams.campaignPeriodId,
			expectedRevisionNo: 1,
			occurredAt: baseRevisionParams.occurredAt,
			note: null,
		};
		const confirm = await calculateCampaignPeriodLifecycleFingerprint({
			...params,
			operation: "CONFIRM",
		});
		const hide = await calculateCampaignPeriodLifecycleFingerprint({
			...params,
			operation: "HIDE",
		});
		expect(confirm).not.toBe(hide);
	});
});

describe("calculateCampaignOverrideFingerprint", () => {
	const overrideBase = {
		userId: baseRevisionParams.userId,
		campaignPeriodId: baseRevisionParams.campaignPeriodId,
		purchaseEventId: "66666666-6666-6666-6666-666666666666",
		reasonNote: null,
		occurredAt: baseRevisionParams.occurredAt,
		expectedRevisionNo: 0,
	};

	it("changes when the operation changes (INCLUDE vs EXCLUDE)", async () => {
		const include = await calculateCampaignOverrideFingerprint({
			...overrideBase,
			operation: "INCLUDE",
		});
		const exclude = await calculateCampaignOverrideFingerprint({
			...overrideBase,
			operation: "EXCLUDE",
		});
		expect(include).not.toBe(exclude);
	});

	it("changes when expectedRevisionNo differs (OCC binding, Section M)", async () => {
		const a = await calculateCampaignOverrideFingerprint({
			...overrideBase,
			operation: "INCLUDE",
			expectedRevisionNo: 1,
		});
		const b = await calculateCampaignOverrideFingerprint({
			...overrideBase,
			operation: "INCLUDE",
			expectedRevisionNo: 2,
		});
		expect(a).not.toBe(b);
	});
});

describe("calculateCampaignPeriodCreateRequestFingerprint (Section A/C)", () => {
	const createParams = {
		userId: baseRevisionParams.userId,
		provider: "AKBANK",
		familyKey: "back-to-school",
		periodKey: "2024-09",
		title: baseRevisionParams.title,
		startsOn: baseRevisionParams.startsOn,
		endsOn: baseRevisionParams.endsOn,
		ruleMode: baseRevisionParams.ruleMode,
		targetSpendAmount: baseRevisionParams.targetSpendAmount,
		requiredTransactionCount: baseRevisionParams.requiredTransactionCount,
		minimumTransactionAmount: baseRevisionParams.minimumTransactionAmount,
		stepSpendAmount: baseRevisionParams.stepSpendAmount,
		rewardPointsPerStep: baseRevisionParams.rewardPointsPerStep,
		maxSteps: baseRevisionParams.maxSteps,
		rewardKind: baseRevisionParams.rewardKind,
		rewardAccountId: baseRevisionParams.rewardAccountId,
		expectedRewardPoints: baseRevisionParams.expectedRewardPoints,
		merchantScopeMode: baseRevisionParams.merchantScopeMode,
		requiredCanonicalMerchantNames:
			baseRevisionParams.requiredCanonicalMerchantNames,
		allowedMccCodes: baseRevisionParams.allowedMccCodes,
		rewardExpiryDate: baseRevisionParams.rewardExpiryDate,
		cardIds: baseRevisionParams.cardIds,
		sourceSnapshotId: baseRevisionParams.sourceSnapshotId,
		parserType: null,
		parserVersion: null,
		parserConfidence: null,
		note: baseRevisionParams.note,
		occurredAt: baseRevisionParams.occurredAt,
	};

	it("does not depend on any generated id -- identical for two calls", async () => {
		const a =
			await calculateCampaignPeriodCreateRequestFingerprint(createParams);
		const b =
			await calculateCampaignPeriodCreateRequestFingerprint(createParams);
		expect(a).toBe(b);
	});

	it("changes when provider/familyKey/periodKey identity changes", async () => {
		const a =
			await calculateCampaignPeriodCreateRequestFingerprint(createParams);
		const b = await calculateCampaignPeriodCreateRequestFingerprint({
			...createParams,
			periodKey: "2024-10",
		});
		expect(a).not.toBe(b);
	});

	it("changes when parser provenance changes", async () => {
		const a =
			await calculateCampaignPeriodCreateRequestFingerprint(createParams);
		const b = await calculateCampaignPeriodCreateRequestFingerprint({
			...createParams,
			parserType: "html-table",
			parserVersion: "1.0.0",
		});
		expect(a).not.toBe(b);
	});
});

describe("calculateCampaignPeriodAmendFingerprint (Section C)", () => {
	const amendParams = {
		userId: baseRevisionParams.userId,
		campaignPeriodId: baseRevisionParams.campaignPeriodId,
		expectedRevisionNo: 2,
		title: baseRevisionParams.title,
		startsOn: baseRevisionParams.startsOn,
		endsOn: baseRevisionParams.endsOn,
		ruleMode: baseRevisionParams.ruleMode,
		targetSpendAmount: baseRevisionParams.targetSpendAmount,
		requiredTransactionCount: baseRevisionParams.requiredTransactionCount,
		minimumTransactionAmount: baseRevisionParams.minimumTransactionAmount,
		stepSpendAmount: baseRevisionParams.stepSpendAmount,
		rewardPointsPerStep: baseRevisionParams.rewardPointsPerStep,
		maxSteps: baseRevisionParams.maxSteps,
		rewardKind: baseRevisionParams.rewardKind,
		rewardAccountId: baseRevisionParams.rewardAccountId,
		expectedRewardPoints: baseRevisionParams.expectedRewardPoints,
		merchantScopeMode: baseRevisionParams.merchantScopeMode,
		requiredCanonicalMerchantNames:
			baseRevisionParams.requiredCanonicalMerchantNames,
		allowedMccCodes: baseRevisionParams.allowedMccCodes,
		rewardExpiryDate: baseRevisionParams.rewardExpiryDate,
		cardIds: baseRevisionParams.cardIds,
		sourceSnapshotId: baseRevisionParams.sourceSnapshotId,
		parserType: null,
		parserVersion: null,
		parserConfidence: null,
		note: baseRevisionParams.note,
		occurredAt: baseRevisionParams.occurredAt,
	};

	it("changes when expectedRevisionNo differs even with byte-identical terms", async () => {
		const a = await calculateCampaignPeriodAmendFingerprint(amendParams);
		const b = await calculateCampaignPeriodAmendFingerprint({
			...amendParams,
			expectedRevisionNo: 3,
		});
		expect(a).not.toBe(b);
	});
});

describe("calculateCampaignReviewCandidateHash (Section K)", () => {
	const hashParams = {
		campaignPeriodId: baseRevisionParams.campaignPeriodId,
		sourceSnapshotId: "77777777-7777-7777-7777-777777777777",
		title: baseRevisionParams.title,
		startsOn: baseRevisionParams.startsOn,
		endsOn: baseRevisionParams.endsOn,
		ruleMode: baseRevisionParams.ruleMode,
		targetSpendAmount: baseRevisionParams.targetSpendAmount,
		requiredTransactionCount: baseRevisionParams.requiredTransactionCount,
		minimumTransactionAmount: baseRevisionParams.minimumTransactionAmount,
		stepSpendAmount: baseRevisionParams.stepSpendAmount,
		rewardPointsPerStep: baseRevisionParams.rewardPointsPerStep,
		maxSteps: baseRevisionParams.maxSteps,
		rewardKind: baseRevisionParams.rewardKind,
		rewardAccountId: baseRevisionParams.rewardAccountId,
		expectedRewardPoints: baseRevisionParams.expectedRewardPoints,
		merchantScopeMode: baseRevisionParams.merchantScopeMode,
		requiredCanonicalMerchantNames:
			baseRevisionParams.requiredCanonicalMerchantNames,
		allowedMccCodes: baseRevisionParams.allowedMccCodes,
		rewardExpiryDate: baseRevisionParams.rewardExpiryDate,
		parserType: null,
		parserVersion: null,
		parserConfidence: null,
		proposedCardIds: baseRevisionParams.cardIds,
	};

	it("is identical for identical proposed terms (dedup key)", async () => {
		const a = await calculateCampaignReviewCandidateHash(hashParams);
		const b = await calculateCampaignReviewCandidateHash(hashParams);
		expect(a).toBe(b);
	});

	it("changes when the proposed reward amount differs", async () => {
		const a = await calculateCampaignReviewCandidateHash(hashParams);
		const b = await calculateCampaignReviewCandidateHash({
			...hashParams,
			expectedRewardPoints: "999.0000",
		});
		expect(a).not.toBe(b);
	});
});

describe("calculateCampaignRewardCreditFingerprint", () => {
	it("changes when the actual point amount differs from a prior confirm", async () => {
		const params = {
			userId: baseRevisionParams.userId,
			campaignPeriodId: baseRevisionParams.campaignPeriodId,
			operation: "CREATE",
			rewardAccountId: baseRevisionParams.rewardAccountId,
			expectedPointAmount: "500.0000",
			reasonNote: null,
			occurredAt: baseRevisionParams.occurredAt,
		};
		const a = await calculateCampaignRewardCreditFingerprint({
			...params,
			actualPointAmount: "500.0000",
		});
		const b = await calculateCampaignRewardCreditFingerprint({
			...params,
			actualPointAmount: "450.0000",
		});
		expect(a).not.toBe(b);
	});
});

describe("calculateCampaignSourceContentHash", () => {
	it("is identical for identical content (dedup key)", async () => {
		const params = {
			sourceType: "OFFICIAL_PUBLIC_PAGE",
			sourceUrl: "https://bank.example/campaign",
			externalSourceId: "camp-123",
			sourceTitle: "Back to School",
			sourceText: "Spend 5000 TL, get 500 points",
		};
		const a = await calculateCampaignSourceContentHash(params);
		const b = await calculateCampaignSourceContentHash(params);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when the reward amount in the source text changes", async () => {
		const a = await calculateCampaignSourceContentHash({
			sourceType: "OFFICIAL_PUBLIC_PAGE",
			sourceUrl: "https://bank.example/campaign",
			externalSourceId: "camp-123",
			sourceTitle: "Back to School",
			sourceText: "Spend 5000 TL, get 500 points",
		});
		const b = await calculateCampaignSourceContentHash({
			sourceType: "OFFICIAL_PUBLIC_PAGE",
			sourceUrl: "https://bank.example/campaign",
			externalSourceId: "camp-123",
			sourceTitle: "Back to School",
			sourceText: "Spend 5000 TL, get 700 points",
		});
		expect(a).not.toBe(b);
	});
});
