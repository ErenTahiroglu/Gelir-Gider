import { and, asc, desc, eq } from "drizzle-orm";
import type {
	Database,
	DatabaseOrTransaction,
	DatabaseTransaction,
} from "../db/client";
import { users } from "../db/schema/auth";
import {
	CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES,
	type CreditCardPurchaseBudgetCategory,
} from "../db/schema/credit-card-ledger";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	PERSON_OBLIGATION_DIRECTIONS,
	type PersonObligationDirection,
	people,
	personObligationRevisions,
	personObligations,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { formatCentsToMoney, parsePositiveMoneyString } from "../ledger/money";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import { ensureUserExpenseSystemAccountsInTransaction } from "../ledger/system-expense-accounts";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	type BoundCanonicalTransactionResult,
	createCanonicalTransactionWithLedgerInTransaction,
	reviseCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import { runPeopleReadTransaction, runPeopleTransaction } from "./boundary";
import {
	validateOccurredAt,
	validateOptionalDateFilter,
	validateOptionalIsoCalendarDate,
} from "./calendar";
import { PeopleError } from "./errors";
import {
	calculateObligationCreateFingerprint,
	calculateObligationUpdateFingerprint,
	calculateObligationVoidFingerprint,
} from "./fingerprint";
import { ensurePersonLedgerLinkInTransaction } from "./ledger-provisioning";
import {
	validateCanonicalUuid,
	validateExpectedRevisionNo,
	validateOptionalCanonicalUuid,
	validateOptionalEnum,
} from "./validation";

const OBLIGATION_STATUS_VALUES = ["OPEN", "SETTLED", "VOID"] as const;

export interface ObligationReadModel {
	obligationId: string;
	personId: string;
	direction: PersonObligationDirection;
	status: "OPEN" | "SETTLED" | "VOID";
	principalAmount: string;
	settledAmount: string;
	remainingAmount: string;
	dueDate: string | null;
	description: string | null;
	fundingAssetAccountId: string | null;
	budgetCategory: string | null;
	revisionNo: number;
	canonicalTransactionId: string;
	canonicalRevisionId: string;
}

export interface RecordPersonReceivableParams {
	db: Database;
	userId: string;
	personId: string;
	amount: string;
	fundingAssetAccountId: string;
	occurredAt: Date;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
	idempotencyKey: string;
}

export interface UpdatePersonReceivableParams {
	db: Database;
	userId: string;
	obligationId: string;
	expectedRevisionNo: number;
	amount: string;
	fundingAssetAccountId: string;
	occurredAt: Date;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
	idempotencyKey: string;
}

export interface RecordPersonPayableExpenseParams {
	db: Database;
	userId: string;
	personId: string;
	amount: string;
	budgetCategory: string;
	occurredAt: Date;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
	idempotencyKey: string;
}

export interface UpdatePersonPayableExpenseParams {
	db: Database;
	userId: string;
	obligationId: string;
	expectedRevisionNo: number;
	amount: string;
	budgetCategory: string;
	occurredAt: Date;
	dueDate?: string | null | undefined;
	description?: string | null | undefined;
	idempotencyKey: string;
}

export interface VoidPersonObligationParams {
	db: Database;
	userId: string;
	obligationId: string;
	expectedRevisionNo: number;
	idempotencyKey: string;
}

export interface GetPersonObligationParams {
	db: Database;
	userId: string;
	obligationId: string;
}

export interface ListPersonObligationsParams {
	db: Database;
	userId: string;
	personId?: string | undefined;
	direction?: PersonObligationDirection | undefined;
	status?: "OPEN" | "SETTLED" | "VOID" | undefined;
	dueDateFrom?: string | undefined;
	dueDateUntil?: string | undefined;
}

function validateUserId(value: string): string {
	return validateCanonicalUuid(value, "userId");
}

function validatePersonId(value: string): string {
	return validateCanonicalUuid(value, "personId");
}

function validateObligationId(value: string): string {
	return validateCanonicalUuid(value, "obligationId");
}

function validateAccountId(value: string, field: string): string {
	return validateCanonicalUuid(value, field);
}

function validateIdempotencyKey(value: string): string {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 128) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

function validateAmount(value: string): { normalized: string; cents: bigint } {
	try {
		return parsePositiveMoneyString(value);
	} catch (err) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid amount: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function validateDescription(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > 500) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"description must be between 1 and 500 characters when provided",
		);
	}
	return trimmed;
}

function validateDueDate(value: string | null | undefined): string | null {
	try {
		return validateOptionalIsoCalendarDate(value);
	} catch (err) {
		if (err instanceof PeopleError) throw err;
		throw new PeopleError("PEOPLE_INVALID_INPUT", "Invalid dueDate");
	}
}

function validateBudgetCategory(
	value: string,
): CreditCardPurchaseBudgetCategory {
	const upper = value?.trim().toUpperCase();
	if (
		!CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES.includes(
			upper as CreditCardPurchaseBudgetCategory,
		)
	) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid budgetCategory: "${value}". Must be one of ${CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES.join(", ")}`,
		);
	}
	return upper as CreditCardPurchaseBudgetCategory;
}

async function getLatestObligationRevision(
	dbOrTx: DatabaseOrTransaction,
	obligationId: string,
): Promise<typeof personObligationRevisions.$inferSelect | null> {
	const [latest] = await dbOrTx
		.select()
		.from(personObligationRevisions)
		.where(eq(personObligationRevisions.obligationId, obligationId))
		.orderBy(desc(personObligationRevisions.revisionNo))
		.limit(1);
	return latest ?? null;
}

async function getActiveSettledAmountCents(
	dbOrTx: DatabaseOrTransaction,
	obligationId: string,
): Promise<bigint> {
	const settlements = await dbOrTx
		.select({ id: personSettlements.id })
		.from(personSettlements)
		.where(eq(personSettlements.obligationId, obligationId));

	let total = 0n;
	for (const s of settlements) {
		const [latestRev] = await dbOrTx
			.select()
			.from(personSettlementRevisions)
			.where(eq(personSettlementRevisions.settlementId, s.id))
			.orderBy(desc(personSettlementRevisions.revisionNo))
			.limit(1);

		if (latestRev && latestRev.operation !== "VOID") {
			total += parsePositiveMoneyString(latestRev.appliedAmount).cents;
		}
	}
	return total;
}

function buildObligationReadModel(
	obligation: {
		id: string;
		personId: string;
		direction: string;
		canonicalTransactionId: string;
	},
	latestRev: typeof personObligationRevisions.$inferSelect,
	activeSettledCents: bigint,
): ObligationReadModel {
	const principalCents = parsePositiveMoneyString(
		latestRev.principalAmount,
	).cents;
	const isVoid = latestRev.operation === "VOID";
	const remainingCents = isVoid ? 0n : principalCents - activeSettledCents;

	if (remainingCents < 0n) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			`Obligation ${obligation.id} has an invalid negative derived remaining amount`,
		);
	}

	const status: "OPEN" | "SETTLED" | "VOID" = isVoid
		? "VOID"
		: remainingCents === 0n
			? "SETTLED"
			: "OPEN";

	return {
		obligationId: obligation.id,
		personId: obligation.personId,
		direction: obligation.direction as PersonObligationDirection,
		status,
		principalAmount: latestRev.principalAmount,
		settledAmount: formatCentsToMoney(activeSettledCents),
		remainingAmount: formatCentsToMoney(remainingCents),
		dueDate: latestRev.dueDate,
		description: latestRev.description,
		fundingAssetAccountId: latestRev.fundingAssetAccountId,
		budgetCategory: latestRev.budgetCategory,
		revisionNo: latestRev.revisionNo,
		canonicalTransactionId: obligation.canonicalTransactionId,
		canonicalRevisionId: latestRev.canonicalRevisionId,
	};
}

async function validateFundingAssetAccount(
	tx: DatabaseTransaction,
	userId: string,
	accountId: string,
): Promise<void> {
	const [account] = await tx
		.select()
		.from(ledgerAccounts)
		.where(
			and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.userId, userId)),
		)
		.limit(1);

	if (!account) {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			`Funding asset account "${accountId}" not found for this user`,
		);
	}
	if (account.accountType !== "ASSET" || account.normalBalance !== "DEBIT") {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			"Funding asset account must have accountType='ASSET' and normalBalance='DEBIT'",
		);
	}
	if (account.archivedAt !== null) {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			"Funding asset account is archived",
		);
	}

	const [user] = await tx
		.select({ currency: users.currency })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) {
		throw new PeopleError("PEOPLE_INVALID_INPUT", "User does not exist");
	}
	if (account.currency !== user.currency) {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			`Funding asset account currency '${account.currency}' does not match user currency '${user.currency}'`,
		);
	}
}

async function lockPersonAndVerifyActive(
	tx: DatabaseTransaction,
	userId: string,
	personId: string,
): Promise<void> {
	const [person] = await tx
		.select({ id: people.id })
		.from(people)
		.where(and(eq(people.id, personId), eq(people.userId, userId)))
		.for("update");

	if (!person) {
		throw new PeopleError("PEOPLE_NOT_FOUND", `Person "${personId}" not found`);
	}

	const [latestPersonRev] = await tx
		.select({ status: personRevisions.status })
		.from(personRevisions)
		.where(eq(personRevisions.personId, personId))
		.orderBy(desc(personRevisions.revisionNo))
		.limit(1);

	if (latestPersonRev?.status !== "ACTIVE") {
		throw new PeopleError(
			"PEOPLE_NOT_ACTIVE",
			`Person "${personId}" is not active`,
		);
	}
}

interface ObligationCreateCore {
	direction: PersonObligationDirection;
	canonicalKind: "PERSON_RECEIVABLE_ADVANCE" | "PERSON_PAYABLE_EXPENSE";
	userId: string;
	personId: string;
	amountNormalized: string;
	fundingAssetAccountId: string | null;
	budgetCategory: string | null;
	dueDate: string | null;
	description: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

async function recordObligationCore(
	db: Database,
	core: ObligationCreateCore,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	return runPeopleTransaction(db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(
				and(
					eq(personObligationRevisions.userId, core.userId),
					eq(personObligationRevisions.idempotencyKey, core.idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkObligationCreateReplay(tx, earlyRev, core);
		}

		await lockPersonAndVerifyActive(tx, core.userId, core.personId);

		const [secondRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(
				and(
					eq(personObligationRevisions.userId, core.userId),
					eq(personObligationRevisions.idempotencyKey, core.idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkObligationCreateReplay(tx, secondRev, core);
		}

		const link = await ensurePersonLedgerLinkInTransaction(
			tx,
			core.userId,
			core.personId,
		);

		let ledgerLines: {
			accountId: string;
			side: "DEBIT" | "CREDIT";
			amount: string;
		}[];

		if (core.direction === "RECEIVABLE") {
			if (!core.fundingAssetAccountId) {
				throw new PeopleError(
					"PEOPLE_INVALID_INPUT",
					"fundingAssetAccountId is required for receivable obligations",
				);
			}
			await validateFundingAssetAccount(
				tx,
				core.userId,
				core.fundingAssetAccountId,
			);
			await lockLedgerAccountsInTransaction({
				tx,
				userId: core.userId,
				accountIds: [link.receivableAccountId, core.fundingAssetAccountId],
			});
			ledgerLines = [
				{
					accountId: link.receivableAccountId,
					side: "DEBIT",
					amount: core.amountNormalized,
				},
				{
					accountId: core.fundingAssetAccountId,
					side: "CREDIT",
					amount: core.amountNormalized,
				},
			];
		} else {
			if (!core.budgetCategory) {
				throw new PeopleError(
					"PEOPLE_INVALID_INPUT",
					"budgetCategory is required for payable obligations",
				);
			}
			const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
				tx,
				core.userId,
			);
			const roleMap: Record<string, keyof typeof systemAccounts> = {
				MANDATORY_EXPENSE: "MANDATORY_EXPENSE",
				DISCRETIONARY_SPEND: "DISCRETIONARY_EXPENSE",
				SHORT_TERM_PURCHASE: "SHORT_TERM_PURCHASE",
				UNCLASSIFIED: "UNCLASSIFIED_EXPENSE",
			};
			const role = roleMap[core.budgetCategory];
			if (!role) {
				throw new PeopleError(
					"PEOPLE_INVALID_INPUT",
					`Unknown budgetCategory: ${core.budgetCategory}`,
				);
			}
			const expenseAccountId = systemAccounts[role];
			await lockLedgerAccountsInTransaction({
				tx,
				userId: core.userId,
				accountIds: [link.payableAccountId, expenseAccountId],
			});
			ledgerLines = [
				{
					accountId: expenseAccountId,
					side: "DEBIT",
					amount: core.amountNormalized,
				},
				{
					accountId: link.payableAccountId,
					side: "CREDIT",
					amount: core.amountNormalized,
				},
			];
		}

		const obligationId = crypto.randomUUID();

		const canonicalPayload: Record<string, unknown> = {
			obligationId,
			personId: core.personId,
			direction: core.direction,
			amount: core.amountNormalized,
			dueDate: core.dueDate,
			description: core.description,
		};
		if (core.direction === "RECEIVABLE") {
			canonicalPayload.fundingAssetAccountId = core.fundingAssetAccountId;
		} else {
			canonicalPayload.budgetCategory = core.budgetCategory;
		}

		const boundRes = await createCanonicalTransactionWithLedgerInTransaction({
			tx,
			userId: core.userId,
			kind: core.canonicalKind,
			idempotencyKey: core.idempotencyKey,
			occurredAt: core.occurredAt,
			payload: canonicalPayload,
			source: { type: core.canonicalKind, ref: core.idempotencyKey },
			ledger: {
				memo:
					core.direction === "RECEIVABLE"
						? "Person receivable advance"
						: "Person payable expense",
				lines: ledgerLines,
			},
		});

		await tx.insert(personObligations).values({
			id: obligationId,
			userId: core.userId,
			personId: core.personId,
			direction: core.direction,
			canonicalTransactionId: boundRes.transactionId,
		});

		const fingerprint = await calculateObligationCreateFingerprint({
			userId: core.userId,
			personId: core.personId,
			direction: core.direction,
			amount: core.amountNormalized,
			fundingAssetAccountId: core.fundingAssetAccountId,
			budgetCategory: core.budgetCategory,
			dueDate: core.dueDate,
			description: core.description,
			occurredAt: core.occurredAt,
		});

		const [insertedRev] = await tx
			.insert(personObligationRevisions)
			.values({
				userId: core.userId,
				obligationId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				principalAmount: core.amountNormalized,
				fundingAssetAccountId: core.fundingAssetAccountId,
				budgetCategory: core.budgetCategory,
				dueDate: core.dueDate,
				description: core.description,
				occurredAt: core.occurredAt,
				canonicalRevisionId: boundRes.revisionId,
				idempotencyKey: core.idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person obligation revision",
			);
		}

		return {
			obligation: buildObligationReadModel(
				{
					id: obligationId,
					personId: core.personId,
					direction: core.direction,
					canonicalTransactionId: boundRes.transactionId,
				},
				insertedRev,
				0n,
			),
			idempotentReplay: false,
		};
	});
}

async function checkObligationCreateReplay(
	tx: DatabaseTransaction,
	existingRev: typeof personObligationRevisions.$inferSelect,
	core: ObligationCreateCore,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculateObligationCreateFingerprint({
		userId: core.userId,
		personId: core.personId,
		direction: core.direction,
		amount: core.amountNormalized,
		fundingAssetAccountId: core.fundingAssetAccountId,
		budgetCategory: core.budgetCategory,
		dueDate: core.dueDate,
		description: core.description,
		occurredAt: core.occurredAt,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different obligation payload",
		);
	}

	const [obligation] = await tx
		.select()
		.from(personObligations)
		.where(eq(personObligations.id, existingRev.obligationId))
		.limit(1);

	if (!obligation) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Obligation anchor missing on replay",
		);
	}

	const activeSettled = await getActiveSettledAmountCents(tx, obligation.id);

	return {
		obligation: buildObligationReadModel(
			obligation,
			existingRev,
			activeSettled,
		),
		idempotentReplay: true,
	};
}

/**
 * Records a standalone receivable advance: user paid/advanced money on behalf of a person.
 * Ledger: Dr Person Receivable, Cr Funding Asset. Not an expense or income.
 */
export async function recordPersonReceivable(
	params: RecordPersonReceivableParams,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const personId = validatePersonId(params.personId);
	const amount = validateAmount(params.amount);
	const fundingAssetAccountId = validateAccountId(
		params.fundingAssetAccountId,
		"fundingAssetAccountId",
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const dueDate = validateDueDate(params.dueDate);
	const description = validateDescription(params.description);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	return recordObligationCore(params.db, {
		direction: "RECEIVABLE",
		canonicalKind: "PERSON_RECEIVABLE_ADVANCE",
		userId,
		personId,
		amountNormalized: amount.normalized,
		fundingAssetAccountId,
		budgetCategory: null,
		dueDate,
		description,
		occurredAt,
		idempotencyKey,
	});
}

/**
 * Records a standalone payable expense: a person paid an expense for the user.
 * Ledger: Dr Personal Expense (by budgetCategory), Cr Person Payable.
 */
export async function recordPersonPayableExpense(
	params: RecordPersonPayableExpenseParams,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const personId = validatePersonId(params.personId);
	const amount = validateAmount(params.amount);
	const budgetCategory = validateBudgetCategory(params.budgetCategory);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const dueDate = validateDueDate(params.dueDate);
	const description = validateDescription(params.description);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	return recordObligationCore(params.db, {
		direction: "PAYABLE",
		canonicalKind: "PERSON_PAYABLE_EXPENSE",
		userId,
		personId,
		amountNormalized: amount.normalized,
		fundingAssetAccountId: null,
		budgetCategory,
		dueDate,
		description,
		occurredAt,
		idempotencyKey,
	});
}

interface ObligationUpdateCore {
	direction: PersonObligationDirection;
	canonicalKind: "PERSON_RECEIVABLE_ADVANCE" | "PERSON_PAYABLE_EXPENSE";
	userId: string;
	obligationId: string;
	expectedRevisionNo: number;
	amountNormalized: string;
	fundingAssetAccountId: string | null;
	budgetCategory: string | null;
	dueDate: string | null;
	description: string | null;
	occurredAt: Date;
	idempotencyKey: string;
}

async function updateObligationCore(
	db: Database,
	core: ObligationUpdateCore,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	return runPeopleTransaction(db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(
				and(
					eq(personObligationRevisions.userId, core.userId),
					eq(personObligationRevisions.idempotencyKey, core.idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkObligationUpdateReplay(tx, earlyRev, core);
		}

		const [peek] = await tx
			.select()
			.from(personObligations)
			.where(
				and(
					eq(personObligations.id, core.obligationId),
					eq(personObligations.userId, core.userId),
				),
			)
			.limit(1);

		if (!peek) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				`Obligation "${core.obligationId}" not found`,
			);
		}
		if (peek.direction !== core.direction) {
			throw new PeopleError(
				"PEOPLE_INVALID_INPUT",
				`Obligation "${core.obligationId}" direction does not match this operation`,
			);
		}

		await lockPersonAndVerifyActive(tx, core.userId, peek.personId);

		await tx
			.select({ id: personObligations.id })
			.from(personObligations)
			.where(eq(personObligations.id, core.obligationId))
			.for("update");

		const [secondRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(
				and(
					eq(personObligationRevisions.userId, core.userId),
					eq(personObligationRevisions.idempotencyKey, core.idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkObligationUpdateReplay(tx, secondRev, core);
		}

		const latest = await getLatestObligationRevision(tx, core.obligationId);
		if (!latest) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				"Obligation has no revisions",
			);
		}
		if (latest.operation === "VOID") {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_ACTIVE",
				`Obligation "${core.obligationId}" is VOID`,
			);
		}
		if (latest.revisionNo !== core.expectedRevisionNo) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_REVISION_CONFLICT",
				`Expected revision ${core.expectedRevisionNo} but latest is ${latest.revisionNo}`,
			);
		}

		const activeSettledCents = await getActiveSettledAmountCents(
			tx,
			core.obligationId,
		);
		if (
			parsePositiveMoneyString(core.amountNormalized).cents < activeSettledCents
		) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
				`Cannot revise principal below active settled amount ${formatCentsToMoney(activeSettledCents)}`,
			);
		}

		const link = await ensurePersonLedgerLinkInTransaction(
			tx,
			core.userId,
			peek.personId,
		);

		let ledgerLines: {
			accountId: string;
			side: "DEBIT" | "CREDIT";
			amount: string;
		}[];

		if (core.direction === "RECEIVABLE") {
			if (!core.fundingAssetAccountId) {
				throw new PeopleError(
					"PEOPLE_INVALID_INPUT",
					"fundingAssetAccountId is required for receivable obligations",
				);
			}
			await validateFundingAssetAccount(
				tx,
				core.userId,
				core.fundingAssetAccountId,
			);
			await lockLedgerAccountsInTransaction({
				tx,
				userId: core.userId,
				accountIds: [link.receivableAccountId, core.fundingAssetAccountId],
			});
			ledgerLines = [
				{
					accountId: link.receivableAccountId,
					side: "DEBIT",
					amount: core.amountNormalized,
				},
				{
					accountId: core.fundingAssetAccountId,
					side: "CREDIT",
					amount: core.amountNormalized,
				},
			];
		} else {
			if (!core.budgetCategory) {
				throw new PeopleError(
					"PEOPLE_INVALID_INPUT",
					"budgetCategory is required for payable obligations",
				);
			}
			const systemAccounts = await ensureUserExpenseSystemAccountsInTransaction(
				tx,
				core.userId,
			);
			const roleMap: Record<string, keyof typeof systemAccounts> = {
				MANDATORY_EXPENSE: "MANDATORY_EXPENSE",
				DISCRETIONARY_SPEND: "DISCRETIONARY_EXPENSE",
				SHORT_TERM_PURCHASE: "SHORT_TERM_PURCHASE",
				UNCLASSIFIED: "UNCLASSIFIED_EXPENSE",
			};
			const role = roleMap[core.budgetCategory];
			if (!role) {
				throw new PeopleError(
					"PEOPLE_INVALID_INPUT",
					`Unknown budgetCategory: ${core.budgetCategory}`,
				);
			}
			const expenseAccountId = systemAccounts[role];
			await lockLedgerAccountsInTransaction({
				tx,
				userId: core.userId,
				accountIds: [link.payableAccountId, expenseAccountId],
			});
			ledgerLines = [
				{
					accountId: expenseAccountId,
					side: "DEBIT",
					amount: core.amountNormalized,
				},
				{
					accountId: link.payableAccountId,
					side: "CREDIT",
					amount: core.amountNormalized,
				},
			];
		}

		const canonicalPayload: Record<string, unknown> = {
			obligationId: core.obligationId,
			personId: peek.personId,
			direction: core.direction,
			amount: core.amountNormalized,
			dueDate: core.dueDate,
			description: core.description,
		};
		if (core.direction === "RECEIVABLE") {
			canonicalPayload.fundingAssetAccountId = core.fundingAssetAccountId;
		} else {
			canonicalPayload.budgetCategory = core.budgetCategory;
		}

		let boundRes: BoundCanonicalTransactionResult;
		try {
			boundRes = await reviseCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId: core.userId,
				transactionId: peek.canonicalTransactionId,
				expectedRevisionNo: core.expectedRevisionNo,
				idempotencyKey: core.idempotencyKey,
				occurredAt: core.occurredAt,
				payload: canonicalPayload,
				reasonCode: "PERSON_OBLIGATION_UPDATE",
				reasonNote: null,
				source: { type: core.canonicalKind, ref: core.idempotencyKey },
				ledger: {
					memo:
						core.direction === "RECEIVABLE"
							? "Person receivable advance (revised)"
							: "Person payable expense (revised)",
					lines: ledgerLines,
				},
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_REVISION_CONFLICT"
			) {
				throw new PeopleError(
					"PEOPLE_OBLIGATION_REVISION_CONFLICT",
					"Obligation revision conflict",
				);
			}
			throw err;
		}

		if (boundRes.idempotentReplay) {
			const [existingDomainRev] = await tx
				.select()
				.from(personObligationRevisions)
				.where(
					eq(
						personObligationRevisions.canonicalRevisionId,
						boundRes.revisionId,
					),
				)
				.limit(1);

			if (!existingDomainRev) {
				throw new PeopleError(
					"PEOPLE_INVALID_STATE",
					"Canonical revision replayed but domain projection is missing",
				);
			}

			const activeSettled = await getActiveSettledAmountCents(
				tx,
				core.obligationId,
			);
			return {
				obligation: buildObligationReadModel(
					peek,
					existingDomainRev,
					activeSettled,
				),
				idempotentReplay: true,
			};
		}

		const fingerprint = await calculateObligationUpdateFingerprint({
			userId: core.userId,
			obligationId: core.obligationId,
			expectedRevisionNo: core.expectedRevisionNo,
			amount: core.amountNormalized,
			fundingAssetAccountId: core.fundingAssetAccountId,
			budgetCategory: core.budgetCategory,
			dueDate: core.dueDate,
			description: core.description,
			occurredAt: core.occurredAt,
		});

		const [insertedRev] = await tx
			.insert(personObligationRevisions)
			.values({
				userId: core.userId,
				obligationId: core.obligationId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				principalAmount: core.amountNormalized,
				fundingAssetAccountId: core.fundingAssetAccountId,
				budgetCategory: core.budgetCategory,
				dueDate: core.dueDate,
				description: core.description,
				occurredAt: core.occurredAt,
				canonicalRevisionId: boundRes.revisionId,
				idempotencyKey: core.idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person obligation update revision",
			);
		}

		const activeSettled = await getActiveSettledAmountCents(
			tx,
			core.obligationId,
		);

		return {
			obligation: buildObligationReadModel(peek, insertedRev, activeSettled),
			idempotentReplay: false,
		};
	});
}

async function checkObligationUpdateReplay(
	tx: DatabaseTransaction,
	existingRev: typeof personObligationRevisions.$inferSelect,
	core: ObligationUpdateCore,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculateObligationUpdateFingerprint({
		userId: core.userId,
		obligationId: core.obligationId,
		expectedRevisionNo: core.expectedRevisionNo,
		amount: core.amountNormalized,
		fundingAssetAccountId: core.fundingAssetAccountId,
		budgetCategory: core.budgetCategory,
		dueDate: core.dueDate,
		description: core.description,
		occurredAt: core.occurredAt,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different obligation update payload",
		);
	}

	const [obligation] = await tx
		.select()
		.from(personObligations)
		.where(eq(personObligations.id, existingRev.obligationId))
		.limit(1);

	if (!obligation) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Obligation anchor missing on replay",
		);
	}

	const activeSettled = await getActiveSettledAmountCents(tx, obligation.id);

	return {
		obligation: buildObligationReadModel(
			obligation,
			existingRev,
			activeSettled,
		),
		idempotentReplay: true,
	};
}

/**
 * Updates a standalone receivable obligation. Requires expectedRevisionNo (OCC).
 */
export async function updatePersonReceivable(
	params: UpdatePersonReceivableParams,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const obligationId = validateObligationId(params.obligationId);
	const amount = validateAmount(params.amount);
	const fundingAssetAccountId = validateAccountId(
		params.fundingAssetAccountId,
		"fundingAssetAccountId",
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const dueDate = validateDueDate(params.dueDate);
	const description = validateDescription(params.description);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	return updateObligationCore(params.db, {
		direction: "RECEIVABLE",
		canonicalKind: "PERSON_RECEIVABLE_ADVANCE",
		userId,
		obligationId,
		expectedRevisionNo,
		amountNormalized: amount.normalized,
		fundingAssetAccountId,
		budgetCategory: null,
		dueDate,
		description,
		occurredAt,
		idempotencyKey,
	});
}

/**
 * Updates a standalone payable expense obligation. Requires expectedRevisionNo (OCC).
 */
export async function updatePersonPayableExpense(
	params: UpdatePersonPayableExpenseParams,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const obligationId = validateObligationId(params.obligationId);
	const amount = validateAmount(params.amount);
	const budgetCategory = validateBudgetCategory(params.budgetCategory);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const dueDate = validateDueDate(params.dueDate);
	const description = validateDescription(params.description);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	return updateObligationCore(params.db, {
		direction: "PAYABLE",
		canonicalKind: "PERSON_PAYABLE_EXPENSE",
		userId,
		obligationId,
		expectedRevisionNo,
		amountNormalized: amount.normalized,
		fundingAssetAccountId: null,
		budgetCategory,
		dueDate,
		description,
		occurredAt,
		idempotencyKey,
	});
}

/**
 * Voids a standalone obligation. Requires activeSettledAmount = 0.
 */
export async function voidPersonObligation(
	params: VoidPersonObligationParams,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const obligationId = validateObligationId(params.obligationId);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	return runPeopleTransaction(params.db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(
				and(
					eq(personObligationRevisions.userId, userId),
					eq(personObligationRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkObligationVoidReplay(
				tx,
				earlyRev,
				userId,
				obligationId,
				expectedRevisionNo,
			);
		}

		const [peek] = await tx
			.select()
			.from(personObligations)
			.where(
				and(
					eq(personObligations.id, obligationId),
					eq(personObligations.userId, userId),
				),
			)
			.limit(1);

		if (!peek) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				`Obligation "${obligationId}" not found`,
			);
		}

		await lockPersonAndVerifyActive(tx, userId, peek.personId);

		await tx
			.select({ id: personObligations.id })
			.from(personObligations)
			.where(eq(personObligations.id, obligationId))
			.for("update");

		const [secondRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(
				and(
					eq(personObligationRevisions.userId, userId),
					eq(personObligationRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkObligationVoidReplay(
				tx,
				secondRev,
				userId,
				obligationId,
				expectedRevisionNo,
			);
		}

		const latest = await getLatestObligationRevision(tx, obligationId);
		if (!latest) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				"Obligation has no revisions",
			);
		}
		if (latest.operation === "VOID") {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_ACTIVE",
				`Obligation "${obligationId}" is already VOID`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but latest is ${latest.revisionNo}`,
			);
		}

		const activeSettledCents = await getActiveSettledAmountCents(
			tx,
			obligationId,
		);
		if (activeSettledCents !== 0n) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
				`Cannot VOID obligation with active settled amount ${formatCentsToMoney(activeSettledCents)}. Void settlements first.`,
			);
		}

		const canonicalKind:
			| "PERSON_RECEIVABLE_ADVANCE"
			| "PERSON_PAYABLE_EXPENSE" =
			peek.direction === "RECEIVABLE"
				? "PERSON_RECEIVABLE_ADVANCE"
				: "PERSON_PAYABLE_EXPENSE";

		let boundRes: BoundCanonicalTransactionResult;
		try {
			boundRes = await voidCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				transactionId: peek.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey,
				reasonCode: "PERSON_OBLIGATION_VOID",
				reasonNote: null,
				source: { type: canonicalKind, ref: idempotencyKey },
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_REVISION_CONFLICT"
			) {
				throw new PeopleError(
					"PEOPLE_OBLIGATION_REVISION_CONFLICT",
					"Obligation revision conflict",
				);
			}
			throw err;
		}

		if (boundRes.idempotentReplay) {
			const [existingDomainRev] = await tx
				.select()
				.from(personObligationRevisions)
				.where(
					eq(
						personObligationRevisions.canonicalRevisionId,
						boundRes.revisionId,
					),
				)
				.limit(1);

			if (!existingDomainRev) {
				throw new PeopleError(
					"PEOPLE_INVALID_STATE",
					"Canonical VOID replayed but domain projection is missing",
				);
			}

			return {
				obligation: buildObligationReadModel(peek, existingDomainRev, 0n),
				idempotentReplay: true,
			};
		}

		const fingerprint = await calculateObligationVoidFingerprint({
			userId,
			obligationId,
			expectedRevisionNo,
		});

		const [insertedRev] = await tx
			.insert(personObligationRevisions)
			.values({
				userId,
				obligationId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "VOID",
				principalAmount: latest.principalAmount,
				fundingAssetAccountId: latest.fundingAssetAccountId,
				budgetCategory: latest.budgetCategory,
				dueDate: latest.dueDate,
				description: latest.description,
				occurredAt: latest.occurredAt,
				canonicalRevisionId: boundRes.revisionId,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person obligation void revision",
			);
		}

		return {
			obligation: buildObligationReadModel(peek, insertedRev, 0n),
			idempotentReplay: false,
		};
	});
}

async function checkObligationVoidReplay(
	tx: DatabaseTransaction,
	existingRev: typeof personObligationRevisions.$inferSelect,
	userId: string,
	obligationId: string,
	expectedRevisionNo: number,
): Promise<{ obligation: ObligationReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculateObligationVoidFingerprint({
		userId,
		obligationId,
		expectedRevisionNo,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different obligation void payload",
		);
	}

	const [obligation] = await tx
		.select()
		.from(personObligations)
		.where(eq(personObligations.id, existingRev.obligationId))
		.limit(1);

	if (!obligation) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Obligation anchor missing on replay",
		);
	}

	return {
		obligation: buildObligationReadModel(obligation, existingRev, 0n),
		idempotentReplay: true,
	};
}

/**
 * Reads a single obligation with live-derived settled/remaining amounts.
 * Executes inside one transaction/snapshot and routes all errors through the
 * People error boundary.
 */
export async function getPersonObligation({
	db,
	userId,
	obligationId,
}: GetPersonObligationParams): Promise<ObligationReadModel> {
	const validUserId = validateUserId(userId);
	const validObligationId = validateObligationId(obligationId);

	return runPeopleReadTransaction(db, async (tx) => {
		const [obligation] = await tx
			.select()
			.from(personObligations)
			.where(
				and(
					eq(personObligations.id, validObligationId),
					eq(personObligations.userId, validUserId),
				),
			)
			.limit(1);

		if (!obligation) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				`Obligation "${validObligationId}" not found`,
			);
		}

		const latest = await getLatestObligationRevision(tx, validObligationId);
		if (!latest) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Obligation has no revisions",
			);
		}

		const activeSettled = await getActiveSettledAmountCents(
			tx,
			validObligationId,
		);

		return buildObligationReadModel(obligation, latest, activeSettled);
	});
}

/**
 * Lists obligations for a user with optional filters and stable deterministic ordering.
 */
export async function listPersonObligations({
	db,
	userId,
	personId,
	direction,
	status,
	dueDateFrom,
	dueDateUntil,
}: ListPersonObligationsParams): Promise<ObligationReadModel[]> {
	const validUserId = validateUserId(userId);
	const validPersonId = validateOptionalCanonicalUuid(personId, "personId");
	const validDirection = validateOptionalEnum(
		direction,
		PERSON_OBLIGATION_DIRECTIONS,
		"direction",
	);
	const validStatus = validateOptionalEnum(
		status,
		OBLIGATION_STATUS_VALUES,
		"status",
	);
	const validDueDateFrom = validateOptionalDateFilter(
		dueDateFrom,
		"dueDateFrom",
	);
	const validDueDateUntil = validateOptionalDateFilter(
		dueDateUntil,
		"dueDateUntil",
	);

	if (
		validDueDateFrom !== undefined &&
		validDueDateUntil !== undefined &&
		validDueDateFrom > validDueDateUntil
	) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"dueDateFrom must be less than or equal to dueDateUntil",
		);
	}

	return runPeopleReadTransaction(db, async (tx) => {
		const conditions = [eq(personObligations.userId, validUserId)];
		if (validPersonId !== undefined) {
			conditions.push(eq(personObligations.personId, validPersonId));
		}
		if (validDirection !== undefined) {
			conditions.push(eq(personObligations.direction, validDirection));
		}

		const rows = await tx
			.select()
			.from(personObligations)
			.where(and(...conditions))
			.orderBy(asc(personObligations.createdAt), asc(personObligations.id));

		const results: ObligationReadModel[] = [];
		for (const row of rows) {
			const latest = await getLatestObligationRevision(tx, row.id);
			if (!latest) continue;

			const activeSettled = await getActiveSettledAmountCents(tx, row.id);
			const model = buildObligationReadModel(row, latest, activeSettled);

			if (validStatus !== undefined && model.status !== validStatus) continue;
			if (validDueDateFrom !== undefined) {
				if (model.dueDate === null || model.dueDate < validDueDateFrom) {
					continue;
				}
			}
			if (validDueDateUntil !== undefined) {
				if (model.dueDate === null || model.dueDate > validDueDateUntil) {
					continue;
				}
			}

			results.push(model);
		}

		return results;
	});
}
