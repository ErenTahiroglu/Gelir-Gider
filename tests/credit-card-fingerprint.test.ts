import { describe, expect, it } from "vitest";
import {
	calculateCreditCardArchiveFingerprint,
	calculateCreditCardCreateFingerprint,
	calculateCreditCardUpdateFingerprint,
	calculateStatementCreateFingerprint,
	calculateStatementUpdateFingerprint,
	calculateStatementVoidFingerprint,
	generateCardReserveMidasKey,
} from "../src/credit-cards/fingerprint";

const BASE_DATE = new Date("2026-09-04T10:00:00.000Z");

describe("calculateCreditCardCreateFingerprint", () => {
	it("returns 64-hex string", async () => {
		const fp = await calculateCreditCardCreateFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			code: "AKBANK",
			displayName: "Akbank Kredi Kartı",
			issuer: "Akbank",
			statementDay: 2,
			dueDay: 12,
			creditLimit: "150000.00",
			lastFour: "1234",
			note: null,
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic for same inputs", async () => {
		const params = {
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			code: "AKBANK",
			displayName: "Akbank",
			issuer: "Akbank",
			statementDay: 2,
			dueDay: 12,
			creditLimit: "150000.00",
			lastFour: null,
			note: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculateCreditCardCreateFingerprint(params);
		const fp2 = await calculateCreditCardCreateFingerprint(params);
		expect(fp1).toBe(fp2);
	});

	it("changes when code changes", async () => {
		const base = {
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			code: "AKBANK",
			displayName: "X",
			issuer: "X",
			statementDay: 2,
			dueDay: 12,
			creditLimit: "1.00",
			lastFour: null,
			note: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculateCreditCardCreateFingerprint(base);
		const fp2 = await calculateCreditCardCreateFingerprint({
			...base,
			code: "ZIRAAT",
		});
		expect(fp1).not.toBe(fp2);
	});
});

describe("calculateCreditCardUpdateFingerprint", () => {
	it("returns 64-hex string", async () => {
		const fp = await calculateCreditCardUpdateFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			cardId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
			expectedRevisionNo: 1,
			displayName: "Updated",
			issuer: "Bank",
			statementDay: 5,
			dueDay: 17,
			creditLimit: "50000.00",
			lastFour: null,
			note: null,
			changeReason: null,
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("calculateCreditCardArchiveFingerprint", () => {
	it("returns 64-hex string", async () => {
		const fp = await calculateCreditCardArchiveFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			cardId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
			expectedRevisionNo: 2,
			changeReason: "card closed",
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("calculateStatementCreateFingerprint", () => {
	it("returns 64-hex string", async () => {
		const fp = await calculateStatementCreateFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			cardId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
			cycleYear: 2026,
			cycleMonth: 9,
			statementAmount: "8000.00",
			reservePlacement: "MIDAS_FUND",
			note: null,
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when amount changes", async () => {
		const base = {
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			cardId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
			cycleYear: 2026,
			cycleMonth: 9,
			statementAmount: "8000.00",
			reservePlacement: "MIDAS_FUND",
			note: null,
			occurredAt: BASE_DATE,
		};
		const fp1 = await calculateStatementCreateFingerprint(base);
		const fp2 = await calculateStatementCreateFingerprint({
			...base,
			statementAmount: "9000.00",
		});
		expect(fp1).not.toBe(fp2);
	});
});

describe("calculateStatementUpdateFingerprint", () => {
	it("returns 64-hex string", async () => {
		const fp = await calculateStatementUpdateFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			statementId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
			expectedRevisionNo: 1,
			statementAmount: "9500.00",
			reservePlacement: "MIDAS_FUND",
			note: null,
			reasonNote: null,
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("calculateStatementVoidFingerprint", () => {
	it("returns 64-hex string", async () => {
		const fp = await calculateStatementVoidFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			statementId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
			expectedRevisionNo: 2,
			reasonNote: "entered wrong amount",
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("calculateLiabilityEventCreateFingerprint", () => {
	it("returns 64-hex string and includes installmentCount in v2", async () => {
		const {
			calculateLiabilityEventCreateFingerprint,
			calculateLiabilityEventCreateFingerprintV1,
		} = await import("../src/credit-cards/fingerprint");

		const fpV2 = await calculateLiabilityEventCreateFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			cardId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
			eventType: "PURCHASE",
			amount: "150.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros",
			description: "Groceries",
			installmentCount: 3,
			occurredAt: BASE_DATE,
		});
		expect(fpV2).toMatch(/^[0-9a-f]{64}$/);

		const fpV1 = await calculateLiabilityEventCreateFingerprintV1({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			cardId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
			eventType: "PURCHASE",
			amount: "150.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros",
			description: "Groceries",
			occurredAt: BASE_DATE,
		});
		expect(fpV1).toMatch(/^[0-9a-f]{64}$/);
		expect(fpV2).not.toBe(fpV1);
	});
});

describe("calculateLiabilityEventUpdateFingerprint", () => {
	it("returns 64-hex string and includes reasonNote and installmentCount in v2", async () => {
		const {
			calculateLiabilityEventUpdateFingerprint,
			calculateLiabilityEventUpdateFingerprintV1,
		} = await import("../src/credit-cards/fingerprint");

		const fpV2 = await calculateLiabilityEventUpdateFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			eventId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
			expectedRevisionNo: 1,
			amount: "200.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros",
			description: "Groceries updated",
			installmentCount: 6,
			reasonNote: "Price corrected",
			occurredAt: BASE_DATE,
		});
		expect(fpV2).toMatch(/^[0-9a-f]{64}$/);

		const fpV1 = await calculateLiabilityEventUpdateFingerprintV1({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			eventId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
			expectedRevisionNo: 1,
			amount: "200.00",
			purchaseCategory: "MANDATORY_EXPENSE",
			shortTermGoalId: null,
			merchant: "Migros",
			description: "Groceries updated",
			occurredAt: BASE_DATE,
		});
		expect(fpV1).toMatch(/^[0-9a-f]{64}$/);
		expect(fpV2).not.toBe(fpV1);
	});
});

describe("calculateLiabilityEventVoidFingerprint", () => {
	it("returns 64-hex string", async () => {
		const { calculateLiabilityEventVoidFingerprint } = await import(
			"../src/credit-cards/fingerprint"
		);

		const fp = await calculateLiabilityEventVoidFingerprint({
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			eventId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
			expectedRevisionNo: 2,
			reasonNote: "Duplicate entry",
			occurredAt: BASE_DATE,
		});
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("generateCardReserveMidasKey", () => {
	it("returns CARD_RESERVE_ prefixed 80-char key", async () => {
		const { generateCardReserveMidasKey } = await import(
			"../src/credit-cards/fingerprint"
		);
		const key = await generateCardReserveMidasKey(
			"test-key",
			"cccccccc-cccc-cccc-cccc-cccccccccccc",
			"CREATE",
		);
		expect(key).toMatch(/^CARD_RESERVE_[0-9a-f]{64}$/);
		expect(key.length).toBe(77); // "CARD_RESERVE_" (13) + 64
	});

	it("is bounded under 128 chars", async () => {
		const { generateCardReserveMidasKey } = await import(
			"../src/credit-cards/fingerprint"
		);
		const key = await generateCardReserveMidasKey(
			"a".repeat(128),
			"c".repeat(36),
			"n",
		);
		expect(key.length).toBeLessThanOrEqual(128);
	});

	it("is deterministic", async () => {
		const { generateCardReserveMidasKey } = await import(
			"../src/credit-cards/fingerprint"
		);
		const key1 = await generateCardReserveMidasKey("k", "id", "ns");
		const key2 = await generateCardReserveMidasKey("k", "id", "ns");
		expect(key1).toBe(key2);
	});
});
