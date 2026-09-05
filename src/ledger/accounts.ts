import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import {
	creditCardLedgerLinks,
	creditCardSystemAccounts,
} from "../db/schema/credit-card-ledger";
import { ledgerAccounts } from "../db/schema/ledger";
import { midasAccounts } from "../db/schema/midas";
import { isLedgerAccountInUseDbError } from "../midas/utils";
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

export interface CreateLedgerAccountInTransactionParams {
	tx: DatabaseTransaction;
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
 * Creates a new ledger account within an existing transaction.
 */
export async function createLedgerAccountInTransaction({
	tx,
	userId,
	code,
	name,
	accountType,
}: CreateLedgerAccountInTransactionParams): Promise<LedgerAccountRecord> {
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
	const [user] = await tx
		.select({ id: users.id, currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User does not exist");
	}

	const normalBalance = deriveNormalBalance(accountType);

	try {
		const [created] = await tx
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

function mapLedgerAccountRow(row: {
	id: string;
	userId: string;
	code: string;
	name: string;
	accountType: string;
	normalBalance: string;
	currency: string;
	createdAt: Date;
	archivedAt: Date | null;
}): LedgerAccountRecord {
	return {
		id: row.id,
		userId: row.userId,
		code: row.code,
		name: row.name,
		accountType: row.accountType as AccountType,
		normalBalance: row.normalBalance as NormalBalance,
		currency: row.currency,
		createdAt: row.createdAt,
		archivedAt: row.archivedAt,
	};
}

export interface EnsureDeterministicLedgerAccountParams {
	tx: DatabaseTransaction;
	userId: string;
	code: string;
	name: string;
	accountType: AccountType;
}

/**
 * Ensures a per-user singleton ledger account exists at a deterministic code,
 * without ever relying on catching a raw unique-constraint violation inside
 * the current transaction. A code collision on one of these identities always
 * means "this exact resource already exists" (never a different resource
 * colliding by chance), so this uses `ON CONFLICT DO NOTHING` -- which never
 * raises a Postgres error and therefore never aborts the surrounding
 * transaction -- and re-reads the existing row when nothing was inserted,
 * independently validating that it matches the expected type/balance/currency
 * and is not archived before returning it.
 *
 * Contrast with `createLedgerAccountInTransaction`, which is a plain INSERT
 * that raises `LEDGER_ACCOUNT_CODE_CONFLICT` on collision: catching that
 * error and continuing to query in the same transaction is unsafe, because a
 * real unique-constraint violation puts a PostgreSQL transaction into an
 * aborted state until a ROLLBACK (or ROLLBACK TO SAVEPOINT) is issued -- any
 * subsequent statement, including a "recovery" re-read, would itself fail
 * with "current transaction is aborted". Callers provisioning a deterministic
 * singleton account (as opposed to creating a fresh, caller-named one) should
 * use this function instead.
 */
export async function ensureDeterministicLedgerAccountInTransaction({
	tx,
	userId,
	code,
	name,
	accountType,
}: EnsureDeterministicLedgerAccountParams): Promise<LedgerAccountRecord> {
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

	const [user] = await tx
		.select({ id: users.id, currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User does not exist");
	}

	const normalBalance = deriveNormalBalance(accountType);

	const [inserted] = await tx
		.insert(ledgerAccounts)
		.values({
			userId: user.id,
			code: normalizedCode,
			name: trimmedName,
			accountType,
			normalBalance,
			currency: user.currency,
		})
		.onConflictDoNothing({
			target: [ledgerAccounts.userId, ledgerAccounts.code],
		})
		.returning();

	if (inserted) {
		return mapLedgerAccountRow(inserted);
	}

	// No exception was ever raised above, so the transaction is not aborted
	// and this re-read is always safe.
	const [existing] = await tx
		.select()
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.userId, userId),
				eq(ledgerAccounts.code, normalizedCode),
			),
		)
		.limit(1);

	if (!existing) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			`Failed to provision or resolve deterministic ledger account "${normalizedCode}"`,
		);
	}

	if (
		existing.accountType !== accountType ||
		existing.normalBalance !== normalBalance ||
		existing.currency !== user.currency
	) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			`Existing ledger account "${normalizedCode}" does not match the expected type/balance/currency`,
		);
	}

	if (existing.archivedAt !== null) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_ARCHIVED",
			`Deterministic ledger account "${normalizedCode}" is archived`,
		);
	}

	return mapLedgerAccountRow(existing);
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
	return createLedgerAccountInTransaction({
		tx: db as unknown as DatabaseTransaction,
		userId,
		code,
		name,
		accountType,
	});
}

export interface ArchiveLedgerAccountParams {
	db: Database;
	userId: string;
	accountId: string;
}

export interface ArchiveLedgerAccountInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	accountId: string;
}

/**
 * Soft-archives a ledger account inside a transaction.
 */
export async function archiveLedgerAccountInTransaction({
	tx,
	userId,
	accountId,
}: ArchiveLedgerAccountInTransactionParams): Promise<LedgerAccountRecord> {
	if (!userId || !accountId) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"User ID and Account ID are required",
		);
	}

	const [account] = await tx
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
	const [linkedMidas] = await tx
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

	// Check if this account is linked to a credit card
	const [linkedCard] = await tx
		.select({ cardId: creditCardLedgerLinks.creditCardId })
		.from(creditCardLedgerLinks)
		.where(eq(creditCardLedgerLinks.liabilityAccountId, accountId))
		.limit(1);

	if (linkedCard) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_IN_USE",
			"Cannot archive a ledger account that is linked to a credit card",
		);
	}

	// Check if this account is linked to a credit card system role
	const [linkedSystem] = await tx
		.select({ role: creditCardSystemAccounts.role })
		.from(creditCardSystemAccounts)
		.where(eq(creditCardSystemAccounts.ledgerAccountId, accountId))
		.limit(1);

	if (linkedSystem) {
		throw new LedgerError(
			"LEDGER_ACCOUNT_IN_USE",
			`Cannot archive a ledger account that is linked to credit card system role: ${linkedSystem.role}`,
		);
	}

	try {
		const [updated] = await tx
			.update(ledgerAccounts)
			.set({ archivedAt: new Date() })
			.where(
				and(
					eq(ledgerAccounts.id, accountId),
					eq(ledgerAccounts.userId, userId),
				),
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
	} catch (err) {
		if (err instanceof LedgerError) {
			throw err;
		}
		if (isLedgerAccountInUseDbError(err)) {
			throw new LedgerError(
				"LEDGER_ACCOUNT_IN_USE",
				"Cannot archive a ledger account that is linked to a Midas account or credit card",
			);
		}
		throw err;
	}
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
	return archiveLedgerAccountInTransaction({
		tx: db as unknown as DatabaseTransaction,
		userId,
		accountId,
	});
}
