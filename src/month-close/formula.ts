/**
 * Pure exact-arithmetic surplus formula helpers (Phase 14, Section 6).
 * Operates exclusively on BigInt integer cents -- never JS floating-point.
 *
 * For each ceiling: effectiveSpent = max(netExpense, 0); unused =
 * max(ceiling - effectiveSpent, 0). Unused can never exceed its original
 * ceiling (a net refund/credit must NOT generate surplus above the budget
 * ceiling). closeSurplus = mandatoryUnused + discretionaryUnused.
 */

/**
 * Clamps a signed cents value to a non-negative floor (used for
 * effectiveSpent = max(netExpense, 0)).
 */
export function clampNonNegativeCents(cents: bigint): bigint {
	return cents < 0n ? 0n : cents;
}

/**
 * Computes unused = max(ceiling - max(netExpense, 0), 0) for a single
 * budget ceiling component. Never negative, never exceeds `ceilingCents`.
 */
export function computeMonthCloseUnusedCents(
	ceilingCents: bigint,
	netExpenseCents: bigint,
): bigint {
	const effectiveSpent = clampNonNegativeCents(netExpenseCents);
	const unused = ceilingCents - effectiveSpent;
	return unused > 0n ? unused : 0n;
}

/**
 * Computes closeSurplus = mandatoryUnused + discretionaryUnused.
 */
export function computeMonthCloseSurplusCents(
	mandatoryUnusedCents: bigint,
	discretionaryUnusedCents: bigint,
): bigint {
	return mandatoryUnusedCents + discretionaryUnusedCents;
}

/**
 * Computes fullOfferAmount = min(closeSurplus, goal.remainingToTarget), and
 * the remainder that stays UNALLOCATED if the FULL offer were accepted
 * (Section 10).
 */
export function computeMonthCloseFullOffer(
	closeSurplusCents: bigint,
	remainingToTargetCents: bigint,
): { fullOfferCents: bigint; unroutedRemainderIfFullCents: bigint } {
	const fullOfferCents =
		closeSurplusCents < remainingToTargetCents
			? closeSurplusCents
			: remainingToTargetCents;
	return {
		fullOfferCents,
		unroutedRemainderIfFullCents: closeSurplusCents - fullOfferCents,
	};
}

/**
 * Formats integer (possibly negative, for defensive display only) cents
 * into an exact decimal money string.
 */
export function formatMonthCloseCents(cents: bigint): string {
	const isNegative = cents < 0n;
	const abs = isNegative ? -cents : cents;
	const intPart = abs / 100n;
	const frac = abs % 100n;
	const fracPart = frac < 10n ? `0${frac.toString()}` : frac.toString();
	return `${isNegative ? "-" : ""}${intPart.toString()}.${fracPart}`;
}
