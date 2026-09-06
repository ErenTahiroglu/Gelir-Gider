import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	creditCardStatementRevisions,
	creditCardStatements,
} from "../db/schema/credit-cards";
import { notificationEvents } from "../db/schema/notifications";
import { runNotificationReadTransaction } from "./boundary";
import {
	istanbulNoonToUtcInstant,
	validateNotificationCanonicalUuid,
	validateNotificationLocalDate,
	validateNotificationOptionalType,
} from "./calendar";
import { NotificationError } from "./errors";

export const CREDIT_CARD_DUE_DEEP_LINK_PREFIX = "/credit-cards/statements/";

export interface CreditCardDuePayload {
	title: string;
	body: string;
	data: {
		type: "CREDIT_CARD_DUE";
		statementId: string;
		creditCardId: string;
		dueDate: string;
		deepLink: string;
	};
}

/**
 * Builds the minimal, privacy-safe CREDIT_CARD_DUE push payload (Section 5).
 * Never includes statement amount, card balance, credit limit, or any other
 * financial figure.
 */
export function buildCreditCardDuePayload(params: {
	statementId: string;
	creditCardId: string;
	dueDate: string;
}): CreditCardDuePayload {
	return {
		title: "Kredi kartı son ödeme hatırlatması",
		body: "Bir kredi kartı ekstresinin son ödeme günü bugün. Ödeme durumunu kontrol et.",
		data: {
			type: "CREDIT_CARD_DUE",
			statementId: params.statementId,
			creditCardId: params.creditCardId,
			dueDate: params.dueDate,
			deepLink: `${CREDIT_CARD_DUE_DEEP_LINK_PREFIX}${params.statementId}`,
		},
	};
}

export interface EligibleDueStatementRow {
	statementId: string;
	userId: string;
	creditCardId: string;
	dueDate: string;
}

/**
 * Resolves every OPEN statement across ALL users whose LATEST revision's
 * due_date equals `localDate`, in one bounded query (a max-revision-no
 * subquery joined back to the revisions table -- avoids N+1 over
 * `credit_card_statements`, Section 26). Never infers eligibility from an
 * earlier, superseded revision.
 */
export async function findEligibleDueStatementsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
): Promise<EligibleDueStatementRow[]> {
	const latestRevisionNumbers = tx
		.select({
			statementId: creditCardStatementRevisions.statementId,
			maxRevisionNo:
				sql<number>`max(${creditCardStatementRevisions.revisionNo})`.as(
					"max_revision_no",
				),
		})
		.from(creditCardStatementRevisions)
		.groupBy(creditCardStatementRevisions.statementId)
		.as("latest_rev");

	const rows = await tx
		.select({
			statementId: creditCardStatementRevisions.statementId,
			userId: creditCardStatementRevisions.userId,
			dueDate: creditCardStatementRevisions.dueDate,
			creditCardId: creditCardStatements.creditCardId,
		})
		.from(creditCardStatementRevisions)
		.innerJoin(
			latestRevisionNumbers,
			and(
				eq(
					creditCardStatementRevisions.statementId,
					latestRevisionNumbers.statementId,
				),
				eq(
					creditCardStatementRevisions.revisionNo,
					latestRevisionNumbers.maxRevisionNo,
				),
			),
		)
		.innerJoin(
			creditCardStatements,
			eq(creditCardStatements.id, creditCardStatementRevisions.statementId),
		)
		.where(
			and(
				eq(creditCardStatementRevisions.status, "OPEN"),
				eq(creditCardStatementRevisions.dueDate, localDate),
			),
		)
		.orderBy(
			asc(creditCardStatementRevisions.dueDate),
			asc(creditCardStatementRevisions.statementId),
		);

	return rows.map((row) => ({
		statementId: row.statementId,
		userId: row.userId,
		creditCardId: row.creditCardId,
		dueDate: row.dueDate,
	}));
}

/**
 * Returns the LATEST `credit_card_statement_revisions` row for one
 * statement -- the sole authority for current status (Section 1, 17, 27).
 */
export async function getLatestStatementRevisionInTransaction(
	tx: DatabaseTransaction,
	statementId: string,
): Promise<typeof creditCardStatementRevisions.$inferSelect | undefined> {
	const [row] = await tx
		.select()
		.from(creditCardStatementRevisions)
		.where(eq(creditCardStatementRevisions.statementId, statementId))
		.orderBy(desc(creditCardStatementRevisions.revisionNo))
		.limit(1);
	return row;
}

export interface MaterializeDueEventsResult {
	eventsCreated: number;
}

/**
 * Idempotently ensures a CREDIT_CARD_DUE `notification_events` row exists for
 * every eligible OPEN statement due on `localDate`, across all users
 * (Section 26/28). `UNIQUE(user_id, notification_type, subject_id)` +
 * `ON CONFLICT DO NOTHING` guarantees no duplicate logical event even under
 * a race.
 */
export async function materializeCreditCardDueEventsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
): Promise<MaterializeDueEventsResult> {
	const eligible = await findEligibleDueStatementsInTransaction(tx, localDate);
	const scheduledFor = istanbulNoonToUtcInstant(localDate);
	let eventsCreated = 0;

	for (const statement of eligible) {
		const payload = buildCreditCardDuePayload({
			statementId: statement.statementId,
			creditCardId: statement.creditCardId,
			dueDate: statement.dueDate,
		});
		const inserted = await tx
			.insert(notificationEvents)
			.values({
				userId: statement.userId,
				notificationType: "CREDIT_CARD_DUE",
				subjectId: statement.statementId,
				scheduledLocalDate: localDate,
				scheduledFor,
				payload,
			})
			.onConflictDoNothing()
			.returning({ id: notificationEvents.id });
		if (inserted.length > 0) eventsCreated++;
	}

	return { eventsCreated };
}

/**
 * Lists today's (i.e. `scheduledLocalDate = localDate`) notification events,
 * across all users -- used by the scheduler to drive delivery fan-out.
 */
export async function listEventsForLocalDateInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
): Promise<(typeof notificationEvents.$inferSelect)[]> {
	return tx
		.select()
		.from(notificationEvents)
		.where(eq(notificationEvents.scheduledLocalDate, localDate))
		.orderBy(
			asc(notificationEvents.scheduledLocalDate),
			asc(notificationEvents.id),
		);
}

// ============================================================================
// Read APIs (Section 32)
// ============================================================================

export interface NotificationEventReadModel {
	id: string;
	userId: string;
	notificationType: "CREDIT_CARD_DUE";
	subjectId: string;
	scheduledLocalDate: string;
	scheduledFor: Date;
	payload: unknown;
	createdAt: Date;
}

function toEventReadModel(
	row: typeof notificationEvents.$inferSelect,
): NotificationEventReadModel {
	return {
		id: row.id,
		userId: row.userId,
		notificationType: row.notificationType as "CREDIT_CARD_DUE",
		subjectId: row.subjectId,
		scheduledLocalDate: row.scheduledLocalDate,
		scheduledFor: row.scheduledFor,
		payload: row.payload,
		createdAt: row.createdAt,
	};
}

export interface GetNotificationEventParams {
	db: Database;
	userId: unknown;
	eventId: unknown;
}

export async function getNotificationEvent(
	params: GetNotificationEventParams,
): Promise<NotificationEventReadModel> {
	const userId = validateNotificationCanonicalUuid(params.userId, "userId");
	const eventId = validateNotificationCanonicalUuid(params.eventId, "eventId");
	return runNotificationReadTransaction(params.db, async (tx) => {
		const [row] = await tx
			.select()
			.from(notificationEvents)
			.where(eq(notificationEvents.id, eventId))
			.limit(1);
		if (!row || row.userId !== userId) {
			throw new NotificationError(
				"NOTIFICATION_EVENT_NOT_FOUND",
				"Notification event not found",
			);
		}
		return toEventReadModel(row);
	});
}

export interface ListNotificationEventsParams {
	db: Database;
	userId: unknown;
	type?: unknown;
	dateFrom?: unknown;
	dateUntil?: unknown;
}

export async function listNotificationEvents(
	params: ListNotificationEventsParams,
): Promise<NotificationEventReadModel[]> {
	const userId = validateNotificationCanonicalUuid(params.userId, "userId");
	const type = validateNotificationOptionalType(params.type);
	const dateFrom =
		params.dateFrom === undefined
			? undefined
			: validateNotificationLocalDate(params.dateFrom, "dateFrom");
	const dateUntil =
		params.dateUntil === undefined
			? undefined
			: validateNotificationLocalDate(params.dateUntil, "dateUntil");

	return runNotificationReadTransaction(params.db, async (tx) => {
		const conditions = [eq(notificationEvents.userId, userId)];
		if (type) conditions.push(eq(notificationEvents.notificationType, type));
		if (dateFrom)
			conditions.push(gte(notificationEvents.scheduledLocalDate, dateFrom));
		if (dateUntil)
			conditions.push(lte(notificationEvents.scheduledLocalDate, dateUntil));

		const rows = await tx
			.select()
			.from(notificationEvents)
			.where(and(...conditions))
			.orderBy(
				desc(notificationEvents.scheduledFor),
				asc(notificationEvents.id),
			);
		return rows.map(toEventReadModel);
	});
}
