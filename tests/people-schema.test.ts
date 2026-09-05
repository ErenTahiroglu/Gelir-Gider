import { describe, expect, it } from "vitest";
import migration0031Sql from "../migrations/0031_people_obligations_and_settlements.sql?raw";
import {
	PEOPLE_SYSTEM_INCOME_ROLES,
	PERSON_OBLIGATION_DIRECTIONS,
	PERSON_OBLIGATION_REVISION_OPERATIONS,
	PERSON_RELATIONSHIPS,
	PERSON_REVISION_OPERATIONS,
	PERSON_SETTLEMENT_REVISION_OPERATIONS,
	PERSON_STATUSES,
} from "../src/db/schema/people";

describe("People schema constants", () => {
	it("defines relationship, status, and direction enums", () => {
		expect(PERSON_RELATIONSHIPS).toEqual(["FAMILY", "FRIEND", "OTHER"]);
		expect(PERSON_STATUSES).toEqual(["ACTIVE", "ARCHIVED"]);
		expect(PERSON_OBLIGATION_DIRECTIONS).toEqual(["RECEIVABLE", "PAYABLE"]);
		expect(PERSON_REVISION_OPERATIONS).toEqual(["CREATE", "UPDATE", "ARCHIVE"]);
		expect(PERSON_OBLIGATION_REVISION_OPERATIONS).toEqual([
			"CREATE",
			"UPDATE",
			"VOID",
		]);
		expect(PERSON_SETTLEMENT_REVISION_OPERATIONS).toEqual(["CREATE", "VOID"]);
		expect(PEOPLE_SYSTEM_INCOME_ROLES).toEqual(["OVERPAYMENT_EXTRA"]);
	});
});

describe("Migration 0031", () => {
	const sql = migration0031Sql;

	it("creates all People domain tables", () => {
		for (const table of [
			'CREATE TABLE "people"',
			'CREATE TABLE "person_revisions"',
			'CREATE TABLE "person_ledger_links"',
			'CREATE TABLE "person_obligations"',
			'CREATE TABLE "person_obligation_revisions"',
			'CREATE TABLE "person_settlements"',
			'CREATE TABLE "person_settlement_revisions"',
			'CREATE TABLE "people_system_income_links"',
		]) {
			expect(sql).toContain(table);
		}
	});

	it("enforces canonical anchor completeness for all three People canonical kinds", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_canonical_transaction_anchors",
		);
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_people_canonical_transaction_anchors",
		);
		expect(sql).toContain('AFTER INSERT ON "canonical_transactions"');
		expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
		expect(sql).toContain("PERSON_RECEIVABLE_ADVANCE");
		expect(sql).toContain("PERSON_PAYABLE_EXPENSE");
		expect(sql).toContain("PERSON_OBLIGATION_SETTLEMENT");
	});

	it("guards against orphan canonical revisions for People kinds", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_orphan_canonical_revision",
		);
	});

	it("enforces obligation revision chain integrity and settlement limits", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert",
		);
		expect(sql).toContain("branching forbidden");
		expect(sql).toContain("below active settled amount");
	});

	it("enforces settlement oversettlement guard", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_settlement_revision_insert",
		);
		expect(sql).toContain("beyond principal");
	});

	it("extends ledger account archive protection for People accounts and system income source", () => {
		expect(sql).toContain("linked to a People receivable/payable account");
		expect(sql).toContain("linked to a People system income role");
	});

	it("extends income source archive protection for the People system income role", () => {
		expect(sql).toContain(
			"Cannot archive income source % because it is linked to a People system income role",
		);
	});

	it("enforces person subledger <-> ledger reconciliation and non-negative balances", () => {
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_people_ledger_reconciliation",
		);
		expect(sql).toContain("cannot become negative");
		expect(sql).toContain(
			"does not reconcile with derived obligation remaining",
		);
	});
});
