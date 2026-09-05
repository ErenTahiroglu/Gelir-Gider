export type MidasErrorCode =
	| "MIDAS_INVALID_INPUT"
	| "MIDAS_ACCOUNT_NOT_FOUND"
	| "MIDAS_ACCOUNT_CONFLICT"
	| "MIDAS_LEDGER_ACCOUNT_INVALID"
	| "MIDAS_BUCKET_NOT_FOUND"
	| "MIDAS_BUCKET_CONFLICT"
	| "MIDAS_INSUFFICIENT_FREE_BALANCE"
	| "MIDAS_INSUFFICIENT_BUCKET_BALANCE"
	| "MIDAS_IDEMPOTENCY_CONFLICT"
	| "MIDAS_TRANSFER_NOT_FOUND"
	| "MIDAS_TRANSFER_ALREADY_REVERSED"
	| "MIDAS_BUCKET_INACTIVE"
	| "MIDAS_BUCKET_CAP_EXCEEDED"
	| "MIDAS_LONG_TERM_BUCKET_RESTRICTED"
	| "MIDAS_INVALID_STATE";

export class MidasError extends Error {
	readonly code: MidasErrorCode;

	constructor(code: MidasErrorCode, message: string) {
		super(message);
		this.name = "MidasError";
		this.code = code;
		Object.setPrototypeOf(this, MidasError.prototype);
	}
}
