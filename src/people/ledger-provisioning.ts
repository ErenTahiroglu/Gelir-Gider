import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import { incomeSources } from "../db/schema/income";
import { ledgerAccounts } from "../db/schema/ledger";
import {
	people,
	peopleSystemIncomeLinks,
	personLedgerLinks,
} from "../db/schema/people";
import { IncomeError } from "../income/errors";
import { createIncomeSourceInTransaction } from "../income/sources";
import { createLedgerAccountInTransaction } from "../ledger/accounts";
import { LedgerError } from "../ledger/errors";
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

	const receivableAccount = await provisionAccountWithRetry(
		tx,
		userId,
		`PRCV_${suffix}`.slice(0, 64),
		`Person receivable ${first8}`,
		"ASSET",
	);
	const payableAccount = await provisionAccountWithRetry(
		tx,
		userId,
		`PPAY_${suffix}`.slice(0, 64),
		`Person payable ${first8}`,
		"LIABILITY",
	);

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

/**
 * Provisions a ledger account at a deterministic, singleton code. If a
 * concurrent transaction already created an account at that exact code, this
 * re-reads and reuses that row instead of retrying with a suffixed code --
 * a code collision on one of these identities always means "this exact
 * resource already exists", never "a different resource happened to collide",
 * so a suffix-retry would only create a permanent orphan duplicate.
 */
async function provisionAccountWithRetry(
	tx: DatabaseTransaction,
	userId: string,
	code: string,
	name: string,
	accountType: "ASSET" | "LIABILITY",
): Promise<{ id: string }> {
	try {
		return await createLedgerAccountInTransaction({
			tx,
			userId,
			code,
			name,
			accountType,
		});
	} catch (err: unknown) {
		if (
			err instanceof LedgerError &&
			err.code === "LEDGER_ACCOUNT_CODE_CONFLICT"
		) {
			const [existing] = await tx
				.select({ id: ledgerAccounts.id })
				.from(ledgerAccounts)
				.where(
					and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.code, code)),
				)
				.limit(1);
			if (existing) {
				return existing;
			}
		}
		throw err;
	}
}

const PEOPLE_OVERPAYMENT_SOURCE_CODE = "PEOPLE_OVERPAYMENT";
const PEOPLE_OVERPAYMENT_SOURCE_NAME = "People settlement overpayment";
const PEOPLE_OVERPAYMENT_ACTIVE_FROM = "1900-01-01";

export interface PeopleOverpaymentIncomeSourceResult {
	incomeSourceId: string;
	incomeLedgerAccountId: string;
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

		return {
			incomeSourceId: source.id,
			incomeLedgerAccountId: source.incomeLedgerAccountId,
		};
	}

	const [existingSourceByCode] = await tx
		.select({
			id: incomeSources.id,
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
		sourceId = existingSourceByCode.id;
		incomeLedgerAccountId = existingSourceByCode.incomeLedgerAccountId;
	} else {
		const account = await provisionIncomeAccountWithRetry(
			tx,
			userId,
			"SYS_PEOPLE_OVERPAYMENT_INC",
		);

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

	return {
		incomeSourceId: raceSource.id,
		incomeLedgerAccountId: raceSource.incomeLedgerAccountId,
	};
}

/**
 * Provisions the singleton per-user overpayment income ledger account. See
 * `provisionAccountWithRetry` for why a code conflict is resolved by re-read
 * rather than a suffix retry.
 */
async function provisionIncomeAccountWithRetry(
	tx: DatabaseTransaction,
	userId: string,
	code: string,
): Promise<{ id: string }> {
	try {
		return await createLedgerAccountInTransaction({
			tx,
			userId,
			code,
			name: "People Overpayment Income",
			accountType: "INCOME",
		});
	} catch (err: unknown) {
		if (
			err instanceof LedgerError &&
			err.code === "LEDGER_ACCOUNT_CODE_CONFLICT"
		) {
			const [existing] = await tx
				.select({ id: ledgerAccounts.id })
				.from(ledgerAccounts)
				.where(
					and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.code, code)),
				)
				.limit(1);
			if (existing) {
				return existing;
			}
		}
		throw err;
	}
}
