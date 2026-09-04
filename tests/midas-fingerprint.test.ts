import { describe, expect, it } from "vitest";
import { calculateAllocationTransferFingerprint } from "../src/midas/fingerprint";

describe("Midas Allocation Transfer Fingerprinting (Phase 8A)", () => {
	const baseParams = {
		userId: "11111111-1111-4111-8111-111111111111",
		midasAccountId: "22222222-2222-4222-8222-222222222222",
		fromBucketId: null,
		toBucketId: "33333333-3333-4333-8333-333333333333",
		amount: "500.00",
		occurredAt: new Date("2026-09-01T10:00:00.000Z"),
		memo: "Initial allocation",
		reversalOfTransferId: null,
	};

	it("produces deterministic 64 lowercase hex SHA-256 fingerprint", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint(baseParams);

		expect(fp1).toMatch(/^[0-9a-f]{64}$/);
		expect(fp1).toBe(fp2);
	});

	it("changes fingerprint when amount changes", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint({
			...baseParams,
			amount: "500.01",
		});

		expect(fp1).not.toBe(fp2);
	});

	it("changes fingerprint when fromBucketId changes", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint({
			...baseParams,
			fromBucketId: "44444444-4444-4444-8444-444444444444",
		});

		expect(fp1).not.toBe(fp2);
	});

	it("changes fingerprint when toBucketId changes", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint({
			...baseParams,
			toBucketId: "55555555-5555-4555-8555-555555555555",
		});

		expect(fp1).not.toBe(fp2);
	});

	it("changes fingerprint when occurredAt changes", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint({
			...baseParams,
			occurredAt: new Date("2026-09-01T10:00:01.000Z"),
		});

		expect(fp1).not.toBe(fp2);
	});

	it("changes fingerprint when memo changes", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint({
			...baseParams,
			memo: "Different memo",
		});

		expect(fp1).not.toBe(fp2);
	});

	it("changes fingerprint when reversalOfTransferId changes", async () => {
		const fp1 = await calculateAllocationTransferFingerprint(baseParams);
		const fp2 = await calculateAllocationTransferFingerprint({
			...baseParams,
			reversalOfTransferId: "66666666-6666-4666-8666-666666666666",
		});

		expect(fp1).not.toBe(fp2);
	});
});
