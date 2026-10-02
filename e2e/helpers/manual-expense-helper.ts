import { createDatabase } from "../../src/db/client";
import {
	validateAmount,
	validateManualExpenseBudgetCategory,
	verifyAssetAccountInTransaction,
} from "../../src/manual-expenses/service";
import { mapPurchaseCategoryToSystemRole } from "../../src/db/schema/credit-card-ledger";
import { ensureUserExpenseSystemAccountsInTransaction } from "../../src/ledger/system-expense-accounts";
import { createCanonicalTransactionWithLedgerInTransaction } from "../../src/transactions/ledger-lifecycle";
import { upsertAssignment } from "../../src/spending-categories/assignments";
import { PRODUCT_HTTP_SOURCE_TYPE } from "../../src/transactions/product-read-v2";
import type { JournalLineInput } from "../../src/ledger/posting";

export async function createManualExpenseClean(
	userId: string,
	params: {
		amount: string;
		sourceAssetAccountId: string;
		budgetCategory: string;
		spendingCategoryId?: string | undefined;
		merchant?: string | undefined;
		description?: string | undefined;
		occurredAt?: Date | undefined;
		idempotencyKey: string;
		shortTermGoalId?: string | undefined;
	},
) {
	const db = createDatabase("test");
	const amount = validateAmount(params.amount);
	const sourceAssetAccountId = params.sourceAssetAccountId;
	const budgetCategory = validateManualExpenseBudgetCategory(params.budgetCategory);
	const idempotencyKey = params.idempotencyKey.trim();
	const occurredAt = params.occurredAt ?? new Date();

	const spendingCategoryId = params.spendingCategoryId?.trim() || undefined;
	const shortTermGoalId = params.shortTermGoalId?.trim() || undefined;
	const merchant = params.merchant?.trim() || undefined;
	const description = params.description?.trim() || undefined;

	const res = await db.transaction(async (tx) => {
		await verifyAssetAccountInTransaction(tx, userId, sourceAssetAccountId);

		const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
			tx,
			userId,
		);
		const systemRole = mapPurchaseCategoryToSystemRole(budgetCategory);
		const expenseAccountId = systemAccounts[systemRole];
		if (!expenseAccountId) {
			throw new Error(`Expense account not found for role ${systemRole}`);
		}

		// Clean payload: only include defined keys so canonicalizePayload never throws
		const payload: Record<string, unknown> = {
			amount,
			sourceAssetAccountId,
			budgetCategory,
		};
		if (spendingCategoryId) payload.spendingCategoryId = spendingCategoryId;
		if (merchant) payload.merchant = merchant;
		if (description) payload.description = description;
		if (shortTermGoalId) payload.shortTermGoalId = shortTermGoalId;

		const lines: JournalLineInput[] = [
			{
				accountId: expenseAccountId,
				side: "DEBIT",
				amount,
				memo: description ?? merchant ?? "Manual expense",
			},
			{
				accountId: sourceAssetAccountId,
				side: "CREDIT",
				amount,
				memo: description ?? merchant ?? "Manual expense payment",
			},
		];

		const opResult = await createCanonicalTransactionWithLedgerInTransaction({
			tx,
			userId,
			kind: "MANUAL_EXPENSE",
			idempotencyKey,
			occurredAt,
			payload,
			source: {
				type: PRODUCT_HTTP_SOURCE_TYPE,
				ref: idempotencyKey,
			},
			ledger: {
				memo: description ?? merchant ?? "Manual expense",
				lines,
			},
		});

		return opResult;
	});

	if (spendingCategoryId && res.transactionId) {
		try {
			await upsertAssignment(db, userId, {
				subjectType: "MANUAL_EXPENSE",
				subjectId: res.transactionId,
				categoryId: spendingCategoryId,
			});
		} catch {
			// ignore
		}
	}

	return res;
}
