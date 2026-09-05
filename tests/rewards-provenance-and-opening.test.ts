import { describe, expect, it, vi } from "vitest";
import type { DatabaseTransaction } from "../src/db/client";
import {
	validateRewardPurchaseCategory,
	validateRewardSourceRef,
	validateRewardSourceType,
} from "../src/rewards/calendar";
import { RewardError } from "../src/rewards/errors";
import { recordRewardEarnInTransaction } from "../src/rewards/events";
import { calculateRewardEventCreateFingerprint } from "../src/rewards/fingerprint";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ACCOUNT_ID = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeTxStub() {
	const select = vi.fn(() => {
		throw new Error(
			"tx.select must not be called when validation fails pre-DB",
		);
	});
	const insert = vi.fn(() => {
		throw new Error(
			"tx.insert must not be called when validation fails pre-DB",
		);
	});
	return {
		tx: { select, insert } as unknown as DatabaseTransaction,
		select,
		insert,
	};
}

describe("Strict EARN Provenance & Input Semantics", () => {
	it("rejects sourceType = null without calling DB", async () => {
		const { tx, select, insert } = makeTxStub();
		let thrown: unknown;
		try {
			await recordRewardEarnInTransaction(tx, {
				userId: USER_ID,
				rewardAccountId: ACCOUNT_ID,
				pointAmount: "100",
				reasonNote: null,
				occurredAt: new Date(),
				idempotencyKey: "key-1",
				sourceType: null as unknown as undefined,
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RewardError);
		expect((thrown as RewardError).code).toBe("REWARD_INVALID_INPUT");
		expect(select).not.toHaveBeenCalled();
		expect(insert).not.toHaveBeenCalled();
	});

	it("rejects sourceType = BOGUS without calling DB", async () => {
		const { tx, select, insert } = makeTxStub();
		let thrown: unknown;
		try {
			await recordRewardEarnInTransaction(tx, {
				userId: USER_ID,
				rewardAccountId: ACCOUNT_ID,
				pointAmount: "100",
				reasonNote: null,
				occurredAt: new Date(),
				idempotencyKey: "key-1",
				sourceType: "BOGUS" as unknown as undefined,
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RewardError);
		expect((thrown as RewardError).code).toBe("REWARD_INVALID_INPUT");
		expect(select).not.toHaveBeenCalled();
		expect(insert).not.toHaveBeenCalled();
	});

	it("rejects empty string sourceRef = '' without calling DB", async () => {
		const { tx, select, insert } = makeTxStub();
		let thrown: unknown;
		try {
			await recordRewardEarnInTransaction(tx, {
				userId: USER_ID,
				rewardAccountId: ACCOUNT_ID,
				pointAmount: "100",
				reasonNote: null,
				occurredAt: new Date(),
				idempotencyKey: "key-1",
				sourceRef: "",
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RewardError);
		expect((thrown as RewardError).code).toBe("REWARD_INVALID_INPUT");
		expect(select).not.toHaveBeenCalled();
		expect(insert).not.toHaveBeenCalled();
	});

	it("rejects whitespace-only sourceRef = '   ' without calling DB", async () => {
		const { tx, select, insert } = makeTxStub();
		let thrown: unknown;
		try {
			await recordRewardEarnInTransaction(tx, {
				userId: USER_ID,
				rewardAccountId: ACCOUNT_ID,
				pointAmount: "100",
				reasonNote: null,
				occurredAt: new Date(),
				idempotencyKey: "key-1",
				sourceRef: "   ",
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RewardError);
		expect((thrown as RewardError).code).toBe("REWARD_INVALID_INPUT");
		expect(select).not.toHaveBeenCalled();
		expect(insert).not.toHaveBeenCalled();
	});

	it("rejects non-string sourceRef = 123 without calling DB", async () => {
		const { tx, select, insert } = makeTxStub();
		let thrown: unknown;
		try {
			await recordRewardEarnInTransaction(tx, {
				userId: USER_ID,
				rewardAccountId: ACCOUNT_ID,
				pointAmount: "100",
				reasonNote: null,
				occurredAt: new Date(),
				idempotencyKey: "key-1",
				sourceRef: 123 as unknown as string,
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RewardError);
		expect((thrown as RewardError).code).toBe("REWARD_INVALID_INPUT");
		expect(select).not.toHaveBeenCalled();
		expect(insert).not.toHaveBeenCalled();
	});

	it("validateRewardSourceType accepts valid types and rejects invalid ones", () => {
		expect(validateRewardSourceType("MANUAL")).toBe("MANUAL");
		expect(validateRewardSourceType("CAMPAIGN")).toBe("CAMPAIGN");
		expect(validateRewardSourceType("IMPORT")).toBe("IMPORT");
		expect(() => validateRewardSourceType(null)).toThrow(RewardError);
		expect(() => validateRewardSourceType(undefined)).toThrow(RewardError);
		expect(() => validateRewardSourceType("")).toThrow(RewardError);
		expect(() => validateRewardSourceType("OTHER")).toThrow(RewardError);
	});

	it("validateRewardSourceRef handles undefined, null, valid strings and invalid inputs", () => {
		expect(validateRewardSourceRef(undefined)).toBeNull();
		expect(validateRewardSourceRef(null)).toBeNull();
		expect(validateRewardSourceRef("CMP_123")).toBe("CMP_123");
		expect(validateRewardSourceRef("  CMP_123  ")).toBe("CMP_123");
		expect(() => validateRewardSourceRef("")).toThrow(RewardError);
		expect(() => validateRewardSourceRef("   ")).toThrow(RewardError);
		expect(() => validateRewardSourceRef(123)).toThrow(RewardError);
		expect(() => validateRewardSourceRef({})).toThrow(RewardError);
		expect(() => validateRewardSourceRef("a".repeat(129))).toThrow(RewardError);
	});
});

describe("Purchase Category Validation", () => {
	it("accepts valid categories including UNCLASSIFIED", () => {
		expect(validateRewardPurchaseCategory("MANDATORY_EXPENSE")).toBe(
			"MANDATORY_EXPENSE",
		);
		expect(validateRewardPurchaseCategory("DISCRETIONARY_SPEND")).toBe(
			"DISCRETIONARY_SPEND",
		);
		expect(validateRewardPurchaseCategory("SHORT_TERM_PURCHASE")).toBe(
			"SHORT_TERM_PURCHASE",
		);
		expect(validateRewardPurchaseCategory("UNCLASSIFIED")).toBe("UNCLASSIFIED");
	});

	it("rejects null, undefined, empty string and unknown categories", () => {
		expect(() => validateRewardPurchaseCategory(null)).toThrow(RewardError);
		expect(() => validateRewardPurchaseCategory(undefined)).toThrow(
			RewardError,
		);
		expect(() => validateRewardPurchaseCategory("")).toThrow(RewardError);
		expect(() => validateRewardPurchaseCategory("BOGUS")).toThrow(RewardError);
	});
});

describe("Fingerprint V2 Provenance Sensitivity", () => {
	const occurredAt = new Date("2026-06-15T12:00:00Z");

	it("produces distinct fingerprints for different provenance inputs under same parameters", async () => {
		const baseParams = {
			userId: USER_ID,
			rewardAccountId: ACCOUNT_ID,
			eventType: "EARN",
			pointAmount: "100.0000",
			conversionRate: "1.000000",
			economicAmount: null,
			purchaseCategory: null,
			shortTermGoalId: null,
			merchant: null,
			description: null,
			reasonNote: null,
			occurredAt,
		};

		const fp1 = await calculateRewardEventCreateFingerprint({
			...baseParams,
			sourceType: "CAMPAIGN",
			sourceRef: "CMP_123",
		});

		const fp2 = await calculateRewardEventCreateFingerprint({
			...baseParams,
			sourceType: "CAMPAIGN",
			sourceRef: null,
		});

		const fp3 = await calculateRewardEventCreateFingerprint({
			...baseParams,
			sourceType: "MANUAL",
			sourceRef: null,
		});

		expect(fp1).not.toBe(fp2);
		expect(fp1).not.toBe(fp3);
		expect(fp2).not.toBe(fp3);
	});
});
