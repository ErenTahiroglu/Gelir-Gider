import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import { incomeSources } from "../db/schema/income";
import {
	people,
	peopleSystemIncomeLinks,
	personLedgerLinks,
} from "../db/schema/people";
import { IncomeError } from "../income/errors";
import { createIncomeSourceInTransaction } from "../income/sources";
import { ensureDeterministicLedgerAccountInTransaction } from "../ledger/accounts";
import { PeopleError } from "./errors";

export interface PersonLedgerLinkResult {
	receivableAccountId: string;
	payableAccountId: string;
}

/**
 * Ensures the person has an associated 1:1 receivable (ASSET/DEBIT) and
 * payable (LIABILITY/CREDIT) ledger account link. Provisions deterministic,
 * race-safe accounts if the link does not yet exist.
 */
export async function ensurePersonLedgerLinkInTransaction(
	tx: DatabaseTransaction,
	userId: string,
	personId: string,
): Promise<PersonLedgerLinkResult> {
	const [existing] = await tx
		.select({
			receivableAccountId: personLedgerLinks.receivableAccountId,
			payableAccountId: personLedgerLinks.payableAccountId,
		})
		.from(personLedgerLinks)
		.where(
			and(
				eq(personLedgerLinks.userId, userId),
				eq(personLedgerLinks.personId, personId),
			),
		)
		.limit(1);

	if (existing) {
		return existing;
	}

	const [person] = await tx
		.select({ id: people.id, userId: people.userId })
		.from(people)
		.where(and(eq(people.id, personId), eq(people.userId, userId)))
		.limit(1);

	if (!person) {
		throw new PeopleError("PEOPLE_NOT_FOUND", `Person "${personId}" not found`);
	}

	const suffix = personId.replace(/-/g, "").toUpperCase();
	const first8 = personId.replace(/-/g, "").slice(0, 8).toUpperCase();

	const receivableAccount = await ensureDeterministicLedgerAccountInTransaction(
		{
			tx,
			userId,
			code: `PRCV_${suffix}`.slice(0, 64),
			name: `Person receivable ${first8}`,
			accountType: "ASSET",
		},
	);
	const payableAccount = await ensureDeterministicLedgerAccountInTransaction({
		tx,
		userId,
		code: `PPAY_${suffix}`.slice(0, 64),
		name: `Person payable ${first8}`,
		accountType: "LIABILITY",
	});

	const [createdLink] = await tx
		.insert(personLedgerLinks)
		.values({
			userId,
			personId,
			receivableAccountId: receivableAccount.id,
			payableAccountId: payableAccount.id,
		})
		.onConflictDoNothing({ target: [personLedgerLinks.personId] })
		.returning();

	if (createdLink) {
		return {
			receivableAccountId: createdLink.receivableAccountId,
			payableAccountId: createdLink.payableAccountId,
		};
	}

	// Concurrent race already created the link; return its accounts.
	const [raceExisting] = await tx
		.select({
			receivableAccountId: personLedgerLinks.receivableAccountId,
			payableAccountId: personLedgerLinks.payableAccountId,
		})
		.from(personLedgerLinks)
		.where(eq(personLedgerLinks.personId, personId))
		.limit(1);

	if (!raceExisting) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Failed to provision person ledger link",
		);
	}

	return raceExisting;
}

const PEOPLE_OVERPAYMENT_SOURCE_CODE = "PEOPLE_OVERPAYMENT";
const PEOPLE_OVERPAYMENT_SOURCE_NAME = "People settlement overpayment";
const PEOPLE_OVERPAYMENT_ACTIVE_FROM = "1900-01-01";

export interface PeopleOverpaymentIncomeSourceResult {
	incomeSourceId: string;
	incomeLedgerAccountId: string;
}

function validatePeopleOverpaymentSourceContract(source: {
	id: string;
	code: string;
	nature: string;
	referenceMethod: string;
	archivedAt: Date | null;
}): void {
	if (source.code !== PEOPLE_OVERPAYMENT_SOURCE_CODE) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			`People overpayment income source ${source.id} has unexpected code ${source.code}`,
		);
	}
	if (source.nature !== "EXTRA" || source.referenceMethod !== "EXCLUDED") {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			`People overpayment income source ${source.id} must be nature=EXTRA/referenceMethod=EXCLUDED`,
		);
	}
	if (source.archivedAt !== null) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			`People overpayment income source ${source.id} is archived`,
		);
	}
}

/**
 * Ensures the per-user system income source used to record receivable
 * settlement overpayment excess (nature=EXTRA, referenceMethod=EXCLUDED)
 * exists, provisioning it race-safely exactly once per user.
 */
export async function ensurePeopleOverpaymentIncomeSourceInTransaction(
	tx: DatabaseTransaction,
	userId: string,
): Promise<PeopleOverpaymentIncomeSourceResult> {
	const [existingLink] = await tx
		.select({ incomeSourceId: peopleSystemIncomeLinks.incomeSourceId })
		.from(peopleSystemIncomeLinks)
		.where(
			and(
				eq(peopleSystemIncomeLinks.userId, userId),
				eq(peopleSystemIncomeLinks.role, "OVERPAYMENT_EXTRA"),
			),
		)
		.limit(1);

	if (existingLink) {
		const [source] = await tx
			.select({
				id: incomeSources.id,
				code: incomeSources.code,
				nature: incomeSources.nature,
				referenceMethod: incomeSources.referenceMethod,
				archivedAt: incomeSources.archivedAt,
				incomeLedgerAccountId: incomeSources.incomeLedgerAccountId,
			})
			.from(incomeSources)
			.where(eq(incomeSources.id, existingLink.incomeSourceId))
			.limit(1);

		if (!source) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"People overpayment income link exists but source is missing",
			);
		}
		validatePeopleOverpaymentSourceContract(source);

		return {
			incomeSourceId: source.id,
			incomeLedgerAccountId: source.incomeLedgerAccountId,
		};
	}

	const [existingSourceByCode] = await tx
		.select({
			id: incomeSources.id,
			code: incomeSources.code,
			nature: incomeSources.nature,
			referenceMethod: incomeSources.referenceMethod,
			archivedAt: incomeSources.archivedAt,
			incomeLedgerAccountId: incomeSources.incomeLedgerAccountId,
		})
		.from(incomeSources)
		.where(
			and(
				eq(incomeSources.userId, userId),
				eq(incomeSources.code, PEOPLE_OVERPAYMENT_SOURCE_CODE),
			),
		)
		.limit(1);

	let sourceId: string;
	let incomeLedgerAccountId: string;

	if (existingSourceByCode) {
		validatePeopleOverpaymentSourceContract(existingSourceByCode);
		sourceId = existingSourceByCode.id;
		incomeLedgerAccountId = existingSourceByCode.incomeLedgerAccountId;
	} else {
		const account = await ensureDeterministicLedgerAccountInTransaction({
			tx,
			userId,
			code: "SYS_PEOPLE_OVERPAYMENT_INC",
			name: "People Overpayment Income",
			accountType: "INCOME",
		});

		try {
			const source = await createIncomeSourceInTransaction({
				tx,
				userId,
				code: PEOPLE_OVERPAYMENT_SOURCE_CODE,
				name: PEOPLE_OVERPAYMENT_SOURCE_NAME,
				nature: "EXTRA",
				referenceMethod: "EXCLUDED",
				incomeLedgerAccountId: account.id,
				activeFrom: PEOPLE_OVERPAYMENT_ACTIVE_FROM,
			});
			sourceId = source.id;
			incomeLedgerAccountId = account.id;
		} catch (err) {
			// A concurrent transaction (e.g. provisioning for a different person)
			// won the race to create this singleton source first; reuse its row
			// rather than surfacing a conflict for an otherwise-valid operation.
			if (
				err instanceof IncomeError &&
				err.code === "INCOME_SOURCE_CODE_CONFLICT"
			) {
				const [raceSourceByCode] = await tx
					.select({
						id: incomeSources.id,
						code: incomeSources.code,
						nature: incomeSources.nature,
						referenceMethod: incomeSources.referenceMethod,
						archivedAt: incomeSources.archivedAt,
						incomeLedgerAccountId: incomeSources.incomeLedgerAccountId,
					})
					.from(incomeSources)
					.where(
						and(
							eq(incomeSources.userId, userId),
							eq(incomeSources.code, PEOPLE_OVERPAYMENT_SOURCE_CODE),
						),
					)
					.limit(1);
				if (!raceSourceByCode) throw err;
				validatePeopleOverpaymentSourceContract(raceSourceByCode);
				sourceId = raceSourceByCode.id;
				incomeLedgerAccountId = raceSourceByCode.incomeLedgerAccountId;
			} else {
				throw err;
			}
		}
	}

	const [insertedLink] = await tx
		.insert(peopleSystemIncomeLinks)
		.values({
			userId,
			role: "OVERPAYMENT_EXTRA",
			incomeSourceId: sourceId,
		})
		.onConflictDoNothing({
			target: [peopleSystemIncomeLinks.userId, peopleSystemIncomeLinks.role],
		})
		.returning();

	if (insertedLink) {
		return { incomeSourceId: sourceId, incomeLedgerAccountId };
	}

	// Concurrent race already created the link; return its resolved source.
	const [raceLink] = await tx
		.select({ incomeSourceId: peopleSystemIncomeLinks.incomeSourceId })
		.from(peopleSystemIncomeLinks)
		.where(
			and(
				eq(peopleSystemIncomeLinks.userId, userId),
				eq(peopleSystemIncomeLinks.role, "OVERPAYMENT_EXTRA"),
			),
		)
		.limit(1);

	if (!raceLink) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Failed to provision People overpayment income source",
		);
	}

	const [raceSource] = await tx
		.select({
			id: incomeSources.id,
			code: incomeSources.code,
			nature: incomeSources.nature,
			referenceMethod: incomeSources.referenceMethod,
			archivedAt: incomeSources.archivedAt,
			incomeLedgerAccountId: incomeSources.incomeLedgerAccountId,
		})
		.from(incomeSources)
		.where(eq(incomeSources.id, raceLink.incomeSourceId))
		.limit(1);

	if (!raceSource) {
		throw new PeopleError(
			"PEOPLE_INVALID_STATE",
			"Failed to resolve People overpayment income source after race",
		);
	}
	validatePeopleOverpaymentSourceContract(raceSource);

	return {
		incomeSourceId: raceSource.id,
		incomeLedgerAccountId: raceSource.incomeLedgerAccountId,
	};
}
