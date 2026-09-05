export const LONG_TERM_ERROR_CODES = [
	"LONG_TERM_INVALID_INPUT",
	"LONG_TERM_TASK_NOT_FOUND",
	"LONG_TERM_TASK_NOT_PENDING",
	"LONG_TERM_TASK_NOT_SENT",
	"LONG_TERM_TASK_CANCELLED",
	"LONG_TERM_REVISION_CONFLICT",
	"LONG_TERM_IDEMPOTENCY_CONFLICT",
	"LONG_TERM_INSUFFICIENT_UNALLOCATED",
	"LONG_TERM_INVALID_STATE",
] as const;

export type LongTermErrorCode = (typeof LONG_TERM_ERROR_CODES)[number];

export class LongTermError extends Error {
	readonly code: LongTermErrorCode;

	constructor(code: LongTermErrorCode, message: string) {
		super(message);
		this.name = "LongTermError";
		this.code = code;
		Object.setPrototypeOf(this, LongTermError.prototype);
	}
}
