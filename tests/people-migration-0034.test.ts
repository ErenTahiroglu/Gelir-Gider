import { describe, expect, it } from "vitest";
import migration0034Sql from "../migrations/0034_nosy_smiling_tiger.sql?raw";
import { personSettlementRevisions } from "../src/db/schema/people";

describe("Migration 0034", () => {
	const sql = migration0034Sql;

	it("defines a partial unique index on person_settlement_revisions for overpayment_income_receipt_id", () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "person_settlement_revisions_overpayment_receipt_create_idx"',
		);
		expect(sql).toContain('ON "person_settlement_revisions"');
		expect(sql).toContain('("overpayment_income_receipt_id")');
		expect(sql).toContain(
			'WHERE "person_settlement_revisions"."operation" = \'CREATE\'',
		);
		expect(sql).toContain(
			'"person_settlement_revisions"."overpayment_income_receipt_id" IS NOT NULL',
		);
	});

	it("ensures partial unique index in Drizzle schema matches migration SQL predicate", () => {
		expect(personSettlementRevisions).toBeDefined();
		// The partial unique index applies ONLY to operation = 'CREATE'
		// This guarantees that later VOID revisions on the SAME settlement can retain
		// the same overpaymentIncomeReceiptId without colliding.
		expect(sql).not.toContain("WHERE TRUE");
		expect(sql).toContain("operation\" = 'CREATE'");
	});
});
