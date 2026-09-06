import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import {
	CREDIT_CARD_SYSTEM_ACCOUNT_ROLES,
	type CreditCardSystemAccountRole,
	creditCardSystemAccounts,
} from "../db/schema/credit-card-ledger";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	type AccountType,
	ensureDeterministicLedgerAccountInTransaction,
} from "./accounts";
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

/**
 * The subset of user expense system account roles month-close ever reads.
 */
export const MONTH_CLOSE_EXPENSE_SYSTEM_ACCOUNT_ROLES = [
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_EXPENSE",
	"UNCLASSIFIED_EXPENSE",
] as const;
export type MonthCloseExpenseSystemAccountRole =
	(typeof MONTH_CLOSE_EXPENSE_SYSTEM_ACCOUNT_ROLES)[number];

/**
 * STRICTLY READ-ONLY sibling of `ensureUserExpenseSystemAccountsInTransaction`
 * (Phase 14-R1, Section B). Never INSERTs/UPDATEs/DELETEs -- no ledger
 * account or system-account-role row is ever provisioned here. A read-only
 * caller (month-close preview, and month-close apply which only ever reads
 * expense truth) must never have a mutating side effect.
 *
 * For each of the three expense roles month-close needs:
 *  - If no `creditCardSystemAccounts` mapping row exists for that role, the
 *    role's monthly expense is treated as exactly "0.00" (no supported
 *    domain could have posted into an unprovisioned system role).
 *  - If a mapping DOES exist, the linked `ledgerAccounts` row must be: same
 *    user, accountType = 'EXPENSE', normalBalance = 'DEBIT', same user
 *    currency, and unarchived. A malformed mapping is never repaired here --
 *    it fails closed (throws `LedgerError`).
 */
export async function resolveUserExpenseSystemAccountsReadOnlyInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<Record<MonthCloseExpenseSystemAccountRole, string | null>> {
	const [user] = await tx
		.select({ currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) {
		throw new LedgerError("LEDGER_USER_NOT_FOUND", "User not found");
	}

	const rows = await tx
		.select({
			role: creditCardSystemAccounts.role,
			ledgerAccountId: creditCardSystemAccounts.ledgerAccountId,
		})
		.from(creditCardSystemAccounts)
		.where(
			and(
				eq(creditCardSystemAccounts.userId, userId),
				inArray(
					creditCardSystemAccounts.role,
					MONTH_CLOSE_EXPENSE_SYSTEM_ACCOUNT_ROLES as unknown as string[],
				),
			),
		);

	const roleMap = new Map<MonthCloseExpenseSystemAccountRole, string>();
	for (const row of rows) {
		roleMap.set(
			row.role as MonthCloseExpenseSystemAccountRole,
			row.ledgerAccountId,
		);
	}

	const result = {} as Record<
		MonthCloseExpenseSystemAccountRole,
		string | null
	>;

	for (const role of MONTH_CLOSE_EXPENSE_SYSTEM_ACCOUNT_ROLES) {
		const ledgerAccountId = roleMap.get(role);
		if (!ledgerAccountId) {
			result[role] = null;
			continue;
		}

		const [account] = await tx
			.select({
				id: ledgerAccounts.id,
				userId: ledgerAccounts.userId,
				accountType: ledgerAccounts.accountType,
				normalBalance: ledgerAccounts.normalBalance,
				currency: ledgerAccounts.currency,
				archivedAt: ledgerAccounts.archivedAt,
			})
			.from(ledgerAccounts)
			.where(eq(ledgerAccounts.id, ledgerAccountId))
			.limit(1);

		if (
			!account ||
			account.userId !== userId ||
			account.accountType !== "EXPENSE" ||
			account.normalBalance !== "DEBIT" ||
			account.currency !== user.currency ||
			account.archivedAt !== null
		) {
			throw new LedgerError(
				"LEDGER_INCOMPLETE_STATE",
				`System expense account mapping for role "${role}" is malformed or invalid; refusing to repair it`,
			);
		}

		result[role] = ledgerAccountId;
	}

	return result;
}
