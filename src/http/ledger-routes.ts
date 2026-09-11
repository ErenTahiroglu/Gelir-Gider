import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, getDatabaseUrl } from "../config/env";
import { createDatabase } from "../db/client";
import {
	getLedgerAccountBalance,
	listLedgerAccountBalances,
} from "../ledger/balances";
import { LedgerError } from "../ledger/errors";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import { errorEnvelope, isUuid, parseCanonicalInstant } from "./transport";

type LedgerEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const ledgerRouter = new Hono<LedgerEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB

function fail(c: Context<LedgerEnv>, code: string, status: number) {
	return c.json(errorEnvelope(code), status as 400);
}

function mapDomainError(c: Context<LedgerEnv>, err: unknown) {
	if (err instanceof LedgerError) {
		switch (err.code) {
			case "INVALID_MONEY":
			case "LEDGER_INVALID_ENTRY":
				return fail(c, "LEDGER_INVALID_INPUT", 400);
			case "LEDGER_ACCOUNT_NOT_FOUND":
				return fail(c, "LEDGER_ACCOUNT_NOT_FOUND", 404);
			case "LEDGER_ACCOUNT_ARCHIVED":
				return fail(c, "LEDGER_ACCOUNT_ARCHIVED", 409);
			case "LEDGER_CURRENCY_MISMATCH":
				return fail(c, "LEDGER_CURRENCY_MISMATCH", 400);
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

// Middleware setup -- Read-only router behind authenticated session
ledgerRouter.use("*", requireAuthenticatedSession);
ledgerRouter.use("*", bodyLimit({ maxSize: BODY_LIMIT_BYTES }));

// 1. GET /ledger/accounts -- List ledger account balances
ledgerRouter.get("/accounts", async (c) => {
	const rawIncludeArchived = c.req.query("includeArchived");
	let includeArchived = false;
	if (rawIncludeArchived !== undefined) {
		const trimmed = rawIncludeArchived.trim().toLowerCase();
		if (trimmed === "true") {
			includeArchived = true;
		} else if (trimmed === "false") {
			includeArchived = false;
		} else {
			return fail(c, "LEDGER_INVALID_INPUT", 400);
		}
	}

	const rawAsOf = c.req.query("asOf");
	let asOf: Date | undefined;
	if (rawAsOf !== undefined) {
		const parsed = parseCanonicalInstant(rawAsOf);
		if (!parsed) return fail(c, "LEDGER_INVALID_INPUT", 400);
		asOf = parsed;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const accounts = await listLedgerAccountBalances({
			db,
			userId,
			...(asOf !== undefined ? { asOf } : {}),
			includeArchived,
		});

		return c.json({ accounts }, 200);
	} catch (err) {
		return mapDomainError(c, err);
	}
});

// 2. GET /ledger/accounts/:accountId/balance -- Single ledger account balance
ledgerRouter.get("/accounts/:accountId/balance", async (c) => {
	const accountId = c.req.param("accountId");
	if (!isUuid(accountId)) return fail(c, "LEDGER_INVALID_INPUT", 400);

	const rawAsOf = c.req.query("asOf");
	let asOf: Date | undefined;
	if (rawAsOf !== undefined) {
		const parsed = parseCanonicalInstant(rawAsOf);
		if (!parsed) return fail(c, "LEDGER_INVALID_INPUT", 400);
		asOf = parsed;
	}

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const res = await getLedgerAccountBalance({
			db,
			userId,
			accountId,
			...(asOf !== undefined ? { asOf } : {}),
		});

		return c.json(
			{
				accountId: res.accountId,
				currency: res.currency,
				normalBalance: res.normalBalance,
				balance: res.balance,
				asOf: res.asOf,
			},
			200,
		);
	} catch (err) {
		return mapDomainError(c, err);
	}
});
