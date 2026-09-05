import { describe, expect, it } from "vitest";
import { PeopleError, type PeopleErrorCode } from "../src/people/errors";

describe("PeopleError", () => {
	it("all documented error codes exist and instantiate correctly", () => {
		const codes: PeopleErrorCode[] = [
			"PEOPLE_INVALID_INPUT",
			"PEOPLE_NOT_FOUND",
			"PEOPLE_NOT_ACTIVE",
			"PEOPLE_REVISION_CONFLICT",
			"PEOPLE_OBLIGATION_NOT_FOUND",
			"PEOPLE_OBLIGATION_NOT_ACTIVE",
			"PEOPLE_OBLIGATION_REVISION_CONFLICT",
			"PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
			"PEOPLE_OBLIGATION_OVERSETTLEMENT",
			"PEOPLE_SETTLEMENT_NOT_FOUND",
			"PEOPLE_IDEMPOTENCY_CONFLICT",
			"PEOPLE_LEDGER_ACCOUNT_INVALID",
			"PEOPLE_INVALID_STATE",
		];

		for (const code of codes) {
			const err = new PeopleError(code, "test message");
			expect(err.code).toBe(code);
			expect(err.message).toBe("test message");
			expect(err.name).toBe("PeopleError");
			expect(err).toBeInstanceOf(PeopleError);
			expect(err).toBeInstanceOf(Error);
		}
	});
});
