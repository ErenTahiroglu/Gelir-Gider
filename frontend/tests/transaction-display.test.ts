import { describe, expect, it } from "vitest";
import { getTransactionDisplayModel } from "../src/lib/transaction-display";

describe("Heterogeneous Transaction Payload Safety — F3", () => {
	it("renders MANUAL_EXPENSE with merchant priority and negative expense tone", () => {
		const tx = {
			kind: "MANUAL_EXPENSE",
			status: "ACTIVE" as const,
			payload: {
				amount: "350.00",
				merchant: "Migros",
				description: "Market alışverişi",
				sourceAssetAccountId: "acc-123",
				spendingCategoryId: "cat-456",
				budgetCategory: "MANDATORY_EXPENSE",
			},
		};

		const display = getTransactionDisplayModel(tx);
		expect(display.title).toBe("Migros");
		expect(display.subtitle).toBe("Market alışverişi");
		expect(display.amountFormatted).toBe("-₺350,00");
		expect(display.amountTone).toBe("expense");
		expect(display.typeLabel).toBe("Nakit / Banka");
		expect(display.isVoided).toBe(false);
	});

	it("renders MANUAL_EXPENSE with description fallback when merchant is absent", () => {
		const tx = {
			kind: "MANUAL_EXPENSE",
			status: "ACTIVE" as const,
			payload: {
				amount: "90.00",
				description: "Kahve",
				sourceAssetAccountId: "acc-123",
			},
		};

		const display = getTransactionDisplayModel(tx);
		expect(display.title).toBe("Kahve");
		expect(display.subtitle).toBeUndefined();
		expect(display.amountFormatted).toBe("-₺90,00");
		expect(display.amountTone).toBe("expense");
	});

	it("renders VOIDED MANUAL_EXPENSE correctly with isVoided flag and negative amount preserved", () => {
		const tx = {
			kind: "MANUAL_EXPENSE",
			status: "VOIDED" as const,
			payload: {
				amount: "150.00",
				merchant: "Benzinlik",
			},
		};

		const display = getTransactionDisplayModel(tx);
		expect(display.isVoided).toBe(true);
		expect(display.amountFormatted).toBe("-₺150,00");
	});

	it("safely handles CREDIT_CARD_PURCHASE without inventing split or category", () => {
		const tx = {
			kind: "CREDIT_CARD_PURCHASE",
			status: "ACTIVE" as const,
			payload: {
				amount: "500.00",
				merchant: "Zara",
				cardId: "card-999",
			},
		};

		const display = getTransactionDisplayModel(tx);
		expect(display.title).toBe("Zara");
		expect(display.typeLabel).toBe("Kredi Kartı Harcaması");
		expect(display.amountFormatted).toBe("-₺500,00");
		expect(display.amountTone).toBe("expense");
	});

	it("handles completely unknown future kinds without crashing or guessing financial sign", () => {
		const tx = {
			kind: "FUTURE_CRYPTO_SETTLEMENT",
			status: "ACTIVE" as const,
			payload: {
				weirdField: 12345,
				nested: { something: true },
			},
		};

		const display = getTransactionDisplayModel(tx);
		expect(display.typeLabel).toBe("Diğer İşlem");
		expect(display.title).toBe("Diğer İşlem");
		expect(display.amountFormatted).toBeUndefined();
		expect(display.amountTone).toBe("neutral");
	});

	it("handles null or undefined payload safely", () => {
		const tx = {
			kind: "UNKNOWN_EMPTY",
			status: "ACTIVE" as const,
			payload: null,
		};

		const display = getTransactionDisplayModel(tx);
		expect(display.title).toBe("Diğer İşlem");
		expect(display.typeLabel).toBe("Diğer İşlem");
		expect(display.isVoided).toBe(false);
	});
});
