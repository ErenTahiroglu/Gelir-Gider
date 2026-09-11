import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	type AccountType,
	deriveNormalBalance,
	type LedgerAccountRecord,
	mapLedgerAccountRow,
} from "./accounts";
import { LedgerError } from "./errors";

export const PRODUCT_LEDGER_ACCOUNT_PREFIX = "USR_";
export const ALLOWED_PRODUCT_ACCOUNT_TYPES = new Set<AccountType>([
	"ASSET",
	"INCOME",
]);

export interface CreateProductLedgerAccountParams {
	db: Database;
	userId: string;
	code: string;
	name: string;
	accountType: AccountType;
}

export interface CreateProductLedgerAccountResult {
	account: LedgerAccountRecord;
	idempotentReplay: boolean;
}

/**
 * Creates a user-owned product ledger account using the dedicated `USR_` prefix.
 * Enforces:
 * - Allowed account types: ASSET (derived normalBalance DEBIT) and INCOME (derived normalBalance CREDIT)
 * - User currency derived from authoritative user base currency
 * - Product alias 1..60 chars, mapped to USR_<ALIAS> (5..64 chars, valid under ^[A-Z][A-Z0-9_]{1,63}$)
 * - Natural-key replay via INSERT ... ON CONFLICT DO NOTHING + safe re-read in transaction
 * - Changed definition on replay throws LEDGER_ACCOUNT_CODE_CONFLICT
 */
export async function createProductLedgerAccount({
	db,
	userId,
	code,
	name,
	accountType,
}: CreateProductLedgerAccountParams): Promise<CreateProductLedgerAccountResult> {
	if (!userId || userId.trim() === "") {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User ID is required");
	}

	const trimmedAlias = code?.trim().toUpperCase();
	if (!trimmedAlias || !/^[A-Z0-9_]{1,60}$/.test(trimmedAlias)) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			`Invalid product account code alias: "${code}". Must be 1 to 60 alphanumeric/underscore characters.`,
		);
	}

	const storedCode = `${PRODUCT_LEDGER_ACCOUNT_PREFIX}${trimmedAlias}`;

	const trimmedName = name?.trim();
	if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 100) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			"Account name must be between 1 and 100 characters",
		);
	}

	if (!ALLOWED_PRODUCT_ACCOUNT_TYPES.has(accountType)) {
		throw new LedgerError(
			"LEDGER_INVALID_ENTRY",
			`Invalid product account type: "${accountType}". Only ASSET and INCOME are permitted.`,
		);
	}

	const normalBalance = deriveNormalBalance(accountType);

	return db.transaction(async (tx) => {
		const [user] = await tx
			.select({ id: users.id, currency: users.currency })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);

		if (!user) {
			throw new LedgerError("LEDGER_USER_NOT_FOUND", "User does not exist");
		}

		const [inserted] = await tx
			.insert(ledgerAccounts)
			.values({
				userId: user.id,
				code: storedCode,
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
			return {
				account: mapLedgerAccountRow(inserted),
				idempotentReplay: false,
			};
		}

		// Re-read existing row safely in the still-healthy transaction
		const [existing] = await tx
			.select()
			.from(ledgerAccounts)
			.where(
				and(
					eq(ledgerAccounts.userId, userId),
					eq(ledgerAccounts.code, storedCode),
				),
			)
			.limit(1);

		if (!existing) {
			throw new LedgerError(
				"LEDGER_INVALID_ENTRY",
				`Failed to resolve product ledger account "${storedCode}"`,
			);
		}

		if (
			existing.name !== trimmedName ||
			existing.accountType !== accountType ||
			existing.currency !== user.currency ||
			existing.normalBalance !== normalBalance
		) {
			throw new LedgerError(
				"LEDGER_ACCOUNT_CODE_CONFLICT",
				`Account with code "${storedCode}" already exists with different definition`,
			);
		}

		if (existing.archivedAt !== null) {
			throw new LedgerError(
				"LEDGER_ACCOUNT_ARCHIVED",
				`Product ledger account "${storedCode}" is archived`,
			);
		}

		return {
			account: mapLedgerAccountRow(existing),
			idempotentReplay: true,
		};
	});
}
