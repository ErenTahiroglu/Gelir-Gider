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

export const ledgerAccounts = pgTable(
	"ledger_accounts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		code: varchar("code", { length: 64 }).notNull(),
		name: varchar("name", { length: 100 }).notNull(),
		accountType: varchar("account_type", { length: 20 }).notNull(),
		normalBalance: varchar("normal_balance", { length: 10 }).notNull(),
		currency: varchar("currency", { length: 3 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		archivedAt: timestamp("archived_at", {
			withTimezone: true,
			mode: "date",
		}),
	},
	(table) => [
		uniqueIndex("ledger_accounts_user_code_idx").on(table.userId, table.code),
		index("ledger_accounts_user_id_idx").on(table.userId),
		check(
			"ledger_accounts_type_check",
			sql`${table.accountType} IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')`,
		),
		check(
			"ledger_accounts_normal_balance_check",
			sql`(${table.accountType} IN ('ASSET', 'EXPENSE') AND ${table.normalBalance} = 'DEBIT') OR (${table.accountType} IN ('LIABILITY', 'EQUITY', 'INCOME') AND ${table.normalBalance} = 'CREDIT')`,
		),
		check(
			"ledger_accounts_code_check",
			sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
		),
		check(
			"ledger_accounts_name_check",
			sql`length(trim(${table.name})) >= 1 AND length(${table.name}) <= 100`,
		),
		check(
			"ledger_accounts_currency_check",
			sql`${table.currency} ~ '^[A-Z]{3}$'`,
		),
	],
);

export const journalEntries = pgTable(
	"journal_entries",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		postingFingerprint: varchar("posting_fingerprint", {
			length: 64,
		}).notNull(),
		currency: varchar("currency", { length: 3 }).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		status: varchar("status", { length: 10 }).default("DRAFT").notNull(),
		postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
		reversalOfEntryId: uuid("reversal_of_entry_id").references(
			(): AnyPgColumn => journalEntries.id,
			{ onDelete: "restrict" },
		),
		memo: varchar("memo", { length: 500 }),
		sourceType: varchar("source_type", { length: 64 }),
		sourceRef: varchar("source_ref", { length: 128 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("journal_entries_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("journal_entries_reversal_of_entry_idx")
			.on(table.reversalOfEntryId)
			.where(sql`${table.reversalOfEntryId} IS NOT NULL`),
		index("journal_entries_user_occurred_idx").on(
			table.userId,
			table.occurredAt,
		),
		check(
			"journal_entries_status_check",
			sql`${table.status} IN ('DRAFT', 'POSTED')`,
		),
		check(
			"journal_entries_posted_at_check",
			sql`(${table.status} = 'DRAFT' AND ${table.postedAt} IS NULL) OR (${table.status} = 'POSTED' AND ${table.postedAt} IS NOT NULL)`,
		),
		check(
			"journal_entries_currency_check",
			sql`${table.currency} ~ '^[A-Z]{3}$'`,
		),
		check(
			"journal_entries_fingerprint_check",
			sql`${table.postingFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"journal_entries_idempotency_check",
			sql`length(trim(${table.idempotencyKey})) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
		check(
			"journal_entries_source_check",
			sql`(${table.sourceType} IS NULL AND ${table.sourceRef} IS NULL) OR (${table.sourceType} IS NOT NULL AND ${table.sourceRef} IS NOT NULL)`,
		),
		check(
			"journal_entries_memo_check",
			sql`${table.memo} IS NULL OR length(${table.memo}) <= 500`,
		),
	],
);

export const journalLines = pgTable(
	"journal_lines",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		journalEntryId: uuid("journal_entry_id")
			.notNull()
			.references(() => journalEntries.id, { onDelete: "restrict" }),
		lineNo: integer("line_no").notNull(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		debit: numeric("debit", { precision: 18, scale: 2 })
			.default("0.00")
			.notNull(),
		credit: numeric("credit", { precision: 18, scale: 2 })
			.default("0.00")
			.notNull(),
		memo: varchar("memo", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("journal_lines_entry_line_idx").on(
			table.journalEntryId,
			table.lineNo,
		),
		index("journal_lines_account_idx").on(table.accountId),
		index("journal_lines_journal_entry_idx").on(table.journalEntryId),
		check("journal_lines_line_no_check", sql`${table.lineNo} > 0`),
		check("journal_lines_debit_check", sql`${table.debit} >= 0`),
		check("journal_lines_credit_check", sql`${table.credit} >= 0`),
		check(
			"journal_lines_single_sided_check",
			sql`(${table.debit} > 0 AND ${table.credit} = 0) OR (${table.credit} > 0 AND ${table.debit} = 0)`,
		),
		check(
			"journal_lines_memo_check",
			sql`${table.memo} IS NULL OR length(${table.memo}) <= 500`,
		),
	],
);
