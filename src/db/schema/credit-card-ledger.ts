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
import { creditCardStatements, creditCards } from "./credit-cards";
import { ledgerAccounts } from "./ledger";
import { canonicalTransactions, transactionRevisions } from "./transactions";

export const CREDIT_CARD_SYSTEM_ACCOUNT_ROLES = [
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_EXPENSE",
	"SHORT_TERM_PURCHASE",
	"UNCLASSIFIED_EXPENSE",
	"OPENING_EQUITY",
] as const;
export type CreditCardSystemAccountRole =
	(typeof CREDIT_CARD_SYSTEM_ACCOUNT_ROLES)[number];

export const CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES = [
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
	"UNCLASSIFIED",
] as const;
export type CreditCardPurchaseBudgetCategory =
	(typeof CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES)[number];

export const CREDIT_CARD_LIABILITY_EVENT_TYPES = [
	"PURCHASE",
	"OPENING_BALANCE",
] as const;
export type CreditCardLiabilityEventType =
	(typeof CREDIT_CARD_LIABILITY_EVENT_TYPES)[number];

export const CREDIT_CARD_LIABILITY_EVENT_OPERATIONS = [
	"CREATE",
	"UPDATE",
	"VOID",
] as const;
export type CreditCardLiabilityEventOperation =
	(typeof CREDIT_CARD_LIABILITY_EVENT_OPERATIONS)[number];

/**
 * Maps a purchase budget category to its designated system ledger account role.
 */
export function mapPurchaseCategoryToSystemRole(
	category: CreditCardPurchaseBudgetCategory,
): CreditCardSystemAccountRole {
	switch (category) {
		case "MANDATORY_EXPENSE":
			return "MANDATORY_EXPENSE";
		case "DISCRETIONARY_SPEND":
			return "DISCRETIONARY_EXPENSE";
		case "SHORT_TERM_PURCHASE":
			return "SHORT_TERM_PURCHASE";
		case "UNCLASSIFIED":
			return "UNCLASSIFIED_EXPENSE";
		default:
			throw new Error(
				`Unknown credit card purchase budget category: ${category}`,
			);
	}
}

/**
 * Credit Card Ledger Links Table (Immutable 1:1 Mapping)
 * Binds every credit card to exactly one liability ledger account.
 */
export const creditCardLedgerLinks = pgTable(
	"credit_card_ledger_links",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		liabilityAccountId: uuid("ledger_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("cc_ledger_links_card_idx").on(table.creditCardId),
		uniqueIndex("cc_ledger_links_account_idx").on(table.liabilityAccountId),
		index("cc_ledger_links_user_idx").on(table.userId),
	],
);

/**
 * Credit Card System Accounts Table (Immutable Mapping)
 * Defines system-level expense and equity ledger accounts per user.
 */
export const creditCardSystemAccounts = pgTable(
	"credit_card_system_accounts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		role: varchar("role", { length: 32 }).notNull(),
		ledgerAccountId: uuid("ledger_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("cc_system_accounts_user_role_idx").on(
			table.userId,
			table.role,
		),
		uniqueIndex("cc_system_accounts_account_idx").on(table.ledgerAccountId),
		index("cc_system_accounts_user_idx").on(table.userId),
		check(
			"cc_system_accounts_role_check",
			sql`${table.role} IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_EXPENSE', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED_EXPENSE', 'OPENING_EQUITY')`,
		),
	],
);

/**
 * Credit Card Liability Events Table (Immutable Identity Anchor)
 * Anchor for purchases and opening balance events.
 */
export const creditCardLiabilityEvents = pgTable(
	"credit_card_liability_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		eventType: varchar("event_type", { length: 32 }).notNull(),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("cc_liability_events_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		uniqueIndex("cc_liability_events_card_opening_idx")
			.on(table.creditCardId)
			.where(sql`${table.eventType} = 'OPENING_BALANCE'`),
		index("cc_liability_events_card_idx").on(table.creditCardId),
		index("cc_liability_events_user_idx").on(table.userId),
		check(
			"cc_liability_events_type_check",
			sql`${table.eventType} IN ('PURCHASE', 'OPENING_BALANCE')`,
		),
	],
);

/**
 * Credit Card Liability Event Revisions Table (Append-Only Log)
 * Captures lifecycle state transitions (CREATE, UPDATE, VOID) for purchases and opening balances.
 */
export const creditCardLiabilityEventRevisions = pgTable(
	"credit_card_liability_event_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		eventId: uuid("event_id")
			.notNull()
			.references(() => creditCardLiabilityEvents.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => creditCardLiabilityEventRevisions.id,
			{ onDelete: "restrict" },
		),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		operation: varchar("operation", { length: 20 }).notNull(),
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		budgetCategory: varchar("budget_category", { length: 32 }),
		merchant: varchar("merchant", { length: 200 }),
		description: varchar("description", { length: 500 }),
		installmentCount: integer("installment_count"),
		purchaseDate: date("purchase_date"),
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
		uniqueIndex("cc_liability_event_revisions_event_rev_idx").on(
			table.eventId,
			table.revisionNo,
		),
		uniqueIndex("cc_liability_event_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("cc_liability_event_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("cc_liability_event_revisions_event_idx").on(table.eventId),
		index("cc_liability_event_revisions_user_idx").on(table.userId),
		index("cc_liability_event_revisions_purchase_date_idx").on(
			table.purchaseDate,
		),
		check(
			"cc_liability_event_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"cc_liability_event_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"cc_liability_event_revisions_amount_check",
			sql`${table.amount} > 0`,
		),
		check(
			"cc_liability_event_revisions_category_check",
			sql`${table.budgetCategory} IS NULL OR ${table.budgetCategory} IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED')`,
		),
		check(
			"cc_liability_event_revisions_installment_check",
			sql`${table.installmentCount} IS NULL OR (${table.installmentCount} >= 1 AND ${table.installmentCount} <= 60)`,
		),
		check(
			"cc_liability_event_revisions_merchant_check",
			sql`${table.merchant} IS NULL OR (${table.merchant} = btrim(${table.merchant}) AND length(${table.merchant}) >= 1 AND length(${table.merchant}) <= 200)`,
		),
		check(
			"cc_liability_event_revisions_description_check",
			sql`${table.description} IS NULL OR (${table.description} = btrim(${table.description}) AND length(${table.description}) >= 1 AND length(${table.description}) <= 500)`,
		),
		check(
			"cc_liability_event_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"cc_liability_event_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

/**
 * Credit Card Statement Payment Events Table (Immutable Identity Anchor)
 * Records individual statement payment attempts linked 1:1 with canonical payment transactions.
 */
export const creditCardStatementPaymentEvents = pgTable(
	"credit_card_statement_payment_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		statementId: uuid("statement_id")
			.notNull()
			.references(() => creditCardStatements.id, { onDelete: "restrict" }),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		paymentAssetAccountId: uuid("payment_asset_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("cc_stmt_payment_events_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("cc_stmt_payment_events_stmt_idx").on(table.statementId),
		index("cc_stmt_payment_events_user_idx").on(table.userId),
		index("cc_stmt_payment_events_asset_account_idx").on(
			table.paymentAssetAccountId,
		),
		check("cc_stmt_payment_events_amount_check", sql`${table.amount} > 0`),
	],
);
