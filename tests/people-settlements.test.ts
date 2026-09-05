import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client";
import { PeopleError } from "../src/people/errors";
import {
	recordPersonPayableSettlement,
	recordPersonReceivableSettlement,
	voidPersonSettlement,
} from "../src/people/settlements";

const untouchedDb = {} as Database;
const OCCURRED_AT = new Date("2026-09-05T10:00:00.000Z");

describe("recordPersonReceivableSettlement input validation", () => {
	it("rejects a zero cashAmount", async () => {
		await expect(
			recordPersonReceivableSettlement({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "33333333-3333-3333-3333-333333333333",
				cashAmount: "0.00",
				destinationAssetAccountId: "44444444-4444-4444-4444-444444444444",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);
	});

	it("rejects a missing destinationAssetAccountId", async () => {
		await expect(
			recordPersonReceivableSettlement({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "33333333-3333-3333-3333-333333333333",
				cashAmount: "2745.00",
				destinationAssetAccountId: "",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a note over 500 characters", async () => {
		await expect(
			recordPersonReceivableSettlement({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "33333333-3333-3333-3333-333333333333",
				cashAmount: "2745.00",
				destinationAssetAccountId: "44444444-4444-4444-4444-444444444444",
				note: "a".repeat(501),
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});
});

describe("recordPersonPayableSettlement input validation", () => {
	it("rejects a negative amount", async () => {
		await expect(
			recordPersonPayableSettlement({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "33333333-3333-3333-3333-333333333333",
				amount: "-1.00",
				sourceAssetAccountId: "44444444-4444-4444-4444-444444444444",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});
});

describe("voidPersonSettlement input validation", () => {
	it("rejects a missing reason", async () => {
		await expect(
			voidPersonSettlement({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				settlementId: "55555555-5555-5555-5555-555555555555",
				expectedRevisionNo: 1,
				reason: "",
				idempotencyKey: "key-1",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);
	});

	it("rejects a reason over 500 characters", async () => {
		await expect(
			voidPersonSettlement({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				settlementId: "55555555-5555-5555-5555-555555555555",
				expectedRevisionNo: 1,
				reason: "a".repeat(501),
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});
});
