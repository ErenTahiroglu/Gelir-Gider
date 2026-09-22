import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import type { DatabaseTransaction } from "../db/client";
import { createDatabase } from "../db/client";
import {
	importBatches,
	importRowRevisions,
	importRows,
} from "../db/schema/imports";
import { ImportError, parseGenericCsvV1 } from "../imports";
import { withImportTransaction } from "../imports/boundary";
import type { RawImportRowInput } from "../imports/normalize";
import { MAX_SOURCE_CONTENT_BYTES } from "../imports/normalize";
import {
	applyReadyImportRows,
	buildImportBatchSummaryInTransaction,
	buildImportRowReadModelsInTransaction,
	getImportBatch,
	getImportRow,
	type ImportBatchSummary,
	type ImportRowDetail,
	type ResolveImportRowParams,
	resolveImportRow,
	stageImportBatch,
} from "../imports/service";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
	UUID_RE,
	validateStrictQueryParams,
} from "./transport";

/**
 * IMPORTS — PRODUCT HTTP ADAPTER (Checkpoint 7B.9).
 *
 * Thin authenticated adapter over the existing Imports domain.
 * Every route:
 *   - Runs behind `sameOriginMutationGuard()` + `requireAuthenticatedSession`
 *   - Derives userId ONLY from `c.get("auth").userId`
 *   - Validates the closed transport schema, then delegates to domain
 *   - Maps domain results/errors to bounded, sanitized HTTP responses
 *
 * Financial mutations remain authoritative in Credit Cards / Income domains
 * via `applyImportRow` → `recordCreditCardPurchaseInTransaction` /
 * `createIncomeReceiptInTransaction`. No second financial mutation path exists
 * inside this adapter.
 */

type ImportEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const importsRouter = new Hono<ImportEnv>();

// 11 MiB covers the 10 MiB sourceContent limit plus JSON envelope overhead.
const BATCH_BODY_LIMIT = 11 * 1024 * 1024;
const MUTATION_BODY_LIMIT = 64 * 1024; // 64 KiB for resolve / apply

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

const VALID_ROW_STATUSES = new Set([
	"READY",
	"NEEDS_REVIEW",
	"POSSIBLE_DUPLICATE",
	"EXACT_DUPLICATE",
	"APPLIED",
	"LINKED_EXISTING",
	"SKIPPED",
	"UNSUPPORTED",
]);

function fail(c: Context<ImportEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapImportError(c: Context<ImportEnv>, err: unknown) {
	if (err instanceof ImportError) {
		switch (err.code) {
			case "IMPORT_INVALID_INPUT":
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			case "IMPORT_BATCH_NOT_FOUND":
				return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
			case "IMPORT_ROW_NOT_FOUND":
				return fail(c, "IMPORT_ROW_NOT_FOUND", 404);
			case "IMPORT_REVISION_CONFLICT":
				return fail(c, "IMPORT_REVISION_CONFLICT", 409);
			case "IMPORT_IDEMPOTENCY_CONFLICT":
				return fail(c, "IMPORT_IDEMPOTENCY_CONFLICT", 409);
			case "IMPORT_NEEDS_REVIEW":
				return fail(c, "IMPORT_NEEDS_REVIEW", 409);
			case "IMPORT_POSSIBLE_DUPLICATE":
				return fail(c, "IMPORT_POSSIBLE_DUPLICATE", 409);
			case "IMPORT_EXACT_DUPLICATE":
				return fail(c, "IMPORT_EXACT_DUPLICATE", 409);
			case "IMPORT_UNSUPPORTED_RECORD":
				return fail(c, "IMPORT_UNSUPPORTED_RECORD", 422);
			case "IMPORT_TARGET_NOT_FOUND":
				return fail(c, "IMPORT_TARGET_NOT_FOUND", 404);
			case "IMPORT_TARGET_MISMATCH":
				return fail(c, "IMPORT_TARGET_MISMATCH", 409);
			case "IMPORT_MISSING_CARD_MAPPING":
				return fail(c, "IMPORT_MISSING_CARD_MAPPING", 409);
			case "IMPORT_MISSING_INCOME_MAPPING":
				return fail(c, "IMPORT_MISSING_INCOME_MAPPING", 409);
			case "IMPORT_MISSING_EXPENSE_MAPPING":
				return fail(c, "IMPORT_MISSING_EXPENSE_MAPPING", 409);
			case "IMPORT_INVALID_STATE":
				return fail(c, "IMPORT_INVALID_STATE", 409);
			case "IMPORT_DATABASE_ERROR":
				return fail(c, "INTERNAL_ERROR", 500);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

function batchResponseBody(batch: ImportBatchSummary) {
	return {
		id: batch.id,
		userId: batch.userId,
		provider: batch.provider,
		sourceKind: batch.sourceKind,
		sourceContentHash: batch.sourceContentHash,
		sourceFileName: batch.sourceFileName,
		parserType: batch.parserType,
		parserVersion: batch.parserVersion,
		observedAt: batch.observedAt.toISOString(),
		createdAt: batch.createdAt.toISOString(),
		totalRows: batch.totalRows,
		readyCount: batch.readyCount,
		needsReviewCount: batch.needsReviewCount,
		possibleDuplicateCount: batch.possibleDuplicateCount,
		exactDuplicateCount: batch.exactDuplicateCount,
		appliedCount: batch.appliedCount,
		linkedCount: batch.linkedCount,
		skippedCount: batch.skippedCount,
		unsupportedCount: batch.unsupportedCount,
	};
}

function rowResponseBody(row: ImportRowDetail) {
	return {
		id: row.id,
		userId: row.userId,
		batchId: row.batchId,
		rowOrdinal: row.rowOrdinal,
		recordType: row.recordType,
		latestRevisionNo: row.latestRevisionNo,
		status: row.status,
		payload: row.payload,
		occurredAt: row.occurredAt?.toISOString() ?? null,
		externalIdentityPresent: row.externalIdentityPresent,
		duplicateCandidates: row.duplicateCandidates,
		result: row.result ?? null,
	};
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

importsRouter.use("*", sameOriginMutationGuard());
importsRouter.use("*", requireAuthenticatedSession);

// ---------------------------------------------------------------------------
// GET /imports/batches/:id
// ---------------------------------------------------------------------------

importsRouter.get("/batches/:id", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const id = c.req.param("id");
	if (!UUID_RE.test(id)) {
		return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const batch = await getImportBatch(db, id);
		// Fail-closed ownership: cross-user access returns 404 to avoid
		// revealing whether the batch ID exists.
		if (batch.userId !== userId) {
			return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
		}
		return c.json(batchResponseBody(batch), 200);
	} catch (err) {
		return mapImportError(c, err);
	}
});

// ---------------------------------------------------------------------------
// GET /imports/batches
// ---------------------------------------------------------------------------

importsRouter.get("/batches", async (c) => {
	if (!validateStrictQueryParams(c, ["limit", "after"])) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const rawLimit = c.req.query("limit");
	const limitResult = parseBoundedLimit(rawLimit, {
		defaultLimit: LIST_DEFAULT_LIMIT,
		maxLimit: LIST_MAX_LIMIT,
	});
	if (!limitResult.ok) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}
	const limit = limitResult.limit;

	const after = c.req.query("after");
	if (after !== undefined && !UUID_RE.test(after)) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const fetchLimit = limit + 1;
		const conditions = [eq(importBatches.userId, userId)];
		if (after !== undefined) {
			conditions.push(gt(importBatches.id, after));
		}

		const batchRows = await db
			.select({ id: importBatches.id })
			.from(importBatches)
			.where(and(...conditions))
			.orderBy(asc(importBatches.id))
			.limit(fetchLimit);

		const hasMore = batchRows.length > limit;
		const page = hasMore ? batchRows.slice(0, limit) : batchRows;

		const summaries = await withImportTransaction(db, async (tx) => {
			const result: ImportBatchSummary[] = [];
			for (const b of page) {
				result.push(await buildImportBatchSummaryInTransaction(tx, b.id));
			}
			return result;
		});

		const items = summaries.map(batchResponseBody);
		const nextCursor =
			hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;

		return c.json({ items, nextCursor }, 200);
	} catch (err) {
		return mapImportError(c, err);
	}
});

// ---------------------------------------------------------------------------
// POST /imports/batches
// ---------------------------------------------------------------------------

importsRouter.post(
	"/batches",
	bodyLimit({
		maxSize: BATCH_BODY_LIMIT,
		onError: (c) => c.json(errorEnvelope("IMPORT_INVALID_INPUT"), 413),
	}),
	async (c) => {
		if (!validateStrictQueryParams(c, [])) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const bodyResult = await readJsonObject(c);
		if (!bodyResult.ok) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const ALLOWED_BODY_KEYS = [
			"provider",
			"sourceKind",
			"sourceContent",
			"sourceContentHash",
			"sourceFileName",
			"parserType",
			"parserVersion",
			"observedAt",
			"rows",
		] as const;
		if (!hasOnlyKeys(bodyResult.value, ALLOWED_BODY_KEYS)) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const body = bodyResult.value;

		const observedAtDate = parseCanonicalInstant(body.observedAt);
		if (!observedAtDate) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const sourceKind = body.sourceKind;
		if (
			typeof sourceKind !== "string" ||
			(sourceKind !== "NORMALIZED_ROWS" && sourceKind !== "GENERIC_CSV_V1")
		) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		// Validate sourceContent byte size before calling the domain
		if (body.sourceContent !== undefined && body.sourceContent !== null) {
			if (typeof body.sourceContent !== "string") {
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			}
			const byteLen = new TextEncoder().encode(body.sourceContent).length;
			if (byteLen > MAX_SOURCE_CONTENT_BYTES) {
				return fail(c, "IMPORT_INVALID_INPUT", 413);
			}
		}

		let rows: RawImportRowInput[];

		if (sourceKind === "GENERIC_CSV_V1") {
			// Parse CSV content into normalized rows using the existing parser
			const csvContent = body.sourceContent;
			if (typeof csvContent !== "string") {
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			}
			try {
				rows = parseGenericCsvV1(csvContent);
			} catch (err) {
				if (err instanceof ImportError) {
					return fail(c, "IMPORT_INVALID_INPUT", 400);
				}
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			}
		} else {
			// NORMALIZED_ROWS: rows must be provided directly
			if (!Array.isArray(body.rows)) {
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			}
			rows = body.rows as RawImportRowInput[];
		}

		const userId = c.get("auth").userId;
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await stageImportBatch(db, {
				userId,
				provider:
					typeof body.provider === "string" ? body.provider : "HTTP_UPLOAD",
				sourceKind: sourceKind as "NORMALIZED_ROWS" | "GENERIC_CSV_V1",
				sourceContent:
					typeof body.sourceContent === "string"
						? body.sourceContent
						: undefined,
				sourceContentHash:
					typeof body.sourceContentHash === "string"
						? body.sourceContentHash
						: undefined,
				sourceFileName:
					body.sourceFileName !== undefined
						? (body.sourceFileName as string | null)
						: null,
				parserType:
					typeof body.parserType === "string"
						? body.parserType
						: "GENERIC_CSV_V1",
				parserVersion:
					typeof body.parserVersion === "string" ? body.parserVersion : "1",
				observedAt: observedAtDate,
				rows,
			});

			const httpStatus = result.idempotentReplay ? 200 : 201;
			return c.json(
				{
					batch: batchResponseBody(result.batch),
					rows: result.rows.map(rowResponseBody),
					idempotentReplay: result.idempotentReplay,
				},
				httpStatus as 200,
			);
		} catch (err) {
			return mapImportError(c, err);
		}
	},
);

// ---------------------------------------------------------------------------
// GET /imports/batches/:id/preview
// ---------------------------------------------------------------------------
// Returns a persisted read DTO assembled from the already-staged batch.
// This is NOT a dry-run — it reads existing persisted data. The domain's
// previewImportBatch() function is a dry-run tool and is NOT used here.

importsRouter.get("/batches/:id/preview", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const id = c.req.param("id");
	if (!UUID_RE.test(id)) {
		return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await withImportTransaction(
			db,
			async (tx: DatabaseTransaction) => {
				const summary = await buildImportBatchSummaryInTransaction(tx, id);
				if (summary.userId !== userId) {
					return null;
				}
				// Bounded sample: at most 25 rows, never scaling with 5000 rows
				const PREVIEW_SAMPLE_LIMIT = 25;
				const sampleRowAnchors = await tx
					.select({ id: importRows.id })
					.from(importRows)
					.where(eq(importRows.batchId, id))
					.orderBy(importRows.rowOrdinal)
					.limit(PREVIEW_SAMPLE_LIMIT);

				const rowDetails = await buildImportRowReadModelsInTransaction(
					tx,
					sampleRowAnchors.map((r) => r.id),
				);

				return { summary, rows: rowDetails };
			},
		);

		if (result === null) {
			return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
		}

		return c.json(
			{
				batch: batchResponseBody(result.summary),
				rowSample: result.rows.map(rowResponseBody),
				rowSampleLimit: 25,
			},
			200,
		);
	} catch (err) {
		return mapImportError(c, err);
	}
});

// ---------------------------------------------------------------------------
// POST /imports/batches/:batchId/rows/:rowId/resolve
// ---------------------------------------------------------------------------

importsRouter.post(
	"/batches/:batchId/rows/:rowId/resolve",
	bodyLimit({
		maxSize: MUTATION_BODY_LIMIT,
		onError: (c) => c.json(errorEnvelope("IMPORT_INVALID_INPUT"), 400),
	}),
	async (c) => {
		if (!validateStrictQueryParams(c, [])) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const batchId = c.req.param("batchId");
		const rowId = c.req.param("rowId");
		if (!UUID_RE.test(batchId) || !UUID_RE.test(rowId)) {
			return fail(c, "IMPORT_ROW_NOT_FOUND", 404);
		}

		const idempotencyKeyResult = readIdempotencyKey(c);
		if (!idempotencyKeyResult.ok) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const bodyResult = await readJsonObject(c);
		if (!bodyResult.ok) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const ALLOWED_BODY_KEYS = [
			"expectedRevisionNo",
			"action",
			"resolvedMappings",
			"linkTarget",
			"reasonNote",
		] as const;
		if (!hasOnlyKeys(bodyResult.value, ALLOWED_BODY_KEYS)) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const body = bodyResult.value;

		if (
			typeof body.expectedRevisionNo !== "number" ||
			!Number.isInteger(body.expectedRevisionNo) ||
			body.expectedRevisionNo < 1
		) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const VALID_ACTIONS = new Set([
			"CONFIRM_IMPORT",
			"LINK_EXISTING",
			"RESOLVE_MAPPINGS",
			"SKIP",
		]);
		if (typeof body.action !== "string" || !VALID_ACTIONS.has(body.action)) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const userId = c.get("auth").userId;
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			// Verify that the rowId belongs to the batchId before delegating.
			// Fail-closed: batchId/rowId mismatch → 404.
			const [rowCheck] = await db
				.select({ batchId: importRows.batchId, userId: importRows.userId })
				.from(importRows)
				.where(and(eq(importRows.id, rowId), eq(importRows.userId, userId)))
				.limit(1);

			if (!rowCheck) {
				return fail(c, "IMPORT_ROW_NOT_FOUND", 404);
			}
			if (rowCheck.batchId !== batchId) {
				return fail(c, "IMPORT_ROW_NOT_FOUND", 404);
			}

			const resolveParams: Parameters<typeof resolveImportRow>[1] = {
				userId,
				importRowId: rowId,
				expectedRevisionNo: body.expectedRevisionNo as number,
				action: body.action as
					| "CONFIRM_IMPORT"
					| "LINK_EXISTING"
					| "RESOLVE_MAPPINGS"
					| "SKIP",
				idempotencyKey: idempotencyKeyResult.key,
			};
			if (
				body.resolvedMappings !== undefined &&
				body.resolvedMappings !== null &&
				typeof body.resolvedMappings === "object" &&
				!Array.isArray(body.resolvedMappings)
			) {
				resolveParams.resolvedMappings = body.resolvedMappings as NonNullable<
					ResolveImportRowParams["resolvedMappings"]
				>;
			}
			if (
				body.linkTarget !== undefined &&
				body.linkTarget !== null &&
				typeof body.linkTarget === "object" &&
				!Array.isArray(body.linkTarget)
			) {
				resolveParams.linkTarget = body.linkTarget as NonNullable<
					ResolveImportRowParams["linkTarget"]
				>;
			}
			if (body.reasonNote !== undefined) {
				resolveParams.reasonNote = body.reasonNote as string | null;
			}

			const result = await resolveImportRow(db, resolveParams);

			return c.json(
				{
					row: rowResponseBody(result.row),
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapImportError(c, err);
		}
	},
);

// ---------------------------------------------------------------------------
// POST /imports/batches/:id/apply
// ---------------------------------------------------------------------------

importsRouter.post(
	"/batches/:id/apply",
	bodyLimit({
		maxSize: MUTATION_BODY_LIMIT,
		onError: (c) => c.json(errorEnvelope("IMPORT_INVALID_INPUT"), 400),
	}),
	async (c) => {
		if (!validateStrictQueryParams(c, ["limit"])) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const id = c.req.param("id");
		if (!UUID_RE.test(id)) {
			return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
		}

		const rawLimit = c.req.query("limit");
		const limitResult = parseBoundedLimit(rawLimit, {
			defaultLimit: 50,
			maxLimit: 100,
		});
		if (!limitResult.ok) {
			return fail(c, "IMPORT_INVALID_INPUT", 400);
		}

		const userId = c.get("auth").userId;
		const db = createDatabase(getDatabaseUrl(c.env));

		// Body is optional for apply (no required fields), but if present must
		// be a JSON object with no unknown keys. Validate before any DB work.
		const ct = c.req.header("content-type");
		if (ct?.toLowerCase().includes("application/json")) {
			const bodyResult = await readJsonObject(c);
			if (!bodyResult.ok) {
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			}
			// apply has no body fields — reject any payload
			if (Object.keys(bodyResult.value).length > 0) {
				return fail(c, "IMPORT_INVALID_INPUT", 400);
			}
		}

		try {
			// Verify ownership before applying
			const batch = await getImportBatch(db, id);
			if (batch.userId !== userId) {
				return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
			}

			const result = await applyReadyImportRows(db, {
				userId,
				batchId: id,
				limit: limitResult.limit,
			});
			return c.json(result, 200);
		} catch (err) {
			return mapImportError(c, err);
		}
	},
);

// ---------------------------------------------------------------------------
// GET /imports/rows/:id
// ---------------------------------------------------------------------------

importsRouter.get("/rows/:id", async (c) => {
	if (!validateStrictQueryParams(c, [])) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const id = c.req.param("id");
	if (!UUID_RE.test(id)) {
		return fail(c, "IMPORT_ROW_NOT_FOUND", 404);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const row = await getImportRow(db, id);
		// Fail-closed ownership check
		if (row.userId !== userId) {
			return fail(c, "IMPORT_ROW_NOT_FOUND", 404);
		}
		return c.json(rowResponseBody(row), 200);
	} catch (err) {
		return mapImportError(c, err);
	}
});

// ---------------------------------------------------------------------------
// GET /imports/rows
// ---------------------------------------------------------------------------

importsRouter.get("/rows", async (c) => {
	if (!validateStrictQueryParams(c, ["batchId", "status", "limit", "after"])) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	// batchId is required — import rows naturally scope to their parent batch
	const batchId = c.req.query("batchId");
	if (typeof batchId !== "string" || !UUID_RE.test(batchId)) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const rawStatus = c.req.query("status");
	if (rawStatus !== undefined && !VALID_ROW_STATUSES.has(rawStatus)) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const rawLimit = c.req.query("limit");
	const limitResult = parseBoundedLimit(rawLimit, {
		defaultLimit: LIST_DEFAULT_LIMIT,
		maxLimit: LIST_MAX_LIMIT,
	});
	if (!limitResult.ok) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}
	const limit = limitResult.limit;

	const after = c.req.query("after");
	if (after !== undefined && !UUID_RE.test(after)) {
		return fail(c, "IMPORT_INVALID_INPUT", 400);
	}

	const userId = c.get("auth").userId;
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		// Verify batch ownership first
		const batch = await getImportBatch(db, batchId);
		if (batch.userId !== userId) {
			return fail(c, "IMPORT_BATCH_NOT_FOUND", 404);
		}

		const fetchLimit = limit + 1;

		// Select row IDs applying latest-revision status filter DB-side before page cut
		const rawRowAnchors = await db.execute(sql`
			WITH latest_revisions AS (
				SELECT DISTINCT ON (${importRowRevisions.importRowId})
					${importRowRevisions.importRowId} AS import_row_id,
					${importRowRevisions.revisionNo} AS revision_no,
					${importRowRevisions.status} AS status
				FROM ${importRowRevisions}
				WHERE ${importRowRevisions.userId} = ${userId}
				ORDER BY ${importRowRevisions.importRowId}, ${importRowRevisions.revisionNo} DESC
			)
			SELECT ${importRows.id} AS id
			FROM ${importRows}
			INNER JOIN latest_revisions lr ON ${importRows.id} = lr.import_row_id
			WHERE ${importRows.batchId} = ${batchId}
			  AND ${importRows.userId} = ${userId}
			  ${rawStatus !== undefined ? sql`AND lr.status = ${rawStatus}` : sql``}
			  ${after !== undefined ? sql`AND ${importRows.id} > ${after}` : sql``}
			ORDER BY ${importRows.id} ASC
			LIMIT ${fetchLimit}
		`);

		const rowAnchors = (
			Array.isArray(rawRowAnchors)
				? rawRowAnchors
				: ((rawRowAnchors as { rows?: unknown[] }).rows ?? [])
		) as Array<{ id: string }>;

		const hasMore = rowAnchors.length > limit;
		const page = hasMore ? rowAnchors.slice(0, limit) : rowAnchors;

		// Batch read details in a single set of constant queries (no N+1)
		const details = await withImportTransaction(
			db,
			async (tx: DatabaseTransaction) => {
				return await buildImportRowReadModelsInTransaction(
					tx,
					page.map((r) => r.id),
				);
			},
		);

		const items = details.map(rowResponseBody);
		const nextCursor =
			hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;

		return c.json({ items, nextCursor }, 200);
	} catch (err) {
		return mapImportError(c, err);
	}
});
