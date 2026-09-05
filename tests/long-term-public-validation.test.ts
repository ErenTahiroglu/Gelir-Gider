import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { LongTermError } from "../src/long-term/errors";
import {
	allocateLongTermInvestment,
	cancelLongTermInvestmentTask,
	listLongTermInvestmentTasks,
	markLongTermInvestmentSent,
	reopenLongTermInvestmentSend,
} from "../src/long-term/service";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MIDAS_ACCOUNT_ID = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const TASK_ID = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeDbStub() {
	const transaction = vi.fn(async () => {
		throw new Error("db.transaction must not be called for invalid input");
	});
	return { db: { transaction } as unknown as Database, transaction };
}

async function expectInvalidInputWithoutDb(
	fn: () => Promise<unknown>,
	transactionSpy: ReturnType<typeof vi.fn>,
	expectedCode = "LONG_TERM_INVALID_INPUT",
) {
	let thrown: unknown;
	try {
		await fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(LongTermError);
	expect((thrown as LongTermError).code).toBe(expectedCode);
	expect(transactionSpy).not.toHaveBeenCalled();
}

describe("allocateLongTermInvestment: zero-DB-call rejection", () => {
	it("rejects a non-string userId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: 123 as unknown as string,
					midasAccountId: MIDAS_ACCOUNT_ID,
					amount: "100.00",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a zero amount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: USER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					amount: "0",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a negative amount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: USER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					amount: "-100.00",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a malformed midasAccountId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: USER_ID,
					midasAccountId: "not-a-uuid",
					amount: "100.00",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects occurredAt = null (only undefined means omitted for optional fields; occurredAt is required)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: USER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					amount: "100.00",
					occurredAt: null as unknown as Date,
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a non-string idempotencyKey", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: USER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					amount: "100.00",
					occurredAt: new Date(),
					idempotencyKey: 123 as unknown as string,
				}),
			transaction,
		);
	});

	it("rejects an empty destinationLabel exceeding max length", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				allocateLongTermInvestment({
					db,
					userId: USER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					amount: "100.00",
					destinationLabel: "x".repeat(121),
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("markLongTermInvestmentSent: zero-DB-call rejection", () => {
	it("rejects an invalid expectedRevisionNo", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				markLongTermInvestmentSent({
					db,
					userId: USER_ID,
					taskId: TASK_ID,
					expectedRevisionNo: 0,
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a malformed taskId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				markLongTermInvestmentSent({
					db,
					userId: USER_ID,
					taskId: "not-a-uuid",
					expectedRevisionNo: 1,
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("reopenLongTermInvestmentSend: zero-DB-call rejection", () => {
	it("rejects a non-string idempotencyKey", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				reopenLongTermInvestmentSend({
					db,
					userId: USER_ID,
					taskId: TASK_ID,
					expectedRevisionNo: 1,
					occurredAt: new Date(),
					idempotencyKey: 123 as unknown as string,
				}),
			transaction,
		);
	});

	it("rejects an oversized reasonNote", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				reopenLongTermInvestmentSend({
					db,
					userId: USER_ID,
					taskId: TASK_ID,
					expectedRevisionNo: 1,
					reasonNote: "x".repeat(501),
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("cancelLongTermInvestmentTask: zero-DB-call rejection", () => {
	it("rejects invalid expectedRevisionNo", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				cancelLongTermInvestmentTask({
					db,
					userId: USER_ID,
					taskId: TASK_ID,
					expectedRevisionNo: -1,
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("listLongTermInvestmentTasks: zero-DB-call filter rejection", () => {
	it("rejects status = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listLongTermInvestmentTasks({
					db,
					userId: USER_ID,
					status: null as unknown as undefined,
				}),
			transaction,
		);
	});

	it("rejects status = BOGUS", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listLongTermInvestmentTasks({
					db,
					userId: USER_ID,
					status: "BOGUS" as unknown as undefined,
				}),
			transaction,
		);
	});

	it("rejects a malformed midasAccountId filter", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listLongTermInvestmentTasks({
					db,
					userId: USER_ID,
					midasAccountId: "not-a-uuid",
				}),
			transaction,
		);
	});
});
