import { describe, expect, it } from "vitest";
import journal from "../migrations/meta/_journal.json";

/**
 * `drizzle-kit migrate` determines which journal entries are "new" by
 * comparing each entry's `when` timestamp against the most recently applied
 * migration's recorded `created_at` (itself sourced from `when` at generate
 * time) -- NOT by `idx` order. An entry whose `when` is not strictly greater
 * than its predecessor's is silently treated as already-applied and never
 * runs, even though `idx` correctly places it last in the journal and
 * `drizzle-kit generate` reports no pending schema changes.
 *
 * This exact defect occurred during Phase 18: migration 0056's hand-set
 * `when` (1788760830651) was earlier than 0055's (1788780000000), so two
 * consecutive `drizzle-kit migrate` runs both reported "migrations applied
 * successfully" while never creating the new tables. Caught only by
 * independently querying `information_schema.tables` against the live
 * database after a "successful" apply.
 */
describe("Migration journal integrity (Phase 18 regression)", () => {
	const entries = journal.entries as Array<{
		idx: number;
		when: number;
		tag: string;
	}>;

	it("has entries sorted by idx ascending, starting at 0 with no gaps", () => {
		for (let i = 0; i < entries.length; i++) {
			expect(entries[i]?.idx).toBe(i);
		}
	});

	/**
	 * Entry idx 24 ("0024_wise_hannibal_king") predates this regression test
	 * by many phases and already has `when` earlier than idx 23's -- a
	 * pre-existing historical anomaly, already safely applied on every real
	 * database this project has ever migrated, and out of scope to rewrite
	 * retroactively (mutating a `when` that's already recorded as an applied
	 * migration's `created_at` on a live database would itself be far riskier
	 * than leaving it alone). Every entry from this baseline onward -- i.e.
	 * every migration added since -- MUST be strictly increasing, since that
	 * is the exact invariant `drizzle-kit migrate` depends on.
	 */
	const MONOTONIC_FROM_IDX = 25;

	it("has strictly increasing `when` timestamps from idx 25 onward", () => {
		for (let i = Math.max(1, MONOTONIC_FROM_IDX); i < entries.length; i++) {
			const prev = entries[i - 1] as { when: number; tag: string };
			const curr = entries[i] as { when: number; tag: string };
			expect(
				curr.when,
				`entry "${curr.tag}" (idx ${i}) has when=${curr.when}, which is not ` +
					`greater than its predecessor "${prev.tag}"'s when=${prev.when} -- ` +
					`drizzle-kit migrate would silently skip this migration`,
			).toBeGreaterThan(prev.when);
		}
	});

	it("has a tag for every entry matching its idx-padded prefix", () => {
		for (const entry of entries) {
			const expectedPrefix = String(entry.idx).padStart(4, "0");
			expect(entry.tag.startsWith(expectedPrefix)).toBe(true);
		}
	});
});
