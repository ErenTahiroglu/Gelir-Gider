import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const canonicalTransactions = pgTable(
	"canonical_transactions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		kind: varchar("kind", { length: 64 }).notNull(),
		creationIdempotencyKey: varchar("creation_idempotency_key", {
			length: 128,
		}).notNull(),
		creationFingerprint: varchar("creation_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("canonical_transactions_user_idempotency_idx").on(
			table.userId,
			table.creationIdempotencyKey,
		),
		index("canonical_transactions_user_created_idx").on(
			table.userId,
			table.createdAt,
		),
		check(
			"canonical_transactions_kind_check",
			sql`${table.kind} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
		),
		check(
			"canonical_transactions_idempotency_check",
			sql`${table.creationIdempotencyKey} = btrim(${table.creationIdempotencyKey}) AND length(${table.creationIdempotencyKey}) BETWEEN 1 AND 128`,
		),
		check(
			"canonical_transactions_fingerprint_check",
			sql`${table.creationFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

export const transactionRevisions = pgTable(
	"transaction_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => transactionRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		payload: jsonb("payload").notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		reasonCode: varchar("reason_code", { length: 64 }),
		reasonNote: varchar("reason_note", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("transaction_revisions_tx_rev_idx").on(
			table.transactionId,
			table.revisionNo,
		),
		uniqueIndex("transaction_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("transaction_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("transaction_revisions_tx_created_idx").on(
			table.transactionId,
			table.createdAt,
		),
		index("transaction_revisions_user_occurred_idx").on(
			table.userId,
			table.occurredAt,
		),
		check("transaction_revisions_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"transaction_revisions_operation_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"transaction_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"transaction_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
		check(
			"transaction_revisions_reason_code_check",
			sql`${table.reasonCode} IS NULL OR ${table.reasonCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
		),
		check(
			"transaction_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) BETWEEN 1 AND 500)`,
		),
		check(
			"transaction_revisions_payload_size_check",
			sql`octet_length(${table.payload}::text) <= 65536`,
		),
	],
);

export const transactionSources = pgTable(
	"transaction_sources",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		revisionId: uuid("revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		sourceType: varchar("source_type", { length: 64 }).notNull(),
		sourceRef: varchar("source_ref", { length: 256 }),
		sourcePayloadHash: varchar("source_payload_hash", { length: 64 }),
		observedAt: timestamp("observed_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("transaction_sources_user_type_ref_idx")
			.on(table.userId, table.sourceType, table.sourceRef)
			.where(sql`${table.sourceRef} IS NOT NULL`),
		index("transaction_sources_tx_idx").on(table.transactionId),
		index("transaction_sources_rev_idx").on(table.revisionId),
		check(
			"transaction_sources_type_check",
			sql`${table.sourceType} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
		),
		check(
			"transaction_sources_ref_check",
			sql`${table.sourceRef} IS NULL OR (${table.sourceRef} = btrim(${table.sourceRef}) AND length(${table.sourceRef}) BETWEEN 1 AND 256)`,
		),
		check(
			"transaction_sources_hash_check",
			sql`${table.sourcePayloadHash} IS NULL OR ${table.sourcePayloadHash} ~ '^[0-9a-f]{64}$'`,
		),
	],
);
