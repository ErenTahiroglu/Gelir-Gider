import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
	Database,
	DatabaseOrTransaction,
	DatabaseTransaction,
} from "../db/client";
import { mapPurchaseCategoryToSystemRole } from "../db/schema/credit-card-ledger";
import {
	type RewardEventType,
	rewardAccountRevisions,
	rewardAccounts,
	rewardEventRevisions,
	rewardEvents,
} from "../db/schema/rewards";
import {
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import { ensureUserExpenseSystemAccountsInTransaction } from "../ledger/system-expense-accounts";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import { runRewardsReadTransaction, runRewardsTransaction } from "./boundary";
import {
	validateRewardCanonicalUuid,
	validateRewardEventStatusFilter,
	validateRewardEventTypeFilter,
	validateRewardExpectedRevisionNo,
	validateRewardIdempotencyKey,
	validateRewardOccurredAt,
	validateRewardOptionalText,
	validateRewardPurchaseCategory,
	validateRewardSourceRef,
	validateRewardSourceType,
} from "./calendar";
import {
	calculateRewardEconomicAmount,
	deriveAndValidateEconomicAmount,
	formatUnitsToDecimal,
	parseConversionRate,
	parsePointQuantity,
} from "./decimal";
import { RewardError } from "./errors";
import {
	calculateRewardEventCreateFingerprint,
	calculateRewardEventVoidFingerprint,
} from "./fingerprint";
import { ensureRewardBenefitAccountInTransaction } from "./ledger-provisioning";

const POSITIVE_EVENT_TYPES = new Set<RewardEventType>([
	"OPENING_BALANCE",
	"EARN",
	"ADJUSTMENT_CREDIT",
]);

export interface RewardEventReadModel {
	rewardEventId: string;
	rewardAccountId: string;
	eventType: RewardEventType;
	status: "ACTIVE" | "VOID";
	revisionNo: number;
	pointAmount: string;
	signedPointEffect: string;
	conversionRate: string;
	economicAmount: string | null;
	purchaseCategory: string | null;
	shortTermGoalId: string | null;
	merchant: string | null;
	description: string | null;
	reasonNote: string | null;
	occurredAt: Date;
	createdAt: Date;
	canonicalTransactionId: string | null;
	canonicalRevisionId: string | null;
}

// ============================================================================
// Point Balance Derivation (no cached mutable column)
// ============================================================================

export async function deriveRewardPointBalanceInTransaction(
	tx: DatabaseOrTransaction,
	rewardAccountId: string,
): Promise<bigint> {
	const eventRows = await tx
		.select({ id: rewardEvents.id, eventType: rewardEvents.eventType })
		.from(rewardEvents)
		.where(eq(rewardEvents.rewardAccountId, rewardAccountId));

	if (eventRows.length === 0) return 0n;

	const eventIds = eventRows.map((e) => e.id);
	const revisionRows = await tx
		.select()
		.from(rewardEventRevisions)
		.where(inArray(rewardEventRevisions.rewardEventId, eventIds));

	const latestByEvent = new Map<string, (typeof revisionRows)[number]>();
	for (const rev of revisionRows) {
		const existing = latestByEvent.get(rev.rewardEventId);
		if (!existing || rev.revisionNo > existing.revisionNo) {
			latestByEvent.set(rev.rewardEventId, rev);
		}
	}

	const eventTypeById = new Map(eventRows.map((e) => [e.id, e.eventType]));

	let balance = 0n;
	for (const [eventId, rev] of latestByEvent) {
		if (rev.operation === "VOID") continue;
		const units = parsePointQuantity(rev.pointAmount).units;
		const type = eventTypeById.get(eventId);
		if (type && POSITIVE_EVENT_TYPES.has(type as RewardEventType)) {
			balance += units;
		} else {
			balance -= units;
		}
	}
	return balance;
}

// ============================================================================
// Read Model Construction
// ============================================================================

function signedEffectFor(
	eventType: RewardEventType,
	pointAmount: string,
): string {
	const units = parsePointQuantity(pointAmount).units;
	const signed = POSITIVE_EVENT_TYPES.has(eventType) ? units : -units;
	return formatUnitsToDecimal(signed, 4);
}

function buildRewardEventReadModel(
	event: typeof rewardEvents.$inferSelect,
	revision: typeof rewardEventRevisions.$inferSelect,
): RewardEventReadModel {
	return {
		rewardEventId: event.id,
		rewardAccountId: event.rewardAccountId,
		eventType: event.eventType as RewardEventType,
		status: revision.operation === "VOID" ? "VOID" : "ACTIVE",
		revisionNo: revision.revisionNo,
		pointAmount: revision.pointAmount,
		signedPointEffect:
			revision.operation === "VOID"
				? "0.0000"
				: signedEffectFor(
						event.eventType as RewardEventType,
						revision.pointAmount,
					),
		conversionRate: revision.conversionRate,
		economicAmount: revision.economicAmount,
		purchaseCategory: revision.purchaseCategory,
		shortTermGoalId: revision.shortTermGoalId,
		merchant: revision.merchant,
		description: revision.description,
		reasonNote: revision.reasonNote,
		occurredAt: revision.occurredAt,
		createdAt: event.createdAt,
		canonicalTransactionId: event.canonicalTransactionId,
		canonicalRevisionId: revision.canonicalRevisionId,
	};
}

export async function buildRewardEventReadModelByIdInTransaction(
	tx: DatabaseOrTransaction,
	rewardEventId: string,
): Promise<RewardEventReadModel | null> {
	const [event] = await tx
		.select()
		.from(rewardEvents)
		.where(eq(rewardEvents.id, rewardEventId))
		.limit(1);
	if (!event) return null;

	const [latestRev] = await tx
		.select()
		.from(rewardEventRevisions)
		.where(eq(rewardEventRevisions.rewardEventId, rewardEventId))
		.orderBy(desc(rewardEventRevisions.revisionNo))
		.limit(1);
	if (!latestRev) return null;

	return buildRewardEventReadModel(event, latestRev);
}

// ============================================================================
// Shared internal helpers
// ============================================================================

async function lockActiveRewardAccountInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	rewardAccountId: string,
): Promise<void> {
	const [account] = await tx
		.select()
		.from(rewardAccounts)
		.where(
			and(
				eq(rewardAccounts.id, rewardAccountId),
				eq(rewardAccounts.userId, userId),
			),
		)
		.for("update");
	if (!account) {
		throw new RewardError(
			"REWARD_ACCOUNT_NOT_FOUND",
			`Reward account "${rewardAccountId}" not found`,
		);
	}

	const [latestRev] = await tx
		.select({ status: rewardAccountRevisions.status })
		.from(rewardAccountRevisions)
		.where(eq(rewardAccountRevisions.rewardAccountId, rewardAccountId))
		.orderBy(desc(rewardAccountRevisions.revisionNo))
		.limit(1);

	if (latestRev?.status !== "ACTIVE") {
		throw new RewardError(
			"REWARD_ACCOUNT_NOT_ACTIVE",
			`Reward account "${rewardAccountId}" is not ACTIVE`,
		);
	}
}

async function resolveLatestDefaultConversionRateInTransaction(
	tx: DatabaseTransaction,
	rewardAccountId: string,
): Promise<string> {
	const [latestRev] = await tx
		.select({ rate: rewardAccountRevisions.defaultConversionRate })
		.from(rewardAccountRevisions)
		.where(eq(rewardAccountRevisions.rewardAccountId, rewardAccountId))
		.orderBy(desc(rewardAccountRevisions.revisionNo))
		.limit(1);
	if (!latestRev) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Reward account has no revisions",
		);
	}
	return latestRev.rate;
}

// ============================================================================
// Simple (non-economic) event CREATE: OPENING_BALANCE, EARN, EXPIRE,
// ADJUSTMENT_CREDIT, ADJUSTMENT_DEBIT
// ============================================================================

interface SimpleRewardEventCreateArgs {
	userId: string;
	rewardAccountId: string;
	eventType: RewardEventType;
	pointAmount: string;
	conversionRateOverride: string | undefined;
	reasonNote: string | null;
	occurredAt: Date;
	idempotencyKey: string;
	sourceType: "MANUAL" | "CAMPAIGN" | "IMPORT";
	sourceRef: string | null;
}

async function tryReplaySimpleEventCreate(
	tx: DatabaseTransaction,
	args: SimpleRewardEventCreateArgs,
	preloadedRev?: typeof rewardEventRevisions.$inferSelect,
): Promise<RewardEventReadModel | null> {
	const existingRev =
		preloadedRev ??
		(
			await tx
				.select()
				.from(rewardEventRevisions)
				.innerJoin(
					rewardEvents,
					eq(rewardEvents.id, rewardEventRevisions.rewardEventId),
				)
				.where(
					and(
						eq(rewardEvents.rewardAccountId, args.rewardAccountId),
						eq(rewardEventRevisions.idempotencyKey, args.idempotencyKey),
					),
				)
				.limit(1)
		)[0]?.reward_event_revisions;

	if (!existingRev) return null;

	if (existingRev.revisionNo !== 1 || existingRev.operation !== "CREATE") {
		throw new RewardError(
			"REWARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key was already used for a different reward event operation",
		);
	}

	const rate = args.conversionRateOverride ?? existingRev.conversionRate;
	const candidateFingerprint = await calculateRewardEventCreateFingerprint({
		userId: args.userId,
		rewardAccountId: args.rewardAccountId,
		eventType: args.eventType,
		pointAmount: parsePointQuantity(args.pointAmount).normalized,
		conversionRate: parseConversionRate(rate).normalized,
		economicAmount: null,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: null,
		reasonNote: args.reasonNote,
		sourceType: args.sourceType,
		sourceRef: args.sourceRef,
		occurredAt: args.occurredAt,
	});

	if (candidateFingerprint !== existingRev.revisionFingerprint) {
		throw new RewardError(
			"REWARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key reused with a different reward event CREATE payload",
		);
	}

	return buildRewardEventReadModelByIdInTransaction(
		tx,
		existingRev.rewardEventId,
	);
}

async function createSimpleRewardEventInTransaction(
	tx: DatabaseTransaction,
	args: SimpleRewardEventCreateArgs,
): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
	const earlyReplay = await tryReplaySimpleEventCreate(tx, args);
	if (earlyReplay) return { event: earlyReplay, idempotentReplay: true };

	await lockActiveRewardAccountInTransaction(
		tx,
		args.userId,
		args.rewardAccountId,
	);

	const secondReplay = await tryReplaySimpleEventCreate(tx, args);
	if (secondReplay) return { event: secondReplay, idempotentReplay: true };

	const points = parsePointQuantity(args.pointAmount);
	const rateSource =
		args.conversionRateOverride ??
		(await resolveLatestDefaultConversionRateInTransaction(
			tx,
			args.rewardAccountId,
		));
	const rate = parseConversionRate(rateSource);

	if (!POSITIVE_EVENT_TYPES.has(args.eventType)) {
		const currentBalance = await deriveRewardPointBalanceInTransaction(
			tx,
			args.rewardAccountId,
		);
		if (currentBalance < points.units) {
			throw new RewardError(
				"REWARD_INSUFFICIENT_POINTS",
				`Insufficient reward points: requested ${points.normalized}, available ${formatUnitsToDecimal(currentBalance, 4)}`,
			);
		}
	}

	if (args.eventType === "OPENING_BALANCE") {
		const openingEvents = await tx
			.select({ id: rewardEvents.id })
			.from(rewardEvents)
			.where(
				and(
					eq(rewardEvents.rewardAccountId, args.rewardAccountId),
					eq(rewardEvents.eventType, "OPENING_BALANCE"),
				),
			);
		if (openingEvents.length > 0) {
			const openingIds = openingEvents.map((e) => e.id);
			const revisions = await tx
				.select({
					rewardEventId: rewardEventRevisions.rewardEventId,
					revisionNo: rewardEventRevisions.revisionNo,
					operation: rewardEventRevisions.operation,
				})
				.from(rewardEventRevisions)
				.where(inArray(rewardEventRevisions.rewardEventId, openingIds));

			const latestByEvent = new Map<
				string,
				{ revisionNo: number; operation: string }
			>();
			for (const r of revisions) {
				const prev = latestByEvent.get(r.rewardEventId);
				if (!prev || r.revisionNo > prev.revisionNo) {
					latestByEvent.set(r.rewardEventId, {
						revisionNo: r.revisionNo,
						operation: r.operation,
					});
				}
			}

			for (const [, latest] of latestByEvent) {
				if (latest.operation !== "VOID") {
					throw new RewardError(
						"REWARD_EVENT_CONFLICT",
						"An active opening balance event already exists for this reward account",
					);
				}
			}
		}
	}

	const [insertedEvent] = await tx
		.insert(rewardEvents)
		.values({
			userId: args.userId,
			rewardAccountId: args.rewardAccountId,
			eventType: args.eventType,
			canonicalTransactionId: null,
		})
		.returning();
	if (!insertedEvent) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to create reward event",
		);
	}

	const fingerprint = await calculateRewardEventCreateFingerprint({
		userId: args.userId,
		rewardAccountId: args.rewardAccountId,
		eventType: args.eventType,
		pointAmount: points.normalized,
		conversionRate: rate.normalized,
		economicAmount: null,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: null,
		reasonNote: args.reasonNote,
		sourceType: args.sourceType,
		sourceRef: args.sourceRef,
		occurredAt: args.occurredAt,
	});

	await tx.insert(rewardEventRevisions).values({
		userId: args.userId,
		rewardEventId: insertedEvent.id,
		revisionNo: 1,
		previousRevisionId: null,
		operation: "CREATE",
		pointAmount: points.normalized,
		conversionRate: rate.normalized,
		economicAmount: null,
		purchaseCategory: null,
		shortTermGoalId: null,
		merchant: null,
		description: null,
		reasonNote: args.reasonNote,
		occurredAt: args.occurredAt,
		canonicalRevisionId: null,
		sourceType: args.sourceType,
		sourceRef: args.sourceRef,
		idempotencyKey: args.idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	const readModel = await buildRewardEventReadModelByIdInTransaction(
		tx,
		insertedEvent.id,
	);
	if (!readModel) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to build newly created reward event read model",
		);
	}
	return { event: readModel, idempotentReplay: false };
}

/**
 * Internal transaction-scoped primitive for recording an EARN event. Phase
 * 16 campaigns must reuse this exact primitive (with sourceType: "CAMPAIGN")
 * rather than reimplementing reward-earning logic. Does NOT call
 * db.transaction().
 */
export async function recordRewardEarnInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		rewardAccountId: string;
		pointAmount: string;
		conversionRateOverride?: string | undefined;
		reasonNote: string | null;
		occurredAt: Date;
		idempotencyKey: string;
		sourceType?: "MANUAL" | "CAMPAIGN" | "IMPORT" | undefined;
		sourceRef?: string | null | undefined;
	},
): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
	const sourceType =
		args.sourceType === undefined
			? "MANUAL"
			: validateRewardSourceType(args.sourceType);
	const sourceRef = validateRewardSourceRef(args.sourceRef);
	return createSimpleRewardEventInTransaction(tx, {
		userId: args.userId,
		rewardAccountId: args.rewardAccountId,
		eventType: "EARN",
		pointAmount: args.pointAmount,
		conversionRateOverride: args.conversionRateOverride,
		reasonNote: args.reasonNote,
		occurredAt: args.occurredAt,
		idempotencyKey: args.idempotencyKey,
		sourceType,
		sourceRef,
	});
}

// ============================================================================
// Public simple-event APIs
// ============================================================================

interface PublicSimpleEventParams {
	db: Database;
	userId: string;
	rewardAccountId: string;
	pointAmount: string;
	conversionRateOverride?: string | undefined;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

function makeSimpleEventApi(eventType: RewardEventType) {
	return async function recordSimpleEvent(
		params: PublicSimpleEventParams,
	): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
		const userId = validateRewardCanonicalUuid(params.userId, "userId");
		const rewardAccountId = validateRewardCanonicalUuid(
			params.rewardAccountId,
			"rewardAccountId",
		);
		const pointAmount = parsePointQuantity(params.pointAmount).normalized;
		const conversionRateOverride =
			params.conversionRateOverride === undefined
				? undefined
				: parseConversionRate(params.conversionRateOverride).normalized;
		const reasonNote = validateRewardOptionalText(
			params.reasonNote,
			"reasonNote",
			500,
		);
		const occurredAt = validateRewardOccurredAt(params.occurredAt);
		const idempotencyKey = validateRewardIdempotencyKey(params.idempotencyKey);

		return runRewardsTransaction(params.db, (tx) =>
			createSimpleRewardEventInTransaction(tx, {
				userId,
				rewardAccountId,
				eventType,
				pointAmount,
				conversionRateOverride,
				reasonNote,
				occurredAt,
				idempotencyKey,
				sourceType: "MANUAL",
				sourceRef: null,
			}),
		);
	};
}

export const recordRewardOpeningBalance = makeSimpleEventApi("OPENING_BALANCE");
export const recordRewardEarn = makeSimpleEventApi("EARN");
export const recordRewardExpiry = makeSimpleEventApi("EXPIRE");
export const recordRewardAdjustmentCredit =
	makeSimpleEventApi("ADJUSTMENT_CREDIT");
export const recordRewardAdjustmentDebit =
	makeSimpleEventApi("ADJUSTMENT_DEBIT");

// ============================================================================
// Reward Purchase (REDEEM_PURCHASE) CREATE
// ============================================================================

export interface RecordRewardPurchaseParams {
	db: Database;
	userId: string;
	rewardAccountId: string;
	pointAmount: string;
	conversionRateOverride?: string | undefined;
	purchaseCategory: string;
	shortTermGoalId?: string | null | undefined;
	merchant?: string | null | undefined;
	description?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

async function tryReplayRewardPurchase(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		rewardAccountId: string;
		pointAmount: string;
		conversionRateOverride: string | undefined;
		purchaseCategory: string;
		shortTermGoalId: string | null;
		merchant: string | null;
		description: string | null;
		occurredAt: Date;
		idempotencyKey: string;
	},
): Promise<RewardEventReadModel | null> {
	const [row] = await tx
		.select()
		.from(rewardEventRevisions)
		.innerJoin(
			rewardEvents,
			eq(rewardEvents.id, rewardEventRevisions.rewardEventId),
		)
		.where(
			and(
				eq(rewardEvents.rewardAccountId, args.rewardAccountId),
				eq(rewardEventRevisions.idempotencyKey, args.idempotencyKey),
			),
		)
		.limit(1);

	const existingRev = row?.reward_event_revisions;
	if (!existingRev) return null;

	if (existingRev.revisionNo !== 1 || existingRev.operation !== "CREATE") {
		throw new RewardError(
			"REWARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key was already used for a different reward event operation",
		);
	}

	const rate = args.conversionRateOverride ?? existingRev.conversionRate;
	const economicAmount = calculateRewardEconomicAmount(
		parsePointQuantity(args.pointAmount).normalized,
		parseConversionRate(rate).normalized,
	).normalized;

	const candidateFingerprint = await calculateRewardEventCreateFingerprint({
		userId: args.userId,
		rewardAccountId: args.rewardAccountId,
		eventType: "REDEEM_PURCHASE",
		pointAmount: parsePointQuantity(args.pointAmount).normalized,
		conversionRate: parseConversionRate(rate).normalized,
		economicAmount,
		purchaseCategory: args.purchaseCategory,
		shortTermGoalId: args.shortTermGoalId,
		merchant: args.merchant,
		description: args.description,
		reasonNote: null,
		sourceType: "MANUAL",
		sourceRef: null,
		occurredAt: args.occurredAt,
	});

	if (candidateFingerprint !== existingRev.revisionFingerprint) {
		throw new RewardError(
			"REWARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key reused with a different reward purchase payload",
		);
	}

	return buildRewardEventReadModelByIdInTransaction(
		tx,
		existingRev.rewardEventId,
	);
}

async function createRewardPurchaseInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		rewardAccountId: string;
		pointAmount: string;
		conversionRateOverride: string | undefined;
		purchaseCategory: string;
		shortTermGoalId: string | null;
		merchant: string | null;
		description: string | null;
		occurredAt: Date;
		idempotencyKey: string;
	},
): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
	const earlyReplay = await tryReplayRewardPurchase(tx, args);
	if (earlyReplay) return { event: earlyReplay, idempotentReplay: true };

	// Global lock order: reward account -> short-term goal (read-verify only,
	// no lock -- matches the existing Phase 9/10 contract for goal binding)
	// -> all ledger accounts sorted by id. No Midas lock; no credit-card lock
	// merely because the reward account has a card association.
	await lockActiveRewardAccountInTransaction(
		tx,
		args.userId,
		args.rewardAccountId,
	);

	const secondReplay = await tryReplayRewardPurchase(tx, args);
	if (secondReplay) return { event: secondReplay, idempotentReplay: true };

	const points = parsePointQuantity(args.pointAmount);
	const rateSource =
		args.conversionRateOverride ??
		(await resolveLatestDefaultConversionRateInTransaction(
			tx,
			args.rewardAccountId,
		));
	const rate = parseConversionRate(rateSource);

	const currentBalance = await deriveRewardPointBalanceInTransaction(
		tx,
		args.rewardAccountId,
	);
	if (currentBalance < points.units) {
		throw new RewardError(
			"REWARD_INSUFFICIENT_POINTS",
			`Insufficient reward points: requested ${points.normalized}, available ${formatUnitsToDecimal(currentBalance, 4)}`,
		);
	}

	// Shape validation (SHORT_TERM_PURCHASE requires/forbids shortTermGoalId
	// per category) is pure and already enforced pre-DB in recordRewardPurchase
	// before this transaction ever started. Only the DB-dependent
	// ownership/ACTIVE-status lookup remains here.
	if (args.shortTermGoalId) {
		const [goal] = await tx
			.select({ id: shortTermGoals.id, status: shortTermGoalRevisions.status })
			.from(shortTermGoals)
			.innerJoin(
				shortTermGoalRevisions,
				eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
			)
			.where(
				and(
					eq(shortTermGoals.id, args.shortTermGoalId),
					eq(shortTermGoals.userId, args.userId),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo))
			.limit(1);
		if (!goal) {
			throw new RewardError(
				"REWARD_INVALID_INPUT",
				`Short-term goal "${args.shortTermGoalId}" not found`,
			);
		}
		if (goal.status !== "ACTIVE") {
			throw new RewardError(
				"REWARD_INVALID_INPUT",
				`Short-term goal "${args.shortTermGoalId}" is not ACTIVE`,
			);
		}
	}

	// Authoritative economic derivation: rejects a zero-value redemption and
	// a value that would overflow the NUMERIC(18,2) money contract, before
	// any ledger/canonical work is attempted.
	const economicAmount = deriveAndValidateEconomicAmount(
		points.normalized,
		rate.normalized,
	);

	const role = mapPurchaseCategoryToSystemRole(
		args.purchaseCategory as
			| "MANDATORY_EXPENSE"
			| "DISCRETIONARY_SPEND"
			| "SHORT_TERM_PURCHASE"
			| "UNCLASSIFIED",
	);
	const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
		tx,
		args.userId,
	);
	const expenseAccountId = systemAccounts[role];
	const rewardBenefitAccountId = await ensureRewardBenefitAccountInTransaction(
		tx,
		args.userId,
	);

	await lockLedgerAccountsInTransaction({
		tx,
		userId: args.userId,
		accountIds: [expenseAccountId, rewardBenefitAccountId],
	});

	const rewardEventId = crypto.randomUUID();

	const canonicalPayload: Record<string, unknown> = {
		rewardEventId,
		rewardAccountId: args.rewardAccountId,
		points: points.normalized,
		conversionRate: rate.normalized,
		economicAmount: economicAmount.normalized,
		purchaseCategory: args.purchaseCategory,
		shortTermGoalId: args.shortTermGoalId,
		merchant: args.merchant,
		description: args.description,
	};

	const boundRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: args.userId,
		kind: "REWARD_FUNDED_PURCHASE",
		idempotencyKey: args.idempotencyKey,
		occurredAt: args.occurredAt,
		payload: canonicalPayload,
		source: { type: "REWARD_FUNDED_PURCHASE", ref: args.idempotencyKey },
		ledger: {
			memo: "Reward-funded purchase",
			lines: [
				{
					accountId: expenseAccountId,
					side: "DEBIT",
					amount: economicAmount.normalized,
				},
				{
					accountId: rewardBenefitAccountId,
					side: "CREDIT",
					amount: economicAmount.normalized,
				},
			],
		},
	});

	const [insertedEvent] = await tx
		.insert(rewardEvents)
		.values({
			id: rewardEventId,
			userId: args.userId,
			rewardAccountId: args.rewardAccountId,
			eventType: "REDEEM_PURCHASE",
			canonicalTransactionId: boundRes.transactionId,
		})
		.returning();
	if (!insertedEvent) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to create reward event",
		);
	}

	const fingerprint = await calculateRewardEventCreateFingerprint({
		userId: args.userId,
		rewardAccountId: args.rewardAccountId,
		eventType: "REDEEM_PURCHASE",
		pointAmount: points.normalized,
		conversionRate: rate.normalized,
		economicAmount: economicAmount.normalized,
		purchaseCategory: args.purchaseCategory,
		shortTermGoalId: args.shortTermGoalId,
		merchant: args.merchant,
		description: args.description,
		reasonNote: null,
		sourceType: "MANUAL",
		sourceRef: null,
		occurredAt: args.occurredAt,
	});

	await tx.insert(rewardEventRevisions).values({
		userId: args.userId,
		rewardEventId: insertedEvent.id,
		revisionNo: 1,
		previousRevisionId: null,
		operation: "CREATE",
		pointAmount: points.normalized,
		conversionRate: rate.normalized,
		economicAmount: economicAmount.normalized,
		purchaseCategory: args.purchaseCategory,
		shortTermGoalId: args.shortTermGoalId,
		merchant: args.merchant,
		description: args.description,
		reasonNote: null,
		occurredAt: args.occurredAt,
		canonicalRevisionId: boundRes.revisionId,
		sourceType: "MANUAL",
		sourceRef: null,
		idempotencyKey: args.idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	const readModel = await buildRewardEventReadModelByIdInTransaction(
		tx,
		insertedEvent.id,
	);
	if (!readModel) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to build newly created reward purchase read model",
		);
	}
	return { event: readModel, idempotentReplay: false };
}

export async function recordRewardPurchase(
	params: RecordRewardPurchaseParams,
): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardAccountId = validateRewardCanonicalUuid(
		params.rewardAccountId,
		"rewardAccountId",
	);
	const pointAmount = parsePointQuantity(params.pointAmount).normalized;
	const conversionRateOverride =
		params.conversionRateOverride === undefined
			? undefined
			: parseConversionRate(params.conversionRateOverride).normalized;
	const purchaseCategory = validateRewardPurchaseCategory(
		params.purchaseCategory,
	);
	const shortTermGoalId =
		params.shortTermGoalId === undefined || params.shortTermGoalId === null
			? null
			: validateRewardCanonicalUuid(params.shortTermGoalId, "shortTermGoalId");
	const merchant = validateRewardOptionalText(params.merchant, "merchant", 200);
	const description = validateRewardOptionalText(
		params.description,
		"description",
		500,
	);
	const occurredAt = validateRewardOccurredAt(params.occurredAt);
	const idempotencyKey = validateRewardIdempotencyKey(params.idempotencyKey);

	// Pure, DB-independent shape validation: SHORT_TERM_PURCHASE requires a
	// goal, every other category forbids one. Runs before any DB work.
	if (purchaseCategory === "SHORT_TERM_PURCHASE" && !shortTermGoalId) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"shortTermGoalId is required when purchaseCategory is SHORT_TERM_PURCHASE",
		);
	}
	if (purchaseCategory !== "SHORT_TERM_PURCHASE" && shortTermGoalId) {
		throw new RewardError(
			"REWARD_INVALID_INPUT",
			"shortTermGoalId is only allowed for SHORT_TERM_PURCHASE category",
		);
	}

	// If the caller supplied an explicit rate, the economic value is fully
	// derivable pre-DB -- reject an overflow or a value that rounds to
	// 0.00 before any transaction is opened. When the rate is omitted, the
	// account's default rate is only known inside the transaction, so this
	// same check is repeated there before any ledger/canonical work.
	if (conversionRateOverride !== undefined) {
		deriveAndValidateEconomicAmount(pointAmount, conversionRateOverride);
	}

	return runRewardsTransaction(params.db, (tx) =>
		createRewardPurchaseInTransaction(tx, {
			userId,
			rewardAccountId,
			pointAmount,
			conversionRateOverride,
			purchaseCategory,
			shortTermGoalId,
			merchant,
			description,
			occurredAt,
			idempotencyKey,
		}),
	);
}

// ============================================================================
// VOID (any event type)
// ============================================================================

export interface VoidRewardEventParams {
	db: Database;
	userId: string;
	rewardEventId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	idempotencyKey: string;
}

/**
 * Internal transaction-scoped primitive for VOIDing any reward event (any
 * event type). Extracted from the former body of the public `voidRewardEvent`
 * so Phase 16 campaigns can VOID a linked reward EARN event atomically inside
 * their own campaign-credit-void transaction. Does NOT call db.transaction()
 * itself -- callers must already be inside a transaction. Pure refactor: this
 * contains every line of logic `voidRewardEvent` used to run inline, with
 * zero behavior change.
 */
export async function voidRewardEventInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		rewardEventId: string;
		expectedRevisionNo: number;
		reasonNote: string | null;
		idempotencyKey: string;
	},
): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
	const {
		userId,
		rewardEventId,
		expectedRevisionNo,
		reasonNote,
		idempotencyKey,
	} = args;

	const [eventPeek] = await tx
		.select()
		.from(rewardEvents)
		.where(
			and(eq(rewardEvents.id, rewardEventId), eq(rewardEvents.userId, userId)),
		)
		.limit(1);
	if (!eventPeek) {
		throw new RewardError(
			"REWARD_EVENT_NOT_FOUND",
			`Reward event "${rewardEventId}" not found`,
		);
	}

	// A reward event has at most two revisions (#1 CREATE, then a single
	// terminal VOID). The VOID always copies forward revision #1's
	// occurred_at -- exactly mirroring how the canonical VOID layer itself
	// never accepts a fresh occurredAt for a REDEEM_PURCHASE's canonical
	// transaction, it always copies the previous canonical revision's
	// occurred_at forward. Deriving it uniformly here (for every event
	// type, not just REDEEM_PURCHASE) keeps the projection's occurred_at
	// always in lockstep with the canonical layer's own behavior.
	const [createRev] = await tx
		.select({ occurredAt: rewardEventRevisions.occurredAt })
		.from(rewardEventRevisions)
		.where(
			and(
				eq(rewardEventRevisions.rewardEventId, rewardEventId),
				eq(rewardEventRevisions.revisionNo, 1),
			),
		)
		.limit(1);
	if (!createRev) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Reward event has no CREATE revision",
		);
	}
	const occurredAt = createRev.occurredAt;

	const tryReplay = async (
		existingRev: typeof rewardEventRevisions.$inferSelect,
	) => {
		if (existingRev.operation !== "VOID") {
			throw new RewardError(
				"REWARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different reward event operation",
			);
		}
		const candidateFingerprint = await calculateRewardEventVoidFingerprint({
			userId,
			rewardEventId,
			expectedRevisionNo,
			occurredAt,
			reasonNote,
		});
		if (candidateFingerprint !== existingRev.revisionFingerprint) {
			throw new RewardError(
				"REWARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key reused with a different reward event VOID payload",
			);
		}
		const readModel = await buildRewardEventReadModelByIdInTransaction(
			tx,
			rewardEventId,
		);
		if (!readModel) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Failed to build replayed reward event read model",
			);
		}
		return { event: readModel, idempotentReplay: true as const };
	};

	const [earlyRev] = await tx
		.select()
		.from(rewardEventRevisions)
		.where(
			and(
				eq(rewardEventRevisions.rewardEventId, rewardEventId),
				eq(rewardEventRevisions.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	if (earlyRev) return tryReplay(earlyRev);

	// Global lock order: reward account -> reward event -> ledger accounts.
	await lockActiveRewardAccountInTransaction(
		tx,
		userId,
		eventPeek.rewardAccountId,
	);

	const secondRev = earlyRev
		? earlyRev
		: (
				await tx
					.select()
					.from(rewardEventRevisions)
					.where(
						and(
							eq(rewardEventRevisions.rewardEventId, rewardEventId),
							eq(rewardEventRevisions.idempotencyKey, idempotencyKey),
						),
					)
					.limit(1)
			)[0];
	if (secondRev) return tryReplay(secondRev);

	const [latestRev] = await tx
		.select()
		.from(rewardEventRevisions)
		.where(eq(rewardEventRevisions.rewardEventId, rewardEventId))
		.orderBy(desc(rewardEventRevisions.revisionNo))
		.limit(1);
	if (!latestRev) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Reward event has no revisions",
		);
	}
	if (latestRev.operation === "VOID") {
		throw new RewardError(
			"REWARD_EVENT_NOT_ACTIVE",
			`Reward event "${rewardEventId}" is already VOID`,
		);
	}
	if (latestRev.revisionNo !== expectedRevisionNo) {
		throw new RewardError(
			"REWARD_EVENT_REVISION_CONFLICT",
			`Expected reward event revision ${expectedRevisionNo} but found ${latestRev.revisionNo}`,
		);
	}

	// Pre-check: voiding a positive-contribution event may derive a
	// negative balance if later negative events already consumed those
	// points -- reject early with a clear error rather than relying only
	// on the deferred DB trigger.
	if (POSITIVE_EVENT_TYPES.has(eventPeek.eventType as RewardEventType)) {
		const currentBalance = await deriveRewardPointBalanceInTransaction(
			tx,
			eventPeek.rewardAccountId,
		);
		const thisEventUnits = parsePointQuantity(latestRev.pointAmount).units;
		if (currentBalance - thisEventUnits < 0n) {
			throw new RewardError(
				"REWARD_INSUFFICIENT_POINTS",
				`Cannot VOID reward event "${rewardEventId}": later activity has already consumed these points`,
			);
		}
	}

	let canonicalRevisionId: string | null = null;
	if (eventPeek.eventType === "REDEEM_PURCHASE") {
		if (!eventPeek.canonicalTransactionId || !latestRev.canonicalRevisionId) {
			throw new RewardError(
				"REWARD_INVALID_STATE",
				"Reward purchase event is missing its canonical transaction binding",
			);
		}
		const boundRes = await voidCanonicalTransactionWithLedgerInTransaction({
			tx,
			userId,
			transactionId: eventPeek.canonicalTransactionId,
			expectedRevisionNo: 1,
			idempotencyKey,
			reasonCode: "REWARD_FUNDED_PURCHASE_VOID",
			reasonNote: reasonNote ?? null,
			source: { type: "REWARD_FUNDED_PURCHASE", ref: idempotencyKey },
		});
		canonicalRevisionId = boundRes.revisionId;
	}

	const fingerprint = await calculateRewardEventVoidFingerprint({
		userId,
		rewardEventId,
		expectedRevisionNo,
		occurredAt,
		reasonNote,
	});

	await tx.insert(rewardEventRevisions).values({
		userId,
		rewardEventId,
		revisionNo: latestRev.revisionNo + 1,
		previousRevisionId: latestRev.id,
		operation: "VOID",
		pointAmount: latestRev.pointAmount,
		conversionRate: latestRev.conversionRate,
		economicAmount: latestRev.economicAmount,
		purchaseCategory: latestRev.purchaseCategory,
		shortTermGoalId: latestRev.shortTermGoalId,
		merchant: latestRev.merchant,
		description: latestRev.description,
		reasonNote,
		occurredAt,
		canonicalRevisionId,
		sourceType: latestRev.sourceType,
		sourceRef: latestRev.sourceRef,
		idempotencyKey,
		revisionFingerprint: fingerprint,
	});

	const readModel = await buildRewardEventReadModelByIdInTransaction(
		tx,
		rewardEventId,
	);
	if (!readModel) {
		throw new RewardError(
			"REWARD_INVALID_STATE",
			"Failed to build voided reward event read model",
		);
	}
	return { event: readModel, idempotentReplay: false };
}

/**
 * Public VOID API: validates inputs, then delegates to
 * `voidRewardEventInTransaction` inside a managed transaction. Thin wrapper
 * only -- zero behavior change from the pre-extraction implementation.
 */
export async function voidRewardEvent(
	params: VoidRewardEventParams,
): Promise<{ event: RewardEventReadModel; idempotentReplay: boolean }> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardEventId = validateRewardCanonicalUuid(
		params.rewardEventId,
		"rewardEventId",
	);
	const expectedRevisionNo = validateRewardExpectedRevisionNo(
		params.expectedRevisionNo,
	);
	const reasonNote = validateRewardOptionalText(
		params.reasonNote,
		"reasonNote",
		500,
	);
	const idempotencyKey = validateRewardIdempotencyKey(params.idempotencyKey);

	return runRewardsTransaction(params.db, (tx) =>
		voidRewardEventInTransaction(tx, {
			userId,
			rewardEventId,
			expectedRevisionNo,
			reasonNote,
			idempotencyKey,
		}),
	);
}

// ============================================================================
// Reads
// ============================================================================

export interface GetRewardEventParams {
	db: Database;
	userId: string;
	rewardEventId: string;
}

export interface ListRewardEventsParams {
	db: Database;
	userId: string;
	rewardAccountId?: string | undefined;
	eventType?: RewardEventType | undefined;
	status?: "ACTIVE" | "VOID" | undefined;
}

export async function getRewardEvent(
	params: GetRewardEventParams,
): Promise<RewardEventReadModel | null> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardEventId = validateRewardCanonicalUuid(
		params.rewardEventId,
		"rewardEventId",
	);

	return runRewardsReadTransaction(params.db, async (tx) => {
		const [event] = await tx
			.select()
			.from(rewardEvents)
			.where(
				and(
					eq(rewardEvents.id, rewardEventId),
					eq(rewardEvents.userId, userId),
				),
			)
			.limit(1);
		if (!event) return null;
		return buildRewardEventReadModelByIdInTransaction(tx, event.id);
	});
}

export async function listRewardEvents(
	params: ListRewardEventsParams,
): Promise<RewardEventReadModel[]> {
	const userId = validateRewardCanonicalUuid(params.userId, "userId");
	const rewardAccountId =
		params.rewardAccountId === undefined
			? undefined
			: validateRewardCanonicalUuid(params.rewardAccountId, "rewardAccountId");
	const eventType = validateRewardEventTypeFilter(params.eventType);
	const status = validateRewardEventStatusFilter(params.status);

	return runRewardsReadTransaction(params.db, async (tx) => {
		const conditions = [eq(rewardEvents.userId, userId)];
		if (rewardAccountId !== undefined) {
			conditions.push(eq(rewardEvents.rewardAccountId, rewardAccountId));
		}
		if (eventType !== undefined) {
			conditions.push(eq(rewardEvents.eventType, eventType));
		}

		const events = await tx
			.select()
			.from(rewardEvents)
			.where(and(...conditions))
			.orderBy(desc(rewardEvents.createdAt), asc(rewardEvents.id));

		const results: RewardEventReadModel[] = [];
		for (const event of events) {
			const readModel = await buildRewardEventReadModelByIdInTransaction(
				tx,
				event.id,
			);
			if (!readModel) continue;
			if (status !== undefined && readModel.status !== status) continue;
			results.push(readModel);
		}
		return results;
	});
}
