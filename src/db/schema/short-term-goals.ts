import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { midasAccounts, midasBuckets } from "./midas";

export const SHORT_TERM_GOAL_STATUSES = [
	"ACTIVE",
	"COMPLETED",
	"CANCELLED",
] as const;
export type ShortTermGoalStatus = (typeof SHORT_TERM_GOAL_STATUSES)[number];

export const SHORT_TERM_GOAL_OPERATIONS = [
	"CREATE",
	"UPDATE",
	"COMPLETE",
	"CANCEL",
] as const;
export type ShortTermGoalOperation =
	(typeof SHORT_TERM_GOAL_OPERATIONS)[number];

export const SHORT_TERM_GOAL_FUNDING_STATUSES = [
	"EMPTY",
	"PARTIAL",
	"TARGET_REACHED",
] as const;
export type ShortTermGoalFundingStatus =
	(typeof SHORT_TERM_GOAL_FUNDING_STATUSES)[number];

/**
 * Short-Term Goals Table (Anchor / Identity)
 * Maps 1-to-1 with a dedicated SHORT_TERM_GOAL Midas virtual bucket.
 * Contains no mutable or financial data; rows are immutable.
 */
export const shortTermGoals = pgTable(
	"short_term_goals",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		midasAccountId: uuid("midas_account_id")
			.notNull()
			.references(() => midasAccounts.id, { onDelete: "restrict" }),
		midasBucketId: uuid("midas_bucket_id")
			.notNull()
			.references(() => midasBuckets.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("short_term_goals_bucket_idx").on(table.midasBucketId),
		index("short_term_goals_account_idx").on(table.midasAccountId),
		index("short_term_goals_user_idx").on(table.userId),
	],
);

/**
 * Short-Term Goal Revisions Table (Append-Only)
 * Snapshots all configuration changes and lifecycle transitions for a goal.
 */
export const shortTermGoalRevisions = pgTable(
	"short_term_goal_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		goalId: uuid("goal_id")
			.notNull()
			.references(() => shortTermGoals.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => shortTermGoalRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		status: varchar("status", { length: 20 }).notNull(),
		name: varchar("name", { length: 120 }).notNull(),
		fundingTarget: numeric("funding_target", {
			precision: 18,
			scale: 2,
		}).notNull(),
		targetDate: date("target_date"),
		maxBudget: numeric("max_budget", { precision: 18, scale: 2 }),
		targetPrice: numeric("target_price", { precision: 18, scale: 2 }),
		productUrl: varchar("product_url", { length: 2048 }),
		note: varchar("note", { length: 500 }),
		changeReason: varchar("change_reason", { length: 500 }),
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
		uniqueIndex("stg_revisions_goal_rev_idx").on(
			table.goalId,
			table.revisionNo,
		),
		uniqueIndex("stg_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("stg_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("stg_revisions_goal_idx").on(table.goalId),
		index("stg_revisions_user_idx").on(table.userId),
		check("stg_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"stg_revisions_operation_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'COMPLETE', 'CANCEL')`,
		),
		check(
			"stg_revisions_status_check",
			sql`${table.status} IN ('ACTIVE', 'COMPLETED', 'CANCELLED')`,
		),
		check(
			"stg_revisions_name_check",
			sql`${table.name} = btrim(${table.name}) AND length(${table.name}) >= 1 AND length(${table.name}) <= 120`,
		),
		check("stg_revisions_target_check", sql`${table.fundingTarget} > 0`),
		check(
			"stg_revisions_max_budget_check",
			sql`${table.maxBudget} IS NULL OR (${table.maxBudget} > 0 AND ${table.fundingTarget} <= ${table.maxBudget})`,
		),
		check(
			"stg_revisions_target_price_check",
			sql`${table.targetPrice} IS NULL OR ${table.targetPrice} > 0`,
		),
		check(
			"stg_revisions_product_url_check",
			sql`${table.productUrl} IS NULL OR (${table.productUrl} = btrim(${table.productUrl}) AND length(${table.productUrl}) >= 1 AND length(${table.productUrl}) <= 2048 AND ${table.productUrl} ~* '^https?://')`,
		),
		check(
			"stg_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) >= 1 AND length(${table.note}) <= 500)`,
		),
		check(
			"stg_revisions_change_reason_check",
			sql`${table.changeReason} IS NULL OR (${table.changeReason} = btrim(${table.changeReason}) AND length(${table.changeReason}) >= 1 AND length(${table.changeReason}) <= 500)`,
		),
		check(
			"stg_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"stg_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

/**
 * Short-Term Goal Priority Revisions Table (Append-Only)
 * Snapshots the complete user-defined manual priority ordering of ACTIVE goals for a Midas account.
 */
export const shortTermGoalPriorityRevisions = pgTable(
	"short_term_goal_priority_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		midasAccountId: uuid("midas_account_id")
			.notNull()
			.references(() => midasAccounts.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => shortTermGoalPriorityRevisions.id,
			{ onDelete: "restrict" },
		),
		orderedGoalIds: jsonb("ordered_goal_ids").notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		priorityFingerprint: varchar("priority_fingerprint", {
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
		uniqueIndex("stg_priority_acc_rev_idx").on(
			table.midasAccountId,
			table.revisionNo,
		),
		uniqueIndex("stg_priority_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("stg_priority_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("stg_priority_account_idx").on(table.midasAccountId),
		index("stg_priority_user_idx").on(table.userId),
		check("stg_priority_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"stg_priority_fingerprint_check",
			sql`${table.priorityFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"stg_priority_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
		check(
			"stg_priority_json_array_check",
			sql`jsonb_typeof(${table.orderedGoalIds}) = 'array'`,
		),
	],
);
