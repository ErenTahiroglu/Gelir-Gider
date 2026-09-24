export const QUICK_ENTRY_TEMPLATE_ERROR_CODES = [
	"QUICK_ENTRY_TEMPLATE_NOT_FOUND",
	"QUICK_ENTRY_TEMPLATE_INVALID_INPUT",
	"QUICK_ENTRY_TEMPLATE_CONFLICT",
	"QUICK_ENTRY_TEMPLATE_UNAUTHORIZED",
] as const;

export type QuickEntryTemplateErrorCode =
	(typeof QUICK_ENTRY_TEMPLATE_ERROR_CODES)[number];

export class QuickEntryTemplateError extends Error {
	readonly code: QuickEntryTemplateErrorCode;
	readonly status: number;

	constructor(code: QuickEntryTemplateErrorCode, message: string) {
		super(message);
		this.name = "QuickEntryTemplateError";
		this.code = code;
		switch (code) {
			case "QUICK_ENTRY_TEMPLATE_NOT_FOUND":
				this.status = 404;
				break;
			case "QUICK_ENTRY_TEMPLATE_UNAUTHORIZED":
				this.status = 403;
				break;
			case "QUICK_ENTRY_TEMPLATE_CONFLICT":
				this.status = 409;
				break;
			case "QUICK_ENTRY_TEMPLATE_INVALID_INPUT":
			default:
				this.status = 400;
				break;
		}
	}
}
