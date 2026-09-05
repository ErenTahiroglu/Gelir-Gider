import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	type CreditCardSystemAccountRole,
	creditCardLedgerLinks,
} from "../db/schema/credit-card-ledger";
import { creditCards } from "../db/schema/credit-cards";
import { createLedgerAccountInTransaction } from "../ledger/accounts";
import { ensureUserExpenseSystemAccountsInTransaction } from "../ledger/system-expense-accounts";
import { CreditCardError } from "./errors";

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
 *
 * Thin compatibility wrapper: the actual provisioning logic is shared with
 * other domains (e.g. Phase 11 People payable expenses) via
 * `ensureUserExpenseSystemAccountsInTransaction` so that one economic
 * expense category maps to exactly one ledger account identity per user.
 */
export async function ensureCreditCardSystemAccountsInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<Record<CreditCardSystemAccountRole, string>> {
	return ensureUserExpenseSystemAccountsInTransaction(tx, userId);
}
