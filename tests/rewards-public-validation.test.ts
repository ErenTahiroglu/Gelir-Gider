import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import {
	createRewardAccount,
	updateRewardAccount,
} from "../src/rewards/accounts";
import { RewardError } from "../src/rewards/errors";
import {
	listRewardEvents,
	recordRewardEarn,
	recordRewardPurchase,
	voidRewardEvent,
} from "../src/rewards/events";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ACCOUNT_ID = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const EVENT_ID = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeDbStub() {
	const transaction = vi.fn(async () => {
		throw new Error("db.transaction must not be called for invalid input");
	});
	return { db: { transaction } as unknown as Database, transaction };
}

async function expectInvalidInputWithoutDb(
	fn: () => Promise<unknown>,
	transactionSpy: ReturnType<typeof vi.fn>,
	expectedCode = "REWARD_INVALID_INPUT",
) {
	let thrown: unknown;
	try {
		await fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(RewardError);
	expect((thrown as RewardError).code).toBe(expectedCode);
	expect(transactionSpy).not.toHaveBeenCalled();
}

describe("createRewardAccount: zero-DB-call rejection", () => {
	it("rejects a non-string code", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: 123 as unknown as string,
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a malformed code", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "1STARTS_WITH_DIGIT",
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects occurredAt = null (only undefined means omitted)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "MYCARD",
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
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
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "MYCARD",
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					occurredAt: new Date(),
					idempotencyKey: 123 as unknown as string,
				}),
			transaction,
		);
	});

	it("rejects a zero default conversion rate", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "MYCARD",
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					defaultConversionRate: "0",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a negative default conversion rate", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "MYCARD",
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					defaultConversionRate: "-1",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a malformed creditCardId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "MYCARD",
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					creditCardId: "not-a-uuid",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects an empty displayName", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				createRewardAccount({
					db,
					userId: USER_ID,
					code: "MYCARD",
					displayName: "  ",
					provider: "Bankasi",
					unitName: "points",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("updateRewardAccount: zero-DB-call rejection", () => {
	it("rejects invalid expectedRevisionNo", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				updateRewardAccount({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					expectedRevisionNo: 0,
					displayName: "My Card Points",
					provider: "Bankasi",
					unitName: "points",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("recordRewardEarn: zero-DB-call rejection", () => {
	it("rejects a zero point amount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardEarn({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "0",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a negative point amount (caller must never supply negative)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardEarn({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "-5",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects an over-precise point amount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardEarn({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "1.00001",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a point amount exceeding the NUMERIC(20,4) integer digit boundary", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardEarn({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "99999999999999999",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a conversionRateOverride exceeding the NUMERIC(18,6) integer digit boundary", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardEarn({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "100",
					conversionRateOverride: "9999999999999",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("recordRewardPurchase: zero-DB-call rejection", () => {
	it("rejects an invalid purchaseCategory", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "100",
					purchaseCategory: "BOGUS",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects caller-supplied economicAmount-shaped invalid point string", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "not-a-number",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a malformed shortTermGoalId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "100",
					purchaseCategory: "SHORT_TERM_PURCHASE",
					shortTermGoalId: "not-a-uuid",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a zero/invalid conversionRateOverride", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "100",
					conversionRateOverride: "0",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a derived economic amount that would overflow the NUMERIC(18,2) money contract", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "9999999999999999.9999",
					conversionRateOverride: "999999999999.999999",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a reward purchase whose economic value rounds to exactly 0.00", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "1",
					conversionRateOverride: "0.001",
					purchaseCategory: "UNCLASSIFIED",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects SHORT_TERM_PURCHASE without a shortTermGoalId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "100",
					purchaseCategory: "SHORT_TERM_PURCHASE",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a non-SHORT_TERM_PURCHASE category with a shortTermGoalId supplied", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				recordRewardPurchase({
					db,
					userId: USER_ID,
					rewardAccountId: ACCOUNT_ID,
					pointAmount: "100",
					purchaseCategory: "UNCLASSIFIED",
					shortTermGoalId: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
					occurredAt: new Date(),
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("voidRewardEvent: zero-DB-call rejection", () => {
	it("rejects a non-string idempotencyKey", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				voidRewardEvent({
					db,
					userId: USER_ID,
					rewardEventId: EVENT_ID,
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
				voidRewardEvent({
					db,
					userId: USER_ID,
					rewardEventId: EVENT_ID,
					expectedRevisionNo: -1,
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});

	it("rejects a malformed rewardEventId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				voidRewardEvent({
					db,
					userId: USER_ID,
					rewardEventId: "not-a-uuid",
					expectedRevisionNo: 1,
					idempotencyKey: "key-1",
				}),
			transaction,
		);
	});
});

describe("listRewardEvents: zero-DB-call filter rejection (strict, no truthiness)", () => {
	it("rejects eventType = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listRewardEvents({
					db,
					userId: USER_ID,
					eventType: null as unknown as undefined,
				}),
			transaction,
		);
	});

	it("rejects eventType = BOGUS", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listRewardEvents({
					db,
					userId: USER_ID,
					eventType: "BOGUS" as unknown as undefined,
				}),
			transaction,
		);
	});

	it("rejects status = null", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listRewardEvents({
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
				listRewardEvents({
					db,
					userId: USER_ID,
					status: "BOGUS" as unknown as undefined,
				}),
			transaction,
		);
	});
});
