import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migration0022Sql from "../migrations/0022_hot_mystique.sql?raw";
import {
	SHORT_TERM_GOAL_FUNDING_STATUSES,
	SHORT_TERM_GOAL_OPERATIONS,
	SHORT_TERM_GOAL_STATUSES,
	shortTermGoalPriorityRevisions,
	shortTermGoalRevisions,
	shortTermGoals,
} from "../src/db/schema/short-term-goals";

describe("Short-Term Goals Schema Definitions (Phase 9)", () => {
	it("exports short_term_goals anchor table with exact physical identity columns and NO duplicate balance column", () => {
		const cols = getTableColumns(shortTermGoals);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.midasAccountId.dataType).toBe("string");
		expect(cols.midasBucketId.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");

		// Crucial architectural invariant: NO duplicate accumulated/saved column
		expect(
			(cols as Record<string, unknown>).accumulated_amount,
		).toBeUndefined();
		expect((cols as Record<string, unknown>).saved_amount).toBeUndefined();
		expect((cols as Record<string, unknown>).current_funding).toBeUndefined();
		expect((cols as Record<string, unknown>).balance).toBeUndefined();
	});

	it("exports short_term_goal_revisions append-only table with all configuration and lifecycle columns", () => {
		const cols = getTableColumns(shortTermGoalRevisions);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.goalId.dataType).toBe("string");
		expect(cols.revisionNo.dataType).toBe("number");
		expect(cols.previousRevisionId.dataType).toBe("string");
		expect(cols.operation.dataType).toBe("string");
		expect(cols.status.dataType).toBe("string");
		expect(cols.name.dataType).toBe("string");
		expect(cols.fundingTarget.dataType).toBe("string");
		expect(cols.targetDate.dataType).toBe("string");
		expect(cols.maxBudget.dataType).toBe("string");
		expect(cols.targetPrice.dataType).toBe("string");
		expect(cols.productUrl.dataType).toBe("string");
		expect(cols.note.dataType).toBe("string");
		expect(cols.changeReason.dataType).toBe("string");
		expect(cols.occurredAt.dataType).toBe("date");
		expect(cols.idempotencyKey.dataType).toBe("string");
		expect(cols.revisionFingerprint.dataType).toBe("string");
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("exports short_term_goal_priority_revisions append-only table with ordered array and fingerprint", () => {
		const cols = getTableColumns(shortTermGoalPriorityRevisions);
		expect(cols.id.dataType).toBe("string");
		expect(cols.userId.dataType).toBe("string");
		expect(cols.midasAccountId.dataType).toBe("string");
		expect(cols.revisionNo.dataType).toBe("number");
		expect(cols.previousRevisionId.dataType).toBe("string");
		expect(cols.orderedGoalIds.dataType).toBe("json");
		expect(cols.idempotencyKey.dataType).toBe("string");
		expect(cols.priorityFingerprint.dataType).toBe("string");
		expect(cols.occurredAt.dataType).toBe("date");
		expect(cols.createdAt.dataType).toBe("date");
	});

	it("exports domain enum constants", () => {
		expect(SHORT_TERM_GOAL_STATUSES).toEqual([
			"ACTIVE",
			"COMPLETED",
			"CANCELLED",
		]);
		expect(SHORT_TERM_GOAL_OPERATIONS).toEqual([
			"CREATE",
			"UPDATE",
			"COMPLETE",
			"CANCEL",
		]);
		expect(SHORT_TERM_GOAL_FUNDING_STATUSES).toEqual([
			"EMPTY",
			"PARTIAL",
			"TARGET_REACHED",
		]);
	});

	it("verifies migration 0022 contains required DDL, immutability triggers, and guard triggers", () => {
		const sql = migration0022Sql;

		// Tables
		expect(sql).toContain('CREATE TABLE "short_term_goals"');
		expect(sql).toContain('CREATE TABLE "short_term_goal_revisions"');
		expect(sql).toContain('CREATE TABLE "short_term_goal_priority_revisions"');

		// Unique constraints
		expect(sql).toContain("short_term_goals_bucket_idx");
		expect(sql).toContain("stg_revisions_goal_rev_idx");
		expect(sql).toContain("stg_revisions_user_idempotency_idx");
		expect(sql).toContain("stg_revisions_prev_rev_idx");
		expect(sql).toContain("stg_priority_acc_rev_idx");
		expect(sql).toContain("stg_priority_user_idempotency_idx");
		expect(sql).toContain("stg_priority_prev_rev_idx");

		// Immutability triggers
		expect(sql).toContain("trg_fn_guard_short_term_goals_immutability");
		expect(sql).toContain("trg_fn_guard_stg_revisions_immutability");
		expect(sql).toContain("trg_fn_guard_stg_priority_immutability");

		// Insert guards
		expect(sql).toContain("trg_fn_guard_short_term_goals_insert");
		expect(sql).toContain("trg_fn_guard_stg_revisions_insert");
		expect(sql).toContain("trg_fn_guard_stg_priority_insert");

		// Deferred constraint trigger
		expect(sql).toContain("trg_fn_guard_stg_priority_deferred");
		expect(sql).toContain("INITIALLY DEFERRED");

		// Cross-domain allocation transfer trigger
		expect(sql).toContain("trg_fn_guard_midas_transfers_goal_cap");
		expect(sql).toContain("trg_guard_midas_transfers_goal_cap");
	});
});
