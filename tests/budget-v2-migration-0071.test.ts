import { describe, expect, it } from "vitest";
import migration0071Sql from "../migrations/0071_add_budget_v2_recommendation_feedback.sql?raw";
import journal from "../migrations/meta/_journal.json";
import snapshot0071 from "../migrations/meta/0071_snapshot.json";
import { computeRestoreOrderFromSchema } from "../scripts/restore-backup";
import { getBackupTableDescriptors } from "../src/backups/registry";
import {
	BUDGET_V2_RECOMMENDATION_FEEDBACK_DECISIONS,
	BUDGET_V2_RECOMMENDATION_FEEDBACK_OPERATIONS,
	BUDGET_V2_RECOMMENDATION_FEEDBACK_SOURCE_KINDS,
} from "../src/db/schema/budget-v2-recommendation-feedback";

const sql = migration0071Sql;
const T_INST = "budget_v2_recommendation_instances";
const T_REV = "budget_v2_recommendation_feedback_revisions";

describe("Migration 0071 -- Budget V2 recommendation feedback lifecycle", () => {
	it("is journal entry idx 71 with a strictly-increasing `when`", () => {
		const entries = journal.entries as Array<{
			idx: number;
			when: number;
			tag: string;
		}>;
		const at = entries.findIndex((e) => e.idx === 71);
		expect(at).toBeGreaterThan(0);
		expect(entries[at]?.tag).toBe("0071_add_budget_v2_recommendation_feedback");
		expect(entries[at]?.when).toBeGreaterThan(entries[at - 1]?.when ?? 0);
	});

	it("creates immutable recommendation instances and append-only feedback revisions tables", () => {
		expect(sql).toContain(`CREATE TABLE "${T_INST}"`);
		expect(sql).toContain(`CREATE TABLE "${T_REV}"`);
		expect(sql).toContain('"recommendation_fingerprint" varchar(64) NOT NULL');
		expect(sql).toContain('"revision_fingerprint" varchar(64) NOT NULL');
		expect(sql).toMatch(
			new RegExp(
				`"operation" IN \\('${BUDGET_V2_RECOMMENDATION_FEEDBACK_OPERATIONS.join("', '")}'\\)`,
			),
		);
		expect(sql).toMatch(
			new RegExp(
				`"decision" IN \\('${BUDGET_V2_RECOMMENDATION_FEEDBACK_DECISIONS.join("', '")}'\\)`,
			),
		);
		expect(sql).toMatch(
			new RegExp(
				`"source_kind" IN \\('${BUDGET_V2_RECOMMENDATION_FEEDBACK_SOURCE_KINDS.join("', '")}'\\)`,
			),
		);
	});

	it("enforces closed recommendation kinds and fingerprint hex formats", () => {
		expect(sql).toContain("bv2recinst_fingerprint_check");
		expect(sql).toContain("bv2recinst_kind_check");
		expect(sql).toContain("bv2recfb_fingerprint_check");
		expect(sql).toContain("bv2recfb_decision_mod_check");
		expect(sql).toContain("bv2recfb_chain_check");
	});

	it("has a Drizzle metadata snapshot chaining from 0070_snapshot.json", () => {
		const snap = snapshot0071 as {
			version: string;
			dialect: string;
			prevId: string;
			tables: Record<string, unknown>;
		};
		expect(snap.version).toBe("7");
		expect(snap.dialect).toBe("postgresql");
		expect(snap.tables[`public.${T_INST}`]).toBeTruthy();
		expect(snap.tables[`public.${T_REV}`]).toBeTruthy();
	});

	it("adds immutability and insert validation triggers to both tables", () => {
		expect(sql).toContain("trg_guard_bv2rec_instances_immutability");
		expect(sql).toContain("trg_guard_bv2rec_instances_insert");
		expect(sql).toContain("trg_guard_bv2rec_feedback_revisions_immutability");
		expect(sql).toContain("trg_guard_bv2rec_feedback_revisions_insert");
	});

	it("is discovered automatically by backup registry and is topologically ordered for restore", () => {
		const descriptors = getBackupTableDescriptors();
		const instDesc = descriptors.find((d) => d.tableName === T_INST);
		const revDesc = descriptors.find((d) => d.tableName === T_REV);

		expect(instDesc).toBeDefined();
		expect(revDesc).toBeDefined();

		const restoreOrder = computeRestoreOrderFromSchema();
		const usersIdx = restoreOrder.indexOf("users");
		const snapIdx = restoreOrder.indexOf("budget_v2_checkpoint_snapshots");
		const payEventIdx = restoreOrder.indexOf(
			"credit_card_statement_payment_events",
		);
		const instIdx = restoreOrder.indexOf(T_INST);
		const revIdx = restoreOrder.indexOf(T_REV);

		expect(usersIdx).toBeGreaterThanOrEqual(0);
		expect(snapIdx).toBeGreaterThanOrEqual(0);
		expect(payEventIdx).toBeGreaterThanOrEqual(0);
		expect(instIdx).toBeGreaterThanOrEqual(0);
		expect(revIdx).toBeGreaterThanOrEqual(0);

		// Parents must be restored BEFORE instances
		expect(instIdx).toBeGreaterThan(usersIdx);
		expect(instIdx).toBeGreaterThan(snapIdx);
		expect(instIdx).toBeGreaterThan(payEventIdx);

		// Instances must be restored BEFORE feedback revisions
		expect(revIdx).toBeGreaterThan(instIdx);
		expect(revIdx).toBeGreaterThan(usersIdx);
	});
});
