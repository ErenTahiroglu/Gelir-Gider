import { describe, expect, it, vi } from "vitest";
import type { DatabaseTransaction } from "../src/db/client";
import type { MidasError } from "../src/midas/errors";
import { ensureMidasSingletonBucketInTransaction } from "../src/midas/service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MIDAS_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const BUCKET_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Builds a mock DatabaseTransaction that: (1) finds the Midas account, (2)
 * simulates the singleton `ON CONFLICT DO NOTHING` insert finding the row
 * already exists (returns nothing), then (3) re-reads the existing row with
 * the given (possibly mismatched) code/name.
 */
function makeMockTxWithExistingRow(existingRow: {
	id: string;
	userId: string;
	midasAccountId: string;
	code: string;
	name: string;
	bucketType: string;
	createdAt: Date;
}) {
	const select = vi
		.fn()
		// 1. Midas account existence check
		.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					limit: vi
						.fn()
						.mockResolvedValue([{ id: MIDAS_ACCOUNT_ID, userId: USER_ID }]),
				}),
			}),
		})
		// 2. Re-read after ON CONFLICT DO NOTHING found an existing row
		.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					limit: vi.fn().mockResolvedValue([existingRow]),
				}),
			}),
		});

	const insert = vi.fn().mockReturnValue({
		values: vi.fn().mockReturnValue({
			onConflictDoNothing: vi.fn().mockReturnValue({
				returning: vi.fn().mockResolvedValue([]),
			}),
		}),
	});

	return { select, insert } as unknown as DatabaseTransaction;
}

describe("ensureMidasSingletonBucketInTransaction deterministic code/name contract (Phase 14-R1, Section G)", () => {
	it("rejects when an existing singleton bucket's code does not match the deterministic contract", async () => {
		const tx = makeMockTxWithExistingRow({
			id: BUCKET_ID,
			userId: USER_ID,
			midasAccountId: MIDAS_ACCOUNT_ID,
			code: "WRONG_CODE",
			name: "Medium-Term Reserve",
			bucketType: "MEDIUM_TERM_RESERVE",
			createdAt: new Date(),
		});

		await expect(
			ensureMidasSingletonBucketInTransaction({
				tx,
				userId: USER_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				bucketType: "MEDIUM_TERM_RESERVE",
				code: "MEDIUM_TERM_RESERVE",
				name: "Medium-Term Reserve",
			}),
		).rejects.toMatchObject({
			code: "MIDAS_INVALID_STATE",
		} satisfies Partial<MidasError>);
	});

	it("rejects when an existing singleton bucket's name does not match the deterministic contract", async () => {
		const tx = makeMockTxWithExistingRow({
			id: BUCKET_ID,
			userId: USER_ID,
			midasAccountId: MIDAS_ACCOUNT_ID,
			code: "MEDIUM_TERM_RESERVE",
			name: "Some Wrong Name",
			bucketType: "MEDIUM_TERM_RESERVE",
			createdAt: new Date(),
		});

		await expect(
			ensureMidasSingletonBucketInTransaction({
				tx,
				userId: USER_ID,
				midasAccountId: MIDAS_ACCOUNT_ID,
				bucketType: "MEDIUM_TERM_RESERVE",
				code: "MEDIUM_TERM_RESERVE",
				name: "Medium-Term Reserve",
			}),
		).rejects.toMatchObject({
			code: "MIDAS_INVALID_STATE",
		} satisfies Partial<MidasError>);
	});

	it("accepts when an existing singleton bucket's code and name match exactly", async () => {
		const tx = makeMockTxWithExistingRow({
			id: BUCKET_ID,
			userId: USER_ID,
			midasAccountId: MIDAS_ACCOUNT_ID,
			code: "MEDIUM_TERM_RESERVE",
			name: "Medium-Term Reserve",
			bucketType: "MEDIUM_TERM_RESERVE",
			createdAt: new Date(),
		});

		const result = await ensureMidasSingletonBucketInTransaction({
			tx,
			userId: USER_ID,
			midasAccountId: MIDAS_ACCOUNT_ID,
			bucketType: "MEDIUM_TERM_RESERVE",
			code: "MEDIUM_TERM_RESERVE",
			name: "Medium-Term Reserve",
		});

		expect(result.id).toBe(BUCKET_ID);
	});
});
