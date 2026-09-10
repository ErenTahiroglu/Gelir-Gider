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
import { budgetV2CheckpointSnapshots } from "./budget-v2-checkpoint";
import { creditCardStatementPaymentEvents } from "./credit-card-ledger";

/**
 * PERSONAL_BUDGET_V2 -- RECOMMENDATION FEEDBACK LIFECYCLE (Checkpoint 6C).
 *
 * Two additive tables that capture the user's explicit review decisions
 * (ACCEPT / MODIFY / IGNORE) on deterministic Budget V2 recommendations:
 *
 *   budget_v2_recommendation_instances
 *     -- an immutable snapshot of the exact recommendation shown to and
 *        first responded to by the user. Captures the frozen recommendation
 *        JSON and its canonical SHA-256 fingerprint. Never updated or deleted.
 *
 *   budget_v2_recommendation_feedback_revisions
 *     -- an append-only revision ledger of the user's evolving decisions
 *        (ACCEPT | MODIFY | IGNORE) for a recommendation instance.
 *        CREATE (revision 1) -> UPDATE (revision 2..N).
 *
 * CRITICAL SEMANTICS:
 * - ACCEPT does NOT execute the recommendation or move any funds.
 * - MODIFY does NOT execute the proposal or alter budget policies.
 * - IGNORE does NOT disable future safety guardrails.
 * - Feedback records USER DECISIONS only -- no money movement, no policy
 *   mutation, and no feedback learning yet.
 */

export const BUDGET_V2_RECOMMENDATION_FEEDBACK_OPERATIONS = [
	"CREATE",
	"UPDATE",
] as const;
export type BudgetV2RecommendationFeedbackOperation =
	(typeof BUDGET_V2_RECOMMENDATION_FEEDBACK_OPERATIONS)[number];

export const BUDGET_V2_RECOMMENDATION_FEEDBACK_DECISIONS = [
	"ACCEPT",
	"MODIFY",
	"IGNORE",
] as const;
export type BudgetV2RecommendationFeedbackDecision =
	(typeof BUDGET_V2_RECOMMENDATION_FEEDBACK_DECISIONS)[number];

export const BUDGET_V2_RECOMMENDATION_FEEDBACK_SOURCE_KINDS = [
	"USER_APPROVED",
] as const;
export type BudgetV2RecommendationFeedbackSourceKind =
	(typeof BUDGET_V2_RECOMMENDATION_FEEDBACK_SOURCE_KINDS)[number];

// ============================================================================
// Immutable recommendation instance snapshot
// ============================================================================

export const budgetV2RecommendationInstances = pgTable(
	"budget_v2_recommendation_instances",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		checkpointSnapshotId: uuid("checkpoint_snapshot_id")
			.notNull()
			.references(() => budgetV2CheckpointSnapshots.id, {
				onDelete: "restrict",
			}),
		paymentEventId: uuid("payment_event_id")
			.notNull()
			.references(() => creditCardStatementPaymentEvents.id, {
				onDelete: "restrict",
			}),
		recommendationId: varchar("recommendation_id", { length: 256 }).notNull(),
		recommendationKind: varchar("recommendation_kind", {
			length: 64,
		}).notNull(),
		recommendationScope: varchar("recommendation_scope", {
			length: 128,
		}).notNull(),
		recommendationEngineVersion: varchar("recommendation_engine_version", {
			length: 64,
		}).notNull(),
		behaviorEngineVersion: varchar("behavior_engine_version", {
			length: 64,
		}).notNull(),
		observationContractVersion: varchar("observation_contract_version", {
			length: 64,
		}).notNull(),
		priority: integer("priority").notNull(),
		recommendationJson: jsonb("recommendation_json").notNull(),
		recommendationFingerprint: varchar("recommendation_fingerprint", {
			length: 64,
		}).notNull(),
		capturedAt: timestamp("captured_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("bv2recinst_user_rec_id_idx").on(
			table.userId,
			table.recommendationId,
		),
		uniqueIndex("bv2recinst_user_semantic_idx").on(
			table.userId,
			table.paymentEventId,
			table.recommendationKind,
			table.recommendationScope,
		),
		index("bv2recinst_user_checkpoint_idx").on(
			table.userId,
			table.checkpointSnapshotId,
		),
		check(
			"bv2recinst_fingerprint_check",
			sql`${table.recommendationFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"bv2recinst_rec_id_check",
			sql`${table.recommendationId} = btrim(${table.recommendationId}) AND length(${table.recommendationId}) BETWEEN 1 AND 256`,
		),
		check(
			"bv2recinst_kind_check",
			sql`${table.recommendationKind} IN (
				'DATA_COMPLETION_REQUIRED',
				'DEFICIT_STABILIZATION_REVIEW',
				'SURPLUS_OVERSUBSCRIPTION_REVIEW',
				'EMERGENCY_REBUILD_REVIEW',
				'BASELINE_RESET_REVIEW',
				'LANE_OVERRUN_REVIEW',
				'DISCRETIONARY_SPIKE_REVIEW',
				'OBLIGATION_LOAD_SPIKE_REVIEW',
				'TRUE_SURPLUS_RATE_DROP_REVIEW',
				'FOOD_OUTSIDE_SHARE_SPIKE_REVIEW',
				'UNUSED_DISCRETIONARY_SWEEP_REVIEW'
			)`,
		),
		check("bv2recinst_priority_check", sql`${table.priority} >= 0`),
	],
);

// ============================================================================
// Append-only feedback revision ledger
// ============================================================================

export const budgetV2RecommendationFeedbackRevisions = pgTable(
	"budget_v2_recommendation_feedback_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		recommendationInstanceId: uuid("recommendation_instance_id")
			.notNull()
			.references(() => budgetV2RecommendationInstances.id, {
				onDelete: "restrict",
			}),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => budgetV2RecommendationFeedbackRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE | UPDATE
		decision: varchar("decision", { length: 16 }).notNull(), // ACCEPT | MODIFY | IGNORE
		modificationJson: jsonb("modification_json"),
		sourceKind: varchar("source_kind", { length: 32 }).notNull(), // USER_APPROVED
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("bv2recfb_instance_rev_no_idx").on(
			table.recommendationInstanceId,
			table.revisionNo,
		),
		uniqueIndex("bv2recfb_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("bv2recfb_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("bv2recfb_user_instance_idx").on(
			table.userId,
			table.recommendationInstanceId,
		),
		check("bv2recfb_rev_no_check", sql`${table.revisionNo} > 0`),
		check("bv2recfb_op_check", sql`${table.operation} IN ('CREATE', 'UPDATE')`),
		check(
			"bv2recfb_decision_check",
			sql`${table.decision} IN ('ACCEPT', 'MODIFY', 'IGNORE')`,
		),
		check(
			"bv2recfb_source_kind_check",
			sql`${table.sourceKind} IN ('USER_APPROVED')`,
		),
		check(
			"bv2recfb_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"bv2recfb_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
		check(
			"bv2recfb_decision_mod_check",
			sql`(${table.decision} IN ('ACCEPT', 'IGNORE') AND ${table.modificationJson} IS NULL) OR (${table.decision} = 'MODIFY' AND ${table.modificationJson} IS NOT NULL)`,
		),
		check(
			"bv2recfb_chain_check",
			sql`(${table.revisionNo} = 1 AND ${table.previousRevisionId} IS NULL AND ${table.operation} = 'CREATE') OR (${table.revisionNo} > 1 AND ${table.previousRevisionId} IS NOT NULL AND ${table.operation} = 'UPDATE')`,
		),
	],
);
