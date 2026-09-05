import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/auth";
import {
	PERSON_RELATIONSHIPS,
	PERSON_STATUSES,
	type PersonRelationship,
	people,
	personLedgerLinks,
	personRevisions,
} from "../db/schema/people";
import { getLedgerAccountBalanceInTransaction } from "../ledger/balances";
import { runPeopleReadTransaction, runPeopleTransaction } from "./boundary";
import { validateOccurredAt } from "./calendar";
import { PeopleError } from "./errors";
import {
	calculatePersonArchiveFingerprint,
	calculatePersonCreateFingerprint,
	calculatePersonUpdateFingerprint,
} from "./fingerprint";
import {
	validateCanonicalUuid,
	validateExpectedRevisionNo,
	validateOptionalEnum,
} from "./validation";

export interface PersonReadModel {
	personId: string;
	status: "ACTIVE" | "ARCHIVED";
	displayName: string;
	relationship: PersonRelationship;
	note: string | null;
	revisionNo: number;
	receivableAccountId: string | null;
	receivableBalance: string;
	payableAccountId: string | null;
	payableBalance: string;
}

export interface CreatePersonParams {
	db: Database;
	userId: string;
	displayName: string;
	relationship: PersonRelationship;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface UpdatePersonParams {
	db: Database;
	userId: string;
	personId: string;
	expectedRevisionNo: number;
	displayName: string;
	relationship: PersonRelationship;
	note?: string | null | undefined;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface ArchivePersonParams {
	db: Database;
	userId: string;
	personId: string;
	expectedRevisionNo: number;
	occurredAt: Date;
	idempotencyKey: string;
}

export interface GetPersonParams {
	db: Database;
	userId: string;
	personId: string;
}

export interface ListPeopleParams {
	db: Database;
	userId: string;
	status?: "ACTIVE" | "ARCHIVED" | undefined;
	relationship?: PersonRelationship | undefined;
}

function validateDisplayName(value: string): string {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length < 1 || trimmed.length > 120) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"displayName must be between 1 and 120 characters",
		);
	}
	return trimmed;
}

function validateRelationship(value: string): PersonRelationship {
	if (!PERSON_RELATIONSHIPS.includes(value as PersonRelationship)) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			`Invalid relationship: "${value}". Must be one of ${PERSON_RELATIONSHIPS.join(", ")}`,
		);
	}
	return value as PersonRelationship;
}

function validateNote(value: string | null | undefined): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}
	if (trimmed.length > 500) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"note must be between 1 and 500 characters when provided",
		);
	}
	return trimmed;
}

function validateIdempotencyKey(value: string): string {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length < 1 || trimmed.length > 128) {
		throw new PeopleError(
			"PEOPLE_INVALID_INPUT",
			"idempotencyKey must be between 1 and 128 characters",
		);
	}
	return trimmed;
}

function validateUserId(value: string): string {
	return validateCanonicalUuid(value, "userId");
}

function validatePersonId(value: string): string {
	return validateCanonicalUuid(value, "personId");
}

/**
 * Creates a new person identity with revision #1. Fresh CREATE serialization:
 * early replay -> users row FOR UPDATE -> second replay -> person anchor -> revision #1.
 */
export async function createPerson(
	params: CreatePersonParams,
): Promise<{ person: PersonReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const displayName = validateDisplayName(params.displayName);
	const relationship = validateRelationship(params.relationship);
	const note = validateNote(params.note);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);

	return runPeopleTransaction(params.db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personRevisions)
			.where(
				and(
					eq(personRevisions.userId, userId),
					eq(personRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkPersonCreateReplay(
				earlyRev,
				userId,
				displayName,
				relationship,
				note,
				occurredAt,
			);
		}

		const [user] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");

		if (!user) {
			throw new PeopleError("PEOPLE_INVALID_INPUT", "User does not exist");
		}

		const [secondRev] = await tx
			.select()
			.from(personRevisions)
			.where(
				and(
					eq(personRevisions.userId, userId),
					eq(personRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkPersonCreateReplay(
				secondRev,
				userId,
				displayName,
				relationship,
				note,
				occurredAt,
			);
		}

		const [insertedPerson] = await tx
			.insert(people)
			.values({ userId })
			.returning();

		if (!insertedPerson) {
			throw new PeopleError("PEOPLE_INVALID_STATE", "Failed to create person");
		}

		const fingerprint = await calculatePersonCreateFingerprint({
			userId,
			displayName,
			relationship,
			note,
			occurredAt,
		});

		const [insertedRev] = await tx
			.insert(personRevisions)
			.values({
				userId,
				personId: insertedPerson.id,
				revisionNo: 1,
				previousRevisionId: null,
				operation: "CREATE",
				status: "ACTIVE",
				displayName,
				relationship,
				note,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to create person revision",
			);
		}

		return {
			person: toReadModelBase(insertedPerson.id, insertedRev),
			idempotentReplay: false,
		};
	});
}

async function checkPersonCreateReplay(
	existingRev: typeof personRevisions.$inferSelect,
	userId: string,
	displayName: string,
	relationship: PersonRelationship,
	note: string | null,
	occurredAt: Date,
): Promise<{ person: PersonReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculatePersonCreateFingerprint({
		userId,
		displayName,
		relationship,
		note,
		occurredAt,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different person payload",
		);
	}

	return {
		person: toReadModelBase(existingRev.personId, existingRev),
		idempotentReplay: true,
	};
}

function toReadModelBase(
	personId: string,
	rev: typeof personRevisions.$inferSelect,
): PersonReadModel {
	return {
		personId,
		status: rev.status as "ACTIVE" | "ARCHIVED",
		displayName: rev.displayName,
		relationship: rev.relationship as PersonRelationship,
		note: rev.note,
		revisionNo: rev.revisionNo,
		receivableAccountId: null,
		receivableBalance: "0.00",
		payableAccountId: null,
		payableBalance: "0.00",
	};
}

/**
 * Updates a person's mutable profile fields. Requires expectedRevisionNo (OCC).
 * Historical replay is checked before any mutable-state validation.
 */
export async function updatePerson(
	params: UpdatePersonParams,
): Promise<{ person: PersonReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const personId = validatePersonId(params.personId);
	const displayName = validateDisplayName(params.displayName);
	const relationship = validateRelationship(params.relationship);
	const note = validateNote(params.note);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	return runPeopleTransaction(params.db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personRevisions)
			.where(
				and(
					eq(personRevisions.userId, userId),
					eq(personRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkPersonMutationReplay(
				earlyRev,
				userId,
				personId,
				expectedRevisionNo,
				displayName,
				relationship,
				note,
				occurredAt,
			);
		}

		const [person] = await tx
			.select({ id: people.id, userId: people.userId })
			.from(people)
			.where(and(eq(people.id, personId), eq(people.userId, userId)))
			.for("update");

		if (!person) {
			throw new PeopleError(
				"PEOPLE_NOT_FOUND",
				`Person "${personId}" not found`,
			);
		}

		const [secondRev] = await tx
			.select()
			.from(personRevisions)
			.where(
				and(
					eq(personRevisions.userId, userId),
					eq(personRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkPersonMutationReplay(
				secondRev,
				userId,
				personId,
				expectedRevisionNo,
				displayName,
				relationship,
				note,
				occurredAt,
			);
		}

		const [latest] = await tx
			.select()
			.from(personRevisions)
			.where(eq(personRevisions.personId, personId))
			.orderBy(desc(personRevisions.revisionNo))
			.limit(1);

		if (!latest) {
			throw new PeopleError("PEOPLE_NOT_FOUND", "Person has no revisions");
		}

		if (latest.revisionNo !== expectedRevisionNo) {
			throw new PeopleError(
				"PEOPLE_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but latest is ${latest.revisionNo}`,
			);
		}

		if (latest.status !== "ACTIVE") {
			throw new PeopleError(
				"PEOPLE_NOT_ACTIVE",
				`Person "${personId}" is not active`,
			);
		}

		const fingerprint = await calculatePersonUpdateFingerprint({
			userId,
			personId,
			expectedRevisionNo,
			displayName,
			relationship,
			note,
			occurredAt,
		});

		const [insertedRev] = await tx
			.insert(personRevisions)
			.values({
				userId,
				personId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "UPDATE",
				status: "ACTIVE",
				displayName,
				relationship,
				note,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person update revision",
			);
		}

		return {
			person: toReadModelBase(personId, insertedRev),
			idempotentReplay: false,
		};
	});
}

async function checkPersonMutationReplay(
	existingRev: typeof personRevisions.$inferSelect,
	userId: string,
	personId: string,
	expectedRevisionNo: number,
	displayName: string,
	relationship: PersonRelationship,
	note: string | null,
	occurredAt: Date,
): Promise<{ person: PersonReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculatePersonUpdateFingerprint({
		userId,
		personId,
		expectedRevisionNo,
		displayName,
		relationship,
		note,
		occurredAt,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different person update payload",
		);
	}

	return {
		person: toReadModelBase(existingRev.personId, existingRev),
		idempotentReplay: true,
	};
}

/**
 * Archives a person. Requires zero receivable/payable balance and zero remaining
 * on all non-VOID obligations. Historical replay is checked before mutable-state validation.
 */
export async function archivePerson(
	params: ArchivePersonParams,
): Promise<{ person: PersonReadModel; idempotentReplay: boolean }> {
	const userId = validateUserId(params.userId);
	const personId = validatePersonId(params.personId);
	const occurredAt = validateOccurredAt(params.occurredAt);
	const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
	const expectedRevisionNo = validateExpectedRevisionNo(
		params.expectedRevisionNo,
	);

	return runPeopleTransaction(params.db, async (tx) => {
		const [earlyRev] = await tx
			.select()
			.from(personRevisions)
			.where(
				and(
					eq(personRevisions.userId, userId),
					eq(personRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (earlyRev) {
			return checkPersonArchiveReplay(
				earlyRev,
				userId,
				personId,
				expectedRevisionNo,
				occurredAt,
			);
		}

		const [person] = await tx
			.select({ id: people.id })
			.from(people)
			.where(and(eq(people.id, personId), eq(people.userId, userId)))
			.for("update");

		if (!person) {
			throw new PeopleError(
				"PEOPLE_NOT_FOUND",
				`Person "${personId}" not found`,
			);
		}

		const [secondRev] = await tx
			.select()
			.from(personRevisions)
			.where(
				and(
					eq(personRevisions.userId, userId),
					eq(personRevisions.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);

		if (secondRev) {
			return checkPersonArchiveReplay(
				secondRev,
				userId,
				personId,
				expectedRevisionNo,
				occurredAt,
			);
		}

		const [latest] = await tx
			.select()
			.from(personRevisions)
			.where(eq(personRevisions.personId, personId))
			.orderBy(desc(personRevisions.revisionNo))
			.limit(1);

		if (!latest) {
			throw new PeopleError("PEOPLE_NOT_FOUND", "Person has no revisions");
		}

		if (latest.revisionNo !== expectedRevisionNo) {
			throw new PeopleError(
				"PEOPLE_REVISION_CONFLICT",
				`Expected revision ${expectedRevisionNo} but latest is ${latest.revisionNo}`,
			);
		}

		if (latest.status !== "ACTIVE") {
			throw new PeopleError(
				"PEOPLE_NOT_ACTIVE",
				`Person "${personId}" is not active`,
			);
		}

		const [link] = await tx
			.select()
			.from(personLedgerLinks)
			.where(eq(personLedgerLinks.personId, personId))
			.limit(1);

		if (link) {
			const receivableBalance = await getLedgerAccountBalanceInTransaction({
				tx,
				userId,
				accountId: link.receivableAccountId,
			});
			if (receivableBalance.balance !== "0.00") {
				throw new PeopleError(
					"PEOPLE_INVALID_STATE",
					`Cannot archive person "${personId}" with non-zero receivable balance ${receivableBalance.balance}`,
				);
			}

			const payableBalance = await getLedgerAccountBalanceInTransaction({
				tx,
				userId,
				accountId: link.payableAccountId,
			});
			if (payableBalance.balance !== "0.00") {
				throw new PeopleError(
					"PEOPLE_INVALID_STATE",
					`Cannot archive person "${personId}" with non-zero payable balance ${payableBalance.balance}`,
				);
			}
		}

		const fingerprint = await calculatePersonArchiveFingerprint({
			userId,
			personId,
			expectedRevisionNo,
			occurredAt,
		});

		const [insertedRev] = await tx
			.insert(personRevisions)
			.values({
				userId,
				personId,
				revisionNo: latest.revisionNo + 1,
				previousRevisionId: latest.id,
				operation: "ARCHIVE",
				status: "ARCHIVED",
				displayName: latest.displayName,
				relationship: latest.relationship,
				note: latest.note,
				occurredAt,
				idempotencyKey,
				revisionFingerprint: fingerprint,
			})
			.returning();

		if (!insertedRev) {
			throw new PeopleError(
				"PEOPLE_INVALID_STATE",
				"Failed to insert person archive revision",
			);
		}

		return {
			person: toReadModelBase(personId, insertedRev),
			idempotentReplay: false,
		};
	});
}

async function checkPersonArchiveReplay(
	existingRev: typeof personRevisions.$inferSelect,
	userId: string,
	personId: string,
	expectedRevisionNo: number,
	occurredAt: Date,
): Promise<{ person: PersonReadModel; idempotentReplay: boolean }> {
	const candidateFingerprint = await calculatePersonArchiveFingerprint({
		userId,
		personId,
		expectedRevisionNo,
		occurredAt,
	});

	if (existingRev.revisionFingerprint !== candidateFingerprint) {
		throw new PeopleError(
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"Idempotency key already used with different person archive payload",
		);
	}

	return {
		person: toReadModelBase(existingRev.personId, existingRev),
		idempotentReplay: true,
	};
}

/**
 * Reads a person with live-derived receivable/payable balances. Executes
 * inside one transaction/snapshot and routes all errors through the People
 * error boundary, so the revision and balances are never read from different
 * committed states.
 */
export async function getPerson({
	db,
	userId,
	personId,
}: GetPersonParams): Promise<PersonReadModel> {
	const validUserId = validateUserId(userId);
	const validPersonId = validatePersonId(personId);

	return runPeopleReadTransaction(db, async (tx) => {
		const [person] = await tx
			.select({ id: people.id })
			.from(people)
			.where(and(eq(people.id, validPersonId), eq(people.userId, validUserId)))
			.limit(1);

		if (!person) {
			throw new PeopleError(
				"PEOPLE_NOT_FOUND",
				`Person "${validPersonId}" not found`,
			);
		}

		const [latest] = await tx
			.select()
			.from(personRevisions)
			.where(eq(personRevisions.personId, validPersonId))
			.orderBy(desc(personRevisions.revisionNo))
			.limit(1);

		if (!latest) {
			throw new PeopleError("PEOPLE_INVALID_STATE", "Person has no revisions");
		}

		const base = toReadModelBase(validPersonId, latest);

		const [link] = await tx
			.select()
			.from(personLedgerLinks)
			.where(eq(personLedgerLinks.personId, validPersonId))
			.limit(1);

		if (!link) {
			return base;
		}

		const receivableBalance = await getLedgerAccountBalanceInTransaction({
			tx,
			userId: validUserId,
			accountId: link.receivableAccountId,
		});
		const payableBalance = await getLedgerAccountBalanceInTransaction({
			tx,
			userId: validUserId,
			accountId: link.payableAccountId,
		});

		return {
			...base,
			receivableAccountId: link.receivableAccountId,
			receivableBalance: receivableBalance.balance,
			payableAccountId: link.payableAccountId,
			payableBalance: payableBalance.balance,
		};
	});
}

/**
 * Lists people for a user with optional status/relationship filters and stable ordering.
 */
export async function listPeople({
	db,
	userId,
	status,
	relationship,
}: ListPeopleParams): Promise<PersonReadModel[]> {
	const validUserId = validateUserId(userId);
	const validStatus = validateOptionalEnum(status, PERSON_STATUSES, "status");
	const validRelationship = validateOptionalEnum(
		relationship,
		PERSON_RELATIONSHIPS,
		"relationship",
	);

	return runPeopleReadTransaction(db, async (tx) => {
		const rows = await tx
			.select({ id: people.id })
			.from(people)
			.where(eq(people.userId, validUserId))
			.orderBy(asc(people.createdAt), asc(people.id));

		const results: PersonReadModel[] = [];
		for (const row of rows) {
			const [latest] = await tx
				.select()
				.from(personRevisions)
				.where(eq(personRevisions.personId, row.id))
				.orderBy(desc(personRevisions.revisionNo))
				.limit(1);

			if (!latest) continue;

			if (validStatus !== undefined && latest.status !== validStatus) {
				continue;
			}
			if (
				validRelationship !== undefined &&
				latest.relationship !== validRelationship
			) {
				continue;
			}

			const base = toReadModelBase(row.id, latest);

			const [link] = await tx
				.select()
				.from(personLedgerLinks)
				.where(eq(personLedgerLinks.personId, row.id))
				.limit(1);

			if (!link) {
				results.push(base);
				continue;
			}

			const receivableBalance = await getLedgerAccountBalanceInTransaction({
				tx,
				userId: validUserId,
				accountId: link.receivableAccountId,
			});
			const payableBalance = await getLedgerAccountBalanceInTransaction({
				tx,
				userId: validUserId,
				accountId: link.payableAccountId,
			});

			results.push({
				...base,
				receivableAccountId: link.receivableAccountId,
				receivableBalance: receivableBalance.balance,
				payableAccountId: link.payableAccountId,
				payableBalance: payableBalance.balance,
			});
		}

		return results;
	});
}
