import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
	notificationDeliveries,
	notificationDeliveryAttempts,
} from "../db/schema/notifications";
import {
	runNotificationReadTransaction,
	runNotificationTransaction,
} from "./boundary";
import {
	getIstanbulLocalDateAndHour,
	isAtOrAfterNotificationDeliveryHour,
} from "./calendar";
import {
	type DeliveryAttemptHistory,
	ensureDeliveryInTransaction,
	insertDeliveryAttemptInTransaction,
	lockDeliveryAttemptHistoryInTransaction,
	planDeliveryAttempt,
} from "./delivery";
import type { NotificationEventReadModel } from "./events";
import {
	getLatestStatementRevisionInTransaction,
	listEventsForLocalDateInTransaction,
	materializeCreditCardDueEventsInTransaction,
} from "./events";
import { deriveNotificationChildIdempotencyKey } from "./fingerprint";
import {
	disablePushSubscriptionForEndpointGoneInTransaction,
	listActivePushSubscriptionsInTransaction,
	type PushSubscriptionReadModel,
} from "./subscriptions";
import type { PushTransport } from "./web-push";

const NOTIFICATION_PUSH_TTL_SECONDS = 12 * 60 * 60;

export interface RunNotificationSchedulerParams {
	db: Database;
	scheduledAt: Date;
	transport: PushTransport;
}

export interface NotificationSchedulerSummary {
	eventsCreated: number;
	deliveriesCreated: number;
	successes: number;
	retryableFailures: number;
	terminalFailures: number;
	suppressed: number;
}

async function readUnlockedHistory(
	db: Database,
	eventId: string,
	subscriptionId: string,
): Promise<{ deliveryExists: boolean; history: DeliveryAttemptHistory }> {
	return runNotificationReadTransaction(db, async (tx) => {
		const [delivery] = await tx
			.select({ id: notificationDeliveries.id })
			.from(notificationDeliveries)
			.where(
				and(
					eq(notificationDeliveries.notificationEventId, eventId),
					eq(notificationDeliveries.pushSubscriptionId, subscriptionId),
				),
			)
			.limit(1);
		if (!delivery) {
			return {
				deliveryExists: false,
				history: {
					attemptCount: 0,
					lastAttemptStatus: null,
					hasSuccess: false,
				},
			};
		}
		const attempts = await tx
			.select()
			.from(notificationDeliveryAttempts)
			.where(eq(notificationDeliveryAttempts.deliveryId, delivery.id));
		return {
			deliveryExists: true,
			history: {
				attemptCount: attempts.length,
				lastAttemptStatus:
					attempts.length > 0
						? (attempts[attempts.length - 1]
								?.status as DeliveryAttemptHistory["lastAttemptStatus"])
						: null,
				hasSuccess: attempts.some((a) => a.status === "SUCCESS"),
			},
		};
	});
}

/**
 * Processes exactly one (event, active subscription) pair for this
 * scheduler run. The push-service network call (if any) always happens
 * OUTSIDE any open database transaction; the delivery anchor and its
 * resulting attempt are always created together, atomically, in the single
 * transaction that follows -- a naked delivery-with-zero-attempts is never
 * left behind (Section 13/35-37).
 */
async function processEventSubscription(
	db: Database,
	transport: PushTransport,
	event: NotificationEventReadModel,
	subscription: PushSubscriptionReadModel,
	scheduledAt: Date,
	summary: NotificationSchedulerSummary,
): Promise<void> {
	const precheck = await readUnlockedHistory(
		db,
		event.id,
		subscription.subscriptionId,
	);

	const precheckStatement = await runNotificationReadTransaction(db, (tx) =>
		getLatestStatementRevisionInTransaction(tx, event.subjectId),
	);
	const precheckStatus =
		(precheckStatement?.status as "OPEN" | "PAID" | "VOID" | undefined) ??
		"VOID";
	const precheckPlan = planDeliveryAttempt({
		history: precheck.history,
		currentStatementStatus: precheckStatus,
		isSameDueDay: true,
	});

	if (
		precheckPlan === "SKIP_DONE" ||
		precheckPlan === "SKIP_MAX_ATTEMPTS" ||
		precheckPlan === "SKIP_NOT_SAME_DAY"
	) {
		return;
	}

	// Only call the transport when a send is genuinely still warranted right
	// now -- never for an already-obsolete/exhausted/completed delivery
	// (Section 17, Section 41).
	const sendResult =
		precheckPlan === "SEND"
			? await transport.send(
					{
						endpoint: subscription.endpoint,
						p256dh: subscription.p256dh,
						auth: subscription.auth,
					},
					event.payload as object,
					{ ttlSeconds: NOTIFICATION_PUSH_TTL_SECONDS },
				)
			: null;

	await runNotificationTransaction(db, async (tx) => {
		const { deliveryId, created } = await ensureDeliveryInTransaction(tx, {
			userId: event.userId,
			eventId: event.id,
			subscriptionId: subscription.subscriptionId,
		});
		if (created) summary.deliveriesCreated++;

		const freshHistory = await lockDeliveryAttemptHistoryInTransaction(
			tx,
			deliveryId,
		);
		const freshStatement = await getLatestStatementRevisionInTransaction(
			tx,
			event.subjectId,
		);
		const freshStatus =
			(freshStatement?.status as "OPEN" | "PAID" | "VOID" | undefined) ??
			"VOID";
		const freshPlan = planDeliveryAttempt({
			history: freshHistory,
			currentStatementStatus: freshStatus,
			isSameDueDay: true,
		});

		if (
			freshPlan === "SKIP_DONE" ||
			freshPlan === "SKIP_MAX_ATTEMPTS" ||
			freshPlan === "SKIP_NOT_SAME_DAY"
		) {
			// Resolved concurrently since the precheck; a pre-existing delivery
			// already carries its own attempts, so nothing is left naked.
			return;
		}

		if (freshPlan === "SUPPRESS_OBSOLETE") {
			await insertDeliveryAttemptInTransaction(tx, {
				userId: event.userId,
				deliveryId,
				nextAttemptNo: freshHistory.attemptCount + 1,
				status: "SUPPRESSED_OBSOLETE",
				httpStatus: null,
				errorCode: null,
				attemptedAt: scheduledAt,
			});
			summary.suppressed++;
			return;
		}

		// freshPlan === "SEND". sendResult must be non-null here: the precheck
		// already established the statement was OPEN and the delivery was
		// eligible, and freshPlan re-confirmed the same; the only way to reach
		// "SEND" is via the precheck-also-"SEND" branch above.
		if (!sendResult) return;

		const attempt = await insertDeliveryAttemptInTransaction(tx, {
			userId: event.userId,
			deliveryId,
			nextAttemptNo: freshHistory.attemptCount + 1,
			status: sendResult.outcome,
			httpStatus: sendResult.httpStatus ?? null,
			errorCode: sendResult.errorCode ?? null,
			attemptedAt: scheduledAt,
		});

		if (sendResult.outcome === "SUCCESS") summary.successes++;
		else if (sendResult.outcome === "RETRYABLE_FAILURE")
			summary.retryableFailures++;
		else summary.terminalFailures++;

		if (
			sendResult.outcome === "TERMINAL_FAILURE" &&
			sendResult.errorCode === "ENDPOINT_GONE"
		) {
			const idempotencyKey = await deriveNotificationChildIdempotencyKey(
				"scheduler-endpoint-gone",
				[subscription.subscriptionId, deliveryId, String(attempt.attemptNo)],
			);
			await disablePushSubscriptionForEndpointGoneInTransaction(tx, {
				userId: event.userId,
				subscriptionId: subscription.subscriptionId,
				occurredAt: scheduledAt,
				idempotencyKey,
			});
		}
	});
}

/**
 * The hourly cron entrypoint's core algorithm (Section 25). Never returns
 * PII -- counts only.
 */
export async function runNotificationScheduler(
	params: RunNotificationSchedulerParams,
): Promise<NotificationSchedulerSummary> {
	const { db, scheduledAt, transport } = params;
	const { localDate, localHour } = getIstanbulLocalDateAndHour(scheduledAt);

	const summary: NotificationSchedulerSummary = {
		eventsCreated: 0,
		deliveriesCreated: 0,
		successes: 0,
		retryableFailures: 0,
		terminalFailures: 0,
		suppressed: 0,
	};

	if (isAtOrAfterNotificationDeliveryHour(localHour)) {
		const result = await runNotificationTransaction(db, (tx) =>
			materializeCreditCardDueEventsInTransaction(tx, localDate),
		);
		summary.eventsCreated = result.eventsCreated;
	}

	const events = await runNotificationReadTransaction(db, (tx) =>
		listEventsForLocalDateInTransaction(tx, localDate),
	);
	if (events.length === 0) {
		return summary;
	}

	for (const rawEvent of events) {
		const event: NotificationEventReadModel = {
			id: rawEvent.id,
			userId: rawEvent.userId,
			notificationType: rawEvent.notificationType as "CREDIT_CARD_DUE",
			subjectId: rawEvent.subjectId,
			scheduledLocalDate: rawEvent.scheduledLocalDate,
			scheduledFor: rawEvent.scheduledFor,
			payload: rawEvent.payload,
			createdAt: rawEvent.createdAt,
		};

		const activeSubscriptions = await runNotificationReadTransaction(db, (tx) =>
			listActivePushSubscriptionsInTransaction(tx, event.userId),
		);
		if (activeSubscriptions.length === 0) continue;

		for (const subscription of activeSubscriptions) {
			await processEventSubscription(
				db,
				transport,
				event,
				subscription,
				scheduledAt,
				summary,
			);
		}
	}

	return summary;
}
