import { describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import { calculateMonthCloseApplyFingerprint } from "../src/month-close/fingerprint";
import { closeMonth } from "../src/month-close/service";

const USER_ID = "019543ef-1111-7000-8000-000000000099";
const PERIOD_MONTH = "2026-01";
const EXPECTED_PROPOSAL_FINGERPRINT = "a".repeat(64);
const OCCURRED_AT = new Date("2026-02-05T00:00:00Z");
const IDEMPOTENCY_KEY = "shared-replay-key";
const MONTH_CLOSE_ID = "019543ef-2222-7000-8000-000000000001";
const ANCHOR_ROW = { budgetPlanId: "019543ef-3333-7000-8000-000000000001" };

/**
 * Builds a stored `month_close_revisions` row (as it would come back from the
 * DB) plus its `revisionFingerprint`, computed honestly from the STORED
 * route/decision/appliedAmount -- exactly as the original `closeMonth` call
 * that created it would have computed it.
 */
async function buildStoredRevision(params: {
	route: "SHORT_TERM_GOAL" | "MEDIUM_TERM_RESERVE" | "NONE";
	decision: "FULL" | "PARTIAL" | "SKIP" | "AUTO_MEDIUM" | "NO_ACTION";
	appliedAmount: string;
}) {
	const revisionFingerprint = await calculateMonthCloseApplyFingerprint({
		userId: USER_ID,
		periodMonth: PERIOD_MONTH,
		expectedProposalFingerprint: EXPECTED_PROPOSAL_FINGERPRINT,
		effectiveRoute: params.route,
		decision: params.decision,
		partialAmount: params.decision === "PARTIAL" ? params.appliedAmount : null,
		occurredAt: OCCURRED_AT,
	});

	return {
		id: "019543ef-4444-7000-8000-000000000001",
		userId: USER_ID,
		monthCloseId: MONTH_CLOSE_ID,
		revisionNo: 1,
		previousRevisionId: null,
		operation: "CLOSE",
		status: "CLOSED",
		budgetPlanRevisionNo: 1,
		policyVersion: "PERSONAL_BUDGET_V1",
		currency: "TRY",
		referenceIncome: "1000.00",
		mandatoryCeiling: "500.00",
		mandatoryExpense: "0.00",
		mandatoryUnused: "500.00",
		discretionaryCeiling: "100.00",
		discretionaryExpense: "0.00",
		discretionaryUnused: "100.00",
		unclassifiedExpense: "0.00",
		closeSurplus: params.route === "NONE" ? "0.00" : "600.00",
		route: params.route,
		decision: params.decision,
		midasAccountId:
			params.route === "NONE" ? null : "019543ef-5555-7000-8000-000000000001",
		targetGoalId:
			params.route === "SHORT_TERM_GOAL"
				? "019543ef-6666-7000-8000-000000000001"
				: null,
		targetGoalRevisionNo: params.route === "SHORT_TERM_GOAL" ? 1 : null,
		targetBucketId:
			params.route === "NONE" ? null : "019543ef-7777-7000-8000-000000000001",
		fullOfferAmount: params.route === "SHORT_TERM_GOAL" ? "600.00" : "0.00",
		appliedAmount: params.appliedAmount,
		unroutedAmount: "0.00",
		midasAllocationTransferId:
			params.decision === "SKIP" || params.decision === "NO_ACTION"
				? null
				: "019543ef-8888-7000-8000-000000000001",
		proposalFingerprint: EXPECTED_PROPOSAL_FINGERPRINT,
		idempotencyKey: IDEMPOTENCY_KEY,
		revisionFingerprint,
		occurredAt: OCCURRED_AT,
		createdAt: new Date(),
	};
}

/**
 * A mock `db.transaction` whose `tx.select` resolves the early
 * idempotency-key lookup to `existingRev` on the first call, and (only
 * reached on an exact-match replay) the month-close anchor row on the
 * second call.
 */
function makeReplayDb(existingRev: unknown) {
	const select = vi
		.fn()
		.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([existingRev]),
				}),
			}),
		})
		.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([ANCHOR_ROW]),
				}),
			}),
		});

	const tx = { select } as unknown as DatabaseTransaction;
	const db = {
		transaction: vi.fn(async (cb: (tx: DatabaseTransaction) => unknown) =>
			cb(tx),
		),
	} as unknown as Database;
	return db;
}

function baseCallParams(overrides: Record<string, unknown> = {}) {
	return {
		userId: USER_ID,
		periodMonth: PERIOD_MONTH,
		expectedProposalFingerprint: EXPECTED_PROPOSAL_FINGERPRINT,
		occurredAt: OCCURRED_AT,
		idempotencyKey: IDEMPOTENCY_KEY,
		...overrides,
	};
}

describe("closeMonth historical idempotency replay binds caller input (Phase 14-R1, Section A)", () => {
	it("FULL -> exact FULL retry is accepted as a replay", async () => {
		const stored = await buildStoredRevision({
			route: "SHORT_TERM_GOAL",
			decision: "FULL",
			appliedAmount: "600.00",
		});
		const db = makeReplayDb(stored);

		const result = await closeMonth({
			db,
			...baseCallParams({ decision: "FULL" }),
		} as never);

		expect(result.idempotentReplay).toBe(true);
		expect(result.monthClose.decision).toBe("FULL");
	});

	it("FULL -> SKIP with the same idempotency key is rejected as a conflict", async () => {
		const stored = await buildStoredRevision({
			route: "SHORT_TERM_GOAL",
			decision: "FULL",
			appliedAmount: "600.00",
		});
		const db = makeReplayDb(stored);

		await expect(
			closeMonth({ db, ...baseCallParams({ decision: "SKIP" }) } as never),
		).rejects.toMatchObject({ code: "MONTH_CLOSE_IDEMPOTENCY_CONFLICT" });
	});

	it("SKIP -> FULL with the same idempotency key is rejected as a conflict", async () => {
		const stored = await buildStoredRevision({
			route: "SHORT_TERM_GOAL",
			decision: "SKIP",
			appliedAmount: "0.00",
		});
		const db = makeReplayDb(stored);

		await expect(
			closeMonth({ db, ...baseCallParams({ decision: "FULL" }) } as never),
		).rejects.toMatchObject({ code: "MONTH_CLOSE_IDEMPOTENCY_CONFLICT" });
	});

	it("PARTIAL-250 -> exact PARTIAL-250 retry is accepted as a replay", async () => {
		const stored = await buildStoredRevision({
			route: "SHORT_TERM_GOAL",
			decision: "PARTIAL",
			appliedAmount: "250.00",
		});
		const db = makeReplayDb(stored);

		const result = await closeMonth({
			db,
			...baseCallParams({ decision: "PARTIAL", partialAmount: "250.00" }),
		} as never);

		expect(result.idempotentReplay).toBe(true);
	});

	it("PARTIAL-250 -> PARTIAL-300 with the same idempotency key is rejected as a conflict", async () => {
		const stored = await buildStoredRevision({
			route: "SHORT_TERM_GOAL",
			decision: "PARTIAL",
			appliedAmount: "250.00",
		});
		const db = makeReplayDb(stored);

		await expect(
			closeMonth({
				db,
				...baseCallParams({ decision: "PARTIAL", partialAmount: "300.00" }),
			} as never),
		).rejects.toMatchObject({ code: "MONTH_CLOSE_IDEMPOTENCY_CONFLICT" });
	});

	it("PARTIAL -> FULL with the same idempotency key is rejected as a conflict", async () => {
		const stored = await buildStoredRevision({
			route: "SHORT_TERM_GOAL",
			decision: "PARTIAL",
			appliedAmount: "250.00",
		});
		const db = makeReplayDb(stored);

		await expect(
			closeMonth({ db, ...baseCallParams({ decision: "FULL" }) } as never),
		).rejects.toMatchObject({ code: "MONTH_CLOSE_IDEMPOTENCY_CONFLICT" });
	});

	it("MEDIUM_TERM_RESERVE original -> caller now supplies decision=FULL with the same key is rejected as a conflict", async () => {
		const stored = await buildStoredRevision({
			route: "MEDIUM_TERM_RESERVE",
			decision: "AUTO_MEDIUM",
			appliedAmount: "600.00",
		});
		const db = makeReplayDb(stored);

		await expect(
			closeMonth({ db, ...baseCallParams({ decision: "FULL" }) } as never),
		).rejects.toMatchObject({ code: "MONTH_CLOSE_IDEMPOTENCY_CONFLICT" });
	});

	it("NONE original -> caller now supplies decision=SKIP with the same key is rejected as a conflict", async () => {
		const stored = await buildStoredRevision({
			route: "NONE",
			decision: "NO_ACTION",
			appliedAmount: "0.00",
		});
		const db = makeReplayDb(stored);

		await expect(
			closeMonth({ db, ...baseCallParams({ decision: "SKIP" }) } as never),
		).rejects.toMatchObject({ code: "MONTH_CLOSE_IDEMPOTENCY_CONFLICT" });
	});
});
