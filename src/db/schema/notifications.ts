import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const PUSH_SUBSCRIPTION_OPERATIONS = [
	"REGISTER",
	"REFRESH",
	"DISABLE",
	"REACTIVATE",
] as const;
export type PushSubscriptionOperation =
	(typeof PUSH_SUBSCRIPTION_OPERATIONS)[number];

export const PUSH_SUBSCRIPTION_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type PushSubscriptionStatus =
	(typeof PUSH_SUBSCRIPTION_STATUSES)[number];

export const NOTIFICATION_TYPES = ["CREDIT_CARD_DUE"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_DELIVERY_ATTEMPT_STATUSES = [
	"SUCCESS",
	"RETRYABLE_FAILURE",
	"TERMINAL_FAILURE",
	"SUPPRESSED_OBSOLETE",
] as const;
export type NotificationDeliveryAttemptStatus =
	(typeof NOTIFICATION_DELIVERY_ATTEMPT_STATUSES)[number];

/**
 * Push Subscriptions Table (Immutable Identity Anchor)
 * One row per unique (user, endpoint identity). endpoint_hash is the stable
 * SHA-256 hex identity of the normalized endpoint URL, computed once at the
 * application layer before insert -- it is how REGISTER vs REFRESH/REACTIVATE
 * is distinguished for the "same browser/device subscription" case. Rows are
 * immutable once created; mutable lifecycle state lives in
 * push_subscription_revisions.
 */
export const pushSubscriptions = pgTable(
	"push_subscriptions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		endpointHash: varchar("endpoint_hash", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("push_subscriptions_user_endpoint_hash_idx").on(
			table.userId,
			table.endpointHash,
		),
		index("push_subscriptions_user_idx").on(table.userId),
		check(
			"push_subscriptions_endpoint_hash_check",
			sql`${table.endpointHash} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

/**
 * Push Subscription Revisions Table (Append-Only Lifecycle Log)
 * revision #1 is always REGISTER/ACTIVE. Subsequent revisions follow:
 * ACTIVE -> DISABLED (DISABLE), ACTIVE -> ACTIVE (REFRESH, same endpoint
 * identity with updated keys/metadata), DISABLED -> ACTIVE (REACTIVATE).
 */
export const pushSubscriptionRevisions = pgTable(
	"push_subscription_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		subscriptionId: uuid("subscription_id")
			.notNull()
			.references(() => pushSubscriptions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => pushSubscriptionRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		status: varchar("status", { length: 20 }).notNull(),
		endpoint: varchar("endpoint", { length: 2048 }).notNull(),
		p256dh: varchar("p256dh", { length: 128 }).notNull(),
		auth: varchar("auth", { length: 64 }).notNull(),
		expirationTime: timestamp("expiration_time", {
			withTimezone: true,
			mode: "date",
		}),
		userAgent: varchar("user_agent", { length: 500 }),
		disableReason: varchar("disable_reason", { length: 500 }),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("push_sub_revisions_sub_rev_idx").on(
			table.subscriptionId,
			table.revisionNo,
		),
		uniqueIndex("push_sub_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("push_sub_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("push_sub_revisions_sub_idx").on(table.subscriptionId),
		index("push_sub_revisions_user_idx").on(table.userId),
		check("push_sub_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"push_sub_revisions_op_check",
			sql`${table.operation} IN ('REGISTER', 'REFRESH', 'DISABLE', 'REACTIVATE')`,
		),
		check(
			"push_sub_revisions_status_check",
			sql`${table.status} IN ('ACTIVE', 'DISABLED')`,
		),
		check(
			"push_sub_revisions_endpoint_check",
			sql`${table.endpoint} = btrim(${table.endpoint}) AND length(${table.endpoint}) >= 1 AND length(${table.endpoint}) <= 2048 AND ${table.endpoint} LIKE 'https://%'`,
		),
		check(
			"push_sub_revisions_p256dh_check",
			sql`${table.p256dh} ~ '^[A-Za-z0-9_-]{1,128}$'`,
		),
		check(
			"push_sub_revisions_auth_check",
			sql`${table.auth} ~ '^[A-Za-z0-9_-]{1,64}$'`,
		),
		check(
			"push_sub_revisions_user_agent_check",
			sql`${table.userAgent} IS NULL OR (length(${table.userAgent}) >= 1 AND length(${table.userAgent}) <= 500)`,
		),
		check(
			"push_sub_revisions_disable_reason_check",
			sql`${table.disableReason} IS NULL OR (${table.disableReason} = btrim(${table.disableReason}) AND length(${table.disableReason}) >= 1 AND length(${table.disableReason}) <= 500)`,
		),
		check(
			"push_sub_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"push_sub_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

/**
 * Notification Events Table (Insert-Only Logical Event Log)
 * One row per logical notification, ever. V1 notification_type is
 * CREDIT_CARD_DUE only (subject_id = the credit_card_statements.id). The
 * CHECK constraint is intentionally narrow for V1; a future phase widens it
 * via its own forward migration.
 */
export const notificationEvents = pgTable(
	"notification_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		notificationType: varchar("notification_type", { length: 30 }).notNull(),
		subjectId: uuid("subject_id").notNull(),
		scheduledLocalDate: date("scheduled_local_date").notNull(),
		scheduledFor: timestamp("scheduled_for", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		payload: jsonb("payload").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("notification_events_user_type_subject_idx").on(
			table.userId,
			table.notificationType,
			table.subjectId,
		),
		index("notification_events_user_idx").on(table.userId),
		index("notification_events_scheduled_local_date_idx").on(
			table.scheduledLocalDate,
		),
		check(
			"notification_events_type_check",
			sql`${table.notificationType} IN ('CREDIT_CARD_DUE')`,
		),
	],
);

/**
 * Notification Deliveries Table (Immutable Fan-Out Anchor)
 * One row per (logical event, active push subscription) pair, ever. Exactly
 * one delivery per pair -- this is how one logical event fans out to
 * multiple devices (Android + macOS) without ever duplicating the logical
 * event itself. A delivery is only ever created together with its first
 * attempt (in the same short transaction) so a permanently-naked delivery is
 * not a reachable applicationstate; a deferred DB constraint also rejects a
 * naked delivery anchor at commit as a backstop.
 */
export const notificationDeliveries = pgTable(
	"notification_deliveries",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		notificationEventId: uuid("notification_event_id")
			.notNull()
			.references(() => notificationEvents.id, { onDelete: "restrict" }),
		pushSubscriptionId: uuid("push_subscription_id")
			.notNull()
			.references(() => pushSubscriptions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("notification_deliveries_event_sub_idx").on(
			table.notificationEventId,
			table.pushSubscriptionId,
		),
		index("notification_deliveries_user_idx").on(table.userId),
		index("notification_deliveries_event_idx").on(table.notificationEventId),
		index("notification_deliveries_sub_idx").on(table.pushSubscriptionId),
	],
);

/**
 * Notification Delivery Dispatches Table (Append-Only Pre-Send Reservation)
 * Phase 15-R1 Section A. A durable reservation, committed BEFORE any network
 * call, that binds one (delivery, hourly cron slot) pair to the EXACT push
 * subscription revision that will be used. `dispatch_no` is a
 * strictly-increasing unbranched sequence per delivery_id, starting at 1
 * (independent of `notification_delivery_attempts.attempt_no`, which also
 * counts no-network SUPPRESSED_OBSOLETE outcomes). The
 * `(delivery_id, scheduler_hour_slot)` UNIQUE constraint is what makes "two
 * overlapping/concurrent scheduler invocations for the same hourly slot
 * perform zero duplicate network calls" DB-provable: a second reservation
 * attempt for the same slot conflicts and is treated as a no-op by the
 * caller (see `reserveDispatchInTransaction`).
 */
export const notificationDeliveryDispatches = pgTable(
	"notification_delivery_dispatches",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		deliveryId: uuid("delivery_id")
			.notNull()
			.references(() => notificationDeliveries.id, { onDelete: "restrict" }),
		dispatchNo: integer("dispatch_no").notNull(),
		pushSubscriptionRevisionId: uuid("push_subscription_revision_id")
			.notNull()
			.references(() => pushSubscriptionRevisions.id, {
				onDelete: "restrict",
			}),
		schedulerHourSlot: timestamp("scheduler_hour_slot", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		reservedAt: timestamp("reserved_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("notification_delivery_dispatches_delivery_no_idx").on(
			table.deliveryId,
			table.dispatchNo,
		),
		uniqueIndex("notification_delivery_dispatches_delivery_hour_idx").on(
			table.deliveryId,
			table.schedulerHourSlot,
		),
		index("notification_delivery_dispatches_delivery_idx").on(table.deliveryId),
		index("notification_delivery_dispatches_user_idx").on(table.userId),
		index("notification_delivery_dispatches_revision_idx").on(
			table.pushSubscriptionRevisionId,
		),
		check(
			"notification_delivery_dispatches_no_check",
			sql`${table.dispatchNo} > 0 AND ${table.dispatchNo} <= 5`,
		),
	],
);

/**
 * Notification Delivery Attempts Table (Append-Only Attempt Chain)
 * attempt_no is a strictly-increasing unbranched sequence per delivery_id,
 * starting at 1. Raw push response bodies are NEVER persisted here.
 * `dispatch_id` (Phase 15-R1 Section A/K) binds a completed network attempt
 * result to the exact pre-send dispatch reservation it resolves -- NULL only
 * for the no-network SUPPRESSED_OBSOLETE path (Section J/31).
 */
export const notificationDeliveryAttempts = pgTable(
	"notification_delivery_attempts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		deliveryId: uuid("delivery_id")
			.notNull()
			.references(() => notificationDeliveries.id, { onDelete: "restrict" }),
		dispatchId: uuid("dispatch_id").references(
			() => notificationDeliveryDispatches.id,
			{ onDelete: "restrict" },
		),
		attemptNo: integer("attempt_no").notNull(),
		status: varchar("status", { length: 30 }).notNull(),
		httpStatus: integer("http_status"),
		errorCode: varchar("error_code", { length: 64 }),
		attemptedAt: timestamp("attempted_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("notification_delivery_attempts_delivery_no_idx").on(
			table.deliveryId,
			table.attemptNo,
		),
		uniqueIndex("notification_delivery_attempts_dispatch_idx")
			.on(table.dispatchId)
			.where(sql`${table.dispatchId} IS NOT NULL`),
		index("notification_delivery_attempts_delivery_idx").on(table.deliveryId),
		index("notification_delivery_attempts_user_idx").on(table.userId),
		check(
			"notification_delivery_attempts_no_check",
			sql`${table.attemptNo} > 0 AND ${table.attemptNo} <= 5`,
		),
		check(
			"notification_delivery_attempts_status_check",
			sql`${table.status} IN ('SUCCESS', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE', 'SUPPRESSED_OBSOLETE')`,
		),
		check(
			"notification_delivery_attempts_http_status_check",
			sql`${table.httpStatus} IS NULL OR (${table.httpStatus} >= 100 AND ${table.httpStatus} <= 599)`,
		),
		check(
			"notification_delivery_attempts_error_code_check",
			sql`${table.errorCode} IS NULL OR (length(${table.errorCode}) >= 1 AND length(${table.errorCode}) <= 64)`,
		),
	],
);
