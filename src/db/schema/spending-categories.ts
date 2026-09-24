import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

// ============================================================================
// Spending Categories
// ============================================================================

export const SPENDING_CATEGORY_DEFAULT_BUDGET_CATEGORIES = [
	"MANDATORY_EXPENSE",
	"DISCRETIONARY_SPEND",
	"SHORT_TERM_PURCHASE",
	"ASK",
] as const;
export type SpendingCategoryDefaultBudgetCategory =
	(typeof SPENDING_CATEGORY_DEFAULT_BUDGET_CATEGORIES)[number];

export const SPENDING_CATEGORY_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type SpendingCategoryStatus =
	(typeof SPENDING_CATEGORY_STATUSES)[number];

/**
 * Spending Categories Table
 * User-defined metadata labels for personal spending classification.
 * These are PURE METADATA — they do NOT affect financial accounting.
 * The defaultBudgetCategory is a suggestion hint for the frontend when
 * auto-selecting the financial budget category on new transactions.
 */
export const spendingCategories = pgTable(
	"spending_categories",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		name: varchar("name", { length: 100 }).notNull(),
		defaultBudgetCategory: varchar("default_budget_category", {
			length: 30,
		}).notNull(),
		status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("spending_categories_user_idx").on(table.userId),
		index("spending_categories_user_status_idx").on(table.userId, table.status),
		check(
			"spending_categories_name_check",
			sql`length(trim(${table.name})) >= 1 AND length(${table.name}) <= 100`,
		),
		check(
			"spending_categories_default_budget_category_check",
			sql`${table.defaultBudgetCategory} IN ('MANDATORY_EXPENSE', 'DISCRETIONARY_SPEND', 'SHORT_TERM_PURCHASE', 'ASK')`,
		),
		check(
			"spending_categories_status_check",
			sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`,
		),
		check("spending_categories_sort_order_check", sql`${table.sortOrder} >= 0`),
	],
);

// ============================================================================
// Spending Category Assignments
// ============================================================================

export const SPENDING_CATEGORY_SUBJECT_TYPES = [
	"CREDIT_CARD_PURCHASE",
	"MANUAL_EXPENSE",
] as const;
export type SpendingCategorySubjectType =
	(typeof SPENDING_CATEGORY_SUBJECT_TYPES)[number];

/**
 * Spending Category Assignments Table
 * Maps a spending category to a specific transaction subject.
 * subject_id references the domain-specific event/expense ID.
 * ON CONFLICT (user_id, subject_type, subject_id) → upsert latest category.
 * PURE METADATA — no ledger or financial state is affected.
 */
export const spendingCategoryAssignments = pgTable(
	"spending_category_assignments",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		subjectType: varchar("subject_type", { length: 30 }).notNull(),
		subjectId: uuid("subject_id").notNull(),
		categoryId: uuid("category_id")
			.notNull()
			.references(() => spendingCategories.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("spending_category_assignments_user_type_subject_idx").on(
			table.userId,
			table.subjectType,
			table.subjectId,
		),
		index("spending_category_assignments_user_idx").on(table.userId),
		index("spending_category_assignments_category_idx").on(table.categoryId),
		check(
			"spending_category_assignments_subject_type_check",
			sql`${table.subjectType} IN ('CREDIT_CARD_PURCHASE', 'MANUAL_EXPENSE')`,
		),
	],
);
