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
import {
	creditCardLiabilityEventRevisions,
	creditCardLiabilityEvents,
} from "./credit-card-ledger";
import { creditCardPurchaseSplitRevisions } from "./credit-card-splits";
import { personObligationRevisions, personObligations } from "./people";

/**
 * PERSONAL_BUDGET_V2 -- EXPLICIT SPENDING FOOD SEMANTICS (append-only)
 *
 * Additive, append-only metadata that lets the Budget V2 checkpoint report
 * decompose personal spending into food vs non-food EXACTLY:
 *
 *   FOOD_TOTAL       = FOOD_HOME_MARKET + FOOD_OUTSIDE
 *   nonFoodAmount    = basisPersonalAmount - FOOD_TOTAL
 *
 * The classification is STORED semantic truth approved by the user. It is
 * never inferred from merchant / description / MCC / card / time / amount /
 * location / behaviour. A future engine may SUGGEST an allocation, but a row
 * here always represents an explicit user approval (`source_kind`).
 *
 * Mixed spend is first-class: a single personal economic amount can be split
 * into home/market food, outside food, and an implicit non-food remainder.
 * "No classification row" is NOT the same as NON_FOOD; an explicit NON_FOOD
 * decision is a row with both food amounts zero.
 *
 * This projection carries NO ledger posting, NO canonical transaction, NO
 * Midas movement, NO statement-liability change and NO People-principal
 * change. The immutable financial source (the credit-card purchase event, or
 * the People PAYABLE obligation) stays the sole economic record.
 */

export const SPENDING_FOOD_SUBJECT_TYPES = [
	"CREDIT_CARD_PURCHASE",
	"PEOPLE_PAYABLE",
] as const;
export type SpendingFoodSubjectType =
	(typeof SPENDING_FOOD_SUBJECT_TYPES)[number];

export const SPENDING_FOOD_OPERATIONS = ["CREATE", "UPDATE", "VOID"] as const;
export type SpendingFoodOperation = (typeof SPENDING_FOOD_OPERATIONS)[number];

export const SPENDING_FOOD_SOURCE_KINDS = [
	"USER_APPROVED",
	"USER_APPROVED_FROM_SUGGESTION",
] as const;
export type SpendingFoodSourceKind =
	(typeof SPENDING_FOOD_SOURCE_KINDS)[number];

/**
 * How `basis_personal_amount` was derived from the credit-card purchase's
 * authoritative economic split as of the classification command time (see
 * Checkpoint 4B.3's `resolveAuthoritativePurchaseSplitAsOf`). Not stored for
 * PEOPLE_PAYABLE subjects (their basis is the obligation principal).
 */
export const SPENDING_FOOD_SPLIT_BASES = [
	"NO_SPLIT",
	"VOID_SPLIT",
	"SEALED_SPLIT_AS_OF",
] as const;
export type SpendingFoodSplitBasis = (typeof SPENDING_FOOD_SPLIT_BASES)[number];

export const budgetV2SpendingFoodSemanticRevisions = pgTable(
	"budget_v2_spending_food_semantic_revisions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		subjectType: varchar("subject_type", { length: 32 }).notNull(),
		// Exactly one of the two subject identities is present, consistent with
		// `subject_type` (DB CHECK + BEFORE INSERT guard).
		purchaseEventId: uuid("purchase_event_id").references(
			() => creditCardLiabilityEvents.id,
			{ onDelete: "restrict" },
		),
		personObligationId: uuid("person_obligation_id").references(
			() => personObligations.id,
			{ onDelete: "restrict" },
		),
		revisionNo: integer("revision_no").notNull(),
		previousRevisionId: uuid("previous_revision_id").references(
			(): AnyPgColumn => budgetV2SpendingFoodSemanticRevisions.id,
			{ onDelete: "restrict" },
		),
		operation: varchar("operation", { length: 10 }).notNull(), // CREATE | UPDATE | VOID
		basisPersonalAmount: numeric("basis_personal_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		foodHomeMarketAmount: numeric("food_home_market_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		foodOutsideAmount: numeric("food_outside_amount", {
			precision: 18,
			scale: 2,
		}).notNull(),
		sourceKind: varchar("source_kind", { length: 32 }).notNull(),
		// Evidence proving the basis (the financial source state the user
		// approved against). Kept for every operation, VOID included.
		purchaseEventRevisionId: uuid("purchase_event_revision_id").references(
			() => creditCardLiabilityEventRevisions.id,
			{ onDelete: "restrict" },
		),
		personObligationRevisionId: uuid(
			"person_obligation_revision_id",
		).references(() => personObligationRevisions.id, { onDelete: "restrict" }),
		splitBasis: varchar("split_basis", { length: 24 }),
		splitRevisionId: uuid("split_revision_id").references(
			() => creditCardPurchaseSplitRevisions.id,
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
		uniqueIndex("bv2food_purchase_rev_no_idx")
			.on(table.purchaseEventId, table.revisionNo)
			.where(sql`${table.purchaseEventId} IS NOT NULL`),
		uniqueIndex("bv2food_obligation_rev_no_idx")
			.on(table.personObligationId, table.revisionNo)
			.where(sql`${table.personObligationId} IS NOT NULL`),
		uniqueIndex("bv2food_prev_idx")
			.on(table.previousRevisionId)
			.where(sql`${table.previousRevisionId} IS NOT NULL`),
		uniqueIndex("bv2food_user_idempotency_idx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("bv2food_user_purchase_idx").on(table.userId, table.purchaseEventId),
		index("bv2food_user_obligation_idx").on(
			table.userId,
			table.personObligationId,
		),
		check("bv2food_rev_no_check", sql`${table.revisionNo} > 0`),
		check(
			"bv2food_op_check",
			sql`${table.operation} IN ('CREATE', 'UPDATE', 'VOID')`,
		),
		check(
			"bv2food_subject_type_check",
			sql`${table.subjectType} IN ('CREDIT_CARD_PURCHASE', 'PEOPLE_PAYABLE')`,
		),
		check(
			"bv2food_source_kind_check",
			sql`${table.sourceKind} IN ('USER_APPROVED', 'USER_APPROVED_FROM_SUGGESTION')`,
		),
		check(
			"bv2food_fingerprint_check",
			sql`${table.revisionFingerprint} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"bv2food_idempotency_check",
			sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND length(${table.idempotencyKey}) BETWEEN 1 AND 128`,
		),
		check("bv2food_home_nonneg_check", sql`${table.foodHomeMarketAmount} >= 0`),
		check("bv2food_outside_nonneg_check", sql`${table.foodOutsideAmount} >= 0`),
		check(
			"bv2food_basis_positive_check",
			sql`${table.basisPersonalAmount} > 0`,
		),
		check(
			"bv2food_food_sum_check",
			sql`${table.foodHomeMarketAmount} + ${table.foodOutsideAmount} <= ${table.basisPersonalAmount}`,
		),
		// A VOID revision removes the classification -- it carries no food.
		check(
			"bv2food_void_zero_food_check",
			sql`${table.operation} <> 'VOID' OR (${table.foodHomeMarketAmount} = 0 AND ${table.foodOutsideAmount} = 0)`,
		),
		// Polymorphic subject identity: exactly one identity, consistent with
		// subject_type, and the wrong subject's evidence columns stay NULL.
		check(
			"bv2food_subject_identity_check",
			sql`(
				${table.subjectType} = 'CREDIT_CARD_PURCHASE'
				AND ${table.purchaseEventId} IS NOT NULL
				AND ${table.personObligationId} IS NULL
				AND ${table.personObligationRevisionId} IS NULL
			) OR (
				${table.subjectType} = 'PEOPLE_PAYABLE'
				AND ${table.personObligationId} IS NOT NULL
				AND ${table.purchaseEventId} IS NULL
				AND ${table.purchaseEventRevisionId} IS NULL
				AND ${table.splitBasis} IS NULL
				AND ${table.splitRevisionId} IS NULL
			)`,
		),
		check(
			"bv2food_split_basis_check",
			sql`${table.splitBasis} IS NULL OR ${table.splitBasis} IN ('NO_SPLIT', 'VOID_SPLIT', 'SEALED_SPLIT_AS_OF')`,
		),
		check(
			"bv2food_sealed_split_rev_check",
			sql`${table.splitBasis} <> 'SEALED_SPLIT_AS_OF' OR ${table.splitRevisionId} IS NOT NULL`,
		),
		// A credit-card subject always proves its basis with the effective
		// purchase revision + the split basis it was resolved against.
		check(
			"bv2food_cc_evidence_check",
			sql`${table.subjectType} <> 'CREDIT_CARD_PURCHASE' OR (${table.purchaseEventRevisionId} IS NOT NULL AND ${table.splitBasis} IS NOT NULL)`,
		),
		// A People PAYABLE subject always proves its basis with the effective
		// obligation revision.
		check(
			"bv2food_people_evidence_check",
			sql`${table.subjectType} <> 'PEOPLE_PAYABLE' OR ${table.personObligationRevisionId} IS NOT NULL`,
		),
		check(
			"bv2food_create_chain_check",
			sql`${table.revisionNo} <> 1 OR (${table.previousRevisionId} IS NULL AND ${table.operation} = 'CREATE')`,
		),
		check(
			"bv2food_noncreate_chain_check",
			sql`${table.revisionNo} = 1 OR (${table.previousRevisionId} IS NOT NULL AND ${table.operation} IN ('UPDATE', 'VOID'))`,
		),
	],
);
