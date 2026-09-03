import { describe, expect, it } from "vitest";
import { BudgetError } from "../src/budget/errors";
import {
	allocatePersonalBudgetV1,
	PERSONAL_BUDGET_V1,
} from "../src/budget/policy";

describe("PERSONAL_BUDGET_V1 Policy Allocator", () => {
	it("handles zero reference income (0.00)", () => {
		const res = allocatePersonalBudgetV1("0.00");

		expect(res.policyVersion).toBe(PERSONAL_BUDGET_V1);
		expect(res.referenceIncome).toBe("0.00");
		expect(res.referenceIncomeCents).toBe(0n);
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("0.00");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("0.00");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("0.00");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("0.00");
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("0.00");
	});

	it("allocates 0.01 reference income with residual cent to LONG_TERM_INVESTMENT", () => {
		const res = allocatePersonalBudgetV1("0.01");

		expect(res.referenceIncome).toBe("0.01");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("0.00");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("0.00");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("0.00");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("0.00");
		// 1 cent - 0 - 0 - 0 - 0 = 1 cent
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("0.01");
		expect(res.allocations.LONG_TERM_INVESTMENT.cents).toBe(1n);

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(1n);
	});

	it("allocates 0.02 reference income with residual cents to LONG_TERM_INVESTMENT", () => {
		const res = allocatePersonalBudgetV1("0.02");

		// total = 2 cents
		// mandatory = floor(2 * 6500 / 10000) = 1 cent (0.01)
		// discretionary = floor(2 * 500 / 10000) = 0 cents (0.00)
		// short = floor(2 * 1000 / 10000) = 0 cents (0.00)
		// medium = floor(2 * 1000 / 10000) = 0 cents (0.00)
		// long = 2 - 1 - 0 - 0 - 0 = 1 cent (0.01)
		expect(res.referenceIncome).toBe("0.02");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("0.01");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("0.00");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("0.00");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("0.00");
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("0.01");
		expect(res.allocations.LONG_TERM_INVESTMENT.cents).toBe(1n);

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(2n);
	});

	it("allocates 1.00 reference income exactly", () => {
		const res = allocatePersonalBudgetV1("1.00");

		expect(res.referenceIncome).toBe("1.00");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("0.65");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("0.05");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("0.10");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("0.10");
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("0.10");

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(100n);
	});

	it("allocates 100.01 reference income with exact residual allocation", () => {
		const res = allocatePersonalBudgetV1("100.01");

		// total = 10001 cents
		// mandatory = floor(10001 * 6500 / 10000) = 6500 cents (65.00)
		// discretionary = floor(10001 * 500 / 10000) = 500 cents (5.00)
		// short = floor(10001 * 1000 / 10000) = 1000 cents (10.00)
		// medium = floor(10001 * 1000 / 10000) = 1000 cents (10.00)
		// long = 10001 - 6500 - 500 - 1000 - 1000 = 1001 cents (10.01)
		expect(res.referenceIncome).toBe("100.01");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("65.00");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("5.00");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("10.00");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("10.00");
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("10.01");

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(10001n);
	});

	it("allocates 1234.57 reference income exactly to the kuruş", () => {
		const res = allocatePersonalBudgetV1("1234.57");

		// total = 123457 cents
		// mandatory = floor(123457 * 6500 / 10000) = floor(802470500 / 10000) = 80247 cents (802.47)
		// discretionary = floor(123457 * 500 / 10000) = floor(61728500 / 10000) = 6172 cents (61.72)
		// short = floor(123457 * 1000 / 10000) = floor(123457000 / 10000) = 12345 cents (123.45)
		// medium = floor(123457 * 1000 / 10000) = 12345 cents (123.45)
		// long = 123457 - 80247 - 6172 - 12345 - 12345 = 12348 cents (123.48)
		expect(res.referenceIncome).toBe("1234.57");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("802.47");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("61.72");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("123.45");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("123.45");
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("123.48");

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(123457n);
	});

	it("allocates 11250.00 reference income matching specification example", () => {
		const res = allocatePersonalBudgetV1("11250.00");

		expect(res.referenceIncome).toBe("11250.00");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe("7312.50");
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe("562.50");
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe("1125.00");
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe("1125.00");
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe("1125.00");

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(1125000n);
	});

	it("allocates max valid NUMERIC(18,2) reference income 9999999999999999.99 without bigint overflow", () => {
		const res = allocatePersonalBudgetV1("9999999999999999.99");

		// total cents = 999999999999999999n
		// mandatory = floor(999999999999999999 * 6500 / 10000) = 649999999999999999 cents (6499999999999999.99)
		// discretionary = floor(999999999999999999 * 500 / 10000) = 49999999999999999 cents (499999999999999.99)
		// short = floor(999999999999999999 * 1000 / 10000) = 99999999999999999 cents (999999999999999.99)
		// medium = floor(999999999999999999 * 1000 / 10000) = 99999999999999999 cents (999999999999999.99)
		// long = 999999999999999999 - 649999999999999999 - 49999999999999999 - 99999999999999999 - 99999999999999999
		//      = 100000000000000003 cents (1000000000000000.03)
		expect(res.referenceIncome).toBe("9999999999999999.99");
		expect(res.allocations.MANDATORY_EXPENSE.amount).toBe(
			"6499999999999999.99",
		);
		expect(res.allocations.DISCRETIONARY_SPEND.amount).toBe(
			"499999999999999.99",
		);
		expect(res.allocations.SHORT_TERM_PURCHASE.amount).toBe(
			"999999999999999.99",
		);
		expect(res.allocations.MEDIUM_TERM_RESERVE.amount).toBe(
			"999999999999999.99",
		);
		expect(res.allocations.LONG_TERM_INVESTMENT.amount).toBe(
			"1000000000000000.03",
		);

		const sumCents =
			res.allocations.MANDATORY_EXPENSE.cents +
			res.allocations.DISCRETIONARY_SPEND.cents +
			res.allocations.SHORT_TERM_PURCHASE.cents +
			res.allocations.MEDIUM_TERM_RESERVE.cents +
			res.allocations.LONG_TERM_INVESTMENT.cents;
		expect(sumCents).toBe(999999999999999999n);
	});

	it("rejects negative or malformed reference income strings", () => {
		expect(() => allocatePersonalBudgetV1("-100.00")).toThrowError(BudgetError);
		expect(() => allocatePersonalBudgetV1("abc")).toThrowError(BudgetError);
		expect(() => allocatePersonalBudgetV1("10.000")).toThrowError(BudgetError);
	});
});
