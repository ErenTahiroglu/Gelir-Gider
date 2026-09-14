import type { Database } from "../db/client";
import { runLongTermReadTransaction } from "./boundary";
import {
	validateLongTermCanonicalUuid,
	validateLongTermTaskStatusFilter,
} from "./calendar";
import type { LongTermTaskCursor } from "./pagination";
import type { LongTermTaskReadModel, LongTermTaskStatus } from "./service";
import { listLongTermInvestmentTasks } from "./service";

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
}: ListBoundedLongTermTasksParams): Promise<ListBoundedLongTermTasksResult> {
	const validUserId = validateLongTermCanonicalUuid(userId, "userId");
	const validStatus = validateLongTermTaskStatusFilter(status);
	const validMidasAccountId =
		midasAccountId === undefined
			? undefined
			: validateLongTermCanonicalUuid(midasAccountId, "midasAccountId");

	return runLongTermReadTransaction(db, async (tx) => {
		const allTasks = await listLongTermInvestmentTasks({
			db: tx as unknown as Database,
			userId: validUserId,
			status: validStatus,
			midasAccountId: validMidasAccountId,
		});

		let startIndex = 0;
		if (afterCursor) {
			const cursorIndex = allTasks.findIndex((t) => {
				const tCreatedAtIso =
					t.createdAt instanceof Date
						? t.createdAt.toISOString()
						: new Date(String(t.createdAt)).toISOString();
				return (
					tCreatedAtIso === afterCursor.createdAt &&
					t.taskId.toLowerCase() === afterCursor.id.toLowerCase()
				);
			});

			if (cursorIndex !== -1) {
				startIndex = cursorIndex + 1;
			} else {
				startIndex = allTasks.findIndex((t) => {
					const tCreatedAtIso =
						t.createdAt instanceof Date
							? t.createdAt.toISOString()
							: new Date(String(t.createdAt)).toISOString();
					const timeCmp = afterCursor.createdAt.localeCompare(tCreatedAtIso);
					if (timeCmp > 0) return true;
					if (timeCmp < 0) return false;
					return (
						t.taskId.toLowerCase().localeCompare(afterCursor.id.toLowerCase()) >
						0
					);
				});
				if (startIndex === -1) {
					startIndex = allTasks.length;
				}
			}
		}

		const page = allTasks.slice(startIndex, startIndex + limit);
		const hasMore = startIndex + limit < allTasks.length;

		let nextCursor: LongTermTaskCursor | null = null;
		const lastItem = page[page.length - 1];
		if (hasMore && lastItem) {
			const createdAtIso =
				lastItem.createdAt instanceof Date
					? lastItem.createdAt.toISOString()
					: new Date(String(lastItem.createdAt)).toISOString();
			nextCursor = {
				createdAt: createdAtIso,
				id: lastItem.taskId,
			};
		}

		return {
			tasks: page.map(toLongTermTaskProductDto),
			hasMore,
			nextCursor,
		};
	});
}
