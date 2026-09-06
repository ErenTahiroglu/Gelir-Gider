import { describe, expect, it } from "vitest";
import {
	calculatePushSubscriptionDisableFingerprint,
	calculatePushSubscriptionRegisterFingerprint,
	deriveNotificationChildIdempotencyKey,
} from "../src/notifications/fingerprint";

const USER_ID = "019543ef-1111-7000-8000-000000000099";
const OCCURRED_AT = new Date("2026-03-10T09:00:00Z");

describe("calculatePushSubscriptionRegisterFingerprint (Phase 15)", () => {
	const baseParams = {
		userId: USER_ID,
		endpointHash: "a".repeat(64),
		operation: "REGISTER" as const,
		endpoint: "https://fcm.example.test/synthetic/abc123",
		p256dh: "synthetic-p256dh-value",
		auth: "synthetic-auth-value",
		expirationTime: null,
		userAgent: null,
		occurredAt: OCCURRED_AT,
	};

	it("is deterministic for identical input", async () => {
		const a = await calculatePushSubscriptionRegisterFingerprint(baseParams);
		const b = await calculatePushSubscriptionRegisterFingerprint(baseParams);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when the operation changes (REGISTER vs REFRESH)", async () => {
		const a = await calculatePushSubscriptionRegisterFingerprint(baseParams);
		const b = await calculatePushSubscriptionRegisterFingerprint({
			...baseParams,
			operation: "REFRESH",
		});
		expect(a).not.toBe(b);
	});

	it("changes when p256dh changes", async () => {
		const a = await calculatePushSubscriptionRegisterFingerprint(baseParams);
		const b = await calculatePushSubscriptionRegisterFingerprint({
			...baseParams,
			p256dh: "different-p256dh-value",
		});
		expect(a).not.toBe(b);
	});

	it("changes when userId changes (case-insensitively normalized first)", async () => {
		const a = await calculatePushSubscriptionRegisterFingerprint(baseParams);
		const b = await calculatePushSubscriptionRegisterFingerprint({
			...baseParams,
			userId: "019543ef-2222-7000-8000-000000000099",
		});
		expect(a).not.toBe(b);
	});
});

describe("calculatePushSubscriptionDisableFingerprint (Phase 15)", () => {
	it("is deterministic and changes with disableReason", async () => {
		const params = {
			userId: USER_ID,
			subscriptionId: "019543ef-3333-7000-8000-000000000001",
			expectedRevisionNo: 2,
			disableReason: null,
			occurredAt: OCCURRED_AT,
		};
		const a = await calculatePushSubscriptionDisableFingerprint(params);
		const b = await calculatePushSubscriptionDisableFingerprint(params);
		expect(a).toBe(b);

		const c = await calculatePushSubscriptionDisableFingerprint({
			...params,
			disableReason: "PUSH_ENDPOINT_GONE",
		});
		expect(a).not.toBe(c);
	});
});

describe("deriveNotificationChildIdempotencyKey (Section 9)", () => {
	it("is deterministic given the same parent key and parts", async () => {
		const a = await deriveNotificationChildIdempotencyKey("parent-key", [
			"sub-1",
			"delivery-1",
			"1",
		]);
		const b = await deriveNotificationChildIdempotencyKey("parent-key", [
			"sub-1",
			"delivery-1",
			"1",
		]);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when any part changes", async () => {
		const a = await deriveNotificationChildIdempotencyKey("parent-key", [
			"sub-1",
			"delivery-1",
			"1",
		]);
		const b = await deriveNotificationChildIdempotencyKey("parent-key", [
			"sub-1",
			"delivery-1",
			"2",
		]);
		expect(a).not.toBe(b);
	});

	it("never exceeds the 128-char idempotency_key column bound", async () => {
		const key = await deriveNotificationChildIdempotencyKey("x".repeat(128), [
			"y".repeat(128),
			"z".repeat(128),
		]);
		expect(key.length).toBeLessThanOrEqual(128);
	});
});
