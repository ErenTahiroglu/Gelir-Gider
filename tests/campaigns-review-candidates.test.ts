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
			onConflictDoNothing: () => obj,
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

const RECEIPT_ID = "88888888-aaaa-aaaa-aaaa-888888888888";
const APPLY_REVISION_ID = "99999999-9999-9999-9999-999999999999";
const DISMISS_REVISION_ID = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const APPLIED_CAMPAIGN_REVISION_ID = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";

/**
 * Phase 16-R3: a row shaped like
 * campaign_review_candidate_idempotency_receipts.$inferSelect, as returned
 * by a `.select()` against that table.
 */
function makeReceiptRow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const defaults = {
		id: RECEIPT_ID,
		userId: USER_ID,
		idempotencyKey: "stored-key",
		operation: "CREATE",
		requestFingerprint: "b".repeat(64),
		candidateId: CANDIDATE_ID,
		candidateRevisionId: CANDIDATE_REVISION_ID,
		campaignRevisionId: null,
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
// Phase 16-R3, Section 13: the idempotency receipt is now THE authoritative
// lookup for all three mutations. Every scenario below traces the EXACT
// query sequence the current source issues (receipt-table lookup(s) first,
// legacy per-operation revision-table fallback second, mutable-state checks
// LAST), proving the ordering the spec requires -- not merely the outcome.
// ============================================================================

describe("createCampaignReviewCandidate historical replay (Phase 16-R3)", () => {
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

	// Scenario A: exact retry while the campaign is still ACTIVE. The receipt
	// is found on the FIRST lookup -- proving the replay short-circuits
	// before ever touching campaign_periods.
	it("A: exact retry (receipt found immediately) returns the historical PENDING CREATE revision without ever locking campaign_periods", async () => {
		const occurredAt = new Date("2024-09-01T00:00:00Z");
		const fingerprint = await expectedCreateFingerprint(occurredAt);
		const candidateRow = makeCandidateRow();
		const createRevisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-1",
			revisionFingerprint: fingerprint,
		});
		const receiptRow = makeReceiptRow({
			operation: "CREATE",
			requestFingerprint: fingerprint,
			candidateId: CANDIDATE_ID,
			candidateRevisionId: CANDIDATE_REVISION_ID,
			campaignRevisionId: null,
		});

		const responses: unknown[][] = [
			[receiptRow], // 1. receipt select -> found immediately
			[candidateRow], // 2. buildReplayResultFromReceipt: candidate select
			[createRevisionRow], // 3. buildReplayResultFromReceipt: revision select
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

	// Scenario B (Defect 1 regression -- the core fix of this phase):
	// CREATE while ACTIVE -> APPLY -> END the campaign -> retry the ORIGINAL
	// CREATE key. No receipt exists yet for this key in this scenario (it
	// predates migration 0051), so the legacy fallback resolves it and
	// lazily backfills a receipt. Crucially, the queued response sequence
	// contains NO campaign_periods lock, NO lifecycle-status read, and NO
	// snapshot/provider read at all -- if the implementation regressed to
	// checking ACTIVE status before this replay, it would issue additional
	// queries the queue does not have, and the call would reject instead of
	// resolving.
	it("B: CREATE retry after APPLY+END the campaign still returns the historical CREATE/PENDING snapshot, never touching campaign lifecycle (Defect 1)", async () => {
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
		const backfilledReceiptRow = makeReceiptRow({
			operation: "CREATE",
			requestFingerprint: fingerprint,
			candidateId: CANDIDATE_ID,
			candidateRevisionId: CANDIDATE_REVISION_ID,
			campaignRevisionId: null,
		});

		const responses: unknown[][] = [
			[], // 1. receipt select -> not found
			[createRevisionRow], // 2. legacy revision select -> found (pre-0051 CREATE)
			[], // 3. INSERT ... ON CONFLICT DO NOTHING (backfill)
			[backfilledReceiptRow], // 4. re-read confirms the backfilled receipt
			[candidateRow], // 5. buildReplayResultFromReceipt: candidate select
			[createRevisionRow], // 6. buildReplayResultFromReceipt: revision select
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

	// Scenario D: same key, changed occurredAt -> the fingerprint no longer
	// matches the receipt's stored fingerprint -> CONFLICT, thrown at the
	// very first lookup (before any further query).
	it("D: same key + changed occurredAt is rejected as CAMPAIGN_IDEMPOTENCY_CONFLICT at the very first receipt lookup", async () => {
		const storedFingerprint = await expectedCreateFingerprint(
			new Date("2024-09-01T00:00:00Z"),
		);
		const receiptRow = makeReceiptRow({
			operation: "CREATE",
			requestFingerprint: storedFingerprint,
		});

		const responses: unknown[][] = [
			[receiptRow], // 1. receipt select -> found, but for a DIFFERENT occurredAt
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

	// Scenario C (Section 9, dedup-alias durability): request A creates
	// candidate C; request B (same semantic proposal, different key) hits
	// the get-or-create dedup path and must durably bind its OWN key to C's
	// CREATE revision, not merely return it.
	it("C part 1: a dedup-alias request (no receipt/legacy match, hits the semantic-hash PENDING match) durably binds its own key to the resolved candidate", async () => {
		const occurredAt = new Date("2024-09-01T00:00:00Z");
		const fingerprint = await expectedCreateFingerprint(occurredAt);
		const candidateRow = makeCandidateRow();
		const createRevisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-A", // owned by the ORIGINAL request, not this one
			revisionFingerprint: "c".repeat(64),
			revisionNo: 1,
			operation: "CREATE",
			status: "PENDING",
		});
		const boundReceiptRow = makeReceiptRow({
			idempotencyKey: "create-key-B",
			operation: "CREATE",
			requestFingerprint: fingerprint,
			candidateId: CANDIDATE_ID,
			candidateRevisionId: CANDIDATE_REVISION_ID,
			campaignRevisionId: null,
		});

		const responses: unknown[][] = [
			[], // 1. receipt select (early) -> not found
			[], // 2. legacy select (early) -> not found
			[periodRow], // 3. lock campaign_periods FOR UPDATE
			[], // 4. receipt select (locked) -> not found
			[], // 5. legacy select (locked) -> not found
			[{ provider: "TEST_BANK" }], // 6. family provider select
			[periodRow], // 7. getLatestRevisionInTransaction: period select
			[latestPeriodRevRow], // 8. latest period revision select (ACTIVE)
			[], // 9. cards select
			[snapshotRow], // 10. source snapshot select
			[candidateRow], // 11. existingCandidates select (same candidateHash)
			[{ id: CANDIDATE_REVISION_ID }], // 12. buildLatestReadModelInTransaction: latest id
			[candidateRow], // 13. revision-scoped candidate select
			[createRevisionRow], // 14. revision-scoped revision select -> PENDING
			[], // 15. bindCandidateReceipt: INSERT ... ON CONFLICT DO NOTHING
			[boundReceiptRow], // 16. bindCandidateReceipt: re-read confirms
			[candidateRow], // 17. buildReplayResultFromReceipt: candidate select
			[createRevisionRow], // 18. buildReplayResultFromReceipt: revision select
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const result = await createCampaignReviewCandidate({
			...createParams,
			db,
			occurredAt,
			idempotencyKey: "create-key-B",
		});

		expect(result.candidateId).toBe(CANDIDATE_ID);
		expect(result.status).toBe("PENDING");
	});

	it("C part 2: retrying the dedup-alias key later (after the candidate has since moved on) still replays the durably-bound historical CREATE/PENDING snapshot via the receipt found immediately", async () => {
		// This models the state AFTER part 1's bind: key "create-key-B" now
		// has its OWN receipt row pointing at candidate C's original CREATE
		// revision. A later retry finds that receipt on the very FIRST
		// lookup -- no campaign_periods/lifecycle query at all -- regardless
		// of what has since happened to candidate C (APPLIED, campaign
		// HIDDEN/ENDED, etc).
		const occurredAt = new Date("2024-09-01T00:00:00Z");
		const fingerprint = await expectedCreateFingerprint(occurredAt);
		const candidateRow = makeCandidateRow();
		const originalCreateRevisionRow = makeCandidateRevisionRow({
			idempotencyKey: "create-key-A",
			revisionFingerprint: "c".repeat(64),
			revisionNo: 1,
			operation: "CREATE",
			status: "PENDING",
		});
		const boundReceiptRow = makeReceiptRow({
			idempotencyKey: "create-key-B",
			operation: "CREATE",
			requestFingerprint: fingerprint,
			candidateId: CANDIDATE_ID,
			candidateRevisionId: CANDIDATE_REVISION_ID,
			campaignRevisionId: null,
		});

		const responses: unknown[][] = [
			[boundReceiptRow], // 1. receipt select -> found immediately
			[candidateRow], // 2. candidate select
			[originalCreateRevisionRow], // 3. revision select -> STILL the original CREATE/PENDING snapshot
		];
		const { db } = createQueueDb(responses);
		const { createCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const result = await createCampaignReviewCandidate({
			...createParams,
			db,
			occurredAt,
			idempotencyKey: "create-key-B",
		});

		expect(result.revisionNo).toBe(1);
		expect(result.operation).toBe("CREATE");
		expect(result.status).toBe("PENDING");
	});

	it("rejects candidate creation against a non-ACTIVE campaign once past both replay checks (Section E, app-level check)", async () => {
		const nonActiveLatestRev = {
			...latestPeriodRevRow,
			lifecycleStatus: "REVIEW_REQUIRED",
		};
		const responses: unknown[][] = [
			[], // 1. receipt select (early) -> not found
			[], // 2. legacy select (early) -> not found
			[periodRow], // 3. lock
			[], // 4. receipt select (locked) -> not found
			[], // 5. legacy select (locked) -> not found
			[{ provider: "TEST_BANK" }], // 6. family select
			[periodRow], // 7. getLatestRevisionInTransaction: period select
			[nonActiveLatestRev], // 8. latest revision select -> non-ACTIVE
			[], // 9. cards select
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
			[], // 1. receipt select (early) -> not found
			[], // 2. legacy select (early) -> not found
			[periodRow], // 3. lock
			[], // 4. receipt select (locked) -> not found
			[], // 5. legacy select (locked) -> not found
			[{ provider: "TEST_BANK" }], // 6. family select
			[periodRow], // 7. getLatestRevisionInTransaction: period select
			[latestPeriodRevRow], // 8. latest revision select -> ACTIVE
			[], // 9. cards select
			[mismatchedSnapshot], // 10. source snapshot select
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

describe("applyCampaignReviewCandidate / dismissCampaignReviewCandidate historical replay (Phase 16-R3)", () => {
	const periodRow = {
		id: CAMPAIGN_PERIOD_ID,
		userId: USER_ID,
		campaignFamilyId: CAMPAIGN_FAMILY_ID,
		periodKey: "2024-09",
		createdAt: new Date("2024-01-01T00:00:00Z"),
	};
	const familyRow = {
		id: CAMPAIGN_FAMILY_ID,
		userId: USER_ID,
		provider: "TEST_BANK",
		familyKey: "test-family",
		createdAt: new Date("2024-01-01T00:00:00Z"),
	};

	function makeAmendJoinRow(
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		const revisionDefaults = {
			id: APPLIED_CAMPAIGN_REVISION_ID,
			campaignPeriodId: CAMPAIGN_PERIOD_ID,
			revisionNo: 3,
			operation: "AMEND",
			lifecycleStatus: "ACTIVE",
			visibility: "VISIBLE",
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
			sourceSnapshotId: SOURCE_SNAPSHOT_ID,
			parserType: null,
			parserVersion: null,
			parserConfidence: null,
			note: null,
			occurredAt: new Date("2024-09-05T00:00:00Z"),
			createdAt: new Date("2024-09-05T00:00:00Z"),
		};
		return {
			period: periodRow,
			family: familyRow,
			revision: { ...revisionDefaults, ...overrides },
		};
	}

	// Scenario E (Section 4, cross-operation namespace guarantee): a CREATE
	// idempotency key reused for an APPLY call must CONFLICT (operation
	// mismatch), even though the candidate itself is genuinely PENDING.
	it("E: a CREATE idempotency key reused for an APPLY call is rejected as CAMPAIGN_IDEMPOTENCY_CONFLICT", async () => {
		const candidateRow = makeCandidateRow();
		const pendingRevisionRow = makeCandidateRevisionRow({ status: "PENDING" });
		const receiptRowFromEarlierCreate = makeReceiptRow({
			operation: "CREATE", // this key was originally used for a CREATE
		});

		const responses: unknown[][] = [
			[candidateRow], // 1. candidate select ... .for("update")
			[{ id: pendingRevisionRow.id }], // 2. buildLatestReadModelInTransaction: latest id
			[candidateRow], // 3. revision-scoped candidate select
			[pendingRevisionRow], // 4. revision-scoped revision select
			[receiptRowFromEarlierCreate], // 5. receipt select -> found, but operation is CREATE not APPLY
		];
		const { db } = createQueueDb(responses);
		const { applyCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		await expect(
			applyCampaignReviewCandidate({
				db,
				userId: USER_ID,
				candidateId: CANDIDATE_ID,
				expectedCampaignRevisionNo: 3,
				occurredAt: new Date("2024-09-10T00:00:00Z"),
				idempotencyKey: "reused-key",
			}),
		).rejects.toMatchObject({
			code: "CAMPAIGN_IDEMPOTENCY_CONFLICT",
		} satisfies Partial<CampaignError>);
	});

	// Scenario F (Phase 16-R1/R2 regression): APPLY exact retry after a
	// later campaign HIDE/AMEND must still return the EXACT historical APPLY
	// + AMEND snapshot -- the receipt-based fast path must not regress this.
	it("F: APPLY exact retry returns the exact historical APPLY + AMEND snapshot via the receipt path", async () => {
		const candidateRow = makeCandidateRow();
		const latestRevisionRow = makeCandidateRevisionRow({
			id: APPLY_REVISION_ID,
			revisionNo: 2,
			operation: "APPLY",
			status: "APPLIED",
			appliedCampaignRevisionId: APPLIED_CAMPAIGN_REVISION_ID,
		});
		const occurredAt = new Date("2024-09-05T00:00:00Z");
		const expectedCampaignRevisionNo = 2;
		const note = null;
		const fingerprint =
			await calculateCampaignReviewCandidateLifecycleFingerprint({
				userId: USER_ID,
				candidateId: CANDIDATE_ID,
				operation: "APPLY",
				expectedCampaignRevisionNo,
				occurredAt,
				note,
			});
		const receiptRow = makeReceiptRow({
			operation: "APPLY",
			requestFingerprint: fingerprint,
			candidateId: CANDIDATE_ID,
			candidateRevisionId: APPLY_REVISION_ID,
			campaignRevisionId: APPLIED_CAMPAIGN_REVISION_ID,
		});
		const amendJoinRow = makeAmendJoinRow();

		const responses: unknown[][] = [
			[candidateRow], // 1. candidate select ... .for("update")
			[{ id: latestRevisionRow.id }], // 2. buildLatestReadModelInTransaction: latest id
			[candidateRow], // 3. revision-scoped candidate select
			[latestRevisionRow], // 4. revision-scoped revision select
			[receiptRow], // 5. receipt select -> found, operation + fingerprint match
			[candidateRow], // 6. buildReplayResultFromReceipt: candidate select
			[latestRevisionRow], // 7. buildReplayResultFromReceipt: revision select
			[amendJoinRow], // 8. buildCampaignPeriodReadModelForRevisionInTransaction: joined select
			[], // 9. buildCampaignPeriodReadModelForRevisionInTransaction: card rows select
		];
		const { db } = createQueueDb(responses);
		const { applyCampaignReviewCandidate } = await import(
			"../src/campaigns/review-candidates"
		);

		const result = await applyCampaignReviewCandidate({
			db,
			userId: USER_ID,
			candidateId: CANDIDATE_ID,
			expectedCampaignRevisionNo,
			occurredAt,
			idempotencyKey: "apply-key-1",
			note,
		});

		expect(result.candidate.operation).toBe("APPLY");
		expect(result.candidate.status).toBe("APPLIED");
		expect(result.campaign.revisionId).toBe(APPLIED_CAMPAIGN_REVISION_ID);
		expect(result.campaign.operation).toBe("AMEND");
	});

	// Scenario G: DISMISS exact retry returns the historical DISMISS
	// revision via the receipt path.
	it("G: DISMISS exact retry returns the historical DISMISS revision via the receipt path", async () => {
		const candidateRow = makeCandidateRow();
		const latestRevisionRow = makeCandidateRevisionRow({
			id: DISMISS_REVISION_ID,
			revisionNo: 2,
			operation: "DISMISS",
			status: "DISMISSED",
		});
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
		const receiptRow = makeReceiptRow({
			operation: "DISMISS",
			requestFingerprint: fingerprint,
			candidateId: CANDIDATE_ID,
			candidateRevisionId: DISMISS_REVISION_ID,
			campaignRevisionId: null,
		});

		const responses: unknown[][] = [
			[candidateRow], // 1. candidate select ... .for("update")
			[{ id: latestRevisionRow.id }], // 2. buildLatestReadModelInTransaction: latest id
			[candidateRow], // 3. revision-scoped candidate select
			[latestRevisionRow], // 4. revision-scoped revision select
			[receiptRow], // 5. receipt select -> found
			[candidateRow], // 6. buildReplayResultFromReceipt: candidate select
			[latestRevisionRow], // 7. buildReplayResultFromReceipt: revision select
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
