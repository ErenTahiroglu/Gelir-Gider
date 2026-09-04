import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import { ledgerAccounts } from "../db/schema/ledger";
import { midasAccounts } from "../db/schema/midas";
import { LedgerError } from "./errors";

export type AccountType =
	| "ASSET"
	| "LIABILITY"
	| "EQUITY"
	| "INCOME"
	| "EXPENSE";
export type NormalBalance = "DEBIT" | "CREDIT";

const ACCOUNT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const VALID_ACCOUNT_TYPES = new Set<AccountType>([
	"ASSET",
	"LIABILITY",
	"EQUITY",
	"INCOME",
	"EXPENSE",
]);

export function deriveNormalBalance(accountType: AccountType): NormalBalance {
	switch (accountType) {
		case "ASSET":
		case "EXPENSE":
			return "DEBIT";
		case "LIABILITY":
		case "EQUITY":
		case "INCOME":
			return "CREDIT";
		default:
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				`Unknown account type: ${accountType}`,
			);
	}
}

export interface CreateLedgerAccountParams {
	db: Database;
	userId: string;
	code: string;
	name: string;
	accountType: AccountType;
}

export interface LedgerAccountRecord {
	id: string;
	userId: string;
	code: string;
	name: string;
	accountType: AccountType;
	normalBalance: NormalBalance;
	currency: string;
	createdAt: Date;
	archivedAt: Date | null;
}

/**
 * Creates a new ledger account for the given user.
 * Derives normal balance from account type and currency from user's base currency.
 */
export async function createLedgerAccount({
	db,
	userId,
	code,
	name,
	accountType,
}: CreateLedgerAccountParams): Promise<LedgerAccountRecord> {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
	}

	const normalizedCode = code?.trim().toUpperCase();
	if (!normalizedCode || !ACCOUNT_CODE_PATTERN.test(normalizedCode)) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			`Invalid account code format: "${code}". Must match ^[A-Z][A-Z0-9_]{1,63}$`,
		);
	}

	const trimmedName = name?.trim();
	if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 100) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Account name must be between 1 and 100 characters",
		);
	}

	if (!VALID_ACCOUNT_TYPES.has(accountType)) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			`Invalid account type: "${accountType}"`,
		);
	}

	// Resolve user to verify existence and derive currency
	const [user] = await db
		.select({ id: users.id, currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User does not exist");
	}

	const normalBalance = deriveNormalBalance(accountType);

	try {
		const [created] = await db
			.insert(ledgerAccounts)
			.values({
				userId: user.id,
				code: normalizedCode,
				name: trimmedName,
				accountType,
				normalBalance,
				currency: user.currency,
			})
			.returning();

		if (!created) {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				"Failed to create ledger account",
			);
		}

		return {
			id: created.id,
			userId: created.userId,
			code: created.code,
			name: created.name,
			accountType: created.accountType as AccountType,
			normalBalance: created.normalBalance as NormalBalance,
			currency: created.currency,
			createdAt: created.createdAt,
			archivedAt: created.archivedAt,
		};
	} catch (err) {
		if (
			err instanceof Error &&
			("code" in err || "constraint" in err || "message" in err)
		) {
			const errStr = String(err.message);
			if (
				errStr.includes("ledger_accounts_user_code_idx") ||
				errStr.includes("unique") ||
				("code" in err && (err as { code: string }).code === "23505")
			) {
				throw new LedgerError(
					"LEDGER_ACCOUNT_CODE_CONFLICT",
					`Account with code "${normalizedCode}" already exists for this user`,
				);
			}
		}
		throw err;
	}
}

export interface ArchiveLedgerAccountParams {
	db: Database;
	userId: string;
	accountId: string;
}

/**
 * Soft-archives a ledger account. Idempotent if already archived.
 * Historical lines remain intact; new journal postings to this account are prohibited.
 */
export async function archiveLedgerAccount({
	db,
	userId,
	accountId,
}: ArchiveLedgerAccountParams): Promise<LedgerAccountRecord> {
	if (!userId || !accountId) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"User ID and Account ID are required",
		);
	}

	const [account] = await db
		.select()
		.from(ledgerAccounts)
		.where(
			and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.userId, userId)),
		)
		.limit(1);

	if (!account) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_NOT_FOUND",
			"Ledger account not found",
		);
	}

	if (account.archivedAt !== null) {
		// Idempotent return if already archived
		return {
			id: account.id,
			userId: account.userId,
			code: account.code,
			name: account.name,
			accountType: account.accountType as AccountType,
			normalBalance: account.normalBalance as NormalBalance,
			currency: account.currency,
			createdAt: account.createdAt,
			archivedAt: account.archivedAt,
		};
	}

	// Check if this account is linked to an active Midas account
	const [linkedMidas] = await db
		.select({ id: midasAccounts.id })
		.from(midasAccounts)
		.where(eq(midasAccounts.ledgerAccountId, accountId))
		.limit(1);

	if (linkedMidas) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_IN_USE",
			"Cannot archive a ledger account that is linked to a Midas account",
		);
	}

	const [updated] = await db
		.update(ledgerAccounts)
		.set({ archivedAt: new Date() })
		.where(
			and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.userId, userId)),
		)
		.returning();

	if (!updated) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_NOT_FOUND",
			"Ledger account not found during update",
		);
	}

	return {
		id: updated.id,
		userId: updated.userId,
		code: updated.code,
		name: updated.name,
		accountType: updated.accountType as AccountType,
		normalBalance: updated.normalBalance as NormalBalance,
		currency: updated.currency,
		createdAt: updated.createdAt,
		archivedAt: updated.archivedAt,
	};
}
