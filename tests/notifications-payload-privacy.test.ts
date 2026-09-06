import { describe, expect, it } from "vitest";
import { buildCreditCardDuePayload } from "../src/notifications/events";

const FORBIDDEN_SUBSTRINGS = [
	"statementAmount",
	"creditLimit",
	"liability",
	"balance",
	"family",
	"person",
	"income",
	"budget",
	"reward",
];

describe("CREDIT_CARD_DUE push payload privacy (Phase 15, Section 5/42)", () => {
	const payload = buildCreditCardDuePayload({
		statementId: "019543ef-4444-7000-8000-000000000001",
		creditCardId: "019543ef-5555-7000-8000-000000000001",
		dueDate: "2026-03-10",
	});
	const serialized = JSON.stringify(payload);

	it("contains only the minimal expected fields", () => {
		expect(payload.title).toBe("Kredi kartı son ödeme hatırlatması");
		expect(payload.body).toBe(
			"Bir kredi kartı ekstresinin son ödeme günü bugün. Ödeme durumunu kontrol et.",
		);
		expect(payload.data).toEqual({
			type: "CREDIT_CARD_DUE",
			statementId: "019543ef-4444-7000-8000-000000000001",
			creditCardId: "019543ef-5555-7000-8000-000000000001",
			dueDate: "2026-03-10",
			deepLink: "/credit-cards/statements/019543ef-4444-7000-8000-000000000001",
		});
	});

	it.each(FORBIDDEN_SUBSTRINGS)(
		"never mentions %s anywhere in the serialized payload",
		(forbidden) => {
			expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
		},
	);

	it("never includes a numeric money-shaped field", () => {
		const keys = Object.keys(payload.data);
		expect(keys.sort()).toEqual(
			["creditCardId", "deepLink", "dueDate", "statementId", "type"].sort(),
		);
	});
});
