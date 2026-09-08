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
 * PERSONAL_BUDGET_V2 monthly budget projection.
 *
 * This is a SEPARATE V2 anchor / append-only revision projection. It does NOT
 * reuse, relax, or generalise the historical PERSONAL_BUDGET_V1 tables
 * (`monthly_budget_plans` / `monthly_budget_plan_revisions`), which remain a
 * closed historical contract. V2 persisted records bind to a distinct
 * canonical transaction kind `MONTHLY_BUDGET_PLAN_V2`.
 *
 * The deterministic V2 policy math lives in `src/budget/policy-v2.ts`; the
 * DB independently re-derives and rejects any non-conforming projection via
 * the `trg_fn_guard_monthly_budget_v2_plan_revisions_insert` guard added in
 * migration 0061.
 */

/**
 * Monthly Budget V2 Plans Table (Identity / Anchor)
 * One immutable V2 plan per user + period month.
 */
export const monthlyBudgetV2Plans = pgTable(
	"monthly_budget_v2_plans",
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
		uniqueIndex("monthly_budget_v2_plans_user_period_idx").on(
			table.userId,
			table.periodMonth,
		),
		uniqueIndex("monthly_budget_v2_plans_canonical_tx_idx").on(
			table.canonicalTransactionId,
		),
		index("monthly_budget_v2_plans_user_idx").on(table.userId),
		check(
			"monthly_budget_v2_plans_period_month_check",
			sql`EXTRACT(DAY FROM ${table.periodMonth}) = 1`,
		),
	],
);

/**
 * Monthly Budget V2 Plan Revisions Table (Append-Only)
 *
 * Core INPUT snapshot columns + core OUTPUT snapshot columns are explicit
 * NUMERIC(18,2) financial truth. `evidenceSnapshot` is bounded JSONB
 * metadata/evidence ONLY -- never a home for the financial amounts.
 */
export const monthlyBudgetV2PlanRevisions = pgTable(
	"monthly_budget_v2_plan_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		budgetPlanId: uuid("budget_plan_id")
			.notNull()
			.references(() => monthlyBudgetV2Plans.id, { onDelete: "restrict" }),
		canonicalRevisionId: uuid("canonical_revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		revisionNo: integer("revision_no").notNull(),
		previousBudgetRevisionId: uuid("previous_budget_revision_id").references(
			(): AnyPgColumn => monthlyBudgetV2PlanRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE, UPDATE, VOID
		policyVersion: varchar("policy_version", { length: 64 }).notNull(),
		currency: varchar("currency", { length: 3 }).notNull(),

		// ---- Core INPUT snapshot (already-resolved non-negative inputs) ----
		realizedIncomeAmount: numeric("realized_income_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		currentObligationsAmount: numeric("current_obligations_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		basicLivingFundingAmount: numeric("basic_living_funding_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		dateBoundNecessaryPurchaseFundingAmount: numeric(
			"date_bound_necessary_purchase_funding_amount",
			{ precision: 18, scale: 2 },
		).notNull(),
		coreEmergencyFundBalanceAmount: numeric(
			"core_emergency_fund_balance_amount",
			{
				precision: 18,
				scale: 2,
			},
		).notNull(),
		mobilityBalanceAmount: numeric("mobility_balance_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),

		// ---- Core OUTPUT snapshot (deterministic waterfall results) ----
		emergencyCatchUpAmount: numeric("emergency_catch_up_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		deficitAmount: numeric("deficit_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		trueSurplusAmount: numeric("true_surplus_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		mobilityAllocationAmount: numeric("mobility_allocation_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		longTermInvestmentAmount: numeric("long_term_investment_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		discretionaryAllocationAmount: numeric("discretionary_allocation_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),

		// Bounded evidence/reference metadata for future historical source
		// pinning. NEVER carries financial truth amounts.
		evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("monthly_budget_v2_plan_revisions_canonical_rev_idx").on(
			table.canonicalRevisionId,
		),
		uniqueIndex("monthly_budget_v2_plan_revisions_plan_rev_no_idx").on(
			table.budgetPlanId,
			table.revisionNo,
		),
		uniqueIndex("monthly_budget_v2_plan_revisions_prev_idx")
			.on(table.previousBudgetRevisionId)
			.where(sql`${table.previousBudgetRevisionId} IS NOT NULL`),
		index("monthly_budget_v2_plan_revisions_user_plan_idx").on(
			table.userId,
			table.budgetPlanId,
		),
		check(
			"monthly_budget_v2_plan_revisions_rev_no_check",
			sql`${table.revisionNo} > 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"monthly_budget_v2_plan_revisions_policy_check",
			sql`${table.policyVersion} = 'PERSONAL_BUDGET_V2'`,
		),
		check(
			"monthly_budget_v2_plan_revisions_currency_check",
			sql`${table.currency} = btrim(${table.currency}) AND length(${table.currency}) = 3`,
		),
		check(
			"monthly_budget_v2_plan_revisions_realized_income_check",
			sql`${table.realizedIncomeAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_current_obligations_check",
			sql`${table.currentObligationsAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_basic_living_check",
			sql`${table.basicLivingFundingAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_necessary_purchase_check",
			sql`${table.dateBoundNecessaryPurchaseFundingAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_emergency_balance_check",
			sql`${table.coreEmergencyFundBalanceAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_mobility_balance_check",
			sql`${table.mobilityBalanceAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_emergency_catch_up_check",
			sql`${table.emergencyCatchUpAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_deficit_check",
			sql`${table.deficitAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_true_surplus_check",
			sql`${table.trueSurplusAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_mobility_alloc_check",
			sql`${table.mobilityAllocationAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_long_term_check",
			sql`${table.longTermInvestmentAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_discretionary_check",
			sql`${table.discretionaryAllocationAmount} >= 0`,
		),
		check(
			"monthly_budget_v2_plan_revisions_allocation_sum_check",
			sql`${table.mobilityAllocationAmount} + ${table.longTermInvestmentAmount} + ${table.discretionaryAllocationAmount} = ${table.trueSurplusAmount}`,
		),
	],
);
