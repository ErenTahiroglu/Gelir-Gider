import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	budgetV2CheckpointTriggerCardRevisions,
	CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS,
	type CheckpointTriggerCardSourceKind,
	type CheckpointTriggerCardStatus,
} from "../db/schema/budget-v2-checkpoint";
import { creditCards } from "../db/schema/credit-cards";
import { BudgetError } from "./errors";
import { calculateCheckpointTriggerCardRevisionFingerprint } from "./semantic-fingerprint-v2";
import { normalizeUuid } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- user-approved checkpoint TRIGGER-CARD configuration.
 *
 * Append-only, versioned, one unbranched chain per user+card. `create*` opens
 * revision #1; `update*` appends an OCC-guarded UPDATE. A card is a
 * checkpoint-trigger card ONLY when the revision effective as of a payment
 * event's `occurredAt` (greatest `revisionNo` whose `occurredAt <=` the
 * payment instant) exists AND has `status = 'ENABLED'`. No row => NOT ENABLED.
 * DISABLED => no trigger.
 *
 * The card is identified by its EXACT owned `creditCardId` -- never by issuer,
 * displayName, last-four, or any name/merchant heuristic. This is a
 * policy-config log only: no ledger posting, no canonical transaction, no
 * Midas movement.
 */

// ============================================================================
// Read model
// ============================================================================

export interface CheckpointTriggerCardItem {
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE";
	creditCardId: string;
	status: CheckpointTriggerCardStatus;
	sourceKind: CheckpointTriggerCardSourceKind;
	previousRevisionId: string | null;
	occurredAt: string;
}

function toItem(
	row: typeof budgetV2CheckpointTriggerCardRevisions.$inferSelect,
): CheckpointTriggerCardItem {
	return {
		revisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as "CREATE" | "UPDATE",
		creditCardId: row.creditCardId,
		status: row.status as CheckpointTriggerCardStatus,
		sourceKind: row.sourceKind as CheckpointTriggerCardSourceKind,
		previousRevisionId: row.previousRevisionId,
		occurredAt: row.occurredAt.toISOString(),
	};
}

// ============================================================================
// Params
// ============================================================================

export interface CreateCheckpointTriggerCardParams {
	db: Database;
	userId: string;
	creditCardId: string;
	status: CheckpointTriggerCardStatus;
	sourceKind: CheckpointTriggerCardSourceKind;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface UpdateCheckpointTriggerCardParams
	extends CreateCheckpointTriggerCardParams {
	expectedRevisionNo: number;
}

export interface CheckpointTriggerCardResult {
	config: CheckpointTriggerCardItem;
	idempotentReplay: boolean;
}

// ============================================================================
// Validation
// ============================================================================

function validateStatus(value: unknown): CheckpointTriggerCardStatus {
	if (value !== "ENABLED" && value !== "DISABLED") {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"status must be ENABLED or DISABLED",
		);
	}
	return value;
}

function validateSourceKind(value: unknown): CheckpointTriggerCardSourceKind {
	if (
		typeof value !== "string" ||
		!(CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS as readonly string[]).includes(value)
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`sourceKind must be one of: ${CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS.join(", ")}`,
		);
	}
	return value as CheckpointTriggerCardSourceKind;
}

function requireKey(idempotencyKey: string): string {
	const trimmed = idempotencyKey?.trim();
	if (!trimmed || trimmed.length > 128) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"idempotencyKey is required and must be 1..128 chars",
		);
	}
	return trimmed;
}

function validateOptionalOccurredAt(value: Date | undefined): Date | undefined {
	if (value === undefined) return undefined;
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"occurredAt must be a valid Date object",
		);
	}
	return value;
}

// ============================================================================
// Internal lookups
// ============================================================================

async function findByIdempotencyKey(
	db: Database,
	userId: string,
	idempotencyKey: string,
): Promise<
	typeof budgetV2CheckpointTriggerCardRevisions.$inferSelect | undefined
> {
	const [row] = await db
		.select()
		.from(budgetV2CheckpointTriggerCardRevisions)
		.where(
			and(
				eq(budgetV2CheckpointTriggerCardRevisions.userId, userId),
				eq(
					budgetV2CheckpointTriggerCardRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);
	return row;
}

/**
 * Take a stable per-card write lock. This MUST run first inside the write
 * transaction -- BEFORE the second idempotency lookup and before the
 * CREATE/OCC decision -- so two different fresh idempotency keys can never
 * race onto the same revision position for one card. The DB INSERT trigger
 * also locks `credit_cards`, but that is too late: the application has
 * already chosen `revisionNo` / `previousRevisionId` by then.
 */
async function lockOwnedCard(
	txdb: Database,
	userId: string,
	creditCardId: string,
): Promise<void> {
	const [card] = await txdb
		.select({ id: creditCards.id })
		.from(creditCards)
		.where(
			and(eq(creditCards.id, creditCardId), eq(creditCards.userId, userId)),
		)
		.for("update");
	if (!card) {
		throw new BudgetError(
			"BUDGET_CHECKPOINT_TRIGGER_CARD_INVALID",
			`credit card ${creditCardId} does not exist for this user`,
		);
	}
}

async function latestRevisionForCard(
	db: Database,
	userId: string,
	creditCardId: string,
): Promise<
	typeof budgetV2CheckpointTriggerCardRevisions.$inferSelect | undefined
> {
	const [row] = await db
		.select()
		.from(budgetV2CheckpointTriggerCardRevisions)
		.where(
			and(
				eq(budgetV2CheckpointTriggerCardRevisions.userId, userId),
				eq(budgetV2CheckpointTriggerCardRevisions.creditCardId, creditCardId),
			),
		)
		.orderBy(desc(budgetV2CheckpointTriggerCardRevisions.revisionNo))
		.limit(1);
	return row;
}

interface ReconcileCtx {
	userId: string;
	creditCardId: string;
	operation: "CREATE" | "UPDATE";
	expectedRevisionNo?: number;
	status: CheckpointTriggerCardStatus;
	sourceKind: CheckpointTriggerCardSourceKind;
	explicitOccurredAt: Date | undefined;
	idempotencyKey: string;
}

/**
 * Fail-closed replay reconciliation: an exact re-issue returns the stored
 * revision; any divergence is BUDGET_IDEMPOTENCY_CONFLICT.
 */
async function reconcileExisting(
	existing: typeof budgetV2CheckpointTriggerCardRevisions.$inferSelect,
	ctx: ReconcileCtx,
): Promise<CheckpointTriggerCardResult> {
	const candidateFp = await calculateCheckpointTriggerCardRevisionFingerprint({
		userId: ctx.userId,
		creditCardId: ctx.creditCardId,
		operation: ctx.operation,
		revisionNo: existing.revisionNo,
		previousRevisionId: existing.previousRevisionId,
		status: ctx.status,
		sourceKind: ctx.sourceKind,
		occurredAt: ctx.explicitOccurredAt ?? existing.occurredAt,
	});
	const positionOk =
		ctx.operation === "CREATE"
			? existing.revisionNo === 1 && existing.previousRevisionId === null
			: existing.revisionNo === (ctx.expectedRevisionNo ?? -1) + 1 &&
				existing.previousRevisionId !== null;
	const exact =
		existing.userId === ctx.userId &&
		existing.creditCardId === ctx.creditCardId &&
		existing.operation === ctx.operation &&
		positionOk &&
		existing.revisionFingerprint === candidateFp;
	if (!exact) {
		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`Idempotency key "${ctx.idempotencyKey}" was already used with different checkpoint trigger-card parameters`,
		);
	}
	return { config: toItem(existing), idempotentReplay: true };
}

// ============================================================================
// create (revision #1)
// ============================================================================

export async function createCheckpointTriggerCard(
	params: CreateCheckpointTriggerCardParams,
): Promise<CheckpointTriggerCardResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const creditCardId = normalizeUuid(params.creditCardId, "creditCardId");
	const status = validateStatus(params.status);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);

	const ctx: ReconcileCtx = {
		userId,
		creditCardId,
		operation: "CREATE",
		status,
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		// 1. stable per-card write lock (before the 2nd lookup / CREATE decision)
		await lockOwnedCard(txdb, userId, creditCardId);
		// 2. second (userId, idempotencyKey) lookup, now under the card lock
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		// 3. read the latest trigger-card revision for this card
		const latest = await latestRevisionForCard(txdb, userId, creditCardId);
		// 4. CREATE decision: a concurrent fresh key that already won CREATE is
		//    visible here because it committed before this tx got the card lock.
		if (latest) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`A checkpoint trigger-card config already exists for card ${creditCardId} (revision ${latest.revisionNo}); use updateCheckpointTriggerCard`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const revisionFingerprint =
			await calculateCheckpointTriggerCardRevisionFingerprint({
				userId,
				creditCardId,
				operation: "CREATE",
				revisionNo: 1,
				previousRevisionId: null,
				status,
				sourceKind,
				occurredAt,
			});

		const [inserted] = await tx
			.insert(budgetV2CheckpointTriggerCardRevisions)
			.values({
				userId,
				creditCardId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status,
				sourceKind,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.onConflictDoNothing({
				target: [
					budgetV2CheckpointTriggerCardRevisions.userId,
					budgetV2CheckpointTriggerCardRevisions.idempotencyKey,
				],
			})
			.returning();
		if (inserted) return { config: toItem(inserted), idempotentReplay: false };

		const afterConflict = await findByIdempotencyKey(
			txdb,
			userId,
			idempotencyKey,
		);
		if (!afterConflict) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"checkpoint trigger-card idempotency key conflicted but no row is visible",
			);
		}
		return reconcileExisting(afterConflict, ctx);
	});
}

// ============================================================================
// update (append OCC-guarded UPDATE revision)
// ============================================================================

export async function updateCheckpointTriggerCard(
	params: UpdateCheckpointTriggerCardParams,
): Promise<CheckpointTriggerCardResult> {
	const { db, expectedRevisionNo } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const creditCardId = normalizeUuid(params.creditCardId, "creditCardId");
	const status = validateStatus(params.status);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);
	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"expectedRevisionNo must be a positive integer",
		);
	}

	const ctx: ReconcileCtx = {
		userId,
		creditCardId,
		operation: "UPDATE",
		expectedRevisionNo,
		status,
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		// 1. stable per-card write lock (before the 2nd lookup / OCC decision)
		await lockOwnedCard(txdb, userId, creditCardId);
		// 2. second (userId, idempotencyKey) lookup, now under the card lock
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		// 3. read the latest trigger-card revision for this card
		const latest = await latestRevisionForCard(txdb, userId, creditCardId);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_CHECKPOINT_TRIGGER_CARD_INVALID",
				`No checkpoint trigger-card config to update for card ${creditCardId}; use createCheckpointTriggerCard`,
			);
		}
		// 4. OCC decision: a concurrent fresh key that already appended
		//    `expectedRevisionNo + 1` is visible here (it committed before this
		//    tx acquired the card lock) -> this caller loses with a typed
		//    BUDGET_REVISION_CONFLICT, never a raw 23505.
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Expected checkpoint trigger-card revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const newRevisionNo = expectedRevisionNo + 1;
		const revisionFingerprint =
			await calculateCheckpointTriggerCardRevisionFingerprint({
				userId,
				creditCardId,
				operation: "UPDATE",
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				status,
				sourceKind,
				occurredAt,
			});

		const [inserted] = await tx
			.insert(budgetV2CheckpointTriggerCardRevisions)
			.values({
				userId,
				creditCardId,
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				status,
				sourceKind,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.onConflictDoNothing({
				target: [
					budgetV2CheckpointTriggerCardRevisions.userId,
					budgetV2CheckpointTriggerCardRevisions.idempotencyKey,
				],
			})
			.returning();
		if (inserted) return { config: toItem(inserted), idempotentReplay: false };

		const afterConflict = await findByIdempotencyKey(
			txdb,
			userId,
			idempotencyKey,
		);
		if (!afterConflict) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"checkpoint trigger-card idempotency key conflicted but no row is visible",
			);
		}
		return reconcileExisting(afterConflict, ctx);
	});
}

// ============================================================================
// reads
// ============================================================================

export interface EffectiveCheckpointTriggerCard {
	enabled: boolean;
	config: CheckpointTriggerCardItem | null;
}

/**
 * The trigger-card config revision effective at `asOf` -- the greatest
 * `revisionNo` for (user, card) whose `occurredAt <= asOf`. `enabled` is true
 * ONLY when such a revision exists and its `status` is `ENABLED`.
 */
export async function getEffectiveCheckpointTriggerCard(params: {
	db: Database;
	userId: string;
	creditCardId: string;
	asOf: Date;
}): Promise<EffectiveCheckpointTriggerCard> {
	const userId = normalizeUuid(params.userId, "userId");
	const creditCardId = normalizeUuid(params.creditCardId, "creditCardId");
	if (!(params.asOf instanceof Date) || Number.isNaN(params.asOf.getTime())) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"asOf must be a valid Date object",
		);
	}
	const [row] = await params.db
		.select()
		.from(budgetV2CheckpointTriggerCardRevisions)
		.where(
			and(
				eq(budgetV2CheckpointTriggerCardRevisions.userId, userId),
				eq(budgetV2CheckpointTriggerCardRevisions.creditCardId, creditCardId),
				lte(budgetV2CheckpointTriggerCardRevisions.occurredAt, params.asOf),
			),
		)
		.orderBy(desc(budgetV2CheckpointTriggerCardRevisions.revisionNo))
		.limit(1);
	if (!row) return { enabled: false, config: null };
	return { enabled: row.status === "ENABLED", config: toItem(row) };
}

export async function listCheckpointTriggerCardRevisions(params: {
	db: Database;
	userId: string;
	creditCardId: string;
}): Promise<CheckpointTriggerCardItem[]> {
	const userId = normalizeUuid(params.userId, "userId");
	const creditCardId = normalizeUuid(params.creditCardId, "creditCardId");
	const rows = await params.db
		.select()
		.from(budgetV2CheckpointTriggerCardRevisions)
		.where(
			and(
				eq(budgetV2CheckpointTriggerCardRevisions.userId, userId),
				eq(budgetV2CheckpointTriggerCardRevisions.creditCardId, creditCardId),
			),
		)
		.orderBy(desc(budgetV2CheckpointTriggerCardRevisions.revisionNo));
	return rows.map(toItem);
}
