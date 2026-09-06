import {
	type CreditCardPurchaseRecord,
	listCreditCardPurchasesInTransaction,
} from "../credit-cards/purchases";
import type { Database, DatabaseTransaction } from "../db/client";
import { runCampaignsReadTransaction } from "./boundary";
import { validateCampaignCanonicalUuid } from "./calendar";
import {
	formatCampaignCentsToMoney,
	formatCampaignPointUnitsToDecimal,
	parseCampaignAggregateMoneyString,
} from "./decimal";
import { CampaignError } from "./errors";
import { resolveCanonicalMerchantNameInTransaction } from "./merchant";
import {
	applyPurchaseOverride,
	type CampaignOverrideOperation,
	type CampaignPurchaseEligibilityStatus,
	computeRuleProgress,
	deriveAutomaticEligibility,
	purchaseCountsTowardProgress,
} from "./rules";
import {
	getActiveCampaignRewardCreditInTransaction,
	getLatestRevisionInTransaction,
	listLatestCampaignPurchaseOverridesInTransaction,
} from "./service";

export type CampaignQualificationStatus =
	| "NOT_STARTED"
	| "IN_PROGRESS"
	| "QUALIFIED_AWAITING_CREDIT"
	| "REWARD_CREDITED";

export interface CampaignQualifyingPurchase {
	purchaseEventId: string;
	amount: string;
	purchaseDate: string | null;
	merchant: string | null;
	status: CampaignPurchaseEligibilityStatus;
}

export interface CampaignProgressReadModel {
	campaignPeriodId: string;
	lifecycleStatus: "REVIEW_REQUIRED" | "ACTIVE" | "ENDED" | "CANCELLED";
	visibility: "VISIBLE" | "HIDDEN";
	startsOn: string;
	endsOn: string;
	ruleMode: "TOTAL_SPEND" | "TRANSACTION_COUNT" | "REPEATABLE_SPEND";
	eligibleSpend: string;
	eligibleTransactionCount: number;
	requiredSpend: string | null;
	requiredTransactionCount: number | null;
	stepsEarned: number | null;
	maxSteps: number | null;
	progressNumerator: string;
	progressDenominator: string | null;
	progressPercentage: number | null;
	qualificationStatus: CampaignQualificationStatus;
	expectedRewardKind: "REWARD_POINTS" | "STATEMENT_CREDIT" | "INFORMATIONAL";
	expectedRewardPoints: string | null;
	actualRewardPointsCredited: string | null;
	needsReviewCount: number;
	needsReviewAmount: string;
	qualifyingPurchases: CampaignQualifyingPurchase[];
	needsReviewPurchases: CampaignQualifyingPurchase[];
}

async function computeProgressInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	campaignPeriodId: string,
): Promise<CampaignProgressReadModel> {
	const latest = await getLatestRevisionInTransaction(
		tx,
		userId,
		campaignPeriodId,
	);
	if (!latest) {
		throw new CampaignError(
			"CAMPAIGN_NOT_FOUND",
			`Campaign period "${campaignPeriodId}" not found`,
		);
	}
	const rev = latest.row;

	const overridesByPurchase =
		await listLatestCampaignPurchaseOverridesInTransaction(
			tx,
			campaignPeriodId,
		);

	const allPurchases: CreditCardPurchaseRecord[] = [];
	for (const cardId of latest.cardIds) {
		const purchases = await listCreditCardPurchasesInTransaction({
			tx,
			userId,
			cardId,
			status: "POSTED",
			purchaseDateFrom: rev.startsOn,
			purchaseDateUntil: rev.endsOn,
			limit: 1000,
		});
		allPurchases.push(...purchases.filter((p) => p.eventType === "PURCHASE"));
	}

	const requiredCanonicalMerchantNames = new Set(
		(rev.requiredCanonicalMerchantNames as string[] | null) ?? [],
	);
	const mccRequired =
		Array.isArray(rev.allowedMccCodes) && rev.allowedMccCodes.length > 0;
	const minimumTransactionAmountCents = rev.minimumTransactionAmount
		? parseCampaignAggregateMoneyString(rev.minimumTransactionAmount).cents
		: null;

	const qualifying: CampaignQualifyingPurchase[] = [];
	const needsReview: CampaignQualifyingPurchase[] = [];
	const countedAmountsCents: bigint[] = [];
	let needsReviewCents = 0n;

	for (const purchase of allPurchases) {
		const amountCents = parseCampaignAggregateMoneyString(
			purchase.amount,
		).cents;

		let merchantResolvedMatch: boolean | null = null;
		if (rev.merchantScopeMode === "MERCHANT_ALIASES") {
			const canonical = await resolveCanonicalMerchantNameInTransaction(
				tx,
				userId,
				purchase.merchant,
			);
			merchantResolvedMatch =
				canonical !== null && requiredCanonicalMerchantNames.has(canonical);
		}

		const automatic = deriveAutomaticEligibility({
			merchantScopeMode: rev.merchantScopeMode as
				| "ALL_MERCHANTS"
				| "MERCHANT_ALIASES"
				| "MANUAL_REVIEW_REQUIRED",
			merchantResolvedMatch,
			mccRequired,
			amountCents,
			minimumTransactionAmountCents,
		});

		const overrideOp = (overridesByPurchase.get(purchase.eventId) ??
			null) as CampaignOverrideOperation | null;
		const finalStatus = applyPurchaseOverride(
			automatic,
			overrideOp === "CLEAR" ? null : overrideOp,
		);

		const entry: CampaignQualifyingPurchase = {
			purchaseEventId: purchase.eventId,
			amount: purchase.amount,
			purchaseDate: purchase.purchaseDate,
			merchant: purchase.merchant,
			status: finalStatus,
		};

		if (purchaseCountsTowardProgress(finalStatus)) {
			qualifying.push(entry);
			countedAmountsCents.push(amountCents);
		} else if (finalStatus === "NEEDS_REVIEW") {
			needsReview.push(entry);
			needsReviewCents += amountCents;
		}
	}

	const targetSpendAmountCents = rev.targetSpendAmount
		? parseCampaignAggregateMoneyString(rev.targetSpendAmount).cents
		: null;
	const stepSpendAmountCents = rev.stepSpendAmount
		? parseCampaignAggregateMoneyString(rev.stepSpendAmount).cents
		: null;

	const ruleProgress = computeRuleProgress({
		ruleMode: rev.ruleMode as
			| "TOTAL_SPEND"
			| "TRANSACTION_COUNT"
			| "REPEATABLE_SPEND",
		countedAmountsCents,
		targetSpendAmountCents,
		requiredTransactionCount: rev.requiredTransactionCount,
		stepSpendAmountCents,
		maxSteps: rev.maxSteps,
	});

	const activeCredit = await getActiveCampaignRewardCreditInTransaction(
		tx,
		campaignPeriodId,
	);

	let qualificationStatus: CampaignQualificationStatus;
	if (activeCredit) {
		qualificationStatus = "REWARD_CREDITED";
	} else if (ruleProgress.qualified) {
		qualificationStatus = "QUALIFIED_AWAITING_CREDIT";
	} else if (
		ruleProgress.eligibleSpendCents === 0n &&
		ruleProgress.eligibleTransactionCount === 0
	) {
		qualificationStatus = "NOT_STARTED";
	} else {
		qualificationStatus = "IN_PROGRESS";
	}

	let expectedRewardPoints: string | null = rev.expectedRewardPoints;
	if (
		rev.rewardKind === "REWARD_POINTS" &&
		rev.ruleMode === "REPEATABLE_SPEND" &&
		rev.rewardPointsPerStep &&
		ruleProgress.stepsEarnedUnits !== null
	) {
		// Exact bigint derivation of per-step units from the decimal string --
		// never a float round-trip.
		const [intPart, fracPart = ""] = rev.rewardPointsPerStep.split(".");
		const fracPadded = fracPart.padEnd(4, "0").slice(0, 4);
		const exactPerStepUnits =
			BigInt(intPart ?? "0") * 10000n + BigInt(fracPadded || "0");
		const expectedUnits = ruleProgress.stepsEarnedUnits * exactPerStepUnits;
		expectedRewardPoints = formatCampaignPointUnitsToDecimal(expectedUnits);
	}

	let progressNumerator: string;
	let progressDenominator: string | null;
	let progressPercentage: number | null;

	if (rev.ruleMode === "TOTAL_SPEND") {
		progressNumerator = formatCampaignCentsToMoney(
			ruleProgress.eligibleSpendCents,
		);
		progressDenominator = rev.targetSpendAmount;
		progressPercentage =
			targetSpendAmountCents && targetSpendAmountCents > 0n
				? Math.min(
						100,
						Number(
							(ruleProgress.eligibleSpendCents * 10000n) /
								targetSpendAmountCents,
						) / 100,
					)
				: null;
	} else if (rev.ruleMode === "TRANSACTION_COUNT") {
		progressNumerator = String(ruleProgress.eligibleTransactionCount);
		progressDenominator =
			rev.requiredTransactionCount !== null
				? String(rev.requiredTransactionCount)
				: null;
		progressPercentage =
			rev.requiredTransactionCount && rev.requiredTransactionCount > 0
				? Math.min(
						100,
						(ruleProgress.eligibleTransactionCount /
							rev.requiredTransactionCount) *
							100,
					)
				: null;
	} else {
		progressNumerator = String(ruleProgress.stepsEarnedUnits ?? 0n);
		progressDenominator = rev.maxSteps !== null ? String(rev.maxSteps) : null;
		progressPercentage =
			rev.maxSteps && rev.maxSteps > 0 && ruleProgress.stepsEarnedUnits !== null
				? Math.min(
						100,
						(Number(ruleProgress.stepsEarnedUnits) / rev.maxSteps) * 100,
					)
				: null;
	}

	return {
		campaignPeriodId,
		lifecycleStatus: rev.lifecycleStatus as
			| "REVIEW_REQUIRED"
			| "ACTIVE"
			| "ENDED"
			| "CANCELLED",
		visibility: rev.visibility as "VISIBLE" | "HIDDEN",
		startsOn: rev.startsOn,
		endsOn: rev.endsOn,
		ruleMode: rev.ruleMode as
			| "TOTAL_SPEND"
			| "TRANSACTION_COUNT"
			| "REPEATABLE_SPEND",
		eligibleSpend: formatCampaignCentsToMoney(ruleProgress.eligibleSpendCents),
		eligibleTransactionCount: ruleProgress.eligibleTransactionCount,
		requiredSpend: rev.targetSpendAmount,
		requiredTransactionCount: rev.requiredTransactionCount,
		stepsEarned:
			ruleProgress.stepsEarnedUnits !== null
				? Number(ruleProgress.stepsEarnedUnits)
				: null,
		maxSteps: rev.maxSteps,
		progressNumerator,
		progressDenominator,
		progressPercentage,
		qualificationStatus,
		expectedRewardKind: rev.rewardKind as
			| "REWARD_POINTS"
			| "STATEMENT_CREDIT"
			| "INFORMATIONAL",
		expectedRewardPoints,
		actualRewardPointsCredited: activeCredit?.actualPointAmount ?? null,
		needsReviewCount: needsReview.length,
		needsReviewAmount: formatCampaignCentsToMoney(needsReviewCents),
		qualifyingPurchases: qualifying,
		needsReviewPurchases: needsReview,
	};
}

export interface GetCampaignProgressParams {
	db: Database;
	userId: string;
	campaignPeriodId: string;
}

/**
 * Section 31: getCampaignProgress. Always derives live from the credit-card
 * purchase domain at read time -- no mutable "campaign accumulated spend"
 * column is ever consulted. Runs under REPEATABLE READ so every statement in
 * this multi-query computation observes one coherent snapshot.
 */
export async function getCampaignProgress(
	params: GetCampaignProgressParams,
): Promise<CampaignProgressReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const campaignPeriodId = validateCampaignCanonicalUuid(
		params.campaignPeriodId,
		"campaignPeriodId",
	);

	return runCampaignsReadTransaction(params.db, (tx) =>
		computeProgressInTransaction(tx, userId, campaignPeriodId),
	);
}
