export const MANUAL_EXPENSE_ERROR_CODES = [
	"MANUAL_EXPENSE_NOT_FOUND",
	"MANUAL_EXPENSE_INVALID_INPUT",
	"MANUAL_EXPENSE_CONFLICT",
	"MANUAL_EXPENSE_REVISION_CONFLICT",
	"MANUAL_EXPENSE_IDEMPOTENCY_CONFLICT",
	"MANUAL_EXPENSE_ALREADY_VOID",
	"MANUAL_EXPENSE_UNAUTHORIZED",
] as const;

export type ManualExpenseErrorCode =
	(typeof MANUAL_EXPENSE_ERROR_CODES)[number];

export class ManualExpenseError extends Error {
	readonly code: ManualExpenseErrorCode;
	readonly status: number;

	constructor(code: ManualExpenseErrorCode, message: string) {
		super(message);
		this.name = "ManualExpenseError";
		this.code = code;
		switch (code) {
			case "MANUAL_EXPENSE_NOT_FOUND":
				this.status = 404;
				break;
			case "MANUAL_EXPENSE_UNAUTHORIZED":
				this.status = 403;
				break;
			case "MANUAL_EXPENSE_CONFLICT":
			case "MANUAL_EXPENSE_REVISION_CONFLICT":
			case "MANUAL_EXPENSE_IDEMPOTENCY_CONFLICT":
			case "MANUAL_EXPENSE_ALREADY_VOID":
				this.status = 409;
				break;
			case "MANUAL_EXPENSE_INVALID_INPUT":
			default:
				this.status = 400;
				break;
		}
	}
}
