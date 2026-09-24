import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	type CreditCardPurchaseBudgetCategory,
	mapPurchaseCategoryToSystemRole,
} from "../db/schema/credit-card-ledger";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	canonicalTransactions,
	transactionRevisions,
} from "../db/schema/transactions";
import { LedgerError } from "../ledger/errors";
import { formatCentsToMoney, parsePositiveMoneyString } from "../ledger/money";
import type { JournalLineInput } from "../ledger/posting";
import { ensureUserExpenseSystemAccountsInTransaction } from "../ledger/system-expense-accounts";
import { upsertAssignment } from "../spending-categories/assignments";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	reviseCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import {
	listCanonicalTransactions,
	PRODUCT_HTTP_SOURCE_TYPE,
	USER_EDIT_REASON_CODE,
	USER_VOID_REASON_CODE,
} from "../transactions/product-read-v2";
import { ManualExpenseError } from "./errors";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_BUDGET_CATEGORIES = new Set<string>([
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
]);

export function validateManualExpenseBudgetCategory(
	cat: unknown,
): CreditCardPurchaseBudgetCategory {
	if (typeof cat !== "string") {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			"budgetCategory must be a string",
		);
	}
	const trimmed = cat.trim();
	if (trimmed === "ASK") {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			"budgetCategory cannot be ASK for financial transactions",
		);
	}
	if (!VALID_BUDGET_CATEGORIES.has(trimmed)) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			`Invalid budgetCategory: "${trimmed}". Must be MANDATORY_EXPENSE, DISCRETIONARY_SPEND, or SHORT_TERM_PURCHASE`,
		);
	}
	return trimmed as CreditCardPurchaseBudgetCategory;
}

export function validateUuid(val: unknown, fieldName: string): string {
	if (typeof val !== "string" || !UUID_PATTERN.test(val.trim())) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			`${fieldName} must be a valid UUID`,
		);
	}
	return val.trim().toLowerCase();
}

export function validateAmount(val: unknown): string {
	try {
		return parsePositiveMoneyString(val).normalized;
	} catch {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			'amount must be a valid positive money string (e.g. "120.00")',
		);
	}
}

export async function verifyAssetAccountInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	assetAccountId: string,
): Promise<typeof ledgerAccounts.$inferSelect> {
	const [acc] = await tx
		.select()
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.id, assetAccountId),
				eq(ledgerAccounts.userId, userId),
			),
		);

	if (!acc) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			`Asset account ${assetAccountId} not found`,
		);
	}

	if (acc.accountType !== "ASSET") {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			`Account ${assetAccountId} is not an ASSET account (type=${acc.accountType})`,
		);
	}

	if (acc.archivedAt !== null) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			`Asset account ${assetAccountId} is archived`,
		);
	}

	return acc;
}

function handleTransactionLifecycleError(err: unknown): never {
	if (err instanceof ManualExpenseError) {
		throw err;
	}
	if (err instanceof CanonicalTransactionError) {
		switch (err.code) {
			case "TRANSACTION_NOT_FOUND":
				throw new ManualExpenseError("MANUAL_EXPENSE_NOT_FOUND", err.message);
			case "TRANSACTION_REVISION_CONFLICT":
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_REVISION_CONFLICT",
					err.message,
				);
			case "TRANSACTION_IDEMPOTENCY_CONFLICT":
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_IDEMPOTENCY_CONFLICT",
					err.message,
				);
			case "TRANSACTION_ALREADY_VOIDED":
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_ALREADY_VOID",
					err.message,
				);
			case "TRANSACTION_INVALID_INPUT":
			default:
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_INVALID_INPUT",
					err.message,
				);
		}
	}
	if (err instanceof LedgerError) {
		throw new ManualExpenseError("MANUAL_EXPENSE_INVALID_INPUT", err.message);
	}
	throw err;
}

export interface CreateManualExpenseParams {
	amount: string;
	sourceAssetAccountId: string;
	budgetCategory: string;
	spendingCategoryId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	occurredAt?: Date | undefined;
	idempotencyKey: string;
	shortTermGoalId?: string | undefined;
}

export async function createManualExpense(
	db: Database,
	userId: string,
	params: CreateManualExpenseParams,
) {
	const amount = validateAmount(params.amount);
	const sourceAssetAccountId = validateUuid(
		params.sourceAssetAccountId,
		"sourceAssetAccountId",
	);
	const budgetCategory = validateManualExpenseBudgetCategory(
		params.budgetCategory,
	);
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			"idempotencyKey is required",
		);
	}
	const occurredAt = params.occurredAt ?? new Date();

	const spendingCategoryId = params.spendingCategoryId
		? validateUuid(params.spendingCategoryId, "spendingCategoryId")
		: undefined;
	const shortTermGoalId = params.shortTermGoalId
		? validateUuid(params.shortTermGoalId, "shortTermGoalId")
		: undefined;
	const merchant = params.merchant?.trim() || undefined;
	const description = params.description?.trim() || undefined;

	let createdTransactionId: string | undefined;

	try {
		const res = await db.transaction(async (tx) => {
			await verifyAssetAccountInTransaction(tx, userId, sourceAssetAccountId);

			const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
				tx,
				userId,
			);
			const systemRole = mapPurchaseCategoryToSystemRole(budgetCategory);
			const expenseAccountId = systemAccounts[systemRole];
			if (!expenseAccountId) {
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_INVALID_INPUT",
					`Expense account not found for role ${systemRole}`,
				);
			}

			const payload: Record<string, unknown> = {
				amount,
				sourceAssetAccountId,
				budgetCategory,
				spendingCategoryId,
				merchant,
				description,
				shortTermGoalId,
			};

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

		createdTransactionId = res.transactionId;

		// Post-commit assignment sync
		if (spendingCategoryId && createdTransactionId) {
			try {
				await upsertAssignment(db, userId, {
					subjectType: "MANUAL_EXPENSE",
					subjectId: createdTransactionId,
					categoryId: spendingCategoryId,
				});
			} catch {
				// Category assignment is secondary metadata; non-fatal
			}
		}

		return res;
	} catch (err) {
		handleTransactionLifecycleError(err);
	}
}

export interface UpdateManualExpenseParams {
	expectedRevisionNo: number;
	amount?: string | undefined;
	sourceAssetAccountId?: string | undefined;
	budgetCategory?: string | undefined;
	spendingCategoryId?: string | undefined;
	merchant?: string | undefined;
	description?: string | undefined;
	occurredAt?: Date | undefined;
	idempotencyKey: string;
	reasonNote?: string | undefined;
}

export async function updateManualExpense(
	db: Database,
	userId: string,
	expenseId: string,
	params: UpdateManualExpenseParams,
) {
	validateUuid(expenseId, "expenseId");
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			"idempotencyKey is required",
		);
	}

	try {
		const res = await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(canonicalTransactions)
				.where(
					and(
						eq(canonicalTransactions.id, expenseId),
						eq(canonicalTransactions.userId, userId),
						eq(canonicalTransactions.kind, "MANUAL_EXPENSE"),
					),
				);

			if (!current) {
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_NOT_FOUND",
					`Manual expense ${expenseId} not found`,
				);
			}

			const [latestRev] = await tx
				.select()
				.from(transactionRevisions)
				.where(eq(transactionRevisions.transactionId, expenseId))
				.orderBy(desc(transactionRevisions.revisionNo))
				.limit(1);

			if (!latestRev) {
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_NOT_FOUND",
					`No revisions found for manual expense ${expenseId}`,
				);
			}

			const currentPayload = latestRev.payload as Record<string, unknown>;

			const amount =
				params.amount !== undefined
					? validateAmount(params.amount)
					: (currentPayload.amount as string);
			const sourceAssetAccountId =
				params.sourceAssetAccountId !== undefined
					? validateUuid(params.sourceAssetAccountId, "sourceAssetAccountId")
					: (currentPayload.sourceAssetAccountId as string);
			const budgetCategory =
				params.budgetCategory !== undefined
					? validateManualExpenseBudgetCategory(params.budgetCategory)
					: (currentPayload.budgetCategory as CreditCardPurchaseBudgetCategory);

			const spendingCategoryId =
				params.spendingCategoryId !== undefined
					? params.spendingCategoryId
						? validateUuid(params.spendingCategoryId, "spendingCategoryId")
						: undefined
					: (currentPayload.spendingCategoryId as string | undefined);

			const merchant =
				params.merchant !== undefined
					? params.merchant.trim() || undefined
					: (currentPayload.merchant as string | undefined);

			const description =
				params.description !== undefined
					? params.description.trim() || undefined
					: (currentPayload.description as string | undefined);

			const occurredAt = params.occurredAt ?? latestRev.occurredAt;

			await verifyAssetAccountInTransaction(tx, userId, sourceAssetAccountId);

			const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
				tx,
				userId,
			);
			const systemRole = mapPurchaseCategoryToSystemRole(budgetCategory);
			const expenseAccountId = systemAccounts[systemRole];
			if (!expenseAccountId) {
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_INVALID_INPUT",
					`Expense account not found for role ${systemRole}`,
				);
			}

			const payload: Record<string, unknown> = {
				...currentPayload,
				amount,
				sourceAssetAccountId,
				budgetCategory,
				spendingCategoryId,
				merchant,
				description,
			};

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

			const opResult = await reviseCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				transactionId: expenseId,
				expectedRevisionNo: params.expectedRevisionNo,
				idempotencyKey,
				occurredAt,
				payload,
				reasonCode: USER_EDIT_REASON_CODE,
				reasonNote: params.reasonNote?.trim() || null,
				source: {
					type: PRODUCT_HTTP_SOURCE_TYPE,
					ref: idempotencyKey,
				},
				ledger: {
					memo: description ?? merchant ?? "Manual expense correction",
					lines,
				},
			});

			return opResult;
		});

		if (params.spendingCategoryId) {
			try {
				await upsertAssignment(db, userId, {
					subjectType: "MANUAL_EXPENSE",
					subjectId: expenseId,
					categoryId: params.spendingCategoryId,
				});
			} catch {
				// Secondary
			}
		}

		return res;
	} catch (err) {
		handleTransactionLifecycleError(err);
	}
}

export async function voidManualExpense(
	db: Database,
	userId: string,
	expenseId: string,
	params: {
		expectedRevisionNo: number;
		reason?: string | undefined;
		idempotencyKey: string;
	},
) {
	validateUuid(expenseId, "expenseId");
	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_INVALID_INPUT",
			"idempotencyKey is required",
		);
	}

	try {
		return await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(canonicalTransactions)
				.where(
					and(
						eq(canonicalTransactions.id, expenseId),
						eq(canonicalTransactions.userId, userId),
						eq(canonicalTransactions.kind, "MANUAL_EXPENSE"),
					),
				);

			if (!current) {
				throw new ManualExpenseError(
					"MANUAL_EXPENSE_NOT_FOUND",
					`Manual expense ${expenseId} not found`,
				);
			}

			return await voidCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				transactionId: expenseId,
				expectedRevisionNo: params.expectedRevisionNo,
				idempotencyKey,
				reasonCode: USER_VOID_REASON_CODE,
				reasonNote: params.reason?.trim() || null,
				source: {
					type: PRODUCT_HTTP_SOURCE_TYPE,
					ref: idempotencyKey,
				},
			});
		});
	} catch (err) {
		handleTransactionLifecycleError(err);
	}
}

export async function getManualExpense(
	db: Database,
	userId: string,
	expenseId: string,
) {
	validateUuid(expenseId, "expenseId");

	const [txRow] = await db
		.select()
		.from(canonicalTransactions)
		.where(
			and(
				eq(canonicalTransactions.id, expenseId),
				eq(canonicalTransactions.userId, userId),
				eq(canonicalTransactions.kind, "MANUAL_EXPENSE"),
			),
		);

	if (!txRow) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_NOT_FOUND",
			`Manual expense ${expenseId} not found`,
		);
	}

	const [latestRev] = await db
		.select()
		.from(transactionRevisions)
		.where(eq(transactionRevisions.transactionId, expenseId))
		.orderBy(desc(transactionRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new ManualExpenseError(
			"MANUAL_EXPENSE_NOT_FOUND",
			`No revisions found for manual expense ${expenseId}`,
		);
	}

	const payload = (latestRev.payload ?? {}) as Record<string, unknown>;
	return {
		id: txRow.id,
		userId: txRow.userId,
		kind: txRow.kind,
		status: latestRev.operation === "VOID" ? "VOIDED" : "ACTIVE",
		revisionNo: latestRev.revisionNo,
		amount: typeof payload.amount === "string" ? payload.amount : "0.00",
		occurredAt: latestRev.occurredAt.toISOString(),
		payload,
		createdAt: txRow.createdAt.toISOString(),
		updatedAt: latestRev.createdAt.toISOString(),
	};
}

export async function listManualExpenses(
	db: Database,
	userId: string,
	params: {
		limit?: number | undefined;
		status?: "ACTIVE" | "VOIDED" | undefined;
		beforeOccurredAt?: Date | undefined;
		beforeTransactionId?: string | undefined;
	},
) {
	return listCanonicalTransactions({
		db,
		userId,
		kind: "MANUAL_EXPENSE",
		limit: params.limit,
		status: params.status,
		beforeOccurredAt: params.beforeOccurredAt,
		beforeTransactionId: params.beforeTransactionId,
	});
}
