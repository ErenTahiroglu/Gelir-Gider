import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	incomeReceiptBudgetV2SemanticRevisions,
	SUPPORT_RECEIPT_ROLES,
	type SupportReceiptRole,
} from "../db/schema/budget-v2-semantics";
import { incomeReceipts, incomeSources } from "../db/schema/income";
import { BudgetError } from "./errors";
import { calculateSupportSemanticRevisionFingerprint } from "./semantic-fingerprint-v2";
import {
	type SupportRoleSemantics,
	supportRoleSemantics,
} from "./support-semantics-v2";
import { normalizeUuid } from "./utils";

// ============================================================================
// Read model
// ============================================================================

export interface SupportReceiptClassificationItem {
	incomeReceiptId: string;
	userId: string;
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE";
	supportRole: SupportReceiptRole;
	/** Pure deterministic semantics for the future live-source resolver. */
	semantics: SupportRoleSemantics;
	previousRevisionId: string | null;
	occurredAt: string;
}

function toItem(
	row: typeof incomeReceiptBudgetV2SemanticRevisions.$inferSelect,
): SupportReceiptClassificationItem {
	const supportRole = row.supportRole as SupportReceiptRole;
	return {
		incomeReceiptId: row.incomeReceiptId,
		userId: row.userId,
		revisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as "CREATE" | "UPDATE",
		supportRole,
		semantics: supportRoleSemantics(supportRole),
		previousRevisionId: row.previousRevisionId,
		occurredAt: row.occurredAt.toISOString(),
	};
}

// ============================================================================
// Params
// ============================================================================

export interface ClassifySupportReceiptParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
	supportRole: SupportReceiptRole;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface ReclassifySupportReceiptParams {
	db: Database;
	userId: string;
	incomeReceiptId: string;
	expectedRevisionNo: number;
	supportRole: SupportReceiptRole;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface SupportReceiptClassificationResult {
	classification: SupportReceiptClassificationItem;
	idempotentReplay: boolean;
}

// ============================================================================
// Shared validation
// ============================================================================

function validateRole(role: unknown): SupportReceiptRole {
	if (
		typeof role !== "string" ||
		!(SUPPORT_RECEIPT_ROLES as readonly string[]).includes(role)
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`support_role must be one of: ${SUPPORT_RECEIPT_ROLES.join(", ")}`,
		);
	}
	return role as SupportReceiptRole;
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

/** Loads a receipt (owned by user) and asserts its source nature is SUPPORT. */
async function loadSupportReceiptOrThrow(
	tx: Database,
	userId: string,
	incomeReceiptId: string,
	lock: boolean,
): Promise<void> {
	const base = tx
		.select({ id: incomeReceipts.id, sourceId: incomeReceipts.sourceId })
		.from(incomeReceipts)
		.where(
			and(
				eq(incomeReceipts.id, incomeReceiptId),
				eq(incomeReceipts.userId, userId),
			),
		);
	const [receipt] = await (lock ? base.for("update") : base).limit(1);
	if (!receipt) {
		throw new BudgetError(
			"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
			`Income receipt "${incomeReceiptId}" not found`,
		);
	}
	const [source] = await tx
		.select({ nature: incomeSources.nature })
		.from(incomeSources)
		.where(eq(incomeSources.id, receipt.sourceId))
		.limit(1);
	if (!source) {
		throw new BudgetError(
			"BUDGET_INVALID_STATE",
			`Income source for receipt "${incomeReceiptId}" is missing`,
		);
	}
	if (source.nature !== "SUPPORT") {
		throw new BudgetError(
			"BUDGET_CLASSIFICATION_INVALID_TARGET",
			`Budget V2 support classification requires a SUPPORT income receipt; source nature is ${source.nature}`,
		);
	}
}

/**
 * Fail-closed reconciliation of an already-stored revision found by
 * `(userId, idempotencyKey)` against the incoming effective command. Used by
 * BOTH the fast pre-transaction path and the in-transaction rechecks (after
 * the target lock, and after an `ON CONFLICT DO NOTHING` no-op), so there is a
 * single place that decides replay-vs-conflict for this domain.
 *
 * Exact match => idempotent replay. Any divergence (target, operation,
 * revision position, role, or effective occurredAt -- all bound into the
 * stored fingerprint) => BUDGET_IDEMPOTENCY_CONFLICT. A raw unique-violation
 * is never surfaced.
 */
async function reconcileExistingRevision(
	existing: typeof incomeReceiptBudgetV2SemanticRevisions.$inferSelect,
	ctx: {
		userId: string;
		incomeReceiptId: string;
		supportRole: SupportReceiptRole;
		operation: "CREATE" | "UPDATE";
		expectedRevisionNo?: number;
		explicitOccurredAt: Date | undefined;
		idempotencyKey: string;
	},
): Promise<SupportReceiptClassificationResult> {
	const candidateFp = await calculateSupportSemanticRevisionFingerprint({
		userId: ctx.userId,
		incomeReceiptId: ctx.incomeReceiptId,
		operation: ctx.operation,
		revisionNo: existing.revisionNo,
		previousRevisionId: existing.previousRevisionId,
		supportRole: ctx.supportRole,
		occurredAt: ctx.explicitOccurredAt ?? existing.occurredAt,
	});
	const positionOk =
		ctx.operation === "CREATE"
			? existing.revisionNo === 1 && existing.previousRevisionId === null
			: existing.revisionNo === (ctx.expectedRevisionNo ?? -1) + 1 &&
				existing.previousRevisionId !== null;
	const exact =
		existing.userId === ctx.userId &&
		existing.incomeReceiptId === ctx.incomeReceiptId &&
		existing.operation === ctx.operation &&
		positionOk &&
		existing.revisionFingerprint === candidateFp;
	if (!exact) {
		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`Idempotency key "${ctx.idempotencyKey}" was already used with different ${
				ctx.operation === "CREATE" ? "classification" : "reclassification"
			} parameters`,
		);
	}
	return { classification: toItem(existing), idempotentReplay: true };
}

async function findByIdempotencyKey(
	db: Database,
	userId: string,
	idempotencyKey: string,
): Promise<
	typeof incomeReceiptBudgetV2SemanticRevisions.$inferSelect | undefined
> {
	const [row] = await db
		.select()
		.from(incomeReceiptBudgetV2SemanticRevisions)
		.where(
			and(
				eq(incomeReceiptBudgetV2SemanticRevisions.userId, userId),
				eq(
					incomeReceiptBudgetV2SemanticRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);
	return row;
}

async function latestRevisionForReceipt(
	tx: Database,
	userId: string,
	incomeReceiptId: string,
): Promise<
	typeof incomeReceiptBudgetV2SemanticRevisions.$inferSelect | undefined
> {
	const [row] = await tx
		.select()
		.from(incomeReceiptBudgetV2SemanticRevisions)
		.where(
			and(
				eq(incomeReceiptBudgetV2SemanticRevisions.userId, userId),
				eq(
					incomeReceiptBudgetV2SemanticRevisions.incomeReceiptId,
					incomeReceiptId,
				),
			),
		)
		.orderBy(desc(incomeReceiptBudgetV2SemanticRevisions.revisionNo))
		.limit(1);
	return row;
}

// ============================================================================
// classify (CREATE revision #1)
// ============================================================================

export async function classifySupportReceipt(
	params: ClassifySupportReceiptParams,
): Promise<SupportReceiptClassificationResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const incomeReceiptId = normalizeUuid(
		params.incomeReceiptId,
		"incomeReceiptId",
	);
	const supportRole = validateRole(params.supportRole);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);

	const reconcileCtx = {
		userId,
		incomeReceiptId,
		supportRole,
		operation: "CREATE" as const,
		explicitOccurredAt,
		idempotencyKey,
	};

	// FAST HISTORICAL IDEMPOTENCY PATH (normal retries) --------------------
	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExistingRevision(existing, reconcileCtx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await loadSupportReceiptOrThrow(txdb, userId, incomeReceiptId, true);

		// SECOND idempotency check -- now holding the receipt lock, a racing
		// writer that committed after the fast path is visible here.
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExistingRevision(raced, reconcileCtx);

		const latest = await latestRevisionForReceipt(
			txdb,
			userId,
			incomeReceiptId,
		);
		if (latest) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Income receipt "${incomeReceiptId}" is already classified (revision ${latest.revisionNo}); use reclassify`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const revisionFingerprint =
			await calculateSupportSemanticRevisionFingerprint({
				userId,
				incomeReceiptId,
				operation: "CREATE",
				revisionNo: 1,
				previousRevisionId: null,
				supportRole,
				occurredAt,
			});

		// Race-safe insert: a cross-target same-key writer (whose receipt lock
		// does NOT serialize against ours) is absorbed by the idempotency
		// unique index instead of aborting the transaction with a raw 23505.
		const [inserted] = await tx
			.insert(incomeReceiptBudgetV2SemanticRevisions)
			.values({
				userId,
				incomeReceiptId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				supportRole,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.onConflictDoNothing({
				target: [
					incomeReceiptBudgetV2SemanticRevisions.userId,
					incomeReceiptBudgetV2SemanticRevisions.idempotencyKey,
				],
			})
			.returning();
		if (inserted) {
			return { classification: toItem(inserted), idempotentReplay: false };
		}

		const afterConflict = await findByIdempotencyKey(
			txdb,
			userId,
			idempotencyKey,
		);
		if (!afterConflict) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Support classification idempotency key conflicted but no row is visible",
			);
		}
		return reconcileExistingRevision(afterConflict, reconcileCtx);
	});
}

// ============================================================================
// reclassify (append UPDATE revision)
// ============================================================================

export async function reclassifySupportReceipt(
	params: ReclassifySupportReceiptParams,
): Promise<SupportReceiptClassificationResult> {
	const { db, expectedRevisionNo } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const incomeReceiptId = normalizeUuid(
		params.incomeReceiptId,
		"incomeReceiptId",
	);
	const supportRole = validateRole(params.supportRole);
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

	const reconcileCtx = {
		userId,
		incomeReceiptId,
		supportRole,
		operation: "UPDATE" as const,
		expectedRevisionNo,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExistingRevision(existing, reconcileCtx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		await loadSupportReceiptOrThrow(txdb, userId, incomeReceiptId, true);

		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExistingRevision(raced, reconcileCtx);

		const latest = await latestRevisionForReceipt(
			txdb,
			userId,
			incomeReceiptId,
		);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
				`Income receipt "${incomeReceiptId}" is not yet classified; use classify`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Expected classification revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const newRevisionNo = expectedRevisionNo + 1;
		const revisionFingerprint =
			await calculateSupportSemanticRevisionFingerprint({
				userId,
				incomeReceiptId,
				operation: "UPDATE",
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				supportRole,
				occurredAt,
			});

		const [inserted] = await tx
			.insert(incomeReceiptBudgetV2SemanticRevisions)
			.values({
				userId,
				incomeReceiptId,
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				supportRole,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.onConflictDoNothing({
				target: [
					incomeReceiptBudgetV2SemanticRevisions.userId,
					incomeReceiptBudgetV2SemanticRevisions.idempotencyKey,
				],
			})
			.returning();
		if (inserted) {
			return { classification: toItem(inserted), idempotentReplay: false };
		}

		const afterConflict = await findByIdempotencyKey(
			txdb,
			userId,
			idempotencyKey,
		);
		if (!afterConflict) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Support reclassification idempotency key conflicted but no row is visible",
			);
		}
		return reconcileExistingRevision(afterConflict, reconcileCtx);
	});
}

// ============================================================================
// get / list
// ============================================================================

export async function getSupportReceiptClassification(params: {
	db: Database;
	userId: string;
	incomeReceiptId: string;
}): Promise<SupportReceiptClassificationItem | null> {
	const userId = normalizeUuid(params.userId, "userId");
	const incomeReceiptId = normalizeUuid(
		params.incomeReceiptId,
		"incomeReceiptId",
	);
	const latest = await latestRevisionForReceipt(
		params.db,
		userId,
		incomeReceiptId,
	);
	return latest ? toItem(latest) : null;
}

export async function listSupportReceiptClassifications(params: {
	db: Database;
	userId: string;
	incomeReceiptIds?: string[] | undefined;
}): Promise<SupportReceiptClassificationItem[]> {
	const userId = normalizeUuid(params.userId, "userId");
	const conds = [eq(incomeReceiptBudgetV2SemanticRevisions.userId, userId)];
	if (params.incomeReceiptIds && params.incomeReceiptIds.length > 0) {
		conds.push(
			inArray(
				incomeReceiptBudgetV2SemanticRevisions.incomeReceiptId,
				params.incomeReceiptIds.map((r) => normalizeUuid(r, "incomeReceiptId")),
			),
		);
	}
	const rows = await params.db
		.select()
		.from(incomeReceiptBudgetV2SemanticRevisions)
		.where(and(...conds))
		.orderBy(desc(incomeReceiptBudgetV2SemanticRevisions.revisionNo));

	const latestByReceipt = new Map<
		string,
		typeof incomeReceiptBudgetV2SemanticRevisions.$inferSelect
	>();
	for (const row of rows) {
		if (!latestByReceipt.has(row.incomeReceiptId)) {
			latestByReceipt.set(row.incomeReceiptId, row);
		}
	}
	return [...latestByReceipt.values()]
		.sort((a, b) => a.incomeReceiptId.localeCompare(b.incomeReceiptId))
		.map(toItem);
}
