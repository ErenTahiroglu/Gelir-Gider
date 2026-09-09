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
import { shortTermGoalBudgetV2PurposeRevisions } from "./budget-v2-semantics";
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "./credit-card-ledger";
import { creditCardPurchaseSplitRevisions } from "./credit-card-splits";
import { longTermSendTaskRevisions, longTermSendTasks } from "./long-term";
import { midasAllocationTransfers } from "./midas";
import { personObligationRevisions, personObligations } from "./people";
import { shortTermGoals } from "./short-term-goals";

/**
 * PERSONAL_BUDGET_V2 -- SURPLUS-USE ATTRIBUTION (Checkpoint 5B).
 *
 * An additive, append-only USER-APPROVED semantic projection that records how
 * much of a Budget V2 period's current-period `trueSurplus` a realized source
 * event actually consumed. It is NOT an economic event: no canonical
 * transaction, no ledger posting, no Midas movement, no principal change.
 *
 * Three facts are kept distinct and never collapsed:
 *   - the economic/source event ("a 1,000 TL discretionary purchase occurred")
 *   - funding provenance ("600 TL of it consumed September trueSurplus")
 *   - remaining policy capacity (computed by the read model, never stored)
 *
 * `current_surplus_amount` MAY be 0 -- an explicit user decision that this
 * source consumed ZERO of this period's trueSurplus. That is authoritative and
 * distinct from "no attribution exists" (UNATTRIBUTED), exactly as an explicit
 * NON_FOOD classification is distinct from UNCLASSIFIED.
 *
 * `other_funding_amount = basis_amount - current_surplus_amount` is derivable
 * and never stored. Funding provenance is never inferred from merchant / memo /
 * amount / card / bank / timing / bucket balance / destination label.
 */

export const SURPLUS_USE_SUBJECT_TYPES = [
	"CREDIT_CARD_PURCHASE",
	"PEOPLE_PAYABLE",
	"MOBILITY_MIDAS_TRANSFER",
	"LONG_TERM_SEND_TASK",
] as const;
export type SurplusUseSubjectType = (typeof SURPLUS_USE_SUBJECT_TYPES)[number];

export const SURPLUS_USE_OPERATIONS = ["CREATE", "UPDATE", "VOID"] as const;
export type SurplusUseOperation = (typeof SURPLUS_USE_OPERATIONS)[number];

export const SURPLUS_USE_LANES = [
	"DISCRETIONARY",
	"INTERNATIONAL_MOBILITY",
	"LONG_TERM_INVESTMENT",
] as const;
export type SurplusUseLane = (typeof SURPLUS_USE_LANES)[number];

export const SURPLUS_USE_SOURCE_KINDS = ["USER_APPROVED"] as const;
export type SurplusUseSourceKind = (typeof SURPLUS_USE_SOURCE_KINDS)[number];

export const budgetV2SurplusUseAttributionRevisions = pgTable(
	"budget_v2_surplus_use_attribution_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		periodMonth: date("period_month", { mode: "string" }).notNull(),
		subjectType: varchar("subject_type", { length: 32 }).notNull(),
		// exactly ONE of these is populated, matched to subject_type
		purchaseEventId: uuid("purchase_event_id").references(
			() => creditCardLiabilityEvents.id,
			{ onDelete: "restrict" },
		),
		personObligationId: uuid("person_obligation_id").references(
			() => personObligations.id,
			{ onDelete: "restrict" },
		),
		midasAllocationTransferId: uuid("midas_allocation_transfer_id").references(
			() => midasAllocationTransfers.id,
			{ onDelete: "restrict" },
		),
		longTermSendTaskId: uuid("long_term_send_task_id").references(
			() => longTermSendTasks.id,
			{ onDelete: "restrict" },
		),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => budgetV2SurplusUseAttributionRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		lane: varchar("lane", { length: 24 }).notNull(),
		basisAmount: numeric("basis_amount", { precision: 18, scale: 2 }).notNull(),
		currentSurplusAmount: numeric("current_surplus_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		sourceKind: varchar("source_kind", { length: 32 }).notNull(),
		// evidence (typed to subject_type)
		purchaseEventRevisionId: uuid("purchase_event_revision_id").references(
			() => creditCardLiabilityEventRevisions.id,
			{ onDelete: "restrict" },
		),
		purchaseSplitRevisionId: uuid("purchase_split_revision_id").references(
			() => creditCardPurchaseSplitRevisions.id,
			{ onDelete: "restrict" },
		),
		personObligationRevisionId: uuid(
			"person_obligation_revision_id",
		).references(() => personObligationRevisions.id, { onDelete: "restrict" }),
		mobilityGoalId: uuid("mobility_goal_id").references(
			() => shortTermGoals.id,
			{ onDelete: "restrict" },
		),
		mobilityPurposeRevisionId: uuid("mobility_purpose_revision_id").references(
			() => shortTermGoalBudgetV2PurposeRevisions.id,
			{ onDelete: "restrict" },
		),
		longTermTaskRevisionId: uuid("long_term_task_revision_id").references(
			() => longTermSendTaskRevisions.id,
			{ onDelete: "restrict" },
		),
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
		uniqueIndex("bv2surplus_purchase_rev_no_idx")
			.on(table.purchaseEventId, table.periodMonth, table.revisionNo)
			.where(sql`${table.purchaseEventId} IS NOT NULL`),
		uniqueIndex("bv2surplus_obligation_rev_no_idx")
			.on(table.personObligationId, table.periodMonth, table.revisionNo)
			.where(sql`${table.personObligationId} IS NOT NULL`),
		uniqueIndex("bv2surplus_transfer_rev_no_idx")
			.on(table.midasAllocationTransferId, table.periodMonth, table.revisionNo)
			.where(sql`${table.midasAllocationTransferId} IS NOT NULL`),
		uniqueIndex("bv2surplus_task_rev_no_idx")
			.on(table.longTermSendTaskId, table.periodMonth, table.revisionNo)
			.where(sql`${table.longTermSendTaskId} IS NOT NULL`),
		uniqueIndex("bv2surplus_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("bv2surplus_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("bv2surplus_user_period_idx").on(table.userId, table.periodMonth),
		check("bv2surplus_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"bv2surplus_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"bv2surplus_lane_check",
			sql`${table.lane} IN ('DISCRETIONARY', 'INTERNATIONAL_MOBILITY', 'LONG_TERM_INVESTMENT')`,
		),
		check(
			"bv2surplus_subject_type_check",
			sql`${table.subjectType} IN ('CREDIT_CARD_PURCHASE', 'PEOPLE_PAYABLE', 'MOBILITY_MIDAS_TRANSFER', 'LONG_TERM_SEND_TASK')`,
		),
		check(
			"bv2surplus_source_kind_check",
			sql`${table.sourceKind} IN ('USER_APPROVED')`,
		),
		check(
			"bv2surplus_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"bv2surplus_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
		check("bv2surplus_basis_positive_check", sql`${table.basisAmount} > 0`),
		check(
			"bv2surplus_current_nonneg_check",
			sql`${table.currentSurplusAmount} >= 0`,
		),
		check(
			"bv2surplus_current_le_basis_check",
			sql`${table.currentSurplusAmount} <= ${table.basisAmount}`,
		),
		check(
			"bv2surplus_void_zero_current_check",
			sql`${table.operation} <> 'VOID' OR ${table.currentSurplusAmount} = 0`,
		),
		// exactly one polymorphic subject identity, matched to subject_type +
		// compatible evidence + lane
		check(
			"bv2surplus_subject_identity_check",
			sql`(
				${table.subjectType} = 'CREDIT_CARD_PURCHASE'
					AND ${table.purchaseEventId} IS NOT NULL
					AND ${table.personObligationId} IS NULL
					AND ${table.midasAllocationTransferId} IS NULL
					AND ${table.longTermSendTaskId} IS NULL
					AND ${table.purchaseEventRevisionId} IS NOT NULL
					AND ${table.personObligationRevisionId} IS NULL
					AND ${table.mobilityGoalId} IS NULL
					AND ${table.mobilityPurposeRevisionId} IS NULL
					AND ${table.longTermTaskRevisionId} IS NULL
					AND ${table.lane} = 'DISCRETIONARY'
			) OR (
				${table.subjectType} = 'PEOPLE_PAYABLE'
					AND ${table.personObligationId} IS NOT NULL
					AND ${table.purchaseEventId} IS NULL
					AND ${table.midasAllocationTransferId} IS NULL
					AND ${table.longTermSendTaskId} IS NULL
					AND ${table.personObligationRevisionId} IS NOT NULL
					AND ${table.purchaseEventRevisionId} IS NULL
					AND ${table.purchaseSplitRevisionId} IS NULL
					AND ${table.mobilityGoalId} IS NULL
					AND ${table.mobilityPurposeRevisionId} IS NULL
					AND ${table.longTermTaskRevisionId} IS NULL
					AND ${table.lane} = 'DISCRETIONARY'
			) OR (
				${table.subjectType} = 'MOBILITY_MIDAS_TRANSFER'
					AND ${table.midasAllocationTransferId} IS NOT NULL
					AND ${table.purchaseEventId} IS NULL
					AND ${table.personObligationId} IS NULL
					AND ${table.longTermSendTaskId} IS NULL
					AND ${table.mobilityGoalId} IS NOT NULL
					AND ${table.purchaseEventRevisionId} IS NULL
					AND ${table.purchaseSplitRevisionId} IS NULL
					AND ${table.personObligationRevisionId} IS NULL
					AND ${table.longTermTaskRevisionId} IS NULL
					AND ${table.lane} = 'INTERNATIONAL_MOBILITY'
			) OR (
				${table.subjectType} = 'LONG_TERM_SEND_TASK'
					AND ${table.longTermSendTaskId} IS NOT NULL
					AND ${table.purchaseEventId} IS NULL
					AND ${table.personObligationId} IS NULL
					AND ${table.midasAllocationTransferId} IS NULL
					AND ${table.longTermTaskRevisionId} IS NOT NULL
					AND ${table.purchaseEventRevisionId} IS NULL
					AND ${table.purchaseSplitRevisionId} IS NULL
					AND ${table.personObligationRevisionId} IS NULL
					AND ${table.mobilityGoalId} IS NULL
					AND ${table.mobilityPurposeRevisionId} IS NULL
					AND ${table.lane} = 'LONG_TERM_INVESTMENT'
			)`,
		),
		check(
			"bv2surplus_create_chain_check",
			sql`${table.revisionNo} <> 1 OR (${table.previousRevisionId} IS NULL AND ${table.operation} = 'CREATE')`,
		),
		check(
			"bv2surplus_noncreate_chain_check",
			sql`${table.revisionNo} = 1 OR (${table.previousRevisionId} IS NOT NULL AND ${table.operation} IN ('UPDATE', 'VOID'))`,
		),
	],
);
