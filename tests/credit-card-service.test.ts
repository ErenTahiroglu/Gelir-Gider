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
import type { DatabaseTransaction } from "../src/db/client";

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
