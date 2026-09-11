import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import { LedgerError } from "../ledger/errors";
import { parsePositiveMoneyString } from "../ledger/money";
import type { JournalLineInput } from "../ledger/posting";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	createCanonicalTransactionWithLedger,
	reviseCanonicalTransactionWithLedger,
	voidCanonicalTransactionWithLedger,
} from "../transactions/ledger-lifecycle";
import {
	isAllowedManualTransactionKind,
	listBoundedCanonicalTransactionRevisions,
	listCanonicalTransactions,
	PRODUCT_HTTP_SOURCE_TYPE,
	USER_EDIT_REASON_CODE,
	USER_VOID_REASON_CODE,
} from "../transactions/product-read-v2";
import { getCanonicalTransaction } from "../transactions/service";
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
				return fail(c, "TRANSACTION_IDEMPOTENCY_CONFLICT", 409);
			case "TRANSACTION_REVISION_CONFLICT":
				return fail(c, "TRANSACTION_REVISION_CONFLICT", 409);
			case "TRANSACTION_ALREADY_VOIDED":
				return fail(c, "TRANSACTION_ALREADY_VOIDED", 409);
			case "TRANSACTION_SOURCE_CONFLICT":
				return fail(c, "TRANSACTION_SOURCE_CONFLICT", 409);
			case "TRANSACTION_LEDGER_EFFECT_CONFLICT":
				return fail(c, "TRANSACTION_IDEMPOTENCY_CONFLICT", 409);
			case "TRANSACTION_LEDGER_INCOMPLETE_STATE":
			case "TRANSACTION_INVALID_STATE":
				return fail(c, "INTERNAL_ERROR", 500);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}

	if (err instanceof LedgerError) {
		switch (err.code) {
			case "INVALID_MONEY":
			case "LEDGER_INVALID_ENTRY":
				return fail(c, "TRANSACTION_INVALID_INPUT", 400);
			case "LEDGER_UNBALANCED":
				return fail(c, "LEDGER_UNBALANCED", 400);
			case "LEDGER_ACCOUNT_NOT_FOUND":
				return fail(c, "LEDGER_ACCOUNT_NOT_FOUND", 404);
			case "LEDGER_ACCOUNT_ARCHIVED":
				return fail(c, "LEDGER_ACCOUNT_ARCHIVED", 409);
			case "LEDGER_CURRENCY_MISMATCH":
				return fail(c, "LEDGER_CURRENCY_MISMATCH", 400);
			case "LEDGER_IDEMPOTENCY_CONFLICT":
				return fail(c, "TRANSACTION_IDEMPOTENCY_CONFLICT", 409);
			case "LEDGER_ALREADY_REVERSED":
				return fail(c, "LEDGER_ALREADY_REVERSED", 409);
			case "LEDGER_ENTRY_NOT_FOUND":
				return fail(c, "LEDGER_ENTRY_NOT_FOUND", 404);
			case "LEDGER_INCOMPLETE_STATE":
			case "LEDGER_USER_NOT_FOUND":
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}

	return fail(c, "INTERNAL_ERROR", 500);
}

// Middleware setup
transactionsRouter.use("*", sameOriginMutationGuard());
transactionsRouter.use("*", requireAuthenticatedSession);
transactionsRouter.use("*", bodyLimit({ maxSize: BODY_LIMIT_BYTES }));

function validateLedgerLines(rawLedger: unknown): {
	memo?: string | undefined;
	lines: JournalLineInput[];
} | null {
	if (!rawLedger || typeof rawLedger !== "object" || Array.isArray(rawLedger)) {
		return null;
	}
	const ledgerObj = rawLedger as Record<string, unknown>;
	if (!hasOnlyKeys(ledgerObj, ["memo", "lines"])) return null;

	let memo: string | undefined;
	if (ledgerObj.memo !== undefined && ledgerObj.memo !== null) {
		if (typeof ledgerObj.memo !== "string") return null;
		const trimmed = ledgerObj.memo.trim();
		if (trimmed.length > 500) return null;
		memo = trimmed.length > 0 ? trimmed : undefined;
	}

	if (!Array.isArray(ledgerObj.lines) || ledgerObj.lines.length < 2) {
		return null;
	}

	const validatedLines: JournalLineInput[] = [];
	for (const rawLine of ledgerObj.lines) {
		if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) {
			return null;
		}
		const lineObj = rawLine as Record<string, unknown>;
		if (!hasOnlyKeys(lineObj, ["accountId", "side", "amount", "memo"])) {
			return null;
		}

		if (typeof lineObj.accountId !== "string" || !isUuid(lineObj.accountId)) {
			return null;
		}

		if (lineObj.side !== "DEBIT" && lineObj.side !== "CREDIT") {
			return null;
		}

		if (typeof lineObj.amount !== "string") {
			return null; // Numeric JSON money strictly rejected
		}

		try {
			parsePositiveMoneyString(lineObj.amount);
		} catch {
			return null;
		}

		let lineMemo: string | undefined;
		if (lineObj.memo !== undefined && lineObj.memo !== null) {
			if (typeof lineObj.memo !== "string") return null;
			const trimmedMemo = lineObj.memo.trim();
			if (trimmedMemo.length > 500) return null;
			lineMemo = trimmedMemo.length > 0 ? trimmedMemo : undefined;
		}

		validatedLines.push({
			accountId: lineObj.accountId,
			side: lineObj.side,
			amount: lineObj.amount,
			memo: lineMemo,
		});
	}

	return { memo, lines: validatedLines };
}

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

// 4. POST /transactions -- Create product transaction with ledger effect
transactionsRouter.post("/", async (c) => {
	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const body = await readJsonObject(c);
	if (!body.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	if (!hasOnlyKeys(body.value, ["kind", "occurredAt", "payload", "ledger"])) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	const rawKind = body.value.kind;
	if (typeof rawKind !== "string" || !isAllowedManualTransactionKind(rawKind)) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(body.value.occurredAt);
	if (!occurredAt) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const rawPayload = body.value.payload;
	if (
		!rawPayload ||
		typeof rawPayload !== "object" ||
		Array.isArray(rawPayload)
	) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	const ledger = validateLedgerLines(body.value.ledger);
	if (!ledger) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const res = await createCanonicalTransactionWithLedger({
			db,
			userId,
			kind: rawKind.trim().toUpperCase(),
			idempotencyKey: idem.key,
			occurredAt,
			payload: rawPayload as Record<string, unknown>,
			source: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
				payloadHash: null,
				observedAt: null,
			},
			ledger,
		});

		return c.json(
			{
				transactionId: res.transactionId,
				revisionId: res.revisionId,
				revisionNo: res.revisionNo,
				operation: res.operation,
				idempotentReplay: res.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapDomainError(c, err);
	}
});

// 5. POST /transactions/:transactionId/revisions -- Revise transaction with ledger correction
transactionsRouter.post("/:transactionId/revisions", async (c) => {
	const txId = c.req.param("transactionId");
	if (!isUuid(txId)) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const body = await readJsonObject(c);
	if (!body.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	if (
		!hasOnlyKeys(body.value, [
			"expectedRevisionNo",
			"occurredAt",
			"payload",
			"reasonNote",
			"ledger",
		])
	) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	const expRev = body.value.expectedRevisionNo;
	if (
		typeof expRev !== "number" ||
		!Number.isSafeInteger(expRev) ||
		expRev < 1
	) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(body.value.occurredAt);
	if (!occurredAt) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const rawPayload = body.value.payload;
	if (
		!rawPayload ||
		typeof rawPayload !== "object" ||
		Array.isArray(rawPayload)
	) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	let reasonNote: string | null = null;
	if (body.value.reasonNote !== undefined && body.value.reasonNote !== null) {
		if (typeof body.value.reasonNote !== "string") {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		const trimmed = body.value.reasonNote.trim();
		if (trimmed.length > 500) {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		reasonNote = trimmed.length > 0 ? trimmed : null;
	}

	const ledger = validateLedgerLines(body.value.ledger);
	if (!ledger) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const res = await reviseCanonicalTransactionWithLedger({
			db,
			userId,
			transactionId: txId,
			expectedRevisionNo: expRev,
			idempotencyKey: idem.key,
			occurredAt,
			payload: rawPayload as Record<string, unknown>,
			reasonCode: USER_EDIT_REASON_CODE,
			reasonNote,
			source: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
				payloadHash: null,
				observedAt: null,
			},
			ledger,
		});

		return c.json(
			{
				transactionId: res.transactionId,
				revisionId: res.revisionId,
				revisionNo: res.revisionNo,
				operation: res.operation,
				idempotentReplay: res.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapDomainError(c, err);
	}
});

// 6. POST /transactions/:transactionId/void -- Void transaction with ledger reversal
transactionsRouter.post("/:transactionId/void", async (c) => {
	const txId = c.req.param("transactionId");
	if (!isUuid(txId)) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const idem = readIdempotencyKey(c);
	if (!idem.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	const body = await readJsonObject(c);
	if (!body.ok) return fail(c, "TRANSACTION_INVALID_INPUT", 400);

	if (!hasOnlyKeys(body.value, ["expectedRevisionNo", "reasonNote"])) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	const expRev = body.value.expectedRevisionNo;
	if (
		typeof expRev !== "number" ||
		!Number.isSafeInteger(expRev) ||
		expRev < 1
	) {
		return fail(c, "TRANSACTION_INVALID_INPUT", 400);
	}

	let reasonNote: string | null = null;
	if (body.value.reasonNote !== undefined && body.value.reasonNote !== null) {
		if (typeof body.value.reasonNote !== "string") {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		const trimmed = body.value.reasonNote.trim();
		if (trimmed.length > 500) {
			return fail(c, "TRANSACTION_INVALID_INPUT", 400);
		}
		reasonNote = trimmed.length > 0 ? trimmed : null;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const res = await voidCanonicalTransactionWithLedger({
			db,
			userId,
			transactionId: txId,
			expectedRevisionNo: expRev,
			idempotencyKey: idem.key,
			reasonCode: USER_VOID_REASON_CODE,
			reasonNote,
			source: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idem.key,
				payloadHash: null,
				observedAt: null,
			},
		});

		return c.json(
			{
				transactionId: res.transactionId,
				revisionId: res.revisionId,
				revisionNo: res.revisionNo,
				operation: res.operation,
				idempotentReplay: res.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapDomainError(c, err);
	}
});
