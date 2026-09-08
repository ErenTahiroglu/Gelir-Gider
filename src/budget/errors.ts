export type BudgetErrorCode =
	| "BUDGET_INVALID_INPUT"
	| "BUDGET_PLAN_NOT_FOUND"
	| "BUDGET_PERIOD_CONFLICT"
	| "BUDGET_IDEMPOTENCY_CONFLICT"
	| "BUDGET_REVISION_CONFLICT"
	| "BUDGET_ALREADY_VOIDED"
	| "BUDGET_INVALID_STATE"
	| "BUDGET_REFERENCE_INVALID_STATE"
	// Budget V2 semantic classification (support receipts / goal purpose)
	| "BUDGET_CLASSIFICATION_TARGET_NOT_FOUND"
	| "BUDGET_CLASSIFICATION_INVALID_TARGET"
	// Budget V2 basic-living user-approved config
	| "BUDGET_BASIC_LIVING_CONFIG_NOT_FOUND"
	// Budget V2 authoritative live-source resolver -- fail-closed guard.
	// The resolver refuses to produce an input it cannot prove from stored,
	// authoritative domain truth (never an estimate).
	| "BUDGET_RESOLVER_FAIL_CLOSED";

export class BudgetError extends Error {
	readonly code: BudgetErrorCode;

	constructor(code: BudgetErrorCode, message: string) {
		super(message);
		this.name = "BudgetError";
		this.code = code;
		Object.setPrototypeOf(this, BudgetError.prototype);
	}
}
