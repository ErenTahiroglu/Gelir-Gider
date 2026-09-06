import { parseMoneyString, parsePositiveMoneyString } from "../ledger/money";
import { parsePointQuantity } from "../rewards/decimal";
import { CampaignError } from "./errors";

/**
 * Parses a strictly positive campaign money string (NUMERIC(18,2) DB
 * contract), reusing the exact same bigint-cents-based ledger money parser
 * used across every other money-handling domain in this codebase. Never uses
 * JS floating point.
 */
export function parseCampaignPositiveMoneyString(
	value: unknown,
	fieldName: string,
): { normalized: string; cents: bigint } {
	try {
		return parsePositiveMoneyString(value);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new CampaignError(
			"CAMPAIGN_INVALID_INPUT",
			`${fieldName}: ${message}`,
		);
	}
}

/**
 * Parses a campaign money string that may be omitted (returns null when
 * `undefined`/`null`), otherwise strictly positive.
 */
export function parseCampaignOptionalPositiveMoneyString(
	value: unknown,
	fieldName: string,
): { normalized: string; cents: bigint } | null {
	if (value === undefined || value === null) return null;
	return parseCampaignPositiveMoneyString(value, fieldName);
}

/**
 * Parses a non-negative campaign money aggregate string (used only for
 * reading back a SUM(...) style derived aggregate, never for user input).
 */
export function parseCampaignAggregateMoneyString(value: unknown): {
	normalized: string;
	cents: bigint;
} {
	try {
		return parseMoneyString(value);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new CampaignError("CAMPAIGN_INVALID_STATE", message);
	}
}

/**
 * Parses a strictly positive reward point quantity (NUMERIC(20,4) DB
 * contract), reusing the exact Phase 12 reward point-quantity parser.
 */
export function parseCampaignPointQuantity(
	value: unknown,
	fieldName = "pointAmount",
): { normalized: string; units: bigint } {
	try {
		return parsePointQuantity(value, fieldName);
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err) {
			throw new CampaignError("CAMPAIGN_INVALID_INPUT", err.message);
		}
		throw err;
	}
}

/**
 * Formats integer cents into an exact NUMERIC(18,2)-compatible decimal
 * string.
 */
export function formatCampaignCentsToMoney(cents: bigint): string {
	if (cents < 0n) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"Negative cents formatting is not supported for campaign money amounts",
		);
	}
	const intPart = cents / 100n;
	const frac = cents % 100n;
	const fracPart = frac < 10n ? `0${frac.toString()}` : frac.toString();
	return `${intPart.toString()}.${fracPart}`;
}

/**
 * Formats a bigint scaled by 10^4 back into a NUMERIC(20,4)-compatible
 * decimal string (reward point quantity).
 */
export function formatCampaignPointUnitsToDecimal(units: bigint): string {
	if (units < 0n) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"Negative point units are not supported",
		);
	}
	const digits = units.toString().padStart(5, "0");
	const intPart = digits.slice(0, digits.length - 4) || "0";
	const fracPart = digits.slice(digits.length - 4);
	return `${intPart}.${fracPart}`;
}

/**
 * Computes stepsEarned = min(floor(totalEligibleSpendCents / stepSpendCents),
 * maxSteps) using pure BigInt integer division -- never JS float. Both cent
 * amounts must be non-negative; stepSpendCents must be strictly positive.
 */
export function computeRepeatableStepsEarned(
	totalEligibleSpendCents: bigint,
	stepSpendCents: bigint,
	maxSteps: number,
): bigint {
	if (stepSpendCents <= 0n) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_RULE",
			"stepSpendAmount must be strictly positive",
		);
	}
	if (totalEligibleSpendCents < 0n) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"totalEligibleSpendCents must be non-negative",
		);
	}
	const rawSteps = totalEligibleSpendCents / stepSpendCents; // exact floor for non-negative bigints
	const cap = BigInt(maxSteps);
	return rawSteps > cap ? cap : rawSteps;
}

/**
 * Computes expected reward points for REPEATABLE_SPEND = stepsEarned *
 * rewardPointsPerStep, exact bigint (scale 4) arithmetic, never JS float.
 */
export function computeRepeatableExpectedPoints(
	stepsEarned: bigint,
	rewardPointsPerStepUnits: bigint,
): bigint {
	return stepsEarned * rewardPointsPerStepUnits;
}
