import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	index,
	integer,
	numeric,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { midasAccounts, midasAllocationTransfers, midasBuckets } from "./midas";
import { transactionRevisions } from "./transactions";

export const LONG_TERM_TASK_OPERATIONS = [
	"CREATE",
	"SENT",
	"REOPEN",
	"CANCEL",
] as const;
export type LongTermTaskOperation = (typeof LONG_TERM_TASK_OPERATIONS)[number];

export const LONG_TERM_TASK_STATUSES = [
	"PENDING",
	"SENT",
	"CANCELLED",
] as const;
export type LongTermTaskStatus = (typeof LONG_TERM_TASK_STATUSES)[number];

/**
 * Long-Term Send Tasks Table (Immutable Identity Anchor)
 * One row per long-term investment allocation/send task. midasAccountId and
 * pendingBucketId are immutable once created. Mutable lifecycle state lives
 * in long_term_send_task_revisions.
 */
export const longTermSendTasks = pgTable(
	"long_term_send_tasks",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		midasAccountId: uuid("midas_account_id")
			.notNull()
			.references(() => midasAccounts.id, { onDelete: "restrict" }),
		pendingBucketId: uuid("pending_bucket_id")
			.notNull()
			.references(() => midasBuckets.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("long_term_send_tasks_user_idx").on(table.userId),
		index("long_term_send_tasks_account_idx").on(table.midasAccountId),
		index("long_term_send_tasks_bucket_idx").on(table.pendingBucketId),
	],
);

/**
 * Long-Term Send Task Revisions Table (Append-Only Lifecycle Log)
 * revision #1 is always CREATE/PENDING. Subsequent revisions follow the
 * exact transition table: PENDING -> SENT, PENDING -> CANCELLED (terminal),
 * SENT -> PENDING (REOPEN), PENDING (post-REOPEN) -> SENT or CANCELLED.
 */
export const longTermSendTaskRevisions = pgTable(
	"long_term_send_task_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		taskId: uuid("task_id")
			.notNull()
			.references(() => longTermSendTasks.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => longTermSendTaskRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		status: varchar("status", { length: 20 }).notNull(),
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		destinationLabel: varchar("destination_label", { length: 120 }),
		note: varchar("note", { length: 500 }),
		reasonNote: varchar("reason_note", { length: 500 }),
		midasAllocationTransferId: uuid("midas_allocation_transfer_id")
			.notNull()
			.references(() => midasAllocationTransfers.id, { onDelete: "restrict" }),
		canonicalRevisionId: uuid("canonical_revision_id").references(
			() => transactionRevisions.id,
			{ onDelete: "restrict" },
		),
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
		uniqueIndex("long_term_task_revisions_task_rev_idx").on(
			table.taskId,
			table.revisionNo,
		),
		uniqueIndex("long_term_task_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("long_term_task_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("long_term_task_revisions_transfer_idx").on(
			table.midasAllocationTransferId,
		),
		uniqueIndex("long_term_task_revisions_canonical_rev_idx")
			.on(table.canonicalRevisionId)
			.where(sql`${table.canonicalRevisionId} IS NOT NULL`),
		index("long_term_task_revisions_task_idx").on(table.taskId),
		index("long_term_task_revisions_user_idx").on(table.userId),
		check(
			"long_term_task_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"long_term_task_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'SENT', 'REOPEN', 'CANCEL')`,
		),
		check(
			"long_term_task_revisions_status_check",
			sql`${table.status} IN ('PENDING', 'SENT', 'CANCELLED')`,
		),
		check("long_term_task_revisions_amount_check", sql`${table.amount} > 0`),
		check(
			"long_term_task_revisions_destination_label_check",
			sql`${table.destinationLabel} IS NULL OR (${table.destinationLabel} = btrim(${table.destinationLabel}) AND length(${table.destinationLabel}) >= 1 AND length(${table.destinationLabel}) <= 120)`,
		),
		check(
			"long_term_task_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) >= 1 AND length(${table.note}) <= 500)`,
		),
		check(
			"long_term_task_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) >= 1 AND length(${table.reasonNote}) <= 500)`,
		),
		check(
			"long_term_task_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"long_term_task_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);
