import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { IncomeError } from "../src/income/errors";
import { LedgerError } from "../src/ledger/errors";
import {
	extractErrorCauseChain,
	isDatabaseBoundaryError,
	mapCanonicalError,
	mapDbError,
	mapIncomeError,
	mapLedgerError,
	runPeopleTransaction,
} from "../src/people/boundary";
import { PeopleError } from "../src/people/errors";
import { CanonicalTransactionError } from "../src/transactions/errors";

describe("mapLedgerError", () => {
	it("maps account-invalid ledger errors to PEOPLE_LEDGER_ACCOUNT_INVALID", () => {
		expect(() =>
			mapLedgerError(new LedgerError("LEDGER_ACCOUNT_NOT_FOUND", "x")),
		).toThrow(PeopleError);
		try {
			mapLedgerError(new LedgerError("LEDGER_ACCOUNT_ARCHIVED", "x"));
		} catch (e) {
			expect(e).toBeInstanceOf(PeopleError);
			expect((e as PeopleError).code).toBe("PEOPLE_LEDGER_ACCOUNT_INVALID");
		}
	});

	it("maps idempotency conflicts to PEOPLE_IDEMPOTENCY_CONFLICT", () => {
		try {
			mapLedgerError(new LedgerError("LEDGER_IDEMPOTENCY_CONFLICT", "x"));
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_IDEMPOTENCY_CONFLICT");
		}
	});

	it("maps invalid-entry errors to PEOPLE_INVALID_INPUT", () => {
		try {
			mapLedgerError(new LedgerError("LEDGER_INVALID_ENTRY", "x"));
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_INPUT");
		}
	});

	it("maps unrecognized ledger errors to PEOPLE_INVALID_STATE by default", () => {
		try {
			mapLedgerError(new LedgerError("LEDGER_UNBALANCED", "x"));
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_STATE");
		}
	});
});

describe("mapCanonicalError", () => {
	it("maps revision conflict to PEOPLE_OBLIGATION_REVISION_CONFLICT", () => {
		try {
			mapCanonicalError(
				new CanonicalTransactionError("TRANSACTION_REVISION_CONFLICT", "x"),
			);
		} catch (e) {
			expect((e as PeopleError).code).toBe(
				"PEOPLE_OBLIGATION_REVISION_CONFLICT",
			);
		}
	});

	it("maps idempotency conflict to PEOPLE_IDEMPOTENCY_CONFLICT", () => {
		try {
			mapCanonicalError(
				new CanonicalTransactionError("TRANSACTION_IDEMPOTENCY_CONFLICT", "x"),
			);
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_IDEMPOTENCY_CONFLICT");
		}
	});

	it("maps invalid input/not found to PEOPLE_INVALID_INPUT", () => {
		try {
			mapCanonicalError(
				new CanonicalTransactionError("TRANSACTION_NOT_FOUND", "x"),
			);
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_INPUT");
		}
	});
});

describe("mapIncomeError", () => {
	it("maps income idempotency conflict to PEOPLE_IDEMPOTENCY_CONFLICT", () => {
		try {
			mapIncomeError(new IncomeError("INCOME_IDEMPOTENCY_CONFLICT", "x"));
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_IDEMPOTENCY_CONFLICT");
		}
	});

	it("maps destination account invalid to PEOPLE_LEDGER_ACCOUNT_INVALID", () => {
		try {
			mapIncomeError(
				new IncomeError("INCOME_DESTINATION_ACCOUNT_INVALID", "x"),
			);
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_LEDGER_ACCOUNT_INVALID");
		}
	});

	it("maps unrecognized income errors to PEOPLE_INVALID_INPUT by default", () => {
		try {
			mapIncomeError(new IncomeError("INCOME_INVALID_INPUT", "x"));
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_INPUT");
		}
	});
});

describe("extractErrorCauseChain / isDatabaseBoundaryError", () => {
	it("extracts nested cause messages", () => {
		const inner = new Error("inner failure");
		const outer = new Error("outer failure", { cause: inner });
		const chain = extractErrorCauseChain(outer);
		expect(chain).toContain("outer failure");
		expect(chain).toContain("inner failure");
	});

	it("detects a raw postgres-shaped error as a database boundary error", () => {
		const pgLike = { code: "23505", message: "duplicate key value" };
		expect(isDatabaseBoundaryError(pgLike)).toBe(true);
	});

	it("does not classify a plain PeopleError as a database boundary error", () => {
		expect(
			isDatabaseBoundaryError(new PeopleError("PEOPLE_NOT_FOUND", "x")),
		).toBe(false);
	});
});

describe("mapDbError", () => {
	it("rethrows PeopleError unchanged", () => {
		const original = new PeopleError("PEOPLE_NOT_FOUND", "x");
		expect(() => mapDbError(original)).toThrow(original);
	});

	it("maps a recognized DB trigger rejection for obligation settlement limit", () => {
		const dbErr = {
			code: "P0001",
			message:
				'error: Cannot revise obligation "x" principal to 100.00 below active settled amount 200.00',
		};
		try {
			mapDbError(dbErr);
		} catch (e) {
			expect((e as PeopleError).code).toBe(
				"PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT",
			);
		}
	});

	it("maps a recognized DB trigger rejection for ledger reconciliation drift", () => {
		const dbErr = {
			code: "P0001",
			message:
				"error: Person x receivable ledger balance 5.00 does not reconcile with derived obligation remaining 0.00",
		};
		try {
			mapDbError(dbErr);
		} catch (e) {
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_STATE");
		}
	});

	it("maps overpayment receipt unique index collision to PEOPLE_INVALID_STATE", () => {
		const dbErr = {
			code: "23505",
			constraint: "person_settlement_revisions_overpayment_receipt_create_idx",
			message:
				'duplicate key value violates unique constraint "person_settlement_revisions_overpayment_receipt_create_idx"',
		};
		try {
			mapDbError(dbErr);
		} catch (e) {
			expect(e).toBeInstanceOf(PeopleError);
			expect((e as PeopleError).code).toBe("PEOPLE_INVALID_STATE");
			expect((e as PeopleError).message).not.toContain("23505");
			expect((e as PeopleError).message).not.toContain(
				"person_settlement_revisions_overpayment_receipt_create_idx",
			);
		}
	});

	it("rethrows programmer errors (e.g. TypeError) unchanged", () => {
		const bug = new TypeError("Cannot read properties of undefined");
		expect(() => mapDbError(bug)).toThrow(TypeError);
	});
});

describe("runPeopleTransaction", () => {
	it("rethrows PeopleError unchanged from the work callback", async () => {
		const mockDb = {
			transaction: vi.fn(async (work) => work({})),
		} as unknown as Database;

		await expect(
			runPeopleTransaction(mockDb, async () => {
				throw new PeopleError("PEOPLE_NOT_FOUND", "not found");
			}),
		).rejects.toThrow(PeopleError);
	});

	it("maps a LedgerError thrown from the work callback", async () => {
		const mockDb = {
			transaction: vi.fn(async (work) => work({})),
		} as unknown as Database;

		await expect(
			runPeopleTransaction(mockDb, async () => {
				throw new LedgerError("LEDGER_ACCOUNT_ARCHIVED", "archived");
			}),
		).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PeopleError && e.code === "PEOPLE_LEDGER_ACCOUNT_INVALID",
		);
	});

	it("does not leak raw LedgerError/CanonicalTransactionError/IncomeError at the boundary", async () => {
		const mockDb = {
			transaction: vi.fn(async (work) => work({})),
		} as unknown as Database;

		await expect(
			runPeopleTransaction(mockDb, async () => {
				throw new CanonicalTransactionError(
					"TRANSACTION_REVISION_CONFLICT",
					"x",
				);
			}),
		).rejects.not.toBeInstanceOf(CanonicalTransactionError);
	});
});
