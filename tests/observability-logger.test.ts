import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	logOperationalEvent,
	type OperationalEvent,
} from "../src/observability/logger";

describe("logOperationalEvent", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("routes 'info' events to console.log", () => {
		logOperationalEvent({
			level: "info",
			eventCode: "HTTP_REQUEST_COMPLETED",
			component: "http",
		});
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("routes 'warn' events to console.log", () => {
		logOperationalEvent({
			level: "warn",
			eventCode: "BACKUP_RETENTION_FAILED",
			component: "scheduled",
		});
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("routes 'error' events to console.error", () => {
		logOperationalEvent({
			level: "error",
			eventCode: "BACKUP_FAILED",
			component: "scheduled",
		});
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("serializes as a single JSON line containing the given fields", () => {
		logOperationalEvent({
			level: "info",
			eventCode: "HTTP_REQUEST_COMPLETED",
			component: "http",
			requestId: "req-1",
			durationMs: 42,
			statusCode: 200,
		});
		const line = logSpy.mock.calls[0]?.[0] as string;
		const parsed = JSON.parse(line);
		expect(parsed.eventCode).toBe("HTTP_REQUEST_COMPLETED");
		expect(parsed.requestId).toBe("req-1");
		expect(parsed.durationMs).toBe(42);
		expect(parsed.statusCode).toBe(200);
		expect(typeof parsed.timestamp).toBe("string");
	});

	it("auto-fills timestamp when omitted", () => {
		logOperationalEvent({
			level: "info",
			eventCode: "HTTP_REQUEST_COMPLETED",
			component: "http",
		});
		const line = logSpy.mock.calls[0]?.[0] as string;
		const parsed = JSON.parse(line);
		expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
	});

	it("preserves an explicitly provided timestamp instead of overwriting it", () => {
		const fixed = "2020-01-01T00:00:00.000Z";
		logOperationalEvent({
			level: "info",
			eventCode: "HTTP_REQUEST_COMPLETED",
			component: "http",
			timestamp: fixed,
		});
		const line = logSpy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line).timestamp).toBe(fixed);
	});

	it("never includes keys outside the narrow OperationalEvent shape, even when bypassed with `as unknown as OperationalEvent`", () => {
		const leaking = {
			level: "info",
			eventCode: "HTTP_REQUEST_COMPLETED",
			component: "http",
			// Deliberately smuggled extra field simulating a raw-object leak.
			rawError: { message: "do not leak me", stack: "at foo()" },
			requestBody: { secret: "s3cr3t" },
		} as unknown as OperationalEvent;

		logOperationalEvent(leaking);
		const line = logSpy.mock.calls[0]?.[0] as string;
		expect(line).not.toContain("do not leak me");
		expect(line).not.toContain("s3cr3t");
		const parsed = JSON.parse(line);
		expect(parsed).not.toHaveProperty("rawError");
		expect(parsed).not.toHaveProperty("requestBody");
	});

	it("counts is restricted to a flat Record<string, number> and is passed through as-is when well-formed", () => {
		logOperationalEvent({
			level: "info",
			eventCode: "SCHEDULED_NOTIFICATION_COMPLETED",
			component: "scheduled",
			counts: { eventsCreated: 3, deliveriesCreated: 5 },
		});
		const line = logSpy.mock.calls[0]?.[0] as string;
		const parsed = JSON.parse(line);
		expect(parsed.counts).toEqual({ eventsCreated: 3, deliveriesCreated: 5 });
	});
});
