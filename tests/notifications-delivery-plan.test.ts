import { describe, expect, it } from "vitest";
import {
	type DeliveryAttemptHistory,
	MAX_DELIVERY_ATTEMPTS,
	planDeliveryAttempt,
} from "../src/notifications/delivery";

const FRESH: DeliveryAttemptHistory = {
	attemptCount: 0,
	lastAttemptStatus: null,
	hasSuccess: false,
};

describe("planDeliveryAttempt (Phase 15, Section 15-18/27/41 decision matrix)", () => {
	it("SENDs a brand-new delivery when the statement is OPEN and it's the same due day", () => {
		expect(
			planDeliveryAttempt({
				history: FRESH,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SEND");
	});

	it("SUPPRESS_OBSOLETEs a brand-new delivery when the statement is already PAID", () => {
		expect(
			planDeliveryAttempt({
				history: FRESH,
				currentStatementStatus: "PAID",
				isSameDueDay: true,
			}),
		).toBe("SUPPRESS_OBSOLETE");
	});

	it("SUPPRESS_OBSOLETEs when the statement is VOID", () => {
		expect(
			planDeliveryAttempt({
				history: FRESH,
				currentStatementStatus: "VOID",
				isSameDueDay: true,
			}),
		).toBe("SUPPRESS_OBSOLETE");
	});

	it("never resends once a SUCCESS attempt exists, regardless of statement status", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: 1,
			lastAttemptStatus: "SUCCESS",
			hasSuccess: true,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SKIP_DONE");
	});

	it("permits a retry after a RETRYABLE_FAILURE while the statement is still OPEN", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: 1,
			lastAttemptStatus: "RETRYABLE_FAILURE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SEND");
	});

	it("suppresses (does not call the transport for) a retry once the statement is no longer OPEN", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: 1,
			lastAttemptStatus: "RETRYABLE_FAILURE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "PAID",
				isSameDueDay: true,
			}),
		).toBe("SUPPRESS_OBSOLETE");
	});

	it("never attempts again after a TERMINAL_FAILURE", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: 1,
			lastAttemptStatus: "TERMINAL_FAILURE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SKIP_DONE");
	});

	it("never attempts again after a SUPPRESSED_OBSOLETE", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: 1,
			lastAttemptStatus: "SUPPRESSED_OBSOLETE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SKIP_DONE");
	});

	it(`never creates a 6th attempt (max is ${MAX_DELIVERY_ATTEMPTS})`, () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: MAX_DELIVERY_ATTEMPTS,
			lastAttemptStatus: "RETRYABLE_FAILURE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SKIP_MAX_ATTEMPTS");
	});

	it("permits exactly the 5th attempt (attemptCount=4 -> next is #5)", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: MAX_DELIVERY_ATTEMPTS - 1,
			lastAttemptStatus: "RETRYABLE_FAILURE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: true,
			}),
		).toBe("SEND");
	});

	it("never retries into the next calendar day", () => {
		const history: DeliveryAttemptHistory = {
			attemptCount: 1,
			lastAttemptStatus: "RETRYABLE_FAILURE",
			hasSuccess: false,
		};
		expect(
			planDeliveryAttempt({
				history,
				currentStatementStatus: "OPEN",
				isSameDueDay: false,
			}),
		).toBe("SKIP_NOT_SAME_DAY");
	});
});
