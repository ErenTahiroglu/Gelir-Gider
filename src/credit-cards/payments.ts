import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import { users } from "../db/schema/auth";
import { creditCardStatementPaymentEvents } from "../db/schema/credit-card-ledger";
import {
	type CreditCardReservePlacement,
	creditCardRevisions,
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "../db/schema/credit-cards";
import { ledgerAccounts } from "../db/schema/ledger";
import { midasAccounts } from "../db/schema/midas";
import { transactionRevisions } from "../db/schema/transactions";
import { getLedgerAccountBalanceInTransaction } from "../ledger/balances";
import {
	formatSignedCentsToMoney,
	parseSignedAggregateMoneyString,
} from "../ledger/money";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import { MidasError } from "../midas/errors";
import {
	createMidasAllocationTransferInTransaction,
	getMidasLiquidityStateInTransaction,
	lockMidasAllocationStateInTransaction,
} from "../midas/service";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import {
	mapDbError,
	mapMidasError,
	runCreditCardTransaction,
} from "./boundary";
import {
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validatePaymentMethod,
} from "./calendar";
import { CreditCardError } from "./errors";
import {
	calculateStatementPayFingerprint,
	calculateStatementReopenFingerprint,
	generateCardReserveMidasKey,
} from "./fingerprint";
import { ensureCreditCardLedgerLinkInTransaction } from "./ledger-provisioning";
import type { CreditCardStatementLifecycleResult } from "./service";

// ============================================================================
// Params & Result Interfaces
// ============================================================================

export interface PayCreditCardStatementInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	paymentAmount?: string | undefined;
	paymentMethod?: "MIDAS_FUND" | "OUTSIDE_MIDAS" | undefined;
	paymentAssetAccountId?: string | undefined;
	outsidePaymentAssetAccountId?: string | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface PayCreditCardStatementParams {
	db: Database;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	paymentAmount?: string | undefined;
	paymentMethod?: "MIDAS_FUND" | "OUTSIDE_MIDAS" | undefined;
	paymentAssetAccountId?: string | undefined;
	outsidePaymentAssetAccountId?: string | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ReopenCreditCardStatementPaymentInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ReopenCreditCardStatementPaymentParams {
	db: Database;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	reasonNote?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ReconcileCreditCardStatementInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	statementId: string;
}

export interface ReconcileCreditCardStatementParams {
	db: Database;
	userId: string;
	statementId: string;
}

export interface CreditCardStatementReconciliationResult {
	statementId: string;
	cardId: string;
	statementAmount: string;
	cardLiabilityBalance: string;
	reservePlacement: CreditCardReservePlacement;
	reserveAmount: string;
	liabilityCoverage: "READY" | "SHORTFALL";
	liabilityAfterPayment: string;
}

// ============================================================================
// Statement Payment Lifecycle
// ============================================================================

/**
 * Pays an OPEN credit card statement inside a transaction.
 * DR Credit Card Liability, CR Payment Asset Account.
 * Releases Midas virtual reserve back to unallocated pool if reservePlacement === "MIDAS_FUND".
 */
export async function payCreditCardStatementInTransaction({
	tx,
	userId,
	statementId,
	expectedRevisionNo,
	paymentAmount,
	paymentMethod,
	paymentAssetAccountId,
	outsidePaymentAssetAccountId,
	occurredAt,
	idempotencyKey,
}: PayCreditCardStatementInTransactionParams): Promise<CreditCardStatementLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatementId = validateCcCanonicalUuid(statementId, "statementId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	if (
		outsidePaymentAssetAccountId !== undefined &&
		outsidePaymentAssetAccountId !== null &&
		paymentAssetAccountId !== undefined &&
		paymentAssetAccountId !== null
	) {
		const normOutside = validateCcCanonicalUuid(
			outsidePaymentAssetAccountId,
			"outsidePaymentAssetAccountId",
		);
		const normPayment = validateCcCanonicalUuid(
			paymentAssetAccountId,
			"paymentAssetAccountId",
		);
		if (normOutside !== normPayment) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"outsidePaymentAssetAccountId and paymentAssetAccountId cannot differ",
			);
		}
	}

	const candidateAssetId =
		outsidePaymentAssetAccountId ?? paymentAssetAccountId;

	const [earlyRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, validUserId),
				eq(creditCardStatementRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkStatementPayReplay(
			tx,
			earlyRev,
			validUserId,
			validStatementId,
			validExpectedRev,
			validOccurredAt,
			paymentAmount,
			paymentMethod,
			candidateAssetId,
		);
	}

	// 2. Lock Statement Anchor FOR UPDATE
	const [statement] = await tx
		.select({
			id: creditCardStatements.id,
			creditCardId: creditCardStatements.creditCardId,
			userId: creditCardStatements.userId,
			midasAccountId: creditCardStatements.midasAccountId,
			midasReserveBucketId: creditCardStatements.midasReserveBucketId,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, validStatementId),
				eq(creditCardStatements.userId, validUserId),
			),
		)
		.for("update");

	if (!statement) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			`Statement "${validStatementId}" not found`,
		);
	}

	// 4.1 SECOND IDEMPOTENCY REPLAY CHECK (under lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, validUserId),
				eq(creditCardStatementRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkStatementPayReplay(
			tx,
			secondRev,
			validUserId,
			validStatementId,
			validExpectedRev,
			validOccurredAt,
			paymentAmount,
			paymentMethod,
			candidateAssetId,
		);
	}

	// 5. Fetch latest statement revision
	const [latestRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, validStatementId))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for statement "${validStatementId}"`,
		);
	}

	if (latestRev.operation === "VOID" || latestRev.status === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_OPEN",
			`Statement "${validStatementId}" is voided`,
		);
	}

	if (latestRev.status === "PAID") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_ALREADY_PAID",
			`Statement "${validStatementId}" is already paid`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	// 6. Authoritative Payment Amount & Method Derivation
	const authoritativeAmount = latestRev.statementAmount;
	const authoritativeMethod =
		latestRev.reservePlacement as CreditCardReservePlacement;

	// Validate caller assertions if provided
	if (paymentAmount !== undefined && paymentAmount !== null) {
		const validPassedAmount = validateCcPositiveMoneyString(
			paymentAmount,
			"paymentAmount",
		).normalized;
		if (validPassedAmount !== authoritativeAmount) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Payment amount "${validPassedAmount}" does not match statement amount "${authoritativeAmount}"`,
			);
		}
	}

	if (paymentMethod !== undefined && paymentMethod !== null) {
		const validPassedMethod = validatePaymentMethod(paymentMethod);
		if (validPassedMethod !== authoritativeMethod) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				`Payment method "${validPassedMethod}" does not match statement reserve placement "${authoritativeMethod}"`,
			);
		}
	}

	// 7. Resolve Payment Asset Account
	let resolvedAssetAccountId: string;

	if (authoritativeMethod === "MIDAS_FUND") {
		if (!statement.midasAccountId) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Statement "${validStatementId}" is configured with MIDAS_FUND but has no linked Midas account`,
			);
		}

		const [midasAcc] = await tx
			.select({
				id: midasAccounts.id,
				ledgerAccountId: midasAccounts.ledgerAccountId,
			})
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, statement.midasAccountId),
					eq(midasAccounts.userId, validUserId),
				),
			)
			.limit(1);

		if (!midasAcc) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`Midas account "${statement.midasAccountId}" not found for statement "${validStatementId}"`,
			);
		}

		resolvedAssetAccountId = midasAcc.ledgerAccountId;

		// Symmetrical caller asset assertion validation for MIDAS_FUND
		const callerSuppliedAsset =
			outsidePaymentAssetAccountId ?? paymentAssetAccountId;
		if (callerSuppliedAsset !== undefined && callerSuppliedAsset !== null) {
			const validCallerAsset = validateCcCanonicalUuid(
				callerSuppliedAsset,
				"paymentAssetAccountId",
			);
			if (validCallerAsset !== resolvedAssetAccountId) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_INPUT",
					`Supplied payment asset account "${validCallerAsset}" does not match MIDAS_FUND resolved asset account "${resolvedAssetAccountId}"`,
				);
			}
		}
	} else {
		// OUTSIDE_MIDAS
		const candidateAssetId =
			outsidePaymentAssetAccountId ?? paymentAssetAccountId;
		if (!candidateAssetId) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_INPUT",
				"outsidePaymentAssetAccountId is required for OUTSIDE_MIDAS statement payment",
			);
		}
		const validAssetId = validateCcCanonicalUuid(
			candidateAssetId,
			"outsidePaymentAssetAccountId",
		);

		// Validate asset account
		const [assetAcc] = await tx
			.select({
				id: ledgerAccounts.id,
				userId: ledgerAccounts.userId,
				accountType: ledgerAccounts.accountType,
				normalBalance: ledgerAccounts.normalBalance,
				currency: ledgerAccounts.currency,
				archivedAt: ledgerAccounts.archivedAt,
			})
			.from(ledgerAccounts)
			.where(
				and(
					eq(ledgerAccounts.id, validAssetId),
					eq(ledgerAccounts.userId, validUserId),
				),
			)
			.limit(1);

		if (!assetAcc) {
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				`Payment asset account "${validAssetId}" not found`,
			);
		}
		if (
			assetAcc.accountType !== "ASSET" ||
			assetAcc.normalBalance !== "DEBIT"
		) {
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				`Payment asset account "${validAssetId}" must be ASSET/DEBIT`,
			);
		}
		if (assetAcc.archivedAt !== null) {
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				`Payment asset account "${validAssetId}" is archived`,
			);
		}

		// Ensure it is NOT linked to midas_accounts
		const [linkedMidas] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(eq(midasAccounts.ledgerAccountId, validAssetId))
			.limit(1);

		if (linkedMidas) {
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				`Payment asset account "${validAssetId}" is linked to a Midas account and cannot be used for OUTSIDE_MIDAS payment`,
			);
		}

		// Currency invariant check (asset account currency === user currency)
		const [userRow] = await tx
			.select({ currency: users.currency })
			.from(users)
			.where(eq(users.id, validUserId))
			.limit(1);

		if (!userRow || assetAcc.currency !== userRow.currency) {
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				`Payment asset account "${validAssetId}" currency "${assetAcc.currency}" must match user currency "${userRow?.currency}"`,
			);
		}

		resolvedAssetAccountId = validAssetId;
	}

	// 8. Resolve Liability Ledger Account
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		statement.creditCardId,
	);

	// 9. Lock Ledger Accounts FOR UPDATE
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, resolvedAssetAccountId],
	});

	// 10. Check Card Liability Balance (Non-Negativity / Shortfall Check)
	const currentBal = await getLedgerAccountBalanceInTransaction({
		tx,
		userId: validUserId,
		accountId: liabilityAccountId,
	});
	const currentLiabilityCents = parseSignedAggregateMoneyString(
		currentBal.balance,
	).cents;
	const statementCents =
		parseSignedAggregateMoneyString(authoritativeAmount).cents;

	if (currentLiabilityCents < statementCents) {
		throw new CreditCardError(
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			`Current credit card liability balance (${currentBal.balance}) is less than statement amount (${authoritativeAmount})`,
		);
	}

	// 11. Handle Midas Reserve Release if MIDAS_FUND
	if (authoritativeMethod === "MIDAS_FUND") {
		const reserveBucketId = statement.midasReserveBucketId;
		if (!reserveBucketId) {
			throw new CreditCardError(
				"CREDIT_CARD_RESERVE_CONFLICT",
				"Dedicated CREDIT_CARD_RESERVE bucket not found in Midas account",
			);
		}

		if (!statement.midasAccountId) {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				"Statement has no linked Midas account",
			);
		}

		await lockMidasAllocationStateInTransaction({
			tx,
			userId: validUserId,
			midasAccountId: statement.midasAccountId,
		});

		const midasKey = await generateCardReserveMidasKey(
			validKey,
			validStatementId,
			"RELEASE_ON_PAY",
		);

		await createMidasAllocationTransferInTransaction({
			tx,
			userId: validUserId,
			midasAccountId: statement.midasAccountId,
			fromBucketId: reserveBucketId,
			toBucketId: null, // release to UNALLOCATED
			amount: authoritativeAmount,
			occurredAt: validOccurredAt,
			idempotencyKey: midasKey,
			memo: `Release card reserve on statement ${validStatementId} payment`,
		});
	}

	// Pre-generate payment event ID
	const paymentEventId = crypto.randomUUID();

	// 12. Post Canonical Transaction with Ledger Lines
	const canonicalRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		kind: "CREDIT_CARD_STATEMENT_PAYMENT",
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		payload: {
			paymentEventId,
			statementId: validStatementId,
			cardId: statement.creditCardId,
			amount: authoritativeAmount,
			paymentAssetAccountId: resolvedAssetAccountId,
			reservePlacement: authoritativeMethod,
		},
		source: {
			type: "CREDIT_CARD_STATEMENT_PAYMENT",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card statement payment - ${authoritativeAmount}`,
			lines: [
				{
					accountId: liabilityAccountId,
					side: "DEBIT",
					amount: authoritativeAmount,
				},
				{
					accountId: resolvedAssetAccountId,
					side: "CREDIT",
					amount: authoritativeAmount,
				},
			],
		},
	});

	// 13. Insert Payment Event Record
	await tx.insert(creditCardStatementPaymentEvents).values({
		id: paymentEventId,
		userId: validUserId,
		statementId: validStatementId,
		canonicalTransactionId: canonicalRes.transactionId,
		paymentAssetAccountId: resolvedAssetAccountId,
		amount: authoritativeAmount,
		occurredAt: validOccurredAt,
	});

	// 14. Fingerprint & Insert PAY Statement Revision
	const fingerprint = await calculateStatementPayFingerprint({
		userId: validUserId,
		statementId: validStatementId,
		expectedRevisionNo: validExpectedRev,
		paymentAmount: authoritativeAmount,
		paymentMethod: authoritativeMethod,
		assetAccountId: resolvedAssetAccountId,
		occurredAt: validOccurredAt,
	});

	const newRevisionId = crypto.randomUUID();
	const newRevisionNo = latestRev.revisionNo + 1;

	await tx.insert(creditCardStatementRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		statementId: validStatementId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		operation: "PAY",
		status: "PAID",
		statementAmount: latestRev.statementAmount,
		statementDate: latestRev.statementDate,
		dueDate: latestRev.dueDate,
		reservePlacement: latestRev.reservePlacement,
		note: latestRev.note,
		reasonNote: null,
		paymentEventId,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		statementId: validStatementId,
		revisionId: newRevisionId,
		revisionNo: newRevisionNo,
		operation: "PAY",
		status: "PAID",
		idempotentReplay: false,
		snapshot: {
			statementAmount: latestRev.statementAmount,
			statementDate: latestRev.statementDate,
			dueDate: latestRev.dueDate,
			reservePlacement:
				latestRev.reservePlacement as CreditCardReservePlacement,
			note: latestRev.note,
			reasonNote: null,
		},
	};
}

async function checkStatementPayReplay(
	tx: DatabaseTransaction,
	existingRev: typeof creditCardStatementRevisions.$inferSelect,
	userId: string,
	statementId: string,
	expectedRevisionNo: number,
	occurredAt: Date,
	paymentAmount?: string | undefined,
	paymentMethod?: "MIDAS_FUND" | "OUTSIDE_MIDAS" | undefined,
	candidateAssetAccountId?: string | undefined,
): Promise<CreditCardStatementLifecycleResult> {
	if (existingRev.operation !== "PAY" || existingRev.status !== "PAID") {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different statement operation",
		);
	}

	if (!existingRev.paymentEventId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Historical PAY revision ${existingRev.id} is missing paymentEventId`,
		);
	}

	// Load historical payment event to obtain historical paymentAssetAccountId
	const [paymentEvent] = await tx
		.select({
			id: creditCardStatementPaymentEvents.id,
			paymentAssetAccountId:
				creditCardStatementPaymentEvents.paymentAssetAccountId,
		})
		.from(creditCardStatementPaymentEvents)
		.where(
			and(
				eq(creditCardStatementPaymentEvents.id, existingRev.paymentEventId),
				eq(creditCardStatementPaymentEvents.userId, userId),
			),
		)
		.limit(1);

	if (!paymentEvent) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Historical payment event "${existingRev.paymentEventId}" not found`,
		);
	}

	// Validate caller optional assertions if provided
	if (paymentAmount !== undefined && paymentAmount !== null) {
		const validPassedAmount = validateCcPositiveMoneyString(
			paymentAmount,
			"paymentAmount",
		).normalized;
		if (validPassedAmount !== existingRev.statementAmount) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				`Idempotency key used with different paymentAmount: passed "${validPassedAmount}" vs historical "${existingRev.statementAmount}"`,
			);
		}
	}

	if (paymentMethod !== undefined && paymentMethod !== null) {
		const validPassedMethod = validatePaymentMethod(paymentMethod);
		if (validPassedMethod !== existingRev.reservePlacement) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				`Idempotency key used with different paymentMethod: passed "${validPassedMethod}" vs historical "${existingRev.reservePlacement}"`,
			);
		}
	}

	if (
		candidateAssetAccountId !== undefined &&
		candidateAssetAccountId !== null
	) {
		const validPassedAssetId = validateCcCanonicalUuid(
			candidateAssetAccountId,
			"paymentAssetAccountId",
		);
		if (validPassedAssetId !== paymentEvent.paymentAssetAccountId) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				`Idempotency key used with different paymentAssetAccountId: passed "${validPassedAssetId}" vs historical "${paymentEvent.paymentAssetAccountId}"`,
			);
		}
	}

	// Calculate fingerprint using caller's expectedRevisionNo & occurredAt + historical authoritative values
	const expectedFingerprint = await calculateStatementPayFingerprint({
		userId,
		statementId,
		expectedRevisionNo,
		paymentAmount: existingRev.statementAmount,
		paymentMethod: existingRev.reservePlacement as CreditCardReservePlacement,
		assetAccountId: paymentEvent.paymentAssetAccountId,
		occurredAt,
	});

	if (existingRev.revisionFingerprint !== expectedFingerprint) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different pay payload or intent",
		);
	}

	return {
		statementId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: "PAY",
		status: "PAID",
		idempotentReplay: true,
		snapshot: {
			statementAmount: existingRev.statementAmount,
			statementDate: existingRev.statementDate,
			dueDate: existingRev.dueDate,
			reservePlacement:
				existingRev.reservePlacement as CreditCardReservePlacement,
			note: existingRev.note,
			reasonNote: existingRev.reasonNote,
		},
	};
}

/**
 * Pays an OPEN credit card statement.
 */
export async function payCreditCardStatement(
	params: PayCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return payCreditCardStatementInTransaction({ tx, ...params });
	});
}

// ============================================================================
// Payment Reopen (Correction) Lifecycle
// ============================================================================

/**
 * Reopens a PAID credit card statement inside a transaction.
 *
 * EXECUTION ORDER:
 * 1. Early idempotency replay check.
 * 2. Preliminary statement lookup -> creditCardId.
 * 3. Lock credit_cards row FOR UPDATE.
 * 4. Re-read current card revision, require status === 'ACTIVE'.
 * 5. Lock credit_card_statements row FOR UPDATE.
 * 6. Second idempotency replay check under lock.
 * 7. Validate PAID status & expectedRevisionNo.
 * 8. Lock required ledger accounts FOR UPDATE (sorted by ID).
 * 9. Lock parent Midas account FOR UPDATE (if MIDAS_FUND).
 * 10. VOID/reverse canonical payment FIRST (restoring physical Midas ledger asset).
 * 11. Allocate full statement amount back into CREDIT_CARD_RESERVE virtual bucket.
 * 12. Insert REOPEN statement revision.
 */
export async function reopenCreditCardStatementPaymentInTransaction({
	tx,
	userId,
	statementId,
	expectedRevisionNo,
	reasonNote,
	occurredAt,
	idempotencyKey,
}: ReopenCreditCardStatementPaymentInTransactionParams): Promise<CreditCardStatementLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatementId = validateCcCanonicalUuid(statementId, "statementId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);
	const validReason = validateCcRequiredText(reasonNote, "reasonNote", 500);

	// 1. EARLY IDEMPOTENCY REPLAY CHECK
	const [earlyRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, validUserId),
				eq(creditCardStatementRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (earlyRev) {
		return checkStatementReopenReplay(
			earlyRev,
			validUserId,
			validStatementId,
			validExpectedRev,
			validReason,
			validOccurredAt,
		);
	}

	// 2. Preliminary statement lookup without lock to obtain creditCardId
	const [stmtLookup] = await tx
		.select({
			creditCardId: creditCardStatements.creditCardId,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, validStatementId),
				eq(creditCardStatements.userId, validUserId),
			),
		)
		.limit(1);

	if (!stmtLookup) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			`Statement "${validStatementId}" not found`,
		);
	}

	// 3. Lock credit_cards row FOR UPDATE
	const [card] = await tx
		.select({
			id: creditCards.id,
			userId: creditCards.userId,
		})
		.from(creditCards)
		.where(
			and(
				eq(creditCards.id, stmtLookup.creditCardId),
				eq(creditCards.userId, validUserId),
			),
		)
		.for("update");

	if (!card) {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_FOUND",
			`Credit card "${stmtLookup.creditCardId}" not found`,
		);
	}

	// 4. Re-read latest card revision and require ACTIVE
	const [cardRev] = await tx
		.select({
			status: creditCardRevisions.status,
		})
		.from(creditCardRevisions)
		.where(eq(creditCardRevisions.creditCardId, card.id))
		.orderBy(desc(creditCardRevisions.revisionNo))
		.limit(1);

	if (cardRev?.status !== "ACTIVE") {
		throw new CreditCardError(
			"CREDIT_CARD_NOT_ACTIVE",
			`Credit card "${card.id}" is not active (status: "${cardRev?.status}")`,
		);
	}

	// 5. Lock Statement Anchor FOR UPDATE
	const [statement] = await tx
		.select({
			id: creditCardStatements.id,
			creditCardId: creditCardStatements.creditCardId,
			userId: creditCardStatements.userId,
			midasAccountId: creditCardStatements.midasAccountId,
			midasReserveBucketId: creditCardStatements.midasReserveBucketId,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, validStatementId),
				eq(creditCardStatements.userId, validUserId),
			),
		)
		.for("update");

	if (!statement) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			`Statement "${validStatementId}" not found`,
		);
	}

	// 6. SECOND IDEMPOTENCY REPLAY CHECK (under lock)
	const [secondRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, validUserId),
				eq(creditCardStatementRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (secondRev) {
		return checkStatementReopenReplay(
			secondRev,
			validUserId,
			validStatementId,
			validExpectedRev,
			validReason,
			validOccurredAt,
		);
	}

	// 7. Fetch latest revision
	const [latestRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, validStatementId))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for statement "${validStatementId}"`,
		);
	}

	if (latestRev.operation === "VOID" || latestRev.status === "VOID") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_OPEN",
			`Statement "${validStatementId}" is voided`,
		);
	}

	if (latestRev.status !== "PAID" || latestRev.operation !== "PAY") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_PAID",
			`Statement "${validStatementId}" is not in PAID status`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	if (!latestRev.paymentEventId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Paid statement "${validStatementId}" has no linked payment event`,
		);
	}

	// Fetch Payment Event
	const [paymentEvent] = await tx
		.select()
		.from(creditCardStatementPaymentEvents)
		.where(
			and(
				eq(creditCardStatementPaymentEvents.id, latestRev.paymentEventId),
				eq(creditCardStatementPaymentEvents.userId, validUserId),
			),
		)
		.limit(1);

	if (!paymentEvent) {
		throw new CreditCardError(
			"CREDIT_CARD_PAYMENT_NOT_FOUND",
			`Payment event "${latestRev.paymentEventId}" not found`,
		);
	}

	// 8. Resolve Liability Ledger Account
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		statement.creditCardId,
	);

	// Lock Ledger Accounts FOR UPDATE (sorted)
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, paymentEvent.paymentAssetAccountId],
	});

	// 9. Lock Midas Account (if MIDAS_FUND)
	let midasAccId: string | null = null;
	if (latestRev.reservePlacement === "MIDAS_FUND") {
		const [midasAcc] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.userId, validUserId),
					eq(midasAccounts.ledgerAccountId, paymentEvent.paymentAssetAccountId),
				),
			)
			.limit(1);

		if (midasAcc) {
			midasAccId = midasAcc.id;
			await lockMidasAllocationStateInTransaction({
				tx,
				userId: validUserId,
				midasAccountId: midasAcc.id,
			});
		}
	}

	// 10. STEP 1: VOID / Reverse Canonical Payment Transaction FIRST (restores physical liquidity to Midas / Bank)
	const [canRev] = await tx
		.select()
		.from(transactionRevisions)
		.where(
			and(
				eq(
					transactionRevisions.transactionId,
					paymentEvent.canonicalTransactionId,
				),
				eq(transactionRevisions.userId, validUserId),
			),
		)
		.orderBy(desc(transactionRevisions.revisionNo))
		.limit(1);

	if (!canRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`Canonical transaction "${paymentEvent.canonicalTransactionId}" has no revisions`,
		);
	}

	await voidCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		transactionId: paymentEvent.canonicalTransactionId,
		expectedRevisionNo: canRev.revisionNo,
		idempotencyKey: validKey,
		reasonCode: "STATEMENT_PAYMENT_REOPEN",
		reasonNote: validReason,
		source: {
			type: "CREDIT_CARD_STATEMENT_PAYMENT_REOPEN",
			ref: validKey,
		},
	});

	// 11. STEP 2: Allocate Reserve Back into CREDIT_CARD_RESERVE Virtual Bucket (Midas physical asset is restored now)
	if (latestRev.reservePlacement === "MIDAS_FUND" && midasAccId) {
		const reserveBucketId = statement.midasReserveBucketId;

		if (reserveBucketId) {
			const midasKey = await generateCardReserveMidasKey(
				validKey,
				validStatementId,
				"REOPEN_ALLOCATION",
			);
			try {
				await createMidasAllocationTransferInTransaction({
					tx,
					userId: validUserId,
					midasAccountId: midasAccId,
					idempotencyKey: midasKey,
					fromBucketId: null,
					toBucketId: reserveBucketId,
					amount: latestRev.statementAmount,
					occurredAt: validOccurredAt,
					memo: `Credit card reserve restore after reopen: ${validStatementId}`,
				});
			} catch (err: unknown) {
				if (err instanceof MidasError) {
					mapMidasError(err);
				}
				mapDbError(err, "statement payment REOPEN reserve allocation");
			}
		}
	}

	// 12. Fingerprint & Insert REOPEN Statement Revision
	const fingerprint = await calculateStatementReopenFingerprint({
		userId: validUserId,
		statementId: validStatementId,
		expectedRevisionNo: validExpectedRev,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	const newRevisionId = crypto.randomUUID();
	const newRevisionNo = latestRev.revisionNo + 1;

	await tx.insert(creditCardStatementRevisions).values({
		id: newRevisionId,
		userId: validUserId,
		statementId: validStatementId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		operation: "REOPEN",
		status: "OPEN",
		statementAmount: latestRev.statementAmount,
		statementDate: latestRev.statementDate,
		dueDate: latestRev.dueDate,
		reservePlacement: latestRev.reservePlacement,
		note: latestRev.note,
		reasonNote: validReason,
		paymentEventId: paymentEvent.id,
		occurredAt: validOccurredAt,
		idempotencyKey: validKey,
		revisionFingerprint: fingerprint,
	});

	return {
		statementId: validStatementId,
		revisionId: newRevisionId,
		revisionNo: newRevisionNo,
		operation: "REOPEN",
		status: "OPEN",
		idempotentReplay: false,
		snapshot: {
			statementAmount: latestRev.statementAmount,
			statementDate: latestRev.statementDate,
			dueDate: latestRev.dueDate,
			reservePlacement:
				latestRev.reservePlacement as CreditCardReservePlacement,
			note: latestRev.note,
			reasonNote: validReason,
		},
	};
}

async function checkStatementReopenReplay(
	existingRev: typeof creditCardStatementRevisions.$inferSelect,
	userId: string,
	statementId: string,
	expectedRevisionNo: number,
	reasonNote: string,
	occurredAt: Date,
): Promise<CreditCardStatementLifecycleResult> {
	const fp = await calculateStatementReopenFingerprint({
		userId,
		statementId,
		expectedRevisionNo,
		reasonNote,
		occurredAt,
	});

	if (existingRev.revisionFingerprint !== fp) {
		throw new CreditCardError(
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different reopen payload",
		);
	}

	return {
		statementId,
		revisionId: existingRev.id,
		revisionNo: existingRev.revisionNo,
		operation: "REOPEN",
		status: "OPEN",
		idempotentReplay: true,
		snapshot: {
			statementAmount: existingRev.statementAmount,
			statementDate: existingRev.statementDate,
			dueDate: existingRev.dueDate,
			reservePlacement:
				existingRev.reservePlacement as CreditCardReservePlacement,
			note: existingRev.note,
			reasonNote: existingRev.reasonNote,
		},
	};
}

/**
 * Reopens a PAID credit card statement.
 */
export async function reopenCreditCardStatementPayment(
	params: ReopenCreditCardStatementPaymentParams,
): Promise<CreditCardStatementLifecycleResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return reopenCreditCardStatementPaymentInTransaction({ tx, ...params });
	});
}

// ============================================================================
// Statement Reconciliation
// ============================================================================

/**
 * Reconciles a credit card statement against current card liability and reserve readiness.
 * Returns coherent status: READY (coverage >= statement) or SHORTFALL from a single serialized snapshot.
 */
export async function reconcileCreditCardStatementInTransaction({
	tx,
	userId,
	statementId,
}: ReconcileCreditCardStatementInTransactionParams): Promise<CreditCardStatementReconciliationResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatementId = validateCcCanonicalUuid(statementId, "statementId");

	// 1. Lock Statement Anchor FOR UPDATE
	const [statement] = await tx
		.select({
			id: creditCardStatements.id,
			creditCardId: creditCardStatements.creditCardId,
			userId: creditCardStatements.userId,
			midasAccountId: creditCardStatements.midasAccountId,
			midasReserveBucketId: creditCardStatements.midasReserveBucketId,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, validStatementId),
				eq(creditCardStatements.userId, validUserId),
			),
		)
		.for("update");

	if (!statement) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			`Statement "${validStatementId}" not found`,
		);
	}

	// 2. Resolve liability ledger account
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		statement.creditCardId,
	);

	// Resolve Midas physical ledger account if linked
	let midasPhysicalAccountId: string | null = null;
	if (statement.midasAccountId) {
		const [midasAcc] = await tx
			.select({ ledgerAccountId: midasAccounts.ledgerAccountId })
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.id, statement.midasAccountId),
					eq(midasAccounts.userId, validUserId),
				),
			)
			.limit(1);

		if (midasAcc) {
			midasPhysicalAccountId = midasAcc.ledgerAccountId;
		}
	}

	// 3. Lock all required ledger accounts together (sorted by ID)
	const ledgerAccountIds = [liabilityAccountId];
	if (midasPhysicalAccountId) {
		ledgerAccountIds.push(midasPhysicalAccountId);
	}
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: ledgerAccountIds,
	});

	// 4. Lock Midas account (global order: ledger_accounts -> midas_accounts)
	if (statement.midasAccountId) {
		await lockMidasAllocationStateInTransaction({
			tx,
			userId: validUserId,
			midasAccountId: statement.midasAccountId,
		});
	}

	// 5. Re-read latest statement revision
	const [latestRev] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, validStatementId))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);

	if (!latestRev) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			`No revisions found for statement "${validStatementId}"`,
		);
	}

	// 6. Read exact current card liability balance
	const cardBal = await getLedgerAccountBalanceInTransaction({
		tx,
		userId: validUserId,
		accountId: liabilityAccountId,
	});

	const cardLiabilityBalance = cardBal.balance;
	const stmtCents = parseSignedAggregateMoneyString(
		latestRev.statementAmount,
	).cents;
	const ledgerCents =
		parseSignedAggregateMoneyString(cardLiabilityBalance).cents;

	// 7. Read exact current reserve state
	let reserveAmount = "0.00";
	if (statement.midasReserveBucketId && statement.midasAccountId) {
		const midasState = await getMidasLiquidityStateInTransaction({
			tx,
			userId: validUserId,
		});
		const bucket = midasState.buckets.find(
			(b) => b.bucketId === statement.midasReserveBucketId,
		);
		if (bucket) {
			reserveAmount = bucket.balance;
		}
	}

	// 8. Validate reserve invariant
	if (latestRev.status === "OPEN") {
		if (latestRev.reservePlacement === "MIDAS_FUND") {
			if (reserveAmount !== latestRev.statementAmount) {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`OPEN MIDAS_FUND statement ${validStatementId} reserve amount (${reserveAmount}) does not match statement amount (${latestRev.statementAmount})`,
				);
			}
		} else if (latestRev.reservePlacement === "OUTSIDE_MIDAS") {
			if (reserveAmount !== "0.00") {
				throw new CreditCardError(
					"CREDIT_CARD_INVALID_STATE",
					`OPEN OUTSIDE_MIDAS statement ${validStatementId} must have reserve amount 0.00, found ${reserveAmount}`,
				);
			}
		}
	} else if (latestRev.status === "PAID" || latestRev.status === "VOID") {
		if (reserveAmount !== "0.00") {
			throw new CreditCardError(
				"CREDIT_CARD_INVALID_STATE",
				`${latestRev.status} statement ${validStatementId} must have reserve amount 0.00, found ${reserveAmount}`,
			);
		}
	}

	// 9. Derive coverage and expected post-payment liability
	const isReady = ledgerCents >= stmtCents;
	const liabilityCoverage = isReady ? "READY" : "SHORTFALL";
	const diffCents = ledgerCents - stmtCents;
	const liabilityAfterPayment = formatSignedCentsToMoney(diffCents);

	return {
		statementId: validStatementId,
		cardId: statement.creditCardId,
		statementAmount: latestRev.statementAmount,
		cardLiabilityBalance,
		reservePlacement: latestRev.reservePlacement as CreditCardReservePlacement,
		reserveAmount,
		liabilityCoverage,
		liabilityAfterPayment,
	};
}

/**
 * Reconciles a credit card statement.
 */
export async function reconcileCreditCardStatement(
	params: ReconcileCreditCardStatementParams,
): Promise<CreditCardStatementReconciliationResult> {
	return runCreditCardTransaction(params.db, async (tx) => {
		return reconcileCreditCardStatementInTransaction({ tx, ...params });
	});
}
