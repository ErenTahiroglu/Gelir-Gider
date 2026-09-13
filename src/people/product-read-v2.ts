import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditCardPurchaseSplitParticipants } from "../db/schema/credit-card-splits";
import {
	type PersonObligationDirection,
	type PersonRelationship,
	type PersonStatus,
	people,
	personLedgerLinks,
	personObligationRevisions,
	personObligations,
	personRevisions,
	personSettlementRevisions,
	personSettlements,
} from "../db/schema/people";
import { getLedgerAccountBalanceInTransaction } from "../ledger/balances";
import { parsePositiveMoneyString } from "../ledger/money";
import { runPeopleReadTransaction } from "./boundary";
import type { ObligationReadModel } from "./obligations";
import type {
	ObligationCursor,
	PersonCursor,
	SettlementCursor,
} from "./pagination";
import type { PersonReadModel } from "./people";
import type { SettlementReadModel } from "./settlements";
import { validateCanonicalUuid } from "./validation";

// ============================================================================
// Product DTO Interfaces (Sanitized Public Surface)
// ============================================================================

export interface PersonProductDto {
	personId: string;
	status: PersonStatus;
	displayName: string;
	relationship: PersonRelationship;
	note: string | null;
	revisionNo: number;
	receivableBalance: string;
	payableBalance: string;
}

export interface ObligationProductDto {
	obligationId: string;
	personId: string;
	direction: PersonObligationDirection;
	status: "OPEN" | "SETTLED" | "VOID";
	principalAmount: string;
	settledAmount: string;
	remainingAmount: string;
	dueDate: string | null;
	description: string | null;
	budgetCategory: string | null;
	revisionNo: number;
	isSplitManaged: boolean;
	fundingAssetAccountId?: string | null | undefined;
}

export interface SettlementProductDto {
	settlementId: string;
	obligationId: string;
	personId: string;
	direction: PersonObligationDirection;
	status: "ACTIVE" | "VOIDED";
	cashAmount: string;
	appliedAmount: string;
	excessAmount: string;
	note: string | null;
	occurredAt: string;
	revisionNo: number;
	assetAccountId?: string | undefined;
	overpaymentIncomeReceiptId?: string | null | undefined;
}

// ============================================================================
// Public DTO Mappers
// ============================================================================

export function toPersonProductDto(
	model:
		| PersonReadModel
		| {
				personId: string;
				status: PersonStatus;
				displayName: string;
				relationship: PersonRelationship;
				note: string | null;
				revisionNo: number;
				receivableBalance: string;
				payableBalance: string;
		  },
): PersonProductDto {
	return {
		personId: model.personId,
		status: model.status,
		displayName: model.displayName,
		relationship: model.relationship,
		note: model.note,
		revisionNo: model.revisionNo,
		receivableBalance: model.receivableBalance,
		payableBalance: model.payableBalance,
	};
}

export function toObligationProductDto(
	model:
		| ObligationReadModel
		| {
				obligationId: string;
				personId: string;
				direction: PersonObligationDirection;
				status: "OPEN" | "SETTLED" | "VOID";
				principalAmount: string;
				settledAmount: string;
				remainingAmount: string;
				dueDate: string | null;
				description: string | null;
				budgetCategory: string | null;
				revisionNo: number;
				fundingAssetAccountId?: string | null;
		  },
	isSplitManaged: boolean,
): ObligationProductDto {
	const dto: ObligationProductDto = {
		obligationId: model.obligationId,
		personId: model.personId,
		direction: model.direction,
		status: model.status,
		principalAmount: model.principalAmount,
		settledAmount: model.settledAmount,
		remainingAmount: model.remainingAmount,
		dueDate: model.dueDate,
		description: model.description,
		budgetCategory: model.budgetCategory ?? null,
		revisionNo: model.revisionNo,
		isSplitManaged,
	};

	if (
		model.direction === "RECEIVABLE" &&
		model.fundingAssetAccountId !== undefined
	) {
		dto.fundingAssetAccountId = model.fundingAssetAccountId;
	}

	return dto;
}

export function toSettlementProductDto(
	model:
		| SettlementReadModel
		| {
				settlementId: string;
				obligationId: string;
				personId: string;
				direction: PersonObligationDirection;
				status: "ACTIVE" | "VOIDED";
				cashAmount: string;
				appliedAmount: string;
				excessAmount: string;
				note: string | null;
				occurredAt: Date | string;
				revisionNo: number;
				assetAccountId?: string;
				overpaymentIncomeReceiptId?: string | null;
		  },
): SettlementProductDto {
	const occurredAtStr =
		model.occurredAt instanceof Date
			? model.occurredAt.toISOString()
			: String(model.occurredAt);

	return {
		settlementId: model.settlementId,
		obligationId: model.obligationId,
		personId: model.personId,
		direction: model.direction,
		status: model.status,
		cashAmount: model.cashAmount,
		appliedAmount: model.appliedAmount,
		excessAmount: model.excessAmount,
		note: model.note,
		occurredAt: occurredAtStr,
		revisionNo: model.revisionNo,
		...(model.assetAccountId !== undefined
			? { assetAccountId: model.assetAccountId }
			: {}),
		...(model.overpaymentIncomeReceiptId !== undefined
			? { overpaymentIncomeReceiptId: model.overpaymentIncomeReceiptId }
			: {}),
	};
}

// ============================================================================
// 1. Bounded People Query
// ============================================================================

export interface ListBoundedPeopleParams {
	db: Database;
	userId: string;
	status?: "ACTIVE" | "ARCHIVED" | undefined;
	relationship?: PersonRelationship | undefined;
	limit: number;
	afterCursor?: PersonCursor | undefined;
}

export interface ListBoundedPeopleResult {
	people: PersonProductDto[];
	hasMore: boolean;
	nextCursor: PersonCursor | null;
}

export async function listBoundedPeople({
	db,
	userId,
	status,
	relationship,
	limit,
	afterCursor,
}: ListBoundedPeopleParams): Promise<ListBoundedPeopleResult> {
	const validUserId = validateCanonicalUuid(userId, "userId");

	return runPeopleReadTransaction(db, async (tx) => {
		const latestPersonRevsSq = tx
			.selectDistinctOn([personRevisions.personId], {
				personId: personRevisions.personId,
				userId: personRevisions.userId,
				revisionNo: personRevisions.revisionNo,
				status: personRevisions.status,
				displayName: personRevisions.displayName,
				relationship: personRevisions.relationship,
				note: personRevisions.note,
				createdAt: people.createdAt,
			})
			.from(personRevisions)
			.innerJoin(people, eq(people.id, personRevisions.personId))
			.where(eq(personRevisions.userId, validUserId))
			.orderBy(personRevisions.personId, desc(personRevisions.revisionNo))
			.as("latest_person_revs");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [
			eq(latestPersonRevsSq.userId, validUserId),
		];

		if (status !== undefined) {
			conditions.push(eq(latestPersonRevsSq.status, status));
		}
		if (relationship !== undefined) {
			conditions.push(eq(latestPersonRevsSq.relationship, relationship));
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(latestPersonRevsSq.createdAt, cursorDate),
					and(
						eq(latestPersonRevsSq.createdAt, cursorDate),
						lt(latestPersonRevsSq.personId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(latestPersonRevsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(latestPersonRevsSq.createdAt),
				desc(latestPersonRevsSq.personId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		const personIds = pageRows.map((r) => r.personId);
		const links =
			personIds.length > 0
				? await tx
						.select()
						.from(personLedgerLinks)
						.where(inArray(personLedgerLinks.personId, personIds))
				: [];
		const linkByPersonId = new Map(links.map((l) => [l.personId, l]));

		const dtos: PersonProductDto[] = [];
		for (const row of pageRows) {
			const link = linkByPersonId.get(row.personId);
			let receivableBalance = "0.00";
			let payableBalance = "0.00";

			if (link) {
				const recBal = await getLedgerAccountBalanceInTransaction({
					tx,
					userId: validUserId,
					accountId: link.receivableAccountId,
				});
				const payBal = await getLedgerAccountBalanceInTransaction({
					tx,
					userId: validUserId,
					accountId: link.payableAccountId,
				});
				receivableBalance = recBal.balance;
				payableBalance = payBal.balance;
			}

			dtos.push({
				personId: row.personId,
				status: row.status as PersonStatus,
				displayName: row.displayName,
				relationship: row.relationship as PersonRelationship,
				note: row.note,
				revisionNo: row.revisionNo,
				receivableBalance,
				payableBalance,
			});
		}

		const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
		const nextCursor: PersonCursor | null =
			hasMore && lastRow
				? {
						createdAt: lastRow.createdAt.toISOString(),
						id: lastRow.personId,
					}
				: null;

		return {
			people: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 2. Bounded Obligations Query
// ============================================================================

export interface ListBoundedObligationsParams {
	db: Database;
	userId: string;
	personId: string;
	direction?: PersonObligationDirection | undefined;
	status?: "OPEN" | "SETTLED" | "VOID" | undefined;
	dueDateFrom?: string | undefined;
	dueDateUntil?: string | undefined;
	limit: number;
	afterCursor?: ObligationCursor | undefined;
}

export interface ListBoundedObligationsResult {
	obligations: ObligationProductDto[];
	hasMore: boolean;
	nextCursor: ObligationCursor | null;
}

function formatCentsMoneyString(amountStr: string | null | undefined): string {
	if (!amountStr) return "0.00";
	try {
		return parsePositiveMoneyString(amountStr).normalized;
	} catch {
		const num = Number(amountStr);
		if (Number.isNaN(num) || num <= 0) return "0.00";
		return num.toFixed(2);
	}
}

export async function listBoundedObligations({
	db,
	userId,
	personId,
	direction,
	status,
	dueDateFrom,
	dueDateUntil,
	limit,
	afterCursor,
}: ListBoundedObligationsParams): Promise<ListBoundedObligationsResult> {
	const validUserId = validateCanonicalUuid(userId, "userId");
	const validPersonId = validateCanonicalUuid(personId, "personId");

	return runPeopleReadTransaction(db, async (tx) => {
		// 1. Latest revision per obligation for this person
		const latestOblRevsSq = tx
			.selectDistinctOn([personObligationRevisions.obligationId], {
				obligationId: personObligationRevisions.obligationId,
				userId: personObligationRevisions.userId,
				revisionNo: personObligationRevisions.revisionNo,
				operation: personObligationRevisions.operation,
				principalAmount: personObligationRevisions.principalAmount,
				fundingAssetAccountId: personObligationRevisions.fundingAssetAccountId,
				budgetCategory: personObligationRevisions.budgetCategory,
				dueDate: personObligationRevisions.dueDate,
				description: personObligationRevisions.description,
				personId: personObligations.personId,
				direction: personObligations.direction,
				createdAt: personObligations.createdAt,
			})
			.from(personObligationRevisions)
			.innerJoin(
				personObligations,
				eq(personObligations.id, personObligationRevisions.obligationId),
			)
			.where(
				and(
					eq(personObligationRevisions.userId, validUserId),
					eq(personObligations.personId, validPersonId),
				),
			)
			.orderBy(
				personObligationRevisions.obligationId,
				desc(personObligationRevisions.revisionNo),
			)
			.as("latest_obl_revs");

		// 2. Active settlement totals per obligation
		const latestSettlementRevsSq = tx
			.selectDistinctOn([personSettlementRevisions.settlementId], {
				settlementId: personSettlementRevisions.settlementId,
				obligationId: personSettlements.obligationId,
				operation: personSettlementRevisions.operation,
				appliedAmount: personSettlementRevisions.appliedAmount,
			})
			.from(personSettlementRevisions)
			.innerJoin(
				personSettlements,
				eq(personSettlements.id, personSettlementRevisions.settlementId),
			)
			.where(eq(personSettlementRevisions.userId, validUserId))
			.orderBy(
				personSettlementRevisions.settlementId,
				desc(personSettlementRevisions.revisionNo),
			)
			.as("latest_settle_revs");

		const activeSettlementsSq = tx
			.select({
				obligationId: latestSettlementRevsSq.obligationId,
				totalSettled:
					sql<string>`COALESCE(SUM(${latestSettlementRevsSq.appliedAmount}), 0)`.as(
						"total_settled",
					),
			})
			.from(latestSettlementRevsSq)
			.where(sql`${latestSettlementRevsSq.operation} != 'VOID'`)
			.groupBy(latestSettlementRevsSq.obligationId)
			.as("active_settlements");

		// 3. Derived status & remaining amounts in SQL
		const derivedObligationsSq = tx
			.select({
				obligationId: latestOblRevsSq.obligationId,
				personId: latestOblRevsSq.personId,
				direction: latestOblRevsSq.direction,
				revisionNo: latestOblRevsSq.revisionNo,
				operation: latestOblRevsSq.operation,
				principalAmount: latestOblRevsSq.principalAmount,
				fundingAssetAccountId: latestOblRevsSq.fundingAssetAccountId,
				budgetCategory: latestOblRevsSq.budgetCategory,
				dueDate: latestOblRevsSq.dueDate,
				description: latestOblRevsSq.description,
				createdAt: latestOblRevsSq.createdAt,
				settledAmount:
					sql<string>`COALESCE(${activeSettlementsSq.totalSettled}, 0)`.as(
						"settled_amount",
					),
				remainingAmount: sql<string>`CASE
					WHEN ${latestOblRevsSq.operation} = 'VOID' THEN 0
					ELSE ${latestOblRevsSq.principalAmount} - COALESCE(${activeSettlementsSq.totalSettled}, 0)
				END`.as("remaining_amount"),
				status: sql<"OPEN" | "SETTLED" | "VOID">`CASE
					WHEN ${latestOblRevsSq.operation} = 'VOID' THEN 'VOID'
					WHEN (${latestOblRevsSq.principalAmount} - COALESCE(${activeSettlementsSq.totalSettled}, 0)) <= 0 THEN 'SETTLED'
					ELSE 'OPEN'
				END`.as("status"),
			})
			.from(latestOblRevsSq)
			.leftJoin(
				activeSettlementsSq,
				eq(activeSettlementsSq.obligationId, latestOblRevsSq.obligationId),
			)
			.as("derived_obligations");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [];
		if (direction !== undefined) {
			conditions.push(eq(derivedObligationsSq.direction, direction));
		}
		if (status !== undefined) {
			conditions.push(eq(derivedObligationsSq.status, status));
		}
		if (dueDateFrom !== undefined) {
			conditions.push(gte(derivedObligationsSq.dueDate, dueDateFrom));
		}
		if (dueDateUntil !== undefined) {
			conditions.push(lte(derivedObligationsSq.dueDate, dueDateUntil));
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(derivedObligationsSq.createdAt, cursorDate),
					and(
						eq(derivedObligationsSq.createdAt, cursorDate),
						lt(derivedObligationsSq.obligationId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(derivedObligationsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(derivedObligationsSq.createdAt),
				desc(derivedObligationsSq.obligationId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		// 4. Resolve isSplitManaged in batch
		const pageObligationIds = pageRows.map((r) => r.obligationId);
		const splitParticipantRows =
			pageObligationIds.length > 0
				? await tx
						.select({
							obligationId:
								creditCardPurchaseSplitParticipants.personObligationId,
						})
						.from(creditCardPurchaseSplitParticipants)
						.where(
							and(
								eq(creditCardPurchaseSplitParticipants.userId, validUserId),
								inArray(
									creditCardPurchaseSplitParticipants.personObligationId,
									pageObligationIds,
								),
							),
						)
				: [];
		const splitObligationIds = new Set(
			splitParticipantRows.map((r) => r.obligationId),
		);

		const dtos: ObligationProductDto[] = pageRows.map((row) => {
			const settledFormatted = formatCentsMoneyString(row.settledAmount);
			const remainingFormatted =
				row.status === "VOID"
					? "0.00"
					: formatCentsMoneyString(row.remainingAmount);

			const dto: ObligationProductDto = {
				obligationId: row.obligationId,
				personId: row.personId,
				direction: row.direction as PersonObligationDirection,
				status: row.status,
				principalAmount: formatCentsMoneyString(row.principalAmount),
				settledAmount: settledFormatted,
				remainingAmount: remainingFormatted,
				dueDate: row.dueDate,
				description: row.description,
				budgetCategory: row.budgetCategory ?? null,
				revisionNo: row.revisionNo,
				isSplitManaged: splitObligationIds.has(row.obligationId),
			};

			if (row.direction === "RECEIVABLE" && row.fundingAssetAccountId) {
				dto.fundingAssetAccountId = row.fundingAssetAccountId;
			}

			return dto;
		});

		const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
		const nextCursor: ObligationCursor | null =
			hasMore && lastRow
				? {
						createdAt: lastRow.createdAt.toISOString(),
						id: lastRow.obligationId,
					}
				: null;

		return {
			obligations: dtos,
			hasMore,
			nextCursor,
		};
	});
}

// ============================================================================
// 3. Bounded Settlements Query
// ============================================================================

export interface ListBoundedSettlementsParams {
	db: Database;
	userId: string;
	personId: string;
	obligationId: string;
	status?: "ACTIVE" | "VOIDED" | undefined;
	limit: number;
	afterCursor?: SettlementCursor | undefined;
}

export interface ListBoundedSettlementsResult {
	settlements: SettlementProductDto[];
	hasMore: boolean;
	nextCursor: SettlementCursor | null;
}

export async function listBoundedSettlements({
	db,
	userId,
	personId,
	obligationId,
	status,
	limit,
	afterCursor,
}: ListBoundedSettlementsParams): Promise<ListBoundedSettlementsResult> {
	const validUserId = validateCanonicalUuid(userId, "userId");
	const validPersonId = validateCanonicalUuid(personId, "personId");
	const validObligationId = validateCanonicalUuid(obligationId, "obligationId");

	return runPeopleReadTransaction(db, async (tx) => {
		// Confirm obligation ownership & person
		const [obligation] = await tx
			.select()
			.from(personObligations)
			.where(
				and(
					eq(personObligations.id, validObligationId),
					eq(personObligations.userId, validUserId),
					eq(personObligations.personId, validPersonId),
				),
			)
			.limit(1);

		if (!obligation) {
			throw new (await import("./errors")).PeopleError(
				"PEOPLE_OBLIGATION_NOT_FOUND",
				`Obligation ${validObligationId} not found for person ${validPersonId}`,
			);
		}

		// Latest revision per settlement
		const latestSettlementRevsSq = tx
			.selectDistinctOn([personSettlementRevisions.settlementId], {
				settlementId: personSettlementRevisions.settlementId,
				userId: personSettlementRevisions.userId,
				obligationId: personSettlements.obligationId,
				revisionNo: personSettlementRevisions.revisionNo,
				operation: personSettlementRevisions.operation,
				assetAccountId: personSettlementRevisions.assetAccountId,
				cashAmount: personSettlementRevisions.cashAmount,
				appliedAmount: personSettlementRevisions.appliedAmount,
				excessAmount: personSettlementRevisions.excessAmount,
				overpaymentIncomeReceiptId:
					personSettlementRevisions.overpaymentIncomeReceiptId,
				note: personSettlementRevisions.note,
				occurredAt: personSettlementRevisions.occurredAt,
				createdAt: personSettlements.createdAt,
			})
			.from(personSettlementRevisions)
			.innerJoin(
				personSettlements,
				eq(personSettlements.id, personSettlementRevisions.settlementId),
			)
			.where(
				and(
					eq(personSettlementRevisions.userId, validUserId),
					eq(personSettlements.obligationId, validObligationId),
				),
			)
			.orderBy(
				personSettlementRevisions.settlementId,
				desc(personSettlementRevisions.revisionNo),
			)
			.as("latest_settlement_revs");

		const derivedSettlementsSq = tx
			.select({
				settlementId: latestSettlementRevsSq.settlementId,
				obligationId: latestSettlementRevsSq.obligationId,
				revisionNo: latestSettlementRevsSq.revisionNo,
				operation: latestSettlementRevsSq.operation,
				assetAccountId: latestSettlementRevsSq.assetAccountId,
				cashAmount: latestSettlementRevsSq.cashAmount,
				appliedAmount: latestSettlementRevsSq.appliedAmount,
				excessAmount: latestSettlementRevsSq.excessAmount,
				overpaymentIncomeReceiptId:
					latestSettlementRevsSq.overpaymentIncomeReceiptId,
				note: latestSettlementRevsSq.note,
				occurredAt: latestSettlementRevsSq.occurredAt,
				createdAt: latestSettlementRevsSq.createdAt,
				status: sql<"ACTIVE" | "VOIDED">`CASE
					WHEN ${latestSettlementRevsSq.operation} = 'VOID' THEN 'VOIDED'
					ELSE 'ACTIVE'
				END`.as("status"),
			})
			.from(latestSettlementRevsSq)
			.as("derived_settlements");

		const conditions: (import("drizzle-orm").SQL<unknown> | undefined)[] = [];
		if (status !== undefined) {
			conditions.push(eq(derivedSettlementsSq.status, status));
		}
		if (afterCursor) {
			const cursorDate = new Date(afterCursor.createdAt);
			conditions.push(
				or(
					lt(derivedSettlementsSq.createdAt, cursorDate),
					and(
						eq(derivedSettlementsSq.createdAt, cursorDate),
						lt(derivedSettlementsSq.settlementId, afterCursor.id),
					),
				),
			);
		}

		const nonNullConditions = conditions.filter(
			(c): c is import("drizzle-orm").SQL<unknown> => c !== undefined,
		);

		const rows = await tx
			.select()
			.from(derivedSettlementsSq)
			.where(
				nonNullConditions.length > 0 ? and(...nonNullConditions) : undefined,
			)
			.orderBy(
				desc(derivedSettlementsSq.createdAt),
				desc(derivedSettlementsSq.settlementId),
			)
			.limit(limit + 1);

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;

		const dtos: SettlementProductDto[] = pageRows.map((row) => ({
			settlementId: row.settlementId,
			obligationId: row.obligationId,
			personId: obligation.personId,
			direction: obligation.direction as PersonObligationDirection,
			status: row.status,
			cashAmount: formatCentsMoneyString(row.cashAmount),
			appliedAmount: formatCentsMoneyString(row.appliedAmount),
			excessAmount: formatCentsMoneyString(row.excessAmount),
			note: row.note,
			occurredAt: row.occurredAt.toISOString(),
			revisionNo: row.revisionNo,
			assetAccountId: row.assetAccountId,
			overpaymentIncomeReceiptId: row.overpaymentIncomeReceiptId ?? null,
		}));

		const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
		const nextCursor: SettlementCursor | null =
			hasMore && lastRow
				? {
						createdAt: lastRow.createdAt.toISOString(),
						id: lastRow.settlementId,
					}
				: null;

		return {
			settlements: dtos,
			hasMore,
			nextCursor,
		};
	});
}
