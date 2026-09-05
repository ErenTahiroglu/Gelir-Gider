import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { PeopleError } from "../src/people/errors";
import {
	listPersonObligations,
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
				userId: "11111111-1111-1111-1111-111111111111",
				personId: "22222222-2222-2222-2222-222222222222",
				amount: "0.00",
				fundingAssetAccountId: "44444444-4444-4444-4444-444444444444",
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
				userId: "11111111-1111-1111-1111-111111111111",
				personId: "22222222-2222-2222-2222-222222222222",
				amount: "-100.00",
				fundingAssetAccountId: "44444444-4444-4444-4444-444444444444",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects a missing fundingAssetAccountId", async () => {
		await expect(
			recordPersonReceivable({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				personId: "22222222-2222-2222-2222-222222222222",
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
				userId: "11111111-1111-1111-1111-111111111111",
				personId: "22222222-2222-2222-2222-222222222222",
				amount: "1000.00",
				fundingAssetAccountId: "44444444-4444-4444-4444-444444444444",
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
				userId: "11111111-1111-1111-1111-111111111111",
				personId: "22222222-2222-2222-2222-222222222222",
				amount: "1000.00",
				fundingAssetAccountId: "44444444-4444-4444-4444-444444444444",
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
				userId: "11111111-1111-1111-1111-111111111111",
				personId: "22222222-2222-2222-2222-222222222222",
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
					userId: "11111111-1111-1111-1111-111111111111",
					personId: "22222222-2222-2222-2222-222222222222",
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
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "",
				expectedRevisionNo: 1,
				amount: "1000.00",
				fundingAssetAccountId: "44444444-4444-4444-4444-444444444444",
				occurredAt: OCCURRED_AT,
				idempotencyKey: "key-1",
			}),
		).rejects.toThrow(PeopleError);
	});

	it("rejects an invalid budgetCategory on payable update", async () => {
		await expect(
			updatePersonPayableExpense({
				db: untouchedDb,
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "33333333-3333-3333-3333-333333333333",
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
				userId: "11111111-1111-1111-1111-111111111111",
				obligationId: "33333333-3333-3333-3333-333333333333",
				expectedRevisionNo: 1,
				idempotencyKey: "",
			}),
		).rejects.toThrow(PeopleError);
	});
});

describe("listPersonObligations strict date filter validation", () => {
	const validUserId = "11111111-1111-1111-1111-111111111111";

	function createSpiedDb() {
		return {
			transaction: vi.fn(),
			select: vi.fn(),
		} as unknown as Database;
	}

	it("rejects dueDateFrom: null before querying DB", async () => {
		const db = createSpiedDb();
		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateFrom: null as unknown as string,
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError &&
				e.code === "PEOPLE_INVALID_INPUT" &&
				e.message.includes("dueDateFrom"),
		);
		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});

	it("rejects dueDateUntil: null before querying DB", async () => {
		const db = createSpiedDb();
		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateUntil: null as unknown as string,
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError &&
				e.code === "PEOPLE_INVALID_INPUT" &&
				e.message.includes("dueDateUntil"),
		);
		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});

	it("rejects empty string and whitespace filters before querying DB", async () => {
		const db = createSpiedDb();
		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateFrom: "",
			}),
		).rejects.toThrow(PeopleError);

		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateUntil: "   ",
			}),
		).rejects.toThrow(PeopleError);

		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});

	it("rejects invalid Gregorian dates (2026-02-30, 2025-02-29) before querying DB", async () => {
		const db = createSpiedDb();
		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateFrom: "2026-02-30",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);

		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateUntil: "2025-02-29",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_INVALID_INPUT",
		);

		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});

	it("rejects non-string runtime filter values before querying DB", async () => {
		const db = createSpiedDb();
		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateFrom: 20260905 as unknown as string,
			}),
		).rejects.toThrow(PeopleError);

		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});

	it("rejects reversed date range (dueDateFrom > dueDateUntil) before querying DB", async () => {
		const db = createSpiedDb();
		await expect(
			listPersonObligations({
				db,
				userId: validUserId,
				dueDateFrom: "2026-10-01",
				dueDateUntil: "2026-09-30",
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError &&
				e.code === "PEOPLE_INVALID_INPUT" &&
				e.message.includes(
					"dueDateFrom must be less than or equal to dueDateUntil",
				),
		);

		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.select).not.toHaveBeenCalled();
	});
});
