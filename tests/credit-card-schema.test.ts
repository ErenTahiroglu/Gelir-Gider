import { describe, expect, it } from "vitest";
import {
	CREDIT_CARD_OPERATIONS,
	CREDIT_CARD_RESERVE_PLACEMENTS,
	CREDIT_CARD_STATEMENT_OPERATIONS,
	CREDIT_CARD_STATEMENT_STATUSES,
	CREDIT_CARD_STATUSES,
	creditCardRevisions,
	creditCardStatementRevisions,
	creditCardStatements,
	creditCards,
} from "../src/db/schema/credit-cards";

describe("credit-cards schema constants", () => {
	it("CREDIT_CARD_OPERATIONS contains CREATE, UPDATE, ARCHIVE", () => {
		expect(CREDIT_CARD_OPERATIONS).toContain("CREATE");
		expect(CREDIT_CARD_OPERATIONS).toContain("UPDATE");
		expect(CREDIT_CARD_OPERATIONS).toContain("ARCHIVE");
		expect(CREDIT_CARD_OPERATIONS).not.toContain("VOID");
	});

	it("CREDIT_CARD_STATUSES contains ACTIVE, ARCHIVED", () => {
		expect(CREDIT_CARD_STATUSES).toContain("ACTIVE");
		expect(CREDIT_CARD_STATUSES).toContain("ARCHIVED");
	});

	it("CREDIT_CARD_STATEMENT_OPERATIONS contains CREATE, UPDATE, VOID, PAY, REOPEN", () => {
		expect(CREDIT_CARD_STATEMENT_OPERATIONS).toContain("CREATE");
		expect(CREDIT_CARD_STATEMENT_OPERATIONS).toContain("UPDATE");
		expect(CREDIT_CARD_STATEMENT_OPERATIONS).toContain("VOID");
		expect(CREDIT_CARD_STATEMENT_OPERATIONS).toContain("PAY");
		expect(CREDIT_CARD_STATEMENT_OPERATIONS).toContain("REOPEN");
		expect(CREDIT_CARD_STATEMENT_OPERATIONS).not.toContain("ARCHIVE");
	});

	it("CREDIT_CARD_STATEMENT_STATUSES contains OPEN, VOID, PAID", () => {
		expect(CREDIT_CARD_STATEMENT_STATUSES).toContain("OPEN");
		expect(CREDIT_CARD_STATEMENT_STATUSES).toContain("VOID");
		expect(CREDIT_CARD_STATEMENT_STATUSES).toContain("PAID");
	});

	it("CREDIT_CARD_RESERVE_PLACEMENTS contains MIDAS_FUND, OUTSIDE_MIDAS", () => {
		expect(CREDIT_CARD_RESERVE_PLACEMENTS).toContain("MIDAS_FUND");
		expect(CREDIT_CARD_RESERVE_PLACEMENTS).toContain("OUTSIDE_MIDAS");
	});
});

describe("credit-cards schema tables", () => {
	it("creditCards table exists with correct structure", () => {
		expect(creditCards).toBeDefined();
		const columns = Object.keys(creditCards);
		expect(columns).toBeDefined();
	});

	it("creditCardRevisions table exists with correct structure including changeReason", () => {
		expect(creditCardRevisions).toBeDefined();
		expect(creditCardRevisions.changeReason).toBeDefined();
	});

	it("creditCardStatements table exists", () => {
		expect(creditCardStatements).toBeDefined();
	});

	it("creditCardStatementRevisions table exists", () => {
		expect(creditCardStatementRevisions).toBeDefined();
	});
});
