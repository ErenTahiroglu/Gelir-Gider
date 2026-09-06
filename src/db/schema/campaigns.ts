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
import { creditCardLiabilityEvents } from "./credit-card-ledger";
import { creditCards } from "./credit-cards";
import { rewardAccounts, rewardEvents } from "./rewards";

// ============================================================================
// Enums (application-level constants mirrored by DB CHECK constraints)
// ============================================================================

export const CAMPAIGN_SOURCE_TYPES = [
	"MANUAL",
	"OFFICIAL_PUBLIC_PAGE",
	"IMPORT",
] as const;
export type CampaignSourceType = (typeof CAMPAIGN_SOURCE_TYPES)[number];

export const CAMPAIGN_RULE_MODES = [
	"TOTAL_SPEND",
	"TRANSACTION_COUNT",
	"REPEATABLE_SPEND",
] as const;
export type CampaignRuleMode = (typeof CAMPAIGN_RULE_MODES)[number];

export const CAMPAIGN_REWARD_KINDS = [
	"REWARD_POINTS",
	"STATEMENT_CREDIT",
	"INFORMATIONAL",
] as const;
export type CampaignRewardKind = (typeof CAMPAIGN_REWARD_KINDS)[number];

export const CAMPAIGN_MERCHANT_SCOPE_MODES = [
	"ALL_MERCHANTS",
	"MERCHANT_ALIASES",
	"MANUAL_REVIEW_REQUIRED",
] as const;
export type CampaignMerchantScopeMode =
	(typeof CAMPAIGN_MERCHANT_SCOPE_MODES)[number];

export const CAMPAIGN_LIFECYCLE_STATUSES = [
	"REVIEW_REQUIRED",
	"ACTIVE",
	"ENDED",
	"CANCELLED",
] as const;
export type CampaignLifecycleStatus =
	(typeof CAMPAIGN_LIFECYCLE_STATUSES)[number];

export const CAMPAIGN_VISIBILITIES = ["VISIBLE", "HIDDEN"] as const;
export type CampaignVisibility = (typeof CAMPAIGN_VISIBILITIES)[number];

export const CAMPAIGN_PERIOD_REVISION_OPERATIONS = [
	"CREATE",
	"CONFIRM",
	"AMEND",
	"HIDE",
	"RESTORE",
	"END",
	"CANCEL",
] as const;
export type CampaignPeriodRevisionOperation =
	(typeof CAMPAIGN_PERIOD_REVISION_OPERATIONS)[number];

export const CAMPAIGN_OVERRIDE_OPERATIONS = [
	"INCLUDE",
	"EXCLUDE",
	"CLEAR",
] as const;
export type CampaignOverrideOperation =
	(typeof CAMPAIGN_OVERRIDE_OPERATIONS)[number];

export const CAMPAIGN_REWARD_CREDIT_OPERATIONS = ["CREATE", "VOID"] as const;
export type CampaignRewardCreditOperation =
	(typeof CAMPAIGN_REWARD_CREDIT_OPERATIONS)[number];

// ============================================================================
// Campaign Families (Immutable Anchor)
// ============================================================================

export const campaignFamilies = pgTable(
	"campaign_families",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		provider: varchar("provider", { length: 120 }).notNull(),
		familyKey: varchar("family_key", { length: 160 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("campaign_families_user_provider_key_idx").on(
			table.userId,
			table.provider,
			table.familyKey,
		),
		index("campaign_families_user_idx").on(table.userId),
		check(
			"campaign_families_provider_check",
			sql`${table.provider} = btrim(${table.provider}) AND length(${table.provider}) >= 1 AND length(${table.provider}) <= 120`,
		),
		check(
			"campaign_families_family_key_check",
			sql`${table.familyKey} = btrim(${table.familyKey}) AND length(${table.familyKey}) >= 1 AND length(${table.familyKey}) <= 160`,
		),
	],
);

// ============================================================================
// Campaign Periods (Immutable Anchor)
// ============================================================================

export const campaignPeriods = pgTable(
	"campaign_periods",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		campaignFamilyId: uuid("campaign_family_id")
			.notNull()
			.references(() => campaignFamilies.id, { onDelete: "restrict" }),
		periodKey: varchar("period_key", { length: 160 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("campaign_periods_family_period_key_idx").on(
			table.campaignFamilyId,
			table.periodKey,
		),
		index("campaign_periods_user_idx").on(table.userId),
		index("campaign_periods_family_idx").on(table.campaignFamilyId),
		check(
			"campaign_periods_period_key_check",
			sql`${table.periodKey} = btrim(${table.periodKey}) AND length(${table.periodKey}) >= 1 AND length(${table.periodKey}) <= 160`,
		),
	],
);

// ============================================================================
// Campaign Source Snapshots (Append-only)
// ============================================================================

export const campaignSourceSnapshots = pgTable(
	"campaign_source_snapshots",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		provider: varchar("provider", { length: 120 }).notNull(),
		sourceType: varchar("source_type", { length: 24 }).notNull(),
		sourceUrl: varchar("source_url", { length: 2048 }),
		externalSourceId: varchar("external_source_id", { length: 200 }),
		sourceTitle: varchar("source_title", { length: 300 }),
		sourceText: varchar("source_text", { length: 20000 }),
		contentHash: varchar("content_hash", { length: 64 }).notNull(),
		capturedAt: timestamp("captured_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("campaign_source_snapshots_user_idx").on(table.userId),
		index("campaign_source_snapshots_provider_idx").on(table.provider),
		index("campaign_source_snapshots_content_hash_idx").on(table.contentHash),
		check(
			"campaign_source_snapshots_source_type_check",
			sql`${table.sourceType} IN ('MANUAL', 'OFFICIAL_PUBLIC_PAGE', 'IMPORT')`,
		),
		check(
			"campaign_source_snapshots_https_check",
			sql`${table.sourceUrl} IS NULL OR ${table.sourceUrl} LIKE 'https://%'`,
		),
		check(
			"campaign_source_snapshots_content_hash_check",
			sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"campaign_source_snapshots_provider_check",
			sql`${table.provider} = btrim(${table.provider}) AND length(${table.provider}) >= 1 AND length(${table.provider}) <= 120`,
		),
	],
);

// ============================================================================
// Campaign Period Revisions (Append-only)
// ============================================================================

export const campaignPeriodRevisions = pgTable(
	"campaign_period_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		campaignPeriodId: uuid("campaign_period_id")
			.notNull()
			.references(() => campaignPeriods.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => campaignPeriodRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 20 }).notNull(),
		lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull(),
		visibility: varchar("visibility", { length: 10 }).notNull(),
		title: varchar("title", { length: 200 }).notNull(),
		startsOn: date("starts_on").notNull(),
		endsOn: date("ends_on").notNull(),
		ruleMode: varchar("rule_mode", { length: 24 }).notNull(),
		targetSpendAmount: numeric("target_spend_amount", {
			precision: 18,
			scale: 2,
		}),
		requiredTransactionCount: integer("required_transaction_count"),
		minimumTransactionAmount: numeric("minimum_transaction_amount", {
			precision: 18,
			scale: 2,
		}),
		stepSpendAmount: numeric("step_spend_amount", { precision: 18, scale: 2 }),
		rewardPointsPerStep: numeric("reward_points_per_step", {
			precision: 20,
			scale: 4,
		}),
		maxSteps: integer("max_steps"),
		rewardKind: varchar("reward_kind", { length: 20 }).notNull(),
		rewardAccountId: uuid("reward_account_id").references(
			() => rewardAccounts.id,
			{ onDelete: "restrict" },
		),
		expectedRewardPoints: numeric("expected_reward_points", {
			precision: 20,
			scale: 4,
		}),
		merchantScopeMode: varchar("merchant_scope_mode", {
			length: 24,
		}).notNull(),
		requiredCanonicalMerchantNames: jsonb("required_canonical_merchant_names"),
		allowedMccCodes: jsonb("allowed_mcc_codes"),
		rewardExpiryDate: date("reward_expiry_date"),
		sourceSnapshotId: uuid("source_snapshot_id").references(
			() => campaignSourceSnapshots.id,
			{ onDelete: "restrict" },
		),
		parserType: varchar("parser_type", { length: 60 }),
		parserVersion: varchar("parser_version", { length: 40 }),
		parserConfidence: numeric("parser_confidence", { precision: 5, scale: 4 }),
		note: varchar("note", { length: 1000 }),
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
		uniqueIndex("campaign_period_revisions_period_rev_idx").on(
			table.campaignPeriodId,
			table.revisionNo,
		),
		uniqueIndex("campaign_period_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("campaign_period_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("campaign_period_revisions_period_idx").on(table.campaignPeriodId),
		index("campaign_period_revisions_user_idx").on(table.userId),
		index("campaign_period_revisions_status_idx").on(table.lifecycleStatus),
		check(
			"campaign_period_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"campaign_period_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'CONFIRM', 'AMEND', 'HIDE', 'RESTORE', 'END', 'CANCEL')`,
		),
		check(
			"campaign_period_revisions_lifecycle_check",
			sql`${table.lifecycleStatus} IN ('REVIEW_REQUIRED', 'ACTIVE', 'ENDED', 'CANCELLED')`,
		),
		check(
			"campaign_period_revisions_visibility_check",
			sql`${table.visibility} IN ('VISIBLE', 'HIDDEN')`,
		),
		check(
			"campaign_period_revisions_title_check",
			sql`${table.title} = btrim(${table.title}) AND length(${table.title}) >= 1 AND length(${table.title}) <= 200`,
		),
		check(
			"campaign_period_revisions_date_window_check",
			sql`${table.startsOn} <= ${table.endsOn}`,
		),
		check(
			"campaign_period_revisions_rule_mode_check",
			sql`${table.ruleMode} IN ('TOTAL_SPEND', 'TRANSACTION_COUNT', 'REPEATABLE_SPEND')`,
		),
		check(
			"campaign_period_revisions_rule_shape_check",
			sql`(
				${table.ruleMode} = 'TOTAL_SPEND' AND ${table.targetSpendAmount} IS NOT NULL AND ${table.targetSpendAmount} > 0
					AND ${table.requiredTransactionCount} IS NULL AND ${table.minimumTransactionAmount} IS NULL
					AND ${table.stepSpendAmount} IS NULL AND ${table.rewardPointsPerStep} IS NULL AND ${table.maxSteps} IS NULL
			) OR (
				${table.ruleMode} = 'TRANSACTION_COUNT' AND ${table.requiredTransactionCount} IS NOT NULL AND ${table.requiredTransactionCount} >= 1
					AND (${table.minimumTransactionAmount} IS NULL OR ${table.minimumTransactionAmount} > 0)
					AND ${table.targetSpendAmount} IS NULL AND ${table.stepSpendAmount} IS NULL
					AND ${table.rewardPointsPerStep} IS NULL AND ${table.maxSteps} IS NULL
			) OR (
				${table.ruleMode} = 'REPEATABLE_SPEND' AND ${table.stepSpendAmount} IS NOT NULL AND ${table.stepSpendAmount} > 0
					AND ${table.rewardPointsPerStep} IS NOT NULL AND ${table.rewardPointsPerStep} > 0
					AND ${table.maxSteps} IS NOT NULL AND ${table.maxSteps} >= 1
					AND (${table.minimumTransactionAmount} IS NULL OR ${table.minimumTransactionAmount} > 0)
					AND ${table.targetSpendAmount} IS NULL AND ${table.requiredTransactionCount} IS NULL
			)`,
		),
		check(
			"campaign_period_revisions_reward_kind_check",
			sql`${table.rewardKind} IN ('REWARD_POINTS', 'STATEMENT_CREDIT', 'INFORMATIONAL')`,
		),
		check(
			"campaign_period_revisions_reward_shape_check",
			sql`(
				${table.rewardKind} = 'REWARD_POINTS' AND ${table.rewardAccountId} IS NOT NULL
					AND (
						(${table.ruleMode} = 'REPEATABLE_SPEND' AND ${table.expectedRewardPoints} IS NULL)
						OR (${table.ruleMode} != 'REPEATABLE_SPEND' AND ${table.expectedRewardPoints} IS NOT NULL AND ${table.expectedRewardPoints} > 0)
					)
			) OR (
				${table.rewardKind} IN ('STATEMENT_CREDIT', 'INFORMATIONAL')
					AND ${table.rewardAccountId} IS NULL AND ${table.expectedRewardPoints} IS NULL
			)`,
		),
		check(
			"campaign_period_revisions_merchant_scope_check",
			sql`${table.merchantScopeMode} IN ('ALL_MERCHANTS', 'MERCHANT_ALIASES', 'MANUAL_REVIEW_REQUIRED')`,
		),
		check(
			"campaign_period_revisions_merchant_scope_shape_check",
			sql`(
				${table.merchantScopeMode} = 'MERCHANT_ALIASES' AND ${table.requiredCanonicalMerchantNames} IS NOT NULL
					AND jsonb_typeof(${table.requiredCanonicalMerchantNames}) = 'array' AND jsonb_array_length(${table.requiredCanonicalMerchantNames}) >= 1
			) OR (
				${table.merchantScopeMode} != 'MERCHANT_ALIASES' AND ${table.requiredCanonicalMerchantNames} IS NULL
			)`,
		),
		check(
			"campaign_period_revisions_mcc_shape_check",
			sql`${table.allowedMccCodes} IS NULL OR jsonb_typeof(${table.allowedMccCodes}) = 'array'`,
		),
		check(
			"campaign_period_revisions_parser_confidence_check",
			sql`${table.parserConfidence} IS NULL OR (${table.parserConfidence} >= 0 AND ${table.parserConfidence} <= 1)`,
		),
		check(
			"campaign_period_revisions_parser_shape_check",
			sql`(${table.parserType} IS NULL) = (${table.parserVersion} IS NULL)`,
		),
		check(
			"campaign_period_revisions_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) >= 1 AND length(${table.note}) <= 1000)`,
		),
		check(
			"campaign_period_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"campaign_period_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

// ============================================================================
// Campaign Period Revision Cards (Immutable Companion)
// ============================================================================

export const campaignPeriodRevisionCards = pgTable(
	"campaign_period_revision_cards",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		revisionId: uuid("revision_id")
			.notNull()
			.references(() => campaignPeriodRevisions.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("campaign_period_revision_cards_rev_card_idx").on(
			table.revisionId,
			table.creditCardId,
		),
		index("campaign_period_revision_cards_revision_idx").on(table.revisionId),
		index("campaign_period_revision_cards_card_idx").on(table.creditCardId),
	],
);

// ============================================================================
// Merchant Aliases (Append-only correction memory)
// ============================================================================

export const merchantAliases = pgTable(
	"merchant_aliases",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		rawNormalizedAlias: varchar("raw_normalized_alias", {
			length: 200,
		}).notNull(),
		canonicalMerchantName: varchar("canonical_merchant_name", {
			length: 200,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("merchant_aliases_user_alias_idx").on(
			table.userId,
			table.rawNormalizedAlias,
		),
		check(
			"merchant_aliases_raw_check",
			sql`${table.rawNormalizedAlias} = btrim(${table.rawNormalizedAlias}) AND length(${table.rawNormalizedAlias}) >= 1 AND length(${table.rawNormalizedAlias}) <= 200`,
		),
		check(
			"merchant_aliases_canonical_check",
			sql`${table.canonicalMerchantName} = btrim(${table.canonicalMerchantName}) AND length(${table.canonicalMerchantName}) >= 1 AND length(${table.canonicalMerchantName}) <= 200`,
		),
	],
);

// ============================================================================
// Campaign Purchase Overrides (Immutable Anchor + Append-only Revisions)
// ============================================================================

export const campaignPurchaseOverrides = pgTable(
	"campaign_purchase_overrides",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		campaignPeriodId: uuid("campaign_period_id")
			.notNull()
			.references(() => campaignPeriods.id, { onDelete: "restrict" }),
		purchaseEventId: uuid("purchase_event_id")
			.notNull()
			.references(() => creditCardLiabilityEvents.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("campaign_purchase_overrides_period_purchase_idx").on(
			table.campaignPeriodId,
			table.purchaseEventId,
		),
		index("campaign_purchase_overrides_period_idx").on(table.campaignPeriodId),
		index("campaign_purchase_overrides_user_idx").on(table.userId),
	],
);

export const campaignPurchaseOverrideRevisions = pgTable(
	"campaign_purchase_override_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		overrideId: uuid("override_id")
			.notNull()
			.references(() => campaignPurchaseOverrides.id, {
				onDelete: "restrict",
			}),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => campaignPurchaseOverrideRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
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
		uniqueIndex("campaign_purchase_override_revisions_override_rev_idx").on(
			table.overrideId,
			table.revisionNo,
		),
		uniqueIndex("campaign_purchase_override_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("campaign_purchase_override_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("campaign_purchase_override_revisions_override_idx").on(
			table.overrideId,
		),
		check(
			"campaign_purchase_override_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"campaign_purchase_override_revisions_op_check",
			sql`${table.operation} IN ('INCLUDE', 'EXCLUDE', 'CLEAR')`,
		),
		check(
			"campaign_purchase_override_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) >= 1 AND length(${table.reasonNote}) <= 500)`,
		),
		check(
			"campaign_purchase_override_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"campaign_purchase_override_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

// ============================================================================
// Campaign Reward Credits (Immutable Anchor + Append-only Revisions)
// ============================================================================

export const campaignRewardCredits = pgTable(
	"campaign_reward_credits",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		campaignPeriodId: uuid("campaign_period_id")
			.notNull()
			.references(() => campaignPeriods.id, { onDelete: "restrict" }),
		rewardAccountId: uuid("reward_account_id")
			.notNull()
			.references(() => rewardAccounts.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("campaign_reward_credits_period_idx").on(table.campaignPeriodId),
		index("campaign_reward_credits_user_idx").on(table.userId),
	],
);

export const campaignRewardCreditRevisions = pgTable(
	"campaign_reward_credit_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		creditId: uuid("credit_id")
			.notNull()
			.references(() => campaignRewardCredits.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => campaignRewardCreditRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		actualPointAmount: numeric("actual_point_amount", {
			precision: 20,
			scale: 4,
		}).notNull(),
		expectedPointAmount: numeric("expected_point_amount", {
			precision: 20,
			scale: 4,
		}),
		reasonNote: varchar("reason_note", { length: 500 }),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		rewardEventId: uuid("reward_event_id")
			.notNull()
			.references(() => rewardEvents.id, { onDelete: "restrict" }),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("campaign_reward_credit_revisions_credit_rev_idx").on(
			table.creditId,
			table.revisionNo,
		),
		uniqueIndex("campaign_reward_credit_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("campaign_reward_credit_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		// Partial: only the CREATE revision establishes a reward_event_id
		// binding that must be globally unique (preventing two different
		// campaign_reward_credits identities from both claiming the same
		// underlying reward event). A subsequent VOID revision on the SAME
		// credit is required (by trg_fn_guard_campaign_reward_credit_revision_insert)
		// to copy the identical reward_event_id forward, so VOID rows must be
		// excluded from this uniqueness check or every VOID would collide
		// with its own CREATE revision.
		uniqueIndex("campaign_reward_credit_revisions_reward_event_idx")
			.on(table.rewardEventId)
			.where(sql`${table.operation} = 'CREATE'`),
		index("campaign_reward_credit_revisions_credit_idx").on(table.creditId),
		check(
			"campaign_reward_credit_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"campaign_reward_credit_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'VOID')`,
		),
		check(
			"campaign_reward_credit_revisions_actual_check",
			sql`${table.actualPointAmount} > 0`,
		),
		check(
			"campaign_reward_credit_revisions_expected_check",
			sql`${table.expectedPointAmount} IS NULL OR ${table.expectedPointAmount} > 0`,
		),
		check(
			"campaign_reward_credit_revisions_reason_note_check",
			sql`${table.reasonNote} IS NULL OR (${table.reasonNote} = btrim(${table.reasonNote}) AND length(${table.reasonNote}) >= 1 AND length(${table.reasonNote}) <= 500)`,
		),
		check(
			"campaign_reward_credit_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"campaign_reward_credit_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);

// ============================================================================
// Campaign Review Candidates (Immutable Anchor + Append-only Revisions)
// Phase 16-R1 Section K: source-change review candidates. A changed source
// snapshot for an ACTIVE campaign creates a PENDING review candidate without
// ever touching the currently confirmed campaign revision. Chain is
// CREATE -> (APPLY | DISMISS), both terminal.
// ============================================================================

export const CAMPAIGN_REVIEW_CANDIDATE_STATUSES = [
	"PENDING",
	"APPLIED",
	"DISMISSED",
] as const;
export type CampaignReviewCandidateStatus =
	(typeof CAMPAIGN_REVIEW_CANDIDATE_STATUSES)[number];

export const CAMPAIGN_REVIEW_CANDIDATE_OPERATIONS = [
	"CREATE",
	"APPLY",
	"DISMISS",
] as const;
export type CampaignReviewCandidateOperation =
	(typeof CAMPAIGN_REVIEW_CANDIDATE_OPERATIONS)[number];

export const campaignReviewCandidates = pgTable(
	"campaign_review_candidates",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		campaignPeriodId: uuid("campaign_period_id")
			.notNull()
			.references(() => campaignPeriods.id, { onDelete: "restrict" }),
		sourceSnapshotId: uuid("source_snapshot_id")
			.notNull()
			.references(() => campaignSourceSnapshots.id, { onDelete: "restrict" }),
		candidateHash: varchar("candidate_hash", { length: 64 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("campaign_review_candidates_period_idx").on(table.campaignPeriodId),
		index("campaign_review_candidates_user_idx").on(table.userId),
		index("campaign_review_candidates_hash_idx").on(
			table.campaignPeriodId,
			table.candidateHash,
		),
		check(
			"campaign_review_candidates_hash_check",
			sql`${table.candidateHash} ~ '^[0-9a-f]{64}$'`,
		),
	],
);

export const campaignReviewCandidateRevisions = pgTable(
	"campaign_review_candidate_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		candidateId: uuid("candidate_id")
			.notNull()
			.references(() => campaignReviewCandidates.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => campaignReviewCandidateRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		status: varchar("status", { length: 10 }).notNull(),
		title: varchar("title", { length: 200 }).notNull(),
		startsOn: date("starts_on").notNull(),
		endsOn: date("ends_on").notNull(),
		ruleMode: varchar("rule_mode", { length: 24 }).notNull(),
		targetSpendAmount: numeric("target_spend_amount", {
			precision: 18,
			scale: 2,
		}),
		requiredTransactionCount: integer("required_transaction_count"),
		minimumTransactionAmount: numeric("minimum_transaction_amount", {
			precision: 18,
			scale: 2,
		}),
		stepSpendAmount: numeric("step_spend_amount", { precision: 18, scale: 2 }),
		rewardPointsPerStep: numeric("reward_points_per_step", {
			precision: 20,
			scale: 4,
		}),
		maxSteps: integer("max_steps"),
		rewardKind: varchar("reward_kind", { length: 20 }).notNull(),
		rewardAccountId: uuid("reward_account_id").references(
			() => rewardAccounts.id,
			{ onDelete: "restrict" },
		),
		expectedRewardPoints: numeric("expected_reward_points", {
			precision: 20,
			scale: 4,
		}),
		merchantScopeMode: varchar("merchant_scope_mode", {
			length: 24,
		}).notNull(),
		requiredCanonicalMerchantNames: jsonb("required_canonical_merchant_names"),
		allowedMccCodes: jsonb("allowed_mcc_codes"),
		rewardExpiryDate: date("reward_expiry_date"),
		parserType: varchar("parser_type", { length: 60 }),
		parserVersion: varchar("parser_version", { length: 40 }),
		parserConfidence: numeric("parser_confidence", { precision: 5, scale: 4 }),
		proposedCardIds: jsonb("proposed_card_ids").notNull(),
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
		uniqueIndex("campaign_review_candidate_revisions_candidate_rev_idx").on(
			table.candidateId,
			table.revisionNo,
		),
		uniqueIndex("campaign_review_candidate_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("campaign_review_candidate_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		index("campaign_review_candidate_revisions_candidate_idx").on(
			table.candidateId,
		),
		check(
			"campaign_review_candidate_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"campaign_review_candidate_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'APPLY', 'DISMISS')`,
		),
		check(
			"campaign_review_candidate_revisions_status_check",
			sql`${table.status} IN ('PENDING', 'APPLIED', 'DISMISSED')`,
		),
		check(
			"campaign_review_candidate_revisions_title_check",
			sql`${table.title} = btrim(${table.title}) AND length(${table.title}) >= 1 AND length(${table.title}) <= 200`,
		),
		check(
			"campaign_review_candidate_revisions_date_window_check",
			sql`${table.startsOn} <= ${table.endsOn}`,
		),
		check(
			"campaign_review_candidate_revisions_rule_mode_check",
			sql`${table.ruleMode} IN ('TOTAL_SPEND', 'TRANSACTION_COUNT', 'REPEATABLE_SPEND')`,
		),
		check(
			"campaign_review_candidate_revisions_reward_kind_check",
			sql`${table.rewardKind} IN ('REWARD_POINTS', 'STATEMENT_CREDIT', 'INFORMATIONAL')`,
		),
		check(
			"campaign_review_candidate_revisions_merchant_scope_check",
			sql`${table.merchantScopeMode} IN ('ALL_MERCHANTS', 'MERCHANT_ALIASES', 'MANUAL_REVIEW_REQUIRED')`,
		),
		check(
			"campaign_review_candidate_revisions_mcc_shape_check",
			sql`${table.allowedMccCodes} IS NULL OR jsonb_typeof(${table.allowedMccCodes}) = 'array'`,
		),
		check(
			"campaign_review_candidate_revisions_parser_confidence_check",
			sql`${table.parserConfidence} IS NULL OR (${table.parserConfidence} >= 0 AND ${table.parserConfidence} <= 1)`,
		),
		check(
			"campaign_review_candidate_revisions_parser_shape_check",
			sql`(${table.parserType} IS NULL) = (${table.parserVersion} IS NULL)`,
		),
		check(
			"campaign_review_candidate_revisions_proposed_card_ids_check",
			sql`jsonb_typeof(${table.proposedCardIds}) = 'array'`,
		),
		check(
			"campaign_review_candidate_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"campaign_review_candidate_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);
