import { beforeEach, describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	classifySupportReceipt,
	getSupportReceiptClassification,
	listSupportReceiptClassifications,
	reclassifySupportReceipt,
} from "../src/budget/support-classification-v2";
import { incomeReceiptBudgetV2SemanticRevisions } from "../src/db/schema/budget-v2-semantics";
import { incomeReceipts, incomeSources } from "../src/db/schema/income";
import { makePgFake, type PgFake } from "./helpers/pg-fake";

const USER = "11111111-1111-4111-8111-111111111111";
const SUP_SRC = "a1111111-1111-4111-8111-111111111111";
const REG_SRC = "a2222222-2222-4222-8222-222222222222";
const EXT_SRC = "a3333333-3333-4333-8333-333333333333";
const R_SUP = "b1111111-1111-4111-8111-111111111111";
const R_REG = "b2222222-2222-4222-8222-222222222222";
const R_EXT = "b3333333-3333-4333-8333-333333333333";

let fake: PgFake;

beforeEach(() => {
	fake = makePgFake();
	fake.seed(incomeSources, [
		{ id: SUP_SRC, nature: "SUPPORT" },
		{ id: REG_SRC, nature: "REGULAR" },
		// The People settlement overpayment source is EXTRA / EXCLUDED.
		{ id: EXT_SRC, nature: "EXTRA" },
	]);
	fake.seed(incomeReceipts, [
		{ id: R_SUP, userId: USER, sourceId: SUP_SRC },
		{ id: R_REG, userId: USER, sourceId: REG_SRC },
		{ id: R_EXT, userId: USER, sourceId: EXT_SRC },
	]);
});

const classify = (
	over: Partial<Parameters<typeof classifySupportReceipt>[0]> = {},
) =>
	classifySupportReceipt({
		db: fake.db,
		userId: USER,
		incomeReceiptId: R_SUP,
		supportRole: "PLANNED_FAMILY_GIFT",
		idempotencyKey: "k-classify-1",
		occurredAt: new Date("2026-09-01T00:00:00.000Z"),
		...over,
	});

describe("Budget V2 SUPPORT receipt classification service", () => {
	// F
	it("F: classifying an active SUPPORT receipt succeeds (revision #1, CREATE)", async () => {
		const res = await classify();
		expect(res.idempotentReplay).toBe(false);
		expect(res.classification.revisionNo).toBe(1);
		expect(res.classification.operation).toBe("CREATE");
		expect(res.classification.supportRole).toBe("PLANNED_FAMILY_GIFT");
		expect(res.classification.previousRevisionId).toBeNull();
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(1);
	});

	// G / H  -- nature guard at the service layer (the DB guard also enforces it)
	it("G: classifying a REGULAR receipt is rejected (BUDGET_CLASSIFICATION_INVALID_TARGET)", async () => {
		await expect(
			classify({ incomeReceiptId: R_REG, idempotencyKey: "k-reg" }),
		).rejects.toMatchObject({ code: "BUDGET_CLASSIFICATION_INVALID_TARGET" });
	});
	it("H: classifying an EXTRA receipt (incl. the People overpayment source shape) is rejected", async () => {
		await expect(
			classify({ incomeReceiptId: R_EXT, idempotencyKey: "k-ext" }),
		).rejects.toMatchObject({ code: "BUDGET_CLASSIFICATION_INVALID_TARGET" });
	});

	it("rejects an unknown target receipt (BUDGET_CLASSIFICATION_TARGET_NOT_FOUND)", async () => {
		await expect(
			classify({
				incomeReceiptId: "b9999999-9999-4999-8999-999999999999",
				idempotencyKey: "k-missing",
			}),
		).rejects.toMatchObject({ code: "BUDGET_CLASSIFICATION_TARGET_NOT_FOUND" });
	});

	// I
	it("I: exact idempotent replay (same key + same params) returns the stored revision, no duplicate", async () => {
		const first = await classify();
		const replay = await classify();
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.classification.revisionId).toBe(
			first.classification.revisionId,
		);
		expect(fake.rows(incomeReceiptBudgetV2SemanticRevisions)).toHaveLength(1);
	});

	it("I2: replay works even when occurredAt is omitted on the retry (stored timestamp reused)", async () => {
		const first = await classify();
		const replay = await classify({ occurredAt: undefined });
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.classification.revisionId).toBe(
			first.classification.revisionId,
		);
	});

	// J
	it("J: same key with a changed role is an idempotency conflict", async () => {
		await classify();
		await expect(
			classify({ supportRole: "DEFICIT_FAMILY_SUPPORT" }),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
	});
	it("J2: same key with a changed receipt / changed occurredAt is an idempotency conflict", async () => {
		await classify();
		await expect(
			classify({
				occurredAt: new Date("2026-09-02T00:00:00.000Z"),
			}),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
	});

	// K / L
	it("K: reclassification appends an UPDATE revision with the exact predecessor link", async () => {
		const c = await classify();
		const rc = await reclassifySupportReceipt({
			db: fake.db,
			userId: USER,
			incomeReceiptId: R_SUP,
			expectedRevisionNo: 1,
			supportRole: "DEFICIT_FAMILY_SUPPORT",
			idempotencyKey: "k-reclass-1",
			occurredAt: new Date("2026-10-01T00:00:00.000Z"),
		});
		expect(rc.classification.revisionNo).toBe(2);
		expect(rc.classification.operation).toBe("UPDATE");
		expect(rc.classification.previousRevisionId).toBe(
			c.classification.revisionId,
		);
		expect(rc.classification.supportRole).toBe("DEFICIT_FAMILY_SUPPORT");
		expect(rc.classification.semantics.isDeficitFunding).toBe(true);
	});

	it("L: a stale expectedRevisionNo on reclassify is rejected (BUDGET_REVISION_CONFLICT)", async () => {
		await classify();
		await reclassifySupportReceipt({
			db: fake.db,
			userId: USER,
			incomeReceiptId: R_SUP,
			expectedRevisionNo: 1,
			supportRole: "DEFICIT_FAMILY_SUPPORT",
			idempotencyKey: "k-reclass-1",
		});
		await expect(
			reclassifySupportReceipt({
				db: fake.db,
				userId: USER,
				incomeReceiptId: R_SUP,
				expectedRevisionNo: 1, // stale
				supportRole: "PLANNED_FAMILY_GIFT",
				idempotencyKey: "k-reclass-2",
			}),
		).rejects.toMatchObject({ code: "BUDGET_REVISION_CONFLICT" });
	});

	it("reclassify replay + changed-param conflict", async () => {
		await classify();
		const args = {
			db: fake.db,
			userId: USER,
			incomeReceiptId: R_SUP,
			expectedRevisionNo: 1,
			supportRole: "DEFICIT_FAMILY_SUPPORT" as const,
			idempotencyKey: "k-reclass-1",
			occurredAt: new Date("2026-10-01T00:00:00.000Z"),
		};
		const r1 = await reclassifySupportReceipt(args);
		const r2 = await reclassifySupportReceipt(args);
		expect(r2.idempotentReplay).toBe(true);
		expect(r2.classification.revisionId).toBe(r1.classification.revisionId);
		await expect(
			reclassifySupportReceipt({ ...args, supportRole: "PLANNED_FAMILY_GIFT" }),
		).rejects.toMatchObject({ code: "BUDGET_IDEMPOTENCY_CONFLICT" });
	});

	// M -- unbranched chain: a fresh classify after one already exists is refused
	it("M: a second fresh classify on an already-classified receipt is refused (use reclassify)", async () => {
		await classify();
		await expect(
			classify({ idempotencyKey: "k-classify-2" }),
		).rejects.toMatchObject({ code: "BUDGET_REVISION_CONFLICT" });
	});

	it("rejects an invalid support role before any DB work", async () => {
		await expect(
			classify({ supportRole: "FAMILY_REIMBURSEMENT" as never }),
		).rejects.toBeInstanceOf(BudgetError);
	});

	// GET / LIST
	it("get returns null when unclassified, the latest revision otherwise", async () => {
		expect(
			await getSupportReceiptClassification({
				db: fake.db,
				userId: USER,
				incomeReceiptId: R_SUP,
			}),
		).toBeNull();
		await classify();
		await reclassifySupportReceipt({
			db: fake.db,
			userId: USER,
			incomeReceiptId: R_SUP,
			expectedRevisionNo: 1,
			supportRole: "DEFICIT_FAMILY_SUPPORT",
			idempotencyKey: "k-reclass-1",
		});
		const got = await getSupportReceiptClassification({
			db: fake.db,
			userId: USER,
			incomeReceiptId: R_SUP,
		});
		expect(got?.revisionNo).toBe(2);
		expect(got?.supportRole).toBe("DEFICIT_FAMILY_SUPPORT");
	});

	it("list returns one latest item per classified receipt", async () => {
		await classify();
		const list = await listSupportReceiptClassifications({
			db: fake.db,
			userId: USER,
		});
		expect(list).toHaveLength(1);
		expect(list[0]?.incomeReceiptId).toBe(R_SUP);
	});
});

describe("FAMILY_REIMBURSEMENT neutrality (O / P / Q)", () => {
	it("O/P: the classification service structurally refuses every non-SUPPORT receipt -- ordinary reimbursement (People receivable settlement principal) and overpayment excess (EXTRA/EXCLUDED) can never become a family-support income role", async () => {
		for (const [receipt, key] of [
			[R_REG, "n-reg"],
			[R_EXT, "n-ext"],
		] as const) {
			await expect(
				classify({ incomeReceiptId: receipt, idempotencyKey: key }),
			).rejects.toMatchObject({ code: "BUDGET_CLASSIFICATION_INVALID_TARGET" });
		}
	});

	it("Q: the enum has no FAMILY_REIMBURSEMENT role", async () => {
		const { SUPPORT_RECEIPT_ROLES } = await import(
			"../src/db/schema/budget-v2-semantics"
		);
		expect(SUPPORT_RECEIPT_ROLES).toEqual([
			"PLANNED_FAMILY_GIFT",
			"DEFICIT_FAMILY_SUPPORT",
		]);
	});
});
