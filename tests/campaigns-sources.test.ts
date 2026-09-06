import { describe, expect, it } from "vitest";
import { computeCampaignSemanticDiff } from "../src/campaigns/sources";

describe("computeCampaignSemanticDiff (Section 33/56)", () => {
	it("returns no diffs for identical terms", () => {
		const current = {
			targetSpendAmount: "5000.00",
			rewardKind: "REWARD_POINTS",
		};
		const candidate = {
			targetSpendAmount: "5000.00",
			rewardKind: "REWARD_POINTS",
		};
		expect(computeCampaignSemanticDiff(current, candidate)).toEqual([]);
	});

	it("surfaces a changed reward amount", () => {
		const current = { expectedRewardPoints: "500.0000" };
		const candidate = { expectedRewardPoints: "700.0000" };
		const diff = computeCampaignSemanticDiff(current, candidate);
		expect(diff).toEqual([
			{
				field: "expectedRewardPoints",
				currentValue: "500.0000",
				candidateValue: "700.0000",
			},
		]);
	});

	it("surfaces multiple changed fields sorted by field name", () => {
		const current = { endsOn: "2024-09-30", rewardKind: "REWARD_POINTS" };
		const candidate = { endsOn: "2024-10-15", rewardKind: "STATEMENT_CREDIT" };
		const diff = computeCampaignSemanticDiff(current, candidate);
		expect(diff.map((d) => d.field)).toEqual(["endsOn", "rewardKind"]);
	});

	it("surfaces a changed card scope array", () => {
		const current = { cardIds: ["card-a"] };
		const candidate = { cardIds: ["card-a", "card-b"] };
		const diff = computeCampaignSemanticDiff(current, candidate);
		expect(diff).toHaveLength(1);
		expect(diff[0]?.field).toBe("cardIds");
	});

	it("treats undefined and null as equivalent 'absent' values", () => {
		const current = { note: null };
		const candidate = {};
		expect(computeCampaignSemanticDiff(current, candidate)).toEqual([]);
	});
});
