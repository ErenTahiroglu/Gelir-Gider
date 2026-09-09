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
import { creditCardStatementPaymentEvents } from "./credit-card-ledger";
import {
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "./credit-cards";

/**
 * PERSONAL_BUDGET_V2 -- DURABLE CHECKPOINT PERSISTENCE & PAID-EVENT TRIGGER
 * ORCHESTRATION (Checkpoint 5).
 *
 * Three additive tables that turn the authoritative Budget V2 checkpoint READ
 * model into a durable production workflow:
 *
 *   budget_v2_checkpoint_trigger_card_revisions
 *     -- append-only, user-approved config marking an EXACT owned creditCardId
 *        as a checkpoint-trigger card. No issuer / displayName / last-four /
 *        merchant inference anywhere: a row is keyed by the literal card id.
 *        `status` ENABLED | DISABLED; no row => NOT ENABLED.
 *
 *   budget_v2_checkpoint_requests
 *     -- an immutable OUTBOX row. One row = one actual eligible PAID payment
 *        event that requires a Budget V2 checkpoint. NOT the report. Created
 *        transactionally with the PAY event; unique on payment_event_id.
 *
 *   budget_v2_checkpoint_snapshots
 *     -- an immutable successful checkpoint report snapshot. Exactly one per
 *        request. `report_json` is frozen at production time and is the sole
 *        historical replay source -- later source-truth changes never rewrite
 *        it. `report_fingerprint` is a canonical (recursively key-sorted)
 *        lowercase SHA-256 of `report_json`.
 *
 * None of these carry a ledger posting / canonical transaction / Midas
 * movement / statement-liability change. Month-close remains a separate
 * lifecycle and is never invoked from here.
 */

// ============================================================================
// Trigger-card config
// ============================================================================

export const CHECKPOINT_TRIGGER_CARD_OPERATIONS = ["CREATE", "UPDATE"] as const;
export type CheckpointTriggerCardOperation =
	(typeof CHECKPOINT_TRIGGER_CARD_OPERATIONS)[number];

export const CHECKPOINT_TRIGGER_CARD_STATUSES = [
	"ENABLED",
	"DISABLED",
] as const;
export type CheckpointTriggerCardStatus =
	(typeof CHECKPOINT_TRIGGER_CARD_STATUSES)[number];

export const CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS = ["USER_APPROVED"] as const;
export type CheckpointTriggerCardSourceKind =
	(typeof CHECKPOINT_TRIGGER_CARD_SOURCE_KINDS)[number];

export const budgetV2CheckpointTriggerCardRevisions = pgTable(
	"budget_v2_checkpoint_trigger_card_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => budgetV2CheckpointTriggerCardRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE | UPDATE
		status: varchar("status", { length: 16 }).notNull(), // ENABLED | DISABLED
		sourceKind: varchar("source_kind", { length: 32 }).notNull(), // USER_APPROVED
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// One unbranched append-only chain per user+card.
		uniqueIndex("bv2ckcard_user_card_rev_no_idx").on(
			table.userId,
			table.creditCardId,
			table.revisionNo,
		),
		uniqueIndex("bv2ckcard_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("bv2ckcard_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("bv2ckcard_user_card_idx").on(table.userId, table.creditCardId),
		check("bv2ckcard_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"bv2ckcard_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE')`,
		),
		check(
			"bv2ckcard_status_check",
			sql`${table.status} IN ('ENABLED', 'DISABLED')`,
		),
		check(
			"bv2ckcard_source_kind_check",
			sql`${table.sourceKind} IN ('USER_APPROVED')`,
		),
		check(
			"bv2ckcard_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"bv2ckcard_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
		check(
			"bv2ckcard_create_chain_check",
			sql`${table.revisionNo} <> 1 OR (${table.previousRevisionId} IS NULL AND ${table.operation} = 'CREATE')`,
		),
		check(
			"bv2ckcard_noncreate_chain_check",
			sql`${table.revisionNo} = 1 OR (${table.previousRevisionId} IS NOT NULL AND ${table.operation} = 'UPDATE')`,
		),
	],
);

// ============================================================================
// Durable checkpoint request (immutable outbox)
// ============================================================================

export const budgetV2CheckpointRequests = pgTable(
	"budget_v2_checkpoint_requests",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		paymentEventId: uuid("payment_event_id")
			.notNull()
			.references(() => creditCardStatementPaymentEvents.id, {
				onDelete: "restrict",
			}),
		statementId: uuid("statement_id")
			.notNull()
			.references(() => creditCardStatements.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		payRevisionId: uuid("pay_revision_id")
			.notNull()
			.references(() => creditCardStatementRevisions.id, {
				onDelete: "restrict",
			}),
		triggerConfigRevisionId: uuid("trigger_config_revision_id")
			.notNull()
			.references(() => budgetV2CheckpointTriggerCardRevisions.id, {
				onDelete: "restrict",
			}),
		checkpointAt: timestamp("checkpoint_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		periodMonth: date("period_month", { mode: "string" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// One request per actual payment event.
		uniqueIndex("bv2ckreq_payment_event_idx").on(table.paymentEventId),
		index("bv2ckreq_user_period_idx").on(
			table.userId,
			table.periodMonth,
			table.checkpointAt,
		),
		check(
			"bv2ckreq_period_first_day_check",
			sql`EXTRACT(DAY FROM ${table.periodMonth}) = 1`,
		),
	],
);

// ============================================================================
// Immutable checkpoint snapshot (successful report)
// ============================================================================

export const budgetV2CheckpointSnapshots = pgTable(
	"budget_v2_checkpoint_snapshots",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		requestId: uuid("request_id")
			.notNull()
			.references(() => budgetV2CheckpointRequests.id, {
				onDelete: "restrict",
			}),
		paymentEventId: uuid("payment_event_id")
			.notNull()
			.references(() => creditCardStatementPaymentEvents.id, {
				onDelete: "restrict",
			}),
		periodMonth: date("period_month", { mode: "string" }).notNull(),
		checkpointAt: timestamp("checkpoint_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		previousCheckpointSnapshotId: uuid(
			"previous_checkpoint_snapshot_id",
		).references((): AnyPgColumn => budgetV2CheckpointSnapshots.id, {
			onDelete: "restrict",
		}),
		previousCheckpointAt: timestamp("previous_checkpoint_at", {
			withTimezone: true,
			mode: "date",
		}),
		reportSchemaVersion: varchar("report_schema_version", {
			length: 64,
		}).notNull(),
		reportJson: jsonb("report_json").notNull(),
		reportFingerprint: varchar("report_fingerprint", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("bv2cksnap_request_idx").on(table.requestId),
		uniqueIndex("bv2cksnap_payment_event_idx").on(table.paymentEventId),
		// No branch in the previous-checkpoint chain.
		uniqueIndex("bv2cksnap_prev_idx")
			.on(table.previousCheckpointSnapshotId)
			.where(sql`${table.previousCheckpointSnapshotId} IS NOT NULL`),
		index("bv2cksnap_user_period_idx").on(
			table.userId,
			table.periodMonth,
			table.checkpointAt,
		),
		check(
			"bv2cksnap_period_first_day_check",
			sql`EXTRACT(DAY FROM ${table.periodMonth}) = 1`,
		),
		check(
			"bv2cksnap_fingerprint_check",
			sql`${table.reportFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		// previous_checkpoint_snapshot_id and previous_checkpoint_at are set
		// together or both null (first checkpoint of a period).
		check(
			"bv2cksnap_prev_pair_check",
			sql`(${table.previousCheckpointSnapshotId} IS NULL) = (${table.previousCheckpointAt} IS NULL)`,
		),
		check(
			"bv2cksnap_prev_before_check",
			sql`${table.previousCheckpointAt} IS NULL OR ${table.previousCheckpointAt} < ${table.checkpointAt}`,
		),
	],
);
