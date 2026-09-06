import { describe, expect, it, vi } from "vitest";
import type { DatabaseTransaction } from "../src/db/client";
import { computeEndpointHash } from "../src/notifications/calendar";
import { calculatePushSubscriptionRegisterFingerprint } from "../src/notifications/fingerprint";
import { registerPushSubscriptionInTransaction } from "../src/notifications/subscriptions";

const USER_ID = "019543ef-1111-7000-8000-000000000099";
const SUBSCRIPTION_ID = "019543ef-2222-7000-8000-000000000001";
const OCCURRED_AT = new Date("2026-03-10T09:00:00Z");
const IDEMPOTENCY_KEY = "shared-register-key";

const REGISTER_ARGS = {
	userId: USER_ID,
	endpoint: "https://fcm.example.test/synthetic/abc123",
	p256dh: "synthetic-p256dh-value",
	auth: "synthetic-auth-value",
	expirationTime: null,
	userAgent: null,
	occurredAt: OCCURRED_AT,
	idempotencyKey: IDEMPOTENCY_KEY,
};

/**
 * A mock `tx.select` whose first call resolves the early idempotency-key
 * lookup to `existingRev`, and (only reached on an exact-match replay) a
 * second call resolves the anchor row. Mirrors
 * `tests/month-close-historical-replay.test.ts::makeReplayDb`.
 */
function makeReplayTx(existingRev: unknown, includeAnchorLookup: boolean) {
	let select = vi.fn().mockReturnValueOnce({
		from: vi.fn().mockReturnValue({
			where: vi.fn().mockReturnValue({
				limit: vi.fn().mockResolvedValue([existingRev]),
			}),
		}),
	});
	if (includeAnchorLookup) {
		select = select.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					limit: vi
						.fn()
						.mockResolvedValue([
							{ id: SUBSCRIPTION_ID, userId: USER_ID, createdAt: new Date() },
						]),
				}),
			}),
		});
	}
	return { select } as unknown as DatabaseTransaction;
}

describe("registerPushSubscriptionInTransaction idempotency replay (Phase 15, Section 8)", () => {
	it("an exact-match REGISTER retry is accepted as a replay", async () => {
		const endpointHash = await computeEndpointHash(REGISTER_ARGS.endpoint);
		const fingerprint = await calculatePushSubscriptionRegisterFingerprint({
			userId: REGISTER_ARGS.userId,
			endpointHash,
			operation: "REGISTER",
			endpoint: REGISTER_ARGS.endpoint,
			p256dh: REGISTER_ARGS.p256dh,
			auth: REGISTER_ARGS.auth,
			expirationTime: REGISTER_ARGS.expirationTime,
			userAgent: REGISTER_ARGS.userAgent,
			occurredAt: REGISTER_ARGS.occurredAt,
		});
		const existingRev = {
			id: "rev-1",
			userId: USER_ID,
			subscriptionId: SUBSCRIPTION_ID,
			revisionNo: 1,
			operation: "REGISTER",
			status: "ACTIVE",
			endpoint: REGISTER_ARGS.endpoint,
			p256dh: REGISTER_ARGS.p256dh,
			auth: REGISTER_ARGS.auth,
			expirationTime: null,
			userAgent: null,
			idempotencyKey: IDEMPOTENCY_KEY,
			revisionFingerprint: fingerprint,
			createdAt: new Date(),
		};
		const tx = makeReplayTx(existingRev, true);

		const result = await registerPushSubscriptionInTransaction(
			tx,
			REGISTER_ARGS,
		);
		expect(result.idempotentReplay).toBe(true);
		expect(result.subscription.status).toBe("ACTIVE");
	});

	it("the same idempotency key used for a DISABLE is rejected as a conflict", async () => {
		const existingRev = {
			id: "rev-2",
			userId: USER_ID,
			subscriptionId: SUBSCRIPTION_ID,
			revisionNo: 2,
			operation: "DISABLE",
			status: "DISABLED",
			endpoint: REGISTER_ARGS.endpoint,
			p256dh: REGISTER_ARGS.p256dh,
			auth: REGISTER_ARGS.auth,
			expirationTime: null,
			userAgent: null,
			idempotencyKey: IDEMPOTENCY_KEY,
			revisionFingerprint: "b".repeat(64),
			createdAt: new Date(),
		};
		const tx = makeReplayTx(existingRev, false);

		await expect(
			registerPushSubscriptionInTransaction(tx, REGISTER_ARGS),
		).rejects.toMatchObject({ code: "NOTIFICATION_IDEMPOTENCY_CONFLICT" });
	});

	it("the same idempotency key reused with a different payload is rejected as a conflict", async () => {
		const existingRev = {
			id: "rev-1",
			userId: USER_ID,
			subscriptionId: SUBSCRIPTION_ID,
			revisionNo: 1,
			operation: "REGISTER",
			status: "ACTIVE",
			endpoint: REGISTER_ARGS.endpoint,
			p256dh: "a-completely-different-p256dh",
			auth: REGISTER_ARGS.auth,
			expirationTime: null,
			userAgent: null,
			idempotencyKey: IDEMPOTENCY_KEY,
			revisionFingerprint: "c".repeat(64),
			createdAt: new Date(),
		};
		const tx = makeReplayTx(existingRev, false);

		await expect(
			registerPushSubscriptionInTransaction(tx, REGISTER_ARGS),
		).rejects.toMatchObject({ code: "NOTIFICATION_IDEMPOTENCY_CONFLICT" });
	});
});
