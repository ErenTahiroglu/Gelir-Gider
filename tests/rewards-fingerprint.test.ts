import { describe, expect, it } from "vitest";
import {
	calculateRewardEventCreateFingerprint,
	type RewardEventCreateFingerprintParams,
} from "../src/rewards/fingerprint";

const BASE: RewardEventCreateFingerprintParams = {
	userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	rewardAccountId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
	eventType: "EARN",
	pointAmount: "100.0000",
	conversionRate: "1.000000",
	economicAmount: null,
	purchaseCategory: null,
	shortTermGoalId: null,
	merchant: null,
	description: null,
	reasonNote: "welcome bonus",
	sourceType: "MANUAL",
	sourceRef: null,
	occurredAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("calculateRewardEventCreateFingerprint (V2: binds provenance)", () => {
	it("produces a different fingerprint when reasonNote changes", async () => {
		const a = await calculateRewardEventCreateFingerprint(BASE);
		const b = await calculateRewardEventCreateFingerprint({
			...BASE,
			reasonNote: "different reason",
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint when sourceType changes (MANUAL vs CAMPAIGN)", async () => {
		const a = await calculateRewardEventCreateFingerprint(BASE);
		const b = await calculateRewardEventCreateFingerprint({
			...BASE,
			sourceType: "CAMPAIGN",
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint when sourceType changes (MANUAL vs IMPORT)", async () => {
		const a = await calculateRewardEventCreateFingerprint(BASE);
		const b = await calculateRewardEventCreateFingerprint({
			...BASE,
			sourceType: "IMPORT",
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint when sourceRef changes", async () => {
		const a = await calculateRewardEventCreateFingerprint({
			...BASE,
			sourceType: "CAMPAIGN",
			sourceRef: "campaign-1",
		});
		const b = await calculateRewardEventCreateFingerprint({
			...BASE,
			sourceType: "CAMPAIGN",
			sourceRef: "campaign-2",
		});
		expect(a).not.toBe(b);
	});

	it("produces the identical fingerprint for the exact same payload (stable replay)", async () => {
		const a = await calculateRewardEventCreateFingerprint(BASE);
		const b = await calculateRewardEventCreateFingerprint({ ...BASE });
		expect(a).toBe(b);
	});
});
