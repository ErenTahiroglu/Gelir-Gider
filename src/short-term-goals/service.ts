import { and, desc, eq, inArray } from "drizzle-orm";
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
import { formatSignedCentsToMoney, parseMoneyString } from "../ledger/money";
import { MidasError } from "../midas/errors";
import {
	createMidasAllocationTransferInTransaction,
	getMidasLiquidityStateInTransaction,
} from "../midas/service";
import {
	validateCanonicalUuid,
	validateExpectedRevisionNo,
	validateGregorianDate,
	validateOccurredAt,
	validateOptionalTrimmedText,
	validatePositiveMoneyString,
	validatePriorityPosition,
	validateProductUrl,
	validateRequiredTrimmedText,
	validateSuppliedPriorityPosition,
} from "./calendar";
import { ShortTermGoalError } from "./errors";
import {
	calculateShortTermGoalCreateFingerprintV2,
	calculateShortTermGoalPriorityFingerprint,
	calculateShortTermGoalRevisionFingerprintV1,
	calculateShortTermGoalTerminalFingerprintV2,
	calculateShortTermGoalUpdateFingerprintV2,
	generateHashedPriorityIdempotencyKey,
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
	remainingToTarget: string; // exact BigInt-cent: max(fundingTarget - accumulatedAmount, 0)
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	priority: number | null; // 1-based: 1, 2, 3... or null
	latestRevisionNo: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface ShortTermGoalLifecycleResult {
	goalId: string;
	revisionId: string;
	revisionNo: number;
	operation: ShortTermGoalOperation;
	status: ShortTermGoalStatus;
	idempotentReplay: boolean;
	snapshot: {
		name: string;
		fundingTarget: string;
		targetDate: string | null;
		maxBudget: string | null;
		targetPrice: string | null;
		productUrl: string | null;
		note: string | null;
	};
}

export interface ShortTermGoalReorderResult {
	priorityRevisionId: string;
	revisionNo: number;
	orderedGoalIds: string[];
	idempotentReplay: boolean;
}

export interface ShortTermGoalFundingResult {
	goalId: string;
	transferId: string;
	amount: string;
	idempotentReplay: boolean;
}

export interface ShortTermGoalReleaseResult {
	goalId: string;
	transferId: string;
	amount: string;
	idempotentReplay: boolean;
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
	priorityPosition?: number | null; // 1-based
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdateShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	expectedRevisionNo: number;
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
	expectedRevisionNo: number;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface CancelShortTermGoalParams {
	db: Database | DatabaseTransaction;
	userId: string;
	goalId: string;
	expectedRevisionNo: number;
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
	db: Database;
	userId: string;
	goalId: string;
}

export interface GetShortTermGoalInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	goalId: string;
}

export interface ListShortTermGoalsParams {
	db: Database;
	userId: string;
	midasAccountId: string;
	status?: ShortTermGoalStatus | undefined;
	includeTerminal?: boolean | undefined;
}

export interface ListShortTermGoalsInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	midasAccountId: string;
	status?: ShortTermGoalStatus | undefined;
	includeTerminal?: boolean | undefined;
}

function deriveFundingMetrics(
	accumulatedCents: bigint,
	targetCents: bigint,
): {
	accumulatedAmount: string;
	remainingToTarget: string;
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
} {
	const safeAccumulated = accumulatedCents < 0n ? 0n : accumulatedCents;
	const accumulatedAmount = formatSignedCentsToMoney(safeAccumulated);

	const remainingCents =
		targetCents > safeAccumulated ? targetCents - safeAccumulated : 0n;
	const remainingToTarget = formatSignedCentsToMoney(remainingCents);

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
			? Math.round(Number((safeAccumulated * 10000n) / targetCents)) / 100
			: 0;

	return {
		accumulatedAmount,
		remainingToTarget,
		fundingStatus,
		progressPercentage,
	};
}

async function validateAndBuildCreateReplayInTransaction(
	tx: DatabaseTransaction,
	existingRev: typeof shortTermGoalRevisions.$inferSelect,
	userId: string,
	idempotencyKey: string,
	name: string,
	parsedTargetNormalized: string,
	targetDate: string | null,
	maxBudget: string | null,
	targetPrice: string | null,
	productUrl: string | null,
	note: string | null,
	suppliedPriorityPosition: number | undefined,
	occurredAt: Date,
): Promise<ShortTermGoalLifecycleResult> {
	if (existingRev.operation !== "CREATE") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used for different operation",
		);
	}

	// 1. Resolve original priority position from the priority snapshot created by this CREATE
	const internalPriorityKey = await generateHashedPriorityIdempotencyKey(
		idempotencyKey,
		existingRev.goalId,
		"CREATE",
	);

	let [priorityRev] = await tx
		.select()
		.from(shortTermGoalPriorityRevisions)
		.where(
			and(
				eq(shortTermGoalPriorityRevisions.userId, userId),
				eq(shortTermGoalPriorityRevisions.idempotencyKey, internalPriorityKey),
			),
		)
		.limit(1);

	if (!priorityRev) {
		const legacyKey = `${idempotencyKey}:priority`;
		[priorityRev] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(shortTermGoalPriorityRevisions.userId, userId),
					eq(shortTermGoalPriorityRevisions.idempotencyKey, legacyKey),
				),
			)
			.limit(1);
	}

	let historicalPosition: number | undefined;
	if (priorityRev) {
		const orderedIds = priorityRev.orderedGoalIds as string[];
		const idx = orderedIds.indexOf(existingRev.goalId);
		if (idx === -1) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Goal ${existingRev.goalId} not found in creation priority snapshot`,
			);
		}
		historicalPosition = idx + 1;
	}

	// 2. Candidate v2 fingerprint check
	const posForV2 = suppliedPriorityPosition ?? historicalPosition;
	if (posForV2 !== undefined) {
		const candidateFpV2 = await calculateShortTermGoalCreateFingerprintV2({
			userId,
			goalId: existingRev.goalId,
			name,
			fundingTarget: parsedTargetNormalized,
			targetDate,
			maxBudget,
			targetPrice,
			productUrl,
			note,
			priorityPosition: posForV2,
			occurredAt,
		});

		if (existingRev.revisionFingerprint === candidateFpV2) {
			if (
				suppliedPriorityPosition !== undefined &&
				historicalPosition !== undefined &&
				suppliedPriorityPosition !== historicalPosition
			) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different priorityPosition",
				);
			}

			return {
				goalId: existingRev.goalId,
				revisionId: existingRev.id,
				revisionNo: existingRev.revisionNo,
				operation: existingRev.operation as ShortTermGoalOperation,
				status: existingRev.status as ShortTermGoalStatus,
				idempotentReplay: true,
				snapshot: {
					name: existingRev.name,
					fundingTarget: existingRev.fundingTarget,
					targetDate: existingRev.targetDate,
					maxBudget: existingRev.maxBudget,
					targetPrice: existingRev.targetPrice,
					productUrl: existingRev.productUrl,
					note: existingRev.note,
				},
			};
		}
	}

	// 3. Legacy v1 fallback check (Section 7)
	const candidateFpV1 = await calculateShortTermGoalRevisionFingerprintV1({
		userId,
		goalId: existingRev.goalId,
		revisionNo: existingRev.revisionNo,
		previousRevisionId: existingRev.previousRevisionId,
		operation: existingRev.operation,
		status: existingRev.status,
		name,
		fundingTarget: parsedTargetNormalized,
		targetDate,
		maxBudget,
		targetPrice,
		productUrl,
		note,
		changeReason: null,
		occurredAt,
	});

	if (existingRev.revisionFingerprint === candidateFpV1) {
		if (
			suppliedPriorityPosition !== undefined &&
			historicalPosition !== undefined &&
			suppliedPriorityPosition !== historicalPosition
		) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different priorityPosition",
			);
		}

		return {
			goalId: existingRev.goalId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as ShortTermGoalOperation,
			status: existingRev.status as ShortTermGoalStatus,
			idempotentReplay: true,
			snapshot: {
				name: existingRev.name,
				fundingTarget: existingRev.fundingTarget,
				targetDate: existingRev.targetDate,
				maxBudget: existingRev.maxBudget,
				targetPrice: existingRev.targetPrice,
				productUrl: existingRev.productUrl,
				note: existingRev.note,
			},
		};
	}

	throw new ShortTermGoalError(
		"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
		"Idempotency key already used with different parameters",
	);
}

async function validateAndBuildUpdateReplayInTransaction(
	tx: DatabaseTransaction,
	existingRev: typeof shortTermGoalRevisions.$inferSelect,
	userId: string,
	goalId: string,
	expectedRevisionNo: number,
	params: UpdateShortTermGoalParams,
	changeReason: string | null,
	occurredAt: Date,
): Promise<ShortTermGoalLifecycleResult> {
	if (existingRev.goalId !== goalId || existingRev.operation !== "UPDATE") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used for different goal or operation",
		);
	}

	if (!existingRev.previousRevisionId) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			"UPDATE revision has no previousRevisionId",
		);
	}

	// Load predecessor
	const [predecessor] = await tx
		.select()
		.from(shortTermGoalRevisions)
		.where(
			and(
				eq(shortTermGoalRevisions.id, existingRev.previousRevisionId),
				eq(shortTermGoalRevisions.userId, userId),
				eq(shortTermGoalRevisions.goalId, goalId),
			),
		)
		.limit(1);

	if (!predecessor || predecessor.revisionNo !== existingRev.revisionNo - 1) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			"UPDATE revision predecessor missing or invalid",
		);
	}

	if (expectedRevisionNo !== predecessor.revisionNo) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
			`Idempotency key was used with expectedRevisionNo ${predecessor.revisionNo}, caller supplied ${expectedRevisionNo}`,
		);
	}

	// Reconstruct caller's intended resulting snapshot by applying caller fields to PREDECESSOR snapshot
	const intendedName =
		params.name !== undefined
			? validateRequiredTrimmedText(params.name, "name", 120)
			: predecessor.name;

	const intendedFundingTarget =
		params.fundingTarget !== undefined
			? validatePositiveMoneyString(params.fundingTarget, "fundingTarget")
					.normalized
			: predecessor.fundingTarget;

	const intendedTargetDate =
		params.targetDate !== undefined
			? validateGregorianDate(params.targetDate, "targetDate")
			: predecessor.targetDate;

	const intendedMaxBudget =
		params.maxBudget !== undefined
			? params.maxBudget === null
				? null
				: validatePositiveMoneyString(params.maxBudget, "maxBudget").normalized
			: predecessor.maxBudget;

	const intendedTargetPrice =
		params.targetPrice !== undefined
			? params.targetPrice === null
				? null
				: validatePositiveMoneyString(params.targetPrice, "targetPrice")
						.normalized
			: predecessor.targetPrice;

	const intendedProductUrl =
		params.productUrl !== undefined
			? validateProductUrl(params.productUrl)
			: predecessor.productUrl;

	const intendedNote =
		params.note !== undefined
			? validateOptionalTrimmedText(params.note, "note", 500)
			: predecessor.note;

	// Validate maxBudget >= fundingTarget on intended snapshot
	if (intendedMaxBudget !== null) {
		const maxParsed = parseMoneyString(intendedMaxBudget);
		const targetParsed = parseMoneyString(intendedFundingTarget);
		if (maxParsed.cents < targetParsed.cents) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_INPUT",
				`maxBudget (${intendedMaxBudget}) cannot be less than fundingTarget (${intendedFundingTarget})`,
			);
		}
	}

	// Candidate v2 check
	const candidateFpV2 = await calculateShortTermGoalUpdateFingerprintV2({
		userId,
		goalId,
		expectedRevisionNo,
		name: intendedName,
		fundingTarget: intendedFundingTarget,
		targetDate: intendedTargetDate,
		maxBudget: intendedMaxBudget,
		targetPrice: intendedTargetPrice,
		productUrl: intendedProductUrl,
		note: intendedNote,
		changeReason,
		occurredAt,
	});

	if (existingRev.revisionFingerprint === candidateFpV2) {
		return {
			goalId: existingRev.goalId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as ShortTermGoalOperation,
			status: existingRev.status as ShortTermGoalStatus,
			idempotentReplay: true,
			snapshot: {
				name: existingRev.name,
				fundingTarget: existingRev.fundingTarget,
				targetDate: existingRev.targetDate,
				maxBudget: existingRev.maxBudget,
				targetPrice: existingRev.targetPrice,
				productUrl: existingRev.productUrl,
				note: existingRev.note,
			},
		};
	}

	// Legacy v1 fallback check (Section 8)
	const candidateFpV1 = await calculateShortTermGoalRevisionFingerprintV1({
		userId,
		goalId,
		revisionNo: existingRev.revisionNo,
		previousRevisionId: existingRev.previousRevisionId,
		operation: "UPDATE",
		status: "ACTIVE",
		name: intendedName,
		fundingTarget: intendedFundingTarget,
		targetDate: intendedTargetDate,
		maxBudget: intendedMaxBudget,
		targetPrice: intendedTargetPrice,
		productUrl: intendedProductUrl,
		note: intendedNote,
		changeReason,
		occurredAt,
	});

	if (existingRev.revisionFingerprint === candidateFpV1) {
		return {
			goalId: existingRev.goalId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as ShortTermGoalOperation,
			status: existingRev.status as ShortTermGoalStatus,
			idempotentReplay: true,
			snapshot: {
				name: existingRev.name,
				fundingTarget: existingRev.fundingTarget,
				targetDate: existingRev.targetDate,
				maxBudget: existingRev.maxBudget,
				targetPrice: existingRev.targetPrice,
				productUrl: existingRev.productUrl,
				note: existingRev.note,
			},
		};
	}

	throw new ShortTermGoalError(
		"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
		"Idempotency key already used with different parameters",
	);
}

async function validateAndBuildTerminalReplayInTransaction(
	tx: DatabaseTransaction,
	existingRev: typeof shortTermGoalRevisions.$inferSelect,
	userId: string,
	goalId: string,
	operation: "COMPLETE" | "CANCEL",
	targetStatus: ShortTermGoalStatus,
	expectedRevisionNo: number,
	changeReason: string | null,
	occurredAt: Date,
): Promise<ShortTermGoalLifecycleResult> {
	if (existingRev.goalId !== goalId || existingRev.operation !== operation) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used for different goal or operation",
		);
	}

	// Candidate v2 check
	const candidateFpV2 = await calculateShortTermGoalTerminalFingerprintV2({
		userId,
		goalId,
		operation,
		expectedRevisionNo,
		changeReason,
		occurredAt,
	});

	if (existingRev.revisionFingerprint === candidateFpV2) {
		return {
			goalId: existingRev.goalId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as ShortTermGoalOperation,
			status: existingRev.status as ShortTermGoalStatus,
			idempotentReplay: true,
			snapshot: {
				name: existingRev.name,
				fundingTarget: existingRev.fundingTarget,
				targetDate: existingRev.targetDate,
				maxBudget: existingRev.maxBudget,
				targetPrice: existingRev.targetPrice,
				productUrl: existingRev.productUrl,
				note: existingRev.note,
			},
		};
	}

	// Legacy v1 check: must require expectedRevisionNo = existingRev.revisionNo - 1 (Section 10)
	if (!existingRev.previousRevisionId) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			"Terminal revision missing predecessor ID",
		);
	}

	const [predecessor] = await tx
		.select()
		.from(shortTermGoalRevisions)
		.where(
			and(
				eq(shortTermGoalRevisions.id, existingRev.previousRevisionId),
				eq(shortTermGoalRevisions.userId, userId),
				eq(shortTermGoalRevisions.goalId, goalId),
			),
		)
		.limit(1);

	if (!predecessor || predecessor.revisionNo !== existingRev.revisionNo - 1) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			"Terminal revision predecessor missing or invalid",
		);
	}

	if (expectedRevisionNo !== predecessor.revisionNo) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
			`Idempotency key was used with expectedRevisionNo ${predecessor.revisionNo}, caller supplied ${expectedRevisionNo}`,
		);
	}

	const candidateFpV1 = await calculateShortTermGoalRevisionFingerprintV1({
		userId,
		goalId,
		revisionNo: existingRev.revisionNo,
		previousRevisionId: existingRev.previousRevisionId,
		operation,
		status: targetStatus,
		name: existingRev.name,
		fundingTarget: existingRev.fundingTarget,
		targetDate: existingRev.targetDate,
		maxBudget: existingRev.maxBudget,
		targetPrice: existingRev.targetPrice,
		productUrl: existingRev.productUrl,
		note: existingRev.note,
		changeReason,
		occurredAt,
	});

	if (existingRev.revisionFingerprint === candidateFpV1) {
		return {
			goalId: existingRev.goalId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as ShortTermGoalOperation,
			status: existingRev.status as ShortTermGoalStatus,
			idempotentReplay: true,
			snapshot: {
				name: existingRev.name,
				fundingTarget: existingRev.fundingTarget,
				targetDate: existingRev.targetDate,
				maxBudget: existingRev.maxBudget,
				targetPrice: existingRev.targetPrice,
				productUrl: existingRev.productUrl,
				note: existingRev.note,
			},
		};
	}

	throw new ShortTermGoalError(
		"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
		"Idempotency key already used with different parameters",
	);
}

/**
 * Creates a new short-term goal, dedicated deterministic Midas virtual bucket, initial revision, and updates priority order.
 */
export async function createShortTermGoal(
	params: CreateShortTermGoalParams,
): Promise<ShortTermGoalLifecycleResult> {
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

	// Early check priorityPosition format if provided
	const suppliedPosition = validateSuppliedPriorityPosition(
		params.priorityPosition,
		"priorityPosition",
	);

	const executeInTx = async (
		tx: DatabaseTransaction,
	): Promise<ShortTermGoalLifecycleResult> => {
		// 1. Check idempotency on revisions early (before lock)
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
			return await validateAndBuildCreateReplayInTransaction(
				tx,
				existingRev,
				userId,
				idempotencyKey,
				name,
				parsedTarget.normalized,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				suppliedPosition,
				occurredAt,
			);
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

		// 3. SECOND Idempotency Check (under Midas lock to close concurrent same-key races)
		const [existingRevPostLock] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, userId),
					eq(shortTermGoalRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRevPostLock) {
			return await validateAndBuildCreateReplayInTransaction(
				tx,
				existingRevPostLock,
				userId,
				idempotencyKey,
				name,
				parsedTarget.normalized,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				suppliedPosition,
				occurredAt,
			);
		}

		// 4. Fetch current priority ordering to resolve active goal count & validated position
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

		const activeGoalCount = currentOrderedList.length;
		const validatedPosition = validatePriorityPosition(
			params.priorityPosition,
			activeGoalCount,
			"priorityPosition",
		);

		// 5. Deterministic Internal Bucket & Goal ID generation
		const goalId = crypto.randomUUID();
		const rawHex = goalId.replace(/-/g, "").toUpperCase();
		const bucketCode = `STG_${rawHex}`;
		const bucketName = `Short-term goal ${goalId.slice(0, 8)}`;

		// 6. Create dedicated Midas virtual bucket with type SHORT_TERM_GOAL
		const [midasBucket] = await tx
			.insert(midasBuckets)
			.values({
				userId,
				midasAccountId,
				code: bucketCode,
				name: bucketName,
				bucketType: "SHORT_TERM_GOAL",
			})
			.returning();

		if (!midasBucket) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create Midas bucket for short-term goal",
			);
		}

		// 7. Insert short_term_goals anchor identity with generated goalId
		const [goal] = await tx
			.insert(shortTermGoals)
			.values({
				id: goalId,
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

		// 8. Calculate revision 1 fingerprint v2 & insert revision
		const revisionFingerprint = await calculateShortTermGoalCreateFingerprintV2(
			{
				userId,
				goalId: goal.id,
				name,
				fundingTarget: parsedTarget.normalized,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
				priorityPosition: validatedPosition,
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

		// 9. Update manual priority ordering
		const nextOrderedList = [...currentOrderedList];
		const insertIndex = validatedPosition - 1;
		nextOrderedList.splice(insertIndex, 0, goal.id);

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

		const priorityIdempotencyKey = await generateHashedPriorityIdempotencyKey(
			idempotencyKey,
			goal.id,
			"CREATE",
		);

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

		return {
			goalId: goal.id,
			revisionId: revision.id,
			revisionNo: 1,
			operation: "CREATE",
			status: "ACTIVE",
			idempotentReplay: false,
			snapshot: {
				name: revision.name,
				fundingTarget: revision.fundingTarget,
				targetDate: revision.targetDate,
				maxBudget: revision.maxBudget,
				targetPrice: revision.targetPrice,
				productUrl: revision.productUrl,
				note: revision.note,
			},
		};
	};

	if ("transaction" in params.db) {
		return await params.db.transaction(executeInTx);
	}
	return await executeInTx(params.db as DatabaseTransaction);
}

/**
 * Updates an active short-term goal configuration with optimistic concurrency control.
 */
export async function updateShortTermGoal(
	params: UpdateShortTermGoalParams,
): Promise<ShortTermGoalLifecycleResult> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
		"expectedRevisionNo",
	);
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

	const executeInTx = async (
		tx: DatabaseTransaction,
	): Promise<ShortTermGoalLifecycleResult> => {
		// 1. Early idempotency check (happens before latest-state / active checks)
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
			return await validateAndBuildUpdateReplayInTransaction(
				tx,
				existingRev,
				userId,
				goalId,
				expectedRevisionNo,
				params,
				changeReason,
				occurredAt,
			);
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

		// 4. SECOND Idempotency Check (under lock)
		const [existingRevPostLock] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, userId),
					eq(shortTermGoalRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRevPostLock) {
			return await validateAndBuildUpdateReplayInTransaction(
				tx,
				existingRevPostLock,
				userId,
				goalId,
				expectedRevisionNo,
				params,
				changeReason,
				occurredAt,
			);
		}

		// 5. Fetch latest revision and check optimistic concurrency
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

		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_REVISION_CONFLICT",
				`Goal revision conflict: expected revision ${expectedRevisionNo} but latest is ${latestRev.revisionNo}`,
			);
		}

		if (latestRev.status !== "ACTIVE") {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_ACTIVE",
				`Cannot update goal in ${latestRev.status} status`,
			);
		}

		// 6. Merge fields
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
			const transfers = await tx
				.select({
					toBucketId: midasAllocationTransfers.toBucketId,
					fromBucketId: midasAllocationTransfers.fromBucketId,
					amount: midasAllocationTransfers.amount,
				})
				.from(midasAllocationTransfers)
				.where(
					eq(midasAllocationTransfers.midasAccountId, goal.midasAccountId),
				);

			let netCents = 0n;
			for (const t of transfers) {
				const p = parseMoneyString(t.amount);
				if (t.toBucketId === goal.midasBucketId) netCents += p.cents;
				if (t.fromBucketId === goal.midasBucketId) netCents -= p.cents;
			}

			if (netCents > maxParsed.cents) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_MAX_BUDGET_EXCEEDED",
					`Current accumulated balance (${formatSignedCentsToMoney(netCents)}) exceeds new maxBudget (${maxBudget})`,
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

		const revisionFingerprint = await calculateShortTermGoalUpdateFingerprintV2(
			{
				userId,
				goalId,
				expectedRevisionNo,
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

		const [createdRev] = await tx
			.insert(shortTermGoalRevisions)
			.values({
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
			})
			.returning();

		if (!createdRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create update revision",
			);
		}

		return {
			goalId,
			revisionId: createdRev.id,
			revisionNo: createdRev.revisionNo,
			operation: "UPDATE",
			status: "ACTIVE",
			idempotentReplay: false,
			snapshot: {
				name,
				fundingTarget,
				targetDate,
				maxBudget,
				targetPrice,
				productUrl,
				note,
			},
		};
	};

	if ("transaction" in params.db) {
		return await params.db.transaction(executeInTx);
	}
	return await executeInTx(params.db as DatabaseTransaction);
}

/**
 * Transitions a short-term goal to COMPLETED status (requires 0.00 bucket balance and optimistic revision check).
 */
export async function completeShortTermGoal(
	params: CompleteShortTermGoalParams,
): Promise<ShortTermGoalLifecycleResult> {
	return await transitionTerminalStatus({
		...params,
		targetStatus: "COMPLETED",
		operation: "COMPLETE",
	});
}

/**
 * Transitions a short-term goal to CANCELLED status (requires 0.00 bucket balance and optimistic revision check).
 */
export async function cancelShortTermGoal(
	params: CancelShortTermGoalParams,
): Promise<ShortTermGoalLifecycleResult> {
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
	expectedRevisionNo: number;
	changeReason?: string | null;
	occurredAt: Date;
	idempotencyKey: string;
	targetStatus: ShortTermGoalStatus;
	operation: "COMPLETE" | "CANCEL";
}): Promise<ShortTermGoalLifecycleResult> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
		"expectedRevisionNo",
	);
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

	const executeInTx = async (
		tx: DatabaseTransaction,
	): Promise<ShortTermGoalLifecycleResult> => {
		// 1. Early idempotency check (happens before latest-state / active checks)
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
			return await validateAndBuildTerminalReplayInTransaction(
				tx,
				existingRev,
				userId,
				goalId,
				params.operation,
				params.targetStatus,
				expectedRevisionNo,
				changeReason,
				occurredAt,
			);
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

		// 4. SECOND Idempotency Check (under lock)
		const [existingRevPostLock] = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, userId),
					eq(shortTermGoalRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingRevPostLock) {
			return await validateAndBuildTerminalReplayInTransaction(
				tx,
				existingRevPostLock,
				userId,
				goalId,
				params.operation,
				params.targetStatus,
				expectedRevisionNo,
				changeReason,
				occurredAt,
			);
		}

		// 5. Fetch latest revision and check optimistic concurrency
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

		if (latestRev.revisionNo !== expectedRevisionNo) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_REVISION_CONFLICT",
				`Goal revision conflict: expected revision ${expectedRevisionNo} but latest is ${latestRev.revisionNo}`,
			);
		}

		if (latestRev.status !== "ACTIVE") {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_NOT_ACTIVE",
				`Cannot transition goal in ${latestRev.status} status to ${params.targetStatus}`,
			);
		}

		// 6. Verify bucket balance is exactly 0.00
		const transfers = await tx
			.select({
				toBucketId: midasAllocationTransfers.toBucketId,
				fromBucketId: midasAllocationTransfers.fromBucketId,
				amount: midasAllocationTransfers.amount,
			})
			.from(midasAllocationTransfers)
			.where(eq(midasAllocationTransfers.midasAccountId, goal.midasAccountId));

		let netCents = 0n;
		for (const t of transfers) {
			const p = parseMoneyString(t.amount);
			if (t.toBucketId === goal.midasBucketId) netCents += p.cents;
			if (t.fromBucketId === goal.midasBucketId) netCents -= p.cents;
		}

		if (netCents !== 0n) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_BALANCE_NOT_ZERO",
				`Cannot transition goal to ${params.targetStatus} with non-zero accumulated balance (${formatSignedCentsToMoney(netCents)}). Release or reallocate funds first.`,
			);
		}

		// 7. Insert terminal revision
		const nextRevNo = latestRev.revisionNo + 1;

		const revisionFingerprint =
			await calculateShortTermGoalTerminalFingerprintV2({
				userId,
				goalId,
				operation: params.operation,
				expectedRevisionNo,
				changeReason,
				occurredAt,
			});

		const [createdRev] = await tx
			.insert(shortTermGoalRevisions)
			.values({
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
			})
			.returning();

		if (!createdRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create terminal revision",
			);
		}

		// 8. Update priority revision (remove goal from active ordered array)
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

		const priorityIdempotencyKey = await generateHashedPriorityIdempotencyKey(
			idempotencyKey,
			goalId,
			params.operation,
		);

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

		return {
			goalId,
			revisionId: createdRev.id,
			revisionNo: createdRev.revisionNo,
			operation: params.operation,
			status: params.targetStatus,
			idempotentReplay: false,
			snapshot: {
				name: latestRev.name,
				fundingTarget: latestRev.fundingTarget,
				targetDate: latestRev.targetDate,
				maxBudget: latestRev.maxBudget,
				targetPrice: latestRev.targetPrice,
				productUrl: latestRev.productUrl,
				note: latestRev.note,
			},
		};
	};

	if ("transaction" in params.db) {
		return await params.db.transaction(executeInTx);
	}
	return await executeInTx(params.db as DatabaseTransaction);
}

/**
 * Updates the manual priority ordering of ACTIVE goals for a Midas account.
 */
export async function reorderShortTermGoals(
	params: ReorderShortTermGoalsParams,
): Promise<ShortTermGoalReorderResult> {
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

	const executeInTx = async (
		tx: DatabaseTransaction,
	): Promise<ShortTermGoalReorderResult> => {
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
			if (existingPriority.midasAccountId !== midasAccountId) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used for different Midas account",
				);
			}

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

			return {
				priorityRevisionId: existingPriority.id,
				revisionNo: existingPriority.revisionNo,
				orderedGoalIds: existingPriority.orderedGoalIds as string[],
				idempotentReplay: true,
			};
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

		// 3. SECOND Idempotency Check (under lock)
		const [existingPriorityPostLock] = await tx
			.select()
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(shortTermGoalPriorityRevisions.userId, userId),
					eq(shortTermGoalPriorityRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (existingPriorityPostLock) {
			if (existingPriorityPostLock.midasAccountId !== midasAccountId) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used for different Midas account",
				);
			}

			const candidateFp = await calculateShortTermGoalPriorityFingerprint({
				userId,
				midasAccountId,
				revisionNo: existingPriorityPostLock.revisionNo,
				previousRevisionId: existingPriorityPostLock.previousRevisionId,
				orderedGoalIds: normalizedGoalIds,
				occurredAt,
			});

			if (existingPriorityPostLock.priorityFingerprint !== candidateFp) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_IDEMPOTENCY_CONFLICT",
					"Idempotency key already used with different priority ordering",
				);
			}

			return {
				priorityRevisionId: existingPriorityPostLock.id,
				revisionNo: existingPriorityPostLock.revisionNo,
				orderedGoalIds: existingPriorityPostLock.orderedGoalIds as string[],
				idempotentReplay: true,
			};
		}

		// 4. Fetch all active goals for account
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

		// 5. Fetch latest priority revision
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

		const [createdPriority] = await tx
			.insert(shortTermGoalPriorityRevisions)
			.values({
				userId,
				midasAccountId,
				revisionNo: nextPriorityRevNo,
				previousRevisionId: latestPriority ? latestPriority.id : null,
				orderedGoalIds: normalizedGoalIds,
				idempotencyKey,
				priorityFingerprint,
				occurredAt,
			})
			.returning();

		if (!createdPriority) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				"Failed to create priority revision",
			);
		}

		return {
			priorityRevisionId: createdPriority.id,
			revisionNo: createdPriority.revisionNo,
			orderedGoalIds: normalizedGoalIds,
			idempotentReplay: false,
		};
	};

	if ("transaction" in params.db) {
		return await params.db.transaction(executeInTx);
	}
	return await executeInTx(params.db as DatabaseTransaction);
}

/**
 * Virtually funds a short-term goal by transferring liquidity into its Midas bucket.
 * Exact historical replay takes precedence before mutable goal checks.
 */
export async function fundShortTermGoal(
	params: FundShortTermGoalParams,
): Promise<ShortTermGoalFundingResult> {
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

	const executeInTx = async (
		tx: DatabaseTransaction,
	): Promise<ShortTermGoalFundingResult> => {
		// 1. Resolve immutable goal identity only
		const [goal] = await tx
			.select({
				id: shortTermGoals.id,
				userId: shortTermGoals.userId,
				midasAccountId: shortTermGoals.midasAccountId,
				midasBucketId: shortTermGoals.midasBucketId,
			})
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

		// 2. Delegate to Midas allocation transfer (handles early historical replay inside)
		try {
			const res = await createMidasAllocationTransferInTransaction({
				tx,
				userId,
				midasAccountId: goal.midasAccountId,
				idempotencyKey,
				fromBucketId,
				toBucketId: goal.midasBucketId,
				amount: parsedAmount.normalized,
				occurredAt,
				memo: memo ?? `Virtual funding for short-term goal: ${goal.id}`,
			});

			return {
				goalId: goal.id,
				transferId: res.transferId,
				amount: res.amount,
				idempotentReplay: res.idempotentReplay,
			};
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
				if (err.code === "MIDAS_INSUFFICIENT_FREE_BALANCE") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE",
						err.message,
					);
				}
				if (err.code === "MIDAS_INSUFFICIENT_BUCKET_BALANCE") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_INSUFFICIENT_BALANCE",
						err.message,
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
	};

	if ("transaction" in params.db) {
		return await params.db.transaction(executeInTx);
	}
	return await executeInTx(params.db as DatabaseTransaction);
}

/**
 * Virtually releases funding from a short-term goal back to unallocated liquidity or another bucket.
 */
export async function releaseShortTermGoalFunding(
	params: ReleaseShortTermGoalFundingParams,
): Promise<ShortTermGoalReleaseResult> {
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

	const executeInTx = async (
		tx: DatabaseTransaction,
	): Promise<ShortTermGoalReleaseResult> => {
		// 1. Resolve immutable goal identity only
		const [goal] = await tx
			.select({
				id: shortTermGoals.id,
				userId: shortTermGoals.userId,
				midasAccountId: shortTermGoals.midasAccountId,
				midasBucketId: shortTermGoals.midasBucketId,
			})
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

		// 2. Delegate to Midas allocation transfer
		try {
			const res = await createMidasAllocationTransferInTransaction({
				tx,
				userId,
				midasAccountId: goal.midasAccountId,
				idempotencyKey,
				fromBucketId: goal.midasBucketId,
				toBucketId,
				amount: parsedAmount.normalized,
				occurredAt,
				memo: memo ?? `Virtual funding release for short-term goal: ${goal.id}`,
			});

			return {
				goalId: goal.id,
				transferId: res.transferId,
				amount: res.amount,
				idempotentReplay: res.idempotentReplay,
			};
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
				if (err.code === "MIDAS_INSUFFICIENT_BUCKET_BALANCE") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_INSUFFICIENT_BALANCE",
						"Insufficient balance in short-term goal bucket to release",
					);
				}
				if (err.code === "MIDAS_INSUFFICIENT_FREE_BALANCE") {
					throw new ShortTermGoalError(
						"SHORT_TERM_GOAL_INSUFFICIENT_FREE_BALANCE",
						err.message,
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
	};

	if ("transaction" in params.db) {
		return await params.db.transaction(executeInTx);
	}
	return await executeInTx(params.db as DatabaseTransaction);
}

/**
 * Retrieves a single short-term goal with derived funding and manual priority.
 * Guaranteed consistent snapshot via single outer transaction.
 */
export async function getShortTermGoal(
	params: GetShortTermGoalParams,
): Promise<ShortTermGoalRecord> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const goalId = validateCanonicalUuid(params.goalId, "goalId");

	return await params.db.transaction(async (tx) => {
		return await getShortTermGoalInTransaction({ tx, userId, goalId });
	});
}

/**
 * Transactional read for a single short-term goal.
 */
export async function getShortTermGoalInTransaction(
	params: GetShortTermGoalInTransactionParams,
): Promise<ShortTermGoalRecord> {
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

	// 1. Lock Midas liquidity state FOR UPDATE to get authoritative snapshot
	const liquidityState = await getMidasLiquidityStateInTransaction({
		tx,
		userId,
		midasAccountId: goal.midasAccountId,
	});

	// 2. Fetch latest revision for goal
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

	// 3. Fetch latest priority revision
	const [latestPriority] = await tx
		.select()
		.from(shortTermGoalPriorityRevisions)
		.where(
			and(
				eq(shortTermGoalPriorityRevisions.midasAccountId, goal.midasAccountId),
				eq(shortTermGoalPriorityRevisions.userId, userId),
			),
		)
		.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
		.limit(1);

	const priorityOrder: string[] = latestPriority
		? (latestPriority.orderedGoalIds as string[])
		: [];

	// 4. Fail-closed invariant validations
	const bucketInfo = liquidityState.buckets.find(
		(b) => b.bucketId === goal.midasBucketId,
	);
	if (!bucketInfo) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			`Goal bucket ${goal.midasBucketId} not found in Midas liquidity state`,
		);
	}

	if (bucketInfo.bucketType !== "SHORT_TERM_GOAL") {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			`Goal bucket ${goal.midasBucketId} has invalid type ${bucketInfo.bucketType}`,
		);
	}

	const balanceParsed = parseMoneyString(bucketInfo.balance);
	if (balanceParsed.cents < 0n) {
		throw new ShortTermGoalError(
			"SHORT_TERM_GOAL_INVALID_STATE",
			`Negative balance (${bucketInfo.balance}) on short-term goal bucket`,
		);
	}

	let priority: number | null = null;
	const priorityIdx = priorityOrder.indexOf(goalId);

	if (latestRev.status === "ACTIVE") {
		if (priorityIdx < 0) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`ACTIVE goal ${goalId} is absent from latest priority ordering`,
			);
		}
		priority = priorityIdx + 1; // 1-based priority
	} else {
		if (priorityIdx >= 0) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Terminal goal ${goalId} (${latestRev.status}) is present in priority ordering`,
			);
		}
		if (balanceParsed.cents !== 0n) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Terminal goal ${goalId} (${latestRev.status}) has non-zero balance ${bucketInfo.balance}`,
			);
		}
	}

	if (latestRev.maxBudget !== null) {
		const maxParsed = parseMoneyString(latestRev.maxBudget);
		if (balanceParsed.cents > maxParsed.cents) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Goal balance ${bucketInfo.balance} exceeds configured maxBudget ${latestRev.maxBudget}`,
			);
		}
	}

	const targetParsed = parseMoneyString(latestRev.fundingTarget);
	const {
		accumulatedAmount,
		remainingToTarget,
		fundingStatus,
		progressPercentage,
	} = deriveFundingMetrics(balanceParsed.cents, targetParsed.cents);

	return {
		id: goal.id,
		userId: goal.userId,
		midasAccountId: goal.midasAccountId,
		midasBucketId: goal.midasBucketId,
		status: latestRev.status as ShortTermGoalStatus,
		name: latestRev.name,
		fundingTarget: latestRev.fundingTarget,
		accumulatedAmount,
		remainingToTarget,
		fundingStatus,
		progressPercentage,
		targetDate: latestRev.targetDate,
		maxBudget: latestRev.maxBudget,
		targetPrice: latestRev.targetPrice,
		productUrl: latestRev.productUrl,
		note: latestRev.note,
		priority,
		latestRevisionNo: latestRev.revisionNo,
		createdAt: goal.createdAt,
		updatedAt: latestRev.occurredAt,
	};
}

/**
 * Lists all short-term goals for a Midas account ordered by priority (ACTIVE) then recent (terminal).
 * Guaranteed consistent snapshot via single outer transaction.
 */
export async function listShortTermGoals(
	params: ListShortTermGoalsParams,
): Promise<ShortTermGoalRecord[]> {
	const userId = validateCanonicalUuid(params.userId, "userId");
	const midasAccountId = validateCanonicalUuid(
		params.midasAccountId,
		"midasAccountId",
	);

	return await params.db.transaction(async (tx) => {
		return await listShortTermGoalsInTransaction({
			tx,
			userId,
			midasAccountId,
			status: params.status,
			includeTerminal: params.includeTerminal,
		});
	});
}

/**
 * Transactional list for short-term goals.
 */
export async function listShortTermGoalsInTransaction(
	params: ListShortTermGoalsInTransactionParams,
): Promise<ShortTermGoalRecord[]> {
	const {
		tx,
		userId,
		midasAccountId,
		status,
		includeTerminal = false,
	} = params;

	// 1. Lock Midas liquidity state FOR UPDATE exactly once to serialize view
	const liquidityState = await getMidasLiquidityStateInTransaction({
		tx,
		userId,
		midasAccountId,
	});

	// 2. Fetch all goals for account
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

	// 3. Fetch all revisions for goals
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

	const priorityOrder: string[] = latestPriority
		? (latestPriority.orderedGoalIds as string[])
		: [];

	const priorityMap = new Map<string, number>();
	priorityOrder.forEach((id, idx) => {
		priorityMap.set(id, idx + 1); // 1-based priority
	});

	const bucketMap = new Map<string, (typeof liquidityState.buckets)[0]>();
	for (const b of liquidityState.buckets) {
		bucketMap.set(b.bucketId, b);
	}

	const records: ShortTermGoalRecord[] = [];

	for (const goal of goals) {
		const latestRev = latestRevMap.get(goal.id);
		if (!latestRev) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Goal ${goal.id} has no revisions`,
			);
		}

		const bucketInfo = bucketMap.get(goal.midasBucketId);
		if (!bucketInfo) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Goal bucket ${goal.midasBucketId} not found in Midas state`,
			);
		}

		if (bucketInfo.bucketType !== "SHORT_TERM_GOAL") {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Goal bucket ${goal.midasBucketId} has invalid type ${bucketInfo.bucketType}`,
			);
		}

		const balanceParsed = parseMoneyString(bucketInfo.balance);
		if (balanceParsed.cents < 0n) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_INVALID_STATE",
				`Negative balance (${bucketInfo.balance}) on goal ${goal.id}`,
			);
		}

		const hasPriority = priorityMap.has(goal.id);
		const pNum = hasPriority ? (priorityMap.get(goal.id) ?? null) : null;

		// Invariant validations apply to ALL goals
		if (latestRev.status === "ACTIVE") {
			if (!hasPriority) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_STATE",
					`ACTIVE goal ${goal.id} is absent from latest priority ordering`,
				);
			}
		} else {
			if (hasPriority) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_STATE",
					`Terminal goal ${goal.id} (${latestRev.status}) is present in priority ordering`,
				);
			}
			if (balanceParsed.cents !== 0n) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_STATE",
					`Terminal goal ${goal.id} (${latestRev.status}) has non-zero balance ${bucketInfo.balance}`,
				);
			}
		}

		if (latestRev.maxBudget !== null) {
			const maxParsed = parseMoneyString(latestRev.maxBudget);
			if (balanceParsed.cents > maxParsed.cents) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_STATE",
					`Goal balance ${bucketInfo.balance} exceeds maxBudget ${latestRev.maxBudget}`,
				);
			}
		}

		// Filter status (Section 16)
		if (status !== undefined) {
			if (latestRev.status !== status) {
				continue;
			}
		} else {
			if (!includeTerminal && latestRev.status !== "ACTIVE") {
				continue;
			}
		}

		const targetParsed = parseMoneyString(latestRev.fundingTarget);
		const {
			accumulatedAmount,
			remainingToTarget,
			fundingStatus,
			progressPercentage,
		} = deriveFundingMetrics(balanceParsed.cents, targetParsed.cents);

		records.push({
			id: goal.id,
			userId: goal.userId,
			midasAccountId: goal.midasAccountId,
			midasBucketId: goal.midasBucketId,
			status: latestRev.status as ShortTermGoalStatus,
			name: latestRev.name,
			fundingTarget: latestRev.fundingTarget,
			accumulatedAmount,
			remainingToTarget,
			fundingStatus,
			progressPercentage,
			targetDate: latestRev.targetDate,
			maxBudget: latestRev.maxBudget,
			targetPrice: latestRev.targetPrice,
			productUrl: latestRev.productUrl,
			note: latestRev.note,
			priority: pNum,
			latestRevisionNo: latestRev.revisionNo,
			createdAt: goal.createdAt,
			updatedAt: latestRev.occurredAt,
		});
	}

	// Sort: Active goals by priority (ascending 1, 2, 3...), terminal goals by createdAt DESC, id ASC (Section 17)
	records.sort((a, b) => {
		if (a.status === "ACTIVE" && b.status === "ACTIVE") {
			const pA = a.priority ?? Number.MAX_SAFE_INTEGER;
			const pB = b.priority ?? Number.MAX_SAFE_INTEGER;
			return pA - pB;
		}
		if (a.status === "ACTIVE") return -1;
		if (b.status === "ACTIVE") return 1;
		const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
		if (timeDiff !== 0) return timeDiff;
		return a.id.localeCompare(b.id);
	});

	return records;
}

async function listActiveGoalIdsInTx(params: {
	tx: DatabaseTransaction;
	userId: string;
	midasAccountId: string;
}): Promise<string[]> {
	const { tx, userId, midasAccountId } = params;

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
