import { describe, expect, it } from "vitest";
import migration0015Sql from "../migrations/0015_harden_income_projection_integrity.sql?raw";
import migration0016Sql from "../migrations/0016_brief_unicorn.sql?raw";
import migration0017Sql from "../migrations/0017_harden_income_settlement_serialization.sql?raw";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../src/db/schema/income";
import {
	incomeEntitlementRevisions,
	incomeEntitlements,
	incomeSettlementBatches,
	incomeSettlementBatchRevisions,
} from "../src/db/schema/income-entitlements";

describe("Income Schema Definitions", () => {
	it("defines income_sources table structure properly", () => {
		expect(incomeSources).toBeDefined();
		expect(incomeSources.id).toBeDefined();
		expect(incomeSources.userId).toBeDefined();
		expect(incomeSources.code).toBeDefined();
		expect(incomeSources.name).toBeDefined();
		expect(incomeSources.nature).toBeDefined();
		expect(incomeSources.referenceMethod).toBeDefined();
		expect(incomeSources.expectedMonthlyAmount).toBeDefined();
		expect(incomeSources.seasonalMonthsPerYear).toBeDefined();
		expect(incomeSources.rollingMedianMonths).toBeDefined();
		expect(incomeSources.incomeLedgerAccountId).toBeDefined();
		expect(incomeSources.activeFrom).toBeDefined();
		expect(incomeSources.activeUntil).toBeDefined();
		expect(incomeSources.createdAt).toBeDefined();
		expect(incomeSources.archivedAt).toBeDefined();
	});

	it("defines income_receipts table structure properly", () => {
		expect(incomeReceipts).toBeDefined();
		expect(incomeReceipts.id).toBeDefined();
		expect(incomeReceipts.userId).toBeDefined();
		expect(incomeReceipts.sourceId).toBeDefined();
		expect(incomeReceipts.canonicalTransactionId).toBeDefined();
		expect(incomeReceipts.createdAt).toBeDefined();
	});

	it("defines income_receipt_revisions table structure properly", () => {
		expect(incomeReceiptRevisions).toBeDefined();
		expect(incomeReceiptRevisions.id).toBeDefined();
		expect(incomeReceiptRevisions.userId).toBeDefined();
		expect(incomeReceiptRevisions.incomeReceiptId).toBeDefined();
		expect(incomeReceiptRevisions.canonicalRevisionId).toBeDefined();
		expect(incomeReceiptRevisions.revisionNo).toBeDefined();
		expect(incomeReceiptRevisions.previousReceiptRevisionId).toBeDefined();
		expect(incomeReceiptRevisions.operation).toBeDefined();
		expect(incomeReceiptRevisions.occurredAt).toBeDefined();
		expect(incomeReceiptRevisions.amount).toBeDefined();
		expect(incomeReceiptRevisions.destinationAccountId).toBeDefined();
		expect(incomeReceiptRevisions.note).toBeDefined();
		expect(incomeReceiptRevisions.createdAt).toBeDefined();
	});

	it("defines income_entitlements and revisions table structure properly", () => {
		expect(incomeEntitlements).toBeDefined();
		expect(incomeEntitlements.id).toBeDefined();
		expect(incomeEntitlements.userId).toBeDefined();
		expect(incomeEntitlements.sourceId).toBeDefined();
		expect(incomeEntitlements.periodMonth).toBeDefined();
		expect(incomeEntitlements.canonicalTransactionId).toBeDefined();

		expect(incomeEntitlementRevisions).toBeDefined();
		expect(incomeEntitlementRevisions.id).toBeDefined();
		expect(incomeEntitlementRevisions.userId).toBeDefined();
		expect(incomeEntitlementRevisions.entitlementId).toBeDefined();
		expect(incomeEntitlementRevisions.canonicalRevisionId).toBeDefined();
		expect(incomeEntitlementRevisions.revisionNo).toBeDefined();
		expect(incomeEntitlementRevisions.operation).toBeDefined();
		expect(incomeEntitlementRevisions.amount).toBeDefined();
		expect(incomeEntitlementRevisions.expectedReceiptOn).toBeDefined();
		expect(incomeEntitlementRevisions.note).toBeDefined();
	});

	it("defines income_settlement_batches and revisions table structure properly", () => {
		expect(incomeSettlementBatches).toBeDefined();
		expect(incomeSettlementBatches.id).toBeDefined();
		expect(incomeSettlementBatches.userId).toBeDefined();
		expect(incomeSettlementBatches.incomeReceiptId).toBeDefined();
		expect(incomeSettlementBatches.canonicalTransactionId).toBeDefined();

		expect(incomeSettlementBatchRevisions).toBeDefined();
		expect(incomeSettlementBatchRevisions.id).toBeDefined();
		expect(incomeSettlementBatchRevisions.userId).toBeDefined();
		expect(incomeSettlementBatchRevisions.settlementBatchId).toBeDefined();
		expect(incomeSettlementBatchRevisions.canonicalRevisionId).toBeDefined();
		expect(incomeSettlementBatchRevisions.revisionNo).toBeDefined();
		expect(incomeSettlementBatchRevisions.operation).toBeDefined();
		expect(incomeSettlementBatchRevisions.allocations).toBeDefined();
		expect(incomeSettlementBatchRevisions.note).toBeDefined();
	});

	it("verifies migration 0015 contains hardened trigger checks", () => {
		const sql = migration0015Sql;

		// Required payload keys check
		expect(sql).toContain("v_rev.payload ? 'incomeSourceId'");
		expect(sql).toContain("v_rev.payload ? 'amount'");
		expect(sql).toContain("v_rev.payload ? 'destinationAccountId'");
		expect(sql).toContain("v_rev.payload ? 'note'");

		// Exact textual string equality
		expect(sql).toContain("(v_rev.payload->>'amount') != (NEW.amount::text)");
		expect(sql).toContain(
			"(v_rev.payload->>'incomeSourceId') != (v_receipt.source_id::text)",
		);
		expect(sql).toContain(
			"(v_rev.payload->>'destinationAccountId') != (NEW.destination_account_id::text)",
		);

		// Source ownership checks
		expect(sql).toContain("v_source.user_id != NEW.user_id");
		expect(sql).toContain("v_source.user_id != v_receipt.user_id");

		// Note type and exact matching checks
		expect(sql).toContain("jsonb_typeof(v_rev.payload->'note') = 'null'");
		expect(sql).toContain("jsonb_typeof(v_rev.payload->'note') = 'string'");
	});

	it("verifies migration 0016 contains hardened triggers for entitlements and settlements", () => {
		const sql = migration0016Sql;

		// Tables
		expect(sql).toContain('CREATE TABLE "income_entitlements"');
		expect(sql).toContain('CREATE TABLE "income_entitlement_revisions"');
		expect(sql).toContain('CREATE TABLE "income_settlement_batches"');
		expect(sql).toContain('CREATE TABLE "income_settlement_batch_revisions"');

		// Immutability triggers
		expect(sql).toContain("trg_guard_income_entitlements_immutability");
		expect(sql).toContain(
			"trg_guard_income_entitlement_revisions_immutability",
		);
		expect(sql).toContain("trg_guard_income_settlement_batches_immutability");
		expect(sql).toContain(
			"trg_guard_income_settlement_batch_revisions_immutability",
		);

		// Trigger functions
		expect(sql).toContain("trg_fn_guard_income_entitlement_revisions_insert");
		expect(sql).toContain(
			"trg_fn_guard_income_settlement_batch_revisions_insert",
		);

		// Entitlement payload checks
		expect(sql).toContain("v_rev.payload ? 'incomeSourceId'");
		expect(sql).toContain("v_rev.payload ? 'periodMonth'");
		expect(sql).toContain("v_rev.payload ? 'amount'");
		expect(sql).toContain("v_rev.payload ? 'expectedReceiptOn'");
		expect(sql).toContain("v_rev.payload ? 'note'");

		// Settlement payload checks
		expect(sql).toContain("v_rev.payload ? 'incomeReceiptId'");
		expect(sql).toContain("v_rev.payload ? 'allocations'");
		expect(sql).toContain("v_rev.payload ? 'note'");
	});

	it("verifies migration 0017 contains hardened concurrency locks and cross-domain invariants", () => {
		const sql = migration0017Sql;

		// Receipt trigger locks receipt and guards against allocation reduction / void
		expect(sql).toContain("trg_fn_guard_income_receipt_revisions_insert");
		expect(sql).toContain("FOR UPDATE");
		expect(sql).toContain("Cannot reduce receipt amount");
		expect(sql).toContain(
			"Cannot void income receipt with active settlement allocations",
		);

		// Entitlement trigger locks entitlement and guards against allocation reduction / void
		expect(sql).toContain("trg_fn_guard_income_entitlement_revisions_insert");
		expect(sql).toContain("Europe/Istanbul");
		expect(sql).toContain("Cannot reduce entitlement amount");
		expect(sql).toContain(
			"Cannot void income entitlement with active settlement allocations",
		);

		// Settlement trigger locks receipt and referenced entitlements deterministically
		expect(sql).toContain(
			"trg_fn_guard_income_settlement_batch_revisions_insert",
		);
		expect(sql).toContain("ORDER BY id ASC");
		expect(sql).toContain("FOR UPDATE");
		expect(sql).toContain("jsonb_object_keys(v_alloc_elem)");
		expect(sql).toContain(
			"jsonb_typeof(v_alloc_elem->'entitlementId') != 'string'",
		);
		expect(sql).toContain(
			"Total allocations % exceed active income receipt amount %",
		);
		expect(sql).toContain(
			"Total allocation % exceeds active entitlement amount %",
		);
	});
});
