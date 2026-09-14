import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	longTermSendTaskRevisions,
	longTermSendTasks,
} from "../db/schema/long-term";
import { midasAccounts } from "../db/schema/midas";
import { transactionRevisions } from "../db/schema/transactions";
import { runLongTermReadTransaction } from "./boundary";
import {
	validateLongTermCanonicalUuid,
	validateLongTermTaskStatusFilter,
} from "./calendar";
import { LongTermError } from "./errors";
import {
	decodeLongTermTaskCursor,
	type LongTermTaskCursor,
} from "./pagination";
import type { LongTermTaskReadModel, LongTermTaskStatus } from "./service";

// ============================================================================
// Public DTO Interface
// ============================================================================

export interface LongTermTaskProductDto {
	taskId: string;
	status: LongTermTaskStatus;
	revisionNo: number;
	amount: string;
	destinationLabel: string | null;
	note: string | null;
	midasAccountId: string;
	pendingBucketId: string;
	allocatedAt: string;
	sentAt: string | null;
	latestMidasAllocationTransferId: string;
	currentSendCanonicalTransactionId: string | null;
	currentSendCanonicalRevisionId: string | null;
	createdAt: string;
}

// ============================================================================
// Public DTO Mapper
// ============================================================================

export function toLongTermTaskProductDto(
	model: LongTermTaskReadModel,
): LongTermTaskProductDto {
	const allocatedAtStr =
		model.allocatedAt instanceof Date
			? model.allocatedAt.toISOString()
			: String(model.allocatedAt);
	const sentAtStr =
		model.sentAt instanceof Date
			? model.sentAt.toISOString()
			: model.sentAt
				? String(model.sentAt)
				: null;
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		taskId: model.taskId,
		status: model.status,
		revisionNo: model.revisionNo,
		amount: model.amount,
		destinationLabel: model.destinationLabel,
		note: model.note,
		midasAccountId: model.midasAccountId,
		pendingBucketId: model.pendingBucketId,
		allocatedAt: allocatedAtStr,
		sentAt: sentAtStr,
		latestMidasAllocationTransferId: model.latestMidasAllocationTransferId,
		currentSendCanonicalTransactionId: model.currentSendCanonicalTransactionId,
		currentSendCanonicalRevisionId: model.currentSendCanonicalRevisionId,
		createdAt: createdAtStr,
	};
}

// ============================================================================
// Bounded Keyset Query
// ============================================================================

export interface ListBoundedLongTermTasksParams {
	db: Database;
	userId: string;
	status?: LongTermTaskStatus | undefined;
	midasAccountId?: string | undefined;
	limit: number;
	afterCursor?: LongTermTaskCursor | undefined;
	rawCursor?: string | undefined;
}

export interface ListBoundedLongTermTasksResult {
	tasks: LongTermTaskProductDto[];
	hasMore: boolean;
	nextCursor: LongTermTaskCursor | null;
}

export async function listBoundedLongTermTasks({
	db,
	userId,
	status,
	midasAccountId,
	limit,
	afterCursor,
	rawCursor,
}: ListBoundedLongTermTasksParams): Promise<ListBoundedLongTermTasksResult> {
	const validUserId = validateLongTermCanonicalUuid(userId, "userId");
	const validStatus = validateLongTermTaskStatusFilter(status);
	const validMidasAccountId =
		midasAccountId === undefined
			? undefined
			: validateLongTermCanonicalUuid(midasAccountId, "midasAccountId");

	return runLongTermReadTransaction(db, async (tx) => {
		let effectiveCursor = afterCursor;
		if (rawCursor !== undefined) {
			effectiveCursor = decodeLongTermTaskCursor(rawCursor, {
				userId: validUserId,
				midasAccountId: validMidasAccountId,
				status: validStatus,
			});
		} else if (effectiveCursor) {
			if (
				effectiveCursor.userId !== validUserId ||
				effectiveCursor.midasAccountId !== (validMidasAccountId ?? "ALL") ||
				effectiveCursor.status !== (validStatus ?? "ALL")
			) {
				throw new LongTermError(
					"LONG_TERM_INVALID_INPUT",
					"Invalid long-term task pagination cursor scope",
				);
			}
		}

		if (validMidasAccountId !== undefined) {
			const [accRecord] = await tx
				.select({ id: midasAccounts.id })
				.from(midasAccounts)
				.where(
					and(
						eq(midasAccounts.id, validMidasAccountId),
						eq(midasAccounts.userId, validUserId),
					),
				)
				.limit(1);
			if (!accRecord) {
				return {
					tasks: [],
					hasMore: false,
					nextCursor: null,
				};
			}
		}

		const latestRevSubquery = tx
			.select({
				taskId: longTermSendTaskRevisions.taskId,
				maxRev: sql<number>`MAX(${longTermSendTaskRevisions.revisionNo})`.as(
					"max_rev",
				),
			})
			.from(longTermSendTaskRevisions)
			.where(eq(longTermSendTaskRevisions.userId, validUserId))
			.groupBy(longTermSendTaskRevisions.taskId)
			.as("latest_rev");

		const conditions = [
			eq(longTermSendTasks.userId, validUserId),
			eq(longTermSendTaskRevisions.revisionNo, latestRevSubquery.maxRev),
		];

		if (validMidasAccountId !== undefined) {
			conditions.push(
				eq(longTermSendTasks.midasAccountId, validMidasAccountId),
			);
		}

		if (validStatus !== undefined) {
			conditions.push(eq(longTermSendTaskRevisions.status, validStatus));
		}

		if (effectiveCursor) {
			const cursorDate = new Date(effectiveCursor.createdAt);
			const cursorCondition = or(
				lt(longTermSendTasks.createdAt, cursorDate),
				and(
					eq(longTermSendTasks.createdAt, cursorDate),
					gt(longTermSendTasks.id, effectiveCursor.id),
				),
			);
			if (cursorCondition) {
				conditions.push(cursorCondition);
			}
		}

		const rows = await tx
			.select({
				task: longTermSendTasks,
				rev: longTermSendTaskRevisions,
			})
			.from(longTermSendTasks)
			.innerJoin(
				longTermSendTaskRevisions,
				eq(longTermSendTaskRevisions.taskId, longTermSendTasks.id),
			)
			.innerJoin(
				latestRevSubquery,
				eq(latestRevSubquery.taskId, longTermSendTasks.id),
			)
			.where(and(...conditions))
			.orderBy(desc(longTermSendTasks.createdAt), asc(longTermSendTasks.id))
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		if (pageRows.length === 0) {
			return {
				tasks: [],
				hasMore: false,
				nextCursor: null,
			};
		}

		const pageTaskIds = pageRows.map((r) => r.task.id);

		// Fetch revision #1 (CREATE) for allocatedAt for bounded page rows only
		const createRevs = await tx
			.select({
				taskId: longTermSendTaskRevisions.taskId,
				occurredAt: longTermSendTaskRevisions.occurredAt,
			})
			.from(longTermSendTaskRevisions)
			.where(
				and(
					eq(longTermSendTaskRevisions.userId, validUserId),
					inArray(longTermSendTaskRevisions.taskId, pageTaskIds),
					eq(longTermSendTaskRevisions.revisionNo, 1),
				),
			);

		const createRevMap = new Map<string, Date>();
		for (const cr of createRevs) {
			createRevMap.set(cr.taskId, cr.occurredAt);
		}

		// Fetch canonical transactions for any SENT tasks with canonicalRevisionId
		const canonicalRevIds = pageRows
			.map((r) => r.rev.canonicalRevisionId)
			.filter((id): id is string => id !== null);

		const canonicalTxMap = new Map<string, string>();
		if (canonicalRevIds.length > 0) {
			const canRevs = await tx
				.select({
					id: transactionRevisions.id,
					transactionId: transactionRevisions.transactionId,
				})
				.from(transactionRevisions)
				.where(inArray(transactionRevisions.id, canonicalRevIds));

			for (const cr of canRevs) {
				canonicalTxMap.set(cr.id, cr.transactionId);
			}
		}

		const tasks: LongTermTaskProductDto[] = pageRows.map(({ task, rev }) => {
			const status = rev.status as LongTermTaskStatus;
			let sentAtStr: string | null = null;
			let currentSendCanonicalRevisionId: string | null = null;
			let currentSendCanonicalTransactionId: string | null = null;

			if (status === "SENT" && rev.canonicalRevisionId) {
				sentAtStr =
					rev.occurredAt instanceof Date
						? rev.occurredAt.toISOString()
						: String(rev.occurredAt);
				currentSendCanonicalRevisionId = rev.canonicalRevisionId;
				currentSendCanonicalTransactionId =
					canonicalTxMap.get(rev.canonicalRevisionId) ?? null;
			}

			const allocatedAtDate = createRevMap.get(task.id) ?? task.createdAt;
			const allocatedAtStr =
				allocatedAtDate instanceof Date
					? allocatedAtDate.toISOString()
					: String(allocatedAtDate);

			const createdAtStr =
				task.createdAt instanceof Date
					? task.createdAt.toISOString()
					: String(task.createdAt);

			return {
				taskId: task.id,
				status,
				revisionNo: rev.revisionNo,
				amount: rev.amount,
				destinationLabel: rev.destinationLabel,
				note: rev.note,
				midasAccountId: task.midasAccountId,
				pendingBucketId: task.pendingBucketId,
				allocatedAt: allocatedAtStr,
				sentAt: sentAtStr,
				latestMidasAllocationTransferId: rev.midasAllocationTransferId,
				currentSendCanonicalTransactionId,
				currentSendCanonicalRevisionId,
				createdAt: createdAtStr,
			};
		});

		let nextCursor: LongTermTaskCursor | null = null;
		const lastRow = pageRows[pageRows.length - 1];
		if (hasMore && lastRow) {
			const createdAtIso =
				lastRow.task.createdAt instanceof Date
					? lastRow.task.createdAt.toISOString()
					: new Date(String(lastRow.task.createdAt)).toISOString();
			nextCursor = {
				v: 1,
				userId: validUserId,
				midasAccountId: validMidasAccountId ?? "ALL",
				status: validStatus ?? "ALL",
				createdAt: createdAtIso,
				id: lastRow.task.id,
			};
		}

		return {
			tasks,
			hasMore,
			nextCursor,
		};
	});
}
