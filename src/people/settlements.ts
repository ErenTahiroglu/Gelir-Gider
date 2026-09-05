import { and, asc, desc, eq } from "drizzle-orm";
import type {
	Database,
	DatabaseOrTransaction,
	DatabaseTransaction,
} from "../db/client";
import { users } from "../db/schema/auth";
import { incomeReceiptRevisions } from "../db/schema/income";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	type PersonObligationDirection,
	people,
	personObligationRevisions,
	personObligations,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { transactionRevisions } from "../db/schema/transactions";
import {
	createIncomeReceiptInTransaction,
	voidIncomeReceiptInTransaction,
} from "../income/receipts";
import { formatCentsToMoney, parsePositiveMoneyString } from "../ledger/money";
import { lockLedgerAccountsInTransaction } from "../ledger/posting";
import { CanonicalTransactionError } from "../transactions/errors";
import {
	type BoundCanonicalTransactionResult,
	createCanonicalTransactionWithLedgerInTransaction,
	voidCanonicalTransactionWithLedgerInTransaction,
} from "../transactions/ledger-lifecycle";
import { runPeopleReadTransaction, runPeopleTransaction } from "./boundary";
import { validateOccurredAt } from "./calendar";
import { PeopleError } from "./errors";
import {
	calculateSettlementCreateFingerprint,
	calculateSettlementVoidFingerprint,
	calculateSettlementVoidFingerprintV1,
	derivePeopleIncomeIdempotencyKey,
} from "./fingerprint";
import {
	ensurePeopleOverpaymentIncomeSourceInTransaction,
	ensurePersonLedgerLinkInTransaction,
} from "./ledger-provisioning";
import {
	validateCanonicalUuid,
	validateExpectedRevisionNo,
	validateOptionalCanonicalUuid,
	validateOptionalEnum,
} from "./validation";

const SETTLEMENT_STATUS_VALUES = ["ACTIVE", "VOIDED"] as const;

export interface SettlementReadModel {
	settlementId: string;
	obligationId: string;
	personId: string;
	direction: PersonObligationDirection;
	status: "ACTIVE" | "VOIDED";
	assetAccountId: string;
	cashAmount: string;
	appliedAmount: string;
	excessAmount: string;
	overpaymentIncomeReceiptId: string | null;
	note: string | null;
	occurredAt: Date;
	revisionNo: number;
	canonicalTransactionId: string;
	canonicalRevisionId: string;
}

export interface RecordPersonReceivableSettlementParams {
	db: Database;
	userId: string;
	obligationId: string;
	cashAmount: string;
	destinationAssetAccountId: string;
	occurredAt: Date;
	note?: string | null | undefined;
	idempotencyKey: string;
}

export interface RecordPersonPayableSettlementParams {
	db: Database;
	userId: string;
	obligationId: string;
	amount: string;
	sourceAssetAccountId: string;
	occurredAt: Date;
	note?: string | null | undefined;
	idempotencyKey: string;
}

export interface VoidPersonSettlementParams {
	db: Database;
	userId: string;
	settlementId: string;
	expectedRevisionNo: number;
	reason: string;
	idempotencyKey: string;
}

export interface GetPersonSettlementParams {
	db: Database;
	userId: string;
	settlementId: string;
}

export interface ListPersonSettlementsParams {
	db: Database;
	userId: string;
	obligationId?: string | undefined;
	status?: "ACTIVE" | "VOIDED" | undefined;
}

function validateUserId(value: string): string {
	return validateCanonicalUuid(value, "userId");
}

function validateObligationId(value: string): string {
	return validateCanonicalUuid(value, "obligationId");
}

function validateSettlementId(value: string): string {
	return validateCanonicalUuid(value, "settlementId");
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

function validatePositiveAmount(value: string): {
	normalized: string;
	cents: bigint;
} {
	try {
		return parsePositiveMoneyString(value);
	} catch (err) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid amount: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function validateNote(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > 500) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"note must be between 1 and 500 characters when provided",
		);
	}
	return trimmed;
}

function validateReason(value: string): string {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 500) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"reason is required and must be at most 500 characters",
		);
	}
	return trimmed;
}

async function validateAssetAccount(
	tx: DatabaseTransaction,
	userId: string,
	accountId: string,
	field: string,
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
			`${field} "${accountId}" not found for this user`,
		);
	}
	if (account.accountType !== "ASSET" || account.normalBalance !== "DEBIT") {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			`${field} must have accountType='ASSET' and normalBalance='DEBIT'`,
		);
	}
	if (account.archivedAt !== null) {
		throw new PeopleError(
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			`${field} is archived`,
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
			`${field} currency '${account.currency}' does not match user currency '${user.currency}'`,
		);
	}
}

async function verifyPersonActiveInTransaction(
	tx: DatabaseTransaction,
	personId: string,
): Promise<void> {
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

async function getLatestSettlementRevision(
	dbOrTx: DatabaseOrTransaction,
	settlementId: string,
): Promise<typeof personSettlementRevisions.$inferSelect | null> {
	const [latest] = await dbOrTx
		.select()
		.from(personSettlementRevisions)
		.where(eq(personSettlementRevisions.settlementId, settlementId))
		.orderBy(desc(personSettlementRevisions.revisionNo))
		.limit(1);
	return latest ?? null;
}

function buildSettlementReadModel(
	settlement: {
		id: string;
		obligationId: string;
		canonicalTransactionId: string;
	},
	personId: string,
	direction: PersonObligationDirection,
	rev: typeof personSettlementRevisions.$inferSelect,
): SettlementReadModel {
	return {
		settlementId: settlement.id,
		obligationId: settlement.obligationId,
		personId,
		direction,
		status: rev.operation === "VOID" ? "VOIDED" : "ACTIVE",
		assetAccountId: rev.assetAccountId,
		cashAmount: rev.cashAmount,
		appliedAmount: rev.appliedAmount,
		excessAmount: rev.excessAmount,
		overpaymentIncomeReceiptId: rev.overpaymentIncomeReceiptId,
		note: rev.note,
		occurredAt: rev.occurredAt,
		revisionNo: rev.revisionNo,
		canonicalTransactionId: settlement.canonicalTransactionId,
		canonicalRevisionId: rev.canonicalRevisionId,
	};
}

interface SettlementCreateCore {
	direction: PersonObligationDirection;
	userId: string;
	obligationId: string;
	cashAmountNormalized: string;
	assetAccountId: string;
	occurredAt: Date;
	note: string | null;
	idempotencyKey: string;
}

async function createSettlementCore(
	db: Database,
	core: SettlementCreateCore,
): Promise<{ settlement: SettlementReadModel; idempotentReplay: boolean }> {
	return runPeopleTransaction(db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personSettlementRevisions)
			.where(
				and(
					eq(personSettlementRevisions.userId, core.userId),
					eq(personSettlementRevisions.idempotencyKey, core.idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkSettlementCreateReplay(tx, earlyRev, core);
		}

		const [obligationPeek] = await tx
			.select()
			.from(personObligations)
			.where(
				and(
					eq(personObligations.id, core.obligationId),
					eq(personObligations.userId, core.userId),
				),
			)
			.limit(1);

		if (!obligationPeek) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				`Obligation "${core.obligationId}" not found`,
			);
		}
		if (obligationPeek.direction !== core.direction) {
			throw new PeopleError(
				"PEOPLE_INVALID_INPUT",
				`Obligation "${core.obligationId}" direction does not match this settlement type`,
			);
		}

		await tx
			.select({ id: people.id })
			.from(people)
			.where(eq(people.id, obligationPeek.personId))
			.for("update");

		await tx
			.select({ id: personObligations.id })
			.from(personObligations)
			.where(eq(personObligations.id, core.obligationId))
			.for("update");

		const [secondRev] = await tx
			.select()
			.from(personSettlementRevisions)
			.where(
				and(
					eq(personSettlementRevisions.userId, core.userId),
					eq(personSettlementRevisions.idempotencyKey, core.idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkSettlementCreateReplay(tx, secondRev, core);
		}

		await verifyPersonActiveInTransaction(tx, obligationPeek.personId);

		const [latestObligationRev] = await tx
			.select()
			.from(personObligationRevisions)
			.where(eq(personObligationRevisions.obligationId, core.obligationId))
			.orderBy(desc(personObligationRevisions.revisionNo))
			.limit(1);

		if (!latestObligationRev || latestObligationRev.operation === "VOID") {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_NOT_ACTIVE",
				`Obligation "${core.obligationId}" is VOID or has no revisions`,
			);
		}

		const existingSettlements = await tx
			.select({ id: personSettlements.id })
			.from(personSettlements)
			.where(eq(personSettlements.obligationId, core.obligationId));

		let activeSettledCents = 0n;
		for (const s of existingSettlements) {
			const latestSettleRev = await getLatestSettlementRevision(tx, s.id);
			if (latestSettleRev && latestSettleRev.operation !== "VOID") {
				activeSettledCents += parsePositiveMoneyString(
					latestSettleRev.appliedAmount,
				).cents;
			}
		}

		const principalCents = parsePositiveMoneyString(
			latestObligationRev.principalAmount,
		).cents;
		const remainingCents = principalCents - activeSettledCents;

		if (remainingCents <= 0n) {
			throw new PeopleError(
				"PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
				`Obligation "${core.obligationId}" has no remaining balance to settle`,
			);
		}

		const cashCents = parsePositiveMoneyString(core.cashAmountNormalized).cents;
		let appliedCents: bigint;
		let excessCents: bigint;

		if (core.direction === "PAYABLE") {
			if (cashCents > remainingCents) {
				throw new PeopleError(
					"PEOPLE_OBLIGATION_OVERSETTLEMENT",
					`Payment ${core.cashAmountNormalized} exceeds remaining balance ${formatCentsToMoney(remainingCents)}`,
				);
			}
			appliedCents = cashCents;
			excessCents = 0n;
		} else {
			appliedCents = cashCents < remainingCents ? cashCents : remainingCents;
			excessCents = cashCents - appliedCents;
		}

		await validateAssetAccount(
			tx,
			core.userId,
			core.assetAccountId,
			core.direction === "RECEIVABLE"
				? "destinationAssetAccountId"
				: "sourceAssetAccountId",
		);

		const link = await ensurePersonLedgerLinkOrThrow(
			tx,
			obligationPeek.personId,
		);

		const peopleLedgerAccountId =
			core.direction === "RECEIVABLE"
				? link.receivableAccountId
				: link.payableAccountId;

		await lockLedgerAccountsInTransaction({
			tx,
			userId: core.userId,
			accountIds: [peopleLedgerAccountId, core.assetAccountId],
		});

		const settlementId = crypto.randomUUID();
		const appliedNormalized = formatCentsToMoney(appliedCents);
		const cashNormalized = formatCentsToMoney(cashCents);
		const excessNormalized = formatCentsToMoney(excessCents);

		const canonicalPayload: Record<string, unknown> = {
			settlementId,
			obligationId: core.obligationId,
			personId: obligationPeek.personId,
			direction: core.direction,
			appliedAmount: appliedNormalized,
			cashAmount: cashNormalized,
			excessAmount: excessNormalized,
			assetAccountId: core.assetAccountId,
			note: core.note,
		};

		const ledgerLines =
			core.direction === "RECEIVABLE"
				? [
						{
							accountId: core.assetAccountId,
							side: "DEBIT" as const,
							amount: appliedNormalized,
						},
						{
							accountId: link.receivableAccountId,
							side: "CREDIT" as const,
							amount: appliedNormalized,
						},
					]
				: [
						{
							accountId: link.payableAccountId,
							side: "DEBIT" as const,
							amount: appliedNormalized,
						},
						{
							accountId: core.assetAccountId,
							side: "CREDIT" as const,
							amount: appliedNormalized,
						},
					];

		const boundRes = await createCanonicalTransactionWithLedgerInTransaction({
			tx,
			userId: core.userId,
			kind: "PERSON_OBLIGATION_SETTLEMENT",
			idempotencyKey: core.idempotencyKey,
			occurredAt: core.occurredAt,
			payload: canonicalPayload,
			source: {
				type: "PERSON_OBLIGATION_SETTLEMENT",
				ref: core.idempotencyKey,
			},
			ledger: {
				memo:
					core.direction === "RECEIVABLE"
						? "Person receivable settlement"
						: "Person payable settlement",
				lines: ledgerLines,
			},
		});

		await tx.insert(personSettlements).values({
			id: settlementId,
			userId: core.userId,
			obligationId: core.obligationId,
			canonicalTransactionId: boundRes.transactionId,
		});

		let overpaymentIncomeReceiptId: string | null = null;
		if (excessCents > 0n) {
			const sourceInfo = await ensurePeopleOverpaymentIncomeSourceInTransaction(
				tx,
				core.userId,
			);
			const overpaymentCreateKey = await derivePeopleIncomeIdempotencyKey(
				core.idempotencyKey,
				settlementId,
				"OVERPAYMENT_CREATE",
			);
			const incomeRes = await createIncomeReceiptInTransaction({
				tx,
				userId: core.userId,
				sourceId: sourceInfo.incomeSourceId,
				idempotencyKey: overpaymentCreateKey,
				receivedAt: core.occurredAt,
				amount: excessNormalized,
				destinationAccountId: core.assetAccountId,
				note: core.note,
				provenance: {
					type: "PERSON_OBLIGATION_SETTLEMENT_OVERPAYMENT",
					ref: settlementId,
				},
			});
			overpaymentIncomeReceiptId = incomeRes.incomeReceipt.incomeReceiptId;
		}

		const fingerprint = await calculateSettlementCreateFingerprint({
			userId: core.userId,
			obligationId: core.obligationId,
			direction: core.direction,
			assetAccountId: core.assetAccountId,
			cashAmount: cashNormalized,
			occurredAt: core.occurredAt,
			note: core.note,
		});

		const [insertedRev] = await tx
			.insert(personSettlementRevisions)
			.values({
				userId: core.userId,
				settlementId,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				assetAccountId: core.assetAccountId,
				cashAmount: cashNormalized,
				appliedAmount: appliedNormalized,
				excessAmount: excessNormalized,
				overpaymentIncomeReceiptId,
				note: core.note,
				occurredAt: core.occurredAt,
				canonicalRevisionId: boundRes.revisionId,
				idempotencyKey: core.idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person settlement revision",
			);
		}

		return {
			settlement: buildSettlementReadModel(
				{
					id: settlementId,
					obligationId: core.obligationId,
					canonicalTransactionId: boundRes.transactionId,
				},
				obligationPeek.personId,
				core.direction,
				insertedRev,
			),
			idempotentReplay: false,
		};
	});
}

async function ensurePersonLedgerLinkOrThrow(
	tx: DatabaseTransaction,
	personId: string,
): Promise<{ receivableAccountId: string; payableAccountId: string }> {
	const [personRow] = await tx
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	if (!personRow) {
		throw new PeopleError("PEOPLE_NOT_FOUND", `Person "${personId}" not found`);
	}
	return ensurePersonLedgerLinkInTransaction(tx, personRow.userId, personId);
}

async function checkSettlementCreateReplay(
	tx: DatabaseTransaction,
	existingRev: typeof personSettlementRevisions.$inferSelect,
	core: SettlementCreateCore,
): Promise<{ settlement: SettlementReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculateSettlementCreateFingerprint({
		userId: core.userId,
		obligationId: core.obligationId,
		direction: core.direction,
		assetAccountId: core.assetAccountId,
		cashAmount: core.cashAmountNormalized,
		occurredAt: core.occurredAt,
		note: core.note,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different settlement payload",
		);
	}

	const [settlement] = await tx
		.select()
		.from(personSettlements)
		.where(eq(personSettlements.id, existingRev.settlementId))
		.limit(1);

	if (!settlement) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Settlement anchor missing on replay",
		);
	}

	const [obligation] = await tx
		.select({
			personId: personObligations.personId,
			direction: personObligations.direction,
		})
		.from(personObligations)
		.where(eq(personObligations.id, settlement.obligationId))
		.limit(1);

	if (!obligation) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Obligation missing on replay",
		);
	}

	return {
		settlement: buildSettlementReadModel(
			settlement,
			obligation.personId,
			obligation.direction as PersonObligationDirection,
			existingRev,
		),
		idempotentReplay: true,
	};
}

/**
 * Records a receivable settlement: person pays user. Applies min(cashAmount, remaining)
 * against the receivable; any excess becomes a separate EXTRA/EXCLUDED income receipt
 * in the same outer transaction.
 */
export async function recordPersonReceivableSettlement(
	params: RecordPersonReceivableSettlementParams,
): Promise<{ settlement: SettlementReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const obligationId = validateObligationId(params.obligationId);
	const cashAmount = validatePositiveAmount(params.cashAmount);
	const destinationAssetAccountId = validateAccountId(
		params.destinationAssetAccountId,
		"destinationAssetAccountId",
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const note = validateNote(params.note);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	return createSettlementCore(params.db, {
		direction: "RECEIVABLE",
		userId,
		obligationId,
		cashAmountNormalized: cashAmount.normalized,
		assetAccountId: destinationAssetAccountId,
		occurredAt,
		note,
		idempotencyKey,
	});
}

/**
 * Records a payable settlement: user repays person. No automatic overpayment;
 * amount exceeding remaining is rejected with PEOPLE_OBLIGATION_OVERSETTLEMENT.
 */
export async function recordPersonPayableSettlement(
	params: RecordPersonPayableSettlementParams,
): Promise<{ settlement: SettlementReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const obligationId = validateObligationId(params.obligationId);
	const amount = validatePositiveAmount(params.amount);
	const sourceAssetAccountId = validateAccountId(
		params.sourceAssetAccountId,
		"sourceAssetAccountId",
	);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const note = validateNote(params.note);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	return createSettlementCore(params.db, {
		direction: "PAYABLE",
		userId,
		obligationId,
		cashAmountNormalized: amount.normalized,
		assetAccountId: sourceAssetAccountId,
		occurredAt,
		note,
		idempotencyKey,
	});
}

/**
 * Voids a settlement: reverses its ledger effect exactly, and if it contained a
 * receivable overpayment, also voids the linked EXTRA income receipt atomically.
 */
export async function voidPersonSettlement(
	params: VoidPersonSettlementParams,
): Promise<{ settlement: SettlementReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const settlementId = validateSettlementId(params.settlementId);
	const reason = validateReason(params.reason);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	return runPeopleTransaction(params.db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personSettlementRevisions)
			.where(
				and(
					eq(personSettlementRevisions.userId, userId),
					eq(personSettlementRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkSettlementVoidReplay(
				tx,
				earlyRev,
				userId,
				settlementId,
				expectedRevisionNo,
				reason,
			);
		}

		const [settlementPeek] = await tx
			.select()
			.from(personSettlements)
			.where(
				and(
					eq(personSettlements.id, settlementId),
					eq(personSettlements.userId, userId),
				),
			)
			.limit(1);

		if (!settlementPeek) {
			throw new PeopleError(
				"PEOPLE_SETTLEMENT_NOT_FOUND",
				`Settlement "${settlementId}" not found`,
			);
		}

		const [obligationPeek] = await tx
			.select()
			.from(personObligations)
			.where(eq(personObligations.id, settlementPeek.obligationId))
			.limit(1);

		if (!obligationPeek) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Obligation missing for settlement",
			);
		}

		await tx
			.select({ id: people.id })
			.from(people)
			.where(eq(people.id, obligationPeek.personId))
			.for("update");

		await tx
			.select({ id: personObligations.id })
			.from(personObligations)
			.where(eq(personObligations.id, obligationPeek.id))
			.for("update");

		await tx
			.select({ id: personSettlements.id })
			.from(personSettlements)
			.where(eq(personSettlements.id, settlementId))
			.for("update");

		const [secondRev] = await tx
			.select()
			.from(personSettlementRevisions)
			.where(
				and(
					eq(personSettlementRevisions.userId, userId),
					eq(personSettlementRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkSettlementVoidReplay(
				tx,
				secondRev,
				userId,
				settlementId,
				expectedRevisionNo,
				reason,
			);
		}

		await verifyPersonActiveInTransaction(tx, obligationPeek.personId);

		const latest = await getLatestSettlementRevision(tx, settlementId);
		if (!latest) {
			throw new PeopleError(
				"PEOPLE_SETTLEMENT_NOT_FOUND",
				"Settlement has no revisions",
			);
		}
		if (latest.operation === "VOID") {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				`Settlement "${settlementId}" is already VOID`,
			);
		}
		if (latest.revisionNo !== expectedRevisionNo) {
			throw new PeopleError(
				"PEOPLE_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but latest is ${latest.revisionNo}`,
			);
		}

		let boundRes: BoundCanonicalTransactionResult;
		try {
			boundRes = await voidCanonicalTransactionWithLedgerInTransaction({
				tx,
				userId,
				transactionId: settlementPeek.canonicalTransactionId,
				expectedRevisionNo,
				idempotencyKey,
				reasonCode: "PERSON_SETTLEMENT_VOID",
				reasonNote: reason,
				source: { type: "PERSON_OBLIGATION_SETTLEMENT", ref: idempotencyKey },
			});
		} catch (err) {
			if (
				err instanceof CanonicalTransactionError &&
				err.code === "TRANSACTION_REVISION_CONFLICT"
			) {
				throw new PeopleError(
					"PEOPLE_REVISION_CONFLICT",
					"Settlement revision conflict",
				);
			}
			throw err;
		}

		if (boundRes.idempotentReplay) {
			const [existingDomainRev] = await tx
				.select()
				.from(personSettlementRevisions)
				.where(
					eq(
						personSettlementRevisions.canonicalRevisionId,
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
				settlement: buildSettlementReadModel(
					settlementPeek,
					obligationPeek.personId,
					obligationPeek.direction as PersonObligationDirection,
					existingDomainRev,
				),
				idempotentReplay: true,
			};
		}

		if (latest.overpaymentIncomeReceiptId) {
			const [incomeLatestRev] = await tx
				.select({ revisionNo: incomeReceiptRevisions.revisionNo })
				.from(incomeReceiptRevisions)
				.where(
					eq(
						incomeReceiptRevisions.incomeReceiptId,
						latest.overpaymentIncomeReceiptId,
					),
				)
				.orderBy(desc(incomeReceiptRevisions.revisionNo))
				.limit(1);

			if (!incomeLatestRev) {
				throw new PeopleError(
					"PEOPLE_INVALID_STATE",
					"Linked overpayment income receipt has no revisions",
				);
			}

			const overpaymentVoidKey = await derivePeopleIncomeIdempotencyKey(
				idempotencyKey,
				settlementId,
				"OVERPAYMENT_VOID",
			);

			await voidIncomeReceiptInTransaction({
				tx,
				userId,
				incomeReceiptId: latest.overpaymentIncomeReceiptId,
				expectedRevisionNo: incomeLatestRev.revisionNo,
				idempotencyKey: overpaymentVoidKey,
				reasonCode: "PERSON_SETTLEMENT_VOID",
				reasonNote: reason,
				provenance: {
					type: "PERSON_OBLIGATION_SETTLEMENT_OVERPAYMENT_VOID",
					ref: settlementId,
				},
			});
		}

		const fingerprint = await calculateSettlementVoidFingerprint({
			userId,
			settlementId,
			expectedRevisionNo,
			reason,
		});

		const [insertedRev] = await tx
			.insert(personSettlementRevisions)
			.values({
				userId,
				settlementId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "VOID",
				assetAccountId: latest.assetAccountId,
				cashAmount: latest.cashAmount,
				appliedAmount: latest.appliedAmount,
				excessAmount: latest.excessAmount,
				overpaymentIncomeReceiptId: latest.overpaymentIncomeReceiptId,
				note: latest.note,
				occurredAt: latest.occurredAt,
				canonicalRevisionId: boundRes.revisionId,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person settlement void revision",
			);
		}

		return {
			settlement: buildSettlementReadModel(
				settlementPeek,
				obligationPeek.personId,
				obligationPeek.direction as PersonObligationDirection,
				insertedRev,
			),
			idempotentReplay: false,
		};
	});
}

async function checkSettlementVoidReplay(
	tx: DatabaseTransaction,
	existingRev: typeof personSettlementRevisions.$inferSelect,
	userId: string,
	settlementId: string,
	expectedRevisionNo: number,
	reason: string,
): Promise<{ settlement: SettlementReadModel; idempotentReplay: boolean }> {
	const candidateV2 = await calculateSettlementVoidFingerprint({
		userId,
		settlementId,
		expectedRevisionNo,
		reason,
	});

	if (existingRev.revisionFingerprint !== candidateV2) {
		const candidateV1 = await calculateSettlementVoidFingerprintV1({
			userId,
			settlementId,
			expectedRevisionNo,
		});

		if (existingRev.revisionFingerprint !== candidateV1) {
			throw new PeopleError(
				"PEOPLE_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different settlement void payload",
			);
		}

		// Legacy v1 row predates the reason-bearing fingerprint: fall back to
		// comparing against the historical reason stored on the canonical VOID
		// revision itself, so a changed reason still conflicts.
		const [canonicalRev] = await tx
			.select({ reasonNote: transactionRevisions.reasonNote })
			.from(transactionRevisions)
			.where(eq(transactionRevisions.id, existingRev.canonicalRevisionId))
			.limit(1);

		const historicalReason = canonicalRev?.reasonNote ?? null;
		if (historicalReason !== reason) {
			throw new PeopleError(
				"PEOPLE_IDEMPOTENCY_CONFLICT",
				"Idempotency key already used with different settlement void reason",
			);
		}
	}

	const [settlement] = await tx
		.select()
		.from(personSettlements)
		.where(eq(personSettlements.id, existingRev.settlementId))
		.limit(1);

	if (!settlement) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Settlement anchor missing on replay",
		);
	}

	const [obligation] = await tx
		.select({
			personId: personObligations.personId,
			direction: personObligations.direction,
		})
		.from(personObligations)
		.where(eq(personObligations.id, settlement.obligationId))
		.limit(1);

	if (!obligation) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Obligation missing on replay",
		);
	}

	return {
		settlement: buildSettlementReadModel(
			settlement,
			obligation.personId,
			obligation.direction as PersonObligationDirection,
			existingRev,
		),
		idempotentReplay: true,
	};
}

/**
 * Reads a single settlement. Executes inside one transaction/snapshot so the
 * revision and any joined state are read from the same committed state, and
 * routes all errors through the People error boundary.
 */
export async function getPersonSettlement({
	db,
	userId,
	settlementId,
}: GetPersonSettlementParams): Promise<SettlementReadModel> {
	const validUserId = validateUserId(userId);
	const validSettlementId = validateSettlementId(settlementId);

	return runPeopleReadTransaction(db, async (tx) => {
		const [settlement] = await tx
			.select()
			.from(personSettlements)
			.where(
				and(
					eq(personSettlements.id, validSettlementId),
					eq(personSettlements.userId, validUserId),
				),
			)
			.limit(1);

		if (!settlement) {
			throw new PeopleError(
				"PEOPLE_SETTLEMENT_NOT_FOUND",
				`Settlement "${validSettlementId}" not found`,
			);
		}

		const [obligation] = await tx
			.select({
				personId: personObligations.personId,
				direction: personObligations.direction,
			})
			.from(personObligations)
			.where(eq(personObligations.id, settlement.obligationId))
			.limit(1);

		if (!obligation) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Obligation missing for settlement",
			);
		}

		const latest = await getLatestSettlementRevision(tx, validSettlementId);
		if (!latest) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Settlement has no revisions",
			);
		}

		return buildSettlementReadModel(
			settlement,
			obligation.personId,
			obligation.direction as PersonObligationDirection,
			latest,
		);
	});
}

/**
 * Lists settlements with optional filters and stable deterministic ordering.
 */
export async function listPersonSettlements({
	db,
	userId,
	obligationId,
	status,
}: ListPersonSettlementsParams): Promise<SettlementReadModel[]> {
	const validUserId = validateUserId(userId);
	const validObligationId = validateOptionalCanonicalUuid(
		obligationId,
		"obligationId",
	);
	const validStatus = validateOptionalEnum(
		status,
		SETTLEMENT_STATUS_VALUES,
		"status",
	);

	return runPeopleReadTransaction(db, async (tx) => {
		const conditions = [eq(personSettlements.userId, validUserId)];
		if (validObligationId !== undefined) {
			conditions.push(eq(personSettlements.obligationId, validObligationId));
		}

		const rows = await tx
			.select()
			.from(personSettlements)
			.where(and(...conditions))
			.orderBy(asc(personSettlements.createdAt), asc(personSettlements.id));

		const results: SettlementReadModel[] = [];
		for (const row of rows) {
			const latest = await getLatestSettlementRevision(tx, row.id);
			if (!latest) continue;

			if (validStatus !== undefined) {
				const rowStatus = latest.operation === "VOID" ? "VOIDED" : "ACTIVE";
				if (rowStatus !== validStatus) continue;
			}

			const [obligation] = await tx
				.select({
					personId: personObligations.personId,
					direction: personObligations.direction,
				})
				.from(personObligations)
				.where(eq(personObligations.id, row.obligationId))
				.limit(1);

			if (!obligation) continue;

			results.push(
				buildSettlementReadModel(
					row,
					obligation.personId,
					obligation.direction as PersonObligationDirection,
					latest,
				),
			);
		}

		return results;
	});
}
