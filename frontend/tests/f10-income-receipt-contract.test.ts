import { describe, expect, it, vi } from "vitest";
import * as clientModule from "../src/api/client";
import { fetchIncomeReceipts } from "../src/api/income-api";
import { getIstanbulMonthStartUtcInstant } from "../src/lib/istanbul-date";

describe("Income Receipt Date Filter Contract (Targeted Blocker B)", () => {
	it("derives canonical UTC ISO instant for start of month according to Europe/Istanbul boundary", () => {
		// In Europe/Istanbul (UTC+3 year-round):
		// 2026-10-01 00:00:00+03:00 is 2026-09-30T21:00:00.000Z in UTC.
		const instantOct2026 = getIstanbulMonthStartUtcInstant("2026-10");
		expect(instantOct2026).toBe("2026-09-30T21:00:00.000Z");

		// 2026-01-01 00:00:00+03:00 is 2025-12-31T21:00:00.000Z in UTC.
		const instantJan2026 = getIstanbulMonthStartUtcInstant("2026-01");
		expect(instantJan2026).toBe("2025-12-31T21:00:00.000Z");

		// Must NOT be simple UTC midnight
		expect(instantOct2026).not.toBe("2026-10-01T00:00:00.000Z");
		// Must NOT be calendar date
		expect(instantOct2026).not.toBe("2026-10-01");
	});

	it("fetchIncomeReceipts sends canonical UTC ISO instant query parameters", async () => {
		const apiGetSpy = vi.spyOn(clientModule, "apiGet").mockResolvedValueOnce({
			receipts: [],
			hasMore: false,
		});

		const fromInstant = getIstanbulMonthStartUtcInstant("2026-10");
		const toInstant = "2026-10-31T20:59:59.999Z";

		await fetchIncomeReceipts({
			from: fromInstant,
			to: toInstant,
			limit: 50,
		});

		expect(apiGetSpy).toHaveBeenCalledTimes(1);
		const requestedPath = (apiGetSpy.mock.calls[0] as [string])[0];

		// Must contain URL-encoded or raw ISO strings
		expect(requestedPath).toContain("from=2026-09-30T21%3A00%3A00.000Z");
		expect(requestedPath).toContain("to=2026-10-31T20%3A59%3A59.999Z");
		expect(requestedPath).not.toContain("from=2026-10-01");

		apiGetSpy.mockRestore();
	});

	it("verifies contract: calendar date YYYY-MM-DD violates canonical instant requirement", () => {
		// The backend requires parseCanonicalInstant which enforces ISO 8601 with timezone/Z
		const CANONICAL_INSTANT_REGEX =
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

		// Calendar date fails backend parser
		expect(CANONICAL_INSTANT_REGEX.test("2026-10-01")).toBe(false);

		// Output of getIstanbulMonthStartUtcInstant satisfies backend parser
		const validInstant = getIstanbulMonthStartUtcInstant("2026-10");
		expect(CANONICAL_INSTANT_REGEX.test(validInstant)).toBe(true);
	});
});
