import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { users } from "../src/db/schema/auth";
import { incomeSources } from "../src/db/schema/income";
import { getMonthlyReferenceIncome } from "../src/income/reference";

/**
 * Proves the 2745/3000 overpayment scenario's reference-income invariant (spec section 55):
 * a People overpayment excess is recorded as an actual EXTRA income receipt, but because its
 * system-provisioned income source always carries referenceMethod=EXCLUDED, the reference-income
 * engine forces its contribution to "0.00" regardless of amount -- so reference income is
 * unaffected by any 255-style overpayment receipt.
 */
function buildMockDb(sources: (typeof incomeSources.$inferSelect)[]): Database {
	return {
		select: vi.fn().mockImplementation((_cols?: unknown) => ({
			from: vi.fn().mockImplementation((table: unknown) => ({
				where: vi.fn().mockImplementation(() => ({
					limit: vi.fn().mockImplementation(() => {
						if (table === users) {
							return Promise.resolve([{ currency: "TRY" }]);
						}
						return Promise.resolve([]);
					}),
					orderBy: vi.fn().mockImplementation(() => {
						if (table === incomeSources) {
							return Promise.resolve(sources);
						}
						return Promise.resolve([]);
					}),
				})),
			})),
		})),
	} as unknown as Database;
}

const REGULAR_SOURCE = {
	id: "src-regular",
	userId: "user-1",
	code: "SALARY",
	name: "Salary",
	nature: "REGULAR",
	referenceMethod: "FIXED_MONTHLY",
	expectedMonthlyAmount: "50000.00",
	seasonalMonthsPerYear: null,
	rollingMedianMonths: null,
	incomeLedgerAccountId: "acct-income-1",
	activeFrom: "2020-01-01",
	activeUntil: null,
	createdAt: new Date("2020-01-01T00:00:00.000Z"),
	archivedAt: null,
} as unknown as typeof incomeSources.$inferSelect;

const PEOPLE_OVERPAYMENT_SOURCE = {
	id: "src-overpayment",
	userId: "user-1",
	code: "PEOPLE_OVERPAYMENT",
	name: "People settlement overpayment",
	nature: "EXTRA",
	referenceMethod: "EXCLUDED",
	// Even if this were non-null and large, EXCLUDED forces refAmount to "0.00".
	expectedMonthlyAmount: "255.00",
	seasonalMonthsPerYear: null,
	rollingMedianMonths: null,
	incomeLedgerAccountId: "acct-income-2",
	activeFrom: "1900-01-01",
	activeUntil: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	archivedAt: null,
} as unknown as typeof incomeSources.$inferSelect;

describe("Reference income exclusion (People overpayment proof)", () => {
	it("computes reference income from only the REGULAR source before the overpayment source exists", async () => {
		const db = buildMockDb([REGULAR_SOURCE]);
		const result = await getMonthlyReferenceIncome({
			db,
			userId: "user-1",
			asOf: "2026-09-05",
		});
		expect(result.total).toBe("50000.00");
	});

	it("remains unchanged after the EXTRA/EXCLUDED People overpayment source is added", async () => {
		const db = buildMockDb([REGULAR_SOURCE, PEOPLE_OVERPAYMENT_SOURCE]);
		const result = await getMonthlyReferenceIncome({
			db,
			userId: "user-1",
			asOf: "2026-09-05",
		});

		expect(result.total).toBe("50000.00");

		const overpaymentEntry = result.sources.find(
			(s) => s.code === "PEOPLE_OVERPAYMENT",
		);
		expect(overpaymentEntry).toBeDefined();
		expect(overpaymentEntry?.nature).toBe("EXTRA");
		expect(overpaymentEntry?.referenceMethod).toBe("EXCLUDED");
		expect(overpaymentEntry?.referenceAmount).toBe("0.00");
	});
});
