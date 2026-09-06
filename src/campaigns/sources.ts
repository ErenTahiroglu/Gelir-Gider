import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { campaignSourceSnapshots } from "../db/schema/campaigns";
import {
	runCampaignsReadTransaction,
	runCampaignsTransaction,
} from "./boundary";
import {
	validateCampaignCanonicalUuid,
	validateCampaignOccurredAt,
	validateCampaignOptionalText,
	validateCampaignRequiredText,
	validateCampaignSourceType,
	validateCampaignSourceUrl,
} from "./calendar";
import { CampaignError } from "./errors";
import { calculateCampaignSourceContentHash } from "./fingerprint";

/**
 * A narrow future interface for an official campaign source collector.
 * Section 9: Phase 16 does NOT implement any concrete collector (no
 * scraping, no browser automation, no bank login automation). This type
 * exists only so a FUTURE, verified, machine-readable official public
 * source integration has a stable shape to implement against -- it is
 * unused by any code in this phase.
 */
export interface FutureOfficialCampaignSourceCollector {
	readonly provider: string;
	/**
	 * Must return only content captured from a verified official public,
	 * unauthenticated, HTTPS machine-readable source. Must never perform
	 * bank login automation, browser automation, or private API calls.
	 */
	fetchLatestSnapshots(): Promise<
		Array<{
			sourceUrl: string;
			externalSourceId: string | null;
			sourceTitle: string | null;
			sourceText: string | null;
			capturedAt: Date;
		}>
	>;
}

export interface CampaignSourceSnapshotReadModel {
	id: string;
	userId: string;
	provider: string;
	sourceType: "MANUAL" | "OFFICIAL_PUBLIC_PAGE" | "IMPORT";
	sourceUrl: string | null;
	externalSourceId: string | null;
	sourceTitle: string | null;
	sourceText: string | null;
	contentHash: string;
	capturedAt: Date;
	createdAt: Date;
	isDuplicateOfLatest: boolean;
}

/**
 * Records a new campaign source snapshot (Section 7). Append-only. If the
 * most recent snapshot for the same (userId, provider, externalSourceId)
 * identity has the identical content hash, no new row is inserted and the
 * existing snapshot is returned with isDuplicateOfLatest=true (Section 8: no
 * duplicate review candidate work for repeated identical content).
 */
export async function recordCampaignSourceSnapshotInTransaction(
	tx: DatabaseTransaction,
	args: {
		userId: string;
		provider: string;
		sourceType: "MANUAL" | "OFFICIAL_PUBLIC_PAGE" | "IMPORT";
		sourceUrl: string | null;
		externalSourceId: string | null;
		sourceTitle: string | null;
		sourceText: string | null;
		capturedAt: Date;
	},
): Promise<CampaignSourceSnapshotReadModel> {
	const contentHash = await calculateCampaignSourceContentHash({
		sourceType: args.sourceType,
		sourceUrl: args.sourceUrl,
		externalSourceId: args.externalSourceId,
		sourceTitle: args.sourceTitle,
		sourceText: args.sourceText,
	});

	const conditions = [
		eq(campaignSourceSnapshots.userId, args.userId),
		eq(campaignSourceSnapshots.provider, args.provider),
	];
	if (args.externalSourceId !== null) {
		conditions.push(
			eq(campaignSourceSnapshots.externalSourceId, args.externalSourceId),
		);
	}

	const [latest] = await tx
		.select()
		.from(campaignSourceSnapshots)
		.where(and(...conditions))
		.orderBy(desc(campaignSourceSnapshots.createdAt))
		.limit(1);

	if (latest && latest.contentHash === contentHash) {
		return {
			id: latest.id,
			userId: latest.userId,
			provider: latest.provider,
			sourceType: latest.sourceType as
				| "MANUAL"
				| "OFFICIAL_PUBLIC_PAGE"
				| "IMPORT",
			sourceUrl: latest.sourceUrl,
			externalSourceId: latest.externalSourceId,
			sourceTitle: latest.sourceTitle,
			sourceText: latest.sourceText,
			contentHash: latest.contentHash,
			capturedAt: latest.capturedAt,
			createdAt: latest.createdAt,
			isDuplicateOfLatest: true,
		};
	}

	const [inserted] = await tx
		.insert(campaignSourceSnapshots)
		.values({
			userId: args.userId,
			provider: args.provider,
			sourceType: args.sourceType,
			sourceUrl: args.sourceUrl,
			externalSourceId: args.externalSourceId,
			sourceTitle: args.sourceTitle,
			sourceText: args.sourceText,
			contentHash,
			capturedAt: args.capturedAt,
		})
		.returning();

	if (!inserted) {
		throw new CampaignError(
			"CAMPAIGN_INVALID_STATE",
			"Failed to record campaign source snapshot",
		);
	}

	return {
		id: inserted.id,
		userId: inserted.userId,
		provider: inserted.provider,
		sourceType: inserted.sourceType as
			| "MANUAL"
			| "OFFICIAL_PUBLIC_PAGE"
			| "IMPORT",
		sourceUrl: inserted.sourceUrl,
		externalSourceId: inserted.externalSourceId,
		sourceTitle: inserted.sourceTitle,
		sourceText: inserted.sourceText,
		contentHash: inserted.contentHash,
		capturedAt: inserted.capturedAt,
		createdAt: inserted.createdAt,
		isDuplicateOfLatest: false,
	};
}

export interface RecordCampaignSourceSnapshotParams {
	db: Database;
	userId: string;
	provider: string;
	sourceType: "MANUAL" | "OFFICIAL_PUBLIC_PAGE" | "IMPORT";
	sourceUrl?: string | null | undefined;
	externalSourceId?: string | null | undefined;
	sourceTitle?: string | null | undefined;
	sourceText?: string | null | undefined;
	capturedAt: Date;
}

export async function recordCampaignSourceSnapshot(
	params: RecordCampaignSourceSnapshotParams,
): Promise<CampaignSourceSnapshotReadModel> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const provider = validateCampaignRequiredText(
		params.provider,
		"provider",
		120,
	);
	const sourceType = validateCampaignSourceType(params.sourceType);
	const sourceUrl = validateCampaignSourceUrl(params.sourceUrl);
	const externalSourceId = validateCampaignOptionalText(
		params.externalSourceId,
		"externalSourceId",
		200,
	);
	const sourceTitle = validateCampaignOptionalText(
		params.sourceTitle,
		"sourceTitle",
		300,
	);
	const sourceText = validateCampaignOptionalText(
		params.sourceText,
		"sourceText",
		20000,
	);
	const capturedAt = validateCampaignOccurredAt(params.capturedAt);

	return runCampaignsTransaction(params.db, (tx) =>
		recordCampaignSourceSnapshotInTransaction(tx, {
			userId,
			provider,
			sourceType,
			sourceUrl,
			externalSourceId,
			sourceTitle,
			sourceText,
			capturedAt,
		}),
	);
}

/**
 * Section 33/56: deterministic semantic diff between the currently confirmed
 * campaign terms and a new candidate revision's terms. Surfaces changed
 * fields only -- never auto-applies anything.
 */
export interface CampaignSemanticDiffEntry {
	field: string;
	currentValue: unknown;
	candidateValue: unknown;
}

export function computeCampaignSemanticDiff(
	current: Record<string, unknown>,
	candidate: Record<string, unknown>,
): CampaignSemanticDiffEntry[] {
	const fields = new Set([...Object.keys(current), ...Object.keys(candidate)]);
	const diffs: CampaignSemanticDiffEntry[] = [];
	for (const field of fields) {
		const currentValue = current[field] ?? null;
		const candidateValue = candidate[field] ?? null;
		if (JSON.stringify(currentValue) !== JSON.stringify(candidateValue)) {
			diffs.push({ field, currentValue, candidateValue });
		}
	}
	return diffs.sort((a, b) => a.field.localeCompare(b.field));
}

export interface GetCampaignSourceSnapshotParams {
	db: Database;
	userId: string;
	sourceSnapshotId: string;
}

export async function getCampaignSourceSnapshot(
	params: GetCampaignSourceSnapshotParams,
): Promise<CampaignSourceSnapshotReadModel | null> {
	const userId = validateCampaignCanonicalUuid(params.userId, "userId");
	const sourceSnapshotId = validateCampaignCanonicalUuid(
		params.sourceSnapshotId,
		"sourceSnapshotId",
	);

	return runCampaignsReadTransaction(params.db, async (tx) => {
		const [row] = await tx
			.select()
			.from(campaignSourceSnapshots)
			.where(
				and(
					eq(campaignSourceSnapshots.id, sourceSnapshotId),
					eq(campaignSourceSnapshots.userId, userId),
				),
			)
			.limit(1);
		if (!row) return null;
		return {
			id: row.id,
			userId: row.userId,
			provider: row.provider,
			sourceType: row.sourceType as
				| "MANUAL"
				| "OFFICIAL_PUBLIC_PAGE"
				| "IMPORT",
			sourceUrl: row.sourceUrl,
			externalSourceId: row.externalSourceId,
			sourceTitle: row.sourceTitle,
			sourceText: row.sourceText,
			contentHash: row.contentHash,
			capturedAt: row.capturedAt,
			createdAt: row.createdAt,
			isDuplicateOfLatest: false,
		};
	});
}
