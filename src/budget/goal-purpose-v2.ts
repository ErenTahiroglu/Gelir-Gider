import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	STG_BUDGET_V2_PURPOSES,
	type StgBudgetV2Purpose,
	shortTermGoalBudgetV2PurposeRevisions,
} from "../db/schema/budget-v2-semantics";
import { shortTermGoals } from "../db/schema/short-term-goals";
import { BudgetError } from "./errors";
import { calculateGoalPurposeRevisionFingerprint } from "./semantic-fingerprint-v2";
import { normalizeUuid } from "./utils";

// ============================================================================
// Read model
// ============================================================================

export interface GoalBudgetV2PurposeItem {
	goalId: string;
	userId: string;
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE";
	purpose: StgBudgetV2Purpose;
	previousRevisionId: string | null;
	occurredAt: string;
}

function toItem(
	row: typeof shortTermGoalBudgetV2PurposeRevisions.$inferSelect,
): GoalBudgetV2PurposeItem {
	return {
		goalId: row.goalId,
		userId: row.userId,
		revisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as "CREATE" | "UPDATE",
		purpose: row.purpose as StgBudgetV2Purpose,
		previousRevisionId: row.previousRevisionId,
		occurredAt: row.occurredAt.toISOString(),
	};
}

// ============================================================================
// Params
// ============================================================================

export interface ClassifyGoalPurposeParams {
	db: Database;
	userId: string;
	goalId: string;
	purpose: StgBudgetV2Purpose;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface ReclassifyGoalPurposeParams {
	db: Database;
	userId: string;
	goalId: string;
	expectedRevisionNo: number;
	purpose: StgBudgetV2Purpose;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface GoalBudgetV2PurposeResult {
	purpose: GoalBudgetV2PurposeItem;
	idempotentReplay: boolean;
}

// ============================================================================
// Validation helpers
// ============================================================================

function validatePurpose(purpose: unknown): StgBudgetV2Purpose {
	if (
		typeof purpose !== "string" ||
		!(STG_BUDGET_V2_PURPOSES as readonly string[]).includes(purpose)
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`purpose must be one of: ${STG_BUDGET_V2_PURPOSES.join(", ")}`,
		);
	}
	return purpose as StgBudgetV2Purpose;
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

async function assertGoalOwned(
	tx: Database,
	userId: string,
	goalId: string,
	lock: boolean,
): Promise<void> {
	const base = tx
		.select({ id: shortTermGoals.id })
		.from(shortTermGoals)
		.where(
			and(eq(shortTermGoals.id, goalId), eq(shortTermGoals.userId, userId)),
		);
	const [goal] = await (lock ? base.for("update") : base).limit(1);
	if (!goal) {
		throw new BudgetError(
			"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
			`Short-term goal "${goalId}" not found`,
		);
	}
}

async function findByIdempotencyKey(
	db: Database,
	userId: string,
	idempotencyKey: string,
): Promise<
	typeof shortTermGoalBudgetV2PurposeRevisions.$inferSelect | undefined
> {
	const [row] = await db
		.select()
		.from(shortTermGoalBudgetV2PurposeRevisions)
		.where(
			and(
				eq(shortTermGoalBudgetV2PurposeRevisions.userId, userId),
				eq(
					shortTermGoalBudgetV2PurposeRevisions.idempotencyKey,
					idempotencyKey,
				),
			),
		)
		.limit(1);
	return row;
}

async function latestRevisionForGoal(
	tx: Database,
	userId: string,
	goalId: string,
): Promise<
	typeof shortTermGoalBudgetV2PurposeRevisions.$inferSelect | undefined
> {
	const [row] = await tx
		.select()
		.from(shortTermGoalBudgetV2PurposeRevisions)
		.where(
			and(
				eq(shortTermGoalBudgetV2PurposeRevisions.userId, userId),
				eq(shortTermGoalBudgetV2PurposeRevisions.goalId, goalId),
			),
		)
		.orderBy(desc(shortTermGoalBudgetV2PurposeRevisions.revisionNo))
		.limit(1);
	return row;
}

// ============================================================================
// classify (CREATE revision #1)
// ============================================================================

export async function classifyGoalPurpose(
	params: ClassifyGoalPurposeParams,
): Promise<GoalBudgetV2PurposeResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const goalId = normalizeUuid(params.goalId, "goalId");
	const purpose = validatePurpose(params.purpose);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) {
		const candidateFp = await calculateGoalPurposeRevisionFingerprint({
			userId,
			goalId,
			operation: "CREATE",
			revisionNo: existing.revisionNo,
			previousRevisionId: existing.previousRevisionId,
			purpose,
			occurredAt: explicitOccurredAt ?? existing.occurredAt,
		});
		if (
			existing.goalId !== goalId ||
			existing.operation !== "CREATE" ||
			candidateFp !== existing.revisionFingerprint
		) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" was already used with different purpose parameters`,
			);
		}
		return { purpose: toItem(existing), idempotentReplay: true };
	}

	return await db.transaction(async (tx) => {
		await assertGoalOwned(tx as unknown as Database, userId, goalId, true);

		const latest = await latestRevisionForGoal(
			tx as unknown as Database,
			userId,
			goalId,
		);
		if (latest) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Goal "${goalId}" purpose is already classified (revision ${latest.revisionNo}); use reclassify`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const revisionFingerprint = await calculateGoalPurposeRevisionFingerprint({
			userId,
			goalId,
			operation: "CREATE",
			revisionNo: 1,
			previousRevisionId: null,
			purpose,
			occurredAt,
		});

		const [inserted] = await tx
			.insert(shortTermGoalBudgetV2PurposeRevisions)
			.values({
				userId,
				goalId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				purpose,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.returning();
		if (!inserted) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Failed to insert goal purpose revision",
			);
		}
		return { purpose: toItem(inserted), idempotentReplay: false };
	});
}

// ============================================================================
// reclassify (append UPDATE revision)
// ============================================================================

export async function reclassifyGoalPurpose(
	params: ReclassifyGoalPurposeParams,
): Promise<GoalBudgetV2PurposeResult> {
	const { db, expectedRevisionNo } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const goalId = normalizeUuid(params.goalId, "goalId");
	const purpose = validatePurpose(params.purpose);
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
		const candidateFp = await calculateGoalPurposeRevisionFingerprint({
			userId,
			goalId,
			operation: "UPDATE",
			revisionNo: existing.revisionNo,
			previousRevisionId: existing.previousRevisionId,
			purpose,
			occurredAt: explicitOccurredAt ?? existing.occurredAt,
		});
		if (
			existing.goalId !== goalId ||
			existing.operation !== "UPDATE" ||
			existing.revisionNo !== expectedRevisionNo + 1 ||
			candidateFp !== existing.revisionFingerprint
		) {
			throw new BudgetError(
				"BUDGET_IDEMPOTENCY_CONFLICT",
				`Idempotency key "${idempotencyKey}" was already used with different re-purpose parameters`,
			);
		}
		return { purpose: toItem(existing), idempotentReplay: true };
	}

	return await db.transaction(async (tx) => {
		await assertGoalOwned(tx as unknown as Database, userId, goalId, true);

		const latest = await latestRevisionForGoal(
			tx as unknown as Database,
			userId,
			goalId,
		);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_CLASSIFICATION_TARGET_NOT_FOUND",
				`Goal "${goalId}" purpose is not yet classified; use classify`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Expected purpose revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const newRevisionNo = expectedRevisionNo + 1;
		const revisionFingerprint = await calculateGoalPurposeRevisionFingerprint({
			userId,
			goalId,
			operation: "UPDATE",
			revisionNo: newRevisionNo,
			previousRevisionId: latest.id,
			purpose,
			occurredAt,
		});

		const [inserted] = await tx
			.insert(shortTermGoalBudgetV2PurposeRevisions)
			.values({
				userId,
				goalId,
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				purpose,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.returning();
		if (!inserted) {
			throw new BudgetError(
				"BUDGET_INVALID_STATE",
				"Failed to insert re-purpose revision",
			);
		}
		return { purpose: toItem(inserted), idempotentReplay: false };
	});
}

// ============================================================================
// get / list
// ============================================================================

export async function getGoalPurpose(params: {
	db: Database;
	userId: string;
	goalId: string;
}): Promise<GoalBudgetV2PurposeItem | null> {
	const userId = normalizeUuid(params.userId, "userId");
	const goalId = normalizeUuid(params.goalId, "goalId");
	const latest = await latestRevisionForGoal(params.db, userId, goalId);
	return latest ? toItem(latest) : null;
}

export async function listGoalPurposes(params: {
	db: Database;
	userId: string;
	goalIds?: string[] | undefined;
}): Promise<GoalBudgetV2PurposeItem[]> {
	const userId = normalizeUuid(params.userId, "userId");
	const conds = [eq(shortTermGoalBudgetV2PurposeRevisions.userId, userId)];
	if (params.goalIds && params.goalIds.length > 0) {
		conds.push(
			inArray(
				shortTermGoalBudgetV2PurposeRevisions.goalId,
				params.goalIds.map((g) => normalizeUuid(g, "goalId")),
			),
		);
	}
	const rows = await params.db
		.select()
		.from(shortTermGoalBudgetV2PurposeRevisions)
		.where(and(...conds))
		.orderBy(desc(shortTermGoalBudgetV2PurposeRevisions.revisionNo));

	const latestByGoal = new Map<
		string,
		typeof shortTermGoalBudgetV2PurposeRevisions.$inferSelect
	>();
	for (const row of rows) {
		if (!latestByGoal.has(row.goalId)) latestByGoal.set(row.goalId, row);
	}
	return [...latestByGoal.values()]
		.sort((a, b) => a.goalId.localeCompare(b.goalId))
		.map(toItem);
}
