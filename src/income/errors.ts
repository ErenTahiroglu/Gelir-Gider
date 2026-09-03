export type IncomeErrorCode =
	| "INCOME_INVALID_INPUT"
	| "INCOME_SOURCE_NOT_FOUND"
	| "INCOME_SOURCE_ARCHIVED"
	| "INCOME_SOURCE_CODE_CONFLICT"
	| "INCOME_LEDGER_ACCOUNT_INVALID"
	| "INCOME_DESTINATION_ACCOUNT_INVALID"
	| "INCOME_RECEIPT_NOT_FOUND"
	| "INCOME_RECEIPT_INVALID_STATE"
	| "INCOME_IDEMPOTENCY_CONFLICT"
	| "INCOME_REFERENCE_INVALID_STATE";

export class IncomeError extends Error {
	readonly code: IncomeErrorCode;

	constructor(code: IncomeErrorCode, message: string) {
		super(message);
		this.name = "IncomeError";
		this.code = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
