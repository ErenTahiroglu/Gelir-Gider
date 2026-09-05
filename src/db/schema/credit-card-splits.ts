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
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "./credit-card-ledger";
import { people, personObligations } from "./people";

export const SPLIT_OPERATIONS = ["CREATE", "UPDATE", "VOID"] as const;
export type SplitOperation = (typeof SPLIT_OPERATIONS)[number];

export const SPLIT_METHODS = ["EQUAL", "MANUAL", "RATIO"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

/**
 * Credit Card Purchase Splits Table (Immutable Identity Anchor)
 * One split identity per credit card PURCHASE event.
 */
export const creditCardPurchaseSplits = pgTable(
	"credit_card_purchase_splits",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		purchaseEventId: uuid("purchase_event_id")
			.notNull()
			.references(() => creditCardLiabilityEvents.id, {
				onDelete: "restrict",
			}),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("credit_card_purchase_splits_purchase_event_id_uq").on(
			table.purchaseEventId,
		),
		index("credit_card_purchase_splits_user_id_idx").on(table.userId),
	],
);

/**
 * Credit Card Purchase Split Revisions Table (Append-Only Log)
 */
export const creditCardPurchaseSplitRevisions = pgTable(
	"credit_card_purchase_split_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		splitId: uuid("split_id")
			.notNull()
			.references(() => creditCardPurchaseSplits.id, {
				onDelete: "restrict",
			}),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => creditCardPurchaseSplitRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 32 }).notNull(),
		method: varchar("method", { length: 32 }).notNull(),
		purchaseEventRevisionId: uuid("purchase_event_revision_id")
			.notNull()
			.references(() => creditCardLiabilityEventRevisions.id, {
				onDelete: "restrict",
			}),
		grossAmount: numeric("gross_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		userShareAmount: numeric("user_share_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		externalShareAmount: numeric("external_share_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		userWeight: integer("user_weight"),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }),
		revisionFingerprint: varchar("revision_fingerprint", {
			length: 64,
		}).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("credit_card_purchase_split_revisions_split_revision_no_uq").on(
			table.splitId,
			table.revisionNo,
		),
		uniqueIndex(
			"credit_card_purchase_split_revisions_split_prev_revision_uq",
		).on(table.splitId, table.previousRevisionId),
		uniqueIndex(
			"credit_card_purchase_split_revisions_split_idempotency_key_uq",
		).on(table.splitId, table.idempotencyKey),
		index("credit_card_purchase_split_revisions_purchase_rev_idx").on(
			table.purchaseEventRevisionId,
		),
		index("credit_card_purchase_split_revisions_split_idx").on(table.splitId),
		check(
			"credit_card_purchase_split_revisions_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"credit_card_purchase_split_revisions_method_check",
			sql`${table.method} IN ('EQUAL', 'MANUAL', 'RATIO')`,
		),
		check(
			"credit_card_purchase_split_revisions_gross_amount_check",
			sql`${table.grossAmount} > 0`,
		),
		check(
			"credit_card_purchase_split_revisions_user_share_check",
			sql`${table.userShareAmount} >= 0`,
		),
		check(
			"credit_card_purchase_split_revisions_ext_share_check",
			sql`${table.externalShareAmount} >= 0`,
		),
		check(
			"credit_card_purchase_split_revisions_sum_check",
			sql`${table.grossAmount} = ${table.userShareAmount} + ${table.externalShareAmount}`,
		),
	],
);

/**
 * Credit Card Purchase Split Participants Table (Immutable Anchor)
 * Binds each participant identity to exactly one person and one People obligation.
 */
export const creditCardPurchaseSplitParticipants = pgTable(
	"credit_card_purchase_split_participants",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		splitId: uuid("split_id")
			.notNull()
			.references(() => creditCardPurchaseSplits.id, {
				onDelete: "restrict",
			}),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "restrict" }),
		personObligationId: uuid("person_obligation_id")
			.notNull()
			.references(() => personObligations.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("credit_card_purchase_split_participants_obligation_uq").on(
			table.personObligationId,
		),
		index("credit_card_purchase_split_participants_split_idx").on(
			table.splitId,
		),
		index("credit_card_purchase_split_participants_person_idx").on(
			table.personId,
		),
		index("credit_card_purchase_split_participants_user_idx").on(table.userId),
	],
);

/**
 * Credit Card Purchase Split Revision Items Table (Append-Only)
 */
export const creditCardPurchaseSplitRevisionItems = pgTable(
	"credit_card_purchase_split_revision_items",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		splitRevisionId: uuid("split_revision_id")
			.notNull()
			.references(() => creditCardPurchaseSplitRevisions.id, {
				onDelete: "restrict",
			}),
		participantId: uuid("participant_id")
			.notNull()
			.references(() => creditCardPurchaseSplitParticipants.id, {
				onDelete: "restrict",
			}),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "restrict" }),
		shareAmount: numeric("share_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		weight: integer("weight"),
		dueDate: date("due_date", { mode: "string" }),
		description: varchar("description", { length: 500 }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("credit_card_purchase_split_revision_items_rev_person_uq").on(
			table.splitRevisionId,
			table.personId,
		),
		uniqueIndex(
			"credit_card_purchase_split_revision_items_rev_participant_uq",
		).on(table.splitRevisionId, table.participantId),
		index("credit_card_purchase_split_revision_items_rev_idx").on(
			table.splitRevisionId,
		),
		check(
			"credit_card_purchase_split_revision_items_share_check",
			sql`${table.shareAmount} > 0`,
		),
	],
);

/**
 * Credit Card Purchase Split Revision Seals Table (Append-Only, DB-authoritative).
 * Exactly one row per split_revision_id, inserted LAST by the service after all
 * revision items have been written. Once sealed, a BEFORE INSERT trigger on
 * credit_card_purchase_split_revision_items rejects any further item referencing
 * that revision, making the historical snapshot immutable beyond INSERT-only
 * table semantics (which alone would still allow post-commit item appends).
 */
export const creditCardPurchaseSplitRevisionSeals = pgTable(
	"credit_card_purchase_split_revision_seals",
	{
		splitRevisionId: uuid("split_revision_id")
			.primaryKey()
			.references(() => creditCardPurchaseSplitRevisions.id, {
				onDelete: "restrict",
			}),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
);
