import { describe, expect, it, vi } from "vitest";
import {
	MAX_DISPATCH_ATTEMPTS,
	toAttemptHistory,
	truncateToSchedulerHourSlot,
} from "../src/notifications/delivery";
import { NotificationError } from "../src/notifications/errors";
import { ensurePushTransportPrepared } from "../src/notifications/scheduler";
import type { PushTransport } from "../src/notifications/web-push";

describe("truncateToSchedulerHourSlot (Phase 15-R1 Section A)", () => {
	it("truncates down to the start of the current UTC hour", () => {
		expect(
			truncateToSchedulerHourSlot(new Date("2026-03-10T09:37:42.123Z")),
		).toEqual(new Date("2026-03-10T09:00:00.000Z"));
	});

	it("is idempotent on an exact hour boundary", () => {
		const exact = new Date("2026-03-10T12:00:00.000Z");
		expect(truncateToSchedulerHourSlot(exact)).toEqual(exact);
	});

	it("produces distinct slots for consecutive hourly cron ticks", () => {
		const slotA = truncateToSchedulerHourSlot(new Date("2026-03-10T12:05:00Z"));
		const slotB = truncateToSchedulerHourSlot(new Date("2026-03-10T13:05:00Z"));
		expect(slotA.getTime()).not.toBe(slotB.getTime());
	});

	it("produces the SAME slot for two 'concurrent' invocations sharing the same hourly tick", () => {
		// This is the DB-less-provable half of the concurrency story: two
		// scheduler invocations for what is logically the same hourly cron
		// tick (e.g. `controller.scheduledTime` a few seconds apart, or a
		// slow-running previous tick still active when the next one fires)
		// always compute the identical scheduler_hour_slot value. The other
		// half -- that the DB's UNIQUE(delivery_id, scheduler_hour_slot)
		// constraint then makes a second reservation attempt for that slot a
		// guaranteed no-op -- requires a real Postgres instance to prove
		// (see the final report's live-DB checklist); it cannot be proven
		// DB-lessly because this codebase's transactions are real
		// `db.transaction()` calls, not an injectable in-memory repository.
		const slotA = truncateToSchedulerHourSlot(new Date("2026-03-10T12:00:03Z"));
		const slotB = truncateToSchedulerHourSlot(new Date("2026-03-10T12:00:57Z"));
		expect(slotA.getTime()).toBe(slotB.getTime());
	});
});

describe("toAttemptHistory (Phase 15-R1 Section A)", () => {
	it("projects a DeliveryHistory down to the fields planDeliveryAttempt needs", () => {
		expect(
			toAttemptHistory({
				attemptCount: 2,
				lastAttemptStatus: "RETRYABLE_FAILURE",
				hasSuccess: false,
				dispatchCount: 2,
				unresolvedDispatches: [],
			}),
		).toEqual({
			attemptCount: 2,
			lastAttemptStatus: "RETRYABLE_FAILURE",
			hasSuccess: false,
		});
	});
});

describe("MAX_DISPATCH_ATTEMPTS", () => {
	it("mirrors MAX_DELIVERY_ATTEMPTS (5)", () => {
		expect(MAX_DISPATCH_ATTEMPTS).toBe(5);
	});
});

describe("ensurePushTransportPrepared (Phase 15-R2 Section C)", () => {
	function fakeTransport(prepareImpl?: () => Promise<void>): PushTransport {
		return {
			send: vi.fn(),
			prepare: prepareImpl ? vi.fn(prepareImpl) : vi.fn(async () => {}),
		};
	}

	it("calls transport.prepare() exactly once even across multiple invocations sharing the same state object", async () => {
		const transport = fakeTransport();
		const state = { prepared: false };
		await ensurePushTransportPrepared(transport, state);
		await ensurePushTransportPrepared(transport, state);
		await ensurePushTransportPrepared(transport, state);
		expect(transport.prepare).toHaveBeenCalledTimes(1);
		expect(state.prepared).toBe(true);
	});

	it("is a no-op (does not call prepare again) once state.prepared is already true", async () => {
		const transport = fakeTransport();
		const state = { prepared: true };
		await ensurePushTransportPrepared(transport, state);
		expect(transport.prepare).not.toHaveBeenCalled();
	});

	it("does nothing (and does not throw) when the transport has no prepare() method", async () => {
		const transport: PushTransport = { send: vi.fn() };
		const state = { prepared: false };
		await expect(
			ensurePushTransportPrepared(transport, state),
		).resolves.toBeUndefined();
		expect(state.prepared).toBe(true);
	});

	it("propagates a NotificationError thrown by prepare() unchanged", async () => {
		const transport = fakeTransport(async () => {
			throw new NotificationError(
				"NOTIFICATION_PUSH_CONFIG_INVALID",
				"bad vapid config",
			);
		});
		const state = { prepared: false };
		await expect(
			ensurePushTransportPrepared(transport, state),
		).rejects.toMatchObject({
			code: "NOTIFICATION_PUSH_CONFIG_INVALID",
			message: "bad vapid config",
		});
		expect(state.prepared).toBe(false);
	});

	it("wraps a non-NotificationError thrown by prepare() into a sanitized NOTIFICATION_PUSH_CONFIG_INVALID", async () => {
		const transport = fakeTransport(async () => {
			throw new Error("raw crypto explosion with sensitive details");
		});
		const state = { prepared: false };
		await expect(
			ensurePushTransportPrepared(transport, state),
		).rejects.toMatchObject({ code: "NOTIFICATION_PUSH_CONFIG_INVALID" });
		expect(state.prepared).toBe(false);
	});
});
