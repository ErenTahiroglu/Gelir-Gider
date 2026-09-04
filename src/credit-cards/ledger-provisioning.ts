import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	CREDIT_CARD_SYSTEM_ACCOUNT_ROLES,
	type CreditCardSystemAccountRole,
	creditCardLedgerLinks,
	creditCardSystemAccounts,
} from "../db/schema/credit-card-ledger";
import { creditCards } from "../db/schema/credit-cards";
import {
	type AccountType,
	createLedgerAccountInTransaction,
} from "../ledger/accounts";
import { CreditCardError } from "./errors";

const SYSTEM_ROLE_DEFINITIONS: Record<
	CreditCardSystemAccountRole,
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
 * Ensures the credit card has an associated 1:1 LIABILITY ledger account link.
 * If the link does not exist, provisions a dedicated LIABILITY ledger account and creates the link.
 */
export async function ensureCreditCardLedgerLinkInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	cardId: string,
): Promise<string> {
	const [existing] = await tx
		.select({
			id: creditCardLedgerLinks.id,
			liabilityAccountId: creditCardLedgerLinks.liabilityAccountId,
		})
		.from(creditCardLedgerLinks)
		.where(
			and(
				eq(creditCardLedgerLinks.userId, userId),
				eq(creditCardLedgerLinks.creditCardId, cardId),
			),
		)
		.limit(1);

	if (existing) {
		return existing.liabilityAccountId;
	}

	// Fetch card to construct account code and name
	const [card] = await tx
		.select({
			id: creditCards.id,
			code: creditCards.code,
			userId: creditCards.userId,
		})
		.from(creditCards)
		.where(and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)))
		.limit(1);

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${cardId}" not found`,
		);
	}

	const baseCode = `CC_${card.code.toUpperCase()}_LIABILITY`.slice(0, 64);
	let targetCode = baseCode;
	let attempts = 0;
	let createdAccount: { id: string } | null = null;

	while (!createdAccount && attempts < 5) {
		try {
			createdAccount = await createLedgerAccountInTransaction({
				tx,
				userId,
				code: targetCode,
				name: `${card.code} Liability`,
				accountType: "LIABILITY",
			});
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as { code: string }).code === "LEDGER_ACCOUNT_CODE_CONFLICT"
			) {
				attempts++;
				targetCode = `CC_${card.code.toUpperCase()}_LIAB_${attempts}`.slice(
					0,
					64,
				);
			} else {
				throw err;
			}
		}
	}

	if (!createdAccount) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Failed to provision ledger account for credit card ${card.code}`,
		);
	}

	const [createdLink] = await tx
		.insert(creditCardLedgerLinks)
		.values({
			userId,
			creditCardId: card.id,
			liabilityAccountId: createdAccount.id,
		})
		.returning({ id: creditCardLedgerLinks.id });

	if (!createdLink) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			"Failed to create credit card ledger link",
		);
	}

	return createdAccount.id;
}

/**
 * Ensures all system expense and equity ledger accounts exist for the user.
 * Provisions any missing roles idempotently.
 */
export async function ensureCreditCardSystemAccountsInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<Record<CreditCardSystemAccountRole, string>> {
	const existingRows = await tx
		.select({
			role: creditCardSystemAccounts.role,
			ledgerAccountId: creditCardSystemAccounts.ledgerAccountId,
		})
		.from(creditCardSystemAccounts)
		.where(eq(creditCardSystemAccounts.userId, userId));

	const roleMap = new Map<CreditCardSystemAccountRole, string>();
	for (const row of existingRows) {
		roleMap.set(row.role as CreditCardSystemAccountRole, row.ledgerAccountId);
	}

	for (const role of CREDIT_CARD_SYSTEM_ACCOUNT_ROLES) {
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
					err instanceof Error &&
					"code" in err &&
					(err as { code: string }).code === "LEDGER_ACCOUNT_CODE_CONFLICT"
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
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
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
		throw new Error("Failed to provision all credit card system accounts");
	}

	return {
		MANDATORY_EXPENSE: mandatory,
		DISCRETIONARY_EXPENSE: discretionary,
		SHORT_TERM_PURCHASE: shortTerm,
		UNCLASSIFIED_EXPENSE: unclassified,
		OPENING_EQUITY: opening,
	};
}
