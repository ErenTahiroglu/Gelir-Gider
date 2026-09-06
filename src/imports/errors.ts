export const IMPORT_ERROR_CODES = [
	"IMPORT_INVALID_INPUT",
	"IMPORT_BATCH_NOT_FOUND",
	"IMPORT_ROW_NOT_FOUND",
	"IMPORT_REVISION_CONFLICT",
	"IMPORT_IDEMPOTENCY_CONFLICT",
	"IMPORT_NEEDS_REVIEW",
	"IMPORT_POSSIBLE_DUPLICATE",
	"IMPORT_EXACT_DUPLICATE",
	"IMPORT_UNSUPPORTED_RECORD",
	"IMPORT_TARGET_NOT_FOUND",
	"IMPORT_TARGET_MISMATCH",
	"IMPORT_MISSING_CARD_MAPPING",
	"IMPORT_MISSING_INCOME_MAPPING",
	"IMPORT_MISSING_EXPENSE_MAPPING",
	"IMPORT_INVALID_STATE",
	"IMPORT_DATABASE_ERROR",
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export class ImportError extends Error {
	readonly code: ImportErrorCode;
	readonly details?: Record<string, unknown> | undefined;

	constructor(
		code: ImportErrorCode,
		message: string,
		details?: Record<string, unknown> | undefined,
	) {
		super(message);
		this.name = "ImportError";
		this.code = code;
		this.details = details;
		Object.setPrototypeOf(this, ImportError.prototype);
	}
}
