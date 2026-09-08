import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
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
import { creditCardLiabilityEvents } from "./credit-card-ledger";
import { creditCardPurchaseSplitRevisions } from "./credit-card-splits";
import {
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "./credit-cards";
import { people } from "./people";

/**
 * CREDIT-CARD STATEMENT RECONCILIATION LAYER (append-only, authoritative)
 *
 * Budget V2 must NOT infer a statement's personal / external composition from
 * `purchaseDate + statementDay/dueDay` calendar math. Instead a statement
 * revision is reconciled into EXPLICIT, STORED components:
 *
 *   PURCHASE   -- backed by an exact non-VOID purchase liability event (and,
 *                 optionally, the split revision that assigns its shares)
 *   ADJUSTMENT -- statement value not represented by a purchase (fee, interest,
 *                 carry-over, FX/adjustment, ...). Ownership is ALWAYS explicit,
 *                 never inferred.
 *
 * Every component carries explicit ownership: PERSONAL, or EXTERNAL_PERSON with
 * a `person_id` (family vs other-person reporting uses `person_revisions`
 * relationship truth downstream). A reconciliation revision becomes effective
 * only once SEALED; the seal guard (migration 0065) enforces
 *   SUM(component.amount) == reconciled_statement_amount   (kurus-exact)
 * and that `reconciled_statement_amount` equals the referenced statement
 * revision's `statement_amount`. Any statement whose latest reconciliation is
 * missing / unsealed / VOID / stale (statement revised after reconciliation)
 * is treated as NOT reconciled and every Budget-V2 metric that depends on its
 * decomposition FAILS CLOSED.
 *
 * NO canonical transaction, NO ledger posting, NO Midas movement, NO backfill.
 */

export const CC_STATEMENT_RECON_OPERATIONS = [
	"CREATE",
	"SUPERSEDE",
	"VOID",
] as const;
export type CcStatementReconOperation =
	(typeof CC_STATEMENT_RECON_OPERATIONS)[number];

export const CC_STATEMENT_RECON_COMPONENT_TYPES = [
	"PURCHASE",
	"ADJUSTMENT",
] as const;
export type CcStatementReconComponentType =
	(typeof CC_STATEMENT_RECON_COMPONENT_TYPES)[number];

export const CC_STATEMENT_RECON_OWNERSHIPS = [
	"PERSONAL",
	"EXTERNAL_PERSON",
] as const;
export type CcStatementReconOwnership =
	(typeof CC_STATEMENT_RECON_OWNERSHIPS)[number];

export const CC_STATEMENT_RECON_ADJUSTMENT_KINDS = [
	"FEE",
	"INTEREST",
	"CARRY_OVER",
	"FX_ADJUSTMENT",
	"OTHER",
] as const;
export type CcStatementReconAdjustmentKind =
	(typeof CC_STATEMENT_RECON_ADJUSTMENT_KINDS)[number];

/** Immutable anchor: exactly one reconciliation identity per statement. */
export const creditCardStatementReconciliations = pgTable(
	"credit_card_statement_reconciliations",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		statementId: uuid("statement_id")
			.notNull()
			.references(() => creditCardStatements.id, { onDelete: "restrict" }),
		creditCardId: uuid("credit_card_id")
			.notNull()
			.references(() => creditCards.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("ccsr_statement_idx").on(table.statementId),
		index("ccsr_user_idx").on(table.userId),
		index("ccsr_card_idx").on(table.creditCardId),
	],
);

/** Append-only reconciliation revision chain for a statement. */
export const creditCardStatementReconciliationRevisions = pgTable(
	"credit_card_statement_reconciliation_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		reconciliationId: uuid("reconciliation_id")
			.notNull()
			.references(() => creditCardStatementReconciliations.id, {
				onDelete: "restrict",
			}),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => creditCardStatementReconciliationRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 12 }).notNull(), // CREATE|SUPERSEDE|VOID
		statementRevisionId: uuid("statement_revision_id")
			.notNull()
			.references(() => creditCardStatementRevisions.id, {
				onDelete: "restrict",
			}),
		reconciledStatementAmount: numeric("reconciled_statement_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		componentCount: integer("component_count").notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		reconciliationFingerprint: varchar("reconciliation_fingerprint", {
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
		uniqueIndex("ccsrr_recon_rev_no_idx").on(
			table.reconciliationId,
			table.revisionNo,
		),
		uniqueIndex("ccsrr_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("ccsrr_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("ccsrr_recon_idx").on(table.reconciliationId),
		index("ccsrr_stmt_rev_idx").on(table.statementRevisionId),
		check("ccsrr_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"ccsrr_op_check",
			sql`${table.operation} IN ('CREATE', 'SUPERSEDE', 'VOID')`,
		),
		check("ccsrr_amount_check", sql`${table.reconciledStatementAmount} > 0`),
		check("ccsrr_component_count_check", sql`${table.componentCount} >= 0`),
		check(
			"ccsrr_fingerprint_check",
			sql`${table.reconciliationFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"ccsrr_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
	],
);

/** Append-only components of a reconciliation revision. */
export const creditCardStatementReconciliationComponents = pgTable(
	"credit_card_statement_reconciliation_components",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		reconciliationRevisionId: uuid("reconciliation_revision_id")
			.notNull()
			.references(() => creditCardStatementReconciliationRevisions.id, {
				onDelete: "restrict",
			}),
		componentNo: integer("component_no").notNull(),
		componentType: varchar("component_type", { length: 12 }).notNull(),
		amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
		ownership: varchar("ownership", { length: 16 }).notNull(),
		personId: uuid("person_id").references(() => people.id, {
			onDelete: "restrict",
		}),
		purchaseEventId: uuid("purchase_event_id").references(
			() => creditCardLiabilityEvents.id,
			{ onDelete: "restrict" },
		),
		purchaseSplitRevisionId: uuid("purchase_split_revision_id").references(
			() => creditCardPurchaseSplitRevisions.id,
			{ onDelete: "restrict" },
		),
		adjustmentKind: varchar("adjustment_kind", { length: 16 }),
		note: varchar("note", { length: 500 }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("ccsrc_rev_component_no_idx").on(
			table.reconciliationRevisionId,
			table.componentNo,
		),
		index("ccsrc_rev_idx").on(table.reconciliationRevisionId),
		index("ccsrc_purchase_event_idx").on(table.purchaseEventId),
		index("ccsrc_person_idx").on(table.personId),
		check("ccsrc_component_no_check", sql`${table.componentNo} > 0`),
		check(
			"ccsrc_type_check",
			sql`${table.componentType} IN ('PURCHASE', 'ADJUSTMENT')`,
		),
		check("ccsrc_amount_check", sql`${table.amount} > 0`),
		check(
			"ccsrc_ownership_check",
			sql`${table.ownership} IN ('PERSONAL', 'EXTERNAL_PERSON')`,
		),
		check(
			"ccsrc_ownership_person_consistency_check",
			sql`(${table.ownership} = 'EXTERNAL_PERSON' AND ${table.personId} IS NOT NULL) OR (${table.ownership} = 'PERSONAL' AND ${table.personId} IS NULL)`,
		),
		check(
			"ccsrc_type_reference_consistency_check",
			sql`(${table.componentType} = 'PURCHASE' AND ${table.purchaseEventId} IS NOT NULL AND ${table.adjustmentKind} IS NULL) OR (${table.componentType} = 'ADJUSTMENT' AND ${table.purchaseEventId} IS NULL AND ${table.purchaseSplitRevisionId} IS NULL AND ${table.adjustmentKind} IS NOT NULL)`,
		),
		check(
			"ccsrc_adjustment_kind_check",
			sql`${table.adjustmentKind} IS NULL OR ${table.adjustmentKind} IN ('FEE', 'INTEREST', 'CARRY_OVER', 'FX_ADJUSTMENT', 'OTHER')`,
		),
		check(
			"ccsrc_note_check",
			sql`${table.note} IS NULL OR (${table.note} = btrim(${table.note}) AND length(${table.note}) BETWEEN 1 AND 500)`,
		),
	],
);

/**
 * Append-only seal: exactly one row per reconciliation revision, inserted LAST
 * by the service after every component is written. The seal guard verifies the
 * kurus-exact component sum; a BEFORE INSERT trigger on the components table
 * rejects any further component once the seal exists. VOID revisions carry no
 * components and are never sealed.
 */
export const creditCardStatementReconciliationSeals = pgTable(
	"credit_card_statement_reconciliation_seals",
	{
		reconciliationRevisionId: uuid("reconciliation_revision_id")
			.primaryKey()
			.references(() => creditCardStatementReconciliationRevisions.id, {
				onDelete: "restrict",
			}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
);
