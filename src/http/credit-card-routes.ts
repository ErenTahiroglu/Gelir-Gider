import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { CreditCardError } from "../credit-cards/errors";
import {
	payCreditCardStatement,
	reconcileCreditCardStatement,
	reopenCreditCardStatementPayment,
} from "../credit-cards/payments";
import {
	getCreditCardPurchase,
	listCreditCardPurchases,
	recordCreditCardPurchase,
	updateCreditCardPurchase,
	voidCreditCardPurchase,
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
	getStatementReconciliation,
	getStatementReconciliationAsOf,
	reconcileStatement,
	voidStatementReconciliation,
} from "../credit-cards/statement-reconciliation";
import { createDatabase } from "../db/client";
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

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const allCards = await listCreditCards({
			db,
			userId: auth.userId,
			...(statusFilter ? { status: statusFilter } : {}),
		});

		// Bounded pagination
		const after = c.req.query("after");
		let startIndex = 0;
		if (after) {
			const idx = allCards.findIndex((card) => card.cardId === after);
			if (idx >= 0) {
				startIndex = idx + 1;
			}
		}

		const paginated = allCards.slice(startIndex, startIndex + limitRes.limit);
		const hasMore = startIndex + limitRes.limit < allCards.length;

		return c.json({
			cards: paginated,
			limit: limitRes.limit,
			hasMore,
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
			displayName.length > 100
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof issuer !== "string" ||
			issuer.trim().length === 0 ||
			issuer.length > 100
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
			displayName.length > 100
		) {
			return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
		}
		if (
			typeof issuer !== "string" ||
			issuer.trim().length === 0 ||
			issuer.length > 100
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

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		// Confirm card ownership
		const card = await getCreditCard({ db, userId: auth.userId, cardId });
		if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);

		const allStatements = await listCreditCardStatements({
			db,
			userId: auth.userId,
			creditCardId: cardId,
			...(statusFilter ? { status: statusFilter } : {}),
			...(cycleMonthFrom ? { cycleMonthFrom } : {}),
			...(cycleMonthUntil ? { cycleMonthUntil } : {}),
		});

		const after = c.req.query("after");
		let startIndex = 0;
		if (after) {
			const idx = allStatements.findIndex((s) => s.statementId === after);
			if (idx >= 0) {
				startIndex = idx + 1;
			}
		}

		const paginated = allStatements.slice(
			startIndex,
			startIndex + limitRes.limit,
		);
		const hasMore = startIndex + limitRes.limit < allStatements.length;

		return c.json({
			statements: paginated,
			limit: limitRes.limit,
			hasMore,
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
	if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}
	if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
		return fail(c, "CREDIT_CARD_INVALID_INPUT", 400);
	}

	const db = createDatabase(getDatabaseUrl(c.env));
	try {
		const card = await getCreditCard({ db, userId: auth.userId, cardId });
		if (!card) return fail(c, "CREDIT_CARD_NOT_FOUND", 404);

		const allPurchases = await listCreditCardPurchases({
			db,
			userId: auth.userId,
			cardId,
			...(statusFilter ? { status: statusFilter } : {}),
			...(fromDate ? { purchaseDateFrom: fromDate } : {}),
			...(toDate ? { purchaseDateUntil: toDate } : {}),
		});

		const after = c.req.query("after");
		let startIndex = 0;
		if (after) {
			const idx = allPurchases.findIndex((p) => p.eventId === after);
			if (idx >= 0) {
				startIndex = idx + 1;
			}
		}

		const paginated = allPurchases.slice(
			startIndex,
			startIndex + limitRes.limit,
		);
		const hasMore = startIndex + limitRes.limit < allPurchases.length;

		return c.json({
			purchases: paginated,
			limit: limitRes.limit,
			hasMore,
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

		if (!purchase || purchase.cardId !== cardId)
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);
		return c.json({ purchase });
	} catch (err) {
		return mapCreditCardDomainError(c, err);
	}
});

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
	if (
		purchaseCategory !== "MANDATORY_EXPENSE" &&
		purchaseCategory !== "DISCRETIONARY_EXPENSE" &&
		purchaseCategory !== "SAVING_INVESTMENT" &&
		purchaseCategory !== "DEBT_REPAYMENT"
	) {
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
			installmentCount > 36
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
			purchaseCategory,
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
	if (
		purchaseCategory !== "MANDATORY_EXPENSE" &&
		purchaseCategory !== "DISCRETIONARY_EXPENSE" &&
		purchaseCategory !== "SAVING_INVESTMENT" &&
		purchaseCategory !== "DEBT_REPAYMENT"
	) {
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
			installmentCount > 36
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
		if (!existing || existing.cardId !== cardId)
			return fail(c, "CREDIT_CARD_PURCHASE_NOT_FOUND", 404);

		const result = await updateCreditCardPurchase({
			db,
			userId: auth.userId,
			eventId,
			expectedRevisionNo,
			amount,
			purchaseCategory,
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
		if (!existing || existing.cardId !== cardId)
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
