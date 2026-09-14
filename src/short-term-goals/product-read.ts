import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { midasAccounts, midasAllocationTransfers } from "../db/schema/midas";
import {
	type ShortTermGoalFundingStatus,
	type ShortTermGoalStatus,
	shortTermGoalPriorityRevisions,
	shortTermGoalRevisions,
	shortTermGoals,
} from "../db/schema/short-term-goals";
import { parseMoneyString } from "../ledger/money";
import { validateCanonicalUuid } from "./calendar";
import { ShortTermGoalError } from "./errors";
import {
	decodeShortTermGoalCursor,
	type ShortTermGoalCursor,
} from "./pagination";
import type { ShortTermGoalRecord } from "./service";

// ============================================================================
// Public DTO Interface
// ============================================================================

export interface ShortTermGoalProductDto {
	goalId: string;
	midasAccountId: string;
	midasBucketId: string;
	status: ShortTermGoalStatus;
	name: string;
	fundingTarget: string;
	accumulatedAmount: string;
	remainingToTarget: string;
	fundingStatus: ShortTermGoalFundingStatus;
	progressPercentage: number;
	targetDate: string | null;
	maxBudget: string | null;
	targetPrice: string | null;
	productUrl: string | null;
	note: string | null;
	priority: number | null;
	latestRevisionNo: number;
	createdAt: string;
	updatedAt: string;
}

export function toShortTermGoalProductDto(
	record: ShortTermGoalRecord,
): ShortTermGoalProductDto {
	const createdAtStr =
		record.createdAt instanceof Date
			? record.createdAt.toISOString()
			: String(record.createdAt);
	const updatedAtStr =
		record.updatedAt instanceof Date
			? record.updatedAt.toISOString()
			: String(record.updatedAt);

	return {
		goalId: record.id,
		midasAccountId: record.midasAccountId,
		midasBucketId: record.midasBucketId,
		status: record.status,
		name: record.name,
		fundingTarget: record.fundingTarget,
		accumulatedAmount: record.accumulatedAmount,
		remainingToTarget: record.remainingToTarget,
		fundingStatus: record.fundingStatus,
		progressPercentage: record.progressPercentage,
		targetDate: record.targetDate,
		maxBudget: record.maxBudget,
		targetPrice: record.targetPrice,
		productUrl: record.productUrl,
		note: record.note,
		priority: record.priority,
		latestRevisionNo: record.latestRevisionNo,
		createdAt: createdAtStr,
		updatedAt: updatedAtStr,
	};
}

// ============================================================================
// Funding Metrics Helper
// ============================================================================

function deriveFundingMetrics(balanceCents: bigint, targetCents: bigint) {
	const accumulatedAmount = (Number(balanceCents) / 100).toFixed(2);
	let remainingToTarget = "0.00";
	let fundingStatus: ShortTermGoalFundingStatus = "EMPTY";
	let progressPercentage = 0;

	if (targetCents > 0n) {
		const remCents =
			targetCents > balanceCents ? targetCents - balanceCents : 0n;
		remainingToTarget = (Number(remCents) / 100).toFixed(2);

		if (balanceCents === 0n) {
			fundingStatus = "EMPTY";
			progressPercentage = 0;
		} else if (balanceCents >= targetCents) {
			fundingStatus = "TARGET_REACHED";
			progressPercentage = 100;
		} else {
			fundingStatus = "PARTIAL";
			progressPercentage = Math.min(
				99.99,
				Math.round((Number(balanceCents) / Number(targetCents)) * 10000) / 100,
			);
		}
	} else {
		remainingToTarget = "0.00";
		fundingStatus = balanceCents > 0n ? "TARGET_REACHED" : "EMPTY";
		progressPercentage = balanceCents > 0n ? 100 : 0;
	}

	return {
		accumulatedAmount,
		remainingToTarget,
		fundingStatus,
		progressPercentage,
	};
}

// ============================================================================
// Bounded Keyset Query
// ============================================================================

export interface ListBoundedShortTermGoalsParams {
	db: Database;
	userId: string;
	midasAccountId?: string | undefined;
	status?: ShortTermGoalStatus | undefined;
	limit: number;
	afterCursor?: ShortTermGoalCursor | undefined;
	rawCursor?: string | undefined;
}

export interface ListBoundedShortTermGoalsResult {
	goals: ShortTermGoalProductDto[];
	hasMore: boolean;
	nextCursor: ShortTermGoalCursor | null;
}

export async function listBoundedShortTermGoals({
	db,
	userId,
	midasAccountId,
	status,
	limit,
	afterCursor,
	rawCursor,
}: ListBoundedShortTermGoalsParams): Promise<ListBoundedShortTermGoalsResult> {
	const validUserId = validateCanonicalUuid(userId, "userId");

	return await db.transaction(async (tx) => {
		let resolvedMidasAccountId: string;
		if (midasAccountId !== undefined) {
			resolvedMidasAccountId = validateCanonicalUuid(
				midasAccountId,
				"midasAccountId",
			);
		} else {
			const [acc] = await tx
				.select({ id: midasAccounts.id })
				.from(midasAccounts)
				.where(eq(midasAccounts.userId, validUserId))
				.limit(1);
			if (!acc) {
				return {
					goals: [],
					hasMore: false,
					nextCursor: null,
				};
			}
			resolvedMidasAccountId = acc.id;
		}

		// Decode cursor with expected scope if raw cursor was passed
		let effectiveCursor = afterCursor;
		if (rawCursor !== undefined) {
			effectiveCursor = decodeShortTermGoalCursor(rawCursor, {
				userId: validUserId,
				midasAccountId: resolvedMidasAccountId,
				status,
			});
		} else if (effectiveCursor) {
			// Validate scope on decoded cursor as well
			if (
				effectiveCursor.userId !== validUserId ||
				effectiveCursor.midasAccountId !== resolvedMidasAccountId ||
				effectiveCursor.status !== (status ?? "ALL")
			) {
				throw new ShortTermGoalError(
					"SHORT_TERM_GOAL_INVALID_INPUT",
					"Invalid short-term goal pagination cursor scope",
				);
			}
		}

		// Verify Midas account ownership
		const [accRecord] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, resolvedMidasAccountId),
					eq(midasAccounts.userId, validUserId),
				),
			)
			.limit(1);

		if (!accRecord) {
			throw new ShortTermGoalError(
				"SHORT_TERM_GOAL_MIDAS_ACCOUNT_NOT_FOUND",
				"Midas account not found",
			);
		}

		// 1. Fetch latest priority revision for active goals ordering
		const [latestPriority] = await tx
			.select({
				id: shortTermGoalPriorityRevisions.id,
				orderedGoalIds: shortTermGoalPriorityRevisions.orderedGoalIds,
			})
			.from(shortTermGoalPriorityRevisions)
			.where(
				and(
					eq(
						shortTermGoalPriorityRevisions.midasAccountId,
						resolvedMidasAccountId,
					),
					eq(shortTermGoalPriorityRevisions.userId, validUserId),
				),
			)
			.orderBy(desc(shortTermGoalPriorityRevisions.revisionNo))
			.limit(1);

		const orderedGoalIds = (latestPriority?.orderedGoalIds as string[]) ?? [];
		const priorityMap = new Map<string, number>();
		orderedGoalIds.forEach((id, idx) => {
			priorityMap.set(id, idx + 1);
		});

		// 2. Select the bounded list of goal IDs (limit + 1)
		const candidateGoalIds: string[] = [];

		if (status === "ACTIVE") {
			let startIndex = 0;
			if (effectiveCursor) {
				const idx = orderedGoalIds.indexOf(effectiveCursor.id);
				if (idx !== -1) {
					startIndex = idx + 1;
				} else if (effectiveCursor.priority !== null) {
					startIndex = effectiveCursor.priority;
				}
			}
			const pageIds = orderedGoalIds.slice(startIndex, startIndex + limit + 1);
			candidateGoalIds.push(...pageIds);
		} else if (status === "COMPLETED" || status === "CANCELLED") {
			// Terminal goals bounded query via SQL
			const latestRevSubquery = tx
				.select({
					goalId: shortTermGoalRevisions.goalId,
					maxRev: sql<number>`MAX(${shortTermGoalRevisions.revisionNo})`.as(
						"max_rev",
					),
				})
				.from(shortTermGoalRevisions)
				.where(eq(shortTermGoalRevisions.userId, validUserId))
				.groupBy(shortTermGoalRevisions.goalId)
				.as("latest_rev");

			const terminalConditions = [
				eq(shortTermGoals.midasAccountId, resolvedMidasAccountId),
				eq(shortTermGoals.userId, validUserId),
				eq(shortTermGoalRevisions.status, status),
			];

			if (effectiveCursor) {
				const cursorDate = new Date(effectiveCursor.createdAt);
				const cursorCond = or(
					lt(shortTermGoals.createdAt, cursorDate),
					and(
						eq(shortTermGoals.createdAt, cursorDate),
						gt(shortTermGoals.id, effectiveCursor.id),
					),
				);
				if (cursorCond) {
					terminalConditions.push(cursorCond);
				}
			}

			const terminalRows = await tx
				.select({ id: shortTermGoals.id })
				.from(shortTermGoals)
				.innerJoin(
					shortTermGoalRevisions,
					eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
				)
				.innerJoin(
					latestRevSubquery,
					and(
						eq(latestRevSubquery.goalId, shortTermGoals.id),
						eq(shortTermGoalRevisions.revisionNo, latestRevSubquery.maxRev),
					),
				)
				.where(and(...terminalConditions))
				.orderBy(desc(shortTermGoals.createdAt), asc(shortTermGoals.id))
				.limit(limit + 1);

			candidateGoalIds.push(...terminalRows.map((r) => r.id));
		} else {
			// All goals (Active priority first, then Terminal by createdAt DESC, id ASC)
			if (effectiveCursor && effectiveCursor.priority === null) {
				// Cursor is already in terminal section
				const latestRevSubquery = tx
					.select({
						goalId: shortTermGoalRevisions.goalId,
						maxRev: sql<number>`MAX(${shortTermGoalRevisions.revisionNo})`.as(
							"max_rev",
						),
					})
					.from(shortTermGoalRevisions)
					.where(eq(shortTermGoalRevisions.userId, validUserId))
					.groupBy(shortTermGoalRevisions.goalId)
					.as("latest_rev");

				const cursorDate = new Date(effectiveCursor.createdAt);
				const terminalRows = await tx
					.select({ id: shortTermGoals.id })
					.from(shortTermGoals)
					.innerJoin(
						shortTermGoalRevisions,
						eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
					)
					.innerJoin(
						latestRevSubquery,
						and(
							eq(latestRevSubquery.goalId, shortTermGoals.id),
							eq(shortTermGoalRevisions.revisionNo, latestRevSubquery.maxRev),
						),
					)
					.where(
						and(
							eq(shortTermGoals.midasAccountId, resolvedMidasAccountId),
							eq(shortTermGoals.userId, validUserId),
							sql`${shortTermGoalRevisions.status} != 'ACTIVE'`,
							or(
								lt(shortTermGoals.createdAt, cursorDate),
								and(
									eq(shortTermGoals.createdAt, cursorDate),
									gt(shortTermGoals.id, effectiveCursor.id),
								),
							),
						),
					)
					.orderBy(desc(shortTermGoals.createdAt), asc(shortTermGoals.id))
					.limit(limit + 1);

				candidateGoalIds.push(...terminalRows.map((r) => r.id));
			} else {
				// Starting from active section
				let startActiveIndex = 0;
				if (effectiveCursor && effectiveCursor.priority !== null) {
					const idx = orderedGoalIds.indexOf(effectiveCursor.id);
					if (idx !== -1) {
						startActiveIndex = idx + 1;
					} else {
						startActiveIndex = effectiveCursor.priority;
					}
				}
				const activeSlice = orderedGoalIds.slice(
					startActiveIndex,
					startActiveIndex + limit + 1,
				);
				candidateGoalIds.push(...activeSlice);

				if (candidateGoalIds.length < limit + 1) {
					const remainingNeeded = limit + 1 - candidateGoalIds.length;
					const latestRevSubquery = tx
						.select({
							goalId: shortTermGoalRevisions.goalId,
							maxRev: sql<number>`MAX(${shortTermGoalRevisions.revisionNo})`.as(
								"max_rev",
							),
						})
						.from(shortTermGoalRevisions)
						.where(eq(shortTermGoalRevisions.userId, validUserId))
						.groupBy(shortTermGoalRevisions.goalId)
						.as("latest_rev");

					const terminalRows = await tx
						.select({ id: shortTermGoals.id })
						.from(shortTermGoals)
						.innerJoin(
							shortTermGoalRevisions,
							eq(shortTermGoalRevisions.goalId, shortTermGoals.id),
						)
						.innerJoin(
							latestRevSubquery,
							and(
								eq(latestRevSubquery.goalId, shortTermGoals.id),
								eq(shortTermGoalRevisions.revisionNo, latestRevSubquery.maxRev),
							),
						)
						.where(
							and(
								eq(shortTermGoals.midasAccountId, resolvedMidasAccountId),
								eq(shortTermGoals.userId, validUserId),
								sql`${shortTermGoalRevisions.status} != 'ACTIVE'`,
							),
						)
						.orderBy(desc(shortTermGoals.createdAt), asc(shortTermGoals.id))
						.limit(remainingNeeded);

					candidateGoalIds.push(...terminalRows.map((r) => r.id));
				}
			}
		}

		if (candidateGoalIds.length === 0) {
			return {
				goals: [],
				hasMore: false,
				nextCursor: null,
			};
		}

		// 3. Fetch goal anchors for the bounded candidate IDs
		const goalRows = await tx
			.select()
			.from(shortTermGoals)
			.where(
				and(
					eq(shortTermGoals.userId, validUserId),
					inArray(shortTermGoals.id, candidateGoalIds),
				),
			);

		const goalMap = new Map<string, (typeof goalRows)[0]>();
		for (const g of goalRows) {
			goalMap.set(g.id, g);
		}

		// 4. Fetch latest revisions for the bounded candidate IDs
		const revRows = await tx
			.select()
			.from(shortTermGoalRevisions)
			.where(
				and(
					eq(shortTermGoalRevisions.userId, validUserId),
					inArray(shortTermGoalRevisions.goalId, candidateGoalIds),
				),
			)
			.orderBy(desc(shortTermGoalRevisions.revisionNo));

		const latestRevMap = new Map<string, (typeof revRows)[0]>();
		for (const r of revRows) {
			if (!latestRevMap.has(r.goalId)) {
				latestRevMap.set(r.goalId, r);
			}
		}

		// 5. Fetch bucket balances for only the bounded candidate buckets
		const bucketIds = goalRows.map((g) => g.midasBucketId);
		const bucketBalanceMap = new Map<string, bigint>();
		for (const bId of bucketIds) {
			bucketBalanceMap.set(bId, 0n);
		}

		if (bucketIds.length > 0) {
			const transfers = await tx
				.select({
					fromBucketId: midasAllocationTransfers.fromBucketId,
					toBucketId: midasAllocationTransfers.toBucketId,
					amount: midasAllocationTransfers.amount,
				})
				.from(midasAllocationTransfers)
				.where(
					and(
						eq(midasAllocationTransfers.midasAccountId, resolvedMidasAccountId),
						or(
							inArray(midasAllocationTransfers.toBucketId, bucketIds),
							inArray(midasAllocationTransfers.fromBucketId, bucketIds),
						),
					),
				);

			for (const t of transfers) {
				const parsed = parseMoneyString(t.amount);
				if (t.toBucketId && bucketBalanceMap.has(t.toBucketId)) {
					bucketBalanceMap.set(
						t.toBucketId,
						(bucketBalanceMap.get(t.toBucketId) ?? 0n) + parsed.cents,
					);
				}
				if (t.fromBucketId && bucketBalanceMap.has(t.fromBucketId)) {
					bucketBalanceMap.set(
						t.fromBucketId,
						(bucketBalanceMap.get(t.fromBucketId) ?? 0n) - parsed.cents,
					);
				}
			}
		}

		// 6. Build DTOs in order of candidateGoalIds
		const resultDtos: ShortTermGoalProductDto[] = [];
		for (const gId of candidateGoalIds) {
			const goal = goalMap.get(gId);
			const rev = latestRevMap.get(gId);
			if (!goal || !rev) continue;

			const currentBalanceCents =
				bucketBalanceMap.get(goal.midasBucketId) ?? 0n;
			const targetCents = parseMoneyString(rev.fundingTarget).cents;
			const {
				accumulatedAmount,
				remainingToTarget,
				fundingStatus,
				progressPercentage,
			} = deriveFundingMetrics(currentBalanceCents, targetCents);

			const pNum = priorityMap.get(gId) ?? null;

			resultDtos.push({
				goalId: goal.id,
				midasAccountId: goal.midasAccountId,
				midasBucketId: goal.midasBucketId,
				status: rev.status as ShortTermGoalStatus,
				name: rev.name,
				fundingTarget: rev.fundingTarget,
				accumulatedAmount,
				remainingToTarget,
				fundingStatus,
				progressPercentage,
				targetDate: rev.targetDate,
				maxBudget: rev.maxBudget,
				targetPrice: rev.targetPrice,
				productUrl: rev.productUrl,
				note: rev.note,
				priority: pNum,
				latestRevisionNo: rev.revisionNo,
				createdAt:
					goal.createdAt instanceof Date
						? goal.createdAt.toISOString()
						: String(goal.createdAt),
				updatedAt:
					rev.occurredAt instanceof Date
						? rev.occurredAt.toISOString()
						: String(rev.occurredAt),
			});
		}

		const hasMore = resultDtos.length > limit;
		const page = resultDtos.slice(0, limit);

		let nextCursor: ShortTermGoalCursor | null = null;
		const lastItem = page[page.length - 1];
		if (hasMore && lastItem) {
			nextCursor = {
				v: 1,
				userId: validUserId,
				midasAccountId: resolvedMidasAccountId,
				status: status ?? "ALL",
				priority: lastItem.priority,
				createdAt: lastItem.createdAt,
				id: lastItem.goalId,
			};
		}

		return {
			goals: page,
			hasMore,
			nextCursor,
		};
	});
}
