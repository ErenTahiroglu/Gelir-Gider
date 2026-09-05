import { describe, expect, it } from "vitest";
import migration0035Sql from "../migrations/0035_clever_rattler.sql?raw";

describe("Credit Card Splits Migration 0035 Verification", () => {
	const sql = migration0035Sql;

	it("contains DDL for split anchor, revisions, participants, and items tables", () => {
		expect(sql).toContain('CREATE TABLE "credit_card_purchase_splits"');
		expect(sql).toContain(
			'CREATE TABLE "credit_card_purchase_split_revisions"',
		);
		expect(sql).toContain(
			'CREATE TABLE "credit_card_purchase_split_participants"',
		);
		expect(sql).toContain(
			'CREATE TABLE "credit_card_purchase_split_revision_items"',
		);
	});

	it("contains immutability triggers on all 4 split tables", () => {
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_credit_card_purchase_splits",
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_revisions",
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_participants",
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_deny_mutation_credit_card_purchase_split_revision_items",
		);
	});

	it("contains revision insert trigger guard trg_guard_cc_split_revision_insert", () => {
		expect(sql).toContain("FUNCTION trg_fn_guard_cc_split_revision_insert()");
		expect(sql).toContain("CREATE TRIGGER trg_guard_cc_split_revision_insert");
	});

	it("contains revision items trigger guard trg_guard_cc_split_revision_items_insert", () => {
		expect(sql).toContain(
			"FUNCTION trg_fn_guard_cc_split_revision_items_insert()",
		);
		expect(sql).toContain(
			"CREATE TRIGGER trg_guard_cc_split_revision_items_insert",
		);
	});

	it("updates person obligation triggers for CREDIT_CARD_PURCHASE_SPLIT source type", () => {
		expect(sql).toContain("CREDIT_CARD_PURCHASE_SPLIT");
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_revision_insert()",
		);
		expect(sql).toContain(
			"CREATE OR REPLACE FUNCTION trg_fn_guard_person_obligation_ledger_effect()",
		);
	});

	it("contains deferred trigger for split commit and purchase binding completeness", () => {
		expect(sql).toContain("FUNCTION trg_fn_guard_cc_split_commit_check()");
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_cc_split_commit_check",
		);
		expect(sql).toContain(
			"FUNCTION trg_fn_guard_cc_purchase_split_binding_check()",
		);
		expect(sql).toContain(
			"CREATE CONSTRAINT TRIGGER trg_guard_cc_purchase_split_binding_check",
		);
	});
});
