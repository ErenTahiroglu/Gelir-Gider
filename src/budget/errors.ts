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
	| "BUDGET_RESOLVER_FAIL_CLOSED"
	// Budget V2 checkpoint report -- the authoritative payment-event trigger
	// context (a payment event owned by the user, exactly one PAY revision that
	// references it, status PAID, an agreeing payment amount, a RECONCILED
	// non-stale statement reconciliation whose amount matches) could not be
	// established from stored truth.
	| "BUDGET_CHECKPOINT_TRIGGER_INVALID"
	// Budget V2 checkpoint report -- the statementId convenience wrapper could
	// not resolve a single unambiguous payment event (0 or >1 eligible PAY
	// events, e.g. after PAY -> REOPEN -> PAY). Callers must pass an explicit
	// triggerPaymentEventId.
	| "BUDGET_CHECKPOINT_TRIGGER_AMBIGUOUS"
	// Budget V2 checkpoint report -- a read helper could not derive an exact
	// figure from authoritative stored truth (unsealed / inconsistent split,
	// missing required resolver evidence, unresolvable historical person / card
	// state) and refuses to substitute a plausible value.
	| "BUDGET_CHECKPOINT_REPORT_FAIL_CLOSED"
	// Budget V2 durable checkpoint persistence (Checkpoint 5).
	// A checkpoint trigger-card config lifecycle target could not be
	// established (card not owned, no config chain, wrong operation position).
	| "BUDGET_CHECKPOINT_TRIGGER_CARD_INVALID"
	// The persistence processor must persist an earlier still-pending
	// checkpoint request for the same user+period before this one; this
	// request stays pending/blocked (never persisted with a wrong interval).
	| "BUDGET_CHECKPOINT_REQUEST_BLOCKED"
	// Two distinct eligible payment events for the same user+period share the
	// exact same checkpointAt and the timestamp interval model cannot order
	// them without inference -- fail closed at the report layer (payments and
	// requests remain durable and intact).
	| "BUDGET_CHECKPOINT_TIMESTAMP_COLLISION"
	// A stored checkpoint snapshot failed integrity verification on read
	// (recomputed canonical fingerprint / schemaVersion / paymentEventId /
	// periodMonth / checkpointAt / previousCheckpointAt identity mismatch).
	| "BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT"
	// Budget V2 surplus-use attribution (Checkpoint 5B).
	// The attribution subject is not an eligible surplus-use source: wrong
	// polymorphic anchor, not owned, People target not PAYABLE, credit-card
	// target not PURCHASE, Midas transfer not an UNALLOCATED -> INTERNATIONAL
	// MOBILITY goal allocation, Long-Term task not owned, or a lane that is
	// structurally incompatible with the subject type.
	| "BUDGET_SURPLUS_USE_SUBJECT_INVALID"
	// The attribution's bound source is inactive as of the attribution instant
	// (purchase VOID, People PAYABLE VOID, Midas transfer reversed, Long-Term
	// task CANCELLED) so it cannot open a surplus-use attribution.
	| "BUDGET_SURPLUS_USE_SOURCE_INACTIVE";

export class BudgetError extends Error {
	readonly code: BudgetErrorCode;

	constructor(code: BudgetErrorCode, message: string) {
		super(message);
		this.name = "BudgetError";
		this.code = code;
		Object.setPrototypeOf(this, BudgetError.prototype);
	}
}
