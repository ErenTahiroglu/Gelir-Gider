import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client";
import {
	monthlyBudgetPlanRevisions,
	monthlyBudgetPlans,
} from "../db/schema/budget";
import {
	creditCardStatementRevisions,
	creditCardStatements,
} from "../db/schema/credit-cards";
import {
	type NotificationType,
	notificationEvents,
	pushSubscriptionRevisions,
	pushSubscriptions,
} from "../db/schema/notifications";
import { parseAggregateMoneyString } from "../ledger/money";
import { getMonthCloseIstanbulPeriodBoundaries } from "../month-close/calendar";
import { calculatePersonalSpendInTransaction } from "../spending/personal-spend-calculator";
import { runNotificationReadTransaction } from "./boundary";
import {
	getNextDayIstanbul,
	istanbulLocalHourToUtcInstant,
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

export interface CreditCardDueSoonPayload {
	title: string;
	body: string;
	data: {
		type: "CREDIT_CARD_DUE_SOON";
		statementId: string;
		creditCardId: string;
		dueDate: string;
		deepLink: string;
	};
}

export function buildCreditCardDueSoonPayload(params: {
	statementId: string;
	creditCardId: string;
	dueDate: string;
}): CreditCardDueSoonPayload {
	return {
		title: "Kredi kartı son ödeme hatırlatması",
		body: "Yarın kredi kartı ödemen var.",
		data: {
			type: "CREDIT_CARD_DUE_SOON",
			statementId: params.statementId,
			creditCardId: params.creditCardId,
			dueDate: params.dueDate,
			deepLink: `${CREDIT_CARD_DUE_DEEP_LINK_PREFIX}${params.statementId}`,
		},
	};
}

export interface BudgetThresholdPayload {
	title: string;
	body: string;
	data: {
		type: "BUDGET_THRESHOLD";
		periodMonth: string;
		deepLink: string;
	};
}

export function buildBudgetThresholdPayload(params: {
	periodMonth: string;
}): BudgetThresholdPayload {
	return {
		title: "Bütçe uyarısı",
		body: "Aylık bütçeni aştın.",
		data: {
			type: "BUDGET_THRESHOLD",
			periodMonth: params.periodMonth,
			deepLink: "/budget",
		},
	};
}

export interface NoSpendCheckPayload {
	title: string;
	body: string;
	data: {
		type: "NO_SPEND_CHECK";
		localDate: string;
		deepLink: string;
	};
}

export function buildNoSpendCheckPayload(params: {
	localDate: string;
}): NoSpendCheckPayload {
	return {
		title: "Harcama kontrolü",
		body: "Bugün hiç harcama yaptın mı?",
		data: {
			type: "NO_SPEND_CHECK",
			localDate: params.localDate,
			deepLink: "/",
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
 * due_date equals `localDate`, in one bounded query.
 */
export async function findEligibleDueStatementsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
	limit = 500,
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
				sql`NOT EXISTS (
					SELECT 1 FROM ${notificationEvents}
					WHERE ${notificationEvents.userId} = ${creditCardStatementRevisions.userId}
						AND ${notificationEvents.dedupeKey} = 'CC_DUE:' || ${creditCardStatementRevisions.statementId}
				)`,
			),
		)
		.orderBy(
			asc(creditCardStatementRevisions.dueDate),
			asc(creditCardStatementRevisions.statementId),
		)
		.limit(limit);

	return rows.map((row) => ({
		statementId: row.statementId,
		userId: row.userId,
		creditCardId: row.creditCardId,
		dueDate: row.dueDate,
	}));
}

/**
 * Resolves every OPEN statement across ALL users whose LATEST revision's
 * due_date equals tomorrow (i.e. due in 1 day).
 */
export async function findEligibleDueSoonStatementsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
	limit = 500,
): Promise<EligibleDueStatementRow[]> {
	const tomorrow = getNextDayIstanbul(localDate);
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
				eq(creditCardStatementRevisions.dueDate, tomorrow),
				sql`NOT EXISTS (
					SELECT 1 FROM ${notificationEvents}
					WHERE ${notificationEvents.userId} = ${creditCardStatementRevisions.userId}
						AND ${notificationEvents.dedupeKey} = 'CC_DUE_SOON:' || ${creditCardStatementRevisions.statementId}
				)`,
			),
		)
		.orderBy(
			asc(creditCardStatementRevisions.dueDate),
			asc(creditCardStatementRevisions.statementId),
		)
		.limit(limit);

	return rows.map((row) => ({
		statementId: row.statementId,
		userId: row.userId,
		creditCardId: row.creditCardId,
		dueDate: row.dueDate,
	}));
}

/**
 * Returns the LATEST `credit_card_statement_revisions` row for one statement.
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
 * every eligible OPEN statement due on `localDate`.
 */
export async function materializeCreditCardDueEventsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
	limit = 500,
): Promise<MaterializeDueEventsResult> {
	const eligible = await findEligibleDueStatementsInTransaction(
		tx,
		localDate,
		limit,
	);
	const scheduledFor = istanbulLocalHourToUtcInstant(localDate, 10);
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
				dedupeKey: `CC_DUE:${statement.statementId}`,
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
 * Idempotently ensures a CREDIT_CARD_DUE_SOON `notification_events` row exists for
 * every eligible OPEN statement due tomorrow.
 */
export async function materializeCreditCardDueSoonEventsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
	limit = 500,
): Promise<MaterializeDueEventsResult> {
	const eligible = await findEligibleDueSoonStatementsInTransaction(
		tx,
		localDate,
		limit,
	);
	const scheduledFor = istanbulLocalHourToUtcInstant(localDate, 22);
	let eventsCreated = 0;

	for (const statement of eligible) {
		const payload = buildCreditCardDueSoonPayload({
			statementId: statement.statementId,
			creditCardId: statement.creditCardId,
			dueDate: statement.dueDate,
		});
		const inserted = await tx
			.insert(notificationEvents)
			.values({
				userId: statement.userId,
				notificationType: "CREDIT_CARD_DUE_SOON",
				subjectId: statement.statementId,
				dedupeKey: `CC_DUE_SOON:${statement.statementId}`,
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
 * Materializes a single collapsed BUDGET_THRESHOLD event if threshold is crossed.
 * Never inserts fake historical catch-up rows; queries existing thresholds for
 * (userId, periodMonth) and emits only when currentHighestCrossed > previousHighest.
 */
export async function materializeBudgetThresholdEventInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		periodMonth: string;
		currentSpendCents: bigint;
		budgetCents: bigint;
		localDate: string;
	},
): Promise<MaterializeDueEventsResult> {
	if (
		params.currentSpendCents <= params.budgetCents ||
		params.budgetCents <= 0n
	) {
		return { eventsCreated: 0 };
	}

	const step = 500000n; // 5000 TRY = 500,000 cents
	const delta = params.currentSpendCents - params.budgetCents;
	const stepsCrossed = delta / step;
	const highestThresholdCents = params.budgetCents + stepsCrossed * step;

	// Query highest previously emitted threshold for this (userId, periodMonth)
	const existingEvents = await tx
		.select({ dedupeKey: notificationEvents.dedupeKey })
		.from(notificationEvents)
		.where(
			and(
				eq(notificationEvents.userId, params.userId),
				eq(notificationEvents.notificationType, "BUDGET_THRESHOLD"),
				sql`${notificationEvents.dedupeKey} LIKE ${`BUDGET:${params.periodMonth}:%`}`,
			),
		);

	let previousHighestThreshold = 0n;
	for (const ev of existingEvents) {
		const parts = ev.dedupeKey.split(":");
		if (parts.length >= 3 && parts[2] !== undefined) {
			try {
				const val = BigInt(parts[2]);
				if (val > previousHighestThreshold) {
					previousHighestThreshold = val;
				}
			} catch {
				// ignore malformed keys
			}
		}
	}

	if (highestThresholdCents <= previousHighestThreshold) {
		return { eventsCreated: 0 };
	}

	const highestDedupeKey = `BUDGET:${params.periodMonth}:${highestThresholdCents.toString()}`;
	const scheduledFor = istanbulLocalHourToUtcInstant(params.localDate, 10);
	const payload = buildBudgetThresholdPayload({
		periodMonth: params.periodMonth,
	});

	const [inserted] = await tx
		.insert(notificationEvents)
		.values({
			userId: params.userId,
			notificationType: "BUDGET_THRESHOLD",
			subjectId: params.userId,
			dedupeKey: highestDedupeKey,
			scheduledLocalDate: params.localDate,
			scheduledFor,
			payload,
		})
		.onConflictDoNothing()
		.returning({ id: notificationEvents.id });

	return { eventsCreated: inserted ? 1 : 0 };
}

/**
 * Scans all users who have an active budget plan for the given month,
 * evaluates personal spending, and emits budget threshold events if crossed.
 */
export async function materializeAllActiveBudgetThresholdEventsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
	scheduledAt: Date,
): Promise<MaterializeDueEventsResult> {
	const periodMonth = localDate.slice(0, 7);
	const { start } = getMonthCloseIstanbulPeriodBoundaries(periodMonth);

	const latestPlanRevisions = tx
		.select({
			budgetPlanId: monthlyBudgetPlanRevisions.budgetPlanId,
			maxRev: sql<number>`max(${monthlyBudgetPlanRevisions.revisionNo})`.as(
				"max_rev",
			),
		})
		.from(monthlyBudgetPlanRevisions)
		.groupBy(monthlyBudgetPlanRevisions.budgetPlanId)
		.as("latest_plan_rev");

	const activeBudgetPlans = await tx
		.select({
			userId: monthlyBudgetPlans.userId,
			mandatoryCeiling: monthlyBudgetPlanRevisions.mandatoryCeilingAmount,
			discretionaryCeiling:
				monthlyBudgetPlanRevisions.discretionaryCeilingAmount,
		})
		.from(monthlyBudgetPlans)
		.innerJoin(
			monthlyBudgetPlanRevisions,
			eq(monthlyBudgetPlans.id, monthlyBudgetPlanRevisions.budgetPlanId),
		)
		.innerJoin(
			latestPlanRevisions,
			and(
				eq(
					monthlyBudgetPlanRevisions.budgetPlanId,
					latestPlanRevisions.budgetPlanId,
				),
				eq(monthlyBudgetPlanRevisions.revisionNo, latestPlanRevisions.maxRev),
			),
		)
		.where(
			and(
				eq(monthlyBudgetPlans.periodMonth, periodMonth),
				sql`${monthlyBudgetPlanRevisions.operation} != 'VOID'`,
			),
		);

	let eventsCreated = 0;
	for (const plan of activeBudgetPlans) {
		const spend = await calculatePersonalSpendInTransaction({
			db: tx,
			userId: plan.userId,
			start,
			end: scheduledAt,
		});

		const mandatoryCents = parseAggregateMoneyString(
			plan.mandatoryCeiling,
		).cents;
		const discretionaryCents = parseAggregateMoneyString(
			plan.discretionaryCeiling,
		).cents;
		const budgetCents = mandatoryCents + discretionaryCents;

		const res = await materializeBudgetThresholdEventInTransaction(tx, {
			userId: plan.userId,
			periodMonth,
			currentSpendCents: spend.totalPersonalSpendCents,
			budgetCents,
			localDate,
		});
		eventsCreated += res.eventsCreated;
	}

	return { eventsCreated };
}

/**
 * Materializes a NO_SPEND_CHECK notification event if no personal spending occurred today.
 */
export async function materializeNoSpendCheckEventInTransaction(
	tx: DatabaseTransaction,
	params: {
		userId: string;
		localDate: string;
		hasSpending: boolean;
	},
): Promise<MaterializeDueEventsResult> {
	if (params.hasSpending) {
		return { eventsCreated: 0 };
	}

	const dedupeKey = `NO_SPEND:${params.localDate}`;
	const scheduledFor = istanbulLocalHourToUtcInstant(params.localDate, 22);
	const payload = buildNoSpendCheckPayload({ localDate: params.localDate });

	const [inserted] = await tx
		.insert(notificationEvents)
		.values({
			userId: params.userId,
			notificationType: "NO_SPEND_CHECK",
			subjectId: params.userId,
			dedupeKey,
			scheduledLocalDate: params.localDate,
			scheduledFor,
			payload,
		})
		.onConflictDoNothing()
		.returning({ id: notificationEvents.id });

	return { eventsCreated: inserted ? 1 : 0 };
}

/**
 * For all users with active push subscriptions who have not yet received a NO_SPEND_CHECK
 * event today, checks if they had personal spending today. If no spending occurred,
 * materializes a NO_SPEND_CHECK notification event scheduled for 22:00.
 */
export async function materializeAllNoSpendCheckEventsInTransaction(
	tx: DatabaseTransaction,
	localDate: string,
): Promise<MaterializeDueEventsResult> {
	const start = istanbulLocalHourToUtcInstant(localDate, 0);
	const end = istanbulLocalHourToUtcInstant(getNextDayIstanbul(localDate), 0);

	const usersWithSubscriptions = await tx
		.selectDistinct({ userId: pushSubscriptions.userId })
		.from(pushSubscriptions)
		.innerJoin(
			pushSubscriptionRevisions,
			eq(pushSubscriptions.id, pushSubscriptionRevisions.subscriptionId),
		)
		.where(
			and(
				eq(pushSubscriptionRevisions.status, "ACTIVE"),
				sql`NOT EXISTS (
					SELECT 1 FROM ${notificationEvents}
					WHERE ${notificationEvents.userId} = ${pushSubscriptions.userId}
						AND ${notificationEvents.dedupeKey} = 'NO_SPEND:' || ${localDate}
				)`,
			),
		);

	let eventsCreated = 0;
	for (const u of usersWithSubscriptions) {
		const spend = await calculatePersonalSpendInTransaction({
			db: tx,
			userId: u.userId,
			start,
			end,
		});

		const res = await materializeNoSpendCheckEventInTransaction(tx, {
			userId: u.userId,
			localDate,
			hasSpending: spend.hasSpending,
		});
		eventsCreated += res.eventsCreated;
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
	limit = 500,
	afterEventId?: string | undefined,
	onlyPendingDeliveries = false,
	scheduledAt?: Date,
): Promise<(typeof notificationEvents.$inferSelect)[]> {
	const conditions = [eq(notificationEvents.scheduledLocalDate, localDate)];
	if (afterEventId) {
		conditions.push(gt(notificationEvents.id, afterEventId));
	}
	if (scheduledAt) {
		conditions.push(lte(notificationEvents.scheduledFor, scheduledAt));
	}
	if (onlyPendingDeliveries) {
		conditions.push(sql`EXISTS (
			SELECT 1 FROM push_subscriptions ps
			JOIN (
				SELECT DISTINCT ON (subscription_id) subscription_id, status
				FROM push_subscription_revisions
				ORDER BY subscription_id, revision_no DESC
			) psr ON psr.subscription_id = ps.id
			WHERE ps.user_id = ${notificationEvents.userId}
			  AND psr.status = 'ACTIVE'
			  AND NOT EXISTS (
				SELECT 1 FROM notification_deliveries nd
				JOIN notification_delivery_attempts nda ON nda.delivery_id = nd.id
				WHERE nd.notification_event_id = ${notificationEvents.id}
				  AND nd.push_subscription_id = ps.id
				  AND nda.status IN ('SUCCESS', 'TERMINAL_FAILURE', 'SUPPRESSED_OBSOLETE')
			  )
		)`);
	}
	return tx
		.select()
		.from(notificationEvents)
		.where(and(...conditions))
		.orderBy(
			asc(notificationEvents.scheduledLocalDate),
			asc(notificationEvents.id),
		)
		.limit(limit);
}

// ============================================================================
// Read APIs (Section 32)
// ============================================================================

export interface NotificationEventReadModel {
	id: string;
	userId: string;
	notificationType: NotificationType;
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
		notificationType: row.notificationType as NotificationType,
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
