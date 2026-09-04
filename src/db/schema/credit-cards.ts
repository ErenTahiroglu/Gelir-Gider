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
import { midasAccounts, midasBuckets } from "./midas";

export const CREDIT_CARD_OPERATIONS = ["CREATE", "UPDATE", "ARCHIVE"] as const;
export type CreditCardOperation = (typeof CREDIT_CARD_OPERATIONS)[number];

export const CREDIT_CARD_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CreditCardStatus = (typeof CREDIT_CARD_STATUSES)[number];

export const CREDIT_CARD_STATEMENT_OPERATIONS = [
	"CREATE",
	"UPDATE",
	"VOID",
] as const;
export type CreditCardStatementOperation =
	(typeof CREDIT_CARD_STATEMENT_OPERATIONS)[number];

export const CREDIT_CARD_STATEMENT_STATUSES = ["OPEN", "VOID"] as const;
export type CreditCardStatementStatus =
	(typeof CREDIT_CARD_STATEMENT_STATUSES)[number];

export const CREDIT_CARD_RESERVE_PLACEMENTS = [
	"MIDAS_FUND",
	"OUTSIDE_MIDAS",
] as const;
export type CreditCardReservePlacement =
	(typeof CREDIT_CARD_RESERVE_PLACEMENTS)[number];

/**
 * Credit Cards Table (Immutable Identity Anchor)
 * One row per user-defined card. Rows are immutable once created.
 * Mutable card config lives in credit_card_revisions.
 */
export const creditCards = pgTable(
	"credit_cards",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		code: varchar("code", { length: 32 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("credit_cards_user_code_idx").on(table.userId, table.code),
		index("credit_cards_user_idx").on(table.userId),
		check(
			"credit_cards_code_check",
			sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,31}$'`,
		),
	],
);

/**
 * Credit Card Revisions Table (Append-Only Config Log)
 * Every configuration change or lifecycle event appends a new revision.
 */
export const creditCardRevisions = pgTable(
	"credit_card_revisions",
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
			(): AnyPgColumn => creditCardRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		status: varchar("status", { length: 20 }).notNull(),
		displayName: varchar("display_name", { length: 120 }).notNull(),
		issuer: varchar("issuer", { length: 120 }).notNull(),
		statementDay: integer("statement_day").notNull(),
		dueDay: integer("due_day").notNull(),
		creditLimit: numeric("credit_limit", {
			precision: 18,
			scale: 2,
		}).notNull(),
		lastFour: varchar("last_four", { length: 4 }),
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
		uniqueIndex("cc_revisions_card_rev_idx").on(
			table.creditCardId,
			table.revisionNo,
		),
		uniqueIndex("cc_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("cc_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("cc_revisions_card_idx").on(table.creditCardId),
		index("cc_revisions_user_idx").on(table.userId),
		check("cc_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"cc_revisions_operation_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'ARCHIVE')`,
		),
		check(
			"cc_revisions_status_check",
			sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`,
		),
		check(
			"cc_revisions_display_name_check",
			sql`${table.displayName} = btrim(${table.displayName}) AND length(${table.displayName}) >= 1 AND length(${table.displayName}) <= 120`,
		),
		check(
			"cc_revisions_issuer_check",
			sql`${table.issuer} = btrim(${table.issuer}) AND length(${table.issuer}) >= 1 AND length(${table.issuer}) <= 120`,
		),
		check(
			"cc_revisions_statement_day_check",
			sql`${table.statementDay} >= 1 AND ${table.statementDay} <= 31`,
		),
		check(
			"cc_revisions_due_day_check",
			sql`${table.dueDay} >= 1 AND ${table.dueDay} <= 31`,
		),
		check("cc_revisions_credit_limit_check", sql`${table.creditLimit} > 0`),
		check(
			"cc_revisions_last_four_check",
			sql`${table.lastFour} IS NULL OR (${table.lastFour} ~ '^[0-9]{4}$')`,
		),
		check(
			"cc_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) >= 1 AND length(${table.note}) <= 500)`,
		),
		check(
			"cc_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"cc_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

/**
 * Credit Card Statements Table (Immutable Statement Identity Anchor)
 * One row per statement cycle (card + YYYY-MM). Immutable once created.
 * Gets a dedicated CREDIT_CARD_RESERVE Midas bucket at creation.
 */
export const creditCardStatements = pgTable(
	"credit_card_statements",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		midasAccountId: uuid("midas_account_id")
			.notNull()
			.references(() => midasAccounts.id, { onDelete: "restrict" }),
		midasReserveBucketId: uuid("midas_reserve_bucket_id")
			.notNull()
			.references(() => midasBuckets.id, { onDelete: "restrict" }),
		cycleYear: integer("cycle_year").notNull(),
		cycleMonth: integer("cycle_month").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("cc_statements_card_cycle_idx").on(
			table.creditCardId,
			table.cycleYear,
			table.cycleMonth,
		),
		uniqueIndex("cc_statements_reserve_bucket_idx").on(
			table.midasReserveBucketId,
		),
		index("cc_statements_card_idx").on(table.creditCardId),
		index("cc_statements_user_idx").on(table.userId),
		index("cc_statements_midas_account_idx").on(table.midasAccountId),
		check(
			"cc_statements_cycle_year_check",
			sql`${table.cycleYear} >= 2000 AND ${table.cycleYear} <= 2200`,
		),
		check(
			"cc_statements_cycle_month_check",
			sql`${table.cycleMonth} >= 1 AND ${table.cycleMonth} <= 12`,
		),
	],
);

/**
 * Credit Card Statement Revisions Table (Append-Only)
 * Captures all state changes for a statement obligation.
 */
export const creditCardStatementRevisions = pgTable(
	"credit_card_statement_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		statementId: uuid("statement_id")
			.notNull()
			.references(() => creditCardStatements.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => creditCardStatementRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		status: varchar("status", { length: 20 }).notNull(),
		statementAmount: numeric("statement_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		statementDate: date("statement_date").notNull(),
		dueDate: date("due_date").notNull(),
		reservePlacement: varchar("reserve_placement", { length: 20 }).notNull(),
		note: varchar("note", { length: 500 }),
		reasonNote: varchar("reason_note", { length: 500 }),
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
		uniqueIndex("cc_stmt_revisions_stmt_rev_idx").on(
			table.statementId,
			table.revisionNo,
		),
		uniqueIndex("cc_stmt_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("cc_stmt_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("cc_stmt_revisions_stmt_idx").on(table.statementId),
		index("cc_stmt_revisions_user_idx").on(table.userId),
		check("cc_stmt_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"cc_stmt_revisions_operation_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"cc_stmt_revisions_status_check",
			sql`${table.status} IN ('OPEN', 'VOID')`,
		),
		check(
			"cc_stmt_revisions_amount_check",
			sql`${table.statementAmount} > 0`,
		),
		check(
			"cc_stmt_revisions_placement_check",
			sql`${table.reservePlacement} IN ('MIDAS_FUND', 'OUTSIDE_MIDAS')`,
		),
		check(
			"cc_stmt_revisions_due_after_statement_check",
			sql`${table.dueDate} > ${table.statementDate}`,
		),
		check(
			"cc_stmt_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) >= 1 AND length(${table.note}) <= 500)`,
		),
		check(
			"cc_stmt_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) >= 1 AND length(${table.reasonNote}) <= 500)`,
		),
		check(
			"cc_stmt_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"cc_stmt_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);
