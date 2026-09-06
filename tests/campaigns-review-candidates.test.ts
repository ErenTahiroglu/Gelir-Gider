import { describe, expect, it, vi } from "vitest";
import type { CampaignError } from "../src/campaigns/errors";
import {
	calculateCampaignReviewCandidateCreateRequestFingerprint,
	calculateCampaignReviewCandidateHash,
	calculateCampaignReviewCandidateLifecycleFingerprint,
	deriveCampaignReviewChildIdempotencyKey,
} from "../src/campaigns/fingerprint";
import type { Database, DatabaseTransaction } from "../src/db/client";

// ============================================================================
// Section B/C (Phase 16-R2): pure fingerprint/child-key function tests.
// ============================================================================

describe("deriveCampaignReviewChildIdempotencyKey (Section B)", () => {
	it("returns exactly 64 lowercase hex chars even for a max-length (128 char) parent key", async () => {
		const parentKey = "p".repeat(128);
		const key = await deriveCampaignReviewChildIdempotencyKey({
			parentKey,
			candidateId: "11111111-1111-1111-1111-111111111111",
			operation: "APPLY",
			child: "CAMPAIGN_AMEND",
		});
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is stable for identical input", async () => {
		const args = {
			parentKey: "same-key",
			candidateId: "11111111-1111-1111-1111-111111111111",
			operation: "APPLY" as const,
			child: "CAMPAIGN_AMEND" as const,
		};
		const a = await deriveCampaignReviewChildIdempotencyKey(args);
		const b = await deriveCampaignReviewChildIdempotencyKey(args);
		expect(a).toBe(b);
	});

	it("changes when candidateId changes", async () => {
		const base = {
			parentKey: "same-key",
			operation: "APPLY" as const,
			child: "CAMPAIGN_AMEND" as const,
		};
		const a = await deriveCampaignReviewChildIdempotencyKey({
			...base,
			candidateId: "11111111-1111-1111-1111-111111111111",
		});
		const b = await deriveCampaignReviewChildIdempotencyKey({
			...base,
			candidateId: "22222222-2222-2222-2222-222222222222",
		});
		expect(a).not.toBe(b);
	});

	it("changes when the parent key changes", async () => {
		const base = {
			candidateId: "11111111-1111-1111-1111-111111111111",
			operation: "APPLY" as const,
			child: "CAMPAIGN_AMEND" as const,
		};
		const a = await deriveCampaignReviewChildIdempotencyKey({
			...base,
			parentKey: "key-a",
		});
		const b = await deriveCampaignReviewChildIdempotencyKey({
			...base,
			parentKey: "key-b",
		});
		expect(a).not.toBe(b);
	});
});

const baseCreateFingerprintParams = {
	userId: "11111111-1111-1111-1111-111111111111",
	campaignPeriodId: "22222222-2222-2222-2222-222222222222",
	sourceSnapshotId: "33333333-3333-3333-3333-333333333333",
	candidateHash: "a".repeat(64),
	title: "Back to School",
	startsOn: "2024-09-01",
	endsOn: "2024-09-30",
	ruleMode: "TOTAL_SPEND",
	targetSpendAmount: "100.00",
	requiredTransactionCount: null,
	minimumTransactionAmount: null,
	stepSpendAmount: null,
	rewardPointsPerStep: null,
	maxSteps: null,
	rewardKind: "STATEMENT_CREDIT",
	rewardAccountId: null,
	expectedRewardPoints: null,
	merchantScopeMode: "ALL_MERCHANTS",
	requiredCanonicalMerchantNames: null,
	allowedMccCodes: null,
	rewardExpiryDate: null,
	parserType: null,
	parserVersion: null,
	parserConfidence: null,
	proposedCardIds: ["44444444-4444-4444-4444-444444444444"],
	occurredAt: new Date("2024-09-01T00:00:00Z"),
};

describe("calculateCampaignReviewCandidateCreateRequestFingerprint (Section C)", () => {
	it("is deterministic for identical input", async () => {
		const a = await calculateCampaignReviewCandidateCreateRequestFingerprint(
			baseCreateFingerprintParams,
		);
		const b = await calculateCampaignReviewCandidateCreateRequestFingerprint(
			baseCreateFingerprintParams,
		);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when occurredAt changes (unlike candidateHash, which excludes it)", async () => {
		const a = await calculateCampaignReviewCandidateCreateRequestFingerprint(
			baseCreateFingerprintParams,
		);
		const b = await calculateCampaignReviewCandidateCreateRequestFingerprint({
			...baseCreateFingerprintParams,
			occurredAt: new Date("2024-09-02T00:00:00Z"),
		});
		expect(a).not.toBe(b);
	});

	it("changes when sourceSnapshotId changes", async () => {
		const a = await calculateCampaignReviewCandidateCreateRequestFingerprint(
			baseCreateFingerprintParams,
		);
		const b = await calculateCampaignReviewCandidateCreateRequestFingerprint({
			...baseCreateFingerprintParams,
			sourceSnapshotId: "55555555-5555-5555-5555-555555555555",
		});
		expect(a).not.toBe(b);
	});

	it("changes when campaignPeriodId changes", async () => {
		const a = await calculateCampaignReviewCandidateCreateRequestFingerprint(
			baseCreateFingerprintParams,
		);
		const b = await calculateCampaignReviewCandidateCreateRequestFingerprint({
			...baseCreateFingerprintParams,
			campaignPeriodId: "66666666-6666-6666-6666-666666666666",
		});
		expect(a).not.toBe(b);
	});

	it("changes when candidateHash changes (so any term/card/parser change also changes this)", async () => {
		const a = await calculateCampaignReviewCandidateCreateRequestFingerprint(
			baseCreateFingerprintParams,
		);
		const b = await calculateCampaignReviewCandidateCreateRequestFingerprint({
			...baseCreateFingerprintParams,
			candidateHash: "b".repeat(64),
		});
		expect(a).not.toBe(b);
	});

	it("does not bind any generated id (candidateId/revisionId are not accepted params at all)", () => {
		expect(baseCreateFingerprintParams).not.toHaveProperty("candidateId");
		expect(baseCreateFingerprintParams).not.toHaveProperty("revisionId");
	});
});

// ============================================================================
// DB-less mocked Database/DatabaseTransaction harness.
//
// The campaign review-candidate service functions issue a deterministic,
// traceable sequence of drizzle query-builder calls (select/insert, each
// terminating in an awaited chain). This harness models a `Database` whose
// `.transaction()` invokes the given work function against a fake
// `DatabaseTransaction` backed by a response queue: each chain-starting call
// resolves to the next queued array of rows, in the exact order the
// production code issues them (traced by reading the current source).
//
// This intentionally does not interpret WHERE/JOIN conditions -- it is a
// call-order-based mock, not a real query engine. Tests that need the code
// to run past a certain point queue enough responses to get there; letting
// the queue run dry produces a thrown Error, which is a valid way to prove
// "reached point X without an extra transaction call" without simulating
// the full downstream logic.
// ============================================================================

function createQueueTx(responses: unknown[][]): {
	tx: DatabaseTransaction;
	insertedValues: unknown[];
} {
	let i = 0;
	const insertedValues: unknown[] = [];

	function nextResponse(): unknown[] {
		if (i >= responses.length) {
			throw new Error(`FakeTx: no queued response for query #${i}`);
		}
		const value = responses[i];
		i++;
		if (value === undefined) {
			throw new Error(`FakeTx: queued response #${i - 1} was undefined`);
		}
		return value;
	}

	function chain() {
		const obj = {
			from: () => obj,
			innerJoin: () => obj,
			where: () => obj,
			orderBy: () => obj,
			limit: () => obj,
			for: () => obj,
			values: (v: unknown) => {
				insertedValues.push(v);
				return obj;
			},
			returning: () => obj,
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable mock query builder (mirrors real drizzle chain, which is also thenable)
			then: (
				resolve: (value: unknown) => void,
				reject: (err: unknown) => void,
			) => {
				try {
					resolve(nextResponse());
				} catch (err) {
					reject(err);
				}
			},
		};
		return obj;
	}

	const tx = {
		select: () => chain(),
		insert: () => chain(),
		update: () => chain(),
		delete: () => chain(),
	} as unknown as DatabaseTransaction;

	return { tx, insertedValues };
}

function createQueueDb(responses: unknown[][]): {
	db: Database;
	transactionSpy: ReturnType<typeof vi.fn>;
	insertedValues: unknown[];
} {
	const { tx, insertedValues } = createQueueTx(responses);
	const transactionSpy = vi.fn(
		async (work: (tx: DatabaseTransaction) => unknown) => work(tx),
	);
	const db = { transaction: transactionSpy } as unknown as Database;
	return { db, transactionSpy, insertedValues };
}

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CANDIDATE_ID = "22222222-2222-2222-2222-222222222222";
const CAMPAIGN_PERIOD_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_SNAPSHOT_ID = "44444444-4444-4444-4444-444444444444";
const CARD_ID = "55555555-5555-5555-5555-555555555555";
const CANDIDATE_REVISION_ID = "66666666-6666-6666-6666-666666666666";
const CAMPAIGN_FAMILY_ID = "77777777-7777-7777-7777-777777777777";

function makeCandidateRow() {
	return {
		id: CANDIDATE_ID,
		userId: USER_ID,
		campaignPeriodId: CAMPAIGN_PERIOD_ID,
		sourceSnapshotId: SOURCE_SNAPSHOT_ID,
		candidateHash: "a".repeat(64),
		createdAt: new Date("2024-09-01T00:00:00Z"),
	};
}

function makeCandidateRevisionRow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const defaults = {
		id: CANDIDATE_REVISION_ID,
		userId: USER_ID,
		candidateId: CANDIDATE_ID,
		revisionNo: 1,
		previousRevisionId: null,
		operation: "CREATE",
		status: "PENDING",
		title: "Back to School",
		startsOn: "2024-09-01",
		endsOn: "2024-09-30",
		ruleMode: "TOTAL_SPEND",
		targetSpendAmount: "100.00",
		requiredTransactionCount: null,
		minimumTransactionAmount: null,
		stepSpendAmount: null,
		rewardPointsPerStep: null,
		maxSteps: null,
		rewardKind: "STATEMENT_CREDIT",
		rewardAccountId: null,
		expectedRewardPoints: null,
		merchantScopeMode: "ALL_MERCHANTS",
		requiredCanonicalMerchantNames: null,
		allowedMccCodes: null,
		rewardExpiryDate: null,
		parserType: null,
		parserVersion: null,
		parserConfidence: null,
		proposedCardIds: [CARD_ID],
		appliedCampaignRevisionId: null,
		occurredAt: new Date("2024-09-01T00:00:00Z"),
		idempotencyKey: "stored-key",
		revisionFingerprint: "b".repeat(64),
		createdAt: new Date("2024-09-01T00:00:00Z"),
	};
	return { ...defaults, ...overrides };
}

// ============================================================================
// Section A: applyCampaignReviewCandidate must invoke db.transaction exactly
// once per call -- proving the campaign AMEND no longer opens a second,
// independent transaction/connection via the old
// `amendCampaignPeriod({db: params.db, ...})` call.
// ============================================================================

describe("applyCampaignReviewCandidate transaction atomicity (Section A)", () => {
	it("invokes db.transaction exactly once, even though it reaches the internal campaign-AMEND call", async () => {
		const { applyCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const candidateRow = makeCandidateRow();
		const revisionRow = makeCandidateRevisionRow();

		// Responses queued in the EXACT order the current source issues
		// them (traced by reading src/campaigns/review-candidates.ts and
		// src/campaigns/service.ts):
		//   1. candidate select ... .for("update")
		//   2. buildLatestReadModelInTransaction: latest revision id select
		//   3. revision-scoped candidate select
		//   4. revision-scoped revision select
		//   5. existingRevByKey idempotency select -> none found
		// Execution then proceeds into amendCampaignPeriodInTransaction
		// (Section A's fix target) which immediately issues
		// tryReplayCampaignPeriodRevisionByKey's select (#6) -- left
		// UNQUEUED so the queue runs dry there. What matters is that
		// db.transaction was invoked exactly once to reach this point: in
		// the pre-fix code, the (now-removed) `amendCampaignPeriod({db:
		// params.db, ...})` call would have invoked db.transaction a SECOND
		// time before ever reaching query #6.
		const responses: unknown[][] = [
			[candidateRow],
			[{ id: CANDIDATE_REVISION_ID }],
			[candidateRow],
			[revisionRow],
			[],
		];
		const { db, transactionSpy } = createQueueDb(responses);

		await expect(
			applyCampaignReviewCandidate({
				db,
				userId: USER_ID,
				candidateId: CANDIDATE_ID,
				expectedCampaignRevisionNo: 1,
				occurredAt: new Date("2024-09-05T00:00:00Z"),
				idempotencyKey: "apply-key-1",
			}),
		).rejects.toThrow();

		expect(transactionSpy).toHaveBeenCalledTimes(1);
	});
});

// ============================================================================
// Section D: CREATE/APPLY/DISMISS idempotency replay must resolve the EXACT
// historical revision that owns the key, not whatever is currently latest.
// ============================================================================

describe("createCampaignReviewCandidate historical replay (Section C/D)", () => {
	const createParams = {
		userId: USER_ID,
		campaignPeriodId: CAMPAIGN_PERIOD_ID,
		sourceSnapshotId: SOURCE_SNAPSHOT_ID,
		occurredAt: new Date("2024-09-01T00:00:00Z"),
		idempotencyKey: "create-key-1",
		title: "Back to School",
		startsOn: "2024-09-01",
		endsOn: "2024-09-30",
		ruleMode: "TOTAL_SPEND",
		targetSpendAmount: "100.00",
		rewardKind: "STATEMENT_CREDIT",
		merchantScopeMode: "ALL_MERCHANTS",
		proposedCardIds: [CARD_ID],
	};

	const periodRow = {
		id: CAMPAIGN_PERIOD_ID,
		userId: USER_ID,
		campaignFamilyId: CAMPAIGN_FAMILY_ID,
		periodKey: "2024-09",
		createdAt: new Date("2024-01-01T00:00:00Z"),
	};
	const latestPeriodRevRow = {
		id: "88888888-8888-8888-8888-888888888888",
		campaignPeriodId: CAMPAIGN_PERIOD_ID,
		revisionNo: 2,
		lifecycleStatus: "ACTIVE",
		visibility: "VISIBLE",
	};
	const snapshotRow = {
		id: SOURCE_SNAPSHOT_ID,
		userId: USER_ID,
		provider: "TEST_BANK",
		sourceType: "MANUAL",
	};

	async function expectedCandidateHash() {
		return calculateCampaignReviewCandidateHash({
			campaignPeriodId: CAMPAIGN_PERIOD_ID,
			sourceSnapshotId: SOURCE_SNAPSHOT_ID,
			title: "Back to School",
			startsOn: "2024-09-01",
			endsOn: "2024-09-30",
			ruleMode: "TOTAL_SPEND",
			targetSpendAmount: "100.00",
			requiredTransactionCount: null,
			minimumTransactionAmount: null,
			stepSpendAmount: null,
			rewardPointsPerStep: null,
			maxSteps: null,
			rewardKind: "STATEMENT_CREDIT",
			rewardAccountId: null,
			expectedRewardPoints: null,
			merchantScopeMode: "ALL_MERCHANTS",
			requiredCanonicalMerchantNames: null,
			allowedMccCodes: null,
			rewardExpiryDate: null,
			parserType: null,
			parserVersion: null,
			parserConfidence: null,
			proposedCardIds: [CARD_ID],
		});
	}

	async function expectedCreateFingerprint(occurredAt: Date) {
		const candidateHash = await expectedCandidateHash();
		return calculateCampaignReviewCandidateCreateRequestFingerprint({
			userId: USER_ID,
			campaignPeriodId: CAMPAIGN_PERIOD_ID,
			sourceSnapshotId: SOURCE_SNAPSHOT_ID,
			candidateHash,
			title: "Back to School",
			startsOn: "2024-09-01",
			endsOn: "2024-09-30",
			ruleMode: "TOTAL_SPEND",
			targetSpendAmount: "100.00",
			requiredTransactionCount: null,
			minimumTransactionAmount: null,
			stepSpendAmount: null,
			rewardPointsPerStep: null,
			maxSteps: null,
			rewardKind: "STATEMENT_CREDIT",
			rewardAccountId: null,
			expectedRewardPoints: null,
			merchantScopeMode: "ALL_MERCHANTS",
			requiredCanonicalMerchantNames: null,
			allowedMccCodes: null,
			rewardExpiryDate: null,
			parserType: null,
			parserVersion: null,
			parserConfidence: null,
			proposedCardIds: [CARD_ID],
			occurredAt,
		});
	}

	function queueThroughEarlyReplayCheck() {
		return [
			[periodRow], // 1. period select ... .for("update")
			[{ provider: "TEST_BANK" }], // 2. family provider select
			[periodRow], // 3a. getLatestRevisionInTransaction: period select
			[latestPeriodRevRow], // 3b. latest period revision select
			[], // 3c. cards select
			[snapshotRow], // 4. source snapshot select
		];
	}

	it("exact retry (same key, byte-identical request) returns the historical PENDING CREATE revision", async () => {
		const occurredAt = new Date("2024-09-01T00:00:00Z");
		const fingerprint = await expectedCreateFingerprint(occurredAt);
		const candidateRow = makeCandidateRow();
		const revisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-1",
			revisionFingerprint: fingerprint,
		});

		const responses: unknown[][] = [
			...queueThroughEarlyReplayCheck(),
			[revisionRow], // 5. existingRevByKey select -> found
			[candidateRow], // 6. revision-scoped candidate select
			[revisionRow], // 7. revision-scoped revision select
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const result = await createCampaignReviewCandidate({
			...createParams,
			db,
			occurredAt,
		});

		expect(result.revisionNo).toBe(1);
		expect(result.operation).toBe("CREATE");
		expect(result.status).toBe("PENDING");
	});

	it("same key + changed occurredAt is rejected as CAMPAIGN_IDEMPOTENCY_CONFLICT", async () => {
		const storedFingerprint = await expectedCreateFingerprint(
			new Date("2024-09-01T00:00:00Z"),
		);
		const revisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-1",
			revisionFingerprint: storedFingerprint,
		});

		const responses: unknown[][] = [
			...queueThroughEarlyReplayCheck(),
			[revisionRow], // existingRevByKey select -> found, but fingerprint
			// was computed for a DIFFERENT occurredAt than this call uses.
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		await expect(
			createCampaignReviewCandidate({
				...createParams,
				db,
				occurredAt: new Date("2024-09-02T00:00:00Z"), // changed
			}),
		).rejects.toMatchObject({
			code: "CAMPAIGN_IDEMPOTENCY_CONFLICT",
		} satisfies Partial<CampaignError>);
	});

	it("same key + changed sourceSnapshotId is rejected as CAMPAIGN_IDEMPOTENCY_CONFLICT", async () => {
		const occurredAt = new Date("2024-09-01T00:00:00Z");
		const storedFingerprint = await expectedCreateFingerprint(occurredAt);
		const revisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-1",
			revisionFingerprint: storedFingerprint,
		});
		const otherSnapshotId = "99999999-9999-9999-9999-999999999999";
		const otherSnapshotRow = {
			id: otherSnapshotId,
			userId: USER_ID,
			provider: "TEST_BANK",
			sourceType: "MANUAL",
		};

		const responses: unknown[][] = [
			[periodRow],
			[{ provider: "TEST_BANK" }],
			[periodRow],
			[latestPeriodRevRow],
			[],
			[otherSnapshotRow],
			[revisionRow], // stored fingerprint bound to the ORIGINAL sourceSnapshotId
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		await expect(
			createCampaignReviewCandidate({
				...createParams,
				db,
				occurredAt,
				sourceSnapshotId: otherSnapshotId, // changed
			}),
		).rejects.toMatchObject({
			code: "CAMPAIGN_IDEMPOTENCY_CONFLICT",
		} satisfies Partial<CampaignError>);
	});

	it("CREATE after a later APPLY still returns the historical PENDING CREATE revision via the original key (Section D)", async () => {
		// Even though buildCampaignReviewCandidateReadModelForRevisionInTransaction
		// is now used (resolving the EXACT revision id the key owns) instead of
		// buildLatestReadModelInTransaction (which would resolve whatever is
		// CURRENTLY latest -- e.g. an APPLY row from a later operation), the
		// mock only models the revision-scoped query directly. This proves the
		// code path taken (revision-scoped, not latest-scoped) returns the
		// CREATE snapshot when fed the CREATE row for that exact revision id.
		const occurredAt = new Date("2024-09-01T00:00:00Z");
		const fingerprint = await expectedCreateFingerprint(occurredAt);
		const candidateRow = makeCandidateRow();
		const createRevisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-1",
			revisionFingerprint: fingerprint,
			revisionNo: 1,
			operation: "CREATE",
			status: "PENDING",
		});

		const responses: unknown[][] = [
			...queueThroughEarlyReplayCheck(),
			[createRevisionRow], // existingRevByKey resolves to the CREATE row itself
			[candidateRow],
			[createRevisionRow],
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const result = await createCampaignReviewCandidate({
			...createParams,
			db,
			occurredAt,
		});

		expect(result.revisionNo).toBe(1);
		expect(result.operation).toBe("CREATE");
		expect(result.status).toBe("PENDING");
	});

	it("rejects candidate creation against a non-ACTIVE campaign (Section E, app-level check)", async () => {
		const nonActiveLatestRev = {
			...latestPeriodRevRow,
			lifecycleStatus: "REVIEW_REQUIRED",
		};
		const responses: unknown[][] = [
			[periodRow],
			[{ provider: "TEST_BANK" }],
			[periodRow],
			[nonActiveLatestRev],
			[],
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		await expect(
			createCampaignReviewCandidate({ ...createParams, db }),
		).rejects.toMatchObject({
			code: "CAMPAIGN_NOT_ACTIVE",
		} satisfies Partial<CampaignError>);
	});

	it("rejects a non-MANUAL source snapshot whose provider does not match the campaign family provider (Section F, app-level check)", async () => {
		const mismatchedSnapshot = {
			id: SOURCE_SNAPSHOT_ID,
			userId: USER_ID,
			provider: "OTHER_BANK",
			sourceType: "OFFICIAL_PUBLIC_PAGE",
		};
		const responses: unknown[][] = [
			[periodRow],
			[{ provider: "TEST_BANK" }],
			[periodRow],
			[latestPeriodRevRow],
			[],
			[mismatchedSnapshot],
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		await expect(
			createCampaignReviewCandidate({ ...createParams, db }),
		).rejects.toMatchObject({
			code: "CAMPAIGN_INVALID_INPUT",
		} satisfies Partial<CampaignError>);
	});
});

describe("dismissCampaignReviewCandidate historical replay (Section D)", () => {
	it("exact replay returns the historical DISMISS revision via the revision-scoped builder", async () => {
		const candidateRow = makeCandidateRow();
		const pendingRevisionRow = makeCandidateRevisionRow();
		const occurredAt = new Date("2024-09-10T00:00:00Z");
		const note = null;
		const fingerprint =
			await calculateCampaignReviewCandidateLifecycleFingerprint({
				userId: USER_ID,
				candidateId: CANDIDATE_ID,
				operation: "DISMISS",
				expectedCampaignRevisionNo: null,
				occurredAt,
				note,
			});
		const dismissRevisionRow = makeCandidateRevisionRow({
			id: "99999999-9999-9999-9999-999999999999",
			revisionNo: 2,
			operation: "DISMISS",
			status: "DISMISSED",
			idempotencyKey: "dismiss-key-1",
			revisionFingerprint: fingerprint,
			occurredAt,
		});

		const responses: unknown[][] = [
			[candidateRow], // candidate select ... .for("update")
			[{ id: pendingRevisionRow.id }], // buildLatestReadModelInTransaction latest id
			[candidateRow],
			[pendingRevisionRow],
			[dismissRevisionRow], // existingRevByKey select -> found
			[candidateRow], // revision-scoped candidate select
			[dismissRevisionRow], // revision-scoped revision select
		];
		const { db } = createQueueDb(responses);
		const { dismissCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const result = await dismissCampaignReviewCandidate({
			db,
			userId: USER_ID,
			candidateId: CANDIDATE_ID,
			occurredAt,
			idempotencyKey: "dismiss-key-1",
			note,
		});

		expect(result.operation).toBe("DISMISS");
		expect(result.status).toBe("DISMISSED");
		expect(result.revisionNo).toBe(2);
	});
});
