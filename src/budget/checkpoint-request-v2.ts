import { and, desc, eq, lte } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client";
import {
	budgetV2CheckpointRequests,
	budgetV2CheckpointTriggerCardRevisions,
} from "../db/schema/budget-v2-checkpoint";
import { getIstanbulCalendarDate } from "../income/calendar";

/**
 * PAID-EVENT -> DURABLE CHECKPOINT REQUEST enqueue (Checkpoint 5, Section 5).
 *
 * Called from inside the canonical statement-payment transaction, AFTER the
 * `credit_card_statement_payment_events` row and the PAY statement revision
 * exist. It:
 *
 *   1. resolves the checkpoint trigger-card config effective at the payment
 *      event's `occurredAt` (greatest revisionNo whose occurredAt <= that
 *      instant) -- keyed by the EXACT creditCardId, never issuer/name;
 *   2. if the card is not an ENABLED trigger card -> does nothing;
 *   3. otherwise inserts EXACTLY ONE immutable checkpoint REQUEST row, keyed
 *      uniquely on paymentEventId (ON CONFLICT DO NOTHING makes a concurrent
 *      retry a no-op).
 *
 * This is transactionally bound to the PAY event: a failure here rolls back
 * the payment, and a committed payment always carries its request. It is
 * NEVER called on statement CREATE / UPDATE / VOID / REOPEN or on a
 * payment preview -- only an actual successful PAY reaches this code.
 *
 * The request is durable evidence only. It is NOT the report and never runs
 * `buildBudgetV2CheckpointReport`.
 */

export interface MaybeEnqueueCheckpointRequestParams {
	tx: DatabaseTransaction;
	userId: string;
	statementId: string;
	creditCardId: string;
	paymentEventId: string;
	payRevisionId: string;
	/** The payment event's business-effective instant. */
	occurredAt: Date;
}

export interface MaybeEnqueueCheckpointRequestResult {
	enqueued: boolean;
	/** The period the PAYMENT EVENT instant falls in (Europe/Istanbul), YYYY-MM-01. */
	periodMonth: string | null;
}

function periodMonthForInstant(instant: Date): string {
	return `${getIstanbulCalendarDate(instant).slice(0, 7)}-01`;
}

export async function maybeEnqueueBudgetV2CheckpointRequest(
	params: MaybeEnqueueCheckpointRequestParams,
): Promise<MaybeEnqueueCheckpointRequestResult> {
	const {
		tx,
		userId,
		statementId,
		creditCardId,
		paymentEventId,
		payRevisionId,
		occurredAt,
	} = params;

	// 1. Effective trigger-card config as of the payment instant.
	const [cfg] = await tx
		.select({
			id: budgetV2CheckpointTriggerCardRevisions.id,
			status: budgetV2CheckpointTriggerCardRevisions.status,
		})
		.from(budgetV2CheckpointTriggerCardRevisions)
		.where(
			and(
				eq(budgetV2CheckpointTriggerCardRevisions.userId, userId),
				eq(budgetV2CheckpointTriggerCardRevisions.creditCardId, creditCardId),
				lte(budgetV2CheckpointTriggerCardRevisions.occurredAt, occurredAt),
			),
		)
		.orderBy(desc(budgetV2CheckpointTriggerCardRevisions.revisionNo))
		.limit(1);

	// 2. No row => NOT ENABLED. DISABLED => no trigger.
	if (cfg?.status !== "ENABLED") {
		return { enqueued: false, periodMonth: null };
	}

	// 3. Exactly one immutable request per payment event.
	const periodMonth = periodMonthForInstant(occurredAt);
	const [inserted] = await tx
		.insert(budgetV2CheckpointRequests)
		.values({
			userId,
			paymentEventId,
			statementId,
			creditCardId,
			payRevisionId,
			triggerConfigRevisionId: cfg.id,
			checkpointAt: occurredAt,
			periodMonth,
		})
		.onConflictDoNothing({
			target: [budgetV2CheckpointRequests.paymentEventId],
		})
		.returning({ id: budgetV2CheckpointRequests.id });

	return { enqueued: Boolean(inserted), periodMonth };
}
