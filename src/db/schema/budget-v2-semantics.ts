import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	index,
	integer,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { incomeReceipts } from "./income";
import { shortTermGoals } from "./short-term-goals";

/**
 * PERSONAL_BUDGET_V2 SEMANTIC CLASSIFICATIONS
 *
 * Additive, append-only metadata projections that make the future Budget V2
 * live-source resolver trustworthy. They carry NO financial amounts and are
 * NOT economic events -- no canonical transaction, no ledger posting, no
 * Midas movement. The base `income_receipts` / `short_term_goals` rows remain
 * the identity anchors; no historical revision rows are rewritten.
 *
 * The event-intent distinction for family support lives at the RECEIPT level
 * (a single SUPPORT source can legitimately produce different intents over
 * time). It is never inferred from source name/code or by splitting sources.
 */

export const SUPPORT_RECEIPT_ROLES = [
	"PLANNED_FAMILY_GIFT",
	"DEFICIT_FAMILY_SUPPORT",
] as const;
export type SupportReceiptRole = (typeof SUPPORT_RECEIPT_ROLES)[number];

export const STG_BUDGET_V2_PURPOSES = [
	"INTERNATIONAL_MOBILITY",
	"DATE_BOUND_NECESSARY_PURCHASE",
	"PLANNED_DISCRETIONARY",
	"OTHER",
] as const;
export type StgBudgetV2Purpose = (typeof STG_BUDGET_V2_PURPOSES)[number];

export const BUDGET_V2_SEMANTIC_OPERATIONS = ["CREATE", "UPDATE"] as const;
export type BudgetV2SemanticOperation =
	(typeof BUDGET_V2_SEMANTIC_OPERATIONS)[number];

/**
 * Append-only Budget V2 support-role classification for a SUPPORT income
 * receipt. Revision #1 is CREATE; every later revision is a reclassification
 * UPDATE. The DB guard (migration 0063) enforces that the receipt belongs to
 * the user AND its income source nature is exactly SUPPORT.
 */
export const incomeReceiptBudgetV2SemanticRevisions = pgTable(
	"income_receipt_budget_v2_semantic_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		incomeReceiptId: uuid("income_receipt_id")
			.notNull()
			.references(() => incomeReceipts.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => incomeReceiptBudgetV2SemanticRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE | UPDATE
		supportRole: varchar("support_role", { length: 32 }).notNull(),
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
		uniqueIndex("irbv2sem_receipt_rev_no_idx").on(
			table.incomeReceiptId,
			table.revisionNo,
		),
		uniqueIndex("irbv2sem_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("irbv2sem_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("irbv2sem_user_receipt_idx").on(table.userId, table.incomeReceiptId),
		check("irbv2sem_rev_no_check", sql`${table.revisionNo} > 0`),
		check("irbv2sem_op_check", sql`${table.operation} IN ('CREATE', 'UPDATE')`),
		check(
			"irbv2sem_role_check",
			sql`${table.supportRole} IN ('PLANNED_FAMILY_GIFT', 'DEFICIT_FAMILY_SUPPORT')`,
		),
		check(
			"irbv2sem_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"irbv2sem_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);

/**
 * Append-only Budget V2 policy-purpose classification for a short-term goal.
 * Not singleton on INTERNATIONAL_MOBILITY: the resolver aggregates every
 * ACTIVE goal explicitly classified INTERNATIONAL_MOBILITY.
 */
export const shortTermGoalBudgetV2PurposeRevisions = pgTable(
	"short_term_goal_budget_v2_purpose_revisions",
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
			(): AnyPgColumn => shortTermGoalBudgetV2PurposeRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE | UPDATE
		purpose: varchar("purpose", { length: 40 }).notNull(),
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
		uniqueIndex("stgbv2purpose_goal_rev_no_idx").on(
			table.goalId,
			table.revisionNo,
		),
		uniqueIndex("stgbv2purpose_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("stgbv2purpose_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("stgbv2purpose_user_goal_idx").on(table.userId, table.goalId),
		check("stgbv2purpose_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"stgbv2purpose_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE')`,
		),
		check(
			"stgbv2purpose_purpose_check",
			sql`${table.purpose} IN ('INTERNATIONAL_MOBILITY', 'DATE_BOUND_NECESSARY_PURCHASE', 'PLANNED_DISCRETIONARY', 'OTHER')`,
		),
		check(
			"stgbv2purpose_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"stgbv2purpose_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);
