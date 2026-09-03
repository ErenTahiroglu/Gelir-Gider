export type LedgerErrorCode =
	| "INVALID_MONEY"
	| "LEDGER_INVALID_ENTRY"
	| "LEDGER_UNBALANCED"
	| "LEDGER_ACCOUNT_NOT_FOUND"
	| "LEDGER_ACCOUNT_ARCHIVED"
	| "LEDGER_ACCOUNT_CODE_CONFLICT"
	| "LEDGER_IDEMPOTENCY_CONFLICT"
	| "LEDGER_INCOMPLETE_STATE"
	| "LEDGER_USER_NOT_FOUND"
	| "LEDGER_CURRENCY_MISMATCH"
	| "LEDGER_ENTRY_NOT_FOUND"
	| "LEDGER_ALREADY_REVERSED"
	| "LEDGER_INVALID_REVERSAL";

export class LedgerError extends Error {
	readonly code: LedgerErrorCode;

	constructor(code: LedgerErrorCode, message: string) {
		super(message);
		this.name = "LedgerError";
		this.code = code;
		Object.setPrototypeOf(this, LedgerError.prototype);
	}
}
