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
import { canonicalTransactions } from "./transactions";

// ============================================================================
// Enums / Domain Constants
// ============================================================================

export const IMPORT_SOURCE_KINDS = [
	"NORMALIZED_ROWS",
	"GENERIC_CSV_V1",
] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KINDS)[number];

export const IMPORT_RECORD_TYPES = [
	"CREDIT_CARD_PURCHASE",
	"INCOME_RECEIPT",
	"UNSUPPORTED",
] as const;
export type ImportRecordType = (typeof IMPORT_RECORD_TYPES)[number];

export const IMPORT_ROW_OPERATIONS = [
	"STAGE",
	"RESOLVE",
	"APPLY",
	"LINK",
	"SKIP",
] as const;
export type ImportRowOperation = (typeof IMPORT_ROW_OPERATIONS)[number];

export const IMPORT_ROW_STATUSES = [
	"READY",
	"NEEDS_REVIEW",
	"POSSIBLE_DUPLICATE",
	"EXACT_DUPLICATE",
	"APPLIED",
	"LINKED_EXISTING",
	"SKIPPED",
	"UNSUPPORTED",
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const IMPORT_DUPLICATE_CANDIDATE_TYPES = [
	"IMPORT_ROW",
	"CREDIT_CARD_PURCHASE",
	"INCOME_RECEIPT",
] as const;
export type ImportDuplicateCandidateType =
	(typeof IMPORT_DUPLICATE_CANDIDATE_TYPES)[number];

export const IMPORT_DUPLICATE_REASON_CODES = [
	"SAME_CARD_DATE_AMOUNT",
	"SAME_CARD_DATE_AMOUNT_MERCHANT",
	"SAME_INCOME_SOURCE_DATE_AMOUNT",
	"SAME_BATCH_SEMANTICS",
] as const;
export type ImportDuplicateReasonCode =
	(typeof IMPORT_DUPLICATE_REASON_CODES)[number];

export const IMPORT_RESULT_KINDS = [
	"CREATED",
	"LINKED_EXISTING",
	"EXACT_DUPLICATE",
] as const;
export type ImportResultKind = (typeof IMPORT_RESULT_KINDS)[number];

export const IMPORT_RESULT_TARGET_TYPES = [
	"CREDIT_CARD_PURCHASE",
	"INCOME_RECEIPT",
] as const;
export type ImportResultTargetType =
	(typeof IMPORT_RESULT_TARGET_TYPES)[number];

// ============================================================================
// 1. import_batches (immutable batch anchor)
// ============================================================================

export const importBatches = pgTable(
	"import_batches",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		provider: varchar("provider", { length: 64 }).notNull(),
		sourceKind: varchar("source_kind", { length: 32 }).notNull(),
		sourceContentHash: varchar("source_content_hash", { length: 64 }).notNull(),
		sourceFileName: varchar("source_file_name", { length: 255 }),
		parserType: varchar("parser_type", { length: 64 }).notNull(),
		parserVersion: varchar("parser_version", { length: 32 }).notNull(),
		observedAt: timestamp("observed_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("import_batches_identity_idx").on(
			table.userId,
			table.provider,
			table.sourceContentHash,
			table.parserType,
			table.parserVersion,
		),
		index("import_batches_user_created_idx").on(table.userId, table.createdAt),
		check(
			"import_batches_source_kind_check",
			sql`${table.sourceKind} IN ('NORMALIZED_ROWS', 'GENERIC_CSV_V1')`,
		),
		check(
			"import_batches_content_hash_check",
			sql`${table.sourceContentHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"import_batches_provider_check",
			sql`${table.provider} = btrim(${table.provider}) AND length(${table.provider}) BETWEEN 1 AND 64`,
		),
		check(
			"import_batches_parser_type_check",
			sql`${table.parserType} = btrim(${table.parserType}) AND length(${table.parserType}) BETWEEN 1 AND 64`,
		),
		check(
			"import_batches_parser_version_check",
			sql`${table.parserVersion} = btrim(${table.parserVersion}) AND length(${table.parserVersion}) BETWEEN 1 AND 32`,
		),
		check(
			"import_batches_file_name_check",
			sql`${table.sourceFileName} IS NULL OR (${table.sourceFileName} = btrim(${table.sourceFileName}) AND length(${table.sourceFileName}) BETWEEN 1 AND 255)`,
		),
	],
);

// ============================================================================
// 2. import_rows (immutable row anchor)
// ============================================================================

export const importRows = pgTable(
	"import_rows",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		batchId: uuid("batch_id")
			.notNull()
			.references(() => importBatches.id, { onDelete: "restrict" }),
		rowOrdinal: integer("row_ordinal").notNull(),
		recordType: varchar("record_type", { length: 32 }).notNull(),
		rawRowHash: varchar("raw_row_hash", { length: 64 }).notNull(),
		semanticFingerprint: varchar("semantic_fingerprint", {
			length: 64,
		}).notNull(),
		externalTransactionIdHash: varchar("external_transaction_id_hash", {
			length: 64,
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("import_rows_batch_ordinal_idx").on(
			table.batchId,
			table.rowOrdinal,
		),
		index("import_rows_user_created_idx").on(table.userId, table.createdAt),
		index("import_rows_user_semantic_idx").on(
			table.userId,
			table.semanticFingerprint,
		),
		index("import_rows_user_ext_id_idx")
			.on(table.userId, table.externalTransactionIdHash)
			.where(sql`${table.externalTransactionIdHash} IS NOT NULL`),
		check("import_rows_ordinal_check", sql`${table.rowOrdinal} >= 0`),
		check(
			"import_rows_record_type_check",
			sql`${table.recordType} IN ('CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT', 'UNSUPPORTED')`,
		),
		check(
			"import_rows_raw_hash_check",
			sql`${table.rawRowHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"import_rows_semantic_fp_check",
			sql`${table.semanticFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"import_rows_ext_id_hash_check",
			sql`${table.externalTransactionIdHash} IS NULL OR ${table.externalTransactionIdHash} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

// ============================================================================
// 3. import_row_revisions (append-only row state progression)
// ============================================================================

export const importRowRevisions = pgTable(
	"import_row_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		importRowId: uuid("import_row_id")
			.notNull()
			.references(() => importRows.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => importRowRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 16 }).notNull(),
		status: varchar("status", { length: 32 }).notNull(),
		payload: jsonb("payload").notNull(),
		reasonNote: varchar("reason_note", { length: 500 }),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}),
		idempotencyKey: varchar("idempotency_key", { length: 128 }),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("import_row_revisions_row_rev_idx").on(
			table.importRowId,
			table.revisionNo,
		),
		uniqueIndex("import_row_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("import_row_revisions_user_idempotency_idx")
			.on(table.userId, table.idempotencyKey)
			.where(sql`${table.idempotencyKey} IS NOT NULL`),
		index("import_row_revisions_row_created_idx").on(
			table.importRowId,
			table.createdAt,
		),
		index("import_row_revisions_user_status_idx").on(
			table.userId,
			table.status,
		),
		check("import_row_revisions_rev_no_check", sql`${table.revisionNo} >= 1`),
		check(
			"import_row_revisions_operation_check",
			sql`${table.operation} IN ('STAGE', 'RESOLVE', 'APPLY', 'LINK', 'SKIP')`,
		),
		check(
			"import_row_revisions_status_check",
			sql`${table.status} IN ('READY', 'NEEDS_REVIEW', 'POSSIBLE_DUPLICATE', 'EXACT_DUPLICATE', 'APPLIED', 'LINKED_EXISTING', 'SKIPPED', 'UNSUPPORTED')`,
		),
		check(
			"import_row_revisions_fp_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"import_row_revisions_idempotency_check",
			sql`${table.idempotencyKey} IS NULL OR (${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128)`,
		),
		check(
			"import_row_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) BETWEEN 1 AND 500)`,
		),
		check(
			"import_row_revisions_payload_size_check",
			sql`octet_length(${table.payload}::text) <= 65536`,
		),
	],
);

// ============================================================================
// 4. import_external_identity_claims (strong dedup claims)
// ============================================================================

export const importExternalIdentityClaims = pgTable(
	"import_external_identity_claims",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		provider: varchar("provider", { length: 64 }).notNull(),
		recordType: varchar("record_type", { length: 32 }).notNull(),
		scopeId: varchar("scope_id", { length: 64 }).notNull(),
		externalTransactionIdHash: varchar("external_transaction_id_hash", {
			length: 64,
		}).notNull(),
		importRowId: uuid("import_row_id")
			.notNull()
			.references(() => importRows.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("import_ext_claims_identity_idx").on(
			table.userId,
			table.provider,
			table.recordType,
			table.scopeId,
			table.externalTransactionIdHash,
		),
		index("import_ext_claims_row_idx").on(table.importRowId),
		check(
			"import_ext_claims_record_type_check",
			sql`${table.recordType} IN ('CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT')`,
		),
		check(
			"import_ext_claims_provider_check",
			sql`${table.provider} = btrim(${table.provider}) AND length(${table.provider}) BETWEEN 1 AND 64`,
		),
		check(
			"import_ext_claims_scope_check",
			sql`${table.scopeId} = btrim(${table.scopeId}) AND length(${table.scopeId}) BETWEEN 1 AND 64`,
		),
		check(
			"import_ext_claims_hash_check",
			sql`${table.externalTransactionIdHash} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

// ============================================================================
// 5. import_duplicate_candidates (audit trail for possible duplicates)
// ============================================================================

export const importDuplicateCandidates = pgTable(
	"import_duplicate_candidates",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		importRowId: uuid("import_row_id")
			.notNull()
			.references(() => importRows.id, { onDelete: "restrict" }),
		candidateType: varchar("candidate_type", { length: 32 }).notNull(),
		candidateId: varchar("candidate_id", { length: 64 }).notNull(),
		reasonCode: varchar("reason_code", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("import_duplicate_candidates_row_idx").on(table.importRowId),
		index("import_duplicate_candidates_target_idx").on(
			table.userId,
			table.candidateType,
			table.candidateId,
		),
		check(
			"import_duplicate_candidates_type_check",
			sql`${table.candidateType} IN ('IMPORT_ROW', 'CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT')`,
		),
		check(
			"import_duplicate_candidates_id_check",
			sql`${table.candidateId} = btrim(${table.candidateId}) AND length(${table.candidateId}) BETWEEN 1 AND 64`,
		),
		check(
			"import_duplicate_candidates_reason_check",
			sql`${table.reasonCode} IN ('SAME_CARD_DATE_AMOUNT', 'SAME_CARD_DATE_AMOUNT_MERCHANT', 'SAME_INCOME_SOURCE_DATE_AMOUNT', 'SAME_BATCH_SEMANTICS')`,
		),
	],
);

// ============================================================================
// 6. import_row_results (authoritative result binding)
// ============================================================================

export const importRowResults = pgTable(
	"import_row_results",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		importRowId: uuid("import_row_id")
			.notNull()
			.references(() => importRows.id, { onDelete: "restrict" }),
		resultKind: varchar("result_kind", { length: 32 }).notNull(),
		targetType: varchar("target_type", { length: 32 }).notNull(),
		targetId: varchar("target_id", { length: 64 }).notNull(),
		canonicalTransactionId: uuid("canonical_transaction_id").references(
			() => canonicalTransactions.id,
			{ onDelete: "restrict" },
		),
		externalIdentityClaimId: uuid("external_identity_claim_id").references(
			(): AnyPgColumn => importExternalIdentityClaims.id,
			{ onDelete: "restrict" },
		),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("import_row_results_row_idx").on(table.importRowId),
		index("import_row_results_target_idx").on(
			table.userId,
			table.targetType,
			table.targetId,
		),
		index("import_row_results_claim_idx").on(table.externalIdentityClaimId),
		check(
			"import_row_results_kind_check",
			sql`${table.resultKind} IN ('CREATED', 'LINKED_EXISTING', 'EXACT_DUPLICATE')`,
		),
		check(
			"import_row_results_target_type_check",
			sql`${table.targetType} IN ('CREDIT_CARD_PURCHASE', 'INCOME_RECEIPT')`,
		),
		check(
			"import_row_results_target_id_check",
			sql`${table.targetId} = btrim(${table.targetId}) AND length(${table.targetId}) BETWEEN 1 AND 64`,
		),
	],
);

// ============================================================================
// 7. import_mutation_idempotency_receipts (immutable mutation replay)
// ============================================================================

export const IMPORT_MUTATION_OPERATIONS = [
	"RESOLVE_MAPPINGS",
	"CONFIRM_IMPORT",
	"LINK_EXISTING",
	"SKIP",
	"APPLY",
] as const;
export type ImportMutationOperation =
	(typeof IMPORT_MUTATION_OPERATIONS)[number];

export const importMutationIdempotencyReceipts = pgTable(
	"import_mutation_idempotency_receipts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		operation: varchar("operation", { length: 32 }).notNull(),
		requestFingerprint: varchar("request_fingerprint", {
			length: 64,
		}).notNull(),
		importRowId: uuid("import_row_id")
			.notNull()
			.references(() => importRows.id, { onDelete: "restrict" }),
		importRowRevisionId: uuid("import_row_revision_id")
			.notNull()
			.references(() => importRowRevisions.id, { onDelete: "restrict" }),
		importRowResultId: uuid("import_row_result_id").references(
			() => importRowResults.id,
			{ onDelete: "restrict" },
		),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("import_mutation_receipts_user_key_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("import_mutation_receipts_row_idx").on(table.importRowId),
		check(
			"import_mutation_receipts_op_check",
			sql`${table.operation} IN ('RESOLVE_MAPPINGS', 'CONFIRM_IMPORT', 'LINK_EXISTING', 'SKIP', 'APPLY')`,
		),
		check(
			"import_mutation_receipts_key_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
		check(
			"import_mutation_receipts_fp_check",
			sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
	],
);
