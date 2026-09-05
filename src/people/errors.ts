export type PeopleErrorCode =
	| "PEOPLE_INVALID_INPUT"
	| "PEOPLE_NOT_FOUND"
	| "PEOPLE_NOT_ACTIVE"
	| "PEOPLE_REVISION_CONFLICT"
	| "PEOPLE_OBLIGATION_NOT_FOUND"
	| "PEOPLE_OBLIGATION_NOT_ACTIVE"
	| "PEOPLE_OBLIGATION_REVISION_CONFLICT"
	| "PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT"
	| "PEOPLE_OBLIGATION_OVERSETTLEMENT"
	| "PEOPLE_SETTLEMENT_NOT_FOUND"
	| "PEOPLE_IDEMPOTENCY_CONFLICT"
	| "PEOPLE_LEDGER_ACCOUNT_INVALID"
	| "PEOPLE_INVALID_STATE";

export class PeopleError extends Error {
	readonly code: PeopleErrorCode;

	constructor(code: PeopleErrorCode, message: string) {
		super(message);
		this.name = "PeopleError";
		this.code = code;
		Object.setPrototypeOf(this, PeopleError.prototype);
	}
}
