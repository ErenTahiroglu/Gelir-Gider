export const MONTH_CLOSE_ERROR_CODES = [
	"MONTH_CLOSE_INVALID_INPUT",
	"MONTH_CLOSE_PERIOD_NOT_ENDED",
	"MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND",
	"MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE",
	"MONTH_CLOSE_UNCLASSIFIED_EXPENSES",
	"MONTH_CLOSE_MIDAS_NOT_FOUND",
	"MONTH_CLOSE_INSUFFICIENT_LIQUIDITY",
	"MONTH_CLOSE_STALE_PROPOSAL",
	"MONTH_CLOSE_ALREADY_CLOSED",
	"MONTH_CLOSE_IDEMPOTENCY_CONFLICT",
	"MONTH_CLOSE_INVALID_STATE",
] as const;

export type MonthCloseErrorCode = (typeof MONTH_CLOSE_ERROR_CODES)[number];

export class MonthCloseError extends Error {
	readonly code: MonthCloseErrorCode;

	constructor(code: MonthCloseErrorCode, message: string) {
		super(message);
		this.name = "MonthCloseError";
		this.code = code;
		Object.setPrototypeOf(this, MonthCloseError.prototype);
	}
}
