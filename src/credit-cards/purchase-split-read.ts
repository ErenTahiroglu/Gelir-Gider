import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { effectiveRevisionAsOf } from "../db/effective-revision";
import {
	creditCardPurchaseSplitParticipants,
	creditCardPurchaseSplitRevisionItems,
	creditCardPurchaseSplitRevisionSeals,
	creditCardPurchaseSplitRevisions,
	creditCardPurchaseSplits,
} from "../db/schema/credit-card-splits";
import { parseAggregateMoneyString } from "../ledger/money";

/**
 * ONE authoritative AS-OF purchase-split reader for every financial consumer
 * (Budget V2 live resolver, checkpoint report, statement reconciliation
 * freshness). Replaces three separate interpretations of "authoritative split
 * truth".
 *
 * A non-VOID split revision is ACTIVE only when EVERY invariant holds:
 *   1. split anchor belongs to the user
 *   2. split anchor belongs to purchaseEventId
 *   3. effective revision = highest revisionNo with occurredAt <= asOf
 *      (Checkpoint 4B.2 rule; business-effective time only, no createdAt)
 *   4. that revision is non-VOID
 *   5. a split-revision seal row exists
 *   6. userShare + externalShare == gross
 *   7. SUM(exact revision item shares) == externalShare
 *   8. every revision item's participantId is a participant anchor of THIS split
 *   9. item.personId == that participant anchor's personId
 *  10. the participant anchor carries a resolvable personObligationId (FK)
 *  11. when `expectedPurchaseCents` is supplied: split gross == that amount
 *
 * Anything else -> UNRESOLVED (`inconsistent` distinguishes "not yet
 * authoritative", e.g. unsealed, from "internally corrupt"). Financial
 * consumers MUST fail closed on UNRESOLVED and MUST NOT read an unsealed
 * revision's userShareAmount or infer a missing share.
 *
 * NO_SPLIT and VOID_SPLIT both mean 100% PERSONAL economically, but are
 * reported distinctly so evidence can tell them apart. An UNSEALED non-VOID
 * revision is NOT NO_SPLIT -- it is UNRESOLVED.
 */

export interface AuthoritativeSplitParticipant {
	personId: string;
	personObligationId: string;
	shareAmount: string;
	shareCents: bigint;
}

export type AuthoritativePurchaseSplit =
	| { kind: "NO_SPLIT" }
	| {
			kind: "VOID_SPLIT";
			splitId: string;
			splitRevisionId: string;
			revisionNo: number;
	  }
	| {
			kind: "ACTIVE";
			splitId: string;
			splitRevisionId: string;
			revisionNo: number;
			sealed: true;
			grossAmount: string;
			grossCents: bigint;
			userShareAmount: string;
			userShareCents: bigint;
			externalShareAmount: string;
			externalShareCents: bigint;
			participants: AuthoritativeSplitParticipant[];
	  }
	| { kind: "UNRESOLVED"; reason: string; inconsistent: boolean };

export interface ResolveAuthoritativePurchaseSplitParams {
	db: Database;
	userId: string;
	purchaseEventId: string;
	asOf: Date;
	/** When supplied, ACTIVE additionally requires split gross == this. */
	expectedPurchaseCents?: bigint | undefined;
}

function cents(v: string): bigint {
	return parseAggregateMoneyString(v).cents;
}

export async function resolveAuthoritativePurchaseSplitAsOf(
	params: ResolveAuthoritativePurchaseSplitParams,
): Promise<AuthoritativePurchaseSplit> {
	const { db, userId, purchaseEventId, asOf, expectedPurchaseCents } = params;

	// (1,2) anchor -- owned by the user, bound to this purchase event
	const [split] = await db
		.select({
			id: creditCardPurchaseSplits.id,
			userId: creditCardPurchaseSplits.userId,
		})
		.from(creditCardPurchaseSplits)
		.where(eq(creditCardPurchaseSplits.purchaseEventId, purchaseEventId))
		.limit(1);
	if (!split) return { kind: "NO_SPLIT" };
	if (split.userId !== userId) {
		return {
			kind: "UNRESOLVED",
			reason: `split for purchase ${purchaseEventId} is not owned by this user`,
			inconsistent: true,
		};
	}

	// (3) effective split revision at asOf
	const revs = await db
		.select({
			id: creditCardPurchaseSplitRevisions.id,
			revisionNo: creditCardPurchaseSplitRevisions.revisionNo,
			operation: creditCardPurchaseSplitRevisions.operation,
			gross: creditCardPurchaseSplitRevisions.grossAmount,
			userShare: creditCardPurchaseSplitRevisions.userShareAmount,
			externalShare: creditCardPurchaseSplitRevisions.externalShareAmount,
			occurredAt: creditCardPurchaseSplitRevisions.occurredAt,
		})
		.from(creditCardPurchaseSplitRevisions)
		.where(eq(creditCardPurchaseSplitRevisions.splitId, split.id));
	const eff = effectiveRevisionAsOf(revs, asOf);
	if (!eff) return { kind: "NO_SPLIT" }; // no split revision was effective yet

	// (4) non-VOID
	if (eff.operation === "VOID") {
		return {
			kind: "VOID_SPLIT",
			splitId: split.id,
			splitRevisionId: eff.id,
			revisionNo: eff.revisionNo,
		};
	}

	// (5) sealed -- an unsealed non-VOID revision is UNRESOLVED, never NO_SPLIT
	const [seal] = await db
		.select({ id: creditCardPurchaseSplitRevisionSeals.splitRevisionId })
		.from(creditCardPurchaseSplitRevisionSeals)
		.where(eq(creditCardPurchaseSplitRevisionSeals.splitRevisionId, eff.id))
		.limit(1);
	if (!seal) {
		return {
			kind: "UNRESOLVED",
			reason: `split revision ${eff.id} for purchase ${purchaseEventId} is effective at ${asOf.toISOString()} but is not sealed`,
			inconsistent: false,
		};
	}

	const grossCents = cents(eff.gross);
	const userShareCents = cents(eff.userShare);
	const externalShareCents = cents(eff.externalShare);

	// (6) user + external == gross
	if (userShareCents + externalShareCents !== grossCents) {
		return {
			kind: "UNRESOLVED",
			reason: `split revision ${eff.id}: user ${userShareCents} + external ${externalShareCents} != gross ${grossCents}`,
			inconsistent: true,
		};
	}

	// (11) split gross == expected effective purchase amount
	if (
		expectedPurchaseCents !== undefined &&
		grossCents !== expectedPurchaseCents
	) {
		return {
			kind: "UNRESOLVED",
			reason: `split revision ${eff.id} gross ${grossCents} does not match the effective purchase amount ${expectedPurchaseCents} as of ${asOf.toISOString()}`,
			inconsistent: true,
		};
	}

	// (7,8,9,10) exact revision items -> participant anchors of the SAME split
	const items = await db
		.select({
			participantId: creditCardPurchaseSplitRevisionItems.participantId,
			personId: creditCardPurchaseSplitRevisionItems.personId,
			shareAmount: creditCardPurchaseSplitRevisionItems.shareAmount,
		})
		.from(creditCardPurchaseSplitRevisionItems)
		.where(eq(creditCardPurchaseSplitRevisionItems.splitRevisionId, eff.id));
	const anchors = await db
		.select({
			id: creditCardPurchaseSplitParticipants.id,
			personId: creditCardPurchaseSplitParticipants.personId,
			personObligationId:
				creditCardPurchaseSplitParticipants.personObligationId,
		})
		.from(creditCardPurchaseSplitParticipants)
		.where(eq(creditCardPurchaseSplitParticipants.splitId, split.id));
	const anchorById = new Map(anchors.map((a) => [a.id, a]));

	let itemsSum = 0n;
	const participants: AuthoritativeSplitParticipant[] = [];
	for (const it of items) {
		const sc = cents(it.shareAmount);
		itemsSum += sc;
		// (8) the item's participant anchor must belong to this split
		const anchor = anchorById.get(it.participantId);
		if (!anchor) {
			return {
				kind: "UNRESOLVED",
				reason: `split revision ${eff.id} item participant ${it.participantId} is not an anchored participant of split ${split.id}`,
				inconsistent: true,
			};
		}
		// (9) item personId == participant anchor personId
		if (anchor.personId !== it.personId) {
			return {
				kind: "UNRESOLVED",
				reason: `split revision ${eff.id} item person ${it.personId} disagrees with its participant anchor person ${anchor.personId}`,
				inconsistent: true,
			};
		}
		// (10) resolvable participant obligation identity (FK-backed, non-null)
		if (!anchor.personObligationId) {
			return {
				kind: "UNRESOLVED",
				reason: `split revision ${eff.id} participant ${it.participantId} has no resolvable obligation identity`,
				inconsistent: true,
			};
		}
		participants.push({
			personId: it.personId,
			personObligationId: anchor.personObligationId,
			shareAmount: it.shareAmount,
			shareCents: sc,
		});
	}

	// (7) exact item shares sum to the external share
	if (itemsSum !== externalShareCents) {
		return {
			kind: "UNRESOLVED",
			reason: `split revision ${eff.id}: item share sum ${itemsSum} != external share ${externalShareCents}`,
			inconsistent: true,
		};
	}

	return {
		kind: "ACTIVE",
		splitId: split.id,
		splitRevisionId: eff.id,
		revisionNo: eff.revisionNo,
		sealed: true,
		grossAmount: eff.gross,
		grossCents,
		userShareAmount: eff.userShare,
		userShareCents,
		externalShareAmount: eff.externalShare,
		externalShareCents,
		participants,
	};
}
