import { describe, expect, it } from "vitest";
import {
	canonicalJsonStringify,
	verifyStoredCheckpointSnapshot,
} from "../src/budget/checkpoint-canonical-v2";
import {
	createCheckpointTriggerCard,
	getEffectiveCheckpointTriggerCard,
	updateCheckpointTriggerCard,
} from "../src/budget/checkpoint-trigger-card-v2";
import { BudgetError } from "../src/budget/errors";
import type { Database } from "../src/db/client";

/**
 * Checkpoint 5 -- the authoritative PGlite coverage for the checkpoint
 * trigger-card write service, the enqueue helper, the persistence processor,
 * and replay-before-live lives in `scripts/pg-runtime-verify.ts` (Phase 5).
 * The workerd vitest gate cannot open a PGlite database, so this file pins the
 * pure canonical-serialization contract and the input guards that fail before
 * any database access.
 */

const db = undefined as unknown as Database;
const OK_UUID = "11111111-1111-4111-8111-111111111111";
const base = {
	db,
	userId: OK_UUID,
	creditCardId: OK_UUID,
	status: "ENABLED" as const,
	sourceKind: "USER_APPROVED" as const,
	idempotencyKey: "tc-1",
};

describe("createCheckpointTriggerCard -- pre-DB input guards", () => {
	it("rejects a non-UUID userId", async () => {
		await expect(
			createCheckpointTriggerCard({ ...base, userId: "nope" }),
		).rejects.toMatchObject({
			name: "BudgetError",
			code: "BUDGET_INVALID_INPUT",
		});
	});

	it("rejects a non-UUID creditCardId", async () => {
		await expect(
			createCheckpointTriggerCard({ ...base, creditCardId: "card-a" }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects an unknown status", async () => {
		await expect(
			createCheckpointTriggerCard({
				...base,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				status: "ON" as any,
			}),
		).rejects.toBeInstanceOf(BudgetError);
	});

	it("rejects a non-USER_APPROVED sourceKind (no AUTO / MODEL / issuer detection)", async () => {
		await expect(
			createCheckpointTriggerCard({
				...base,
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
				sourceKind: "AUTO" as any,
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("rejects a missing idempotency key", async () => {
		await expect(
			createCheckpointTriggerCard({ ...base, idempotencyKey: "   " }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});

describe("updateCheckpointTriggerCard / getEffective -- pre-DB guards", () => {
	it("update rejects a non-positive expectedRevisionNo", async () => {
		await expect(
			updateCheckpointTriggerCard({ ...base, expectedRevisionNo: 0 }),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});

	it("getEffective rejects an Invalid Date asOf", async () => {
		await expect(
			getEffectiveCheckpointTriggerCard({
				db,
				userId: OK_UUID,
				creditCardId: OK_UUID,
				asOf: new Date("nope"),
			}),
		).rejects.toMatchObject({ code: "BUDGET_INVALID_INPUT" });
	});
});

describe("canonicalJsonStringify -- deterministic, key-order-independent", () => {
	it("sorts object keys recursively and is independent of insertion order", () => {
		const a = { b: 1, a: { d: [3, 2, 1], c: "x" } };
		const b = { a: { c: "x", d: [3, 2, 1] }, b: 1 };
		expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
		expect(canonicalJsonStringify(a)).toBe('{"a":{"c":"x","d":[3,2,1]},"b":1}');
	});

	it("keeps array order (semantic) but not object key order", () => {
		expect(canonicalJsonStringify([{ y: 1, x: 2 }, "s"])).toBe(
			'[{"x":2,"y":1},"s"]',
		);
	});

	it("drops undefined object properties and refuses non-finite numbers", () => {
		expect(canonicalJsonStringify({ a: undefined, b: 2 })).toBe('{"b":2}');
		expect(() => canonicalJsonStringify({ n: Number.NaN })).toThrow(
			BudgetError,
		);
	});
});

describe("verifyStoredCheckpointSnapshot -- fail-closed integrity check", () => {
	const report = {
		schemaVersion: "budget-v2-checkpoint-report-v1",
		checkpoint: {
			schemaVersion: "budget-v2-checkpoint-report-v1",
			paymentEventId: OK_UUID,
			periodMonth: "2026-09-01",
			checkpointAt: "2026-09-15T00:00:00.000Z",
			previousCheckpointAt: null,
		},
	};

	it("passes when the recomputed fingerprint + identity columns all match", async () => {
		const { calculateCheckpointReportFingerprint } = await import(
			"../src/budget/checkpoint-canonical-v2"
		);
		const fingerprint = await calculateCheckpointReportFingerprint(report);
		await expect(
			verifyStoredCheckpointSnapshot({
				reportSchemaVersion: "budget-v2-checkpoint-report-v1",
				reportJson: report,
				reportFingerprint: fingerprint,
				paymentEventId: OK_UUID,
				periodMonth: "2026-09-01",
				checkpointAt: new Date("2026-09-15T00:00:00.000Z"),
				previousCheckpointAt: null,
			}),
		).resolves.toBeUndefined();
	});

	it("fails closed on a tampered fingerprint", async () => {
		await expect(
			verifyStoredCheckpointSnapshot({
				reportSchemaVersion: "budget-v2-checkpoint-report-v1",
				reportJson: report,
				reportFingerprint: "0".repeat(64),
				paymentEventId: OK_UUID,
				periodMonth: "2026-09-01",
				checkpointAt: new Date("2026-09-15T00:00:00.000Z"),
				previousCheckpointAt: null,
			}),
		).rejects.toMatchObject({ code: "BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT" });
	});

	it("fails closed when a stored identity column disagrees with the frozen report", async () => {
		const { calculateCheckpointReportFingerprint } = await import(
			"../src/budget/checkpoint-canonical-v2"
		);
		const fingerprint = await calculateCheckpointReportFingerprint(report);
		await expect(
			verifyStoredCheckpointSnapshot({
				reportSchemaVersion: "budget-v2-checkpoint-report-v1",
				reportJson: report,
				reportFingerprint: fingerprint,
				paymentEventId: OK_UUID,
				periodMonth: "2026-10-01", // column disagrees with report
				checkpointAt: new Date("2026-09-15T00:00:00.000Z"),
				previousCheckpointAt: null,
			}),
		).rejects.toMatchObject({ code: "BUDGET_CHECKPOINT_SNAPSHOT_CORRUPT" });
	});
});
