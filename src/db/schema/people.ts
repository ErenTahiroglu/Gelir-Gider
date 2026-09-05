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
import { incomeReceipts, incomeSources } from "./income";
import { ledgerAccounts } from "./ledger";
import { canonicalTransactions, transactionRevisions } from "./transactions";

export const PERSON_RELATIONSHIPS = ["FAMILY", "FRIEND", "OTHER"] as const;
export type PersonRelationship = (typeof PERSON_RELATIONSHIPS)[number];

export const PERSON_REVISION_OPERATIONS = [
	"CREATE",
	"UPDATE",
	"ARCHIVE",
] as const;
export type PersonRevisionOperation =
	(typeof PERSON_REVISION_OPERATIONS)[number];

export const PERSON_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const PERSON_OBLIGATION_DIRECTIONS = ["RECEIVABLE", "PAYABLE"] as const;
export type PersonObligationDirection =
	(typeof PERSON_OBLIGATION_DIRECTIONS)[number];

export const PERSON_OBLIGATION_REVISION_OPERATIONS = [
	"CREATE",
	"UPDATE",
	"VOID",
] as const;
export type PersonObligationRevisionOperation =
	(typeof PERSON_OBLIGATION_REVISION_OPERATIONS)[number];

export const PERSON_SETTLEMENT_REVISION_OPERATIONS = [
	"CREATE",
	"VOID",
] as const;
export type PersonSettlementRevisionOperation =
	(typeof PERSON_SETTLEMENT_REVISION_OPERATIONS)[number];

export const PEOPLE_SYSTEM_INCOME_ROLES = ["OVERPAYMENT_EXTRA"] as const;
export type PeopleSystemIncomeRole =
	(typeof PEOPLE_SYSTEM_INCOME_ROLES)[number];

/**
 * People Identity Table (Immutable Anchor)
 * App-local contact identity. No external phone/Google/Apple sync.
 */
export const people = pgTable(
	"people",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("people_user_idx").on(table.userId)],
);

/**
 * Person Revisions Table (Append-Only)
 * Captures identity/state lifecycle: CREATE, UPDATE, ARCHIVE.
 */
export const personRevisions = pgTable(
	"person_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => personRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		status: varchar("status", { length: 10 }).notNull(),
		displayName: varchar("display_name", { length: 120 }).notNull(),
		relationship: varchar("relationship", { length: 10 }).notNull(),
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
		uniqueIndex("person_revisions_person_rev_idx").on(
			table.personId,
			table.revisionNo,
		),
		uniqueIndex("person_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("person_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("person_revisions_person_idx").on(table.personId),
		index("person_revisions_user_idx").on(table.userId),
		check("person_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"person_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'ARCHIVE')`,
		),
		check(
			"person_revisions_status_check",
			sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`,
		),
		check(
			"person_revisions_status_op_check",
			sql`(${table.operation} = 'ARCHIVE' AND ${table.status} = 'ARCHIVED') OR (${table.operation} IN ('CREATE', 'UPDATE') AND ${table.status} = 'ACTIVE')`,
		),
		check(
			"person_revisions_display_name_check",
			sql`${table.displayName} = btrim(${table.displayName}) AND length(${table.displayName}) BETWEEN 1 AND 120`,
		),
		check(
			"person_revisions_relationship_check",
			sql`${table.relationship} IN ('FAMILY', 'FRIEND', 'OTHER')`,
		),
		check(
			"person_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) BETWEEN 1 AND 500)`,
		),
		check(
			"person_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"person_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);

/**
 * Person Ledger Links Table (Immutable 1:1 Mapping)
 * Binds every person to exactly one receivable (ASSET/DEBIT) and one payable (LIABILITY/CREDIT) account.
 */
export const personLedgerLinks = pgTable(
	"person_ledger_links",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "restrict" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		receivableAccountId: uuid("receivable_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		payableAccountId: uuid("payable_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("person_ledger_links_person_idx").on(table.personId),
		uniqueIndex("person_ledger_links_receivable_idx").on(
			table.receivableAccountId,
		),
		uniqueIndex("person_ledger_links_payable_idx").on(table.payableAccountId),
		index("person_ledger_links_user_idx").on(table.userId),
	],
);

/**
 * Person Obligations Table (Immutable Identity Anchor)
 * Anchor for standalone receivable advances and payable expenses. Direction is immutable.
 */
export const personObligations = pgTable(
	"person_obligations",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "restrict" }),
		direction: varchar("direction", { length: 10 }).notNull(),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("person_obligations_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("person_obligations_person_idx").on(table.personId),
		index("person_obligations_user_idx").on(table.userId),
		check(
			"person_obligations_direction_check",
			sql`${table.direction} IN ('RECEIVABLE', 'PAYABLE')`,
		),
	],
);

/**
 * Person Obligation Revisions Table (Append-Only)
 * Captures lifecycle state transitions (CREATE, UPDATE, VOID). No mutable remaining/settled cache.
 */
export const personObligationRevisions = pgTable(
	"person_obligation_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		obligationId: uuid("obligation_id")
			.notNull()
			.references(() => personObligations.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => personObligationRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		principalAmount: numeric("principal_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		fundingAssetAccountId: uuid("funding_asset_account_id").references(
			() => ledgerAccounts.id,
			{ onDelete: "restrict" },
		),
		budgetCategory: varchar("budget_category", { length: 32 }),
		dueDate: date("due_date", { mode: "string" }),
		description: varchar("description", { length: 500 }),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("person_obligation_revisions_obl_rev_idx").on(
			table.obligationId,
			table.revisionNo,
		),
		uniqueIndex("person_obligation_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("person_obligation_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("person_obligation_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		index("person_obligation_revisions_obl_idx").on(table.obligationId),
		index("person_obligation_revisions_user_idx").on(table.userId),
		index("person_obligation_revisions_due_date_idx").on(table.dueDate),
		check(
			"person_obligation_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"person_obligation_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"person_obligation_revisions_principal_check",
			sql`${table.principalAmount} > 0`,
		),
		check(
			"person_obligation_revisions_budget_category_check",
			sql`${table.budgetCategory} IS NULL OR ${table.budgetCategory} IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'UNCLASSIFIED')`,
		),
		check(
			"person_obligation_revisions_description_check",
			sql`${table.description} IS NULL OR (${table.description} = btrim(${table.description}) AND length(${table.description}) BETWEEN 1 AND 500)`,
		),
		check(
			"person_obligation_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"person_obligation_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);

/**
 * Person Settlements Table (Immutable Identity Anchor)
 * Anchor for a single settlement event against an obligation.
 */
export const personSettlements = pgTable(
	"person_settlements",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		obligationId: uuid("obligation_id")
			.notNull()
			.references(() => personObligations.id, { onDelete: "restrict" }),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("person_settlements_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("person_settlements_obl_idx").on(table.obligationId),
		index("person_settlements_user_idx").on(table.userId),
	],
);

/**
 * Person Settlement Revisions Table (Append-Only)
 * V1 lifecycle: CREATE, VOID only. No in-place UPDATE; corrections are VOID + CREATE.
 */
export const personSettlementRevisions = pgTable(
	"person_settlement_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		settlementId: uuid("settlement_id")
			.notNull()
			.references(() => personSettlements.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => personSettlementRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		assetAccountId: uuid("asset_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		cashAmount: numeric("cash_amount", { precision: 18, scale: 2 }).notNull(),
		appliedAmount: numeric("applied_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		excessAmount: numeric("excess_amount", { precision: 18, scale: 2 })
			.default("0.00")
			.notNull(),
		overpaymentIncomeReceiptId: uuid(
			"overpayment_income_receipt_id",
		).references(() => incomeReceipts.id, { onDelete: "restrict" }),
		note: varchar("note", { length: 500 }),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("person_settlement_revisions_settle_rev_idx").on(
			table.settlementId,
			table.revisionNo,
		),
		uniqueIndex("person_settlement_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("person_settlement_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("person_settlement_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		index("person_settlement_revisions_settle_idx").on(table.settlementId),
		index("person_settlement_revisions_user_idx").on(table.userId),
		check(
			"person_settlement_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"person_settlement_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'VOID')`,
		),
		check(
			"person_settlement_revisions_cash_check",
			sql`${table.cashAmount} > 0`,
		),
		check(
			"person_settlement_revisions_applied_check",
			sql`${table.appliedAmount} > 0 AND ${table.appliedAmount} <= ${table.cashAmount}`,
		),
		check(
			"person_settlement_revisions_excess_check",
			sql`${table.excessAmount} >= 0 AND ${table.excessAmount} = ${table.cashAmount} - ${table.appliedAmount}`,
		),
		check(
			"person_settlement_revisions_overpayment_link_check",
			sql`(${table.excessAmount} = 0 AND ${table.overpaymentIncomeReceiptId} IS NULL) OR (${table.excessAmount} > 0 AND ${table.overpaymentIncomeReceiptId} IS NOT NULL)`,
		),
		check(
			"person_settlement_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) BETWEEN 1 AND 500)`,
		),
		check(
			"person_settlement_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"person_settlement_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);

/**
 * People System Income Links Table (Immutable Mapping)
 * Binds a system-provisioned income source (e.g. overpayment excess) to its People domain role.
 */
export const peopleSystemIncomeLinks = pgTable(
	"people_system_income_links",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		role: varchar("role", { length: 32 }).notNull(),
		incomeSourceId: uuid("income_source_id")
			.notNull()
			.references(() => incomeSources.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("people_system_income_links_user_role_idx").on(
			table.userId,
			table.role,
		),
		uniqueIndex("people_system_income_links_source_idx").on(
			table.incomeSourceId,
		),
		check(
			"people_system_income_links_role_check",
			sql`${table.role} IN ('OVERPAYMENT_EXTRA')`,
		),
	],
);
