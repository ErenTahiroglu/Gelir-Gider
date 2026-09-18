import { sql } from "drizzle-orm";
import {
	check,
	date,
	index,
	numeric,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { monthCloses } from "./month-close";

/**
 * Month Close Adjustments Table (MC-01 Option C: Post-Close Adjustment Model)
 *
 * Records backdated or retroactive modifications that impact a period after it
 * has already been CLOSED. The closed month's original month_closes and
 * month_close_revisions remain 100% immutable.
 *
 * Unapplied adjustments are carried forward and reconciled in the next open
 * period close:
 *   adjustedRoutableSurplus = max(0, nativeCloseSurplus + unappliedPriorAdjustments)
 */
export const monthCloseAdjustments = pgTable(
	"month_close_adjustments",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		closedPeriodMonth: date("closed_period_month").notNull(),
		adjustmentAmount: numeric("adjustment_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		remainingAmount: numeric("remaining_amount", {
			precision: 18,
			scale: 2,
		})
			.default("0.00")
			.notNull(),
		reasonCode: varchar("reason_code", { length: 64 }).notNull(),
		sourceRef: varchar("source_ref", { length: 128 }).notNull(),
		appliedInMonthCloseId: uuid("applied_in_month_close_id").references(
			() => monthCloses.id,
			{ onDelete: "restrict" },
		),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("month_close_adjustments_user_source_ref_idx").on(
			table.userId,
			table.sourceRef,
		),
		index("month_close_adjustments_user_unapplied_idx").on(
			table.userId,
			table.closedPeriodMonth,
		),
		index("month_close_adjustments_applied_close_idx").on(
			table.appliedInMonthCloseId,
		),
		check(
			"month_close_adjustments_closed_period_check",
			sql`EXTRACT(DAY FROM ${table.closedPeriodMonth}) = 1`,
		),
		check(
			"month_close_adjustments_reason_code_check",
			sql`${table.reasonCode} = btrim(${table.reasonCode}) AND length(${table.reasonCode}) BETWEEN 1 AND 64`,
		),
		check(
			"month_close_adjustments_source_ref_check",
			sql`${table.sourceRef} = btrim(${table.sourceRef}) AND length(${table.sourceRef}) BETWEEN 1 AND 128`,
		),
	],
);

/**
 * Month Close Adjustment Applications Table
 *
 * Append-only audit record linking each applied adjustment to the month close
 * that absorbed it.
 */
export const monthCloseAdjustmentApplications = pgTable(
	"month_close_adjustment_applications",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		monthCloseId: uuid("month_close_id")
			.notNull()
			.references(() => monthCloses.id, { onDelete: "restrict" }),
		adjustmentId: uuid("adjustment_id")
			.notNull()
			.references(() => monthCloseAdjustments.id, { onDelete: "restrict" }),
		appliedAmount: numeric("applied_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("month_close_adj_apps_unique_idx").on(
			table.monthCloseId,
			table.adjustmentId,
		),
		index("month_close_adj_apps_user_idx").on(table.userId),
	],
);
