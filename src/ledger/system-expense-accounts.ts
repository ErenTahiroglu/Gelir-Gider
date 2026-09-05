import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	CREDIT_CARD_SYSTEM_ACCOUNT_ROLES,
	type CreditCardSystemAccountRole,
	creditCardSystemAccounts,
} from "../db/schema/credit-card-ledger";
import {
	type AccountType,
	ensureDeterministicLedgerAccountInTransaction,
} from "./accounts";

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
		const code = `SYS_CC_${def.defaultCodeSuffix}`.slice(0, 64);

		// This is a per-user singleton identity, provisioned via a safe
		// ON CONFLICT DO NOTHING ensure (never a caught raw unique-violation
		// exception, which would otherwise leave this transaction aborted).
		const account = await ensureDeterministicLedgerAccountInTransaction({
			tx,
			userId,
			code,
			name: def.name,
			accountType: def.accountType,
		});
		const ledgerAccountId = account.id;

		const [insertedSystemAccount] = await tx
			.insert(creditCardSystemAccounts)
			.values({ userId, role, ledgerAccountId })
			.onConflictDoNothing({
				target: [
					creditCardSystemAccounts.userId,
					creditCardSystemAccounts.role,
				],
			})
			.returning({ ledgerAccountId: creditCardSystemAccounts.ledgerAccountId });

		if (insertedSystemAccount) {
			roleMap.set(role, insertedSystemAccount.ledgerAccountId);
			continue;
		}

		// Concurrent race already inserted the system account row for this role.
		const [existingSystemAccount] = await tx
			.select({ ledgerAccountId: creditCardSystemAccounts.ledgerAccountId })
			.from(creditCardSystemAccounts)
			.where(
				and(
					eq(creditCardSystemAccounts.userId, userId),
					eq(creditCardSystemAccounts.role, role),
				),
			)
			.limit(1);

		if (!existingSystemAccount) {
			throw new Error(
				`Failed to provision system ledger account for role ${role}`,
			);
		}

		roleMap.set(role, existingSystemAccount.ledgerAccountId);
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
