import { describe, expect, it } from "vitest";
import {
	formatIstanbulPurchaseDate,
	validateLiabilityEventStatusFilter,
	validatePaymentMethod,
	validatePurchaseCategory,
	validateStatementStatusFilter,
} from "../src/credit-cards/calendar";
import {
	CreditCardError,
	type CreditCardErrorCode,
} from "../src/credit-cards/errors";
import {
	calculateLiabilityEventCreateFingerprint,
	calculateLiabilityEventUpdateFingerprint,
	calculateLiabilityEventVoidFingerprint,
	calculateStatementPayFingerprint,
	calculateStatementReopenFingerprint,
	generateCreditCardLiabilityJournalKey,
	generateCreditCardPaymentJournalKey,
	generateCreditCardPaymentReopenJournalKey,
} from "../src/credit-cards/fingerprint";
import {
	CREDIT_CARD_LIABILITY_EVENT_OPERATIONS,
	CREDIT_CARD_LIABILITY_EVENT_TYPES,
	CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES,
	CREDIT_CARD_SYSTEM_ACCOUNT_ROLES,
	mapPurchaseCategoryToSystemRole,
} from "../src/db/schema/credit-card-ledger";

describe("Credit Card Ledger Schema & Constants", () => {
	it("all system account roles are defined", () => {
		expect(CREDIT_CARD_SYSTEM_ACCOUNT_ROLES).toContain("MANDATORY_EXPENSE");
		expect(CREDIT_CARD_SYSTEM_ACCOUNT_ROLES).toContain("DISCRETIONARY_EXPENSE");
		expect(CREDIT_CARD_SYSTEM_ACCOUNT_ROLES).toContain("SHORT_TERM_PURCHASE");
		expect(CREDIT_CARD_SYSTEM_ACCOUNT_ROLES).toContain("UNCLASSIFIED_EXPENSE");
		expect(CREDIT_CARD_SYSTEM_ACCOUNT_ROLES).toContain("OPENING_EQUITY");
	});

	it("all purchase budget categories are defined", () => {
		expect(CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES).toContain(
			"MANDATORY_EXPENSE",
		);
		expect(CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES).toContain(
			"DISCRETIONARY_SPEND",
		);
		expect(CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES).toContain(
			"SHORT_TERM_PURCHASE",
		);
		expect(CREDIT_CARD_PURCHASE_BUDGET_CATEGORIES).toContain("UNCLASSIFIED");
	});

	it("all liability event types and operations are defined", () => {
		expect(CREDIT_CARD_LIABILITY_EVENT_TYPES).toEqual([
			"PURCHASE",
			"OPENING_BALANCE",
		]);
		expect(CREDIT_CARD_LIABILITY_EVENT_OPERATIONS).toEqual([
			"CREATE",
			"UPDATE",
			"VOID",
		]);
	});

	it("mapPurchaseCategoryToSystemRole correctly maps categories to system account roles", () => {
		expect(mapPurchaseCategoryToSystemRole("MANDATORY_EXPENSE")).toBe(
			"MANDATORY_EXPENSE",
		);
		expect(mapPurchaseCategoryToSystemRole("DISCRETIONARY_SPEND")).toBe(
			"DISCRETIONARY_EXPENSE",
		);
		expect(mapPurchaseCategoryToSystemRole("SHORT_TERM_PURCHASE")).toBe(
			"SHORT_TERM_PURCHASE",
		);
		expect(mapPurchaseCategoryToSystemRole("UNCLASSIFIED")).toBe(
			"UNCLASSIFIED_EXPENSE",
		);
	});
});

describe("Credit Card Phase 10B Error Codes", () => {
	it("all Phase 10B error codes exist and instantiate correctly", () => {
		const codes: CreditCardErrorCode[] = [
			"CREDIT_CARD_PURCHASE_NOT_FOUND",
			"CREDIT_CARD_PURCHASE_NOT_ACTIVE",
			"CREDIT_CARD_OPENING_BALANCE_CONFLICT",
			"CREDIT_CARD_LEDGER_ACCOUNT_INVALID",
			"CREDIT_CARD_LIABILITY_SHORTFALL",
			"CREDIT_CARD_PAYMENT_NOT_FOUND",
			"CREDIT_CARD_PAYMENT_CONFLICT",
			"CREDIT_CARD_STATEMENT_ALREADY_PAID",
			"CREDIT_CARD_STATEMENT_NOT_PAID",
			"CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY",
			"CREDIT_CARD_LEDGER_LINK_NOT_FOUND",
			"CREDIT_CARD_SYSTEM_ACCOUNT_NOT_FOUND",
		];

		for (const code of codes) {
			const err = new CreditCardError(code, "test message");
			expect(err.code).toBe(code);
			expect(err.name).toBe("CreditCardError");
		}
	});
});

describe("Credit Card Fingerprinting & Key Generation", () => {
	it("deterministic SHA-256 fingerprinting for liability event CREATE", async () => {
		const fp1 = await calculateLiabilityEventCreateFingerprint({
			userId: "11111111-1111-1111-1111-111111111111",
			cardId: "22222222-2222-2222-2222-222222222222",
			eventType: "PURCHASE",
			amount: "150.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros",
			description: "Groceries",
			occurredAt: new Date("2026-09-04T12:00:00Z"),
		});

		const fp2 = await calculateLiabilityEventCreateFingerprint({
			userId: "11111111-1111-1111-1111-111111111111",
			cardId: "22222222-2222-2222-2222-222222222222",
			eventType: "PURCHASE",
			amount: "150.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros",
			description: "Groceries",
			occurredAt: new Date("2026-09-04T12:00:00Z"),
		});

		expect(fp1).toMatch(/^[0-9a-f]{64}$/);
		expect(fp1).toBe(fp2);

		const updFp = await calculateLiabilityEventUpdateFingerprint({
			userId: "11111111-1111-1111-1111-111111111111",
			eventId: "22222222-2222-2222-2222-222222222222",
			expectedRevisionNo: 1,
			amount: "200.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros Upd",
			description: "Groceries Upd",
			occurredAt: new Date("2026-09-04T12:00:00Z"),
		});
		expect(updFp).toMatch(/^[0-9a-f]{64}$/);

		const voidFp = await calculateLiabilityEventVoidFingerprint({
			userId: "11111111-1111-1111-1111-111111111111",
			eventId: "22222222-2222-2222-2222-222222222222",
			expectedRevisionNo: 2,
			reasonNote: "Void reason",
			occurredAt: new Date("2026-09-04T12:00:00Z"),
		});
		expect(voidFp).toMatch(/^[0-9a-f]{64}$/);
	});

	it("deterministic fingerprinting for statement PAY and REOPEN", async () => {
		const payFp = await calculateStatementPayFingerprint({
			userId: "11111111-1111-1111-1111-111111111111",
			statementId: "33333333-3333-3333-3333-333333333333",
			expectedRevisionNo: 1,
			paymentAmount: "5000.00",
			paymentMethod: "MIDAS_FUND",
			assetAccountId: "44444444-4444-4444-4444-444444444444",
			occurredAt: new Date("2026-09-04T12:00:00Z"),
		});

		const reopenFp = await calculateStatementReopenFingerprint({
			userId: "11111111-1111-1111-1111-111111111111",
			statementId: "33333333-3333-3333-3333-333333333333",
			expectedRevisionNo: 2,
			reasonNote: "Payment error correction",
			occurredAt: new Date("2026-09-04T12:00:00Z"),
		});

		expect(payFp).toMatch(/^[0-9a-f]{64}$/);
		expect(reopenFp).toMatch(/^[0-9a-f]{64}$/);
		expect(payFp).not.toBe(reopenFp);
	});

	it("generates deterministic prefixed keys", async () => {
		const liabilityKey = await generateCreditCardLiabilityJournalKey(
			"key1",
			"event-id-1",
			1,
		);
		const paymentKey = await generateCreditCardPaymentJournalKey(
			"key1",
			"stmt-id-1",
			"MIDAS_FUND",
		);
		const reopenKey = await generateCreditCardPaymentReopenJournalKey(
			"key1",
			"stmt-id-1",
			"pay-event-id-1",
		);

		expect(liabilityKey).toMatch(/^CC_LIABILITY_[0-9a-f]{64}$/);
		expect(paymentKey).toMatch(/^CC_PAYMENT_[0-9a-f]{64}$/);
		expect(reopenKey).toMatch(/^CC_REOPEN_[0-9a-f]{64}$/);
	});
});

describe("Calendar & Validation Helpers", () => {
	it("formatIstanbulPurchaseDate formats date in Europe/Istanbul timezone", () => {
		// 2026-09-04 22:00:00 UTC is 2026-09-05 01:00:00 UTC+3
		const d = new Date("2026-09-04T22:00:00Z");
		expect(formatIstanbulPurchaseDate(d)).toBe("2026-09-05");

		const d2 = new Date("2026-09-04T10:00:00Z");
		expect(formatIstanbulPurchaseDate(d2)).toBe("2026-09-04");
	});

	it("validatePurchaseCategory validates category inputs", () => {
		expect(validatePurchaseCategory("MANDATORY")).toBe("MANDATORY");
		expect(validatePurchaseCategory("DISCRETIONARY")).toBe("DISCRETIONARY");
		expect(validatePurchaseCategory("SHORT_TERM_PURCHASE")).toBe(
			"SHORT_TERM_PURCHASE",
		);
		expect(validatePurchaseCategory("UNCLASSIFIED")).toBe("UNCLASSIFIED");
		expect(() => validatePurchaseCategory("INVALID")).toThrow(CreditCardError);
	});

	it("validatePaymentMethod validates method inputs", () => {
		expect(validatePaymentMethod("MIDAS_FUND")).toBe("MIDAS_FUND");
		expect(validatePaymentMethod("OUTSIDE_MIDAS")).toBe("OUTSIDE_MIDAS");
		expect(() => validatePaymentMethod("CRYPTO")).toThrow(CreditCardError);
	});

	it("validateStatementStatusFilter accepts PAID", () => {
		expect(validateStatementStatusFilter("OPEN")).toBe("OPEN");
		expect(validateStatementStatusFilter("VOID")).toBe("VOID");
		expect(validateStatementStatusFilter("PAID")).toBe("PAID");
		expect(validateStatementStatusFilter(undefined)).toBeUndefined();
		expect(() => validateStatementStatusFilter("OTHER")).toThrow(
			CreditCardError,
		);
	});

	it("validateLiabilityEventStatusFilter validates status", () => {
		expect(validateLiabilityEventStatusFilter("POSTED")).toBe("POSTED");
		expect(validateLiabilityEventStatusFilter("VOID")).toBe("VOID");
		expect(validateLiabilityEventStatusFilter(undefined)).toBeUndefined();
		expect(() => validateLiabilityEventStatusFilter("UNKNOWN")).toThrow(
			CreditCardError,
		);
	});
});
