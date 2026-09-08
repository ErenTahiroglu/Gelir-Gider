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

	// HISTORICAL IDEMPOTENCY FIRST -----------------------------------------
	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) {
		const candidateFp = await calculateSupportSemanticRevisionFingerprint({
			userId,
			incomeReceiptId,
			operation: "CREATE",
			revisionNo: existing.revisionNo,
			previousRevisionId: existing.previousRevisionId,
			supportRole,
			occurredAt: explicitOccurredAt ?? existing.occurredAt,
		});
		if (
			existing.incomeReceiptId !== incomeReceiptId ||
			existing.operation !== "CREATE" ||
			candidateFp !== existing.revisionFingerprint
		) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" was already used with different classification parameters`,
			);
		}
		return { classification: toItem(existing), idempotentReplay: true };
	}

	return await db.transaction(async (tx) => {
		await loadSupportReceiptOrThrow(
			tx as unknown as Database,
			userId,
			incomeReceiptId,
			true,
		);

		const latest = await latestRevisionForReceipt(
			tx as unknown as Database,
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
			.returning();
		if (!inserted) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Failed to insert support classification revision",
			);
		}
		return { classification: toItem(inserted), idempotentReplay: false };
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

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) {
		const candidateFp = await calculateSupportSemanticRevisionFingerprint({
			userId,
			incomeReceiptId,
			operation: "UPDATE",
			revisionNo: existing.revisionNo,
			previousRevisionId: existing.previousRevisionId,
			supportRole,
			occurredAt: explicitOccurredAt ?? existing.occurredAt,
		});
		if (
			existing.incomeReceiptId !== incomeReceiptId ||
			existing.operation !== "UPDATE" ||
			existing.revisionNo !== expectedRevisionNo + 1 ||
			candidateFp !== existing.revisionFingerprint
		) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" was already used with different reclassification parameters`,
			);
		}
		return { classification: toItem(existing), idempotentReplay: true };
	}

	return await db.transaction(async (tx) => {
		await loadSupportReceiptOrThrow(
			tx as unknown as Database,
			userId,
			incomeReceiptId,
			true,
		);

		const latest = await latestRevisionForReceipt(
			tx as unknown as Database,
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
			.returning();
		if (!inserted) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Failed to insert reclassification revision",
			);
		}
		return { classification: toItem(inserted), idempotentReplay: false };
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
