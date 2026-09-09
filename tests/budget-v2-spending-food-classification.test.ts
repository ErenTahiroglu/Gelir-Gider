import { describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	createSpendingFoodClassification,
	deriveFoodClassificationKind,
	getSpendingFoodClassificationAsOf,
	resolveSpendingFoodBasisAsOf,
	updateSpendingFoodClassification,
	voidSpendingFoodClassification,
} from "../src/budget/spending-food-classification-v2";
import type { Database } from "../src/db/client";

/**
 * Checkpoint 4C -- the authoritative PGlite coverage for the spending-food
 * semantic write service + read model lives in `scripts/pg-runtime-verify.ts`
 * (Phase 4C). The workerd vitest gate cannot open a PGlite database, so this
 * file pins the pure label projection and the input guards that fail before
 * any database access.
 */

const db = undefined as unknown as Database;
const OK_UUID = "11111111-1111-4111-8111-111111111111";
const c = (n: bigint) => n;

describe("deriveFoodClassificationKind -- convenience label over the authoritative allocation", () => {
	it("all home/market -> FOOD_HOME_MARKET", () => {
		expect(deriveFoodClassificationKind(c(1000n), c(1000n), c(0n))).toBe(
			"FOOD_HOME_MARKET",
		);
	});
	it("all outside -> FOOD_OUTSIDE", () => {
		expect(deriveFoodClassificationKind(c(1000n), c(0n), c(1000n))).toBe(
			"FOOD_OUTSIDE",
		);
	});
	it("both zero -> NON_FOOD (an explicit user decision, never 'unclassified')", () => {
		expect(deriveFoodClassificationKind(c(1000n), c(0n), c(0n))).toBe(
			"NON_FOOD",
		);
	});
	it("partly food + partly non-food -> MIXED", () => {
		expect(deriveFoodClassificationKind(c(1000n), c(500n), c(100n))).toBe(
			"MIXED",
		);
	});
	it("home + outside -> MIXED", () => {
		expect(deriveFoodClassificationKind(c(1000n), c(600n), c(400n))).toBe(
			"MIXED",
		);
	});
});

describe("createSpendingFoodClassification -- pre-DB input guards", () => {
	const base = {
		db,
		userId: OK_UUID,
		subject: {
			type: "CREDIT_CARD_PURCHASE" as const,
			purchaseEventId: OK_UUID,
		},
		foodHomeMarketAmount: "10.00",
		foodOutsideAmount: "0.00",
		sourceKind: "USER_APPROVED" as const,
		idempotencyKey: "food-1",
	};

	it("rejects a non-UUID userId", async () => {
		await expect(
			createSpendingFoodClassification({ ...base, userId: "nope" }),
		).rejects.toMatchObject({
			name: "BudgetError",
			code: "BUDGET_INVALID_INPUT",
		});
	});

	it("rejects an unknown subject type", async () => {
		await expect(
			createSpendingFoodClassification({
				...base,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				subject: { type: "MYSTERY", purchaseEventId: OK_UUID } as any,
			}),
		).rejects.toBeInstanceOf(BudgetError);
	});

	it("rejects a negative food amount", async () => {
		await expect(
			createSpendingFoodClassification({
				...base,
				foodOutsideAmount: "-1.00",
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects an unknown sourceKind (no AUTO / MODEL / HEURISTIC)", async () => {
		await expect(
			createSpendingFoodClassification({
				...base,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				sourceKind: "AUTO" as any,
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects a missing idempotency key", async () => {
		await expect(
			createSpendingFoodClassification({ ...base, idempotencyKey: "  " }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});

describe("update / void -- pre-DB OCC guard", () => {
	it("update rejects a non-positive expectedRevisionNo", async () => {
		await expect(
			updateSpendingFoodClassification({
				db,
				userId: OK_UUID,
				subject: { type: "PEOPLE_PAYABLE", personObligationId: OK_UUID },
				expectedRevisionNo: 0,
				foodHomeMarketAmount: "1.00",
				foodOutsideAmount: "0.00",
				sourceKind: "USER_APPROVED",
				idempotencyKey: "food-u",
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("void rejects a non-integer expectedRevisionNo", async () => {
		await expect(
			voidSpendingFoodClassification({
				db,
				userId: OK_UUID,
				subject: { type: "PEOPLE_PAYABLE", personObligationId: OK_UUID },
				expectedRevisionNo: 1.5,
				sourceKind: "USER_APPROVED",
				idempotencyKey: "food-v",
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});

describe("strict asOf -- an invalid explicit cutoff is never silently 'now' (4C.1)", () => {
	const ccSubject = {
		type: "CREDIT_CARD_PURCHASE" as const,
		purchaseEventId: OK_UUID,
	};

	it("getSpendingFoodClassificationAsOf rejects an Invalid Date asOf", async () => {
		await expect(
			getSpendingFoodClassificationAsOf({
				db,
				userId: OK_UUID,
				subject: ccSubject,
				asOf: new Date("nope"),
			}),
		).rejects.toMatchObject({
			name: "BudgetError",
			code: "BUDGET_INVALID_INPUT",
		});
	});

	it("getSpendingFoodClassificationAsOf rejects a non-Date asOf", async () => {
		await expect(
			getSpendingFoodClassificationAsOf({
				db,
				userId: OK_UUID,
				subject: ccSubject,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				asOf: "2026-09-15" as any,
			}),
		).rejects.toBeInstanceOf(BudgetError);
	});

	it("resolveSpendingFoodBasisAsOf requires a valid Date asOf", async () => {
		await expect(
			resolveSpendingFoodBasisAsOf({
				db,
				userId: OK_UUID,
				subject: ccSubject,
				asOf: new Date("nope"),
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});
