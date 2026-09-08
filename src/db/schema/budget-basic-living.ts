import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	date,
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

/**
 * PERSONAL_BUDGET_V2 -- USER-APPROVED BASIC-LIVING TARGET (append-only config)
 *
 * The monthly basic-living funding target is a decision the user OWNS. The
 * system may later *suggest* a new amount from behaviour data, but it never
 * changes the target without an explicit user-approved revision here. There is
 * no hard-coded TL floor and the V1 65%% rule is never reused as the V2
 * basic-living target.
 *
 * This projection carries NO ledger posting / canonical transaction / Midas
 * movement -- it is a pure policy-config log. `effective_period_month` is the
 * first calendar day of the month a revision starts to apply from; the
 * revision effective for a given month M is the one with the greatest
 * `revision_no` whose `effective_period_month <= firstDayOf(M)`. The DB guard
 * (migration 0064) keeps `effective_period_month` non-decreasing along the
 * chain so that rule is unambiguous.
 */

export const BASIC_LIVING_CONFIG_OPERATIONS = ["CREATE", "UPDATE"] as const;
export type BasicLivingConfigOperation =
	(typeof BASIC_LIVING_CONFIG_OPERATIONS)[number];

export const BASIC_LIVING_CONFIG_SOURCE_KINDS = [
	"USER_APPROVED",
	"USER_APPROVED_FROM_SUGGESTION",
] as const;
export type BasicLivingConfigSourceKind =
	(typeof BASIC_LIVING_CONFIG_SOURCE_KINDS)[number];

export const budgetV2BasicLivingConfigRevisions = pgTable(
	"budget_v2_basic_living_config_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => budgetV2BasicLivingConfigRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE | UPDATE
		effectivePeriodMonth: date("effective_period_month", {
			mode: "string",
		}).notNull(),
		monthlyTargetAmount: numeric("monthly_target_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		currency: varchar("currency", { length: 3 }).notNull(),
		sourceKind: varchar("source_kind", { length: 32 }).notNull(),
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
		// Single-user app: one global append-only chain per user.
		uniqueIndex("bv2bl_user_rev_no_idx").on(table.userId, table.revisionNo),
		uniqueIndex("bv2bl_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("bv2bl_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("bv2bl_user_effective_idx").on(
			table.userId,
			table.effectivePeriodMonth,
		),
		check("bv2bl_rev_no_check", sql`${table.revisionNo} > 0`),
		check("bv2bl_op_check", sql`${table.operation} IN ('CREATE', 'UPDATE')`),
		check("bv2bl_target_check", sql`${table.monthlyTargetAmount} > 0`),
		check("bv2bl_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
		check(
			"bv2bl_effective_month_first_day_check",
			sql`EXTRACT(DAY FROM ${table.effectivePeriodMonth}) = 1`,
		),
		check(
			"bv2bl_source_kind_check",
			sql`${table.sourceKind} IN ('USER_APPROVED', 'USER_APPROVED_FROM_SUGGESTION')`,
		),
		check(
			"bv2bl_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"bv2bl_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);
