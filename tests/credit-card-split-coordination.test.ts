import { describe, expect, it } from "vitest";
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
