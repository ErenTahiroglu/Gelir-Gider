import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	date,
	index,
	integer,
	numeric,
	pgTable,
	smallint,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { ledgerAccounts } from "./ledger";
import { canonicalTransactions, transactionRevisions } from "./transactions";

export const incomeSources = pgTable(
	"income_sources",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		code: varchar("code", { length: 64 }).notNull(),
		name: varchar("name", { length: 120 }).notNull(),
		nature: varchar("nature", { length: 16 }).notNull(),
		referenceMethod: varchar("reference_method", { length: 32 }).notNull(),
		expectedMonthlyAmount: numeric("expected_monthly_amount", {
			precision: 18,
			scale: 2,
		}),
		seasonalMonthsPerYear: smallint("seasonal_months_per_year"),
		rollingMedianMonths: smallint("rolling_median_months"),
		incomeLedgerAccountId: uuid("income_ledger_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		activeFrom: date("active_from", { mode: "string" }).notNull(),
		activeUntil: date("active_until", { mode: "string" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		uniqueIndex("income_sources_user_code_idx").on(table.userId, table.code),
		index("income_sources_user_active_idx").on(
			table.userId,
			table.activeFrom,
			table.activeUntil,
		),
		check(
			"income_sources_code_check",
			sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
		),
		check(
			"income_sources_name_check",
			sql`${table.name} = btrim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 120`,
		),
		check(
			"income_sources_nature_check",
			sql`${table.nature} IN ('REGULAR', 'EXTRA', 'SUPPORT')`,
		),
		check(
			"income_sources_reference_method_check",
			sql`${table.referenceMethod} IN ('FIXED_MONTHLY', 'SEASONAL_ANNUALIZED', 'ROLLING_MEDIAN', 'EXCLUDED')`,
		),
		check(
			"income_sources_nature_method_consistency_check",
			sql`(${table.nature} IN ('EXTRA', 'SUPPORT') AND ${table.referenceMethod} = 'EXCLUDED') OR (${table.nature} = 'REGULAR')`,
		),
		check(
			"income_sources_method_params_check",
			sql`
				(${table.referenceMethod} = 'FIXED_MONTHLY' AND ${table.expectedMonthlyAmount} > 0 AND ${table.seasonalMonthsPerYear} IS NULL AND ${table.rollingMedianMonths} IS NULL) OR
				(${table.referenceMethod} = 'SEASONAL_ANNUALIZED' AND ${table.expectedMonthlyAmount} > 0 AND ${table.seasonalMonthsPerYear} BETWEEN 1 AND 12 AND ${table.rollingMedianMonths} IS NULL) OR
				(${table.referenceMethod} = 'ROLLING_MEDIAN' AND ${table.rollingMedianMonths} BETWEEN 1 AND 24 AND ${table.seasonalMonthsPerYear} IS NULL) OR
				(${table.referenceMethod} = 'EXCLUDED' AND ${table.seasonalMonthsPerYear} IS NULL AND ${table.rollingMedianMonths} IS NULL)
			`,
		),
		check(
			"income_sources_active_window_check",
			sql`${table.activeUntil} IS NULL OR ${table.activeUntil} >= ${table.activeFrom}`,
		),
	],
);

export const incomeReceipts = pgTable(
	"income_receipts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		sourceId: uuid("source_id")
			.notNull()
			.references(() => incomeSources.id, { onDelete: "restrict" }),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("income_receipts_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("income_receipts_user_source_idx").on(table.userId, table.sourceId),
	],
);

export const incomeReceiptRevisions = pgTable(
	"income_receipt_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		incomeReceiptId: uuid("income_receipt_id")
			.notNull()
			.references(() => incomeReceipts.id, { onDelete: "restrict" }),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousReceiptRevisionId: uuid("previous_receipt_revision_id").references(
			(): AnyPgColumn => incomeReceiptRevisions.id,
			{
				onDelete: "restrict",
			},
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		destinationAccountId: uuid("destination_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		note: varchar("note", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("income_receipt_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		uniqueIndex("income_receipt_revisions_receipt_rev_no_idx").on(
			table.incomeReceiptId,
			table.revisionNo,
		),
		uniqueIndex("income_receipt_revisions_prev_idx")
			.on(table.previousReceiptRevisionId)
			.where(sql`${table.previousReceiptRevisionId} IS NOT NULL`),
		index("income_receipt_revisions_user_receipt_idx").on(
			table.userId,
			table.incomeReceiptId,
		),
		check(
			"income_receipt_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"income_receipt_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check("income_receipt_revisions_amount_check", sql`${table.amount} > 0`),
		check(
			"income_receipt_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) BETWEEN 1 AND 500)`,
		),
	],
);
