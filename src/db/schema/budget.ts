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
import { canonicalTransactions, transactionRevisions } from "./transactions";

/**
 * Monthly Budget Plans Table (Identity / Anchor)
 * Immutable once created. Represents a monthly planned budget envelope.
 */
export const monthlyBudgetPlans = pgTable(
	"monthly_budget_plans",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		periodMonth: date("period_month").notNull(),
		canonicalTransactionId: uuid("canonical_transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("monthly_budget_plans_user_period_idx").on(
			table.userId,
			table.periodMonth,
		),
		uniqueIndex("monthly_budget_plans_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("monthly_budget_plans_user_idx").on(table.userId),
		check(
			"monthly_budget_plans_period_month_check",
			sql`EXTRACT(DAY FROM ${table.periodMonth}) = 1`,
		),
	],
);

/**
 * Monthly Budget Plan Revisions Table (Append-Only)
 * Snapshots all changes, recalcs, and void operations on monthly budget plans.
 */
export const monthlyBudgetPlanRevisions = pgTable(
	"monthly_budget_plan_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		budgetPlanId: uuid("budget_plan_id")
			.notNull()
			.references(() => monthlyBudgetPlans.id, { onDelete: "restrict" }),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousBudgetRevisionId: uuid("previous_budget_revision_id").references(
			(): AnyPgColumn => monthlyBudgetPlanRevisions.id,
			{
				onDelete: "restrict",
			},
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE, UPDATE, VOID
		policyVersion: varchar("policy_version", { length: 64 }).notNull(),
		currency: varchar("currency", { length: 3 }).notNull(),
		referenceIncomeAmount: numeric("reference_income_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		mandatoryCeilingAmount: numeric("mandatory_ceiling_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		discretionaryCeilingAmount: numeric("discretionary_ceiling_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		shortTermPurchaseAmount: numeric("short_term_purchase_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		mediumTermReserveAmount: numeric("medium_term_reserve_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		longTermInvestmentAmount: numeric("long_term_investment_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		referenceSnapshot: jsonb("reference_snapshot").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("monthly_budget_plan_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		uniqueIndex("monthly_budget_plan_revisions_plan_rev_no_idx").on(
			table.budgetPlanId,
			table.revisionNo,
		),
		uniqueIndex("monthly_budget_plan_revisions_prev_idx")
			.on(table.previousBudgetRevisionId)
			.where(sql`${table.previousBudgetRevisionId} IS NOT NULL`),
		index("monthly_budget_plan_revisions_user_plan_idx").on(
			table.userId,
			table.budgetPlanId,
		),
		check(
			"monthly_budget_plan_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"monthly_budget_plan_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"monthly_budget_plan_revisions_policy_check",
			sql`${table.policyVersion} = 'PERSONAL_BUDGET_V1'`,
		),
		check(
			"monthly_budget_plan_revisions_currency_check",
			sql`${table.currency} = btrim(${table.currency}) AND length(${table.currency}) = 3`,
		),
		check(
			"monthly_budget_plan_revisions_ref_amt_check",
			sql`${table.referenceIncomeAmount} >= 0`,
		),
		check(
			"monthly_budget_plan_revisions_mand_amt_check",
			sql`${table.mandatoryCeilingAmount} >= 0`,
		),
		check(
			"monthly_budget_plan_revisions_disc_amt_check",
			sql`${table.discretionaryCeilingAmount} >= 0`,
		),
		check(
			"monthly_budget_plan_revisions_short_amt_check",
			sql`${table.shortTermPurchaseAmount} >= 0`,
		),
		check(
			"monthly_budget_plan_revisions_med_amt_check",
			sql`${table.mediumTermReserveAmount} >= 0`,
		),
		check(
			"monthly_budget_plan_revisions_long_amt_check",
			sql`${table.longTermInvestmentAmount} >= 0`,
		),
		check(
			"monthly_budget_plan_revisions_sum_check",
			sql`${table.mandatoryCeilingAmount} + ${table.discretionaryCeilingAmount} + ${table.shortTermPurchaseAmount} + ${table.mediumTermReserveAmount} + ${table.longTermInvestmentAmount} = ${table.referenceIncomeAmount}`,
		),
	],
);
