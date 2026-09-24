import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	pgTable,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

// ============================================================================
// Quick Entry Templates
// ============================================================================

export const QUICK_ENTRY_TEMPLATE_TYPES = [
	"CREDIT_CARD_EXPENSE",
	"MANUAL_EXPENSE",
	"INCOME",
	"RECEIVABLE",
	"PAYABLE",
] as const;
export type QuickEntryTemplateType =
	(typeof QUICK_ENTRY_TEMPLATE_TYPES)[number];

export const QUICK_ENTRY_TEMPLATE_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type QuickEntryTemplateStatus =
	(typeof QUICK_ENTRY_TEMPLATE_STATUSES)[number];

/**
 * Quick Entry Templates Table
 * Server-synced shortcut templates for fast transaction entry on the frontend.
 * config is a JSONB blob whose shape is per-templateType (validated at service layer).
 * Templates are NEVER executed server-side — they are suggestion/autofill data only.
 * The frontend populates a form from the template config and the user confirms before submission.
 */
export const quickEntryTemplates = pgTable(
	"quick_entry_templates",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		name: varchar("name", { length: 100 }).notNull(),
		templateType: varchar("template_type", { length: 30 }).notNull(),
		config: jsonb("config").notNull(),
		sortOrder: integer("sort_order").notNull().default(0),
		status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("quick_entry_templates_user_idx").on(table.userId),
		index("quick_entry_templates_user_status_idx").on(
			table.userId,
			table.status,
		),
		check(
			"quick_entry_templates_name_check",
			sql`length(trim(${table.name})) >= 1 AND length(${table.name}) <= 100`,
		),
		check(
			"quick_entry_templates_type_check",
			sql`${table.templateType} IN ('CREDIT_CARD_EXPENSE', 'MANUAL_EXPENSE', 'INCOME', 'RECEIVABLE', 'PAYABLE')`,
		),
		check(
			"quick_entry_templates_status_check",
			sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`,
		),
		check(
			"quick_entry_templates_sort_order_check",
			sql`${table.sortOrder} >= 0`,
		),
	],
);
