import { beforeEach, describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	classifyGoalPurpose,
	getGoalPurpose,
	listGoalPurposes,
	reclassifyGoalPurpose,
} from "../src/budget/goal-purpose-v2";
import {
	STG_BUDGET_V2_PURPOSES,
	type StgBudgetV2Purpose,
	shortTermGoalBudgetV2PurposeRevisions,
} from "../src/db/schema/budget-v2-semantics";
import { shortTermGoals } from "../src/db/schema/short-term-goals";
import { makePgFake, type PgFake } from "./helpers/pg-fake";

const USER = "11111111-1111-4111-8111-111111111111";
const G1 = "c1111111-1111-4111-8111-111111111111";
const G2 = "c2222222-2222-4222-8222-222222222222";

let fake: PgFake;
beforeEach(() => {
	fake = makePgFake();
	fake.seed(shortTermGoals, [
		{ id: G1, userId: USER },
		{ id: G2, userId: USER },
	]);
});

const classify = (
	over: Partial<Parameters<typeof classifyGoalPurpose>[0]> = {},
) =>
	classifyGoalPurpose({
		db: fake.db,
		userId: USER,
		goalId: G1,
		purpose: "INTERNATIONAL_MOBILITY",
		idempotencyKey: "k-g1-1",
		occurredAt: new Date("2026-09-01T00:00:00.000Z"),
		...over,
	});

describe("Budget V2 short-term goal purpose classification service", () => {
	// R
	it("R: each exact purpose is accepted", async () => {
		for (const p of STG_BUDGET_V2_PURPOSES) {
			const f = makePgFake();
			f.seed(shortTermGoals, [{ id: G1, userId: USER }]);
			const res = await classifyGoalPurpose({
				db: f.db,
				userId: USER,
				goalId: G1,
				purpose: p,
				idempotencyKey: `k-${p}`,
			});
			expect(res.purpose.purpose).toBe(p);
			expect(res.purpose.revisionNo).toBe(1);
		}
	});

	// S
	it("S: an unknown purpose is rejected before any DB work", async () => {
		await expect(
			classify({ purpose: "MOBILITY_GOAL" as never }),
		).rejects.toBeInstanceOf(BudgetError);
	});

	// T -- no name/code inference: the service never reads goal name/code; it
	// only takes an explicit purpose argument.
	it("T: purpose is taken only from the explicit argument (no name/code inference)", async () => {
		// A goal with a "mobility"-ish id still requires an explicit purpose.
		const f = makePgFake();
		f.seed(shortTermGoals, [
			{ id: G1, userId: USER, code: "INTL_MOBILITY", name: "Move abroad" },
		]);
		expect(
			await getGoalPurpose({ db: f.db, userId: USER, goalId: G1 }),
		).toBeNull();
		const res = await classifyGoalPurpose({
			db: f.db,
			userId: USER,
			goalId: G1,
			purpose: "OTHER",
			idempotencyKey: "k-explicit",
		});
		expect(res.purpose.purpose).toBe("OTHER");
	});

	// U
	it("U: first classification is a CREATE revision #1 with NULL previous", async () => {
		const res = await classify();
		expect(res.purpose.operation).toBe("CREATE");
		expect(res.purpose.revisionNo).toBe(1);
		expect(res.purpose.previousRevisionId).toBeNull();
	});

	// V
	it("V: reclassification is an UPDATE revision with the exact predecessor link", async () => {
		const c = await classify();
		const rc = await reclassifyGoalPurpose({
			db: fake.db,
			userId: USER,
			goalId: G1,
			expectedRevisionNo: 1,
			purpose: "PLANNED_DISCRETIONARY",
			idempotencyKey: "k-g1-2",
		});
		expect(rc.purpose.operation).toBe("UPDATE");
		expect(rc.purpose.revisionNo).toBe(2);
		expect(rc.purpose.previousRevisionId).toBe(c.purpose.revisionId);
		expect(rc.purpose.purpose).toBe("PLANNED_DISCRETIONARY");
	});

	// W
	it("W: exact idempotency replay returns the stored revision, no duplicate", async () => {
		const first = await classify();
		const replay = await classify();
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.purpose.revisionId).toBe(first.purpose.revisionId);
		expect(fake.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(1);
	});

	// X
	it("X: same key with a changed purpose is an idempotency conflict", async () => {
		await classify();
		await expect(classify({ purpose: "OTHER" })).rejects.toMatchObject({
			code: "BUDGET_IDEMPOTENCY_CONFLICT",
		});
	});

	// Y
	it("Y: a stale expectedRevisionNo on reclassify is rejected (BUDGET_REVISION_CONFLICT)", async () => {
		await classify();
		await reclassifyGoalPurpose({
			db: fake.db,
			userId: USER,
			goalId: G1,
			expectedRevisionNo: 1,
			purpose: "OTHER",
			idempotencyKey: "k-g1-2",
		});
		await expect(
			reclassifyGoalPurpose({
				db: fake.db,
				userId: USER,
				goalId: G1,
				expectedRevisionNo: 1, // stale
				purpose: "PLANNED_DISCRETIONARY",
				idempotencyKey: "k-g1-3",
			}),
		).rejects.toMatchObject({ code: "BUDGET_REVISION_CONFLICT" });
	});

	// Z
	it("Z: multiple goals may independently be INTERNATIONAL_MOBILITY (no singleton)", async () => {
		await classifyGoalPurpose({
			db: fake.db,
			userId: USER,
			goalId: G1,
			purpose: "INTERNATIONAL_MOBILITY",
			idempotencyKey: "k-g1",
		});
		const r2 = await classifyGoalPurpose({
			db: fake.db,
			userId: USER,
			goalId: G2,
			purpose: "INTERNATIONAL_MOBILITY",
			idempotencyKey: "k-g2",
		});
		expect(r2.purpose.purpose).toBe("INTERNATIONAL_MOBILITY");
		const list = await listGoalPurposes({ db: fake.db, userId: USER });
		expect(
			list.filter(
				(p: { purpose: StgBudgetV2Purpose }) =>
					p.purpose === "INTERNATIONAL_MOBILITY",
			),
		).toHaveLength(2);
	});

	it("rejects an unknown target goal (BUDGET_CLASSIFICATION_TARGET_NOT_FOUND)", async () => {
		await expect(
			classify({ goalId: "c9999999-9999-4999-8999-999999999999" }),
		).rejects.toMatchObject({ code: "BUDGET_CLASSIFICATION_TARGET_NOT_FOUND" });
	});

	it("a second fresh classify on an already-classified goal is refused (use reclassify)", async () => {
		await classify();
		await expect(
			classify({ idempotencyKey: "k-g1-other" }),
		).rejects.toMatchObject({ code: "BUDGET_REVISION_CONFLICT" });
	});

	// AA -- purpose classification never produces a Midas transfer: the service
	// only ever writes to shortTermGoalBudgetV2PurposeRevisions.
	it("AA: classification / reclassification write ONLY the purpose-revision table (no Midas transfer, no goal mutation)", async () => {
		await classify();
		await reclassifyGoalPurpose({
			db: fake.db,
			userId: USER,
			goalId: G1,
			expectedRevisionNo: 1,
			purpose: "OTHER",
			idempotencyKey: "k-g1-2",
		});
		expect([...fake.store.keys()]).toEqual([
			shortTermGoals, // seeded, untouched
			shortTermGoalBudgetV2PurposeRevisions,
		]);
		expect(fake.rows(shortTermGoals)).toHaveLength(2); // seed unchanged
		expect(fake.rows(shortTermGoalBudgetV2PurposeRevisions)).toHaveLength(2);
	});

	// AB -- historical goal revision rows are untouched (the service never
	// references shortTermGoalRevisions at all).
	it("AB: get returns null / latest; historical goal config revisions are never touched", async () => {
		expect(
			await getGoalPurpose({ db: fake.db, userId: USER, goalId: G1 }),
		).toBeNull();
		await classify();
		const got = await getGoalPurpose({ db: fake.db, userId: USER, goalId: G1 });
		expect(got?.revisionNo).toBe(1);
		expect(got?.purpose).toBe("INTERNATIONAL_MOBILITY");
	});
});
