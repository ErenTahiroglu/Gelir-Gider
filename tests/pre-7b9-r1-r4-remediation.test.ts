import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import journal from "../migrations/meta/_journal.json";
import snapshot0075 from "../migrations/meta/0075_snapshot.json";
import { BackupError } from "../src/backups/errors";
import { buildSnapshotPayload } from "../src/backups/export";
import { discoverBackupTableRegistry } from "../src/backups/registry";
import {
	decodeCampaignOverrideCursor,
	decodeCampaignPeriodCursor,
	decodeCampaignProgressPurchaseCursor,
	decodeCampaignReviewCandidateCursor,
	encodeCampaignOverrideCursor,
	encodeCampaignPeriodCursor,
	encodeCampaignProgressPurchaseCursor,
	encodeCampaignReviewCandidateCursor,
} from "../src/campaigns/pagination";
import {
	decodeCardCursor,
	decodePurchaseCursor,
	decodeStatementCursor,
	encodeCardCursor,
	encodePurchaseCursor,
	encodeStatementCursor,
} from "../src/credit-cards/pagination";
import {
	decodeObligationCursor,
	decodePersonCursor,
	decodeSettlementCursor,
	encodeObligationCursor,
	encodePersonCursor,
	encodeSettlementCursor,
} from "../src/people/pagination";
import {
	decodeRewardAccountCursor,
	decodeRewardEventCursor,
	encodeRewardAccountCursor,
	encodeRewardEventCursor,
} from "../src/rewards/pagination";

describe("R1-R4.1 (M-02) Migration 0075 integrity & journal registration", () => {
	it("verifies migration 0075 is recorded in _journal.json and snapshot exists", () => {
		const entry75 = (
			journal.entries as Array<{ idx: number; tag: string; when: number }>
		).find((e) => e.idx === 75);
		expect(entry75).toBeDefined();
		expect(entry75?.tag).toBe(
			"0075_historical_settlement_replay_reconstruction",
		);

		expect(snapshot0075.prevId).toBe("c4a92de8-b715-46f9-bf55-cb81e19481ea");
	});
});

describe("R1-R4.3 (N-02) Cursor scope enforcement & cross-scope fail-closed rejection", () => {
	const userA = "00000000-0000-0000-0000-00000000000a";
	const userB = "00000000-0000-0000-0000-00000000000b";
	const cardA = "11111111-1111-1111-1111-11111111111a";
	const cardB = "11111111-1111-1111-1111-11111111111b";
	const personA = "22222222-2222-2222-2222-22222222222a";
	const obligationA = "33333333-3333-3333-3333-33333333333a";
	const accountA = "44444444-4444-4444-4444-44444444444a";
	const campaignA = "55555555-5555-5555-5555-55555555555a";

	it("rejects Credit Cards cursor when userId scope mismatches", () => {
		const cursor = encodeCardCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA },
		);
		expect(() => decodeCardCursor(cursor, { userId: userB })).toThrow();
	});

	it("rejects Credit Card Statements cursor when cardId scope mismatches", () => {
		const cursor = encodeStatementCursor(
			{
				cycleYear: 2026,
				cycleMonth: 9,
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, cardId: cardA },
		);
		expect(() =>
			decodeStatementCursor(cursor, { userId: userA, cardId: cardB }),
		).toThrow();
	});

	it("rejects Credit Card Purchases cursor when cardId scope mismatches", () => {
		const cursor = encodePurchaseCursor(
			{
				purchaseDate: "2026-09-01",
				occurredAt: "2026-09-01T10:00:00.000Z",
				eventId: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, cardId: cardA },
		);
		expect(() =>
			decodePurchaseCursor(cursor, { userId: userA, cardId: cardB }),
		).toThrow();
	});

	it("rejects People cursors when scope mismatches", () => {
		const pCursor = encodePersonCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA },
		);
		expect(() => decodePersonCursor(pCursor, { userId: userB })).toThrow();

		const oCursor = encodeObligationCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, personId: personA },
		);
		expect(() =>
			decodeObligationCursor(oCursor, {
				userId: userA,
				personId: "00000000-0000-0000-0000-000000000000",
			}),
		).toThrow();

		const sCursor = encodeSettlementCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, obligationId: obligationA },
		);
		expect(() =>
			decodeSettlementCursor(sCursor, {
				userId: userA,
				obligationId: "00000000-0000-0000-0000-000000000000",
			}),
		).toThrow();
	});

	it("rejects Rewards cursors when scope mismatches", () => {
		const aCursor = encodeRewardAccountCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA },
		);
		expect(() =>
			decodeRewardAccountCursor(aCursor, { userId: userB }),
		).toThrow();

		const eCursor = encodeRewardEventCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, rewardAccountId: accountA },
		);
		expect(() =>
			decodeRewardEventCursor(eCursor, {
				userId: userA,
				rewardAccountId: "00000000-0000-0000-0000-000000000000",
			}),
		).toThrow();
	});

	it("rejects Campaign cursors when scope mismatches", () => {
		const pCursor = encodeCampaignPeriodCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA },
		);
		expect(() =>
			decodeCampaignPeriodCursor(pCursor, { userId: userB }),
		).toThrow();

		const rCursor = encodeCampaignReviewCandidateCursor(
			{
				createdAt: "2026-09-01T10:00:00.000Z",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, campaignPeriodId: campaignA },
		);
		expect(() =>
			decodeCampaignReviewCandidateCursor(rCursor, {
				userId: userA,
				campaignPeriodId: "00000000-0000-0000-0000-000000000000",
			}),
		).toThrow();

		const progCursor = encodeCampaignProgressPurchaseCursor(
			{
				purchaseDate: "2026-09-01",
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, cardId: cardA },
		);
		expect(() =>
			decodeCampaignProgressPurchaseCursor(progCursor, {
				userId: userA,
				cardId: cardB,
			}),
		).toThrow();

		const overCursor = encodeCampaignOverrideCursor(
			{
				id: "99999999-9999-9999-9999-999999999999",
			},
			{ userId: userA, campaignPeriodId: campaignA },
		);
		expect(() =>
			decodeCampaignOverrideCursor(overCursor, {
				userId: userA,
				campaignPeriodId: "00000000-0000-0000-0000-000000000000",
			}),
		).toThrow();
	});
});

describe("R1-R4.6 (B-01) Backup safety & registry primary keys", () => {
	it("ensures every table in discoverBackupTableRegistry has exactly 1 primary key column", () => {
		const tables = discoverBackupTableRegistry();
		expect(tables.length).toBeGreaterThan(0);
		for (const table of tables) {
			const config = getTableConfig(table);
			const pkCols = config.columns.filter((c) => c.primary);
			expect(pkCols.length).toBe(1);
		}
	});

	it("throws BACKUP_TOO_LARGE when plaintext exceeds ceiling", async () => {
		const payload = {
			formatVersion: "V1",
			backupId: "test-bk",
			createdAt: new Date().toISOString(),
			tables: [
				{
					tableName: "test",
					rowCount: 1,
					rows: [{ id: "1", data: "x".repeat(5000) }],
					tableContentHash: "hash",
				},
			],
			maxPlaintextBytes: 100,
		};
		await expect(buildSnapshotPayload(payload)).rejects.toThrow(BackupError);
	});
});
