import type { Database } from "../db/client";
import {
	runNotificationReadTransaction,
	runNotificationTransaction,
} from "./boundary";
import {
	getIstanbulLocalDateAndHour,
	isAtOrAfterNotificationDeliveryHour,
} from "./calendar";
import {
	ensureDeliveryInTransaction,
	insertDeliveryAttemptInTransaction,
	lockDeliveryHistoryInTransaction,
	planDeliveryAttempt,
	reserveDispatchInTransaction,
	resolveStaleDispatchReservationsInTransaction,
	toAttemptHistory,
	truncateToSchedulerHourSlot,
} from "./delivery";
import { NotificationError } from "./errors";
import type { NotificationEventReadModel } from "./events";
import {
	getLatestStatementRevisionInTransaction,
	listEventsForLocalDateInTransaction,
	materializeCreditCardDueEventsInTransaction,
} from "./events";
import { deriveNotificationChildIdempotencyKey } from "./fingerprint";
import {
	disablePushSubscriptionForEndpointGoneIfStillLatestInTransaction,
	getActiveSubscriptionRevisionInTransaction,
	listActivePushSubscriptionsInTransaction,
	type PushSubscriptionReadModel,
} from "./subscriptions";
import type { PushSendResult, PushTransport } from "./web-push";

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

function zeroSummary(): NotificationSchedulerSummary {
	return {
		eventsCreated: 0,
		deliveriesCreated: 0,
		successes: 0,
		retryableFailures: 0,
		terminalFailures: 0,
		suppressed: 0,
	};
}

type ReservationOutcome =
	| {
			kind: "RESERVED";
			deliveryId: string;
			dispatchId: string;
			pushSubscriptionRevisionId: string;
			endpoint: string;
			p256dh: string;
			auth: string;
	  }
	| { kind: "NONE" };

/**
 * Phase 15-R1 Section A -- Transaction A ("reserve"). Runs entirely inside
 * one DB transaction and performs NO network I/O. Ensures/locks the
 * delivery, resolves any stale (crash-window) dispatch reservations, re-
 * checks the statement status and the subscription's exact ACTIVE revision,
 * decides whether a send is still warranted, and -- only if so -- commits a
 * durable pre-send dispatch reservation bound to that exact revision. If a
 * concurrent scheduler invocation already reserved this exact
 * (delivery, hourly slot) pair, the reservation INSERT is a no-op
 * (`ON CONFLICT DO NOTHING`) and this returns `{ kind: "NONE" }` -- zero
 * network calls follow.
 */
async function reserveInTransaction(
	db: Database,
	event: NotificationEventReadModel,
	subscription: PushSubscriptionReadModel,
	scheduledAt: Date,
	currentHourSlot: Date,
	summary: NotificationSchedulerSummary,
): Promise<ReservationOutcome> {
	return runNotificationTransaction(db, async (tx) => {
		const { deliveryId, created } = await ensureDeliveryInTransaction(tx, {
			userId: event.userId,
			eventId: event.id,
			subscriptionId: subscription.subscriptionId,
		});
		if (created) summary.deliveriesCreated++;

		let history = await lockDeliveryHistoryInTransaction(tx, deliveryId);
		history = await resolveStaleDispatchReservationsInTransaction(tx, {
			userId: event.userId,
			deliveryId,
			currentHourSlot,
			history,
			resolvedAt: scheduledAt,
		});

		const statement = await getLatestStatementRevisionInTransaction(
			tx,
			event.subjectId,
		);
		const currentStatementStatus =
			(statement?.status as "OPEN" | "PAID" | "VOID" | undefined) ?? "VOID";

		const plan = planDeliveryAttempt({
			history: toAttemptHistory(history),
			currentStatementStatus,
			// `listEventsForLocalDateInTransaction` only ever returns events
			// whose scheduled_local_date equals today's Istanbul local date,
			// so a delivery reached through this path is always same-due-day
			// by construction (Section 19/21 additionally gate the whole run
			// before this point is ever reached).
			isSameDueDay: true,
		});

		if (
			plan === "SKIP_DONE" ||
			plan === "SKIP_MAX_ATTEMPTS" ||
			plan === "SKIP_NOT_SAME_DAY"
		) {
			return { kind: "NONE" };
		}

		if (plan === "SUPPRESS_OBSOLETE") {
			await insertDeliveryAttemptInTransaction(tx, {
				userId: event.userId,
				deliveryId,
				nextAttemptNo: history.attemptCount + 1,
				status: "SUPPRESSED_OBSOLETE",
				httpStatus: null,
				errorCode: null,
				attemptedAt: scheduledAt,
				dispatchId: null,
			});
			summary.suppressed++;
			return { kind: "NONE" };
		}

		// plan === "SEND": re-resolve the EXACT current ACTIVE subscription
		// revision (Section B) -- never trust the revision snapshot the
		// outer loop's listing took moments earlier.
		const revision = await getActiveSubscriptionRevisionInTransaction(
			tx,
			subscription.subscriptionId,
		);
		if (!revision) {
			// Subscription was disabled concurrently since the outer active-
			// subscription listing. Nothing to reserve; the delivery anchor
			// is guaranteed non-naked because reaching "SEND" with a
			// brand-new delivery is only possible when the DB's own
			// cross-user/active-subscription INSERT guard already accepted
			// the delivery row moments earlier in this same transaction.
			return { kind: "NONE" };
		}

		const { reserved, dispatch } = await reserveDispatchInTransaction(tx, {
			userId: event.userId,
			deliveryId,
			nextDispatchNo: history.dispatchCount + 1,
			pushSubscriptionRevisionId: revision.id,
			schedulerHourSlot: currentHourSlot,
			reservedAt: scheduledAt,
		});
		if (!reserved || !dispatch) {
			// Another concurrent scheduler invocation already reserved this
			// exact hourly slot for this delivery -- zero network calls.
			return { kind: "NONE" };
		}

		return {
			kind: "RESERVED",
			deliveryId,
			dispatchId: dispatch.id,
			pushSubscriptionRevisionId: revision.id,
			endpoint: revision.endpoint,
			p256dh: revision.p256dh,
			auth: revision.auth,
		};
	});
}

/**
 * Phase 15-R1 Section A -- Transaction B ("finalize"). Runs after the
 * network call (if any) completes, entirely outside that network I/O. Locks
 * the delivery, appends the attempt result bound to the EXACT dispatch
 * reservation created in Transaction A, and -- only for a 404/410
 * ENDPOINT_GONE result -- conditionally auto-disables the subscription, but
 * ONLY if the dispatch's exact revision is still the subscription's current
 * latest revision (Section B/10/11 race fix).
 */
async function finalizeInTransaction(
	db: Database,
	event: NotificationEventReadModel,
	subscription: PushSubscriptionReadModel,
	reservation: Extract<ReservationOutcome, { kind: "RESERVED" }>,
	sendResult: PushSendResult,
	scheduledAt: Date,
	summary: NotificationSchedulerSummary,
): Promise<void> {
	await runNotificationTransaction(db, async (tx) => {
		const history = await lockDeliveryHistoryInTransaction(
			tx,
			reservation.deliveryId,
		);
		const attempt = await insertDeliveryAttemptInTransaction(tx, {
			userId: event.userId,
			deliveryId: reservation.deliveryId,
			nextAttemptNo: history.attemptCount + 1,
			status: sendResult.outcome,
			httpStatus: sendResult.httpStatus ?? null,
			errorCode: sendResult.errorCode ?? null,
			attemptedAt: scheduledAt,
			dispatchId: reservation.dispatchId,
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
				[
					subscription.subscriptionId,
					reservation.deliveryId,
					String(attempt.attemptNo),
				],
			);
			await disablePushSubscriptionForEndpointGoneIfStillLatestInTransaction(
				tx,
				{
					userId: event.userId,
					subscriptionId: subscription.subscriptionId,
					expectedRevisionId: reservation.pushSubscriptionRevisionId,
					occurredAt: scheduledAt,
					idempotencyKey,
				},
			);
		}
	});
}

/**
 * Processes exactly one (event, active subscription) pair for this
 * scheduler run using the reserve-then-send-then-finalize architecture
 * (Phase 15-R1 Section A): the push-service network call always happens
 * OUTSIDE any open database transaction, sandwiched between the durable
 * pre-send reservation (Transaction A) and the result finalization
 * (Transaction B). A global Web Push configuration failure
 * (`NOTIFICATION_PUSH_CONFIG_INVALID`) is rethrown to abort the whole
 * scheduler run rather than being misclassified as this one subscription's
 * problem (Section C/15); any other transport/crypto failure (e.g. a
 * subscription-specific encryption error from corrupted stored key
 * material) is isolated to this one subscription as a sanitized
 * `TERMINAL_FAILURE`/`INVALID_SUBSCRIPTION` result so it never aborts
 * processing of other subscriptions in the same run.
 */
async function processEventSubscription(
	db: Database,
	transport: PushTransport,
	event: NotificationEventReadModel,
	subscription: PushSubscriptionReadModel,
	scheduledAt: Date,
	currentHourSlot: Date,
	summary: NotificationSchedulerSummary,
): Promise<void> {
	const reservation = await reserveInTransaction(
		db,
		event,
		subscription,
		scheduledAt,
		currentHourSlot,
		summary,
	);
	if (reservation.kind !== "RESERVED") return;

	let sendResult: PushSendResult;
	try {
		sendResult = await transport.send(
			{
				endpoint: reservation.endpoint,
				p256dh: reservation.p256dh,
				auth: reservation.auth,
			},
			event.payload as object,
			{ ttlSeconds: NOTIFICATION_PUSH_TTL_SECONDS },
		);
	} catch (err) {
		if (
			err instanceof NotificationError &&
			err.code === "NOTIFICATION_PUSH_CONFIG_INVALID"
		) {
			// Global VAPID/config failure -- must NOT be silently converted
			// into "every subscription's attempt is terminal" (that would
			// burn through each delivery's 5-attempt budget instantly).
			// Still finalize this one reservation as an unresolved/unknown
			// outcome so it isn't left dangling, then abort the whole run.
			await finalizeInTransaction(
				db,
				event,
				subscription,
				reservation,
				{ outcome: "RETRYABLE_FAILURE", errorCode: "PUSH_CONFIG_INVALID" },
				scheduledAt,
				summary,
			);
			throw err;
		}
		// Subscription-specific crypto/transport failure (e.g. corrupted
		// stored key material throwing a raw DOMException out of the
		// encryption step) -- sanitize and isolate, never let it escape
		// uncaught or abort other subscriptions in this run.
		sendResult = {
			outcome: "TERMINAL_FAILURE",
			errorCode: "INVALID_SUBSCRIPTION",
		};
	}

	await finalizeInTransaction(
		db,
		event,
		subscription,
		reservation,
		sendResult,
		scheduledAt,
		summary,
	);
}

/**
 * The hourly cron entrypoint's core algorithm (Section 25). Never returns
 * PII -- counts only. Phase 15-R1 Section 19: before 12:00 Europe/Istanbul
 * local time, this returns a fully-zero summary IMMEDIATELY -- no
 * materialization, no event listing, no delivery/retry work of any kind,
 * even for an event that already exists from an earlier run today.
 */
export async function runNotificationScheduler(
	params: RunNotificationSchedulerParams,
): Promise<NotificationSchedulerSummary> {
	const { db, scheduledAt, transport } = params;
	const { localDate, localHour } = getIstanbulLocalDateAndHour(scheduledAt);

	if (!isAtOrAfterNotificationDeliveryHour(localHour)) {
		return zeroSummary();
	}

	const summary = zeroSummary();
	const currentHourSlot = truncateToSchedulerHourSlot(scheduledAt);

	const result = await runNotificationTransaction(db, (tx) =>
		materializeCreditCardDueEventsInTransaction(tx, localDate),
	);
	summary.eventsCreated = result.eventsCreated;

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
				currentHourSlot,
				summary,
			);
		}
	}

	return summary;
}
