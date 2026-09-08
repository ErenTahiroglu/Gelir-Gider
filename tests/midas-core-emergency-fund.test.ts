import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import {
	MIDAS_BUCKET_TYPES,
	SINGLETON_BUCKET_TYPES,
} from "../src/db/schema/midas";
import { MidasError } from "../src/midas/errors";
import { createMidasBucket } from "../src/midas/service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MIDAS_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Ordered mock `Database` for `createMidasBucket`'s exact call sequence:
 *   1. select midas_accounts (existence) -> [account]
 *   2. select midas_buckets  (code conflict) -> []
 *   3. select midas_buckets  (singleton type conflict) -> `singletonRows`
 */
function makeDb(singletonRows: unknown[]) {
	let call = 0;
	const results: unknown[][] = [
		[{ id: MIDAS_ACCOUNT_ID, userId: USER_ID }],
		[],
		singletonRows,
	];
	const select = vi.fn(() => ({
		from: () => ({
			where: () => ({
				limit: () => Promise.resolve(results[call++] ?? []),
			}),
		}),
	}));
	const insert = vi.fn(() => ({
		values: (row: { code: string; name: string; bucketType: string }) => ({
			returning: () =>
				Promise.resolve([
					{
						id: "44444444-4444-4444-8444-444444444444",
						userId: USER_ID,
						midasAccountId: MIDAS_ACCOUNT_ID,
						code: row.code,
						name: row.name,
						bucketType: row.bucketType,
						createdAt: new Date(),
					},
				]),
		}),
	}));
	return { select, insert } as unknown as Database;
}

describe("CORE_EMERGENCY_FUND Midas bucket primitive (Budget V2 foundation)", () => {
	it("is a registered bucket type, appended without disturbing existing types", () => {
		expect(MIDAS_BUCKET_TYPES).toEqual([
			"CREDIT_CARD_RESERVE",
			"SHORT_TERM_GOAL",
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
			"CORE_EMERGENCY_FUND",
		]);
		// INCOME_BUFFER keeps its exact identity and position -- not renamed,
		// not reinterpreted.
		expect(MIDAS_BUCKET_TYPES.indexOf("INCOME_BUFFER")).toBe(3);
		expect(MIDAS_BUCKET_TYPES).toContain("INCOME_BUFFER");
	});

	it("participates in singleton semantics; INCOME_BUFFER's singleton status is untouched", () => {
		expect(SINGLETON_BUCKET_TYPES).toEqual([
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
			"CORE_EMERGENCY_FUND",
		]);
		expect(SINGLETON_BUCKET_TYPES).toContain("INCOME_BUFFER");
		expect(SINGLETON_BUCKET_TYPES).toContain("CORE_EMERGENCY_FUND");
	});

	it("createMidasBucket accepts bucketType CORE_EMERGENCY_FUND (reaches DB work)", async () => {
		const db = makeDb([]); // no existing singleton
		const rec = await createMidasBucket({
			db,
			userId: USER_ID,
			midasAccountId: MIDAS_ACCOUNT_ID,
			code: "CORE_EMERGENCY_FUND",
			name: "Core Emergency Fund",
			bucketType: "CORE_EMERGENCY_FUND",
		});
		expect(rec.bucketType).toBe("CORE_EMERGENCY_FUND");
	});

	it("rejects a SECOND CORE_EMERGENCY_FUND bucket on the same Midas account (singleton)", async () => {
		const db = makeDb([
			{
				id: "99999999-9999-4999-8999-999999999999",
				bucketType: "CORE_EMERGENCY_FUND",
			},
		]);
		await expect(
			createMidasBucket({
				db,
				userId: USER_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				code: "CORE_EMERGENCY_FUND_2",
				name: "Second Core Emergency Fund",
				bucketType: "CORE_EMERGENCY_FUND",
			}),
		).rejects.toMatchObject({
			name: "MidasError",
			code: "MIDAS_BUCKET_CONFLICT",
		});
	});

	it("still accepts every pre-existing bucket type", async () => {
		for (const t of [
			"CREDIT_CARD_RESERVE",
			"SHORT_TERM_GOAL",
			"MEDIUM_TERM_RESERVE",
			"INCOME_BUFFER",
			"PENDING_LONG_TERM",
		] as const) {
			const db = makeDb([]);
			await expect(
				createMidasBucket({
					db,
					userId: USER_ID,
					midasAccountId: MIDAS_ACCOUNT_ID,
					code: `BUCKET_${t}`,
					name: `Bucket ${t}`,
					bucketType: t,
				}),
			).resolves.toBeDefined();
		}
	});

	it("rejects an unknown bucket type before any DB work", async () => {
		const db = makeDb([]);
		await expect(
			createMidasBucket({
				db,
				userId: USER_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				code: "MYSTERY",
				name: "Mystery",
				bucketType: "NOT_A_REAL_TYPE" as never,
			}),
		).rejects.toBeInstanceOf(MidasError);
		expect(
			(db.select as ReturnType<typeof vi.fn>).mock?.calls?.length ?? 0,
		).toBe(0);
	});
});
