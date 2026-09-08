import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	BASIC_LIVING_CONFIG_SOURCE_KINDS,
	type BasicLivingConfigSourceKind,
	budgetV2BasicLivingConfigRevisions,
} from "../db/schema/budget-basic-living";
import { parsePositiveMoneyString } from "../ledger/money";
import { BudgetError } from "./errors";
import { calculateBasicLivingConfigRevisionFingerprint } from "./semantic-fingerprint-v2";
import { normalizeUuid, validateBudgetPeriodMonth } from "./utils";

/**
 * PERSONAL_BUDGET_V2 -- user-approved monthly basic-living target config.
 *
 * Append-only, versioned. `create*` opens revision #1; `update*` appends an
 * OCC-guarded UPDATE. `getEffective*` resolves the revision that applies to a
 * given month deterministically: the greatest `revisionNo` whose
 * `effectivePeriodMonth <= firstDayOf(month)` (the DB guard keeps
 * `effectivePeriodMonth` non-decreasing along the chain).
 *
 * This is a POLICY-CONFIG log only -- no ledger posting, no canonical
 * transaction, no Midas movement.
 */

// ============================================================================
// Read model
// ============================================================================

export interface BasicLivingConfigItem {
	revisionId: string;
	revisionNo: number;
	operation: "CREATE" | "UPDATE";
	effectivePeriodMonth: string;
	monthlyTargetAmount: string;
	currency: string;
	sourceKind: BasicLivingConfigSourceKind;
	previousRevisionId: string | null;
	occurredAt: string;
}

function toItem(
	row: typeof budgetV2BasicLivingConfigRevisions.$inferSelect,
): BasicLivingConfigItem {
	return {
		revisionId: row.id,
		revisionNo: row.revisionNo,
		operation: row.operation as "CREATE" | "UPDATE",
		effectivePeriodMonth: row.effectivePeriodMonth,
		monthlyTargetAmount: row.monthlyTargetAmount,
		currency: row.currency,
		sourceKind: row.sourceKind as BasicLivingConfigSourceKind,
		previousRevisionId: row.previousRevisionId,
		occurredAt: row.occurredAt.toISOString(),
	};
}

// ============================================================================
// Params
// ============================================================================

export interface CreateBasicLivingTargetParams {
	db: Database;
	userId: string;
	effectivePeriodMonth: string;
	monthlyTargetAmount: string;
	currency: string;
	sourceKind: BasicLivingConfigSourceKind;
	idempotencyKey: string;
	occurredAt?: Date | undefined;
}

export interface UpdateBasicLivingTargetParams
	extends CreateBasicLivingTargetParams {
	expectedRevisionNo: number;
}

export interface BasicLivingConfigResult {
	config: BasicLivingConfigItem;
	idempotentReplay: boolean;
}

// ============================================================================
// Validation
// ============================================================================

function normalizeEffectivePeriodMonth(value: string): string {
	// Accept "YYYY-MM" for convenience; store/validate as the first calendar day.
	const candidate =
		typeof value === "string" && /^\d{4}-\d{2}$/.test(value.trim())
			? `${value.trim()}-01`
			: value;
	return validateBudgetPeriodMonth(candidate);
}

function validateCurrency(value: string): string {
	const trimmed = typeof value === "string" ? value.trim().toUpperCase() : "";
	if (!/^[A-Z]{3}$/.test(trimmed)) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			"currency must be a 3-letter ISO code",
		);
	}
	return trimmed;
}

function validateSourceKind(value: unknown): BasicLivingConfigSourceKind {
	if (
		typeof value !== "string" ||
		!(BASIC_LIVING_CONFIG_SOURCE_KINDS as readonly string[]).includes(value)
	) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`sourceKind must be one of: ${BASIC_LIVING_CONFIG_SOURCE_KINDS.join(", ")}`,
		);
	}
	return value as BasicLivingConfigSourceKind;
}

function validateTargetAmount(value: string): string {
	try {
		return parsePositiveMoneyString(value).normalized;
	} catch (e) {
		throw new BudgetError(
			"BUDGET_INVALID_INPUT",
			`monthlyTargetAmount must be a positive money string: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
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
): Promise<typeof budgetV2BasicLivingConfigRevisions.$inferSelect | undefined> {
	const [row] = await db
		.select()
		.from(budgetV2BasicLivingConfigRevisions)
		.where(
			and(
				eq(budgetV2BasicLivingConfigRevisions.userId, userId),
				eq(budgetV2BasicLivingConfigRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	return row;
}

async function latestRevisionForUser(
	tx: Database,
	userId: string,
): Promise<typeof budgetV2BasicLivingConfigRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(budgetV2BasicLivingConfigRevisions)
		.where(eq(budgetV2BasicLivingConfigRevisions.userId, userId))
		.orderBy(desc(budgetV2BasicLivingConfigRevisions.revisionNo))
		.limit(1);
	return row;
}

interface ReconcileCtx {
	userId: string;
	operation: "CREATE" | "UPDATE";
	expectedRevisionNo?: number;
	effectivePeriodMonth: string;
	monthlyTargetAmount: string;
	currency: string;
	sourceKind: BasicLivingConfigSourceKind;
	explicitOccurredAt: Date | undefined;
	idempotencyKey: string;
}

/**
 * Fail-closed replay reconciliation: an exact re-issue of the same command
 * returns the stored revision; any divergence is BUDGET_IDEMPOTENCY_CONFLICT.
 */
async function reconcileExisting(
	existing: typeof budgetV2BasicLivingConfigRevisions.$inferSelect,
	ctx: ReconcileCtx,
): Promise<BasicLivingConfigResult> {
	const candidateFp = await calculateBasicLivingConfigRevisionFingerprint({
		userId: ctx.userId,
		operation: ctx.operation,
		revisionNo: existing.revisionNo,
		previousRevisionId: existing.previousRevisionId,
		effectivePeriodMonth: ctx.effectivePeriodMonth,
		monthlyTargetAmount: ctx.monthlyTargetAmount,
		currency: ctx.currency,
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
		existing.operation === ctx.operation &&
		positionOk &&
		existing.revisionFingerprint === candidateFp;
	if (!exact) {
		throw new BudgetError(
			"BUDGET_IDEMPOTENCY_CONFLICT",
			`Idempotency key "${ctx.idempotencyKey}" was already used with different basic-living config parameters`,
		);
	}
	return { config: toItem(existing), idempotentReplay: true };
}

// ============================================================================
// create (revision #1)
// ============================================================================

export async function createBasicLivingTarget(
	params: CreateBasicLivingTargetParams,
): Promise<BasicLivingConfigResult> {
	const { db } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const effectivePeriodMonth = normalizeEffectivePeriodMonth(
		params.effectivePeriodMonth,
	);
	const monthlyTargetAmount = validateTargetAmount(params.monthlyTargetAmount);
	const currency = validateCurrency(params.currency);
	const sourceKind = validateSourceKind(params.sourceKind);
	const idempotencyKey = requireKey(params.idempotencyKey);
	const explicitOccurredAt = validateOptionalOccurredAt(params.occurredAt);

	const ctx: ReconcileCtx = {
		userId,
		operation: "CREATE",
		effectivePeriodMonth,
		monthlyTargetAmount,
		currency,
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		const latest = await latestRevisionForUser(txdb, userId);
		if (latest) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`A basic-living config already exists (revision ${latest.revisionNo}); use updateBasicLivingTarget`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const revisionFingerprint =
			await calculateBasicLivingConfigRevisionFingerprint({
				userId,
				operation: "CREATE",
				revisionNo: 1,
				previousRevisionId: null,
				effectivePeriodMonth,
				monthlyTargetAmount,
				currency,
				sourceKind,
				occurredAt,
			});

		const [inserted] = await tx
			.insert(budgetV2BasicLivingConfigRevisions)
			.values({
				userId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				effectivePeriodMonth,
				monthlyTargetAmount,
				currency,
				sourceKind,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.onConflictDoNothing({
				target: [
					budgetV2BasicLivingConfigRevisions.userId,
					budgetV2BasicLivingConfigRevisions.idempotencyKey,
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
				"basic-living config idempotency key conflicted but no row is visible",
			);
		}
		return reconcileExisting(afterConflict, ctx);
	});
}

// ============================================================================
// update (append OCC-guarded UPDATE revision)
// ============================================================================

export async function updateBasicLivingTarget(
	params: UpdateBasicLivingTargetParams,
): Promise<BasicLivingConfigResult> {
	const { db, expectedRevisionNo } = params;
	const userId = normalizeUuid(params.userId, "userId");
	const effectivePeriodMonth = normalizeEffectivePeriodMonth(
		params.effectivePeriodMonth,
	);
	const monthlyTargetAmount = validateTargetAmount(params.monthlyTargetAmount);
	const currency = validateCurrency(params.currency);
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
		operation: "UPDATE",
		expectedRevisionNo,
		effectivePeriodMonth,
		monthlyTargetAmount,
		currency,
		sourceKind,
		explicitOccurredAt,
		idempotencyKey,
	};

	const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
	if (existing) return reconcileExisting(existing, ctx);

	return await db.transaction(async (tx) => {
		const txdb = tx as unknown as Database;
		const raced = await findByIdempotencyKey(txdb, userId, idempotencyKey);
		if (raced) return reconcileExisting(raced, ctx);

		const latest = await latestRevisionForUser(txdb, userId);
		if (!latest) {
			throw new BudgetError(
				"BUDGET_BASIC_LIVING_CONFIG_NOT_FOUND",
				"No basic-living config to update; use createBasicLivingTarget",
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new BudgetError(
				"BUDGET_REVISION_CONFLICT",
				`Expected basic-living config revision ${expectedRevisionNo}, but latest is ${latest.revisionNo}`,
			);
		}
		if (effectivePeriodMonth < latest.effectivePeriodMonth) {
			throw new BudgetError(
				"BUDGET_INVALID_INPUT",
				`effectivePeriodMonth "${effectivePeriodMonth}" must not precede the current revision's "${latest.effectivePeriodMonth}"`,
			);
		}

		const occurredAt = explicitOccurredAt ?? new Date();
		const newRevisionNo = expectedRevisionNo + 1;
		const revisionFingerprint =
			await calculateBasicLivingConfigRevisionFingerprint({
				userId,
				operation: "UPDATE",
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				effectivePeriodMonth,
				monthlyTargetAmount,
				currency,
				sourceKind,
				occurredAt,
			});

		const [inserted] = await tx
			.insert(budgetV2BasicLivingConfigRevisions)
			.values({
				userId,
				revisionNo: newRevisionNo,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				effectivePeriodMonth,
				monthlyTargetAmount,
				currency,
				sourceKind,
				idempotencyKey,
				revisionFingerprint,
				occurredAt,
			})
			.onConflictDoNothing({
				target: [
					budgetV2BasicLivingConfigRevisions.userId,
					budgetV2BasicLivingConfigRevisions.idempotencyKey,
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
				"basic-living config idempotency key conflicted but no row is visible",
			);
		}
		return reconcileExisting(afterConflict, ctx);
	});
}

// ============================================================================
// reads
// ============================================================================

export async function getLatestBasicLivingConfigRevision(params: {
	db: Database;
	userId: string;
}): Promise<BasicLivingConfigItem | null> {
	const userId = normalizeUuid(params.userId, "userId");
	const latest = await latestRevisionForUser(params.db, userId);
	return latest ? toItem(latest) : null;
}

/**
 * The basic-living config revision effective for `periodMonth` -- the greatest
 * `revisionNo` whose `effectivePeriodMonth <= firstDayOf(periodMonth)`.
 * Returns null when the user has no config that reaches this month.
 */
export async function getEffectiveBasicLivingTarget(params: {
	db: Database;
	userId: string;
	periodMonth: string;
}): Promise<BasicLivingConfigItem | null> {
	const userId = normalizeUuid(params.userId, "userId");
	const firstDay = normalizeEffectivePeriodMonth(params.periodMonth);
	const [row] = await params.db
		.select()
		.from(budgetV2BasicLivingConfigRevisions)
		.where(
			and(
				eq(budgetV2BasicLivingConfigRevisions.userId, userId),
				lte(budgetV2BasicLivingConfigRevisions.effectivePeriodMonth, firstDay),
			),
		)
		.orderBy(desc(budgetV2BasicLivingConfigRevisions.revisionNo))
		.limit(1);
	return row ? toItem(row) : null;
}

export async function listBasicLivingConfigRevisions(params: {
	db: Database;
	userId: string;
}): Promise<BasicLivingConfigItem[]> {
	const userId = normalizeUuid(params.userId, "userId");
	const rows = await params.db
		.select()
		.from(budgetV2BasicLivingConfigRevisions)
		.where(eq(budgetV2BasicLivingConfigRevisions.userId, userId))
		.orderBy(desc(budgetV2BasicLivingConfigRevisions.revisionNo));
	return rows.map(toItem);
}
