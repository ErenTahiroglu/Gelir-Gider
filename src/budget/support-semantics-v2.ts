import type { SupportReceiptRole } from "../db/schema/budget-v2-semantics";

/**
 * Deterministic pure semantics of a Budget V2 SUPPORT receipt role. This is
 * the single authority the future live-source resolver must consult so it
 * cannot reinterpret these roles: no weights, no scores, no behavioural
 * inference -- three exact booleans.
 *
 *  - `includeInStructuralRealizedIncome`: whether the receipt amount is added
 *    to `realizedIncome` BEFORE the structural affordability deficit is
 *    computed.
 *  - `isBaselineIncome`: whether it counts as regular / baseline income
 *    (always false -- support is never baseline).
 *  - `isDeficitFunding`: whether it is a post-deficit funding source that must
 *    NOT be added to `realizedIncome` before the deficit calculation, and that
 *    feeds self-funding / dependency analytics.
 */
export interface SupportRoleSemantics {
	includeInStructuralRealizedIncome: boolean;
	isBaselineIncome: boolean;
	isDeficitFunding: boolean;
}

const SEMANTICS: Readonly<
	Record<SupportReceiptRole, Readonly<SupportRoleSemantics>>
> = Object.freeze({
	// Intentional gift/support for the user -- genuine realized support the
	// resolver WILL include in realizedIncome. Not baseline, and NOT evidence
	// the user could not self-fund.
	PLANNED_FAMILY_GIFT: Object.freeze({
		includeInStructuralRealizedIncome: true,
		isBaselineIncome: false,
		isDeficitFunding: false,
	}),
	// Family money used specifically to close the user's own affordability
	// deficit -- a post-deficit funding source. The resolver MUST NOT add it
	// to realizedIncome before the structural deficit is calculated.
	DEFICIT_FAMILY_SUPPORT: Object.freeze({
		includeInStructuralRealizedIncome: false,
		isBaselineIncome: false,
		isDeficitFunding: true,
	}),
});

export function supportRoleSemantics(
	role: SupportReceiptRole,
): Readonly<SupportRoleSemantics> {
	const s = SEMANTICS[role];
	if (!s) {
		// Unreachable for a validated role; fail-closed rather than guess.
		throw new Error(`Unknown Budget V2 support receipt role: ${String(role)}`);
	}
	return s;
}

export const SUPPORT_ROLE_SEMANTICS = SEMANTICS;
