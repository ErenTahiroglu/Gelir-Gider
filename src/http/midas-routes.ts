import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../config/env";
import { getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { MidasError } from "../midas/errors";
import { encodeMidasTransferCursor } from "../midas/pagination";
import {
	listBoundedMidasAllocationTransfers,
	toMidasLiquidityProductDto,
} from "../midas/product-read";
import {
	createMidasAccount,
	createMidasAllocationTransfer,
	ensureMidasSingletonBucketInTransaction,
	getMidasLiquidityState,
	reverseMidasAllocationTransfer,
} from "../midas/service";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	isUuid,
	parseBoundedLimit,
	parseCanonicalInstant,
	readIdempotencyKey,
	readJsonObject,
	sameOriginMutationGuard,
} from "./transport";

type MidasEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const midasRouter = new Hono<MidasEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<MidasEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapMidasDomainError(c: Context<MidasEnv>, err: unknown) {
	if (err instanceof MidasError) {
		switch (err.code) {
			case "MIDAS_INVALID_INPUT":
				return fail(c, err.code, 400);
			case "MIDAS_ACCOUNT_NOT_FOUND":
			case "MIDAS_BUCKET_NOT_FOUND":
			case "MIDAS_TRANSFER_NOT_FOUND":
				return fail(c, err.code, 404);
			case "MIDAS_ACCOUNT_CONFLICT":
			case "MIDAS_LEDGER_ACCOUNT_INVALID":
			case "MIDAS_BUCKET_CONFLICT":
			case "MIDAS_INSUFFICIENT_FREE_BALANCE":
			case "MIDAS_INSUFFICIENT_BUCKET_BALANCE":
			case "MIDAS_IDEMPOTENCY_CONFLICT":
			case "MIDAS_TRANSFER_ALREADY_REVERSED":
			case "MIDAS_BUCKET_INACTIVE":
			case "MIDAS_BUCKET_CAP_EXCEEDED":
			case "MIDAS_LONG_TERM_BUCKET_RESTRICTED":
				return fail(c, err.code, 409);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}
	return fail(c, "INTERNAL_ERROR", 500);
}

function validateStrictQueryParams(
	c: Context,
	allowedKeys: readonly string[],
): boolean {
	const url = new URL(c.req.url);
	const seen = new Set<string>();
	for (const key of url.searchParams.keys()) {
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		if (!allowedKeys.includes(key)) {
			return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Global Router Middleware
// ---------------------------------------------------------------------------

midasRouter.use("*", requireAuthenticatedSession);
midasRouter.use("*", sameOriginMutationGuard());

// ===========================================================================
// STATIC SUBTREES FIRST
// ===========================================================================

/**
 * 10. POST /midas/accounts (and POST /midas/setup)
 * Idempotent Midas account setup / link to physical ledger account.
 * Also provisions the deterministic PENDING_LONG_TERM singleton bucket.
 */
async function handleMidasSetup(c: Context<MidasEnv>) {
	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "MIDAS_INVALID_INPUT", 400);
	const body = parsed.value;

	if (!hasOnlyKeys(body, ["ledgerAccountId"])) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	if (
		typeof body.ledgerAccountId !== "string" ||
		!isUuid(body.ledgerAccountId)
	) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const account = await createMidasAccount({
			db,
			userId: auth.userId,
			ledgerAccountId: body.ledgerAccountId,
		});

		// Deterministically ensure required PENDING_LONG_TERM singleton bucket
		await db.transaction(async (tx) => {
			await ensureMidasSingletonBucketInTransaction({
				tx,
				userId: auth.userId,
				midasAccountId: account.id,
				bucketType: "PENDING_LONG_TERM",
				code: "PENDING_LONG_TERM",
				name: "Pending Long-Term Investment",
			});
		});

		const createdAtStr =
			account.createdAt instanceof Date
				? account.createdAt.toISOString()
				: String(account.createdAt);

		return c.json(
			{
				midasAccount: {
					midasAccountId: account.id,
					ledgerAccountId: account.ledgerAccountId,
					createdAt: createdAtStr,
				},
			},
			200,
		);
	} catch (err) {
		return mapMidasDomainError(c, err);
	}
}

midasRouter.post(
	"/accounts",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	handleMidasSetup,
);
midasRouter.post(
	"/setup",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	handleMidasSetup,
);

/**
 * 11. GET /midas/liquidity
 * Query current liquidity state for user Midas account.
 */
midasRouter.get("/liquidity", async (c) => {
	if (!validateStrictQueryParams(c, ["midasAccountId"])) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	const midasAccountIdQuery = c.req.query("midasAccountId");
	if (midasAccountIdQuery !== undefined && !isUuid(midasAccountIdQuery)) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const state = await getMidasLiquidityState({
			db,
			userId: auth.userId,
			midasAccountId: midasAccountIdQuery,
		});

		return c.json({ liquidity: toMidasLiquidityProductDto(state) }, 200);
	} catch (err) {
		return mapMidasDomainError(c, err);
	}
});

/**
 * 12. GET /midas/transfers
 * Bounded keyset listing of allocation transfers.
 */
midasRouter.get("/transfers", async (c) => {
	if (
		!validateStrictQueryParams(c, [
			"midasAccountId",
			"bucketId",
			"limit",
			"after",
		])
	) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "MIDAS_INVALID_INPUT", 400);

	const midasAccountIdQuery = c.req.query("midasAccountId");
	if (midasAccountIdQuery !== undefined && !isUuid(midasAccountIdQuery)) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	const bucketIdQuery = c.req.query("bucketId");
	if (bucketIdQuery !== undefined && !isUuid(bucketIdQuery)) {
		return fail(c, "MIDAS_INVALID_INPUT", 400);
	}

	const afterQuery = c.req.query("after");

	const auth = c.get("auth");
	const db = createDatabase(getDatabaseUrl(c.env));

	try {
		const result = await listBoundedMidasAllocationTransfers({
			db,
			userId: auth.userId,
			midasAccountId: midasAccountIdQuery,
			bucketId: bucketIdQuery,
			limit: limitRes.limit,
			rawCursor: afterQuery,
		});

		const nextCursor =
			result.hasMore && result.nextCursor
				? encodeMidasTransferCursor(result.nextCursor)
				: null;

		return c.json(
			{
				transfers: result.transfers,
				limit: limitRes.limit,
				hasMore: result.hasMore,
				nextCursor,
			},
			200,
		);
	} catch (err) {
		return mapMidasDomainError(c, err);
	}
});

/**
 * 13. POST /midas/transfers
 * Create generic earmark allocation transfer.
 */
midasRouter.post(
	"/transfers",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "MIDAS_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "MIDAS_INVALID_INPUT", 400);
		const body = parsed.value;

		if (
			!hasOnlyKeys(body, [
				"midasAccountId",
				"amount",
				"fromBucketId",
				"toBucketId",
				"memo",
				"occurredAt",
			])
		) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		if (
			typeof body.midasAccountId !== "string" ||
			!isUuid(body.midasAccountId) ||
			typeof body.amount !== "string" ||
			typeof body.occurredAt !== "string"
		) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const fromBucketId =
			body.fromBucketId !== undefined
				? body.fromBucketId === null
					? null
					: typeof body.fromBucketId === "string" && isUuid(body.fromBucketId)
						? body.fromBucketId
						: undefined
				: undefined;
		if (fromBucketId === undefined && body.fromBucketId !== undefined) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const toBucketId =
			body.toBucketId !== undefined
				? body.toBucketId === null
					? null
					: typeof body.toBucketId === "string" && isUuid(body.toBucketId)
						? body.toBucketId
						: undefined
				: undefined;
		if (toBucketId === undefined && body.toBucketId !== undefined) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const memo =
			body.memo !== undefined
				? body.memo === null
					? null
					: typeof body.memo === "string"
						? body.memo
						: undefined
				: undefined;
		if (memo === undefined && body.memo !== undefined) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await createMidasAllocationTransfer({
				db,
				userId: auth.userId,
				midasAccountId: body.midasAccountId,
				idempotencyKey: keyRes.key,
				fromBucketId,
				toBucketId,
				amount: body.amount,
				occurredAt: occurredAtDate,
				memo,
			});

			return c.json(
				{
					transfer: {
						transferId: result.transferId,
						midasAccountId: result.midasAccountId,
						fromBucketId: result.fromBucketId,
						toBucketId: result.toBucketId,
						amount: result.amount,
						occurredAt:
							result.occurredAt instanceof Date
								? result.occurredAt.toISOString()
								: String(result.occurredAt),
					},
					idempotentReplay: result.idempotentReplay,
				},
				result.idempotentReplay ? 200 : 201,
			);
		} catch (err) {
			return mapMidasDomainError(c, err);
		}
	},
);

/**
 * 14. POST /midas/transfers/:id/reverse
 * Perform compensating reversal of an allocation transfer.
 */
midasRouter.post(
	"/transfers/:id/reverse",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const targetTransferId = c.req.param("id");
		if (!isUuid(targetTransferId)) return fail(c, "MIDAS_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "MIDAS_INVALID_INPUT", 400);

		const parsed = await readJsonObject(c);
		if (!parsed.ok) return fail(c, "MIDAS_INVALID_INPUT", 400);
		const body = parsed.value;

		if (!hasOnlyKeys(body, ["memo", "occurredAt"])) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		if (typeof body.occurredAt !== "string") {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const occurredAtDate = parseCanonicalInstant(body.occurredAt);
		if (!occurredAtDate) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const memo =
			body.memo !== undefined
				? body.memo === null
					? null
					: typeof body.memo === "string"
						? body.memo
						: undefined
				: undefined;
		if (memo === undefined && body.memo !== undefined) {
			return fail(c, "MIDAS_INVALID_INPUT", 400);
		}

		const auth = c.get("auth");
		const db = createDatabase(getDatabaseUrl(c.env));

		try {
			const result = await reverseMidasAllocationTransfer({
				db,
				userId: auth.userId,
				idempotencyKey: keyRes.key,
				targetTransferId,
				occurredAt: occurredAtDate,
				memo,
			});

			return c.json(
				{
					transfer: {
						transferId: result.transferId,
						midasAccountId: result.midasAccountId,
						fromBucketId: result.fromBucketId,
						toBucketId: result.toBucketId,
						amount: result.amount,
						occurredAt:
							result.occurredAt instanceof Date
								? result.occurredAt.toISOString()
								: String(result.occurredAt),
					},
					idempotentReplay: result.idempotentReplay,
				},
				200,
			);
		} catch (err) {
			return mapMidasDomainError(c, err);
		}
	},
);
