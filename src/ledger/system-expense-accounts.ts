import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	CREDIT_CARD_SYSTEM_ACCOUNT_ROLES,
	type CreditCardSystemAccountRole,
	creditCardSystemAccounts,
} from "../db/schema/credit-card-ledger";
import { type AccountType, createLedgerAccountInTransaction } from "./accounts";
import { LedgerError } from "./errors";

/**
 * Neutral, domain-agnostic per-user system expense/equity ledger account roles.
 * Originates from Phase 10 (credit cards) but is shared by any domain that
 * posts against the same economic expense categories (e.g. Phase 11 People
 * payable expenses) so that one economic category maps to exactly one ledger
 * account identity per user. The underlying table name and role codes are
 * preserved for database compatibility with existing rows.
 */
export const USER_EXPENSE_SYSTEM_ACCOUNT_ROLES =
	CREDIT_CARD_SYSTEM_ACCOUNT_ROLES;
export type UserExpenseSystemAccountRole = CreditCardSystemAccountRole;

const SYSTEM_ROLE_DEFINITIONS: Record<
	UserExpenseSystemAccountRole,
	{ defaultCodeSuffix: string; name: string; accountType: AccountType }
> = {
	MANDATORY_EXPENSE: {
		defaultCodeSuffix: "MANDATORY_EXP",
		name: "Credit Card Mandatory Expense",
		accountType: "EXPENSE",
	},
	DISCRETIONARY_EXPENSE: {
		defaultCodeSuffix: "DISCRETIONARY_EXP",
		name: "Credit Card Discretionary Expense",
		accountType: "EXPENSE",
	},
	SHORT_TERM_PURCHASE: {
		defaultCodeSuffix: "SHORT_TERM_EXP",
		name: "Credit Card Short Term Goal Expense",
		accountType: "EXPENSE",
	},
	UNCLASSIFIED_EXPENSE: {
		defaultCodeSuffix: "UNCLASSIFIED_EXP",
		name: "Credit Card Unclassified Expense",
		accountType: "EXPENSE",
	},
	OPENING_EQUITY: {
		defaultCodeSuffix: "OPENING_EQUITY",
		name: "Credit Card Opening Equity",
		accountType: "EQUITY",
	},
};

/**
 * Ensures all system expense and equity ledger accounts exist for the user.
 * Provisions any missing roles idempotently. Shared by credit-cards and people.
 */
export async function ensureUserExpenseSystemAccountsInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<Record<UserExpenseSystemAccountRole, string>> {
	const existingRows = await tx
		.select({
			role: creditCardSystemAccounts.role,
			ledgerAccountId: creditCardSystemAccounts.ledgerAccountId,
		})
		.from(creditCardSystemAccounts)
		.where(eq(creditCardSystemAccounts.userId, userId));

	const roleMap = new Map<UserExpenseSystemAccountRole, string>();
	for (const row of existingRows) {
		roleMap.set(row.role as UserExpenseSystemAccountRole, row.ledgerAccountId);
	}

	for (const role of USER_EXPENSE_SYSTEM_ACCOUNT_ROLES) {
		if (roleMap.has(role)) continue;

		const def = SYSTEM_ROLE_DEFINITIONS[role];
		const baseCode = `SYS_CC_${def.defaultCodeSuffix}`.slice(0, 64);
		let targetCode = baseCode;
		let attempts = 0;
		let createdAccount: { id: string } | null = null;

		while (!createdAccount && attempts < 5) {
			try {
				createdAccount = await createLedgerAccountInTransaction({
					tx,
					userId,
					code: targetCode,
					name: def.name,
					accountType: def.accountType,
				});
			} catch (err: unknown) {
				if (
					err instanceof LedgerError &&
					err.code === "LEDGER_ACCOUNT_CODE_CONFLICT"
				) {
					attempts++;
					targetCode = `SYS_CC_${def.defaultCodeSuffix}_${attempts}`.slice(
						0,
						64,
					);
				} else {
					throw err;
				}
			}
		}

		if (!createdAccount) {
			throw new Error(
				`Failed to provision system ledger account for role ${role}`,
			);
		}

		await tx.insert(creditCardSystemAccounts).values({
			userId,
			role,
			ledgerAccountId: createdAccount.id,
		});

		roleMap.set(role, createdAccount.id);
	}

	const mandatory = roleMap.get("MANDATORY_EXPENSE");
	const discretionary = roleMap.get("DISCRETIONARY_EXPENSE");
	const shortTerm = roleMap.get("SHORT_TERM_PURCHASE");
	const unclassified = roleMap.get("UNCLASSIFIED_EXPENSE");
	const opening = roleMap.get("OPENING_EQUITY");

	if (!mandatory || !discretionary || !shortTerm || !unclassified || !opening) {
		throw new Error("Failed to provision all user expense system accounts");
	}

	return {
		MANDATORY_EXPENSE: mandatory,
		DISCRETIONARY_EXPENSE: discretionary,
		SHORT_TERM_PURCHASE: shortTerm,
		UNCLASSIFIED_EXPENSE: unclassified,
		OPENING_EQUITY: opening,
	};
}
