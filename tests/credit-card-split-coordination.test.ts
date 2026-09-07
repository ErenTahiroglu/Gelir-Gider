import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCreditCardPurchaseSplit,
	getCreditCardPurchaseSplit,
	listCreditCardPurchaseSplits,
	recordSharedCreditCardPurchase,
	updateCreditCardPurchaseSplit,
	updateCreditCardPurchaseWithSplit,
	voidCreditCardPurchaseSplit,
	voidCreditCardPurchaseWithSplit,
} from "../src/credit-cards";
import { CreditCardError } from "../src/credit-cards/errors";
import { calculateLiabilityEventVoidFingerprint } from "../src/credit-cards/fingerprint";
import * as ledgerProvisioning from "../src/credit-cards/ledger-provisioning";
import * as splits from "../src/credit-cards/splits";
import type { Database, DatabaseTransaction } from "../src/db/client";
import * as ledgerBalances from "../src/ledger/balances";
import * as ledgerPosting from "../src/ledger/posting";
import * as ledgerLifecycle from "../src/transactions/ledger-lifecycle";

describe("Credit Card Split Coordination Exports & Interface Tests", () => {
	it("exports all Phase 11B service functions", () => {
		expect(typeof recordSharedCreditCardPurchase).toBe("function");
		expect(typeof updateCreditCardPurchaseWithSplit).toBe("function");
		expect(typeof voidCreditCardPurchaseWithSplit).toBe("function");
		expect(typeof createCreditCardPurchaseSplit).toBe("function");
		expect(typeof updateCreditCardPurchaseSplit).toBe("function");
		expect(typeof voidCreditCardPurchaseSplit).toBe("function");
		expect(typeof getCreditCardPurchaseSplit).toBe("function");
		expect(typeof listCreditCardPurchaseSplits).toBe("function");
	});
});

// ============================================================================
// Coordinated shared-purchase VOID retry determinism
// ----------------------------------------------------------------------------
// Regression coverage for the defect where `voidCreditCardPurchaseWithSplit`
// passed `validOccurredAt ?? new Date()` to the purchase-side VOID. When the
// caller omitted `occurredAt`, a retry of an already-committed coordinated
// command could feed a *fresh* wall-clock timestamp into the purchase VOID
// fingerprint under the same idempotency key -- making a lost-response retry
// look like an idempotency conflict.
//
// The split side is already deterministic: an omitted `occurredAt` falls back
// to the previous split revision's `occurredAt` on a fresh VOID, and to the
// stored VOID revision's `occurredAt` on a historical replay. The fix reuses
// that same effective timestamp (`splitRes.split.occurredAt`, always a
// `Date` -- the column is `mode: "date"`) for the coordinated purchase VOID.
// ============================================================================

describe("voidCreditCardPurchaseWithSplit — omitted-occurredAt retry determinism", () => {
	const USER_ID = "11111111-1111-1111-1111-111111111111";
	const CARD_ID = "22222222-2222-2222-2222-222222222222";
	const PURCHASE_EVENT_ID = "33333333-3333-3333-3333-333333333333";
	const SPLIT_ID = "44444444-4444-4444-4444-444444444444";

	// The deterministic effective timestamp the split VOID resolves to when the
	// caller omits `occurredAt` (previous split revision on a fresh VOID, stored
	// VOID revision on a replay). It is deliberately far in the past so that any
	// accidental `new Date()` fallback is trivially distinguishable.
	const SPLIT_EFFECTIVE_AT = new Date("2026-06-10T09:00:00.000Z");
	const OTHER_AT = new Date("2026-07-01T00:00:00.000Z");

	const SPLIT_READ_MODEL = (occurredAt: Date) => ({
		splitId: SPLIT_ID,
		userId: USER_ID,
		purchaseEventId: PURCHASE_EVENT_ID,
		status: "VOID" as const,
		revisionNo: 2,
		method: "EQUAL" as const,
		grossAmount: "100.00",
		userShareAmount: "100.00",
		externalShareAmount: "0.00",
		userWeight: 1,
		occurredAt,
		createdAt: new Date("2026-06-01T00:00:00.000Z"),
		participants: [],
	});

	const SPLIT_ANCHOR_ROW = {
		id: SPLIT_ID,
		userId: USER_ID,
		purchaseEventId: PURCHASE_EVENT_ID,
		createdAt: new Date("2026-06-01T00:00:00.000Z"),
	};

	/**
	 * Minimal ordered fake transaction. `select(...)` chains that terminate in
	 * `.limit()`, `.for()` or `.orderBy(...).limit()` each consume the next
	 * entry from `results`; `insert(...).values(row)` records `row`.
	 */
	function makeOrderedTx(results: unknown[][]) {
		let call = 0;
		const inserted: Record<string, unknown>[] = [];
		const next = () => {
			if (call >= results.length) {
				throw new Error(`unexpected select #${call + 1}`);
			}
			return Promise.resolve(results[call++]);
		};
		const whereObj = {
			limit: () => next(),
			for: () => next(),
			orderBy: () => ({ limit: () => next() }),
		};
		const tx = {
			select: () => ({
				from: () => ({ where: () => whereObj, ...whereObj }),
			}),
			insert: () => ({
				values: (row: Record<string, unknown>) => {
					inserted.push(row);
					return Promise.resolve(undefined);
				},
			}),
		};
		return { tx: tx as unknown as DatabaseTransaction, inserted };
	}

	function makeDb(tx: DatabaseTransaction): Database {
		return {
			transaction: vi.fn(async (work: (t: DatabaseTransaction) => unknown) =>
				work(tx),
			),
		} as unknown as Database;
	}

	function stubSplitVoid(occurredAt: Date, idempotentReplay: boolean) {
		return vi.spyOn(splits, "voidSplitInTransaction").mockResolvedValue({
			split: SPLIT_READ_MODEL(occurredAt),
			idempotentReplay,
		} as unknown as Awaited<ReturnType<typeof splits.voidSplitInTransaction>>);
	}

	function stubPurchaseVoidLedgerDeps() {
		vi.spyOn(
			ledgerProvisioning,
			"ensureCreditCardLedgerLinkInTransaction",
		).mockResolvedValue("liab-acct");
		vi.spyOn(
			ledgerProvisioning,
			"ensureCreditCardSystemAccountsInTransaction",
		).mockResolvedValue({
			MANDATORY_EXPENSE: "exp-acct",
		} as unknown as Awaited<
			ReturnType<
				typeof ledgerProvisioning.ensureCreditCardSystemAccountsInTransaction
			>
		>);
		vi.spyOn(
			ledgerPosting,
			"lockLedgerAccountsInTransaction",
		).mockResolvedValue(
			[] as unknown as Awaited<
				ReturnType<typeof ledgerPosting.lockLedgerAccountsInTransaction>
			>,
		);
		vi.spyOn(
			ledgerBalances,
			"getLedgerAccountBalanceInTransaction",
		).mockResolvedValue({
			accountId: "liab-acct",
			currency: "TRY",
			normalBalance: "CREDIT",
			balance: "100.00",
			asOf: "2026-06-10T00:00:00.000Z",
		});
		vi.spyOn(
			ledgerLifecycle,
			"voidCanonicalTransactionWithLedgerInTransaction",
		).mockResolvedValue({
			transactionId: "canon-txn-1",
			revisionId: "canon-rev-2",
			revisionNo: 2,
			operation: "VOID",
			idempotentReplay: false,
			ledger: {
				appliedJournalEntryId: "je-void-1",
				reversalJournalEntryId: null,
			},
		});
	}

	const FRESH_LATEST_REV = {
		id: "cc-rev-1",
		eventId: PURCHASE_EVENT_ID,
		revisionNo: 1,
		operation: "CREATE",
		amount: "100.00",
		budgetCategory: "MANDATORY_EXPENSE",
		merchant: null,
		description: null,
		installmentCount: null,
		purchaseDate: "2026-06-10",
		canonicalRevisionId: "canon-rev-1",
	};

	function freshVoidResults(): unknown[][] {
		return [
			[SPLIT_ANCHOR_ROW], // wrapper: locate split
			[], // purchase VOID: early idempotency replay -> none
			[
				{
					id: PURCHASE_EVENT_ID,
					userId: USER_ID,
					creditCardId: CARD_ID,
					eventType: "PURCHASE",
					canonicalTransactionId: "canon-txn-1",
				},
			], // event anchor
			[{ id: CARD_ID, userId: USER_ID, code: "CARD1" }], // card FOR UPDATE
			[{ status: "ACTIVE" }], // latest card revision
			[{ id: PURCHASE_EVENT_ID }], // event anchor lock
			[], // second idempotency replay -> none
			[FRESH_LATEST_REV], // latest liability revision
			[{ revisionNo: 1 }], // latest canonical revision
		];
	}

	function storedVoidRev(fingerprint: string) {
		return {
			id: "cc-void-rev-2",
			userId: USER_ID,
			eventId: PURCHASE_EVENT_ID,
			revisionNo: 2,
			operation: "VOID",
			amount: "100.00",
			budgetCategory: "MANDATORY_EXPENSE",
			merchant: null,
			description: null,
			installmentCount: null,
			purchaseDate: "2026-06-10",
			canonicalRevisionId: "canon-rev-2",
			revisionFingerprint: fingerprint,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -- A. FRESH OMITTED-TIMESTAMP VOID -------------------------------------
	it("A: fresh coordinated VOID with occurredAt omitted uses the split's effective timestamp, never a fresh wall-clock", async () => {
		const splitVoidSpy = stubSplitVoid(SPLIT_EFFECTIVE_AT, false);
		stubPurchaseVoidLedgerDeps();
		const { tx, inserted } = makeOrderedTx(freshVoidResults());

		const res = await voidCreditCardPurchaseWithSplit({
			db: makeDb(tx),
			userId: USER_ID,
			purchaseEventId: PURCHASE_EVENT_ID,
			purchaseExpectedRevisionNo: 1,
			splitExpectedRevisionNo: 1,
			purchaseIdempotencyKey: "pk-fresh",
			splitIdempotencyKey: "sk-fresh",
			reasonNote: "cancelled order",
			// occurredAt omitted
		});

		expect(res.purchase.status).toBe("VOID");
		expect(res.purchase.idempotentReplay).toBe(false);

		// Split side was asked to resolve its own deterministic fallback.
		expect(splitVoidSpy).toHaveBeenCalledTimes(1);
		expect(splitVoidSpy.mock.calls[0]?.[1]).toMatchObject({
			occurredAt: undefined,
		});

		// The purchase VOID revision was persisted with EXACTLY the split's
		// resolved effective timestamp -- not `new Date()`.
		expect(inserted).toHaveLength(1);
		const persistedOccurredAt = inserted[0]?.occurredAt;
		expect(persistedOccurredAt).toBeInstanceOf(Date);
		expect((persistedOccurredAt as Date).getTime()).toBe(
			SPLIT_EFFECTIVE_AT.getTime(),
		);
	});

	// -- B. LOST-RESPONSE RETRY -------------------------------------------------
	it("B: replaying the identical coordinated VOID (omitted occurredAt, lost response) is an idempotent replay, not a conflict", async () => {
		// The first call committed a purchase VOID whose fingerprint was bound
		// to the split's effective timestamp. On the retry the split VOID is an
		// idempotent replay returning that same stored timestamp.
		const fingerprint = await calculateLiabilityEventVoidFingerprint({
			userId: USER_ID,
			eventId: PURCHASE_EVENT_ID,
			expectedRevisionNo: 1,
			reasonNote: null,
			occurredAt: SPLIT_EFFECTIVE_AT,
		});
		const splitVoidSpy = stubSplitVoid(SPLIT_EFFECTIVE_AT, true);
		const { tx, inserted } = makeOrderedTx([
			[SPLIT_ANCHOR_ROW],
			[storedVoidRev(fingerprint)],
		]);

		const res = await voidCreditCardPurchaseWithSplit({
			db: makeDb(tx),
			userId: USER_ID,
			purchaseEventId: PURCHASE_EVENT_ID,
			purchaseExpectedRevisionNo: 1,
			splitExpectedRevisionNo: 1,
			purchaseIdempotencyKey: "pk-retry",
			splitIdempotencyKey: "sk-retry",
			// reasonNote omitted -> null, occurredAt omitted
		});

		expect(splitVoidSpy).toHaveBeenCalledTimes(1);
		expect(res.purchase.idempotentReplay).toBe(true);
		expect(res.purchase.revisionId).toBe("cc-void-rev-2");
		expect(res.purchase.revisionNo).toBe(2);
		expect(res.split.revisionNo).toBe(2);
		expect(res.idempotentReplay).toBe(true);
		// No new revision of any kind was written on the retry.
		expect(inserted).toHaveLength(0);
	});

	// -- C. EXPLICIT TIMESTAMP -----------------------------------------------
	it("C: an explicit occurredAt is still used verbatim and replays cleanly (split's own timestamp is irrelevant)", async () => {
		const fingerprint = await calculateLiabilityEventVoidFingerprint({
			userId: USER_ID,
			eventId: PURCHASE_EVENT_ID,
			expectedRevisionNo: 1,
			reasonNote: null,
			occurredAt: SPLIT_EFFECTIVE_AT,
		});
		// Split read model reports a DIFFERENT timestamp -- must be ignored when
		// the caller passed an explicit occurredAt.
		const splitVoidSpy = stubSplitVoid(OTHER_AT, true);
		const { tx, inserted } = makeOrderedTx([
			[SPLIT_ANCHOR_ROW],
			[storedVoidRev(fingerprint)],
		]);

		const res = await voidCreditCardPurchaseWithSplit({
			db: makeDb(tx),
			userId: USER_ID,
			purchaseEventId: PURCHASE_EVENT_ID,
			purchaseExpectedRevisionNo: 1,
			splitExpectedRevisionNo: 1,
			purchaseIdempotencyKey: "pk-explicit",
			splitIdempotencyKey: "sk-explicit",
			occurredAt: SPLIT_EFFECTIVE_AT,
		});

		// Split VOID received the validated explicit timestamp.
		expect(splitVoidSpy.mock.calls[0]?.[1]).toMatchObject({
			occurredAt: SPLIT_EFFECTIVE_AT,
		});
		expect(res.purchase.idempotentReplay).toBe(true);
		expect(inserted).toHaveLength(0);
	});

	// -- D. CHANGED PAYLOAD CONFLICT ---------------------------------------
	it("D: same idempotency key with a genuinely changed explicit occurredAt is still an idempotency conflict", async () => {
		const storedFingerprint = await calculateLiabilityEventVoidFingerprint({
			userId: USER_ID,
			eventId: PURCHASE_EVENT_ID,
			expectedRevisionNo: 1,
			reasonNote: null,
			occurredAt: SPLIT_EFFECTIVE_AT,
		});
		stubSplitVoid(OTHER_AT, true);
		const { tx } = makeOrderedTx([
			[SPLIT_ANCHOR_ROW],
			[storedVoidRev(storedFingerprint)],
		]);

		await expect(
			voidCreditCardPurchaseWithSplit({
				db: makeDb(tx),
				userId: USER_ID,
				purchaseEventId: PURCHASE_EVENT_ID,
				purchaseExpectedRevisionNo: 1,
				splitExpectedRevisionNo: 1,
				purchaseIdempotencyKey: "pk-conflict",
				splitIdempotencyKey: "sk-conflict",
				occurredAt: OTHER_AT, // different from the committed VOID
			}),
		).rejects.toMatchObject({
			name: "CreditCardError",
			code: "CREDIT_CARD_IDEMPOTENCY_CONFLICT",
		});
	});

	// -- E. INPUT VALIDATION ------------------------------------------------
	it("E: null / string / number / invalid Date for optional occurredAt fails before any DB work", async () => {
		const badValues: unknown[] = [
			null,
			"2026-06-10T09:00:00.000Z",
			1_717_000_000_000,
			new Date("not-a-date"),
		];

		for (const bad of badValues) {
			const transaction = vi.fn();
			const db = { transaction } as unknown as Database;

			await expect(
				voidCreditCardPurchaseWithSplit({
					db,
					userId: USER_ID,
					purchaseEventId: PURCHASE_EVENT_ID,
					purchaseExpectedRevisionNo: 1,
					splitExpectedRevisionNo: 1,
					purchaseIdempotencyKey: "pk-bad",
					splitIdempotencyKey: "sk-bad",
					occurredAt: bad as unknown as Date,
				}),
			).rejects.toBeInstanceOf(CreditCardError);
			expect(transaction).not.toHaveBeenCalled();
		}
	});
});
