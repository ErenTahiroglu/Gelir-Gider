import { describe, expect, it } from "vitest";
import {
	computeRepeatableExpectedPoints,
	computeRepeatableStepsEarned,
	formatCampaignCentsToMoney,
	formatCampaignPointUnitsToDecimal,
	parseCampaignAggregateMoneyString,
	parseCampaignOptionalPositiveMoneyString,
	parseCampaignPointQuantity,
	parseCampaignPositiveMoneyString,
} from "../src/campaigns/decimal";
import { CampaignError } from "../src/campaigns/errors";

describe("parseCampaignPositiveMoneyString", () => {
	it("parses and normalizes a positive money string exactly", () => {
		const parsed = parseCampaignPositiveMoneyString(
			"5000",
			"targetSpendAmount",
		);
		expect(parsed.normalized).toBe("5000.00");
		expect(parsed.cents).toBe(500_000n);
	});

	it("rejects zero and negative amounts", () => {
		expect(() =>
			parseCampaignPositiveMoneyString("0", "targetSpendAmount"),
		).toThrow(CampaignError);
		expect(() =>
			parseCampaignPositiveMoneyString("-1", "targetSpendAmount"),
		).toThrow(CampaignError);
	});

	it("rejects non-string input", () => {
		expect(() =>
			parseCampaignPositiveMoneyString(5000, "targetSpendAmount"),
		).toThrow(CampaignError);
	});
});

describe("parseCampaignOptionalPositiveMoneyString", () => {
	it("returns null when omitted", () => {
		expect(
			parseCampaignOptionalPositiveMoneyString(
				undefined,
				"minimumTransactionAmount",
			),
		).toBeNull();
		expect(
			parseCampaignOptionalPositiveMoneyString(
				null,
				"minimumTransactionAmount",
			),
		).toBeNull();
	});

	it("parses a supplied value", () => {
		const parsed = parseCampaignOptionalPositiveMoneyString(
			"100.50",
			"minimumTransactionAmount",
		);
		expect(parsed?.normalized).toBe("100.50");
	});
});

describe("parseCampaignPointQuantity", () => {
	it("parses exact 4-decimal point quantities", () => {
		const parsed = parseCampaignPointQuantity("100.5");
		expect(parsed.normalized).toBe("100.5000");
		expect(parsed.units).toBe(1_005_000n);
	});

	it("rejects zero/negative", () => {
		expect(() => parseCampaignPointQuantity("0")).toThrow(CampaignError);
	});
});

describe("formatCampaignCentsToMoney / formatCampaignPointUnitsToDecimal", () => {
	it("formats cents back to money exactly", () => {
		expect(formatCampaignCentsToMoney(500_000n)).toBe("5000.00");
		expect(formatCampaignCentsToMoney(1n)).toBe("0.01");
		expect(formatCampaignCentsToMoney(0n)).toBe("0.00");
	});

	it("rejects negative cents", () => {
		expect(() => formatCampaignCentsToMoney(-1n)).toThrow(CampaignError);
	});

	it("formats point units back to decimal exactly", () => {
		expect(formatCampaignPointUnitsToDecimal(3_000_000n)).toBe("300.0000");
		expect(formatCampaignPointUnitsToDecimal(1n)).toBe("0.0001");
	});
});

describe("parseCampaignAggregateMoneyString", () => {
	it("parses an aggregate money string (e.g. SUM output)", () => {
		expect(parseCampaignAggregateMoneyString("12345.67").cents).toBe(
			1_234_567n,
		);
	});
});

// Section 54: REPEATABLE_SPEND matrix -- exact bigint stepping, no float.
describe("computeRepeatableStepsEarned (Section 54 matrix)", () => {
	it("stepSpend=1000, maxSteps=5: 3450 total -> 3 steps", () => {
		const steps = computeRepeatableStepsEarned(345_000n, 100_000n, 5);
		expect(steps).toBe(3n);
	});

	it("stepSpend=1000, maxSteps=5: 7000 total -> capped at 5 steps", () => {
		const steps = computeRepeatableStepsEarned(700_000n, 100_000n, 5);
		expect(steps).toBe(5n);
	});

	it("exactly at a step boundary counts the step", () => {
		const steps = computeRepeatableStepsEarned(200_000n, 100_000n, 5);
		expect(steps).toBe(2n);
	});

	it("zero spend yields zero steps", () => {
		expect(computeRepeatableStepsEarned(0n, 100_000n, 5)).toBe(0n);
	});

	it("rejects non-positive stepSpendCents", () => {
		expect(() => computeRepeatableStepsEarned(100n, 0n, 5)).toThrow(
			CampaignError,
		);
	});
});

describe("computeRepeatableExpectedPoints (Section 54 matrix)", () => {
	it("3 steps * 100 points/step = 300 points", () => {
		const expected = computeRepeatableExpectedPoints(3n, 1_000_000n); // 100.0000 units
		expect(expected).toBe(3_000_000n);
		expect(formatCampaignPointUnitsToDecimal(expected)).toBe("300.0000");
	});

	it("5 steps (capped) * 100 points/step = 500 points", () => {
		const expected = computeRepeatableExpectedPoints(5n, 1_000_000n);
		expect(formatCampaignPointUnitsToDecimal(expected)).toBe("500.0000");
	});
});
