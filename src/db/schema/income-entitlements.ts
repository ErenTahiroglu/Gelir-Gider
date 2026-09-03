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
import { incomeReceipts, incomeSources } from "./income";
import { canonicalTransactions, transactionRevisions } from "./transactions";

export interface SettlementAllocationItem {
	entitlementId: string;
	amount: string;
}

/**
 * Income Entitlements Table (Identity / Anchor)
 * Immutable once created. Tracks monthly expectation / earned entitlement identity.
 */
export const incomeEntitlements = pgTable(
	"income_entitlements",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		sourceId: uuid("source_id")
			.notNull()
			.references(() => incomeSources.id, { onDelete: "restrict" }),
		periodMonth: date("period_month").notNull(),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("income_entitlements_user_source_period_idx").on(
			table.userId,
			table.sourceId,
			table.periodMonth,
		),
		uniqueIndex("income_entitlements_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("income_entitlements_user_source_idx").on(
			table.userId,
			table.sourceId,
		),
		check(
			"income_entitlements_period_month_check",
			sql`EXTRACT(DAY FROM ${table.periodMonth}) = 1`,
		),
	],
);

/**
 * Income Entitlement Revisions Table (Append-Only)
 * Snapshots all changes, revisions, and void operations on entitlements.
 */
export const incomeEntitlementRevisions = pgTable(
	"income_entitlement_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		entitlementId: uuid("entitlement_id")
			.notNull()
			.references(() => incomeEntitlements.id, { onDelete: "restrict" }),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousEntitlementRevisionId: uuid(
			"previous_entitlement_revision_id",
		).references((): AnyPgColumn => incomeEntitlementRevisions.id, {
			onDelete: "restrict",
		}),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE, UPDATE, VOID
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		expectedReceiptOn: date("expected_receipt_on"),
		note: varchar("note", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("income_entitlement_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		uniqueIndex("income_entitlement_revisions_entitlement_rev_no_idx").on(
			table.entitlementId,
			table.revisionNo,
		),
		uniqueIndex("income_entitlement_revisions_prev_idx")
			.on(table.previousEntitlementRevisionId)
			.where(sql`${table.previousEntitlementRevisionId} IS NOT NULL`),
		index("income_entitlement_revisions_user_entitlement_idx").on(
			table.userId,
			table.entitlementId,
		),
		check(
			"income_entitlement_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"income_entitlement_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"income_entitlement_revisions_amount_check",
			sql`${table.amount} > 0`,
		),
		check(
			"income_entitlement_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) BETWEEN 1 AND 500)`,
		),
	],
);

/**
 * Income Settlement Batches Table (Identity / Anchor)
 * One settlement batch identity exists per income receipt.
 */
export const incomeSettlementBatches = pgTable(
	"income_settlement_batches",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		incomeReceiptId: uuid("income_receipt_id")
			.notNull()
			.references(() => incomeReceipts.id, { onDelete: "restrict" }),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("income_settlement_batches_receipt_idx").on(
			table.incomeReceiptId,
		),
		uniqueIndex("income_settlement_batches_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("income_settlement_batches_user_idx").on(table.userId),
	],
);

/**
 * Income Settlement Batch Revisions Table (Append-Only)
 * Snapshots the current allocation array of a receipt to one or more entitlements.
 */
export const incomeSettlementBatchRevisions = pgTable(
	"income_settlement_batch_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		settlementBatchId: uuid("settlement_batch_id")
			.notNull()
			.references(() => incomeSettlementBatches.id, { onDelete: "restrict" }),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousSettlementRevisionId: uuid(
			"previous_settlement_revision_id",
		).references((): AnyPgColumn => incomeSettlementBatchRevisions.id, {
			onDelete: "restrict",
		}),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE, UPDATE
		allocations: jsonb("allocations")
			.$type<SettlementAllocationItem[]>()
			.notNull(),
		note: varchar("note", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("income_settlement_batch_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		uniqueIndex("income_settlement_batch_revisions_batch_rev_no_idx").on(
			table.settlementBatchId,
			table.revisionNo,
		),
		uniqueIndex("income_settlement_batch_revisions_prev_idx")
			.on(table.previousSettlementRevisionId)
			.where(sql`${table.previousSettlementRevisionId} IS NOT NULL`),
		index("income_settlement_batch_revisions_user_batch_idx").on(
			table.userId,
			table.settlementBatchId,
		),
		check(
			"income_settlement_batch_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"income_settlement_batch_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE')`,
		),
		check(
			"income_settlement_batch_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) BETWEEN 1 AND 500)`,
		),
	],
);
