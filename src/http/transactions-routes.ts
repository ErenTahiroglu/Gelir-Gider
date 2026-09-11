import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	listBoundedCanonicalTransactionRevisions,
	listCanonicalTransactions,
} from "../transactions/product-read-v2";
import { getCanonicalTransaction } from "../transactions/service";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	isUuid,
	parseBoundedLimit,
	parseCanonicalInstant,
} from "./transport";

type TransactionsEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const transactionsRouter = new Hono<TransactionsEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<TransactionsEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapDomainError(c: Context<TransactionsEnv>, err: unknown) {
	if (err instanceof CanonicalTransactionError) {
		switch (err.code) {
			case "TRANSACTION_INVALID_INPUT":
			case "TRANSACTION_PAYLOAD_INVALID":
			case "TRANSACTION_LEDGER_EFFECT_INVALID":
				return fail(c, "TRANSACTION_INVALID_INPUT", 400);
			case "TRANSACTION_NOT_FOUND":
				return fail(c, "TRANSACTION_NOT_FOUND", 404);
			case "TRANSACTION_IDEMPOTENCY_CONFLICT":
			case "TRANSACTION_REVISION_CONFLICT":
			case "TRANSACTION_ALREADY_VOIDED":
			case "TRANSACTION_SOURCE_CONFLICT":
			case "TRANSACTION_LEDGER_EFFECT_CONFLICT":
				return fail(c, "TRANSACTION_IDEMPOTENCY_CONFLICT", 409);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}

	return fail(c, "INTERNAL_ERROR", 500);
}

// Middleware setup -- Read-only router behind authenticated session
transactionsRouter.use("*", requireAuthenticatedSession);
transactionsRouter.use("*", bodyLimit({ maxSize: BODY_LIMIT_BYTES }));

// 1. GET /transactions -- Bounded transaction list
transactionsRouter.get("/", async (c) => {
	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const rawStatus = c.req.query("status");
	let status: "ACTIVE" | "VOIDED" | undefined;
	if (rawStatus !== undefined) {
		const upper = rawStatus.trim().toUpperCase();
		if (upper !== "ACTIVE" && upper !== "VOIDED") {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		status = upper;
	}

	const rawKind = c.req.query("kind");
	let kind: string | undefined;
	if (rawKind !== undefined) {
		const trimmed = rawKind.trim().toUpperCase();
		if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(trimmed)) {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		kind = trimmed;
	}

	const rawBeforeOccurred = c.req.query("beforeOccurredAt");
	let beforeOccurredAt: Date | undefined;
	if (rawBeforeOccurred !== undefined) {
		const parsed = parseCanonicalInstant(rawBeforeOccurred);
		if (!parsed) return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		beforeOccurredAt = parsed;
	}

	const rawBeforeTxId = c.req.query("beforeTransactionId");
	let beforeTransactionId: string | undefined;
	if (rawBeforeTxId !== undefined) {
		if (!isUuid(rawBeforeTxId))
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		beforeTransactionId = rawBeforeTxId.trim();
	}

	if (
		(beforeOccurredAt && !beforeTransactionId) ||
		(!beforeOccurredAt && beforeTransactionId)
	) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await listCanonicalTransactions({
			db,
			userId,
			limit: limitRes.limit,
			status,
			kind,
			beforeOccurredAt,
			beforeTransactionId,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapDomainError(c, err);
	}
});

// 2. GET /transactions/:transactionId -- Transaction detail
transactionsRouter.get("/:transactionId", async (c) => {
	const txId = c.req.param("transactionId");
	if (!isUuid(txId)) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const tx = await getCanonicalTransaction({
			db,
			userId,
			transactionId: txId,
		});

		return c.json(
			{
				transactionId: tx.transactionId,
				kind: tx.kind,
				status: tx.status,
				revisionNo: tx.revisionNo,
				occurredAt: tx.occurredAt.toISOString(),
				payload: tx.payload,
				createdAt: tx.createdAt.toISOString(),
				latestRevisionCreatedAt: tx.latestRevisionCreatedAt.toISOString(),
			},
			200,
		);
	} catch (err) {
		return mapDomainError(c, err);
	}
});

// 3. GET /transactions/:transactionId/revisions -- Bounded revision history
transactionsRouter.get("/:transactionId/revisions", async (c) => {
	const txId = c.req.param("transactionId");
	if (!isUuid(txId)) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const rawBeforeRev = c.req.query("beforeRevisionNo");
	let beforeRevisionNo: number | undefined;
	if (rawBeforeRev !== undefined) {
		if (!/^[0-9]+$/.test(rawBeforeRev)) {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		const n = Number.parseInt(rawBeforeRev, 10);
		if (!Number.isSafeInteger(n) || n < 1) {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		beforeRevisionNo = n;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await listBoundedCanonicalTransactionRevisions({
			db,
			userId,
			transactionId: txId,
			limit: limitRes.limit,
			beforeRevisionNo,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapDomainError(c, err);
	}
});
