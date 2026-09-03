import { describe, expect, it } from "vitest";
import migration0013Sql from "../migrations/0013_sudden_hellcat.sql?raw";
import { transactionLedgerBindings } from "../src/db/schema/transaction-ledger";
import { CanonicalTransactionError } from "../src/transactions/errors";

describe("Transaction Ledger Binding Schema & Trigger Assertions", () => {
	it("exports transactionLedgerBindings table definition with correct column names", () => {
		expect(transactionLedgerBindings).toBeDefined();
		expect(transactionLedgerBindings.id).toBeDefined();
		expect(transactionLedgerBindings.userId).toBeDefined();
		expect(transactionLedgerBindings.transactionId).toBeDefined();
		expect(transactionLedgerBindings.revisionId).toBeDefined();
		expect(transactionLedgerBindings.previousBindingId).toBeDefined();
		expect(transactionLedgerBindings.appliedJournalEntryId).toBeDefined();
		expect(transactionLedgerBindings.reversalJournalEntryId).toBeDefined();
		expect(transactionLedgerBindings.createdAt).toBeDefined();
	});

	it("verifies migration 0013 contains table, indexes, and custom integrity triggers", () => {
		const content = migration0013Sql;

		// Table & Constraints
		expect(content).toContain('CREATE TABLE "transaction_ledger_bindings"');
		expect(content).toContain("transaction_ledger_bindings_distinct_check");
		expect(content).toContain("transaction_ledger_bindings_rev_idx");
		expect(content).toContain("transaction_ledger_bindings_prev_idx");
		expect(content).toContain("transaction_ledger_bindings_applied_idx");
		expect(content).toContain("transaction_ledger_bindings_reversal_idx");

		// Immutability trigger
		expect(content).toContain(
			"trg_fn_protect_transaction_ledger_bindings_immutability",
		);
		expect(content).toContain(
			"trg_protect_transaction_ledger_bindings_mutation",
		);
		expect(content).toContain(
			"transaction_ledger_bindings rows are immutable and cannot be updated or deleted",
		);

		// Insert Guard trigger
		expect(content).toContain(
			"trg_fn_guard_transaction_ledger_bindings_insert",
		);
		expect(content).toContain("trg_guard_transaction_ledger_bindings_insert");
		expect(content).toContain(
			"CREATE binding must have null previous_binding_id",
		);
		expect(content).toContain(
			"CREATE binding must not have reversal_journal_entry_id",
		);
		expect(content).toContain(
			"CREATE binding requires applied_journal_entry_id",
		);
		expect(content).toContain("UPDATE binding requires previous_binding_id");
		expect(content).toContain(
			"UPDATE binding requires reversal_journal_entry_id",
		);
		expect(content).toContain(
			"UPDATE binding requires applied_journal_entry_id",
		);
		expect(content).toContain("VOID binding requires previous_binding_id");
		expect(content).toContain(
			"VOID binding requires reversal_journal_entry_id",
		);
		expect(content).toContain(
			"VOID binding must not have applied_journal_entry_id",
		);
		expect(content).toContain(
			"Applied journal source must be CANONICAL_REVISION",
		);
		expect(content).toContain("Reversal journal source must be REVERSAL");
		expect(content).toContain("txrev:%:apply");
		expect(content).toContain("txrev:%:reverse");
	});

	it("verifies CanonicalTransactionError supports Phase 5B error codes", () => {
		const errIncomplete = new CanonicalTransactionError(
			"TRANSACTION_LEDGER_INCOMPLETE_STATE",
			"test message",
		);
		expect(errIncomplete.code).toBe("TRANSACTION_LEDGER_INCOMPLETE_STATE");
		expect(errIncomplete.name).toBe("CanonicalTransactionError");

		const errConflict = new CanonicalTransactionError(
			"TRANSACTION_LEDGER_EFFECT_CONFLICT",
			"test conflict",
		);
		expect(errConflict.code).toBe("TRANSACTION_LEDGER_EFFECT_CONFLICT");

		const errInvalid = new CanonicalTransactionError(
			"TRANSACTION_LEDGER_EFFECT_INVALID",
			"test invalid",
		);
		expect(errInvalid.code).toBe("TRANSACTION_LEDGER_EFFECT_INVALID");
	});
});
