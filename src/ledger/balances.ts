import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	journalEntries,
	journalLines,
	ledgerAccounts,
} from "../db/schema/ledger";
import { LedgerError } from "./errors";
import { formatSignedCentsToMoney, parseMoneyString } from "./money";

export interface GetLedgerAccountBalanceParams {
	db: Database;
	userId: string;
	accountId: string;
	asOf?: Date;
}

export interface LedgerAccountBalanceResult {
	accountId: string;
	currency: string;
	normalBalance: "DEBIT" | "CREDIT";
	balance: string;
	asOf: string | null;
}

export interface ListLedgerAccountBalancesParams {
	db: Database;
	userId: string;
	asOf?: Date;
	includeArchived?: boolean;
}

export interface LedgerAccountBalanceListItem {
	accountId: string;
	code: string;
	name: string;
	accountType: string;
	normalBalance: "DEBIT" | "CREDIT";
	currency: string;
	archived: boolean;
	balance: string;
}

/**
 * Calculates the exact signed decimal balance for a specific ledger account.
 * Reads ONLY from POSTED journal entries and supports historical asOf timestamp.
 */
export async function getLedgerAccountBalance({
	db,
	userId,
	accountId,
	asOf,
}: GetLedgerAccountBalanceParams): Promise<LedgerAccountBalanceResult> {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
	}

	const trimmedAccountId = accountId?.trim();
	if (!trimmedAccountId) {
		throw new LedgerError("LEDGER_ACCOUNT_NOT_FOUND", "Account ID is required");
	}

	if (
		asOf !== undefined &&
		(!(asOf instanceof Date) || Number.isNaN(asOf.getTime()))
	) {
		throw new LedgerError("LEDGER_INVALID_ENTRY", "Invalid asOf Date provided");
	}

	// 1. Verify account exists and belongs to user
	const [account] = await db
		.select({
			id: ledgerAccounts.id,
			userId: ledgerAccounts.userId,
			normalBalance: ledgerAccounts.normalBalance,
			currency: ledgerAccounts.currency,
		})
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.id, trimmedAccountId),
				eq(ledgerAccounts.userId, userId),
			),
		)
		.limit(1);

	if (!account) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_NOT_FOUND",
			`Account "${trimmedAccountId}" not found for this user`,
		);
	}

	// 2. Aggregate debit and credit sums from POSTED entries
	const conditions = [
		eq(journalLines.accountId, trimmedAccountId),
		eq(journalEntries.status, "POSTED"),
	];

	if (asOf) {
		conditions.push(lte(journalEntries.occurredAt, asOf));
	}

	const [aggregate] = await db
		.select({
			debitSum: sql<string>`COALESCE(SUM(${journalLines.debit}), 0.00)`,
			creditSum: sql<string>`COALESCE(SUM(${journalLines.credit}), 0.00)`,
		})
		.from(journalLines)
		.innerJoin(
			journalEntries,
			eq(journalLines.journalEntryId, journalEntries.id),
		)
		.where(and(...conditions));

	const debitParsed = parseMoneyString(aggregate?.debitSum ?? "0.00");
	const creditParsed = parseMoneyString(aggregate?.creditSum ?? "0.00");

	const normalBalance = account.normalBalance as "DEBIT" | "CREDIT";

	// DEBIT normal (ASSET, EXPENSE): balance = debit - credit
	// CREDIT normal (LIABILITY, EQUITY, INCOME): balance = credit - debit
	const signedCents =
		normalBalance === "DEBIT"
			? debitParsed.cents - creditParsed.cents
			: creditParsed.cents - debitParsed.cents;

	return {
		accountId: account.id,
		currency: account.currency,
		normalBalance,
		balance: formatSignedCentsToMoney(signedCents),
		asOf: asOf ? asOf.toISOString() : null,
	};
}

/**
 * Lists exact balances for all ledger accounts belonging to the user,
 * ordered deterministically by account code.
 */
export async function listLedgerAccountBalances({
	db,
	userId,
	asOf,
	includeArchived = false,
}: ListLedgerAccountBalancesParams): Promise<LedgerAccountBalanceListItem[]> {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
	}

	if (
		asOf !== undefined &&
		(!(asOf instanceof Date) || Number.isNaN(asOf.getTime()))
	) {
		throw new LedgerError("LEDGER_INVALID_ENTRY", "Invalid asOf Date provided");
	}

	// Fetch all accounts
	const accountConditions = [eq(ledgerAccounts.userId, userId)];
	if (!includeArchived) {
		accountConditions.push(isNull(ledgerAccounts.archivedAt));
	}

	const accounts = await db
		.select({
			id: ledgerAccounts.id,
			code: ledgerAccounts.code,
			name: ledgerAccounts.name,
			accountType: ledgerAccounts.accountType,
			normalBalance: ledgerAccounts.normalBalance,
			currency: ledgerAccounts.currency,
			archivedAt: ledgerAccounts.archivedAt,
		})
		.from(ledgerAccounts)
		.where(and(...accountConditions))
		.orderBy(ledgerAccounts.code);

	if (accounts.length === 0) {
		return [];
	}

	// Aggregate line totals per account for POSTED entries
	const lineConditions = [
		eq(journalEntries.userId, userId),
		eq(journalEntries.status, "POSTED"),
	];

	if (asOf) {
		lineConditions.push(lte(journalEntries.occurredAt, asOf));
	}

	const aggregatedLines = await db
		.select({
			accountId: journalLines.accountId,
			debitSum: sql<string>`COALESCE(SUM(${journalLines.debit}), 0.00)`,
			creditSum: sql<string>`COALESCE(SUM(${journalLines.credit}), 0.00)`,
		})
		.from(journalLines)
		.innerJoin(
			journalEntries,
			eq(journalLines.journalEntryId, journalEntries.id),
		)
		.where(and(...lineConditions))
		.groupBy(journalLines.accountId);

	const totalsMap = new Map(
		aggregatedLines.map((row) => [
			row.accountId,
			{
				debitCents: parseMoneyString(row.debitSum).cents,
				creditCents: parseMoneyString(row.creditSum).cents,
			},
		]),
	);

	return accounts.map((acc) => {
		const totals = totalsMap.get(acc.id) ?? {
			debitCents: 0n,
			creditCents: 0n,
		};
		const normalBal = acc.normalBalance as "DEBIT" | "CREDIT";
		const signedCents =
			normalBal === "DEBIT"
				? totals.debitCents - totals.creditCents
				: totals.creditCents - totals.debitCents;

		return {
			accountId: acc.id,
			code: acc.code,
			name: acc.name,
			accountType: acc.accountType,
			normalBalance: normalBal,
			currency: acc.currency,
			archived: acc.archivedAt !== null,
			balance: formatSignedCentsToMoney(signedCents),
		};
	});
}
