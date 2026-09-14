import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	type MidasBucketType,
	midasAccounts,
	midasAllocationTransfers,
} from "../db/schema/midas";
import { MidasError } from "./errors";
import type { MidasTransferCursor } from "./pagination";
import type { MidasLiquidityState } from "./service";
import { normalizeCanonicalUuid } from "./utils";

// ============================================================================
// Public DTO Interfaces
// ============================================================================

export interface MidasBucketProductDto {
	bucketId: string;
	code: string;
	name: string;
	bucketType: MidasBucketType;
	balance: string;
}

export interface MidasLiquidityProductDto {
	midasAccountId: string;
	ledgerAccountId: string;
	currency: string;
	physicalBalance: string;
	totalEarmarked: string;
	unallocatedBalance: string;
	buckets: MidasBucketProductDto[];
}

export interface MidasAllocationTransferProductDto {
	transferId: string;
	midasAccountId: string;
	fromBucketId: string | null;
	toBucketId: string | null;
	amount: string;
	occurredAt: string;
	reversalOfTransferId: string | null;
	memo: string | null;
	createdAt: string;
}

// ============================================================================
// Public DTO Mappers
// ============================================================================

export function toMidasLiquidityProductDto(
	model: MidasLiquidityState,
): MidasLiquidityProductDto {
	return {
		midasAccountId: model.midasAccountId,
		ledgerAccountId: model.ledgerAccountId,
		currency: model.currency,
		physicalBalance: model.physicalBalance,
		totalEarmarked: model.totalEarmarked,
		unallocatedBalance: model.unallocatedBalance,
		buckets: model.buckets.map((b) => ({
			bucketId: b.bucketId,
			code: b.code,
			name: b.name,
			bucketType: b.bucketType,
			balance: b.balance,
		})),
	};
}

export function toMidasAllocationTransferProductDto(model: {
	id: string;
	midasAccountId: string;
	fromBucketId: string | null;
	toBucketId: string | null;
	amount: string;
	occurredAt: Date | string;
	reversalOfTransferId: string | null;
	memo: string | null;
	createdAt: Date | string;
}): MidasAllocationTransferProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);
	const createdAtStr =
		model.createdAt instanceof Date
			? model.createdAt.toISOString()
			: String(model.createdAt);

	return {
		transferId: model.id,
		midasAccountId: model.midasAccountId,
		fromBucketId: model.fromBucketId,
		toBucketId: model.toBucketId,
		amount: model.amount,
		occurredAt: occurredAtStr,
		reversalOfTransferId: model.reversalOfTransferId,
		memo: model.memo,
		createdAt: createdAtStr,
	};
}

// ============================================================================
// Bounded Keyset Query
// ============================================================================

export interface ListBoundedMidasAllocationTransfersParams {
	db: Database;
	userId: string;
	midasAccountId?: string | undefined;
	bucketId?: string | undefined;
	limit: number;
	afterCursor?: MidasTransferCursor | undefined;
	rawCursor?: string | undefined;
}

export interface ListBoundedMidasAllocationTransfersResult {
	transfers: MidasAllocationTransferProductDto[];
	hasMore: boolean;
	nextCursor: MidasTransferCursor | null;
}

export async function listBoundedMidasAllocationTransfers({
	db,
	userId,
	midasAccountId,
	bucketId,
	limit,
	afterCursor,
	rawCursor,
}: ListBoundedMidasAllocationTransfersParams): Promise<ListBoundedMidasAllocationTransfersResult> {
	const canonicalUserId = normalizeCanonicalUuid(userId, "userId");

	let resolvedMidasAccountId = midasAccountId;
	if (resolvedMidasAccountId !== undefined) {
		resolvedMidasAccountId = normalizeCanonicalUuid(
			resolvedMidasAccountId,
			"midasAccountId",
		);
	} else {
		const [acc] = await db
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(eq(midasAccounts.userId, canonicalUserId))
			.limit(1);
		if (!acc) {
			return {
				transfers: [],
				hasMore: false,
				nextCursor: null,
			};
		}
		resolvedMidasAccountId = acc.id;
	}

	const canonicalBucketId =
		bucketId !== undefined
			? normalizeCanonicalUuid(bucketId, "bucketId")
			: undefined;

	let effectiveCursor = afterCursor;
	if (rawCursor !== undefined) {
		const { decodeMidasTransferCursor } = await import("./pagination");
		effectiveCursor = decodeMidasTransferCursor(rawCursor, {
			userId: canonicalUserId,
			midasAccountId: resolvedMidasAccountId,
			bucketId: canonicalBucketId,
		});
	} else if (effectiveCursor) {
		if (
			effectiveCursor.userId !== canonicalUserId ||
			effectiveCursor.midasAccountId !== resolvedMidasAccountId ||
			effectiveCursor.bucketId !== (canonicalBucketId ?? "ALL")
		) {
			throw new MidasError(
				"MIDAS_INVALID_INPUT",
				"Invalid Midas transfer pagination cursor scope",
			);
		}
	}

	// Verify Midas account ownership
	const [accRecord] = await db
		.select({ id: midasAccounts.id })
		.from(midasAccounts)
		.where(
			and(
				eq(midasAccounts.id, resolvedMidasAccountId),
				eq(midasAccounts.userId, canonicalUserId),
			),
		)
		.limit(1);

	if (!accRecord) {
		throw new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "Midas account not found");
	}

	const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [
		eq(midasAllocationTransfers.userId, canonicalUserId),
		eq(midasAllocationTransfers.midasAccountId, resolvedMidasAccountId),
	];

	if (canonicalBucketId !== undefined) {
		conditions.push(
			or(
				eq(midasAllocationTransfers.fromBucketId, canonicalBucketId),
				eq(midasAllocationTransfers.toBucketId, canonicalBucketId),
			),
		);
	}

	if (effectiveCursor) {
		const cursorDate = new Date(effectiveCursor.occurredAt);
		conditions.push(
			or(
				lt(midasAllocationTransfers.occurredAt, cursorDate),
				and(
					eq(midasAllocationTransfers.occurredAt, cursorDate),
					lt(midasAllocationTransfers.id, effectiveCursor.id),
				),
			),
		);
	}

	const nonNullConditions = conditions.filter(
		(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
	);

	const rows = await db
		.select()
		.from(midasAllocationTransfers)
		.where(and(...nonNullConditions))
		.orderBy(
			desc(midasAllocationTransfers.occurredAt),
			desc(midasAllocationTransfers.id),
		)
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;

	let nextCursor: MidasTransferCursor | null = null;
	const lastRow = pageRows[pageRows.length - 1];
	if (hasMore && lastRow) {
		const occurredAtIso =
			lastRow.occurredAt instanceof Date
				? lastRow.occurredAt.toISOString()
				: new Date(String(lastRow.occurredAt)).toISOString();
		nextCursor = {
			v: 1,
			userId: canonicalUserId,
			midasAccountId: resolvedMidasAccountId,
			bucketId: canonicalBucketId ?? "ALL",
			occurredAt: occurredAtIso,
			id: lastRow.id,
		};
	}

	return {
		transfers: pageRows.map(toMidasAllocationTransferProductDto),
		hasMore,
		nextCursor,
	};
}
