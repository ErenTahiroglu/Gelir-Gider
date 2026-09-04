import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	index,
	numeric,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { ledgerAccounts } from "./ledger";

export const MIDAS_BUCKET_TYPES = [
	"CREDIT_CARD_RESERVE",
	"SHORT_TERM_GOAL",
	"MEDIUM_TERM_RESERVE",
	"INCOME_BUFFER",
	"PENDING_LONG_TERM",
] as const;

export type MidasBucketType = (typeof MIDAS_BUCKET_TYPES)[number];

export const SINGLETON_BUCKET_TYPES: readonly MidasBucketType[] = [
	"MEDIUM_TERM_RESERVE",
	"INCOME_BUFFER",
	"PENDING_LONG_TERM",
] as const;

/**
 * Midas Accounts Table (Physical Liquidity Center Identity)
 * Maps 1-to-1 with an existing ASSET / DEBIT-normal ledger account for a user.
 * Contains NO mutable balance column; physical balance is strictly derived from posted ledger journal entries.
 * Rows are immutable once created.
 */
export const midasAccounts = pgTable(
	"midas_accounts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		ledgerAccountId: uuid("ledger_account_id")
			.notNull()
			.references(() => ledgerAccounts.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("midas_accounts_user_idx").on(table.userId),
		uniqueIndex("midas_accounts_ledger_account_idx").on(table.ledgerAccountId),
		index("midas_accounts_user_id_idx").on(table.userId),
	],
);

/**
 * Midas Buckets Table (Virtual Earmark Registry)
 * Virtual buckets dividing physical liquidity.
 * UNALLOCATED is derived and never stored as a bucket row.
 */
export const midasBuckets = pgTable(
	"midas_buckets",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		midasAccountId: uuid("midas_account_id")
			.notNull()
			.references(() => midasAccounts.id, { onDelete: "restrict" }),
		code: varchar("code", { length: 64 }).notNull(),
		name: varchar("name", { length: 120 }).notNull(),
		bucketType: varchar("bucket_type", { length: 30 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("midas_buckets_account_code_idx").on(
			table.midasAccountId,
			table.code,
		),
		uniqueIndex("midas_buckets_singleton_type_idx")
			.on(table.midasAccountId, table.bucketType)
			.where(
				sql`${table.bucketType} IN ('MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM')`,
			),
		index("midas_buckets_account_idx").on(table.midasAccountId),
		index("midas_buckets_user_idx").on(table.userId),
		check(
			"midas_buckets_type_check",
			sql`${table.bucketType} IN ('CREDIT_CARD_RESERVE', 'SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE', 'INCOME_BUFFER', 'PENDING_LONG_TERM')`,
		),
		check(
			"midas_buckets_code_check",
			sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
		),
		check(
			"midas_buckets_name_check",
			sql`length(trim(${table.name})) >= 1 AND length(${table.name}) <= 120`,
		),
	],
);

/**
 * Midas Allocation Transfers Table (Append-Only Virtual Allocation Ledger)
 * Tracks all movements between UNALLOCATED (NULL) and virtual buckets, or between buckets.
 * Rows are immutable. Corrections occur via exact compensating reversals.
 */
export const midasAllocationTransfers = pgTable(
	"midas_allocation_transfers",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		midasAccountId: uuid("midas_account_id")
			.notNull()
			.references(() => midasAccounts.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		transferFingerprint: varchar("transfer_fingerprint", {
			length: 64,
		}).notNull(),
		fromBucketId: uuid("from_bucket_id").references(
			(): AnyPgColumn => midasBuckets.id,
			{ onDelete: "restrict" },
		),
		toBucketId: uuid("to_bucket_id").references(
			(): AnyPgColumn => midasBuckets.id,
			{ onDelete: "restrict" },
		),
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		reversalOfTransferId: uuid("reversal_of_transfer_id").references(
			(): AnyPgColumn => midasAllocationTransfers.id,
			{ onDelete: "restrict" },
		),
		memo: varchar("memo", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("midas_transfers_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("midas_transfers_reversal_idx")
			.on(table.reversalOfTransferId)
			.where(sql`${table.reversalOfTransferId} IS NOT NULL`),
		index("midas_transfers_account_occurred_idx").on(
			table.midasAccountId,
			table.occurredAt,
		),
		index("midas_transfers_from_bucket_idx").on(table.fromBucketId),
		index("midas_transfers_to_bucket_idx").on(table.toBucketId),
		check("midas_transfers_amount_check", sql`${table.amount} > 0`),
		check(
			"midas_transfers_endpoints_check",
			sql`${table.fromBucketId} IS NOT NULL OR ${table.toBucketId} IS NOT NULL`,
		),
		check(
			"midas_transfers_distinct_buckets_check",
			sql`${table.fromBucketId} IS NULL OR ${table.toBucketId} IS NULL OR ${table.fromBucketId} != ${table.toBucketId}`,
		),
		check(
			"midas_transfers_fingerprint_check",
			sql`${table.transferFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"midas_transfers_idempotency_check",
			sql`length(trim(${table.idempotencyKey})) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
		check(
			"midas_transfers_memo_check",
			sql`${table.memo} IS NULL OR length(${table.memo}) <= 500`,
		),
	],
);
