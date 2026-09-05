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
import { creditCards } from "./credit-cards";
import { shortTermGoals } from "./short-term-goals";
import { canonicalTransactions, transactionRevisions } from "./transactions";

export const REWARD_ACCOUNT_OPERATIONS = [
	"CREATE",
	"UPDATE",
	"ARCHIVE",
] as const;
export type RewardAccountOperation = (typeof REWARD_ACCOUNT_OPERATIONS)[number];

export const REWARD_ACCOUNT_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type RewardAccountStatus = (typeof REWARD_ACCOUNT_STATUSES)[number];

export const REWARD_EVENT_TYPES = [
	"OPENING_BALANCE",
	"EARN",
	"EXPIRE",
	"ADJUSTMENT_CREDIT",
	"ADJUSTMENT_DEBIT",
	"REDEEM_PURCHASE",
] as const;
export type RewardEventType = (typeof REWARD_EVENT_TYPES)[number];

export const REWARD_EVENT_OPERATIONS = ["CREATE", "VOID"] as const;
export type RewardEventOperation = (typeof REWARD_EVENT_OPERATIONS)[number];

export const REWARD_PURCHASE_CATEGORIES = [
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
	"UNCLASSIFIED",
] as const;
export type RewardPurchaseCategory =
	(typeof REWARD_PURCHASE_CATEGORIES)[number];

export const REWARD_EVENT_SOURCE_TYPES = [
	"MANUAL",
	"CAMPAIGN",
	"IMPORT",
] as const;
export type RewardEventSourceType = (typeof REWARD_EVENT_SOURCE_TYPES)[number];

/**
 * Reward Accounts Table (Immutable Identity Anchor)
 * One row per user-defined loyalty/point wallet. code and creditCardId
 * association are immutable once created. Mutable config lives in
 * reward_account_revisions. creditCardId is optional association metadata
 * only -- reward wallet usability never depends on the card's ACTIVE status.
 */
export const rewardAccounts = pgTable(
	"reward_accounts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		code: varchar("code", { length: 32 }).notNull(),
		creditCardId: uuid("credit_card_id").references(() => creditCards.id, {
			onDelete: "restrict",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("reward_accounts_user_code_idx").on(table.userId, table.code),
		index("reward_accounts_user_idx").on(table.userId),
		index("reward_accounts_card_idx").on(table.creditCardId),
		check(
			"reward_accounts_code_check",
			sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,31}$'`,
		),
	],
);

/**
 * Reward Account Revisions Table (Append-Only Config Log)
 * Every configuration change or lifecycle event appends a new revision.
 */
export const rewardAccountRevisions = pgTable(
	"reward_account_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		rewardAccountId: uuid("reward_account_id")
			.notNull()
			.references(() => rewardAccounts.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => rewardAccountRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		status: varchar("status", { length: 20 }).notNull(),
		displayName: varchar("display_name", { length: 120 }).notNull(),
		provider: varchar("provider", { length: 120 }).notNull(),
		unitName: varchar("unit_name", { length: 40 }).notNull(),
		defaultConversionRate: numeric("default_conversion_rate", {
			precision: 18,
			scale: 6,
		}).notNull(),
		note: varchar("note", { length: 500 }),
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
		uniqueIndex("reward_account_revisions_account_rev_idx").on(
			table.rewardAccountId,
			table.revisionNo,
		),
		uniqueIndex("reward_account_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("reward_account_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("reward_account_revisions_account_idx").on(table.rewardAccountId),
		index("reward_account_revisions_user_idx").on(table.userId),
		check(
			"reward_account_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"reward_account_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'ARCHIVE')`,
		),
		check(
			"reward_account_revisions_status_check",
			sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`,
		),
		check(
			"reward_account_revisions_display_name_check",
			sql`${table.displayName} = btrim(${table.displayName}) AND length(${table.displayName}) >= 1 AND length(${table.displayName}) <= 120`,
		),
		check(
			"reward_account_revisions_provider_check",
			sql`${table.provider} = btrim(${table.provider}) AND length(${table.provider}) >= 1 AND length(${table.provider}) <= 120`,
		),
		check(
			"reward_account_revisions_unit_name_check",
			sql`${table.unitName} = btrim(${table.unitName}) AND length(${table.unitName}) >= 1 AND length(${table.unitName}) <= 40`,
		),
		check(
			"reward_account_revisions_rate_check",
			sql`${table.defaultConversionRate} > 0`,
		),
		check(
			"reward_account_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) >= 1 AND length(${table.note}) <= 500)`,
		),
		check(
			"reward_account_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"reward_account_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

/**
 * Reward Events Table (Immutable Identity Anchor)
 * Anchor for every point-affecting event. canonicalTransactionId is set
 * exactly once at INSERT (NOT NULL for REDEEM_PURCHASE, NULL otherwise --
 * enforced by a same-row CHECK constraint since it never changes afterward).
 */
export const rewardEvents = pgTable(
	"reward_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		rewardAccountId: uuid("reward_account_id")
			.notNull()
			.references(() => rewardAccounts.id, { onDelete: "restrict" }),
		eventType: varchar("event_type", { length: 32 }).notNull(),
		canonicalTransactionId: uuid("canonical_transaction_id").references(
			() => canonicalTransactions.id,
			{ onDelete: "restrict" },
		),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("reward_events_canonical_tx_idx")
			.on(table.canonicalTransactionId)
			.where(sql`${table.canonicalTransactionId} IS NOT NULL`),
		index("reward_events_account_idx").on(table.rewardAccountId),
		index("reward_events_user_idx").on(table.userId),
		check(
			"reward_events_type_check",
			sql`${table.eventType} IN ('OPENING_BALANCE', 'EARN', 'EXPIRE', 'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT', 'REDEEM_PURCHASE')`,
		),
		check(
			"reward_events_canonical_binding_check",
			sql`(${table.eventType} = 'REDEEM_PURCHASE' AND ${table.canonicalTransactionId} IS NOT NULL) OR (${table.eventType} != 'REDEEM_PURCHASE' AND ${table.canonicalTransactionId} IS NULL)`,
		),
	],
);

/**
 * Reward Event Revisions Table (Append-Only Log)
 * revision #1 is always CREATE; the only other permitted operation is a
 * single terminal VOID (no UPDATE in V1 -- a correction voids the old event
 * and creates a new one).
 */
export const rewardEventRevisions = pgTable(
	"reward_event_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		rewardEventId: uuid("reward_event_id")
			.notNull()
			.references(() => rewardEvents.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => rewardEventRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		pointAmount: numeric("point_amount", {
			precision: 20,
			scale: 4,
		}).notNull(),
		conversionRate: numeric("conversion_rate", {
			precision: 18,
			scale: 6,
		}).notNull(),
		economicAmount: numeric("economic_amount", { precision: 18, scale: 2 }),
		purchaseCategory: varchar("purchase_category", { length: 32 }),
		shortTermGoalId: uuid("short_term_goal_id").references(
			() => shortTermGoals.id,
			{ onDelete: "restrict" },
		),
		merchant: varchar("merchant", { length: 200 }),
		description: varchar("description", { length: 500 }),
		reasonNote: varchar("reason_note", { length: 500 }),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		canonicalRevisionId: uuid("canonical_revision_id").references(
			() => transactionRevisions.id,
			{ onDelete: "restrict" },
		),
		sourceType: varchar("source_type", { length: 20 })
			.notNull()
			.default("MANUAL"),
		sourceRef: varchar("source_ref", { length: 128 }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("reward_event_revisions_event_rev_idx").on(
			table.rewardEventId,
			table.revisionNo,
		),
		uniqueIndex("reward_event_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("reward_event_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("reward_event_revisions_event_idx").on(table.rewardEventId),
		index("reward_event_revisions_user_idx").on(table.userId),
		check("reward_event_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"reward_event_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'VOID')`,
		),
		check(
			"reward_event_revisions_point_amount_check",
			sql`${table.pointAmount} > 0`,
		),
		check(
			"reward_event_revisions_rate_check",
			sql`${table.conversionRate} > 0`,
		),
		check(
			"reward_event_revisions_economic_amount_check",
			sql`${table.economicAmount} IS NULL OR ${table.economicAmount} > 0`,
		),
		check(
			"reward_event_revisions_category_check",
			sql`${table.purchaseCategory} IS NULL OR ${table.purchaseCategory} IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED')`,
		),
		check(
			"reward_event_revisions_merchant_check",
			sql`${table.merchant} IS NULL OR (${table.merchant} = btrim(${table.merchant}) AND length(${table.merchant}) >= 1 AND length(${table.merchant}) <= 200)`,
		),
		check(
			"reward_event_revisions_description_check",
			sql`${table.description} IS NULL OR (${table.description} = btrim(${table.description}) AND length(${table.description}) >= 1 AND length(${table.description}) <= 500)`,
		),
		check(
			"reward_event_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) >= 1 AND length(${table.reasonNote}) <= 500)`,
		),
		check(
			"reward_event_revisions_source_type_check",
			sql`${table.sourceType} IN ('MANUAL', 'CAMPAIGN', 'IMPORT')`,
		),
		check(
			"reward_event_revisions_source_ref_check",
			sql`${table.sourceRef} IS NULL OR (${table.sourceRef} = btrim(${table.sourceRef}) AND length(${table.sourceRef}) >= 1 AND length(${table.sourceRef}) <= 128)`,
		),
		check(
			"reward_event_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"reward_event_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);
