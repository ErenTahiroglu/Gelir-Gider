import { describe, expect, it } from "vitest";
import {
	calculateLongTermTaskCreateFingerprint,
	calculateLongTermTaskLifecycleFingerprint,
	deriveLongTermChildIdempotencyKey,
} from "../src/long-term/fingerprint";

const BASE_CREATE = {
	userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	midasAccountId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
	amount: "100.00",
	destinationLabel: "Sentinax Brokerage",
	note: "Q1 contribution",
	occurredAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("calculateLongTermTaskCreateFingerprint", () => {
	it("produces the identical fingerprint for the exact same payload (stable replay)", async () => {
		const a = await calculateLongTermTaskCreateFingerprint(BASE_CREATE);
		const b = await calculateLongTermTaskCreateFingerprint({ ...BASE_CREATE });
		expect(a).toBe(b);
	});

	it("produces a different fingerprint when amount changes", async () => {
		const a = await calculateLongTermTaskCreateFingerprint(BASE_CREATE);
		const b = await calculateLongTermTaskCreateFingerprint({
			...BASE_CREATE,
			amount: "200.00",
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint when destinationLabel changes", async () => {
		const a = await calculateLongTermTaskCreateFingerprint(BASE_CREATE);
		const b = await calculateLongTermTaskCreateFingerprint({
			...BASE_CREATE,
			destinationLabel: "Foneria Brokerage",
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint when note changes", async () => {
		const a = await calculateLongTermTaskCreateFingerprint(BASE_CREATE);
		const b = await calculateLongTermTaskCreateFingerprint({
			...BASE_CREATE,
			note: "different note",
		});
		expect(a).not.toBe(b);
	});
});

describe("calculateLongTermTaskLifecycleFingerprint", () => {
	const base = {
		userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		taskId: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
		operation: "SENT" as const,
		expectedRevisionNo: 1,
		occurredAt: new Date("2026-01-02T00:00:00.000Z"),
		reasonNote: null,
	};

	it("produces the identical fingerprint for the exact same payload", async () => {
		const a = await calculateLongTermTaskLifecycleFingerprint(base);
		const b = await calculateLongTermTaskLifecycleFingerprint({ ...base });
		expect(a).toBe(b);
	});

	it("produces a different fingerprint for a different operation (SENT vs REOPEN)", async () => {
		const a = await calculateLongTermTaskLifecycleFingerprint(base);
		const b = await calculateLongTermTaskLifecycleFingerprint({
			...base,
			operation: "REOPEN",
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint for a different expectedRevisionNo", async () => {
		const a = await calculateLongTermTaskLifecycleFingerprint(base);
		const b = await calculateLongTermTaskLifecycleFingerprint({
			...base,
			expectedRevisionNo: 2,
		});
		expect(a).not.toBe(b);
	});

	it("produces a different fingerprint when reasonNote changes", async () => {
		const a = await calculateLongTermTaskLifecycleFingerprint({
			...base,
			operation: "CANCEL",
			reasonNote: "changed my mind",
		});
		const b = await calculateLongTermTaskLifecycleFingerprint({
			...base,
			operation: "CANCEL",
			reasonNote: "different reason",
		});
		expect(a).not.toBe(b);
	});
});

describe("deriveLongTermChildIdempotencyKey (bounded, never a raw concatenation)", () => {
	it("produces a 64-character hex string regardless of a maximal 128-char parent key", async () => {
		const maximalParentKey = "x".repeat(128);
		const key = await deriveLongTermChildIdempotencyKey(maximalParentKey, [
			"cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
			"SENT",
			"transfer",
		]);
		expect(key).toHaveLength(64);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces different child keys for different operations from the same parent key", async () => {
		const parentKey = "caller-supplied-key";
		const taskId = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
		const a = await deriveLongTermChildIdempotencyKey(parentKey, [
			taskId,
			"SENT",
			"transfer",
		]);
		const b = await deriveLongTermChildIdempotencyKey(parentKey, [
			taskId,
			"SENT",
			"canonical",
		]);
		expect(a).not.toBe(b);
	});

	it("produces the identical child key for the identical inputs (stable replay derivation)", async () => {
		const parentKey = "caller-supplied-key";
		const taskId = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
		const a = await deriveLongTermChildIdempotencyKey(parentKey, [
			taskId,
			"REOPEN",
			"void",
		]);
		const b = await deriveLongTermChildIdempotencyKey(parentKey, [
			taskId,
			"REOPEN",
			"void",
		]);
		expect(a).toBe(b);
	});
});
