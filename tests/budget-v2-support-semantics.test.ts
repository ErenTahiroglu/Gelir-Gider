import { describe, expect, it } from "vitest";
import {
	SUPPORT_ROLE_SEMANTICS,
	supportRoleSemantics,
} from "../src/budget/support-semantics-v2";

describe("PERSONAL_BUDGET_V2 SUPPORT role pure semantics (resolver contract)", () => {
	// D
	it("D: PLANNED_FAMILY_GIFT -> included in structural realizedIncome, not baseline, not deficit funding", () => {
		expect(supportRoleSemantics("PLANNED_FAMILY_GIFT")).toEqual({
			includeInStructuralRealizedIncome: true,
			isBaselineIncome: false,
			isDeficitFunding: false,
		});
	});

	// E
	it("E: DEFICIT_FAMILY_SUPPORT -> NOT in structural realizedIncome, not baseline, is deficit funding", () => {
		expect(supportRoleSemantics("DEFICIT_FAMILY_SUPPORT")).toEqual({
			includeInStructuralRealizedIncome: false,
			isBaselineIncome: false,
			isDeficitFunding: true,
		});
	});

	it("the mapping is frozen and total over the two roles", () => {
		expect(Object.keys(SUPPORT_ROLE_SEMANTICS).sort()).toEqual([
			"DEFICIT_FAMILY_SUPPORT",
			"PLANNED_FAMILY_GIFT",
		]);
		expect(Object.isFrozen(SUPPORT_ROLE_SEMANTICS)).toBe(true);
		expect(Object.isFrozen(SUPPORT_ROLE_SEMANTICS.PLANNED_FAMILY_GIFT)).toBe(
			true,
		);
	});

	it("neither role is ever baseline income, and the two roles disagree on structural inclusion + deficit funding", () => {
		const gift = supportRoleSemantics("PLANNED_FAMILY_GIFT");
		const deficit = supportRoleSemantics("DEFICIT_FAMILY_SUPPORT");
		expect(gift.isBaselineIncome).toBe(false);
		expect(deficit.isBaselineIncome).toBe(false);
		expect(gift.includeInStructuralRealizedIncome).not.toBe(
			deficit.includeInStructuralRealizedIncome,
		);
		expect(gift.isDeficitFunding).not.toBe(deficit.isDeficitFunding);
	});

	it("throws (fail-closed) for an unknown role rather than guessing", () => {
		expect(() => supportRoleSemantics("MYSTERY" as never)).toThrow();
	});
});
