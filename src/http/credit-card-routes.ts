import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { validateGregorianDateString } from "../credit-cards/calendar";
import { CreditCardError } from "../credit-cards/errors";
import { deriveCreditCardSharedChildKey } from "../credit-cards/fingerprint";
import {
	type CardCursor,
	decodeCardCursor,
	decodePurchaseCursor,
	decodeStatementCursor,
	encodeCardCursor,
	encodePurchaseCursor,
	encodeStatementCursor,
	type PurchaseCursor,
	type StatementCursor,
} from "../credit-cards/pagination";
import {
	payCreditCardStatement,
	reconcileCreditCardStatement,
	reopenCreditCardStatementPayment,
} from "../credit-cards/payments";
import {
	getCreditCardOpeningBalance,
	getCreditCardPurchase,
	listCreditCardPurchases,
	recordCreditCardOpeningBalance,
	recordCreditCardPurchase,
	recordSharedCreditCardPurchase,
	updateCreditCardOpeningBalance,
	updateCreditCardPurchase,
	updateCreditCardPurchaseWithSplit,
	voidCreditCardOpeningBalance,
	voidCreditCardPurchase,
	voidCreditCardPurchaseWithSplit,
} from "../credit-cards/purchases";
import {
	archiveCreditCard,
	createCreditCard,
	createCreditCardStatement,
	getCreditCard,
	getCreditCardStatement,
	listCreditCardStatements,
	listCreditCards,
	updateCreditCard,
	updateCreditCardStatement,
	voidCreditCardStatement,
} from "../credit-cards/service";
import {
	type CreditCardPurchaseSplitReadModel,
	createCreditCardPurchaseSplit,
	getCreditCardPurchaseSplit,
	type ParticipantAllocationInput,
	updateCreditCardPurchaseSplit,
	voidCreditCardPurchaseSplit,
} from "../credit-cards/splits";
import {
	getStatementReconciliation,
	getStatementReconciliationAsOf,
	reconcileStatement,
	voidStatementReconciliation,
} from "../credit-cards/statement-reconciliation";
import { createDatabase } from "../db/client";
import type { SplitMethod } from "../db/schema/credit-card-splits";
import { formatSignedCentsToMoney } from "../ledger/money";
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

type CreditCardEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const creditCardRouter = new Hono<CreditCardEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB
const CARD_CODE_REGEX = /^[A-Za-z0-9_-]{1,32}$/;

function fail(c: Context<CreditCardEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapCreditCardDomainError(c: Context<CreditCardEnv>, err: unknown) {
	if (err instanceof CreditCardError) {
		switch (err.code) {
			case "CREDIT_CARD_INVALID_INPUT":
			case "CREDIT_CARD_LEDGER_ACCOUNT_INVALID":
			case "CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_BALANCED":
				return fail(c, err.code, 400);
			case "CREDIT_CARD_NOT_FOUND":
			case "CREDIT_CARD_STATEMENT_NOT_FOUND":
			case "CREDIT_CARD_PURCHASE_NOT_FOUND":
			case "CREDIT_CARD_PAYMENT_NOT_FOUND":
			case "CREDIT_CARD_LEDGER_LINK_NOT_FOUND":
			case "CREDIT_CARD_SYSTEM_ACCOUNT_NOT_FOUND":
			case "CREDIT_CARD_SPLIT_NOT_FOUND":
			case "CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_FOUND":
				return fail(c, err.code, 404);
			case "CREDIT_CARD_NOT_ACTIVE":
			case "CREDIT_CARD_CONFLICT":
			case "CREDIT_CARD_REVISION_CONFLICT":
			case "CREDIT_CARD_STATEMENT_PERIOD_CONFLICT":
			case "CREDIT_CARD_STATEMENT_NOT_OPEN":
			case "CREDIT_CARD_STATEMENT_REVISION_CONFLICT":
			case "CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY":
			case "CREDIT_CARD_RESERVE_CONFLICT":
			case "CREDIT_CARD_IDEMPOTENCY_CONFLICT":
			case "CREDIT_CARD_INVALID_STATE":
			case "CREDIT_CARD_PURCHASE_NOT_ACTIVE":
			case "CREDIT_CARD_OPENING_BALANCE_CONFLICT":
			case "CREDIT_CARD_LIABILITY_SHORTFALL":
			case "CREDIT_CARD_PAYMENT_CONFLICT":
			case "CREDIT_CARD_STATEMENT_ALREADY_PAID":
			case "CREDIT_CARD_STATEMENT_NOT_PAID":
			case "CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY":
			case "CREDIT_CARD_SPLIT_NOT_ACTIVE":
			case "CREDIT_CARD_SPLIT_REVISION_CONFLICT":
			case "CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT":
			case "CREDIT_CARD_SPLIT_CONFLICT":
			case "CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT":
			case "CREDIT_CARD_STATEMENT_RECONCILIATION_IDEMPOTENCY_CONFLICT":
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

// ----------------------------------------------------------------------------
// MIDDLEWARES
// ----------------------------------------------------------------------------
creditCardRouter.use("*", sameOriginMutationGuard());
creditCardRouter.use("*", requireAuthenticatedSession);
creditCardRouter.post(
	"*",
	bodyLimit({
		maxSize: BODY_LIMIT_BYTES,
		onError: (c) => fail(c, "CREDIT_CARD_INVALID_INPUT", 400),
	}),
);

// ============================================================================
// 1. CREDIT CARDS SURFACE
// ============================================================================

/**
 * GET /credit-cards
 * Lists the authenticated user's credit cards.
 */
creditCardRouter.get("/", async (c) => {
	const auth = c.get("auth");
	if (!validateStrictQueryParams(c, ["limit", "status", "after"])) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const statusQuery = c.req.query("status");
	let statusFilter: "ACTIVE" | "ARCHIVED" | undefined;
	if (statusQuery !== undefined) {
		if (statusQuery !== "ACTIVE" && statusQuery !== "ARCHIVED") {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery;
	}

	const afterQuery = c.req.query("after");
	let afterCursor: CardCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeCardCursor(afterQuery);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const rows = await listCreditCards({
			db,
			userId: auth.userId,
			...(statusFilter ? { status: statusFilter } : {}),
			limit: limitRes.limit + 1,
			afterCursor,
		});

		const hasMore = rows.length > limitRes.limit;
		const cards = hasMore ? rows.slice(0, limitRes.limit) : rows;
		const lastCard = cards.length > 0 ? cards[cards.length - 1] : null;
		const nextCursor =
			hasMore && lastCard
				? encodeCardCursor({
						createdAt: lastCard.createdAt.toISOString(),
						id: lastCard.cardId,
					})
				: null;

		return c.json({
			cards,
			limit: limitRes.limit,
			hasMore,
			nextCursor,
		});
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * GET /credit-cards/:id
 * Fetches a single credit card for the authenticated user.
 */
creditCardRouter.get("/:id", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("id");
	if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const card = await getCreditCard({
			db,
			userId: auth.userId,
			cardId,
		});

		if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);
		return c.json({ card });
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards
 * Creates a new credit card definition.
 */
creditCardRouter.post(
	"/",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = [
			"code",
			"displayName",
			"issuer",
			"statementDay",
			"dueDay",
			"creditLimit",
			"lastFour",
			"note",
			"occurredAt",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			code,
			displayName,
			issuer,
			statementDay,
			dueDay,
			creditLimit,
			lastFour,
			note,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (typeof code !== "string" || !CARD_CODE_REGEX.test(code)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof displayName !== "string" ||
			displayName.trim().length === 0 ||
			displayName.length > 120
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof issuer !== "string" ||
			issuer.trim().length === 0 ||
			issuer.length > 120
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof statementDay !== "number" ||
			!Number.isInteger(statementDay) ||
			statementDay < 1 ||
			statementDay > 31
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof dueDay !== "number" ||
			!Number.isInteger(dueDay) ||
			dueDay < 1 ||
			dueDay > 31
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (typeof creditLimit !== "string" || !/^\d+\.\d{2}$/.test(creditLimit)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (lastFour !== undefined && lastFour !== null) {
			if (typeof lastFour !== "string" || !/^\d{4}$/.test(lastFour)) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (note !== undefined && note !== null) {
			if (typeof note !== "string" || note.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const result = await createCreditCard({
				db,
				userId: auth.userId,
				code: code.trim(),
				displayName: displayName.trim(),
				issuer: issuer.trim(),
				statementDay,
				dueDay,
				creditLimit,
				lastFour: lastFour ?? null,
				note: note ? note.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * POST /credit-cards/:id
 * Updates an existing credit card definition (OCC).
 */
creditCardRouter.post(
	"/:id",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("id");
		if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = [
			"expectedRevisionNo",
			"displayName",
			"issuer",
			"statementDay",
			"dueDay",
			"creditLimit",
			"lastFour",
			"note",
			"changeReason",
			"occurredAt",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			displayName,
			issuer,
			statementDay,
			dueDay,
			creditLimit,
			lastFour,
			note,
			changeReason,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof displayName !== "string" ||
			displayName.trim().length === 0 ||
			displayName.length > 120
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof issuer !== "string" ||
			issuer.trim().length === 0 ||
			issuer.length > 120
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof statementDay !== "number" ||
			!Number.isInteger(statementDay) ||
			statementDay < 1 ||
			statementDay > 31
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof dueDay !== "number" ||
			!Number.isInteger(dueDay) ||
			dueDay < 1 ||
			dueDay > 31
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (typeof creditLimit !== "string" || !/^\d+\.\d{2}$/.test(creditLimit)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (lastFour !== undefined && lastFour !== null) {
			if (typeof lastFour !== "string" || !/^\d{4}$/.test(lastFour)) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (note !== undefined && note !== null) {
			if (typeof note !== "string" || note.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (changeReason !== undefined && changeReason !== null) {
			if (typeof changeReason !== "string" || changeReason.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const result = await updateCreditCard({
				db,
				userId: auth.userId,
				cardId,
				expectedRevisionNo,
				displayName: displayName.trim(),
				issuer: issuer.trim(),
				statementDay,
				dueDay,
				creditLimit,
				lastFour: lastFour ?? null,
				note: note ? note.trim() : null,
				changeReason: changeReason ? changeReason.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * POST /credit-cards/:id/archive
 * Archives a credit card definition.
 */
creditCardRouter.post(
	"/:id/archive",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("id");
		if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = ["expectedRevisionNo", "changeReason", "occurredAt"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			changeReason,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (changeReason !== undefined && changeReason !== null) {
			if (typeof changeReason !== "string" || changeReason.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const result = await archiveCreditCard({
				db,
				userId: auth.userId,
				cardId,
				expectedRevisionNo,
				changeReason: changeReason ? changeReason.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

// ============================================================================
// 2. STATEMENTS SURFACE
// ============================================================================

/**
 * GET /credit-cards/:cardId/statements
 * Lists statements for a specific credit card.
 */
creditCardRouter.get("/:cardId/statements", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	if (
		!validateStrictQueryParams(c, ["limit", "status", "cycleMonth", "after"])
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const statusQuery = c.req.query("status");
	let statusFilter: "OPEN" | "PAID" | "VOID" | undefined;
	if (statusQuery !== undefined) {
		if (
			statusQuery !== "OPEN" &&
			statusQuery !== "PAID" &&
			statusQuery !== "VOID"
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery;
	}

	const cycleMonthQuery = c.req.query("cycleMonth");
	let cycleMonthFrom: string | undefined;
	let cycleMonthUntil: string | undefined;
	if (cycleMonthQuery !== undefined) {
		if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cycleMonthQuery)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		cycleMonthFrom = cycleMonthQuery;
		cycleMonthUntil = cycleMonthQuery;
	}

	const afterQuery = c.req.query("after");
	let afterCursor: StatementCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodeStatementCursor(afterQuery);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		// Confirm card ownership
		const card = await getCreditCard({ db, userId: auth.userId, cardId });
		if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);

		const rows = await listCreditCardStatements({
			db,
			userId: auth.userId,
			creditCardId: cardId,
			...(statusFilter ? { status: statusFilter } : {}),
			...(cycleMonthFrom ? { cycleMonthFrom } : {}),
			...(cycleMonthUntil ? { cycleMonthUntil } : {}),
			limit: limitRes.limit + 1,
			afterCursor,
		});

		const hasMore = rows.length > limitRes.limit;
		const statements = hasMore ? rows.slice(0, limitRes.limit) : rows;
		const lastStmt =
			statements.length > 0 ? statements[statements.length - 1] : null;
		const nextCursor =
			hasMore && lastStmt
				? encodeStatementCursor({
						cycleYear: lastStmt.cycleYear,
						cycleMonth: lastStmt.cycleMonth,
						id: lastStmt.statementId,
					})
				: null;

		return c.json({
			statements,
			limit: limitRes.limit,
			hasMore,
			nextCursor,
		});
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * GET /credit-cards/:cardId/statements/:id
 * Fetches detail of a single credit card statement.
 */
creditCardRouter.get("/:cardId/statements/:id", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const statementId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(statementId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const statement = await getCreditCardStatement({
			db,
			userId: auth.userId,
			statementId,
		});

		if (!statement || statement.cardId !== cardId) {
			return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
		}

		return c.json({ statement });
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards/:cardId/statements
 * Creates a credit card statement for a billing cycle.
 */
creditCardRouter.post(
	"/:cardId/statements",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = [
			"midasAccountId",
			"cycleMonth",
			"statementAmount",
			"reservePlacement",
			"note",
			"occurredAt",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			midasAccountId,
			cycleMonth,
			statementAmount,
			reservePlacement,
			note,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (typeof midasAccountId !== "string" || !isUuid(midasAccountId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof cycleMonth !== "string" ||
			!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cycleMonth)
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof statementAmount !== "string" ||
			!/^\d+\.\d{2}$/.test(statementAmount)
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			reservePlacement !== "MIDAS_FUND" &&
			reservePlacement !== "OUTSIDE_MIDAS"
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (note !== undefined && note !== null) {
			if (typeof note !== "string" || note.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const result = await createCreditCardStatement({
				db,
				userId: auth.userId,
				cardId,
				midasAccountId,
				cycleMonth,
				statementAmount,
				reservePlacement,
				note: note ? note.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * POST /credit-cards/:cardId/statements/:id
 * Updates an open credit card statement (OCC).
 */
creditCardRouter.post(
	"/:cardId/statements/:id",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const statementId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(statementId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = [
			"expectedRevisionNo",
			"statementAmount",
			"reservePlacement",
			"note",
			"reasonNote",
			"occurredAt",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			statementAmount,
			reservePlacement,
			note,
			reasonNote,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof statementAmount !== "string" ||
			!/^\d+\.\d{2}$/.test(statementAmount)
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			reservePlacement !== "MIDAS_FUND" &&
			reservePlacement !== "OUTSIDE_MIDAS"
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (note !== undefined && note !== null) {
			if (typeof note !== "string" || note.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (reasonNote !== undefined && reasonNote !== null) {
			if (typeof reasonNote !== "string" || reasonNote.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			// Confirm statement belongs to card
			const stmt = await getCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
			});
			if (!stmt || stmt.cardId !== cardId) {
				return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
			}

			const result = await updateCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
				expectedRevisionNo,
				statementAmount,
				reservePlacement,
				note: note ? note.trim() : null,
				reasonNote: reasonNote ? reasonNote.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * POST /credit-cards/:cardId/statements/:id/void
 * Voids an open credit card statement.
 */
creditCardRouter.post(
	"/:cardId/statements/:id/void",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const statementId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(statementId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = ["expectedRevisionNo", "reasonNote", "occurredAt"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			reasonNote,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (reasonNote !== undefined && reasonNote !== null) {
			if (typeof reasonNote !== "string" || reasonNote.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const stmt = await getCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
			});
			if (!stmt || stmt.cardId !== cardId) {
				return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
			}

			const result = await voidCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
				expectedRevisionNo,
				reasonNote: reasonNote ? reasonNote.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

// ============================================================================
// 3. PAYMENT & REOPEN SURFACE
// ============================================================================

/**
 * POST /credit-cards/:cardId/statements/:id/pay
 * Executes a payment on an open credit card statement.
 */
creditCardRouter.post(
	"/:cardId/statements/:id/pay",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const statementId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(statementId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = [
			"expectedRevisionNo",
			"paymentAmount",
			"paymentMethod",
			"paymentAssetAccountId",
			"outsidePaymentAssetAccountId",
			"occurredAt",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			paymentAmount,
			paymentMethod,
			paymentAssetAccountId,
			outsidePaymentAssetAccountId,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (paymentAmount !== undefined) {
			if (
				typeof paymentAmount !== "string" ||
				!/^\d+\.\d{2}$/.test(paymentAmount)
			) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (paymentMethod !== undefined) {
			if (paymentMethod !== "MIDAS_FUND" && paymentMethod !== "OUTSIDE_MIDAS") {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (paymentAssetAccountId !== undefined) {
			if (
				typeof paymentAssetAccountId !== "string" ||
				!isUuid(paymentAssetAccountId)
			) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}
		if (outsidePaymentAssetAccountId !== undefined) {
			if (
				typeof outsidePaymentAssetAccountId !== "string" ||
				!isUuid(outsidePaymentAssetAccountId)
			) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const stmt = await getCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
			});
			if (!stmt || stmt.cardId !== cardId) {
				return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
			}

			const result = await payCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
				expectedRevisionNo,
				paymentAmount,
				paymentMethod,
				paymentAssetAccountId,
				outsidePaymentAssetAccountId,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * POST /credit-cards/:cardId/statements/:id/reopen
 * Reopens a paid credit card statement (reversal).
 */
creditCardRouter.post(
	"/:cardId/statements/:id/reopen",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const statementId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(statementId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = ["expectedRevisionNo", "reasonNote", "occurredAt"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			reasonNote,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (reasonNote !== undefined && reasonNote !== null) {
			if (typeof reasonNote !== "string" || reasonNote.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const stmt = await getCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
			});
			if (!stmt || stmt.cardId !== cardId) {
				return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
			}

			const result = await reopenCreditCardStatementPayment({
				db,
				userId: auth.userId,
				statementId,
				expectedRevisionNo,
				reasonNote: reasonNote ? reasonNote.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

// ============================================================================
// 4. STATEMENT RECONCILIATION & READINESS SURFACE
// ============================================================================

/**
 * GET /credit-cards/:cardId/statements/:id/readiness
 * Payment-readiness calculation and liability coverage inspection.
 */
creditCardRouter.get("/:cardId/statements/:id/readiness", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const statementId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(statementId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const stmt = await getCreditCardStatement({
			db,
			userId: auth.userId,
			statementId,
		});
		if (!stmt || stmt.cardId !== cardId) {
			return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
		}

		const readiness = await reconcileCreditCardStatement({
			db,
			userId: auth.userId,
			statementId,
		});

		return c.json({ readiness });
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * GET /credit-cards/:cardId/statements/:id/reconciliation
 * Returns explicit stored statement reconciliation decomposition.
 */
creditCardRouter.get("/:cardId/statements/:id/reconciliation", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const statementId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(statementId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const asOfQuery = c.req.query("asOf");
	let asOf: Date | undefined;
	if (asOfQuery !== undefined) {
		asOf = parseCanonicalInstant(asOfQuery) ?? undefined;
		if (!asOf) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const stmt = await getCreditCardStatement({
			db,
			userId: auth.userId,
			statementId,
		});
		if (!stmt || stmt.cardId !== cardId) {
			return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
		}

		const reconView = asOf
			? await getStatementReconciliationAsOf({
					db,
					userId: auth.userId,
					statementId,
					asOf,
				})
			: await getStatementReconciliation({
					db,
					userId: auth.userId,
					statementId,
				});

		const externalAmountsByPerson: Record<string, string> = {};
		for (const [personId, cents] of reconView.externalByPerson.entries()) {
			externalAmountsByPerson[personId] = formatSignedCentsToMoney(cents);
		}

		return c.json({
			reconciliation: {
				statementId: reconView.statementId,
				status: reconView.status,
				revisionNo: reconView.revisionNo,
				statementRevisionId: reconView.statementRevisionId,
				reconciledStatementAmount: reconView.reconciledStatementAmount,
				staleReason: reconView.staleReason,
				components: reconView.components,
				personalAmount: formatSignedCentsToMoney(reconView.personalCents),
				externalAmountsByPerson,
			},
		});
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards/:cardId/statements/:id/reconcile
 * Persists explicit statement reconciliation decomposition.
 */
creditCardRouter.post(
	"/:cardId/statements/:id/reconcile",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const statementId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(statementId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = [
			"statementRevisionId",
			"components",
			"expectedRevisionNo",
			"occurredAt",
		];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			statementRevisionId,
			components,
			expectedRevisionNo,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof statementRevisionId !== "string" ||
			!isUuid(statementRevisionId)
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (!Array.isArray(components) || components.length === 0) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (expectedRevisionNo !== undefined) {
			if (
				typeof expectedRevisionNo !== "number" ||
				!Number.isInteger(expectedRevisionNo) ||
				expectedRevisionNo < 1
			) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		let occurredAt: Date | undefined;
		if (rawOccurredAt !== undefined) {
			occurredAt = parseCanonicalInstant(rawOccurredAt) ?? undefined;
			if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const stmt = await getCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
			});
			if (!stmt || stmt.cardId !== cardId) {
				return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
			}

			const result = await reconcileStatement({
				db,
				userId: auth.userId,
				statementId,
				statementRevisionId,
				// biome-ignore lint/suspicious/noExplicitAny: domain component input validation
				components: components as any,
				idempotencyKey: keyRes.key,
				expectedRevisionNo,
				occurredAt,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * POST /credit-cards/:cardId/statements/:id/reconcile/void
 * Voids an existing explicit statement reconciliation.
 */
creditCardRouter.post(
	"/:cardId/statements/:id/reconcile/void",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const statementId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(statementId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = ["expectedRevisionNo", "occurredAt"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const { expectedRevisionNo, occurredAt: rawOccurredAt } = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		let occurredAt: Date | undefined;
		if (rawOccurredAt !== undefined) {
			occurredAt = parseCanonicalInstant(rawOccurredAt) ?? undefined;
			if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const stmt = await getCreditCardStatement({
				db,
				userId: auth.userId,
				statementId,
			});
			if (!stmt || stmt.cardId !== cardId) {
				return fail(c, "CREDIT_CARD_STATEMENT_NOT_FOUND", 404);
			}

			await voidStatementReconciliation({
				db,
				userId: auth.userId,
				statementId,
				expectedRevisionNo,
				idempotencyKey: keyRes.key,
				occurredAt,
			});

			return c.json({ ok: true }, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

// ============================================================================
// 5. CREDIT CARD PURCHASES SURFACE (Unshared Product Surface)
// ============================================================================

/**
 * GET /credit-cards/:cardId/purchases
 * Lists unshared purchases for a credit card.
 */
creditCardRouter.get("/:cardId/purchases", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	if (
		!validateStrictQueryParams(c, [
			"limit",
			"status",
			"purchaseDateFrom",
			"fromDate",
			"purchaseDateUntil",
			"toDate",
			"after",
			"budgetCategory",
			"purchaseCategory",
			"category",
		])
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	if (
		c.req.query("purchaseDateFrom") !== undefined &&
		c.req.query("fromDate") !== undefined
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (
		c.req.query("purchaseDateUntil") !== undefined &&
		c.req.query("toDate") !== undefined
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const categoryKeysPresent = [
		c.req.query("budgetCategory"),
		c.req.query("purchaseCategory"),
		c.req.query("category"),
	].filter((v) => v !== undefined);

	if (categoryKeysPresent.length > 1) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const rawCategory =
		c.req.query("purchaseCategory") ??
		c.req.query("budgetCategory") ??
		c.req.query("category");
	let categoryFilter:
		| "MANDATORY_EXPENSE"
		| "DISCRETIONARY_SPEND"
		| "SHORT_TERM_PURCHASE"
		| "UNCLASSIFIED"
		| undefined;
	if (rawCategory !== undefined) {
		const norm = normalizePurchaseCategoryForDomain(rawCategory);
		if (!norm) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		categoryFilter = norm;
	}

	const limitRes = parseBoundedLimit(c.req.query("limit"), {
		defaultLimit: 50,
		maxLimit: 100,
	});
	if (!limitRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const statusQuery = c.req.query("status");
	let statusFilter: "POSTED" | "VOID" | undefined;
	if (statusQuery !== undefined) {
		if (statusQuery !== "POSTED" && statusQuery !== "VOID") {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		statusFilter = statusQuery;
	}

	const fromDate = c.req.query("purchaseDateFrom") ?? c.req.query("fromDate");
	const toDate = c.req.query("purchaseDateUntil") ?? c.req.query("toDate");
	if (fromDate) {
		try {
			validateGregorianDateString(fromDate, "fromDate");
		} catch {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (toDate) {
		try {
			validateGregorianDateString(toDate, "toDate");
		} catch {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const afterQuery = c.req.query("after");
	let afterCursor: PurchaseCursor | undefined;
	if (afterQuery !== undefined) {
		try {
			afterCursor = decodePurchaseCursor(afterQuery);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const card = await getCreditCard({ db, userId: auth.userId, cardId });
		if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);

		const rows = await listCreditCardPurchases({
			db,
			userId: auth.userId,
			cardId,
			eventType: "PURCHASE",
			...(categoryFilter ? { budgetCategory: categoryFilter } : {}),
			...(statusFilter ? { status: statusFilter } : {}),
			...(fromDate ? { purchaseDateFrom: fromDate } : {}),
			...(toDate ? { purchaseDateUntil: toDate } : {}),
			limit: limitRes.limit + 1,
			afterCursor,
		});

		const hasMore = rows.length > limitRes.limit;
		const purchases = hasMore ? rows.slice(0, limitRes.limit) : rows;
		const lastPurchase =
			purchases.length > 0 ? purchases[purchases.length - 1] : null;
		const nextCursor =
			hasMore && lastPurchase?.purchaseDate
				? encodePurchaseCursor({
						purchaseDate: lastPurchase.purchaseDate,
						occurredAt: lastPurchase.occurredAt.toISOString(),
						eventId: lastPurchase.eventId,
					})
				: null;

		return c.json({
			purchases,
			limit: limitRes.limit,
			hasMore,
			nextCursor,
		});
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * GET /credit-cards/:cardId/purchases/:id
 * Fetches a single purchase for a credit card.
 */
creditCardRouter.get("/:cardId/purchases/:id", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});

		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		)
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		return c.json({ purchase });
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

function normalizePurchaseCategoryForDomain(
	raw: unknown,
):
	| "MANDATORY_EXPENSE"
	| "DISCRETIONARY_SPEND"
	| "SHORT_TERM_PURCHASE"
	| "UNCLASSIFIED"
	| null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim().toUpperCase();
	if (trimmed === "MANDATORY" || trimmed === "MANDATORY_EXPENSE")
		return "MANDATORY_EXPENSE";
	if (
		trimmed === "DISCRETIONARY" ||
		trimmed === "DISCRETIONARY_SPEND" ||
		trimmed === "DISCRETIONARY_EXPENSE"
	)
		return "DISCRETIONARY_SPEND";
	if (trimmed === "SHORT_TERM_PURCHASE") return "SHORT_TERM_PURCHASE";
	if (trimmed === "UNCLASSIFIED") return "UNCLASSIFIED";
	return null;
}

/**
 * POST /credit-cards/:cardId/purchases
 * Records a new unshared purchase on a credit card.
 */
creditCardRouter.post("/:cardId/purchases", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"amount",
		"purchaseCategory",
		"shortTermGoalId",
		"merchant",
		"description",
		"installmentCount",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		amount,
		purchaseCategory,
		shortTermGoalId,
		merchant,
		description,
		installmentCount,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;

	if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	const normCat = normalizePurchaseCategoryForDomain(purchaseCategory);
	if (!normCat) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (shortTermGoalId !== undefined && shortTermGoalId !== null) {
		if (typeof shortTermGoalId !== "string" || !isUuid(shortTermGoalId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (merchant !== undefined && merchant !== null) {
		if (typeof merchant !== "string" || merchant.length > 200) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (installmentCount !== undefined && installmentCount !== null) {
		if (
			typeof installmentCount !== "number" ||
			!Number.isInteger(installmentCount) ||
			installmentCount < 1 ||
			installmentCount > 60
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const result = await recordCreditCardPurchase({
			db,
			userId: auth.userId,
			cardId,
			amount,
			purchaseCategory: normCat,
			shortTermGoalId: shortTermGoalId ?? null,
			merchant: merchant ? merchant.trim() : null,
			description: description ? description.trim() : null,
			installmentCount: installmentCount ?? null,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

function toCreditCardPurchaseSplitProductDto(
	split: CreditCardPurchaseSplitReadModel,
) {
	return {
		splitId: split.splitId,
		purchaseEventId: split.purchaseEventId,
		status: split.status,
		revisionNo: split.revisionNo,
		method: split.method,
		grossAmount: split.grossAmount,
		userShareAmount: split.userShareAmount,
		externalShareAmount: split.externalShareAmount,
		userWeight: split.userWeight,
		occurredAt: split.occurredAt.toISOString(),
		participants: split.participants.map((p) => ({
			personId: p.personId,
			displayName: p.displayName,
			relationship: p.relationship,
			shareAmount: p.shareAmount,
			settledAmount: p.settledAmount,
			remainingAmount: p.remainingAmount,
			weight: p.weight,
			dueDate: p.dueDate,
			description: p.description,
			obligationId: p.personObligationId,
		})),
	};
}

function parseSplitParticipantsInput(
	raw: unknown,
): ParticipantAllocationInput[] | null {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 9) return null;
	const participants: ParticipantAllocationInput[] = [];
	const allowedParticipantKeys = [
		"personId",
		"shareAmount",
		"weight",
		"dueDate",
		"description",
	];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) return null;
		if (!hasOnlyKeys(item, allowedParticipantKeys)) return null;
		if (typeof item.personId !== "string" || !isUuid(item.personId)) {
			return null;
		}
		if (item.shareAmount !== undefined && item.shareAmount !== null) {
			if (
				typeof item.shareAmount !== "string" ||
				!/^\d+\.\d{2}$/.test(item.shareAmount)
			) {
				return null;
			}
		}
		if (item.weight !== undefined && item.weight !== null) {
			if (
				typeof item.weight !== "number" ||
				!Number.isSafeInteger(item.weight) ||
				item.weight <= 0
			) {
				return null;
			}
		}
		if (item.dueDate !== undefined && item.dueDate !== null) {
			if (
				typeof item.dueDate !== "string" ||
				!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(item.dueDate)
			) {
				return null;
			}
		}
		if (item.description !== undefined && item.description !== null) {
			if (
				typeof item.description !== "string" ||
				item.description.length > 500
			) {
				return null;
			}
		}
		participants.push({
			personId: item.personId,
			shareAmount: item.shareAmount ?? undefined,
			weight: item.weight ?? undefined,
			dueDate: item.dueDate ?? undefined,
			description: item.description ? item.description.trim() : undefined,
		});
	}
	return participants;
}

/**
 * POST /credit-cards/:cardId/purchases/shared
 * Records a new shared purchase and its split in one atomic transaction.
 */
creditCardRouter.post("/:cardId/purchases/shared", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"amount",
		"purchaseCategory",
		"shortTermGoalId",
		"merchant",
		"description",
		"installmentCount",
		"occurredAt",
		"splitMethod",
		"userWeight",
		"participants",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		amount,
		purchaseCategory,
		shortTermGoalId,
		merchant,
		description,
		installmentCount,
		occurredAt: rawOccurredAt,
		splitMethod,
		userWeight,
		participants: rawParticipants,
	} = bodyRes.value;

	if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	const normCat = normalizePurchaseCategoryForDomain(purchaseCategory);
	if (!normCat) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (shortTermGoalId !== undefined && shortTermGoalId !== null) {
		if (typeof shortTermGoalId !== "string" || !isUuid(shortTermGoalId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (merchant !== undefined && merchant !== null) {
		if (typeof merchant !== "string" || merchant.length > 200) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (installmentCount !== undefined && installmentCount !== null) {
		if (
			typeof installmentCount !== "number" ||
			!Number.isInteger(installmentCount) ||
			installmentCount < 1 ||
			installmentCount > 60
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (
		typeof splitMethod !== "string" ||
		(splitMethod !== "EQUAL" &&
			splitMethod !== "MANUAL" &&
			splitMethod !== "RATIO")
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (userWeight !== undefined && userWeight !== null) {
		if (
			typeof userWeight !== "number" ||
			!Number.isSafeInteger(userWeight) ||
			userWeight < 0
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const participants = parseSplitParticipantsInput(rawParticipants);
	if (!participants) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchaseKey = await deriveCreditCardSharedChildKey(
			keyRes.key,
			"PURCHASE",
		);
		const splitKey = await deriveCreditCardSharedChildKey(keyRes.key, "SPLIT");

		const result = await recordSharedCreditCardPurchase({
			db,
			userId: auth.userId,
			cardId,
			amount,
			purchaseCategory: normCat,
			shortTermGoalId: shortTermGoalId ?? null,
			merchant: merchant ? merchant.trim() : null,
			description: description ? description.trim() : null,
			installmentCount: installmentCount ?? null,
			occurredAt,
			purchaseIdempotencyKey: purchaseKey,
			splitMethod: splitMethod as SplitMethod,
			userWeight: userWeight ?? undefined,
			participants,
			splitIdempotencyKey: splitKey,
		});

		return c.json(
			{
				purchase: result.purchase,
				split: toCreditCardPurchaseSplitProductDto(result.split),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * Helper to update a credit card purchase.
 */
async function handleUpdatePurchase(c: Context<CreditCardEnv>) {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"expectedRevisionNo",
		"amount",
		"purchaseCategory",
		"shortTermGoalId",
		"merchant",
		"description",
		"installmentCount",
		"reasonNote",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		expectedRevisionNo,
		amount,
		purchaseCategory,
		shortTermGoalId,
		merchant,
		description,
		installmentCount,
		reasonNote,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	const normCat = normalizePurchaseCategoryForDomain(purchaseCategory);
	if (!normCat) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (shortTermGoalId !== undefined && shortTermGoalId !== null) {
		if (typeof shortTermGoalId !== "string" || !isUuid(shortTermGoalId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (merchant !== undefined && merchant !== null) {
		if (typeof merchant !== "string" || merchant.length > 200) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (installmentCount !== undefined && installmentCount !== null) {
		if (
			typeof installmentCount !== "number" ||
			!Number.isInteger(installmentCount) ||
			installmentCount < 1 ||
			installmentCount > 60
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (reasonNote !== undefined && reasonNote !== null) {
		if (typeof reasonNote !== "string" || reasonNote.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const existing = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!existing ||
			existing.cardId !== cardId ||
			existing.eventType !== "PURCHASE"
		)
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);

		const result = await updateCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
			expectedRevisionNo,
			amount,
			purchaseCategory: normCat,
			shortTermGoalId: shortTermGoalId ?? null,
			merchant: merchant ? merchant.trim() : null,
			description: description ? description.trim() : null,
			installmentCount: installmentCount ?? null,
			reasonNote: reasonNote ? reasonNote.trim() : null,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
}

/**
 * POST /credit-cards/:cardId/purchases/:id
 * and POST /credit-cards/:cardId/purchases/:id/revisions
 * Updates an unshared purchase.
 */
creditCardRouter.post("/:cardId/purchases/:id", handleUpdatePurchase);
creditCardRouter.post("/:cardId/purchases/:id/revisions", handleUpdatePurchase);

/**
 * POST /credit-cards/:cardId/purchases/:id/void
 * Voids an unshared purchase.
 */
creditCardRouter.post("/:cardId/purchases/:id/void", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = ["expectedRevisionNo", "reasonNote", "occurredAt"];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		expectedRevisionNo,
		reasonNote,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (reasonNote !== undefined && reasonNote !== null) {
		if (typeof reasonNote !== "string" || reasonNote.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const existing = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!existing ||
			existing.cardId !== cardId ||
			existing.eventType !== "PURCHASE"
		)
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);

		const result = await voidCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
			expectedRevisionNo,
			reasonNote: reasonNote ? reasonNote.trim() : null,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

// ============================================================================
// 6. CREDIT CARD OPENING BALANCE SURFACE
// ============================================================================

/**
 * GET /credit-cards/:cardId/opening-balance
 * Fetches the opening balance liability event for a credit card.
 */
creditCardRouter.get("/:cardId/opening-balance", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const card = await getCreditCard({ db, userId: auth.userId, cardId });
		if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);

		const openingBalance = await getCreditCardOpeningBalance({
			db,
			userId: auth.userId,
			cardId,
		});

		return c.json({ openingBalance }, 200);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards/:cardId/opening-balance
 * Records the initial opening balance for a credit card.
 */
creditCardRouter.post(
	"/:cardId/opening-balance",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		if (!isUuid(cardId)) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = ["amount", "description", "occurredAt"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const { amount, description, occurredAt: rawOccurredAt } = bodyRes.value;

		if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (description !== undefined && description !== null) {
			if (typeof description !== "string" || description.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const card = await getCreditCard({ db, userId: auth.userId, cardId });
			if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);

			const result = await recordCreditCardOpeningBalance({
				db,
				userId: auth.userId,
				cardId,
				amount,
				description: description ? description.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 201);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

/**
 * Handler for updating an existing credit card opening balance.
 */
async function handleUpdateOpeningBalance(c: Context<CreditCardEnv>) {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"expectedRevisionNo",
		"amount",
		"description",
		"reasonNote",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		expectedRevisionNo,
		amount,
		description,
		reasonNote,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (reasonNote !== undefined && reasonNote !== null) {
		if (typeof reasonNote !== "string" || reasonNote.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const existing = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!existing ||
			existing.cardId !== cardId ||
			existing.eventType !== "OPENING_BALANCE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const result = await updateCreditCardOpeningBalance({
			db,
			userId: auth.userId,
			eventId,
			expectedRevisionNo,
			amount,
			description: description ? description.trim() : null,
			reasonNote: reasonNote ? reasonNote.trim() : null,
			occurredAt,
			idempotencyKey: keyRes.key,
		});

		return c.json(result, 200);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
}

creditCardRouter.post(
	"/:cardId/opening-balance/:id",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	handleUpdateOpeningBalance,
);
creditCardRouter.post(
	"/:cardId/opening-balance/:id/revisions",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	handleUpdateOpeningBalance,
);

/**
 * POST /credit-cards/:cardId/opening-balance/:id/void
 * Voids an existing credit card opening balance.
 */
creditCardRouter.post(
	"/:cardId/opening-balance/:id/void",
	bodyLimit({ maxSize: BODY_LIMIT_BYTES }),
	async (c) => {
		const auth = c.get("auth");
		const cardId = c.req.param("cardId");
		const eventId = c.req.param("id");
		if (!isUuid(cardId) || !isUuid(eventId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const keyRes = readIdempotencyKey(c);
		if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const bodyRes = await readJsonObject(c);
		if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const allowedKeys = ["expectedRevisionNo", "reasonNote", "occurredAt"];
		if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}

		const {
			expectedRevisionNo,
			reasonNote,
			occurredAt: rawOccurredAt,
		} = bodyRes.value;

		if (
			typeof expectedRevisionNo !== "number" ||
			!Number.isInteger(expectedRevisionNo) ||
			expectedRevisionNo < 1
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (reasonNote !== undefined && reasonNote !== null) {
			if (typeof reasonNote !== "string" || reasonNote.length > 500) {
				return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
			}
		}

		const occurredAt = parseCanonicalInstant(rawOccurredAt);
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

		const db = createDatabase(getDatabaseUrl(c.env));
		try {
			const existing = await getCreditCardPurchase({
				db,
				userId: auth.userId,
				eventId,
			});
			if (
				!existing ||
				existing.cardId !== cardId ||
				existing.eventType !== "OPENING_BALANCE"
			) {
				return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
			}

			const result = await voidCreditCardOpeningBalance({
				db,
				userId: auth.userId,
				eventId,
				expectedRevisionNo,
				reasonNote: reasonNote ? reasonNote.trim() : null,
				occurredAt,
				idempotencyKey: keyRes.key,
			});

			return c.json(result, 200);
		} catch (err) {
			return mapCreditCardDomainError(c, err);
		}
	},
);

// ============================================================================
// 7. CREDIT CARD SHARED PURCHASES & SPLITS SURFACE
// ============================================================================

export interface CreditCardPurchaseSplitParticipantProductDto {
	personId: string;
	displayName: string;
	relationship: string;
	shareAmount: string;
	settledAmount: string;
	remainingAmount: string;
	weight: number | null;
	dueDate: string | null;
	description: string | null;
	obligationId: string;
}

export interface CreditCardPurchaseSplitProductDto {
	splitId: string;
	purchaseEventId: string;
	status: "ACTIVE" | "VOID";
	revisionNo: number;
	method: SplitMethod;
	grossAmount: string;
	userShareAmount: string;
	externalShareAmount: string;
	userWeight: number | null;
	occurredAt: string;
	participants: CreditCardPurchaseSplitParticipantProductDto[];
}

/**
 * GET /credit-cards/:cardId/purchases/:id/split
 * Fetches the active split product DTO for a credit card purchase.
 */
creditCardRouter.get("/:cardId/purchases/:id/split", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const split = await getCreditCardPurchaseSplit({
			db,
			userId: auth.userId,
			purchaseEventId: eventId,
		});
		if (!split) {
			return fail(c, "CREDIT_CARD_SPLIT_NOT_FOUND", 404);
		}

		return c.json(
			{
				split: toCreditCardPurchaseSplitProductDto(split),
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards/:cardId/purchases/:id/split
 * Attaches a new split to an existing unshared credit card purchase.
 */
creditCardRouter.post("/:cardId/purchases/:id/split", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"method",
		"splitMethod",
		"userWeight",
		"participants",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		userWeight,
		participants: rawParticipants,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;
	const method = bodyRes.value.splitMethod ?? bodyRes.value.method;

	if (
		typeof method !== "string" ||
		(method !== "EQUAL" && method !== "MANUAL" && method !== "RATIO")
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (userWeight !== undefined && userWeight !== null) {
		if (
			typeof userWeight !== "number" ||
			!Number.isSafeInteger(userWeight) ||
			userWeight < 0
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const participants = parseSplitParticipantsInput(rawParticipants);
	if (!participants) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	let occurredAt: Date | undefined;
	if (rawOccurredAt !== undefined) {
		occurredAt = parseCanonicalInstant(rawOccurredAt) ?? undefined;
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const result = await createCreditCardPurchaseSplit({
			db,
			userId: auth.userId,
			purchaseEventId: eventId,
			method: method as SplitMethod,
			userWeight: userWeight ?? undefined,
			participants,
			idempotencyKey: keyRes.key,
			occurredAt,
		});

		return c.json(
			{
				split: toCreditCardPurchaseSplitProductDto(result.split),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * Helper to update a credit card purchase split.
 */
async function handleUpdateSplit(c: Context<CreditCardEnv>) {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"expectedRevisionNo",
		"method",
		"splitMethod",
		"userWeight",
		"participants",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		expectedRevisionNo,
		userWeight,
		participants: rawParticipants,
		occurredAt: rawOccurredAt,
	} = bodyRes.value;
	const method = bodyRes.value.splitMethod ?? bodyRes.value.method;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (
		typeof method !== "string" ||
		(method !== "EQUAL" && method !== "MANUAL" && method !== "RATIO")
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (userWeight !== undefined && userWeight !== null) {
		if (
			typeof userWeight !== "number" ||
			!Number.isSafeInteger(userWeight) ||
			userWeight < 0
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const participants = parseSplitParticipantsInput(rawParticipants);
	if (!participants) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	let occurredAt: Date | undefined;
	if (rawOccurredAt !== undefined) {
		occurredAt = parseCanonicalInstant(rawOccurredAt) ?? undefined;
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const split = await getCreditCardPurchaseSplit({
			db,
			userId: auth.userId,
			purchaseEventId: eventId,
		});
		if (!split) {
			return fail(c, "CREDIT_CARD_SPLIT_NOT_FOUND", 404);
		}

		const result = await updateCreditCardPurchaseSplit({
			db,
			userId: auth.userId,
			splitId: split.splitId,
			expectedRevisionNo,
			method: method as SplitMethod,
			userWeight: userWeight ?? undefined,
			participants,
			idempotencyKey: keyRes.key,
			occurredAt,
		});

		return c.json(
			{
				split: toCreditCardPurchaseSplitProductDto(result.split),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
}

creditCardRouter.post(
	"/:cardId/purchases/:id/split/revisions",
	handleUpdateSplit,
);

/**
 * POST /credit-cards/:cardId/purchases/:id/split/void
 * Voids an existing credit card purchase split.
 */
creditCardRouter.post("/:cardId/purchases/:id/split/void", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = ["expectedRevisionNo", "occurredAt"];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const { expectedRevisionNo, occurredAt: rawOccurredAt } = bodyRes.value;

	if (
		typeof expectedRevisionNo !== "number" ||
		!Number.isInteger(expectedRevisionNo) ||
		expectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	let occurredAt: Date | undefined;
	if (rawOccurredAt !== undefined) {
		occurredAt = parseCanonicalInstant(rawOccurredAt) ?? undefined;
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const split = await getCreditCardPurchaseSplit({
			db,
			userId: auth.userId,
			purchaseEventId: eventId,
		});
		if (!split) {
			return fail(c, "CREDIT_CARD_SPLIT_NOT_FOUND", 404);
		}

		const result = await voidCreditCardPurchaseSplit({
			db,
			userId: auth.userId,
			splitId: split.splitId,
			expectedRevisionNo,
			idempotencyKey: keyRes.key,
			occurredAt,
		});

		return c.json(
			{
				split: toCreditCardPurchaseSplitProductDto(result.split),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards/:cardId/purchases/:id/shared-revisions
 * Coordinated revision of both purchase details and split allocation in one atomic transaction.
 */
creditCardRouter.post("/:cardId/purchases/:id/shared-revisions", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"purchaseExpectedRevisionNo",
		"expectedPurchaseRevisionNo",
		"amount",
		"purchaseCategory",
		"shortTermGoalId",
		"merchant",
		"description",
		"installmentCount",
		"reasonNote",
		"occurredAt",
		"splitExpectedRevisionNo",
		"expectedSplitRevisionNo",
		"splitMethod",
		"method",
		"userWeight",
		"participants",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const {
		amount,
		purchaseCategory,
		shortTermGoalId,
		merchant,
		description,
		installmentCount,
		reasonNote,
		occurredAt: rawOccurredAt,
		userWeight,
		participants: rawParticipants,
	} = bodyRes.value;
	const purchaseExpectedRevisionNo =
		bodyRes.value.expectedPurchaseRevisionNo ??
		bodyRes.value.purchaseExpectedRevisionNo;
	const splitExpectedRevisionNo =
		bodyRes.value.expectedSplitRevisionNo ??
		bodyRes.value.splitExpectedRevisionNo;
	const splitMethod = bodyRes.value.splitMethod ?? bodyRes.value.method;

	if (
		typeof purchaseExpectedRevisionNo !== "number" ||
		!Number.isInteger(purchaseExpectedRevisionNo) ||
		purchaseExpectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (
		typeof splitExpectedRevisionNo !== "number" ||
		!Number.isInteger(splitExpectedRevisionNo) ||
		splitExpectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (typeof amount !== "string" || !/^\d+\.\d{2}$/.test(amount)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	const normCat = normalizePurchaseCategoryForDomain(purchaseCategory);
	if (!normCat) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (shortTermGoalId !== undefined && shortTermGoalId !== null) {
		if (typeof shortTermGoalId !== "string" || !isUuid(shortTermGoalId)) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (merchant !== undefined && merchant !== null) {
		if (typeof merchant !== "string" || merchant.length > 200) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (description !== undefined && description !== null) {
		if (typeof description !== "string" || description.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (installmentCount !== undefined && installmentCount !== null) {
		if (
			typeof installmentCount !== "number" ||
			!Number.isInteger(installmentCount) ||
			installmentCount < 1 ||
			installmentCount > 60
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (reasonNote !== undefined && reasonNote !== null) {
		if (typeof reasonNote !== "string" || reasonNote.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}
	if (
		typeof splitMethod !== "string" ||
		(splitMethod !== "EQUAL" &&
			splitMethod !== "MANUAL" &&
			splitMethod !== "RATIO")
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (userWeight !== undefined && userWeight !== null) {
		if (
			typeof userWeight !== "number" ||
			!Number.isSafeInteger(userWeight) ||
			userWeight < 0
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	const participants = parseSplitParticipantsInput(rawParticipants);
	if (!participants) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const occurredAt = parseCanonicalInstant(rawOccurredAt);
	if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const purchaseKey = await deriveCreditCardSharedChildKey(
			keyRes.key,
			"PURCHASE",
		);
		const splitKey = await deriveCreditCardSharedChildKey(keyRes.key, "SPLIT");

		const result = await updateCreditCardPurchaseWithSplit({
			db,
			userId: auth.userId,
			purchaseEventId: eventId,
			purchaseExpectedRevisionNo,
			amount,
			purchaseCategory: normCat,
			shortTermGoalId: shortTermGoalId ?? null,
			merchant: merchant ? merchant.trim() : null,
			description: description ? description.trim() : null,
			installmentCount: installmentCount ?? null,
			reasonNote: reasonNote ? reasonNote.trim() : null,
			occurredAt,
			purchaseIdempotencyKey: purchaseKey,
			splitExpectedRevisionNo,
			splitMethod: splitMethod as SplitMethod,
			userWeight: userWeight ?? undefined,
			participants,
			splitIdempotencyKey: splitKey,
		});

		return c.json(
			{
				purchase: result.purchase,
				split: toCreditCardPurchaseSplitProductDto(result.split),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

/**
 * POST /credit-cards/:cardId/purchases/:id/shared-void
 * Coordinated void of both purchase and its split in one atomic transaction.
 */
creditCardRouter.post("/:cardId/purchases/:id/shared-void", async (c) => {
	const auth = c.get("auth");
	const cardId = c.req.param("cardId");
	const eventId = c.req.param("id");
	if (!isUuid(cardId) || !isUuid(eventId)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const keyRes = readIdempotencyKey(c);
	if (!keyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const bodyRes = await readJsonObject(c);
	if (!bodyRes.ok) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);

	const allowedKeys = [
		"purchaseExpectedRevisionNo",
		"expectedPurchaseRevisionNo",
		"splitExpectedRevisionNo",
		"expectedSplitRevisionNo",
		"reasonNote",
		"occurredAt",
	];
	if (!hasOnlyKeys(bodyRes.value, allowedKeys)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const { reasonNote, occurredAt: rawOccurredAt } = bodyRes.value;
	const purchaseExpectedRevisionNo =
		bodyRes.value.expectedPurchaseRevisionNo ??
		bodyRes.value.purchaseExpectedRevisionNo;
	const splitExpectedRevisionNo =
		bodyRes.value.expectedSplitRevisionNo ??
		bodyRes.value.splitExpectedRevisionNo;

	if (
		typeof purchaseExpectedRevisionNo !== "number" ||
		!Number.isInteger(purchaseExpectedRevisionNo) ||
		purchaseExpectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (
		typeof splitExpectedRevisionNo !== "number" ||
		!Number.isInteger(splitExpectedRevisionNo) ||
		splitExpectedRevisionNo < 1
	) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (reasonNote !== undefined && reasonNote !== null) {
		if (typeof reasonNote !== "string" || reasonNote.length > 500) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
	}

	let occurredAt: Date | undefined;
	if (rawOccurredAt !== undefined) {
		occurredAt = parseCanonicalInstant(rawOccurredAt) ?? undefined;
		if (!occurredAt) return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const purchase = await getCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
		});
		if (
			!purchase ||
			purchase.cardId !== cardId ||
			purchase.eventType !== "PURCHASE"
		) {
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		}

		const purchaseKey = await deriveCreditCardSharedChildKey(
			keyRes.key,
			"PURCHASE",
		);
		const splitKey = await deriveCreditCardSharedChildKey(keyRes.key, "SPLIT");

		const result = await voidCreditCardPurchaseWithSplit({
			db,
			userId: auth.userId,
			purchaseEventId: eventId,
			purchaseExpectedRevisionNo,
			splitExpectedRevisionNo,
			purchaseIdempotencyKey: purchaseKey,
			splitIdempotencyKey: splitKey,
			reasonNote: reasonNote ? reasonNote.trim() : null,
			occurredAt,
		});

		return c.json(
			{
				purchase: result.purchase,
				split: toCreditCardPurchaseSplitProductDto(result.split),
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});
