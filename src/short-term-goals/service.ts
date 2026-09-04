import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	midasAccounts,
	midasAllocationTransfers,
	midasBuckets,
} from "../db/schema/midas";
import {
	type ShortTermGoalFundingStatus,
	type ShortTermGoalOperation,
	type ShortTermGoalStatus,
	shortTermGoalPriorityRevisions,
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import {
	formatSignedCentsToMoney,
	parseMoneyString,
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { MidasError } from "../midas/errors";
import { createMidasAllocationTransferInTransaction } from "../midas/service";
import {
	validateCanonicalUuid,
	validateGregorianDate,
	validateOccurredAt,
	validateOptionalTrimmedText,
	validatePositiveMoneyString,
	validateProductUrl,
	validateRequiredTrimmedText,
} from "./calendar";
import { ShortTermGoalError } from "./errors";
import {
	calculateShortTermGoalPriorityFingerprint,
	calculateShortTermGoalRevisionFingerprint,
} from "./fingerprint";

export interface ShortTermGoalRecord {
	id: string;
	userId: string;
	midasAccountId: string;
	midasBucketId: string;
	status: ShortTermGoalStatus;
	name: string;
	fundingTarget: string;
	accumulatedAmount: string;
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	priorityIndex: number | null;
	latestRevisionNo: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface CreateShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	name: string;
	fundingTarget: string;
	targetDate?: string | null;
	maxBudget?: string | null;
	targetPrice?: string | null;
	productUrl?: string | null;
	note?: string | null;
	priorityIndex?: number | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	name?: string;
	fundingTarget?: string;
	targetDate?: string | null;
	maxBudget?: string | null;
	targetPrice?: string | null;
	productUrl?: string | null;
	note?: string | null;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface CompleteShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface CancelShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ReorderShortTermGoalsParams {
	db: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	orderedGoalIds: string[];
	occurredAt: Date;
	idempotencyKey: string;
}

export interface FundShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	fromBucketId?: string | null;
	amount: string;
	occurredAt: Date;
	memo?: string | null;
	idempotencyKey: string;
}

export interface ReleaseShortTermGoalFundingParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	toBucketId?: string | null;
	amount: string;
	occurredAt: Date;
	memo?: string | null;
	idempotencyKey: string;
}

export interface GetShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
}

export interface ListShortTermGoalsParams {
	db: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	status?: ShortTermGoalStatus | undefined;
}

function deriveFundingMetrics(
	accumulatedCents: bigint,
	targetCents: bigint,
): {
	accumulatedAmount: string;
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
} {
	const safeAccumulated = accumulatedCents < 0n ? 0n : accumulatedCents;
	const accumulatedAmount = formatSignedCentsToMoney(safeAccumulated);

	let fundingStatus: ShortTermGoalFundingStatus = "EMPTY";
	if (safeAccumulated === 0n) {
		fundingStatus = "EMPTY";
	} else if (safeAccumulated >= targetCents) {
		fundingStatus = "TARGET_REACHED";
	} else {
		fundingStatus = "PARTIAL";
	}

	const progressPercentage =
		targetCents > 0n
			? Math.round((Number(safeAccumulated) / Number(targetCents)) * 10000) /
				100
			: 0;

	return {
		accumulatedAmount,
		fundingStatus,
		progressPercentage,
	};
}

/**
 * Creates a new short-term goal, dedicated Midas virtual bucket, initial revision, and updates priority order.
 */
export async function createShortTermGoal(
	params: CreateShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);
	const idempotencyKey = validateRequiredTrimmedText(
		params.idempotencyKey,
		"idempotencyKey",
		128,
	);
	const name = validateRequiredTrimmedText(params.name, "name", 120);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const targetDate = validateGregorianDate(params.targetDate, "targetDate");
	const productUrl = validateProductUrl(params.productUrl);
	const note = validateOptionalTrimmedText(params.note, "note", 500);

	const parsedTarget = validatePositiveMoneyString(
		params.fundingTarget,
		"fundingTarget",
	);

	let maxBudget: string | null = null;
	if (params.maxBudget !== undefined && params.maxBudget !== null) {
		const parsedMax = validatePositiveMoneyString(
			params.maxBudget,
			"maxBudget",
		);
		if (parsedMax.cents < parsedTarget.cents) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_INPUT",
				`maxBudget (${parsedMax.normalized}) cannot be less than fundingTarget (${parsedTarget.normalized})`,
			);
		}
		maxBudget = parsedMax.normalized;
	}

	let targetPrice: string | null = null;
	if (params.targetPrice !== undefined && params.targetPrice !== null) {
		const parsedPrice = validatePositiveMoneyString(
			params.targetPrice,
			"targetPrice",
		);
		targetPrice = parsedPrice.normalized;
	}

	return await params.db.transaction(async (tx) => {
		// 1. Check idempotency on revisions early
		const [existingRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, userId),
					eq(shortTermGoalRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRev) {
			// Validate candidate fingerprint matches
			const candidateFp = await calculateShortTermGoalRevisionFingerprint({
				userId,
				goalId: existingRev.goalId,
				revisionNo: existingRev.revisionNo,
				previousRevisionId: existingRev.previousRevisionId,
				operation: existingRev.operation,
				status: existingRev.status,
				name,
				fundingTarget: parsedTarget.normalized,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				changeReason: null,
				occurredAt,
			});

			if (existingRev.revisionFingerprint !== candidateFp) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different parameters",
				);
			}

			// Return existing goal hydrated
			return await getShortTermGoalInTx({
				tx,
				userId,
				goalId: existingRev.goalId,
			});
		}

		// 2. Lock parent Midas account FOR UPDATE to serialize priority and goal additions
		const [midasAccount] = await tx
			.select()
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, midasAccountId),
					eq(midasAccounts.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!midasAccount) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND",
				"Midas account not found",
			);
		}

		// 3. Create dedicated Midas virtual bucket with type SHORT_TERM_GOAL
		const randomBucketSuffix = crypto
			.randomUUID()
			.replace(/-/g, "")
			.slice(0, 12)
			.toUpperCase();
		const bucketCode = `STG_${randomBucketSuffix}`;

		const [midasBucket] = await tx
			.insert(midasBuckets)
			.values({
				userId,
				midasAccountId,
				code: bucketCode,
				name,
				bucketType: "SHORT_TERM_GOAL",
			})
			.returning();

		if (!midasBucket) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create Midas bucket for short-term goal",
			);
		}

		// 4. Insert short_term_goals anchor identity
		const [goal] = await tx
			.insert(shortTermGoals)
			.values({
				userId,
				midasAccountId,
				midasBucketId: midasBucket.id,
			})
			.returning();

		if (!goal) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create short-term goal identity",
			);
		}

		// 5. Calculate revision 1 fingerprint & insert revision
		const revisionFingerprint = await calculateShortTermGoalRevisionFingerprint(
			{
				userId,
				goalId: goal.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "ACTIVE",
				name,
				fundingTarget: parsedTarget.normalized,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				changeReason: null,
				occurredAt,
			},
		);

		const [revision] = await tx
			.insert(shortTermGoalRevisions)
			.values({
				userId,
				goalId: goal.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "ACTIVE",
				name,
				fundingTarget: parsedTarget.normalized,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				changeReason: null,
				occurredAt,
				idempotencyKey,
				revisionFingerprint,
			})
			.returning();

		if (!revision) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create short-term goal revision",
			);
		}

		// 6. Update manual priority ordering
		const [latestPriority] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(shortTermGoalPriorityRevisions.midasAccountId, midasAccountId),
					eq(shortTermGoalPriorityRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
			.limit(1);

		const currentOrderedList: string[] = latestPriority
			? (latestPriority.orderedGoalIds as string[])
			: [];

		const nextOrderedList = [...currentOrderedList];
		if (
			params.priorityIndex !== undefined &&
			params.priorityIndex !== null &&
			params.priorityIndex >= 0 &&
			params.priorityIndex <= nextOrderedList.length
		) {
			nextOrderedList.splice(params.priorityIndex, 0, goal.id);
		} else {
			nextOrderedList.push(goal.id);
		}

		const nextPriorityRevNo = (latestPriority?.revisionNo ?? 0) + 1;
		const priorityFingerprint = await calculateShortTermGoalPriorityFingerprint(
			{
				userId,
				midasAccountId,
				revisionNo: nextPriorityRevNo,
				previousRevisionId: latestPriority ? latestPriority.id : null,
				orderedGoalIds: nextOrderedList,
				occurredAt,
			},
		);

		const priorityIdempotencyKey = `${idempotencyKey}:priority`;

		await tx.insert(shortTermGoalPriorityRevisions).values({
			userId,
			midasAccountId,
			revisionNo: nextPriorityRevNo,
			previousRevisionId: latestPriority ? latestPriority.id : null,
			orderedGoalIds: nextOrderedList,
			idempotencyKey: priorityIdempotencyKey,
			priorityFingerprint,
			occurredAt,
		});

		const priorityIdx = nextOrderedList.indexOf(goal.id);

		const { accumulatedAmount, fundingStatus, progressPercentage } =
			deriveFundingMetrics(0n, parsedTarget.cents);

		return {
			id: goal.id,
			userId: goal.userId,
			midasAccountId: goal.midasAccountId,
			midasBucketId: goal.midasBucketId,
			status: revision.status as ShortTermGoalStatus,
			name: revision.name,
			fundingTarget: revision.fundingTarget,
			accumulatedAmount,
			fundingStatus,
			progressPercentage,
			targetDate: revision.targetDate,
			maxBudget: revision.maxBudget,
			targetPrice: revision.targetPrice,
			productUrl: revision.productUrl,
			note: revision.note,
			priorityIndex: priorityIdx >= 0 ? priorityIdx : null,
			latestRevisionNo: revision.revisionNo,
			createdAt: goal.createdAt,
			updatedAt: revision.occurredAt,
		};
	});
}

/**
 * Updates an active short-term goal configuration.
 */
export async function updateShortTermGoal(
	params: UpdateShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");
	const idempotencyKey = validateRequiredTrimmedText(
		params.idempotencyKey,
		"idempotencyKey",
		128,
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const changeReason = validateOptionalTrimmedText(
		params.changeReason,
		"changeReason",
		500,
	);

	return await params.db.transaction(async (tx) => {
		// 1. Early idempotency check
		const [existingRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, userId),
					eq(shortTermGoalRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRev) {
			if (existingRev.goalId !== goalId) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different goal",
				);
			}
			return await getShortTermGoalInTx({ tx, userId, goalId });
		}

		// 2. Fetch goal identity
		const [goal] = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(eq(shortTermGoals.id, goalId), eq(shortTermGoals.userId, userId)),
			)
			.limit(1);

		if (!goal) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"Short-term goal not found",
			);
		}

		// 3. Lock parent Midas account FOR UPDATE
		await tx
			.select()
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, goal.midasAccountId),
					eq(midasAccounts.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		// 4. Fetch latest revision
		const [latestRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.goalId, goalId),
					eq(shortTermGoalRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"No revisions found for goal",
			);
		}

		if (latestRev.status !== "ACTIVE") {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_ACTIVE",
				`Cannot update goal in ${latestRev.status} status`,
			);
		}

		// 5. Merge fields
		const name =
			params.name !== undefined
				? validateRequiredTrimmedText(params.name, "name", 120)
				: latestRev.name;

		const fundingTarget =
			params.fundingTarget !== undefined
				? validatePositiveMoneyString(params.fundingTarget, "fundingTarget")
						.normalized
				: latestRev.fundingTarget;

		const targetDate =
			params.targetDate !== undefined
				? validateGregorianDate(params.targetDate, "targetDate")
				: latestRev.targetDate;

		let maxBudget = latestRev.maxBudget;
		if (params.maxBudget !== undefined) {
			if (params.maxBudget === null) {
				maxBudget = null;
			} else {
				const parsedMax = validatePositiveMoneyString(
					params.maxBudget,
					"maxBudget",
				);
				maxBudget = parsedMax.normalized;
			}
		}

		// Validate maxBudget >= fundingTarget
		const targetParsed = parseMoneyString(fundingTarget);
		if (maxBudget !== null) {
			const maxParsed = parseMoneyString(maxBudget);
			if (maxParsed.cents < targetParsed.cents) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_INPUT",
					`maxBudget (${maxBudget}) cannot be less than fundingTarget (${fundingTarget})`,
				);
			}

			// Validate current bucket balance does not exceed new maxBudget
			const [balanceRow] = await tx
				.select({
					netAmount: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${goal.midasBucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${goal.midasBucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
				})
				.from(midasAllocationTransfers)
				.where(
					eq(midasAllocationTransfers.midasAccountId, goal.midasAccountId),
				);

			const currentAccumulated = parseSignedAggregateMoneyString(
				balanceRow?.netAmount ?? "0.00",
			);

			if (currentAccumulated.cents > maxParsed.cents) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED",
					`Current accumulated balance (${currentAccumulated.normalized}) exceeds new maxBudget (${maxBudget})`,
				);
			}
		}

		let targetPrice = latestRev.targetPrice;
		if (params.targetPrice !== undefined) {
			if (params.targetPrice === null) {
				targetPrice = null;
			} else {
				targetPrice = validatePositiveMoneyString(
					params.targetPrice,
					"targetPrice",
				).normalized;
			}
		}

		const productUrl =
			params.productUrl !== undefined
				? validateProductUrl(params.productUrl)
				: latestRev.productUrl;

		const note =
			params.note !== undefined
				? validateOptionalTrimmedText(params.note, "note", 500)
				: latestRev.note;

		const nextRevNo = latestRev.revisionNo + 1;

		const revisionFingerprint = await calculateShortTermGoalRevisionFingerprint(
			{
				userId,
				goalId,
				revisionNo: nextRevNo,
				previousRevisionId: latestRev.id,
				operation: "UPDATE",
				status: "ACTIVE",
				name,
				fundingTarget,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				changeReason,
				occurredAt,
			},
		);

		await tx.insert(shortTermGoalRevisions).values({
			userId,
			goalId,
			revisionNo: nextRevNo,
			previousRevisionId: latestRev.id,
			operation: "UPDATE",
			status: "ACTIVE",
			name,
			fundingTarget,
			targetDate,
			maxBudget,
			targetPrice,
			productUrl,
			note,
			changeReason,
			occurredAt,
			idempotencyKey,
			revisionFingerprint,
		});

		return await getShortTermGoalInTx({ tx, userId, goalId });
	});
}

/**
 * Transitions a short-term goal to COMPLETED status (requires 0.00 bucket balance).
 */
export async function completeShortTermGoal(
	params: CompleteShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	return await transitionTerminalStatus({
		...params,
		targetStatus: "COMPLETED",
		operation: "COMPLETE",
	});
}

/**
 * Transitions a short-term goal to CANCELLED status (requires 0.00 bucket balance).
 */
export async function cancelShortTermGoal(
	params: CancelShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	return await transitionTerminalStatus({
		...params,
		targetStatus: "CANCELLED",
		operation: "CANCEL",
	});
}

async function transitionTerminalStatus(params: {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
	targetStatus: ShortTermGoalStatus;
	operation: ShortTermGoalOperation;
}): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");
	const idempotencyKey = validateRequiredTrimmedText(
		params.idempotencyKey,
		"idempotencyKey",
		128,
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const changeReason = validateOptionalTrimmedText(
		params.changeReason,
		"changeReason",
		500,
	);

	return await params.db.transaction(async (tx) => {
		// 1. Early idempotency check
		const [existingRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, userId),
					eq(shortTermGoalRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRev) {
			if (existingRev.goalId !== goalId) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different goal",
				);
			}
			return await getShortTermGoalInTx({ tx, userId, goalId });
		}

		// 2. Fetch goal identity
		const [goal] = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(eq(shortTermGoals.id, goalId), eq(shortTermGoals.userId, userId)),
			)
			.limit(1);

		if (!goal) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"Short-term goal not found",
			);
		}

		// 3. Lock parent Midas account FOR UPDATE
		await tx
			.select()
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, goal.midasAccountId),
					eq(midasAccounts.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		// 4. Fetch latest revision
		const [latestRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.goalId, goalId),
					eq(shortTermGoalRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"No revisions found for goal",
			);
		}

		if (latestRev.status !== "ACTIVE") {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_ACTIVE",
				`Cannot transition goal in ${latestRev.status} status to ${params.targetStatus}`,
			);
		}

		// 5. Verify bucket balance is exactly 0.00
		const [balanceRow] = await tx
			.select({
				netAmount: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${goal.midasBucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${goal.midasBucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
			})
			.from(midasAllocationTransfers)
			.where(eq(midasAllocationTransfers.midasAccountId, goal.midasAccountId));

		const currentAccumulated = parseSignedAggregateMoneyString(
			balanceRow?.netAmount ?? "0.00",
		);

		if (currentAccumulated.cents !== 0n) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NON_ZERO_BALANCE",
				`Cannot transition goal to ${params.targetStatus} with non-zero accumulated balance (${currentAccumulated.normalized}). Release or reallocate funds first.`,
			);
		}

		// 6. Insert terminal revision (exact copy of config fields)
		const nextRevNo = latestRev.revisionNo + 1;

		const revisionFingerprint = await calculateShortTermGoalRevisionFingerprint(
			{
				userId,
				goalId,
				revisionNo: nextRevNo,
				previousRevisionId: latestRev.id,
				operation: params.operation,
				status: params.targetStatus,
				name: latestRev.name,
				fundingTarget: latestRev.fundingTarget,
				targetDate: latestRev.targetDate,
				maxBudget: latestRev.maxBudget,
				targetPrice: latestRev.targetPrice,
				productUrl: latestRev.productUrl,
				note: latestRev.note,
				changeReason,
				occurredAt,
			},
		);

		await tx.insert(shortTermGoalRevisions).values({
			userId,
			goalId,
			revisionNo: nextRevNo,
			previousRevisionId: latestRev.id,
			operation: params.operation,
			status: params.targetStatus,
			name: latestRev.name,
			fundingTarget: latestRev.fundingTarget,
			targetDate: latestRev.targetDate,
			maxBudget: latestRev.maxBudget,
			targetPrice: latestRev.targetPrice,
			productUrl: latestRev.productUrl,
			note: latestRev.note,
			changeReason,
			occurredAt,
			idempotencyKey,
			revisionFingerprint,
		});

		// 7. Update priority revision (remove goal from active ordered array)
		const [latestPriority] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(
						shortTermGoalPriorityRevisions.midasAccountId,
						goal.midasAccountId,
					),
					eq(shortTermGoalPriorityRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
			.limit(1);

		const currentOrderedList: string[] = latestPriority
			? (latestPriority.orderedGoalIds as string[])
			: [];

		const nextOrderedList = currentOrderedList.filter((id) => id !== goalId);

		const nextPriorityRevNo = (latestPriority?.revisionNo ?? 0) + 1;
		const priorityFingerprint = await calculateShortTermGoalPriorityFingerprint(
			{
				userId,
				midasAccountId: goal.midasAccountId,
				revisionNo: nextPriorityRevNo,
				previousRevisionId: latestPriority ? latestPriority.id : null,
				orderedGoalIds: nextOrderedList,
				occurredAt,
			},
		);

		const priorityIdempotencyKey = `${idempotencyKey}:priority`;

		await tx.insert(shortTermGoalPriorityRevisions).values({
			userId,
			midasAccountId: goal.midasAccountId,
			revisionNo: nextPriorityRevNo,
			previousRevisionId: latestPriority ? latestPriority.id : null,
			orderedGoalIds: nextOrderedList,
			idempotencyKey: priorityIdempotencyKey,
			priorityFingerprint,
			occurredAt,
		});

		return await getShortTermGoalInTx({ tx, userId, goalId });
	});
}

/**
 * Updates the manual priority ordering of ACTIVE goals for a Midas account.
 */
export async function reorderShortTermGoals(
	params: ReorderShortTermGoalsParams,
): Promise<ShortTermGoalRecord[]> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);
	const idempotencyKey = validateRequiredTrimmedText(
		params.idempotencyKey,
		"idempotencyKey",
		128,
	);
	const occurredAt = validateOccurredAt(params.occurredAt);

	if (!Array.isArray(params.orderedGoalIds)) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_INPUT",
			"orderedGoalIds must be an array",
		);
	}

	const normalizedGoalIds = params.orderedGoalIds.map((id, index) =>
		validateCanonicalUuid(id, `orderedGoalIds[${index}]`),
	);

	// Check duplicates
	const uniqueSet = new Set(normalizedGoalIds);
	if (uniqueSet.size !== normalizedGoalIds.length) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_PRIORITY_COLLISION",
			"orderedGoalIds contains duplicate goal IDs",
		);
	}

	return await params.db.transaction(async (tx) => {
		// 1. Early idempotency check
		const [existingPriority] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(shortTermGoalPriorityRevisions.userId, userId),
					eq(shortTermGoalPriorityRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingPriority) {
			const candidateFp = await calculateShortTermGoalPriorityFingerprint({
				userId,
				midasAccountId,
				revisionNo: existingPriority.revisionNo,
				previousRevisionId: existingPriority.previousRevisionId,
				orderedGoalIds: normalizedGoalIds,
				occurredAt,
			});

			if (existingPriority.priorityFingerprint !== candidateFp) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different priority ordering",
				);
			}

			return await listShortTermGoalsInTx({
				tx,
				userId,
				midasAccountId,
				status: "ACTIVE",
			});
		}

		// 2. Lock parent Midas account FOR UPDATE
		const [midasAccount] = await tx
			.select()
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, midasAccountId),
					eq(midasAccounts.userId, userId),
				),
			)
			.for("update")
			.limit(1);

		if (!midasAccount) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND",
				"Midas account not found",
			);
		}

		// 3. Fetch all active goals for account
		const activeGoals = await listActiveGoalIdsInTx({
			tx,
			userId,
			midasAccountId,
		});

		const activeSet = new Set(activeGoals);
		if (activeSet.size !== uniqueSet.size) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_PRIORITY_MISMATCH",
				`Priority list count (${uniqueSet.size}) does not match active goals count (${activeSet.size})`,
			);
		}

		for (const goalId of normalizedGoalIds) {
			if (!activeSet.has(goalId)) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_PRIORITY_MISMATCH",
					`Goal "${goalId}" in priority list is not an active goal of this Midas account`,
				);
			}
		}

		// 4. Fetch latest priority revision
		const [latestPriority] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(shortTermGoalPriorityRevisions.midasAccountId, midasAccountId),
					eq(shortTermGoalPriorityRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
			.limit(1);

		const nextPriorityRevNo = (latestPriority?.revisionNo ?? 0) + 1;
		const priorityFingerprint = await calculateShortTermGoalPriorityFingerprint(
			{
				userId,
				midasAccountId,
				revisionNo: nextPriorityRevNo,
				previousRevisionId: latestPriority ? latestPriority.id : null,
				orderedGoalIds: normalizedGoalIds,
				occurredAt,
			},
		);

		await tx.insert(shortTermGoalPriorityRevisions).values({
			userId,
			midasAccountId,
			revisionNo: nextPriorityRevNo,
			previousRevisionId: latestPriority ? latestPriority.id : null,
			orderedGoalIds: normalizedGoalIds,
			idempotencyKey,
			priorityFingerprint,
			occurredAt,
		});

		return await listShortTermGoalsInTx({
			tx,
			userId,
			midasAccountId,
			status: "ACTIVE",
		});
	});
}

/**
 * Virtually funds a short-term goal by transferring liquidity into its Midas bucket.
 */
export async function fundShortTermGoal(
	params: FundShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");
	const idempotencyKey = validateRequiredTrimmedText(
		params.idempotencyKey,
		"idempotencyKey",
		128,
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const memo = validateOptionalTrimmedText(params.memo, "memo", 500);
	const fromBucketId =
		params.fromBucketId !== undefined && params.fromBucketId !== null
			? validateCanonicalUuid(params.fromBucketId, "fromBucketId")
			: null;

	const parsedAmount = validatePositiveMoneyString(params.amount, "amount");

	return await params.db.transaction(async (tx) => {
		// 1. Fetch goal
		const [goal] = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(eq(shortTermGoals.id, goalId), eq(shortTermGoals.userId, userId)),
			)
			.limit(1);

		if (!goal) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"Short-term goal not found",
			);
		}

		// 2. Fetch latest revision to verify ACTIVE status and maxBudget
		const [latestRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.goalId, goalId),
					eq(shortTermGoalRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"No revisions found for goal",
			);
		}

		if (latestRev.status !== "ACTIVE") {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_ACTIVE",
				`Cannot fund goal in ${latestRev.status} status`,
			);
		}

		// 3. Pre-check maxBudget if configured
		if (latestRev.maxBudget !== null) {
			const maxParsed = parseMoneyString(latestRev.maxBudget);
			const [balanceRow] = await tx
				.select({
					netAmount: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${goal.midasBucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${goal.midasBucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
				})
				.from(midasAllocationTransfers)
				.where(
					eq(midasAllocationTransfers.midasAccountId, goal.midasAccountId),
				);

			const currentAccumulated = parseSignedAggregateMoneyString(
				balanceRow?.netAmount ?? "0.00",
			);

			if (currentAccumulated.cents + parsedAmount.cents > maxParsed.cents) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED",
					`Transfer amount ${parsedAmount.normalized} would exceed goal maxBudget ${latestRev.maxBudget} (current accumulated: ${currentAccumulated.normalized})`,
				);
			}
		}

		// 4. Delegate to Midas allocation transfer
		try {
			await createMidasAllocationTransferInTransaction({
				tx,
				userId,
				midasAccountId: goal.midasAccountId,
				idempotencyKey,
				fromBucketId,
				toBucketId: goal.midasBucketId,
				amount: parsedAmount.normalized,
				occurredAt,
				memo: memo ?? `Virtual funding for short-term goal: ${latestRev.name}`,
			});
		} catch (err: unknown) {
			if (err instanceof MidasError) {
				if (err.code === "MIDAS_BUCKET_INACTIVE") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_NOT_ACTIVE",
						"Cannot fund goal because goal is not active",
					);
				}
				if (err.code === "MIDAS_BUCKET_CAP_EXCEEDED") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED",
						"Funding amount would exceed goal maximum budget",
					);
				}
				if (err.code === "MIDAS_IDEMPOTENCY_CONFLICT") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
						err.message,
					);
				}
			}
			throw err;
		}

		return await getShortTermGoalInTx({ tx, userId, goalId });
	});
}

/**
 * Virtually releases funding from a short-term goal back to unallocated liquidity or another bucket.
 */
export async function releaseShortTermGoalFunding(
	params: ReleaseShortTermGoalFundingParams,
): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");
	const idempotencyKey = validateRequiredTrimmedText(
		params.idempotencyKey,
		"idempotencyKey",
		128,
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const memo = validateOptionalTrimmedText(params.memo, "memo", 500);
	const toBucketId =
		params.toBucketId !== undefined && params.toBucketId !== null
			? validateCanonicalUuid(params.toBucketId, "toBucketId")
			: null;

	const parsedAmount = validatePositiveMoneyString(params.amount, "amount");

	return await params.db.transaction(async (tx) => {
		// 1. Fetch goal
		const [goal] = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(eq(shortTermGoals.id, goalId), eq(shortTermGoals.userId, userId)),
			)
			.limit(1);

		if (!goal) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"Short-term goal not found",
			);
		}

		// 2. Fetch latest revision
		const [latestRev] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.goalId, goalId),
					eq(shortTermGoalRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);

		if (!latestRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_FOUND",
				"No revisions found for goal",
			);
		}

		// 3. Delegate to Midas allocation transfer
		try {
			await createMidasAllocationTransferInTransaction({
				tx,
				userId,
				midasAccountId: goal.midasAccountId,
				idempotencyKey,
				fromBucketId: goal.midasBucketId,
				toBucketId,
				amount: parsedAmount.normalized,
				occurredAt,
				memo:
					memo ??
					`Virtual funding release for short-term goal: ${latestRev.name}`,
			});
		} catch (err: unknown) {
			if (err instanceof MidasError) {
				if (err.code === "MIDAS_BUCKET_INACTIVE") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_NOT_ACTIVE",
						"Cannot transfer into target goal because it is not active",
					);
				}
				if (err.code === "MIDAS_BUCKET_CAP_EXCEEDED") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED",
						"Transfer would exceed target goal maximum budget",
					);
				}
				if (err.code === "MIDAS_IDEMPOTENCY_CONFLICT") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
						err.message,
					);
				}
			}
			throw err;
		}

		return await getShortTermGoalInTx({ tx, userId, goalId });
	});
}

/**
 * Retrieves a single short-term goal with derived funding status.
 */
export async function getShortTermGoal(
	params: GetShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");

	return await getShortTermGoalInTx({
		tx: params.db,
		userId,
		goalId,
	});
}

/**
 * Lists all short-term goals for a Midas account ordered by priority (ACTIVE) then recent (terminal).
 */
export async function listShortTermGoals(
	params: ListShortTermGoalsParams,
): Promise<ShortTermGoalRecord[]> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);

	return await listShortTermGoalsInTx({
		tx: params.db,
		userId,
		midasAccountId,
		status: params.status,
	});
}

// ---------------------------------------------------------
// Internal Transactional Helpers
// ---------------------------------------------------------

async function getShortTermGoalInTx(params: {
	tx: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
}): Promise<ShortTermGoalRecord> {
	const { tx, userId, goalId } = params;

	const [goal] = await tx
		.select()
		.from(shortTermGoals)
		.where(
			and(eq(shortTermGoals.id, goalId), eq(shortTermGoals.userId, userId)),
		)
		.limit(1);

	if (!goal) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_NOT_FOUND",
			"Short-term goal not found",
		);
	}

	const [latestRev] = await tx
		.select()
		.from(shortTermGoalRevisions)
		.where(
			and(
				eq(shortTermGoalRevisions.goalId, goalId),
				eq(shortTermGoalRevisions.userId, userId),
			),
		)
		.orderBy(desc(shortTermGoalRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_NOT_FOUND",
			"No revisions found for goal",
		);
	}

	const [balanceRow] = await tx
		.select({
			netAmount: sql<string>`COALESCE(SUM(CASE WHEN ${midasAllocationTransfers.toBucketId} = ${goal.midasBucketId} THEN ${midasAllocationTransfers.amount} WHEN ${midasAllocationTransfers.fromBucketId} = ${goal.midasBucketId} THEN -${midasAllocationTransfers.amount} ELSE 0 END), 0)::text`,
		})
		.from(midasAllocationTransfers)
		.where(eq(midasAllocationTransfers.midasAccountId, goal.midasAccountId));

	const parsedAccumulated = parseSignedAggregateMoneyString(
		balanceRow?.netAmount ?? "0.00",
	);

	const parsedTarget = parseMoneyString(latestRev.fundingTarget);

	const { accumulatedAmount, fundingStatus, progressPercentage } =
		deriveFundingMetrics(parsedAccumulated.cents, parsedTarget.cents);

	// Priority resolution
	let priorityIndex: number | null = null;
	if (latestRev.status === "ACTIVE") {
		const [latestPriority] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(
						shortTermGoalPriorityRevisions.midasAccountId,
						goal.midasAccountId,
					),
					eq(shortTermGoalPriorityRevisions.userId, userId),
				),
			)
			.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
			.limit(1);

		if (latestPriority) {
			const list = latestPriority.orderedGoalIds as string[];
			const idx = list.indexOf(goalId);
			priorityIndex = idx >= 0 ? idx : null;
		}
	}

	return {
		id: goal.id,
		userId: goal.userId,
		midasAccountId: goal.midasAccountId,
		midasBucketId: goal.midasBucketId,
		status: latestRev.status as ShortTermGoalStatus,
		name: latestRev.name,
		fundingTarget: latestRev.fundingTarget,
		accumulatedAmount,
		fundingStatus,
		progressPercentage,
		targetDate: latestRev.targetDate,
		maxBudget: latestRev.maxBudget,
		targetPrice: latestRev.targetPrice,
		productUrl: latestRev.productUrl,
		note: latestRev.note,
		priorityIndex,
		latestRevisionNo: latestRev.revisionNo,
		createdAt: goal.createdAt,
		updatedAt: latestRev.occurredAt,
	};
}

async function listActiveGoalIdsInTx(params: {
	tx: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
}): Promise<string[]> {
	const { tx, userId, midasAccountId } = params;

	// Query latest revision for every goal in this account
	const goals = await tx
		.select({ id: shortTermGoals.id })
		.from(shortTermGoals)
		.where(
			and(
				eq(shortTermGoals.midasAccountId, midasAccountId),
				eq(shortTermGoals.userId, userId),
			),
		);

	if (goals.length === 0) return [];

	const goalIds = goals.map((g) => g.id);

	// Select latest revision for each goal
	const revisions = await tx
		.select({
			goalId: shortTermGoalRevisions.goalId,
			status: shortTermGoalRevisions.status,
			revisionNo: shortTermGoalRevisions.revisionNo,
		})
		.from(shortTermGoalRevisions)
		.where(
			and(
				eq(shortTermGoalRevisions.userId, userId),
				inArray(shortTermGoalRevisions.goalId, goalIds),
			),
		)
		.orderBy(desc(shortTermGoalRevisions.revisionNo));

	const latestStatusMap = new Map<string, string>();
	for (const rev of revisions) {
		if (!latestStatusMap.has(rev.goalId)) {
			latestStatusMap.set(rev.goalId, rev.status);
		}
	}

	return goalIds.filter((id) => latestStatusMap.get(id) === "ACTIVE");
}

async function listShortTermGoalsInTx(params: {
	tx: Database | DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	status?: ShortTermGoalStatus | undefined;
}): Promise<ShortTermGoalRecord[]> {
	const { tx, userId, midasAccountId, status } = params;

	const goals = await tx
		.select()
		.from(shortTermGoals)
		.where(
			and(
				eq(shortTermGoals.midasAccountId, midasAccountId),
				eq(shortTermGoals.userId, userId),
			),
		);

	if (goals.length === 0) return [];

	const goalIds = goals.map((g) => g.id);

	// Fetch all revisions
	const allRevisions = await tx
		.select()
		.from(shortTermGoalRevisions)
		.where(
			and(
				eq(shortTermGoalRevisions.userId, userId),
				inArray(shortTermGoalRevisions.goalId, goalIds),
			),
		)
		.orderBy(desc(shortTermGoalRevisions.revisionNo));

	const latestRevMap = new Map<string, (typeof allRevisions)[0]>();
	for (const rev of allRevisions) {
		if (!latestRevMap.has(rev.goalId)) {
			latestRevMap.set(rev.goalId, rev);
		}
	}

	// Fetch all bucket balances in one query
	const bucketIds = goals.map((g) => g.midasBucketId);
	const balances = await tx
		.select({
			toBucketId: midasAllocationTransfers.toBucketId,
			fromBucketId: midasAllocationTransfers.fromBucketId,
			amount: midasAllocationTransfers.amount,
		})
		.from(midasAllocationTransfers)
		.where(
			and(
				eq(midasAllocationTransfers.midasAccountId, midasAccountId),
				or(
					inArray(midasAllocationTransfers.toBucketId, bucketIds),
					inArray(midasAllocationTransfers.fromBucketId, bucketIds),
				),
			),
		);

	const bucketBalanceCentsMap = new Map<string, bigint>();
	for (const b of bucketIds) {
		bucketBalanceCentsMap.set(b, 0n);
	}

	for (const row of balances) {
		const parsed = parseMoneyString(row.amount);
		if (row.toBucketId && bucketBalanceCentsMap.has(row.toBucketId)) {
			const curr = bucketBalanceCentsMap.get(row.toBucketId) ?? 0n;
			bucketBalanceCentsMap.set(row.toBucketId, curr + parsed.cents);
		}
		if (row.fromBucketId && bucketBalanceCentsMap.has(row.fromBucketId)) {
			const curr = bucketBalanceCentsMap.get(row.fromBucketId) ?? 0n;
			bucketBalanceCentsMap.set(row.fromBucketId, curr - parsed.cents);
		}
	}

	// Priority list
	const [latestPriority] = await tx
		.select()
		.from(shortTermGoalPriorityRevisions)
		.where(
			and(
				eq(shortTermGoalPriorityRevisions.midasAccountId, midasAccountId),
				eq(shortTermGoalPriorityRevisions.userId, userId),
			),
		)
		.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
		.limit(1);

	const priorityOrder: string[] = latestPriority
		? (latestPriority.orderedGoalIds as string[])
		: [];

	const priorityMap = new Map<string, number>();
	priorityOrder.forEach((id, idx) => {
		priorityMap.set(id, idx);
	});

	const records: ShortTermGoalRecord[] = [];

	for (const goal of goals) {
		const latestRev = latestRevMap.get(goal.id);
		if (!latestRev) continue;

		if (status && latestRev.status !== status) {
			continue;
		}

		const balanceCents = bucketBalanceCentsMap.get(goal.midasBucketId) ?? 0n;
		const targetParsed = parseMoneyString(latestRev.fundingTarget);

		const { accumulatedAmount, fundingStatus, progressPercentage } =
			deriveFundingMetrics(balanceCents, targetParsed.cents);

		const pIdx =
			latestRev.status === "ACTIVE" && priorityMap.has(goal.id)
				? (priorityMap.get(goal.id) ?? null)
				: null;

		records.push({
			id: goal.id,
			userId: goal.userId,
			midasAccountId: goal.midasAccountId,
			midasBucketId: goal.midasBucketId,
			status: latestRev.status as ShortTermGoalStatus,
			name: latestRev.name,
			fundingTarget: latestRev.fundingTarget,
			accumulatedAmount,
			fundingStatus,
			progressPercentage,
			targetDate: latestRev.targetDate,
			maxBudget: latestRev.maxBudget,
			targetPrice: latestRev.targetPrice,
			productUrl: latestRev.productUrl,
			note: latestRev.note,
			priorityIndex: pIdx,
			latestRevisionNo: latestRev.revisionNo,
			createdAt: goal.createdAt,
			updatedAt: latestRev.occurredAt,
		});
	}

	// Sort: Active goals by priorityIndex ascending, non-active goals by updatedAt descending
	records.sort((a, b) => {
		if (a.status === "ACTIVE" && b.status === "ACTIVE") {
			const idxA = a.priorityIndex ?? Number.MAX_SAFE_INTEGER;
			const idxB = b.priorityIndex ?? Number.MAX_SAFE_INTEGER;
			return idxA - idxB;
		}
		if (a.status === "ACTIVE") return -1;
		if (b.status === "ACTIVE") return 1;
		return b.updatedAt.getTime() - a.updatedAt.getTime();
	});

	return records;
}
