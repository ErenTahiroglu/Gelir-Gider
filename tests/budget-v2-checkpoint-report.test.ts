import { describe, expect, it } from "vitest";
import {
	BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION,
	buildBudgetV2CheckpointReport,
} from "../src/budget/checkpoint-report-v2";
import { BudgetError } from "../src/budget/errors";
import type { Database } from "../src/db/client";

/**
 * Checkpoint 4B -- the authoritative PGlite coverage for the checkpoint report
 * read model lives in `scripts/pg-runtime-verify.ts` (Phase 4B: cases A..X).
 * The vitest gate runs on workerd and cannot open a PGlite database, so this
 * file only pins the exported contract + the input guards that fail before any
 * database access.
 */

const OK_UUID = "11111111-1111-4111-8111-111111111111";
const db = undefined as unknown as Database;

describe("buildBudgetV2CheckpointReport -- exported contract + pre-DB input guards", () => {
	it("exposes a stable schema version", () => {
		expect(BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION).toBe(
			"budget-v2-checkpoint-report-v1",
		);
	});

	it("rejects a non-UUID userId before touching the database", async () => {
		await expect(
			buildBudgetV2CheckpointReport({
				db,
				userId: "not-a-uuid",
				periodMonth: "2026-09-01",
				triggerStatementId: OK_UUID,
			}),
		).rejects.toMatchObject({
			name: "BudgetError",
			code: "BUDGET_INVALID_INPUT",
		});
	});

	it("rejects an invalid periodMonth before touching the database", async () => {
		await expect(
			buildBudgetV2CheckpointReport({
				db,
				userId: OK_UUID,
				periodMonth: "2026-09",
				triggerStatementId: OK_UUID,
			}),
		).rejects.toBeInstanceOf(BudgetError);
	});

	it("rejects a non-UUID triggerStatementId before touching the database", async () => {
		await expect(
			buildBudgetV2CheckpointReport({
				db,
				userId: OK_UUID,
				periodMonth: "2026-09-01",
				triggerStatementId: "nope",
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});
