import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	type RewardAccountStatus,
	type RewardEventSourceType,
	type RewardEventType,
	rewardAccountRevisions,
	rewardAccounts,
	rewardEventRevisions,
	rewardEvents,
} from "../db/schema/rewards";
import type { RewardAccountReadModel } from "./accounts";
import { runRewardsReadTransaction } from "./boundary";
import { validateRewardCanonicalUuid } from "./calendar";
import {
	formatUnitsToDecimal,
	parseConversionRate,
	roundHalfUpToEconomicCents,
} from "./decimal";
import type { RewardEventReadModel } from "./events";
import { deriveRewardPointBalanceInTransaction } from "./events";
import type { RewardAccountCursor, RewardEventCursor } from "./pagination";

const POSITIVE_EVENT_TYPES = new Set<RewardEventType>([
	"OPENING_BALANCE",
	"EARN",
	"ADJUSTMENT_CREDIT",
]);

// ============================================================================
// Product DTO Interfaces (Sanitized Public Surface)
// ============================================================================

export interface RewardAccountProductDto {
	rewardAccountId: string;
	code: string;
	status: RewardAccountStatus;
	displayName: string;
	provider: string;
	unitName: string;
	creditCardId: string | null;
	defaultConversionRate: string;
	balancePoints: string;
	estimatedCurrentValue: string;
	revisionNo: number;
	occurredAt: string;
	createdAt: string;
}

export interface RewardEventProductDto {
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
	sourceType: RewardEventSourceType;
	occurredAt: string;
	createdAt: string;
}

// ============================================================================
// Public DTO Mappers
// ============================================================================

export function toRewardAccountProductDto(
	model:
		| RewardAccountReadModel
		| {
				rewardAccountId: string;
				code: string;
				status: RewardAccountStatus;
				displayName: string;
				provider: string;
				unitName: string;
				creditCardId: string | null;
				defaultConversionRate: string;
				balancePoints: string;
				estimatedCurrentValue: string;
				revisionNo: number;
				occurredAt: Date | string;
				createdAt: Date | string;
		  },
): RewardAccountProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		rewardAccountId: model.rewardAccountId,
		code: model.code,
		status: model.status,
		displayName: model.displayName,
		provider: model.provider,
		unitName: model.unitName,
		creditCardId: model.creditCardId,
		defaultConversionRate: model.defaultConversionRate,
		balancePoints: model.balancePoints,
		estimatedCurrentValue: model.estimatedCurrentValue,
		revisionNo: model.revisionNo,
		occurredAt: occurredAtStr,
		createdAt: createdAtStr,
	};
}

export function toRewardEventProductDto(
	model:
		| RewardEventReadModel
		| {
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
				sourceType: RewardEventSourceType;
				occurredAt: Date | string;
				createdAt: Date | string;
		  },
): RewardEventProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		rewardEventId: model.rewardEventId,
		rewardAccountId: model.rewardAccountId,
		eventType: model.eventType,
		status: model.status,
		revisionNo: model.revisionNo,
		pointAmount: model.pointAmount,
		signedPointEffect: model.signedPointEffect,
		conversionRate: model.conversionRate,
		economicAmount: model.economicAmount,
		purchaseCategory: model.purchaseCategory,
		shortTermGoalId: model.shortTermGoalId,
		merchant: model.merchant,
		description: model.description,
		reasonNote: model.reasonNote,
		sourceType: model.sourceType,
		occurredAt: occurredAtStr,
		createdAt: createdAtStr,
	};
}

// ============================================================================
// 1. Bounded Reward Accounts Query
// ============================================================================

export interface ListBoundedRewardAccountsParams {
	db: Database;
	userId: string;
	status?: RewardAccountStatus | undefined;
	limit: number;
	afterCursor?: RewardAccountCursor | undefined;
}

export interface ListBoundedRewardAccountsResult {
	accounts: RewardAccountProductDto[];
	hasMore: boolean;
	nextCursor: RewardAccountCursor | null;
}

export async function listBoundedRewardAccounts({
	db,
	userId,
	status,
	limit,
	afterCursor,
}: ListBoundedRewardAccountsParams): Promise<ListBoundedRewardAccountsResult> {
	const validUserId = validateRewardCanonicalUuid(userId, "userId");

	return runRewardsReadTransaction(db, async (tx) => {
		const latestAccountRevsSq = tx
			.selectDistinctOn([rewardAccountRevisions.rewardAccountId], {
				rewardAccountId: rewardAccountRevisions.rewardAccountId,
				userId: rewardAccountRevisions.userId,
				revisionNo: rewardAccountRevisions.revisionNo,
				status: rewardAccountRevisions.status,
				displayName: rewardAccountRevisions.displayName,
				provider: rewardAccountRevisions.provider,
				unitName: rewardAccountRevisions.unitName,
				defaultConversionRate: rewardAccountRevisions.defaultConversionRate,
				occurredAt: rewardAccountRevisions.occurredAt,
				createdAt: rewardAccounts.createdAt,
				code: rewardAccounts.code,
				creditCardId: rewardAccounts.creditCardId,
			})
			.from(rewardAccountRevisions)
			.innerJoin(
				rewardAccounts,
				eq(rewardAccounts.id, rewardAccountRevisions.rewardAccountId),
			)
			.where(eq(rewardAccountRevisions.userId, validUserId))
			.orderBy(
				rewardAccountRevisions.rewardAccountId,
				desc(rewardAccountRevisions.revisionNo),
			)
			.as("latest_account_revs");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [
			eq(latestAccountRevsSq.userId, validUserId),
		];

		if (status !== undefined) {
			conditions.push(eq(latestAccountRevsSq.status, status));
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(latestAccountRevsSq.createdAt, cursorDate),
					and(
						eq(latestAccountRevsSq.createdAt, cursorDate),
						lt(latestAccountRevsSq.rewardAccountId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(latestAccountRevsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(latestAccountRevsSq.createdAt),
				desc(latestAccountRevsSq.rewardAccountId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		const dtos: RewardAccountProductDto[] = [];
		for (const row of pageRows) {
			const balanceUnits = await deriveRewardPointBalanceInTransaction(
				tx,
				row.rewardAccountId,
			);
			const balancePoints = formatUnitsToDecimal(balanceUnits, 4);
			const rate = parseConversionRate(row.defaultConversionRate);
			const estimatedValueCents = roundHalfUpToEconomicCents(
				balanceUnits,
				rate.units,
			);

			dtos.push({
				rewardAccountId: row.rewardAccountId,
				code: row.code,
				status: row.status as RewardAccountStatus,
				displayName: row.displayName,
				provider: row.provider,
				unitName: row.unitName,
				creditCardId: row.creditCardId,
				defaultConversionRate: row.defaultConversionRate,
				balancePoints,
				estimatedCurrentValue: formatUnitsToDecimal(estimatedValueCents, 2),
				revisionNo: row.revisionNo,
				occurredAt: row.occurredAt.toISOString(),
				createdAt: row.createdAt.toISOString(),
			});
		}

		let nextCursor: RewardAccountCursor | null = null;
		const lastRow = pageRows[pageRows.length - 1];
		if (hasMore && lastRow) {
			nextCursor = {
				createdAt: lastRow.createdAt.toISOString(),
				id: lastRow.rewardAccountId,
			};
		}

		return {
			accounts: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 2. Bounded Reward Events Query
// ============================================================================

export interface ListBoundedRewardEventsParams {
	db: Database;
	userId: string;
	rewardAccountId: string;
	eventType?: RewardEventType | undefined;
	status?: "ACTIVE" | "VOID" | undefined;
	limit: number;
	afterCursor?: RewardEventCursor | undefined;
}

export interface ListBoundedRewardEventsResult {
	events: RewardEventProductDto[];
	hasMore: boolean;
	nextCursor: RewardEventCursor | null;
}

export async function listBoundedRewardEvents({
	db,
	userId,
	rewardAccountId,
	eventType,
	status,
	limit,
	afterCursor,
}: ListBoundedRewardEventsParams): Promise<ListBoundedRewardEventsResult> {
	const validUserId = validateRewardCanonicalUuid(userId, "userId");
	const validAccountId = validateRewardCanonicalUuid(
		rewardAccountId,
		"rewardAccountId",
	);

	return runRewardsReadTransaction(db, async (tx) => {
		// Ensure account exists for user
		const [account] = await tx
			.select({ id: rewardAccounts.id })
			.from(rewardAccounts)
			.where(
				and(
					eq(rewardAccounts.id, validAccountId),
					eq(rewardAccounts.userId, validUserId),
				),
			)
			.limit(1);
		if (!account) {
			return {
				events: [],
				hasMore: false,
				nextCursor: null,
			};
		}

		const latestEventRevsSq = tx
			.selectDistinctOn([rewardEventRevisions.rewardEventId], {
				rewardEventId: rewardEventRevisions.rewardEventId,
				userId: rewardEventRevisions.userId,
				rewardAccountId: rewardEvents.rewardAccountId,
				eventType: rewardEvents.eventType,
				revisionNo: rewardEventRevisions.revisionNo,
				operation: rewardEventRevisions.operation,
				pointAmount: rewardEventRevisions.pointAmount,
				conversionRate: rewardEventRevisions.conversionRate,
				economicAmount: rewardEventRevisions.economicAmount,
				purchaseCategory: rewardEventRevisions.purchaseCategory,
				shortTermGoalId: rewardEventRevisions.shortTermGoalId,
				merchant: rewardEventRevisions.merchant,
				description: rewardEventRevisions.description,
				reasonNote: rewardEventRevisions.reasonNote,
				sourceType: rewardEventRevisions.sourceType,
				occurredAt: rewardEventRevisions.occurredAt,
				createdAt: rewardEvents.createdAt,
			})
			.from(rewardEventRevisions)
			.innerJoin(
				rewardEvents,
				eq(rewardEvents.id, rewardEventRevisions.rewardEventId),
			)
			.where(
				and(
					eq(rewardEventRevisions.userId, validUserId),
					eq(rewardEvents.rewardAccountId, validAccountId),
				),
			)
			.orderBy(
				rewardEventRevisions.rewardEventId,
				desc(rewardEventRevisions.revisionNo),
			)
			.as("latest_event_revs");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [
			eq(latestEventRevsSq.userId, validUserId),
			eq(latestEventRevsSq.rewardAccountId, validAccountId),
		];

		if (eventType !== undefined) {
			conditions.push(eq(latestEventRevsSq.eventType, eventType));
		}
		if (status !== undefined) {
			if (status === "ACTIVE") {
				conditions.push(sql`${latestEventRevsSq.operation} != 'VOID'`);
			} else {
				conditions.push(sql`${latestEventRevsSq.operation} = 'VOID'`);
			}
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(latestEventRevsSq.createdAt, cursorDate),
					and(
						eq(latestEventRevsSq.createdAt, cursorDate),
						lt(latestEventRevsSq.rewardEventId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(latestEventRevsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(latestEventRevsSq.createdAt),
				desc(latestEventRevsSq.rewardEventId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		const dtos: RewardEventProductDto[] = pageRows.map((r) => {
			const eventStatus = r.operation === "VOID" ? "VOID" : "ACTIVE";
			let signedPointEffect = "0.0000";
			if (eventStatus === "ACTIVE") {
				const isPos = POSITIVE_EVENT_TYPES.has(r.eventType as RewardEventType);
				signedPointEffect = isPos ? r.pointAmount : `-${r.pointAmount}`;
			}

			return {
				rewardEventId: r.rewardEventId,
				rewardAccountId: r.rewardAccountId,
				eventType: r.eventType as RewardEventType,
				status: eventStatus,
				revisionNo: r.revisionNo,
				pointAmount: r.pointAmount,
				signedPointEffect,
				conversionRate: r.conversionRate,
				economicAmount: r.economicAmount,
				purchaseCategory: r.purchaseCategory,
				shortTermGoalId: r.shortTermGoalId,
				merchant: r.merchant,
				description: r.description,
				reasonNote: r.reasonNote,
				sourceType: r.sourceType as RewardEventSourceType,
				occurredAt: r.occurredAt.toISOString(),
				createdAt: r.createdAt.toISOString(),
			};
		});

		let nextCursor: RewardEventCursor | null = null;
		const lastRow = pageRows[pageRows.length - 1];
		if (hasMore && lastRow) {
			nextCursor = {
				createdAt: lastRow.createdAt.toISOString(),
				id: lastRow.rewardEventId,
			};
		}

		return {
			events: dtos,
			hasMore,
			nextCursor,
		};
	});
}
