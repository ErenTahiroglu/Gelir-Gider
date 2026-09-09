import { describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	createSurplusUseAttribution,
	getSurplusUseAttributionAsOf,
	resolveSurplusUseBasisAsOf,
	updateSurplusUseAttribution,
	voidSurplusUseAttribution,
} from "../src/budget/surplus-use-attribution-v2";
import type { Database } from "../src/db/client";

/**
 * Checkpoint 5B -- the authoritative PGlite coverage for the surplus-use
 * attribution write service, the 4-domain basis / staleness read model, the
 * candidate universe and the authoritative `availableToAllocateNow` lives in
 * `scripts/pg-runtime-verify.ts` (Phase 5B). The workerd vitest gate cannot
 * open a PGlite database, so this file pins the input guards that fail before
 * any database access.
 */

const db = undefined as unknown as Database;
const OK = "11111111-1111-4111-8111-111111111111";
const ccBase = {
	db,
	userId: OK,
	subject: { type: "CREDIT_CARD_PURCHASE" as const, purchaseEventId: OK },
	periodMonth: "2026-09-01",
	currentSurplusAmount: "100.00",
	sourceKind: "USER_APPROVED" as const,
	idempotencyKey: "su-1",
};

describe("createSurplusUseAttribution -- pre-DB input guards", () => {
	it("rejects a non-UUID userId", async () => {
		await expect(
			createSurplusUseAttribution({ ...ccBase, userId: "nope" }),
		).rejects.toMatchObject({
			name: "BudgetError",
			code: "BUDGET_INVALID_INPUT",
		});
	});

	it("rejects an unknown subject type", async () => {
		await expect(
			createSurplusUseAttribution({
				...ccBase,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				subject: { type: "MYSTERY", purchaseEventId: OK } as any,
			}),
		).rejects.toMatchObject({ code: "BUDGET_SURPLUS_USE_SUBJECT_INVALID" });
	});

	it("rejects a negative currentSurplusAmount", async () => {
		await expect(
			createSurplusUseAttribution({ ...ccBase, currentSurplusAmount: "-1.00" }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects an unknown sourceKind (USER_APPROVED only -- no AUTO / MODEL)", async () => {
		await expect(
			createSurplusUseAttribution({
				...ccBase,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				sourceKind: "AUTO" as any,
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects a missing idempotency key", async () => {
		await expect(
			createSurplusUseAttribution({ ...ccBase, idempotencyKey: "   " }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects a non-first-day periodMonth", async () => {
		await expect(
			createSurplusUseAttribution({ ...ccBase, periodMonth: "2026-09-15" }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects an Invalid Date occurredAt", async () => {
		await expect(
			createSurplusUseAttribution({ ...ccBase, occurredAt: new Date("nope") }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});

describe("update / void / read -- pre-DB guards", () => {
	it("update rejects a non-positive expectedRevisionNo", async () => {
		await expect(
			updateSurplusUseAttribution({ ...ccBase, expectedRevisionNo: 0 }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("void rejects a non-integer expectedRevisionNo", async () => {
		await expect(
			voidSurplusUseAttribution({
				db,
				userId: OK,
				subject: { type: "PEOPLE_PAYABLE", personObligationId: OK },
				periodMonth: "2026-09-01",
				expectedRevisionNo: 1.5,
				sourceKind: "USER_APPROVED",
				idempotencyKey: "su-v",
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("resolveSurplusUseBasisAsOf rejects an Invalid Date asOf", async () => {
		await expect(
			resolveSurplusUseBasisAsOf({
				db,
				userId: OK,
				subject: {
					type: "MOBILITY_MIDAS_TRANSFER",
					midasAllocationTransferId: OK,
				},
				asOf: new Date("nope"),
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("getSurplusUseAttributionAsOf rejects an Invalid Date asOf", async () => {
		await expect(
			getSurplusUseAttributionAsOf({
				db,
				userId: OK,
				subject: { type: "LONG_TERM_SEND_TASK", longTermSendTaskId: OK },
				periodMonth: "2026-09-01",
				asOf: new Date("nope"),
			}),
		).rejects.toBeInstanceOf(BudgetError);
	});
});
