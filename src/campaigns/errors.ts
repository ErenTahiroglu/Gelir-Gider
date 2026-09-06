export const CAMPAIGN_ERROR_CODES = [
	"CAMPAIGN_INVALID_INPUT",
	"CAMPAIGN_NOT_FOUND",
	"CAMPAIGN_NOT_ACTIVE",
	"CAMPAIGN_REVIEW_REQUIRED",
	"CAMPAIGN_REVISION_CONFLICT",
	"CAMPAIGN_IDEMPOTENCY_CONFLICT",
	"CAMPAIGN_INVALID_RULE",
	"CAMPAIGN_PURCHASE_NOT_FOUND",
	"CAMPAIGN_PURCHASE_NEEDS_REVIEW",
	"CAMPAIGN_NOT_QUALIFIED",
	"CAMPAIGN_REWARD_ALREADY_CREDITED",
	"CAMPAIGN_INVALID_STATE",
] as const;

export type CampaignErrorCode = (typeof CAMPAIGN_ERROR_CODES)[number];

export class CampaignError extends Error {
	readonly code: CampaignErrorCode;

	constructor(code: CampaignErrorCode, message: string) {
		super(message);
		this.name = "CampaignError";
		this.code = code;
		Object.setPrototypeOf(this, CampaignError.prototype);
	}
}
