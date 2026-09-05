import { describe, expect, it } from "vitest";
import migration0037Sql from "../migrations/0037_close_final_shared_split_integrity_gaps.sql?raw";

describe("Credit Card Splits Migration 0037 Verification", () => {
	const sql = migration0037Sql;

	it("binds CREDIT_CARD_PURCHASE_SPLIT payload splitId/purchaseEventId/splitRevisionId to the real split at insert time", () => {
		expect(sql).toContain("Split % referenced by canonical payload not found");
		expect(sql).toContain("does not match canonical payload purchaseEventId");
		expect(sql).toContain(
			"belongs to split % not matching canonical payload splitId",
		);
	});

	it("rejects a standalone (non-CREDIT_CARD_PURCHASE_SPLIT) obligation from backing a split participant at commit", () => {
		expect(sql).toContain("is not a CREDIT_CARD_PURCHASE_SPLIT obligation");
	});

	it("enforces exact participant provenance (splitParticipantId/splitId/purchaseEventId) against the obligation's stored payload at commit", () => {
		expect(sql).toContain(
			"payload splitParticipantId % does not match participant",
		);
		expect(sql).toContain("payload splitId % does not match split");
		expect(sql).toContain(
			"payload purchaseEventId % does not match split purchase_event_id",
		);
		expect(sql).toContain("does not identify a revision of split");
	});

	it("enforces the revision-item companion (exactly one matching item for participant/person/amount) at commit", () => {
		expect(sql).toContain("must contain exactly one matching revision item");
	});

	it("still contains the 0036 baseline naked-anchor, orphan-participant, and VOID final invariant checks (superset, not a replacement)", () => {
		expect(sql).toContain("naked split anchor");
		expect(sql).toContain("orphan participant anchor");
		expect(sql).toContain("leaves participant obligation");
	});
});
