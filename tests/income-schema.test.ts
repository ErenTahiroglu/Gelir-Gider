import { describe, expect, it } from "vitest";
import migration0015Sql from "../migrations/0015_harden_income_projection_integrity.sql?raw";
import {
	incomeReceiptRevisions,
	incomeReceipts,
	incomeSources,
} from "../src/db/schema/income";

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
});
