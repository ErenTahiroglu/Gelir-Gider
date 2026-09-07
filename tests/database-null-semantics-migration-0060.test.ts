import { describe, expect, it } from "vitest";
import journal from "../migrations/meta/_journal.json";

describe("Database Null-Semantics & Migration 0060 Canonical Payload Key-Presence Seal", () => {
	const migrationFiles = (
		import.meta as unknown as {
			glob: (
				pattern: string,
				options: Record<string, unknown>,
			) => Record<string, string>;
		}
	).glob("../migrations/*.sql", {
		query: "?raw",
		import: "default",
		eager: true,
	});

	const effectiveFunctions = new Map<
		string,
		{ migration: string; body: string }
	>();

	const entries = journal.entries as Array<{
		idx: number;
		when: number;
		tag: string;
	}>;

	for (const entry of entries) {
		const key = `../migrations/${entry.tag}.sql`;
		const content = migrationFiles[key];
		if (!content) continue;
		const chunks = content.split(/-->\s*statement-breakpoint/);

		for (const chunk of chunks) {
			const match = chunk.match(
				/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-zA-Z0-9_]+)/i,
			);
			if (match?.[1]) {
				effectiveFunctions.set(match[1], {
					migration: entry.tag,
					body: chunk,
				});
			}
		}
	}

	it("confirms migration 0060 defines trg_fn_seal_person_obligation_canonical_payload and trg_fn_seal_person_settlement_canonical_payload", () => {
		const oblFn = effectiveFunctions.get(
			"trg_fn_seal_person_obligation_canonical_payload",
		);
		expect(oblFn).toBeDefined();
		expect(oblFn?.migration).toBe("0060_seal_canonical_payload_key_presence");

		const stlFn = effectiveFunctions.get(
			"trg_fn_seal_person_settlement_canonical_payload",
		);
		expect(stlFn).toBeDefined();
		expect(stlFn?.migration).toBe("0060_seal_canonical_payload_key_presence");
	});

	describe("Person Obligation Exact Key-Set and Explicit Null Guard", () => {
		const fnBody = () =>
			effectiveFunctions.get("trg_fn_seal_person_obligation_canonical_payload")
				?.body ?? "";

		it("enforces exact key count and key presence for PERSON_RECEIVABLE_ADVANCE (7 keys)", () => {
			const body = fnBody();
			expect(body).toContain(
				"v_expected_keys := ARRAY['obligationId', 'personId', 'direction', 'amount', 'fundingAssetAccountId', 'dueDate', 'description']",
			);
			expect(body).toContain(
				"IF v_key_count != array_length(v_expected_keys, 1) THEN",
			);
			expect(body).toContain("IF NOT (v_payload ? v_k) THEN");
		});

		it("enforces exact key count and key presence for PERSON_PAYABLE_EXPENSE (7 keys)", () => {
			const body = fnBody();
			expect(body).toContain(
				"v_expected_keys := ARRAY['obligationId', 'personId', 'direction', 'amount', 'budgetCategory', 'dueDate', 'description']",
			);
		});

		it("enforces exact key count and key presence for CREDIT_CARD_PURCHASE_SPLIT (11 keys)", () => {
			const body = fnBody();
			expect(body).toContain(
				"v_expected_keys := ARRAY['obligationId', 'splitId', 'splitRevisionId', 'splitParticipantId', 'purchaseEventId', 'personId', 'direction', 'amount', 'expenseAccountId', 'dueDate', 'description']",
			);
		});

		it("enforces explicit JSON null for dueDate when projection due_date is null", () => {
			const body = fnBody();
			expect(body).toContain("IF NEW.due_date IS NULL THEN");
			expect(body).toContain(
				"IF jsonb_typeof(v_payload->'dueDate') != 'null' THEN",
			);
			expect(body).toContain(
				"RAISE EXCEPTION 'Canonical payload dueDate must be explicit JSON null when due_date is null'",
			);
		});

		it("enforces explicit JSON null for description when projection description is null", () => {
			const body = fnBody();
			expect(body).toContain("IF NEW.description IS NULL THEN");
			expect(body).toContain(
				"IF jsonb_typeof(v_payload->'description') != 'null' THEN",
			);
			expect(body).toContain(
				"RAISE EXCEPTION 'Canonical payload description must be explicit JSON null when description is null'",
			);
		});
	});

	describe("Person Settlement Exact Key-Set and Explicit Null Guard", () => {
		const fnBody = () =>
			effectiveFunctions.get("trg_fn_seal_person_settlement_canonical_payload")
				?.body ?? "";

		it("enforces exact key count and key presence for PERSON_OBLIGATION_SETTLEMENT (9 keys)", () => {
			const body = fnBody();
			expect(body).toContain(
				"v_expected_keys := ARRAY['settlementId', 'obligationId', 'personId', 'direction', 'appliedAmount', 'cashAmount', 'excessAmount', 'assetAccountId', 'note']",
			);
			expect(body).toContain(
				"IF v_key_count != array_length(v_expected_keys, 1) THEN",
			);
			expect(body).toContain("IF NOT (v_payload ? v_k) THEN");
		});

		it("enforces explicit JSON null for note when projection note is null", () => {
			const body = fnBody();
			expect(body).toContain("IF NEW.note IS NULL THEN");
			expect(body).toContain(
				"IF jsonb_typeof(v_payload->'note') != 'null' THEN",
			);
			expect(body).toContain(
				"RAISE EXCEPTION 'Canonical payload note must be explicit JSON null when note is null'",
			);
		});
	});

	describe("Structural DB-less Contract Validation Simulations", () => {
		// Pure TypeScript simulation of the trigger validation logic
		function validateObligationPayload(
			kind: string,
			payload: Record<string, unknown>,
			projection: { dueDate: string | null; description: string | null },
		) {
			let expectedKeys: string[];
			if (kind === "PERSON_RECEIVABLE_ADVANCE") {
				expectedKeys = [
					"obligationId",
					"personId",
					"direction",
					"amount",
					"fundingAssetAccountId",
					"dueDate",
					"description",
				];
			} else if (kind === "PERSON_PAYABLE_EXPENSE") {
				expectedKeys = [
					"obligationId",
					"personId",
					"direction",
					"amount",
					"budgetCategory",
					"dueDate",
					"description",
				];
			} else if (kind === "CREDIT_CARD_PURCHASE_SPLIT") {
				expectedKeys = [
					"obligationId",
					"splitId",
					"splitRevisionId",
					"splitParticipantId",
					"purchaseEventId",
					"personId",
					"direction",
					"amount",
					"expenseAccountId",
					"dueDate",
					"description",
				];
			} else {
				throw new Error(`Unsupported kind: ${kind}`);
			}

			const payloadKeys = Object.keys(payload);
			if (payloadKeys.length !== expectedKeys.length) {
				throw new Error(
					`Expected ${expectedKeys.length} keys, found ${payloadKeys.length}`,
				);
			}

			for (const key of expectedKeys) {
				if (!Object.hasOwn(payload, key)) {
					throw new Error(`Missing required key: ${key}`);
				}
			}

			if (projection.dueDate === null) {
				if (payload.dueDate !== null) {
					throw new Error(
						"dueDate must be explicit null when projection is null",
					);
				}
			} else {
				if (
					typeof payload.dueDate !== "string" ||
					payload.dueDate !== projection.dueDate
				) {
					throw new Error("dueDate does not match projection");
				}
			}

			if (projection.description === null) {
				if (payload.description !== null) {
					throw new Error(
						"description must be explicit null when projection is null",
					);
				}
			} else {
				if (
					typeof payload.description !== "string" ||
					payload.description !== projection.description
				) {
					throw new Error("description does not match projection");
				}
			}

			return true;
		}

		function validateSettlementPayload(
			payload: Record<string, unknown>,
			projection: { note: string | null },
		) {
			const expectedKeys = [
				"settlementId",
				"obligationId",
				"personId",
				"direction",
				"appliedAmount",
				"cashAmount",
				"excessAmount",
				"assetAccountId",
				"note",
			];

			const payloadKeys = Object.keys(payload);
			if (payloadKeys.length !== expectedKeys.length) {
				throw new Error(
					`Expected ${expectedKeys.length} keys, found ${payloadKeys.length}`,
				);
			}

			for (const key of expectedKeys) {
				if (!Object.hasOwn(payload, key)) {
					throw new Error(`Missing required key: ${key}`);
				}
			}

			if (projection.note === null) {
				if (payload.note !== null) {
					throw new Error("note must be explicit null when projection is null");
				}
			} else {
				if (
					typeof payload.note !== "string" ||
					payload.note !== projection.note
				) {
					throw new Error("note does not match projection");
				}
			}

			return true;
		}

		it("Receivable: missing dueDate -> rejects", () => {
			const payload = {
				obligationId: "obl-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				amount: "100.00",
				fundingAssetAccountId: "acct-1",
				description: null,
			};
			expect(() =>
				validateObligationPayload("PERSON_RECEIVABLE_ADVANCE", payload, {
					dueDate: null,
					description: null,
				}),
			).toThrow(/Expected 7 keys, found 6/);
		});

		it("Receivable: missing description -> rejects", () => {
			const payload = {
				obligationId: "obl-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				amount: "100.00",
				fundingAssetAccountId: "acct-1",
				dueDate: null,
			};
			expect(() =>
				validateObligationPayload("PERSON_RECEIVABLE_ADVANCE", payload, {
					dueDate: null,
					description: null,
				}),
			).toThrow(/Expected 7 keys, found 6/);
		});

		it("Receivable: explicit null dueDate/description -> accepts", () => {
			const payload = {
				obligationId: "obl-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				amount: "100.00",
				fundingAssetAccountId: "acct-1",
				dueDate: null,
				description: null,
			};
			expect(
				validateObligationPayload("PERSON_RECEIVABLE_ADVANCE", payload, {
					dueDate: null,
					description: null,
				}),
			).toBe(true);
		});

		it("Payable: missing dueDate -> rejects", () => {
			const payload = {
				obligationId: "obl-1",
				personId: "person-1",
				direction: "PAYABLE",
				amount: "100.00",
				budgetCategory: "MANDATORY_EXPENSE",
				description: null,
			};
			expect(() =>
				validateObligationPayload("PERSON_PAYABLE_EXPENSE", payload, {
					dueDate: null,
					description: null,
				}),
			).toThrow(/Expected 7 keys, found 6/);
		});

		it("Payable: explicit null dueDate/description -> accepts", () => {
			const payload = {
				obligationId: "obl-1",
				personId: "person-1",
				direction: "PAYABLE",
				amount: "100.00",
				budgetCategory: "MANDATORY_EXPENSE",
				dueDate: null,
				description: null,
			};
			expect(
				validateObligationPayload("PERSON_PAYABLE_EXPENSE", payload, {
					dueDate: null,
					description: null,
				}),
			).toBe(true);
		});

		it("Shared split: missing description -> rejects", () => {
			const payload = {
				obligationId: "obl-1",
				splitId: "split-1",
				splitRevisionId: "srev-1",
				splitParticipantId: "spart-1",
				purchaseEventId: "pevent-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				amount: "50.00",
				expenseAccountId: "exp-1",
				dueDate: null,
			};
			expect(() =>
				validateObligationPayload("CREDIT_CARD_PURCHASE_SPLIT", payload, {
					dueDate: null,
					description: null,
				}),
			).toThrow(/Expected 11 keys, found 10/);
		});

		it("Shared split: explicit null dueDate/description -> accepts", () => {
			const payload = {
				obligationId: "obl-1",
				splitId: "split-1",
				splitRevisionId: "srev-1",
				splitParticipantId: "spart-1",
				purchaseEventId: "pevent-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				amount: "50.00",
				expenseAccountId: "exp-1",
				dueDate: null,
				description: null,
			};
			expect(
				validateObligationPayload("CREDIT_CARD_PURCHASE_SPLIT", payload, {
					dueDate: null,
					description: null,
				}),
			).toBe(true);
		});

		it("Settlement: missing note -> rejects", () => {
			const payload = {
				settlementId: "set-1",
				obligationId: "obl-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				appliedAmount: "50.00",
				cashAmount: "50.00",
				excessAmount: "0.00",
				assetAccountId: "acct-1",
			};
			expect(() => validateSettlementPayload(payload, { note: null })).toThrow(
				/Expected 9 keys, found 8/,
			);
		});

		it("Settlement: explicit JSON null note -> accepts", () => {
			const payload = {
				settlementId: "set-1",
				obligationId: "obl-1",
				personId: "person-1",
				direction: "RECEIVABLE",
				appliedAmount: "50.00",
				cashAmount: "50.00",
				excessAmount: "0.00",
				assetAccountId: "acct-1",
				note: null,
			};
			expect(validateSettlementPayload(payload, { note: null })).toBe(true);
		});
	});
});
