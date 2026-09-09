/**
 * BUSINESS-EFFECTIVE revision selection for append-only revision chains.
 *
 * One shared rule for "what state was in effect at `asOf`?": pick the row with
 * the HIGHEST `revisionNo` among those whose `occurredAt` (the domain's
 * business-effective instant) is at or before `asOf`. Returns `undefined` when
 * no revision was effective yet at that instant (the entity did not exist).
 *
 * A later `revisionNo` whose `occurredAt` is AFTER `asOf` must never shadow an
 * older effective revision, so this NEVER simply takes the last array element
 * and NEVER selects "latest, then test its occurredAt". Input order is
 * irrelevant.
 *
 * This is business-effective (`occurredAt`) time only. It is NOT a bitemporal /
 * transaction-time (`createdAt`) model; later-backdated corrections are out of
 * scope here (future persisted checkpoint snapshots freeze historical reports).
 */
export function effectiveRevisionAsOf<
	T extends { revisionNo: number; occurredAt: Date | string },
>(revisions: readonly T[], asOf: Date): T | undefined {
	const cutoff = asOf.getTime();
	let chosen: T | undefined;
	for (const r of revisions) {
		const at =
			r.occurredAt instanceof Date
				? r.occurredAt.getTime()
				: new Date(r.occurredAt).getTime();
		if (at > cutoff) continue;
		if (!chosen || r.revisionNo > chosen.revisionNo) chosen = r;
	}
	return chosen;
}
