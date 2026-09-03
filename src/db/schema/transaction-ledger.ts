import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	check,
	index,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { journalEntries } from "./ledger";
import { canonicalTransactions, transactionRevisions } from "./transactions";

export const transactionLedgerBindings = pgTable(
	"transaction_ledger_bindings",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => canonicalTransactions.id, { onDelete: "restrict" }),
		revisionId: uuid("revision_id")
			.notNull()
			.references(() => transactionRevisions.id, { onDelete: "restrict" }),
		previousBindingId: uuid("previous_binding_id").references(
			(): AnyPgColumn => transactionLedgerBindings.id,
			{ onDelete: "restrict" },
		),
		appliedJournalEntryId: uuid("applied_journal_entry_id").references(
			() => journalEntries.id,
			{ onDelete: "restrict" },
		),
		reversalJournalEntryId: uuid("reversal_journal_entry_id").references(
			() => journalEntries.id,
			{ onDelete: "restrict" },
		),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("transaction_ledger_bindings_rev_idx").on(table.revisionId),
		uniqueIndex("transaction_ledger_bindings_prev_idx")
			.on(table.previousBindingId)
			.where(sql`${table.previousBindingId} IS NOT NULL`),
		uniqueIndex("transaction_ledger_bindings_applied_idx")
			.on(table.appliedJournalEntryId)
			.where(sql`${table.appliedJournalEntryId} IS NOT NULL`),
		uniqueIndex("transaction_ledger_bindings_reversal_idx")
			.on(table.reversalJournalEntryId)
			.where(sql`${table.reversalJournalEntryId} IS NOT NULL`),
		index("transaction_ledger_bindings_tx_idx").on(table.transactionId),
		index("transaction_ledger_bindings_user_idx").on(table.userId),
		check(
			"transaction_ledger_bindings_distinct_check",
			sql`${table.appliedJournalEntryId} IS NULL OR ${table.reversalJournalEntryId} IS NULL OR ${table.appliedJournalEntryId} != ${table.reversalJournalEntryId}`,
		),
	],
);
