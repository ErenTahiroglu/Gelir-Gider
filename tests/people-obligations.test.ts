import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client";
import { PeopleError } from "../src/people/errors";
import {
	recordPersonPayableExpense,
	recordPersonReceivable,
	updatePersonPayableExpense,
	updatePersonReceivable,
	voidPersonObligation,
} from "../src/people/obligations";

const untouchedDb = {} as Database;
const OCCURRED_AT = new Date("2026-09-05T10:00:00.000Z");

describe("recordPersonReceivable input validation", () => {
	it("rejects a zero amount", async () => {
		await expect(
			recordPersonReceivable({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				amount: "0.00",
				fundingAssetAccountId: "acct-1",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);
	});

	it("rejects a negative amount", async () => {
		await expect(
			recordPersonReceivable({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				amount: "-100.00",
				fundingAssetAccountId: "acct-1",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a missing fundingAssetAccountId", async () => {
		await expect(
			recordPersonReceivable({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				amount: "1000.00",
				fundingAssetAccountId: "",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a malformed dueDate", async () => {
		await expect(
			recordPersonReceivable({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				amount: "1000.00",
				fundingAssetAccountId: "acct-1",
				dueDate: "31-12-2026",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a description over 500 characters", async () => {
		await expect(
			recordPersonReceivable({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				amount: "1000.00",
				fundingAssetAccountId: "acct-1",
				description: "a".repeat(501),
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});
});

describe("recordPersonPayableExpense input validation", () => {
	it("rejects an unknown budgetCategory", async () => {
		await expect(
			recordPersonPayableExpense({
				db: untouchedDb,
				userId: "user-1",
				personId: "person-1",
				amount: "1000.00",
				budgetCategory: "LUXURY",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);
	});

	it("accepts all four known budget categories at the validation layer", async () => {
		for (const budgetCategory of [
			"MANDATORY_EXPENSE",
			"DISCRETIONARY_SPEND",
			"SHORT_TERM_PURCHASE",
			"UNCLASSIFIED",
		]) {
			// These will fail later once they touch the untouched mock db, but must NOT
			// fail with PEOPLE_INVALID_INPUT for the budgetCategory itself.
			await expect(
				recordPersonPayableExpense({
					db: untouchedDb,
					userId: "user-1",
					personId: "person-1",
					amount: "1000.00",
					budgetCategory,
					occurredAt: OCCURRED_AT,
					idempotencyKey: "key-1",
				}),
			).rejects.not.toSatisfy(
				(e: unknown) =>
					e instanceof PeopleError &&
					e.code === "PEOPLE_INVALID_INPUT" &&
					e.message.includes("budgetCategory"),
			);
		}
	});
});

describe("updatePersonReceivable / updatePersonPayableExpense input validation", () => {
	it("rejects a missing obligationId", async () => {
		await expect(
			updatePersonReceivable({
				db: untouchedDb,
				userId: "user-1",
				obligationId: "",
				expectedRevisionNo: 1,
				amount: "1000.00",
				fundingAssetAccountId: "acct-1",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects an invalid budgetCategory on payable update", async () => {
		await expect(
			updatePersonPayableExpense({
				db: untouchedDb,
				userId: "user-1",
				obligationId: "obligation-1",
				expectedRevisionNo: 1,
				amount: "1000.00",
				budgetCategory: "NOT_REAL",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});
});

describe("voidPersonObligation input validation", () => {
	it("rejects a missing idempotencyKey", async () => {
		await expect(
			voidPersonObligation({
				db: untouchedDb,
				userId: "user-1",
				obligationId: "obligation-1",
				expectedRevisionNo: 1,
				idempotencyKey: "",
			}),
		).rejects.toThrow(PeopleError);
	});
});
