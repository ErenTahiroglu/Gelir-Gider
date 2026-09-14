import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { midasAccounts } from "../db/schema/midas";
import type {
	ShortTermGoalFundingStatus,
	ShortTermGoalStatus,
} from "../db/schema/short-term-goals";
import { validateCanonicalUuid } from "./calendar";
import { ShortTermGoalError } from "./errors";
import type { ShortTermGoalCursor } from "./pagination";
import type { ShortTermGoalRecord } from "./service";
import { listShortTermGoalsInTransaction } from "./service";

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

// ============================================================================
// Public DTO Mapper
// ============================================================================

export function toShortTermGoalProductDto(
	model: ShortTermGoalRecord,
): ShortTermGoalProductDto {
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);
	const updatedAtStr =
		model.updatedAt instanceof Date
			? model.updatedAt.toISOString()
			: String(model.updatedAt);

	return {
		goalId: model.id,
		midasAccountId: model.midasAccountId,
		midasBucketId: model.midasBucketId,
		status: model.status,
		name: model.name,
		fundingTarget: model.fundingTarget,
		accumulatedAmount: model.accumulatedAmount,
		remainingToTarget: model.remainingToTarget,
		fundingStatus: model.fundingStatus,
		progressPercentage: model.progressPercentage,
		targetDate: model.targetDate,
		maxBudget: model.maxBudget,
		targetPrice: model.targetPrice,
		productUrl: model.productUrl,
		note: model.note,
		priority: model.priority,
		latestRevisionNo: model.latestRevisionNo,
		createdAt: createdAtStr,
		updatedAt: updatedAtStr,
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

		const allGoals = await listShortTermGoalsInTransaction({
			tx,
			userId: validUserId,
			midasAccountId: resolvedMidasAccountId,
			status,
			includeTerminal: true,
		});

		// Apply keyset pagination cursor if provided
		let startIndex = 0;
		if (afterCursor) {
			const cursorIndex = allGoals.findIndex((g) => {
				const gCreatedAtIso =
					g.createdAt instanceof Date
						? g.createdAt.toISOString()
						: new Date(String(g.createdAt)).toISOString();
				return (
					g.priority === afterCursor.priority &&
					gCreatedAtIso === afterCursor.createdAt &&
					g.id.toLowerCase() === afterCursor.id.toLowerCase()
				);
			});

			if (cursorIndex !== -1) {
				startIndex = cursorIndex + 1;
			} else {
				// Deterministic position search in sorted list
				startIndex = allGoals.findIndex((g) => {
					if (g.status === "ACTIVE" && afterCursor.priority !== null) {
						const gPri = g.priority ?? Number.MAX_SAFE_INTEGER;
						if (gPri > afterCursor.priority) return true;
						if (gPri < afterCursor.priority) return false;
					} else if (g.status === "ACTIVE" && afterCursor.priority === null) {
						return false;
					} else if (g.status !== "ACTIVE" && afterCursor.priority !== null) {
						return true;
					}
					const gCreatedAtIso =
						g.createdAt instanceof Date
							? g.createdAt.toISOString()
							: new Date(String(g.createdAt)).toISOString();
					const timeCmp = afterCursor.createdAt.localeCompare(gCreatedAtIso);
					if (timeCmp > 0) return true;
					if (timeCmp < 0) return false;
					return (
						g.id.toLowerCase().localeCompare(afterCursor.id.toLowerCase()) > 0
					);
				});
				if (startIndex === -1) {
					startIndex = allGoals.length;
				}
			}
		}

		const page = allGoals.slice(startIndex, startIndex + limit);
		const hasMore = startIndex + limit < allGoals.length;

		let nextCursor: ShortTermGoalCursor | null = null;
		const lastItem = page[page.length - 1];
		if (hasMore && lastItem) {
			const createdAtIso =
				lastItem.createdAt instanceof Date
					? lastItem.createdAt.toISOString()
					: new Date(String(lastItem.createdAt)).toISOString();
			nextCursor = {
				priority: lastItem.priority,
				createdAt: createdAtIso,
				id: lastItem.id,
			};
		}

		return {
			goals: page.map(toShortTermGoalProductDto),
			hasMore,
			nextCursor,
		};
	});
}
