export type CreditCardErrorCode =
	| "CREDIT_CARD_INVALID_INPUT"
	| "CREDIT_CARD_NOT_FOUND"
	| "CREDIT_CARD_NOT_ACTIVE"
	| "CREDIT_CARD_CONFLICT"
	| "CREDIT_CARD_REVISION_CONFLICT"
	| "CREDIT_CARD_STATEMENT_NOT_FOUND"
	| "CREDIT_CARD_STATEMENT_PERIOD_CONFLICT"
	| "CREDIT_CARD_STATEMENT_NOT_OPEN"
	| "CREDIT_CARD_STATEMENT_REVISION_CONFLICT"
	| "CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY"
	| "CREDIT_CARD_RESERVE_CONFLICT"
	| "CREDIT_CARD_IDEMPOTENCY_CONFLICT"
	| "CREDIT_CARD_INVALID_STATE";

export class CreditCardError extends Error {
	readonly code: CreditCardErrorCode;

	constructor(code: CreditCardErrorCode, message: string) {
		super(message);
		this.name = "CreditCardError";
		this.code = code;
		Object.setPrototypeOf(this, CreditCardError.prototype);
	}
}
