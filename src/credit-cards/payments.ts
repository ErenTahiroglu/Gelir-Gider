import { and, desc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	creditCardLedgerLinks,
	creditCardStatementPaymentEvents,
} from "../db/schema/credit-card-ledger";
import {
	type CreditCardReservePlacement,
	type CreditCardStatementOperation,
	type CreditCardStatementStatus,
	creditCardStatementRevisions,
	creditCardStatements,
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
import {
	createMidasAllocationTransferInTransaction,
	lockMidasAllocationStateInTransaction,
} from "../midas/service";
import {
	createCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import {
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOccurredAt,
	validateCcOptionalText,
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
// Params Interfaces
// ============================================================================

export interface PayCreditCardStatementInTransactionParams {
	tx: DatabaseTransaction;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	paymentAmount: string;
	paymentMethod: "MIDAS_FUND" | "OUTSIDE_MIDAS";
	paymentAssetAccountId: string;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface PayCreditCardStatementParams {
	db: Database;
	userId: string;
	statementId: string;
	expectedRevisionNo: number;
	paymentAmount: string;
	paymentMethod: "MIDAS_FUND" | "OUTSIDE_MIDAS";
	paymentAssetAccountId: string;
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

export interface ReconcileCreditCardStatementParams {
	db: Database;
	userId: string;
	statementId: string;
}

export interface ReconcileCreditCardStatementResult {
	statementId: string;
	cardId: string;
	statementAmount: string;
	statementDate: string;
	ledgerLiabilityBalance: string;
	isMatched: boolean;
	difference: string;
}

// ============================================================================
// Statement Payment Implementation
// ============================================================================

/**
 * Executes a full statement payment within an existing transaction.
 * Dr Card Liability, Cr Payment Asset (zero new expense).
 * If MIDAS_FUND: releases dedicated CREDIT_CARD_RESERVE to unallocated liquidity atomically.
 */
export async function payCreditCardStatementInTransaction({
	tx,
	userId,
	statementId,
	expectedRevisionNo,
	paymentAmount,
	paymentMethod,
	paymentAssetAccountId,
	occurredAt,
	idempotencyKey,
}: PayCreditCardStatementInTransactionParams): Promise<CreditCardStatementLifecycleResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatementId = validateCcCanonicalUuid(statementId, "statementId");
	const validExpectedRev = validateCcExpectedRevisionNo(expectedRevisionNo);
	const validAmount = validateCcPositiveMoneyString(
		paymentAmount,
		"paymentAmount",
	).normalized;
	const validMethod = validatePaymentMethod(paymentMethod);
	const validAssetAccountId = validateCcCanonicalUuid(
		paymentAssetAccountId,
		"paymentAssetAccountId",
	);
	const validOccurredAt = validateCcOccurredAt(occurredAt);
	const validKey = validateCcRequiredText(
		idempotencyKey,
		"idempotencyKey",
		128,
	);

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardStatementRevisions.id,
			statementId: creditCardStatementRevisions.statementId,
			revisionNo: creditCardStatementRevisions.revisionNo,
			operation: creditCardStatementRevisions.operation,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			statementDate: creditCardStatementRevisions.statementDate,
			dueDate: creditCardStatementRevisions.dueDate,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			note: creditCardStatementRevisions.note,
			reasonNote: creditCardStatementRevisions.reasonNote,
			revisionFingerprint: creditCardStatementRevisions.revisionFingerprint,
		})
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, validUserId),
				eq(creditCardStatementRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateStatementPayFingerprint({
			userId: validUserId,
			statementId: validStatementId,
			expectedRevisionNo: validExpectedRev,
			paymentAmount: validAmount,
			paymentMethod: validMethod,
			assetAccountId: validAssetAccountId,
			occurredAt: validOccurredAt,
		});

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different statement payment payload",
			);
		}

		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
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

	// 2. Lock Statement Anchor FOR UPDATE
	const [statement] = await tx
		.select({
			id: creditCardStatements.id,
			cardId: creditCardStatements.creditCardId,
			userId: creditCardStatements.userId,
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
			`Credit card statement "${validStatementId}" not found`,
		);
	}

	// 3. Fetch latest statement revision
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

	if (latestRev.status === "PAID") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_ALREADY_PAID",
			`Statement "${validStatementId}" is already PAID`,
		);
	}

	if (latestRev.status !== "OPEN") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_OPEN",
			`Cannot pay statement "${validStatementId}" with status ${latestRev.status}`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} does not match current revision ${latestRev.revisionNo}`,
		);
	}

	if (latestRev.statementAmount !== validAmount) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_INPUT",
			`Payment amount ${validAmount} does not match statement amount ${latestRev.statementAmount}`,
		);
	}

	// 4. Resolve Liability Account & Validate Payment Asset Account
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		statement.cardId,
	);

	const [assetAccount] = await tx
		.select({
			id: ledgerAccounts.id,
			accountType: ledgerAccounts.accountType,
			normalBalance: ledgerAccounts.normalBalance,
			archivedAt: ledgerAccounts.archivedAt,
		})
		.from(ledgerAccounts)
		.where(
			and(
				eq(ledgerAccounts.id, validAssetAccountId),
				eq(ledgerAccounts.userId, validUserId),
			),
		)
		.limit(1);

	if (!assetAccount) {
		throw new CreditCardError(
			"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
			`Payment asset account "${validAssetAccountId}" not found`,
		);
	}

	if (assetAccount.accountType !== "ASSET") {
		throw new CreditCardError(
			"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
			`Payment account "${validAssetAccountId}" must have account_type ASSET, found ${assetAccount.accountType}`,
		);
	}

	if (assetAccount.archivedAt !== null) {
		throw new CreditCardError(
			"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
			`Payment asset account "${validAssetAccountId}" is archived`,
		);
	}

	// Lock ledger accounts in deterministic ascending UUID order
	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, validAssetAccountId],
	});

	// 5. Global Lock Order: If MIDAS_FUND, handle Midas reserve release
	if (validMethod === "MIDAS_FUND") {
		const [midasAcc] = await tx
			.select({ id: midasAccounts.id })
			.from(midasAccounts)
			.where(
				and(
					eq(midasAccounts.userId, validUserId),
					eq(midasAccounts.ledgerAccountId, validAssetAccountId),
				),
			)
			.limit(1);

		if (!midasAcc) {
			throw new CreditCardError(
				"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
				`Asset account "${validAssetAccountId}" is not linked to user's Midas account`,
			);
		}

		await lockMidasAllocationStateInTransaction({
			tx,
			userId: validUserId,
			midasAccountId: midasAcc.id,
		});

		const reserveBucketId = statement.midasReserveBucketId;

		if (!reserveBucketId) {
			throw new CreditCardError(
				"CREDIT_CARD_RESERVE_CONFLICT",
				"Dedicated CREDIT_CARD_RESERVE bucket not found in Midas account",
			);
		}

		// Transfer reserve from bucket back to unallocated as it is being paid
		const midasKey = await generateCardReserveMidasKey(
			validKey,
			validStatementId,
			"RELEASE_ON_PAY",
		);

		await createMidasAllocationTransferInTransaction({
			tx,
			userId: validUserId,
			midasAccountId: midasAcc.id,
			fromBucketId: reserveBucketId,
			toBucketId: null, // to UNALLOCATED
			amount: validAmount,
			occurredAt: validOccurredAt,
			idempotencyKey: midasKey,
			memo: `Release card reserve on statement ${validStatementId} payment`,
		});
	}

	// 6. Post Canonical Payment Transaction (Dr Card Liability, Cr Payment Asset)
	const canonicalRes = await createCanonicalTransactionWithLedgerInTransaction({
		tx,
		userId: validUserId,
		kind: "CREDIT_CARD_STATEMENT_PAYMENT",
		idempotencyKey: validKey,
		occurredAt: validOccurredAt,
		payload: {
			statementId: validStatementId,
			amount: validAmount,
			paymentMethod: validMethod,
			paymentAssetAccountId: validAssetAccountId,
		},
		source: {
			type: "CREDIT_CARD_STATEMENT_PAYMENT",
			ref: validKey,
		},
		ledger: {
			memo: `Credit card statement payment: ${validStatementId}`,
			lines: [
				{
					accountId: liabilityAccountId,
					side: "DEBIT",
					amount: validAmount,
				},
				{
					accountId: validAssetAccountId,
					side: "CREDIT",
					amount: validAmount,
				},
			],
		},
	});

	// 7. Insert Payment Event Anchor
	const paymentEventId = crypto.randomUUID();
	await tx.insert(creditCardStatementPaymentEvents).values({
		id: paymentEventId,
		userId: validUserId,
		statementId: validStatementId,
		canonicalTransactionId: canonicalRes.transactionId,
		paymentAssetAccountId: validAssetAccountId,
		amount: validAmount,
		occurredAt: validOccurredAt,
	});

	// 8. Insert PAID Statement Revision
	const fingerprint = await calculateStatementPayFingerprint({
		userId: validUserId,
		statementId: validStatementId,
		expectedRevisionNo: validExpectedRev,
		paymentAmount: validAmount,
		paymentMethod: validMethod,
		assetAccountId: validAssetAccountId,
		occurredAt: validOccurredAt,
	});

	const newRevisionNo = latestRev.revisionNo + 1;
	const newRevisionId = crypto.randomUUID();

	await tx.insert(creditCardStatementRevisions).values({
		id: newRevisionId,
		statementId: validStatementId,
		userId: validUserId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		operation: "PAY",
		status: "PAID",
		statementAmount: latestRev.statementAmount,
		statementDate: latestRev.statementDate,
		dueDate: latestRev.dueDate,
		reservePlacement: latestRev.reservePlacement,
		paymentEventId,
		note: latestRev.note,
		reasonNote: null,
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

/**
 * Pays a credit card statement.
 */
export async function payCreditCardStatement(
	params: PayCreditCardStatementParams,
): Promise<CreditCardStatementLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return payCreditCardStatementInTransaction({ tx, ...params });
	});
}

/**
 * Reopens a PAID credit card statement payment (correction/reversal).
 * Reverses canonical payment transaction (Dr Payment Asset, Cr Card Liability).
 * If MIDAS_FUND: restores reserve from unallocated to CREDIT_CARD_RESERVE bucket atomically.
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
	const validReason = validateCcOptionalText(reasonNote, "reasonNote", 500);

	// 1. Check Idempotent Replay on Revision Key
	const [existingRev] = await tx
		.select({
			id: creditCardStatementRevisions.id,
			statementId: creditCardStatementRevisions.statementId,
			revisionNo: creditCardStatementRevisions.revisionNo,
			operation: creditCardStatementRevisions.operation,
			status: creditCardStatementRevisions.status,
			statementAmount: creditCardStatementRevisions.statementAmount,
			statementDate: creditCardStatementRevisions.statementDate,
			dueDate: creditCardStatementRevisions.dueDate,
			reservePlacement: creditCardStatementRevisions.reservePlacement,
			note: creditCardStatementRevisions.note,
			reasonNote: creditCardStatementRevisions.reasonNote,
			revisionFingerprint: creditCardStatementRevisions.revisionFingerprint,
		})
		.from(creditCardStatementRevisions)
		.where(
			and(
				eq(creditCardStatementRevisions.userId, validUserId),
				eq(creditCardStatementRevisions.idempotencyKey, validKey),
			),
		)
		.limit(1);

	if (existingRev) {
		const candidateFingerprint = await calculateStatementReopenFingerprint({
			userId: validUserId,
			statementId: validStatementId,
			expectedRevisionNo: validExpectedRev,
			reasonNote: validReason,
			occurredAt: validOccurredAt,
		});

		if (existingRev.revisionFingerprint !== candidateFingerprint) {
			throw new CreditCardError(
				"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different statement reopen payload",
			);
		}

		return {
			statementId: existingRev.statementId,
			revisionId: existingRev.id,
			revisionNo: existingRev.revisionNo,
			operation: existingRev.operation as CreditCardStatementOperation,
			status: existingRev.status as CreditCardStatementStatus,
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

	// 2. Lock Statement Anchor FOR UPDATE
	const [statement] = await tx
		.select({
			id: creditCardStatements.id,
			cardId: creditCardStatements.creditCardId,
			userId: creditCardStatements.userId,
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
			`Credit card statement "${validStatementId}" not found`,
		);
	}

	// 3. Fetch latest statement revision
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

	if (latestRev.status !== "PAID") {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_PAID",
			`Cannot reopen payment for statement with status ${latestRev.status}`,
		);
	}

	if (latestRev.revisionNo !== validExpectedRev) {
		throw new CreditCardError(
			"CREDIT_CARD_REVISION_CONFLICT",
			`Expected revision ${validExpectedRev} but current revision is ${latestRev.revisionNo}`,
		);
	}

	if (!latestRev.paymentEventId) {
		throw new CreditCardError(
			"CREDIT_CARD_INVALID_STATE",
			"Payment event ID missing on PAID statement revision",
		);
	}

	// 4. Fetch Payment Event
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
			"CREDIT_CARD_INVALID_STATE",
			`Payment event ${latestRev.paymentEventId} not found`,
		);
	}

	// 5. Resolve Liability Account & Lock Accounts
	const liabilityAccountId = await ensureCreditCardLedgerLinkInTransaction(
		tx,
		validUserId,
		statement.cardId,
	);

	await lockLedgerAccountsInTransaction({
		tx,
		userId: validUserId,
		accountIds: [liabilityAccountId, paymentEvent.paymentAssetAccountId],
	});

	// 6. Global Lock Order: If MIDAS_FUND, restore reserve from unallocated to bucket
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
			await lockMidasAllocationStateInTransaction({
				tx,
				userId: validUserId,
				midasAccountId: midasAcc.id,
			});

			const reserveBucketId = statement.midasReserveBucketId;

			if (reserveBucketId) {
				const midasKey = await generateCardReserveMidasKey(
					validKey,
					validStatementId,
					"RESTORE_ON_REOPEN",
				);

				await createMidasAllocationTransferInTransaction({
					tx,
					userId: validUserId,
					midasAccountId: midasAcc.id,
					fromBucketId: null, // from UNALLOCATED
					toBucketId: reserveBucketId,
					amount: latestRev.statementAmount,
					occurredAt: validOccurredAt,
					idempotencyKey: midasKey,
					memo: `Restore card reserve on statement ${validStatementId} payment reopen`,
				});
			}
		}
	}

	// 7. Void/Reverse Canonical Payment Transaction
	const [canRev] = await tx
		.select({ revisionNo: transactionRevisions.revisionNo })
		.from(transactionRevisions)
		.where(
			eq(
				transactionRevisions.transactionId,
				paymentEvent.canonicalTransactionId,
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
			type: "CREDIT_CARD_STATEMENT_PAYMENT",
			ref: validKey,
		},
	});

	// 8. Insert REOPEN Statement Revision (Status returns to OPEN)
	const fingerprint = await calculateStatementReopenFingerprint({
		userId: validUserId,
		statementId: validStatementId,
		expectedRevisionNo: validExpectedRev,
		reasonNote: validReason,
		occurredAt: validOccurredAt,
	});

	const newRevisionNo = latestRev.revisionNo + 1;
	const newRevisionId = crypto.randomUUID();

	await tx.insert(creditCardStatementRevisions).values({
		id: newRevisionId,
		statementId: validStatementId,
		userId: validUserId,
		revisionNo: newRevisionNo,
		previousRevisionId: latestRev.id,
		operation: "REOPEN",
		status: "OPEN",
		statementAmount: latestRev.statementAmount,
		statementDate: latestRev.statementDate,
		dueDate: latestRev.dueDate,
		reservePlacement: latestRev.reservePlacement,
		paymentEventId: paymentEvent.id,
		note: latestRev.note,
		reasonNote: validReason,
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

/**
 * Reopens a PAID credit card statement payment.
 */
export async function reopenCreditCardStatementPayment(
	params: ReopenCreditCardStatementPaymentParams,
): Promise<CreditCardStatementLifecycleResult> {
	return params.db.transaction(async (tx) => {
		return reopenCreditCardStatementPaymentInTransaction({ tx, ...params });
	});
}

/**
 * Reconciles the statement obligation against the live ledger liability balance as of the statement date.
 */
export async function reconcileCreditCardStatement({
	db,
	userId,
	statementId,
}: ReconcileCreditCardStatementParams): Promise<ReconcileCreditCardStatementResult> {
	const validUserId = validateCcCanonicalUuid(userId, "userId");
	const validStatementId = validateCcCanonicalUuid(statementId, "statementId");

	const [statement] = await db
		.select({
			id: creditCardStatements.id,
			cardId: creditCardStatements.creditCardId,
			userId: creditCardStatements.userId,
		})
		.from(creditCardStatements)
		.where(
			and(
				eq(creditCardStatements.id, validStatementId),
				eq(creditCardStatements.userId, validUserId),
			),
		)
		.limit(1);

	if (!statement) {
		throw new CreditCardError(
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			`Credit card statement "${validStatementId}" not found`,
		);
	}

	const [latestRev] = await db
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

	const [link] = await db
		.select({ liabilityAccountId: creditCardLedgerLinks.liabilityAccountId })
		.from(creditCardLedgerLinks)
		.where(
			and(
				eq(creditCardLedgerLinks.userId, validUserId),
				eq(creditCardLedgerLinks.creditCardId, statement.cardId),
			),
		)
		.limit(1);

	let liveLiabilityBalance = "0.00";
	if (link) {
		// Calculate as of end of statement date (23:59:59.999Z on statementDate)
		const stmtDate = new Date(`${latestRev.statementDate}T23:59:59.999Z`);
		const balRes = await getLedgerAccountBalanceInTransaction({
			tx: db as unknown as DatabaseTransaction,
			userId: validUserId,
			accountId: link.liabilityAccountId,
			asOf: stmtDate,
		});
		liveLiabilityBalance = balRes.balance;
	}

	const stmtCents = parseSignedAggregateMoneyString(
		latestRev.statementAmount,
	).cents;
	const ledgerCents =
		parseSignedAggregateMoneyString(liveLiabilityBalance).cents;
	const diffCents = stmtCents - ledgerCents;

	return {
		statementId: validStatementId,
		cardId: statement.cardId,
		statementAmount: latestRev.statementAmount,
		statementDate: latestRev.statementDate,
		ledgerLiabilityBalance: liveLiabilityBalance,
		isMatched: stmtCents === ledgerCents,
		difference: formatSignedCentsToMoney(diffCents),
	};
}
