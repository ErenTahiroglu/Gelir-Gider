export const REWARD_ERROR_CODES = [
	"REWARD_INVALID_INPUT",
	"REWARD_ACCOUNT_NOT_FOUND",
	"REWARD_ACCOUNT_NOT_ACTIVE",
	"REWARD_ACCOUNT_CONFLICT",
	"REWARD_ACCOUNT_REVISION_CONFLICT",
	"REWARD_EVENT_NOT_FOUND",
	"REWARD_EVENT_NOT_ACTIVE",
	"REWARD_EVENT_CONFLICT",
	"REWARD_EVENT_REVISION_CONFLICT",
	"REWARD_IDEMPOTENCY_CONFLICT",
	"REWARD_INSUFFICIENT_POINTS",
	"REWARD_INVALID_STATE",
] as const;

export type RewardErrorCode = (typeof REWARD_ERROR_CODES)[number];

export class RewardError extends Error {
	readonly code: RewardErrorCode;

	constructor(code: RewardErrorCode, message: string) {
		super(message);
		this.name = "RewardError";
		this.code = code;
		Object.setPrototypeOf(this, RewardError.prototype);
	}
}
