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
import { monthlyBudgetPlans } from "./budget";
import { midasAccounts, midasAllocationTransfers, midasBuckets } from "./midas";
import { shortTermGoals } from "./short-term-goals";

export const MONTH_CLOSE_ROUTES = [
	"SHORT_TERM_GOAL",
	"MEDIUM_TERM_RESERVE",
	"NONE",
] as const;
export type MonthCloseRoute = (typeof MONTH_CLOSE_ROUTES)[number];

export const MONTH_CLOSE_DECISIONS = [
	"FULL",
	"PARTIAL",
	"SKIP",
	"AUTO_MEDIUM",
	"NO_ACTION",
] as const;
export type MonthCloseDecision = (typeof MONTH_CLOSE_DECISIONS)[number];

/**
 * Month Closes Table (Immutable Identity Anchor)
 * One row per userId + periodMonth. Binds a month-end surplus close to the
 * authoritative Monthly Budget Plan for that exact user/period. Rows are
 * immutable once created; mutable snapshot data lives exclusively in
 * month_close_revisions (V1: exactly one revision per anchor, revision #1).
 */
export const monthCloses = pgTable(
	"month_closes",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		periodMonth: date("period_month").notNull(),
		budgetPlanId: uuid("budget_plan_id")
			.notNull()
			.references(() => monthlyBudgetPlans.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("month_closes_user_period_idx").on(
			table.userId,
			table.periodMonth,
		),
		index("month_closes_user_idx").on(table.userId),
		index("month_closes_budget_plan_idx").on(table.budgetPlanId),
		check(
			"month_closes_period_month_check",
			sql`EXTRACT(DAY FROM ${table.periodMonth}) = 1`,
		),
	],
);

/**
 * Month Close Revisions Table (Append-Only Immutable Historical Decision Snapshot)
 * V1 permits exactly one revision (#1, operation CLOSE, status CLOSED) per
 * month close anchor -- no REOPEN/UPDATE lifecycle in this phase. Later
 * ordinary Midas reallocations never rewrite what the user decided here.
 */
export const monthCloseRevisions = pgTable(
	"month_close_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		monthCloseId: uuid("month_close_id")
			.notNull()
			.references(() => monthCloses.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => monthCloseRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(),
		status: varchar("status", { length: 10 }).notNull(),

		budgetPlanRevisionNo: integer("budget_plan_revision_no").notNull(),
		policyVersion: varchar("policy_version", { length: 64 }).notNull(),
		currency: varchar("currency", { length: 3 }).notNull(),
		referenceIncome: numeric("reference_income", {
			precision: 18,
			scale: 2,
		}).notNull(),

		mandatoryCeiling: numeric("mandatory_ceiling", {
			precision: 18,
			scale: 2,
		}).notNull(),
		mandatoryExpense: numeric("mandatory_expense", {
			precision: 18,
			scale: 2,
		}).notNull(),
		mandatoryUnused: numeric("mandatory_unused", {
			precision: 18,
			scale: 2,
		}).notNull(),

		discretionaryCeiling: numeric("discretionary_ceiling", {
			precision: 18,
			scale: 2,
		}).notNull(),
		discretionaryExpense: numeric("discretionary_expense", {
			precision: 18,
			scale: 2,
		}).notNull(),
		discretionaryUnused: numeric("discretionary_unused", {
			precision: 18,
			scale: 2,
		}).notNull(),

		unclassifiedExpense: numeric("unclassified_expense", {
			precision: 18,
			scale: 2,
		}).notNull(),
		closeSurplus: numeric("close_surplus", {
			precision: 18,
			scale: 2,
		}).notNull(),

		route: varchar("route", { length: 20 }).notNull(),
		decision: varchar("decision", { length: 20 }).notNull(),

		midasAccountId: uuid("midas_account_id").references(
			() => midasAccounts.id,
			{ onDelete: "restrict" },
		),
		targetGoalId: uuid("target_goal_id").references(() => shortTermGoals.id, {
			onDelete: "restrict",
		}),
		targetGoalRevisionNo: integer("target_goal_revision_no"),
		targetBucketId: uuid("target_bucket_id").references(() => midasBuckets.id, {
			onDelete: "restrict",
		}),

		fullOfferAmount: numeric("full_offer_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		appliedAmount: numeric("applied_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		unroutedAmount: numeric("unrouted_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),

		midasAllocationTransferId: uuid("midas_allocation_transfer_id").references(
			() => midasAllocationTransfers.id,
			{ onDelete: "restrict" },
		),

		proposalFingerprint: varchar("proposal_fingerprint", {
			length: 64,
		}).notNull(),
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
		uniqueIndex("month_close_revisions_close_rev_idx").on(
			table.monthCloseId,
			table.revisionNo,
		),
		uniqueIndex("month_close_revisions_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		uniqueIndex("month_close_revisions_prev_rev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("month_close_revisions_transfer_idx")
			.on(table.midasAllocationTransferId)
			.where(sql`${table.midasAllocationTransferId} IS NOT NULL`),
		index("month_close_revisions_close_idx").on(table.monthCloseId),
		index("month_close_revisions_user_idx").on(table.userId),
		index("month_close_revisions_goal_idx").on(table.targetGoalId),
		index("month_close_revisions_midas_account_idx").on(table.midasAccountId),

		check("month_close_revisions_rev_no_check", sql`${table.revisionNo} = 1`),
		check(
			"month_close_revisions_prev_rev_null_check",
			sql`${table.previousRevisionId} IS NULL`,
		),
		check("month_close_revisions_op_check", sql`${table.operation} = 'CLOSE'`),
		check(
			"month_close_revisions_status_check",
			sql`${table.status} = 'CLOSED'`,
		),
		check(
			"month_close_revisions_budget_plan_rev_no_check",
			sql`${table.budgetPlanRevisionNo} > 0`,
		),
		check(
			"month_close_revisions_policy_check",
			sql`${table.policyVersion} = 'PERSONAL_BUDGET_V1'`,
		),
		check(
			"month_close_revisions_currency_check",
			sql`${table.currency} = btrim(${table.currency}) AND length(${table.currency}) = 3`,
		),
		check(
			"month_close_revisions_reference_income_check",
			sql`${table.referenceIncome} >= 0`,
		),
		check(
			"month_close_revisions_mandatory_ceiling_check",
			sql`${table.mandatoryCeiling} >= 0`,
		),
		check(
			"month_close_revisions_mandatory_unused_check",
			sql`${table.mandatoryUnused} >= 0 AND ${table.mandatoryUnused} = GREATEST(${table.mandatoryCeiling} - GREATEST(${table.mandatoryExpense}, 0), 0)`,
		),
		check(
			"month_close_revisions_discretionary_ceiling_check",
			sql`${table.discretionaryCeiling} >= 0`,
		),
		check(
			"month_close_revisions_discretionary_unused_check",
			sql`${table.discretionaryUnused} >= 0 AND ${table.discretionaryUnused} = GREATEST(${table.discretionaryCeiling} - GREATEST(${table.discretionaryExpense}, 0), 0)`,
		),
		check(
			"month_close_revisions_unclassified_check",
			sql`${table.unclassifiedExpense} = 0`,
		),
		check(
			"month_close_revisions_surplus_check",
			sql`${table.closeSurplus} = ${table.mandatoryUnused} + ${table.discretionaryUnused}`,
		),
		check(
			"month_close_revisions_unrouted_check",
			sql`${table.unroutedAmount} = ${table.closeSurplus} - ${table.appliedAmount}`,
		),
		check(
			"month_close_revisions_applied_nonneg_check",
			sql`${table.appliedAmount} >= 0`,
		),
		check(
			"month_close_revisions_unrouted_nonneg_check",
			sql`${table.unroutedAmount} >= 0`,
		),
		check(
			"month_close_revisions_full_offer_nonneg_check",
			sql`${table.fullOfferAmount} >= 0`,
		),
		check(
			"month_close_revisions_full_offer_scope_check",
			sql`${table.route} = 'SHORT_TERM_GOAL' OR ${table.fullOfferAmount} = 0`,
		),
		check(
			"month_close_revisions_route_check",
			sql`${table.route} IN ('SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE', 'NONE')`,
		),
		check(
			"month_close_revisions_decision_check",
			sql`${table.decision} IN ('FULL', 'PARTIAL', 'SKIP', 'AUTO_MEDIUM', 'NO_ACTION')`,
		),
		check(
			"month_close_revisions_goal_fields_check",
			sql`(${table.route} = 'SHORT_TERM_GOAL') = (${table.targetGoalId} IS NOT NULL) AND (${table.route} = 'SHORT_TERM_GOAL') = (${table.targetGoalRevisionNo} IS NOT NULL) AND (${table.route} IN ('SHORT_TERM_GOAL', 'MEDIUM_TERM_RESERVE')) = (${table.targetBucketId} IS NOT NULL)`,
		),
		check(
			"month_close_revisions_shape_check",
			sql`
				(${table.route} = 'SHORT_TERM_GOAL' AND ${table.decision} = 'FULL' AND ${table.appliedAmount} = ${table.fullOfferAmount} AND ${table.midasAllocationTransferId} IS NOT NULL)
				OR (${table.route} = 'SHORT_TERM_GOAL' AND ${table.decision} = 'PARTIAL' AND ${table.appliedAmount} > 0 AND ${table.appliedAmount} < ${table.fullOfferAmount} AND ${table.midasAllocationTransferId} IS NOT NULL)
				OR (${table.route} = 'SHORT_TERM_GOAL' AND ${table.decision} = 'SKIP' AND ${table.appliedAmount} = 0 AND ${table.midasAllocationTransferId} IS NULL)
				OR (${table.route} = 'MEDIUM_TERM_RESERVE' AND ${table.decision} = 'AUTO_MEDIUM' AND ${table.appliedAmount} = ${table.closeSurplus} AND ${table.midasAllocationTransferId} IS NOT NULL)
				OR (${table.route} = 'NONE' AND ${table.decision} = 'NO_ACTION' AND ${table.closeSurplus} = 0 AND ${table.appliedAmount} = 0 AND ${table.midasAllocationTransferId} IS NULL)
			`,
		),
		check(
			"month_close_revisions_proposal_fingerprint_check",
			sql`${table.proposalFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"month_close_revisions_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"month_close_revisions_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) >= 1 AND length(${table.idempotencyKey}) <= 128`,
		),
	],
);
