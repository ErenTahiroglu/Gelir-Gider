export const SPENDING_CATEGORY_ERROR_CODES = [
	"SPENDING_CATEGORY_NOT_FOUND",
	"SPENDING_CATEGORY_INVALID_INPUT",
	"SPENDING_CATEGORY_CONFLICT",
	"SPENDING_CATEGORY_UNAUTHORIZED",
] as const;

export type SpendingCategoryErrorCode =
	(typeof SPENDING_CATEGORY_ERROR_CODES)[number];

export class SpendingCategoryError extends Error {
	readonly code: SpendingCategoryErrorCode;
	readonly status: number;

	constructor(code: SpendingCategoryErrorCode, message: string) {
		super(message);
		this.name = "SpendingCategoryError";
		this.code = code;
		switch (code) {
			case "SPENDING_CATEGORY_NOT_FOUND":
				this.status = 404;
				break;
			case "SPENDING_CATEGORY_UNAUTHORIZED":
				this.status = 403;
				break;
			case "SPENDING_CATEGORY_CONFLICT":
				this.status = 409;
				break;
			case "SPENDING_CATEGORY_INVALID_INPUT":
			default:
				this.status = 400;
				break;
		}
	}
}
