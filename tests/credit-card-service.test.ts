import { describe, expect, it, vi } from "vitest";
import {
	validateCalendarDay,
	validateCardCode,
	validateCcCanonicalUuid,
	validateCcExpectedRevisionNo,
	validateCcOptionalText,
	validateCcPositiveMoneyString,
	validateCcRequiredText,
	validateLastFour,
	validateReservePlacement,
} from "../src/credit-cards/calendar";
import { CreditCardError } from "../src/credit-cards/errors";
import type { Database, DatabaseTransaction } from "../src/db/client";
import type {
	CreditCardStatementStatus,
	CreditCardStatus,
} from "../src/db/schema/credit-cards";

describe("CreditCardError", () => {
	it("has correct name and code", () => {
		const err = new CreditCardError("CREDIT_CARD_NOT_FOUND", "not found");
		expect(err.name).toBe("CreditCardError");
		expect(err.code).toBe("CREDIT_CARD_NOT_FOUND");
		expect(err.message).toBe("not found");
		expect(err instanceof Error).toBe(true);
	});

	it("all required error codes exist as strings", () => {
		const codes = [
			"CREDIT_CARD_INVALID_INPUT",
			"CREDIT_CARD_NOT_FOUND",
			"CREDIT_CARD_NOT_ACTIVE",
			"CREDIT_CARD_CONFLICT",
			"CREDIT_CARD_REVISION_CONFLICT",
			"CREDIT_CARD_STATEMENT_NOT_FOUND",
			"CREDIT_CARD_STATEMENT_PERIOD_CONFLICT",
			"CREDIT_CARD_STATEMENT_NOT_OPEN",
			"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			"CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY",
			"CREDIT_CARD_RESERVE_CONFLICT",
			"CREDIT_CARD_IDEMPOTENCY_CONFLICT",
			"CREDIT_CARD_INVALID_STATE",
		] as const;

		for (const code of codes) {
			const err = new CreditCardError(code, "test");
			expect(err.code).toBe(code);
		}
	});
});

describe("input validation edge cases", () => {
	it("validateCcCanonicalUuid rejects non-string", () => {
		expect(() => validateCcCanonicalUuid(123, "id")).toThrow(CreditCardError);
	});

	it("validateCcCanonicalUuid rejects invalid UUID", () => {
		expect(() => validateCcCanonicalUuid("not-a-uuid", "id")).toThrow(
			CreditCardError,
		);
	});

	it("validateCcCanonicalUuid normalizes to lowercase", () => {
		const upper = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
		expect(validateCcCanonicalUuid(upper, "id")).toBe(upper.toLowerCase());
	});

	it("validateCardCode trims and uppercases", () => {
		expect(validateCardCode("  akbank  ")).toBe("AKBANK");
	});

	it("validateCcRequiredText trims input", () => {
		expect(validateCcRequiredText("  hello  ", "f", 100)).toBe("hello");
	});

	it("validateCcRequiredText throws on empty", () => {
		expect(() => validateCcRequiredText("   ", "f", 100)).toThrow(
			CreditCardError,
		);
	});

	it("validateCcRequiredText throws on exceeding maxLength", () => {
		expect(() => validateCcRequiredText("a".repeat(201), "f", 200)).toThrow(
			CreditCardError,
		);
	});

	it("validateCcOptionalText returns null for empty string", () => {
		expect(validateCcOptionalText("  ", "f", 100)).toBeNull();
	});

	it("validateCcOptionalText returns null for null", () => {
		expect(validateCcOptionalText(null, "f", 100)).toBeNull();
	});

	it("validateCcPositiveMoneyString rejects 0.00", () => {
		expect(() => validateCcPositiveMoneyString("0.00", "amount")).toThrow(
			CreditCardError,
		);
	});

	it("validateCcPositiveMoneyString accepts 8000.00", () => {
		const r = validateCcPositiveMoneyString("8000.00", "amount");
		expect(r.normalized).toBe("8000.00");
		expect(r.cents).toBe(800000n);
	});

	it("validateCcPositiveMoneyString rejects decimal > 2 places", () => {
		expect(() => validateCcPositiveMoneyString("8000.001", "amount")).toThrow(
			CreditCardError,
		);
	});

	it("validateCalendarDay accepts 1 and 31", () => {
		expect(validateCalendarDay(1, "d")).toBe(1);
		expect(validateCalendarDay(31, "d")).toBe(31);
	});

	it("validateCalendarDay rejects 0, 32, float", () => {
		expect(() => validateCalendarDay(0, "d")).toThrow(CreditCardError);
		expect(() => validateCalendarDay(32, "d")).toThrow(CreditCardError);
		expect(() => validateCalendarDay(1.5, "d")).toThrow(CreditCardError);
	});

	it("validateLastFour accepts null and 4-digit string", () => {
		expect(validateLastFour(null)).toBeNull();
		expect(validateLastFour("5678")).toBe("5678");
	});

	it("validateLastFour rejects non-digit 4-char string", () => {
		expect(() => validateLastFour("ABCD")).toThrow(CreditCardError);
	});

	it("validateLastFour rejects 3 and 5 digit strings", () => {
		expect(() => validateLastFour("123")).toThrow(CreditCardError);
		expect(() => validateLastFour("12345")).toThrow(CreditCardError);
	});

	it("validateReservePlacement accepts both placements", () => {
		expect(validateReservePlacement("MIDAS_FUND")).toBe("MIDAS_FUND");
		expect(validateReservePlacement("OUTSIDE_MIDAS")).toBe("OUTSIDE_MIDAS");
	});

	it("validateReservePlacement rejects invalid", () => {
		expect(() => validateReservePlacement("PARTIAL")).toThrow(CreditCardError);
		expect(() => validateReservePlacement(null)).toThrow(CreditCardError);
	});

	it("validateCcExpectedRevisionNo rejects 0, float, negative", () => {
		expect(() => validateCcExpectedRevisionNo(0)).toThrow(CreditCardError);
		expect(() => validateCcExpectedRevisionNo(1.5)).toThrow(CreditCardError);
		expect(() => validateCcExpectedRevisionNo(-5)).toThrow(CreditCardError);
	});
});

function createMockTxForConsistentRead(opts: {
	bucketBalance: string;
	statementAmount: string;
	reservePlacement: "MIDAS_FUND" | "OUTSIDE_MIDAS";
	statementStatus?: "OPEN" | "VOID";
}) {
	const statementId = "22222222-2222-4222-8222-222222222222";
	const midasAccountId = "33333333-3333-4333-8333-333333333333";
	const bucketId = "44444444-4444-4444-8444-444444444444";
	const userId = "11111111-1111-4111-8111-111111111111";

	return {
		select: vi
			.fn()
			// 1. Statement anchor lookup
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: statementId,
								cardId: "55555555-5555-4555-8555-555555555555",
								cycleYear: 2026,
								cycleMonth: 9,
								midasAccountId,
								midasReserveBucketId: bucketId,
							},
						]),
					}),
				}),
			})
			// 2. Midas account lookup in getMidasLiquidityStateInTransaction
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						for: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: midasAccountId,
									userId,
									ledgerAccountId: "66666666-6666-4666-8666-666666666666",
								},
							]),
						}),
					}),
				}),
			})
			// 3. Ledger account in getMidasLiquidityStateInTransaction
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: "66666666-6666-4666-8666-666666666666",
								userId,
								currency: "TRY",
							},
						]),
					}),
				}),
			})
			// 4. Physical balance query
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					innerJoin: vi.fn().mockReturnValue({
						where: vi.fn().mockResolvedValue([{ netDebit: "10000.00" }]),
					}),
				}),
			})
			// 5. Buckets query
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						orderBy: vi.fn().mockResolvedValue([
							{
								id: bucketId,
								code: "CCR_TEST",
								name: "Reserve",
								bucketType: "CREDIT_CARD_RESERVE",
							},
						]),
					}),
				}),
			})
			// 6. Per-bucket transfers query
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([
						{
							fromBucketId: null,
							toBucketId: bucketId,
							amount: opts.bucketBalance,
						},
					]),
				}),
			})
			// 7. Latest statement revision lookup
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						orderBy: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									revisionNo: 1,
									status: opts.statementStatus ?? "OPEN",
									statementAmount: opts.statementAmount,
									statementDate: "2026-09-02",
									dueDate: "2026-09-12",
									reservePlacement: opts.reservePlacement,
									note: null,
								},
							]),
						}),
					}),
				}),
			}),
	} as unknown as DatabaseTransaction;
}

describe("Credit Card Service Consistent Reads & Fail-Closed Invariants", () => {
	const userId = "11111111-1111-4111-8111-111111111111";
	const statementId = "22222222-2222-4222-8222-222222222222";

	it("getCreditCardStatementInTransaction throws CREDIT_CARD_INVALID_STATE when OPEN MIDAS_FUND balance mismatches statement amount", async () => {
		const { getCreditCardStatementInTransaction } = await import(
			"../src/credit-cards/service"
		);

		const mockTx = createMockTxForConsistentRead({
			bucketBalance: "5000.00",
			statementAmount: "8000.00",
			reservePlacement: "MIDAS_FUND",
		});

		await expect(
			getCreditCardStatementInTransaction(mockTx, userId, statementId),
		).rejects.toThrowError(
			expect.objectContaining({
				code: "CREDIT_CARD_INVALID_STATE",
			}),
		);
	});

	it("getCreditCardStatementInTransaction throws CREDIT_CARD_INVALID_STATE when OPEN OUTSIDE_MIDAS has non-zero bucket balance", async () => {
		const { getCreditCardStatementInTransaction } = await import(
			"../src/credit-cards/service"
		);

		const mockTx = createMockTxForConsistentRead({
			bucketBalance: "1000.00",
			statementAmount: "8000.00",
			reservePlacement: "OUTSIDE_MIDAS",
		});

		await expect(
			getCreditCardStatementInTransaction(mockTx, userId, statementId),
		).rejects.toThrowError(
			expect.objectContaining({
				code: "CREDIT_CARD_INVALID_STATE",
			}),
		);
	});

	it("getCreditCardStatementInTransaction returns valid record with reserveSatisfied: true when exact", async () => {
		const { getCreditCardStatementInTransaction } = await import(
			"../src/credit-cards/service"
		);

		const mockTx = createMockTxForConsistentRead({
			bucketBalance: "8000.00",
			statementAmount: "8000.00",
			reservePlacement: "MIDAS_FUND",
		});

		const record = await getCreditCardStatementInTransaction(
			mockTx,
			userId,
			statementId,
		);
		expect(record).not.toBeNull();
		expect(record?.reserveSatisfied).toBe(true);
		expect(record?.reserveAmount).toBe("8000.00");
		expect(record?.statementAmount).toBe("8000.00");
	});
});

describe("Credit Card Lifecycle & Replay Snapshot Contracts", () => {
	const userId = "11111111-1111-4111-8111-111111111111";
	const cardId = "55555555-5555-4555-8555-555555555555";
	const occurredAt = new Date("2026-09-01T12:00:00Z");

	it("createCreditCardInTransaction returns historical snapshot on exact replay", async () => {
		const { createCreditCardInTransaction } = await import(
			"../src/credit-cards/service"
		);
		const { calculateCreditCardCreateFingerprint } = await import(
			"../src/credit-cards/fingerprint"
		);

		const expectedFp = await calculateCreditCardCreateFingerprint({
			userId,
			code: "BONUS_CARD",
			displayName: "Bonus Platinum",
			issuer: "Garanti BBVA",
			statementDay: 15,
			dueDay: 25,
			creditLimit: "50000.00",
			lastFour: "1234",
			note: "Main card",
			occurredAt,
		});

		const mockTx = {
			select: vi.fn().mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockResolvedValue([
							{
								id: "rev-1111",
								creditCardId: cardId,
								revisionNo: 1,
								operation: "CREATE",
								status: "ACTIVE",
								displayName: "Bonus Platinum",
								issuer: "Garanti BBVA",
								statementDay: 15,
								dueDay: 25,
								creditLimit: "50000.00",
								lastFour: "1234",
								note: "Main card",
								changeReason: null,
								revisionFingerprint: expectedFp,
							},
						]),
					}),
				}),
			}),
		} as unknown as DatabaseTransaction;

		const result = await createCreditCardInTransaction({
			tx: mockTx,
			userId,
			code: "BONUS_CARD",
			displayName: "Bonus Platinum",
			issuer: "Garanti BBVA",
			statementDay: 15,
			dueDay: 25,
			creditLimit: "50000.00",
			lastFour: "1234",
			note: "Main card",
			occurredAt,
			idempotencyKey: "idem-card-create-1",
		});

		expect(result.idempotentReplay).toBe(true);
		expect(result.cardId).toBe(cardId);
		expect(result.snapshot.displayName).toBe("Bonus Platinum");
		expect(result.snapshot.creditLimit).toBe("50000.00");
		expect(result.snapshot.changeReason).toBeNull();
	});

	it("createCreditCardInTransaction locks users row FOR UPDATE before inserting", async () => {
		const { createCreditCardInTransaction } = await import(
			"../src/credit-cards/service"
		);

		const operations: string[] = [];

		const mockTx = {
			select: vi
				.fn()
				// 1. Early idempotency check
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				})
				// 2. User row lock FOR UPDATE
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							for: vi.fn((mode: string) => {
								operations.push(`lock_users_${mode}`);
								return {
									limit: vi.fn().mockResolvedValue([{ id: userId }]),
								};
							}),
						}),
					}),
				})
				// 3. Second idempotency check post-lock
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				})
				// 4. Code conflict check
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([]),
						}),
					}),
				})
				// 5. ensureCreditCardLedgerLink existing check
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi
								.fn()
								.mockResolvedValue([
									{ id: "link-1", liabilityAccountId: "liab-1" },
								]),
						}),
					}),
				})
				// 6. ensureCreditCardSystemAccounts existing check
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockResolvedValue([
							{ role: "MANDATORY_EXPENSE", ledgerAccountId: "sys-1" },
							{ role: "DISCRETIONARY_EXPENSE", ledgerAccountId: "sys-2" },
							{ role: "SHORT_TERM_PURCHASE", ledgerAccountId: "sys-3" },
							{ role: "UNCLASSIFIED_EXPENSE", ledgerAccountId: "sys-4" },
							{ role: "OPENING_EQUITY", ledgerAccountId: "sys-5" },
						]),
					}),
				}),
			insert: vi.fn((_table: unknown) => ({
				values: vi.fn((_vals: unknown) => ({
					returning: vi.fn(async () => {
						operations.push("insert_table");
						return [
							{
								id: cardId,
								revisionNo: 1,
								userId,
								creditCardId: cardId,
								operation: "CREATE",
								status: "ACTIVE",
								displayName: "World Card",
								issuer: "Yapı Kredi",
								statementDay: 10,
								dueDay: 20,
								creditLimit: "30000.00",
								lastFour: null,
								note: null,
								changeReason: null,
							},
						];
					}),
				})),
			})),
		} as unknown as DatabaseTransaction;

		const result = await createCreditCardInTransaction({
			tx: mockTx,
			userId,
			code: "WORLD_CARD",
			displayName: "World Card",
			issuer: "Yapı Kredi",
			statementDay: 10,
			dueDay: 20,
			creditLimit: "30000.00",
			occurredAt,
			idempotencyKey: "idem-card-create-2",
		});

		expect(result.idempotentReplay).toBe(false);
		expect(operations).toContain("lock_users_update");
		expect(operations[0]).toBe("lock_users_update");
	});
});

describe("Credit Card Error Boundaries & Lower-Layer Redaction", () => {
	it("mapMidasError redacts sentinel secrets and maps to CreditCardError", async () => {
		const { mapMidasError } = await import("../src/credit-cards/service");
		const { MidasError } = await import("../src/midas/errors");

		const sentinelMidasErr = new MidasError(
			"MIDAS_INVALID_STATE",
			"INTERNAL_MIDAS_SECRET_SENTINEL balance diagnostic 12345 secret_bucket_id",
		);

		try {
			mapMidasError(sentinelMidasErr);
			expect.fail("should have thrown");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			const ccErr = err as CreditCardError;
			expect(ccErr.code).toBe("CREDIT_CARD_INVALID_STATE");
			expect(ccErr.message).not.toContain("INTERNAL_MIDAS_SECRET_SENTINEL");
			expect(ccErr.message).not.toContain("12345");
			expect(ccErr.message).not.toContain("secret_bucket_id");
			expect(ccErr.message).toBe("Credit card reserve state is inconsistent");
		}
	});

	it("mapMidasError correctly maps stable Midas error codes to CreditCardError codes", async () => {
		const { mapMidasError } = await import("../src/credit-cards/service");
		const { MidasError } = await import("../src/midas/errors");

		const testCases = [
			{
				input: new MidasError(
					"MIDAS_INSUFFICIENT_FREE_BALANCE",
					"not enough free balance",
				),
				expectedCode: "CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY",
				expectedMessage:
					"Insufficient free Midas liquidity for credit card reserve",
			},
			{
				input: new MidasError(
					"MIDAS_IDEMPOTENCY_CONFLICT",
					"idempotency conflict",
				),
				expectedCode: "CREDIT_CARD_IDEMPOTENCY_CONFLICT",
				expectedMessage: "Midas allocation idempotency conflict",
			},
			{
				input: new MidasError(
					"MIDAS_INSUFFICIENT_BUCKET_BALANCE",
					"bucket underflow",
				),
				expectedCode: "CREDIT_CARD_RESERVE_CONFLICT",
				expectedMessage: "Insufficient reserve bucket balance",
			},
			{
				input: new MidasError("MIDAS_ACCOUNT_NOT_FOUND", "account missing"),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
			{
				input: new MidasError("MIDAS_BUCKET_NOT_FOUND", "bucket missing"),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
			{
				input: new MidasError("MIDAS_BUCKET_INACTIVE", "inactive bucket"),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
			{
				input: new MidasError("MIDAS_BUCKET_CAP_EXCEEDED", "cap exceeded"),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
			{
				input: new MidasError("MIDAS_TRANSFER_NOT_FOUND", "transfer missing"),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
			{
				input: new MidasError(
					"MIDAS_TRANSFER_ALREADY_REVERSED",
					"already reversed",
				),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
			{
				input: new MidasError("MIDAS_INVALID_INPUT", "bad input"),
				expectedCode: "CREDIT_CARD_INVALID_STATE",
				expectedMessage: "Credit card reserve state is inconsistent",
			},
		] as const;

		for (const tc of testCases) {
			try {
				mapMidasError(tc.input);
				expect.fail(`should have thrown for ${tc.input.code}`);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(CreditCardError);
				const ccErr = err as CreditCardError;
				expect(ccErr.code).toBe(tc.expectedCode);
				expect(ccErr.message).toBe(tc.expectedMessage);
			}
		}
	});

	it("mapDbError redacts nested SQL/connection sentinel secrets", async () => {
		const { mapDbError } = await import("../src/credit-cards/service");

		const fakeDbErr = new Error("Query failed: INTERNAL_DB_SECRET_SENTINEL", {
			cause: new Error(
				"Connection postgresql://fake-secret:5432 failed on SELECT secret_column FROM tbl",
				{
					cause: {
						code: "57014",
						detail: "statement timeout with secret_token_xyz",
						routine: "ProcessInterrupts",
					},
				},
			),
		});

		try {
			mapDbError(fakeDbErr);
			expect.fail("should have thrown");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			const ccErr = err as CreditCardError;
			expect(ccErr.code).toBe("CREDIT_CARD_INVALID_STATE");
			expect(ccErr.message).toBe("Credit card state transition failed");
			expect(ccErr.message).not.toContain("INTERNAL_DB_SECRET_SENTINEL");
			expect(ccErr.message).not.toContain("postgresql://");
			expect(ccErr.message).not.toContain("fake-secret");
			expect(ccErr.message).not.toContain("SELECT secret_column");
			expect(ccErr.message).not.toContain("secret_token_xyz");
		}
	});

	it("mapDbError accurately maps exact unique constraints and triggers", async () => {
		const { mapDbError } = await import("../src/credit-cards/service");

		// 1. Card code conflict
		try {
			mapDbError(
				new Error("Drizzle error", {
					cause: {
						code: "23505",
						constraint: "credit_cards_user_code_idx",
					},
				}),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe("CREDIT_CARD_CONFLICT");
			expect((err as CreditCardError).message).toBe("Card code conflict");
		}

		// 2. Statement period conflict
		try {
			mapDbError(
				new Error("Drizzle error", {
					cause: {
						code: "23505",
						constraint: "cc_statements_card_cycle_idx",
					},
				}),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe(
				"CREDIT_CARD_STATEMENT_PERIOD_CONFLICT",
			);
			expect((err as CreditCardError).message).toBe(
				"Statement cycle period conflict",
			);
		}

		// 3. Card revision conflict
		try {
			mapDbError(
				new Error("Drizzle error", {
					cause: {
						code: "23505",
						constraint: "cc_revisions_card_rev_idx",
					},
				}),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe(
				"CREDIT_CARD_REVISION_CONFLICT",
			);
			expect((err as CreditCardError).message).toBe("Card revision conflict");
		}

		// 4. Statement revision conflict
		try {
			mapDbError(
				new Error("Drizzle error", {
					cause: {
						code: "23505",
						constraint: "cc_stmt_revisions_stmt_rev_idx",
					},
				}),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe(
				"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			);
			expect((err as CreditCardError).message).toBe(
				"Statement revision conflict",
			);
		}

		// 5. Trigger branching messages
		try {
			mapDbError(
				new Error(
					"db error: Card revision branching forbidden: statement branch",
				),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe(
				"CREDIT_CARD_REVISION_CONFLICT",
			);
		}

		try {
			mapDbError(
				new Error(
					"db error: Statement revision branching forbidden: statement branch",
				),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe(
				"CREDIT_CARD_STATEMENT_REVISION_CONFLICT",
			);
		}

		// 6. Unrelated 23505 must NOT be classified as card/statement conflict
		try {
			mapDbError(
				new Error("Drizzle error", {
					cause: {
						code: "23505",
						constraint: "totally_unrelated_idx",
						detail: "Key (email)=(test@example.com) already exists.",
					},
				}),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe("CREDIT_CARD_INVALID_STATE");
			expect((err as CreditCardError).message).toBe(
				"Credit card state transition failed",
			);
		}

		// 7. Unrelated constraint containing words 'statement' or 'cycle' or 'unique'
		try {
			mapDbError(
				new Error("Drizzle error", {
					cause: {
						code: "23505",
						constraint: "unique_statement_cycle_unrelated_table_idx",
					},
				}),
			);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect((err as CreditCardError).code).toBe("CREDIT_CARD_INVALID_STATE");
		}
	});

	it("public statement read maps MidasError through CreditCardError boundary without leaking MidasError", async () => {
		const { getCreditCardStatementInTransaction } = await import(
			"../src/credit-cards/service"
		);
		const { MidasError } = await import("../src/midas/errors");

		const userId = "11111111-1111-4111-8111-111111111111";
		const statementId = "22222222-2222-4222-8222-222222222222";

		// Create mockTx where Midas account query triggers a MidasError
		const mockTx = {
			select: vi
				.fn()
				// 1. Statement lookup
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue([
								{
									id: statementId,
									cardId: "55555555-5555-4555-8555-555555555555",
									cycleYear: 2026,
									cycleMonth: 9,
									midasAccountId: "33333333-3333-4333-8333-333333333333",
									midasReserveBucketId: "44444444-4444-4444-8444-444444444444",
								},
							]),
						}),
					}),
				})
				// 2. Midas account lookup throwing MidasError
				.mockReturnValueOnce({
					from: vi.fn().mockReturnValue({
						where: vi.fn().mockReturnValue({
							for: vi.fn().mockReturnValue({
								limit: vi.fn().mockImplementation(() => {
									throw new MidasError(
										"MIDAS_INVALID_STATE",
										"INTERNAL_MIDAS_SECRET_SENTINEL",
									);
								}),
							}),
						}),
					}),
				}),
		} as unknown as DatabaseTransaction;

		try {
			await getCreditCardStatementInTransaction(mockTx, userId, statementId);
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			expect(err).not.toBeInstanceOf(MidasError);
			const ccErr = err as CreditCardError;
			expect(ccErr.code).toBe("CREDIT_CARD_INVALID_STATE");
			expect(ccErr.message).toBe("Credit card reserve state is inconsistent");
			expect(ccErr.message).not.toContain("INTERNAL_MIDAS_SECRET_SENTINEL");
		}
	});
});

describe("Runtime Filter Validation", () => {
	const userId = "11111111-1111-4111-8111-111111111111";

	it("listCreditCardStatements rejects invalid creditCardId before executing query", async () => {
		const { listCreditCardStatementsInTransaction } = await import(
			"../src/credit-cards/service"
		);

		const mockTx = {
			select: vi.fn(),
		} as unknown as DatabaseTransaction;

		await expect(
			listCreditCardStatementsInTransaction(mockTx, {
				userId,
				creditCardId: "bad-uuid",
			}),
		).rejects.toThrowError(
			expect.objectContaining({
				code: "CREDIT_CARD_INVALID_INPUT",
			}),
		);

		await expect(
			listCreditCardStatementsInTransaction(mockTx, {
				userId,
				creditCardId: "   ",
			}),
		).rejects.toThrowError(
			expect.objectContaining({
				code: "CREDIT_CARD_INVALID_INPUT",
			}),
		);

		// Verified no DB queries were executed
		expect(mockTx.select).not.toHaveBeenCalled();
	});

	it("listCreditCardStatements rejects invalid status filter before query", async () => {
		const { listCreditCardStatementsInTransaction } = await import(
			"../src/credit-cards/service"
		);

		const mockTx = {
			select: vi.fn(),
		} as unknown as DatabaseTransaction;

		const invalidStatuses = ["ACTIVE", "ARCHIVED", "foo", ""];
		for (const invalidStatus of invalidStatuses) {
			await expect(
				listCreditCardStatementsInTransaction(mockTx, {
					userId,
					status: invalidStatus as unknown as CreditCardStatementStatus,
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_INPUT",
				}),
			);
		}

		expect(mockTx.select).not.toHaveBeenCalled();
	});

	it("listCreditCards rejects invalid status filter before query", async () => {
		const { listCreditCards } = await import("../src/credit-cards/service");

		const mockDb = {
			select: vi.fn(),
		};

		const invalidCardStatuses = ["OPEN", "VOID", "PAID", "foo", ""];
		for (const invalidStatus of invalidCardStatuses) {
			await expect(
				listCreditCards({
					db: mockDb as unknown as Database,
					userId,
					status: invalidStatus as unknown as CreditCardStatus,
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: "CREDIT_CARD_INVALID_INPUT",
				}),
			);
		}

		expect(mockDb.select).not.toHaveBeenCalled();
	});
});

describe("Outer Transaction and Deferred Commit Boundaries", () => {
	const userId = "11111111-1111-4111-8111-111111111111";

	it("isDatabaseBoundaryError distinguishes database errors from programmer errors", async () => {
		const { isDatabaseBoundaryError } = await import(
			"../src/credit-cards/service"
		);

		// Programmer errors
		expect(
			isDatabaseBoundaryError(
				new TypeError("Cannot read properties of undefined"),
			),
		).toBe(false);
		expect(
			isDatabaseBoundaryError(new ReferenceError("foo is not defined")),
		).toBe(false);
		expect(
			isDatabaseBoundaryError(new RangeError("Invalid array length")),
		).toBe(false);
		expect(isDatabaseBoundaryError(new Error("PROGRAMMER_BUG_SENTINEL"))).toBe(
			false,
		);

		// Database errors
		expect(
			isDatabaseBoundaryError(
				new Error("Drizzle query failed", {
					cause: { code: "23505", constraint: "cc_statements_card_cycle_idx" },
				}),
			),
		).toBe(true);
		expect(
			isDatabaseBoundaryError({
				name: "DrizzleQueryError",
				query: "SELECT secret FROM table",
				params: [],
			}),
		).toBe(true);
		expect(
			isDatabaseBoundaryError({
				severity: "ERROR",
				code: "P0001",
				detail: "postgresql://fake-secret",
			}),
		).toBe(true);
		expect(
			isDatabaseBoundaryError({
				code: "42P01",
				routine: "parserOpenTable",
			}),
		).toBe(true);
	});

	it("mapDbError preserves programmer errors without converting them to CreditCardError", async () => {
		const { mapDbError } = await import("../src/credit-cards/service");

		const typeErr = new TypeError("PROGRAMMER_BUG_SENTINEL");
		expect(() => mapDbError(typeErr)).toThrow(typeErr);

		const refErr = new ReferenceError("PROGRAMMER_REF_SENTINEL");
		expect(() => mapDbError(refErr)).toThrow(refErr);
	});

	it("runCreditCardTransaction catches simulated deferred COMMIT rejection and redacts secrets", async () => {
		const { createCreditCardStatement } = await import(
			"../src/credit-cards/service"
		);

		// Mock db where transaction callback succeeds, but db.transaction promise rejects at commit
		const mockDb = {
			transaction: vi.fn().mockImplementation(async (_work: unknown) => {
				// Simulate internal work succeeding...
				// But during COMMIT, database triggers or deferred constraints fail
				throw new Error("Commit failed", {
					cause: {
						code: "P0001",
						message: "INTERNAL_COMMIT_SECRET_SENTINEL",
						detail: "Connection postgresql://fake-secret:5432 failed on commit",
					},
				});
			}),
		} as unknown as Database;

		try {
			await createCreditCardStatement({
				db: mockDb,
				userId,
				midasAccountId: "22222222-2222-4222-8222-222222222222",
				cardId: "33333333-3333-4333-8333-333333333333",
				cycleMonth: "2026-09",
				statementAmount: "5000.00",
				reservePlacement: "MIDAS_FUND",
				occurredAt: new Date("2026-09-01T10:00:00.000Z"),
				idempotencyKey: "stmt-commit-test-1",
			});
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			const ccErr = err as CreditCardError;
			expect(ccErr.code).toBe("CREDIT_CARD_INVALID_STATE");
			expect(ccErr.message).toBe("Credit card state transition failed");
			expect(ccErr.message).not.toContain("INTERNAL_COMMIT_SECRET_SENTINEL");
			expect(ccErr.message).not.toContain("postgresql://");
			expect(ccErr.message).not.toContain("fake-secret");
		}
	});

	it("runCreditCardTransaction accurately maps deferred unique constraint on COMMIT", async () => {
		const { createCreditCardStatement } = await import(
			"../src/credit-cards/service"
		);

		const mockDb = {
			transaction: vi.fn().mockImplementation(async () => {
				throw new Error("Deferred unique index violation on COMMIT", {
					cause: {
						code: "23505",
						constraint: "cc_statements_card_cycle_idx",
					},
				});
			}),
		} as unknown as Database;

		try {
			await createCreditCardStatement({
				db: mockDb,
				userId,
				midasAccountId: "22222222-2222-4222-8222-222222222222",
				cardId: "33333333-3333-4333-8333-333333333333",
				cycleMonth: "2026-09",
				statementAmount: "5000.00",
				reservePlacement: "MIDAS_FUND",
				occurredAt: new Date("2026-09-01T10:00:00.000Z"),
				idempotencyKey: "stmt-commit-unique-1",
			});
			expect.fail("should throw");
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(CreditCardError);
			const ccErr = err as CreditCardError;
			expect(ccErr.code).toBe("CREDIT_CARD_STATEMENT_PERIOD_CONFLICT");
			expect(ccErr.message).toBe("Statement cycle period conflict");
		}
	});

	it("runCreditCardTransaction propagates programmer TypeError directly without masking", async () => {
		const { createCreditCard } = await import("../src/credit-cards/service");

		const programmerErr = new TypeError("PROGRAMMER_BUG_SENTINEL");
		const mockDb = {
			transaction: vi.fn().mockImplementation(async () => {
				throw programmerErr;
			}),
		} as unknown as Database;

		await expect(
			createCreditCard({
				db: mockDb,
				userId,
				code: "TEST_PROG",
				displayName: "Test Card",
				issuer: "Test Bank",
				statementDay: 1,
				dueDay: 10,
				creditLimit: "1000.00",
				occurredAt: new Date(),
				idempotencyKey: "card-prog-1",
			}),
		).rejects.toThrow(programmerErr);
	});
});
