import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, DatabaseTransaction } from "../src/db/client";
import * as systemAccountsModule from "../src/ledger/system-expense-accounts";
import {
	createManualExpense,
	updateManualExpense,
} from "../src/manual-expenses/service";
import { canonicalizePayload } from "../src/transactions/canonical-json";
import * as ledgerLifecycle from "../src/transactions/ledger-lifecycle";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const EXPENSE_ID = "33333333-3333-4333-8333-333333333333";
const SYSTEM_ACC_ID = "44444444-4444-4444-8444-444444444444";

describe("Manual Expense Canonical Payload & Lifecycle (Targeted Closure)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(
			systemAccountsModule,
			"ensureUserExpenseSystemAccountsInTransaction",
		).mockResolvedValue({
			MANDATORY_EXPENSE: SYSTEM_ACC_ID,
			DISCRETIONARY_EXPENSE: SYSTEM_ACC_ID,
			SHORT_TERM_PURCHASE: SYSTEM_ACC_ID,
			UNCLASSIFIED_EXPENSE: SYSTEM_ACC_ID,
			OPENING_EQUITY: SYSTEM_ACC_ID,
		});
	});

	it("create succeeds with all optional fields omitted and payload has no undefined properties", async () => {
		let capturedPayload: Record<string, unknown> | undefined;
		let capturedLedgerLines: unknown;

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => {
						// For verifyAssetAccountInTransaction
						return Promise.resolve([
							{
								id: ASSET_ID,
								userId: USER_ID,
								accountType: "ASSET",
								archivedAt: null,
							},
						]);
					}),
				})),
			})),
		} as unknown as DatabaseTransaction;

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
					return await cb(mockTx);
				},
			),
		} as unknown as Database;

		const lifecycleSpy = vi
			.spyOn(
				ledgerLifecycle,
				"createCanonicalTransactionWithLedgerInTransaction",
			)
			.mockImplementation(async (params) => {
				capturedPayload = params.payload;
				capturedLedgerLines = params.ledger.lines;

				// Real canonicalizePayload check - strictly rejects any undefined keys
				const { canonicalObject, canonicalJson } = canonicalizePayload(
					params.payload,
				);
				expect(canonicalObject).toBeDefined();
				expect(canonicalJson).toBeDefined();

				return {
					transactionId: EXPENSE_ID,
					revisionId: "rev-1",
					revisionNo: 1,
					operation: "CREATE" as const,
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: "entry-1",
						reversalJournalEntryId: null,
					},
				};
			});

		// Invoke the REAL createManualExpense service function with all legitimate optional fields omitted
		const result = await createManualExpense(mockDb, USER_ID, {
			amount: "150.00",
			sourceAssetAccountId: ASSET_ID,
			budgetCategory: "MANDATORY_EXPENSE",
			idempotencyKey: "idem-key-1",
			spendingCategoryId: undefined,
			merchant: undefined,
			description: undefined,
			shortTermGoalId: undefined,
		});

		expect(result).toBeDefined();
		expect(result?.transactionId).toBe(EXPENSE_ID);
		expect(capturedPayload).toBeDefined();

		// 1. Assert payload contains only defined properties
		expect(capturedPayload).toEqual({
			amount: "150.00",
			sourceAssetAccountId: ASSET_ID,
			budgetCategory: "MANDATORY_EXPENSE",
		});
		expect("spendingCategoryId" in (capturedPayload ?? {})).toBe(false);
		expect("merchant" in (capturedPayload ?? {})).toBe(false);
		expect("description" in (capturedPayload ?? {})).toBe(false);
		expect("shortTermGoalId" in (capturedPayload ?? {})).toBe(false);

		// 2. Verify canonical stored payload contains no undefined properties
		for (const [k, v] of Object.entries(capturedPayload ?? {})) {
			expect(v, `Key ${k} should not be undefined`).not.toBeUndefined();
		}

		// 3. Ledger effect still occurs correctly (balanced debit/credit lines)
		expect(capturedLedgerLines).toEqual([
			{
				accountId: SYSTEM_ACC_ID,
				side: "DEBIT",
				amount: "150.00",
				memo: "Manual expense",
			},
			{
				accountId: ASSET_ID,
				side: "CREDIT",
				amount: "150.00",
				memo: "Manual expense payment",
			},
		]);

		lifecycleSpy.mockRestore();
	});

	it("identical idempotency retry remains idempotent", async () => {
		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => {
						return Promise.resolve([
							{
								id: ASSET_ID,
								userId: USER_ID,
								accountType: "ASSET",
								archivedAt: null,
							},
						]);
					}),
				})),
			})),
		} as unknown as DatabaseTransaction;

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
					return await cb(mockTx);
				},
			),
		} as unknown as Database;

		const lifecycleSpy = vi
			.spyOn(
				ledgerLifecycle,
				"createCanonicalTransactionWithLedgerInTransaction",
			)
			.mockResolvedValueOnce({
				transactionId: EXPENSE_ID,
				revisionId: "rev-1",
				revisionNo: 1,
				operation: "CREATE" as const,
				idempotentReplay: true,
				ledger: {
					appliedJournalEntryId: "entry-1",
					reversalJournalEntryId: null,
				},
			});

		const retryResult = await createManualExpense(mockDb, USER_ID, {
			amount: "150.00",
			sourceAssetAccountId: ASSET_ID,
			budgetCategory: "MANDATORY_EXPENSE",
			idempotencyKey: "idem-key-1",
		});

		expect(retryResult?.idempotentReplay).toBe(true);
		expect(retryResult?.transactionId).toBe(EXPENSE_ID);

		lifecycleSpy.mockRestore();
	});

	it("update with legitimate optional omissions does not generate invalid canonical JSON", async () => {
		let capturedUpdatePayload: Record<string, unknown> | undefined;
		let capturedUpdateLedgerLines: unknown;

		const mockTx = {
			select: vi.fn().mockImplementation(() => ({
				from: vi.fn().mockImplementation(() => ({
					where: vi.fn().mockImplementation(() => {
						const chain = {
							orderBy: vi.fn().mockImplementation(() => ({
								limit: vi.fn().mockResolvedValue([
									{
										revisionNo: 1,
										payload: {
											amount: "150.00",
											sourceAssetAccountId: ASSET_ID,
											budgetCategory: "MANDATORY_EXPENSE",
										},
										occurredAt: new Date(),
									},
								]),
							})),
							// biome-ignore lint/suspicious/noThenProperty: Drizzle query chain mock is thenable
							then: (resolve: (val: unknown) => void) =>
								resolve([
									{
										id: EXPENSE_ID,
										userId: USER_ID,
										kind: "MANUAL_EXPENSE",
										accountType: "ASSET",
										archivedAt: null,
									},
								]),
						};
						return chain;
					}),
				})),
			})),
		} as unknown as DatabaseTransaction;

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: DatabaseTransaction) => Promise<unknown>) => {
					return await cb(mockTx);
				},
			),
		} as unknown as Database;

		const updateSpy = vi
			.spyOn(
				ledgerLifecycle,
				"reviseCanonicalTransactionWithLedgerInTransaction",
			)
			.mockImplementation(async (params) => {
				capturedUpdatePayload = params.payload;
				capturedUpdateLedgerLines = params.ledger.lines;

				// Strictly validates that payload has no undefined properties
				const { canonicalObject, canonicalJson } = canonicalizePayload(
					params.payload,
				);
				expect(canonicalObject).toBeDefined();
				expect(canonicalJson).toBeDefined();

				return {
					transactionId: EXPENSE_ID,
					revisionId: "rev-2",
					revisionNo: 2,
					operation: "UPDATE" as const,
					idempotentReplay: false,
					ledger: {
						appliedJournalEntryId: "entry-2",
						reversalJournalEntryId: "entry-1-rev",
					},
				};
			});

		// Invoke the REAL updateManualExpense service function omitting optional updates
		const result = await updateManualExpense(mockDb, USER_ID, EXPENSE_ID, {
			amount: "200.00",
			expectedRevisionNo: 1,
			idempotencyKey: "update-key-1",
			spendingCategoryId: undefined,
			merchant: undefined,
			description: undefined,
		});

		expect(result).toBeDefined();
		expect(result?.revisionNo).toBe(2);
		expect(capturedUpdatePayload).toBeDefined();

		// Check no undefined values
		for (const [k, v] of Object.entries(capturedUpdatePayload ?? {})) {
			expect(
				v,
				`Key ${k} should not be undefined in update payload`,
			).not.toBeUndefined();
		}

		expect(capturedUpdateLedgerLines).toEqual([
			{
				accountId: SYSTEM_ACC_ID,
				side: "DEBIT",
				amount: "200.00",
				memo: "Manual expense",
			},
			{
				accountId: ASSET_ID,
				side: "CREDIT",
				amount: "200.00",
				memo: "Manual expense payment",
			},
		]);

		updateSpy.mockRestore();
	});
});
