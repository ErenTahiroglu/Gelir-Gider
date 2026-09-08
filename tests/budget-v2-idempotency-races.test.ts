import { beforeEach, describe, expect, it } from "vitest";
import {
	classifyGoalPurpose,
	reclassifyGoalPurpose,
} from "../src/budget/goal-purpose-v2";
import {
	classifySupportReceipt,
	reclassifySupportReceipt,
} from "../src/budget/support-classification-v2";
import {
	incomeReceiptBudgetV2SemanticRevisions,
	shortTermGoalBudgetV2PurposeRevisions,
} from "../src/db/schema/budget-v2-semantics";
import { incomeReceipts, incomeSources } from "../src/db/schema/income";
import { shortTermGoals } from "../src/db/schema/short-term-goals";
import { makePgFake, type PgFake } from "./helpers/pg-fake";

/**
 * Lost-race / concurrent idempotency regression.
 *
 * Each test registers a one-shot pg-fake hook that commits a "winner"
 * revision in the gap between the caller's fast (pre-transaction) idempotency
 * lookup and its in-transaction recheck ("tx:start") or its insert
 * ("insert:before"). The caller must then converge on an exact replay or a
 * fail-closed conflict -- never a raw unique violation, never a false
 * BUDGET_REVISION_CONFLICT for an identical command.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const SUP_SRC = "a1111111-1111-4111-8111-111111111111";
const R_SUP = "b1111111-1111-4111-8111-111111111111";
const R_SUP2 = "b2222222-2222-4222-8222-222222222222";
const OCCURRED = new Date("2026-09-01T00:00:00.000Z");

let fake: PgFake;

beforeEach(() => {
	fake = makePgFake();
	fake.seed(incomeSources, [{ id: SUP_SRC, nature: "SUPPORT" }]);
	fake.seed(incomeReceipts, [
		{ id: R_SUP, userId: USER, sourceId: SUP_SRC },
		{ id: R_SUP2, userId: USER, sourceId: SUP_SRC },
	]);
});

const sClassify = (
	over: Partial<Parameters<typeof classifySupportReceipt>[0]> = {},
) =>
	classifySupportReceipt({
		db: fake.db,
		userId: USER,
		incomeReceiptId: R_SUP,
		supportRole: "PLANNED_FAMILY_GIFT",
		idempotencyKey: "k-race",
		occurredAt: OCCURRED,
		...over,
	});

const sReclassify = (
	over: Partial<Parameters<typeof reclassifySupportReceipt>[0]> = {},
) =>
	reclassifySupportReceipt({
		db: fake.db,
		userId: USER,
		incomeReceiptId: R_SUP,
		expectedRevisionNo: 1,
		supportRole: "DEFICIT_FAMILY_SUPPORT",
		idempotencyKey: "k-race-rc",
		occurredAt: OCCURRED,
		...over,
	});

describe("SUPPORT classification -- concurrent idempotency", () => {
	// A
	it("A: lost-race exact CLASSIFY -> idempotent replay, exactly one row", async () => {
		fake.hook("tx:start", () => sClassify({ db: fake.db }));
		const res = await sClassify();
		expect(res.idempotentReplay).toBe(true);
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(1);
	});

	// B
	it("B: lost-race exact RECLASSIFY -> replay, exactly one NEW revision", async () => {
		await sClassify();
		fake.hook("tx:start", () => sReclassify());
		const res = await sReclassify();
		expect(res.idempotentReplay).toBe(true);
		expect(res.classification.revisionNo).toBe(2);
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(2);
	});

	// C
	it("C: lost-race same key but changed role -> BUDGET_IDEMPOTENCY_CONFLICT", async () => {
		fake.hook("tx:start", () =>
			sClassify({ supportRole: "PLANNED_FAMILY_GIFT" }),
		);
		await expect(
			sClassify({ supportRole: "DEFICIT_FAMILY_SUPPORT" }),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(1);
	});

	// D -- cross-target: the receipt locks do not serialize, so the collision
	// is absorbed by the ON CONFLICT (user_id, idempotency_key) insert shape and
	// re-read, not a raw 23505.
	it("D: same user+key raced onto a different receipt -> BUDGET_IDEMPOTENCY_CONFLICT (no raw unique error)", async () => {
		fake.hook("insert:before", () => sClassify({ incomeReceiptId: R_SUP }));
		const err = await sClassify({ incomeReceiptId: R_SUP2 }).catch((e) => e);
		expect(err).toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
		expect(String(err?.message ?? "")).not.toMatch(/23505|unique|duplicate/i);
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(1);
	});

	// E
	it("E: same target, different fresh keys -> exactly one revision; the loser is a revision conflict", async () => {
		fake.hook("tx:start", () => sClassify({ idempotencyKey: "k-A" }));
		await expect(sClassify({ idempotencyKey: "k-B" })).rejects.toMatchObject({
			code: "BUDGET_REVISION_CONFLICT",
		});
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(1);
	});

	it("E (reclassify): different fresh keys racing rev #1->#2 -> loser is a revision conflict", async () => {
		await sClassify();
		fake.hook("tx:start", () => sReclassify({ idempotencyKey: "rc-A" }));
		await expect(sReclassify({ idempotencyKey: "rc-B" })).rejects.toMatchObject(
			{ code: "BUDGET_REVISION_CONFLICT" },
		);
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------

const G1 = "c1111111-1111-4111-8111-111111111111";
const G2 = "c2222222-2222-4222-8222-222222222222";

describe("goal purpose -- concurrent idempotency", () => {
	let g: PgFake;
	beforeEach(() => {
		g = makePgFake();
		g.seed(shortTermGoals, [
			{ id: G1, userId: USER },
			{ id: G2, userId: USER },
		]);
	});

	const gClassify = (
		over: Partial<Parameters<typeof classifyGoalPurpose>[0]> = {},
	) =>
		classifyGoalPurpose({
			db: g.db,
			userId: USER,
			goalId: G1,
			purpose: "INTERNATIONAL_MOBILITY",
			idempotencyKey: "k-race",
			occurredAt: OCCURRED,
			...over,
		});

	const gReclassify = (
		over: Partial<Parameters<typeof reclassifyGoalPurpose>[0]> = {},
	) =>
		reclassifyGoalPurpose({
			db: g.db,
			userId: USER,
			goalId: G1,
			expectedRevisionNo: 1,
			purpose: "PLANNED_DISCRETIONARY",
			idempotencyKey: "k-race-rc",
			occurredAt: OCCURRED,
			...over,
		});

	// F
	it("F: lost-race exact CLASSIFY -> idempotent replay, exactly one row", async () => {
		g.hook("tx:start", () => gClassify());
		const res = await gClassify();
		expect(res.idempotentReplay).toBe(true);
		expect(g.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(1);
	});

	// G
	it("G: lost-race exact RECLASSIFY -> replay, exactly one NEW revision", async () => {
		await gClassify();
		g.hook("tx:start", () => gReclassify());
		const res = await gReclassify();
		expect(res.idempotentReplay).toBe(true);
		expect(res.purpose.revisionNo).toBe(2);
		expect(g.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(2);
	});

	// H
	it("H: lost-race same key but changed purpose -> BUDGET_IDEMPOTENCY_CONFLICT", async () => {
		g.hook("tx:start", () => gClassify({ purpose: "INTERNATIONAL_MOBILITY" }));
		await expect(gClassify({ purpose: "OTHER" })).rejects.toMatchObject({
			code: "BUDGET_IDEMPOTENCY_CONFLICT",
		});
		expect(g.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(1);
	});

	// I
	it("I: same user+key raced onto a different goal -> BUDGET_IDEMPOTENCY_CONFLICT (no raw unique error)", async () => {
		g.hook("insert:before", () => gClassify({ goalId: G1 }));
		const err = await gClassify({ goalId: G2 }).catch((e) => e);
		expect(err).toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
		expect(String(err?.message ?? "")).not.toMatch(/23505|unique|duplicate/i);
		expect(g.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(1);
	});

	// J
	it("J: same target, different fresh keys -> loser is a revision conflict, one row", async () => {
		g.hook("tx:start", () => gClassify({ idempotencyKey: "k-A" }));
		await expect(gClassify({ idempotencyKey: "k-B" })).rejects.toMatchObject({
			code: "BUDGET_REVISION_CONFLICT",
		});
		expect(g.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(1);
	});

	it("J (reclassify): different fresh keys racing rev #1->#2 -> loser is a revision conflict", async () => {
		await gClassify();
		g.hook("tx:start", () => gReclassify({ idempotencyKey: "rc-A" }));
		await expect(gReclassify({ idempotencyKey: "rc-B" })).rejects.toMatchObject(
			{ code: "BUDGET_REVISION_CONFLICT" },
		);
		expect(g.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(2);
	});
});
