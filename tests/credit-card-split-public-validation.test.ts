import { describe, expect, it, vi } from "vitest";
import { CreditCardError } from "../src/credit-cards/errors";
import {
	recordSharedCreditCardPurchase,
	updateCreditCardPurchaseWithSplit,
} from "../src/credit-cards/purchases";
import {
	createCreditCardPurchaseSplit,
	updateCreditCardPurchaseSplit,
	voidCreditCardPurchaseSplit,
} from "../src/credit-cards/splits";
import type { Database } from "../src/db/client";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PURCHASE_EVENT_ID = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const SPLIT_ID = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
const PERSON_A = "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee";
const CARD_ID = "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * A Database stub whose `.transaction` throws if ever invoked. Used to prove
 * that malformed input is rejected entirely before any DB work begins --
 * db.transaction call count is asserted separately via the spy.
 */
function makeDbStub() {
	const transaction = vi.fn(async () => {
		throw new Error("db.transaction must not be called for invalid input");
	});
	return { db: { transaction } as unknown as Database, transaction };
}

/** A Database stub whose `.transaction` resolves without executing `work`. */
function makeSucceedingDbStub(resolvedValue: unknown) {
	const transaction = vi.fn(async () => resolvedValue);
	return { db: { transaction } as unknown as Database, transaction };
}

async function expectInvalidInputWithoutDb(
	fn: () => Promise<unknown>,
	transactionSpy: ReturnType<typeof vi.fn>,
) {
	let thrown: unknown;
	try {
		await fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(CreditCardError);
	expect((thrown as CreditCardError).code).toBe("CREDIT_CARD_INVALID_INPUT");
	expect(transactionSpy).not.toHaveBeenCalled();
}

describe("createCreditCardPurchaseSplit: zero-DB-call rejection", () => {
	const basePurchaseEventId = PURCHASE_EVENT_ID;

	it("rejects method = 123 (runtime, not string)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: 123 as unknown as "EQUAL",
					participants: [{ personId: PERSON_A }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects idempotencyKey = 123 (runtime, not string)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					participants: [{ personId: PERSON_A }],
					idempotencyKey: 123 as unknown as string,
				}),
			transaction,
		);
	});

	it("rejects participants not an array", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					participants: "not-an-array" as unknown as [],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects duplicate canonical person IDs (same UUID, different case)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					participants: [
						{ personId: PERSON_A.toUpperCase() },
						{ personId: PERSON_A.toLowerCase() },
					],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("EQUAL: rejects userWeight = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					userWeight: null as unknown as undefined,
					participants: [{ personId: PERSON_A }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("EQUAL: rejects participant shareAmount = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					participants: [
						{ personId: PERSON_A, shareAmount: null as unknown as undefined },
					],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("EQUAL: rejects participant weight = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					participants: [
						{ personId: PERSON_A, weight: null as unknown as undefined },
					],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("MANUAL: rejects missing shareAmount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "MANUAL",
					participants: [{ personId: PERSON_A }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("MANUAL: rejects shareAmount = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "MANUAL",
					participants: [
						{ personId: PERSON_A, shareAmount: null as unknown as string },
					],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("MANUAL: rejects weight = null (weight must not be supplied)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "MANUAL",
					participants: [
						{
							personId: PERSON_A,
							shareAmount: "10.00",
							weight: null as unknown as undefined,
						},
					],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it.each([
		["empty string", ""],
		["whitespace", " "],
		["zero", "0"],
		["zero decimal", "0.00"],
		["negative", "-5.00"],
		["malformed precision", "10.001"],
		["non-money string", "abc"],
	])(
		"MANUAL: rejects invalid money shareAmount (%s)",
		async (_label, value) => {
			const { db, transaction } = makeDbStub();
			await expectInvalidInputWithoutDb(
				() =>
					createCreditCardPurchaseSplit({
						db,
						userId: USER_ID,
						purchaseEventId: basePurchaseEventId,
						method: "MANUAL",
						participants: [{ personId: PERSON_A, shareAmount: value }],
						idempotencyKey: "key-1",
					}),
				transaction,
			);
		},
	);

	it("RATIO: rejects userWeight = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "RATIO",
					userWeight: null as unknown as undefined,
					participants: [{ personId: PERSON_A, weight: 1 }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("RATIO: rejects participant shareAmount = null (shareAmount must not be supplied)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "RATIO",
					userWeight: 1,
					participants: [
						{
							personId: PERSON_A,
							weight: 1,
							shareAmount: null as unknown as undefined,
						},
					],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it.each([
		["null", null],
		["missing", undefined],
		["zero", 0],
		["fractional", 1.5],
	])(
		"RATIO: rejects invalid participant weight (%s)",
		async (_label, value) => {
			const { db, transaction } = makeDbStub();
			await expectInvalidInputWithoutDb(
				() =>
					createCreditCardPurchaseSplit({
						db,
						userId: USER_ID,
						purchaseEventId: basePurchaseEventId,
						method: "RATIO",
						userWeight: 1,
						participants: [
							{ personId: PERSON_A, weight: value as unknown as number },
						],
						idempotencyKey: "key-1",
					}),
				transaction,
			);
		},
	);

	it("rejects occurredAt = null (only undefined means omitted)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					purchaseEventId: basePurchaseEventId,
					method: "EQUAL",
					participants: [{ personId: PERSON_A }],
					idempotencyKey: "key-1",
					occurredAt: null as unknown as undefined,
				}),
			transaction,
		);
	});
});

describe("updateCreditCardPurchaseSplit: zero-DB-call rejection", () => {
	it("rejects invalid expectedRevisionNo", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				updateCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: 0,
					method: "EQUAL",
					participants: [{ personId: PERSON_A }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("EQUAL: rejects userWeight = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				updateCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: 1,
					method: "EQUAL",
					userWeight: null as unknown as undefined,
					participants: [{ personId: PERSON_A }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("MANUAL: rejects invalid money shareAmount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				updateCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: 1,
					method: "MANUAL",
					participants: [{ personId: PERSON_A, shareAmount: "abc" }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("RATIO: rejects weight = 0", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				updateCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: 1,
					method: "RATIO",
					userWeight: 1,
					participants: [{ personId: PERSON_A, weight: 0 }],
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("voidCreditCardPurchaseSplit: zero-DB-call rejection", () => {
	it("rejects occurredAt = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				voidCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: 1,
					idempotencyKey: "key-1",
					occurredAt: null as unknown as undefined,
				}),
			transaction,
		);
	});

	it("rejects a non-string idempotencyKey", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				voidCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: 1,
					idempotencyKey: 123 as unknown as string,
				}),
			transaction,
		);
	});

	it("rejects invalid expectedRevisionNo", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				voidCreditCardPurchaseSplit({
					db,
					userId: USER_ID,
					splitId: SPLIT_ID,
					expectedRevisionNo: -1,
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("coordinated APIs: invalid split payload -> zero DB calls", () => {
	it("recordSharedCreditCardPurchase rejects an invalid split method-specific payload before any DB work", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordSharedCreditCardPurchase({
					db,
					userId: USER_ID,
					cardId: CARD_ID,
					amount: "1000.00",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date("2026-09-01T00:00:00.000Z"),
					purchaseIdempotencyKey: "purchase-key-1",
					splitMethod: "MANUAL",
					// MANUAL requires shareAmount -- omitted here.
					participants: [{ personId: PERSON_A }],
					splitIdempotencyKey: "split-key-1",
				}),
			transaction,
		);
	});

	it("recordSharedCreditCardPurchase rejects an invalid PURCHASE-side payload before any DB work", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordSharedCreditCardPurchase({
					db,
					userId: USER_ID,
					cardId: CARD_ID,
					amount: "not-money",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date("2026-09-01T00:00:00.000Z"),
					purchaseIdempotencyKey: "purchase-key-1",
					splitMethod: "EQUAL",
					participants: [{ personId: PERSON_A }],
					splitIdempotencyKey: "split-key-1",
				}),
			transaction,
		);
	});

	it("updateCreditCardPurchaseWithSplit rejects an invalid split method-specific payload before any DB work", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				updateCreditCardPurchaseWithSplit({
					db,
					userId: USER_ID,
					purchaseEventId: PURCHASE_EVENT_ID,
					purchaseExpectedRevisionNo: 1,
					amount: "1000.00",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date("2026-09-01T00:00:00.000Z"),
					purchaseIdempotencyKey: "purchase-key-1",
					splitExpectedRevisionNo: 1,
					splitMethod: "RATIO",
					userWeight: 1,
					// RATIO requires participant weight -- missing here.
					participants: [{ personId: PERSON_A }],
					splitIdempotencyKey: "split-key-1",
				}),
			transaction,
		);
	});
});

describe("valid requests still reach the transaction exactly once", () => {
	it("valid EQUAL create calls db.transaction once", async () => {
		const { db, transaction } = makeSucceedingDbStub({
			split: {},
			idempotentReplay: false,
		});
		await createCreditCardPurchaseSplit({
			db,
			userId: USER_ID,
			purchaseEventId: PURCHASE_EVENT_ID,
			method: "EQUAL",
			participants: [{ personId: PERSON_A }],
			idempotencyKey: "key-1",
		});
		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it("valid MANUAL create calls db.transaction once", async () => {
		const { db, transaction } = makeSucceedingDbStub({
			split: {},
			idempotentReplay: false,
		});
		await createCreditCardPurchaseSplit({
			db,
			userId: USER_ID,
			purchaseEventId: PURCHASE_EVENT_ID,
			method: "MANUAL",
			participants: [{ personId: PERSON_A, shareAmount: "10.00" }],
			idempotencyKey: "key-1",
		});
		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it("valid RATIO create calls db.transaction once", async () => {
		const { db, transaction } = makeSucceedingDbStub({
			split: {},
			idempotentReplay: false,
		});
		await createCreditCardPurchaseSplit({
			db,
			userId: USER_ID,
			purchaseEventId: PURCHASE_EVENT_ID,
			method: "RATIO",
			userWeight: 1,
			participants: [{ personId: PERSON_A, weight: 1 }],
			idempotencyKey: "key-1",
		});
		expect(transaction).toHaveBeenCalledTimes(1);
	});
});
