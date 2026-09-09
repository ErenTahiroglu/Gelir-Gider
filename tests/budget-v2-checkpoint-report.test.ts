import { describe, expect, it } from "vitest";
import {
	assembleMtdNonSpending,
	BUDGET_V2_CHECKPOINT_REPORT_SCHEMA_VERSION,
	buildBudgetV2CheckpointReport,
} from "../src/budget/checkpoint-report-v2";
import { BudgetError } from "../src/budget/errors";
import type { BudgetV2LiveResolution } from "../src/budget/live-resolver-v2";
import type { Database } from "../src/db/client";

/**
 * Checkpoint 4B / 4B.1 -- the authoritative PGlite coverage for the checkpoint
 * report read model lives in `scripts/pg-runtime-verify.ts` (Phase 4B). The
 * vitest gate runs on workerd and cannot open a PGlite database, so this file
 * pins the exported contract, the input guards that fail before any database
 * access, and the pure missing-evidence fail-closed path.
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
				triggerPaymentEventId: OK_UUID,
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
				triggerPaymentEventId: OK_UUID,
			}),
		).rejects.toBeInstanceOf(BudgetError);
	});

	it("rejects a non-UUID triggerPaymentEventId before touching the database", async () => {
		await expect(
			buildBudgetV2CheckpointReport({
				db,
				userId: OK_UUID,
				periodMonth: "2026-09-01",
				triggerPaymentEventId: "nope",
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});

describe("assembleMtdNonSpending -- required-evidence fail-closed (no 0.00 fallback)", () => {
	const baseOutputs = {
		deficit: { amount: "0.00" },
		emergencyCatchUp: { amount: "0.00" },
		trueSurplus: { amount: "0.00" },
		mobilityAllocation: { amount: "0.00" },
		longTermInvestment: { amount: "0.00" },
		discretionaryAllocation: { amount: "0.00" },
	};
	const fullEvidence = {
		basicLiving: {
			basicLivingTarget: "6000.00",
			actualPersonalMandatorySpendMTD: "0.00",
			grossBasicLivingNeed: "6000.00",
			basicLivingOverlapWithCurrentObligations: "0.00",
			basicLivingFunding: "6000.00",
		},
		emergencyFund: { balance: "10000.00", target: "10000.00", gap: "0.00" },
		mobility: { goals: [] },
		necessaryPurchases: { perGoal: [], overdueGoalIds: [] },
	};
	const mk = (evidence: unknown): BudgetV2LiveResolution =>
		({
			inputs: {
				realizedIncome: "0.00",
				currentObligations: "0.00",
				basicLivingFunding: "6000.00",
				dateBoundNecessaryPurchaseFunding: "0.00",
				coreEmergencyFundBalance: "10000.00",
				mobilityBalance: "0.00",
			},
			policyResult: { outputs: baseOutputs },
			evidenceSnapshot: evidence,
		}) as unknown as BudgetV2LiveResolution;

	it("assembles cleanly when every required money field is present", () => {
		const out = assembleMtdNonSpending(mk(fullEvidence));
		expect(out.budget.basicLiving.basicLivingFunding).toBe("6000.00");
		expect(out.emergencyFund.target).toBe("10000.00");
	});

	it("fails closed when a required basic-living field is missing", () => {
		const broken = {
			...fullEvidence,
			basicLiving: {
				...fullEvidence.basicLiving,
				basicLivingFunding: undefined,
			},
		};
		expect(() => assembleMtdNonSpending(mk(broken))).toThrow(
			/BUDGET_CHECKPOINT_REPORT_FAIL_CLOSED|required resolver evidence/,
		);
	});

	it("fails closed when a required emergency-fund field is malformed", () => {
		const broken = {
			...fullEvidence,
			emergencyFund: { ...fullEvidence.emergencyFund, gap: "not-money" },
		};
		expect(() => assembleMtdNonSpending(mk(broken))).toThrow(BudgetError);
	});
});
