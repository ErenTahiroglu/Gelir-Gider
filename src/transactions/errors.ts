export type CanonicalTransactionErrorCode =
	| "TRANSACTION_INVALID_INPUT"
	| "TRANSACTION_NOT_FOUND"
	| "TRANSACTION_IDEMPOTENCY_CONFLICT"
	| "TRANSACTION_REVISION_CONFLICT"
	| "TRANSACTION_ALREADY_VOIDED"
	| "TRANSACTION_INVALID_STATE"
	| "TRANSACTION_SOURCE_CONFLICT"
	| "TRANSACTION_PAYLOAD_INVALID";

export class CanonicalTransactionError extends Error {
	readonly code: CanonicalTransactionErrorCode;

	constructor(code: CanonicalTransactionErrorCode, message: string) {
		super(message);
		this.name = "CanonicalTransactionError";
		this.code = code;
		Object.setPrototypeOf(this, CanonicalTransactionError.prototype);
	}
}
