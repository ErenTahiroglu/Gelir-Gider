import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { MonthCloseError } from "../src/month-close/errors";
import {
	closeMonth,
	getMonthClose,
	listMonthCloses,
	previewMonthClose,
} from "../src/month-close/service";

const USER_ID = "019543ef-1111-7000-8000-000000000001";
const VALID_FINGERPRINT = "a".repeat(64);

/**
 * A Database stub whose `.transaction` throws if ever invoked. Used to prove
 * that malformed input is rejected entirely before any DB work begins.
 */
function makeDbStub() {
	const transaction = vi.fn(async () => {
		throw new Error("db.transaction must not be called for invalid input");
	});
	return { db: { transaction } as unknown as Database, transaction };
}

async function expectInvalidInputWithoutDb(
	fn: () => Promise<unknown>,
	transactionSpy: ReturnType<typeof vi.fn>,
	expectedCode: MonthCloseError["code"] = "MONTH_CLOSE_INVALID_INPUT",
) {
	let thrown: unknown;
	try {
		await fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(MonthCloseError);
	expect((thrown as MonthCloseError).code).toBe(expectedCode);
	expect(transactionSpy).not.toHaveBeenCalled();
}

describe("previewMonthClose: zero-DB-call rejection", () => {
	it("rejects a non-UUID userId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				previewMonthClose({ db, userId: "not-a-uuid", periodMonth: "2026-01" }),
			transaction,
		);
	});

	it("rejects a malformed periodMonth (YYYY-MM-DD instead of YYYY-MM)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				previewMonthClose({ db, userId: USER_ID, periodMonth: "2026-01-01" }),
			transaction,
		);
	});

	it("rejects a non-string periodMonth (runtime unknown, never pre-trimmed)", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				previewMonthClose({
					db,
					userId: USER_ID,
					periodMonth: 202601 as unknown as string,
				}),
			transaction,
		);
	});
});

describe("closeMonth: zero-DB-call rejection", () => {
	function baseParams(overrides: Record<string, unknown> = {}) {
		return {
			userId: USER_ID,
			periodMonth: "2026-01",
			expectedProposalFingerprint: VALID_FINGERPRINT,
			occurredAt: new Date("2026-02-01T00:00:00Z"),
			idempotencyKey: "test-key-1",
			...overrides,
		};
	}

	it("rejects an invalid expectedProposalFingerprint", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ expectedProposalFingerprint: "not-hex" }),
				} as never),
			transaction,
		);
	});

	it("rejects decision without db call when malformed", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ decision: "BOGUS" }),
				} as never),
			transaction,
		);
	});

	it("rejects PARTIAL decision missing partialAmount", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ decision: "PARTIAL" }),
				} as never),
			transaction,
		);
	});

	it("rejects FULL decision with a partialAmount supplied", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ decision: "FULL", partialAmount: "10.00" }),
				} as never),
			transaction,
		);
	});

	it("rejects SKIP decision with a partialAmount supplied", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ decision: "SKIP", partialAmount: "10.00" }),
				} as never),
			transaction,
		);
	});

	it("rejects a partialAmount supplied without any decision", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ partialAmount: "10.00" }),
				} as never),
			transaction,
		);
	});

	it("rejects an invalid occurredAt", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ occurredAt: "2026-01-01" }),
				} as never),
			transaction,
		);
	});

	it("rejects an invalid idempotencyKey", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ idempotencyKey: "" }),
				} as never),
			transaction,
		);
	});

	it("rejects an invalid userId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				closeMonth({
					db,
					...baseParams({ userId: "bad" }),
				} as never),
			transaction,
		);
	});
});

describe("getMonthClose / listMonthCloses: zero-DB-call rejection", () => {
	it("getMonthClose rejects a malformed periodMonth", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() => getMonthClose({ db, userId: USER_ID, periodMonth: "bad" }),
			transaction,
		);
	});

	it("listMonthCloses rejects periodMonthFrom after periodMonthUntil", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() =>
				listMonthCloses({
					db,
					userId: USER_ID,
					periodMonthFrom: "2026-06",
					periodMonthUntil: "2026-01",
				}),
			transaction,
		);
	});

	it("listMonthCloses rejects an invalid userId", async () => {
		const { db, transaction } = makeDbStub();
		await expectInvalidInputWithoutDb(
			() => listMonthCloses({ db, userId: "nope" }),
			transaction,
		);
	});
});
