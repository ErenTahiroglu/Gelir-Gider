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
import { createProductLedgerAccount } from "../ledger/product-accounts";
import type { AuthVariables } from "./auth-middleware";
import { requireAuthenticatedSession } from "./auth-middleware";
import type { RequestIdVariables } from "./security-middleware";
import {
	errorEnvelope,
	hasOnlyKeys,
	isUuid,
	parseCanonicalInstant,
	readJsonObject,
	sameOriginMutationGuard,
} from "./transport";

type LedgerEnv = {
	Bindings: AppEnv;
	Variables: AuthVariables & RequestIdVariables;
};

export const ledgerRouter = new Hono<LedgerEnv>();

const BODY_LIMIT_BYTES = 64 * 1024; // 64 KiB
const PRODUCT_ALIAS_REGEX = /^[A-Z0-9_]{1,60}$/;

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
			case "LEDGER_ACCOUNT_CODE_CONFLICT":
				return fail(c, "LEDGER_ACCOUNT_CODE_CONFLICT", 409);
			case "LEDGER_CURRENCY_MISMATCH":
				return fail(c, "LEDGER_CURRENCY_MISMATCH", 400);
			case "LEDGER_ENTRY_NOT_FOUND":
				return fail(c, "LEDGER_ENTRY_NOT_FOUND", 404);
			default:
				return fail(c, "INTERNAL_ERROR", 500);
		}
	}

	return fail(c, "INTERNAL_ERROR", 500);
}

// Middleware setup -- Authenticated session and same-origin mutation guard
ledgerRouter.use("*", sameOriginMutationGuard());
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

// 3. POST /ledger/accounts -- Safe product ledger account provisioning
ledgerRouter.post("/accounts", async (c) => {
	const parsed = await readJsonObject(c);
	if (!parsed.ok) return fail(c, "LEDGER_INVALID_INPUT", 400);
	const body = parsed.value;

	if (!hasOnlyKeys(body, ["code", "name", "accountType"])) {
		return fail(c, "LEDGER_INVALID_INPUT", 400);
	}

	const rawCode = body.code;
	if (typeof rawCode !== "string") return fail(c, "LEDGER_INVALID_INPUT", 400);
	const code = rawCode.trim().toUpperCase();
	if (!PRODUCT_ALIAS_REGEX.test(code)) {
		return fail(c, "LEDGER_INVALID_INPUT", 400);
	}

	const rawName = body.name;
	if (
		typeof rawName !== "string" ||
		rawName.trim().length === 0 ||
		rawName.trim().length > 100
	) {
		return fail(c, "LEDGER_INVALID_INPUT", 400);
	}
	const name = rawName.trim();

	const rawAccountType = body.accountType;
	if (
		typeof rawAccountType !== "string" ||
		!["ASSET", "INCOME"].includes(rawAccountType)
	) {
		return fail(c, "LEDGER_INVALID_INPUT", 400);
	}
	const accountType = rawAccountType as "ASSET" | "INCOME";

	try {
		const db = createDatabase(getDatabaseUrl(c.env));
		const userId = c.get("auth").userId;

		const result = await createProductLedgerAccount({
			db,
			userId,
			code,
			name,
			accountType,
		});

		return c.json(
			{
				accountId: result.account.id,
				code: result.account.code,
				name: result.account.name,
				accountType: result.account.accountType,
				normalBalance: result.account.normalBalance,
				currency: result.account.currency,
				archived: result.account.archivedAt !== null,
				idempotentReplay: result.idempotentReplay,
			},
			200,
		);
	} catch (err) {
		return mapDomainError(c, err);
	}
});
